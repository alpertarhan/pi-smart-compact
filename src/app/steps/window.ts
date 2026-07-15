/**
 * Step 2: pick the compaction window.
 *
 * Stage: `PreparedRc` → `WindowedRc | null`.
 *
 * The window is the prefix of branch messages we will summarize. Walks back
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
import { smartKeepBoundary, guardToolCallBoundary } from "../../utils/helpers.ts";
import { resolveSessionId } from "../../infra/session-identity.ts";

export function resolveCompactionWindow(rc: PreparedRc): WindowedRc | null {
  const usage = rc.ctx.getContextUsage();
  const totalTokens = usage?.tokens ?? 0;

  const branch = rc.ctx.sessionManager.getBranch();
  const msgs = branch.filter(
    (e: { type: string; id?: string; message?: unknown }) => e.type === "message" && e.message != null,
  ) as SessionMessageEntry[];
  if (msgs.length < 3) return null;

  let accTokens = 0;
  let keepFrom = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    // The model receives structured tool-call arguments as context, so the
    // recent-tail budget must count them too. The run-scoped estimator applies
    // the same provider/model calibration used by synthesis planning.
    accTokens += rc.estimator.message(msgs[i].message as LlmMessage);
    if (accTokens >= rc.profileCfg.keepRecentTokens) { keepFrom = i; break; }
  }
  keepFrom = smartKeepBoundary(msgs, keepFrom, branch);
  // `firstKeptEntryId` is required by Pi's compaction API. When the recent
  // token walk never reaches `keepRecentTokens`, keepFrom is the empty suffix
  // index (`msgs.length`), so resolve that fallback before applying pair
  // safety. Otherwise a trailing toolResult can become the first kept entry
  // while its matching assistant toolCall is compacted away.
  if (keepFrom >= msgs.length) keepFrom = msgs.length - 1;
  keepFrom = guardToolCallBoundary(msgs, keepFrom);

  if ((msgs[keepFrom]?.message as Record<string, unknown> | undefined)?.role === "toolResult") {
    return null;
  }

  const toCompact = msgs.slice(0, keepFrom);
  if (!toCompact.length) return null;

  const contextPercent = rc.ctx.model && totalTokens ? (totalTokens / rc.ctx.model.contextWindow) * 100 : 0;
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
