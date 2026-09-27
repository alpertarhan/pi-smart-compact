/**
 * Smart Compact Extension for Pi Coding Agent (EESV Architecture)
 *
 * Architecture: Extract -> Explore -> Synthesize -> Verify
 */

import {
 convertToLlm,
 type ExtensionAPI,
 type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PendingCompaction, PreparationDiscardReason } from "./types.ts";
import {
 MIN_TOKEN_THRESHOLD,
 FIVE_MINUTES_MS,
 AUTO_TRIGGER_TIMEOUT_CAP_MS,
} from "./constants.ts";
import { loadConfig } from "./utils/config.ts";
import { getProviderCaps, safeContextPercent } from "./utils/tokens.ts";
import { appendMetricsSnapshot } from "./utils/cache.ts";
import { runSmartCompact } from "./app/run-smart-compact.ts";
import { applyGlobalSettingsRuntime } from "./app/global-settings-runtime.ts";
import {
 clearCompactProgress,
 notifyAppliedCompaction,
} from "./ui/overlays.ts";
import {
 branchEntryIds,
 resolveSessionId,
 isUnresolvedSessionId,
} from "./infra/session-identity.ts";
import {
 createPendingSlot,
 pendingMatchesBranch,
 revalidatePending,
 type PendingSlot,
 type ConsumeResult,
} from "./app/pending-slot.ts";
import { createSessionRunLock } from "./app/session-run-lock.ts";
import { commitAppliedCompaction } from "./app/steps/persist.ts";
import {
 createCompactionCommitStore,
 type CommitDiscardReason,
} from "./app/compaction-commit-store.ts";
import {
 OnlineDamageMonitor,
 logDamageReport,
 writeRemediationHints,
} from "./utils/damage.ts";
import { errorDetail, flushIssues, notifyUser, reportIssue } from "./utils/issues.ts";
import * as log from "./utils/logger.ts";
import { deriveProjectIdFromCwd } from "./utils/fingerprint.ts";
import {
 loadScopedCompactionState,
 renderContinuityCapsule,
} from "./utils/state.ts";
import { createNativeContinuityBridge } from "./app/native-continuity-bridge.ts";
import { createNativeReplayHook, setNativeToolSource } from "./app/native-compaction.ts";
import { createSettledAutoTrigger } from "./app/settled-auto-trigger.ts";
import { createBackgroundPreparation } from "./app/background-preparation.ts";
import { injectVisualArchive } from "./app/visual-archive.ts";
import { SecretScrubber } from "./domain/scrub.ts";
import { registerArtifactOffload } from "./app/tool-artifacts.ts";
import {
 registerContextTools,
 resolveGraphScope,
} from "./app/register-context-tools.ts";
import { resolveModels } from "./app/model-routing.ts";
import { registerSmartCompactTool } from "./app/register-smart-compact-tool.ts";
import { registerSmartContextTool } from "./app/register-smart-context-tool.ts";
import { registerSmartCompactCommand } from "./app/register-smart-compact-command.ts";
import { createSmartCompactPolicy } from "./app/smart-compact-policy.ts";
import { createContextToolExposure, registerContextToolLoader } from "./app/lazy-tools.ts";
import { registerNavigation, type NavigationController } from "./app/register-navigation.ts";
import { registerAnchorCache } from "./app/anchor-cache.ts";
export { findModelById, resolveModels } from "./app/model-routing.ts";

/**
 * Translate a `ConsumeResult` into the side-effects the host expects:
 *   - log the reason (warn for expired/mismatch, debug for empty)
 *   - surface a user-facing notification *only* when something interesting
 *     happened (we don't toast for the common "nothing pending" case)
 *   - return the unwrapped payload, or `null` if no payload should be used
 *
 * Keeping this orchestration in the extension entry point — instead of
 * inside `PendingSlot.consume` itself — lets the slot stay a pure,
 * host-agnostic state machine that's trivial to unit-test.
 */
function unwrapConsumed(
 result: ConsumeResult,
 ctx: ExtensionContext,
): PendingCompaction | null {
 switch (result.kind) {
  case "ok": {
   // Same-session is necessary but insufficient: a fork can retain the
   // session id while moving to a sibling branch. Both producer provenance
   // and the replacement boundary must remain in active ancestry.
   if (!pendingMatchesBranch(result.pending, ctx.sessionManager.getBranch())) {
    reportIssue({
     key: "pending.branch-mismatch",
     message: "Prepared summary was for a different branch or context and was discarded. Pi's own compaction runs instead. No action needed.",
    }, ctx);
    return null;
   }
   return result.pending;
  }
  case "empty":
   return null;
  case "expired":
   reportIssue({
    key: "pending.expired",
    message: "Prepared summary expired after " + Math.round(result.ageMs / 1000) + "s and was discarded. Pi's own compaction runs instead. Run /smart-compact again if needed.",
   }, ctx);
   return null;
  case "mismatch":
   log.debug("Discarding pending smart compaction prepared for a different session");
   return null;
 }
}

export default function smartCompactExtension(pi: ExtensionAPI) {
 const PENDING_TTL_MS = FIVE_MINUTES_MS;
 // Encapsulated slot: producers call `.set(...)`, the event handler calls
 // `.consume(...)`. The lifecycle (set/consume/clear/expire/mismatch) lives
 // entirely inside the slot factory — see src/app/pending-slot.ts.
 const pendingRef: PendingSlot = createPendingSlot({ ttlMs: PENDING_TTL_MS });
 const isRunning = createSessionRunLock();
 let navigation: NavigationController;
 const pivotQueued = (ctx: ExtensionContext) => navigation?.isPending(ctx) ?? false;
 let preparationGeneration = 0;
 const damageMonitor = new OnlineDamageMonitor();
 const settledAutoTrigger = createSettledAutoTrigger();
 const policy = createSmartCompactPolicy(pi, () => toolExposure.apply());
 const toolExposure = createContextToolExposure(pi, { compactionAccess: () => policy.snapshot().agentToolAccess });
 const automaticConfig = () => {
  const config = loadConfig();
  return {
   ...config, autoTrigger: policy.isAutoTriggerEnabled(),
   showStatus: policy.branchOverrides().showStatus ?? config.showStatus
  };
 };
 const background = createBackgroundPreparation({
  async prepare(ctx, config, signal) {
   if (signal.aborted || isRunning.isSessionActive(resolveSessionId(ctx))) return null;
   const { sumModel, segModel, verifyModel } = resolveModels(ctx, undefined, config);
   if (!sumModel || !segModel || !verifyModel) return null;
   // A cancelled background run must never clear or replace a foreground payload.
   const localPending = createPendingSlot({ ttlMs: FIVE_MINUTES_MS });
   const outcome = await runSmartCompact({
    ctx, config, summaryModel: sumModel, segModel, verifyModel,
    mode: config.mode, profile: config.profile, autoTriggered: true,
    pendingRef: localPending, isRunning, abortSignal: signal,
    timeoutMs: Math.min(config.autoTriggerTimeoutMs, AUTO_TRIGGER_TIMEOUT_CAP_MS),
   });
   return outcome.kind === "staged" ? outcome.pending : null;
  },
 });
 const observeBackground = (ctx: ExtensionContext): void => {
  try {
   if (pivotQueued(ctx)) { background.cancel("session"); return; }
   if (pendingRef.isPresent(resolveSessionId(ctx))) { background.cancel("superseded"); return; }
   background.observe(ctx, automaticConfig());
  } catch (error) {
   background.cancel("cancelled");
   reportIssue({
    key: "background.observe",
    severity: "error",
    message: "Background preparation stopped (" + errorDetail(error) + "). Automatic compaction falls back to on-demand runs. Please report this if it repeats.",
    error,
   }, ctx);
  }
 };
 // Filesystem-backed, one-shot handoff survives extension reloads/process
 // restarts while project/session/branch scope prevents sibling leakage.
 const nativeContinuity = createNativeContinuityBridge();
 // Native engine: tools for the nested request, replay of stored native state.
 setNativeToolSource(() => {
  const active = new Set(pi.getActiveTools());
  return pi.getAllTools()
   .filter((tool) => active.has(tool.name))
   .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
 });
 registerAnchorCache(pi, { config: loadConfig });
 const nativeReplay = createNativeReplayHook();
 pi.on("before_provider_request", (event, ctx) => nativeReplay.handle(event.payload, ctx));
 const applyFailureWrites = new Map<string, Promise<boolean>>();
 const recordApplyFailure = (
  pending: PendingCompaction,
  reason: CommitDiscardReason,
 ): Promise<boolean> | null => {
  if (!pending.metricsSnapshot) return null;
  const cancelled = reason === "aborted" || reason === "shutdown";
  const write = appendMetricsSnapshot(pending.sessionId, {
   ...pending.metricsSnapshot,
   status: cancelled ? "cancelled" : "error",
   failureKind: cancelled
    ? "cancelled"
    : reason === "evicted"
     ? "internal"
     : "persistence",
   fallbackReason: "native-apply:" + reason,
  });
  applyFailureWrites.set(pending.runId, write);
  void write.finally(() => {
   if (applyFailureWrites.get(pending.runId) === write) {
    applyFailureWrites.delete(pending.runId);
   }
  });
  return write;
 };
 const commitCandidates = createCompactionCommitStore({
  ttlMs: loadConfig().pendingTtlMs,
  onDiscard: (pending, reason) => {
   void recordApplyFailure(pending, reason);
  },
 });
 const onNativeApplyError = (runId: string): boolean =>
  Boolean(commitCandidates.discard(runId, "apply-error"));
 const activateOnlineDamage = (pending: PendingCompaction): void => {
  if (!loadConfig().onlineDamageMonitor || !pending.projectId) return;
  damageMonitor.activate(
   pending.sessionId,
   pending.projectId,
   pending.details,
  );
 };
 const invalidateSession = (sessionId: string, reason: PreparationDiscardReason = "session"): void => {
  preparationGeneration++;
  background.cancel(reason);
  pendingRef.clear(sessionId);
  commitCandidates.clearSession(sessionId, "aborted");
 };
 const invalidatePreparation = (ctx: ExtensionContext, reason: PreparationDiscardReason = "session"): void =>
  invalidateSession(resolveSessionId(ctx), reason);
 const stageForNativeApply = (
  pending: PendingCompaction,
  signal: AbortSignal,
 ): boolean => {
  try {
   commitCandidates.stage(pending);
   const discardOnAbort = () => {
    commitCandidates.discard(pending.runId, "aborted");
   };
   if (signal.aborted) discardOnAbort();
   else signal.addEventListener("abort", discardOnAbort, { once: true });
   return !signal.aborted;
  } catch (error) {
   reportIssue({
    key: "apply.stage",
    severity: "error",
    message: "Could not stage the summary for apply (" + errorDetail(error) + "). Pi's own compaction runs instead. Please report this if it repeats.",
    error,
   });
   void recordApplyFailure(pending, "apply-error");
   return false;
  }
 };

 pi.on("context", (event, ctx) => {
  const config = loadConfig();
  if (!config.visualArchiveEnabled) return;
  try {
   const messages = injectVisualArchive(event.messages, ctx.sessionManager.getBranch(), ctx, true,
    new SecretScrubber(config.scrubSecrets, config.scrubPii));
   return messages === event.messages ? undefined : { messages };
  } catch (error) {
   reportIssue({
    key: "visual.context",
    message: "Visual archive could not be attached (" + errorDetail(error) + "). The text context is used unchanged. Disable visualArchiveEnabled if this repeats.",
    error,
   }, ctx);
  }
 });
 registerContextTools(pi);
 registerContextToolLoader(pi, toolExposure);
 navigation = registerNavigation(pi, {
  config: automaticConfig,
  mutationBlocked: ctx => isRunning.isSessionActive(resolveSessionId(ctx)) ? "Compaction is running; wait for it to finish." : undefined,
  onContextChange: ctx => invalidatePreparation(ctx, "branch"),
 });
 registerArtifactOffload(pi, automaticConfig, () => toolExposure.reachable("history"));
 const smartContext = registerSmartContextTool(pi, {
  config: automaticConfig,
  isPaused: pivotQueued,
  canAgentMutate: () => policy.snapshot().agentToolAccess !== "disabled",
  canAutoTrim: ctx => !background.hasWork() && !pendingRef.isPresent(resolveSessionId(ctx))
   && !isRunning.isSessionActive(resolveSessionId(ctx)),
  onContextChange: ctx => invalidatePreparation(ctx, "branch"),
 });

 registerSmartCompactCommand(pi, {
  pendingRef,
  runLock: isRunning,
  onNativeApplyError,
  policy,
  requestManualTrim: ctx => smartContext.requestManualTrim(ctx),
  navigation,
  toolSummary: () => toolExposure.summary(),
  getRuntimeState: ctx => ({
   running: isRunning.isRunning(resolveSessionId(ctx)),
   preparation: background.status(resolveSessionId(ctx)),
   paused: pivotQueued(ctx),
  }),
  onGlobalSettingsApplied(paths, ctx) {
   invalidatePreparation(ctx, "config");
   try {
    applyGlobalSettingsRuntime(paths, ctx, policy, toolExposure);
    navigation.refresh(ctx);
   } catch (error) {
    reportIssue({
     key: "settings.apply:" + paths.join(","),
     message: "Settings were saved but could not be applied live (" + errorDetail(error) + "). Start a new session to apply them.",
     error,
    }, ctx);
   }
  },
 });

 pi.on("session_start", (_event, ctx) => {
  nativeReplay.refresh(ctx);
  flushIssues(ctx);
  invalidatePreparation(ctx);
  toolExposure.atBoundary();
  policy.restore(ctx);
  navigation.refresh(ctx);
 });

 pi.on("session_tree", (_event, ctx) => {
  nativeReplay.refresh(ctx);
  invalidatePreparation(ctx);
  toolExposure.atBoundary();
  policy.restore(ctx);
  navigation.refresh(ctx);
 });
 pi.on("session_before_switch", (_event, ctx) => { invalidatePreparation(ctx); });
 pi.on("session_before_tree", (_event, ctx) => { invalidatePreparation(ctx); });
 pi.on("session_before_fork", (_event, ctx) => { invalidatePreparation(ctx); });
 pi.on("model_select", (_event, ctx) => { invalidatePreparation(ctx, "config"); });
 pi.on("turn_end", (event, ctx) => {
  flushIssues(ctx);
  if (event.entries?.some(entry => entry.type === "context_edit" || entry.type === "compaction")) background.cancel("branch");
  else observeBackground(ctx);
 });

 pi.on("agent_settled", async (_event, ctx) => {
  if (pivotQueued(ctx)) return;
  observeBackground(ctx);
  try {
   await settledAutoTrigger.request(ctx, automaticConfig());
  } catch (error) {
   reportIssue({
    key: "auto.settled",
    message: "Automatic compaction request failed (" + errorDetail(error) + "). Conversation unchanged. Run /smart-compact manually if context is high.",
    error,
   }, ctx);
  }
 });

 pi.on("session_before_compact", async (event, ctx) => {
  if (pivotQueued(ctx)) return { cancel: true };
  const config = automaticConfig();
  // Explicit instructions require a fresh summary, never a speculative one.
  if (event.customInstructions?.trim()) invalidatePreparation(ctx, "superseded");
  const generation = preparationGeneration;
  const prepared = background.take(ctx, config);
  const foreground = unwrapConsumed(pendingRef.consume(ctx), ctx);
  if (prepared && foreground) background.noteHandoffUnused(prepared.runId, "superseded");
  const candidate = foreground ?? prepared;
  const consumed = candidate && revalidatePending(candidate, ctx, event.preparation?.settings?.reserveTokens);
  if (!consumed && prepared && candidate === prepared) background.noteHandoffUnused(prepared.runId, "stale");
  if (consumed && stageForNativeApply(consumed, event.signal)) {
   return {
    compaction: {
     summary: consumed.summary,
     firstKeptEntryId: consumed.firstKeptEntryId,
     tokensBefore: consumed.tokensBefore,
     details: consumed.details,
    },
   };
  }
  if (!config.autoTrigger) return;
  try {
   const usage = ctx.getContextUsage();
   const totalTokens = usage?.tokens ?? 0;
   if (!totalTokens || totalTokens < MIN_TOKEN_THRESHOLD) return;
   // Threshold is advisory during overflow recovery: Pi already has a
   // rejected provider turn to rescue, even if model metadata understates
   // the backend's effective limit.
   const pct = safeContextPercent(totalTokens, ctx.model?.contextWindow);
   if (event.reason !== "overflow" && pct < config.minContextPercent) return;
   const cur = ctx.model;
   if (!cur) return;
   const { segModel, sumModel, verifyModel } = resolveModels(
    ctx,
    cur,
    config,
   );
   if (!sumModel) return;
   if (!isRunning.isRunning(resolveSessionId(ctx))) {
    const caps = getProviderCaps(sumModel.provider);
    const effectiveTimeoutMs = Math.min(
     AUTO_TRIGGER_TIMEOUT_CAP_MS,
     Math.round(config.autoTriggerTimeoutMs * caps.timeoutMultiplier),
    );

    // Outer hard timeout: providers occasionally ignore AbortSignal, so we
    // need a second line of defense that cannot be subverted from inside.
    // We hand a shared cancellation handle to runSmartCompact; firing it
    // sets `timedOut = true` on the run's context which propagates to:
    //   - every cancellation gate in run-smart-compact.ts (skips compact, clears pending),
    //   - the finally block (records a timeout metric, frees isRunning).
    // No Promise.race is needed: we await the run normally and let the
    // shared flag drive the bailout. This removes the race window where
    // the outer race resolved "timeout" while the inner pipeline was
    // still mid-applyCompaction.
    const cancellationOut: {
     value:
     | import("./app/run-smart-compact.ts").ExternalCancellation
     | null;
    } = { value: null };
    const timeoutId = setTimeout(() => {
     // Fires 100ms AFTER the inner deadline — this is the outer backstop
     // for providers that ignore AbortSignal, not the primary timeout.
     // The inner setTimeout in prepareRun (at effectiveTimeoutMs) is what
     // normally aborts the run; this one only acts when that abort was
     // swallowed.
     if (cancellationOut.value && !cancellationOut.value.timedOut) {
      reportIssue({
       key: "auto.hard-timeout",
       message: "Automatic compaction exceeded its " + Math.round(effectiveTimeoutMs / 1000) + "s limit and was stopped. Pi's own compaction runs instead. Raise autoTriggerTimeoutMs or use a faster summary model.",
      }, ctx);
      cancellationOut.value.abort();
     }
    }, effectiveTimeoutMs + 100);

    try {
     await runSmartCompact({
      ctx,
      summaryModel: sumModel,
      segModel: segModel ?? sumModel,
      verifyModel: verifyModel ?? sumModel,
      mode: config.mode,
      pendingRef,
      isRunning,
      onNativeApplyError,
      autoTriggered: true,
      userNote: event.customInstructions,
      overflowRecovery: event.reason === "overflow",
      timeoutMs: effectiveTimeoutMs,
      abortSignal: event.signal,
      cancellationOut,
     });
    } catch (err) {
     // runSmartCompact already reported the cause visibly (once per kind).
     log.debugError("Smart compact auto-trigger stopped", err);
    } finally {
     clearTimeout(timeoutId);
    }

    // If the outer timer fired, runSmartCompact's finally has already
    // cleared pendingRef. Falling through to native compact is the right
    // behavior — we don't need to re-check the timeout flag here.
    if (generation !== preparationGeneration || pivotQueued(ctx)) {
     pendingRef.clear(resolveSessionId(ctx));
     return { cancel: true };
    }
    const generated = unwrapConsumed(pendingRef.consume(ctx), ctx);
    const fresh = generated && revalidatePending(generated, ctx, event.preparation?.settings?.reserveTokens);
    if (fresh && stageForNativeApply(fresh, event.signal)) {
     return {
      compaction: {
       summary: fresh.summary,
       firstKeptEntryId: fresh.firstKeptEntryId,
       tokensBefore: fresh.tokensBefore,
       details: fresh.details,
      },
     };
    }
   }
  } catch (e) {
   reportIssue({
    key: "hook.before-compact",
    severity: "error",
    message: "Compaction hook failed (" + errorDetail(e) + "). Pi's own compaction runs instead. Please report this if it repeats.",
    error: e,
   }, ctx);
  }
 });

 pi.on("session_compact", async (event, ctx) => {
  const sessionId = resolveSessionId(ctx);
  settledAutoTrigger.noteCompaction(sessionId);
  background.noteCompaction(sessionId);
  if (event.fromExtension) {
   const details = event.compactionEntry.details as
    | { runId?: unknown }
    | undefined;
   const runId = typeof details?.runId === "string" ? details.runId : null;
   if (!runId) return; // another compaction extension
   const candidate = commitCandidates.take(runId, sessionId);
   if (!candidate) {
    clearCompactProgress(ctx);
    reportIssue({
     key: "apply.no-candidate",
     severity: "error",
     message: "Compaction was applied but its local records were missing, so continuity state and metrics were not saved. The conversation is compacted. Please report this if it repeats.",
    }, ctx);
    return;
   }
   try {
    const persistenceFailures = await commitAppliedCompaction(candidate);
    clearCompactProgress(ctx);
    notifyAppliedCompaction(
     ctx,
     candidate.details,
     candidate.metricsSnapshot?.runType !== "manual",
    );
    if (persistenceFailures.length) {
     reportIssue({
      key: "apply.persistence",
      message: "Compaction applied, but saving " + persistenceFailures.join(", ") + " failed. Recall/restore may miss this compaction. /smart-compact metrics lists the causes; check disk space and permissions.",
     }, ctx);
    }
    activateOnlineDamage(candidate);
   } catch (error) {
    clearCompactProgress(ctx);
    reportIssue({
     key: "apply.commit",
     severity: "error",
     message: "Compaction applied, but post-apply bookkeeping failed (" + errorDetail(error) + "). Continuity state and metrics may be missing. Please report this if it repeats.",
     error,
    }, ctx);
   }
   return;
  }
  if (isUnresolvedSessionId(sessionId)) return;
  const projectId = deriveProjectIdFromCwd(ctx.cwd);
  if (!projectId) return;
  const branchIds = branchEntryIds(
   ctx.sessionManager.getBranch() as Array<{ id?: string }>,
  );
  const branchHeadId =
   typeof event.compactionEntry.id === "string"
    ? event.compactionEntry.id
    : branchIds.at(-1);
  if (!branchHeadId) return;
  const state = loadScopedCompactionState(
   { projectId, sessionId },
   branchIds,
  );
  if (state)
   nativeContinuity.stage(
    { projectId, sessionId, branchHeadId },
    renderContinuityCapsule(state),
   );
 });

 pi.on("session_compact_failed", async (event, ctx) => {
  if (!event.fromExtension) return;
  const sessionId = resolveSessionId(ctx);
  clearCompactProgress(ctx);
  const reason: CommitDiscardReason = event.aborted ? "aborted" : "apply-error";
  const discarded = commitCandidates.clearSession(sessionId, reason);
  const metricWrites = discarded.flatMap((pending) => {
   const write = applyFailureWrites.get(pending.runId);
   return write ? [write] : [];
  });
  if (metricWrites.length > 0) await Promise.all(metricWrites);
  if (discarded.length > 0) {
   if (!event.aborted) {
    reportIssue({
     key: "apply.native-failure",
     message: "Pi could not apply the prepared summary" + (event.errorMessage ? " (" + errorDetail(event.errorMessage) + ")" : "") + ". Conversation unchanged. Run /smart-compact again.",
    }, ctx);
   }
  }
 });

 pi.on("before_agent_start", async (_event, ctx) => {
  flushIssues(ctx);
  const scope = resolveGraphScope(ctx);
  if (!scope?.branchHeadId) return;
  const content = nativeContinuity.take({
   projectId: scope.projectId,
   sessionId: scope.sessionId,
   branchHeadId: scope.branchHeadId,
  });
  if (!content) return;
  return {
   message: {
    customType: "smart-compact-native-continuity",
    content:
     "Native compaction continuity bridge (preserve these unresolved facts):\n\n" +
     content,
    display: false,
    details: {
     sessionId: scope.sessionId,
     branchHeadId: scope.branchHeadId,
    },
   },
  };
 });

 pi.on("message_end", async (event, ctx) => {
  try {
   const sessionId = resolveSessionId(ctx);
   const converted = convertToLlm([event.message as never])[0] as
    | import("./types.ts").LlmMessage
    | undefined;
   if (!converted) return;
   const observation = damageMonitor.observe(sessionId, converted);
   if (!observation) return;
   logDamageReport(
    sessionId,
    observation.report,
    observation.details,
    observation.projectId,
    "online-window",
   );
   if (observation.report.reReadFiles.length > 0) {
    writeRemediationHints(
     observation.projectId,
     observation.report.reReadFiles,
    );
   }
   if (observation.report.damageScore > 0) {
    notifyUser(ctx,
     "Post-compaction damage detected: " + observation.report.summary,
     "warning",
    );
   }
  } catch (error) {
   reportIssue({
    key: "damage.monitor",
    message: "Post-compaction damage check failed (" + errorDetail(error) + "). The conversation is unaffected; re-read hints may be missing.",
    error,
   }, ctx);
  }
 });

 pi.on("session_shutdown", async (_event, ctx) => {
  await background.shutdown();
  const sessionId = resolveSessionId(ctx);
  damageMonitor.clear(sessionId);
  pendingRef.clear(sessionId);
  commitCandidates.clearSession(sessionId, "shutdown");
  settledAutoTrigger.clear(sessionId);
  // Native continuity is deliberately not cleared here: shutdown/reload is
  // the process gap the branch-scoped filesystem handoff must survive.
 });

 registerSmartCompactTool(pi, {
  pendingRef,
  runLock: isRunning,
  onNativeApplyError,
  policy,
 });

 // Lazy tool exposure is re-decided only at boundaries; a compaction already
 // invalidates the prompt cache and may have indexed the first graph entries.
 pi.on("session_compact", (_event, ctx) => {
  nativeReplay.refresh(ctx);
  toolExposure.atBoundary();
  policy.restore(ctx);
  navigation.refresh(ctx);
 });
}
