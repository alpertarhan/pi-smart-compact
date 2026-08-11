import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { PROFILES } from "../constants.ts";
import type { CompactConfig, EffectiveCompactionMode, LlmMessage, ProfileConfig, SessionMessageEntry } from "../types.ts";
import { deriveProjectIdFromCwd } from "../utils/fingerprint.ts";
import { computeToolCharPercentage } from "../utils/helpers.ts";
import { readRecentDamageScores } from "../utils/damage.ts";
import { getProviderCaps, makeTokenEstimator, type TokenCalibrationStore, type TokenEstimator } from "../utils/tokens.ts";
import { MODE_POLICIES } from "./mode-policy.ts";
import type { CompactionWindowPlan } from "./run-context.ts";
import { estimateFinalSummaryAllowance, planCompactionWindow } from "./steps/window.ts";

export function preflightDamageMedian(cwd: string, config: CompactConfig): number {
  if (!config.adaptiveDamageFeedback) return 0;
  const projectId = deriveProjectIdFromCwd(cwd);
  if (!projectId) return 0;
  const recent = readRecentDamageScores(projectId, 5).slice(-3).sort((a, b) => a - b);
  return recent.length ? recent[Math.floor(recent.length / 2)] : 0;
}

export interface PreparedPreflightProfile {
  profileCfg: ProfileConfig;
  estimator: TokenEstimator;
  providerCaps: ReturnType<typeof getProviderCaps>;
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
    providerCaps: getProviderCaps(input.summaryModel.provider),
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

export interface ManualPreflightContext {
  branch: unknown[];
  msgs: SessionMessageEntry[];
  messageTokens: number[];
  totalTokens: number;
  rawEstimatedMessageTokens: number;
  modelContextWindow?: number;
  contextWindowTokens: number;
  contextPercent: number;
  toolPercent: number;
  overflowedContext: boolean;
}

/** Mode-independent session scan shared by all three preview plans. */
export function prepareManualPreflightContext(
  ctx: ExtensionContext,
  summaryModel: Model<Api>,
  tokenCalibration: TokenCalibrationStore,
): ManualPreflightContext {
  const branch = (typeof ctx.sessionManager.buildContextEntries === "function"
    ? ctx.sessionManager.buildContextEntries()
    : ctx.sessionManager.getBranch()) as unknown[];
  const msgs = branch.filter(
    (entry): entry is SessionMessageEntry => (entry as { type?: string; message?: unknown }).type === "message"
      && (entry as { message?: unknown }).message != null,
  );
  const totalTokens = ctx.getContextUsage()?.tokens ?? 0;
  const modelContextWindow = ctx.model?.contextWindow;
  const contextWindowTokens = modelContextWindow ?? 0;
  const contextPercent = contextWindowTokens > 0 ? totalTokens / contextWindowTokens * 100 : 0;
  const toolPercent = computeToolCharPercentage(branch);
  const overflowedContext = contextWindowTokens > 0 && totalTokens > contextWindowTokens;
  const estimator = makeTokenEstimator(summaryModel.provider, summaryModel.id, tokenCalibration);
  const messageTokens = msgs.map(entry => estimator.message(entry.message as LlmMessage));
  return {
    branch, msgs, messageTokens, totalTokens,
    rawEstimatedMessageTokens: messageTokens.reduce((sum, tokens) => sum + tokens, 0),
    modelContextWindow, contextWindowTokens, contextPercent, toolPercent, overflowedContext,
  };
}

export function planManualPreflight(
  ctx: ExtensionContext,
  summaryModel: Model<Api>,
  mode: EffectiveCompactionMode,
  tokenCalibration: TokenCalibrationStore,
  config: CompactConfig,
  damageMedian?: number,
  shared: ManualPreflightContext = prepareManualPreflightContext(ctx, summaryModel, tokenCalibration),
): ManualPreflight {
  const prepared = preparePreflightProfile({ cwd: ctx.cwd, summaryModel, mode, tokenCalibration, config, damageMedian });
  const {
    branch, msgs, messageTokens, totalTokens, rawEstimatedMessageTokens,
    modelContextWindow, contextWindowTokens, contextPercent, toolPercent, overflowedContext,
  } = shared;
  if (msgs.length < 3) {
    return { mode, plan: null, reason: "not-enough-messages", profileCfg: prepared.profileCfg, totalTokens, rawEstimatedMessageTokens, estimatorScale: 1, adapted: prepared.adapted, damageMedian: prepared.damageMedian, contextWindowTokens, contextPercent, toolPercent, overflowedContext };
  }
  const plan = planCompactionWindow({
    msgs,
    branch: branch as unknown[],
    messageTokens,
    totalTokens,
    modelContextWindow,
    mode,
    profileCfg: prepared.profileCfg,
    force: true,
    overflowedContext,
    finalSummaryAllowanceTokens: estimateFinalSummaryAllowance(prepared.profileCfg, prepared.estimator, prepared.providerCaps),
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
