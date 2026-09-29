import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { runSmartCompact, type ExternalCancellation } from "../src/app/run-smart-compact.ts";
import { createPendingSlot } from "../src/app/pending-slot.ts";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { resetLlmClient, setLlmClient } from "../src/infra/llm-client.ts";
import { readMetricsLog } from "../src/utils/cache.ts";
import { resetConfigCache } from "../src/utils/config.ts";

const originalHome = process.env.HOME;
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-cancellation-"));
  process.env.HOME = home;
  resetConfigCache();
});
afterEach(() => {
  resetLlmClient();
  process.env.HOME = originalHome;
  resetConfigCache();
  fs.rmSync(home, { recursive: true, force: true });
});

const model = { id: "cancellation", provider: "openai", api: "openai-responses", contextWindow: 100_000, maxTokens: 8_192 } as Model<Api>;

describe("auth-wait cancellation (A10)", () => {
  it.each([
    { source: "host" as const },
    { source: "timeout" as const },
  ])(
    "settles the run and frees the lock when $source abort lands during deferred auth",
    async ({ source }) => {
      const manager = SessionManager.inMemory(home);
      for (let i = 0; i < 12; i++) {
        manager.appendMessage({ role: "user", content: "Preserve cancellation evidence. " + "Detail about this task. ".repeat(600), timestamp: i * 2 });
        manager.appendMessage({
          role: "assistant", content: [{ type: "text", text: "Recorded evidence. ".repeat(600) }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: i * 2 + 1,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
        });
      }
      const before = manager.getBranch();
      let releaseAuth!: (value: { ok: true; apiKey: string }) => void;
      let authStarted!: () => void;
      const started = new Promise<void>((resolve) => { authStarted = resolve; });
      const pendingAuth = new Promise<{ ok: true; apiKey: string }>((resolve) => { releaseAuth = resolve; });
      let authCalls = 0;
      let providerCalls = 0;
      let applies = 0;
      const host = new AbortController();
      const cancellationOut: { value: ExternalCancellation | null } = { value: null };
      setLlmClient({
        complete: async () => {
          providerCalls++;
          throw new Error("Provider must not be reached");
        },
      });
      const ctx = {
        cwd: home, hasUI: false, model, sessionManager: manager,
        ui: { notify() { }, setWidget() { }, setStatus() { } },
        modelRegistry: {
          getApiKeyAndHeaders: async () => {
            authCalls++;
            authStarted();
            return pendingAuth;
          },
        },
        getContextUsage: () => ({ tokens: 75_000, contextWindow: 100_000, percent: 75 }),
        compact: () => { applies++; },
      } as unknown as ExtensionContext;
      const pendingRef = createPendingSlot({ ttlMs: 60_000 });
      const isRunning = { value: false };
      let settled = false;
      const running = runSmartCompact({
        ctx, summaryModel: model, segModel: model, mode: "fast", dryRun: true,
        config: { ...DEFAULT_CONFIG, mode: "fast", minContextPercent: 0, zeroCallEnabled: false, requireApproval: false, backupEnabled: false, contextGraphEnabled: false },
        pendingRef, isRunning, cancellationOut, abortSignal: host.signal,
      }).then((outcome) => { settled = true; return outcome; });

      await started;
      if (source === "host") host.abort();
      else cancellationOut.value!.abort();
      await new Promise((resolve) => setTimeout(resolve, 30));
      // The abort must settle the whole run promptly: no held lock, no
      // staging, no provider call — even while the registry is still pending.
      expect(settled).toBe(true);
      expect(isRunning.value).toBe(false);
      expect(pendingRef.isPresent()).toBe(false);
      expect(providerCalls).toBe(0);
      expect(applies).toBe(0);
      // Exactly one registry call was in flight when the abort landed.
      expect(authCalls).toBe(1);

      releaseAuth({ ok: true, apiKey: "late-auth" });
      const outcome = await running;
      expect(outcome).toEqual({ kind: "cancelled", source });
      // The late resolution is not applied and the conversation is untouched.
      expect(applies).toBe(0);
      expect(manager.getBranch()).toEqual(before);
    },
  );

  it("consumes a registry rejection that races a synchronous abort without unhandled rejections (A10)", async () => {
    const manager = SessionManager.inMemory(home);
    for (let i = 0; i < 12; i++) {
      manager.appendMessage({ role: "user", content: "Preserve cancellation evidence. " + "Detail about this task. ".repeat(600), timestamp: i * 2 });
      manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "Recorded evidence. ".repeat(600) }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: i * 2 + 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      });
    }
    const host = new AbortController();
    const cancellationOut: { value: ExternalCancellation | null } = { value: null };
    let providerCalls = 0;
    setLlmClient({
      complete: async () => {
        providerCalls++;
        throw new Error("Provider must not be reached");
      },
    });
    const ctx = {
      cwd: home, hasUI: false, model, sessionManager: manager,
      ui: { notify() { }, setWidget() { }, setStatus() { } },
      // The registry call synchronously aborts the host controller and then
      // rejects: both the race and the rejected promise must be consumed.
      modelRegistry: {
        getApiKeyAndHeaders: async () => {
          host.abort();
          return Promise.reject(new Error("registry aborted"));
        },
      },
      getContextUsage: () => ({ tokens: 75_000, contextWindow: 100_000, percent: 75 }),
      compact: () => { },
    } as unknown as ExtensionContext;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let outcome: Awaited<ReturnType<typeof runSmartCompact>>;
    try {
      outcome = await runSmartCompact({
        ctx, summaryModel: model, segModel: model, mode: "fast", dryRun: true,
        config: { ...DEFAULT_CONFIG, mode: "fast", minContextPercent: 0, zeroCallEnabled: false, requireApproval: false, backupEnabled: false, contextGraphEnabled: false },
        pendingRef: createPendingSlot({ ttlMs: 60_000 }), isRunning: { value: false },
        cancellationOut, abortSignal: host.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(outcome).toEqual({ kind: "cancelled", source: "host" });
    expect(providerCalls).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it("does not ask the auth registry at all when the run is already aborted (A10)", async () => {
    const manager = SessionManager.inMemory(home);
    let authCalls = 0;
    const host = new AbortController();
    host.abort();
    const ctx = {
      cwd: home, hasUI: false, model, sessionManager: manager,
      ui: { notify() { }, setWidget() { }, setStatus() { } },
      modelRegistry: { getApiKeyAndHeaders: async () => { authCalls++; return { ok: true, apiKey: "offline" }; } },
      getContextUsage: () => ({ tokens: 75_000, contextWindow: 100_000, percent: 75 }),
      compact: () => { },
    } as unknown as ExtensionContext;
    const result = await runSmartCompact({
      ctx, summaryModel: model, segModel: model, mode: "fast", dryRun: true,
      config: { ...DEFAULT_CONFIG, mode: "fast", minContextPercent: 0, zeroCallEnabled: false, requireApproval: false, backupEnabled: false, contextGraphEnabled: false },
      pendingRef: createPendingSlot({ ttlMs: 60_000 }), isRunning: { value: false },
      abortSignal: host.signal,
    });
    expect(result).toEqual({ kind: "cancelled", source: "host" });
    expect(authCalls).toBe(0);
  });
});

describe("cancelled pipeline outcomes", () => {
  it.each([
    { source: "timeout", dryRun: true, status: "timeout" },
    { source: "host", dryRun: false, status: "cancelled" },
  ] as const)("does not apply or report success after $source (dryRun=$dryRun)", async ({ source, dryRun, status }) => {
    const manager = SessionManager.inMemory(home);
    for (let i = 0; i < 12; i++) {
      manager.appendMessage({ role: "user", content: "Preserve cancellation evidence. " + "Detail about this task. ".repeat(600), timestamp: i * 2 });
      manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "Recorded evidence. ".repeat(600) }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: i * 2 + 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      });
    }
    const before = manager.getBranch();
    let applyCalls = 0;
    let providerCalls = 0;
    const hostCancellation = new AbortController();
    const cancellationOut: { value: ExternalCancellation | null } = { value: null };
    setLlmClient({
      complete: async () => {
        providerCalls++;
        if (source === "host") hostCancellation.abort();
        else cancellationOut.value!.abort();
        throw new DOMException("Compaction cancelled", "AbortError");
      }
    });
    const ctx = {
      cwd: home, hasUI: false, model, sessionManager: manager,
      ui: { notify() { }, setWidget() { }, setStatus() { } },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-fixture" }) },
      getContextUsage: () => ({ tokens: 75_000, contextWindow: 100_000, percent: 75 }),
      compact: () => { applyCalls++; },
    } as unknown as ExtensionContext;
    const pendingRef = createPendingSlot({ ttlMs: 60_000 });
    const isRunning = { value: false };
    const result = await runSmartCompact({
      ctx, summaryModel: model, segModel: model, mode: "fast", dryRun,
      config: { ...DEFAULT_CONFIG, mode: "fast", minContextPercent: 0, zeroCallEnabled: false, requireApproval: false, backupEnabled: false, contextGraphEnabled: false },
      pendingRef, isRunning, cancellationOut, abortSignal: hostCancellation.signal,
    });
    expect(providerCalls).toBe(1);
    expect(result).toEqual({ kind: "cancelled", source });
    expect(applyCalls).toBe(0);
    expect(pendingRef.isPresent()).toBe(false);
    expect(isRunning.value).toBe(false);
    expect(manager.getBranch()).toEqual(before);
    const metrics = readMetricsLog();
    expect(metrics.map(entry => ({ status: entry.status, failureKind: entry.failureKind }))).toEqual([{ status, failureKind: source === "host" ? "cancelled" : "timeout" }]);
  });
});
