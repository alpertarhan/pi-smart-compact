import type { CompactMetricsEntry } from "../types.ts";
import { VERSION } from "../constants.ts";
import { damageReportsFile, metricsDashboardFile } from "../infra/paths.ts";
import { atomicWriteFileSync, readJsonlTail } from "../infra/fs.ts";
import type { DamageTelemetryEntry } from "../domain/telemetry.ts";
import { buildDashboardInsights, type DashboardInsights } from "./dashboard-insights.ts";
import * as log from "../utils/logger.ts";
import { readMetricsLog } from "../utils/cache.ts";
import { metricDuration, metricMs, metricNum, metricPct } from "./dashboard-format.ts";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>\"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] ?? c));
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))];
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: Math.abs(value) >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function statusClass(status?: string): "good" | "warn" | "bad" {
  if (status === "timeout" || status === "error") return "bad";
  if (status === "dry-run" || status === "cancelled") return "warn";
  return "good";
}

function statusLabel(status?: string): string {
  return status ?? "success";
}

function badge(status?: string): string {
  const label = statusLabel(status);
  return `<span class="badge ${statusClass(label)}">${escapeHtml(label)}</span>`;
}

interface MetricsDashboardSummary {
  runs: number;
  success: number;
  timeout: number;
  error: number;
  dryRun: number;
  successRate: number;
  avgDuration: number;
  p95Duration: number;
  totalCalls: number;
  totalInput: number;
  totalOutput: number;
  totalSaved: number;
  avgScore: number;
}

interface MetricsGroupSummary {
  name: string;
  runs: number;
  avgDuration: number;
  p95Duration: number;
  avgScore: number;
  totalSaved: number;
  totalCalls: number;
  errorRate: number;
}

function summarizeDashboard(entries: CompactMetricsEntry[]): MetricsDashboardSummary {
  const durations = entries.map(metricDuration).filter(Boolean);
  const success = entries.filter(e => statusLabel(e.status) === "success").length;
  const timeout = entries.filter(e => e.status === "timeout").length;
  const error = entries.filter(e => e.status === "error").length;
  const dryRun = entries.filter(e => e.status === "dry-run").length;
  const scored = entries.map(e => e.verificationScore).filter((v): v is number => typeof v === "number");
  return {
    runs: entries.length,
    success,
    timeout,
    error,
    dryRun,
    successRate: entries.length ? success / entries.length : 0,
    avgDuration: Math.round(average(durations)),
    p95Duration: percentile(durations, 95),
    totalCalls: entries.reduce((sum, e) => sum + (e.totalCalls ?? 0), 0),
    totalInput: entries.reduce((sum, e) =>
      sum + (e.totalInput ?? 0) + (e.totalCacheHit ?? 0) + (e.totalCacheWrite ?? 0), 0),
    totalOutput: entries.reduce((sum, e) => sum + (e.totalOutput ?? 0), 0),
    totalSaved: entries.reduce((sum, e) => sum + (e.tokensSaved ?? 0), 0),
    avgScore: Math.round(average(scored)),
  };
}

function groupMetrics(entries: CompactMetricsEntry[], keyFn: (entry: CompactMetricsEntry) => string | undefined): MetricsGroupSummary[] {
  const groups = new Map<string, CompactMetricsEntry[]>();
  for (const entry of entries) {
    const key = keyFn(entry);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()].map(([name, group]) => {
    const durations = group.map(metricDuration).filter(Boolean);
    const scores = group.map(e => e.verificationScore).filter((v): v is number => typeof v === "number");
    const failures = group.filter(e => e.status === "timeout" || e.status === "error").length;
    return {
      name,
      runs: group.length,
      avgDuration: Math.round(average(durations)),
      p95Duration: percentile(durations, 95),
      avgScore: Math.round(average(scores)),
      totalSaved: group.reduce((sum, e) => sum + (e.tokensSaved ?? 0), 0),
      totalCalls: group.reduce((sum, e) => sum + (e.totalCalls ?? 0), 0),
      errorRate: group.length ? failures / group.length : 0,
    };
  }).sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
}

function progressBar(value: number, label = metricPct(value)): string {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return `<div class="meter" title="${escapeHtml(label)}"><span style="width:${pct}%"></span></div>`;
}

function sparkline(values: number[]): string {
  const nums = values.filter(v => Number.isFinite(v));
  if (nums.length < 2) return `<div class="empty">Need at least two runs for trend</div>`;
  const width = 520;
  const height = 120;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = Math.max(1, max - min);
  const points = nums.map((value, i) => {
    const x = (i / Math.max(1, nums.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 18) - 9;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = nums[nums.length - 1];
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="Duration trend"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${width}" cy="${(height - ((last - min) / span) * (height - 18) - 9).toFixed(1)}" r="4" fill="currentColor"/><text x="0" y="14">${escapeHtml(metricMs(max))}</text><text x="0" y="${height - 4}">${escapeHtml(metricMs(min))}</text></svg>`;
}

function metricCard(label: string, value: string, detail: string, tone: "neutral" | "good" | "warn" | "bad" = "neutral"): string {
  return `<article class="card ${tone}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="detail">${escapeHtml(detail)}</div></article>`;
}

function comparisonRows(groups: MetricsGroupSummary[]): string {
  if (!groups.length) return `<tr><td colspan="8" class="empty">No data yet</td></tr>`;
  return groups.map(group => `<tr>
    <td><strong>${escapeHtml(group.name)}</strong></td>
    <td class="num">${metricNum(group.runs)}</td>
    <td class="num">${escapeHtml(metricMs(group.avgDuration))}</td>
    <td class="num">${escapeHtml(metricMs(group.p95Duration))}</td>
    <td class="num">${group.avgScore ? metricNum(group.avgScore) : "—"}</td>
    <td class="num">${metricNum(group.totalCalls)}</td>
    <td class="num">${metricNum(group.totalSaved)}</td>
    <td>${progressBar(1 - group.errorRate, metricPct(1 - group.errorRate) + " reliable")}</td>
  </tr>`).join("\n");
}

function providerRouteRows(insights: DashboardInsights): string {
  if (!insights.providers.length) return `<tr><td colspan="9" class="empty">No stage-route evidence yet</td></tr>`;
  return insights.providers.map(item => `<tr>
    <td>${escapeHtml(item.stage)}</td><td><strong>${escapeHtml(item.provider + "/" + item.model)}</strong></td>
    <td class="num">${metricNum(item.runs)}</td><td class="num">${metricNum(item.calls)}</td>
    <td class="num">${metricPct(item.reliability)}</td>
    <td class="num">${item.avgQuality == null ? "—" : item.avgQuality.toFixed(1)}</td>
    <td class="num">${metricPct(item.qualityCoverage)}</td>
    <td class="num">${escapeHtml(metricMs(item.avgLatencyMs))}</td>
    <td class="num">${metricNum(item.avgTokensPerCall)}</td>
  </tr>`).join("\n");
}

function canaryRows(insights: DashboardInsights): string {
  const baseline = insights.canary.baseline;
  const canary = insights.canary.canary;
  const rows: Array<[string, string, string]> = [
    ["Runs (total/applied)", metricNum(baseline.runs) + "/" + metricNum(baseline.appliedRuns), metricNum(canary.runs) + "/" + metricNum(canary.appliedRuns)],
    ["Success", metricPct(baseline.successRate), metricPct(canary.successRate)],
    ["Verify quality", baseline.avgQuality?.toFixed(1) ?? "—", canary.avgQuality?.toFixed(1) ?? "—"],
    ["p95 duration", metricMs(baseline.p95LatencyMs), metricMs(canary.p95LatencyMs)],
    ["Avg tokens", metricNum(baseline.avgTokens), metricNum(canary.avgTokens)],
    ["Fallback", metricPct(baseline.fallbackRate), metricPct(canary.fallbackRate)],
    ["Damage", metricPct(baseline.damageRate), metricPct(canary.damageRate)],
    ["Damage observed", metricPct(baseline.damageCoverage), metricPct(canary.damageCoverage)],
  ];
  return rows.map(row => `<tr><td>${escapeHtml(row[0])}</td><td class="num">${escapeHtml(row[1])}</td><td class="num">${escapeHtml(row[2])}</td></tr>`).join("\n");
}

function qualityRows(insights: DashboardInsights): string {
  const quality = insights.quality;
  const values: Array<[string, string]> = [
    ["Quality Health", quality.healthScore + "/100 (" + quality.healthLabel + ")"],
    ["Measured / missing", quality.measuredRuns + " / " + quality.missingRuns],
    ["Average / median / minimum", (quality.average?.toFixed(1) ?? "—") + " / " + (quality.median?.toFixed(1) ?? "—") + " / " + (quality.minimum?.toFixed(1) ?? "—")],
    ["Excellent ≥90 / pass 75–89 / low <75", quality.excellent + " / " + quality.passing + " / " + quality.low],
    ["Initial average / repair gain", (quality.averageInitial?.toFixed(1) ?? "—") + " / " + (quality.averageRepairGain?.toFixed(1) ?? "—")],
    ["Deterministic / LLM / quality-floor runs", quality.deterministicPatchedRuns + " / " + quality.llmPatchedRuns + " / " + quality.qualityFloorRuns],
    ["Remaining verification gaps", String(quality.remainingGaps)],
  ];
  return values.map(row => `<tr><td>${escapeHtml(row[0])}</td><td class="num">${escapeHtml(row[1])}</td></tr>`).join("\n");
}

function failureRows(insights: DashboardInsights): string {
  const rows = Object.entries(insights.failures);
  if (!rows.length) return `<tr><td colspan="2" class="empty">No schema-v2 failures classified</td></tr>`;
  return rows.sort((a, b) => b[1] - a[1]).map(([kind, count]) => `<tr><td>${escapeHtml(kind)}</td><td class="num">${metricNum(count)}</td></tr>`).join("\n");
}

function phaseRows(entry?: CompactMetricsEntry): string {
  const timings = entry?.phaseTimings ?? [];
  if (!timings.length) return `<tr><td colspan="3" class="empty">No phase timings yet</td></tr>`;
  const total = timings.reduce((sum, phase) => sum + phase.durationMs, 0) || 1;
  return timings.map(phase => `<tr>
    <td>${escapeHtml(phase.phase)}</td>
    <td class="num">${escapeHtml(metricMs(phase.durationMs))}</td>
    <td>${progressBar(phase.durationMs / total, metricPct(phase.durationMs / total))}</td>
  </tr>`).join("\n");
}

function recentRunRows(entries: CompactMetricsEntry[]): string {
  if (!entries.length) return `<tr><td colspan="13" class="empty">No runs recorded yet</td></tr>`;
  return entries.slice(-80).reverse().map(entry => `<tr>
    <td class="mono small">${escapeHtml(entry.ts)}</td>
    <td>${escapeHtml(entry.mode ?? entry.profile)}</td>
    <td>${escapeHtml(entry.provider ?? entry.model?.split("/")[0])}</td>
    <td>${escapeHtml(entry.method)}</td>
    <td>${escapeHtml(entry.runType)}</td>
    <td>${escapeHtml((entry.version ?? "legacy") + "/" + (entry.releaseChannel ?? "stable"))}</td>
    <td>${badge(entry.status)}</td>
    <td class="num">${escapeHtml(metricMs(metricDuration(entry)))}</td>
    <td class="num">${typeof entry.verificationScore === "number" ? metricNum(entry.verificationScore) : "—"}</td>
    <td class="num">${typeof entry.tokensSaved === "number" ? metricNum(entry.tokensSaved) : "—"}</td>
    <td class="num">${metricNum(entry.totalCalls ?? 0)}</td>
    <td class="num">${typeof entry.extractionCacheHitRate === "number" ? metricPct(entry.extractionCacheHitRate) : "—"}</td>
    <td class="mono small reason">${escapeHtml(entry.failureKind ?? entry.fallbackReason ?? entry.extractionCacheMissReason ?? "")}</td>
  </tr>`).join("\n");
}

function dashboardCss(): string {
  return `:root{color-scheme:dark;--bg:#08111f;--surface:#0f172a;--surface2:#111c33;--card:#111827;--text:#e5edf8;--muted:#8fa3bf;--line:#24324a;--accent:#60a5fa;--good:#22c55e;--bad:#fb7185;--warn:#fbbf24;--shadow:0 18px 50px rgba(0,0,0,.28)}@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f7fb;--surface:#ffffff;--surface2:#f8fafc;--card:#ffffff;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--shadow:0 18px 50px rgba(15,23,42,.08)}}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,rgba(96,165,250,.20),transparent 34rem),var(--bg);color:var(--text);font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}main{max-width:1280px;margin:0 auto;padding:32px}header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:24px}.eyebrow{color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:12px}h1{font-size:32px;line-height:1.1;margin:6px 0 6px}.muted,.detail{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:20px 0 22px}.card{background:linear-gradient(180deg,rgba(255,255,255,.035),transparent),var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;box-shadow:var(--shadow)}.card.good{border-color:rgba(34,197,94,.45)}.card.warn{border-color:rgba(251,191,36,.45)}.card.bad{border-color:rgba(251,113,133,.5)}.label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:700}.value{font-size:28px;font-weight:800;margin-top:6px}.layout{display:grid;grid-template-columns:1.15fr .85fr;gap:18px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}.panel h2{display:flex;align-items:center;justify-content:space-between;margin:0;padding:15px 18px;background:linear-gradient(180deg,rgba(255,255,255,.035),transparent),var(--surface2);font-size:15px}.table-wrap{overflow:auto;max-height:560px}table{border-collapse:separate;border-spacing:0;width:100%}th,td{border-bottom:1px solid var(--line);padding:9px 11px;text-align:left;vertical-align:middle;white-space:nowrap}th{position:sticky;top:0;z-index:1;background:var(--surface2);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}tr:hover td{background:rgba(96,165,250,.06)}.num{text-align:right}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.small{font-size:12px}.reason{max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 9px;font-size:12px;font-weight:800}.badge.good{background:rgba(34,197,94,.14);color:var(--good)}.badge.bad{background:rgba(251,113,133,.16);color:var(--bad)}.badge.warn{background:rgba(251,191,36,.16);color:var(--warn)}.meter{height:8px;background:rgba(148,163,184,.22);border-radius:99px;min-width:96px;overflow:hidden}.meter span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent),var(--good))}.spark{width:100%;height:160px;color:var(--accent);padding:18px}.spark text{fill:var(--muted);font-size:12px}.empty{padding:18px;color:var(--muted);text-align:center}pre{white-space:pre-wrap;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px;overflow:auto}.section{margin-top:18px}.two{display:grid;grid-template-columns:1fr 1fr;gap:18px}@media(max-width:960px){main{padding:20px}.cards,.layout,.two{grid-template-columns:1fr}header{display:block}th,td{padding:8px}.value{font-size:24px}}`;
}

export function buildLocalDashboardInsights(
  entries = readMetricsLog(200),
  damageEntries = readJsonlTail<DamageTelemetryEntry>(damageReportsFile(), 1_000),
): DashboardInsights {
  return buildDashboardInsights(entries, damageEntries, { version: VERSION });
}

export function buildMetricsReport(
  entries = readMetricsLog(100),
  damageEntries?: DamageTelemetryEntry[],
  prebuiltInsights?: DashboardInsights,
): string {
  if (!entries.length) return "No smart-compact metrics recorded yet.";
  const summary = summarizeDashboard(entries);
  const insights = prebuiltInsights ?? buildLocalDashboardInsights(entries, damageEntries);
  const byMode = groupMetrics(entries, e => e.mode);
  const byProfile = groupMetrics(entries, e => e.profile);
  const byProvider = groupMetrics(entries, e => e.provider ?? e.model?.split("/")[0]);
  const summarizeGroup = (group: MetricsGroupSummary) => "- " + group.name + ": n=" + group.runs + ", avg=" + group.avgDuration + "ms, p95=" + group.p95Duration + "ms, score=" + group.avgScore + ", saved=" + group.totalSaved + "t, reliability=" + metricPct(1 - group.errorRate);
  const extractionCacheRuns = entries.filter(e => typeof e.extractionCacheHitRate === "number");
  const extractionCacheAvg = average(extractionCacheRuns.map(e => e.extractionCacheHitRate ?? 0));
  const confidence = insights.confidence;
  const quality = insights.quality;
  const canary = insights.canary;
  const providerRoutes = insights.providers.map(item =>
    "- " + item.stage + " / " + item.provider + "/" + item.model + ": n=" + item.runs +
    ", reliability=" + metricPct(item.reliability) + ", quality=" + (item.avgQuality?.toFixed(1) ?? "—") +
    " (coverage " + metricPct(item.qualityCoverage) + "), latency=" + metricMs(item.avgLatencyMs) +
    ", tokens/call=" + item.avgTokensPerCall,
  );
  return [
    "# Smart Compact Metrics",
    "",
    "Runs: " + summary.runs + " (success " + summary.success + ", dry-run " + summary.dryRun + ", timeout " + summary.timeout + ", error " + summary.error + ")",
    "Reliability: " + metricPct(summary.successRate),
    "Latency: avg " + summary.avgDuration + "ms, p95 " + summary.p95Duration + "ms",
    "LLM calls: " + summary.totalCalls + ", input " + summary.totalInput + "t, output " + summary.totalOutput + "t",
    "Extraction cache: avg " + (extractionCacheRuns.length ? metricPct(extractionCacheAvg) : "—") + " across " + extractionCacheRuns.length + " measured run(s)",
    "Tokens saved: " + summary.totalSaved + "t, average verification score: " + summary.avgScore,
    "Data Confidence: " + confidence.score + "/100 (telemetry completeness; target ≥85 " + (confidence.targetMet ? "met" : "not met") + ")",
    "Quality Health: " + quality.healthScore + "/100 (" + quality.healthLabel + "; target ≥85 " + (quality.targetMet ? "met" : "not met") + ")",
    "Evidence: sample " + confidence.sampleScore + "/25 · schema-v2 " + confidence.schemaScore + "/25 · quality " + confidence.qualityScore + "/20 · completeness " + confidence.completenessScore + "/20 · freshness " + confidence.freshnessScore + "/10",
    ...confidence.guidance.map(item => "- " + item),
    "",
    "## Quality drilldown",
    "- Measured/missing: " + quality.measuredRuns + "/" + quality.missingRuns + "; average " + (quality.average?.toFixed(1) ?? "—") + "; median " + (quality.median?.toFixed(1) ?? "—") + "; minimum " + (quality.minimum?.toFixed(1) ?? "—"),
    "- Bands: excellent ≥90 " + quality.excellent + " · pass 75–89 " + quality.passing + " · low <75 " + quality.low,
    "- Repair: initial average " + (quality.averageInitial?.toFixed(1) ?? "—") + " · average gain " + (quality.averageRepairGain?.toFixed(1) ?? "—") + " · deterministic " + quality.deterministicPatchedRuns + " · LLM " + quality.llmPatchedRuns + " · quality floor " + quality.qualityFloorRuns + " · remaining gaps " + quality.remainingGaps,
    "",
    "## Canary / stable control",
    "Decision: " + canary.decision.toUpperCase() + " · confidence " + canary.dataConfidence + "% · stable total/applied=" + canary.baseline.runs + "/" + canary.baseline.appliedRuns + " · canary total/applied=" + canary.canary.runs + "/" + canary.canary.appliedRuns,
    ...canary.reasons.map(item => "- " + item),
    ...canary.triggers.map(item => "- Trigger " + item.metric + ": stable " + item.baseline + " → canary " + item.canary + " (" + item.threshold + ")"),
    "",
    "## Mode comparison",
    ...(byMode.length ? byMode.map(summarizeGroup) : ["- No mode-tagged runs yet"]),
    "",
    "## Profile comparison",
    ...byProfile.map(summarizeGroup),
    "",
    "## Provider comparison",
    ...byProvider.map(summarizeGroup),
    "",
    "## Stage provider/model comparison",
    ...(providerRoutes.length ? providerRoutes : ["- No stage-route evidence yet"]),
    "",
    "## Failure taxonomy",
    ...(Object.keys(insights.failures).length
      ? Object.entries(insights.failures).map(([kind, count]) => "- " + kind + ": " + count)
      : ["- No schema-v2 failures classified"]),
  ].join("\n");
}

export function writeMetricsDashboard(
  entries = readMetricsLog(200),
  damageEntries = readJsonlTail<DamageTelemetryEntry>(damageReportsFile(), 1_000),
): string | null {
  try {
    const summary = summarizeDashboard(entries);
    const insights = buildLocalDashboardInsights(entries, damageEntries);
    const latest = entries[entries.length - 1];
    const report = buildMetricsReport(entries, damageEntries);
    const profileGroups = groupMetrics(entries, e => e.profile);
    const providerGroups = groupMetrics(entries, e => e.provider ?? e.model?.split("/")[0]);
    const healthTone = summary.error + summary.timeout > 0 ? "warn" : "good";
    const confidenceTone = insights.confidence.targetMet ? "good" : insights.confidence.score >= 60 ? "warn" : "bad";
    const qualityTone = insights.quality.targetMet ? "good" : insights.quality.healthScore >= 60 ? "warn" : "bad";
    const canaryTone = insights.canary.decision === "promote" ? "good" : insights.canary.decision === "rollback" ? "bad" : "warn";
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Smart Compact Metrics</title><style>${dashboardCss()}</style></head><body><main>
      <header><div><div class="eyebrow">pi-smart-compact</div><h1>Operational Metrics</h1><div class="muted">Generated ${escapeHtml(new Date().toISOString())} · ${metricNum(entries.length)} recent runs · local file dashboard</div></div><div>${badge(latest?.status)} ${latest ? `<span class="muted">latest ${escapeHtml(latest.mode ?? latest.profile ?? "unknown")}</span>` : ""}</div></header>
      <section class="cards">
        ${metricCard("Reliability", metricPct(summary.successRate), `${summary.success} success · ${summary.timeout} timeout · ${summary.error} error`, healthTone)}
        ${metricCard("Avg duration", metricMs(summary.avgDuration), `p95 ${metricMs(summary.p95Duration)}`)}
        ${metricCard("LLM calls", compactNumber(summary.totalCalls), `${compactNumber(summary.totalInput)} input · ${compactNumber(summary.totalOutput)} output`)}
        ${metricCard("Tokens saved", compactNumber(summary.totalSaved), `avg score ${summary.avgScore || "—"}`)}
        ${metricCard("Data Confidence", insights.confidence.score + "/100", `telemetry completeness · target ≥85 ${insights.confidence.targetMet ? "met" : "not met"}`, confidenceTone)}
        ${metricCard("Quality Health", insights.quality.healthScore + "/100", `actual outcomes · target ≥85 ${insights.quality.targetMet ? "met" : "not met"}`, qualityTone)}
        ${metricCard("Canary gate", insights.canary.decision.toUpperCase(), `${insights.canary.canary.runs}/${insights.canary.canary.appliedRuns} canary total/applied · ${insights.canary.dataConfidence}% confidence`, canaryTone)}
      </section>
      <section class="layout">
        <div class="panel"><h2>Duration trend <span class="muted">last ${Math.min(entries.length, 80)} runs</span></h2>${sparkline(entries.slice(-80).map(metricDuration))}</div>
        <div class="panel"><h2>Latest phase timings</h2><div class="table-wrap"><table><thead><tr><th>Phase</th><th class="num">Duration</th><th>Share</th></tr></thead><tbody>${phaseRows(latest)}</tbody></table></div></div>
      </section>
      <section class="two section">
        <div class="panel"><h2>Quality drilldown <span class="muted">schema-v2 only</span></h2><div class="table-wrap"><table><thead><tr><th>Evidence</th><th class="num">Value</th></tr></thead><tbody>${qualityRows(insights)}</tbody></table></div></div>
        <div class="panel"><h2>Canary vs stable <span class="badge ${statusClass(insights.canary.decision === "rollback" ? "error" : insights.canary.decision === "promote" ? "success" : "dry-run")}">${escapeHtml(insights.canary.decision)}</span></h2><div class="table-wrap"><table><thead><tr><th>Gate</th><th class="num">Stable</th><th class="num">Canary</th></tr></thead><tbody>${canaryRows(insights)}</tbody></table></div></div>
      </section>
      <section class="two section">
        <div class="panel"><h2>Profile comparison</h2><div class="table-wrap"><table><thead><tr><th>Profile</th><th class="num">Runs</th><th class="num">Avg</th><th class="num">p95</th><th class="num">Score</th><th class="num">Calls</th><th class="num">Saved</th><th>Reliability</th></tr></thead><tbody>${comparisonRows(profileGroups)}</tbody></table></div></div>
        <div class="panel"><h2>Provider comparison</h2><div class="table-wrap"><table><thead><tr><th>Provider</th><th class="num">Runs</th><th class="num">Avg</th><th class="num">p95</th><th class="num">Score</th><th class="num">Calls</th><th class="num">Saved</th><th>Reliability</th></tr></thead><tbody>${comparisonRows(providerGroups)}</tbody></table></div></div>
      </section>
      <section class="panel section"><h2>Stage provider/model comparison <span class="muted">quality coverage is explicit</span></h2><div class="table-wrap"><table><thead><tr><th>Stage</th><th>Provider/model</th><th class="num">Runs</th><th class="num">Calls</th><th class="num">Reliable</th><th class="num">Quality</th><th class="num">Coverage</th><th class="num">Latency</th><th class="num">Tokens/call</th></tr></thead><tbody>${providerRouteRows(insights)}</tbody></table></div></section>
      <section class="two section">
        <div class="panel"><h2>Data Confidence evidence</h2><div class="table-wrap"><table><tbody>
          <tr><td>Sample</td><td class="num">${insights.confidence.sampleScore}/25</td></tr><tr><td>Schema v2</td><td class="num">${insights.confidence.schemaScore}/25</td></tr><tr><td>Quality coverage</td><td class="num">${insights.confidence.qualityScore}/20</td></tr><tr><td>Completeness</td><td class="num">${insights.confidence.completenessScore}/20</td></tr><tr><td>Freshness</td><td class="num">${insights.confidence.freshnessScore}/10</td></tr>
        </tbody></table></div><div class="empty">${escapeHtml(insights.confidence.guidance.join(" · ") || "Evidence target met")}</div></div>
        <div class="panel"><h2>Failure taxonomy</h2><div class="table-wrap"><table><thead><tr><th>Kind</th><th class="num">Runs</th></tr></thead><tbody>${failureRows(insights)}</tbody></table></div></div>
      </section>
      <section class="panel section"><h2>Recent runs</h2><div class="table-wrap"><table><thead><tr><th>Time</th><th>Mode</th><th>Provider</th><th>Method</th><th>Run</th><th>Version/channel</th><th>Status</th><th class="num">Duration</th><th class="num">Score</th><th class="num">Saved</th><th class="num">Calls</th><th class="num">Ext cache</th><th>Reason</th></tr></thead><tbody>${recentRunRows(entries)}</tbody></table></div></section>
      <section class="section"><h2>Raw text report</h2><pre>${escapeHtml(report)}</pre></section>
    </main></body></html>`;
    const fp = metricsDashboardFile();
    atomicWriteFileSync(fp, html);
    return fp;
  } catch (e) { log.warn("writeMetricsDashboard failed", e); return null; }
}
