/**
 * Service container — the dependency-injection backbone for one
 * `runSmartCompact` invocation.
 *
 * Background: the original codebase relied on module-level mutable singletons
 * for everything that needed cross-call state — the metrics array in
 * `cache.ts`, `_toolSupportCache` in `explore.ts`, the config cache in
 * `helpers.ts`, the calibration map in `tokens.ts`. Each singleton is
 * convenient on the happy path but breaks down once you run two pi sessions
 * simultaneously or write tests that need isolation:
 *
 *   - `_metrics` is shared across sessions, so one session's summary
 *     reset wipes another's in-flight call record.
 *   - `_toolSupportCache` carries TTL'd state into every test run; a flaky
 *     test that toggles tool support leaks into the next describe block.
 *   - Hot path metrics writes contend on the same array indices.
 *
 * The `SmartCompactServices` bag fixes this by giving every run its own
 * services instance. The container is intentionally narrow — only things that
 * (a) hold state across calls *within* a run, or (b) are worth swapping out in
 * tests, live here.
 *
 * Services that are stateless or already inject through their own seam
 * (`LlmClient`, `Clock`, file system helpers in `infra/fs.ts`) are exposed via
 * the container for convenience but never mutated through it.
 */

import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import type { LlmClient } from "./llm-client.ts";
import { getLlmClient } from "./llm-client.ts";
import crypto from "node:crypto";
import type { LLMCallMetric } from "../types.ts";
import { METRICS_BUFFER_MAX, ONE_HOUR_MS } from "../constants.ts";
import { TokenCalibrationStore } from "../utils/tokens.ts";

/**
 * In-memory cache for "does this provider support tools?".
 *
 * Used by `explore.ts` to avoid the 1-tool probe call on every compaction.
 * Per-run isolation matters because:
 *   - Tests can spin up a fake provider that toggles support without bleeding
 *     into other tests.
 *   - A provider may temporarily drop tool support during an outage; per-run
 *     scoping bounds how long we cache a stale negative.
 *
 * TTL: 1 hour, matching the previous singleton's behaviour.
 */
export class ToolSupportCache {
  private readonly entries = new Map<string, { result: boolean; timestamp: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs = ONE_HOUR_MS) { this.ttlMs = ttlMs; }

  /** Returns the cached value if fresh, or undefined to force a probe. */
  get(key: string, now: number): boolean | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.timestamp > this.ttlMs) return undefined;
    return entry.result;
  }

  set(key: string, value: boolean, now: number): void {
    this.entries.set(key, { result: value, timestamp: now });
  }

  /** Snapshot for debug logging; safe to call from anywhere. */
  size(): number { return this.entries.size; }
}

/**
 * Per-run metrics sink.
 *
 * Caps at `maxEntries` and trims from the front so a runaway test or a long
 * batch synthesis doesn't grow unbounded. `summary()` is O(n) but n is bounded
 * by `maxEntries`, so it's safe to call from the result screen.
 */
export class MetricsSink {
  private readonly buf: LLMCallMetric[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = METRICS_BUFFER_MAX) { this.maxEntries = maxEntries; }

  record(metric: LLMCallMetric): void {
    this.buf.push(metric);
    if (this.buf.length > this.maxEntries) {
      // Trim from the front so the most recent calls are always available
      // to the result screen and the metrics dashboard.
      this.buf.splice(0, this.buf.length - Math.floor(this.maxEntries / 2));
    }
  }

  snapshot(): LLMCallMetric[] { return [...this.buf]; }
  clear(): void { this.buf.length = 0; }

  summary(): {
    totalCalls: number; totalInput: number; totalOutput: number;
    totalCacheHit: number; avgLatency: number; cacheHitRate: number;
  } {
    const n = this.buf.length;
    if (!n) return { totalCalls: 0, totalInput: 0, totalOutput: 0, totalCacheHit: 0, avgLatency: 0, cacheHitRate: 0 };
    let totalInput = 0, totalOutput = 0, totalCacheHit = 0, totalLatency = 0;
    for (const m of this.buf) {
      totalInput += m.inputTokens;
      totalOutput += m.outputTokens;
      totalCacheHit += m.cacheHitTokens;
      totalLatency += m.latencyMs;
    }
    const cacheHitRate = totalInput > 0 ? totalCacheHit / (totalInput + totalCacheHit) : 0;
    return {
      totalCalls: n, totalInput, totalOutput, totalCacheHit,
      avgLatency: Math.round(totalLatency / n), cacheHitRate,
    };
  }
}

/**
 * Per-run extraction cache stats.
 *
 * Tracks hits vs misses on `loadCachedExtraction`. Surfaced into the metrics
 * dashboard so we can tune the prefix-match tolerance over time.
 */
export class ExtractionCacheStats {
  private hits = 0;
  private misses = 0;

  recordHit(): void { this.hits++; }
  recordMiss(): void { this.misses++; }

  snapshot(): { hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return { hits: this.hits, misses: this.misses, hitRate: total > 0 ? this.hits / total : 0 };
  }

  clear(): void { this.hits = 0; this.misses = 0; }
}

/** The full per-run service bag. */
export interface SmartCompactServices {
  clock: Clock;
  llm: LlmClient;
  toolSupport: ToolSupportCache;
  metrics: MetricsSink;
  extractionCacheStats: ExtractionCacheStats;
  tokenCalibration: TokenCalibrationStore;
  /** Per-run prompt-cache namespace for providers that support prompt caching. */
  compactSessionId: string;
}

export function makeCompactSessionId(): string {
  return "sc-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
}

export function createServices(overrides: Partial<SmartCompactServices> = {}): SmartCompactServices {
  return {
    clock: overrides.clock ?? systemClock,
    // Lazy delegate, not `getLlmClient()` captured eagerly: the llm-client
    // seam promises call-time resolution, so a `setLlmClient` installed
    // after this bag was created must still be honoured.
    llm: overrides.llm ?? { complete: (...args) => getLlmClient().complete(...args) },
    toolSupport: overrides.toolSupport ?? new ToolSupportCache(),
    metrics: overrides.metrics ?? new MetricsSink(),
    extractionCacheStats: overrides.extractionCacheStats ?? new ExtractionCacheStats(),
    tokenCalibration: overrides.tokenCalibration ?? new TokenCalibrationStore(),
    compactSessionId: overrides.compactSessionId ?? makeCompactSessionId(),
  };
}

// ── Process-default registry ─────────────────────────────────────────────────
//
// Production runs use the run-scoped services injected through RunContext.
// This process-default registry exists only for legacy direct callers and test
// seams whose public signatures still allow an omitted services bag. Production
// orchestration never resets or mutates it.

let _default: SmartCompactServices = createServices();

export function getDefaultServices(): SmartCompactServices { return _default; }

/** Swap the default container; tests use this to inject a clock/llm. */
export function setDefaultServices(services: SmartCompactServices): void { _default = services; }

/** Reset the legacy/test default container. Production runs do not call this. */
export function resetDefaultServices(): void { _default = createServices(); }
