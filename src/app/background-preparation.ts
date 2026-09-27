/** Opt-in speculative preparation. Application stays in Pi's native compaction lifecycle. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FIVE_MINUTES_MS, MIN_TOKEN_THRESHOLD, SETTLED_TRIGGER_COOLDOWN_MS } from "../constants.ts";
import { resolveSessionId, isUnresolvedSessionId } from "../infra/session-identity.ts";
import type { CompactConfig, MetricsSnapshot, PendingCompaction, PreparationDiscardReason } from "../types.ts";
import { pendingMatchesBranch, revalidatePending } from "./pending-slot.ts";
import { errorDetail, recordIssue } from "../utils/issues.ts";
import { appendMetricsSnapshot } from "../utils/cache.ts";
import { effectiveContextWindow } from "../utils/tokens.ts";

/**
 * Default discard recorder: one bounded local metrics entry per discarded
 * preparation, so its provider cost is counted exactly once and never lands
 * in the applied cohort. Injectable for tests.
 */
export function recordPreparationDiscard(
 sessionId: string,
 snapshot: MetricsSnapshot,
 reason: PreparationDiscardReason,
): Promise<boolean> {
 return appendMetricsSnapshot(sessionId, {
  ...snapshot,
  status: "discarded",
  preparation: "background",
  preparationDiscardReason: reason,
  fallbackReason: "preparation:" + reason,
 });
}
export function preparationStartTokens(applyTokens: number): number {
 const lead = Math.min(32_000, Math.max(8_192, Math.floor(applyTokens * 0.125)));
 return Math.max(MIN_TOKEN_THRESHOLD, applyTokens - lead);
}

/**
 * Token window for speculative preparation. minContextPercent is always the
 * apply gate. An explicit prepareContextPercent below it sets the start;
 * null (or an unvalidated value at/above the gate) uses the adaptive lead.
 * MIN_TOKEN_THRESHOLD is a floor in both cases.
 */
export function preparationWindow(
 config: Pick<CompactConfig, "minContextPercent" | "prepareContextPercent">,
 window: number,
): { startTokens: number; applyTokens: number } {
 const applyTokens = window * config.minContextPercent / 100;
 const prepare = config.prepareContextPercent;
 const explicit = typeof prepare === "number" && Number.isFinite(prepare)
  && prepare >= 0 && prepare < config.minContextPercent;
 const startTokens = explicit
  ? Math.max(MIN_TOKEN_THRESHOLD, window * prepare / 100)
  : preparationStartTokens(applyTokens);
 return { startTokens, applyTokens };
}

/** Keep the pipeline on one immutable branch/usage snapshot while the agent continues. */
function snapshotContext(ctx: ExtensionContext): ExtensionContext {
 const branch = structuredClone(ctx.sessionManager.getBranch());
 const sessionId = resolveSessionId(ctx);
 const sessionFile = ctx.sessionManager.getSessionFile?.();
 const usage = structuredClone(ctx.getContextUsage());
 const sessionManager = new Proxy(ctx.sessionManager, {
  get(target, key) {
   if (key === "getBranch") return () => branch;
   if (key === "getSessionId") return () => sessionId;
   if (key === "getSessionFile") return () => sessionFile;
   const value = Reflect.get(target, key);
   return typeof value === "function" ? value.bind(target) : value;
  },
 });
 const snapshot: ExtensionContext = {
  ...ctx, sessionManager, model: ctx.model && { ...ctx.model }, hasUI: false,
  getContextUsage: () => usage,
  ui: { ...ctx.ui, notify() { }, setStatus() { }, setWidget() { } },
 };
 // Silent while healthy; failures are queued and shown at the next real event.
 return Object.assign(snapshot, { silentBackground: true });
}

function signature(ctx: ExtensionContext, config: CompactConfig): string {
 const model = ctx.model;
 return JSON.stringify([model?.provider, model?.id, model?.api, model?.contextWindow, model?.maxTokens, config]);
}

function enabled(config: CompactConfig): boolean {
 // requireApproval governs manual apply; automatic runs retain their existing policy.
 return config.autoTrigger && config.autoTriggerStrategy === "background";
}

interface Preparation {
 sessionId: string;
 originId: string;
 signature: string;
 controller: AbortController;
 createdAt: number;
 readyAt?: number;
 pending?: PendingCompaction;
 discardReason?: PreparationDiscardReason;
 ctx: ExtensionContext;
}

export function createBackgroundPreparation(options: {
 prepare(ctx: ExtensionContext, config: CompactConfig, signal: AbortSignal): Promise<PendingCompaction | null>;
 now?: () => number;
 ttlMs?: number;
 cooldownMs?: number;
 /** Test seam for the bounded local discard metrics entry. */
 discardRecorder?: (sessionId: string, snapshot: MetricsSnapshot, reason: PreparationDiscardReason) => void | Promise<boolean>;
}) {
 const now = options.now ?? Date.now;
 const ttlMs = options.ttlMs ?? FIVE_MINUTES_MS;
 const cooldownMs = options.cooldownMs ?? SETTLED_TRIGGER_COOLDOWN_MS;
 // ponytail: one speculative task per extension; per-session scheduling only if concurrent servers need it.
 let current: Preparation | null = null;
 let lastAttempt: { sessionId: string; at: number } | undefined;
 const settling = new Set<Promise<unknown>>();
 const track = (work: Promise<unknown>): void => {
  settling.add(work);
  void work.then(() => { settling.delete(work); }, error => {
   settling.delete(work);
   recordIssue({ key: "background.accounting", message: "Background accounting failed (" + errorDetail(error) + ").", error });
  });
 };

 // Background work is silent while healthy: no footer status. Failures
 // are reported by runSmartCompact through the issue reporter.
 const discard = options.discardRecorder ?? recordPreparationDiscard;
 const recordDiscard = (sessionId: string, snapshot: MetricsSnapshot, reason: PreparationDiscardReason): void => {
  const write = discard(sessionId, snapshot, reason);
  if (write) track(write);
 };
 const preparationMetrics = (task: Preparation, snapshot: MetricsSnapshot): MetricsSnapshot => ({
  ...snapshot,
  preparation: "background",
  ...(task.readyAt != null ? {
   preparationReadyMs: Math.max(0, task.readyAt - task.createdAt),
   preparationWaitMs: Math.max(0, now() - task.readyAt),
  } : {}),
 });
 const writeDiscard = (task: Preparation, reason: PreparationDiscardReason): void => {
  // No ready pending means the run's own failure/cancel metrics already
  // carry its cost; a discard entry would double count it.
  const snapshot = task.pending?.metricsSnapshot;
  if (snapshot && task.pending) recordDiscard(task.pending.sessionId, preparationMetrics(task, snapshot), reason);
 };
 const cancel = (reason: PreparationDiscardReason = "cancelled"): void => {
  const old = current;
  current = null;
  if (!old) return;
  old.discardReason = reason;
  writeDiscard(old, reason);
  old.controller.abort();
 };
 /** Why the task no longer matches the live session, or null while valid. */
 const invalidationReason = (
  task: Preparation,
  ctx: ExtensionContext,
  config: CompactConfig,
 ): PreparationDiscardReason | null => {
  if (!enabled(config)) return "config";
  if (task.sessionId !== resolveSessionId(ctx)) return "session";
  if (task.signature !== signature(ctx, config)) return "config";
  if (now() - (task.readyAt ?? task.createdAt) > ttlMs) return "ttl";
  const branch = ctx.sessionManager.getBranch();
  const origin = branch.findIndex(entry => entry.id === task.originId);
  // New messages are fine; a new projection/compaction requires a new snapshot.
  return origin >= 0 && !branch.slice(origin + 1).some(entry =>
   entry.type === "context_edit" || entry.type === "compaction",
  ) ? null : "branch";
 };
 const valid = (task: Preparation, ctx: ExtensionContext, config: CompactConfig): boolean =>
  invalidationReason(task, ctx, config) === null;

 const observe = (ctx: ExtensionContext, config: CompactConfig): void => {
  if (current) {
   const reason = invalidationReason(current, ctx, config);
   if (reason) cancel(reason);
  }
  if (current || !enabled(config) || !ctx.model) return;
  const sessionId = resolveSessionId(ctx);
  if (isUnresolvedSessionId(sessionId)
   || (lastAttempt?.sessionId === sessionId && now() - lastAttempt.at < cooldownMs)) return;
  const tokens = ctx.getContextUsage()?.tokens;
  const window = effectiveContextWindow(ctx.model, config);
  if (typeof tokens !== "number" || !Number.isFinite(tokens)
   || typeof window !== "number" || !Number.isFinite(window) || window <= 0) return;
  const { startTokens, applyTokens } = preparationWindow(config, window);
  if (tokens < startTokens || tokens >= applyTokens) return;

  const snapshot = snapshotContext(ctx);
  const originId = snapshot.sessionManager.getBranch().at(-1)?.id;
  if (!originId) return;
  const task: Preparation = {
   sessionId, originId, signature: signature(ctx, config),
   controller: new AbortController(), createdAt: now(), ctx,
  };
  current = task;
  lastAttempt = { sessionId, at: now() };
  // Only lower the admission gate, not retention policy or reduction targets.
  const preparationConfig = { ...config, minContextPercent: startTokens / window * 100 };
  track(Promise.resolve().then(() => options.prepare(snapshot, preparationConfig, task.controller.signal))
   .then(pending => {
    if (pending) { task.pending = pending; task.readyAt = now(); }
    if (current !== task || task.controller.signal.aborted) {
     // Superseded or cancelled while in flight: the staged cost would
     // otherwise vanish. Exactly one entry, never in the applied cohort.
     writeDiscard(task, task.discardReason ?? "superseded");
     return;
    }
    if (!pending) { cancel("cancelled"); return; }
   }).catch(error => {
    // runSmartCompact reports run failures visibly; keep a local record.
    recordIssue({ key: "background.prepare", message: "Background preparation stopped (" + errorDetail(error) + ").", error });
    if (current === task) cancel("cancelled");
   }));
 };

 // Handed-off work is applied (or apply-failed) by the native lifecycle;
 // the caller reports back only when the taken candidate is dropped unused.
 let handedOff: { runId: string; task: Preparation } | null = null;

 const take = (ctx: ExtensionContext, config: CompactConfig): PendingCompaction | null => {
  const task = current;
  if (!task) return null;
  // Native compaction owns the next action, even when speculative work is
  // unfinished: an in-flight run is aborted (its own metrics carry the cost).
  if (!task.pending) { cancel("cancelled"); return null; }
  const pending = task.pending;
  const invalid = invalidationReason(task, ctx, config);
  if (invalid) { cancel(invalid); return null; }
  if (!pendingMatchesBranch(pending, ctx.sessionManager.getBranch())) { cancel("branch"); return null; }
  current = null;
  handedOff = null;
  // Last gate: token headroom can still fail at the moment of apply.
  const revalidated = revalidatePending(pending, ctx);
  if (!revalidated) { writeDiscard(task, "stale"); return null; }
  const snapshot = revalidated.metricsSnapshot;
  const ready = snapshot ? {
   ...revalidated,
   metricsSnapshot: preparationMetrics(task, snapshot),
  } : revalidated;
  handedOff = { runId: pending.runId, task };
  return ready;
 };

 const noteHandoffUnused = (runId: string, reason: "superseded" | "stale"): void => {
  if (handedOff?.runId !== runId) return;
  const entry = handedOff;
  handedOff = null;
  writeDiscard(entry.task, reason);
 };

 return {
  observe, take, cancel, noteHandoffUnused,
  async shutdown(): Promise<void> {
   cancel("session");
   // A finishing cancelled run can enqueue its discard while we wait.
   while (settling.size) await Promise.allSettled([...settling]);
  },
  hasWork: () => current !== null,
  /** Read-only preparation state for the host; no TTL or metrics effects. */
  status(sessionId: string): "idle" | "preparing" | "ready" {
   const task = current;
   if (!task || task.sessionId !== sessionId) return "idle";
   return task.pending ? "ready" : "preparing";
  },
  noteCompaction(sessionId: string) {
   if (current?.sessionId === sessionId) cancel("superseded");
   lastAttempt = { sessionId, at: now() };
  },
 };
}
