/**
 * Lifecycle invariants for the persist step.
 *
 * The audit flagged two related bugs:
 *
 *   P1 #4 — `ctx.compact()` onError did not clear `pendingRef`, so a failed
 *           native compact left a stale summary alive for up to 5 minutes.
 *   P1 #5 — Project fingerprint + compaction state were persisted before
 *           ctx.compact() confirmed application. A subsequent failure would
 *           leave the cache claiming success.
 *
 * These tests exercise the orchestration without needing a real Pi context —
 * we drive `applyCompaction` with a minimal fake RunContext.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyCompaction } from "../src/app/steps/persist.ts";

// applyCompaction records outcome metrics (JSONL append under HOME); isolate
// the writes so the suite never touches the developer's real metrics log.
beforeAll(() => {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "psc-persist-"));
});
import type { RunContext } from "../src/app/run-context.ts";
import { createPendingSlot } from "../src/app/pending-slot.ts";
import type { PendingCompaction } from "../src/types.ts";

function makeFakeCtx(behaviour: "complete" | "error") {
  let onCompleteFn: (() => void) | undefined;
  let onErrorFn: ((e: Error) => void) | undefined;
  const calls: string[] = [];
  const ctx = {
    ui: { notify: (msg: string) => calls.push("notify:" + msg) },
    compact: (opts: { onComplete?: () => void; onError?: (e: Error) => void }) => {
      onCompleteFn = opts.onComplete;
      onErrorFn = opts.onError;
      if (behaviour === "complete") onCompleteFn?.();
      else onErrorFn?.(new Error("native compact rejected"));
    },
  } as unknown as RunContext["ctx"];
  return { ctx, calls };
}

function makeRC(behaviour: "complete" | "error"): RunContext {
  const { ctx, calls } = makeFakeCtx(behaviour);
  const slot = createPendingSlot({ ttlMs: 5 * 60 * 1000 });
  // Pre-stage a payload so the onError path has something to clear and the
  // happy-path tests can assert that applyCompaction does NOT clear on
  // success (the agent loop consumes via session_before_compact).
  const stagedPayload: PendingCompaction = {
    summary: "x",
    firstKeptEntryId: "id",
    tokensBefore: 0,
    details: {} as any,
    sessionId: "test-session",
  };
  slot.set(stagedPayload);
  const rc: Partial<RunContext> = {
    ctx,
    pendingRef: slot,
    flags: { autoTriggered: false, skipCompact: false, verbose: false, dryRun: false, force: false },
    notify: () => { /* no-op */ },
    phaseTimings: [],
    phaseStart: 0,
    pipelineStart: Date.now(),
    extraction: undefined,
    compactionState: undefined,
    // applyCompaction now records the run outcome from the native compact's
    // callbacks (success on onComplete, error on onError), so the fake RC
    // needs the metric fields those paths read.
    sessionId: "test-session",
    profile: "balanced",
    tier: "full",
    contextPercent: 80,
    toolPercent: 0,
    totalTokens: 1000,
    tokensSaved: 500,
    chunkCount: 1,
    verificationScore: 100,
    verificationGaps: [],
    method: "eesv",
    modelLabel: "test/model",
    summaryModel: { provider: "test", id: "model" } as any,
    cancellation: { timedOut: false } as any,
    services: undefined as any,
  };
  // recordSuccessMetrics/recordFailureMetrics read rc.services; give the
  // fake RC a real bag (lazily imported to keep the test header clean).
  const { createServices } = require("../src/infra/services.ts");
  (rc as any).services = createServices();
  (rc as unknown as { _calls: string[] })._calls = calls;
  return rc as RunContext;
}

describe("applyCompaction onError", () => {
  it("clears pendingRef when the native compact rejects (audit P1 #4)", () => {
    const rc = makeRC("error");
    applyCompaction(rc);
    expect(rc.pendingRef.isPresent()).toBe(false);
    expect(rc.pendingRef.peek()).toBeNull();
  });

  it("does not call ctx.compact when skipCompact is set", () => {
    const rc = makeRC("complete");
    rc.flags.skipCompact = true;
    // pendingRef survives because we never invoked compact at all.
    applyCompaction(rc);
    expect(rc.pendingRef.isPresent()).toBe(true);
  });

  it("leaves pendingRef in place when compaction succeeds (the agent loop consumes it)", () => {
    const rc = makeRC("complete");
    applyCompaction(rc);
    // pendingRef is consumed by session_before_compact, not by applyCompaction.
    expect(rc.pendingRef.isPresent()).toBe(true);
  });
});

// External cancellation is the contract that lets `session_before_compact`
// race a hard timeout against the in-pipeline AbortSignal. We exercise the
// surface here without spinning up a full Pi context.
describe("external cancellation surface", () => {
  it("marks the run as timed out and aborts the underlying controller", async () => {
    const { runSmartCompact } = await import("../src/app/run-smart-compact.ts");
    const cancellationOut: { value: import("../src/app/run-smart-compact.ts").ExternalCancellation | null } = { value: null };
    // Fake ctx that does just enough for prepareRun to fail authentication so
    // the run exits quickly. The cancellation handle should still be populated
    // before that exit.
    const fakeCtx = {
      ui: { notify: () => { /* noop */ } },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, apiKey: null }) },
      cwd: "/tmp",
      model: { contextWindow: 100000, provider: "openai", id: "x" },
      sessionManager: { getBranch: () => [], getSessionId: () => "sess" },
      getContextUsage: () => ({ tokens: 0 }),
    } as any;
    const pendingRef = createPendingSlot({ ttlMs: 5 * 60 * 1000 });
    const isRunning = { value: false };
    const summaryModel = { id: "x", provider: "openai", contextWindow: 100000 } as any;
    const run = runSmartCompact({
      ctx: fakeCtx,
      summaryModel,
      segModel: summaryModel,
      profile: "balanced",
      pendingRef, isRunning,
      autoTriggered: true,
      cancellationOut,
    });
    // The cancellation handle must be available synchronously — in production
    // the outer setTimeout starts ticking before the inner pipeline reaches any
    // await point we'd care about.
    expect(cancellationOut.value).not.toBeNull();
    cancellationOut.value!.abort();
    expect(cancellationOut.value!.timedOut).toBe(true);
    await run;
  });
});
