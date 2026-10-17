import { describe, expect, it } from "bun:test";
import { recoverSourceMessages } from "../src/app/steps/recover.ts";
import { ATTENTION_CUSTOM_TYPE } from "../src/app/context-operations.ts";

describe("recoverSourceMessages", () => {
  it("drops this extension's context-pressure hints, so a summary never carries them as open loops", async () => {
    const entries = [
      { type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "Ship the parser fix", timestamp: 1 } },
      { type: "message", id: "h1", parentId: "u1", timestamp: "t", message: {
        role: "custom", customType: ATTENTION_CUSTOM_TYPE, content: "Context attention: 72% of the policy window (cleanup band).", display: true, timestamp: 2,
      } },
      { type: "message", id: "n1", parentId: "h1", timestamp: "t", message: {
        role: "custom", customType: "other-extension", content: "Unrelated extension note", display: true, timestamp: 3,
      } },
    ];
    const { messages } = await recoverSourceMessages("session-1", entries as never, "/tmp");
    expect(messages.map(item => item.entryId)).toEqual(["u1", "n1"]);
    expect(JSON.stringify(messages)).not.toContain("Context attention");
  });
});
