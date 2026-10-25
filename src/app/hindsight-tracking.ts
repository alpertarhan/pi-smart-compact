import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isOpenReceipt, listReceipts, type HindsightReceipt } from "../infra/hindsight-receipts.ts";
import { hindsightTargetDigest } from "../infra/memory-ref.ts";
import { loadConfig } from "../utils/config.ts";
import { deriveProjectIdFromCwd } from "../utils/fingerprint.ts";
import { errorDetail, reportIssue } from "../utils/issues.ts";
import { describeRemoteSave, refreshReceipt, resolveHindsightTarget, type RemoteSaveOutcome } from "./hindsight-memory.ts";

const MAX_TRACKED = 32;
interface TrackedReceipt {
  receipt: HindsightReceipt;
  startedAt: number;
  epoch: number;
  lastError?: string;
}

/** Status reads only: never submits, retries or resolves a remote memory. */
export function registerHindsightTracking(pi: ExtensionAPI, options: {
  pollIntervalMs?: number;
  maxTrackingMs?: number;
} = {}): { observe: (outcome: RemoteSaveOutcome, ctx: ExtensionContext) => boolean } {
  if (typeof pi.events?.on !== "function" || typeof pi.sendMessage !== "function") return { observe: () => false };
  const interval = options.pollIntervalMs ?? 5_000;
  const maxTrackingMs = options.maxTrackingMs ?? 120_000;
  const jobs = new Map<string, TrackedReceipt>();
  let active: { ctx: ExtensionContext; sessionId: string; projectId: string } | undefined;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | undefined;
  let abort: AbortController | undefined;

  function targetFor(receipt: HindsightReceipt, generation = epoch) {
    if (!active || generation !== epoch) return;
    try {
      if (active.ctx.sessionManager.getSessionId() !== active.sessionId
        || deriveProjectIdFromCwd(active.ctx.cwd) !== active.projectId
        || receipt.projectId !== active.projectId) return;
      const target = resolveHindsightTarget(loadConfig());
      if (target.enabled && target.ok && target.target.baseUrl === receipt.baseUrl
        && target.target.bankId === receipt.bankId) return target.target;
    } catch { /* A disposed context cannot authorize background work. */ }
  }

  function publish(job: TrackedReceipt, expired = false): void {
    const receipt = job.receipt;
    const target = targetFor(receipt, job.epoch);
    const context = active;
    if (!target || !context || receipt.state === "deleted") return;
    const outcome: RemoteSaveOutcome = receipt.state === "completed" ? { state: "completed", receipt }
      : receipt.state === "failed" ? { state: "failed", receipt, reason: receipt.detail ?? "operation failed" }
        : receipt.state === "accepted"
          ? { state: "accepted", receipt, operationStatus: "pending" }
          : { state: "unknown", receipt, reason: job.lastError ?? receipt.detail ?? "completion not confirmed" };
    const memoryId = receipt.documentId.slice(4);
    const ref = "hindsight:" + memoryId + "@" + hindsightTargetDigest(target.baseUrl, target.bankId, receipt.projectId, memoryId);
    const content = `<memory_status backend="hindsight" state="${outcome.state}">\nSmart Compact: `
      + (expired ? "Last observed memory state: " : "") + describeRemoteSave(outcome)
      + "\nRef: " + ref + "\nOperation: " + receipt.operationId
      + (expired && job.lastError ? "\nLast status check failed: " + job.lastError : "")
      + (expired ? "\nBackground tracking stopped at its time limit; use smart_recall to check the current status." : "")
      + "\n</memory_status>";
    let delivered = false;
    const deliver = () => {
      if (delivered || !targetFor(receipt, job.epoch)) return;
      // A resolve or a newer status observed while compaction held this notice wins.
      const latest = listReceipts(receipt, receipt.documentId).find(item => item.key === receipt.key);
      if (!latest || latest.state !== receipt.state) return;
      pi.sendMessage({ customType: "smart-compact-memory-status", content, display: true,
        details: { backend: "hindsight", state: outcome.state, ref, expired } }, { triggerTurn: false });
      delivered = true;
    };
    const request = { version: 1, sessionId: context.sessionId, deliver, deferred: false };
    pi.events.emit("smart-compact:defer-delivery", request);
    if (!request.deferred) deliver();
  }

  async function check(job: TrackedReceipt, signal: AbortSignal): Promise<void> {
    if (jobs.get(job.receipt.key) !== job) return;
    const target = targetFor(job.receipt, job.epoch);
    if (!target) { jobs.delete(job.receipt.key); return; }
    const remaining = job.startedAt + maxTrackingMs - Date.now();
    if (remaining > 0) {
      try {
        job.receipt = await refreshReceipt(target, job.receipt,
          AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, remaining))]));
        job.lastError = undefined;
      } catch (error) {
        job.lastError = errorDetail(error);
      }
    }
    if (signal.aborted || jobs.get(job.receipt.key) !== job || !targetFor(job.receipt, job.epoch)) return;
    const expired = Date.now() - job.startedAt >= maxTrackingMs;
    if (!isOpenReceipt(job.receipt) || expired) {
      jobs.delete(job.receipt.key);
      publish(job, expired && isOpenReceipt(job.receipt));
    }
  }

  function schedule(): void {
    if (!active || !jobs.size || timer || flight) return;
    timer = setTimeout(() => {
      timer = undefined;
      const generation = epoch;
      const controller = new AbortController();
      abort = controller;
      const batch = [...jobs.values()];
      const pending = (async () => {
        for (let i = 0; i < batch.length && generation === epoch; i += 3) {
          await Promise.all(batch.slice(i, i + 3).map(job => check(job, controller.signal)));
        }
      })().catch(error => {
        if (active && generation === epoch) reportIssue({ key: "hindsight.tracking", message:
          "Hindsight background status tracking could not finish (" + errorDetail(error) + "). smart_recall can refresh the receipts.", error }, active.ctx);
      }).finally(() => {
        if (flight === pending) flight = undefined;
        if (generation === epoch) schedule();
      });
      flight = pending;
    }, interval);
    timer.unref();
  }

  function add(receipt: HindsightReceipt): boolean {
    if (!targetFor(receipt) || !/^psc-cg-[0-9a-f]{24}$/.test(receipt.documentId)) return false;
    if (!isOpenReceipt(receipt)) { jobs.delete(receipt.key); return false; }
    if (jobs.has(receipt.key)) return true;
    if (jobs.size >= MAX_TRACKED) {
      reportIssue({ key: "hindsight.tracking-full", message:
        "Hindsight is already tracking 32 submissions; this receipt remains in the ledger. Use smart_recall to refresh it." }, active?.ctx);
      return false;
    }
    jobs.set(receipt.key, { receipt, startedAt: Date.now(), epoch });
    schedule();
    return true;
  }

  async function stop(): Promise<void> {
    epoch++;
    active = undefined;
    jobs.clear();
    clearTimeout(timer);
    timer = undefined;
    abort?.abort();
    await flight;
  }
  pi.on("session_start", async (_event, ctx) => {
    await stop();
    const projectId = deriveProjectIdFromCwd(ctx.cwd);
    if (!projectId) return;
    active = { ctx, projectId, sessionId: ctx.sessionManager.getSessionId() };
    const target = resolveHindsightTarget(loadConfig());
    if (!target.enabled || !target.ok) return;
    try {
      const pending = listReceipts({ ...target.target, projectId }).filter(isOpenReceipt)
        .sort((a, b) => b.createdAt - a.createdAt);
      for (const receipt of pending) {
        if (jobs.size >= MAX_TRACKED) break;
        add(receipt);
      }
    } catch (error) {
      reportIssue({ key: "hindsight.tracking-ledger", message:
        "Hindsight background tracking could not read its receipt ledger (" + errorDetail(error) + "). No remote request was sent.", error }, ctx);
    }
  });
  pi.on("session_shutdown", stop);

  return { observe: (outcome, ctx) => {
    try {
      if (!active || ctx.sessionManager.getSessionId() !== active.sessionId || ctx.cwd !== active.ctx.cwd) return false;
      if (!outcome.receipt) return false;
      if (outcome.state === "completed" || outcome.state === "failed") {
        jobs.delete(outcome.receipt.key);
        return false;
      }
      return add(outcome.receipt);
    } catch { return false; } // A late save result must not start work in a replacement session.
  } };
}
