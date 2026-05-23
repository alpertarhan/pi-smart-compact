/**
 * Core type definitions for the Smart Compact extension.
 */

import type { Model, Api } from "@earendil-works/pi-ai";

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
  status?: "success" | "timeout" | "error" | "dry-run";
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
  compactionState?: CompactionState;
  openLoops?: OpenLoop[];
}

export interface PendingCompaction {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: SmartCompactDetails;
  compactionState?: CompactionState;
}

export interface ModelOption {
  value: string;
  label: string;
  model: Model<Api>;
  supportsTools: boolean;
}

export interface VerificationResult {
  ok: boolean;
  gaps: string[];
  score: number;
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

export interface CachedExtraction {
  lastMessageIndex: number;
  extraction: StructuredExtraction;
  messageCount: number;
  timestamp: number;
  /** First/last entry IDs for branch-aware cache invalidation */
  firstEntryId?: string;
  lastEntryId?: string;
  /** Original toCompact entry IDs for branch/pivot detection. */
  entryIds?: string[];
  /** Entry IDs that survived pruning; this is the index domain of `extraction`. */
  keptEntryIds?: string[];
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
