/**
 * Context size across our own context edits.
 *
 * Pi's getContextUsage() drops the last provider-measured usage once a `context_edit` or
 * `compaction` entry is newer than it, and falls back to a chars/4 estimate of the visible
 * messages that misses encrypted and signed reasoning. After real rewinds that estimate read
 * 14-33% below the input the provider measured on the next request. Anchoring keeps the measured
 * size and applies only the edits' estimated difference (0.3-2% from the next input there).
 */

import { calculateContextTokens, estimateTokens, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { contextMessageEntries } from "../infra/ai-messages.ts";
import { getProcessTokenCalibration } from "../infra/services.ts";
import { createHash } from "node:crypto";
import {
  makeReaderTokenEstimator,
  thinkingRetentionKnown,
  type ReaderIdentity,
  type TokenCalibrationStore,
  type TokenEstimator,
} from "../utils/tokens.ts";
import type { LlmMessage } from "../types.ts";

type Estimate = (message: Parameters<typeof estimateTokens>[0]) => number;

function estimatedTokens(entries: readonly unknown[], estimate: Estimate): number {
  // SAFETY: contextMessageEntries yields convertToLlm() output, i.e. real LLM messages.
  return contextMessageEntries(entries).reduce((sum, entry) => sum + estimate(entry.message as Parameters<Estimate>[0]), 0);
}

/** Context a finished response measured; 0 for aborted or failed responses, which Pi does not trust either. */
function measuredTokens(entry: SessionEntry): number {
  if (entry.type !== "message" || entry.message.role !== "assistant") return 0;
  const { stopReason, usage } = entry.message;
  return stopReason === "aborted" || stopReason === "error" || !usage ? 0 : calculateContextTokens(usage);
}

/**
 * Last measured usage plus the estimated change since: edits to messages it covered and messages
 * added after it. Null when Pi's own figure is already right (no edit newer than the measurement)
 * or nothing can anchor it (no measured response, or a compaction replaced the measured window).
 * The measured response may itself be edited away: a rewind removes its own call with the research.
 * Pi's own estimator measured the edits most accurately on real rewinds (the provider-calibrated
 * one overcounted removed tool output by up to 8%).
 */
export function anchoredContextTokens(branch: SessionEntry[], estimate: Estimate = estimateTokens): number | null {
  const anchor = branch.findLastIndex(entry => measuredTokens(entry) > 0);
  if (anchor < 0) return null;
  const later = branch.slice(anchor + 1);
  if (!later.some(entry => entry.type === "context_edit") || later.some(entry => entry.type === "compaction")) return null;
  // What the measured request carried versus what the next one carries.
  const then = estimatedTokens(branch.slice(0, anchor + 1), estimate);
  const now = estimatedTokens(branch, estimate);
  return Math.max(0, Math.round(measuredTokens(branch[anchor]) + now - then));
}

type UsageContext = Partial<Pick<ExtensionContext, "getContextUsage" | "sessionManager" | "model" | "getSystemPrompt">>;

/**
 * Reader-domain per-message estimates. The active model replays its own
 * unchanged assistant messages (proxy eligibility), while projected edits and
 * the live turn boundary change what the wire carries. Every consumer of the
 * basis — window walk, native split, picker, reserve prefixes — prices through
 * this one helper so per-message weights and the aggregate can never disagree.
 */
export function estimateReaderMessageTokens(
  readerEstimator: TokenEstimator,
  msgs: ReturnType<typeof contextMessageEntries>,
): number[] {
  // Replay turn accounting follows the WIRE, not human-turn policy: custom and
  // host-summary messages convert to user items, so every projected user item
  // starts a new API turn. (Retention protection elsewhere keeps its stricter
  // human-only boundary.)
  let lastWireUserItem = -1;
  for (let index = 0; index < msgs.length; index++) {
    const message = msgs[index]!.message;
    if (message && typeof message === "object" && (message as { role?: string }).role === "user") lastWireUserItem = index;
  }
  return msgs.map((entry, index) =>
    readerEstimator.message(entry.message as unknown as LlmMessage, {
      contextEdited: entry.contextEdited,
      // No user item anywhere means nothing is provably in the live turn.
      currentTurn: lastWireUserItem >= 0 && index > lastWireUserItem,
    }),
  );
}

/**
 * Run-scoped pricing for the active reader: one calibration snapshot, factors
 * captured at creation (and at first use per identity) so a mid-run summary
 * calibration can never silently reprice an in-flight basis. The estimator
 * functions only ever read messages; they never rewrite signed content.
 */
export interface UsagePricing {
  reader: ReaderIdentity;
  /** Reader-domain message price (replay rules included). */
  estimate: TokenEstimator;
  /** Producer-domain price for the model that measured the anchor. */
  estimateAs: (identity: { provider: string; model: string; api?: string }) => TokenEstimator;
  /** Factor fingerprint for memo keying; contains no secrets. */
  factors: () => string;
}

export function createUsagePricing(reader: ReaderIdentity, calibration: TokenCalibrationStore): UsagePricing {
  const estimate = makeReaderTokenEstimator(reader, calibration);
  const readerFactor = calibration.get(reader.provider, reader.id);
  const captured = new Map<string, { estimator: TokenEstimator; factor: number }>();
  return {
    reader,
    estimate,
    // Producer prefixes price in the PRODUCER's own reader domain (full
    // provider/api/model identity + replay rules), never generic character
    // estimates: opaque old reasoning must not leak into the framing reserve.
    estimateAs: identity => {
      const key = identity.provider + "/" + identity.model + "/" + (identity.api ?? "");
      let entry = captured.get(key);
      if (!entry) {
        // First use freezes this identity's factors for the pricing's lifetime.
        entry = { estimator: makeReaderTokenEstimator({ provider: identity.provider, id: identity.model, api: identity.api }, calibration), factor: calibration.get(identity.provider, identity.model) };
        captured.set(key, entry);
      }
      return entry.estimator;
    },
    // Frozen numeric factors actually used: a mid-run calibration change can
    // neither reprice this snapshot nor let a new one hit the old result.
    factors: () => JSON.stringify([readerFactor, ...[...captured.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v.factor)]),
  };
}

/** Provenance of the returned token figure: what was measured, estimated, or provably missing. */
export interface ContextUsageBasis {
  basis: "measured" | "anchored" | "reprojected" | "uncertain" | "unavailable";
  /** True when the last measured usage provably came from a different model than the active reader. */
  staleProducer?: boolean;
  /** Labeled producer evidence; a hint, never a mandatory total or normalization source. */
  producerEvidence?: { provider?: string; api?: string; model?: string; measuredTokens: number };
}

/** Whether a context edit is newer than the last measured response, walking back only that far. */
function editedSinceMeasurement(sessionManager: ExtensionContext["sessionManager"]): boolean {
  for (let entry = sessionManager.getLeafEntry(); entry; entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined) {
    if (entry.type === "context_edit") return true;
    if (entry.type === "compaction") return false;
    if (measuredTokens(entry) > 0) return false;
  }
  return false;
}

/** Identity of the message that produced the last trusted measurement. */
function measuredProducerIdentity(message: unknown): { provider?: string; api?: string; model?: string } {
  const meta = message as { provider?: string; api?: string; model?: string } | undefined;
  return meta && typeof meta === "object" ? { provider: meta.provider, api: meta.api, model: meta.model } : {};
}

/**
 * Same reader when every PRESENT identity field matches. Missing api/model alone is
 * not proof of a different model (partial metadata must stay compatible); a
 * difference on any present field is.
 */
function sameReader(producer: { provider?: string; api?: string; model?: string }, reader: { provider?: string; api?: string; id?: string }): boolean {
  if (producer.provider === undefined && producer.model === undefined) return false; // no identity to match
  if (producer.provider !== undefined && producer.provider !== reader.provider) return false;
  if (producer.api !== undefined && producer.api !== reader.api) return false;
  if (producer.model !== undefined && producer.model !== reader.id) return false;
  return true;
}

/** Bounded single-slot memo: the stale path serializes the branch, and contextUsage is hot. */
let basisMemoSlot: { key: string; value: { tokens: number; reserve: number; reserveKind: string; basis: ContextUsageBasis } } | null = null;

function hashFingerprint(text: string | undefined): string {
  if (text === undefined) return "none";
  return createHash("sha256").update(text).digest("hex");
}

/**
 * `ctx.getContextUsage()`, anchored across context edits (same-reader, unchanged), and — when the
 * last measurement provably came from a DIFFERENT model and run pricing is supplied — conservatively
 * repriced in the active reader's domain. The old figure survives only as labeled producer evidence.
 */
export function contextUsage(ctx: UsageContext, pricing?: UsagePricing): (ReturnType<ExtensionContext["getContextUsage"]> & Partial<ContextUsageBasis>) | undefined {
  const usage = ctx.getContextUsage?.();
  if (!usage || !ctx.sessionManager) return usage;
  let provablyStale = false;
  try {
    // The common case (no edit since the last response) never copies the branch.
    const edited = editedSinceMeasurement(ctx.sessionManager);
    const branch = ctx.sessionManager.getBranch();
    const anchor = branch.findLastIndex(entry => measuredTokens(entry) > 0);
    const producer = anchor >= 0 ? { ...measuredProducerIdentity((branch[anchor] as { message?: unknown }).message), measuredTokens: measuredTokens(branch[anchor]) } : undefined;
    const activeModel = ctx.model as { provider?: string; api?: string; id?: string } | undefined;
    // Staleness is proven from identity alone — even WITHOUT run pricing, a
    // measured figure from a different model must never masquerade as a current
    // reader measurement for pending/attention/pressure consumers.
    provablyStale = !!producer?.provider
      && (!!pricing ? !sameReader(producer, pricing.reader) : !!activeModel?.provider && !sameReader(producer, activeModel));
    const stale = !!pricing && provablyStale;
    if (!edited && !provablyStale) {
      return usage;
    }
    if (provablyStale && !pricing) {
      // Labeled but unpriced: display paths keep the number, apply gates refuse.
      return { ...usage, basis: "unavailable" as const, staleProducer: true, producerEvidence: producer };
    }
    if (!stale) {
      // Same-reader (or legacy unknown-producer) paths keep today's behavior exactly.
      const anchored = anchoredContextTokens(branch);
      if (anchored === null) return { ...usage, basis: "measured" as const };
      // Pi's message estimate stays the floor: usage that never covered visible messages cannot lower it.
      const tokens = Math.max(anchored, usage.tokens ?? 0);
      return { ...usage, tokens, percent: usage.contextWindow > 0 ? tokens / usage.contextWindow * 100 : usage.percent, basis: "anchored" as const };
    }
    if (!pricing || anchor < 0 || !producer?.provider) return { ...usage, basis: "unavailable" as const, staleProducer: true, producerEvidence: producer };

    // Stale measurement: reprice conservatively in the active reader's domain.
    // The producer's factors are primed BEFORE the key so the memo can never
    // compare against a result computed under different captured factors.
    const producerEstimator = pricing.estimateAs({ provider: producer.provider, api: producer.api, model: producer.model! });
    const memoKey = JSON.stringify([
      ctx.sessionManager.getSessionId?.() ?? "", ctx.model?.maxTokens ?? null,
      ctx.sessionManager.getLeafEntry?.()?.id ?? "leaf", branch.length,
      (branch[anchor] as { id?: string }).id, producer.measuredTokens,
      pricing.reader.provider, pricing.reader.id, pricing.reader.api, pricing.reader.input ?? null,
      usage.contextWindow, hashFingerprint(ctx.getSystemPrompt?.()), pricing.factors(),
    ]);
    if (basisMemoSlot?.key === memoKey) {
      const { value } = basisMemoSlot;
      return { ...usage, tokens: value.tokens, percent: usage.contextWindow > 0 ? value.tokens / usage.contextWindow * 100 : usage.percent,
        basis: value.basis.basis, staleProducer: true, producerEvidence: producer };
    }

    const messages = contextMessageEntries(branch);
    const anchorPrefix = contextMessageEntries(branch.slice(0, anchor + 1));
    // Known-domain framing reserve: what the producer's own prompt carried beyond its
    // REPLAY-AWARE message pricing (its own reader domain, live-turn and edit options),
    // priced entirely in the producer's units. A clamped zero is NOT proof of zero
    // framing — fall through to same-reader or visible-system evidence, else refuse.
    const producerBody = estimateReaderMessageTokens(producerEstimator, anchorPrefix).reduce((a, b) => a + b, 0);
    let reserve = Math.max(0, producer.measuredTokens - producerBody);
    let reserveKind = reserve > 0 ? "estimated-producer" : "none";
    if (reserve <= 0) {
      // Earlier measurement from the READER's own identity: its residual is known same-reader framing.
      for (let i = anchor - 1; i >= 0; i--) {
        const entry = branch[i];
        if (measuredTokens(entry) <= 0) continue;
        const identity = measuredProducerIdentity((entry as { message?: unknown }).message);
        if (!identity.provider || !sameReader(identity, pricing.reader)) continue;
        const ownPrefix = contextMessageEntries(branch.slice(0, i + 1));
        const ownBody = estimateReaderMessageTokens(pricing.estimate, ownPrefix).reduce((a, b) => a + b, 0);
        const ownResidual = measuredTokens(entry) - ownBody;
        if (ownResidual > 0) { reserve = ownResidual; reserveKind = "same-reader"; }
        break;
      }
    }
    const systemPrompt = ctx.getSystemPrompt?.();
    if (reserve <= 0 && systemPrompt !== undefined) {
      reserve = pricing.estimate.text(systemPrompt);
      reserveKind = "partial-visible-system";
    }

    let basis: ContextUsageBasis["basis"] = "reprojected";
    if (reserve <= 0 || reserveKind === "partial-visible-system") basis = "uncertain";

    // Reader body through the SAME options-correct per-message pricing the window
    // walk and picker use, so per-message weights and the aggregate never disagree.
    // Unknown-retention readers already price same-model thinking at its measured
    // upper bound inside the estimator; thinking WITHOUT valid metadata is
    // unboundable — insufficient confidence, not zero unknown overhead.
    const readerWeights = estimateReaderMessageTokens(pricing.estimate, messages);
    if (basis !== "uncertain" && !thinkingRetentionKnown({ id: pricing.reader.id, api: pricing.reader.api })) {
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i]!.message as { role?: string; provider?: string; model?: string; usage?: unknown };
        if (message?.role !== "assistant" || message.provider !== pricing.reader.provider || message.model !== pricing.reader.id) continue;
        if (hasThinking(message) && !validThinkingUsage(message.usage)) basis = "uncertain";
      }
    }
    const tokens = Math.round(readerWeights.reduce((a, b) => a + b, 0) + reserve);
    const value = { key: memoKey, tokens, reserve: Math.round(reserve), reserveKind, basis: { basis, staleProducer: true, producerEvidence: producer } as ContextUsageBasis };
    basisMemoSlot = { key: memoKey, value };
    return { ...usage, tokens, percent: usage.contextWindow > 0 ? tokens / usage.contextWindow * 100 : usage.percent,
      basis, staleProducer: true, producerEvidence: producer };
  } catch {
    // A diagnostic estimate must never take Pi's own figure away — but a proven
    // stale basis must never pass as a current-reader measurement either.
    if (provablyStale && pricing) {
      return { ...usage, basis: "unavailable" as const, staleProducer: true, producerEvidence: undefined };
    }
    return usage;
  }
}

/**
 * Gate/trigger-layer basis: prices ctx.model's context against the shared
 * PRODUCTION calibration store (the one createProductionServices uses), so
 * pressure/attention/entry gates read the current reader's domain instead of a
 * silently raw old-model count. Callers with their own services bag pass its
 * store; the prepared run keeps its immutable rc.usagePricing untouched.
 */
export function readerUsage(
  ctx: UsageContext,
  calibration?: TokenCalibrationStore,
): (ReturnType<ExtensionContext["getContextUsage"]> & Partial<ContextUsageBasis>) | undefined {
  const model = ctx.model as { provider?: string; id?: string; api?: string; input?: readonly string[] } | undefined;
  if (!model?.provider || !model.id) return contextUsage(ctx);
  return contextUsage(ctx, createUsagePricing(
    { provider: model.provider, id: model.id, api: model.api, input: model.input },
    calibration ?? getProcessTokenCalibration(),
  ));
}

function hasThinking(message: unknown): boolean {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) && content.some(block => block && typeof block === "object" && (block as { type?: string }).type === "thinking");
}

/** A finite 0<=reasoning<=output subset; anything else cannot bound retained thinking. */
function validThinkingUsage(usage: unknown): boolean {
  const u = usage as { output?: unknown; reasoning?: unknown } | undefined;
  return typeof u?.output === "number" && Number.isFinite(u.output)
    && typeof u.reasoning === "number" && Number.isFinite(u.reasoning)
    && u.reasoning >= 0 && u.reasoning <= u.output;
}
