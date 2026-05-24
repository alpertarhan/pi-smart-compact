import type { CompactMetricsEntry, PipelinePhaseTiming } from "../types.ts";

export const DASHBOARD_PAGE_SIZE = 24;

export function metricDuration(entry: CompactMetricsEntry): number {
  return entry.durationMs ?? entry.phaseTimings?.reduce((sum, phase) => sum + phase.durationMs, 0) ?? 0;
}

export function metricMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  return ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + "s" : Math.round(ms) + "ms";
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function metricPct(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(clampRatio(value) * 100) + "%" : "—";
}

export function metricNum(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";
}

export function metricScore(entry: CompactMetricsEntry | undefined): string {
  return typeof entry?.verificationScore === "number" && Number.isFinite(entry.verificationScore) ? entry.verificationScore + "/100" : "—";
}

export function formatMetricRun(entry: CompactMetricsEntry, index?: number): string {
  const prefix = typeof index === "number" ? String(index).padStart(2, " ") + ". " : "";
  const time = entry.ts ? new Date(entry.ts).toLocaleString() : "unknown time";
  return prefix + time + " | " + (entry.profile ?? "?") + " | " + (entry.provider ?? entry.model ?? "?") + " | " + (entry.method ?? "?") + " | " + (entry.status ?? "?") + " | score " + metricScore(entry) + " | saved " + metricNum(entry.tokensSaved) + "t";
}

export function formatMetricRunCompact(entry: CompactMetricsEntry): string {
  return "score " + metricScore(entry) + " • saved " + metricNum(entry.tokensSaved) + "t • " + (entry.status ?? "?") + " • " + (entry.profile ?? "?") + " / " + (entry.provider ?? entry.model ?? "?");
}

function formatPhaseTiming(phase: PipelinePhaseTiming, total: number): string {
  const share = total > 0 ? Math.round((phase.durationMs / total) * 100) : 0;
  return "- " + phase.phase + ": " + metricMs(phase.durationMs) + " (" + share + "%)";
}

export function formatRunDetails(entry: CompactMetricsEntry | undefined, title: string): string[] {
  if (!entry) return [title, "", "No run recorded yet."];
  const totalDuration = metricDuration(entry);
  const lines = [
    title,
    "",
    "Session: " + entry.sessionId,
    "Time: " + (entry.ts ? new Date(entry.ts).toLocaleString() : "unknown"),
    "Status: " + (entry.status ?? "unknown") + " | run: " + (entry.runType ?? "?") + " | profile: " + (entry.profile ?? "?"),
    "Provider/model: " + (entry.provider ?? "?") + " / " + (entry.model ?? "?"),
    "Method: " + (entry.method ?? "?") + " | duration: " + metricMs(totalDuration),
    "Quality: " + metricScore(entry) + " | gaps: " + metricNum(entry.verificationGaps),
    "Tokens: before " + metricNum(entry.tokensBefore) + "t | saved " + metricNum(entry.tokensSaved) + "t | prune saved " + metricNum(entry.pruneSavedTokens) + "t",
    "LLM: " + metricNum(entry.totalCalls) + " calls | input " + metricNum(entry.totalInput) + "t | output " + metricNum(entry.totalOutput) + "t | provider cache " + metricPct(entry.cacheHitRate),
    "Extraction cache: " + metricNum(entry.extractionCacheHits) + " hit / " + metricNum(entry.extractionCacheMisses) + " miss | rate " + metricPct(entry.extractionCacheHitRate),
    "Context: " + metricNum(entry.contextPercent) + "% | tool share: " + metricNum(entry.toolPercent) + "% | chunks: " + metricNum(entry.chunkCount),
  ];
  if (entry.extractionCacheMissReason) lines.push("Extraction miss reason: " + entry.extractionCacheMissReason);
  if (entry.fallbackReason) lines.push("Reason: " + entry.fallbackReason);
  if (entry.phaseTimings?.length) {
    lines.push("", "Phase timings:");
    lines.push(...entry.phaseTimings.map(phase => formatPhaseTiming(phase, totalDuration)));
  }
  return lines;
}

export function formatCurrentSession(entries: CompactMetricsEntry[], currentSessionId: string | undefined): string[] {
  if (!currentSessionId || currentSessionId === "unknown") return ["Current session", "", "Session id is not available from Pi context."];
  const runs = entries.filter(entry => entry.sessionId === currentSessionId);
  if (!runs.length) return ["Current session", "", "Session: " + currentSessionId, "No smart-compact metrics recorded for this session yet."];
  const success = runs.filter(entry => entry.status === "success").length;
  const latest = runs[runs.length - 1];
  const totalSaved = runs.reduce((sum, entry) => sum + (entry.tokensSaved ?? 0), 0);
  const avgScoreValues = runs.map(entry => entry.verificationScore).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const avgScore = avgScoreValues.length ? Math.round(avgScoreValues.reduce((sum, value) => sum + value, 0) / avgScoreValues.length) : 0;
  return [
    "Current session",
    "",
    "Session: " + currentSessionId,
    "Runs: " + runs.length + " | success " + success + " | total saved " + totalSaved.toLocaleString() + "t | avg score " + (avgScore || "—"),
    "Latest: " + formatMetricRun(latest),
    "",
    "Runs in this session:",
    ...runs.slice(-20).reverse().map((entry, i) => formatMetricRun(entry, i + 1)),
  ];
}

export function formatRecentRuns(entries: CompactMetricsEntry[]): string[] {
  if (!entries.length) return ["Recent runs", "", "No smart-compact metrics recorded yet."];
  return [
    "Recent runs",
    "",
    ...entries.slice(-30).reverse().map((entry, i) => formatMetricRun(entry, i + 1)),
  ];
}

export function isDashboardTitleLine(line: string): boolean {
  return line.startsWith("#") || line === "Latest run details" || line === "Current session" || line === "Recent runs" || line === "Phase timings:" || line === "Runs in this session:";
}
