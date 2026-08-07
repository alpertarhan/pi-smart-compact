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
  if (msgs.length < 3) return null;

  const adaptiveKeepTokens = rc.ctx.model
    ? Math.min(rc.profileCfg.keepRecentTokens * 2, Math.max(rc.profileCfg.keepRecentTokens, rc.ctx.model.contextWindow * 0.04))
    : rc.profileCfg.keepRecentTokens;
  const mode = rc.mode ?? (rc.profile ? modeFromLegacyProfile(rc.profile) : "balanced");
  const targetPercent = MODE_POLICIES[mode].targetContextPercent;
  const messageTokens = msgs.map(entry => rc.estimator.message(entry.message as LlmMessage));
  const allMessageTokens = messageTokens.reduce((sum, tokens) => sum + tokens, 0);
  const fixedContextTokens = Math.max(0, totalTokens - allMessageTokens);
  const targetRetainedTokens = rc.ctx.model
    ? Math.max(0, rc.ctx.model.contextWindow * targetPercent / 100 - fixedContextTokens - rc.profileCfg.summaryBudgetTokens)
    : adaptiveKeepTokens;
  // Keep as much recent context as the mode's post-compaction target allows,
  // never less than the profile safety floor.
  const retentionBudget = Math.max(adaptiveKeepTokens, targetRetainedTokens);
  let accTokens = 0;
  let keepFrom = msgs.length - 1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const next = messageTokens[i];
    if (accTokens >= adaptiveKeepTokens && accTokens + next > retentionBudget) {
      keepFrom = i + 1;
      break;
    }
    accTokens += next;
    keepFrom = i;
  }
  const recentUsers = msgs
    .map((entry, index) => ({ index, role: (entry.message as { role?: string })?.role }))
    .filter(entry => entry.role === "user");
  if (recentUsers.length) {
    const protectedUser = recentUsers[recentUsers.length >= 2 ? recentUsers.length - 2 : recentUsers.length - 1];
    keepFrom = Math.min(keepFrom, protectedUser.index);
  }
  keepFrom = smartKeepBoundary(msgs, keepFrom, branch);
  keepFrom = guardToolCallBoundary(msgs, keepFrom);

  // Anchor/tool-call safety can move the boundary far earlier than the token
  // walk selected. Recount the actual retained tail; keeping the stale ~20k
  // estimate made metrics claim 100k+ savings while the context stayed full.
  accTokens = rc.estimator.messages(msgs.slice(keepFrom).map(e => e.message as LlmMessage));

  if ((msgs[keepFrom]?.message as Record<string, unknown> | undefined)?.role === "toolResult") {
    return null;
  }

  const toCompact = msgs.slice(0, keepFrom);
  if (!toCompact.length) return null;

  const contextPercent = rc.ctx.model && totalTokens ? (totalTokens / rc.ctx.model.contextWindow) * 100 : 0;
  if (!rc.flags.force && rc.ctx.model && totalTokens > 0 && rc.config.minContextPercent > 0) {
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
    accTokens: number;
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
  out.accTokens = accTokens;
  return advance<PreparedRc, WindowedRc>(out, "_windowed");
}
