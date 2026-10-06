import { describe, expect, it } from "bun:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ATTENTION_CUSTOM_TYPE, registerContextAttention, type ContextAttentionDeps } from "../src/app/context-attention.ts";
import { CONTEXT_CONTROL_TYPE } from "../src/app/context-operations.ts";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";
import { fingerprintContext } from "../src/app/pending-slot.ts";

type Handler = (event: { type: string; message: unknown }, ctx: unknown) => unknown;
type Sent = { message: { customType: string; content: string; details?: unknown }; options?: { deliverAs?: string } };

const settings = (over: Partial<ReturnType<ContextAttentionDeps["config"]>> = {}) => ({
  contextNavigationEnabled: true, contextGuidanceEnabled: true, toolLoading: "eager" as const, autoTrigger: true,
  autoTriggerStrategy: "settled" as const,
  minContextPercent: 80, prepareContextPercent: null, maxContextTokens: 0, ...over,
});

function harness(opts: { active?: string[]; config?: Partial<ReturnType<ContextAttentionDeps["config"]>>; canAct?: boolean; canCleanup?: boolean; reachable?: boolean; branch?: SessionEntry[] } = {}) {
  const handlers = new Map<string, Handler[]>();
  const sent: Sent[] = [];
  const pi = {
    on: (event: string, fn: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return () => {}; },
    sendMessage: (message: Sent["message"], options?: Sent["options"]) => { sent.push({ message, options }); },
    getActiveTools: () => opts.active ?? ["bash", "smart_navigation", "smart_context", "smart_tools"],
  };
  registerContextAttention(pi as never, {
    config: () => settings(opts.config),
    canAgentAct: () => opts.canAct ?? true,
    canCleanup: () => opts.canCleanup ?? true,
    reachable: () => opts.reachable ?? true,
  });
  // 200k window, 80% apply: compaction from 160k, cleanup from 140k.
  const ctx = (tokens: number, sessionId = "s1") => ({
    model: { contextWindow: 200_000, api: "anthropic-messages" },
    getContextUsage: () => ({ tokens }),
    sessionManager: { getBranch: () => opts.branch ?? [], getSessionId: () => sessionId },
  });
  const assistant = (tokens: number, stopReason = "toolUse", tool = "bash") => {
    const message = { role: "assistant", stopReason, content: [{ type: "toolCall", name: tool, id: "c", arguments: {} }] };
    for (const fn of handlers.get("message_end") ?? []) fn({ type: "message_end", message }, ctx(tokens));
  };
  const fire = (event: string, tokens = 0) => { for (const fn of handlers.get(event) ?? []) fn({ type: event, message: null }, ctx(tokens)); };
  const prompt = (tokens: number) => {
    for (const fn of handlers.get("before_agent_start") ?? []) {
      const result = fn({ type: "before_agent_start", message: null }, ctx(tokens)) as { message?: Sent["message"] } | undefined;
      if (result?.message) sent.push({ message: result.message });
    }
  };
  return { sent, assistant, fire, prompt };
}

function research(signed = false): SessionEntry[] {
  const sm = SessionManager.inMemory();
  const base = { role: "assistant" as const, api: "anthropic-messages" as const, provider: "anthropic", model: "offline", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  sm.appendMessage({ role: "user", content: "Inspect evidence", timestamp: 1 });
  sm.appendMessage({ ...base, stopReason: "toolUse", content: [{ type: "toolCall", id: "old", name: "read", arguments: { path: "old.ts" } }] });
  sm.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "old", content: [{ type: "text", text: "evidence ".repeat(3_000) }], isError: false, timestamp: 1 });
  for (let i = 0; i < 5; i++) sm.appendMessage({ ...base, stopReason: "stop", content: signed
    ? [{ type: "thinking", thinking: "Uses the old evidence", thinkingSignature: "offline-signature" }]
    : [{ type: "text", text: "Recent protected turn" }] });
  return sm.getBranch();
}

describe("context attention", () => {
  it("says nothing while there is room", () => {
    const h = harness();
    h.assistant(100_000);
    expect(h.sent).toHaveLength(0);
  });

  it("points an active research checkpoint at rewind, not a new checkpoint or anchor", () => {
    const branch = research();
    branch.push({ type: "custom", id: "cp", parentId: branch.at(-1)!.id, timestamp: new Date(1).toISOString(),
      customType: CONTEXT_CONTROL_TYPE, data: { version: 1, action: "checkpoint", checkpoint: {
        id: "cp", label: "Auth investigation", sessionId: "s1", originId: branch.at(-1)!.id,
        snapshot: fingerprintContext(contextMessageEntries(branch)),
      } } });
    const h = harness({ branch });
    h.assistant(100_000);
    expect(h.sent).toHaveLength(0); // no new per-turn prompt churn below pressure
    h.assistant(150_000);
    const text = h.sent[0].message.content;
    expect(text).toContain("Auth investigation");
    expect(text).toContain("smart_context rewind(report)");
    expect(text).not.toContain("smart_context checkpoint first");
    expect(text).not.toContain("smart_navigation anchor");
    expect(text).not.toContain("trim:");
    const blocked = harness({ branch, canCleanup: false });
    blocked.assistant(150_000);
    expect(blocked.sent[0].message.content).toContain("takes priority");
  });

  it("notes the cleanup band once per session, steering mid-turn with the available tools", () => {
    const h = harness();
    h.assistant(150_000);
    h.assistant(152_000);
    expect(h.sent).toHaveLength(1);
    const [note] = h.sent;
    expect(note.message.customType).toBe(ATTENTION_CUSTOM_TYPE);
    expect(note.options?.deliverAs).toBe("steer");
    expect(note.message.content).toContain("75% of the policy window (cleanup band)");
    expect(note.message.content).toContain("smart_navigation anchor");
    expect(note.message.content).toContain("smart_context checkpoint");
    expect(note.message.content).toContain("requested at 80%");
    expect(note.message.content).not.toContain("trim:");
  });

  it("escalates to the compaction band once, then stays quiet until pressure clears", () => {
    const h = harness();
    h.assistant(150_000);
    h.assistant(170_000);
    h.assistant(175_000);
    h.assistant(150_000); // still above cleanup: compaction note already covers it
    expect(h.sent.map(s => s.message.content.includes("compaction band"))).toEqual([false, true]);
    expect(h.sent[1].message.content).toContain("smart_navigation anchor");
    h.assistant(100_000); // pressure cleared (compaction/trim happened)
    h.assistant(150_000);
    expect(h.sent).toHaveLength(3);
  });

  it("recomputes a prompt note at delivery instead of parking stale pressure in nextTurn", () => {
    const h = harness();
    h.assistant(150_000, "stop");
    expect(h.sent).toHaveLength(0);
    h.fire("session_compact");
    h.prompt(20_000);
    expect(h.sent).toHaveLength(0);
    h.prompt(150_000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.options).toBeUndefined(); // returned from before_agent_start
    expect(h.sent[0]?.message.content).toContain("75%");
    h.assistant(170_000, "stop");
    expect(h.sent).toHaveLength(1);
    h.assistant(170_000, "toolUse");
    expect(h.sent).toHaveLength(2);
  });

  it("does not talk over the model's own context call", () => {
    const h = harness();
    h.assistant(150_000, "toolUse", "smart_navigation");
    expect(h.sent).toHaveLength(0);
    h.assistant(150_000, "toolUse", "bash");
    expect(h.sent).toHaveLength(1);
  });

  it("points lazy loadouts at smart_tools and goes silent when nothing is reachable or allowed", () => {
    const lazy = harness({ active: ["bash", "smart_tools"], config: { toolLoading: "lazy" as never } });
    lazy.assistant(150_000);
    expect(lazy.sent[0].message.content).toContain("smart_navigation anchor");
    expect(lazy.sent[0].message.content).toContain("Load it first: smart_tools load navigation.");

    const unreachable = harness({ active: ["bash"], reachable: false });
    unreachable.assistant(150_000);
    expect(unreachable.sent).toHaveLength(0);

    const off = harness({ config: { toolLoading: "off" as never } });
    off.assistant(150_000);
    const blocked = harness({ canAct: false });
    blocked.assistant(150_000);
    expect([off.sent.length, blocked.sent.length]).toEqual([0, 0]);
  });

  it.each(["session_start", "session_compact", "model_select"])("re-arms at %s", event => {
    const h = harness();
    h.assistant(150_000);
    h.fire(event);
    h.assistant(150_000);
    expect(h.sent).toHaveLength(2);
  });

  it("shares the maintenance gate instead of recommending trim over prepared compaction", () => {
    const blocked = harness({ canCleanup: false, branch: research() });
    blocked.assistant(150_000);
    expect(blocked.sent[0].message.content).not.toContain("trim:");
    const ready = harness({ canCleanup: true, branch: research() });
    ready.assistant(150_000);
    expect(ready.sent[0].message.content).toContain("trim: 1");
  });

  it("does not promise history cleanup or warm cache when signed thinking blocks edits", () => {
    const h = harness({ branch: research(true) });
    h.assistant(150_000);
    expect(h.sent[0].message.content).not.toContain("trim:");
    expect(h.sent[0].message.content).not.toMatch(/stays (warm|cached)|queued automatically/);
    expect(h.sent[0].message.content).toContain("checkpoint"); // metadata still allowed
    expect(h.sent[0].message.content).toContain("safety checks still apply");
  });

  it("history guidance works with navigation disabled", () => {
    const h = harness({ config: { contextNavigationEnabled: false } });
    h.assistant(150_000);
    expect(h.sent[0]?.message.content).toContain("smart_context checkpoint");
    expect(h.sent[0]?.message.content).not.toContain("smart_navigation anchor");
  });

  it.each(["settled", "background", "native-hook"] as const)("describes %s strategy without inventing a preparation phase", strategy => {
    const h = harness({ config: { autoTriggerStrategy: strategy } });
    h.assistant(150_000);
    h.assistant(170_000);
    const text = h.sent.map(note => note.message.content).join("\n");
    if (strategy === "native-hook") {
      expect(text).toContain("when Pi requests compaction");
      expect(text).not.toContain("when the turn settles");
    } else {
      expect(text).toContain("when the turn settles");
      expect(text.includes("Background preparation")).toBe(strategy === "background");
    }
  });

  it("names agent staging, not application, when automatic compaction is off", () => {
    const h = harness({ active: ["smart_compact"], config: { autoTrigger: false, contextNavigationEnabled: false } });
    h.prompt(170_000);
    expect(h.sent[0]?.message.content).toContain("smart_compact");
    expect(h.sent[0]?.message.content).toContain("stages");
    expect(h.sent[0]?.message.content).toContain("/compact");
  });

  it("rechecks changed permissions and tools before the next prompt", () => {
    const opts = { canAct: true, active: ["smart_context"], config: { contextGuidanceEnabled: true } };
    const h = harness(opts);
    h.assistant(150_000, "stop");
    opts.canAct = false;
    h.prompt(150_000);
    opts.canAct = true;
    opts.active = [];
    h.prompt(150_000);
    expect(h.sent).toHaveLength(0);
    opts.active = ["smart_context"];
    opts.config.contextGuidanceEnabled = false;
    h.prompt(150_000);
    expect(h.sent).toHaveLength(0);
    opts.config.contextGuidanceEnabled = true;
    h.prompt(150_000);
    expect(h.sent).toHaveLength(1);
  });
});
