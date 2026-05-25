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
import type { SessionMessageEntry } from "../../types.ts";
import { estimateTokens } from "../../utils/tokens.ts";
import { smartKeepBoundary, guardToolCallBoundary } from "../../utils/helpers.ts";
import { extractText } from "../../utils/extraction.ts";

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
    const msg = msgs[i].message as Record<string, unknown>;
    // extractText already handles string | block[] | undefined and shares the
    // same approximation as the rest of the pipeline. The earlier code used
    // JSON.stringify on the raw content which over-counts tokens (it includes
    // type markers, escapes, and tool args verbatim).
    const contentText = extractText(msg?.content);
    accTokens += estimateTokens(contentText);
    if (accTokens >= rc.profileCfg.keepRecentTokens) { keepFrom = i; break; }
  }
  keepFrom = smartKeepBoundary(msgs, keepFrom, branch);
  keepFrom = guardToolCallBoundary(msgs, keepFrom);

  const toCompact = msgs.slice(0, keepFrom);
  if (!toCompact.length) return null;

  const contextPercent = rc.ctx.model && totalTokens ? (totalTokens / rc.ctx.model.contextWindow) * 100 : 0;
  const firstKeptId = (msgs[keepFrom]?.id ?? msgs[msgs.length - 1]?.id) as string;
  const sessionId = rc.ctx.sessionManager.getSessionId?.() ?? "unknown";

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
