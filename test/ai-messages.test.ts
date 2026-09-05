import { describe, it, expect } from "bun:test";
import {
  asBranchMessage,
  asSerializableMessages,
  contextMessageEntries,
} from "../src/infra/ai-messages.ts";
import type { Message } from "@earendil-works/pi-ai";
import type { LlmMessage } from "../src/types.ts";
import { computeToolCharPercentage, smartKeepBoundary } from "../src/utils/helpers.ts";

describe("host-visible context projection", () => {
  it("preserves prior compaction and anchor IDs while excluding private and context-disabled entries", () => {
    const branch = [
      { type: "compaction", id: "compaction", timestamp: "2026-01-01T00:00:00Z", summary: "Previous facts", tokensBefore: 100 },
      { type: "message", id: "hidden", message: { role: "bashExecution", command: "hidden", output: "PRIVATE_SENTINEL", exitCode: 0, excludeFromContext: true } },
      { type: "message", id: "anchor", message: { role: "toolResult", toolName: "context", toolCallId: "anchor-1", content: [{ type: "text", text: "Decision checkpoint" }], details: { anchor: "checkpoint" }, timestamp: 0 } },
      { type: "message", id: "tool", message: { role: "toolResult", toolName: "read", toolCallId: "call-1", content: [{ type: "text", text: "x".repeat(200) }], timestamp: 0 } },
      { type: "custom", id: "private", customType: "state", data: "PRIVATE_SENTINEL" },
    ];
    const msgs = contextMessageEntries(branch);
    expect(msgs.map(entry => entry.id)).toEqual(["compaction", "anchor", "tool"]);
    expect(JSON.stringify(msgs)).not.toContain("PRIVATE_SENTINEL");
    expect(JSON.stringify(msgs)).toContain("Previous facts");
    expect(smartKeepBoundary(msgs, 2, branch)).toBe(1);
    expect(computeToolCharPercentage(msgs)).toBeGreaterThan(0);
    expect(computeToolCharPercentage(msgs)).toBeLessThan(computeToolCharPercentage(branch));
  });
});

describe("asBranchMessage", () => {
  it("returns the same object reference (no defensive copy)", () => {
    const msg = { role: "user", content: "hi", timestamp: 1 } satisfies Message;
    expect(asBranchMessage(msg)).toBe(msg);
  });

  it("accepts arbitrary unknown input without throwing", () => {
    expect(() => asBranchMessage(null)).not.toThrow();
    expect(() =>
      asBranchMessage({ role: "assistant", content: [] }),
    ).not.toThrow();
  });
});

describe("asSerializableMessages", () => {
  it("preserves array length, order, and element identity", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: [] },
      {
        role: "toolResult",
        toolCallId: "1",
        toolName: "read",
        content: [],
        isError: false,
      },
    ];
    const out = asSerializableMessages(msgs);
    expect(out.length).toBe(3);
    expect(out[0] === msgs[0]).toBe(true);
    expect(out[2] === msgs[2]).toBe(true);
  });

  it("returns an empty array for empty input", () => {
    expect(asSerializableMessages([])).toEqual([]);
  });
});
