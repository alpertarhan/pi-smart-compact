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

export function recoverSessionLog(rc: WindowedRc): RecoveredRc {
  let llmMessages = convertToLlm(
    rc.toCompact.map(e => asBranchMessage(e.message)),
  ) as LlmMessage[];

  if (hasTruncatedMessages(llmMessages)) {
    const fromLog = resolveCompactionMessages(rc.sessionId, rc.toCompact);
    if (fromLog) {
      llmMessages = fromLog;
      rc.notify("Using untruncated session log (" + llmMessages.length + " msgs)", "info");
    }
  }

  const out = rc as WindowedRc & { _recovered: true; llmMessages: LlmMessage[] };
  out.llmMessages = llmMessages;
  return advance<WindowedRc, RecoveredRc>(out, "_recovered");
}
