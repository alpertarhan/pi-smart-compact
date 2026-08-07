/**
 * Step 2: pick the compaction window.
 *
 * Stage: `PreparedRc` → `WindowedRc | null`.
 *
 * The window is the prefix of active-context messages we will summarize. Walks back
 * from the tail accumulating tokens up to `keepRecentTokens`, then anchors:
 *
 *  - `smartKeepBoundary` respects the latest on-branch anchor and avoids
 *    splitting topical groups.
 *  - `guardToolCallBoundary` rejects boundaries that would orphan a
 *    `toolResult` from its `toolCall`.
 *
 * Returns `null` when the conversation is too small to compact.
 */

import type { PreparedRc, WindowedRc } from "../run-context.ts";
import { advance } from "../run-context.ts";
import type { LlmMessage, SessionMessageEntry } from "../../types.ts";
import { MODE_POLICIES, modeFromLegacyProfile } from "../mode-policy.ts";
import { smartKeepBoundary, guardToolCallBoundary } from "../../utils/helpers.ts";
import { resolveSessionId } from "../../infra/session-identity.ts";
import { MIN_TOKEN_THRESHOLD } from "../../constants.ts";

export function resolveCompactionWindow(rc: PreparedRc): WindowedRc | null {
  const usage = rc.ctx.getContextUsage();
  const totalTokens = usage?.tokens ?? 0;

  // getBranch() is append-only history and still contains messages already
  // replaced by earlier compactions. Only buildContextEntries() represents
  // what the model currently sees; summarizing full history caused repeated
  // compactions to process the same six-figure prefix again.
  const manager = rc.ctx.sessionManager;
  const branch = typeof manager.buildContextEntries === "function"
    ? manager.buildContextEntries()
    : manager.getBranch();
  const msgs = branch.filter(
    (e: { type: string; id?: string; message?: unknown }) => e.type === "message" && e.message != null,
  ) as SessionMessageEntry[];
  if (msgs.length < 3) {
    if (rc.flags.force) rc.notify("Manual compaction skipped: fewer than 3 active messages are available.", "warning");
    return null;
  }

  const adaptiveKeepTokens = rc.ctx.model
    ? Math.min(rc.profileCfg.keepRecentTokens * 2, Math.max(rc.profileCfg.keepRecentTokens, rc.ctx.model.contextWindow * 0.04))
    : rc.profileCfg.keepRecentTokens;
  const mode = rc.mode ?? (rc.profile ? modeFromLegacyProfile(rc.profile) : "balanced");
  const targetPercent = MODE_POLICIES[mode].targetContextPercent;
  const messageTokens = msgs.map(entry => rc.estimator.message(entry.message as LlmMessage));
  const allMessageTokens = messageTokens.reduce((sum, tokens) => sum + tokens, 0);
  const overflowedContext = !!rc.flags.overflowRecovery || (!!rc.ctx.model && totalTokens > rc.ctx.model.contextWindow);
  // A model switch or a stale provider usage sample can report more context
  // than the active model accepts while the locally visible messages estimate
  // much lower. In that recovery state, treating the entire delta as an
  // uncompactable system prompt makes every EESV window look non-viable and
  // delegates the already-oversized request to native's single LLM call. Map
  // measured usage back across active messages instead; over-compacting is the
  // only fail-safe direction when the current model cannot accept the context.
  const messageScale = totalTokens > 0 && allMessageTokens > 0 && (allMessageTokens > totalTokens || overflowedContext)
    ? totalTokens / allMessageTokens
    : 1;
  const fixedContextTokens = overflowedContext ? 0 : Math.max(0, totalTokens - allMessageTokens);
  const targetRetainedTokens = rc.ctx.model
    ? Math.max(0, rc.ctx.model.contextWindow * targetPercent / 100 - fixedContextTokens - rc.profileCfg.summaryBudgetTokens)
    : adaptiveKeepTokens;
  // Automatic/tool runs retain up to the model-relative target. An explicit
  // manual command is the user's decision to compact now, so preserve the
  // absolute adaptive safety tail instead of letting a 1M window turn 40–50%
  // into a 400–500K no-op budget.
  const retentionBudget = rc.flags.force
    ? adaptiveKeepTokens
    : Math.max(adaptiveKeepTokens, targetRetainedTokens);
  // Selection uses raw per-message estimates, while both budgets above are in
  // Pi-measured tokens. Scale the thresholds into the estimator's units before
  // walking so an overestimating provider calibration cannot halve the safety
  // tail or make only aggressive mode cross the boundary.
  const rawAdaptiveKeepTokens = adaptiveKeepTokens / messageScale;
  const rawRetentionBudget = retentionBudget / messageScale;
  let accTokens = 0;
  let keepFrom = msgs.length - 1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const next = messageTokens[i];
    if (accTokens >= rawAdaptiveKeepTokens && accTokens + next > rawRetentionBudget) {
      keepFrom = i + 1;
      break;
    }
    accTokens += next;
    keepFrom = i;
  }
  const plannedKeepFrom = keepFrom;
  const recentUsers = msgs
    .map((entry, index) => ({ index, role: (entry.message as { role?: string })?.role }))
    .filter(entry => entry.role === "user");
  if (recentUsers.length) {
    const protectedUser = recentUsers[recentUsers.length >= 2 ? recentUsers.length - 2 : recentUsers.length - 1];
    keepFrom = Math.min(keepFrom, protectedUser.index);
  }
  keepFrom = smartKeepBoundary(msgs, keepFrom, branch);
  keepFrom = guardToolCallBoundary(msgs, keepFrom);

  // Anchor/recent-turn protection is a fidelity preference; intact tool-call
  // pairs are the hard boundary. If the soft protections retain far more than
  // the selected budget, summarize through them with EESV rather than handing
  // an oversized one-shot prompt to native compaction.
  const recount = (from: number) => ({
    compact: Math.round(messageTokens.slice(0, from).reduce((sum, tokens) => sum + tokens, 0) * messageScale),
    retained: Math.round(messageTokens.slice(from).reduce((sum, tokens) => sum + tokens, 0) * messageScale),
  });
  let counts = recount(keepFrom);
  const softProtectionBudget = rc.flags.force
    ? Math.max(retentionBudget, adaptiveKeepTokens * 2)
    : retentionBudget;
  const protectionCeiling = fixedContextTokens + softProtectionBudget + rc.profileCfg.summaryBudgetTokens;
  if (overflowedContext && keepFrom < plannedKeepFrom && fixedContextTokens + counts.retained + rc.profileCfg.summaryBudgetTokens > protectionCeiling) {
    keepFrom = guardToolCallBoundary(msgs, plannedKeepFrom);
    counts = recount(keepFrom);
    rc.notify(
      "Context exceeds the active model window. EESV will summarize through soft recent-turn/checkpoint protections while preserving complete tool-call pairs; native fallback would resend the oversized context.",
      "warning",
    );
  }
  const compactTokens = counts.compact;
  accTokens = counts.retained;

  if ((msgs[keepFrom]?.message as Record<string, unknown> | undefined)?.role === "toolResult") {
    if (rc.flags.force) rc.notify("Manual compaction skipped: no safe boundary can separate the retained tool result from its tool call.", "warning");
    return null;
  }

  const toCompact = msgs.slice(0, keepFrom);
  if (!toCompact.length) {
    if (rc.flags.force) {
      rc.notify(
        "Manual compaction skipped: no eligible prefix remains after protecting recent user turns and tool-call boundaries. It may have been run again too soon.",
        "warning",
      );
    }
    return null;
  }

  const contextPercent = rc.ctx.model && totalTokens ? (totalTokens / rc.ctx.model.contextWindow) * 100 : 0;
  if (rc.flags.force) {
    const lowYield = compactTokens <= rc.profileCfg.summaryBudgetTokens + MIN_TOKEN_THRESHOLD
      || (totalTokens > 0 && compactTokens / totalTokens < 0.1);
    if (lowYield) {
      rc.notify(
        "Low-yield manual compaction: only " + compactTokens.toLocaleString() +
          "t are eligible after preserving " + accTokens.toLocaleString() +
          "t of recent context. Continuing because you requested it; repeated compaction may lose nuance.",
        "warning",
      );
    } else if (rc.config.minContextPercent > 0 && contextPercent < rc.config.minContextPercent) {
      rc.notify(
        "Manual compaction override at " + Math.round(contextPercent) + "% (" +
          totalTokens.toLocaleString() + "t): compacting about " + compactTokens.toLocaleString() +
          "t while preserving " + accTokens.toLocaleString() +
          "t of recent context. Early compaction is lossy; verification remains fail-closed.",
        "warning",
      );
    }
  }
  if (!rc.flags.force && !overflowedContext && rc.ctx.model && totalTokens > 0 && rc.config.minContextPercent > 0) {
    const projectedTokens = fixedContextTokens + accTokens + rc.profileCfg.summaryBudgetTokens;
    const targetTokens = rc.ctx.model.contextWindow * targetPercent / 100;
    if (projectedTokens > targetTokens) {
      rc.notify(
        "Smart compact skipped: protected recent context would remain above " +
        targetPercent + "% after compaction; using native compaction instead.",
        "warning",
      );
      return null;
    }
  }
  const firstKeptId = msgs[keepFrom].id as string;
  // Use the shared helper instead of a local sentinel. A literal fallback
  // (e.g. "unknown") would compare equal across unrelated sessions and
  // defeat the cross-session leak guard in `consumePending`.
  const sessionId = resolveSessionId(rc.ctx);

  const out = rc as PreparedRc & {
    _windowed: true;
    sessionId: string; branch: unknown[]; msgs: SessionMessageEntry[];
    totalTokens: number; contextPercent: number; toolPercent: number;
    keepFrom: number; toCompact: SessionMessageEntry[]; firstKeptId: string;
    compactTokens: number; accTokens: number;
  };
  out.sessionId = sessionId;
  out.branch = branch as unknown[];
  out.msgs = msgs;
  out.totalTokens = totalTokens;
  out.contextPercent = contextPercent;
  out.toolPercent = 0; // populated by selectTier
  out.keepFrom = keepFrom;
  out.toCompact = toCompact;
  out.firstKeptId = firstKeptId;
  out.compactTokens = compactTokens;
  out.accTokens = accTokens;
  return advance<PreparedRc, WindowedRc>(out, "_windowed");
}
