import { describe, expect, it } from "bun:test";
import {
  assessCanary, buildPrivacySafeTelemetry, classifyTelemetryFailure, formatPrivacySafeTelemetry,
} from "../src/domain/telemetry.ts";
import type { CompactMetricsEntry } from "../src/types.ts";

function metric(
  channel: "stable" | "canary",
  patch: Partial<CompactMetricsEntry> = {},
): CompactMetricsEntry {
  return {
    ts: new Date().toISOString(), sessionId: "private-session", metricsSchemaVersion: 2,
    version: "8.0.0", releaseChannel: channel,
    totalCalls: 1, totalInput: 2_000, totalOutput: 500, totalCacheHit: 0,
    avgLatency: 1_000, cacheHitRate: 0, status: "success",
    verificationScore: 95, method: "eesv", provider: "p", model: "p/m",
    ...patch,
  };
}

describe("privacy-safe canary telemetry", () => {
  it("classifies failures without persisting error text", () => {
    expect(classifyTelemetryFailure(Object.assign(new Error("Too many requests"), { status: 429 }))).toBe("rate-limit");
    expect(classifyTelemetryFailure(new Error("API key is invalid"))).toBe("authentication");
    expect(classifyTelemetryFailure(Object.assign(new Error("aborted"), { name: "AbortError" }), true)).toBe("timeout");
    expect(classifyTelemetryFailure(new Error("LLM call budget exhausted"))).toBe("budget");
    expect(classifyTelemetryFailure(new Error("maximum output length limit"))).toBe("output-limit");
    expect(classifyTelemetryFailure(new Error("native compaction write failed"))).toBe("persistence");
    expect(classifyTelemetryFailure(new Error("provider stream failed"))).toBe("provider");
    expect(classifyTelemetryFailure(new Error("unexpected invariant"))).toBe("internal");
  });

  it("holds a canary until the sample floor is met", () => {
    const report = assessCanary([
      ...Array.from({ length: 20 }, () => metric("stable")),
      ...Array.from({ length: 4 }, () => metric("canary")),
    ], [], { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.decision).toBe("hold");
    expect(report.reasons[0]).toContain("more canary runs");
  });

  it("promotes only when baseline, sample, and quality gates pass", () => {
    const report = assessCanary([
      ...Array.from({ length: 20 }, () => metric("stable")),
      ...Array.from({ length: 20 }, () => metric("canary")),
    ], [], { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.decision).toBe("promote");
    expect(report.triggers).toEqual([]);
    expect(report.dataConfidence).toBe(100);
  });

  it("rolls back early on measurable regressions", () => {
    const baseline = Array.from({ length: 20 }, () => metric("stable"));
    const canary = Array.from({ length: 20 }, (_, index) => metric("canary", {
      status: index < 10 ? "failure" : "success",
      verificationScore: 75,
      avgLatency: 2_000,
      totalInput: 4_000,
      totalOutput: 1_000,
      method: "heuristic",
      failureKind: index < 10 ? "provider" : undefined,
    }));
    const damage = Array.from({ length: 5 }, () => ({ version: "8.0.0", releaseChannel: "canary" as const, damageScore: 25 }));
    const report = assessCanary([...baseline, ...canary], damage, { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.decision).toBe("rollback");
    expect(report.triggers.map(trigger => trigger.metric)).toEqual(expect.arrayContaining([
      "failure-rate", "quality", "latency", "tokens", "fallback", "damage",
    ]));
  });

  it("exports aggregates without session, project, prompt, path, or error text", () => {
    const report = buildPrivacySafeTelemetry([
      metric("stable", { failureKind: "authentication", status: "failure" }),
      metric("canary"),
    ], [], { version: "8.0.0", minCanaryRuns: 5 });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("private-session");
    expect(serialized).not.toContain("projectId");
    expect(report.aggregates[0].model).toBe("m");
    expect(report.failures.authentication).toBe(1);
    expect(report.privacy).toContain("aggregate-only");
    expect(formatPrivacySafeTelemetry(report)).toContain("# Smart Compact Telemetry");
  });
});
