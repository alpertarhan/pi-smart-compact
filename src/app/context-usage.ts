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
import {
  makeReaderTokenEstimator,
  makeTokenEstimator,
  type ReaderIdentity,
  type TokenCalibrationStore,
  type TokenEstimator,
} from "../utils/tokens.ts";

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
  estimateAs: (identity: { provider?: string; model?: string }) => TokenEstimator;
  /** Factor fingerprint for memo keying; contains no secrets. */
  factors: () => string;
}

export function createUsagePricing(reader: ReaderIdentity, calibration: TokenCalibrationStore): UsagePricing {
  const estimate = makeReaderTokenEstimator(reader, calibration);
  const captured = new Map<string, TokenEstimator>();
  const factors = [reader.provider, reader.id, calibration.get(reader.provider, reader.id)].join("|");
  return {
    reader,
    estimate,
    estimateAs: identity => {
      const key = identity.provider + "/" + identity.model;
      let estimator = captured.get(key);
      if (!estimator) {
        // First use freezes this identity's factor for the pricing's lifetime.
        estimator = makeTokenEstimator(identity.provider, identity.model, calibration);
        captured.set(key, estimator);
      }
      return estimator;
    },
    factors: () => factors + "|" + [...captured.keys()].sort().join(","),
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

function sameReader(producer: { provider?: string; api?: string; model?: string }, reader: ReaderIdentity): boolean {
  return producer.provider === reader.provider && producer.api === reader.api && producer.model === reader.id;
}

/** Verified thinking-retention rules exist for these readers; anything else is unknown. */
function retentionRulesVerified(reader: ReaderIdentity): boolean {
  if (reader.api === "openai-responses" || reader.api === "openai-codex-responses" || reader.api === "openai-completions") return true;
  return reader.api === "anthropic-messages" && reader.id.toLowerCase().startsWith("claude");
}

/** Bounded single-slot memo: the stale path serializes the branch, and contextUsage is hot. */
const basisMemo: { key: string; tokens: number; reserve: number; reserveKind: string; basis: ContextUsageBasis } | null = { key: "", tokens: 0, reserve: 0, reserveKind: "", basis: { basis: "measured" } };
let basisMemoSlot: { key: string; value: NonNullable<typeof basisMemo> } | null = null;

function hashFingerprint(text: string | undefined): string {
  if (text === undefined) return "none";
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return hash.toString(36) + ":" + text.length;
}

/**
 * `ctx.getContextUsage()`, anchored across context edits (same-reader, unchanged), and — when the
 * last measurement provably came from a DIFFERENT model and run pricing is supplied — conservatively
 * repriced in the active reader's domain. The old figure survives only as labeled producer evidence.
 */
export function contextUsage(ctx: UsageContext, pricing?: UsagePricing): (ReturnType<ExtensionContext["getContextUsage"]> & Partial<ContextUsageBasis>) | undefined {
  const usage = ctx.getContextUsage?.();
  if (!usage || !ctx.sessionManager) return usage;
  try {
    // The common case (no edit since the last response) never copies the branch.
    const edited = editedSinceMeasurement(ctx.sessionManager);
    const branch = ctx.sessionManager.getBranch();
    const anchor = branch.findLastIndex(entry => measuredTokens(entry) > 0);
    const producer = anchor >= 0 ? { ...measuredProducerIdentity((branch[anchor] as { message?: unknown }).message), measuredTokens: measuredTokens(branch[anchor]) } : undefined;
    const stale = !!pricing && !!producer?.provider && !sameReader(producer, pricing.reader);
    if (!edited && !stale) {
      return usage;
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
    const memoKey = JSON.stringify([
      ctx.sessionManager.getLeafEntry?.()?.id ?? "leaf",
      (branch[anchor] as { id?: string }).id, pricing.reader.provider, pricing.reader.id, pricing.reader.api, pricing.reader.input ?? null,
      usage.contextWindow, hashFingerprint(ctx.getSystemPrompt?.()), pricing.factors(),
    ]);
    if (basisMemoSlot?.key === memoKey) {
      const { value } = basisMemoSlot;
      return { ...usage, tokens: value.tokens, percent: usage.contextWindow > 0 ? value.tokens / usage.contextWindow * 100 : usage.percent,
        basis: value.basis.basis, staleProducer: true, producerEvidence: producer };
    }

    const messages = contextMessageEntries(branch);
    const anchorPrefix = contextMessageEntries(branch.slice(0, anchor + 1));
    // Known-domain framing reserve: what the producer's own prompt carried beyond its message
    // estimates, priced entirely in the producer's units. A clamped zero is NOT proof of zero
    // framing — fall through to same-reader or visible-system evidence, else refuse.
    const producerEstimator = pricing.estimateAs({ provider: producer.provider, model: producer.model });
    const producerBody = anchorPrefix.reduce((sum, entry) => sum + producerEstimator.message(entry.message as unknown as import("../types.ts").LlmMessage), 0);
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
        const ownEstimator = pricing.estimateAs({ provider: identity.provider, model: identity.model });
        const ownBody = ownPrefix.reduce((sum, e) => sum + ownEstimator.message(e.message as unknown as import("../types.ts").LlmMessage), 0);
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

    let body = messages.reduce((sum, entry) => sum + pricing.estimate.message(entry.message as unknown as import("../types.ts").LlmMessage), 0);
    if (!retentionRulesVerified(pricing.reader)) {
      // Unknown retention rules: output-reasoning is only a non-reasoning LOWER bound. Bound the
      // possibly-retained thinking with the measured reasoning of clean same-model messages; a
      // thinking message without valid metadata is unboundable — insufficient confidence.
      for (const entry of messages) {
        const message = entry.message as { role?: string; provider?: string; api?: string; model?: string; usage?: { output?: unknown; reasoning?: unknown } };
        if (message?.role !== "assistant" || message.provider !== pricing.reader.provider || message.model !== pricing.reader.id) continue;
        const reasoning = message.usage?.reasoning;
        const output = message.usage?.output;
        if (typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning > 0) {
          body += reasoning;
        } else if (hasThinking(message)) {
          basis = "uncertain"; // unboundable retained thinking
        }
      }
    }
    const tokens = Math.round(body + reserve);
    const value = { key: memoKey, tokens, reserve: Math.round(reserve), reserveKind, basis: { basis, staleProducer: true, producerEvidence: producer } as ContextUsageBasis };
    basisMemoSlot = { key: memoKey, value };
    return { ...usage, tokens, percent: usage.contextWindow > 0 ? tokens / usage.contextWindow * 100 : usage.percent,
      basis, staleProducer: true, producerEvidence: producer };
  } catch {
    // A diagnostic estimate must never take Pi's own figure away.
    return usage;
  }
}

function hasThinking(message: unknown): boolean {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) && content.some(block => block && typeof block === "object" && (block as { type?: string }).type === "thinking");
}
