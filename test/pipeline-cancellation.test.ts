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
