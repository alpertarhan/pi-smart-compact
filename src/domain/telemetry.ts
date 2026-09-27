import type { CompactMetricsEntry, PreparationDiscardReason, TelemetryFailureKind } from "../types.ts";

export interface DamageTelemetryEntry {
 ts?: string;
 /** Originating compaction run; required for trustworthy quality/damage joins. */
 runId?: string;
 version?: string;
 releaseChannel?: "stable" | "canary";
 observationSource?: "online-window" | "next-compaction";
 damageScore?: number;
}

export interface TelemetryWindowStats {
 runs: number;
 /** Host-confirmed applies only (status success). */
 appliedRuns: number;
 /** Real non-dry, non-cancel attempts backing the failure-rate signal. */
 attemptedRuns: number;
 successRate: number;
 avgQuality: number | null;
 qualityCoverage: number;
 p95LatencyMs: number;
 avgTokens: number;
 fallbackRate: number;
 damageRate: number;
 damageCoverage: number;
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
 /** "unknown" when an entry carries no explicit channel; never silently stable. */
 channel: "stable" | "canary" | "unknown";
 provider: string;
 model: string;
 runs: number;
 /** Host-confirmed applies only. */
 successes: number;
 avgQuality: number | null;
 avgLatencyMs: number;
 inputTokens: number;
 cacheReadTokens: number;
 cacheWriteTokens: number;
 outputTokens: number;
}

/** Content-free policy measurements for speculative preparation. */
export interface PreparationPolicyStats {
 preparedRuns: number;
 usedRuns: number;
 discardedRuns: number;
 /** Prepared runs that ended in timeout/error — real failures, not discards. */
 otherOutcomes: number;
 discardReasons: Partial<Record<PreparationDiscardReason, number>>;
 medianReadyMs: number | null;
 medianWaitMs: number | null;
 /** used / (used + discarded); null before the first resolvable outcome. */
 reuseRate: number | null;
 /** Spend on work that never applied; counted once, never in the applied cohort. */
 discardedCost: {
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
 };
}

/** Aggregate visibility for existing verifier-provenance fields. */
export interface QualityProvenanceStats {
 measuredRuns: number;
 avgInitialQuality: number | null;
 avgRepairGain: number | null;
 deterministicPatchRuns: number;
 llmPatchRuns: number;
 qualityFloorRuns: number;
}

export interface PrivacySafeTelemetry {
 generatedAt: string;
 totalRuns: number;
 aggregates: PrivacySafeTelemetryAggregate[];
 failures: Partial<Record<TelemetryFailureKind, number>>;
 canary: CanaryAssessment;
 preparation: PreparationPolicyStats;
 qualityProvenance: QualityProvenanceStats;
 privacy: "aggregate-only; no session ids, project ids, prompts, summaries, paths, or error text";
}

function errorFields(error: unknown, seen = new Set<object>()): { name: string; message: string; status: number | null; code: string } {
 if (!error || typeof error !== "object") {
  return { name: "", message: String(error ?? ""), status: null, code: "" };
 }
 if (seen.has(error) || seen.size >= 8) return { name: "", message: "", status: null, code: "" };
 seen.add(error);
 const value = error as { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; code?: unknown; cause?: unknown };
 const cause = value.cause ? errorFields(value.cause, seen) : null;
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
 if (timedOut) return "timeout";
 if (/max(?:imum)? output|output.?limit|visible[ -]output|length limit|stop reason length/.test(text)) return "output-limit";
 if (/timeout|timed out|watchdog|deadline/.test(text)) return "timeout";
 if (fields.name.toLowerCase() === "verificationgateerror") return "verification";
 if (fields.name.toLowerCase() === "yieldgateerror") return "yield";
 if (/budgetexceeded|modelcapacityerror|token budget|call budget|latency budget/.test(text)) return "budget";
 if (fields.status === 429 || /rate.?limit|too many requests|quota/.test(text)) return "rate-limit";
 if (fields.status === 401 || fields.status === 403 || /unauthori[sz]ed|authentication|api.?key|credential/.test(text)) return "authentication";
 if (/abort|cancel/.test(text)) return "cancelled";
 if (/native compaction|persist|write|rename|filesystem|sqlite|database/.test(text)) return "persistence";
 if (/verificationgateerror|verification gate|verification.*(?:gap|summary)/.test(text)) return "verification";
 if (/invalid|validation|schema|malformed|required/.test(text)) return "validation";
 if ((fields.status != null && fields.status >= 500) || /provider|api error|stream|network|fetch failed|socket/.test(text)) return "provider";
 return "internal";
}

function p95(values: number[]): number {
 if (!values.length) return 0;
 const sorted = [...values].sort((a, b) => a - b);
 return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function median(values: number[]): number | null {
 if (!values.length) return null;
 const sorted = [...values].sort((a, b) => a - b);
 const middle = Math.floor(sorted.length / 2);
 return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Cohort evidence rules:
 *   - applied/success cohorts contain only host-confirmed applies;
 *   - voluntary user cancellation is neutral (never a success or a failure);
 *   - real timeouts and provider failures stay counted;
 *   - discarded speculative preparation is not applied evidence.
 */
function neutralRun(entry: CompactMetricsEntry): boolean {
 return entry.status === "dry-run" || entry.status === "cancelled" || entry.status === "discarded"
  || (entry.status === "error" && entry.failureKind === "cancelled");
}

function stats(entries: CompactMetricsEntry[], damage: readonly DamageTelemetryEntry[]): TelemetryWindowStats {
 const evidence = entries.filter(entry => !neutralRun(entry));
 const successfulRuns = evidence.filter(entry => entry.status === "success");
 const quality = successfulRuns.filter(entry => typeof entry.verificationScore === "number");
 const appliedRunIds = new Set(successfulRuns
  .filter(entry => typeof entry.runId === "string" && entry.runId.length >= 8)
  .map(entry => entry.runId!));
 const observedScores = new Map<string, number>();
 for (const observation of damage) {
  if (!observation.runId || !appliedRunIds.has(observation.runId)
   || typeof observation.damageScore !== "number" || !Number.isFinite(observation.damageScore)) continue;
  observedScores.set(observation.runId, Math.max(
   observedScores.get(observation.runId) ?? 0,
   Math.max(0, Math.min(100, observation.damageScore)),
  ));
 }
 const damaging = [...observedScores.values()].filter(score => score > 0).length;
 return {
  runs: entries.length,
  // Host-confirmed applies only; staged-but-unapplied and cancelled runs
  // are not promotion evidence.
  appliedRuns: successfulRuns.length,
  attemptedRuns: evidence.length,
  successRate: evidence.length ? successfulRuns.length / evidence.length : 1,
  avgQuality: quality.length ? quality.reduce((sum, entry) => sum + (entry.verificationScore ?? 0), 0) / quality.length : null,
  qualityCoverage: evidence.length ? quality.length / evidence.length : 0,
  p95LatencyMs: p95(evidence.map(entry => entry.durationMs ?? entry.avgLatency).filter(Number.isFinite)),
  avgTokens: evidence.length ? evidence.reduce((sum, entry) =>
   sum + entry.totalInput + entry.totalCacheHit + (entry.totalCacheWrite ?? 0) + entry.totalOutput, 0) / evidence.length : 0,
  fallbackRate: evidence.length ? evidence.filter(entry =>
   entry.method === "heuristic" || (Array.isArray(entry.providerRoutes) && entry.providerRoutes.some(route => route.successes < route.calls)),
  ).length / evidence.length : 0,
  damageRate: observedScores.size ? damaging / observedScores.size : 0,
  // Missing correlation ids are missing evidence, not silently excluded
  // from the denominator.
  damageCoverage: successfulRuns.length ? observedScores.size / successfulRuns.length : 0,
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
  damageCoverage: Math.round(value.damageCoverage * 1_000) / 1_000,
 };
}

export function assessCanary(
 entries: readonly CompactMetricsEntry[],
 damageEntries: readonly DamageTelemetryEntry[],
 options: { version: string; minCanaryRuns?: number; baselineRuns?: number },
): CanaryAssessment {
 const minCanaryRuns = Math.max(5, options.minCanaryRuns ?? 20);
 const canaryEntries = entries.filter(entry =>
  entry.metricsSchemaVersion === 2 && entry.version === options.version && entry.releaseChannel === "canary",
 ).slice(-Math.max(100, minCanaryRuns));
 // Unknown channels are never silently stable: entries without an explicit
 // releaseChannel are excluded from the baseline and surfaced as a reason.
 const baselineEntries = entries.filter(entry =>
  entry.metricsSchemaVersion === 2 && entry.releaseChannel === "stable",
 ).slice(-(options.baselineRuns ?? Math.max(50, minCanaryRuns * 2)));
 const unattributedRuns = entries.filter(entry =>
  entry.metricsSchemaVersion === 2 && entry.releaseChannel !== "stable" && entry.releaseChannel !== "canary",
 ).length;
 // Join observations by local runId instead of aligning unrelated JSONL
 // tails. Duplicate online/next-compaction observations collapse to the
 // highest score for their originating compaction.
 const baseline = stats(baselineEntries, damageEntries);
 const canary = stats(canaryEntries, damageEntries);
 const triggers: CanaryTrigger[] = [];
 const failureBaseline = 1 - baseline.successRate;
 const failureCanary = 1 - canary.successRate;
 if (canary.attemptedRuns >= 3 && (failureCanary > 0.050_001 || failureCanary - failureBaseline >= 0.050_001)) {
  triggers.push({
   metric: "failure-rate", baseline: failureBaseline, canary: failureCanary,
   threshold: failureCanary > 0.050_001 ? ">5% absolute" : "+5pp regression",
  });
 }
 if (canary.avgQuality != null && (canary.avgQuality < 85
  || (baseline.avgQuality != null && baseline.avgQuality - canary.avgQuality >= 5))) {
  triggers.push({
   metric: "quality", baseline: baseline.avgQuality ?? 0, canary: canary.avgQuality,
   threshold: canary.avgQuality < 85 ? "<85 absolute" : "-5 points",
  });
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

 const canarySampleAdequacy = Math.min(1, canary.appliedRuns / minCanaryRuns);
 const baselineSampleAdequacy = Math.min(1, baseline.appliedRuns / Math.max(20, minCanaryRuns));
 const dataConfidence = Math.round(100 * (
  canarySampleAdequacy * 0.25
  + baselineSampleAdequacy * 0.15
  + canary.qualityCoverage * canarySampleAdequacy * 0.2
  + canary.damageCoverage * canarySampleAdequacy * 0.2
  + baseline.damageCoverage * baselineSampleAdequacy * 0.2
 ));
 const reasons: string[] = [];
 let decision: CanaryAssessment["decision"] = "hold";
 if (triggers.length && canary.attemptedRuns >= 3) {
  decision = "rollback";
  reasons.push(...triggers.map(trigger => trigger.metric + " crossed " + trigger.threshold));
 } else if (canary.appliedRuns < minCanaryRuns) {
  reasons.push("need " + (minCanaryRuns - canary.appliedRuns) + " more canary runs with host-applied outcomes");
 } else if (baseline.appliedRuns < Math.max(20, minCanaryRuns)) {
  reasons.push("stable baseline is too small");
 } else if (canary.qualityCoverage < 0.7) {
  reasons.push("schema-v2 quality coverage is below 70%");
 } else if (baseline.qualityCoverage < 0.7) {
  reasons.push("stable baseline quality coverage is below 70%");
 } else if (canary.damageCoverage < 0.7) {
  reasons.push("correlated canary damage-observation coverage is below 70%");
 } else if (baseline.damageCoverage < 0.7) {
  reasons.push("correlated stable damage-observation coverage is below 70%");
 } else if ((canary.avgQuality ?? 0) < 85) {
  reasons.push("absolute verifier quality is below 85");
 } else if (canary.successRate < 0.949_999) {
  reasons.push("absolute success rate is below 95%");
 } else if (dataConfidence < 85) {
  reasons.push("data confidence " + dataConfidence + "% is below the agreed 85% promotion floor");
 } else {
  decision = "promote";
  reasons.push("sample, absolute quality, reliability, latency, token, fallback, damage, and data-confidence gates passed");
 }
 if (unattributedRuns > 0) {
  // Visible but non-gating: the rows are already excluded from every
  // cohort; stale unattributed history must not permanently block a
  // fully-evidenced promotion.
  reasons.push(unattributedRuns + " schema-v2 run(s) without an explicit release channel were excluded from both cohorts");
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

export const TELEMETRY_FAILURE_KINDS: ReadonlySet<TelemetryFailureKind> = new Set([
 "cancelled", "timeout", "rate-limit", "authentication", "budget",
 "output-limit", "provider", "persistence", "validation", "verification", "yield", "internal",
]);

export function isTelemetryFailureKind(value: unknown): value is TelemetryFailureKind {
 return typeof value === "string" && TELEMETRY_FAILURE_KINDS.has(value as TelemetryFailureKind);
}

function finiteNumber(value: number | undefined): value is number {
 return typeof value === "number" && Number.isFinite(value);
}

export function buildPreparationStats(

 entries: readonly CompactMetricsEntry[],
): PreparationPolicyStats {
 const prepared = entries.filter(entry => entry.preparation === "background");
 const used = prepared.filter(entry => entry.status === "success");
 const discarded = prepared.filter(entry => entry.status === "discarded");
 const other = prepared.filter(entry =>
  entry.status !== "success" && entry.status !== "discarded" && !neutralRun(entry));
 const discardReasons: Partial<Record<PreparationDiscardReason, number>> = {};
 const cost = { calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
 for (const entry of discarded) {
  if (typeof entry.preparationDiscardReason === "string") {
   discardReasons[entry.preparationDiscardReason] =
    (discardReasons[entry.preparationDiscardReason] ?? 0) + 1;
  }
  cost.calls += Math.max(0, entry.totalCalls ?? 0);
  cost.inputTokens += Math.max(0, entry.totalInput ?? 0);
  cost.cacheReadTokens += Math.max(0, entry.totalCacheHit ?? 0);
  cost.cacheWriteTokens += Math.max(0, entry.totalCacheWrite ?? 0);
  cost.outputTokens += Math.max(0, entry.totalOutput ?? 0);
 }
 const resolvable = used.length + discarded.length;
 return {
  preparedRuns: prepared.length,
  usedRuns: used.length,
  discardedRuns: discarded.length,
  otherOutcomes: other.length,
  discardReasons,
  medianReadyMs: median(prepared.map(entry => entry.preparationReadyMs).filter(finiteNumber)),
  medianWaitMs: median(prepared.map(entry => entry.preparationWaitMs).filter(finiteNumber)),
  reuseRate: resolvable ? used.length / resolvable : null,
  discardedCost: cost,
 };
}

export function buildQualityProvenanceStats(
 entries: readonly CompactMetricsEntry[],
): QualityProvenanceStats {
 const v2 = entries.filter(entry => entry.metricsSchemaVersion === 2);
 const final = v2.map(entry => entry.verificationScore).filter(finiteNumber);
 const initial = v2.map(entry => entry.initialVerificationScore).filter(finiteNumber);
 const gains = v2.flatMap(entry => finiteNumber(entry.verificationScore) && finiteNumber(entry.initialVerificationScore)
  ? [entry.verificationScore - entry.initialVerificationScore] : []);
 const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
 return {
  measuredRuns: final.length,
  avgInitialQuality: mean(initial),
  avgRepairGain: mean(gains),
  deterministicPatchRuns: v2.filter(entry => (entry.deterministicPatchCount ?? 0) > 0).length,
  llmPatchRuns: v2.filter(entry => entry.llmPatched).length,
  qualityFloorRuns: v2.filter(entry => entry.qualityFloorUsed).length,
 };
}

export function buildPrivacySafeTelemetry(
 entries: readonly CompactMetricsEntry[],
 damageEntries: readonly DamageTelemetryEntry[],
 options: { version: string; minCanaryRuns?: number },
): PrivacySafeTelemetry {
 const groups = new Map<string, {
  version: string; channel: PrivacySafeTelemetryAggregate["channel"]; provider: string; model: string;
  runs: number; successes: number; quality: number; qualityRuns: number;
  latency: number; input: number; cacheRead: number; cacheWrite: number; output: number;
 }>();
 const failures: Partial<Record<TelemetryFailureKind, number>> = {};
 for (const entry of entries) {
  const version = safeMetricLabel(entry.version, "legacy");
  const channel = entry.releaseChannel === "canary" ? "canary"
   : entry.releaseChannel === "stable" ? "stable" : "unknown";
  const provider = safeMetricLabel(entry.provider, "unknown");
  const rawModel = safeMetricLabel(entry.model, "unknown");
  const model = rawModel.startsWith(provider + "/") ? rawModel.slice(provider.length + 1) : rawModel;
  const key = [version, channel, provider, model].join("\u0000");
  const group = groups.get(key) ?? {
   version, channel, provider, model, runs: 0, successes: 0,
   quality: 0, qualityRuns: 0, latency: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
  };
  group.runs++;
  if (entry.status === "success") group.successes++;
  if (entry.metricsSchemaVersion === 2 && typeof entry.verificationScore === "number") {
   group.quality += entry.verificationScore;
   group.qualityRuns++;
  }
  group.latency += entry.avgLatency;
  group.input += entry.totalInput;
  group.cacheRead += entry.totalCacheHit;
  group.cacheWrite += entry.totalCacheWrite ?? 0;
  group.output += entry.totalOutput;
  groups.set(key, group);
  if (isTelemetryFailureKind(entry.failureKind)) {
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
  cacheReadTokens: group.cacheRead,
  cacheWriteTokens: group.cacheWrite,
  outputTokens: group.output,
 })).sort((a, b) => b.runs - a.runs || a.version.localeCompare(b.version));
 return {
  generatedAt: new Date().toISOString(),
  totalRuns: entries.length,
  aggregates,
  failures,
  canary: assessCanary(entries, damageEntries, options),
  preparation: buildPreparationStats(entries),
  qualityProvenance: buildQualityProvenanceStats(entries),
  privacy: "aggregate-only; no session ids, project ids, prompts, summaries, paths, or error text",
 };
}

export function formatPrivacySafeTelemetry(report: PrivacySafeTelemetry): string {
 const lines = [
  "# Smart Compact Telemetry", "",
  "Privacy: " + report.privacy + ".", "",
  "| Version | Channel | Provider/model | Runs | Applied | Quality | Latency | Input | Cache R/W | Output |",
  "|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
 ];
 for (const item of report.aggregates) {
  lines.push("| " + item.version + " | " + item.channel + " | " + item.provider + "/" + item.model +
   " | " + item.runs + " | " + item.successes + "/" + item.runs + " | " +
   (item.avgQuality == null ? "n/a" : item.avgQuality.toFixed(1)) + " | " + item.avgLatencyMs +
   "ms | " + item.inputTokens + " | " + item.cacheReadTokens + "/" + item.cacheWriteTokens +
   " | " + item.outputTokens + " |");
 }
 lines.push("", "## Canary: " + report.canary.decision.toUpperCase() + " (data confidence " + report.canary.dataConfidence + "%)", "");
 const baseline = report.canary.baseline;
 const canary = report.canary.canary;
 lines.push(
  "| Gate | Stable baseline | Canary |",
  "|---|---:|---:|",
  "| Runs (total/attempted/applied) | " + baseline.runs + "/" + baseline.attemptedRuns + "/" + baseline.appliedRuns + " | " + canary.runs + "/" + canary.attemptedRuns + "/" + canary.appliedRuns + " |",
  "| Success | " + Math.round(baseline.successRate * 100) + "% | " + Math.round(canary.successRate * 100) + "% |",
  "| Verify quality | " + (baseline.avgQuality ?? "n/a") + " | " + (canary.avgQuality ?? "n/a") + " |",
  "| p95 duration | " + baseline.p95LatencyMs + "ms | " + canary.p95LatencyMs + "ms |",
  "| Avg tokens | " + baseline.avgTokens + " | " + canary.avgTokens + " |",
  "| Fallback | " + Math.round(baseline.fallbackRate * 100) + "% | " + Math.round(canary.fallbackRate * 100) + "% |",
  "| Damage | " + Math.round(baseline.damageRate * 100) + "% | " + Math.round(canary.damageRate * 100) + "% |",
  "| Damage observed | " + Math.round(baseline.damageCoverage * 100) + "% | " + Math.round(canary.damageCoverage * 100) + "% |",
  "",
 );
 for (const reason of report.canary.reasons) lines.push("- " + reason);
 const failureText = Object.entries(report.failures).map(([kind, count]) => kind + "=" + count).join(", ");
 lines.push("", "Failures: " + (failureText || "none classified"));
 const prep = report.preparation;
 if (prep.preparedRuns > 0) {
  const reasons = Object.entries(prep.discardReasons).map(([kind, count]) => kind + "=" + count).join(", ");
  lines.push(
   "",
   "## Preparation policy",
   "",
   "Prepared " + prep.preparedRuns + " | used " + prep.usedRuns + " | discarded " + prep.discardedRuns
   + (prep.otherOutcomes ? " | failed " + prep.otherOutcomes : ""),
   "Reuse rate: " + (prep.reuseRate == null ? "n/a" : Math.round(prep.reuseRate * 100) + "%")
   + " | median ready " + (prep.medianReadyMs ?? "n/a") + "ms"
   + " | median wait " + (prep.medianWaitMs ?? "n/a") + "ms",
   "Discard reasons: " + (reasons || "none"),
   "Discarded spend (counted once, never applied evidence): " + prep.discardedCost.calls + " calls, "
   + prep.discardedCost.inputTokens + "t in, " + prep.discardedCost.cacheReadTokens + "t cache read, "
   + prep.discardedCost.cacheWriteTokens + "t cache write, " + prep.discardedCost.outputTokens + "t out",
  );
 }
 const provenance = report.qualityProvenance;
 lines.push(
  "",
  "Quality provenance: measured " + provenance.measuredRuns
  + " | initial avg " + (provenance.avgInitialQuality == null ? "n/a" : provenance.avgInitialQuality.toFixed(1))
  + " | repair gain " + (provenance.avgRepairGain == null ? "n/a" : provenance.avgRepairGain.toFixed(1))
  + " | deterministic " + provenance.deterministicPatchRuns
  + " | LLM " + provenance.llmPatchRuns
  + " | quality-floor " + provenance.qualityFloorRuns,
 );
 return lines.join("\n");
}
