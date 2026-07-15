/**
 * Extraction cache, metrics, and cache-aware LLM options.
 *
 * Filesystem writes go through `src/infra/fs.ts` (atomic temp+rename for
 * snapshots, advisory lock for the metrics append log) so that two pi
 * sessions racing to compact the same project cannot corrupt each other's
 * state. All LLM I/O routes through the services bag's `llm` client so tests
 * can swap a fake provider in without resolving the real peer dependency.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { LLMCallMetric, StructuredExtraction, CachedExtraction, CacheAwareOptions, CompactMetricsEntry, LlmMessage } from "../types.ts";
import { flattenToolCallBlock, type ToolCallIndex } from "./extraction.ts";
import { estimateTokens, calibrateFromResponse, getProviderCaps } from "./tokens.ts";
import * as log from "./logger.ts";
import type { Model, Api, AssistantMessage, Context } from "@earendil-works/pi-ai";
import { extractionCacheFile, metricsLogFile } from "../infra/paths.ts";
import { appendLineLocked, readJsonSync, writeJsonSync, scheduleFileTailTrim } from "../infra/fs.ts";
import { ONE_HOUR_MS, SEVEN_DAYS_MS, EXTRACTION_CACHE_PREFIX, RUNTIME_LOG_MAX_BYTES, ERROR_RETRY_WINDOW, ERROR_RESOLVE_WINDOW } from "../constants.ts";
import { buildEntryIdFingerprint } from "./id-fingerprint.ts";
import { getDefaultServices, type SmartCompactServices } from "../infra/services.ts";

// ── Cache Options ──

// Prompt-cache namespace id comes from the services bag's `compactSessionId`
// (set once per run by `createServices`).
/** Internal compaction phases that should never use prompt caching — one-shot, not worth write cost. */
const INTERNAL_PHASES: ReadonlySet<LLMCallMetric["phase"]> = new Set([
  "explore", "explore-loop", "explore-retry", "explore-direct",
  "single-pass", "batch", "assemble", "patch",
]);
const SEGMENTATION_PHASES: ReadonlySet<LLMCallMetric["phase"]> = new Set([
  "probe", "explore", "explore-loop", "explore-retry", "explore-direct",
]);

export function cacheOpts(
  opts: CacheAwareOptions,
  provider: string | undefined,
  phase: LLMCallMetric["phase"] | undefined,
  services: SmartCompactServices,
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
  return { ...opts, sessionId: services.compactSessionId, cacheRetention: retention };
}

// ── Metrics ──
//
// Metrics live on the per-run services container, injected explicitly by
// every caller (orchestrator threads `rc.services`; overlays receive it as a
// parameter). No hidden `getDefaultServices()` fallback on this surface: a
// missing bag is a compile error, not a silent cross-session leak. The one
// sanctioned fallback lives at the top of `trackedComplete` — the deep
// phases seam — and is resolved exactly once there.

export function recordMetric(m: LLMCallMetric, services: SmartCompactServices): void { services.metrics.record(m); }

export function effectivePromptInputTokens(inputTokens: number, cacheHitTokens: number): number {
  // Provider usage semantics differ: some providers report `input` as total
  // prompt tokens, while Anthropic-style cache accounting can report only the
  // uncached/new input and expose cached prompt tokens separately as cacheRead.
  // Use the larger plausible denominator so cache hit rate is never >100%.
  if (cacheHitTokens <= 0) return Math.max(0, inputTokens);
  return cacheHitTokens > inputTokens ? inputTokens + cacheHitTokens : inputTokens;
}

export function getMetricsSummary(services: SmartCompactServices): { totalCalls: number; totalInput: number; totalOutput: number; totalCacheHit: number; avgLatency: number; cacheHitRate: number } {
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
  // Single sanctioned fallback point: direct callers (legacy tests, REPL)
  // may omit services; everything downstream of here receives the resolved
  // bag explicitly.
  const svc = services ?? getDefaultServices();
  svc.budget.reserveCall();
  const safeRequest = svc.scrubber.scrubValue(reqBody).value;
  const start = Date.now();
  try {
    const configuredReasoning = SEGMENTATION_PHASES.has(phase)
      ? svc.thinkingLevels.segmentationThinkingLevel
      : svc.thinkingLevels.summaryThinkingLevel;
    const callOpts = opts.reasoning !== undefined || configuredReasoning === null
      ? opts
      : { ...opts, reasoning: configuredReasoning };
    const resolvedOpts = cacheOpts(callOpts, model.provider, phase, svc);
    const resp = await svc.llm.complete(model, safeRequest, resolvedOpts);
    const latency = Date.now() - start;
    const usage = resp.usage;
    const inputT = usage?.input ?? 0;
    const outputT = usage?.output ?? 0;
    const cacheT = usage?.cacheRead ?? 0;
    recordMetric({
      phase, model: model.id, provider: model.provider, inputTokens: inputT, outputTokens: outputT,
      cacheHitTokens: cacheT, latencyMs: latency, success: true,
    }, svc);
    try {
      if (inputT > 0 && "messages" in safeRequest) {
        const rawText = JSON.stringify((safeRequest as unknown as Record<string, unknown>).messages);
        const calibration = svc.tokenCalibration;
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
    }, svc);
    throw err;
  }
}

// ── Extraction Cache ──

function getCachePath(sessionId: string): string {
  return extractionCacheFile(sessionId);
}

// Extraction cache stats delegate to the caller's services container —
// explicit injection, same contract as the metrics surface above.
export function getExtractionCacheStats(services: SmartCompactServices): { hits: number; misses: number; hitRate: number } {
  return services.extractionCacheStats.snapshot();
}

export function recordExtractionCacheHit(services: SmartCompactServices): void { services.extractionCacheStats.recordHit(); }
export function recordExtractionCacheMiss(services: SmartCompactServices): void { services.extractionCacheStats.recordMiss(); }

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
  // The actual scan is deferred to a later event-loop turn; collapse repeated
  // triggers with an in-flight guard.
  scheduleExtractionCacheCleanup();
  return cached;
}

const EXTRACTION_CACHE_TTL_MS = ONE_HOUR_MS;
const EXTRACTION_CACHE_PRUNE_MAX_AGE_MS = SEVEN_DAYS_MS;

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
  setTimeout(() => {
    try {
      const dir = path.dirname(getCachePath("_")); // any sessionId gives us the dir
      if (!fs.existsSync(dir)) return;
      const now = Date.now();
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(EXTRACTION_CACHE_PREFIX) || !name.endsWith(".json")) continue;
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
export function reconcileCachedErrors(
  errors: StructuredExtraction["errors"],
  deltaMessages: LlmMessage[],
  deltaToolCalls: ToolCallIndex,
  baseMsgCount: number,
): StructuredExtraction["errors"] {
  return errors.map(error => {
    if (error.resolved) return { ...error };
    let retryAttempted = error.retryAttempted;
    let resolved = false;
    for (let j = 0; j < deltaMessages.length; j++) {
      const globalIndex = baseMsgCount + j;
      if (globalIndex <= error.index || globalIndex >= error.index + ERROR_RETRY_WINDOW) continue;
      const message = deltaMessages[j];
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      const retry = message.content.flatMap(flattenToolCallBlock).find(call => call.name === error.tool);
      if (!retry) continue;
      retryAttempted = true;
      for (let k = j + 1; k < Math.min(deltaMessages.length, j + ERROR_RESOLVE_WINDOW); k++) {
        const result = deltaMessages[k];
        if (result.role !== "toolResult" || result.isError) continue;
        const matches = retry.id != null
          ? result.toolCallId === retry.id
          : deltaToolCalls.get(result.toolCallId ?? "")?.name === error.tool;
        if (matches) { resolved = true; break; }
      }
      break;
    }
    return { ...error, retryAttempted, resolved };
  });
}

export function mergeExtractions(
  base: StructuredExtraction,
  delta: StructuredExtraction,
  baseMsgCount: number,
  deltaMessages: LlmMessage[] = [],
  deltaToolCalls: ToolCallIndex = new Map(),
): StructuredExtraction {
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

  const modified = new Map(base.modifiedFiles.map(file => [file.path, { ...file }]));
  for (const file of offsetModifiedFiles) {
    const previous = modified.get(file.path);
    modified.set(file.path, previous
      ? { ...file, toolCalls: previous.toolCalls + file.toolCalls, lastModifiedIndex: Math.max(previous.lastModifiedIndex, file.lastModifiedIndex) }
      : file);
  }
  const reconciledBaseErrors = reconcileCachedErrors(base.errors, deltaMessages, deltaToolCalls, baseMsgCount);
  const mergedErrors = [...reconciledBaseErrors, ...offsetErrors];

  return {
    modifiedFiles: [...modified.values()],
    readFiles: [...new Set([...base.readFiles, ...delta.readFiles])],
    deletedFiles: [...new Set([...base.deletedFiles, ...delta.deletedFiles])],
    mediaAttachments: [...(base.mediaAttachments ?? []), ...offsetMedia],
    errors: mergedErrors,
    decisions: [...base.decisions, ...offsetDecisions],
    constraints: [...base.constraints, ...offsetConstraints],
    topics: [...base.topics, ...offsetTopics],
    timeline: [...base.timeline, ...offsetTimeline],
    // mainGoal is the FIRST user message (the original objective) — base holds
    // it; the delta suffix's first user message is mid-conversation, not the goal.
    mainGoal: base.mainGoal ?? delta.mainGoal,
    // "last N" must span the cache boundary: the suffix alone is incomplete
    // when it carries fewer than N user messages / errors.
    lastUserMessages: [...base.lastUserMessages, ...delta.lastUserMessages].slice(-5),
    lastErrors: mergedErrors.filter(error => !error.resolved).map(error => error.message).slice(-3),
    messageCount: baseMsgCount + delta.messageCount,
  };
}

// ── Metrics log ──
/** Extended metrics entry including pipeline context for regression detection. */
export function appendMetricsLog(
  sessionId: string,
  extra: Partial<Omit<CompactMetricsEntry, "ts" | "sessionId" | "totalCalls" | "totalInput" | "totalOutput" | "totalCacheHit" | "avgLatency" | "cacheHitRate">> | undefined,
  services: SmartCompactServices,
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
    const logPath = metricsLogFile();
    appendLineLocked(logPath, JSON.stringify(entry));
    scheduleFileTailTrim(logPath, RUNTIME_LOG_MAX_BYTES);
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

// ── Backup ──

