import { describe, it, expect } from "bun:test";
import { asBranchMessage, asSerializableMessages } from "../src/infra/ai-messages.ts";
import type { LlmMessage } from "../src/types.ts";

describe("asBranchMessage", () => {
  it("returns the same object reference (no defensive copy)", () => {
    const msg = { role: "user", content: "hi", timestamp: 1 };
    expect(asBranchMessage(msg)).toBe(msg);
  });

  it("accepts arbitrary unknown input without throwing", () => {
    expect(() => asBranchMessage(null)).not.toThrow();
    expect(() => asBranchMessage({ role: "assistant", content: [] })).not.toThrow();
  });
});

describe("asSerializableMessages", () => {
  it("preserves array length, order, and element identity", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: [] },
      { role: "toolResult", toolCallId: "1", toolName: "read", content: [], isError: false },
    ];
    const out = asSerializableMessages(msgs);
    expect(out.length).toBe(3);
    expect(out[0]).toBe(msgs[0]);
    expect(out[2]).toBe(msgs[2]);
  });

  it("returns an empty array for empty input", () => {
    expect(asSerializableMessages([])).toEqual([]);
  });
});
