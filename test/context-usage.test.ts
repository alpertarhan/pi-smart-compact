import { describe, expect, it } from "bun:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { anchoredContextTokens, contextUsage } from "../src/app/context-usage.ts";

// Deterministic estimator: a quarter token per visible character.
const estimate = (message: object) => {
  const content = (message as { content?: unknown }).content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.map(block => block.text ?? block.thinking ?? JSON.stringify(block.arguments ?? "")).join("") : "";
  return Math.ceil(text.length / 4);
};

function measured(totalTokens: number, content: AssistantMessage["content"] = [{ type: "text", text: "ok" }]): AssistantMessage {
  return {
    role: "assistant", content, api: "openai-responses", provider: "test", model: "test", stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

const OUTPUT = "research output line\n".repeat(2_000); // 42,000 chars
const MARKER = "[Archived read output, 42000 chars.]";

/** user → read call → large result → measured response (usage 110k); returns the result entry id. */
function session() {
  const s = SessionManager.inMemory();
  s.appendMessage({ role: "user", content: "Find the parser bug", timestamp: 1 });
  const call = s.appendMessage(measured(100_000, [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/parser.ts" } }]));
  const result = s.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "c1", content: [{ type: "text", text: OUTPUT }], isError: false, timestamp: 1 });
  const answer = s.appendMessage(measured(110_000));
  return { s, call, result, answer };
}

describe("anchoredContextTokens", () => {
  it("keeps the measured usage and subtracts only what an edit removed", () => {
    const { s, result } = session();
    s.appendContextEdit(result, { content: MARKER });
    expect(anchoredContextTokens(s.getBranch(), estimate)).toBe(110_000 - Math.ceil(OUTPUT.length / 4) + Math.ceil(MARKER.length / 4));
  });

  it("counts a re-edit against what the measured request carried, not the original", () => {
    const { s, result } = session();
    s.appendContextEdit(result, { content: MARKER });
    s.appendMessage(measured(100_500)); // measured with the marker in place
    s.appendContextEdit(result, null); // a later rewind omits it
    expect(anchoredContextTokens(s.getBranch(), estimate)).toBe(100_500 - Math.ceil(MARKER.length / 4));
  });

  it("adds messages that arrived after the measurement", () => {
    const { s, result } = session();
    s.appendContextEdit(result, { content: MARKER });
    s.appendCustomMessageEntry("smart-compact-rewind", "R".repeat(4_000), true);
    expect(anchoredContextTokens(s.getBranch(), estimate))
      .toBe(110_000 - Math.ceil(OUTPUT.length / 4) + Math.ceil(MARKER.length / 4) + 1_000);
  });

  it("never anchors on an aborted or failed response, like Pi", () => {
    const { s, result } = session();
    for (const stopReason of ["error", "aborted"] as const) {
      const failed = measured(900_000);
      failed.stopReason = stopReason;
      s.appendMessage(failed);
    }
    s.appendContextEdit(result, { content: MARKER });
    const tokens = anchoredContextTokens(s.getBranch(), estimate)!;
    expect(tokens).toBeGreaterThan(95_000); // anchored on the 110k response
    expect(tokens).toBeLessThan(110_000);
  });

  it("anchors on a response the edit removes, as a rewind removes its own call with the research", () => {
    const { s, call, result, answer } = session();
    for (const id of [call, result, answer]) s.appendContextEdit(id, null);
    // Measured 110k minus the call's arguments (6), the output (10,500) and the measured response (1).
    expect(anchoredContextTokens(s.getBranch(), estimate)).toBe(110_000 - 6 - Math.ceil(OUTPUT.length / 4) - 1);
  });

  it("defers to Pi when no edit is newer than the measurement, nothing was measured, or a compaction replaced the window", () => {
    const { s, result } = session();
    expect(anchoredContextTokens(s.getBranch(), estimate)).toBeNull();
    s.appendContextEdit(result, { content: MARKER });
    s.appendMessage(measured(101_000)); // Pi's own usage is current again
    expect(anchoredContextTokens(s.getBranch(), estimate)).toBeNull();

    const unmeasured = SessionManager.inMemory();
    unmeasured.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    unmeasured.appendMessage(measured(0));
    expect(anchoredContextTokens(unmeasured.getBranch(), estimate)).toBeNull();

    const compacted = session();
    compacted.s.appendContextEdit(compacted.result, { content: MARKER });
    const branch = [...compacted.s.getBranch(), { type: "compaction", id: "cmp", parentId: null, timestamp: "t" } as unknown as SessionEntry];
    expect(anchoredContextTokens(branch, estimate)).toBeNull();
  });
});

describe("contextUsage", () => {
  const pi = { tokens: 60_000, contextWindow: 200_000, percent: 30 };

  it("returns Pi's figure unchanged without a session manager or when the branch cannot be read", () => {
    const fake = { getContextUsage: () => pi };
    expect(contextUsage(fake)).toBe(pi);
    const { s, result } = session();
    s.appendContextEdit(result, { content: MARKER }); // an edit is detected, then the branch read fails
    const broken = { ...fake, sessionManager: { getLeafEntry: () => s.getLeafEntry(), getEntry: (id: string) => s.getEntry(id), getBranch: () => { throw new Error("closed"); } } as never };
    expect(contextUsage(broken)).toBe(pi);
    // A session manager without the leaf walk (old fakes) also keeps Pi's figure.
    const walkless = { ...fake, sessionManager: { getBranch: () => [] } as never };
    expect(contextUsage(walkless)).toBe(pi);
    expect(contextUsage({})).toBeUndefined();
  });

  it("replaces tokens and percent with the anchored size after an edit", () => {
    const { s, result } = session();
    s.appendContextEdit(result, { content: MARKER });
    const usage = contextUsage({ getContextUsage: () => pi, sessionManager: s as never })!;
    expect(usage.tokens).toBeGreaterThan(95_000); // the measured 110k minus ~10.5k removed, not Pi's 60k
    expect(usage.tokens).toBeLessThan(110_000);
    expect(usage.percent).toBeCloseTo(usage.tokens! / 200_000 * 100, 6);
    expect(usage.contextWindow).toBe(200_000);
    // Pi's message estimate is the floor when the measured usage never covered the visible messages.
    const higher = { tokens: 150_000, contextWindow: 200_000, percent: 75 };
    expect(contextUsage({ getContextUsage: () => higher, sessionManager: s as never })!.tokens).toBe(150_000);
  });
});
