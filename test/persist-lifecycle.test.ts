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
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyCompaction } from "../src/app/steps/persist.ts";
import { readMetricsLog } from "../src/utils/cache.ts";

// applyCompaction records outcome metrics (JSONL append under HOME); isolate
// the writes so the suite never touches the developer's real metrics log.
const originalHome = process.env.HOME;
let home: string;
beforeEach(() => {
 home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-persist-"));
 process.env.HOME = home;
});
afterEach(() => {
 process.env.HOME = originalHome;
 fs.rmSync(home, { recursive: true, force: true });
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
  compact: (opts: {
   onComplete?: () => void;
   onError?: (e: Error) => void;
  }) => {
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
  runId: "persist-lifecycle-run",
  summary: "x",
  firstKeptEntryId: "id",
  originBranchHeadId: "id",
  tokensBefore: 0,
  details: { runId: "persist-lifecycle-run" } as any,
  sessionId: "test-session",
 };
 slot.set(stagedPayload);
 const rc: Partial<RunContext> = {
  runId: "persist-lifecycle-run",
  ctx,
  pendingRef: slot,
  flags: {
   autoTriggered: false,
   skipCompact: false,
   verbose: false,
   dryRun: false,
   force: false,
  },
  notify: () => {
   /* no-op */
  },
  phaseTimings: [],
  phaseStart: 0,
  pipelineStart: Date.now(),
  extraction: undefined,
  compactionState: undefined,
  // applyCompaction records only native apply errors. Correlated
  // session_compact exclusively owns success metrics and feedback, while
  // the error fallback still reads these metric fields.
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
 // Failure metrics read rc.services; give the fake RC a real bag.
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

 it("keeps a newer run's staged candidate when an older apply rejects", () => {
  const rc = makeRC("error");
  const older = rc.pendingRef.peek()!;
  rc.pendingRef.set({ ...older, runId: "persist-lifecycle-newer", details: { ...older.details, runId: "persist-lifecycle-newer" } });
  applyCompaction(rc);
  expect(rc.pendingRef.peek()?.runId).toBe("persist-lifecycle-newer");
 });

 it("does not call ctx.compact when skipCompact is set", () => {
  const rc = makeRC("complete");
  rc.flags.skipCompact = true;
  // pendingRef survives because we never invoked compact at all.
  applyCompaction(rc);
  expect(rc.pendingRef.isPresent()).toBe(true);
 });

 it("leaves pendingRef and success telemetry untouched until session_compact", () => {
  const rc = makeRC("complete");
  const before = readMetricsLog().length;
  applyCompaction(rc);
  expect(rc.pendingRef.isPresent()).toBe(true);
  expect(readMetricsLog()).toHaveLength(before);
  expect((rc as unknown as { _calls: string[] })._calls).not.toContain(
   "notify:Applied ✓",
  );
 });

 it("lets the lifecycle store own apply-error telemetry without duplication", () => {
  const rc = makeRC("error");
  const calls: string[] = [];
  rc.onNativeApplyError = (runId, error) => {
   calls.push(runId + ":" + error.message);
   return true;
  };
  const before = readMetricsLog().length;
  applyCompaction(rc);
  expect(calls).toEqual(["persist-lifecycle-run:native compact rejected"]);
  expect(readMetricsLog()).toHaveLength(before);
 });
});

