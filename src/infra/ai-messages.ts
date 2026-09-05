/**
 * Boundary adapters between the project's loose `LlmMessage` type and
 * pi-ai's strict `Message` type.
 *
 * Why these exist: pi-ai's `Context.messages` is typed `Message[]` with no
 * permissive input variant, and `AssistantMessage` requires response
 * metadata (`api` / `provider` / `model` / `usage` / `stopReason`). Several
 * call sites hold data that is *genuinely* a `Message` at runtime but is
 * typed looser (`unknown` for raw branch entries, `LlmMessage[]` for the
 * pruned pipeline). Rather than scatter blind `as` casts, each boundary
 * upcast lives here with a comment documenting the data's provenance so a
 * reader can verify soundness without re-deriving it.
 *
 * Note: the explore-tool feedback loop does NOT use these — it builds its
 * conversation buffer in native `Message[]` directly (see `phases/explore.ts`),
 * which is the preferred pattern for any new code that talks to a provider.
 */

import { contentText, type Message } from "@earendil-works/pi-ai";
import type { LlmMessage, SessionMessageEntry } from "../types.ts";
import { convertToLlm, sessionEntryToContextMessages, serializeConversation, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SecretScrubber } from "../domain/scrub.ts";

/** Preserve the host's context projection and original entry IDs, including custom and branch summaries. */
export function contextMessageEntries(entries: readonly unknown[]): SessionMessageEntry[] {
  // SAFETY: these are host SessionManager entries, not provider-supplied data.
  return (entries as readonly SessionEntry[]).flatMap(entry =>
    convertToLlm(sessionEntryToContextMessages(entry)).map(message => ({ type: "message" as const, id: entry.id, message })),
  );
}

/** Text transcript without the host summarizer's implicit 2,000-character tool-result cap. */
export function serializeConversationText(messages: LlmMessage[]): string {
  return asSerializableMessages(messages).map(message => message.role === "toolResult"
    ? "[Tool result]: " + contentText(message.content, "")
    : serializeConversation([message]),
  ).filter(Boolean).join("\n\n");
}

/**
 * Upcast a raw branch entry's `message` to a `Message` for `convertToLlm`.
 *
 * Provenance: pi-coding-agent's `SessionMessageEntry.message` is typed
 * `AgentMessage`, and pi-ai's `Message` (`UserMessage | AssistantMessage |
 * ToolResultMessage`) is a subset of `AgentMessage` — so casting through
 * `Message` is sound and assignable to `convertToLlm`'s `AgentMessage[]`
 * parameter. A branch only ever stores real messages produced by Pi.
 */
export function asBranchMessage(message: unknown): Message {
  return message as Message;
}

/**
 * Re-widen pruned `LlmMessage[]` to `Message[]` for `serializeConversation`.
 *
 * Provenance: the messages were produced by `convertToLlm` (real `Message`s)
 * and pruning only rewrites tool-result `content` via an object spread that
 * preserves `role`, `toolCallId`, `toolName`, `isError`, and `timestamp` —
 * every field `Message` requires. `serializeConversation` reads only
 * `role` + `content` to render text, so the upcast is sound.
 */
export function asSerializableMessages(msgs: LlmMessage[]): Message[] {
  // SAFETY: `convertToLlm` produced these messages and pruning preserves every
  // discriminant/identity field required by the corresponding Pi message type.
  return msgs as unknown as Message[];
}

/**
 * Clone and structurally redact messages before any host serializer flattens
 * secret-bearing argument keys into ordinary text.
 */
export function scrubLlmMessages(msgs: LlmMessage[], scrubber: SecretScrubber): LlmMessage[] {
  return scrubber.scrubValue(msgs).value;
}
