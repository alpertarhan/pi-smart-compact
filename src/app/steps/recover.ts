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
import { ATTENTION_CUSTOM_TYPE } from "../context-operations.ts";

/** Read-only source recovery shared by preflight and execution. */
export async function recoverSourceMessages(
 sessionId: string, entries: WindowedRc["toCompact"], cwd: string,
): Promise<{ messages: Array<{ entryId: string; message: LlmMessage }>; fromLog: boolean }> {
 // Our own context-pressure hints describe a past moment of this session, never work to carry.
 const hints = new Set(entries.flatMap(entry => entry.id && entry.customType === ATTENTION_CUSTOM_TYPE ? [entry.id] : []));
 // Provenance rides on the message so extraction never mines a custom message as user intent.
 const customTypes = new Map(entries.flatMap(entry => entry.id && entry.customType ? [[entry.id, entry.customType] as const] : []));
 const withProvenance = (entryId: string, message: LlmMessage): LlmMessage => {
  const customType = customTypes.get(entryId);
  return customType ? { ...message, customType } : message;
 };
 const resolved = entries.flatMap(entry => {
  if (!entry.id || hints.has(entry.id)) return [];
  return (convertToLlm([asBranchMessage(entry.message)]) as LlmMessage[])
   .map(message => ({ entryId: entry.id, message: withProvenance(entry.id, message) }));
 });

 if (hasTruncatedMessages(resolved.map(item => item.message))) {
  const fromLog = await resolveCompactionMessages(sessionId, entries, cwd);
  if (fromLog) return {
   messages: fromLog.flatMap(item => hints.has(item.entryId) ? [] : [{ entryId: item.entryId, message: withProvenance(item.entryId, item.message) }]),
   fromLog: true,
  };
 }
 return { messages: resolved, fromLog: false };
}

export async function recoverSessionLog(rc: WindowedRc): Promise<RecoveredRc> {
 const { messages: resolved, fromLog } = await recoverSourceMessages(rc.sessionId, rc.toCompact, rc.ctx.cwd);
 if (fromLog) rc.notify("Using untruncated session log (" + resolved.length + " msgs)", "info");

 const out = rc as WindowedRc & {
  _recovered: true;
  llmMessages: LlmMessage[];
  llmEntryIds: string[];
 };
 out.llmMessages = resolved.map(item => item.message);
 out.llmEntryIds = resolved.map(item => item.entryId);
 return advance<WindowedRc, RecoveredRc>(out, "_recovered");
}
