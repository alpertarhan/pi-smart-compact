/**
 * Core type definitions for the Smart Compact extension.
 */

import type { Model, Api, ThinkingLevel, ProviderHeaders } from "@earendil-works/pi-ai";
import type { SectionKind } from "./domain/summary-schema.ts";

/** Session type classification */
export type SessionType = "implementation" | "review" | "debugging" | "discussion";

export type CompressionProfile = "light" | "balanced" | "aggressive";
export type EffectiveCompactionMode = "fast" | "balanced" | "thorough";
/** `aggressive` is accepted only as a legacy input and resolves to Fast. */
export type CompactionMode = "auto" | EffectiveCompactionMode | "aggressive";

export interface ProfileConfig {
  summaryBudgetTokens: number;
  keepRecentTokens: number;
  minChunkTokens: number;
  maxChunkTokens: number;
  singlePassMaxTokens: number;
  batchMaxTokens: number;
}

export interface CompactConfig {
  /** Execution preset. `profile` remains the backwards-compatible compression detail knob. */
  mode: CompactionMode;
  profile: CompressionProfile;
  profiles: Record<CompressionProfile, ProfileConfig>;
  summaryModel: string | null;
  segmentationModel: string | null;
  verificationModel: string | null;
  summaryThinkingLevel: ThinkingLevel | null;
  segmentationThinkingLevel: ThinkingLevel | null;
  autoTrigger: boolean;
  autoTriggerTimeoutMs: number;
  backupEnabled: boolean;
  backupDir: string;
  minContextPercent: number; // Don't compact below this threshold
  requireApproval: boolean;
  scrubSecrets: boolean;
  scrubPii: boolean;
  maxLlmCalls: number; // 0 = selected mode cap
  /** Explicit aggregate prompt-token cap; 0 uses the selected mode's safe cap. */
  maxLlmInputTokens: number;
  /** ChatGPT Codex per-call watchdog; 0 derives 15–90s from the requested output cap. */
  codexMaxCallMs: number;
  maxLatencyMs: number; // 0 = unlimited soft budget; hard timeout stays separate
  focusWeighting: boolean;
  zeroCallEnabled: boolean;
  contextGraphEnabled: boolean;
  telemetryChannel: "stable" | "canary";
  adaptiveDamageFeedback: boolean;
  onlineDamageMonitor: boolean;
  /** File paths that must always survive compaction, regardless of what the
   *  LLM summary chooses to include. Surfaced in the summary's Files Read. */
  pinPaths: string[];
}

export interface ProviderCapabilities {
  maxOutputTokens: number;
  supportsTools: boolean | "probe";
  jsonReliability: "high" | "medium" | "low";
  instructionFollowing: "high" | "medium" | "low";
  tokenRatioEstimate: number;
  concurrencyLimit: number;
  cacheStrategy: "anthropic" | "openai" | "none";
  /** Provider-specific auto-trigger timeout multiplier. Slower providers get more headroom. */
  timeoutMultiplier: number;
  /** Suggested upper bound for single-pass compaction before chunking is preferred. */
  singlePassTokenMultiplier: number;
  /** Whether provider can receive non-text blocks directly. We currently summarize metadata only. */
  multimodal: "native" | "metadata-only";
}

export interface LLMCallMetric {
  phase: "probe" | "explore" | "explore-loop" | "explore-retry" | "explore-direct" | "single-pass" | "batch" | "assemble" | "patch";
  model: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  success: boolean;
  /** True when provider usage was absent or partial and local estimates were used. */
  usageEstimated?: boolean;
}

export type ProviderRouteStage = "explore" | "synthesize" | "verify";

export interface ProviderRouteMetric {
  stage: ProviderRouteStage;
  provider: string;
  model: string;
  calls: number;
  successes: number;
  avgLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Stage-local summary quality before deterministic/LLM repair. */
  qualityScore?: number;
  qualityBasis?: "pre-repair-verification";
}

export interface PipelinePhaseTiming {
  phase: "prepare" | "recover" | "prune" | "extract" | "explore" | "synthesize" | "verify" | "state" | "persist" | "damage";
  durationMs: number;
}

export type TelemetryFailureKind =
  | "cancelled" | "timeout" | "rate-limit" | "authentication"
  | "budget" | "output-limit" | "provider" | "persistence"
  | "validation" | "verification" | "yield" | "internal";

export interface CompactMetricsEntry {
  ts: string;
  /** Local-only lifecycle id used to join post-compaction observations. */
  runId?: string;
  metricsSchemaVersion?: 2;
  version?: string;
  releaseChannel?: "stable" | "canary";
  failureKind?: TelemetryFailureKind;
  sessionId: string;
  totalCalls: number;
  totalInput: number;
  totalOutput: number;
  totalCacheHit: number;
  totalCacheWrite?: number;
  avgLatency: number;
  cacheHitRate: number;
  /** Deterministic extraction-cache stats, distinct from provider prompt-cache. */
  extractionCacheHits?: number;
  extractionCacheMisses?: number;
  extractionCacheHitRate?: number;
  extractionCacheMissReason?: string;
  profile?: string;
  mode?: CompactionMode;
  tier?: string;
  method?: string;
  model?: string;
  provider?: string;
  runType?: "manual" | "auto" | "tool";
  status?: "success" | "timeout" | "error" | "dry-run" | "cancelled";
  contextPercent?: number;
  toolPercent?: number;
  tokensBefore?: number;
  tokensSaved?: number;
  plannedAfterTokens?: number;
  plannedSavedTokens?: number;
  plannedYield?: number;
  estimatedAfterTokens?: number;
  estimatedSavedTokens?: number;
  estimatedYield?: number;
  retainedTailTokens?: number;
  summaryTokens?: number;
  summaryBudgetTokens?: number;
  targetAfterTokens?: number;
  relaxedSoftBoundaries?: Array<"recent-user-turn" | "anchor" | "topical">;
  hardBoundaryAdjusted?: boolean;
  pruneSavedTokens?: number;
  chunkCount?: number;
  fallbackReason?: string;
  verificationScore?: number;
  verificationGaps?: number;
  initialVerificationScore?: number;
  deterministicPatchCount?: number;
  llmPatched?: boolean;
  qualityFloorUsed?: boolean;
  remainingVerificationGaps?: number;
  /** Content-free kinds retained when verification fails before state commit. */
  verificationGapKinds?: VerificationGap["kind"][];
  phaseTimings?: PipelinePhaseTiming[];
  durationMs?: number;
  redactions?: number;
  adapted?: boolean;
  providerRoutes?: ProviderRouteMetric[];
  /** Durable post-apply side effects; compaction itself may still have succeeded. */
  persistenceStatus?: "complete" | "partial";
  persistenceFailures?: string[];
}

export interface TopicBoundary {
  afterIndex: number;
  topic: string;
  priority: "critical" | "high" | "normal" | "low";
  confidence: number;
}

export interface ChunkSummary {
  topic: string;
  startIndex: number;
  endIndex: number;
  summary: string;
  keyDecisions: string[];
  filesModified: string[];
  filesRead: string[];
  filesDeleted: string[];
  priority: "critical" | "high" | "normal" | "low";
}

export interface SmartCompactDetails {
  /** Correlates session_before_compact staging with session_compact commit. */
  runId?: string;
  method: "eesv" | "single-pass" | "heuristic";
  generationFallbacks?: string[];
  chunkCount: number;
  topics: string[];
  readFiles: string[];
  modifiedFiles: string[];
  totalMessages: number;
  totalTokensSummarized: number;
  llmCalls: number;
  profile: CompressionProfile;
  mode?: EffectiveCompactionMode;
  backupPath: string | null;
  tokensSaved: number;
  verified: boolean;
  gaps: string[];
  explorationRounds: number;
  explorationBoundaries: number;
  model: string;
  providerRoutes?: { explore: string; synthesize: string; verify: string };
  version?: string;
  releaseChannel?: "stable" | "canary";
  qualityScore: number;
  tokensBefore: number;
  /** Content-free planner versus verified-summary estimator evidence. */
  plannedAfterTokens?: number;
  plannedSavedTokens?: number;
  plannedYield?: number;
  estimatedAfterTokens?: number;
  estimatedSavedTokens?: number;
  estimatedYield?: number;
  retainedTailTokens?: number;
  summaryTokens?: number;
  summaryBudgetTokens?: number;
  targetAfterTokens?: number;
  relaxedSoftBoundaries?: Array<"recent-user-turn" | "anchor" | "topical">;
  hardBoundaryAdjusted?: boolean;
  provenance?: VerificationProvenance;
  redactions?: number;
  compactionState?: CompactionState;
  openLoops?: OpenLoop[];
}

/**
 * Tiny mutable single-slot ref cell. We use it (instead of bare
 * `{ value: T | null }` literals scattered across modules) for shared
 * mutable boundaries between the extension entry point and the
 * orchestrator — e.g. the run-active flag and the external cancellation
 * handle. Named explicitly so its purpose is obvious at the call site.
 *
 * Note: the *pending-compaction* slot intentionally does NOT use `Cell` —
 * it goes through the encapsulated `PendingSlot` API in
 * `src/app/pending-slot.ts` which enforces TTL + session-id invariants.
 */
export interface Cell<T> {
  value: T;
}

export type MetricsSnapshot = Omit<CompactMetricsEntry, "ts" | "sessionId">;

export interface PreparedConversationBackup {
  path: string;
  /** Eager payload retained for compatibility with direct callers. */
  content?: string;
  /** Deferred exact payload; materialized only after native apply confirmation. */
  materialize?: () => string;
  sessionId: string;
  createdAt: string;
  /** Pre-compaction leaf used for an exact, non-duplicating restore fork. */
  branchLeafId?: string;
  contextTokens?: number;
}

export interface PendingCompaction {
  /** Unique lifecycle correlation id persisted in compaction details. */
  runId: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: SmartCompactDetails;
  /** Complete metrics payload, appended only after Pi emits session_compact. */
  metricsSnapshot?: MetricsSnapshot;
  compactionState?: CompactionState;
  /** Exact backup source, written only after native apply confirmation. */
  preparedBackup?: PreparedConversationBackup;
  /**
   * Project id + extraction snapshot for durable-state persistence after
   * Pi confirms the entry via `session_compact`. Consuming in
   * `session_before_compact` only stages the candidate; it is not a commit.
   */
  projectId?: string;
  extraction?: StructuredExtraction;
  /**
   * Originating pi session id. Used by `session_before_compact` to refuse a
   * pending payload that was prepared by a different session (e.g. when two
   * pi sessions share the same Node process via sub-agents). Without this
   * guard, session A's prepared summary could be applied to session B and
   * silently corrupt its conversation.
   */
  sessionId: string;
}

export interface ModelOption {
  value: string;
  label: string;
  model: Model<Api>;
  /**
   * Tri-state tool support hint:
   *   true   - confirmed (cached or known-good provider)
   *   false  - confirmed unsupported (cached after a failed probe)
   *   "probe" - unknown; will be runtime-probed during exploration
   * The previous boolean form always set `true` in the UI, which silently
   * lied to the user about providers like LM Studio that don't actually
   * support function calling.
   */
  supportsTools: boolean | "probe";
}

export type VerificationGap =
  | { kind: "missing-section"; section: SectionKind }
  | { kind: "missing-file"; path: string }
  | { kind: "missing-read-file"; path: string }
  | { kind: "missing-deleted-file"; path: string }
  | { kind: "missing-error"; message: string; resolved?: boolean }
  | { kind: "missing-constraint"; text: string }
  | { kind: "missing-decision"; summary: string }
  | { kind: "missing-goal"; goal: string }
  | { kind: "fabricated-file"; ref: string }
  | { kind: "inconsistency"; detail: string }
  | { kind: "unsupported-claim"; claim: string }
  | { kind: "missing-open-loops"; unresolvedCount: number };

export interface VerificationResult {
  ok: boolean;
  gaps: VerificationGap[];
  score: number;
}

export interface VerificationProvenance {
  initialScore: number;
  deterministicPatched: VerificationGap[];
  llmPatched: boolean;
  qualityFloorUsed?: boolean;
  finalScore: number;
  remainingGaps: VerificationGap[];
}

export interface ExplorationReport {
  boundaries: TopicBoundary[];
  mainGoal: string;
  sessionType: SessionType;
  enrichedConstraints: string[];
  crossReferences: string[];
  statusAssessment: { done: string[]; inProgress: string[]; blocked: string[] };
  criticalContext: string[];
  keyDecisions: string[];
}

export interface MediaAttachment {
  index: number;
  kind: "image" | "file" | "audio" | "video" | "unknown";
  mimeType?: string;
  name?: string;
  sizeBytes?: number;
  source?: string;
}
export interface ExtractionEvidenceOverflow {
  modifiedFiles?: number;
  readFiles?: number;
  deletedFiles?: number;
  errors?: number;
  decisions?: number;
  constraints?: number;
  timeline?: number;
  mediaAttachments?: number;
}


export interface StructuredExtraction {
  modifiedFiles: Array<{ path: string; toolCalls: number; lastModifiedIndex: number }>;
  readFiles: string[];
  deletedFiles: string[];
  /** File paths grounded in compacted source evidence but not necessarily touched by a tool. */
  referencedFiles?: string[];
  mediaAttachments?: MediaAttachment[];
  errors: Array<{
    index: number;
    tool: string;
    message: string;
    retryAttempted: boolean;
    resolved: boolean;
    /** Stable failed-operation identity used to reconcile incremental retries without source messages. */
    operationSignature?: string;
  }>;
  decisions: Array<{ index: number; type: "explicit" | "implicit"; summary: string; userResponse?: string }>;
  constraints: Array<{ index: number; text: string; category: "requirement" | "preference" | "prohibition"; confidence: number }>;
  topics: Array<{ startIndex: number; endIndex: number; primaryFile: string | null; type: "implementation" | "debugging" | "exploration" | "review"; errorDensity: number }>;
  timeline: Array<{ index: number; event: string; summary: string }>;
  mainGoal: string | null;
  lastUserMessages: string[];
  lastErrors: string[];
  messageCount: number;
  /** Counts of older, lower-priority evidence omitted from the bounded summary domain. */
  evidenceOverflow?: ExtractionEvidenceOverflow;
}

export interface LlmChunk {
  startIndex: number;
  endIndex: number;
  tokenEstimate: number;
  topic: string;
  priority: "critical" | "high" | "normal" | "low";
  messages: LlmMessage[];
}

export interface LlmMessage {
  role: "user" | "assistant" | "toolResult";
  content?: unknown;
  isError?: boolean;
  toolCallId?: string;
  /**
   * Optional tool name on `toolResult` messages. Some providers require it
   * alongside `toolCallId` (Anthropic), others ignore it. We store it when
   * we know it so the explore-loop can round-trip the metadata back to the
   * provider without re-fetching the original toolCall block.
   */
  toolName?: string;
  timestamp?: number;
}



export interface LlmTextBlock { type: "text"; text: string; }
export interface LlmToolCallBlock { type: "toolCall"; id?: string; name: string; arguments: Record<string, unknown>; }
export type LlmContentBlock = LlmTextBlock | LlmToolCallBlock | string;

export interface CacheAwareOptions {
  apiKey?: string;
  headers?: ProviderHeaders;
  maxTokens?: number;
  maxRetries?: number;
  codexWatchdogMs?: number;
  signal?: AbortSignal;
  reasoning?: ThinkingLevel;
  cacheRetention?: "none" | "short" | "long";
  sessionId?: string;
}

/**
 * Compact summary of an entry-ID list used for cache prefix matching.
 *
 * Storing the full id array on disk balloons the cache file linearly with
 * session length (5k msgs ⇒ ~100KB rewritten on every compact). The fingerprint
 * captures everything `extractWithCache` actually checks:
 *
 *  - `count` — array length, used to bound the prefix verification.
 *  - `prefixHash` — sha256 over `ids.join("\n")`, used to *prove* the cached
 *    prefix is a prefix of the current run without storing the full list.
 *  - `tail` — last few ids verbatim, used as a fast first-line sanity check
 *    before computing the hash. Cheap O(K) string compare.
 */
export interface EntryIdFingerprint {
  count: number;
  prefixHash: string;
  tail: string[];
}

export interface CachedExtraction {
  lastMessageIndex: number;
  extraction: StructuredExtraction;
  messageCount: number;
  timestamp: number;
  /** First/last entry IDs for branch-aware cache invalidation */
  firstEntryId?: string;
  lastEntryId?: string;
  /** Legacy: full id array. Kept on the type for backwards-compatible reads of
   *  older cache files. New saves use {entryIdsFp, keptEntryIdsFp} instead. */
  entryIds?: string[];
  /** Legacy: full kept-id array. See `entryIds`. */
  keptEntryIds?: string[];
  /** Compact branch fingerprint (replaces `entryIds` for new caches). */
  entryIdsFp?: EntryIdFingerprint;
  /** Compact pruned fingerprint (replaces `keptEntryIds` for new caches). */
  keptEntryIdsFp?: EntryIdFingerprint;
}

/** An open loop — unresolved task detected during compaction */
export interface OpenLoop {
  id: string;
  type: "bugfix" | "follow-up" | "blocked" | "pending" | "retry";
  priority: "critical" | "high" | "normal" | "low";
  status: "open" | "in-progress" | "resolved";
  summary: string;
  files: string[];
  sourceIndex?: number;
}

export interface LoopOverride {
  id: string;
  summaryKey: string;
  status?: OpenLoop["status"];
  priority?: OpenLoop["priority"];
  pinned?: boolean;
}

export type ContinuityFactKind = "decision" | "constraint" | "error" | "loop";
export interface ContinuityOverride {
  id: string;
  kind: ContinuityFactKind;
  summaryKey: string;
  status: "active" | "resolved" | "superseded";
  replacement?: string;
  updatedAt: number;
}

/** Durable scope for state reuse: project identity + session + branch ancestry. */
export interface ContinuityScope {
  schemaVersion: 2;
  projectId: string;
  sessionId: string;
  branchHeadId?: string;
  /** Bounded active ancestry used to resolve facts without touching siblings. */
  branchAncestryIds?: string[];
}

/** Structured machine-readable compaction state */
export interface CompactionState {
  goal: string | null;
  decisions: Array<{ id: string; summary: string; userResponse?: string; type: "explicit" | "implicit" }>;
  constraints: Array<{ id: string; text: string; category: "requirement" | "preference" | "prohibition"; confidence: number }>;
  modifiedFiles: string[];
  readFiles: string[];
  deletedFiles: string[];
  unresolvedErrors: Array<{ id: string; message: string; tool: string; files: string[] }>;
  resolvedErrors: Array<{ id: string; message: string; tool: string }>;
  openLoops: OpenLoop[];
  loopOverrides?: LoopOverride[];
  factOverrides?: ContinuityOverride[];
  scope?: ContinuityScope;
  topics: Array<{ title: string; type: string; priority: string }>;
  nextActions: string[];
  criticalContext: string[];
  sessionType: SessionType;
  compactionVersion: string;
  updatedAt?: number;
}

/** Shared session message entry type (branch entry filter) */
export interface SessionMessageEntry { type: "message"; id: string; message: unknown }

export interface ProgressState {
  phase: number;
  phaseName: string;
  detail: string;
  extraction?: StructuredExtraction;
  explorationRounds?: number;
  totalBatches?: number;
  currentBatch?: number;
  model?: string;
  profile?: string;
  mode?: CompactionMode;
}
