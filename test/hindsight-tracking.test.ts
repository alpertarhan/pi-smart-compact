import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHindsightTracking } from "../src/app/hindsight-tracking.ts";
import { registerCompactionDelivery } from "../src/app/compaction-delivery.ts";
import { registerContextTools } from "../src/app/register-context-tools.ts";
import { refreshReceipt, saveHindsightMemory } from "../src/app/hindsight-memory.ts";
import { listReceipts, updateReceiptState } from "../src/infra/hindsight-receipts.ts";
import { manualMemoryId } from "../src/infra/context-graph.ts";
import { resetConfigCache } from "../src/utils/config.ts";
import { deriveProjectIdFromCwd } from "../src/utils/fingerprint.ts";
import { startHindsightFake, type HindsightFake } from "./hindsight-fake.ts";

const originalHome = process.env.HOME;
let home: string;
let fake: HindsightFake;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-hindsight-tracking-"));
  process.env.HOME = home;
  fake = startHindsightFake({ token: null });
  fake.retainStatus = "pending";
  configure();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  fake.stop();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  resetConfigCache();
  fs.rmSync(home, { recursive: true, force: true });
});
function configure(bankId = "tracking") {
  const dir = path.join(home, ".pi", "agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ smartCompact: {
    memoryBackend: "hindsight", hindsightBaseUrl: fake.url, hindsightBankId: bankId,
    hindsightApiKeyEnv: null, hindsightTimeoutMs: 1000, requireApproval: false,
  } }));
  resetConfigCache();
}
function fixture(maxTrackingMs = 500) {
  const cwd = path.join(home, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const projectId = deriveProjectIdFromCwd(cwd)!;
  const target = { baseUrl: fake.url, bankId: "tracking", timeoutMs: 1000 };
  const scope = { ...target, projectId };
  const memory = { projectId, memoryId: manualMemoryId(projectId, "decision", "Use isolated test data."),
    kind: "decision", title: "Fixture decision", content: "Use isolated test data.", relatedPaths: [] };
  let sessionId = "tracking-session";
  const ctx = { cwd, hasUI: false, isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [{ id: "branch-head" }] },
    ui: { notify() {}, setStatus() {} } } as unknown as ExtensionContext;
  const events = createEventBus();
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const messages: Array<{ message: any; options: any }> = [];
  const delivered = Promise.withResolvers<void>();
  const tools = new Map<string, any>();
  const pi = { events,
    registerTool(definition: any) { tools.set(definition.name, definition); },
    getActiveTools: () => ["smart_save_memory", "smart_recall"],
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {};
    },
    sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); delivered.resolve(); },
  } as unknown as ExtensionAPI;
  registerCompactionDelivery(pi);
  const tracker = registerHindsightTracking(pi, { pollIntervalMs: 5, maxTrackingMs });
  const emit = async (name: string, event = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };
  cleanups.push(() => emit("session_shutdown"));
  const save = (content = memory.content) => saveHindsightMemory(target, { ...memory, content,
    memoryId: manualMemoryId(projectId, "decision", content) });
  return { pi, tools, ctx, target, scope, memory, events, tracker, emit, save, messages, delivered,
    switchSession() { sessionId = "new-session"; } };
}

async function waitUntil(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  expect(check()).toBe(true);
}

describe("background Hindsight tracking", () => {
  it("the actual save tool starts tracking without delaying its accepted result", async () => {
    const f = fixture();
    registerContextTools(f.pi);
    await f.emit("session_start");
    const result = await f.tools.get("smart_save_memory").execute("save", {
      kind: "decision", title: f.memory.title, content: f.memory.content,
    }, undefined, undefined, f.ctx);
    expect(result.details.remote.state).toBe("accepted");
    expect(result.details.backgroundTracking).toBe(true);
    expect(result.content[0].text).toContain("Background status tracking is active");
    expect(f.messages).toHaveLength(0);
    fake.operations.set(listReceipts(f.scope)[0].operationId, "completed");
    await f.delivered.promise;
    expect(f.messages[0].message.content).toContain("completed");
  }, 10000);

  it("reports completion once without another recall, retain or agent wake", async () => {
    const f = fixture();
    await f.emit("session_start");
    const outcome = await f.save();
    expect(outcome.state).toBe("accepted");
    expect(f.tracker.observe(outcome, f.ctx)).toBe(true);
    expect(f.tracker.observe(outcome, f.ctx)).toBe(true);
    expect(f.messages).toHaveLength(0);
    fake.operations.set(outcome.receipt!.operationId, "completed");
    await f.delivered.promise;
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].options).toEqual({ triggerTurn: false });
    expect(f.messages[0].message.content).toContain("completed");
    expect(f.messages[0].message.content).toContain("Ref: hindsight:");
    expect(listReceipts(f.scope)[0].state).toBe("completed");
    expect(fake.requests.filter(request => request.method === "POST")).toHaveLength(1);
  });

  it("does not flood a resumed session with separate notices for older project receipts", async () => {
    const f = fixture();
    for (const content of ["Older decision A", "Older decision B"]) {
      const outcome = await f.save(content);
      expect(outcome.state).toBe("accepted");
      fake.operations.set(outcome.receipt!.operationId, "completed");
    }
    await f.emit("session_start");
    await f.delivered.promise;
    expect(listReceipts(f.scope).filter(receipt => receipt.state === "completed")).toHaveLength(2);
    expect(fake.requests.filter(request => request.method === "POST")).toHaveLength(2);
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].message.details).toMatchObject({ state: "summary", resumed: true, total: 2,
      counts: { completed: 2, failed: 0, accepted: 0, unknown: 0 } });
    expect(f.messages[0].message.content).toContain("2 earlier submissions");
    expect(f.messages[0].message.content).not.toContain("Operation:");
    expect(f.messages[0].options).toEqual({ triggerTurn: false });
  });

  it("resumes open receipts for the same configured project on session start", async () => {
    const f = fixture();
    const outcome = await f.save();
    fake.operations.set(outcome.receipt!.operationId, "completed");
    await f.emit("session_start");
    await f.delivered.promise;
    expect(f.messages[0].message.content).toContain("completed");
    expect(fake.requests.filter(request => request.method === "POST")).toHaveLength(1);
  });

  it("waits for the whole resumed group instead of reporting each polling wave", async () => {
    const f = fixture();
    const first = await f.save("Earlier A");
    const second = await f.save("Earlier B");
    fake.operations.set(first.receipt!.operationId, "completed");
    await f.emit("session_start");
    await waitUntil(() => listReceipts(f.scope).some(receipt => receipt.state === "completed"));
    expect(f.messages).toHaveLength(0);
    fake.operations.set(second.receipt!.operationId, "completed");
    await f.delivered.promise;
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].message.details.counts.completed).toBe(2);
  });

  it("preserves mixed terminal and unconfirmed states in one bounded summary", async () => {
    const f = fixture(60);
    for (const state of ["completed", "failed", "pending", "missing"]) {
      const outcome = await f.save("Earlier " + state);
      if (state === "missing") fake.operations.delete(outcome.receipt!.operationId);
      else fake.operations.set(outcome.receipt!.operationId, state);
    }
    await f.emit("session_start");
    await f.delivered.promise;
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].message.details).toMatchObject({ total: 4,
      counts: { completed: 1, failed: 1, accepted: 1, unknown: 1 } });
    expect(f.messages[0].message.content).toContain("completion unconfirmed");
    expect(f.messages[0].message.content).toContain("smart_recall");
    expect(fake.requests.filter(request => request.method === "POST")).toHaveLength(4);
  });

  it("summarizes the bounded 32-record backlog once and only new remaining records on reload", async () => {
    const f = fixture(5000);
    for (let i = 0; i < 33; i++) {
      const outcome = await f.save("Earlier decision " + i);
      fake.operations.set(outcome.receipt!.operationId, "completed");
    }
    await f.emit("session_start");
    await f.delivered.promise;
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].message.details.total).toBe(32);
    expect(f.messages[0].message.details.counts.completed).toBe(32);
    await f.emit("session_start");
    await waitUntil(() => f.messages.length === 2);
    expect(f.messages[1].message.details.total).toBe(1);
    await f.emit("session_start");
    await Bun.sleep(20);
    expect(f.messages).toHaveLength(2);
    expect(fake.requests.filter(request => request.method === "POST")).toHaveLength(33);
  });

  it("keeps an explicitly observed save individual when it was already in the resumed group", async () => {
    const f = fixture();
    const outcome = await f.save();
    await f.emit("session_start");
    expect(f.tracker.observe(outcome, f.ctx)).toBe(true);
    fake.operations.set(outcome.receipt!.operationId, "completed");
    await f.delivered.promise;
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].message.details.state).toBe("completed");
    expect(f.messages[0].message.content).toContain("Ref: hindsight:");
  });

  it("queues the resumed summary behind compaction without delaying receipt persistence", async () => {
    const f = fixture();
    const outcome = await f.save();
    await f.emit("session_start");
    await f.emit("session_before_compact");
    const queued = Promise.withResolvers<void>();
    f.events.on("smart-compact:defer-delivery", (value: any) => { if (value.deferred) queued.resolve(); });
    fake.operations.set(outcome.receipt!.operationId, "completed");
    await queued.promise;
    expect(listReceipts(f.scope)[0].state).toBe("completed");
    expect(f.messages).toHaveLength(0);
    await f.emit("session_compact");
    await f.delivered.promise;
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].message.details.state).toBe("summary");
    expect(f.messages[0].options.triggerTurn).toBe(false);
  });

  it.each([false, true])("rechecks resolved receipts before a deferred summary (all resolved: %s)", async all => {
    const f = fixture();
    const first = await f.save("Earlier A");
    const second = await f.save("Earlier B");
    fake.operations.set(first.receipt!.operationId, "completed");
    fake.operations.set(second.receipt!.operationId, "completed");
    const held = Promise.withResolvers<() => void>();
    f.events.on("smart-compact:defer-delivery", (value: any) => { value.deferred = true; held.resolve(value.deliver); });
    await f.emit("session_start");
    const deliver = await held.promise;
    expect(f.messages).toHaveLength(0);
    updateReceiptState(first.receipt!.key, "deleted");
    if (all) updateReceiptState(second.receipt!.key, "deleted");
    deliver();
    deliver();
    expect(f.messages).toHaveLength(all ? 0 : 1);
    if (!all) expect(f.messages[0].message.details).toMatchObject({ total: 1, counts: { completed: 1 } });
  });

  it("does not include a replacement operation in an older deferred summary", async () => {
    const f = fixture();
    const first = await f.save("Earlier A");
    const second = await f.save("Earlier B");
    fake.operations.set(first.receipt!.operationId, "completed");
    fake.operations.set(second.receipt!.operationId, "completed");
    const held = Promise.withResolvers<() => void>();
    f.events.on("smart-compact:defer-delivery", (value: any) => { value.deferred = true; held.resolve(value.deliver); });
    await f.emit("session_start");
    const deliver = await held.promise;
    updateReceiptState(first.receipt!.key, "deleted");
    const replacement = await f.save("Earlier A");
    expect(replacement.state).toBe("accepted");
    expect(replacement.receipt!.operationId).not.toBe(first.receipt!.operationId);
    deliver();
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].message.details).toMatchObject({ total: 1, counts: { completed: 1, accepted: 0 } });
  });

  it.each(["shutdown", "switch", "retarget"])("drops a deferred resumed summary after %s", async action => {
    const f = fixture();
    const outcome = await f.save();
    fake.operations.set(outcome.receipt!.operationId, "completed");
    const held = Promise.withResolvers<() => void>();
    f.events.on("smart-compact:defer-delivery", (value: any) => { value.deferred = true; held.resolve(value.deliver); });
    await f.emit("session_start");
    const deliver = await held.promise;
    if (action === "shutdown") await f.emit("session_shutdown");
    else if (action === "switch") f.switchSession();
    else configure("other-bank");
    deliver();
    expect(f.messages).toHaveLength(0);
  });

  it("reports a terminal server failure without automatically retaining again", async () => {
    const f = fixture();
    await f.emit("session_start");
    const outcome = await f.save();
    f.tracker.observe(outcome, f.ctx);
    fake.operations.set(outcome.receipt!.operationId, "failed");
    await f.delivered.promise;
    expect(f.messages[0].message.content).toContain("FAILED");
    expect(listReceipts(f.scope)[0].state).toBe("failed");
    expect(fake.requests.filter(request => request.method === "POST")).toHaveLength(1);
  });

  it("bounds tracking but never turns a still-pending operation into a failure", async () => {
    const f = fixture(15);
    await f.emit("session_start");
    const outcome = await f.save();
    f.tracker.observe(outcome, f.ctx);
    await f.delivered.promise;
    expect(f.messages[0].message.content).toContain("NOT yet searchable");
    expect(f.messages[0].message.content).toContain("tracking stopped");
    expect(f.messages[0].message.content).not.toContain("FAILED");
    expect(listReceipts(f.scope)[0].state).toBe("accepted");
  });

  it("keeps known acceptance distinct from an unavailable completion status", async () => {
    const f = fixture(50);
    await f.emit("session_start");
    const outcome = await f.save();
    fake.failNext.set("GET operations/:id", -2);
    f.tracker.observe(outcome, f.ctx);
    await f.delivered.promise;
    expect(f.messages[0].message.details.state).toBe("accepted");
    expect(f.messages[0].message.content).toContain("Last observed memory state");
    expect(f.messages[0].message.content).toContain("Last status check failed");
    expect(listReceipts(f.scope)[0].state).toBe("accepted");
  });

  it("queues completion during compaction without delaying receipt persistence", async () => {
    const f = fixture();
    await f.emit("session_start");
    await f.emit("session_before_compact");
    const queued = Promise.withResolvers<void>();
    f.events.on("smart-compact:defer-delivery", (value: any) => { if (value.deferred) queued.resolve(); });
    const outcome = await f.save();
    f.tracker.observe(outcome, f.ctx);
    fake.operations.set(outcome.receipt!.operationId, "completed");
    await queued.promise;
    expect(listReceipts(f.scope)[0].state).toBe("completed");
    expect(f.messages).toHaveLength(0);
    await f.emit("session_compact");
    await f.delivered.promise;
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].options.triggerTurn).toBe(false);
  });

  it.each(["shutdown", "switch", "retarget"])("never delivers a queued completion after %s", async action => {
    const f = fixture();
    await f.emit("session_start");
    const held = Promise.withResolvers<() => void>();
    f.events.on("smart-compact:defer-delivery", (value: any) => { value.deferred = true; held.resolve(value.deliver); });
    const outcome = await f.save();
    f.tracker.observe(outcome, f.ctx);
    fake.operations.set(outcome.receipt!.operationId, "completed");
    const deliver = await held.promise;
    if (action === "shutdown") await f.emit("session_shutdown");
    else if (action === "switch") f.switchSession();
    else configure("other-bank");
    deliver();
    expect(f.messages).toHaveLength(0);
  });

  it("aborts in-flight status checks on shutdown", async () => {
    const f = fixture();
    await f.emit("session_start");
    const outcome = await f.save();
    const checking = Promise.withResolvers<void>();
    fake.beforeNext.set("GET operations/:id", () => { fake.failNext.set("GET operations/:id", -2); checking.resolve(); });
    f.tracker.observe(outcome, f.ctx);
    await checking.promise;
    await f.emit("session_shutdown");
    expect(f.messages).toHaveLength(0);
  });

  it("a repeated save cannot undo a resolve that wins during its status check", async () => {
    const f = fixture();
    const outcome = await f.save();
    const receipt = outcome.receipt!;
    fake.operations.set(receipt.operationId, "completed");
    fake.beforeNext.set("GET operations/:id", () => { updateReceiptState(receipt.key, "deleted"); });
    const repeated = await f.save();
    expect(repeated.state).toBe("failed");
    expect("reason" in repeated && repeated.reason).toContain("resolved while checking status");
    expect(listReceipts(f.scope)[0].state).toBe("deleted");
    expect(fake.requests.filter(request => request.method === "POST")).toHaveLength(1);
  });

  it("a late status response cannot resurrect a receipt deleted during the check", async () => {
    const f = fixture();
    const outcome = await f.save();
    const receipt = outcome.receipt!;
    fake.operations.set(receipt.operationId, "completed");
    fake.beforeNext.set("GET operations/:id", () => { updateReceiptState(receipt.key, "deleted"); });
    expect((await refreshReceipt(f.target, receipt)).state).toBe("deleted");
    expect(listReceipts(f.scope)[0].state).toBe("deleted");
  });
});
