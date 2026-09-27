import { describe, expect, it } from "bun:test";
import { SessionManager, buildSessionProjection, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";
import { fingerprintContext } from "../src/app/pending-slot.ts";
import {
  CONTEXT_CONTROL_TYPE, inspectContext, planContextRewind, planContextTrim, readContextReference, removableResearch,
} from "../src/app/context-operations.ts";

/**
  * Review invariant C9: this extension never rewrites assistant content. A trim
  * replaces tool results only; a rewind removes whole entries (replacement null);
  * archived-output reads never return assistant text. Provider thinking
  * signatures therefore survive every operation byte for byte.
  */
const SIGNATURE = "sig-" + "a".repeat(64);
let sequence = 0;
function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content, api: "anthropic-messages", provider: "test", model: "test", stopReason, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function thinking(text: string) { return { type: "thinking" as const, thinking: text, thinkingSignature: SIGNATURE }; }
function call(session: SessionManager, name: string, args: ToolCall["arguments"], text: string, extra: AssistantMessage["content"] = [], isError = false) {
  const id = "call-" + sequence++;
  session.appendMessage(assistant([...extra, { type: "toolCall", id, name, arguments: args }], "toolUse"));
  session.appendMessage({ role: "toolResult", toolName: name, toolCallId: id, content: [{ type: "text", text }], isError, timestamp: 1 });
}
function apply(session: SessionManager, entries: SessionBoundaryDraft[]) {
  for (const entry of entries) {
    if (entry.type === "context_edit") session.appendContextEdit(entry.targetId, entry.replacement);
    else if (entry.type === "custom") session.appendCustomEntry(entry.customType, entry.data);
    else if (entry.type === "custom_message") session.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    else throw new Error("Unexpected draft " + entry.type);
  }
}
/** Model-visible assistant messages keyed by source entry id. */
function assistantMessages(session: SessionManager) {
  return new Map(buildSessionProjection(session.getBranch()).entries
    .filter(entry => entry.messages[0]?.role === "assistant")
    .map(entry => [entry.sourceEntry.id, JSON.stringify(entry.messages[0])]));
}
const big = (label: string) => (label + " output line\n").repeat(400); // > MIN_TRIM_CHARS
/** Trim plan as the tool builds it: bounded by the active checkpoint's origin. */
function trimPlan(s: SessionManager) { return planContextTrim(s.getBranch(), inspectContext(s.getBranch(), s.getSessionId()).checkpoint?.originId); }

function session() {
  const s = SessionManager.inMemory();
  s.appendMessage({ role: "user", content: "Keep user constraints exactly", timestamp: 1 });
  // Assistant prose and thinking large enough to be trim-sized if they were ever candidates.
  call(s, "read", { path: "src/a.ts" }, big("a"), [thinking("plan ".repeat(1_000)), { type: "text", text: "prose ".repeat(1_000) }]);
  s.appendMessage(assistant([thinking("long ".repeat(1_200)), { type: "text", text: "narrative ".repeat(600) }]));
  call(s, "grep", { pattern: "x", path: "src" }, big("g"));
  call(s, "bash", { command: "ls -R" }, big("ls"), [thinking("shell")]);
  call(s, "read", { path: "src/err.ts" }, big("err"), [thinking("oops")], true);
  s.appendCustomEntry(CONTEXT_CONTROL_TYPE, {
    version: 1, action: "checkpoint", checkpoint: {
      id: "cp", label: "Research", sessionId: s.getSessionId(), originId: s.getLeafId(),
      snapshot: fingerprintContext(contextMessageEntries(s.getBranch())),
    },
  });
  call(s, "read", { path: "src/b.ts" }, big("b"), [thinking("research"), { type: "text", text: "Looking at b" }]);
  call(s, "edit", { path: "src/b.ts", oldText: "x", newText: "y" }, "ok", [thinking("mutating")]);
  call(s, "read", { path: "src/c.ts" }, big("c"), [thinking("more research")]);
  for (let i = 0; i < 4; i++) s.appendMessage(assistant([thinking("recent " + i), { type: "text", text: "Recent protected turn " + i }]));
  return s;
}

describe("assistant content invariant", () => {
  it("trims replace tool results only and leave every assistant message byte-identical", () => {
    const s = session();
    const before = assistantMessages(s);
    const plan = trimPlan(s);
    expect(plan.entries.filter(entry => entry.type === "context_edit").length).toBeGreaterThan(0);
    const entries = new Map(s.getBranch().map(entry => [entry.id, entry]));
    for (const entry of plan.entries) {
      if (entry.type !== "context_edit") continue;
      const target = entries.get(entry.targetId);
      expect(target?.type === "message" && target.message.role).toBe("toolResult");
      expect(typeof entry.replacement?.content).toBe("string");
    }
    apply(s, plan.entries);
    expect(assistantMessages(s)).toEqual(before);
  });

  it("rewinds remove whole research entries, never a part of an assistant message", () => {
    const s = session();
    const before = assistantMessages(s);
    const removable = removableResearch(s.getBranch());
    const plan = planContextRewind(s.getBranch(), s.getSessionId(), "cp", "Findings: b and c read");
    const edits = plan.entries.filter(entry => entry.type === "context_edit");
    expect(edits.length).toBe(plan.removed);
    for (const entry of edits) {
      if (entry.type !== "context_edit") continue;
      expect(entry.replacement).toBeNull();
      expect(removable.has(entry.targetId)).toBe(true);
    }
    apply(s, plan.entries);
    const after = assistantMessages(s);
    for (const [id, text] of after) expect(text).toBe(before.get(id)!);
    // The mutating edit call and its thinking survive; the removed research calls are gone whole.
    expect([...after.values()].filter(text => text.includes('"mutating"')).length).toBe(1);
    expect([...after.values()].some(text => text.includes('"research"'))).toBe(false);
    for (const text of after.values()) if (text.includes('"thinking"')) expect(text).toContain(SIGNATURE);
  });

  it("archived-output reads never return assistant content", () => {
    const s = session();
    apply(s, trimPlan(s).entries);
    apply(s, planContextRewind(s.getBranch(), s.getSessionId(), "cp", "done").entries);
    const branch = s.getBranch();
    const assistantIds = branch.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? [entry.id] : []);
    expect(assistantIds.length).toBeGreaterThan(5);
    for (const id of assistantIds) expect(() => readContextReference(branch, s.getSessionId(), id)).toThrow("No archived reference");
  });
});
