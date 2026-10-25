import { afterEach, describe, expect, it } from "bun:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCompactionDelivery } from "../src/app/compaction-delivery.ts";
import { createSettledAutoTrigger } from "../src/app/settled-auto-trigger.ts";
import { DEFAULT_CONFIG } from "../src/constants.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function fixture(hasUI = false) {
  const events = createEventBus();
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  let sessionId = "one";
  let idle = true;
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  const ctx = {
    isIdle: () => idle,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 85_000, contextWindow: 100_000, percent: 85 }),
    model: { provider: "openai", id: "fixture", contextWindow: 100_000 },
    sessionManager: { getSessionId: () => sessionId },
    hasUI,
    ui: {
      notify(message: string) { notices.push(message); },
      setStatus(_key: string, value: string | undefined) { statuses.push(value); },
    },
  } as unknown as ExtensionContext;
  const pi = {
    events,
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...handlers.get(name) ?? [], handler]);
    },
  } as unknown as ExtensionAPI;
  const controller = registerCompactionDelivery(pi);
  const emit = async (name: string, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  const request = (deliver: () => void, targetSession = sessionId) => {
    const value = { version: 1, sessionId: targetSession, deliver, deferred: false };
    events.emit("smart-compact:defer-delivery", value);
    return value;
  };
  cleanups.push(() => emit("session_shutdown"));
  return { ctx, controller, emit, request, statuses, notices, setIdle: (value: boolean) => { idle = value; },
    switchSession: (id: string) => { sessionId = id; } };
}

describe("compaction delivery gate", () => {
  it("leaves ordinary delivery and other sessions alone", async () => {
    const f = fixture();
    expect(f.request(() => {}).deferred).toBe(false);
    await f.emit("session_before_compact");
    expect(f.request(() => {}, "another-session").deferred).toBe(false);
  });

  it("queues FIFO through native commit, then waits for actual host idle", async () => {
    const f = fixture();
    f.setIdle(false);
    await f.emit("session_before_compact");
    const calls: number[] = [];
    const done = Promise.withResolvers<void>();
    expect(f.request(() => calls.push(1)).deferred).toBe(true);
    expect(f.request(() => { calls.push(2); done.resolve(); }).deferred).toBe(true);
    await f.emit("session_compact");
    expect(calls).toEqual([]);
    // The host still considers itself compacting inside session_compact handlers.
    expect(f.request(() => calls.push(3)).deferred).toBe(true);
    f.setIdle(true);
    await done.promise;
    expect(calls).toEqual([1, 2, 3]);
    expect(f.request(() => {}).deferred).toBe(false);
  });

  it("delivers auto-compaction mail at the next run boundary without requiring idle", async () => {
    const f = fixture();
    f.setIdle(false);
    await f.emit("session_before_compact");
    const calls: string[] = [];
    f.request(() => calls.push("mail"));
    await f.emit("session_compact");
    await f.emit("turn_start");
    await f.emit("agent_settled");
    expect(calls).toEqual(["mail"]);
  });

  it("retains cancelled mail without auto-waking; the next natural run delivers it", async () => {
    const f = fixture();
    await f.emit("session_before_compact");
    const calls: string[] = [];
    f.request(() => calls.push("cancelled-mail"));
    await f.emit("session_compact_failed", { aborted: true });
    await f.emit("agent_settled");
    expect(calls).toEqual([]);
    f.setIdle(false);
    await f.emit("before_agent_start");
    expect(calls).toEqual(["cancelled-mail"]);
  });

  it("waits for turn_start when an older host still reports idle in before_agent_start", async () => {
    const f = fixture();
    await f.emit("session_before_compact");
    let attempts = 0;
    f.request(() => { if (++attempts === 1) throw new Error("first delivery rejected"); });
    await f.emit("session_compact_failed", { aborted: true });
    await f.emit("before_agent_start");
    expect(attempts).toBe(0);
    f.setIdle(false);
    await f.emit("turn_start");
    expect(attempts).toBe(1);
    await f.emit("turn_start");
    expect(attempts).toBe(1);
    f.setIdle(true);
    await f.emit("before_agent_start");
    expect(attempts).toBe(1);
    f.setIdle(false);
    await f.emit("turn_start");
    expect(attempts).toBe(2);
    expect(f.request(() => {}).deferred).toBe(false);
  });

  it("releases cancelled mail after a successful retry without an extra user turn", async () => {
    const f = fixture();
    const delivered = Promise.withResolvers<void>();
    await f.emit("session_before_compact");
    f.request(delivered.resolve);
    await f.emit("session_compact_failed", { aborted: true });
    await f.emit("session_before_compact");
    await f.emit("session_compact");
    await delivered.promise;
    expect(f.request(() => {}).deferred).toBe(false);
  }, 1000);

  it("resumes after failure even when no extension summary was provided", async () => {
    const f = fixture();
    await f.emit("session_before_compact");
    const delivered = Promise.withResolvers<void>();
    f.request(delivered.resolve);
    await f.emit("session_compact_failed", { aborted: false, fromExtension: false });
    await delivered.promise;
    expect(f.request(() => {}).deferred).toBe(false);
  });

  it("drops old-session callbacks on shutdown and never replays them after a switch", async () => {
    const f = fixture();
    await f.emit("session_before_compact");
    const calls: string[] = [];
    f.request(() => calls.push("wrong-session"));
    await f.emit("session_shutdown");
    f.switchSession("two");
    await f.emit("session_start");
    await f.emit("before_agent_start");
    expect(calls).toEqual([]);
    expect(f.request(() => {}).deferred).toBe(false);
  });

  it("does not use a context invalidated before the shutdown event", async () => {
    const f = fixture();
    await f.emit("session_before_compact");
    const calls: string[] = [];
    f.request(() => calls.push("stale"));
    await f.emit("session_compact");
    Object.defineProperty(f.ctx, "sessionManager", { get() { throw new Error("stale ctx"); } });
    await f.emit("turn_start");
    expect(calls).toEqual([]);
  });

  it("stops draining when delivery synchronously starts another compaction", async () => {
    const f = fixture();
    await f.emit("session_before_compact");
    const calls: number[] = [];
    f.request(() => { calls.push(1); void f.emit("session_before_compact"); });
    f.request(() => calls.push(2));
    await f.emit("session_compact");
    await f.emit("turn_start");
    expect(calls).toEqual([1]);
    await f.emit("session_compact");
    await f.emit("turn_start");
    expect(calls).toEqual([1, 2]);
  });

  it("keeps a synchronously rejected delivery for the next natural boundary", async () => {
    const f = fixture();
    await f.emit("session_before_compact");
    let attempts = 0;
    const calls: number[] = [];
    f.request(() => { if (++attempts === 1) throw new Error("fixture rejection"); calls.push(1); });
    f.request(() => calls.push(2));
    await f.emit("session_compact");
    await f.emit("turn_start");
    expect(calls).toEqual([2]);
    // Failed callbacks do not block newly arriving senders or retry twice in one run.
    expect(f.request(() => {}).deferred).toBe(false);
    await f.emit("turn_start");
    expect(attempts).toBe(1);
    f.setIdle(false);
    await f.emit("before_agent_start");
    expect(calls).toEqual([2, 1]);
  });

  it("holds proactive requests before the host reaches session_before_compact", async () => {
    const f = fixture();
    let callbacks: Parameters<ExtensionContext["compact"]>[0];
    f.ctx.compact = options => { callbacks = options; };
    f.controller.guard(f.ctx).compact();
    const delivered = Promise.withResolvers<void>();
    expect(f.request(delivered.resolve).deferred).toBe(true);
    await f.emit("session_before_compact");
    await f.emit("session_compact");
    // The outer request has not completed yet, even if another boundary fires.
    await f.emit("turn_start");
    expect(f.request(() => {}).deferred).toBe(true);
    callbacks?.onComplete?.({ summary: "fixture", firstKeptEntryId: "entry", tokensBefore: 100 });
    await delivered.promise;
    expect(f.request(() => {}).deferred).toBe(false);
  });

  it.each([
    { busy: false, lateCallback: false },
    { busy: true, lateCallback: false },
    { busy: true, lateCallback: true },
  ])("recovers a missing callback only after idle (busy=$busy, late=$lateCallback)", async ({ busy, lateCallback }) => {
    const f = fixture();
    let callbacks: Parameters<ExtensionContext["compact"]>[0];
    f.ctx.compact = options => { callbacks = options; f.setIdle(!busy); };
    const trigger = createSettledAutoTrigger({ watchdogMs: 10, compact: f.controller.compact });
    const request = trigger.request(f.ctx, { ...DEFAULT_CONFIG, autoTrigger: true, autoTriggerStrategy: "settled" });
    const delivered = Promise.withResolvers<void>();
    expect(f.request(delivered.resolve).deferred).toBe(true);
    await request;
    if (busy) {
      expect(f.request(() => {}).deferred).toBe(true);
      f.setIdle(true);
      if (lateCallback) callbacks?.onComplete?.({ summary: "late", firstKeptEntryId: "entry", tokensBefore: 100 });
    }
    await delivered.promise;
    expect(f.request(() => {}).deferred).toBe(false);
  }, 1000);

  it("watchdog recovery and late callbacks cannot release a newer request", async () => {
    const f = fixture();
    const callbacks: Array<Parameters<ExtensionContext["compact"]>[0]> = [];
    f.ctx.compact = options => { callbacks.push(options); };
    const trigger = createSettledAutoTrigger({ watchdogMs: 10, compact: f.controller.compact });
    const request = trigger.request(f.ctx, { ...DEFAULT_CONFIG, autoTrigger: true, autoTriggerStrategy: "settled" });
    f.controller.guard(f.ctx).compact();
    await request;
    callbacks[0]?.onComplete?.({ summary: "old", firstKeptEntryId: "entry", tokensBefore: 100 });
    const delivered = Promise.withResolvers<void>();
    expect(f.request(delivered.resolve).deferred).toBe(true);
    await f.emit("turn_start");
    expect(f.request(() => {}).deferred).toBe(true);
    callbacks[1]?.onComplete?.({ summary: "new", firstKeptEntryId: "entry", tokensBefore: 100 });
    await delivered.promise;
  }, 1000);

  it("shows queue size, cancellation recovery and the volatile lifetime without model messages", async () => {
    const f = fixture(true);
    await f.emit("session_before_compact");
    f.request(() => {});
    f.request(() => {});
    expect(f.statuses.at(-1)).toContain("2 notifications queued");
    expect(f.statuses.at(-1)).toContain("compacting");
    expect(f.notices.filter(text => text.includes("in memory"))).toHaveLength(1);
    expect(f.notices.join(" ")).toContain("reload");
    await f.emit("session_compact_failed", { aborted: true });
    expect(f.statuses.at(-1)).toContain("cancelled");
    expect(f.notices.at(-1)).toContain("Send a message");
    f.setIdle(false);
    await f.emit("before_agent_start");
    expect(f.statuses.at(-1)).toBeUndefined();
  });

  it("keeps delivering if the status renderer and notification UI throw", async () => {
    const f = fixture(true);
    f.ctx.ui.setStatus = () => { throw new Error("broken renderer"); };
    f.ctx.ui.notify = () => { throw new Error("broken notification UI"); };
    await f.emit("session_before_compact");
    const done = Promise.withResolvers<void>();
    f.request(done.resolve);
    await f.emit("session_compact");
    await done.promise;
    expect(f.request(() => {}).deferred).toBe(false);
  });

  it("shows failed delivery separately while allowing healthy notifications through", async () => {
    const f = fixture(true);
    await f.emit("session_before_compact");
    let healthy = 0;
    f.request(() => { throw new Error("permanent producer failure"); });
    f.request(() => { healthy++; });
    await f.emit("session_compact");
    f.setIdle(false);
    await f.emit("before_agent_start");
    expect(healthy).toBe(1);
    expect(f.statuses.at(-1)).toContain("1 notification queued");
    expect(f.statuses.at(-1)).toContain("delivery failed");
    expect(f.request(() => {}).deferred).toBe(false);
    await f.emit("session_shutdown");
    expect(f.statuses.at(-1)).toBeUndefined();
  });

  it("does not redeliver a callback during a reentrant run boundary", async () => {
    const f = fixture();
    let calls = 0;
    await f.emit("session_before_compact");
    f.request(() => { calls++; void f.emit("before_agent_start"); });
    await f.emit("session_compact");
    await f.emit("turn_start");
    expect(calls).toBe(1);
  });

  it("guards foreground preparation and releases a skipped run", async () => {
    const f = fixture();
    const delivered = Promise.withResolvers<void>();
    // Missing models deliberately skip before I/O, but admission is already held.
    const run = f.controller.runManual({ ctx: f.ctx } as Parameters<typeof f.controller.runManual>[0]);
    expect(f.request(delivered.resolve).deferred).toBe(true);
    expect((await run).kind).toBe("skipped");
    await delivered.promise;
    expect(f.request(() => {}).deferred).toBe(false);
  });
});
