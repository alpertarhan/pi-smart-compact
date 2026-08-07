/**
 * Step 10: record metrics for the run.
 *
 * Two paths:
 *
 *   - `recordSuccessMetrics(rc: StatedRc, status)` runs after a full pipeline
 *     completion. Every field on the metric record is statically known.
 *
 *   - `recordFailureMetrics(rc, err, fields)` runs from the catch block in
 *     the orchestrator and may execute before the pipeline ever populated
 *     stage data. The `fields` bag carries whatever the orchestrator managed
 *     to collect before the throw; missing values fall through to undefined.
 *
 * Metrics writes are intentionally append-only and idempotent — they target
 * the JSONL log and never throw past the cache.ts boundary.
 */

import type { RcBase, StatedRc } from "../run-context.ts";
import type { MetricsSnapshot } from "../../types.ts";
import { aggregateProviderRoutes } from "../../domain/provider-evaluation.ts";
import { classifyTelemetryFailure } from "../../domain/telemetry.ts";
import { VERSION } from "../../constants.ts";
import { loadConfig } from "../../utils/helpers.ts";
import {
  appendMetricsLog, appendMetricsSnapshot, getMetricsSummary, getExtractionCacheStats,
  effectivePromptInputTokens,
} from "../../utils/cache.ts";

function runType(rc: RcBase): "manual" | "auto" | "tool" {
  return rc.flags.skipCompact ? "tool" : rc.flags.autoTriggered ? "auto" : "manual";
}

function providerRoutesWithQuality(rc: StatedRc) {
  const routes = aggregateProviderRoutes(rc.services.metrics.snapshot());
  const synthesisRoutes = routes.filter(route => route.stage === "synthesize" && route.successes > 0);
  const initialScore = rc.verificationProvenance?.initialScore;
  if (synthesisRoutes.length !== 1 || typeof initialScore !== "number" || !Number.isFinite(initialScore)) return routes;
  return routes.map(route => route === synthesisRoutes[0] ? {
    ...route,
    qualityScore: Math.max(0, Math.min(100, initialScore)),
    qualityBasis: "pre-repair-verification" as const,
  } : route);
}

export function buildSuccessMetrics(
  rc: StatedRc,
  status: "success" | "dry-run" | "cancelled",
): MetricsSnapshot {
  const ecs = getExtractionCacheStats(rc.services);
  return {
    ...getMetricsSummary(rc.services),
    runId: rc.runId,
    metricsSchemaVersion: 2,
    version: VERSION,
    releaseChannel: rc.config?.telemetryChannel ?? loadConfig().telemetryChannel,
    providerRoutes: providerRoutesWithQuality(rc),
    profile: rc.profile, mode: rc.mode, tier: rc.tier,
    contextPercent: Math.round(rc.contextPercent),
    toolPercent: rc.toolPercent,
    tokensBefore: rc.totalTokens,
    tokensSaved: rc.tokensSaved,
    pruneSavedTokens: rc.pruning?.prunedTokenSaving,
    chunkCount: rc.chunkCount || 1,
    verificationScore: rc.verificationScore,
    verificationGaps: rc.verificationGaps.length,
    initialVerificationScore: rc.verificationProvenance?.initialScore ?? rc.verificationScore,
    deterministicPatchCount: rc.verificationProvenance?.deterministicPatched.length ?? 0,
    llmPatched: rc.verificationProvenance?.llmPatched ?? false,
    qualityFloorUsed: rc.verificationProvenance?.qualityFloorUsed ?? false,
    remainingVerificationGaps: rc.verificationProvenance?.remainingGaps.length ?? rc.verificationGaps.length,
    method: rc.methodForMetrics,
    model: rc.modelLabel,
    provider: rc.summaryModel.provider,
    runType: runType(rc),
    status,
    phaseTimings: rc.phaseTimings,
    durationMs: Date.now() - rc.pipelineStart,
    extractionCacheHits: ecs.hits,
    extractionCacheMisses: ecs.misses,
    extractionCacheHitRate: ecs.hitRate,
    extractionCacheMissReason: rc.extractionCacheMissReason,
    fallbackReason: rc.services.budget.reason() ? "budget-" + rc.services.budget.reason() : undefined,
    redactions: rc.services.scrubber.count(),
    adapted: rc.adapted,
  };
}

export function recordSuccessMetrics(rc: StatedRc, status: "success" | "dry-run" | "cancelled"): void {
  appendMetricsSnapshot(rc.sessionId, buildSuccessMetrics(rc, status));
  const ecs = getExtractionCacheStats(rc.services);
  const ms = getMetricsSummary(rc.services);
  if (status === "success" && ms.totalCalls > 0) {
    const providerCacheRate = Math.round(ms.cacheHitRate * 100);
    const extractionCacheRate = Math.round(ecs.hitRate * 100);
    const promptInput = effectivePromptInputTokens(ms.totalInput, ms.totalCacheHit, ms.totalCacheWrite);
    const inputLabel = ms.totalCacheHit > 0
      ? promptInput + "t prompt (" + ms.totalInput + "t new, " + ms.totalCacheHit + "t cached)"
      : ms.totalInput + "t in";
    rc.notify(
      "Metrics: " + ms.totalCalls + " calls, " + inputLabel + ", " + ms.totalOutput +
        "t out, provider-cache " + providerCacheRate + "% (internal phases disabled), extraction-cache " +
        extractionCacheRate + "%, " + ms.avgLatency + "ms avg",
      "info",
    );
  }
}

/**
 * Partial summary that the orchestrator accumulates as steps complete. The
 * failure path uses whatever is present at the moment of the throw.
 */
export interface FailureSummaryFields {
  sessionId?: string;
  tier?: string;
  contextPercent?: number;
  toolPercent?: number;
  totalTokens?: number;
  methodForMetrics?: string;
  profile: string;
  mode?: import("../../types.ts").CompactionMode;
}

export function recordFailureMetrics(
  rc: RcBase | StatedRc,
  err: unknown,
  fields: FailureSummaryFields,
): void {
  const releaseChannel = (rc as RcBase & { config?: { telemetryChannel?: "stable" | "canary" } }).config?.telemetryChannel
    ?? loadConfig().telemetryChannel;
  const failureKind = classifyTelemetryFailure(err, rc.cancellation.timedOut);
  appendMetricsLog(fields.sessionId ?? "unknown", {
    runId: rc.runId,
    metricsSchemaVersion: 2,
    version: VERSION,
    releaseChannel,
    failureKind,
    providerRoutes: aggregateProviderRoutes(rc.services.metrics.snapshot()),
    profile: fields.profile,
    mode: fields.mode,
    tier: fields.tier,
    contextPercent: fields.contextPercent != null ? Math.round(fields.contextPercent) : undefined,
    toolPercent: fields.toolPercent,
    tokensBefore: fields.totalTokens,
    method: fields.methodForMetrics,
    model: rc.modelLabel,
    provider: rc.summaryModel.provider,
    runType: runType(rc),
    status: rc.cancellation.timedOut ? "timeout" : "error",
    fallbackReason: "failure:" + failureKind,
    phaseTimings: rc.phaseTimings,
    durationMs: Date.now() - rc.pipelineStart,
  }, rc.services);
}
