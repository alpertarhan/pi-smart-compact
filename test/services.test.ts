/**
 * Per-run services container tests.
 *
 * The services bag is what lets two pi sessions run without their metrics,
 * extraction-cache stats leaking into each other while production-only
 * provider capability/calibration knowledge can be shared safely.
 * Locking down the contract here means a future refactor can swap default
 * services freely as long as these assertions hold.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  ToolSupportCache,
  MetricsSink,
  ExtractionCacheStats,
  BudgetGuard,
  BudgetExceededError,
  createServices,
  createProductionServices,
  getDefaultServices,
  resetDefaultServices,
  setDefaultServices,
} from "../src/infra/services.ts";
import { getMetricsSummary, trackedComplete } from "../src/utils/cache.ts";
import type { Model, Api } from "@earendil-works/pi-ai";

beforeEach(() => {
  resetDefaultServices();
});

describe("ToolSupportCache", () => {
  it("returns undefined for an unseen key so callers force a probe", () => {
    const cache = new ToolSupportCache();
    expect(cache.get("openai/gpt-x", 0)).toBeUndefined();
  });

  it("returns the cached value within TTL", () => {
    const cache = new ToolSupportCache(1000);
    cache.set("openai/gpt-x", true, 0);
    expect(cache.get("openai/gpt-x", 500)).toBe(true);
  });

  it("expires entries past TTL so a recovering provider re-probes", () => {
    const cache = new ToolSupportCache(1000);
    cache.set("openai/gpt-x", false, 0);
    // Past the window — the provider may have recovered, force re-probe.
    expect(cache.get("openai/gpt-x", 2000)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("evicts least-recently-used entries at its bound", () => {
    const cache = new ToolSupportCache(1000, 2);
    cache.set("a", true, 0);
    cache.set("b", true, 0);
    expect(cache.get("a", 1)).toBe(true);
    cache.set("c", true, 1);
    expect(cache.get("b", 1)).toBeUndefined();
    expect(cache.get("a", 1)).toBe(true);
  });
});

describe("MetricsSink", () => {
  const sample = (
    over: Partial<{
      in: number;
      out: number;
      cache: number;
      cw: number;
      lat: number;
    }> = {},
  ) => ({
    phase: "batch" as const,
    model: "x",
    provider: "openai",
    inputTokens: over.in ?? 100,
    outputTokens: over.out ?? 50,
    cacheHitTokens: over.cache ?? 0,
    cacheWriteTokens: over.cw ?? 0,
    latencyMs: over.lat ?? 200,
    success: true,
  });

  it("computes a summary that adds inputs/outputs and averages latency", () => {
    const sink = new MetricsSink();
    sink.record(sample({ in: 100, out: 50, lat: 100 }));
    sink.record(sample({ in: 200, out: 80, lat: 300 }));
    const s = sink.summary();
    expect(s.totalCalls).toBe(2);
    expect(s.totalInput).toBe(300);
    expect(s.totalOutput).toBe(130);
    expect(s.avgLatency).toBe(200);
  });

  it("returns a zero summary for an empty sink so divide-by-zero never happens", () => {
    const sink = new MetricsSink();
    const s = sink.summary();
    expect(s.totalCalls).toBe(0);
    expect(s.avgLatency).toBe(0);
    expect(s.cacheHitRate).toBe(0);
  });

  it("trims the buffer once it crosses the cap so we don't grow unbounded", () => {
    const sink = new MetricsSink(10);
    for (let i = 0; i < 25; i++) sink.record(sample({ in: i }));
    // Cap is 10; once exceeded we trim to ~half. Exact figure is the
    // implementation detail we deliberately don't lock down — we only assert
    // the bound.
    expect(sink.snapshot().length).toBeLessThanOrEqual(10);
  });
});

describe("BudgetGuard", () => {
  it("reserves calls atomically and rejects the first call over budget", () => {
    const guard = new BudgetGuard(2);
    expect(guard.remainingCalls()).toBe(2);
    guard.reserveCall();
    expect(guard.remainingCalls()).toBe(1);
    guard.reserveCall();
    expect(() => guard.reserveCall()).toThrow(BudgetExceededError);
    expect(guard.reason()).toBe("calls");
    expect(guard.callCount()).toBe(2);
  });

  it("rejects calls after the latency deadline with a fake clock", () => {
    let now = 100;
    const guard = new BudgetGuard(0, 5000, { now: () => now });
    now = 5100;
    expect(() => guard.reserveCall()).toThrow("latency budget exhausted");
    expect(guard.reason()).toBe("latency");
  });

  it("reserves output before concurrent calls and reconciles actual usage", () => {
    const guard = new BudgetGuard(0, 0, { now: () => 0 }, 1_000, 100);
    const first = guard.reserveCall(10, 60);
    expect(guard.remainingOutputTokens()).toBe(40);
    expect(() => guard.reserveCall(10, 50)).toThrow("tokens budget exhausted");
    guard.reconcileOutput(first, 20);
    expect(guard.outputTokenCount()).toBe(20);
    expect(guard.remainingOutputTokens()).toBe(80);
    const second = guard.reserveCall(10, 50);
    guard.commitFailedOutput(second);
    expect(guard.outputTokenCount()).toBe(70);
  });

  it("reserves aggregate prompt tokens and reconciles estimates with provider usage", () => {
    const guard = new BudgetGuard(0, 0, { now: () => 0 }, 100, 50);
    guard.reserveCall(70);
    expect(guard.inputTokenCount()).toBe(70);
    expect(() => guard.reserveCall(40)).toThrow("tokens budget exhausted");
    guard.reconcileInput(70, 20);
    guard.reserveCall(40);
    expect(guard.inputTokenCount()).toBe(60);
    guard.recordOutput(50);
    expect(guard.outputTokenCount()).toBe(50);
    expect(() => guard.reserveCall(1)).toThrow("tokens budget exhausted");
  });
});

describe("ExtractionCacheStats", () => {
  it("returns hitRate=0 with no observations", () => {
    const stats = new ExtractionCacheStats();
    expect(stats.snapshot().hitRate).toBe(0);
  });

  it("computes hitRate as hits / (hits + misses)", () => {
    const stats = new ExtractionCacheStats();
    stats.recordHit();
    stats.recordHit();
    stats.recordMiss();
    const s = stats.snapshot();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBeCloseTo(2 / 3);
  });

  it("clear() resets both counters", () => {
    const stats = new ExtractionCacheStats();
    stats.recordHit();
    stats.clear();
    expect(stats.snapshot()).toEqual({ hits: 0, misses: 0, hitRate: 0 });
  });
});

describe("run-scoped services", () => {
  it("shares only bounded provider knowledge between production runs", () => {
    const a = createProductionServices();
    const b = createProductionServices();
    const isolated = createServices();
    expect(a.toolSupport).toBe(b.toolSupport);
    expect(a.tokenCalibration).toBe(b.tokenCalibration);
    expect(a.metrics).not.toBe(b.metrics);
    expect(a.budget).not.toBe(b.budget);
    expect(isolated.toolSupport).not.toBe(a.toolSupport);
    expect(isolated.tokenCalibration).not.toBe(a.tokenCalibration);
  });

  it("trackedComplete records metrics and calibration only on the supplied services", async () => {
    const model = {
      id: "m",
      provider: "openai",
      contextWindow: 128000,
    } as Model<Api>;
    const mk = (input: number) =>
      createServices({
        llm: {
          complete: async () =>
            ({
              content: [{ type: "text" as const, text: "ok" }],
              usage: { input, output: 5, cacheRead: 0 },
            }) as any,
        },
      });
    const a = mk(10);
    const b = mk(20);

    await trackedComplete(
      "batch",
      model,
      { systemPrompt: "x", messages: [] } as any,
      { apiKey: "k" } as any,
      a,
    );
    await trackedComplete(
      "batch",
      model,
      { systemPrompt: "x", messages: [] } as any,
      { apiKey: "k" } as any,
      b,
    );

    expect(getMetricsSummary(a).totalInput).toBe(10);
    expect(getMetricsSummary(b).totalInput).toBe(20);
    // The default container must stay untouched — explicit bags only.
    expect(getMetricsSummary(getDefaultServices()).totalCalls).toBe(0);
  });

  it("conservatively estimates missing provider usage for metrics and budgets", async () => {
    const model = {
      id: "m",
      provider: "openai",
      contextWindow: 128000,
    } as Model<Api>;
    const services = createServices({
      llm: {
        complete: async () =>
          ({
            content: [
              { type: "text" as const, text: "generated ".repeat(200) },
            ],
          }) as any,
      },
    });
    await trackedComplete(
      "batch",
      model,
      {
        systemPrompt: "system ".repeat(50),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "input ".repeat(100) }],
          },
        ],
      } as any,
      { apiKey: "k", maxTokens: 500 } as any,
      services,
    );
    const metric = services.metrics.snapshot()[0];
    expect(metric.usageEstimated).toBe(true);
    expect(metric.inputTokens).toBeGreaterThan(0);
    expect(metric.outputTokens).toBeGreaterThan(0);
    expect(services.budget.inputTokenCount()).toBe(metric.inputTokens);
    expect(services.budget.outputTokenCount()).toBe(metric.outputTokens);
  });
});

describe("default container", () => {
  it("isolates state between resetDefaultServices calls", () => {
    getDefaultServices().metrics.record({
      phase: "batch",
      model: "m",
      provider: "p",
      inputTokens: 10,
      outputTokens: 5,
      cacheHitTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: 50,
      success: true,
    });
    expect(getDefaultServices().metrics.snapshot().length).toBe(1);
    resetDefaultServices();
    expect(getDefaultServices().metrics.snapshot().length).toBe(0);
  });

  it("setDefaultServices swaps the whole bag for tests", () => {
    const custom = createServices({ metrics: new MetricsSink(2) });
    setDefaultServices(custom);
    expect(getDefaultServices()).toBe(custom);
  });
});
