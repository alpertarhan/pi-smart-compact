import type {
  CompactMetricsEntry, LLMCallMetric, ProviderRouteMetric, ProviderRouteStage,
} from "../types.ts";

export type ProviderScenario =
  | "compact/conversational" | "compact/mixed" | "compact/tool-heavy"
  | "pressure/conversational" | "pressure/mixed" | "pressure/tool-heavy"
  | "critical/conversational" | "critical/mixed" | "critical/tool-heavy";

export interface ProviderEvaluationCell {
  stage: ProviderRouteStage;
  scenario: ProviderScenario;
  provider: string;
  model: string;
  runs: number;
  calls: number;
  successRate: number;
  avgLatencyMs: number;
  avgTokensPerCall: number;
  avgQuality: number | null;
  qualityCoverage: number;
  score: number;
  confidence: number;
  eligible: boolean;
}

export interface ProviderRouteRecommendation {
  stage: ProviderRouteStage;
  scenario: ProviderScenario;
  model: string | null;
  score: number;
  confidence: number;
  reason: string;
}

export interface ProviderEvaluationReport {
  generatedAt: string;
  entries: number;
  minSamples: number;
  advisoryOnly: true;
  cells: ProviderEvaluationCell[];
  recommendations: ProviderRouteRecommendation[];
}

export function providerStage(phase: LLMCallMetric["phase"]): ProviderRouteStage {
  if (phase === "patch") return "verify";
  if (phase === "probe" || phase.startsWith("explore")) return "explore";
  return "synthesize";
}

/** Collapse per-call telemetry into one route row per stage/provider/model. */
export function aggregateProviderRoutes(metrics: readonly LLMCallMetric[]): ProviderRouteMetric[] {
  const groups = new Map<string, {
    stage: ProviderRouteStage; provider: string; model: string; calls: number;
    successes: number; latency: number; input: number; output: number;
  }>();
  for (const metric of metrics) {
    const stage = providerStage(metric.phase);
    const provider = metric.provider ?? "unknown";
    const key = stage + "\u0000" + provider + "\u0000" + metric.model;
    const group = groups.get(key) ?? {
      stage, provider, model: metric.model, calls: 0, successes: 0,
      latency: 0, input: 0, output: 0,
    };
    group.calls++;
    if (metric.success) group.successes++;
    group.latency += Math.max(0, metric.latencyMs);
    group.input += Math.max(0, metric.inputTokens);
    group.output += Math.max(0, metric.outputTokens);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    stage: group.stage,
    provider: group.provider,
    model: group.model,
    calls: group.calls,
    successes: group.successes,
    avgLatencyMs: group.calls ? Math.round(group.latency / group.calls) : 0,
    inputTokens: group.input,
    outputTokens: group.output,
  }));
}

export function providerScenario(entry: Pick<CompactMetricsEntry, "contextPercent" | "toolPercent">): ProviderScenario {
  const context = (entry.contextPercent ?? 0) >= 90 ? "critical"
    : (entry.contextPercent ?? 0) >= 70 ? "pressure" : "compact";
  const workload = (entry.toolPercent ?? 0) >= 70 ? "tool-heavy"
    : (entry.toolPercent ?? 0) >= 30 ? "mixed" : "conversational";
  return (context + "/" + workload) as ProviderScenario;
}

interface AggregateCell {
  stage: ProviderRouteStage;
  scenario: ProviderScenario;
  provider: string;
  model: string;
  runs: number;
  calls: number;
  successes: number;
  latencyCallMs: number;
  tokens: number;
  qualityTotal: number;
  qualityRuns: number;
}

function validPersistedRoutes(value: unknown): ProviderRouteMetric[] {
  if (!Array.isArray(value)) return [];
  return value.filter((route): route is ProviderRouteMetric => {
    if (!route || typeof route !== "object") return false;
    const item = route as Partial<ProviderRouteMetric>;
    return (item.stage === "explore" || item.stage === "synthesize" || item.stage === "verify")
      && typeof item.provider === "string" && typeof item.model === "string"
      && typeof item.calls === "number" && Number.isFinite(item.calls) && item.calls > 0
      && typeof item.successes === "number" && Number.isFinite(item.successes)
      && typeof item.avgLatencyMs === "number" && Number.isFinite(item.avgLatencyMs)
      && typeof item.inputTokens === "number" && Number.isFinite(item.inputTokens)
      && typeof item.outputTokens === "number" && Number.isFinite(item.outputTokens);
  });
}

function legacyRoute(entry: CompactMetricsEntry): ProviderRouteMetric[] {
  if (!entry.provider || !entry.model || !entry.totalCalls) return [];
  const model = entry.model.startsWith(entry.provider + "/")
    ? entry.model.slice(entry.provider.length + 1)
    : entry.model;
  const successful = entry.status === "success" || entry.status === "dry-run";
  return [{
    stage: "synthesize",
    provider: entry.provider,
    model,
    calls: entry.totalCalls,
    successes: successful ? entry.totalCalls : 0,
    avgLatencyMs: entry.avgLatency,
    inputTokens: entry.totalInput,
    outputTokens: entry.totalOutput,
  }];
}

/**
 * Build an advisory scenario matrix from persisted real-run telemetry.
 * Legacy rows contribute reliability/latency, but only schema-v2 rows
 * contribute verifier quality so old score semantics cannot poison routing.
 */
export function evaluateProviderMetrics(
  entries: readonly CompactMetricsEntry[],
  options: { minSamples?: number } = {},
): ProviderEvaluationReport {
  const minSamples = Math.max(2, options.minSamples ?? 5);
  const groups = new Map<string, AggregateCell>();
  for (const entry of entries) {
    const scenario = providerScenario(entry);
    const persistedRoutes = validPersistedRoutes(entry.providerRoutes);
    const routes = persistedRoutes.length ? persistedRoutes : legacyRoute(entry);
    for (const route of routes) {
      const key = route.stage + "\u0000" + scenario + "\u0000" + route.provider + "\u0000" + route.model;
      const group = groups.get(key) ?? {
        stage: route.stage, scenario, provider: route.provider, model: route.model,
        runs: 0, calls: 0, successes: 0, latencyCallMs: 0, tokens: 0,
        qualityTotal: 0, qualityRuns: 0,
      };
      group.runs++;
      group.calls += route.calls;
      group.successes += Math.max(0, Math.min(route.calls, route.successes));
      group.latencyCallMs += Math.max(0, route.avgLatencyMs) * route.calls;
      group.tokens += Math.max(0, route.inputTokens) + Math.max(0, route.outputTokens);
      if (entry.metricsSchemaVersion === 2 && typeof entry.verificationScore === "number") {
        group.qualityTotal += Math.max(0, Math.min(100, entry.verificationScore));
        group.qualityRuns++;
      }
      groups.set(key, group);
    }
  }

  const cells = [...groups.values()].map((group): ProviderEvaluationCell => {
    const successRate = group.calls ? group.successes / group.calls : 0;
    const avgLatencyMs = group.calls ? group.latencyCallMs / group.calls : 0;
    const avgTokensPerCall = group.calls ? group.tokens / group.calls : 0;
    const avgQuality = group.qualityRuns ? group.qualityTotal / group.qualityRuns : null;
    const qualityCoverage = group.runs ? group.qualityRuns / group.runs : 0;
    const quality = avgQuality == null ? 0.5 : avgQuality / 100;
    const latency = 1 / (1 + avgLatencyMs / 30_000);
    const efficiency = 1 / (1 + avgTokensPerCall / 100_000);
    const rawScore = group.stage === "explore"
      ? successRate * 0.4 + latency * 0.3 + efficiency * 0.15 + quality * 0.15
      : quality * 0.4 + successRate * 0.3 + latency * 0.2 + efficiency * 0.1;
    const confidence = Math.min(1, group.runs / minSamples) * (0.5 + qualityCoverage * 0.5);
    const score = 0.5 + (rawScore - 0.5) * confidence;
    return {
      stage: group.stage,
      scenario: group.scenario,
      provider: group.provider,
      model: group.model,
      runs: group.runs,
      calls: group.calls,
      successRate: Math.round(successRate * 1_000) / 1_000,
      avgLatencyMs: Math.round(avgLatencyMs),
      avgTokensPerCall: Math.round(avgTokensPerCall),
      avgQuality: avgQuality == null ? null : Math.round(avgQuality * 10) / 10,
      qualityCoverage: Math.round(qualityCoverage * 1_000) / 1_000,
      score: Math.round(score * 1_000) / 1_000,
      confidence: Math.round(confidence * 1_000) / 1_000,
      eligible: group.runs >= minSamples && successRate >= 0.8 && qualityCoverage >= 0.5,
    };
  }).sort((a, b) => a.stage.localeCompare(b.stage) || a.scenario.localeCompare(b.scenario) || b.score - a.score);

  const buckets = new Map<string, ProviderEvaluationCell[]>();
  for (const cell of cells) {
    const key = cell.stage + "\u0000" + cell.scenario;
    const values = buckets.get(key) ?? [];
    values.push(cell);
    buckets.set(key, values);
  }
  const recommendations = [...buckets.values()].map((values): ProviderRouteRecommendation => {
    const best = values.filter(value => value.eligible).sort((a, b) => b.score - a.score || b.confidence - a.confidence)[0];
    const first = values[0];
    return best ? {
      stage: best.stage,
      scenario: best.scenario,
      model: best.provider + "/" + best.model,
      score: best.score,
      confidence: best.confidence,
      reason: best.qualityCoverage > 0
        ? "best eligible quality/reliability/latency score"
        : "best eligible operational score; quality evidence pending",
    } : {
      stage: first.stage,
      scenario: first.scenario,
      model: null,
      score: 0,
      confidence: 0,
      reason: "insufficient samples, reliability, or schema-v2 quality coverage; keep the selected model",
    };
  }).sort((a, b) => a.stage.localeCompare(b.stage) || a.scenario.localeCompare(b.scenario));

  return {
    generatedAt: new Date().toISOString(),
    entries: entries.length,
    minSamples,
    advisoryOnly: true,
    cells,
    recommendations,
  };
}

export function formatProviderEvaluation(report: ProviderEvaluationReport): string {
  const lines = [
    "# Provider Evaluation (advisory only)", "",
    "The selected Pi model remains the default. Apply a stage route only after representative quality evidence.", "",
    "| Stage | Scenario | Provider/model | Runs | Success | Quality | Latency | Score | Confidence |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const cell of report.cells) {
    lines.push(
      "| " + cell.stage + " | " + cell.scenario + " | " + cell.provider + "/" + cell.model +
      " | " + cell.runs + " | " + Math.round(cell.successRate * 100) + "% | " +
      (cell.avgQuality == null ? "n/a" : cell.avgQuality.toFixed(1)) + " | " +
      cell.avgLatencyMs + "ms | " + cell.score.toFixed(3) + " | " + Math.round(cell.confidence * 100) + "% |",
    );
  }
  lines.push("", "## Recommendations", "");
  for (const item of report.recommendations) {
    lines.push("- **" + item.stage + " / " + item.scenario + "**: " + (item.model ?? "selected model") + " — " + item.reason + ".");
  }
  return lines.join("\n");
}
