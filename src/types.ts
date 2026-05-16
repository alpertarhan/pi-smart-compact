/**
 * Core type definitions for the Smart Compact extension.
 */

import type { Model, Api } from "@earendil-works/pi-ai";

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
  backupEnabled: boolean;
  backupDir: string;
}

export interface ProviderCapabilities {
  maxOutputTokens: number;
  supportsTools: boolean | "probe";
  jsonReliability: "high" | "medium" | "low";
  instructionFollowing: "high" | "medium" | "low";
  tokenRatioEstimate: number;
  concurrencyLimit: number;
  cacheStrategy: "anthropic" | "openai" | "none";
}

export interface LLMCallMetric {
  phase: "probe" | "explore" | "explore-loop" | "explore-retry" | "explore-direct" | "single-pass" | "batch" | "assemble" | "patch";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  latencyMs: number;
  success: boolean;
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
}

export interface PendingCompaction {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: SmartCompactDetails;
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
  sessionType: "implementation" | "review" | "debugging" | "discussion";
  enrichedConstraints: string[];
  crossReferences: string[];
  statusAssessment: { done: string[]; inProgress: string[]; blocked: string[] };
  criticalContext: string[];
  keyDecisions: string[];
}

export interface StructuredExtraction {
  modifiedFiles: Array<{ path: string; toolCalls: number; lastModifiedIndex: number }>;
  readFiles: string[];
  deletedFiles: string[];
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

export interface ToolCallBlock {
  type: "toolCall";
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface LlmTextBlock { type: "text"; text: string; }
export interface LlmToolCallBlock { type: "toolCall"; id?: string; name: string; arguments: Record<string, unknown>; }
export type LlmContentBlock = LlmTextBlock | LlmToolCallBlock | string;

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
