/**
 * Per-run pipeline context as a typed state machine.
 *
 * The previous incarnation of `RunContext` was a single fat interface where
 * every later-phase field was marked optional. That kept the type system
 * quiet but had two real costs:
 *
 *   1. **Cast pollution.** `makeContext` initialized half the fields with
 *      `undefined as unknown as RunContext["config"]` because the type
 *      claimed they would be set. Every step then re-read them with `!`,
 *      silently relying on call ordering. A future refactor that moved one
 *      step would compile cleanly and crash at runtime.
 *
 *   2. **No phase guarantees.** `applyCompaction` reading `rc.details!` had
 *      no compile-time proof that `buildState` had actually run.
 *
 * We replace that with a stage chain. Each step accepts the previous stage
 * type and returns the next, so:
 *
 *   - `prepareRun(base)` → `PreparedRc`
 *   - `resolveCompactionWindow(prepared)` → `WindowedRc | null`
 *   - …
 *   - `buildState(verified)` → `StatedRc`
 *   - `applyCompaction(stated)` (cannot be invoked before `buildState`)
 *
 * Implementation note: mutation is preserved. Each step mutates the input
 * object and returns it cast to the next stage. The `_brand` field on each
 * extension is the only thing that distinguishes stages structurally — it is
 * never read at runtime. This lets us avoid copying ~30 fields per step
 * while still getting compile-time stage tracking.
 *
 * The final `RunContext = StatedRc` alias keeps backwards-compatible imports
 * working for the `applyCompaction` / metrics paths that ran post-`buildState`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type {
  CompressionProfile, LlmMessage, StructuredExtraction,
  ExplorationReport, ChunkSummary, SessionMessageEntry, PipelinePhaseTiming,
  CompactConfig, ProfileConfig, ProviderCapabilities, SmartCompactDetails,
  CompactionState, OpenLoop, Cell,
} from "../types.ts";
import type { PendingSlot } from "./pending-slot.ts";
import type { PruningResult } from "../utils/pruning.ts";
import type { CompactionTier } from "../utils/helpers.ts";
import type { TokenEstimator } from "../utils/tokens.ts";
import type { SmartCompactServices } from "../infra/services.ts";

// ── Shared infra types (unchanged) ───────────────────────────────────────────

export type Notifier = (msg: string, type?: "info" | "success" | "warning" | "error") => void;

export interface CancellationToken {
  controller: AbortController;
  signal: AbortSignal;
  /** Set when the auto-trigger hard timeout fires. */
  timedOut: boolean;
  /** Active setTimeout handle. Cleared in finally so we never leak timers. */
  timeoutId: ReturnType<typeof setTimeout> | null;
}

/**
 * Backward-compat alias. The pipeline previously juggled a raw
 * `{ value, createdAt }` ref-cell; the encapsulated `PendingSlot` API
 * supersedes it. We keep the name in the run-context so existing wiring
 * stays readable while every mutation goes through the slot's invariants.
 */
export type PendingRef = PendingSlot;

export interface RunFlags {
  verbose: boolean;
  dryRun: boolean;
  autoTriggered: boolean;
  skipCompact: boolean;
  force: boolean;
}

export interface ResolvedAuth {
  apiKey: string;
  headers?: Record<string, string>;
}

// ── Stage 0: Base ────────────────────────────────────────────────────────────
//
// Fields that are guaranteed before any step runs. The orchestrator's
// `makeBase()` populates this from `SmartCompactOptions`. Everything below
// adds to this base via intersection types.

export interface RcBase {
  // ExtensionContext is the narrower base shared with the event-handler ctx.
  // The pipeline never calls command-only methods (waitForIdle, newSession,
  // fork, navigate), so narrowing here lets both interactive commands and
  // `session_before_compact` events feed this same orchestrator without a
  // cast — the type system enforces the "shared surface" invariant.
  ctx: ExtensionContext;
  notify: Notifier;
  vlog: (msg: string) => void;
  services: SmartCompactServices;
  cancellation: CancellationToken;
  pendingRef: PendingRef;
  isRunning: Cell<boolean>;
  flags: RunFlags;
  userNote?: string;
  focus?: string;
  maxLlmCalls?: number;
  timeoutMs: number;
  phaseTimings: PipelinePhaseTiming[];
  pipelineStart: number;
  phaseStart: number;
  summaryModel: Model<Api>;
  segModel: Model<Api>;
  modelLabel: string;
  profile: CompressionProfile;
}

// ── Stage 1: Prepared ────────────────────────────────────────────────────────
//
// After `prepareRun` resolves config + auth. Resolved here once so later
// steps can rely on these fields existing.

export interface PreparedExt {
  /** Discriminator field; never read at runtime. */
  readonly _prepared: true;
  config: CompactConfig;
  profileCfg: ProfileConfig;
  providerCaps: ProviderCapabilities;
  estimator: TokenEstimator;
  adapted: boolean;
  summaryAuth: ResolvedAuth;
  segAuth: ResolvedAuth;
}
export type PreparedRc = RcBase & PreparedExt;

// ── Stage 2: Windowed ────────────────────────────────────────────────────────
//
// After `resolveCompactionWindow` picks the prefix of branch messages to
// summarize. Returning null from that step means "conversation too short" —
// callers must handle the null before treating an Rc as Windowed.

export interface WindowedExt extends PreparedExt {
  readonly _windowed: true;
  sessionId: string;
  branch: unknown[];
  msgs: SessionMessageEntry[];
  totalTokens: number;
  contextPercent: number;
  toolPercent: number;
  keepFrom: number;
  toCompact: SessionMessageEntry[];
  firstKeptId: string;
  accTokens: number;
}
export type WindowedRc = RcBase & WindowedExt;

// ── Stage 3: Recovered ───────────────────────────────────────────────────────

export interface RecoveredExt extends WindowedExt {
  readonly _recovered: true;
  llmMessages: LlmMessage[];
}
export type RecoveredRc = RcBase & RecoveredExt;

// ── Stage 4: Tiered ──────────────────────────────────────────────────────────
//
// After `selectTier`. If the tier is "none" the orchestrator bails before
// any further work; only "light" or "full" reach later stages.

export type ActiveTier = Exclude<CompactionTier, "none">;

export interface TieredExt extends RecoveredExt {
  readonly _tiered: true;
  tier: ActiveTier;
}
export type TieredRc = RcBase & TieredExt;

// ── Stage 5: Extracted ───────────────────────────────────────────────────────

export interface ExtractedExt extends TieredExt {
  readonly _extracted: true;
  pruning: PruningResult;
  currentEntryIds: string[];
  currentKeptEntryIds: string[];
  extraction: StructuredExtraction;
  extractionCacheMissReason?: string;
  prevContext: string;
  projectCtx: string;
  projectId: string;
  /**
   * Serialized pruned conversation text. Computed once in `extractWithCache`
   * and reused by `summarizeConversation` so we don't `serializeConversation`
   * the same 5000-message array twice on the hot path. `convTokens` is the
   * cached `estimateTokens(convText)` value.
   */
  convText: string;
  convTokens: number;
  backupPath: string | null;
}
export type ExtractedRc = RcBase & ExtractedExt;

// ── Stage 6: Synthesized ─────────────────────────────────────────────────────

export interface SynthesizedExt extends ExtractedExt {
  readonly _synthesized: true;
  finalSummary: string;
  method: "eesv" | "single-pass" | "heuristic";
  methodForMetrics: string;
  llmCalls: number;
  summaries: ChunkSummary[];
  explorationReport: ExplorationReport | null;
  explorationRounds: number;
  chunkCount: number;
}
export type SynthesizedRc = RcBase & SynthesizedExt;

// ── Stage 7: Verified ────────────────────────────────────────────────────────

export interface VerifiedExt extends SynthesizedExt {
  readonly _verified: true;
  verificationScore: number;
  verificationGaps: string[];
  verificationProvenance: import("../types.ts").VerificationProvenance;
  verified: boolean;
}
export type VerifiedRc = RcBase & VerifiedExt;

// ── Stage 8: Stated (final) ──────────────────────────────────────────────────
//
// After `buildState`. From here `applyCompaction`, `runDamageDetection`, and
// `recordSuccessMetrics` all have compile-time guarantees on the fields they
// touch — no more `rc.details!`.

export interface StatedExt extends VerifiedExt {
  readonly _stated: true;
  openLoops: OpenLoop[];
  compactionState: CompactionState;
  details: SmartCompactDetails;
  tokensSaved: number;
}
export type StatedRc = RcBase & StatedExt;

/**
 * Backwards-compatible alias.
 *
 * Modules that don't care about pipeline ordering (e.g. `applyCompaction` in
 * `persist.ts`, which only runs after `buildState`) can still take a
 * `RunContext`. New code should prefer the explicit stage types.
 */
export type RunContext = StatedRc;

/** Record an already-measured phase and advance the phase boundary. */
export function markMeasuredPhase(
  rc: RcBase,
  phase: PipelinePhaseTiming["phase"],
  startMs: number,
  endMs = Date.now(),
): void {
  rc.phaseTimings.push({ phase, durationMs: Math.max(0, endMs - startMs) });
  rc.phaseStart = endMs;
}

/** Mark the boundary between two pipeline phases for the metrics log. */
export function markPhase(rc: RcBase, phase: PipelinePhaseTiming["phase"]): void {
  markMeasuredPhase(rc, phase, rc.phaseStart);
}

/**
 * In-place stage advancement.
 *
 * Each step mutates its input then casts to the next stage. The cast is the
 * only place we widen the type — the runtime object never copies. Centralizing
 * it here means tests can spot the transition easily and IDE jumps to the
 * factory rather than scattering `as` keywords through every step.
 */
export function advance<TIn extends RcBase, TOut extends TIn>(rc: TIn, _stage: keyof TOut): TOut {
  return rc as unknown as TOut;
}
