// Trim ROI (H): what recoverable cleanup actually saved on the live branch.
// Pure derivation from the same control records the trims wrote — no I/O.
import { describe, expect, it } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CONTEXT_CONTROL_TYPE, inspectContext, planContextTrim, trimRoi, trimEntries } from "../src/app/context-operations.ts";

function assistant(ts: number, callId: string, pattern: string): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "toolCall", id: callId, name: "grep", arguments: { pattern } }],
    api: "openai-completions", provider: "test", model: "m", stopReason: "toolUse", timestamp: ts,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function trimSession(): SessionManager {
  const sm = SessionManager.inMemory();
  sm.appendMessage({ role: "user", content: "Find parseConfig call sites", timestamp: 1 });
  for (let i = 0; i < 6; i++) {
    const callId = `call-${i}`;
    sm.appendMessage(assistant(10 + i, callId, `pattern-${i}`));
    sm.appendMessage({
      role: "toolResult", toolCallId: callId, toolName: "grep", isError: false, timestamp: 10 + i,
      content: [{ type: "text", text: `match ${i}\n${"x".repeat(5_000)}` }],
    });
  }
  return sm;
}

describe("trimRoi", () => {
  it("reports zero on an untouched branch", () => {
    const sm = trimSession();
    const roi = trimRoi(sm.getBranch(), sm.getSessionId());
    expect(roi).toEqual({ archivedOutputs: 0, archivedChars: 0, savedCharsEstimate: 0 });
  });

  it("derives archived totals and net savings after a committed trim", () => {
    const sm = trimSession();
    const plan = planContextTrim(sm.getBranch(), undefined, { minSavingChars: 1_000 });
    expect(plan.automatic).toBe("ready");
    const entries = trimEntries(plan, "manual");
    for (const entry of entries) {
      if (entry.type === "context_edit") sm.appendContextEdit(entry.targetId, entry.replacement);
      else if (entry.type === "custom") sm.appendCustomEntry(entry.customType, entry.data);
    }
    const roi = trimRoi(sm.getBranch(), sm.getSessionId());
    expect(roi.archivedOutputs).toBe(plan.archives.length);
    expect(roi.archivedChars).toBe(plan.archives.reduce((sum, item) => sum + item.chars, 0));
    // Net = archived bytes minus the markers that remain in context.
    expect(roi.savedCharsEstimate).toBeGreaterThan(0);
    expect(roi.savedCharsEstimate).toBeLessThan(roi.archivedChars);
  });

  it("matches the planner's own accounting", () => {
    const sm = trimSession();
    const plan = planContextTrim(sm.getBranch(), undefined, { minSavingChars: 1_000 });
    const entries = trimEntries(plan, "agent");
    for (const entry of entries) {
      if (entry.type === "context_edit") sm.appendContextEdit(entry.targetId, entry.replacement);
      else if (entry.type === "custom") sm.appendCustomEntry(entry.customType, entry.data);
    }
    const roi = trimRoi(sm.getBranch(), sm.getSessionId());
    expect(roi.savedCharsEstimate).toBe(plan.savedChars);
  });

  it("keeps working after a foreign edit revokes one reference", () => {
    const sm = trimSession();
    const plan = planContextTrim(sm.getBranch(), undefined, { minSavingChars: 1_000 });
    const entries = trimEntries(plan, "manual");
    for (const entry of entries) {
      if (entry.type === "context_edit") sm.appendContextEdit(entry.targetId, entry.replacement);
      else if (entry.type === "custom") sm.appendCustomEntry(entry.customType, entry.data);
    }
    const references = inspectContext(sm.getBranch(), sm.getSessionId()).references;
    const first = [...references][0]!;
    sm.appendContextEdit(first, { content: "replaced by a foreign hook" });
    const roi = trimRoi(sm.getBranch(), sm.getSessionId());
    expect(roi.archivedOutputs).toBe(plan.archives.length - 1);
  });

  it("reads the same state the status surface already shows", () => {
    const sm = trimSession();
    const plan = planContextTrim(sm.getBranch(), undefined, { minSavingChars: 1_000 });
    const entries = trimEntries(plan, "manual");
    for (const entry of entries) {
      if (entry.type === "context_edit") sm.appendContextEdit(entry.targetId, entry.replacement);
      else if (entry.type === "custom") sm.appendCustomEntry(entry.customType, entry.data);
    }
    const state = inspectContext(sm.getBranch(), sm.getSessionId());
    const roi = trimRoi(sm.getBranch(), sm.getSessionId());
    expect(roi.archivedOutputs).toBe(state.archives.size);
    expect(roi.archivedChars).toBe([...state.archives.values()].reduce((sum, rec) => sum + rec.chars, 0));
  });
});
