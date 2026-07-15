/**
 * Core type definitions for the Smart Compact extension.
 */

import type { Model, Api } from "@earendil-works/pi-ai";
import type { SectionKind } from "./domain/summary-schema.ts";

/** Session type classification */
export type SessionType = "implementation" | "review" | "debugging" | "discussion";

export type CompressionProfile = "light" | "balanced" | "aggressive";

export interface ProfileConfig {
  summaryBudgetTokens: number;
  keepRecentTokens: number;
  minChunkTokens: number;
  maxChunkTokens: number;
  singlePassMaxTokens: number;
  batchMaxTokens: number;
}

export interface CompactConfig {
  profile: CompressionProfile;
  profiles: Record<CompressionProfile, ProfileConfig>;
  summaryModel: string | null;
  segmentationModel: string | null;
  autoTrigger: boolean;
  autoTriggerTimeoutMs: number;
  backupEnabled: boolean;
  backupDir: string;
  minContextPercent: number; // Don't compact below this threshold
  requireApproval: boolean;
  scrubSecrets: boolean;
  scrubPii: boolean;
  maxLlmCalls: number; // 0 = unlimited
  maxLatencyMs: number; // 0 = unlimited soft budget; hard timeout stays separate
  focusWeighting: boolean;
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
  latencyMs: number;
  success: boolean;
}

export interface PipelinePhaseTiming {
  phase: "prepare" | "recover" | "prune" | "extract" | "explore" | "synthesize" | "verify" | "state" | "persist" | "damage";
  durationMs: number;
}

export interface CompactMetricsEntry {
  ts: string;
  sessionId: string;
  totalCalls: number;
  totalInput: number;
  totalOutput: number;
  totalCacheHit: number;
  avgLatency: number;
  cacheHitRate: number;
  /** Deterministic extraction-cache stats, distinct from provider prompt-cache. */
  extractionCacheHits?: number;
  extractionCacheMisses?: number;
  extractionCacheHitRate?: number;
  extractionCacheMissReason?: string;
  profile?: string;
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
  pruneSavedTokens?: number;
  chunkCount?: number;
  fallbackReason?: string;
  verificationScore?: number;
  verificationGaps?: number;
  phaseTimings?: PipelinePhaseTiming[];
  durationMs?: number;
  redactions?: number;
  adapted?: boolean;
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
  priority: "critical" | "high" | "normal" | "low";
}

export interface SmartCompactDetails {
  method: "eesv" | "single-pass" | "heuristic";
  chunkCount: number;
  topics: string[];
  readFiles: string[];
  modifiedFiles: string[];
  totalMessages: number;
  totalTokensSummarized: number;
  llmCalls: number;
  profile: CompressionProfile;
  backupPath: string | null;
  tokensSaved: number;
  verified: boolean;
  gaps: string[];
  explorationRounds: number;
  explorationBoundaries: number;
  model: string;
  qualityScore: number;
  tokensBefore: number;
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

export interface PendingCompaction {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: SmartCompactDetails;
  compactionState?: CompactionState;
  /**
   * Project id + extraction snapshot for durable-state persistence at
   * consume time. The auto-trigger and tool paths never reach
   * `applyCompaction` (they return early), so the only moment we *know*
   * the payload is being applied is when `session_before_compact`
   * consumes it. Carrying these fields lets `persistConsumedState` write
   * the project fingerprint + compaction state exactly once, on every
   * path, at that moment.
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
  | { kind: "missing-error"; message: string }
  | { kind: "missing-constraint"; text: string }
  | { kind: "missing-decision"; summary: string }
  | { kind: "missing-goal"; goal: string }
  | { kind: "fabricated-file"; ref: string }
  | { kind: "inconsistency"; detail: string }
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

export interface StructuredExtraction {
  modifiedFiles: Array<{ path: string; toolCalls: number; lastModifiedIndex: number }>;
  readFiles: string[];
  deletedFiles: string[];
  mediaAttachments?: MediaAttachment[];
  errors: Array<{ index: number; tool: string; message: string; retryAttempted: boolean; resolved: boolean }>;
  decisions: Array<{ index: number; type: "explicit" | "implicit"; summary: string; userResponse?: string }>;
  constraints: Array<{ index: number; text: string; category: "requirement" | "preference" | "prohibition"; confidence: number }>;
  topics: Array<{ startIndex: number; endIndex: number; primaryFile: string | null; type: "implementation" | "debugging" | "exploration" | "review"; errorDensity: number }>;
  timeline: Array<{ index: number; event: string; summary: string }>;
  mainGoal: string | null;
  lastUserMessages: string[];
  lastErrors: string[];
  messageCount: number;
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
  headers?: Record<string, string>;
  maxTokens?: number;
  signal?: AbortSignal;
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
}
