import { describe, expect, it } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { recoverSourceMessages } from "../src/app/steps/recover.ts";
import { ATTENTION_CUSTOM_TYPE } from "../src/app/context-operations.ts";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";

describe("recoverSourceMessages", () => {
  it("drops this extension's context-pressure hints, so a summary never carries them as open loops", async () => {
    // Production shape: projected entries already hold convertToLlm user turns, so only entry provenance identifies hints.
    const session = SessionManager.inMemory();
    const user = session.appendMessage({ role: "user", content: "Ship the parser fix", timestamp: 1 });
    session.appendCustomMessageEntry(ATTENTION_CUSTOM_TYPE, "Context attention: 72% of the policy window (cleanup band).", true);
    const note = session.appendCustomMessageEntry("other-extension", "Unrelated extension note", true);
    const { messages } = await recoverSourceMessages(session.getSessionId(), contextMessageEntries(session.getBranch()), "/tmp");
    expect(messages.map(item => item.entryId)).toEqual([user, note]);
    expect(JSON.stringify(messages)).not.toContain("Context attention");
    expect(messages.map(item => [item.message.role, item.message.customType])).toEqual([["user", undefined], ["user", "other-extension"]]);
  });
});
