import { expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerCompactionDelivery } from "../src/app/compaction-delivery.ts";
import { createPendingSlot } from "../src/app/pending-slot.ts";
import { createSettledAutoTrigger } from "../src/app/settled-auto-trigger.ts";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { resetLlmClient, setLlmClient } from "../src/infra/llm-client.ts";

async function fixture(cancel = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psc-delivery-"));
  const authPath = path.join(root, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "SYNTHETIC-NO-REQUEST" } }));
  const runtime = await ModelRuntime.create({ authPath, modelsPath: path.join(root, "models.json"),
    modelsStorePath: path.join(root, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
  const model = { ...runtime.getModel("anthropic", "claude-opus-5-5")!, baseUrl: "http://127.0.0.1:1", contextWindow: 200_000 };
  const assistant = (text: string): AssistantMessage => ({ role: "assistant", api: model.api, provider: model.provider,
    model: model.id, content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1000 },
    retry: { enabled: false }, cacheWarming: "off" });
  const manager = SessionManager.inMemory(root);
  for (let i = 0; i < 12; i++) {
    manager.appendMessage({ role: "user", content: "Preserve task evidence. " + "Detail about this task. ".repeat(600), timestamp: i * 2 });
    const message = assistant("Recorded evidence. ".repeat(600));
    manager.appendMessage({ ...message, usage: { ...message.usage, input: 75_000, totalTokens: 75_005 } });
  }
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const errors: unknown[] = [];
  let api!: ExtensionAPI;
  let ctx!: ExtensionContext;
  let delivery!: ReturnType<typeof registerCompactionDelivery>;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      api = pi;
      delivery = registerCompactionDelivery(pi);
      pi.on("session_start", (_event, context) => { ctx = context; });
      pi.on("session_before_compact", async event => {
        entered.resolve();
        await finish.promise;
        if (cancel) return { cancel: true };
        return { compaction: { summary: "Preserved task evidence; continue the current task.",
          firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
      });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
    settingsManager: settings, resourceLoader: loader, sessionManager: manager, thinkingLevel: "off" });
  await session.bindExtensions({ onError: error => errors.push(error) });
  const requests: Message[][] = [];
  let starts = 0;
  session.subscribe(event => {
    if (event.type === "agent_start") starts++;
    if (event.type === "agent_settled") settled.resolve();
  });
  session.agent.streamFunction = (_model, context) => {
    requests.push(structuredClone(context.messages));
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: assistant("Completed offline work.") });
    stream.end();
    return stream;
  };
  const enqueue = (kind: "agm" | "process" | "context") => {
    const request = { version: 1, sessionId: manager.getSessionId(), deferred: false,
      deliver: () => {
        const message = { customType: "fixture-" + kind, content: kind + "-queued-evidence", display: true };
        if (kind === "process" && ctx.isIdle()) {
          api.sendMessage(message, { triggerTurn: false });
          api.sendUserMessage("", { deliverAs: "steer" });
        } else api.sendMessage(message, kind === "context" ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "steer" });
      } };
    api.events.emit("smart-compact:defer-delivery", request);
    expect(request.deferred).toBe(true);
  };
  return { root, session, manager, model, assistant, ctx, delivery, entered, finish, settled, enqueue, requests, errors,
    starts: () => starts, setCancelled: (value: boolean) => { cancel = value; },
    cleanup: () => { session.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
}

it.each(["agm", "process"] as const)("delivers a mixed burst once and preserves passive context without forcing a turn (%s first)", async first => {
  const f = await fixture();
  try {
    const compact = f.session.compact();
    await f.entered.promise;
    const leaf = f.manager.getLeafId();
    f.enqueue(first);
    f.enqueue("context");
    f.enqueue(first === "agm" ? "process" : "agm");
    expect(f.manager.getLeafId()).toBe(leaf);
    expect(f.starts()).toBe(0);
    f.finish.resolve();
    await compact;
    await f.settled.promise;
    await f.session.waitForIdle();
    expect(f.starts()).toBe(1);
    for (const kind of ["agm", "process", "context"]) {
      expect(f.manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "fixture-" + kind)).toHaveLength(1);
    }
    for (const kind of ["agm", "process"]) expect(JSON.stringify(f.requests)).toContain(kind + "-queued-evidence");
    // Pi can flush passive context after the first request; it must survive for the next one without an extra wake.
    await f.session.prompt("Continue with all recorded evidence.");
    expect(f.starts()).toBe(2);
    for (const kind of ["agm", "process", "context"]) expect(JSON.stringify(f.requests.at(-1))).toContain(kind + "-queued-evidence");
    expect(f.errors).toEqual([]);
  } finally { f.cleanup(); }
});

it("preserves mail across real compaction cancellation without waking until the next user prompt", async () => {
  const f = await fixture(true);
  try {
    const compact = f.session.compact();
    await f.entered.promise;
    f.enqueue("agm");
    f.finish.resolve();
    const failure = await compact.catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Compaction cancelled");
    expect(f.starts()).toBe(0);
    await f.session.prompt("Continue the original task after cancellation.");
    expect(f.starts()).toBe(1);
    expect(JSON.stringify(f.requests)).toContain("agm-queued-evidence");
    expect(JSON.stringify(f.requests)).toContain("Continue the original task after cancellation.");
    expect(f.errors).toEqual([]);
  } finally { f.cleanup(); }
});

it("resumes queued mail after a real cancelled compaction is retried successfully", async () => {
  const f = await fixture(true);
  try {
    const compact = f.session.compact();
    await f.entered.promise;
    f.enqueue("agm");
    f.finish.resolve();
    expect(await compact.catch((error: Error) => error)).toBeInstanceOf(Error);
    expect(f.starts()).toBe(0);
    f.setCancelled(false);
    await f.session.compact();
    await f.settled.promise;
    expect(f.starts()).toBe(1);
    expect(JSON.stringify(f.requests)).toContain("agm-queued-evidence");
    expect(f.errors).toEqual([]);
  } finally { f.cleanup(); }
});

it("recovers after a real host finishes without its completion callback, never while busy", async () => {
  const f = await fixture();
  try {
    const ctx: ExtensionContext = Object.create(f.ctx);
    ctx.getContextUsage = () => ({ tokens: 190_000, contextWindow: 200_000, percent: 95 });
    ctx.compact = options => f.ctx.compact({ ...options, onComplete() {}, onError() {} });
    const trigger = createSettledAutoTrigger({ compact: f.delivery.compact, watchdogMs: 10 });
    const request = trigger.request(ctx, { ...DEFAULT_CONFIG, autoTrigger: true, autoTriggerStrategy: "settled" });
    await f.entered.promise;
    f.enqueue("process");
    await request;
    expect(f.session.isCompacting).toBe(true);
    expect(f.starts()).toBe(0);
    f.finish.resolve();
    await f.settled.promise;
    expect(f.starts()).toBe(1);
    expect(JSON.stringify(f.requests)).toContain("process-queued-evidence");
    expect(f.errors).toEqual([]);
  } finally { f.cleanup(); }
});

it("holds foreground EESV preparation through the real host apply callback", async () => {
  const oldHome = process.env.HOME;
  const f = await fixture();
  process.env.HOME = f.root;
  const summaryStarted = Promise.withResolvers<void>();
  const finishSummary = Promise.withResolvers<void>();
  setLlmClient({ complete: async () => {
    summaryStarted.resolve();
    await finishSummary.promise;
    return f.assistant("## Goal\nPreserve task evidence.\n## Progress\nRecorded evidence.\n## Next Steps\nContinue the current task.");
  } });
  try {
    const running = f.delivery.runManual({ ctx: f.ctx, summaryModel: f.model, segModel: f.model, mode: "fast", force: true,
      pendingRef: createPendingSlot({ ttlMs: 60_000 }), isRunning: { value: false },
      config: { ...DEFAULT_CONFIG, minContextPercent: 0, zeroCallEnabled: false, requireApproval: false,
        backupEnabled: false, contextGraphEnabled: false } });
    await Promise.race([summaryStarted.promise, running.then(outcome => { throw new Error("Preparation skipped: " + outcome.kind); })]);
    expect(f.session.isIdle).toBe(true);
    f.enqueue("agm");
    expect(f.starts()).toBe(0);
    finishSummary.resolve();
    expect((await running).kind).toBe("apply-requested");
    await f.entered.promise;
    expect(f.starts()).toBe(0);
    f.enqueue("process");
    f.finish.resolve();
    await f.settled.promise;
    expect(f.starts()).toBe(1);
    expect(JSON.stringify(f.requests)).toContain("agm-queued-evidence");
    expect(JSON.stringify(f.requests)).toContain("process-queued-evidence");
    expect(f.errors).toEqual([]);
  } finally {
    resetLlmClient();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    f.cleanup();
  }
});
