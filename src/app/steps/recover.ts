/**
 * Step 3: recover untruncated messages from the session log when needed.
 *
 * Stage: `WindowedRc` → `RecoveredRc`.
 *
 * pi-toolkit's context hook truncates tool results in-place on the branch.
 * Where possible we read the original messages from the session log instead.
 * If the log is unavailable we fall back to the (possibly truncated) branch
 * messages — the summary still beats no summary at all.
 */

import type { WindowedRc, RecoveredRc } from "../run-context.ts";
import { advance } from "../run-context.ts";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { asBranchMessage } from "../../infra/ai-messages.ts";
import type { LlmMessage } from "../../types.ts";
import { hasTruncatedMessages, resolveCompactionMessages } from "../../utils/session-log.ts";

export async function recoverSessionLog(rc: WindowedRc): Promise<RecoveredRc> {
  let resolved = rc.toCompact.flatMap(entry => {
    if (!entry.id) return [];
    return (convertToLlm([asBranchMessage(entry.message)]) as LlmMessage[])
      .map(message => ({ entryId: entry.id, message }));
  });

  if (hasTruncatedMessages(resolved.map(item => item.message))) {
    const fromLog = await resolveCompactionMessages(rc.sessionId, rc.toCompact, rc.ctx.cwd);
    if (fromLog) {
      resolved = fromLog;
      rc.notify("Using untruncated session log (" + resolved.length + " msgs)", "info");
    }
  }

  const out = rc as WindowedRc & {
    _recovered: true;
    llmMessages: LlmMessage[];
    llmEntryIds: string[];
  };
  out.llmMessages = resolved.map(item => item.message);
  out.llmEntryIds = resolved.map(item => item.entryId);
  return advance<WindowedRc, RecoveredRc>(out, "_recovered");
}
