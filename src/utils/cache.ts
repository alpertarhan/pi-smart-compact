/**
 * Extraction cache, metrics, and cache-aware LLM options.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { LLMCallMetric, StructuredExtraction, CachedExtraction, CacheAwareOptions } from "../types.ts";
import { estimateTokens, calibrateFromResponse, getProviderCaps } from "./tokens.ts";
import * as log from "./logger.ts";
import { complete, type Model, type Api, type AssistantMessage, type Context } from "@earendil-works/pi-ai";

const CACHE_DIR = path.join(process.env.HOME ?? "/tmp", ".pi", "agent", ".cache");

// ── Session ID ──
let _compactSessionId: string | null = null;

export function getCompactSessionId(): string {
  if (!_compactSessionId) {
    _compactSessionId = "sc-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
  }
  return _compactSessionId;
}

export function resetCompactSessionId(): void {
  _compactSessionId = null;
}

// ── Cache Options ──
/** Internal compaction phases that should never use prompt caching — one-shot, not worth write cost. */
const INTERNAL_PHASES: ReadonlySet<LLMCallMetric["phase"]> = new Set([
  "explore", "explore-loop", "explore-retry", "explore-direct",
  "single-pass", "batch", "assemble", "patch",
]);

export function cacheOpts(
  opts: CacheAwareOptions,
  provider?: string,
  phase?: LLMCallMetric["phase"],
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
  return { ...opts, sessionId: getCompactSessionId(), cacheRetention: retention };
}

// ── Metrics ──
const _metrics: LLMCallMetric[] = [];

export function resetMetrics(): void { _metrics.length = 0; }
export function recordMetric(m: LLMCallMetric): void { _metrics.push(m); if (_metrics.length > 200) _metrics.splice(0, _metrics.length - 100); }
export function getMetrics(): LLMCallMetric[] { return [..._metrics]; }

export function getMetricsSummary(): { totalCalls: number; totalInput: number; totalOutput: number; totalCacheHit: number; avgLatency: number; cacheHitRate: number } {
  const n = _metrics.length;
  if (!n) return { totalCalls: 0, totalInput: 0, totalOutput: 0, totalCacheHit: 0, avgLatency: 0, cacheHitRate: 0 };
  const totalInput = _metrics.reduce((s, m) => s + m.inputTokens, 0);
  const totalOutput = _metrics.reduce((s, m) => s + m.outputTokens, 0);
  const totalCacheHit = _metrics.reduce((s, m) => s + m.cacheHitTokens, 0);
  const avgLatency = _metrics.reduce((s, m) => s + m.latencyMs, 0) / n;
  return {
    totalCalls: n, totalInput, totalOutput, totalCacheHit,
    avgLatency: Math.round(avgLatency),
    cacheHitRate: totalInput > 0 ? totalCacheHit / totalInput : 0,
  };
}

// ── Tracked complete wrapper ──
export async function trackedComplete(
  phase: LLMCallMetric["phase"],
  model: Model<Api>,
  reqBody: Context,
  opts: CacheAwareOptions,
): Promise<AssistantMessage> {
  const start = Date.now();
  try {
    const resolvedOpts = cacheOpts(opts, model.provider, phase);
    const resp = await complete(model, reqBody, resolvedOpts as import("@earendil-works/pi-ai").ProviderStreamOptions);
    const latency = Date.now() - start;
    const usage = resp.usage;
    const inputT = usage?.input ?? 0;
    const outputT = usage?.output ?? 0;
    const cacheT = usage?.cacheRead ?? 0;
    recordMetric({
      phase, model: model.id, inputTokens: inputT, outputTokens: outputT,
      cacheHitTokens: cacheT, latencyMs: latency, success: true,
    });
    try {
      if (inputT > 0 && "messages" in reqBody) {
        const rawText = JSON.stringify((reqBody as unknown as Record<string, unknown>).messages);
        calibrateFromResponse(estimateTokens(rawText), inputT, model.provider);
      }
    } catch (e) { log.debug("token calibration failed", e); }
    return resp;
  } catch (err) {
    recordMetric({
      phase, model: model.id, inputTokens: 0, outputTokens: 0,
      cacheHitTokens: 0, latencyMs: Date.now() - start, success: false,
    });
    throw err;
  }
}

// ── Extraction Cache ──

function getCachePath(sessionId: string): string {
  return path.join(CACHE_DIR, "compact-extraction-" + sessionId.replace(/[^a-zA-Z0-9-]/g, "_") + ".json");
}

/**
 * Save extraction cache with entry-id bounds for branch-aware invalidation.
 * If first/last entry IDs are provided, a subsequent load will compare them
 * against the current toCompact window to detect pivot/branch changes.
 */
export function saveCachedExtraction(
  sessionId: string,
  extraction: StructuredExtraction,
  msgCount: number,
  firstEntryId?: string,
  lastEntryId?: string,
): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const cached: CachedExtraction = {
      lastMessageIndex: msgCount - 1, extraction, messageCount: msgCount, timestamp: Date.now(),
      firstEntryId, lastEntryId,
    };
    fs.writeFileSync(getCachePath(sessionId), JSON.stringify(cached));
  } catch (e) { log.warn("saveCachedExtraction failed", e); }
}

export function loadCachedExtraction(sessionId: string): CachedExtraction | null {
  try {
    const fp = getCachePath(sessionId);
    if (!fs.existsSync(fp)) return null;
    const cached = JSON.parse(fs.readFileSync(fp, "utf8")) as CachedExtraction;
    if (Date.now() - cached.timestamp > 3600000) return null; // 1hr TTL
    return cached;
  } catch (e) { log.warn("loadCachedExtraction failed", e); return null; }
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

  return {
    modifiedFiles: [...new Map([...base.modifiedFiles, ...offsetModifiedFiles].map(f => [f.path, f])).values()],
    readFiles: [...new Set([...base.readFiles, ...delta.readFiles])],
    deletedFiles: [...new Set([...base.deletedFiles, ...delta.deletedFiles])],
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
  extra?: {
    profile?: string;
    tier?: string;
    contextPercent?: number;
    toolPercent?: number;
    tokensBefore?: number;
    tokensSaved?: number;
    pruneSavedTokens?: number;
    chunkCount?: number;
    fallbackReason?: string;
    verificationScore?: number;
  },
): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const logPath = path.join(CACHE_DIR, "compact-metrics.jsonl");
    const summary = getMetricsSummary();
    const entry = {
      ts: new Date().toISOString(),
      sessionId,
      ...summary,
      ...extra,
    };
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch (e) { log.warn("appendMetricsLog failed", e); }
}

// ── Backup ──

