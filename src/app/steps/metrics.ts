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
import {
  appendMetricsLog, getMetricsSummary, getExtractionCacheStats,
  effectivePromptInputTokens,
} from "../../utils/cache.ts";

function runType(rc: RcBase): "manual" | "auto" | "tool" {
  return rc.flags.skipCompact ? "tool" : rc.flags.autoTriggered ? "auto" : "manual";
}

export function recordSuccessMetrics(rc: StatedRc, status: "success" | "dry-run"): void {
  const ecs = getExtractionCacheStats(rc.services);
  appendMetricsLog(rc.sessionId, {
    profile: rc.profile, tier: rc.tier,
    contextPercent: Math.round(rc.contextPercent),
    toolPercent: rc.toolPercent,
    tokensBefore: rc.totalTokens,
    tokensSaved: rc.tokensSaved,
    pruneSavedTokens: rc.pruning?.prunedTokenSaving,
    chunkCount: rc.chunkCount || 1,
    verificationScore: rc.verificationScore,
    verificationGaps: rc.verificationGaps.length,
    method: rc.method,
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
  }, rc.services);

  const ms = getMetricsSummary(rc.services);
  if (status === "success" && ms.totalCalls > 0) {
    const providerCacheRate = Math.round(ms.cacheHitRate * 100);
    const extractionCacheRate = Math.round(ecs.hitRate * 100);
    const promptInput = effectivePromptInputTokens(ms.totalInput, ms.totalCacheHit);
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
}

export function recordFailureMetrics(
  rc: RcBase | StatedRc,
  err: unknown,
  fields: FailureSummaryFields,
): void {
  appendMetricsLog(fields.sessionId ?? "unknown", {
    profile: fields.profile,
    tier: fields.tier,
    contextPercent: fields.contextPercent != null ? Math.round(fields.contextPercent) : undefined,
    toolPercent: fields.toolPercent,
    tokensBefore: fields.totalTokens,
    method: fields.methodForMetrics,
    model: rc.modelLabel,
    provider: rc.summaryModel.provider,
    runType: runType(rc),
    status: rc.cancellation.timedOut ? "timeout" : "error",
    fallbackReason: err instanceof Error ? err.message : String(err),
    phaseTimings: rc.phaseTimings,
    durationMs: Date.now() - rc.pipelineStart,
  }, rc.services);
}
