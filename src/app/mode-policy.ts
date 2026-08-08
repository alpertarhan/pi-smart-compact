import type {
  CompactionMode, CompactionState, CompressionProfile, EffectiveCompactionMode, StructuredExtraction,
} from "../types.ts";

export interface ModePolicy {
  profile: CompressionProfile;
  maxLlmCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  explore: boolean;
  allowLlmPatch: boolean;
  singlePassMultiplier: number;
  batchOutput: { min: number; perChunk: number; max: number };
  targetContextPercent: number;
}

export const MODE_POLICIES: Readonly<Record<EffectiveCompactionMode, ModePolicy>> = {
  fast: {
    profile: "aggressive", maxLlmCalls: 3, maxInputTokens: 100_000, maxOutputTokens: 20_000,
    explore: false, allowLlmPatch: false, singlePassMultiplier: 2,
    batchOutput: { min: 800, perChunk: 160, max: 2_400 }, targetContextPercent: 30,
  },
  balanced: {
    profile: "balanced", maxLlmCalls: 6, maxInputTokens: 200_000, maxOutputTokens: 40_000,
    explore: false, allowLlmPatch: false, singlePassMultiplier: 1.5,
    batchOutput: { min: 1_000, perChunk: 250, max: 4_096 }, targetContextPercent: 40,
  },
  thorough: {
    profile: "light", maxLlmCalls: 8, maxInputTokens: 300_000, maxOutputTokens: 80_000,
    explore: true, allowLlmPatch: true, singlePassMultiplier: 0.9,
    batchOutput: { min: 1_500, perChunk: 400, max: 6_000 }, targetContextPercent: 50,
  },
};

export function modeFromLegacyProfile(profile: CompressionProfile): EffectiveCompactionMode {
  return profile === "light" ? "thorough" : profile === "aggressive" ? "fast" : "balanced";
}

/** Cheap preflight choice used before deterministic extraction is available. */
export function resolveMode(
  requested: CompactionMode,
  contextPercent: number,
  extraction?: StructuredExtraction,
  additionalRisk = 0,
): EffectiveCompactionMode {
  if (requested !== "auto") return requested === "aggressive" ? "fast" : requested;
  if (contextPercent >= 85) return "fast";
  if (!extraction) return contextPercent < 70 ? "fast" : "balanced";

  const unresolved = extraction.errors.filter(error => !error.resolved).length;
  const risk = unresolved * 2
    + extraction.decisions.length
    + extraction.constraints.length
    + Math.ceil(extraction.modifiedFiles.length / 5)
    + Math.ceil(extraction.topics.length / 4)
    + additionalRisk;
  if (risk >= 12) return "thorough";
  if (risk <= 3) return "fast";
  return "balanced";
}

export function deterministicExtractionConfidence(
  extraction: StructuredExtraction,
  context: { conversationTokens?: number; toolPercent?: number } = {},
): number {
  let score = 0.45;
  if (extraction.mainGoal) score += 0.15;
  if (extraction.messageCount > 0) score += 0.05;
  if (extraction.lastUserMessages.length > 0) score += 0.1;
  if (extraction.modifiedFiles.length + extraction.deletedFiles.length + extraction.decisions.length + extraction.constraints.length > 0) score += 0.15;
  if (extraction.messageCount > 80) score -= 0.2;
  if ((context.conversationTokens ?? 0) > 40_000) score -= 0.4;
  if (extraction.messageCount > 0
    && (context.conversationTokens ?? 0) / extraction.messageCount > 2_000) score -= 0.35;
  if ((context.toolPercent ?? 0) > 60) score -= 0.25;
  if (extraction.topics.length > 6) score -= 0.15;
  if (extraction.errors.filter(error => !error.resolved).length > 2) score -= 0.2;
  if ((extraction.mediaAttachments?.length ?? 0) > 0) score -= 0.15;
  return Math.max(0, Math.min(1, score));
}

export function continuityRisk(state: CompactionState | null): number {
  if (!state) return 0;
  return Math.min(12,
    state.unresolvedErrors.length * 2
    + state.openLoops.filter(loop => loop.status !== "resolved").length
    + Math.ceil((state.decisions.length + state.constraints.length) / 5),
  );
}

export function batchOutputLimit(mode: EffectiveCompactionMode, chunks: number, providerMax: number): number {
  const budget = MODE_POLICIES[mode].batchOutput;
  return Math.min(Math.max(budget.min, chunks * budget.perChunk), budget.max, providerMax);
}

export function effectiveBudget(configured: number, modeDefault: number): number {
  if (configured <= 0) return modeDefault;
  return Math.min(configured, modeDefault);
}
