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
  * archived-output reads never return assistant text. Byte equality alone
  * does NOT preserve prefix-bound thinking: retained dependencies must also remain.
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
/** One assistant batch with several calls; returns the call ids in order. */
function batch(session: SessionManager, calls: Array<{ name: string; args: ToolCall["arguments"]; text: string; isError?: boolean }>, extra: AssistantMessage["content"] = []) {
  const ids = calls.map(() => "call-" + sequence++);
  session.appendMessage(assistant([...extra, ...calls.map((item, index) => ({ type: "toolCall" as const, id: ids[index], name: item.name, arguments: item.args }))], "toolUse"));
  calls.forEach((item, index) => session.appendMessage({
    role: "toolResult", toolName: item.name, toolCallId: ids[index], content: [{ type: "text", text: item.text }], isError: item.isError ?? false, timestamp: 1,
  }));
  return ids;
}
function checkpoint(session: SessionManager, id: string) {
  session.appendCustomEntry(CONTEXT_CONTROL_TYPE, { version: 1, action: "checkpoint", checkpoint: {
    id, label: id, sessionId: session.getSessionId(), originId: session.getLeafId(), snapshot: fingerprintContext(contextMessageEntries(session.getBranch())),
  } });
}
/** Model-visible tool result text keyed by tool call id. */
function resultTexts(session: SessionManager) {
  return new Map(buildSessionProjection(session.getBranch()).entries.flatMap(({ messages }) => messages[0]?.role === "toolResult"
    ? [[messages[0].toolCallId, messages[0].content.map(block => block.type === "text" ? block.text : "").join("")] as const] : []));
}
const resultEntryId = (session: SessionManager, callId: string) => session.getBranch()
  .find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === callId)!.id;
/** Trim plan as the tool builds it: bounded by the active checkpoint's origin. */
function trimPlan(s: SessionManager) { return planContextTrim(s.getBranch(), inspectContext(s.getBranch(), s.getSessionId()).checkpoint?.originId); }

function session(signedAnthropic = false) {
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
  if (!signedAnthropic) {
    const branch = s.getBranch();
    for (const [index, entry] of branch.entries()) {
      if (entry.type === "message" && entry.message.role === "assistant") entry.message.api = "openai-completions";
      if (entry.type === "custom" && entry.customType === CONTEXT_CONTROL_TYPE) {
        (entry.data as { checkpoint: { snapshot: ReturnType<typeof fingerprintContext> } }).checkpoint.snapshot = fingerprintContext(contextMessageEntries(branch.slice(0, index)));
      }
    }
  }
  return s;
}

describe("assistant content invariant", () => {
  it("refuses trim and selective rewind that invalidate retained signed thinking", () => {
    const s = session(true);
    const before = assistantMessages(s);
    const plan = trimPlan(s);
    expect(plan.entries).toEqual([]);
    expect(plan.blockedReason).toContain("signed Anthropic thinking");
    expect(() => planContextRewind(s.getBranch(), s.getSessionId(), "cp", "done")).toThrow("signed Anthropic thinking");
    // The refusal names what was kept, so the agent knows which batches blocked the rewind.
    expect(() => planContextRewind(s.getBranch(), s.getSessionId(), "cp", "done")).toThrow("Kept tool batches after the checkpoint:");
    expect(assistantMessages(s)).toEqual(before);
  });

  it("allows removing an entire research suffix while preserving the earlier signed prefix", () => {
    const s = session(true);
    // Start a fresh checkpoint after the existing signed prefix.
    s.appendCustomEntry(CONTEXT_CONTROL_TYPE, { version: 1, action: "checkpoint", checkpoint: {
      id: "pure", label: "Pure research", sessionId: s.getSessionId(), originId: s.getLeafId(),
      snapshot: fingerprintContext(contextMessageEntries(s.getBranch())),
    } });
    const before = assistantMessages(s);
    call(s, "read", { path: "src/pure.ts" }, big("pure"), [thinking("temporary research")]);
    const plan = planContextRewind(s.getBranch(), s.getSessionId(), "pure", "The pure finding.");
    expect(plan.removed).toBe(2);
    const report = plan.entries.find(entry => entry.type === "custom_message") as { content: string };
    expect(report.content).toMatch(/2 research messages removed \(\d+ chars of tool output\); kept no tool batches/);
    apply(s, plan.entries);
    expect(assistantMessages(s)).toEqual(before);
  });

  it.each([
    ["rewinds", "rg -n foo src | head -20"],
    ["refuses", "rg -n foo src > found.txt"],
  ])("%s a signed-thinking detour whose shell call is %s", (verdict, command) => {
    const s = session(true);
    s.appendCustomEntry(CONTEXT_CONTROL_TYPE, { version: 1, action: "checkpoint", checkpoint: {
      id: "shell", label: "Shell research", sessionId: s.getSessionId(), originId: s.getLeafId(),
      snapshot: fingerprintContext(contextMessageEntries(s.getBranch())),
    } });
    const before = assistantMessages(s);
    call(s, "read", { path: "src/d.ts" }, big("d"), [thinking("read first")]);
    call(s, "bash", { command }, big("rg"), [thinking("then search")]);
    const rewind = () => planContextRewind(s.getBranch(), s.getSessionId(), "shell", "Found foo in src/d.ts.");
    if (verdict === "refuses") {
      // A shell call that writes stays, and the signed thinking after the removed read blocks the rewind.
      expect(rewind).toThrow("Kept tool batches after the checkpoint: bash.");
      return;
    }
    const plan = rewind();
    expect(plan.removed).toBe(4); // both call/result pairs
    apply(s, plan.entries);
    expect(assistantMessages(s)).toEqual(before);
  });

  it("archives research outputs inside batches a rewind keeps, leaving instruction reads, errors and assistants intact", () => {
    const s = session();
    checkpoint(s, "mixed");
    const [rules, source] = batch(s, [
      { name: "read", args: { path: "AGENTS.md" }, text: big("rules") },
      { name: "read", args: { path: "src/x.ts" }, text: big("x") },
    ]);
    const [failed, search, tiny] = batch(s, [
      { name: "read", args: { path: "src/missing.ts" }, text: "ENOENT", isError: true },
      { name: "grep", args: { pattern: "y", path: "src" }, text: big("y") },
      { name: "read", args: { path: "src/tiny.ts" }, text: "tiny" },
    ]);
    const before = assistantMessages(s);
    const plan = planContextRewind(s.getBranch(), s.getSessionId(), "mixed", "Found x and y.");
    const report = plan.entries.find(entry => entry.type === "custom_message") as { content: string };
    expect(report.content).toMatch(/0 research messages removed \(0 chars of tool output\); 2 research outputs inside kept batches archived \(\d+ chars, markers left\)/);
    apply(s, plan.entries);
    const texts = resultTexts(s);
    expect(texts.get(rules)).toBe(big("rules")); // instruction reads stay verbatim
    expect(texts.get(failed)).toBe("ENOENT"); // errors stay
    expect(texts.get(tiny)).toBe("tiny"); // too small to be worth a marker
    for (const id of [source, search]) {
      expect(texts.get(id)).toContain("Retrieve with smart_context action=read id=");
      expect(texts.get(id)).toContain("(archived by rewind)");
    }
    expect(readContextReference(s.getBranch(), s.getSessionId(), resultEntryId(s, source))).toBe(big("x"));
    expect(assistantMessages(s)).toEqual(before);
  });

  it("drops, never refuses, kept-batch archiving that would bind retained signed thinking", () => {
    const bound = session(true);
    checkpoint(bound, "bound");
    const [, boundSource] = batch(bound, [
      { name: "read", args: { path: "AGENTS.md" }, text: big("rules") },
      { name: "read", args: { path: "src/x.ts" }, text: big("x") },
    ]);
    call(bound, "edit", { path: "src/x.ts", oldText: "a", newText: "b" }, "ok", [thinking("edit after reading")]);
    const kept = planContextRewind(bound.getBranch(), bound.getSessionId(), "bound", "Edited x.");
    expect(kept.entries.filter(entry => entry.type === "context_edit")).toEqual([]);
    apply(bound, kept.entries);
    expect(resultTexts(bound).get(boundSource)).toBe(big("x"));

    // With no signed thinking after the output, the same batch is archived under Anthropic too.
    const free = session(true);
    checkpoint(free, "free");
    const [, freeSource] = batch(free, [
      { name: "read", args: { path: "AGENTS.md" }, text: big("rules") },
      { name: "read", args: { path: "src/x.ts" }, text: big("x") },
    ], [thinking("read both")]);
    const before = assistantMessages(free);
    apply(free, planContextRewind(free.getBranch(), free.getSessionId(), "free", "Read x.").entries);
    expect(resultTexts(free).get(freeSource)).toContain("(archived by rewind)");
    expect(assistantMessages(free)).toEqual(before);
  });

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
