import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  buildDashboardInsights, calculateDashboardDataConfidence,
  formatDashboardCanary, formatDashboardProviders, formatDashboardQuality,
} from "../src/ui/dashboard-insights.ts";
import type { CompactMetricsEntry } from "../src/types.ts";

function run(patch: Partial<CompactMetricsEntry> = {}): CompactMetricsEntry {
  return {
    ts: new Date().toISOString(), runId: "run-" + randomUUID(), sessionId: "s", metricsSchemaVersion: 2,
    version: "8.0.0", releaseChannel: "stable", status: "success",
    provider: "openai", model: "openai/gpt", method: "eesv", mode: "balanced",
    durationMs: 1_000, avgLatency: 500, totalCalls: 1,
    totalInput: 2_000, totalOutput: 500, totalCacheHit: 0, cacheHitRate: 0,
    verificationScore: 95, verificationGaps: 0, initialVerificationScore: 85,
    deterministicPatchCount: 1, llmPatched: false, qualityFloorUsed: false,
    remainingVerificationGaps: 0,
    providerRoutes: [{
      stage: "synthesize", provider: "openai", model: "gpt", calls: 1,
      successes: 1, avgLatencyMs: 500, inputTokens: 2_000, outputTokens: 500,
      qualityScore: 85, qualityBasis: "pre-repair-verification",
    }],
    ...patch,
  };
}

describe("dashboard trust insights", () => {
  it("meets the >=85 Data Confidence target with complete recent schema-v2 evidence", () => {
    const confidence = calculateDashboardDataConfidence(Array.from({ length: 20 }, () => run()));
    expect(confidence.score).toBe(100);
    expect(confidence.targetMet).toBe(true);
    expect(confidence.label).toBe("high");
  });

  it("does not meet the trust target with a half-legacy window", () => {
    const entries = [
      ...Array.from({ length: 20 }, () => run({ metricsSchemaVersion: undefined })),
      ...Array.from({ length: 20 }, () => run()),
    ];
    const confidence = calculateDashboardDataConfidence(entries);
    expect(confidence.targetMet).toBe(false);
    expect(confidence.score).toBeLessThan(85);
  });

  it("separates complete telemetry from catastrophically bad quality", () => {
    const insights = buildDashboardInsights(Array.from({ length: 20 }, () => run({ verificationScore: 0 })));
    expect(insights.confidence.score).toBe(100);
    expect(insights.confidence.targetMet).toBe(true);
    expect(insights.quality.healthScore).toBeLessThan(25);
    expect(insights.quality.targetMet).toBe(false);
  });

  it("reports why legacy or stale evidence is not trustworthy", () => {
    const old = run({
      ts: "2020-01-01T00:00:00.000Z", metricsSchemaVersion: undefined,
      verificationScore: 100, providerRoutes: undefined,
    });
    const confidence = calculateDashboardDataConfidence(Array.from({ length: 20 }, () => ({ ...old })));
    expect(confidence.targetMet).toBe(false);
    expect(confidence.schemaScore).toBe(0);
    expect(confidence.freshnessScore).toBe(0);
    expect(confidence.guidance.join(" ")).toContain("legacy verifier scores are excluded");
  });

  it("reports route quality only where stage-local evidence exists", () => {
    const insights = buildDashboardInsights([run({
      verificationScore: 100,
      providerRoutes: [
        { stage: "explore", provider: "openai", model: "gpt", calls: 1, successes: 1, avgLatencyMs: 10, inputTokens: 10, outputTokens: 1 },
        { stage: "synthesize", provider: "openai", model: "gpt", calls: 1, successes: 1, avgLatencyMs: 10, inputTokens: 10, outputTokens: 1, qualityScore: 80, qualityBasis: "pre-repair-verification" },
        { stage: "verify", provider: "openai", model: "gpt", calls: 1, successes: 1, avgLatencyMs: 10, inputTokens: 10, outputTokens: 1 },
      ],
    })]);
    expect(insights.providers.find(route => route.stage === "synthesize")?.avgQuality).toBe(80);
    expect(insights.providers.find(route => route.stage === "explore")?.avgQuality).toBeNull();
    expect(insights.providers.find(route => route.stage === "verify")?.avgQuality).toBeNull();
  });

  it("builds provider, quality repair, failure, and canary drilldowns", () => {
    const entries = [
      ...Array.from({ length: 20 }, () => run()),
      ...Array.from({ length: 20 }, () => run({ releaseChannel: "canary", qualityFloorUsed: true })),
      run({ status: "error", failureKind: "provider", verificationScore: undefined }),
      run({ status: "error", failureKind: "yield", verificationScore: undefined }),
    ];
    const damage = entries
      .filter(entry => entry.status === "success")
      .map(entry => ({ runId: entry.runId, damageScore: 0 }));
    const insights = buildDashboardInsights(entries, damage, {
      version: "8.0.0", minCanaryRuns: 20,
    });
    expect(insights.quality.measuredRuns).toBe(40);
    expect(insights.quality.qualityFloorRuns).toBe(20);
    expect(insights.quality.averageRepairGain).toBe(10);
    expect(insights.providers[0]).toMatchObject({
      stage: "synthesize", provider: "openai", model: "gpt", reliability: 1,
    });
    expect(insights.failures.provider).toBe(1);
    expect(insights.failures.yield).toBe(1);
    expect(insights.canary.decision).toBe("promote");
    expect(formatDashboardQuality(insights).join("\n")).toContain("Data Confidence");
    expect(formatDashboardProviders(insights).join("\n")).toContain("openai/gpt");
    const canaryText = formatDashboardCanary(insights).join("\n");
    expect(canaryText).toContain("PROMOTE");
    expect(canaryText).toContain("Runs (total/applied): stable 22/22 | canary 20/20");
  });
});
