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
import type { PendingCompaction } from "./types.ts";
import {
  MIN_TOKEN_THRESHOLD,
  FIVE_MINUTES_MS,
  AUTO_TRIGGER_MAX_LLM_CALLS,
  AUTO_TRIGGER_TIMEOUT_CAP_MS,
} from "./constants.ts";
import { loadConfig } from "./utils/config.ts";
import { getProviderCaps, safeContextPercent } from "./utils/tokens.ts";
import { appendMetricsSnapshot } from "./utils/cache.ts";
import { runSmartCompact } from "./app/run-smart-compact.ts";
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
import * as log from "./utils/logger.ts";
import { deriveProjectIdFromCwd } from "./utils/fingerprint.ts";
import {
  loadScopedCompactionState,
  renderContinuityCapsule,
} from "./utils/state.ts";
import { createNativeContinuityBridge } from "./app/native-continuity-bridge.ts";
import { createSettledAutoTrigger } from "./app/settled-auto-trigger.ts";
import {
  registerContextTools,
  resolveGraphScope,
} from "./app/register-context-tools.ts";
import { resolveModels } from "./app/model-routing.ts";
import { registerSmartCompactTool } from "./app/register-smart-compact-tool.ts";
import { registerSmartCompactCommand } from "./app/register-smart-compact-command.ts";
import { createSmartCompactPolicy } from "./app/smart-compact-policy.ts";

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
      const activeEntryIds = new Set(
        branchEntryIds(
          ctx.sessionManager.getBranch() as Array<{ id?: unknown }>,
        ),
      );
      if (
        !activeEntryIds.has(result.pending.originBranchHeadId) ||
        !activeEntryIds.has(result.pending.firstKeptEntryId)
      ) {
        log.warn(
          "Discarding pending smart compaction prepared for a divergent branch",
        );
        ctx.ui.notify(
          "Divergent-branch pending smart compaction discarded",
          "warning",
        );
        return null;
      }
      return result.pending;
    }
    case "empty":
      return null;
    case "expired":
      log.warn(
        "Discarding expired pending smart compaction after " +
          Math.round(result.ageMs / 1000) +
          "s",
      );
      ctx.ui.notify("Expired pending smart compaction discarded", "warning");
      return null;
    case "mismatch":
      log.warn(
        "Discarding pending smart compaction prepared for a different session (" +
          result.expected +
          " vs " +
          result.actual +
          ")",
      );
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
  const damageMonitor = new OnlineDamageMonitor();
  const settledAutoTrigger = createSettledAutoTrigger();
  const policy = createSmartCompactPolicy(pi);
  // Filesystem-backed, one-shot handoff survives extension reloads/process
  // restarts while project/session/branch scope prevents sibling leakage.
  const nativeContinuity = createNativeContinuityBridge();
  const recordApplyFailure = (
    pending: PendingCompaction,
    reason: CommitDiscardReason,
  ): void => {
    if (!pending.metricsSnapshot) return;
    const cancelled = reason === "aborted" || reason === "shutdown";
    void appendMetricsSnapshot(pending.sessionId, {
      ...pending.metricsSnapshot,
      status: cancelled ? "cancelled" : "error",
      failureKind: cancelled
        ? "cancelled"
        : reason === "evicted"
          ? "internal"
          : "persistence",
      fallbackReason: "native-apply:" + reason,
    });
  };
  const commitCandidates = createCompactionCommitStore({
    onDiscard: recordApplyFailure,
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
      log.warn("Failed to stage smart compaction commit candidate", error);
      recordApplyFailure(pending, "apply-error");
      return false;
    }
  };

  registerContextTools(pi);

  registerSmartCompactCommand(pi, {
    pendingRef,
    runLock: isRunning,
    onNativeApplyError,
    policy,
  });

  pi.on("session_start", (_event, ctx) => {
    policy.restore(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    policy.restore(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!policy.isAutoTriggerEnabled()) return;
    try {
      await settledAutoTrigger.request(ctx, {
        ...loadConfig(),
        autoTrigger: true,
      });
    } catch (error) {
      log.debugError("Settled smart compact trigger stopped", error);
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const consumed = unwrapConsumed(pendingRef.consume(ctx), ctx);
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
    const config = loadConfig();
    if (!policy.isAutoTriggerEnabled()) return;
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
            log.warn(
              "Smart compact auto-trigger hard timeout after " +
                effectiveTimeoutMs +
                "ms",
            );
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
            overflowRecovery: event.reason === "overflow",
            maxLlmCalls: Math.min(
              config.maxLlmCalls,
              AUTO_TRIGGER_MAX_LLM_CALLS,
            ),
            timeoutMs: effectiveTimeoutMs,
            abortSignal: event.signal,
            cancellationOut,
          });
        } catch (err) {
          log.debugError("Smart compact auto-trigger stopped", err);
        } finally {
          clearTimeout(timeoutId);
        }

        // If the outer timer fired, runSmartCompact's finally has already
        // cleared pendingRef. Falling through to native compact is the right
        // behavior — we don't need to re-check the timeout flag here.
        const fresh = unwrapConsumed(pendingRef.consume(ctx), ctx);
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
      log.debugError("session_before_compact stopped", e);
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    settledAutoTrigger.noteCompaction(sessionId);
    if (event.fromExtension) {
      const details = event.compactionEntry.details as
        | { runId?: unknown }
        | undefined;
      const runId = typeof details?.runId === "string" ? details.runId : null;
      if (!runId) return; // another compaction extension
      const candidate = commitCandidates.take(runId, sessionId);
      if (!candidate) {
        clearCompactProgress(ctx);
        log.warn(
          "Applied smart compaction had no matching staged candidate: " + runId,
        );
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
          ctx.ui.notify(
            "Compaction applied, but durable persistence was incomplete: " +
              persistenceFailures.join(", "),
            "warning",
          );
        }
        activateOnlineDamage(candidate);
      } catch (error) {
        clearCompactProgress(ctx);
        log.warn("Failed to commit applied smart compaction", error);
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

  pi.on("before_agent_start", async (_event, ctx) => {
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
        ctx.ui.notify(
          "Post-compaction damage detected: " + observation.report.summary,
          "warning",
        );
      }
    } catch (error) {
      log.warn("online damage monitor message_end failed", error);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
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
}
