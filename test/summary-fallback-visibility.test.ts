import { beforeEach, describe, expect, it } from "bun:test";
import { buildSuccessMetrics } from "../src/app/steps/metrics.ts";
import { evaluateProviderMetrics, formatProviderEvaluation } from "../src/domain/provider-evaluation.ts";
import {
  assessCanary, formatPrivacySafeTelemetry, buildPrivacySafeTelemetry,
  formatSummarySplit, summarySourceOf, summarySourceSplit,
} from "../src/domain/telemetry.ts";
import { createServices } from "../src/infra/services.ts";
import type { CompactMetricsEntry } from "../src/types.ts";
import { buildMetricsReport } from "../src/ui/metrics-report.ts";
import { notifyAppliedCompaction, notifySummaryFallback, resetSummaryFallbackNoticesForTests } from "../src/ui/overlays.ts";

function run(patch: Partial<CompactMetricsEntry>): CompactMetricsEntry {
  return {
    ts: new Date().toISOString(), runId: "run-" + Math.random(), sessionId: "s1", metricsSchemaVersion: 2,
    version: "1.0.0", releaseChannel: "canary", totalCalls: 2, totalInput: 1_000, totalOutput: 100,
    totalCacheHit: 0, avgLatency: 100, cacheHitRate: 0, status: "success", verificationScore: 100,
    provider: "p", model: "p/m", ...patch,
  };
}

function ui() {
  const calls: Array<[string, string]> = [];
  const ctx = { hasUI: true, ui: { notify: (message: string, type: string) => calls.push([type, message]) } } as any;
  return { ctx, calls };
}

const fallbackDetails = {
  method: "heuristic", summarySource: "fallback", model: "minimax/M3",
  providerRoutes: { explore: "minimax/M3", synthesize: "minimax/M3", verify: "minimax/M3" },
  generationFallbacks: ["1 synthesis batch budget fallback(s)", "assembly generation failed"],
  tokensBefore: 1_000, tokensSaved: 500, qualityScore: 100, gaps: [],
} as any;

describe("summary source classification", () => {
  it("separates LLM summaries, committed fallbacks and zero-call plans", () => {
    expect(summarySourceOf({ method: "eesv" })).toBe("llm");
    expect(summarySourceOf({ method: "single-pass-cache" })).toBe("llm");
    expect(summarySourceOf({ method: "heuristic" })).toBe("fallback");
    // The quality floor replaced model text with the deterministic summary.
    expect(summarySourceOf({ method: "eesv", qualityFloorUsed: true })).toBe("fallback");
    expect(summarySourceOf({ method: "zero-call" })).toBe("zero-call");
    expect(summarySourceOf({ method: "heuristic-cache" })).toBe("zero-call");
    expect(summarySourceOf({ method: "native" })).toBeUndefined();
    expect(summarySourceOf({ method: "heuristic", summarySource: "llm" })).toBe("llm");
  });

  it("counts only applied runs and tracks the trailing fallback streak", () => {
    const split = summarySourceSplit([
      run({ method: "heuristic" }), run({ method: "eesv" }), run({ method: "heuristic", status: "dry-run" }),
      run({ method: "heuristic" }), run({ method: "zero-call" }), run({ method: "native" }), run({ method: "heuristic" }),
    ]);
    expect(split).toEqual({ llm: 1, fallback: 3, zeroCall: 1, consecutiveFallbacks: 2 });
    expect(formatSummarySplit(split)).toBe("LLM summaries 1/4 (3 deterministic fallback) · 1 zero-call by plan");
    expect(formatSummarySplit(summarySourceSplit([]))).toBeUndefined();
  });
});

describe("summary fallback in metrics and telemetry", () => {
  it("records an explicit source and fallback labels without changing the verifier score", () => {
    const rc = {
      runId: "run-fallback-metrics", services: createServices(), flags: { skipCompact: false, autoTriggered: true },
      verificationProvenance: { initialScore: 100, deterministicPatched: [], llmPatched: false, qualityFloorUsed: false, finalScore: 100, remainingGaps: [] },
      verificationScore: 100, verificationGaps: [], phaseTimings: [], pipelineStart: Date.now(),
      summaryModel: { provider: "minimax", id: "M3" }, modelLabel: "minimax/M3", profile: "balanced", mode: "thorough",
      tier: "full", contextPercent: 80, toolPercent: 60, totalTokens: 1_000, tokensSaved: 500, chunkCount: 2,
      methodForMetrics: "heuristic", generationFallbacks: ["assembly generation failed"], adapted: false, details: {},
    } as any;
    expect(buildSuccessMetrics(rc, "success")).toMatchObject({
      method: "heuristic", summarySource: "fallback", generationFallbacks: ["assembly generation failed"], verificationScore: 100,
    });
    expect(buildSuccessMetrics({ ...rc, methodForMetrics: "zero-call", generationFallbacks: [] }, "success")).toMatchObject({
      summarySource: "zero-call", generationFallbacks: undefined,
    });
  });

  it("shows the split in the canary report and metrics summary; gates keep their meaning", () => {
    const entries = [
      ...Array.from({ length: 3 }, () => run({ releaseChannel: "stable", method: "eesv" })),
      ...Array.from({ length: 3 }, () => run({ method: "heuristic" })),
    ];
    const canary = assessCanary(entries, [], { version: "1.0.0", minCanaryRuns: 5 });
    expect(canary.canary.summaries).toMatchObject({ llm: 0, fallback: 3 });
    expect(canary.canary.avgQuality).toBe(100);
    const telemetry = formatPrivacySafeTelemetry(buildPrivacySafeTelemetry(entries, [], { version: "1.0.0", minCanaryRuns: 5 }));
    expect(telemetry).toContain("| LLM summaries | LLM summaries 3/3 | LLM summaries 0/3 (3 deterministic fallback) |");
    expect(buildMetricsReport(entries, [])).toContain("Summaries: LLM summaries 3/6 (3 deterministic fallback) across applied runs");
  });

  it("marks the synthesize route's fallback share in provider evaluation", () => {
    const route = { stage: "synthesize" as const, provider: "p", model: "m", calls: 2, successes: 2, avgLatencyMs: 10, inputTokens: 10, outputTokens: 10 };
    const report = evaluateProviderMetrics([
      run({ method: "heuristic", providerRoutes: [route] }), run({ method: "eesv", providerRoutes: [route] }),
    ], { minSamples: 2 });
    expect(report.cells[0]).toMatchObject({ successRate: 1, summaryFallbackRate: 0.5 });
    expect(formatProviderEvaluation(report)).toContain("| 2 | 100% | 50% |");
  });
});

describe("summary fallback notices", () => {
  beforeEach(() => resetSummaryFallbackNoticesForTests());

  it("notes an isolated fallback once per session and route with cause and route", () => {
    const { ctx, calls } = ui();
    notifySummaryFallback(ctx, "s1", fallbackDetails, []);
    notifySummaryFallback(ctx, "s1", fallbackDetails, [run({ method: "heuristic" }), run({ method: "eesv" })]);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("info");
    expect(calls[0][1]).toContain("cause: 1 synthesis batch budget fallback(s); summary model minimax/M3");
    expect(calls[0][1]).toContain("LLM summaries 0/1 (1 deterministic fallback) this session");
    notifySummaryFallback(ctx, "s2", fallbackDetails, []);
    expect(calls).toHaveLength(2);
  });

  it("warns every time fallbacks repeat in the session", () => {
    const { ctx, calls } = ui();
    const earlier = [run({ method: "eesv" }), run({ method: "heuristic" })];
    notifySummaryFallback(ctx, "s1", fallbackDetails, earlier);
    notifySummaryFallback(ctx, "s1", fallbackDetails, [...earlier, run({ method: "heuristic" })]);
    expect(calls.map(call => call[0])).toEqual(["warning", "warning"]);
    expect(calls[1][1]).toContain("3 summaries in a row fell back");
    expect(calls[1][1]).toContain("LLM summaries 1/4 (3 deterministic fallback) this session");
  });

  it("stays silent for LLM summaries and zero-call plans", () => {
    const { ctx, calls } = ui();
    notifySummaryFallback(ctx, "s1", { ...fallbackDetails, summarySource: "llm" }, [run({ method: "heuristic" })]);
    notifySummaryFallback(ctx, "s1", { ...fallbackDetails, method: "heuristic", summarySource: "zero-call", generationFallbacks: [] }, []);
    expect(calls).toEqual([]);
  });

  it("labels a committed fallback in the applied notice", () => {
    const { ctx, calls } = ui();
    notifyAppliedCompaction(ctx, fallbackDetails, true);
    expect(calls[0][1]).toContain("deterministic fallback summary, not LLM (1 synthesis batch budget fallback(s), assembly generation failed)");
  });
});
