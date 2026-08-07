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
import type { Cell } from "../types.ts";
import type { SessionRunLock } from "./session-run-lock.ts";
import { acquireRunLock, releaseRunLock } from "./session-run-lock.ts";
import { resolveSessionId } from "../infra/session-identity.ts";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { CompactionMode, CompressionProfile } from "../types.ts";
import { MODE_POLICIES, modeFromLegacyProfile, resolveMode } from "./mode-policy.ts";
import { clearCompactProgress, showProgressOverlay, showResultScreen } from "../ui/overlays.ts";
import * as log from "../utils/logger.ts";

import type {
  Notifier, RcBase, PendingRef, StatedRc,
} from "./run-context.ts";
import { markPhase } from "./run-context.ts";
import { createProductionServices } from "../infra/services.ts";
import { prepareRun } from "./steps/prepare.ts";
import { resolveCompactionWindow } from "./steps/window.ts";
import { recoverSessionLog } from "./steps/recover.ts";
import { selectTier } from "./steps/tier.ts";
import { extractWithCache } from "./steps/extract.ts";
import { summarizeConversation } from "./steps/synthesize.ts";
import { verifyAndPatch } from "./steps/verify.ts";
import { buildState } from "./steps/state.ts";
import { runDamageDetection, stagePendingCompaction, applyCompaction } from "./steps/persist.ts";
import { buildSuccessMetrics, recordSuccessMetrics, recordFailureMetrics } from "./steps/metrics.ts";

/**
 * Co-operative cancellation surface that the extension entry point can hand
 * back to itself to drive an *external* hard timeout.
 *
 * Setting `timedOut = true` and calling `abort()` from outside the pipeline
 * is the single source of truth for "give up on smart compaction and let Pi
 * run its native compact". The orchestrator notices the flag and:
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

/**
 * Build the Stage 0 context. Every subsequent field is added by a step;
 * see the stage chain in `run-context.ts`.
 */
function makeBase(opts: SmartCompactOptions): RcBase {
  const ctrl = new AbortController();
  const notify: Notifier = (msg, type = "info") => {
    if (opts.autoTriggered && (type === "info" || type === "success")) return;
    if (type === "info" && !opts.verbose) return; // live brief replaces routine toast spam
    opts.ctx.ui.notify(msg, type === "success" ? "info" : type);
  };
  const vlog = (msg: string) => { if (opts.verbose) log.info(msg); };
  const pipelineStart = Date.now();
  const requestedMode = opts.mode ?? modeFromLegacyProfile(opts.profile ?? "balanced");
  const contextPercent = opts.ctx.getContextUsage()?.percent ?? 0;
  const mode = resolveMode(requestedMode, contextPercent);
  const profile = opts.mode ? MODE_POLICIES[mode].profile : (opts.profile ?? MODE_POLICIES[mode].profile);
  return {
    runId: randomUUID(),
    ctx: opts.ctx,
    config: opts.config,
    notify,
    vlog,
    services: createProductionServices(),
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

export async function runSmartCompact(opts: SmartCompactOptions): Promise<void> {
  if (!opts.summaryModel || !opts.segModel) {
    if (!opts.autoTriggered) opts.ctx.ui.notify("Model resolve failed", "error");
    return;
  }
  const runSessionId = resolveSessionId(opts.ctx);
  if (!acquireRunLock(opts.isRunning, runSessionId)) {
    if (!opts.autoTriggered) opts.ctx.ui.notify("Smart compact is already running for this session.", "warning");
    return;
  }

  const base = makeBase(opts);
  const abortFromHost = () => {
    base.cancellation.timedOut = true;
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
  let failureSummaryFields: {
    sessionId?: string; tier?: string; contextPercent?: number; toolPercent?: number;
    totalTokens?: number; methodForMetrics?: string; profile: string; mode?: CompactionMode;
  } = { profile: base.profile, mode: base.mode };

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
    if (base.cancellation.signal.aborted) return;
    const prepared = await prepareRun(base);
    if (!prepared) return;

    base.notify(
      "EESV Compact (" + base.modelLabel + ", " + base.mode + ") — " +
        ((base.ctx.getContextUsage()?.tokens ?? 0)).toLocaleString() + "t",
      "info",
    );

    const windowed = resolveCompactionWindow(prepared);
    if (!windowed) return;
    failureSummaryFields = {
      ...failureSummaryFields,
      sessionId: windowed.sessionId,
      contextPercent: windowed.contextPercent,
      totalTokens: windowed.totalTokens,
    };
    markPhase(windowed, "prepare");

    if (!windowed.flags.autoTriggered) {
      showProgressOverlay(windowed.ctx, {
        phase: 1, phaseName: "Extract",
        detail: "Indexing goals, files, decisions, errors, and open loops",
        model: windowed.modelLabel, profile: windowed.profile,
      });
    }

    const recovered = recoverSessionLog(windowed);
    markPhase(recovered, "recover");

    const tiered = selectTier(recovered);
    if (!tiered) return;
    failureSummaryFields = { ...failureSummaryFields, tier: tiered.tier, toolPercent: tiered.toolPercent };

    const extracted = extractWithCache(tiered);

    const synthesized = await summarizeConversation(extracted);
    failureSummaryFields = {
      ...failureSummaryFields,
      methodForMetrics: synthesized.methodForMetrics,
      mode: synthesized.mode,
      profile: synthesized.profile,
    };

    const verified = await verifyAndPatch(synthesized);
    markPhase(verified, "verify");

    const stated = buildState(verified);
    finalRc = stated;

    stated.vlog(
      "Pipeline complete — method=" + stated.method + " calls=" + stated.llmCalls +
        " chunks=" + stated.chunkCount + " tokensSaved=" + stated.tokensSaved,
    );
    markPhase(stated, "state");

    if (stated.flags.dryRun) {
      recordSuccessMetrics(stated, "dry-run");
      stated.ctx.ui.notify(
        "DRY RUN (" + stated.method + ", " + stated.mode + ") — " +
          stated.toCompact.length + " msgs, " + stated.llmCalls + " calls",
        "info",
      );
      return;
    }

    // Auto-trigger may have hard-timed-out while we were still running. In
    // that case Pi has already moved on to its native compact and we must
    // skip every side effect (no pending, no state writes, no apply).
    if (stated.cancellation.timedOut) return;

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
          ? await showResultScreen(stated.ctx, stated.details, stated.extraction, stated.services, { approval: true })
          : "cancel";
      } catch (err) {
        log.debugError("Approval UI stopped", err);
        stated.notify("Approval UI failed — compaction cancelled", "warning");
      }
      if (decision !== "apply") {
        stated.pendingRef.clear(stated.sessionId);
        recordSuccessMetrics(stated, "cancelled");
        stated.ctx.ui.notify("Compaction cancelled — current conversation unchanged", "info");
        return;
      }
    }

    // One last cancellation gate before staging anything the host could use.
    if (stated.cancellation.timedOut) return;

    // Snapshot telemetry now, but append it only after session_compact proves
    // Pi applied this exact runId. This prevents failed native compactions
    // from being reported or persisted as successful.
    if (willApply) {
      showProgressOverlay(stated.ctx, {
        phase: 5, phaseName: "Apply",
        detail: "Verified " + stated.verificationScore + "/100 · staging this run · awaiting Pi confirmation",
      });
    }
    stagePendingCompaction(stated, buildSuccessMetrics(stated, "success"));
    if (stated.cancellation.timedOut) {
      stated.pendingRef.clear(stated.sessionId);
      return;
    }

    if (willApply) {
      applyCompaction(stated);
      keepApplyProgress = true;
    }
  } catch (err) {
    runFailed = true;
    // The failure path may run before any step has populated stage data, so
    // we collect the few fields we need into a small bag. recordFailureMetrics
    // takes either a StatedRc (best case) or the partial bag.
    recordFailureMetrics(finalRc ?? base, err, failureSummaryFields);
    throw err;
  } finally {
    opts.abortSignal?.removeEventListener("abort", abortFromHost);
    if (base.cancellation.timeoutId) clearTimeout(base.cancellation.timeoutId);
    releaseRunLock(opts.isRunning, runSessionId);
    if (!keepApplyProgress) clearCompactProgress(base.ctx);
    // If the timeout fired we always clear the pending summary so a stale
    // payload cannot be picked up by the next session_before_compact event.
    if (base.cancellation.timedOut) {
      base.pendingRef.clear(runSessionId);
    }
    const pipelineMs = Date.now() - base.pipelineStart;
    if (base.flags.autoTriggered && !base.cancellation.timedOut) {
      // Auto-trigger only prepares the summary; the native compact runs
      // afterwards from `session_before_compact`. The previous wording
      // ("Compaction completed in...") was misleading because the actual
      // apply step hadn't run yet at this point. Use "prepared" to match
      // the lifecycle a user actually sees (an `Applied ✓` toast follows
      // when Pi confirms the compact).
      const dur = pipelineMs < 1000 ? pipelineMs + "ms" : (pipelineMs / 1000).toFixed(1) + "s";
      const hasPending = base.pendingRef.isPresent(runSessionId);
      if (hasPending || runFailed || finalRc) base.ctx.ui.notify(
        hasPending
          ? "Smart compact prepared in " + dur + " — awaiting native /compact"
          : runFailed
            ? "Smart compact stopped safely in " + dur + " · no summary applied · Pi fallback continues"
            : "Smart compact run finished in " + dur,
        runFailed ? "warning" : "info",
      );
    }
  }
}
