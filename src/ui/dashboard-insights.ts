import { VERSION } from "../constants.ts";
import { assessCanary, type CanaryAssessment, type DamageTelemetryEntry } from "../domain/telemetry.ts";
import type { CompactMetricsEntry, ProviderRouteMetric, ProviderRouteStage, TelemetryFailureKind } from "../types.ts";
import { metricDuration } from "./dashboard-format.ts";

export interface DashboardDataConfidence {
  score: number;
  label: "high" | "medium" | "low";
  targetMet: boolean;
  sampleScore: number;
  schemaScore: number;
  qualityScore: number;
  completenessScore: number;
  freshnessScore: number;
  guidance: string[];
}

export interface DashboardQualityInsight {
  /** Actual outcome health; separate from telemetry completeness confidence. */
  healthScore: number;
  healthLabel: "healthy" | "degraded" | "critical";
  targetMet: boolean;
  measuredRuns: number;
  missingRuns: number;
  average: number | null;
  median: number | null;
  minimum: number | null;
  excellent: number;
  passing: number;
  low: number;
  averageInitial: number | null;
  averageRepairGain: number | null;
  deterministicPatchedRuns: number;
  llmPatchedRuns: number;
  qualityFloorRuns: number;
  remainingGaps: number;
}

export interface DashboardProviderInsight {
  stage: ProviderRouteStage;
  provider: string;
  model: string;
  runs: number;
  calls: number;
  reliability: number;
  avgQuality: number | null;
  qualityCoverage: number;
  avgLatencyMs: number;
  avgTokensPerCall: number;
}

export interface DashboardInsights {
  confidence: DashboardDataConfidence;
  quality: DashboardQualityInsight;
  providers: DashboardProviderInsight[];
  canary: CanaryAssessment;
  failures: Partial<Record<TelemetryFailureKind, number>>;
}

function safeLabel(value: unknown): string | null {
  return typeof value === "string" && /^[\w./:@+-]{1,160}$/.test(value) ? value : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function calculateDashboardDataConfidence(
  entries: readonly CompactMetricsEntry[],
  now = Date.now(),
): DashboardDataConfidence {
  const recent = entries.slice(-40);
  if (!recent.length) {
    return {
      score: 0, label: "low", targetMet: false,
      sampleScore: 0, schemaScore: 0, qualityScore: 0, completenessScore: 0, freshnessScore: 0,
      guidance: ["Record at least 20 schema-v2 runs."],
    };
  }
  const v2 = recent.filter(entry => entry.metricsSchemaVersion === 2);
  const measured = v2.filter(entry => finite(entry.verificationScore));
  const complete = recent.filter(entry =>
    typeof entry.ts === "string" && Boolean(entry.status) && metricDuration(entry) > 0
    && Boolean(entry.provider ?? entry.model) && Boolean(entry.method),
  );
  const timestamps = recent.map(entry => Date.parse(entry.ts)).filter(Number.isFinite);
  const latestAge = timestamps.length ? Math.max(0, now - Math.max(...timestamps)) : Number.POSITIVE_INFINITY;
  const sampleRatio = Math.min(1, recent.length / 20);
  const sampleScore = sampleRatio ** 3 * 25;
  const schemaScore = v2.length / recent.length * 25;
  const qualityScore = measured.length / recent.length * 20;
  const completenessScore = complete.length / recent.length * 20;
  const freshnessScore = latestAge <= 7 * 24 * 60 * 60 * 1_000 ? 10
    : latestAge <= 30 * 24 * 60 * 60 * 1_000 ? 5 : 0;
  const score = Math.round(sampleScore + schemaScore + qualityScore + completenessScore + freshnessScore);
  const guidance: string[] = [];
  if (recent.length < 20) guidance.push("Record " + (20 - recent.length) + " more run(s).");
  if (v2.length / recent.length < 0.8) guidance.push("Collect more schema-v2 telemetry; legacy verifier scores are excluded.");
  if (measured.length / recent.length < 0.85) guidance.push("Raise schema-v2 verifier quality coverage to at least 85% of recent runs.");
  if (complete.length / recent.length < 0.9) guidance.push("Some runs lack duration, provider, method, or status fields.");
  if (freshnessScore < 10) guidance.push("No complete run was recorded in the last 7 days.");
  return {
    score,
    label: score >= 85 ? "high" : score >= 60 ? "medium" : "low",
    targetMet: score >= 85,
    sampleScore: Math.round(sampleScore),
    schemaScore: Math.round(schemaScore),
    qualityScore: Math.round(qualityScore),
    completenessScore: Math.round(completenessScore),
    freshnessScore,
    guidance,
  };
}

function qualityInsights(entries: readonly CompactMetricsEntry[]): DashboardQualityInsight {
  const v2 = entries.filter(entry => entry.metricsSchemaVersion === 2);
  const scores = v2.map(entry => entry.verificationScore).filter(finite);
  const initial = v2.map(entry => entry.initialVerificationScore).filter(finite);
  const gains = v2.flatMap(entry => finite(entry.verificationScore) && finite(entry.initialVerificationScore)
    ? [entry.verificationScore - entry.initialVerificationScore] : []);
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const averageScore = average(scores);
  const passingRate = scores.length ? scores.filter(score => score >= 85).length / scores.length : 0;
  const gapFreeRate = v2.length ? v2.filter(entry => (entry.remainingVerificationGaps ?? entry.verificationGaps ?? 0) === 0).length / v2.length : 0;
  const successRate = v2.length ? v2.filter(entry => entry.status === "success" || entry.status === "dry-run").length / v2.length : 0;
  const healthScore = scores.length
    ? Math.round((averageScore! / 100) * 60 + passingRate * 20 + gapFreeRate * 10 + successRate * 10)
    : 0;
  return {
    healthScore,
    healthLabel: healthScore >= 85 ? "healthy" : healthScore >= 60 ? "degraded" : "critical",
    targetMet: healthScore >= 85,
    measuredRuns: scores.length,
    missingRuns: v2.length - scores.length,
    average: averageScore,
    median: median(scores),
    minimum: scores.length ? Math.min(...scores) : null,
    excellent: scores.filter(score => score >= 90).length,
    passing: scores.filter(score => score >= 75 && score < 90).length,
    low: scores.filter(score => score < 75).length,
    averageInitial: average(initial),
    averageRepairGain: average(gains),
    deterministicPatchedRuns: v2.filter(entry => (entry.deterministicPatchCount ?? 0) > 0).length,
    llmPatchedRuns: v2.filter(entry => entry.llmPatched).length,
    qualityFloorRuns: v2.filter(entry => entry.qualityFloorUsed).length,
    remainingGaps: v2.reduce((sum, entry) => sum + (entry.remainingVerificationGaps ?? entry.verificationGaps ?? 0), 0),
  };
}

function legacyRoute(entry: CompactMetricsEntry): ProviderRouteMetric[] {
  if (!entry.provider || !entry.model || !entry.totalCalls) return [];
  const model = entry.model.startsWith(entry.provider + "/") ? entry.model.slice(entry.provider.length + 1) : entry.model;
  return [{
    stage: "synthesize", provider: entry.provider, model,
    calls: entry.totalCalls, successes: entry.status === "success" || entry.status === "dry-run" ? entry.totalCalls : 0,
    avgLatencyMs: entry.avgLatency, inputTokens: entry.totalInput, outputTokens: entry.totalOutput,
  }];
}

function providerInsights(entries: readonly CompactMetricsEntry[]): DashboardProviderInsight[] {
  const groups = new Map<string, {
    stage: ProviderRouteStage; provider: string; model: string; runs: number; calls: number;
    successes: number; latency: number; tokens: number; quality: number; qualityRuns: number;
  }>();
  for (const entry of entries) {
    const routes = Array.isArray(entry.providerRoutes) && entry.providerRoutes.length ? entry.providerRoutes : legacyRoute(entry);
    for (const route of routes) {
      if (!route || (route.stage !== "explore" && route.stage !== "synthesize" && route.stage !== "verify")
        || !safeLabel(route.provider) || !safeLabel(route.model)
        || !finite(route.calls) || route.calls <= 0 || !finite(route.successes)
        || !finite(route.avgLatencyMs) || !finite(route.inputTokens) || !finite(route.outputTokens)) continue;
      const key = route.stage + "\u0000" + route.provider + "\u0000" + route.model;
      const group = groups.get(key) ?? {
        stage: route.stage, provider: route.provider, model: route.model,
        runs: 0, calls: 0, successes: 0, latency: 0, tokens: 0, quality: 0, qualityRuns: 0,
      };
      group.runs++;
      group.calls += route.calls;
      group.successes += Math.max(0, Math.min(route.calls, route.successes));
      group.latency += Math.max(0, route.avgLatencyMs) * route.calls;
      group.tokens += Math.max(0, route.inputTokens) + Math.max(0, route.outputTokens);
      if (entry.metricsSchemaVersion === 2
        && route.qualityBasis === "pre-repair-verification" && finite(route.qualityScore)
        && route.qualityScore >= 0 && route.qualityScore <= 100) {
        group.quality += route.qualityScore;
        group.qualityRuns++;
      }
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(group => ({
    stage: group.stage,
    provider: group.provider,
    model: group.model,
    runs: group.runs,
    calls: group.calls,
    reliability: group.calls ? group.successes / group.calls : 0,
    avgQuality: group.qualityRuns ? group.quality / group.qualityRuns : null,
    qualityCoverage: group.runs ? group.qualityRuns / group.runs : 0,
    avgLatencyMs: group.calls ? Math.round(group.latency / group.calls) : 0,
    avgTokensPerCall: group.calls ? Math.round(group.tokens / group.calls) : 0,
  })).sort((a, b) => a.stage.localeCompare(b.stage) || b.runs - a.runs || a.provider.localeCompare(b.provider));
}

export function formatDashboardQuality(insights: DashboardInsights): string[] {
  const q = insights.quality;
  return [
    "Quality drilldown",
    "",
    "Data Confidence: " + insights.confidence.score + "/100 (telemetry completeness; target ≥85 " + (insights.confidence.targetMet ? "met" : "not met") + ")",
    "Quality Health: " + q.healthScore + "/100 (" + q.healthLabel + "; target ≥85 " + (q.targetMet ? "met" : "not met") + ")",
    "Measured/missing schema-v2 runs: " + q.measuredRuns + "/" + q.missingRuns,
    "Average: " + (q.average?.toFixed(1) ?? "—") + " | median: " + (q.median?.toFixed(1) ?? "—") + " | minimum: " + (q.minimum?.toFixed(1) ?? "—"),
    "Bands: excellent ≥90 " + q.excellent + " | pass 75–89 " + q.passing + " | low <75 " + q.low,
    "Repair: initial avg " + (q.averageInitial?.toFixed(1) ?? "—") + " | gain " + (q.averageRepairGain?.toFixed(1) ?? "—") + " | deterministic " + q.deterministicPatchedRuns + " | LLM " + q.llmPatchedRuns + " | floor " + q.qualityFloorRuns,
    "Remaining gaps: " + q.remainingGaps,
    "",
    "Confidence evidence: sample " + insights.confidence.sampleScore + "/25 | schema " + insights.confidence.schemaScore + "/25 | quality " + insights.confidence.qualityScore + "/20 | complete " + insights.confidence.completenessScore + "/20 | fresh " + insights.confidence.freshnessScore + "/10",
    ...insights.confidence.guidance.map(item => "- " + item),
  ];
}

export function formatDashboardProviders(insights: DashboardInsights): string[] {
  return [
    "Provider routes",
    "",
    ...(insights.providers.length ? insights.providers.map(item =>
      "- " + item.stage + " | " + item.provider + "/" + item.model + " | n=" + item.runs + " | reliable " + Math.round(item.reliability * 100) + "% | quality " + (item.avgQuality?.toFixed(1) ?? "—") + " (" + Math.round(item.qualityCoverage * 100) + "% coverage) | " + item.avgLatencyMs + "ms | " + item.avgTokensPerCall + "t/call",
    ) : ["No stage-route evidence yet."]),
  ];
}

export function formatDashboardCanary(insights: DashboardInsights): string[] {
  const c = insights.canary;
  return [
    "Canary / stable control",
    "",
    "Decision: " + c.decision.toUpperCase() + " | data confidence " + c.dataConfidence + "%",
    "Runs: stable " + c.baseline.runs + " | canary " + c.canary.runs,
    "Success: stable " + Math.round(c.baseline.successRate * 100) + "% | canary " + Math.round(c.canary.successRate * 100) + "%",
    "Quality: stable " + (c.baseline.avgQuality?.toFixed(1) ?? "—") + " | canary " + (c.canary.avgQuality?.toFixed(1) ?? "—"),
    "p95: stable " + c.baseline.p95LatencyMs + "ms | canary " + c.canary.p95LatencyMs + "ms",
    "Tokens: stable " + c.baseline.avgTokens + " | canary " + c.canary.avgTokens,
    "Fallback: stable " + Math.round(c.baseline.fallbackRate * 100) + "% | canary " + Math.round(c.canary.fallbackRate * 100) + "%",
    "Damage: stable " + Math.round(c.baseline.damageRate * 100) + "% | canary " + Math.round(c.canary.damageRate * 100) + "%",
    "Damage observed: stable " + Math.round(c.baseline.damageCoverage * 100) + "% | canary " + Math.round(c.canary.damageCoverage * 100) + "%",
    "",
    ...c.reasons.map(item => "- " + item),
    ...c.triggers.map(item => "- Trigger " + item.metric + ": " + item.baseline + " → " + item.canary + " (" + item.threshold + ")"),
  ];
}

export function buildDashboardInsights(
  entries: readonly CompactMetricsEntry[],
  damageEntries: readonly DamageTelemetryEntry[] = [],
  options: { version?: string; minCanaryRuns?: number; now?: number } = {},
): DashboardInsights {
  const failures: Partial<Record<TelemetryFailureKind, number>> = {};
  const knownFailures = new Set<TelemetryFailureKind>([
    "cancelled", "timeout", "rate-limit", "authentication", "budget",
    "output-limit", "provider", "persistence", "validation", "internal",
  ]);
  for (const entry of entries) {
    if (entry.failureKind && knownFailures.has(entry.failureKind)) {
      failures[entry.failureKind] = (failures[entry.failureKind] ?? 0) + 1;
    }
  }
  return {
    confidence: calculateDashboardDataConfidence(entries, options.now),
    quality: qualityInsights(entries),
    providers: providerInsights(entries),
    canary: assessCanary(entries, damageEntries, {
      version: options.version ?? VERSION,
      minCanaryRuns: options.minCanaryRuns,
    }),
    failures,
  };
}
