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

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { CompressionProfile } from "../types.ts";
import { resetMetrics, resetExtractionCacheStats } from "../utils/cache.ts";
import { resetCompactSessionId } from "../utils/cache.ts";
import { showResultScreen } from "../ui/overlays.ts";
import * as log from "../utils/logger.ts";

import type {
  Notifier, RcBase, PendingRef, StatedRc,
} from "./run-context.ts";
import { markPhase } from "./run-context.ts";
import { getDefaultServices } from "../infra/services.ts";
import { prepareRun } from "./steps/prepare.ts";
import { resolveCompactionWindow } from "./steps/window.ts";
import { recoverSessionLog } from "./steps/recover.ts";
import { selectTier } from "./steps/tier.ts";
import { extractWithCache } from "./steps/extract.ts";
import { summarizeConversation } from "./steps/synthesize.ts";
import { verifyAndPatch } from "./steps/verify.ts";
import { buildState } from "./steps/state.ts";
import { runDamageDetection, stagePendingCompaction, applyCompaction } from "./steps/persist.ts";
import { recordSuccessMetrics, recordFailureMetrics } from "./steps/metrics.ts";

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
  ctx: ExtensionCommandContext;
  summaryModel: Model<Api>;
  segModel: Model<Api>;
  profile: CompressionProfile;
  verbose?: boolean;
  dryRun?: boolean;
  pendingRef: PendingRef;
  isRunning: { value: boolean };
  autoTriggered?: boolean;
  userNote?: string;
  skipCompact?: boolean;
  /** Explicit user command may bypass adaptive context-pressure tier gate. */
  force?: boolean;
  /** Optional hard budget for native auto-trigger only. Manual/tool runs do not time out by default. */
  timeoutMs?: number;
  /**
   * If provided, populated with the run's cancellation handle before any
   * async work begins. The session_before_compact hook uses this to enforce
   * its own hard timeout in addition to the in-pipeline one (some providers
   * ignore AbortSignal entirely).
   */
  cancellationOut?: { value: ExternalCancellation | null };
}

/**
 * Build the Stage 0 context. Every subsequent field is added by a step;
 * see the stage chain in `run-context.ts`.
 */
function makeBase(opts: SmartCompactOptions): RcBase {
  const ctrl = new AbortController();
  const notify: Notifier = (msg, type = "info") => {
    opts.ctx.ui.notify(msg, type === "success" ? "info" : type);
  };
  const vlog = (msg: string) => { if (opts.verbose) log.info(msg); };
  const pipelineStart = Date.now();
  return {
    ctx: opts.ctx,
    notify,
    vlog,
    services: getDefaultServices(),
    cancellation: { controller: ctrl, signal: ctrl.signal, timedOut: false, timeoutId: null },
    pendingRef: opts.pendingRef,
    isRunning: opts.isRunning,
    flags: {
      verbose: !!opts.verbose,
      dryRun: !!opts.dryRun,
      autoTriggered: !!opts.autoTriggered,
      skipCompact: !!opts.skipCompact,
      force: !!opts.force,
    },
    userNote: opts.userNote,
    timeoutMs: opts.timeoutMs ?? 0,
    phaseTimings: [],
    pipelineStart,
    phaseStart: pipelineStart,
    summaryModel: opts.summaryModel,
    segModel: opts.segModel,
    modelLabel: opts.summaryModel ? opts.summaryModel.provider + "/" + opts.summaryModel.id : "unknown",
    profile: opts.profile,
  };
}

export async function runSmartCompact(opts: SmartCompactOptions): Promise<void> {
  if (opts.isRunning.value) return;
  if (!opts.summaryModel || !opts.segModel) {
    if (!opts.autoTriggered) opts.ctx.ui.notify("Model resolve failed", "error");
    return;
  }
  opts.isRunning.value = true;

  resetCompactSessionId();
  resetMetrics();
  resetExtractionCacheStats();

  const base = makeBase(opts);
  // Late-bound StatedRc reference so the finally block can record failure
  // metrics. We populate it as soon as buildState returns; until then it's
  // null and the failure path uses `base` only.
  let finalRc: StatedRc | null = null;
  let failureSummaryFields: {
    sessionId?: string; tier?: string; contextPercent?: number; toolPercent?: number;
    totalTokens?: number; methodForMetrics?: string; profile: string;
  } = { profile: opts.profile };

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
    const prepared = await prepareRun(base);
    if (!prepared) return;

    base.notify(
      "EESV Compact (" + base.modelLabel + ", " + base.profile + ") — " +
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
      // Lazy import to avoid an early UI dependency for headless tests.
      const { showProgressOverlay } = await import("../ui/overlays.ts");
      showProgressOverlay(windowed.ctx, { phase: 1, phaseName: "Extract", detail: "Preparing...", model: windowed.modelLabel, profile: windowed.profile });
    }

    const recovered = recoverSessionLog(windowed);
    markPhase(recovered, "recover");

    const tiered = selectTier(recovered);
    if (!tiered) return;
    failureSummaryFields = { ...failureSummaryFields, tier: tiered.tier, toolPercent: tiered.toolPercent };

    const extracted = extractWithCache(tiered);
    markPhase(extracted, "prune");
    markPhase(extracted, "extract");

    const synthesized = await summarizeConversation(extracted);
    if (synthesized.method === "single-pass" || synthesized.method === "heuristic") {
      markPhase(synthesized, "explore");
    }
    markPhase(synthesized, "synthesize");
    failureSummaryFields = { ...failureSummaryFields, methodForMetrics: synthesized.methodForMetrics };

    const verified = await verifyAndPatch(synthesized);
    markPhase(verified, "verify");

    const stated = buildState(verified);
    finalRc = stated;

    stated.notify(
      "Done: " + describePipeline(stated) +
        " — saved " + stated.tokensSaved.toLocaleString() + "t (" + duration(stated) + ")",
      "success",
    );
    stated.vlog(
      "Pipeline complete — method=" + stated.method + " calls=" + stated.llmCalls +
        " chunks=" + stated.chunkCount + " tokensSaved=" + stated.tokensSaved,
    );
    markPhase(stated, "state");

    if (stated.flags.dryRun) {
      recordSuccessMetrics(stated, "dry-run");
      stated.notify(
        "DRY RUN (" + stated.method + ", " + stated.profile + ") — " +
          stated.toCompact.length + " msgs, " + stated.llmCalls + " calls",
        "info",
      );
      return;
    }

    // Auto-trigger may have hard-timed-out while we were still running. In
    // that case Pi has already moved on to its native compact and we must
    // skip every side effect (no pending, no state writes, no apply).
    if (stated.cancellation.timedOut) return;

    stagePendingCompaction(stated);

    // Re-check after staging in case the external timeout fired between
    // verify and persist. We don't want a late-arriving cancellation to leave
    // a fresh pendingRef alive after the caller has already given up on us.
    if (stated.cancellation.timedOut) {
      stated.pendingRef.value = null;
      stated.pendingRef.createdAt = 0;
      return;
    }

    // Damage detection runs in best-effort mode against the existing branch's
    // previous compaction. Cheap to run, useful for the metrics dashboard.
    runDamageDetection(stated);
    markPhase(stated, "damage");

    recordSuccessMetrics(stated, "success");

    if (!stated.flags.autoTriggered) {
      try {
        const timeoutPromise = new Promise<void>(resolve => setTimeout(resolve, 5000));
        await Promise.race([showResultScreen(stated.ctx, stated.details, stated.extraction), timeoutPromise]);
      } catch (err) {
        log.warn("Result screen error", err);
        stated.notify("Result screen skipped", "info");
      }
    }

    // One last cancellation gate before we touch Pi's native compact. If the
    // outer timeout fired during damage detection or metric writes, calling
    // ctx.compact() now would attempt to apply a payload Pi has already
    // decided to bypass.
    if (stated.cancellation.timedOut) {
      stated.pendingRef.value = null;
      stated.pendingRef.createdAt = 0;
      return;
    }

    applyCompaction(stated);
  } catch (err) {
    // The failure path may run before any step has populated stage data, so
    // we collect the few fields we need into a small bag. recordFailureMetrics
    // takes either a StatedRc (best case) or the partial bag.
    recordFailureMetrics(finalRc ?? base, err, failureSummaryFields);
    throw err;
  } finally {
    if (base.cancellation.timeoutId) clearTimeout(base.cancellation.timeoutId);
    opts.isRunning.value = false;
    // If the timeout fired we always clear the pending summary so a stale
    // payload cannot be picked up by the next session_before_compact event.
    if (base.cancellation.timedOut) {
      base.pendingRef.value = null;
      base.pendingRef.createdAt = 0;
    }
    const pipelineMs = Date.now() - base.pipelineStart;
    if (base.flags.autoTriggered && !base.cancellation.timedOut) {
      base.ctx.ui.notify(
        "Compaction completed in " +
          (pipelineMs < 1000 ? pipelineMs + "ms" : (pipelineMs / 1000).toFixed(1) + "s"),
        "info",
      );
    }
  }
}

function describePipeline(rc: StatedRc): string {
  if (rc.method === "eesv") {
    return "EESV: Extract > Explore (" + rc.explorationRounds + "r) > Synthesize (" +
      (rc.chunkCount || 1) + " chunks) > Verify (" +
      (rc.verified ? "pass" : rc.verificationGaps.length + " gaps") + ")";
  }
  return rc.method + " (" + (rc.chunkCount || 1) + " chunks, " + rc.llmCalls + " calls)";
}

function duration(rc: StatedRc): string {
  const pipelineMs = Date.now() - rc.pipelineStart;
  return pipelineMs < 1000 ? pipelineMs + "ms" : (pipelineMs / 1000).toFixed(1) + "s";
}
