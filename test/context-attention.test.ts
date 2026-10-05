import { describe, expect, it } from "bun:test";
import { ATTENTION_CUSTOM_TYPE, registerContextAttention, type ContextAttentionDeps } from "../src/app/context-attention.ts";

type Handler = (event: { type: string; message: unknown }, ctx: unknown) => unknown;
type Sent = { message: { customType: string; content: string; details?: unknown }; options?: { deliverAs?: string } };

const settings = (over: Partial<ReturnType<ContextAttentionDeps["config"]>> = {}) => ({
  contextNavigationEnabled: true, contextGuidanceEnabled: true, toolLoading: "eager" as const, autoTrigger: true,
  minContextPercent: 80, prepareContextPercent: null, maxContextTokens: 0, ...over,
});

function harness(opts: { active?: string[]; config?: Partial<ReturnType<ContextAttentionDeps["config"]>>; canAct?: boolean; reachable?: boolean } = {}) {
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
    reachable: () => opts.reachable ?? true,
  });
  // 200k window, 80% apply: compaction from 160k, cleanup from 140k.
  const ctx = (tokens: number, sessionId = "s1") => ({
    model: { contextWindow: 200_000, api: "anthropic-messages" },
    getContextUsage: () => ({ tokens }),
    sessionManager: { getBranch: () => [], getSessionId: () => sessionId },
  });
  const assistant = (tokens: number, stopReason = "toolUse", tool = "bash") => {
    const message = { role: "assistant", stopReason, content: [{ type: "toolCall", name: tool, id: "c", arguments: {} }] };
    for (const fn of handlers.get("message_end") ?? []) fn({ type: "message_end", message }, ctx(tokens));
  };
  const fire = (event: string) => { for (const fn of handlers.get(event) ?? []) fn({ type: event, message: null }, ctx(0)); };
  return { sent, assistant, fire };
}

describe("context attention", () => {
  it("says nothing while there is room", () => {
    const h = harness();
    h.assistant(100_000);
    expect(h.sent).toHaveLength(0);
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
    expect(note.message.content).toContain("prepares at 80%");
    expect(note.message.content).not.toContain("trim:");
  });

  it("escalates to the compaction band once, then stays quiet until pressure clears", () => {
    const h = harness();
    h.assistant(150_000);
    h.assistant(170_000);
    h.assistant(175_000);
    h.assistant(150_000); // still above cleanup: compaction note already covers it
    expect(h.sent.map(s => s.message.content.includes("compaction band"))).toEqual([false, true]);
    expect(h.sent[1].message.content).toContain("Anchor now");
    h.assistant(100_000); // pressure cleared (compaction/trim happened)
    h.assistant(150_000);
    expect(h.sent).toHaveLength(3);
  });

  it("parks a cleanup note for the next prompt when the turn ends, but never a compaction note under auto-trigger", () => {
    const h = harness();
    h.assistant(150_000, "stop");
    expect(h.sent[0]?.options?.deliverAs).toBe("nextTurn");
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

  it("re-arms at session boundaries", () => {
    const h = harness();
    h.assistant(150_000);
    h.fire("session_start");
    h.assistant(150_000);
    expect(h.sent).toHaveLength(2);
  });
});
