import { describe, expect, it } from "bun:test";
import type { CompactMetricsEntry } from "../src/types.ts";
import {
  formatCurrentSession,
  formatMetricRunCompact,
  formatRecentRuns,
  formatRunDetails,
  isDashboardTitleLine,
  metricPct,
} from "../src/ui/dashboard-format.ts";

function entry(overrides: Partial<CompactMetricsEntry> = {}): CompactMetricsEntry {
  return {
    ts: "2026-05-24T10:00:00.000Z",
    sessionId: "s1",
    totalCalls: 2,
    totalInput: 100,
    totalOutput: 20,
    totalCacheHit: 50,
    avgLatency: 1234,
    cacheHitRate: 0.5,
    status: "success",
    profile: "balanced",
    provider: "anthropic",
    method: "eesv",
    tokensSaved: 1000,
    verificationScore: 92,
    verificationGaps: 0,
    ...overrides,
  };
}

describe("dashboard format helpers", () => {
  it("formats missing and legacy metrics without throwing", () => {
    const lines = formatRunDetails(undefined, "Latest run details");
    expect(lines).toContain("No run recorded yet.");

    const legacy = formatRunDetails(entry({ provider: undefined, model: undefined, cacheHitRate: 5726.1 }), "Latest run details");
    expect(legacy.join("\n")).toContain("Provider/model: ? / ?");
    expect(legacy.join("\n")).toContain("provider cache 100%");
  });

  it("keeps dashboard highlighting limited to explicit title lines", () => {
    expect(isDashboardTitleLine("Latest run details")).toBe(true);
    expect(isDashboardTitleLine("Runs in this session:")).toBe(true);
    expect(isDashboardTitleLine("No run recorded yet.")).toBe(false);
    expect(isDashboardTitleLine("Overview report")).toBe(false);
  });

  it("uses compact latest-run menu descriptions", () => {
    const desc = formatMetricRunCompact(entry({ tokensSaved: 123456, verificationScore: 88 }));
    expect(desc).toContain("score 88/100");
    expect(desc).toContain("saved 123,456t");
    expect(desc.length).toBeLessThan(90);
  });

  it("formats session and recent-run empty states", () => {
    expect(formatCurrentSession([], "s1").join("\n")).toContain("No smart-compact metrics recorded");
    expect(formatCurrentSession([entry(), entry({ sessionId: "s2" })], "s1").join("\n")).toContain("Runs: 1");
    expect(formatRecentRuns([]).join("\n")).toContain("No smart-compact metrics recorded");
  });

  it("clamps displayed ratio percentages", () => {
    expect(metricPct(0.42)).toBe("42%");
    expect(metricPct(2.5)).toBe("100%");
    expect(metricPct(-1)).toBe("0%");
    expect(metricPct(undefined)).toBe("—");
  });
});
