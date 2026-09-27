import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMetricsLog } from "../src/utils/cache.ts";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { createBackgroundPreparation, preparationStartTokens, preparationWindow } from "../src/app/background-preparation.ts";
import { createSettledAutoTrigger } from "../src/app/settled-auto-trigger.ts";
import { MIN_TOKEN_THRESHOLD } from "../src/constants.ts";
import { fingerprintContext, pendingMatchesBranch, readerSignature } from "../src/app/pending-slot.ts";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";
import type { CompactConfig, PendingCompaction } from "../src/types.ts";

const config: CompactConfig = { ...DEFAULT_CONFIG, autoTrigger: true, autoTriggerStrategy: "background", minContextPercent: 80 };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: "user", content: "Preserve exact facts", timestamp: 1 });
  const last = manager.appendMessage({ role: "user", content: "Keep this recent turn", timestamp: 2 });
  const status: Array<string | undefined> = [];
  let tokens = 140_000;
  const ctx = {
    model: { provider: "openai", id: "test", contextWindow: 200_000, maxTokens: 8_192 },
    sessionManager: manager,
    getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: tokens / 2_000 }),
    hasUI: true, isIdle: () => false,
    ui: { setStatus: (_key: string, value?: string) => status.push(value) },
  } as unknown as ExtensionContext;
  const pending = {
    runId: "prepared-run", sessionId: manager.getSessionId(), originBranchHeadId: last,
    firstKeptEntryId: last, tokensBefore: tokens, summary: "Verified facts",
    contextSnapshot: fingerprintContext(contextMessageEntries(manager.getBranch())),
    readerSignature: readerSignature(ctx),
    details: { estimatedAfterTokens: 30_000, retainedTailTokens: 20_000 },
  } as PendingCompaction;
  return { ctx, manager, pending, first, status, setTokens: (value: number) => { tokens = value; } };
}

describe("background preparation", () => {
  it("derives bounded lead tokens and leaves existing strategies unchanged", async () => {
    expect(preparationStartTokens(160_000)).toBe(140_000);
    expect(preparationStartTokens(1_000_000)).toBe(968_000);
    expect(preparationStartTokens(32_000)).toBe(23_808);
    const f = fixture();
    let calls = 0;
    const worker = createBackgroundPreparation({ prepare: async () => { calls++; return f.pending; } });
    for (const other of [DEFAULT_CONFIG, { ...config, autoTrigger: false }]) worker.observe(f.ctx, other);
    f.setTokens(139_999);
    worker.observe(f.ctx, config);
    f.setTokens(160_000);
    worker.observe(f.ctx, config);
    await flush();
    expect(calls).toBe(0);
  });

  it("does not block, snapshots once, preserves appended tail, and adjusts apply accounting", async () => {
    const f = fixture();
    let resolve!: (pending: PendingCompaction) => void;
    let captured!: ExtensionContext;
    let calls = 0;
    const worker = createBackgroundPreparation({
      prepare: async (ctx, lowered) => {
        calls++;
        captured = ctx;
        expect(lowered.minContextPercent).toBe(70);
        expect(ctx.hasUI).toBe(false);
        return new Promise<PendingCompaction>(done => { resolve = done; });
      },
    });
    expect(worker.observe(f.ctx, config)).toBeUndefined();
    worker.observe(f.ctx, config);
    await flush();
    expect(calls).toBe(1);
    f.manager.appendMessage({ role: "user", content: "NEW_TAIL_MUST_SURVIVE", timestamp: 3 });
    f.setTokens(160_000);
    expect(captured.sessionManager.getBranch()).toHaveLength(2);
    expect(captured.getContextUsage()?.tokens).toBe(140_000);
    resolve(f.pending);
    await flush();
    worker.observe(f.ctx, config);
    const result = worker.take(f.ctx, config);
    expect(calls).toBe(1);
    expect(result?.firstKeptEntryId).toBe(f.pending.firstKeptEntryId);
    expect(result?.tokensBefore).toBe(160_000);
    expect(result?.details.estimatedAfterTokens).toBe(50_000);
    expect(result?.details.retainedTailTokens).toBe(40_000);
    expect(result?.details.tokensSaved).toBe(110_000);
    expect(worker.take(f.ctx, config)).toBeNull();
    // Background preparation never writes footer status while healthy.
    expect(f.status).toEqual([]);
  });

  it.each(["edit", "compaction", "branch", "session", "model", "config", "disabled"])("discards a ready snapshot after %s changes", async kind => {
    const f = fixture();
    const worker = createBackgroundPreparation({ prepare: async () => f.pending });
    worker.observe(f.ctx, config);
    await flush();
    let currentConfig = config;
    if (kind === "edit") f.manager.appendContextEdit(f.first, { content: "Changed intent" });
    if (kind === "compaction") f.manager.appendCompaction("Different summary", f.pending.firstKeptEntryId, 140_000);
    if (kind === "branch") f.manager.branch(f.first);
    if (kind === "session") f.ctx.sessionManager = SessionManager.inMemory();
    if (kind === "model") f.ctx.model = { ...f.ctx.model!, id: "different" };
    if (kind === "config") currentConfig = { ...config, scrubPii: !config.scrubPii };
    if (kind === "disabled") currentConfig = { ...config, autoTrigger: false };
    expect(worker.take(f.ctx, currentConfig)).toBeNull();
  });

  it("aborts unfinished work at native apply and ignores a provider's late completion", async () => {
    const f = fixture();
    let resolve!: (pending: PendingCompaction) => void;
    let signal!: AbortSignal;
    let calls = 0;
    const worker = createBackgroundPreparation({
      prepare: async (_ctx, _config, abort) => {
        calls++;
        signal = abort;
        return new Promise<PendingCompaction>(done => { resolve = done; });
      }
    });
    worker.observe(f.ctx, config);
    await flush();
    expect(worker.take(f.ctx, config)).toBeNull();
    expect(signal.aborted).toBe(true);
    resolve(f.pending);
    await flush();
    expect(worker.take(f.ctx, config)).toBeNull();
    worker.observe(f.ctx, config);
    await flush();
    expect(calls).toBe(1);
  });

  it("expires ready work and throttles retries after failure or confirmed compaction", async () => {
    const f = fixture();
    let now = 0;
    let calls = 0;
    const worker = createBackgroundPreparation({
      now: () => now, ttlMs: 100, cooldownMs: 1_000, prepare: async () => {
        calls++;
        if (calls === 2) throw new Error("synthetic provider failure");
        return f.pending;
      }
    });
    worker.observe(f.ctx, config);
    await flush();
    now = 101;
    expect(worker.take(f.ctx, config)).toBeNull();
    worker.observe(f.ctx, config);
    expect(calls).toBe(1);
    now = 1_001;
    worker.observe(f.ctx, config);
    await flush();
    expect(worker.take(f.ctx, config)).toBeNull();
    worker.observe(f.ctx, config);
    await flush();
    expect(calls).toBe(2);
    now = 3_000;
    worker.noteCompaction(f.manager.getSessionId());
    worker.observe(f.ctx, config);
    await flush();
    expect(calls).toBe(2);
  });

  it("refuses reuse when appended context leaves insufficient response headroom", async () => {
    const f = fixture();
    const worker = createBackgroundPreparation({ prepare: async () => f.pending });
    worker.observe(f.ctx, config);
    await flush();
    f.setTokens(310_000);
    expect(worker.take(f.ctx, config)).toBeNull();
  });

  it("keeps the verified target and minimum yield gates when the tail grows", async () => {
    const f = fixture();
    f.pending.details.targetAfterTokens = 40_000;
    const worker = createBackgroundPreparation({ prepare: async () => f.pending });
    worker.observe(f.ctx, config);
    await flush();
    f.setTokens(160_000); // would retain 50k: enough window space, but misses the verified target
    expect(worker.take(f.ctx, config)).toBeNull();
  });

  it("uses an explicit prepare percentage and keeps minContextPercent as the apply gate", () => {
    const explicit = { ...config, minContextPercent: 65, prepareContextPercent: 60 };
    expect(preparationWindow(explicit, 200_000)).toEqual({ startTokens: 120_000, applyTokens: 130_000 });
    // null (default) keeps the adaptive lead exactly.
    expect(preparationWindow({ ...config, prepareContextPercent: null }, 200_000))
      .toEqual({ startTokens: preparationStartTokens(160_000), applyTokens: 160_000 });
    // The minimum-token safety floor still applies to explicit percentages.
    expect(preparationWindow({ ...config, minContextPercent: 70, prepareContextPercent: 1 }, 200_000).startTokens)
      .toBe(MIN_TOKEN_THRESHOLD);
    // Unvalidated runtime values at/above the apply gate fall back to Auto, like config validation.
    for (const invalid of [65, 80, Number.NaN, -1]) {
      expect(preparationWindow({ ...explicit, prepareContextPercent: invalid }, 200_000))
        .toEqual({ startTokens: preparationStartTokens(130_000), applyTokens: 130_000 });
    }
  });

  it("starts preparing only inside [prepare, apply) for explicit thresholds", async () => {
    const f = fixture();
    const explicit = { ...config, minContextPercent: 65, prepareContextPercent: 60 };
    const lowered: number[] = [];
    const worker = createBackgroundPreparation({ prepare: async (_ctx, c) => { lowered.push(c.minContextPercent); return f.pending; } });
    f.setTokens(119_999);
    worker.observe(f.ctx, explicit);
    f.setTokens(130_000); // at the apply gate: native apply owns it, no speculative start
    worker.observe(f.ctx, explicit);
    await flush();
    expect(lowered).toEqual([]);
    f.setTokens(120_000);
    worker.observe(f.ctx, explicit);
    await flush();
    expect(lowered).toEqual([60]);
  });

  it("sizes the preparation window from maxContextTokens on a larger model window", async () => {
    const f = fixture();
    Object.assign(f.ctx, { model: { ...f.ctx.model!, contextWindow: 1_000_000 } });
    const lowered: number[] = [];
    const worker = createBackgroundPreparation({ prepare: async (_ctx, c) => { lowered.push(c.minContextPercent); return f.pending; } });
    f.setTokens(150_000);
    worker.observe(f.ctx, config); // 15% of 1M: below the uncapped start
    await flush();
    expect(lowered).toEqual([]);
    // Cap 200k: apply at 160k (80%), adaptive start 140k (70% of the cap).
    expect(preparationWindow(config, 200_000)).toEqual({ startTokens: 140_000, applyTokens: 160_000 });
    worker.observe(f.ctx, { ...config, maxContextTokens: 200_000 });
    await flush();
    expect(lowered).toEqual([70]);
  });

  it("runtime proof: prepares at 60%, applies the same pending at 65% through the idle trigger", async () => {
    const f = fixture();
    const explicit = { ...config, minContextPercent: 65, prepareContextPercent: 60 };
    let prepares = 0;
    const worker = createBackgroundPreparation({ prepare: async () => { prepares++; return f.pending; } });
    const applied: Array<PendingCompaction | null> = [];
    (f.ctx as any).isIdle = () => true;
    (f.ctx as any).hasPendingMessages = () => false;
    (f.ctx as any).compact = (callbacks: { onComplete(): void }) => {
      applied.push(worker.take(f.ctx, explicit)); // what session_before_compact does
      callbacks.onComplete();
    };
    const settled = createSettledAutoTrigger();
    f.setTokens(120_000); // 60%
    worker.observe(f.ctx, explicit);
    await settled.request(f.ctx, explicit);
    await flush();
    expect(applied).toEqual([]); // below the 65% apply gate: nothing applied
    f.manager.appendMessage({ role: "user", content: "More work", timestamp: 3 });
    f.setTokens(130_000); // 65%
    worker.observe(f.ctx, explicit);
    await settled.request(f.ctx, explicit);
    expect(prepares).toBe(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.runId).toBe("prepared-run");
    expect(applied[0]?.tokensBefore).toBe(130_000);
  });

  it("checks content fingerprints even when original entry IDs still exist", () => {
    const f = fixture();
    expect(pendingMatchesBranch(f.pending, f.manager.getBranch())).toBe(true);
    f.manager.appendContextEdit(f.first, { content: "Same ID, different facts" });
    expect(pendingMatchesBranch(f.pending, f.manager.getBranch())).toBe(false);
  });

  it("records discarded preparation cost once, by reason, and reports status per session", async () => {
    const f = fixture();
    let now = 0;
    const discards: Array<{ sessionId: string; reason: string }> = [];
    const pendingWithCost = {
      ...f.pending,
      metricsSnapshot: {
        runId: f.pending.runId, metricsSchemaVersion: 2 as const, version: "9.8.0",
        releaseChannel: "canary" as const, totalCalls: 2, totalInput: 1_000, totalOutput: 300,
        totalCacheHit: 200, avgLatency: 10, cacheHitRate: 0, status: "success" as const,
      },
    };
    const worker = createBackgroundPreparation({
      now: () => now, ttlMs: 100, cooldownMs: 0,
      prepare: async () => pendingWithCost,
      discardRecorder: (sessionId, _snapshot, reason) => {
        discards.push({ sessionId, reason });
      },
    });
    expect(worker.status(f.manager.getSessionId())).toBe("idle");
    expect(worker.status("other-session")).toBe("idle");
    worker.observe(f.ctx, config);
    expect(worker.status(f.manager.getSessionId())).toBe("preparing");
    expect(worker.status("other-session")).toBe("idle");
    await flush();
    expect(worker.status(f.manager.getSessionId())).toBe("ready");
    // TTL expiry discards the ready work with its cost, exactly once.
    now = 101;
    expect(worker.take(f.ctx, config)).toBeNull();
    expect(discards).toEqual([
      { sessionId: f.manager.getSessionId(), reason: "ttl" },
    ]);
    expect(worker.status(f.manager.getSessionId())).toBe("idle");
  });

  it("stamps reused preparation on handoff and records an unused handoff once", async () => {
    const f = fixture();
    const discards: string[] = [];
    let now = 0;
    const pendingWithCost = {
      ...f.pending,
      metricsSnapshot: {
        runId: f.pending.runId, metricsSchemaVersion: 2 as const, version: "9.8.0",
        releaseChannel: "stable" as const, totalCalls: 1, totalInput: 500, totalOutput: 100,
        totalCacheHit: 0, avgLatency: 5, cacheHitRate: 0, status: "success" as const,
      },
    };
    const worker = createBackgroundPreparation({
      now: () => now,
      prepare: async () => { now = 25; return pendingWithCost; },
      discardRecorder: (_sessionId, _snapshot, reason) => { discards.push(reason); },
    });
    worker.observe(f.ctx, config);
    await flush();
    now = 100;
    const taken = worker.take(f.ctx, config);
    expect(taken).not.toBeNull();
    expect(taken!.metricsSnapshot?.preparation).toBe("background");
    expect(taken!.metricsSnapshot?.preparationReadyMs).toBe(25);
    expect(taken!.metricsSnapshot?.preparationWaitMs).toBe(75);
    expect(discards).toEqual([]);
    // The caller dropped the taken candidate (a foreground pending won).
    worker.noteHandoffUnused(taken!.runId, "superseded");
    worker.noteHandoffUnused(taken!.runId, "superseded");
    expect(discards).toEqual(["superseded"]);
  });

  it.each(["ready", "finishing-after-cancel"] as const)("persists unused work once before shutdown returns: %s", async timing => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-background-shutdown-"));
    const previousHome = process.env.HOME;
    const f = fixture();
    f.pending.metricsSnapshot = {
      runId: f.pending.runId, metricsSchemaVersion: 2, version: "9.8.0-canary.1", releaseChannel: "canary",
      totalCalls: 2, totalInput: 1_000, totalOutput: 300, totalCacheHit: 200,
      avgLatency: 10, cacheHitRate: 0, status: "success",
    };
    let now = 0;
    let finish: ((pending: PendingCompaction) => void) | undefined;
    const worker = createBackgroundPreparation({
      now: () => now,
      prepare: () => new Promise<PendingCompaction>(resolve => { finish = resolve; }),
    });
    try {
      process.env.HOME = home;
      worker.observe(f.ctx, config);
      await flush();
      if (timing === "ready") { now = 10; finish!(f.pending); await flush(); }
      now = 30;
      const stopped = worker.shutdown();
      if (timing === "finishing-after-cancel") { now = 35; finish!(f.pending); }
      await stopped;
      await worker.shutdown();
      const records = readMetricsLog(10);
      expect(records.map(record => ({
        runId: record.runId, status: record.status, preparation: record.preparation,
        reason: record.preparationDiscardReason, ready: record.preparationReadyMs, wait: record.preparationWaitMs,
      }))).toEqual([{
        runId: f.pending.runId, status: "discarded", preparation: "background", reason: "session",
        ready: timing === "ready" ? 10 : 35, wait: timing === "ready" ? 20 : 0,
      }]);
    } finally {
      finish?.(f.pending);
      await worker.shutdown();
      process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
