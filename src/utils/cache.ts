/**
 * Extraction cache, metrics, and cache-aware LLM options.
 *
 * Filesystem writes go through `src/infra/fs.ts` (atomic temp+rename for
 * snapshots, advisory lock for the metrics append log) so that two pi
 * sessions racing to compact the same project cannot corrupt each other's
 * state. All LLM I/O routes through `getLlmClient()` so tests can swap a fake
 * provider in without resolving the real peer dependency.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { LLMCallMetric, StructuredExtraction, CachedExtraction, CacheAwareOptions, PipelinePhaseTiming, CompactMetricsEntry } from "../types.ts";
import { estimateTokens, calibrateFromResponse, getProviderCaps } from "./tokens.ts";
import * as log from "./logger.ts";
import type { Model, Api, AssistantMessage, Context } from "@earendil-works/pi-ai";
import { getLlmClient } from "../infra/llm-client.ts";
import {
  extractionCacheFile, metricsLogFile, damageReportsFile,
  cacheDir as cacheDirPath, metricsDashboardFile,
} from "../infra/paths.ts";
import { appendLineLocked, ensureDir, readJsonSync, writeJsonSync, atomicWriteFileSync } from "../infra/fs.ts";
import { buildEntryIdFingerprint } from "./id-fingerprint.ts";
import { getDefaultServices, type SmartCompactServices } from "../infra/services.ts";

// ── Cache Options ──

/**
 * Generate a one-shot session id used for prompt-cache namespacing when a
 * caller didn't go through the services container.
 *
 * NOTE: historically this module memoized a single id at module scope, but
 * that id leaked across all runs in the same Node process and collided with
 * `services.compactSessionId` (which is freshly minted per `createServices()`).
 * The right namespace identity belongs to the services container; this helper
 * exists only as a defensive fallback for the rare path where `services` is
 * undefined (e.g. ad-hoc test wiring) and intentionally returns a fresh id
 * every call so two unrelated calls never share a cache namespace by accident.
 */
function fallbackSessionId(): string {
  return "sc-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
}
/** Internal compaction phases that should never use prompt caching — one-shot, not worth write cost. */
const INTERNAL_PHASES: ReadonlySet<LLMCallMetric["phase"]> = new Set([
  "explore", "explore-loop", "explore-retry", "explore-direct",
  "single-pass", "batch", "assemble", "patch",
]);

export function cacheOpts(
  opts: CacheAwareOptions,
  provider?: string,
  phase?: LLMCallMetric["phase"],
  services?: SmartCompactServices,
): CacheAwareOptions & { sessionId?: string } {
  // Internal compaction LLM calls are one-shot: cache write cost (1.25x–2x) is never amortized.
  if (phase && INTERNAL_PHASES.has(phase)) {
    return { ...opts, cacheRetention: "none" as const };
  }

  const strategy = provider ? getProviderCaps(provider).cacheStrategy : "none";
  const retention = strategy === "none" ? "none" as const : (opts.cacheRetention ?? "short" as const);
  if (retention === "none") {
    return { ...opts, cacheRetention: "none" as const };
  }
  return { ...opts, sessionId: services?.compactSessionId ?? fallbackSessionId(), cacheRetention: retention };
}

// ── Metrics ──
//
// Metrics now live on the per-run services container. These functions remain
// for backwards compatibility (overlays.ts, app/steps/metrics.ts call them by
// name); they delegate to the active services bag, which is rotated on each
// `resetMetrics` invocation by the orchestrator. The default container is also
// what tests grab via `setDefaultServices` to inject a deterministic clock.

export function resetMetrics(services = getDefaultServices()): void {
  services.metrics.clear();
  services.extractionCacheStats.clear();
  services.tokenCalibration.clear();
}
export function recordMetric(m: LLMCallMetric, services = getDefaultServices()): void { services.metrics.record(m); }
export function getMetrics(services = getDefaultServices()): LLMCallMetric[] { return services.metrics.snapshot(); }

export function effectivePromptInputTokens(inputTokens: number, cacheHitTokens: number): number {
  // Provider usage semantics differ: some providers report `input` as total
  // prompt tokens, while Anthropic-style cache accounting can report only the
  // uncached/new input and expose cached prompt tokens separately as cacheRead.
  // Use the larger plausible denominator so cache hit rate is never >100%.
  if (cacheHitTokens <= 0) return Math.max(0, inputTokens);
  return cacheHitTokens > inputTokens ? inputTokens + cacheHitTokens : inputTokens;
}

export function getMetricsSummary(services = getDefaultServices()): { totalCalls: number; totalInput: number; totalOutput: number; totalCacheHit: number; avgLatency: number; cacheHitRate: number } {
  const sum = services.metrics.summary();
  // The services container computes a structurally identical summary but
  // uses a slightly different cache-hit denominator. Keep the previously
  // published denominator (capped at <=1) so dashboards don't show >100%.
  const cacheDenominator = effectivePromptInputTokens(sum.totalInput, sum.totalCacheHit);
  return {
    ...sum,
    cacheHitRate: cacheDenominator > 0 ? Math.min(1, sum.totalCacheHit / cacheDenominator) : 0,
  };
}

// ── Tracked complete wrapper ──
// We resolve the LLM client on every call rather than caching the reference so
// that tests which call `setLlmClient` mid-suite see their fake immediately.
export async function trackedComplete(
  phase: LLMCallMetric["phase"],
  model: Model<Api>,
  reqBody: Context,
  opts: CacheAwareOptions,
  services?: SmartCompactServices,
): Promise<AssistantMessage> {
  const start = Date.now();
  try {
    const resolvedOpts = cacheOpts(opts, model.provider, phase, services);
    const resp = await (services?.llm ?? getLlmClient()).complete(model, reqBody, resolvedOpts as import("@earendil-works/pi-ai").ProviderStreamOptions);
    const latency = Date.now() - start;
    const usage = resp.usage;
    const inputT = usage?.input ?? 0;
    const outputT = usage?.output ?? 0;
    const cacheT = usage?.cacheRead ?? 0;
    recordMetric({
      phase, model: model.id, provider: model.provider, inputTokens: inputT, outputTokens: outputT,
      cacheHitTokens: cacheT, latencyMs: latency, success: true,
    }, services);
    try {
      if (inputT > 0 && "messages" in reqBody) {
        const rawText = JSON.stringify((reqBody as unknown as Record<string, unknown>).messages);
        const calibration = services?.tokenCalibration;
        calibrateFromResponse(
          estimateTokens(rawText, model.provider, model.id, calibration),
          inputT,
          model.provider,
          model.id,
          calibration,
        );
      }
    } catch (e) { log.debug("token calibration failed", e); }
    return resp;
  } catch (err) {
    recordMetric({
      phase, model: model.id, provider: model.provider, inputTokens: 0, outputTokens: 0,
      cacheHitTokens: 0, latencyMs: Date.now() - start, success: false,
    }, services);
    throw err;
  }
}

// ── Extraction Cache ──

function getCachePath(sessionId: string): string {
  return extractionCacheFile(sessionId);
}

// Extraction cache stats delegate to the active services container. Resetting
// the container (via resetMetrics) zeros these counters too, which matches
// the previous module-level behaviour without leaking state across sessions.
export function resetExtractionCacheStats(services = getDefaultServices()): void {
  services.extractionCacheStats.clear();
}

export function getExtractionCacheStats(services = getDefaultServices()): { hits: number; misses: number; hitRate: number } {
  return services.extractionCacheStats.snapshot();
}

export function recordExtractionCacheHit(services = getDefaultServices()): void { services.extractionCacheStats.recordHit(); }
export function recordExtractionCacheMiss(services = getDefaultServices()): void { services.extractionCacheStats.recordMiss(); }

/**
 * Save extraction cache with entry-id fingerprints for branch-aware
 * invalidation.
 *
 * We store **compact fingerprints** rather than the raw id arrays so the cache
 * file stays a few hundred bytes regardless of session size. The fingerprint
 * carries enough information (count + tail + prefix hash) for the next run to
 * prove that the cached extraction's domain is a strict prefix of the current
 * pruned/unpruned conversation.
 *
 * @param msgCount — Length of the **pruned** llmMessages array. This is the
 *   domain for all index-bearing fields inside `extraction` (topics, errors,
 *   decisions, etc.). It must NOT be the unpruned toCompact length.
 * @param entryIds — FULL ordered list of original toCompact entry IDs. Used
 *   for branch/pivot detection on subsequent incremental runs.
 * @param keptEntryIds — Ordered entry IDs that survived pruning. This is the
 *   index domain used for safe incremental extraction prefix matching.
 */
export function saveCachedExtraction(
  sessionId: string,
  extraction: StructuredExtraction,
  msgCount: number,
  firstEntryId?: string,
  lastEntryId?: string,
  entryIds?: string[],
  keptEntryIds?: string[],
): void {
  try {
    const cached: CachedExtraction = {
      lastMessageIndex: msgCount - 1, extraction, messageCount: msgCount, timestamp: Date.now(),
      firstEntryId, lastEntryId,
      entryIdsFp: entryIds ? buildEntryIdFingerprint(entryIds) : undefined,
      keptEntryIdsFp: keptEntryIds ? buildEntryIdFingerprint(keptEntryIds) : undefined,
    };
    writeJsonSync(getCachePath(sessionId), cached);
  } catch (e) { log.warn("saveCachedExtraction failed", e); }
}

export function loadCachedExtraction(sessionId: string): CachedExtraction | null {
  const cached = readJsonSync<CachedExtraction>(getCachePath(sessionId));
  if (!cached) return null;
  if (Date.now() - cached.timestamp > EXTRACTION_CACHE_TTL_MS) return null; // 1hr TTL
  // Piggyback on every cache load to opportunistically prune sibling caches.
  // The actual scan is deferred to a microtask so the hot path stays
  // synchronous; collapse repeated triggers with an in-flight guard.
  scheduleExtractionCacheCleanup();
  return cached;
}

const EXTRACTION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const EXTRACTION_CACHE_PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Stale extraction caches (sessions we'll never see again because the user
 * closed pi) accumulate in `~/.pi/agent/cache/` indefinitely. The TTL check
 * in `loadCachedExtraction` only filters at read time, never deletes; on a
 * heavy user's machine this can grow to thousands of files. We deferred-
 * prune on cache load, mirroring the backup-prune strategy in helpers.ts.
 *
 * - Schedule guard prevents repeated readdir during a single compaction.
 * - Files older than 7 days are unlinked (way beyond the 1-hour TTL, so
 *   we're only deleting caches that are definitely abandoned).
 */
let _extractionPruneInFlight = false;
function scheduleExtractionCacheCleanup(): void {
  if (_extractionPruneInFlight) return;
  _extractionPruneInFlight = true;
  queueMicrotask(() => {
    try {
      const dir = path.dirname(getCachePath("_")); // any sessionId gives us the dir
      if (!fs.existsSync(dir)) return;
      const now = Date.now();
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith("compact-extraction-") || !name.endsWith(".json")) continue;
        const fp = path.join(dir, name);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > EXTRACTION_CACHE_PRUNE_MAX_AGE_MS) {
            try { fs.unlinkSync(fp); } catch (e) { log.debug("extraction-cache prune unlink failed", e); }
          }
        } catch (e) { log.debug("extraction-cache stat failed", e); }
      }
    } catch (e) { log.debug("extraction-cache cleanup failed", e); }
    finally { _extractionPruneInFlight = false; }
  });
}

/**
 * Merge a delta extraction into a base extraction, offsetting all
 * index-bearing fields so they align with the global message array.
 *
 * When `extractStructured` is called on `msgs.slice(cached.lastMessageIndex + 1)`
 * the delta's indexes start at 0 in the slice — but in the full conversation
 * they start at `baseMsgCount` (= `cached.messageCount` = `cached.lastMessageIndex + 1`).
 *
 * Without this offset, incremental extraction produces corrupted indexes that
 * break timeline ordering, topic segmentation, and downstream verification.
 */
export function mergeExtractions(base: StructuredExtraction, delta: StructuredExtraction, baseMsgCount: number): StructuredExtraction {
  // ── Offset every index-bearing field in delta ──
  const offsetErrors = delta.errors.map(e => ({ ...e, index: e.index + baseMsgCount }));
  const offsetDecisions = delta.decisions.map(d => ({ ...d, index: d.index + baseMsgCount }));
  const offsetConstraints = delta.constraints.map(c => ({ ...c, index: c.index + baseMsgCount }));
  const offsetTopics = delta.topics.map(t => ({
    ...t,
    startIndex: t.startIndex + baseMsgCount,
    endIndex: t.endIndex + baseMsgCount,
  }));
  const offsetTimeline = delta.timeline.map(t => ({ ...t, index: t.index + baseMsgCount }));
  const offsetModifiedFiles = delta.modifiedFiles.map(f => ({
    ...f,
    lastModifiedIndex: f.lastModifiedIndex + baseMsgCount,
  }));
  const offsetMedia = (delta.mediaAttachments ?? []).map(a => ({ ...a, index: a.index + baseMsgCount }));

  return {
    modifiedFiles: [...new Map([...base.modifiedFiles, ...offsetModifiedFiles].map(f => [f.path, f])).values()],
    readFiles: [...new Set([...base.readFiles, ...delta.readFiles])],
    deletedFiles: [...new Set([...base.deletedFiles, ...delta.deletedFiles])],
    mediaAttachments: [...(base.mediaAttachments ?? []), ...offsetMedia],
    errors: [...base.errors, ...offsetErrors],
    decisions: [...base.decisions, ...offsetDecisions],
    constraints: [...base.constraints, ...offsetConstraints],
    topics: [...base.topics, ...offsetTopics],
    timeline: [...base.timeline, ...offsetTimeline],
    mainGoal: delta.mainGoal ?? base.mainGoal,
    lastUserMessages: delta.lastUserMessages.length > 0 ? delta.lastUserMessages : base.lastUserMessages,
    lastErrors: delta.lastErrors.length > 0 ? delta.lastErrors : base.lastErrors,
    messageCount: baseMsgCount + delta.messageCount,
  };
}

// ── Metrics log ──
/** Extended metrics entry including pipeline context for regression detection. */
export function appendMetricsLog(
  sessionId: string,
  extra?: Partial<Omit<CompactMetricsEntry, "ts" | "sessionId" | "totalCalls" | "totalInput" | "totalOutput" | "totalCacheHit" | "avgLatency" | "cacheHitRate">>,
  services?: SmartCompactServices,
): void {
  try {
    const summary = getMetricsSummary(services);
    const entry: CompactMetricsEntry = {
      ts: new Date().toISOString(),
      sessionId,
      ...summary,
      ...extra,
    };
    // appendLineLocked keeps concurrent pi sessions from interleaving partial
    // JSON inside the metrics log. Each line is either fully written or absent.
    appendLineLocked(metricsLogFile(), JSON.stringify(entry));
  } catch (e) { log.warn("appendMetricsLog failed", e); }
}

/**
 * Read the last `limit` valid entries from the metrics log without loading
 * the whole file. We start from the tail, walking backwards in 64 KB chunks
 * until we have enough lines (`limit * 4` raw lines is a generous safety
 * factor against corrupt entries that get filtered out). The old
 * implementation read the entire log into memory before slicing, which on
 * a long-lived install with a multi-megabyte log was a noticeable IO + GC
 * hit on every dashboard render.
 *
 * Behavior guarantees:
 *   - At most `limit` entries returned (always sliced from the tail).
 *   - Corrupt JSON lines are dropped with a warning, NOT counted toward limit.
 *   - Returned in chronological order (oldest -> newest within the window).
 */
export function readMetricsLog(limit = 100): CompactMetricsEntry[] {
  try {
    const logPath = metricsLogFile();
    if (!fs.existsSync(logPath)) return [];
    const stat = fs.statSync(logPath);
    const TAIL_CHUNK = 64 * 1024;
    // Heuristic budget: most lines are ~400 B; reading limit*8 lines worth of
    // bytes gives plenty of headroom while staying well under a 1 MB read for
    // limit=200. Cap by file size so we never read past the start.
    const wantBytes = Math.min(stat.size, Math.max(TAIL_CHUNK, limit * 8 * 512));
    const startPos = Math.max(0, stat.size - wantBytes);

    const fd = fs.openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(wantBytes);
      fs.readSync(fd, buf, 0, wantBytes, startPos);
      let text = buf.toString("utf8");
      // Drop the (potentially) partial first line when we didn't start at
      // byte 0; otherwise we'd half-parse it and emit a corrupt warning.
      if (startPos > 0) {
        const nl = text.indexOf("\n");
        if (nl >= 0) text = text.slice(nl + 1);
      }
      const lines = text.split("\n").filter(Boolean);
      const entries: CompactMetricsEntry[] = [];
      for (const line of lines) {
        try { entries.push(JSON.parse(line) as CompactMetricsEntry); }
        catch { log.warn("Skipping corrupt compact metrics line"); }
      }
      return entries.slice(-limit);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) { log.warn("readMetricsLog failed", e); return []; }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>\"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] ?? c));
}

function durationOf(entry: CompactMetricsEntry): number {
  return entry.durationMs ?? entry.phaseTimings?.reduce((sum, phase) => sum + phase.durationMs, 0) ?? 0;
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

function formatNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return escapeHtml(value);
  return value.toLocaleString();
}

function formatMs(value: number): string {
  if (!value) return "0ms";
  if (value >= 60_000) return (value / 60_000).toFixed(value >= 600_000 ? 0 : 1) + "m";
  if (value >= 1_000) return (value / 1_000).toFixed(value >= 10_000 ? 0 : 1) + "s";
  return Math.round(value) + "ms";
}

function formatPercent(value: number): string {
  return Math.round(value * 100) + "%";
}

function statusClass(status?: string): "good" | "warn" | "bad" {
  if (status === "timeout" || status === "error") return "bad";
  if (status === "dry-run") return "warn";
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
  const durations = entries.map(durationOf).filter(Boolean);
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
    if (!key) continue; // Legacy metrics may predate profile/provider fields; omit them from comparisons.
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()].map(([name, group]) => {
    const durations = group.map(durationOf).filter(Boolean);
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

function progressBar(value: number, label = formatPercent(value)): string {
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
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="Duration trend"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${width}" cy="${(height - ((last - min) / span) * (height - 18) - 9).toFixed(1)}" r="4" fill="currentColor"/><text x="0" y="14">${escapeHtml(formatMs(max))}</text><text x="0" y="${height - 4}">${escapeHtml(formatMs(min))}</text></svg>`;
}

function metricCard(label: string, value: string, detail: string, tone: "neutral" | "good" | "warn" | "bad" = "neutral"): string {
  return `<article class="card ${tone}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="detail">${escapeHtml(detail)}</div></article>`;
}

function comparisonRows(groups: MetricsGroupSummary[]): string {
  if (!groups.length) return `<tr><td colspan="8" class="empty">No data yet</td></tr>`;
  return groups.map(group => `<tr>
    <td><strong>${escapeHtml(group.name)}</strong></td>
    <td class="num">${formatNumber(group.runs)}</td>
    <td class="num">${escapeHtml(formatMs(group.avgDuration))}</td>
    <td class="num">${escapeHtml(formatMs(group.p95Duration))}</td>
    <td class="num">${group.avgScore ? formatNumber(group.avgScore) : "—"}</td>
    <td class="num">${formatNumber(group.totalCalls)}</td>
    <td class="num">${formatNumber(group.totalSaved)}</td>
    <td>${progressBar(1 - group.errorRate, formatPercent(1 - group.errorRate) + " reliable")}</td>
  </tr>`).join("\n");
}

function phaseRows(entry?: CompactMetricsEntry): string {
  const timings = entry?.phaseTimings ?? [];
  if (!timings.length) return `<tr><td colspan="3" class="empty">No phase timings yet</td></tr>`;
  const total = timings.reduce((sum, phase) => sum + phase.durationMs, 0) || 1;
  return timings.map(phase => `<tr>
    <td>${escapeHtml(phase.phase)}</td>
    <td class="num">${escapeHtml(formatMs(phase.durationMs))}</td>
    <td>${progressBar(phase.durationMs / total, formatPercent(phase.durationMs / total))}</td>
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
    <td class="num">${escapeHtml(formatMs(durationOf(entry)))}</td>
    <td class="num">${typeof entry.verificationScore === "number" ? formatNumber(entry.verificationScore) : "—"}</td>
    <td class="num">${typeof entry.tokensSaved === "number" ? formatNumber(entry.tokensSaved) : "—"}</td>
    <td class="num">${formatNumber(entry.totalCalls ?? 0)}</td>
    <td class="num">${typeof entry.extractionCacheHitRate === "number" ? formatPercent(entry.extractionCacheHitRate) : "—"}</td>
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
  const summarizeGroup = (group: MetricsGroupSummary) => "- " + group.name + ": n=" + group.runs + ", avg=" + group.avgDuration + "ms, p95=" + group.p95Duration + "ms, score=" + group.avgScore + ", saved=" + group.totalSaved + "t, reliability=" + formatPercent(1 - group.errorRate);
  const extractionCacheRuns = entries.filter(e => typeof e.extractionCacheHitRate === "number");
  const extractionCacheAvg = average(extractionCacheRuns.map(e => e.extractionCacheHitRate ?? 0));
  return [
    "# Smart Compact Metrics",
    "",
    "Runs: " + summary.runs + " (success " + summary.success + ", dry-run " + summary.dryRun + ", timeout " + summary.timeout + ", error " + summary.error + ")",
    "Reliability: " + formatPercent(summary.successRate),
    "Latency: avg " + summary.avgDuration + "ms, p95 " + summary.p95Duration + "ms",
    "LLM calls: " + summary.totalCalls + ", input " + summary.totalInput + "t, output " + summary.totalOutput + "t",
    "Extraction cache: avg " + (extractionCacheRuns.length ? formatPercent(extractionCacheAvg) : "—") + " across " + extractionCacheRuns.length + " measured run(s)",
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
    ensureDir(cacheDirPath());
    const summary = summarizeDashboard(entries);
    const latest = entries[entries.length - 1];
    const report = buildMetricsReport(entries);
    const profileGroups = groupMetrics(entries, e => e.profile);
    const providerGroups = groupMetrics(entries, e => e.provider ?? e.model?.split("/")[0]);
    const healthTone = summary.error + summary.timeout > 0 ? "warn" : "good";
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Smart Compact Metrics</title><style>${dashboardCss()}</style></head><body><main>
      <header><div><div class="eyebrow">pi-smart-compact</div><h1>Operational Metrics</h1><div class="muted">Generated ${escapeHtml(new Date().toISOString())} · ${formatNumber(entries.length)} recent runs · local file dashboard</div></div><div>${badge(latest?.status)} ${latest ? `<span class="muted">latest ${escapeHtml(latest.profile ?? "unknown")}</span>` : ""}</div></header>
      <section class="cards">
        ${metricCard("Reliability", formatPercent(summary.successRate), `${summary.success} success · ${summary.timeout} timeout · ${summary.error} error`, healthTone)}
        ${metricCard("Avg duration", formatMs(summary.avgDuration), `p95 ${formatMs(summary.p95Duration)}`)}
        ${metricCard("LLM calls", compactNumber(summary.totalCalls), `${compactNumber(summary.totalInput)} input · ${compactNumber(summary.totalOutput)} output`)}
        ${metricCard("Tokens saved", compactNumber(summary.totalSaved), `avg score ${summary.avgScore || "—"}`)}
      </section>
      <section class="layout">
        <div class="panel"><h2>Duration trend <span class="muted">last ${Math.min(entries.length, 80)} runs</span></h2>${sparkline(entries.slice(-80).map(durationOf))}</div>
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

// ── Backup ──

