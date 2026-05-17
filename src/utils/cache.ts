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
export function cacheOpts(opts: CacheAwareOptions, provider?: string): CacheAwareOptions & { sessionId?: string } {
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
    const resp = await complete(model, reqBody, opts);
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
        const rawText = JSON.stringify((reqBody as Record<string, unknown>).messages);
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

export function saveCachedExtraction(sessionId: string, extraction: StructuredExtraction, msgCount: number): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const cached: CachedExtraction = {
      lastMessageIndex: msgCount - 1, extraction, messageCount: msgCount, timestamp: Date.now(),
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

export function mergeExtractions(base: StructuredExtraction, delta: StructuredExtraction, baseMsgCount: number): StructuredExtraction {
  return {
    modifiedFiles: [...new Map([...base.modifiedFiles, ...delta.modifiedFiles].map(f => [f.path, f])).values()],
    readFiles: [...new Set([...base.readFiles, ...delta.readFiles])],
    deletedFiles: [...new Set([...base.deletedFiles, ...delta.deletedFiles])],
    errors: [...base.errors, ...delta.errors],
    decisions: [...base.decisions, ...delta.decisions],
    constraints: [...base.constraints, ...delta.constraints],
    topics: [...base.topics, ...delta.topics],
    timeline: [...base.timeline, ...delta.timeline],
    mainGoal: delta.mainGoal ?? base.mainGoal,
    lastUserMessages: delta.lastUserMessages.length > 0 ? delta.lastUserMessages : base.lastUserMessages,
    lastErrors: delta.lastErrors.length > 0 ? delta.lastErrors : base.lastErrors,
    messageCount: baseMsgCount + delta.messageCount,
  };
}

// ── Metrics log ──
export function appendMetricsLog(sessionId: string): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const logPath = path.join(CACHE_DIR, "compact-metrics.jsonl");
    const entry = { ts: new Date().toISOString(), sessionId, ...getMetricsSummary() };
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch (e) { log.warn("appendMetricsLog failed", e); }
}

// ── Backup ──

