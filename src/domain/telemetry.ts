import type { CompactMetricsEntry, TelemetryFailureKind } from "../types.ts";

export interface DamageTelemetryEntry {
  ts?: string;
  version?: string;
  releaseChannel?: "stable" | "canary";
  damageScore?: number;
}

export interface TelemetryWindowStats {
  runs: number;
  successRate: number;
  avgQuality: number | null;
  qualityCoverage: number;
  p95LatencyMs: number;
  avgTokens: number;
  fallbackRate: number;
  damageRate: number;
}

export interface CanaryTrigger {
  metric: "failure-rate" | "quality" | "latency" | "tokens" | "fallback" | "damage";
  baseline: number;
  canary: number;
  threshold: string;
}

export interface CanaryAssessment {
  version: string;
  decision: "promote" | "hold" | "rollback";
  dataConfidence: number;
  baseline: TelemetryWindowStats;
  canary: TelemetryWindowStats;
  triggers: CanaryTrigger[];
  reasons: string[];
}

export interface PrivacySafeTelemetryAggregate {
  version: string;
  channel: "stable" | "canary";
  provider: string;
  model: string;
  runs: number;
  successes: number;
  avgQuality: number | null;
  avgLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PrivacySafeTelemetry {
  generatedAt: string;
  totalRuns: number;
  aggregates: PrivacySafeTelemetryAggregate[];
  failures: Partial<Record<TelemetryFailureKind, number>>;
  canary: CanaryAssessment;
  privacy: "aggregate-only; no session ids, project ids, prompts, summaries, paths, or error text";
}

function errorFields(error: unknown): { name: string; message: string; status: number | null; code: string } {
  if (!error || typeof error !== "object") {
    return { name: "", message: String(error ?? ""), status: null, code: "" };
  }
  const value = error as { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; code?: unknown; cause?: unknown };
  const cause = value.cause && value.cause !== error ? errorFields(value.cause) : null;
  const numericStatus = Number(value.status ?? value.statusCode);
  return {
    name: typeof value.name === "string" ? value.name : cause?.name ?? "",
    message: (typeof value.message === "string" ? value.message : "") + (cause?.message ? " " + cause.message : ""),
    status: Number.isFinite(numericStatus) ? numericStatus : cause?.status ?? null,
    code: typeof value.code === "string" ? value.code : cause?.code ?? "",
  };
}

/** Stable, content-free failure taxonomy for aggregate telemetry. */
export function classifyTelemetryFailure(error: unknown, timedOut = false): TelemetryFailureKind {
  const fields = errorFields(error);
  const text = (fields.name + " " + fields.code + " " + fields.message).toLowerCase();
  if (timedOut || /timeout|timed out|watchdog|deadline/.test(text)) return "timeout";
  if (/budgetexceeded|token budget|call budget|latency budget/.test(text)) return "budget";
  if (fields.status === 429 || /rate.?limit|too many requests|quota/.test(text)) return "rate-limit";
  if (fields.status === 401 || fields.status === 403 || /unauthori[sz]ed|authentication|api.?key|credential/.test(text)) return "authentication";
  if (/max(?:imum)? output|output.?limit|visible output|length limit/.test(text)) return "output-limit";
  if (/abort|cancel/.test(text)) return "cancelled";
  if (/native compaction|persist|write|rename|filesystem|sqlite|database/.test(text)) return "persistence";
  if (/invalid|validation|schema|malformed|required/.test(text)) return "validation";
  if ((fields.status != null && fields.status >= 500) || /provider|api error|stream|network|fetch failed|socket/.test(text)) return "provider";
  return "internal";
}

function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function stats(entries: CompactMetricsEntry[], damage: DamageTelemetryEntry[]): TelemetryWindowStats {
  const successes = entries.filter(entry => entry.status === "success" || entry.status === "dry-run");
  const quality = successes.filter(entry => typeof entry.verificationScore === "number");
  const damaging = damage.filter(entry => (entry.damageScore ?? 0) > 0).length;
  return {
    runs: entries.length,
    successRate: entries.length ? successes.length / entries.length : 0,
    avgQuality: quality.length ? quality.reduce((sum, entry) => sum + (entry.verificationScore ?? 0), 0) / quality.length : null,
    qualityCoverage: entries.length ? quality.length / entries.length : 0,
    p95LatencyMs: p95(entries.map(entry => entry.durationMs ?? entry.avgLatency).filter(Number.isFinite)),
    avgTokens: entries.length ? entries.reduce((sum, entry) => sum + entry.totalInput + entry.totalOutput, 0) / entries.length : 0,
    fallbackRate: entries.length ? entries.filter(entry =>
      entry.method === "heuristic" || (Array.isArray(entry.providerRoutes) && entry.providerRoutes.some(route => route.successes < route.calls)),
    ).length / entries.length : 0,
    damageRate: entries.length ? Math.min(1, damaging / entries.length) : 0,
  };
}

function roundStats(value: TelemetryWindowStats): TelemetryWindowStats {
  return {
    ...value,
    successRate: Math.round(value.successRate * 1_000) / 1_000,
    avgQuality: value.avgQuality == null ? null : Math.round(value.avgQuality * 10) / 10,
    qualityCoverage: Math.round(value.qualityCoverage * 1_000) / 1_000,
    p95LatencyMs: Math.round(value.p95LatencyMs),
    avgTokens: Math.round(value.avgTokens),
    fallbackRate: Math.round(value.fallbackRate * 1_000) / 1_000,
    damageRate: Math.round(value.damageRate * 1_000) / 1_000,
  };
}

export function assessCanary(
  entries: readonly CompactMetricsEntry[],
  damageEntries: readonly DamageTelemetryEntry[],
  options: { version: string; minCanaryRuns?: number; baselineRuns?: number } ,
): CanaryAssessment {
  const minCanaryRuns = Math.max(5, options.minCanaryRuns ?? 20);
  const canaryEntries = entries.filter(entry =>
    entry.metricsSchemaVersion === 2 && entry.version === options.version && entry.releaseChannel === "canary",
  ).slice(-Math.max(100, minCanaryRuns));
  const baselineEntries = entries.filter(entry =>
    entry.metricsSchemaVersion === 2 && (entry.releaseChannel ?? "stable") === "stable",
  ).slice(-(options.baselineRuns ?? Math.max(50, minCanaryRuns * 2)));
  const canaryDamage = damageEntries
    .filter(entry => entry.version === options.version && entry.releaseChannel === "canary")
    .slice(-canaryEntries.length);
  const baselineDamage = damageEntries
    .filter(entry => (entry.releaseChannel ?? "stable") === "stable")
    .slice(-baselineEntries.length);
  const baseline = stats(baselineEntries, baselineDamage);
  const canary = stats(canaryEntries, canaryDamage);
  const triggers: CanaryTrigger[] = [];
  const failureBaseline = 1 - baseline.successRate;
  const failureCanary = 1 - canary.successRate;
  if (canary.runs >= 3 && failureCanary >= 0.1 && failureCanary - failureBaseline >= 0.05) {
    triggers.push({ metric: "failure-rate", baseline: failureBaseline, canary: failureCanary, threshold: "+5pp and >=10%" });
  }
  if (baseline.avgQuality != null && canary.avgQuality != null && baseline.avgQuality - canary.avgQuality >= 5) {
    triggers.push({ metric: "quality", baseline: baseline.avgQuality, canary: canary.avgQuality, threshold: "-5 points" });
  }
  if (baseline.p95LatencyMs >= 1_000 && canary.p95LatencyMs >= baseline.p95LatencyMs * 1.5) {
    triggers.push({ metric: "latency", baseline: baseline.p95LatencyMs, canary: canary.p95LatencyMs, threshold: "+50% p95" });
  }
  if (baseline.avgTokens >= 1_000 && canary.avgTokens >= baseline.avgTokens * 1.5) {
    triggers.push({ metric: "tokens", baseline: baseline.avgTokens, canary: canary.avgTokens, threshold: "+50%" });
  }
  if (canary.fallbackRate - baseline.fallbackRate >= 0.1) {
    triggers.push({ metric: "fallback", baseline: baseline.fallbackRate, canary: canary.fallbackRate, threshold: "+10pp" });
  }
  if (canary.damageRate - baseline.damageRate >= 0.1) {
    triggers.push({ metric: "damage", baseline: baseline.damageRate, canary: canary.damageRate, threshold: "+10pp" });
  }

  const dataConfidence = Math.round(100 * (
    Math.min(1, canary.runs / minCanaryRuns) * 0.4
    + Math.min(1, baseline.runs / Math.max(20, minCanaryRuns)) * 0.3
    + canary.qualityCoverage * 0.3
  ));
  const reasons: string[] = [];
  let decision: CanaryAssessment["decision"] = "hold";
  if (triggers.length && canary.runs >= 3) {
    decision = "rollback";
    reasons.push(...triggers.map(trigger => trigger.metric + " crossed " + trigger.threshold));
  } else if (canary.runs < minCanaryRuns) {
    reasons.push("need " + (minCanaryRuns - canary.runs) + " more canary runs");
  } else if (baseline.runs < Math.max(20, minCanaryRuns)) {
    reasons.push("stable baseline is too small");
  } else if (canary.qualityCoverage < 0.7) {
    reasons.push("schema-v2 quality coverage is below 70%");
  } else {
    decision = "promote";
    reasons.push("sample, quality, reliability, latency, token, fallback, and damage gates passed");
  }
  return {
    version: options.version,
    decision,
    dataConfidence,
    baseline: roundStats(baseline),
    canary: roundStats(canary),
    triggers,
    reasons,
  };
}

function safeMetricLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !/^[\w./:@+-]{1,160}$/.test(value)) return fallback;
  return value;
}

const FAILURE_KINDS = new Set<TelemetryFailureKind>([
  "cancelled", "timeout", "rate-limit", "authentication", "budget",
  "output-limit", "provider", "persistence", "validation", "internal",
]);

export function buildPrivacySafeTelemetry(
  entries: readonly CompactMetricsEntry[],
  damageEntries: readonly DamageTelemetryEntry[],
  options: { version: string; minCanaryRuns?: number } ,
): PrivacySafeTelemetry {
  const groups = new Map<string, {
    version: string; channel: "stable" | "canary"; provider: string; model: string;
    runs: number; successes: number; quality: number; qualityRuns: number;
    latency: number; input: number; output: number;
  }>();
  const failures: Partial<Record<TelemetryFailureKind, number>> = {};
  for (const entry of entries) {
    const version = safeMetricLabel(entry.version, "legacy");
    const channel = entry.releaseChannel === "canary" ? "canary" : "stable";
    const provider = safeMetricLabel(entry.provider, "unknown");
    const rawModel = safeMetricLabel(entry.model, "unknown");
    const model = rawModel.startsWith(provider + "/") ? rawModel.slice(provider.length + 1) : rawModel;
    const key = [version, channel, provider, model].join("\u0000");
    const group = groups.get(key) ?? {
      version, channel, provider, model, runs: 0, successes: 0,
      quality: 0, qualityRuns: 0, latency: 0, input: 0, output: 0,
    };
    group.runs++;
    if (entry.status === "success" || entry.status === "dry-run") group.successes++;
    if (entry.metricsSchemaVersion === 2 && typeof entry.verificationScore === "number") {
      group.quality += entry.verificationScore;
      group.qualityRuns++;
    }
    group.latency += entry.avgLatency;
    group.input += entry.totalInput;
    group.output += entry.totalOutput;
    groups.set(key, group);
    if (entry.failureKind && FAILURE_KINDS.has(entry.failureKind)) {
      failures[entry.failureKind] = (failures[entry.failureKind] ?? 0) + 1;
    }
  }
  const aggregates = [...groups.values()].map(group => ({
    version: group.version,
    channel: group.channel,
    provider: group.provider,
    model: group.model,
    runs: group.runs,
    successes: group.successes,
    avgQuality: group.qualityRuns ? Math.round(group.quality / group.qualityRuns * 10) / 10 : null,
    avgLatencyMs: group.runs ? Math.round(group.latency / group.runs) : 0,
    inputTokens: group.input,
    outputTokens: group.output,
  })).sort((a, b) => b.runs - a.runs || a.version.localeCompare(b.version));
  return {
    generatedAt: new Date().toISOString(),
    totalRuns: entries.length,
    aggregates,
    failures,
    canary: assessCanary(entries, damageEntries, options),
    privacy: "aggregate-only; no session ids, project ids, prompts, summaries, paths, or error text",
  };
}

export function formatPrivacySafeTelemetry(report: PrivacySafeTelemetry): string {
  const lines = [
    "# Smart Compact Telemetry", "",
    "Privacy: " + report.privacy + ".", "",
    "| Version | Channel | Provider/model | Runs | Success | Quality | Latency | Input | Output |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const item of report.aggregates) {
    lines.push("| " + item.version + " | " + item.channel + " | " + item.provider + "/" + item.model +
      " | " + item.runs + " | " + item.successes + "/" + item.runs + " | " +
      (item.avgQuality == null ? "n/a" : item.avgQuality.toFixed(1)) + " | " + item.avgLatencyMs +
      "ms | " + item.inputTokens + " | " + item.outputTokens + " |");
  }
  lines.push("", "## Canary: " + report.canary.decision.toUpperCase() + " (data confidence " + report.canary.dataConfidence + "%)", "");
  const baseline = report.canary.baseline;
  const canary = report.canary.canary;
  lines.push(
    "| Gate | Stable baseline | Canary |",
    "|---|---:|---:|",
    "| Runs | " + baseline.runs + " | " + canary.runs + " |",
    "| Success | " + Math.round(baseline.successRate * 100) + "% | " + Math.round(canary.successRate * 100) + "% |",
    "| Verify quality | " + (baseline.avgQuality ?? "n/a") + " | " + (canary.avgQuality ?? "n/a") + " |",
    "| p95 duration | " + baseline.p95LatencyMs + "ms | " + canary.p95LatencyMs + "ms |",
    "| Avg tokens | " + baseline.avgTokens + " | " + canary.avgTokens + " |",
    "| Fallback | " + Math.round(baseline.fallbackRate * 100) + "% | " + Math.round(canary.fallbackRate * 100) + "% |",
    "| Damage | " + Math.round(baseline.damageRate * 100) + "% | " + Math.round(canary.damageRate * 100) + "% |",
    "",
  );
  for (const reason of report.canary.reasons) lines.push("- " + reason);
  const failureText = Object.entries(report.failures).map(([kind, count]) => kind + "=" + count).join(", ");
  lines.push("", "Failures: " + (failureText || "none classified"));
  return lines.join("\n");
}
