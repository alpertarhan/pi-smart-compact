import { describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildSuccessMetrics, recordFailureMetrics } from "../src/app/steps/metrics.ts";
import { VERSION } from "../src/constants.ts";

let cache: typeof import("../src/utils/cache.ts");
let metricsReport: typeof import("../src/ui/metrics-report.ts");
let services: typeof import("../src/infra/services.ts");
let home: string;

async function loadWithHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-metrics-"));
  process.env.HOME = home;
  cache = await import("../src/utils/cache.ts?home=" + encodeURIComponent(home) + "-" + Date.now());
  metricsReport = await import("../src/ui/metrics-report.ts?home=" + encodeURIComponent(home) + "-" + Date.now());
  services = await import("../src/infra/services.ts");
  return home;
}

describe("metrics reporting", () => {
  beforeEach(async () => {
    home = await loadWithHome();
  });

  it("writes and summarizes profile/provider comparisons", () => {
    const svc = services.createServices();
    cache.appendMetricsLog("s1", { profile: "balanced", provider: "openai", model: "openai/gpt", method: "single-pass", status: "success", durationMs: 1000, tokensSaved: 5000, verificationScore: 95 }, svc);
    cache.appendMetricsLog("s2", { profile: "aggressive", provider: "anthropic", model: "anthropic/claude", method: "eesv", status: "timeout", durationMs: 2000, tokensSaved: 9000, verificationScore: 90 }, svc);
    const report = metricsReport.buildMetricsReport(cache.readMetricsLog());
    expect(report).toContain("Profile comparison");
    expect(report).toContain("balanced: n=1");
    expect(report).toContain("anthropic: n=1");
    expect(report).toContain("Data Confidence:");
    expect(report).toContain("Quality drilldown");
    expect(report).toContain("Canary / stable control");
    expect(report).toContain("Stage provider/model comparison");
  });

  it("attributes pre-repair quality only to one successful synthesis route", () => {
    const svc = services.createServices();
    for (const phase of ["explore", "batch", "patch"] as const) {
      svc.metrics.record({
        phase, provider: "openai", model: phase, inputTokens: 10, outputTokens: 1,
        cacheHitTokens: 0, cacheWriteTokens: 0, latencyMs: 10, success: true,
      });
    }
    const snapshot = buildSuccessMetrics({
      runId: "run-stage-quality", services: svc,
      flags: { skipCompact: false, autoTriggered: false },
      verificationProvenance: { initialScore: 73, deterministicPatched: [], llmPatched: true, finalScore: 95, remainingGaps: [] },
      verificationScore: 95, verificationGaps: [], phaseTimings: [], pipelineStart: Date.now(),
      summaryModel: { provider: "openai", id: "batch" }, modelLabel: "openai/batch",
      profile: "balanced", mode: "balanced", tier: "full", contextPercent: 80,
      toolPercent: 50, totalTokens: 1_000, tokensSaved: 500, chunkCount: 1,
      methodForMetrics: "eesv", adapted: false,
      details: {
        plannedAfterTokens: 600, plannedSavedTokens: 400, plannedYield: 0.4,
        estimatedAfterTokens: 500, estimatedSavedTokens: 500, estimatedYield: 0.5,
        retainedTailTokens: 300, summaryTokens: 200, summaryBudgetTokens: 300,
        targetAfterTokens: 600, relaxedSoftBoundaries: ["anchor"], hardBoundaryAdjusted: true,
      },
    } as any, "success");
    expect(snapshot.runId).toBe("run-stage-quality");
    expect(snapshot).toMatchObject({
      tokensSaved: 500, estimatedSavedTokens: 500, estimatedAfterTokens: 500,
      plannedAfterTokens: 600, retainedTailTokens: 300, relaxedSoftBoundaries: ["anchor"], hardBoundaryAdjusted: true,
    });
    expect(snapshot.providerRoutes?.find(route => route.stage === "synthesize")).toMatchObject({
      qualityScore: 73, qualityBasis: "pre-repair-verification",
    });
    expect(snapshot.providerRoutes?.find(route => route.stage === "explore")?.qualityScore).toBeUndefined();
    expect(snapshot.providerRoutes?.find(route => route.stage === "verify")?.qualityScore).toBeUndefined();
  });

  it("persists schema-v2 failure taxonomy without error text", () => {
    const svc = services.createServices();
    recordFailureMetrics({
      services: svc,
      cancellation: { timedOut: false },
      flags: { autoTriggered: true },
      summaryModel: { provider: "openai", id: "gpt" },
      profile: "balanced", mode: "balanced", modelLabel: "openai/gpt",
      pipelineStart: Date.now(),
    } as any, Object.assign(new Error("secret provider body"), { status: 429 }), {
      sessionId: "failed-session", contextPercent: 80, toolPercent: 50,
    });
    const entry = cache.readMetricsLog().at(-1);
    expect(entry?.metricsSchemaVersion).toBe(2);
    expect(entry?.failureKind).toBe("rate-limit");
    expect(JSON.stringify(entry)).not.toContain("secret provider body");
  });

  it("persists content-free verification diagnostics for pre-state failures", () => {
    const svc = services.createServices();
    const error = Object.assign(new Error("Verification gate rejected summary: secret evidence"), {
      name: "VerificationGateError", score: 92, initialScore: 64, gapCount: 2,
      gapKinds: ["inconsistency", "fabricated-file"],
    });
    recordFailureMetrics({
      services: svc,
      cancellation: { timedOut: false },
      flags: { autoTriggered: false },
      summaryModel: { provider: "openai", id: "gpt" },
      profile: "balanced", mode: "balanced", modelLabel: "openai/gpt",
      pipelineStart: Date.now(),
    } as any, error, { sessionId: "verify-failure", contextPercent: 40 });
    const entry = cache.readMetricsLog().at(-1);
    expect(entry).toMatchObject({
      failureKind: "verification", verificationScore: 92, initialVerificationScore: 64,
      verificationGaps: 2, remainingVerificationGaps: 2,
      verificationGapKinds: ["inconsistency", "fabricated-file"],
    });
    expect(JSON.stringify(entry)).not.toContain("secret evidence");
  });

  it("persists content-free yield-gate diagnostics without summary text", () => {
    const svc = services.createServices();
    const error = Object.assign(new Error("Final summary estimate misses target"), {
      name: "YieldGateError", plannedAfterTokens: 500, plannedSavedTokens: 500, plannedYield: 0.5,
      estimatedAfterTokens: 700, estimatedSavedTokens: 300, estimatedYield: 0.3,
      retainedTailTokens: 400, summaryTokens: 300, summaryBudgetTokens: 100,
      targetAfterTokens: 600, relaxedSoftBoundaries: ["anchor"], hardBoundaryAdjusted: true,
    });
    recordFailureMetrics({
      services: svc, cancellation: { timedOut: false }, flags: { autoTriggered: false },
      summaryModel: { provider: "openai", id: "gpt" }, profile: "balanced", mode: "balanced",
      modelLabel: "openai/gpt", pipelineStart: Date.now(),
    } as any, error, { sessionId: "yield-failure", totalTokens: 1_000, profile: "balanced" });
    const entry = cache.readMetricsLog().at(-1);
    expect(entry).toMatchObject({
      failureKind: "yield", estimatedAfterTokens: 700, estimatedSavedTokens: 300,
      targetAfterTokens: 600, relaxedSoftBoundaries: ["anchor"], hardBoundaryAdjusted: true,
    });
    expect(JSON.stringify(entry)).not.toContain("Final summary estimate");
  });

  it("writes a local html dashboard", () => {
    cache.appendMetricsLog("s1", { profile: "balanced", provider: "openai", status: "success", durationMs: 1000 }, services.createServices());
    const fp = metricsReport.writeMetricsDashboard(cache.readMetricsLog());
    expect(fp).toBeTruthy();
    expect(fs.existsSync(fp!)).toBe(true);
    const html = fs.readFileSync(fp!, "utf8");
    expect(html).toContain("Smart Compact Metrics");
    expect(html).toContain("Data Confidence");
    expect(html).toContain("Canary vs stable");
    expect(html).toContain("Quality drilldown");
  });

  it("renders >=85 Data Confidence, canary deltas, and stage provider evidence", () => {
    const svc = services.createServices();
    for (let index = 0; index < 40; index++) {
      cache.appendMetricsLog("trust-" + index, {
        runId: "run-dashboard-" + index,
        metricsSchemaVersion: 2, version: VERSION, releaseChannel: index < 20 ? "stable" : "canary",
        status: "success", provider: "openai", model: "openai/gpt", method: "eesv",
        durationMs: 1_000, avgLatency: 500, verificationScore: 95,
        initialVerificationScore: 90, remainingVerificationGaps: 0,
        totalCalls: 1, totalInput: 1_000, totalOutput: 100,
        providerRoutes: [{ stage: "synthesize", provider: "openai", model: "gpt", calls: 1, successes: 1, avgLatencyMs: 500, inputTokens: 1_000, outputTokens: 100, qualityScore: 90, qualityBasis: "pre-repair-verification" }],
      }, svc);
    }
    const entries = cache.readMetricsLog();
    const damage = entries.map(entry => ({ runId: entry.runId, damageScore: 0 }));
    const fp = metricsReport.writeMetricsDashboard(entries, damage);
    const html = fs.readFileSync(fp!, "utf8");
    expect(html).toContain("100/100");
    expect(html).toContain("PROMOTE");
    expect(html).toContain("Stage provider/model comparison");
    expect(html).toContain("openai/gpt");
    expect(html).toContain("Runs (total/applied)");
    expect(html).toContain("20/20");
    expect(metricsReport.buildMetricsReport(entries, damage)).toContain("stable total/applied=20/20 · canary total/applied=20/20");
  });

  it("caps provider cache hit rate when cacheRead exceeds uncached input", () => {
    const svc = services.createServices();
    cache.recordMetric({
      phase: "batch",
      model: "claude",
      provider: "anthropic",
      inputTokens: 21,
      outputTokens: 100,
      cacheHitTokens: 120248,
      cacheWriteTokens: 0,
      latencyMs: 10,
      success: true,
    }, svc);
    const summary = cache.getMetricsSummary(svc);
    expect(summary.cacheHitRate).toBeGreaterThan(0.99);
    expect(summary.cacheHitRate).toBeLessThanOrEqual(1);
    expect(cache.effectivePromptInputTokens(summary.totalInput, summary.totalCacheHit, summary.totalCacheWrite)).toBe(120269);
  });

  it("counts cache reads and writes even when uncached input is larger", () => {
    const svc = services.createServices();
    cache.recordMetric({
      phase: "batch", model: "claude", provider: "anthropic",
      inputTokens: 60_000, outputTokens: 100,
      cacheHitTokens: 40_000, cacheWriteTokens: 10_000,
      latencyMs: 10, success: true,
    }, svc);
    const summary = cache.getMetricsSummary(svc);
    expect(summary.totalCacheWrite).toBe(10_000);
    expect(cache.effectivePromptInputTokens(summary.totalInput, summary.totalCacheHit, summary.totalCacheWrite)).toBe(110_000);
    expect(summary.cacheHitRate).toBeCloseTo(40_000 / 110_000);
  });

  it("skips corrupt jsonl rows instead of dropping all metrics", () => {
    const svc = services.createServices();
    cache.appendMetricsLog("s1", { profile: "balanced", provider: "openai", status: "success" }, svc);
    const logPath = path.join(home, ".pi", "agent", ".cache", "compact-metrics.jsonl");
    fs.appendFileSync(logPath, "{not-json}\n");
    cache.appendMetricsLog("s2", { profile: "aggressive", provider: "anthropic", status: "error" }, svc);
    const entries = cache.readMetricsLog();
    expect(entries.map(e => e.sessionId)).toEqual(["s1", "s2"]);
  });

  it("escapes dashboard table values", () => {
    cache.appendMetricsLog("s1", { profile: "<script>alert(1)</script>", provider: "openai", status: "success" }, services.createServices());
    const fp = metricsReport.writeMetricsDashboard(cache.readMetricsLog());
    const html = fs.readFileSync(fp!, "utf8");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
