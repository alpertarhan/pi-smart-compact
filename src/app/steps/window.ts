/** Step 2: select and validate the active-context prefix to summarize. */

import type {
  CompactionPlanReason,
  CompactionWindowPlan,
  PreparedRc,
  RelaxedSoftBoundary,
  WindowedRc,
} from "../run-context.ts";
import { advance } from "../run-context.ts";
import type {
  EffectiveCompactionMode,
  LlmMessage,
  ProfileConfig,
  ProviderCapabilities,
  SessionMessageEntry,
} from "../../types.ts";
import { MODE_POLICIES, modeFromLegacyProfile } from "../mode-policy.ts";
import {
  advancePastToolCallBoundary,
  buildToolCallBoundaryIndex,
  guardToolCallBoundary,
  smartKeepBoundaryCandidates,
} from "../../utils/helpers.ts";
import { resolveSessionId } from "../../infra/session-identity.ts";
import {
  MAX_STATE_OPEN_LOOPS,
  MIN_COMPACTION_SAVING_RATIO,
  POST_SUMMARY_RESERVE_RATIO,
  TRUNC,
} from "../../constants.ts";
import { safeContextPercent, type TokenEstimator } from "../../utils/tokens.ts";
import { isRecord } from "../../utils/type-guards.ts";

export type { CompactionWindowPlan } from "../run-context.ts";

export interface CompactionWindowPlanInput {
  msgs: SessionMessageEntry[];
  branch: unknown[];
  messageTokens: number[];
  totalTokens: number;
  modelContextWindow?: number;
  mode: EffectiveCompactionMode;
  profileCfg: ProfileConfig;
  force: boolean;
  /** Estimated final summary size in the same local units as messageTokens. */
  finalSummaryAllowanceTokens?: number;
}

/** Canonical user-facing wording for every planner outcome. */
export function compactionPlanReasonText(reason: CompactionPlanReason): string {
  switch (reason) {
    case "viable":
      return "safe window and useful estimated saving";
    case "no-eligible-prefix":
      return "no older prefix is available";
    case "unsafe-tool-boundary":
      return "no provider-safe complete tool-call boundary is available";
    case "retention-target-exceeded":
      return "a complete tool pair exceeds the tail target";
    case "mode-target-not-met":
      return "the estimated result misses this preset's target";
    case "insufficient-projected-saving":
      return "estimated saving is below 10%";
  }
}

/** Pure, content-free result suitable for both execution and a later UI preview. */
export function estimateFinalSummaryAllowance(
  profileCfg: ProfileConfig,
  estimator: TokenEstimator,
  providerCaps: ProviderCapabilities | undefined,
): number {
  const maxModelOutputChars = Math.ceil(
    profileCfg.summaryBudgetTokens * (providerCaps?.tokenRatioEstimate ?? 3.8),
  );
  // Deterministic repair, delta, open-loop, and continuity rendering happens
  // after the provider output cap. Bound it from the same named storage caps.
  const deterministicChars =
    TRUNC.PREVIOUS_SUMMARY +
    TRUNC.CONTINUITY_CAPSULE +
    MAX_STATE_OPEN_LOOPS * (TRUNC.OPEN_LOOP_SUMMARY + 24);
  const calibratedOutput = estimator.text("x".repeat(maxModelOutputChars));
  const calibratedPostProcessing = estimator.text(
    "x".repeat(deterministicChars),
  );
  const legacyFloor =
    profileCfg.summaryBudgetTokens +
    Math.ceil(profileCfg.summaryBudgetTokens * POST_SUMMARY_RESERVE_RATIO);
  return Math.max(legacyFloor, calibratedOutput + calibratedPostProcessing);
}
const PORTABLE_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Retained messages are sent to the active provider verbatim by Pi. Historical
 * wrapper/MCP names may contain dots or namespace separators that some
 * providers reject before the next turn starts. Summarize the whole offending
 * exchange instead of leaving an unusable live tail.
 */
function advancePastNonPortableToolExchanges(
  msgs: SessionMessageEntry[],
  keepFrom: number,
  toolCallIndex: ReadonlyMap<string, number>,
): number {
  if (keepFrom < 0 || keepFrom >= msgs.length) return keepFrom;
  const exchangeEnds = new Map<number, number>();
  for (let index = keepFrom; index < msgs.length; index++) {
    const message = msgs[index].message;
    if (
      !isRecord(message) ||
      message.role !== "toolResult" ||
      typeof message.toolCallId !== "string"
    )
      continue;
    const callIndex = toolCallIndex.get(message.toolCallId);
    if (callIndex === undefined || callIndex < keepFrom) continue;
    exchangeEnds.set(
      callIndex,
      Math.max(exchangeEnds.get(callIndex) ?? 0, index + 1),
    );
  }

  let adjusted = keepFrom;
  for (let index = keepFrom; index < msgs.length; index++) {
    const message = msgs[index].message;
    if (!isRecord(message)) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const nonPortable = message.content.some(
        (block) =>
          isRecord(block) &&
          block.type === "toolCall" &&
          (typeof block.name !== "string" ||
            !PORTABLE_TOOL_NAME_RE.test(block.name)),
      );
      if (nonPortable)
        adjusted = Math.max(adjusted, exchangeEnds.get(index) ?? index + 1);
    } else if (
      message.role === "toolResult" &&
      typeof message.toolName === "string" &&
      !PORTABLE_TOOL_NAME_RE.test(message.toolName)
    ) {
      adjusted = Math.max(adjusted, index + 1);
    }
  }
  return adjusted;
}

export function planCompactionWindow(
  input: CompactionWindowPlanInput,
): CompactionWindowPlan {
  const {
    msgs,
    branch,
    messageTokens,
    totalTokens,
    modelContextWindow,
    mode,
    profileCfg,
    force,
    finalSummaryAllowanceTokens,
  } = input;
  const tokenPrefix = new Array<number>(messageTokens.length + 1);
  tokenPrefix[0] = 0;
  for (let index = 0; index < messageTokens.length; index++) {
    tokenPrefix[index + 1] = tokenPrefix[index] + messageTokens[index];
  }
  const allMessageTokens = tokenPrefix[messageTokens.length];
  // Host usage can include system prompt, tool schemas, images, and provider
  // accounting that are absent from our message estimator. Treat any positive
  // remainder as uncompactable fixed context. Scaling message estimates up to
  // the whole usage (the old overflow path) double-counted that overhead as
  // compactable and could approve a plan that still exceeded the model window.
  const messageScale =
    totalTokens > 0 && allMessageTokens > totalTokens
      ? totalTokens / allMessageTokens
      : 1;
  const fixedContextTokens = Math.max(0, totalTokens - allMessageTokens);
  const adaptiveKeepTokens = modelContextWindow
    ? Math.min(
        profileCfg.keepRecentTokens * 2,
        Math.max(profileCfg.keepRecentTokens, modelContextWindow * 0.04),
      )
    : profileCfg.keepRecentTokens;
  const targetPercent = MODE_POLICIES[mode].targetContextPercent;
  // Execution/preflight callers provide a calibrated upper bound. Direct
  // planner consumers retain the conservative legacy floor.
  const postSummaryReserveTokens = Math.ceil(
    profileCfg.summaryBudgetTokens * POST_SUMMARY_RESERVE_RATIO,
  );
  const finalSummaryAllowance =
    finalSummaryAllowanceTokens ??
    profileCfg.summaryBudgetTokens + postSummaryReserveTokens;
  const targetRetainedTokens = modelContextWindow
    ? Math.max(
        0,
        (modelContextWindow * targetPercent) / 100 -
          fixedContextTokens -
          finalSummaryAllowance,
      )
    : adaptiveKeepTokens;
  const retentionCeiling = force
    ? adaptiveKeepTokens
    : Math.max(adaptiveKeepTokens, targetRetainedTokens);
  const rawMinimumTail = adaptiveKeepTokens / messageScale;
  const rawRetentionCeiling = retentionCeiling / messageScale;

  let rawRetained = 0;
  let keepFrom = msgs.length - 1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const next = messageTokens[i];
    if (
      rawRetained >= rawMinimumTail &&
      rawRetained + next > rawRetentionCeiling
    ) {
      keepFrom = i + 1;
      break;
    }
    rawRetained += next;
    keepFrom = i;
  }

  const relaxedSoftBoundaries: RelaxedSoftBoundary[] = [];
  const retainedAt = (from: number) =>
    Math.round((allMessageTokens - tokenPrefix[from]) * messageScale);
  const toolCallIndex = buildToolCallBoundaryIndex(msgs);
  // Message boundaries can overshoot the token ceiling by one message; that
  // baseline is the tightest plan this pipeline can represent.
  const effectiveRetentionCeiling = Math.max(
    retentionCeiling,
    retainedAt(keepFrom),
  );
  let hardBoundaryAdjusted = false;
  const trySoftBoundary = (
    kind: RelaxedSoftBoundary,
    candidate: number | undefined,
  ) => {
    if (candidate === undefined || candidate >= keepFrom) return;
    const guarded = guardToolCallBoundary(msgs, candidate, toolCallIndex);
    if (retainedAt(guarded) <= effectiveRetentionCeiling) {
      keepFrom = guarded;
      hardBoundaryAdjusted ||= guarded !== candidate;
    } else relaxedSoftBoundaries.push(kind);
  };

  let userOrdinal = 0;
  let protectedUserIndex: number | undefined;
  for (let index = msgs.length - 1; index >= 0; index--) {
    const message = msgs[index].message;
    if (!isRecord(message) || message.role !== "user") continue;
    userOrdinal++;
    protectedUserIndex = index;
    if (userOrdinal === 2) break;
  }
  trySoftBoundary("recent-user-turn", protectedUserIndex);

  const anchor = smartKeepBoundaryCandidates(msgs, keepFrom, branch).find(
    (candidate) => candidate.kind === "anchor",
  );
  trySoftBoundary("anchor", anchor?.keepFrom);
  const topical = smartKeepBoundaryCandidates(msgs, keepFrom).find(
    (candidate) => candidate.kind === "topical",
  );
  trySoftBoundary("topical", topical?.keepFrom);

  const boundaryBeforeHardGuard = keepFrom;
  const backwardBoundary = guardToolCallBoundary(msgs, keepFrom, toolCallIndex);
  const forwardBoundary =
    retainedAt(backwardBoundary) > effectiveRetentionCeiling
      ? advancePastToolCallBoundary(msgs, keepFrom, toolCallIndex)
      : keepFrom;
  keepFrom =
    forwardBoundary > keepFrom &&
    forwardBoundary < msgs.length &&
    retainedAt(forwardBoundary) <= effectiveRetentionCeiling
      ? forwardBoundary
      : backwardBoundary;
  hardBoundaryAdjusted ||= keepFrom !== boundaryBeforeHardGuard;
  const providerSafeBoundary = advancePastNonPortableToolExchanges(
    msgs,
    keepFrom,
    toolCallIndex,
  );
  const nonPortableTailBlocked = providerSafeBoundary >= msgs.length;
  if (!nonPortableTailBlocked && providerSafeBoundary > keepFrom) {
    keepFrom = providerSafeBoundary;
    hardBoundaryAdjusted = true;
  }
  const compactTokens = Math.round(tokenPrefix[keepFrom] * messageScale);
  const retainedTokens = retainedAt(keepFrom);
  const projectedAfterTokens =
    fixedContextTokens + retainedTokens + finalSummaryAllowance;
  const projectedSavedTokens = Math.max(0, totalTokens - projectedAfterTokens);
  const projectedYield =
    totalTokens > 0 ? projectedSavedTokens / totalTokens : 0;
  const targetAfterTokens =
    !force && modelContextWindow
      ? (modelContextWindow * targetPercent) / 100
      : fixedContextTokens + effectiveRetentionCeiling + finalSummaryAllowance;

  let reason: CompactionPlanReason = "viable";
  const firstKeptMessage = msgs[keepFrom]?.message;
  if (
    nonPortableTailBlocked ||
    (isRecord(firstKeptMessage) && firstKeptMessage.role === "toolResult")
  )
    reason = "unsafe-tool-boundary";
  else if (keepFrom <= 0) reason = "no-eligible-prefix";
  else if (retainedTokens > effectiveRetentionCeiling)
    reason = "retention-target-exceeded";
  else if (
    !force &&
    modelContextWindow &&
    projectedAfterTokens > targetAfterTokens
  )
    reason = "mode-target-not-met";
  else if (projectedYield < MIN_COMPACTION_SAVING_RATIO)
    reason = "insufficient-projected-saving";

  return {
    keepFrom,
    compactTokens,
    retainedTokens,
    projectedAfterTokens,
    projectedSavedTokens,
    projectedYield,
    fixedContextTokens,
    retentionTargetTokens: effectiveRetentionCeiling,
    summaryBudgetTokens: profileCfg.summaryBudgetTokens,
    finalSummaryAllowanceTokens: finalSummaryAllowance,
    targetAfterTokens,
    hardBoundaryAdjusted,
    viable: reason === "viable",
    reason,
    relaxedSoftBoundaries,
  };
}

export function resolveCompactionWindow(rc: PreparedRc): WindowedRc | null {
  const totalTokens = rc.ctx.getContextUsage()?.tokens ?? 0;
  const manager = rc.ctx.sessionManager;
  const branch =
    typeof manager.buildContextEntries === "function"
      ? manager.buildContextEntries()
      : manager.getBranch();
  const msgs = branch.filter(
    (entry: { type: string; message?: unknown }) =>
      entry.type === "message" && entry.message != null,
  ) as SessionMessageEntry[];
  if (msgs.length < 3) {
    if (rc.flags.force)
      rc.notify(
        "Manual compaction skipped: fewer than 3 active messages are available.",
        "warning",
      );
    return null;
  }

  const mode =
    rc.mode ?? (rc.profile ? modeFromLegacyProfile(rc.profile) : "balanced");
  const modelContextWindow = rc.ctx.model?.contextWindow;
  const overflowedContext =
    !!rc.flags.overflowRecovery ||
    (Number.isFinite(modelContextWindow) &&
      (modelContextWindow ?? 0) > 0 &&
      totalTokens > (modelContextWindow as number));
  const plan = planCompactionWindow({
    msgs,
    branch: branch as unknown[],
    messageTokens: msgs.map((entry) =>
      rc.estimator.message(entry.message as LlmMessage),
    ),
    totalTokens,
    modelContextWindow: rc.ctx.model?.contextWindow,
    mode,
    profileCfg: rc.profileCfg,
    force: rc.flags.force,
    finalSummaryAllowanceTokens: estimateFinalSummaryAllowance(
      rc.profileCfg,
      rc.estimator,
      rc.providerCaps,
    ),
  });

  if (!plan.viable) {
    if (rc.flags.force) {
      rc.notify(
        "Manual compaction skipped: " +
          compactionPlanReasonText(plan.reason) +
          ".",
        "warning",
      );
    } else {
      rc.notify(
        "Smart compact skipped: the safe plan cannot meet its target; using native compaction instead.",
        "warning",
      );
    }
    return null;
  }

  if (overflowedContext && plan.relaxedSoftBoundaries.length) {
    rc.notify(
      "Context exceeds the active model window. EESV will summarize through soft recent-turn/checkpoint protections while preserving complete tool-call pairs; native fallback would resend the oversized context.",
      "warning",
    );
  }

  const contextPercent = safeContextPercent(totalTokens, modelContextWindow);
  if (
    rc.flags.force &&
    rc.config.minContextPercent > 0 &&
    contextPercent < rc.config.minContextPercent
  ) {
    rc.notify(
      "Manual compaction override at " +
        Math.round(contextPercent) +
        "% (" +
        totalTokens.toLocaleString() +
        "t): compacting about " +
        plan.compactTokens.toLocaleString() +
        "t while preserving " +
        plan.retainedTokens.toLocaleString() +
        "t of recent context. Early compaction is lossy; verification remains fail-closed.",
      "warning",
    );
  }

  const out = rc as PreparedRc & WindowedRc;
  out.sessionId = resolveSessionId(rc.ctx);
  out.branch = branch as unknown[];
  out.msgs = msgs;
  out.totalTokens = totalTokens;
  out.contextPercent = contextPercent;
  out.toolPercent = 0;
  out.keepFrom = plan.keepFrom;
  out.toCompact = msgs.slice(0, plan.keepFrom);
  out.firstKeptId = msgs[plan.keepFrom].id as string;
  out.compactTokens = plan.compactTokens;
  out.accTokens = plan.retainedTokens;
  out.compactionPlan = plan;
  return advance<PreparedRc, WindowedRc>(out, "_windowed");
}
