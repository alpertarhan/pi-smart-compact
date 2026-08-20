import { describe, expect, it } from "bun:test";
import {
  aggregateProviderRoutes,
  evaluateProviderMetrics,
  formatProviderEvaluation,
  providerScenario,
  providerStage,
} from "../src/domain/provider-evaluation.ts";
import type {
  CompactMetricsEntry,
  LLMCallMetric,
  ProviderRouteMetric,
} from "../src/types.ts";

function entry(
  provider: string,
  model: string,
  quality: number,
  latency: number,
  patch: Partial<CompactMetricsEntry> = {},
): CompactMetricsEntry {
  const route: ProviderRouteMetric = {
    stage: "synthesize",
    provider,
    model,
    calls: 2,
    successes: 2,
    avgLatencyMs: latency,
    inputTokens: 20_000,
    outputTokens: 2_000,
    qualityScore: quality,
    qualityBasis: "pre-repair-verification",
  };
  return {
    ts: new Date().toISOString(),
    sessionId: Math.random().toString(),
    totalCalls: 2,
    totalInput: 20_000,
    totalOutput: 2_000,
    totalCacheHit: 0,
    avgLatency: latency,
    cacheHitRate: 0,
    status: "success",
    contextPercent: 80,
    toolPercent: 80,
    verificationScore: quality,
    metricsSchemaVersion: 2,
    providerRoutes: [route],
    ...patch,
  };
}

describe("provider evaluation", () => {
  it("maps call phases to stage routes and aggregates calls", () => {
    expect(providerStage("explore-loop")).toBe("explore");
    expect(providerStage("batch")).toBe("synthesize");
    expect(providerStage("patch")).toBe("verify");
    const metrics: LLMCallMetric[] = [
      {
        phase: "explore",
        provider: "p",
        model: "m",
        inputTokens: 10,
        outputTokens: 2,
        cacheHitTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: 100,
        success: true,
      },
      {
        phase: "explore-loop",
        provider: "p",
        model: "m",
        inputTokens: 20,
        outputTokens: 3,
        cacheHitTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: 300,
        success: false,
      },
      {
        phase: "patch",
        provider: "q",
        model: "v",
        inputTokens: 5,
        outputTokens: 1,
        cacheHitTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: 50,
        success: true,
      },
    ];
    expect(aggregateProviderRoutes(metrics)).toEqual([
      {
        stage: "explore",
        provider: "p",
        model: "m",
        calls: 2,
        successes: 1,
        avgLatencyMs: 200,
        inputTokens: 30,
        outputTokens: 5,
      },
      {
        stage: "verify",
        provider: "q",
        model: "v",
        calls: 1,
        successes: 1,
        avgLatencyMs: 50,
        inputTokens: 5,
        outputTokens: 1,
      },
    ]);
  });

  it("classifies the real-run scenario matrix", () => {
    expect(providerScenario({ contextPercent: 60, toolPercent: 10 })).toBe(
      "compact/conversational",
    );
    expect(providerScenario({ contextPercent: 75, toolPercent: 50 })).toBe(
      "pressure/mixed",
    );
    expect(providerScenario({ contextPercent: 95, toolPercent: 90 })).toBe(
      "critical/tool-heavy",
    );
  });

  it("recommends only a sufficiently sampled reliable route", () => {
    const entries = [
      ...Array.from({ length: 5 }, () =>
        entry("quality", "model-a", 92, 20_000),
      ),
      ...Array.from({ length: 5 }, () => entry("fast", "model-b", 65, 4_000)),
      entry("tiny", "model-c", 100, 100),
    ];
    const report = evaluateProviderMetrics(entries, { minSamples: 5 });
    const recommendation = report.recommendations.find(
      (item) =>
        item.stage === "synthesize" && item.scenario === "pressure/tool-heavy",
    );
    expect(recommendation?.model).toBe("quality/model-a");
    expect(
      report.cells.find((cell) => cell.provider === "tiny")?.eligible,
    ).toBe(false);
    expect(report.advisoryOnly).toBe(true);
  });

  it("keeps the selected model when evidence is sparse", () => {
    const report = evaluateProviderMetrics([entry("p", "m", 100, 1_000)], {
      minSamples: 5,
    });
    expect(report.recommendations[0]).toMatchObject({
      model: null,
      confidence: 0,
    });
    expect(report.recommendations[0].reason).toContain(
      "keep the selected model",
    );
  });

  it("does not copy a run-level final score into unrelated provider stages", () => {
    const routes: ProviderRouteMetric[] = [
      {
        stage: "explore",
        provider: "p",
        model: "explorer",
        calls: 1,
        successes: 1,
        avgLatencyMs: 10,
        inputTokens: 10,
        outputTokens: 1,
      },
      {
        stage: "synthesize",
        provider: "p",
        model: "writer",
        calls: 1,
        successes: 1,
        avgLatencyMs: 10,
        inputTokens: 10,
        outputTokens: 1,
        qualityScore: 72,
        qualityBasis: "pre-repair-verification",
      },
      {
        stage: "verify",
        provider: "p",
        model: "repairer",
        calls: 1,
        successes: 1,
        avgLatencyMs: 10,
        inputTokens: 10,
        outputTokens: 1,
      },
    ];
    const report = evaluateProviderMetrics(
      [entry("p", "writer", 100, 10, { providerRoutes: routes })],
      { minSamples: 2 },
    );
    expect(
      report.cells.find((cell) => cell.stage === "synthesize")?.avgQuality,
    ).toBe(72);
    expect(
      report.cells.find((cell) => cell.stage === "explore")?.avgQuality,
    ).toBeNull();
    expect(
      report.cells.find((cell) => cell.stage === "verify")?.avgQuality,
    ).toBeNull();
  });

  it("does not trust legacy verification scores with incompatible semantics", () => {
    const legacy = entry("legacy", "m", 100, 1_000, {
      metricsSchemaVersion: undefined,
      providerRoutes: undefined,
      provider: "legacy",
      model: "legacy/m",
    });
    const report = evaluateProviderMetrics(
      Array.from({ length: 5 }, () => ({ ...legacy })),
      { minSamples: 5 },
    );
    expect(report.cells[0].avgQuality).toBeNull();
    expect(report.cells[0].qualityCoverage).toBe(0);
    expect(formatProviderEvaluation(report)).toContain("advisory only");
  });
});
