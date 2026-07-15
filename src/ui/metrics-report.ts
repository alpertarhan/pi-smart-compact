import type { CompactMetricsEntry } from "../types.ts";
import { metricsDashboardFile } from "../infra/paths.ts";
import { atomicWriteFileSync } from "../infra/fs.ts";
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
    totalInput: entries.reduce((sum, e) => sum + (e.totalInput ?? 0), 0),
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
  if (!entries.length) return `<tr><td colspan="12" class="empty">No runs recorded yet</td></tr>`;
  return entries.slice(-80).reverse().map(entry => `<tr>
    <td class="mono small">${escapeHtml(entry.ts)}</td>
    <td>${escapeHtml(entry.profile)}</td>
    <td>${escapeHtml(entry.provider ?? entry.model?.split("/")[0])}</td>
    <td>${escapeHtml(entry.method)}</td>
    <td>${escapeHtml(entry.runType)}</td>
    <td>${badge(entry.status)}</td>
    <td class="num">${escapeHtml(metricMs(metricDuration(entry)))}</td>
    <td class="num">${typeof entry.verificationScore === "number" ? metricNum(entry.verificationScore) : "—"}</td>
    <td class="num">${typeof entry.tokensSaved === "number" ? metricNum(entry.tokensSaved) : "—"}</td>
    <td class="num">${metricNum(entry.totalCalls ?? 0)}</td>
    <td class="num">${typeof entry.extractionCacheHitRate === "number" ? metricPct(entry.extractionCacheHitRate) : "—"}</td>
    <td class="mono small reason">${escapeHtml(entry.fallbackReason ?? entry.extractionCacheMissReason ?? "")}</td>
  </tr>`).join("\n");
}

function dashboardCss(): string {
  return `:root{color-scheme:dark;--bg:#08111f;--surface:#0f172a;--surface2:#111c33;--card:#111827;--text:#e5edf8;--muted:#8fa3bf;--line:#24324a;--accent:#60a5fa;--good:#22c55e;--bad:#fb7185;--warn:#fbbf24;--shadow:0 18px 50px rgba(0,0,0,.28)}@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f7fb;--surface:#ffffff;--surface2:#f8fafc;--card:#ffffff;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--shadow:0 18px 50px rgba(15,23,42,.08)}}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,rgba(96,165,250,.20),transparent 34rem),var(--bg);color:var(--text);font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}main{max-width:1280px;margin:0 auto;padding:32px}header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:24px}.eyebrow{color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:12px}h1{font-size:32px;line-height:1.1;margin:6px 0 6px}.muted,.detail{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:20px 0 22px}.card{background:linear-gradient(180deg,rgba(255,255,255,.035),transparent),var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;box-shadow:var(--shadow)}.card.good{border-color:rgba(34,197,94,.45)}.card.warn{border-color:rgba(251,191,36,.45)}.card.bad{border-color:rgba(251,113,133,.5)}.label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:700}.value{font-size:28px;font-weight:800;margin-top:6px}.layout{display:grid;grid-template-columns:1.15fr .85fr;gap:18px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}.panel h2{display:flex;align-items:center;justify-content:space-between;margin:0;padding:15px 18px;background:linear-gradient(180deg,rgba(255,255,255,.035),transparent),var(--surface2);font-size:15px}.table-wrap{overflow:auto;max-height:560px}table{border-collapse:separate;border-spacing:0;width:100%}th,td{border-bottom:1px solid var(--line);padding:9px 11px;text-align:left;vertical-align:middle;white-space:nowrap}th{position:sticky;top:0;z-index:1;background:var(--surface2);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}tr:hover td{background:rgba(96,165,250,.06)}.num{text-align:right}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.small{font-size:12px}.reason{max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 9px;font-size:12px;font-weight:800}.badge.good{background:rgba(34,197,94,.14);color:var(--good)}.badge.bad{background:rgba(251,113,133,.16);color:var(--bad)}.badge.warn{background:rgba(251,191,36,.16);color:var(--warn)}.meter{height:8px;background:rgba(148,163,184,.22);border-radius:99px;min-width:96px;overflow:hidden}.meter span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent),var(--good))}.spark{width:100%;height:160px;color:var(--accent);padding:18px}.spark text{fill:var(--muted);font-size:12px}.empty{padding:18px;color:var(--muted);text-align:center}pre{white-space:pre-wrap;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px;overflow:auto}.section{margin-top:18px}.two{display:grid;grid-template-columns:1fr 1fr;gap:18px}@media(max-width:960px){main{padding:20px}.cards,.layout,.two{grid-template-columns:1fr}header{display:block}th,td{padding:8px}.value{font-size:24px}}`;
}

export function buildMetricsReport(entries = readMetricsLog(100)): string {
  if (!entries.length) return "No smart-compact metrics recorded yet.";
  const summary = summarizeDashboard(entries);
  const byProfile = groupMetrics(entries, e => e.profile);
  const byProvider = groupMetrics(entries, e => e.provider ?? e.model?.split("/")[0]);
  const summarizeGroup = (group: MetricsGroupSummary) => "- " + group.name + ": n=" + group.runs + ", avg=" + group.avgDuration + "ms, p95=" + group.p95Duration + "ms, score=" + group.avgScore + ", saved=" + group.totalSaved + "t, reliability=" + metricPct(1 - group.errorRate);
  const extractionCacheRuns = entries.filter(e => typeof e.extractionCacheHitRate === "number");
  const extractionCacheAvg = average(extractionCacheRuns.map(e => e.extractionCacheHitRate ?? 0));
  return [
    "# Smart Compact Metrics",
    "",
    "Runs: " + summary.runs + " (success " + summary.success + ", dry-run " + summary.dryRun + ", timeout " + summary.timeout + ", error " + summary.error + ")",
    "Reliability: " + metricPct(summary.successRate),
    "Latency: avg " + summary.avgDuration + "ms, p95 " + summary.p95Duration + "ms",
    "LLM calls: " + summary.totalCalls + ", input " + summary.totalInput + "t, output " + summary.totalOutput + "t",
    "Extraction cache: avg " + (extractionCacheRuns.length ? metricPct(extractionCacheAvg) : "—") + " across " + extractionCacheRuns.length + " measured run(s)",
    "Tokens saved: " + summary.totalSaved + "t, average verification score: " + summary.avgScore,
    "",
    "## Profile comparison",
    ...byProfile.map(summarizeGroup),
    "",
    "## Provider comparison",
    ...byProvider.map(summarizeGroup),
  ].join("\n");
}

export function writeMetricsDashboard(entries = readMetricsLog(200)): string | null {
  try {
    const summary = summarizeDashboard(entries);
    const latest = entries[entries.length - 1];
    const report = buildMetricsReport(entries);
    const profileGroups = groupMetrics(entries, e => e.profile);
    const providerGroups = groupMetrics(entries, e => e.provider ?? e.model?.split("/")[0]);
    const healthTone = summary.error + summary.timeout > 0 ? "warn" : "good";
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Smart Compact Metrics</title><style>${dashboardCss()}</style></head><body><main>
      <header><div><div class="eyebrow">pi-smart-compact</div><h1>Operational Metrics</h1><div class="muted">Generated ${escapeHtml(new Date().toISOString())} · ${metricNum(entries.length)} recent runs · local file dashboard</div></div><div>${badge(latest?.status)} ${latest ? `<span class="muted">latest ${escapeHtml(latest.profile ?? "unknown")}</span>` : ""}</div></header>
      <section class="cards">
        ${metricCard("Reliability", metricPct(summary.successRate), `${summary.success} success · ${summary.timeout} timeout · ${summary.error} error`, healthTone)}
        ${metricCard("Avg duration", metricMs(summary.avgDuration), `p95 ${metricMs(summary.p95Duration)}`)}
        ${metricCard("LLM calls", compactNumber(summary.totalCalls), `${compactNumber(summary.totalInput)} input · ${compactNumber(summary.totalOutput)} output`)}
        ${metricCard("Tokens saved", compactNumber(summary.totalSaved), `avg score ${summary.avgScore || "—"}`)}
      </section>
      <section class="layout">
        <div class="panel"><h2>Duration trend <span class="muted">last ${Math.min(entries.length, 80)} runs</span></h2>${sparkline(entries.slice(-80).map(metricDuration))}</div>
        <div class="panel"><h2>Latest phase timings</h2><div class="table-wrap"><table><thead><tr><th>Phase</th><th class="num">Duration</th><th>Share</th></tr></thead><tbody>${phaseRows(latest)}</tbody></table></div></div>
      </section>
      <section class="two section">
        <div class="panel"><h2>Profile comparison</h2><div class="table-wrap"><table><thead><tr><th>Profile</th><th class="num">Runs</th><th class="num">Avg</th><th class="num">p95</th><th class="num">Score</th><th class="num">Calls</th><th class="num">Saved</th><th>Reliability</th></tr></thead><tbody>${comparisonRows(profileGroups)}</tbody></table></div></div>
        <div class="panel"><h2>Provider comparison</h2><div class="table-wrap"><table><thead><tr><th>Provider</th><th class="num">Runs</th><th class="num">Avg</th><th class="num">p95</th><th class="num">Score</th><th class="num">Calls</th><th class="num">Saved</th><th>Reliability</th></tr></thead><tbody>${comparisonRows(providerGroups)}</tbody></table></div></div>
      </section>
      <section class="panel section"><h2>Recent runs</h2><div class="table-wrap"><table><thead><tr><th>Time</th><th>Profile</th><th>Provider</th><th>Method</th><th>Run</th><th>Status</th><th class="num">Duration</th><th class="num">Score</th><th class="num">Saved</th><th class="num">Calls</th><th class="num">Ext cache</th><th>Reason</th></tr></thead><tbody>${recentRunRows(entries)}</tbody></table></div></section>
      <section class="section"><h2>Raw text report</h2><pre>${escapeHtml(report)}</pre></section>
    </main></body></html>`;
    const fp = metricsDashboardFile();
    atomicWriteFileSync(fp, html);
    return fp;
  } catch (e) { log.warn("writeMetricsDashboard failed", e); return null; }
}
