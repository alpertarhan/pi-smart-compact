/** Step 2: select and validate the active-context prefix to summarize. */

import type {
  CompactionPlanReason, CompactionWindowPlan, PreparedRc, RelaxedSoftBoundary, WindowedRc,
} from "../run-context.ts";
import { advance } from "../run-context.ts";
import type { EffectiveCompactionMode, LlmMessage, ProfileConfig, SessionMessageEntry } from "../../types.ts";
import { MODE_POLICIES, modeFromLegacyProfile } from "../mode-policy.ts";
import { advancePastToolCallBoundary, guardToolCallBoundary, smartKeepBoundaryCandidates } from "../../utils/helpers.ts";
import { resolveSessionId } from "../../infra/session-identity.ts";
import { MIN_COMPACTION_SAVING_RATIO } from "../../constants.ts";

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
  overflowedContext: boolean;
}

/** Pure, content-free result suitable for both execution and a later UI preview. */
export function planCompactionWindow(input: CompactionWindowPlanInput): CompactionWindowPlan {
  const {
    msgs, branch, messageTokens, totalTokens, modelContextWindow, mode, profileCfg, force, overflowedContext,
  } = input;
  const allMessageTokens = messageTokens.reduce((sum, tokens) => sum + tokens, 0);
  const messageScale = totalTokens > 0 && allMessageTokens > 0 && (allMessageTokens > totalTokens || overflowedContext)
    ? totalTokens / allMessageTokens
    : 1;
  const fixedContextTokens = overflowedContext ? 0 : Math.max(0, totalTokens - allMessageTokens);
  const adaptiveKeepTokens = modelContextWindow
    ? Math.min(profileCfg.keepRecentTokens * 2, Math.max(profileCfg.keepRecentTokens, modelContextWindow * 0.04))
    : profileCfg.keepRecentTokens;
  const targetPercent = MODE_POLICIES[mode].targetContextPercent;
  const targetRetainedTokens = modelContextWindow
    ? Math.max(0, modelContextWindow * targetPercent / 100 - fixedContextTokens - profileCfg.summaryBudgetTokens)
    : adaptiveKeepTokens;
  const retentionCeiling = force ? adaptiveKeepTokens : Math.max(adaptiveKeepTokens, targetRetainedTokens);
  const rawMinimumTail = adaptiveKeepTokens / messageScale;
  const rawRetentionCeiling = retentionCeiling / messageScale;

  let rawRetained = 0;
  let keepFrom = msgs.length - 1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const next = messageTokens[i];
    if (rawRetained >= rawMinimumTail && rawRetained + next > rawRetentionCeiling) {
      keepFrom = i + 1;
      break;
    }
    rawRetained += next;
    keepFrom = i;
  }

  const relaxedSoftBoundaries: RelaxedSoftBoundary[] = [];
  const retainedAt = (from: number) => Math.round(messageTokens.slice(from).reduce((sum, tokens) => sum + tokens, 0) * messageScale);
  // Message boundaries can overshoot the token ceiling by one message; that
  // baseline is the tightest plan this pipeline can represent.
  const effectiveRetentionCeiling = Math.max(retentionCeiling, retainedAt(keepFrom));
  let hardBoundaryAdjusted = false;
  const trySoftBoundary = (kind: RelaxedSoftBoundary, candidate: number | undefined) => {
    if (candidate === undefined || candidate >= keepFrom) return;
    const guarded = guardToolCallBoundary(msgs, candidate);
    if (retainedAt(guarded) <= effectiveRetentionCeiling) {
      keepFrom = guarded;
      hardBoundaryAdjusted ||= guarded !== candidate;
    } else relaxedSoftBoundaries.push(kind);
  };

  const users = msgs
    .map((entry, index) => ({ index, role: (entry.message as { role?: string })?.role }))
    .filter(entry => entry.role === "user");
  const protectedUser = users.at(users.length >= 2 ? -2 : -1);
  trySoftBoundary("recent-user-turn", protectedUser?.index);

  const anchor = smartKeepBoundaryCandidates(msgs, keepFrom, branch).find(candidate => candidate.kind === "anchor");
  trySoftBoundary("anchor", anchor?.keepFrom);
  const topical = smartKeepBoundaryCandidates(msgs, keepFrom).find(candidate => candidate.kind === "topical");
  trySoftBoundary("topical", topical?.keepFrom);

  const boundaryBeforeHardGuard = keepFrom;
  const backwardBoundary = guardToolCallBoundary(msgs, keepFrom);
  const forwardBoundary = retainedAt(backwardBoundary) > effectiveRetentionCeiling
    ? advancePastToolCallBoundary(msgs, keepFrom)
    : keepFrom;
  keepFrom = forwardBoundary > keepFrom && forwardBoundary < msgs.length && retainedAt(forwardBoundary) <= effectiveRetentionCeiling
    ? forwardBoundary
    : backwardBoundary;
  hardBoundaryAdjusted ||= keepFrom !== boundaryBeforeHardGuard;
  const compactTokens = Math.round(messageTokens.slice(0, keepFrom).reduce((sum, tokens) => sum + tokens, 0) * messageScale);
  const retainedTokens = retainedAt(keepFrom);
  const projectedAfterTokens = fixedContextTokens + retainedTokens + profileCfg.summaryBudgetTokens;
  const projectedSavedTokens = Math.max(0, totalTokens - projectedAfterTokens);
  const projectedYield = totalTokens > 0 ? projectedSavedTokens / totalTokens : 0;
  const targetAfterTokens = !force && modelContextWindow
    ? modelContextWindow * targetPercent / 100
    : fixedContextTokens + effectiveRetentionCeiling + profileCfg.summaryBudgetTokens;

  let reason: CompactionPlanReason = "viable";
  if ((msgs[keepFrom]?.message as { role?: string } | undefined)?.role === "toolResult") reason = "unsafe-tool-boundary";
  else if (keepFrom <= 0) reason = "no-eligible-prefix";
  else if (retainedTokens > effectiveRetentionCeiling) reason = "retention-target-exceeded";
  else if (!force && modelContextWindow && projectedAfterTokens > targetAfterTokens) reason = "mode-target-not-met";
  else if (projectedYield < MIN_COMPACTION_SAVING_RATIO) reason = "insufficient-projected-saving";

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
  const branch = typeof manager.buildContextEntries === "function" ? manager.buildContextEntries() : manager.getBranch();
  const msgs = branch.filter(
    (entry: { type: string; message?: unknown }) => entry.type === "message" && entry.message != null,
  ) as SessionMessageEntry[];
  if (msgs.length < 3) {
    if (rc.flags.force) rc.notify("Manual compaction skipped: fewer than 3 active messages are available.", "warning");
    return null;
  }

  const mode = rc.mode ?? (rc.profile ? modeFromLegacyProfile(rc.profile) : "balanced");
  const overflowedContext = !!rc.flags.overflowRecovery || (!!rc.ctx.model && totalTokens > rc.ctx.model.contextWindow);
  const plan = planCompactionWindow({
    msgs,
    branch: branch as unknown[],
    messageTokens: msgs.map(entry => rc.estimator.message(entry.message as LlmMessage)),
    totalTokens,
    modelContextWindow: rc.ctx.model?.contextWindow,
    mode,
    profileCfg: rc.profileCfg,
    force: rc.flags.force,
    overflowedContext,
  });

  if (!plan.viable) {
    if (rc.flags.force) {
      const detail = plan.reason === "insufficient-projected-saving"
        ? "projected saving is below 10%."
        : plan.reason === "unsafe-tool-boundary"
          ? "no safe tool-call boundary is available."
          : plan.reason === "no-eligible-prefix"
            ? "no eligible prefix remains."
            : plan.reason === "retention-target-exceeded"
              ? "a complete tool pair exceeds the retention target."
              : "the projected context remains above the mode target.";
      rc.notify("Manual compaction skipped: " + detail, "warning");
    } else {
      rc.notify("Smart compact skipped: the safe plan cannot meet its target; using native compaction instead.", "warning");
    }
    return null;
  }

  if (overflowedContext && plan.relaxedSoftBoundaries.length) {
    rc.notify(
      "Context exceeds the active model window. EESV will summarize through soft recent-turn/checkpoint protections while preserving complete tool-call pairs; native fallback would resend the oversized context.",
      "warning",
    );
  }

  const contextPercent = rc.ctx.model && totalTokens ? totalTokens / rc.ctx.model.contextWindow * 100 : 0;
  if (rc.flags.force && rc.config.minContextPercent > 0 && contextPercent < rc.config.minContextPercent) {
    rc.notify(
      "Manual compaction override at " + Math.round(contextPercent) + "% (" + totalTokens.toLocaleString() +
        "t): compacting about " + plan.compactTokens.toLocaleString() + "t while preserving " +
        plan.retainedTokens.toLocaleString() + "t of recent context. Early compaction is lossy; verification remains fail-closed.",
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
