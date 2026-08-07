import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { PROFILES } from "../constants.ts";
import type { CompactConfig, EffectiveCompactionMode, LlmMessage, ProfileConfig, SessionMessageEntry } from "../types.ts";
import { deriveProjectIdFromCwd } from "../utils/fingerprint.ts";
import { computeToolCharPercentage } from "../utils/helpers.ts";
import { readRecentDamageScores } from "../utils/damage.ts";
import { makeTokenEstimator, type TokenCalibrationStore, type TokenEstimator } from "../utils/tokens.ts";
import { MODE_POLICIES } from "./mode-policy.ts";
import type { CompactionWindowPlan } from "./run-context.ts";
import { planCompactionWindow } from "./steps/window.ts";

export function preflightDamageMedian(cwd: string, config: CompactConfig): number {
  if (!config.adaptiveDamageFeedback) return 0;
  const recent = readRecentDamageScores(deriveProjectIdFromCwd(cwd), 5).slice(-3).sort((a, b) => a - b);
  return recent.length ? recent[Math.floor(recent.length / 2)] : 0;
}

export interface PreparedPreflightProfile {
  profileCfg: ProfileConfig;
  estimator: TokenEstimator;
  adapted: boolean;
  damageMedian: number;
}

/** Shared deterministic preparation used by both the preview and the real run. */
export function preparePreflightProfile(input: {
  cwd: string;
  summaryModel: Model<Api>;
  mode: EffectiveCompactionMode;
  tokenCalibration: TokenCalibrationStore;
  config: CompactConfig;
  damageMedian?: number;
}): PreparedPreflightProfile {
  const config = input.config;
  const profile = MODE_POLICIES[input.mode].profile;
  let profileCfg = { ...PROFILES[profile], ...(config.profiles?.[profile] ?? {}) };
  const damageMedian = input.damageMedian ?? preflightDamageMedian(input.cwd, config);
  if (damageMedian >= 25) {
    profileCfg = {
      ...profileCfg,
      keepRecentTokens: Math.round(profileCfg.keepRecentTokens * (damageMedian >= 50 ? 1.5 : 1.25)),
      summaryBudgetTokens: Math.round(profileCfg.summaryBudgetTokens * (damageMedian >= 50 ? 1.3 : 1.2)),
    };
  }
  return {
    profileCfg,
    estimator: makeTokenEstimator(input.summaryModel.provider, input.summaryModel.id, input.tokenCalibration),
    adapted: damageMedian >= 25,
    damageMedian,
  };
}

export interface ManualPreflight {
  mode: EffectiveCompactionMode;
  plan: CompactionWindowPlan | null;
  reason: CompactionWindowPlan["reason"] | "not-enough-messages";
  profileCfg: ProfileConfig;
  totalTokens: number;
  rawEstimatedMessageTokens: number;
  estimatorScale: number;
  adapted: boolean;
  damageMedian: number;
  contextWindowTokens: number;
  contextPercent: number;
  toolPercent: number;
  overflowedContext: boolean;
}

export function planManualPreflight(
  ctx: ExtensionContext,
  summaryModel: Model<Api>,
  mode: EffectiveCompactionMode,
  tokenCalibration: TokenCalibrationStore,
  config: CompactConfig,
  damageMedian?: number,
): ManualPreflight {
  const prepared = preparePreflightProfile({ cwd: ctx.cwd, summaryModel, mode, tokenCalibration, config, damageMedian });
  const manager = ctx.sessionManager;
  const branch = typeof manager.buildContextEntries === "function" ? manager.buildContextEntries() : manager.getBranch();
  const msgs = branch.filter(
    (entry: { type: string; message?: unknown }) => entry.type === "message" && entry.message != null,
  ) as SessionMessageEntry[];
  const totalTokens = ctx.getContextUsage()?.tokens ?? 0;
  const contextWindowTokens = ctx.model?.contextWindow ?? 0;
  const contextPercent = contextWindowTokens > 0 ? totalTokens / contextWindowTokens * 100 : 0;
  const toolPercent = computeToolCharPercentage(branch);
  const overflowedContext = contextWindowTokens > 0 && totalTokens > contextWindowTokens;
  const messageTokens = msgs.map(entry => prepared.estimator.message(entry.message as LlmMessage));
  const rawEstimatedMessageTokens = messageTokens.reduce((sum, tokens) => sum + tokens, 0);
  if (msgs.length < 3) {
    return { mode, plan: null, reason: "not-enough-messages", profileCfg: prepared.profileCfg, totalTokens, rawEstimatedMessageTokens, estimatorScale: 1, adapted: prepared.adapted, damageMedian: prepared.damageMedian, contextWindowTokens, contextPercent, toolPercent, overflowedContext };
  }
  const plan = planCompactionWindow({
    msgs,
    branch: branch as unknown[],
    messageTokens,
    totalTokens,
    modelContextWindow: ctx.model?.contextWindow,
    mode,
    profileCfg: prepared.profileCfg,
    force: true,
    overflowedContext,
  });
  const normalizedMessages = plan.compactTokens + plan.retainedTokens;
  return {
    mode,
    plan,
    reason: plan.reason,
    profileCfg: prepared.profileCfg,
    totalTokens,
    rawEstimatedMessageTokens,
    estimatorScale: rawEstimatedMessageTokens > 0 ? normalizedMessages / rawEstimatedMessageTokens : 1,
    adapted: prepared.adapted,
    damageMedian: prepared.damageMedian,
    contextWindowTokens,
    contextPercent,
    toolPercent,
    overflowedContext,
  };
}
