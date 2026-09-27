/**
 * Orchestrator: thread the typed run context through every stage in order.
 *
 * Each step is now a typed transition (see `app/run-context.ts`): the input
 * is the previous stage type, the output is the next. Skipping a step or
 * reordering them is a TypeScript error rather than a runtime crash.
 *
 * Responsibilities owned by this file:
 *
 *  - The try/finally that maintains `isRunning`.
 *  - The timeout `setTimeout` handle (set in prepare, cleared in finally).
 *  - The decision to bail out without side effects when the auto-trigger
 *    hard-timeout fires.
 *  - The post-success result screen + apply-compaction trigger.
 *
 * The function intentionally has no clever control flow: every cross-step
 * dependency is data on the stage type, every conditional is a boolean flag.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { Cell, PendingCompaction, SmartCompactDetails } from "../types.ts";
import type { SessionRunLock } from "./session-run-lock.ts";
import { acquireRunLock, releaseRunLock } from "./session-run-lock.ts";
import { isUnresolvedSessionId, resolveSessionId } from "../infra/session-identity.ts";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { CompactionMode, CompressionProfile } from "../types.ts";
import { MODE_POLICIES, modeFromLegacyProfile, resolveMode } from "./mode-policy.ts";
import { clearCompactProgress, showProgressOverlay, showResultScreen } from "../ui/overlays.ts";
import * as log from "../utils/logger.ts";
import { safeContextPercent } from "../utils/tokens.ts";

import type {
 Notifier, RcBase, PendingRef, StatedRc, WindowedRc,
} from "./run-context.ts";
import { markPhase } from "./run-context.ts";
import { createProductionServices } from "../infra/services.ts";
import { usesOAuth } from "../infra/llm-client.ts";
import { prepareRun } from "./steps/prepare.ts";
import { resolveCompactionWindow } from "./steps/window.ts";
import { recoverSessionLog } from "./steps/recover.ts";
import { selectTier } from "./steps/tier.ts";
import { extractWithCache } from "./steps/extract.ts";
import { summarizeConversation } from "./steps/synthesize.ts";
import { verifyAndPatch } from "./steps/verify.ts";
import { buildState } from "./steps/state.ts";
import { attachVisualArchive } from "./steps/visual.ts";
import { runDamageDetection, stagePendingCompaction, applyCompaction } from "./steps/persist.ts";
import { buildSuccessMetrics, recordSuccessMetrics, recordFailureMetrics } from "./steps/metrics.ts";
import { applyNativeCompaction, attemptNativeCompaction, EngineChainError, engineErrorText, nativeRouteLabelOf, shouldWarnNativeSkip } from "./native-compaction.ts";
import type { CompactionEngine, EngineAttempt } from "../types.ts";
import { errorDetail, notifyUser, recordIssue, reportIssue } from "../utils/issues.ts";
import { formatCompactErrorForUi } from "../ui/error-format.ts";
import { classifyTelemetryFailure } from "../domain/telemetry.ts";

/**
 * Co-operative cancellation surface that the extension entry point can hand
 * back to itself to drive an *external* hard timeout.
 *
 * Calling abort() marks an external hard timeout. The requesting host decides
 * whether native compaction may follow; manual callers do not get an implicit
 * fallback. The orchestrator:
 *
 *   - skips all remaining side effects (state persist, ctx.compact apply),
 *   - clears `pendingRef` in finally,
 *   - records a timeout metric instead of a success metric.
 */
export interface ExternalCancellation {
 timedOut: boolean;
 abort: () => void;
}

/** Options for runSmartCompact — avoids 10-parameter positional calls. */
export interface SmartCompactOptions {
 /**
  * The pipeline only touches members shared by `ExtensionContext` and
  * `ExtensionCommandContext` (ui, cwd, sessionManager, modelRegistry,
  * model, getContextUsage, compact). Using the narrower base type lets
  * the `session_before_compact` event handler pass its context in without
  * any cast, and makes the contract "what does the pipeline actually
  * need?" explicit at the type level.
  */
 ctx: ExtensionContext;
 /** Reuse a caller-loaded snapshot when preview and execution must agree. */
 config?: import("../types.ts").CompactConfig;
 summaryModel: Model<Api>;
 segModel: Model<Api>;
 /** Optional explicit verification/repair route; defaults to the summary model. */
 verifyModel?: Model<Api>;
 /** New execution preset. Omit to preserve the legacy profile mapping. */
 mode?: CompactionMode;
 profile?: CompressionProfile;
 verbose?: boolean;
 dryRun?: boolean;
 pendingRef: PendingRef;
 isRunning: Cell<boolean> | SessionRunLock;
 autoTriggered?: boolean;
 userNote?: string;
 focus?: string;
 maxLlmCalls?: number;
 maxLlmInputTokens?: number;
 skipCompact?: boolean;
 /** Explicit user command may bypass adaptive context-pressure tier gate. */
 force?: boolean;
 /** Native hook reason is overflow; EESV must not resend the rejected window to native summarization. */
 overflowRecovery?: boolean;
 /** Optional hard budget for native auto-trigger only. Manual/tool runs do not time out by default. */
 timeoutMs?: number;
 /** Host cancellation for tool/manual callers. Linked to the pipeline controller. */
 abortSignal?: AbortSignal;
 /**
  * If provided, populated with the run's cancellation handle before any
  * async work begins. The session_before_compact hook uses this to enforce
  * its own hard timeout in addition to the in-pipeline one (some providers
  * ignore AbortSignal entirely).
  */
 cancellationOut?: Cell<ExternalCancellation | null>;
 /** Lifecycle callback supplied by the extension's commit store. */
 onNativeApplyError?: (runId: string, error: Error) => boolean;
}
export type CompactOutcome =
 | { kind: "staged"; pending: PendingCompaction }
 | { kind: "apply-requested"; pending: PendingCompaction }
 | { kind: "dry-run"; details: SmartCompactDetails }
 | { kind: "skipped"; reason: "model-unavailable" | "session-unavailable" | "already-running" | "window-not-viable" | "tier-selection-failed" }
 | { kind: "cancelled"; source: "user" | "timeout" | "host" };

/**
 * Build the Stage 0 context. Every subsequent field is added by a step;
 * see the stage chain in `run-context.ts`.
 */
function makeBase(opts: SmartCompactOptions): RcBase {
 const ctrl = new AbortController();
 const startSessionId = resolveSessionId(opts.ctx);
 const notify: Notifier = (msg, type = "info") => {
  if (opts.autoTriggered && (type === "info" || type === "success")) return;
  if (type === "info" && !opts.verbose) return; // live brief replaces routine toast spam
  // A run that finishes after a session switch must not post into the new session.
  if (resolveSessionId(opts.ctx) !== startSessionId) return;
  notifyUser(opts.ctx, msg, type === "success" ? "info" : type);
 };
 const vlog = (msg: string) => { if (opts.verbose) log.info(msg); };
 const pipelineStart = Date.now();
 const requestedMode = opts.mode ?? modeFromLegacyProfile(opts.profile ?? "balanced");
 const usage = opts.ctx.getContextUsage();
 const reportedPercent = usage?.percent;
 const contextPercent = Number.isFinite(reportedPercent) && (reportedPercent ?? 0) >= 0
  ? reportedPercent as number
  : safeContextPercent(usage?.tokens, opts.ctx.model?.contextWindow);
 const mode = resolveMode(requestedMode, contextPercent);
 const profile = opts.mode ? MODE_POLICIES[mode].profile : (opts.profile ?? MODE_POLICIES[mode].profile);
 return {
  runId: randomUUID(),
  ctx: opts.ctx,
  config: opts.config,
  notify,
  vlog,
  services: createProductionServices({
   modelRuntime: opts.ctx.modelRegistry,
   isUsingOAuth: (model) => usesOAuth(opts.ctx, model),
  }),
  cancellation: { controller: ctrl, signal: ctrl.signal, timedOut: false, timeoutId: null },
  pendingRef: opts.pendingRef,
  isRunning: opts.isRunning,
  onNativeApplyError: opts.onNativeApplyError,
  flags: {
   verbose: !!opts.verbose,
   dryRun: !!opts.dryRun,
   autoTriggered: !!opts.autoTriggered,
   skipCompact: !!opts.skipCompact,
   force: !!opts.force,
   overflowRecovery: !!opts.overflowRecovery,
  },
  userNote: opts.userNote,
  focus: opts.focus,
  maxLlmCalls: opts.maxLlmCalls,
  maxLlmInputTokens: opts.maxLlmInputTokens,
  timeoutMs: opts.timeoutMs ?? 0,
  phaseTimings: [],
  pipelineStart,
  phaseStart: pipelineStart,
  summaryModel: opts.summaryModel,
  segModel: opts.segModel,
  verifyModel: opts.verifyModel ?? opts.summaryModel,
  modelLabel: opts.summaryModel ? opts.summaryModel.provider + "/" + opts.summaryModel.id : "unknown",
  requestedMode,
  mode,
  profile,
 };
}

export async function runSmartCompact(opts: SmartCompactOptions): Promise<CompactOutcome> {
 if (!opts.summaryModel || !opts.segModel) {
  if (!opts.autoTriggered) notifyUser(opts.ctx, "Model resolve failed", "error");
  return { kind: "skipped", reason: "model-unavailable" };
 }
 if (opts.abortSignal?.aborted) {
  return { kind: "cancelled", source: "host" };
 }
 const runSessionId = resolveSessionId(opts.ctx);
 if (isUnresolvedSessionId(runSessionId) && !opts.dryRun) {
  if (!opts.autoTriggered) {
   notifyUser(opts.ctx,
    "Smart compact cannot stage or apply safely until the host exposes a stable session ID. No model calls were made.",
    "warning",
   );
  }
  return { kind: "skipped", reason: "session-unavailable" };
 }
 /** Run-scoped notice, dropped if the user has switched sessions meanwhile. */
 const say = (message: string, type: "info" | "warning" | "error" = "info"): void => {
  if (resolveSessionId(opts.ctx) === runSessionId) notifyUser(opts.ctx, message, type);
 };
 if (!acquireRunLock(opts.isRunning, runSessionId)) {
  if (!opts.autoTriggered) notifyUser(opts.ctx, "Smart compact is already running for this session.", "warning");
  return { kind: "skipped", reason: "already-running" };
 }

 const base = makeBase(opts);
 let externallyAborted = false;
 const abortFromHost = () => {
  externallyAborted = true;
  base.cancellation.controller.abort();
 };
 if (opts.abortSignal) {
  if (opts.abortSignal.aborted) abortFromHost();
  else opts.abortSignal.addEventListener("abort", abortFromHost, { once: true });
 }
 // Late-bound StatedRc reference so the finally block can record failure
 // metrics. We populate it as soon as buildState returns; until then it's
 // null and the failure path uses `base` only.
 let finalRc: StatedRc | null = null;
 let keepApplyProgress = false;
 let runFailed = false;
 let runError: unknown;
 let failureSummaryFields: {
  sessionId?: string; tier?: string; contextPercent?: number; toolPercent?: number;
  totalTokens?: number; methodForMetrics?: string; profile: string; mode?: CompactionMode;
 } = { sessionId: runSessionId, profile: base.profile, mode: base.mode };

 // Expose this run's cancellation knobs to the caller (the extension entry
 // point uses them to fire an outer Promise.race timeout if a provider
 // ignores the inner AbortSignal). The shared ref pattern keeps callers from
 // having to await any handshake before they can cancel.
 if (opts.cancellationOut) {
  opts.cancellationOut.value = {
   get timedOut() { return base.cancellation.timedOut; },
   set timedOut(v: boolean) { base.cancellation.timedOut = v; },
   abort: () => {
    base.cancellation.timedOut = true;
    base.cancellation.controller.abort();
   },
  } as ExternalCancellation;
 }

 try {
  base.cancellation.signal.throwIfAborted();
  const prepared = await prepareRun(base);
  base.cancellation.signal.throwIfAborted();

  const engines: CompactionEngine[] = prepared.config.compactionEngines?.length
   ? prepared.config.compactionEngines
   : ["eesv"];
  base.notify(
   (engines[0] === "native" ? "Native Compact (" + nativeRouteLabelOf(base.ctx) : "EESV Compact (" + base.modelLabel) +
   ", " + base.mode + ") — " +
   ((base.ctx.getContextUsage()?.tokens ?? 0)).toLocaleString() + "t",
   "info",
  );

  const windowed = resolveCompactionWindow(prepared);
  if (!windowed) return { kind: "skipped", reason: "window-not-viable" };
  failureSummaryFields = {
   ...failureSummaryFields,
   sessionId: windowed.sessionId,
   contextPercent: windowed.contextPercent,
   totalTokens: windowed.totalTokens,
  };
  markPhase(windowed, "prepare");

  // Engines run in priority order: unavailable ones are skipped, failures
  // recorded, and the first success applies. All share one call budget.
  const attempts: EngineAttempt[] = [];
  for (let index = 0; index < engines.length; index++) {
   const engine = engines[index];
   const isLast = index === engines.length - 1;
   windowed.cancellation.signal.throwIfAborted();
   if (engine === "native") {
    const outcome = await runNativeEngine(windowed, attempts);
    if (outcome) return outcome;
    continue;
   }
   if (isLast && attempts.length === 0) return await runEesvEngine(windowed);
   try {
    const outcome = await runEesvEngine(windowed, attempts);
    if (outcome.kind !== "skipped") return outcome;
    attempts.push({ engine: "eesv", outcome: "skipped", reason: outcome.reason });
   } catch (error) {
    if (windowed.cancellation.signal.aborted) throw error;
    attempts.push({ engine: "eesv", outcome: "failed", reason: engineErrorText(error) });
   }
   if (!isLast) {
    windowed.notify("EESV did not apply (" + attempts.at(-1)!.reason + "); trying next engine", "warning");
   }
  }
  throw new EngineChainError(attempts);
 } catch (err) {
  if (base.cancellation.signal.aborted) err = base.cancellation.signal.reason;
  runFailed = true;
  runError = err;
  // The failure path may run before any step has populated stage data, so
  // we collect the few fields we need into a small bag. recordFailureMetrics
  // takes either a StatedRc (best case) or the partial bag.
  await recordFailureMetrics(finalRc ?? base, err, failureSummaryFields);
  if (base.cancellation.signal.aborted) {
   return { kind: "cancelled", source: externallyAborted ? "host" : "timeout" };
  }
  throw err;
 } finally {
  opts.abortSignal?.removeEventListener("abort", abortFromHost);
  if (base.cancellation.timeoutId) clearTimeout(base.cancellation.timeoutId);
  releaseRunLock(opts.isRunning, runSessionId);
  if (!keepApplyProgress) clearCompactProgress(base.ctx);
  // Cancelled work must never remain available to a later compaction hook.
  if (base.cancellation.signal.aborted) {
   base.pendingRef.clear(runSessionId);
  }
  const pipelineMs = Date.now() - base.pipelineStart;
  if (base.flags.autoTriggered && !base.cancellation.signal.aborted) {
   const dur = pipelineMs < 1000 ? pipelineMs + "ms" : (pipelineMs / 1000).toFixed(1) + "s";
   const hasPending = base.pendingRef.isPresent(runSessionId);
   if (runFailed) {
    // Automatic runs have no caller that shows the error: surface the
    // cause once per session and kind instead of a reasonless toast.
    reportIssue({
     key: "auto.run:" + (runError instanceof Error && runError.name === "EngineChainError"
      ? "engines" : classifyTelemetryFailure(runError)),
     message: formatCompactErrorForUi(runError).replace(
      "Conversation unchanged.",
      base.flags.skipCompact
       ? "Automatic preparation stopped after " + dur + "; context unchanged."
       : "Smart Compact stopped after " + dur + "; no Smart Compact summary was applied.",
     ),
    }, base.ctx);
    recordIssue({ key: "auto.run.detail", message: "Last automatic run error: " + errorDetail(runError) + "." });
   } else if (hasPending || finalRc) say(
    hasPending
     ? "Smart compact prepared in " + dur + " — awaiting native /compact"
     : "Smart compact run finished in " + dur,
    "info",
   );
  }
 }

 async function runNativeEngine(
  windowed: WindowedRc,
  attempts: EngineAttempt[],
 ): Promise<CompactOutcome | null> {
  showProgressOverlay(windowed.ctx, {
   phase: 1, phaseName: "Native",
   detail: "Provider-native compaction on " + nativeRouteLabelOf(windowed.ctx),
   model: nativeRouteLabelOf(windowed.ctx), profile: windowed.profile,
  });
  const result = await attemptNativeCompaction(windowed, attempts);
  windowed.cancellation.signal.throwIfAborted();
  if (result.outcome !== "staged") {
   attempts.push({ engine: "native", outcome: result.outcome, reason: result.reason });
   if (
    result.outcome === "failed" ||
    shouldWarnNativeSkip(windowed.sessionId, nativeRouteLabelOf(windowed.ctx))
   ) {
    windowed.notify("Native compaction " + result.outcome + ": " + result.reason, "warning");
   }
   return null;
  }
  const { pending } = result;
  if (windowed.flags.dryRun) {
   say(
    "DRY RUN (native " + pending.details.model + ") — " + pending.details.totalMessages +
    " msgs, ~" + (pending.details.estimatedAfterTokens ?? 0).toLocaleString() + "t after",
    "info",
   );
   return { kind: "dry-run", details: pending.details };
  }
  if (windowed.cancellation.timeoutId) {
   clearTimeout(windowed.cancellation.timeoutId);
   windowed.cancellation.timeoutId = null;
  }
  const willApply = !windowed.flags.skipCompact && !windowed.flags.autoTriggered;
  if (willApply && windowed.config.requireApproval) {
   let approved = false;
   try {
    approved = windowed.ctx.hasUI
     ? await windowed.ctx.ui.confirm(
      "Apply native compaction?",
      "Engine: native (" + pending.details.model + ")\n" +
      "Compacts " + pending.details.totalMessages + " messages; ~" +
      (pending.details.tokensBefore).toLocaleString() + "t → ~" +
      (pending.details.estimatedAfterTokens ?? 0).toLocaleString() + "t (estimate).\n" +
      "Provider state is opaque and not EESV-verified; it replays only on this provider/model.",
     )
     : false;
   } catch (err) {
    windowed.notify("Approval UI failed — compaction cancelled: " + (err instanceof Error ? err.message : String(err)), "warning");
   }
   windowed.cancellation.signal.throwIfAborted();
   if (!approved) {
    windowed.pendingRef.clear(windowed.sessionId);
    say("Compaction cancelled — current conversation unchanged", "info");
    return { kind: "cancelled", source: "user" };
   }
  }
  windowed.cancellation.signal.throwIfAborted();
  windowed.pendingRef.set(pending);
  if (willApply) {
   showProgressOverlay(windowed.ctx, {
    phase: 5, phaseName: "Apply",
    detail: "Native (" + pending.details.model + ") · staging this run · awaiting Pi confirmation",
   });
   applyNativeCompaction(windowed, pending);
   keepApplyProgress = true;
  }
  return willApply ? { kind: "apply-requested", pending } : { kind: "staged", pending };
 }

 async function runEesvEngine(
  windowed: WindowedRc,
  priorAttempts: EngineAttempt[] = [],
 ): Promise<CompactOutcome> {
  showProgressOverlay(windowed.ctx, {
   phase: 1, phaseName: "Extract",
   detail: "Indexing goals, files, decisions, errors, and open loops",
   model: windowed.modelLabel, profile: windowed.profile,
  });

  const recovered = await recoverSessionLog(windowed);
  recovered.cancellation.signal.throwIfAborted();
  markPhase(recovered, "recover");

  const tiered = selectTier(recovered);
  if (!tiered) return { kind: "skipped", reason: "tier-selection-failed" };
  failureSummaryFields = { ...failureSummaryFields, tier: tiered.tier, toolPercent: tiered.toolPercent };

  const extracted = extractWithCache(tiered);

  const synthesized = await summarizeConversation(extracted);
  failureSummaryFields = {
   ...failureSummaryFields,
   methodForMetrics: synthesized.methodForMetrics,
   mode: synthesized.mode,
   profile: synthesized.profile,
  };

  synthesized.cancellation.signal.throwIfAborted();
  const verified = await verifyAndPatch(synthesized);
  verified.cancellation.signal.throwIfAborted();
  markPhase(verified, "verify");

  const stated = buildState(verified);
  finalRc = stated;
  if (priorAttempts.length) {
   stated.details.engineAttempts = [...priorAttempts, { engine: "eesv", outcome: "applied" }];
  }
  await attachVisualArchive(stated);
  stated.cancellation.signal.throwIfAborted();

  stated.vlog(
   "Pipeline complete — method=" + stated.method + " calls=" + stated.llmCalls +
   " chunks=" + stated.chunkCount + " tokensSaved=" + stated.tokensSaved,
  );
  markPhase(stated, "state");

  if (stated.flags.dryRun) {
   await recordSuccessMetrics(stated, "dry-run");
   say(
    "DRY RUN (" + stated.method + ", " + stated.mode + ") — " +
    stated.toCompact.length + " msgs, " + stated.llmCalls + " calls",
    "info",
   );
   return { kind: "dry-run", details: stated.details };
  }

  // The configured deadline bounds provider/pipeline work, not the user's
  // review time. External host cancellation remains wired during approval.
  if (base.cancellation.timeoutId) {
   clearTimeout(base.cancellation.timeoutId);
   base.cancellation.timeoutId = null;
  }

  // Damage detection runs in best-effort mode against the existing branch's
  // previous compaction. Cheap to run, useful for the metrics dashboard.
  runDamageDetection(stated);
  markPhase(stated, "damage");

  const willApply = !stated.flags.skipCompact && !stated.flags.autoTriggered;
  if (!stated.flags.autoTriggered && willApply && stated.config.requireApproval) {
   let decision: "apply" | "cancel" | "closed" = "cancel";
   try {
    // Approval is fail-closed and never races an auto-apply timer.
    decision = stated.ctx.hasUI
     ? await showResultScreen(stated.ctx, stated.details, stated.extraction, stated.services, { approval: true, summary: stated.finalSummary })
     : "cancel";
   } catch (err) {
    log.debugError("Approval UI stopped", err);
    stated.notify("Approval UI failed — compaction cancelled", "warning");
   }
   stated.cancellation.signal.throwIfAborted();
   if (decision !== "apply") {
    stated.pendingRef.clear(stated.sessionId);
    await recordSuccessMetrics(stated, "cancelled");
    say("Compaction cancelled — current conversation unchanged", "info");
    return { kind: "cancelled", source: "user" };
   }
  }

  // One last cancellation gate before staging anything the host could use.
  stated.cancellation.signal.throwIfAborted();

  // Snapshot telemetry now, but append it only after session_compact proves
  // Pi applied this exact runId. This prevents failed native compactions
  // from being reported or persisted as successful.
  if (willApply) {
   showProgressOverlay(stated.ctx, {
    phase: 5, phaseName: "Apply",
    detail: "Verified " + stated.verificationScore + "/100 · staging this run · awaiting Pi confirmation",
   });
  }
  const pending = stagePendingCompaction(stated, buildSuccessMetrics(stated, "success"));
  stated.cancellation.signal.throwIfAborted();

  if (willApply) {
   applyCompaction(stated);
   keepApplyProgress = true;
  }
  return willApply ? { kind: "apply-requested", pending } : { kind: "staged", pending };
 }
}
