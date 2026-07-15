import { describe, it, expect } from "bun:test";
import { pruneRedundant } from "../src/utils/pruning.ts";
import { extractStructured } from "../src/utils/extraction.ts";
import { PROFILES } from "../src/constants.ts";
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
    expect(result.messages.some(message => message.toolCallId === "r1")).toBe(false);
    expect(result.messages.some(message => message.toolCallId === "r2")).toBe(true);
  });

  it("does not collapse read and grep calls for the same path", () => {
    const msgs: LlmMessage[] = [
      makeMsg("user", "inspect a.ts"),
      makeAssistantWithToolCall("r1", "read", { path: "a.ts" }),
      makeToolResult("r1", "file content"),
      makeAssistantWithToolCall("g1", "grep", { path: "a.ts", pattern: "foo" }),
      makeToolResult("g1", "foo:1"),
    ];

    const result = pruneRedundant(msgs);
    expect(result.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId)).toEqual(["r1", "g1"]);
  });

  it("does not collapse grep calls with different patterns", () => {
    const msgs: LlmMessage[] = [
      makeMsg("user", "search a.ts"),
      makeAssistantWithToolCall("g1", "grep", { path: "a.ts", pattern: "foo" }),
      makeToolResult("g1", "foo:1"),
      makeAssistantWithToolCall("g2", "grep", { pattern: "bar", path: "a.ts" }),
      makeToolResult("g2", "bar:2"),
    ];

    const result = pruneRedundant(msgs);
    expect(result.messages.filter(message => message.role === "toolResult")).toHaveLength(2);
  });

  it("does not collapse reads with different offsets or limits", () => {
    const msgs: LlmMessage[] = [
      makeMsg("user", "read chunks"),
      makeAssistantWithToolCall("r1", "read", { path: "a.ts", offset: 1, limit: 20 }),
      makeToolResult("r1", "first chunk"),
      makeAssistantWithToolCall("r2", "read", { limit: 20, path: "a.ts", offset: 21 }),
      makeToolResult("r2", "second chunk"),
    ];

    const result = pruneRedundant(msgs);
    expect(result.messages.filter(message => message.role === "toolResult")).toHaveLength(2);
  });

  it("collapses identical reads despite argument key order", () => {
    const msgs: LlmMessage[] = [
      makeMsg("user", "read twice"),
      makeAssistantWithToolCall("r1", "functions.read", { path: "a.ts", offset: 1, limit: 20 }),
      makeToolResult("r1", "first"),
      makeAssistantWithToolCall("r2", "read", { limit: 20, offset: 1, path: "a.ts" }),
      makeToolResult("r2", "second"),
    ];

    const result = pruneRedundant(msgs);
    expect(result.messages.some(message => message.toolCallId === "r1")).toBe(false);
    expect(result.messages.some(message => message.toolCallId === "r2")).toBe(true);
  });

  it("preserves an unrelated edit beside a duplicate read", () => {
    const msgs: LlmMessage[] = [
      makeMsg("user", "read a.ts and edit c.ts"),
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", id: "e1", name: "edit", arguments: { path: "c.ts", oldText: "x", newText: "y" } },
        ],
      },
      makeToolResult("r1", "a"),
      makeToolResult("e1", "done"),
      makeAssistantWithToolCall("r2", "read", { path: "a.ts" }),
      makeToolResult("r2", "a again"),
    ];

    const result = pruneRedundant(msgs);
    const extraction = extractStructured(result.messages, PROFILES.balanced);
    expect(extraction.modifiedFiles.map(file => file.path)).toContain("c.ts");
    expect(result.messages.some(message => message.toolCallId === "e1")).toBe(true);
  });

  it("preserves unrelated calls inside multi_tool_use.parallel", () => {
    const msgs: LlmMessage[] = [
      makeMsg("user", "parallel work"),
      {
        role: "assistant",
        content: [{
          type: "toolCall", id: "parallel-1", name: "multi_tool_use.parallel",
          arguments: { tool_uses: [
            { id: "r1", recipient_name: "functions.read", parameters: { path: "a.ts" } },
            { id: "e1", recipient_name: "functions.edit", parameters: { path: "c.ts", oldText: "x", newText: "y" } },
          ] },
        }],
      },
      makeToolResult("r1", "a"),
      makeToolResult("e1", "done"),
      makeAssistantWithToolCall("r2", "read", { path: "a.ts" }),
      makeToolResult("r2", "a again"),
    ];

    const result = pruneRedundant(msgs);
    const extraction = extractStructured(result.messages, PROFILES.balanced);
    expect(extraction.modifiedFiles.map(file => file.path)).toContain("c.ts");
    const wrapper = result.messages.find(message => message.role === "assistant" && Array.isArray(message.content))?.content as Array<{ name?: string; arguments?: { tool_uses?: Array<{ id?: string }> } }>;
    expect(wrapper.flatMap(block => block.arguments?.tool_uses ?? []).map(tool => tool.id)).toEqual(["e1"]);
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
