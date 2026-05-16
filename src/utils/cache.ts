/**
 * Extraction cache, metrics, and cache-aware LLM options.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { LLMCallMetric, StructuredExtraction, CachedExtraction, CacheAwareOptions } from "../types.ts";
import { estimateTokens, calibrateFromResponse } from "./tokens.ts";
import { complete, type Model, type Api } from "@earendil-works/pi-ai";

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
export function cacheOpts(opts: CacheAwareOptions): CacheAwareOptions & { sessionId?: string } {
  const retention = opts.cacheRetention ?? "short";
  if (retention === "none") {
    return { ...opts, cacheRetention: "none" as const };
  }
  return { ...opts, sessionId: getCompactSessionId(), cacheRetention: "short" as const };
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
  reqBody: Record<string, unknown>,
  opts: CacheAwareOptions,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  try {
    const resp = await complete(model, reqBody, opts) as Record<string, unknown>;
    const latency = Date.now() - start;
    const usage = (resp as any).usage ?? {};
    const inputT = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const outputT = usage.output_tokens ?? usage.completion_tokens ?? 0;
    const cacheT = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    recordMetric({
      phase, model: model.id, inputTokens: inputT, outputTokens: outputT,
      cacheHitTokens: cacheT, latencyMs: latency, success: true,
    });
    if (inputT > 0 && reqBody.messages) {
      const rawText = JSON.stringify(reqBody.messages);
      calibrateFromResponse(estimateTokens(rawText), inputT, model.provider);
    }
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
  } catch { /* best effort */ }
}

export function loadCachedExtraction(sessionId: string): CachedExtraction | null {
  try {
    const fp = getCachePath(sessionId);
    if (!fs.existsSync(fp)) return null;
    const cached = JSON.parse(fs.readFileSync(fp, "utf8")) as CachedExtraction;
    if (Date.now() - cached.timestamp > 3600000) return null; // 1hr TTL
    return cached;
  } catch { return null; }
}

export function mergeExtractions(base: StructuredExtraction, delta: StructuredExtraction, baseMsgCount: number): StructuredExtraction {
  return {
    modifiedFiles: [...base.modifiedFiles, ...delta.modifiedFiles],
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
  } catch { /* best effort */ }
}

// ── Backup ──

