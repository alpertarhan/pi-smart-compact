import { describe, it, expect } from "bun:test";
import { pruneRedundant } from "../src/utils/pruning.ts";
import type { LlmMessage } from "../src/types.ts";

function makeMsg(role: LlmMessage["role"], content: string, extra?: Partial<LlmMessage>): LlmMessage {
  return { role, content: [{ type: "text", text: content }], ...extra };
}

function makeToolResult(id: string, text: string, isError = false): LlmMessage {
  return { role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError };
}

function makeAssistantWithToolCall(id: string, name: string, args: Record<string, unknown>): LlmMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Let me read that file." },
      { type: "toolCall", id, name, arguments: args },
    ],
  };
}

describe("pruneRedundant", () => {
  it("returns all messages when below threshold", () => {
    const msgs = [
      makeMsg("user", "hello"),
      makeMsg("assistant", "hi"),
    ];
    const result = pruneRedundant(msgs);
    expect(result.messages.length).toBe(2);
    expect(result.prunedCount).toBe(0);
  });

  it("prunes duplicate file reads keeping only the last", () => {
    const msgs: LlmMessage[] = [
      makeMsg("user", "read index.ts"),
      makeAssistantWithToolCall("r1", "read", { path: "src/index.ts" }),
      makeToolResult("r1", "export const foo = 1;"),
      makeMsg("user", "now check it again"),
      makeAssistantWithToolCall("r2", "read", { path: "src/index.ts" }),
      makeToolResult("r2", "export const foo = 1; // unchanged"),
      makeMsg("user", "thanks"),
    ];
    const result = pruneRedundant(msgs);
    expect(result.prunedCount).toBeGreaterThan(0);
    expect(result.reasons.some(r => r.reason.includes("Duplicate file reads"))).toBe(true);
  });

  it("prunes agent acknowledgment messages", () => {
    const msgs: LlmMessage[] = [
      makeMsg("user", "fix the bug"),
      makeMsg("assistant", "I'll fix that right away."),
      makeMsg("assistant", "Let me check the file."),
      makeMsg("assistant", "Sure, I can help."),
      makeMsg("user", "good"),
    ];
    const result = pruneRedundant(msgs);
    // At least some ack messages should be pruned
    expect(result.messages.length).toBeLessThan(msgs.length);
    expect(result.reasons.some(r => r.reason.includes("acknowledgments"))).toBe(true);
  });

  it("truncates long tool outputs", () => {
    const longOutput = "x".repeat(2000);
    const msgs: LlmMessage[] = [
      makeMsg("user", "check this"),
      makeMsg("assistant", "ok"),
      makeAssistantWithToolCall("r1", "read", { path: "big.ts" }),
      makeToolResult("r1", longOutput),
      makeMsg("user", "thanks"),
      makeMsg("assistant", "done"),
    ];
    const result = pruneRedundant(msgs);
    const toolResult = result.messages.find(m => m.role === "toolResult");
    const text = (toolResult?.content as any[])?.[0]?.text ?? "";
    expect(text.length).toBeLessThan(longOutput.length);
    expect(text).toContain("[truncated");
  });

  it("keeps messages with tool calls intact", () => {
    const msgs: LlmMessage[] = [
      makeMsg("user", "read auth.ts"),
      makeAssistantWithToolCall("r1", "read", { path: "src/auth.ts" }),
      makeToolResult("r1", "export const auth = true;"),
    ];
    const result = pruneRedundant(msgs);
    // Single read should not be pruned
    expect(result.messages.length).toBe(3);
    expect(result.prunedCount).toBe(0);
  });
});
