import { describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
  });

  it("writes a local html dashboard", () => {
    cache.appendMetricsLog("s1", { profile: "balanced", provider: "openai", status: "success", durationMs: 1000 }, services.createServices());
    const fp = metricsReport.writeMetricsDashboard(cache.readMetricsLog());
    expect(fp).toBeTruthy();
    expect(fs.existsSync(fp!)).toBe(true);
    expect(fs.readFileSync(fp!, "utf8")).toContain("Smart Compact Metrics");
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
      latencyMs: 10,
      success: true,
    }, svc);
    const summary = cache.getMetricsSummary(svc);
    expect(summary.cacheHitRate).toBeGreaterThan(0.99);
    expect(summary.cacheHitRate).toBeLessThanOrEqual(1);
    expect(cache.effectivePromptInputTokens(summary.totalInput, summary.totalCacheHit)).toBe(120269);
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
