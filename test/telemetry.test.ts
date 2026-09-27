import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  assessCanary, buildPreparationStats, buildPrivacySafeTelemetry, buildQualityProvenanceStats,
  classifyTelemetryFailure, formatPrivacySafeTelemetry,
} from "../src/domain/telemetry.ts";
import type { CompactMetricsEntry } from "../src/types.ts";
import { ModelCapacityError } from "../src/domain/model-capacity.ts";

function metric(
  channel: "stable" | "canary",
  patch: Partial<CompactMetricsEntry> = {},
): CompactMetricsEntry {
  return {
    ts: new Date().toISOString(), runId: "run-" + randomUUID(), sessionId: "private-session", metricsSchemaVersion: 2,
    version: "8.0.0", releaseChannel: channel,
    totalCalls: 1, totalInput: 2_000, totalOutput: 500, totalCacheHit: 0,
    avgLatency: 1_000, cacheHitRate: 0, status: "success",
    verificationScore: 95, method: "eesv", provider: "p", model: "p/m",
    ...patch,
  };
}

function observed(entries: readonly CompactMetricsEntry[], damageScore = 0) {
  return entries
    .filter(entry => entry.status === "success" && entry.runId)
    .map(entry => ({ runId: entry.runId, damageScore }));
}

describe("privacy-safe canary telemetry", () => {
  it("classifies failures without persisting error text", () => {
    expect(classifyTelemetryFailure(Object.assign(new Error("Too many requests"), { status: 429 }))).toBe("rate-limit");
    expect(classifyTelemetryFailure(new Error("API key is invalid"))).toBe("authentication");
    expect(classifyTelemetryFailure(Object.assign(new Error("aborted"), { name: "AbortError" }), true)).toBe("timeout");
    expect(classifyTelemetryFailure(new Error("LLM call budget exhausted"))).toBe("budget");
    expect(classifyTelemetryFailure(new ModelCapacityError("batch", "request exceeds the selected model window"))).toBe("budget");
    expect(classifyTelemetryFailure(new Error("maximum output length limit"))).toBe("output-limit");
    expect(
      classifyTelemetryFailure(
        Object.assign(
          new Error("Malformed batch summary response: non-terminal stop reason length"),
          { name: "BatchSummaryFormatError" },
        ),
      ),
    ).toBe("output-limit");
    expect(classifyTelemetryFailure(new Error("native compaction write failed"))).toBe("persistence");
    expect(classifyTelemetryFailure(new Error("provider stream failed"))).toBe("provider");
    expect(classifyTelemetryFailure(Object.assign(new Error("Verification gate rejected summary"), { name: "VerificationGateError" }))).toBe("verification");
    expect(classifyTelemetryFailure(Object.assign(new Error("estimate miss"), { name: "YieldGateError" }))).toBe("yield");
    expect(classifyTelemetryFailure(new Error("unexpected invariant"))).toBe("internal");
  });

  it("bounds cyclic causes and distinguishes output watchdogs from timeouts", () => {
    const first = new Error("provider request failed");
    const second = Object.assign(new Error("unauthorized"), { status: 401, cause: first });
    first.cause = second;
    expect(classifyTelemetryFailure(first)).toBe("authentication");
    expect(classifyTelemetryFailure(new Error("Codex visible-output watchdog stopped generation"))).toBe("output-limit");
    expect(classifyTelemetryFailure(new Error("Codex visible-output watchdog stopped generation"), true)).toBe("timeout");
  });

  it("holds a canary until the sample floor is met", () => {
    const report = assessCanary([
      ...Array.from({ length: 20 }, () => metric("stable")),
      ...Array.from({ length: 4 }, () => metric("canary")),
    ], [], { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.decision).toBe("hold");
    expect(report.reasons[0]).toContain("more canary runs");
  });

  it("holds when 19 dry-runs and one applied success only mimic a full canary sample", () => {
    const baseline = Array.from({ length: 20 }, () => metric("stable"));
    const canary = [
      ...Array.from({ length: 19 }, () => metric("canary", { status: "dry-run" })),
      metric("canary"),
    ];
    const report = assessCanary([...baseline, ...canary], observed([...baseline, ...canary]), {
      version: "8.0.0", minCanaryRuns: 20,
    });
    expect(report.canary.runs).toBe(20);
    expect(report.canary.appliedRuns).toBe(1);
    expect(report.decision).toBe("hold");
    expect(report.reasons[0]).toContain("19 more canary runs with host-applied outcomes");
    expect(report.dataConfidence).toBeLessThan(60);
  });

  it("promotes only when baseline, sample, quality, and damage-observation gates pass", () => {
    const entries = [
      ...Array.from({ length: 20 }, () => metric("stable")),
      ...Array.from({ length: 20 }, () => metric("canary")),
    ];
    const report = assessCanary(entries, observed(entries), { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.decision).toBe("promote");
    expect(report.canary.appliedRuns).toBe(20);
    expect(report.triggers).toEqual([]);
    expect(report.dataConfidence).toBe(100);
  });

  it("never promotes an absolutely low-quality canary even when baseline is equally bad", () => {
    const entries = [
      ...Array.from({ length: 20 }, () => metric("stable", { verificationScore: 0 })),
      ...Array.from({ length: 20 }, () => metric("canary", { verificationScore: 0 })),
    ];
    const report = assessCanary(entries, [], { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.decision).toBe("rollback");
    expect(report.triggers).toContainEqual(expect.objectContaining({ metric: "quality", threshold: "<85 absolute" }));
  });

  it("accepts the exact 95% success boundary", () => {
    const entries = [
      ...Array.from({ length: 21 }, (_, index) => metric("stable", { status: index === 0 ? "error" : "success" })),
      ...Array.from({ length: 21 }, (_, index) => metric("canary", { status: index === 0 ? "error" : "success" })),
    ];
    expect(assessCanary(entries, observed(entries), { version: "8.0.0", minCanaryRuns: 20 }).decision).toBe("promote");
  });

  it("never promotes a canary below the absolute 95% success floor", () => {
    const entries = [
      ...Array.from({ length: 20 }, (_, index) => metric("stable", { status: index < 2 ? "error" : "success" })),
      ...Array.from({ length: 20 }, (_, index) => metric("canary", { status: index < 2 ? "error" : "success" })),
    ];
    const report = assessCanary(entries, [], { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.decision).toBe("rollback");
    expect(report.triggers).toContainEqual(expect.objectContaining({ metric: "failure-rate", threshold: ">5% absolute" }));
  });

  it("does not let dry-runs satisfy the early rollback sample floor", () => {
    const entries = [
      ...Array.from({ length: 20 }, () => metric("stable")),
      ...Array.from({ length: 19 }, () => metric("canary", { status: "dry-run" })),
      metric("canary", { status: "error", verificationScore: 0 }),
    ];
    const report = assessCanary(entries, observed(entries), { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.canary.runs).toBe(20);
    expect(report.canary.appliedRuns).toBe(0);
    expect(report.decision).toBe("hold");
  });

  it("rolls back early with three real non-dry outcomes", () => {
    const entries = [
      ...Array.from({ length: 20 }, () => metric("stable")),
      ...Array.from({ length: 3 }, () => metric("canary", { status: "error", verificationScore: 0 })),
    ];
    const report = assessCanary(entries, [], { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.canary.attemptedRuns).toBe(3);
    expect(report.decision).toBe("rollback");
  });

  it("keeps failed non-dry runs in latency, token, and fallback evidence", () => {
    const entries = [
      ...Array.from({ length: 20 }, () => metric("stable")),
      metric("canary", { avgLatency: 1_000, totalInput: 1_000, totalOutput: 0 }),
      metric("canary", { status: "error", avgLatency: 9_000, totalInput: 9_000, totalOutput: 0, method: "heuristic" }),
    ];
    const report = assessCanary(entries, observed(entries), { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.canary.p95LatencyMs).toBe(9_000);
    expect(report.canary.avgTokens).toBe(5_000);
    expect(report.canary.fallbackRate).toBe(0.5);
  });

  it("rolls back early on measurable regressions", () => {
    const baseline = Array.from({ length: 20 }, () => metric("stable"));
    const canary = Array.from({ length: 20 }, (_, index) => metric("canary", {
      status: index < 10 ? "error" : "success",
      verificationScore: 75,
      avgLatency: 2_000,
      totalInput: 4_000,
      totalOutput: 1_000,
      method: "heuristic",
      failureKind: index < 10 ? "provider" : undefined,
    }));
    const applied = [...baseline, ...canary].filter(entry => entry.status === "success");
    const damage = applied.map((entry, index) => ({
      runId: entry.runId,
      damageScore: entry.releaseChannel === "canary" && index >= baseline.length && index < baseline.length + 5 ? 25 : 0,
    }));
    const report = assessCanary([...baseline, ...canary], damage, { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.decision).toBe("rollback");
    expect(report.triggers.map(trigger => trigger.metric)).toEqual(expect.arrayContaining([
      "failure-rate", "quality", "latency", "tokens", "fallback", "damage",
    ]));
  });

  it("holds when post-compaction damage observations are not sufficiently covered", () => {
    const entries = [
      ...Array.from({ length: 20 }, () => metric("stable")),
      ...Array.from({ length: 20 }, () => metric("canary")),
    ];
    const halfObserved = [
      ...observed(entries.filter(entry => entry.releaseChannel === "stable")).slice(0, 10),
      ...observed(entries.filter(entry => entry.releaseChannel === "canary")).slice(0, 10),
    ];
    const report = assessCanary(entries, halfObserved, { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.decision).toBe("hold");
    expect(report.canary.damageCoverage).toBe(0.5);
    expect(report.reasons.join(" ")).toContain("damage-observation coverage");

    const missingIds = entries.map((entry, index) => index % 2 ? entry : { ...entry, runId: undefined });
    const uncorrelatable = assessCanary(missingIds, observed(missingIds), { version: "8.0.0", minCanaryRuns: 20 });
    expect(uncorrelatable.canary.damageCoverage).toBe(0.5);
    expect(uncorrelatable.decision).toBe("hold");
  });

  it("joins damage by runId and deduplicates multiple observations", () => {
    const entries = [
      ...Array.from({ length: 20 }, () => metric("stable")),
      ...Array.from({ length: 20 }, () => metric("canary")),
    ];
    const observations = observed(entries);
    const canaryRun = entries.find(entry => entry.releaseChannel === "canary")!.runId!;
    observations.push({ runId: canaryRun, damageScore: 10 });
    observations.push({ runId: canaryRun, damageScore: 25 });
    observations.push({ runId: "run-unrelated", damageScore: 100 });
    const report = assessCanary(entries, observations, { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.canary.damageCoverage).toBe(1);
    expect(report.canary.damageRate).toBe(0.05);
    expect(report.decision).toBe("promote");
  });

  it("counts only host-applied runs: a voluntary user cancellation pads neither sample nor failures", () => {
    const entries = [
      ...Array.from({ length: 20 }, () => metric("stable")),
      ...Array.from({ length: 19 }, () => metric("canary")),
      metric("canary", { status: "cancelled", failureKind: "cancelled" }),
    ];
    const report = assessCanary(entries, observed(entries), { version: "8.0.0", minCanaryRuns: 20 });
    // 19 successes + 1 user cancel must not read as 20 applied runs.
    expect(report.canary.appliedRuns).toBe(19);
    expect(report.canary.attemptedRuns).toBe(19);
    expect(report.canary.successRate).toBe(1);
    expect(report.decision).toBe("hold");
    expect(report.reasons[0]).toContain("1 more canary run");
  });

  it("never silently counts an entry without an explicit release channel as stable", () => {
    const entries = [
      ...Array.from({ length: 20 }, () => metric("stable")),
      ...Array.from({ length: 20 }, () => metric("canary")),
      ...Array.from({ length: 3 }, () => metric("stable", { releaseChannel: undefined })),
    ];
    const report = assessCanary(entries, observed(entries), { version: "8.0.0", minCanaryRuns: 20 });
    // The 3 unattributed rows (e.g. a native entry that lost its channel) are
    // excluded from the stable cohort, and the report says so.
    expect(report.baseline.runs).toBe(20);
    expect(report.decision).toBe("promote");
    expect(report.reasons).toContainEqual(
      "3 schema-v2 run(s) without an explicit release channel were excluded from both cohorts",
    );
    const exported = buildPrivacySafeTelemetry(entries, [], { version: "8.0.0", minCanaryRuns: 20 });
    expect(exported.aggregates.find(aggregate => aggregate.channel === "unknown")?.runs).toBe(3);
  });

  it("holds when data confidence is 82 even with every other gate passing", () => {
    const canary = Array.from({ length: 20 }, (_, index) => metric("canary", {
      verificationScore: index < 14 ? 95 : undefined,
    }));
    const entries = [
      ...Array.from({ length: 40 }, () => metric("stable")),
      ...canary,
    ];
    // 14 of 20 canary successes observed: exactly 70% correlated coverage.
    const damage = [
      ...observed(entries.filter(entry => entry.releaseChannel === "stable")).slice(0, 28),
      ...observed(canary).slice(0, 14),
    ];
    const report = assessCanary(entries, damage, { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.canary.qualityCoverage).toBe(0.7);
    expect(report.canary.damageCoverage).toBe(0.7);
    expect(report.dataConfidence).toBe(82);
    expect(report.decision).toBe("hold");
    expect(report.reasons).toContainEqual(
      "data confidence 82% is below the agreed 85% promotion floor",
    );
  });

  it("holds when the stable baseline has zero verifier-quality coverage", () => {
    const entries = [
      ...Array.from({ length: 20 }, () => metric("stable", { verificationScore: undefined })),
      ...Array.from({ length: 20 }, () => metric("canary")),
    ];
    const report = assessCanary(entries, observed(entries), { version: "8.0.0", minCanaryRuns: 20 });
    expect(report.baseline.qualityCoverage).toBe(0);
    expect(report.decision).toBe("hold");
    expect(report.reasons).toContainEqual("stable baseline quality coverage is below 70%");
  });

  it("aggregates preparation policy outcomes content-free and counts discarded cost once", () => {
    const entries = [
      metric("canary", { preparation: "background", preparationReadyMs: 8_000, preparationWaitMs: 2_000 }),
      metric("canary", { preparation: "background", preparationReadyMs: 12_000, preparationWaitMs: 6_000 }),
      metric("canary", {
        preparation: "background", status: "discarded", preparationDiscardReason: "ttl",
        totalInput: 900, totalCacheHit: 100, totalCacheWrite: 50, totalOutput: 200,
      }),
      metric("canary", {
        preparation: "background", status: "discarded", preparationDiscardReason: "branch",
        totalInput: 400, totalCacheHit: 0, totalOutput: 100,
      }),
      metric("canary", { preparation: "background", status: "timeout", failureKind: "timeout" }),
      metric("stable"),
    ];
    const prep = buildPreparationStats(entries);
    expect(prep.preparedRuns).toBe(5);
    expect(prep.usedRuns).toBe(2);
    expect(prep.discardedRuns).toBe(2);
    expect(prep.otherOutcomes).toBe(1);
    expect(prep.discardReasons).toEqual({ ttl: 1, branch: 1 });
    expect(prep.reuseRate).toBe(0.5);
    expect(prep.medianReadyMs).toBe(10_000);
    expect(prep.medianWaitMs).toBe(4_000);
    expect(prep.discardedCost).toEqual({
      calls: 2, inputTokens: 1_300, cacheReadTokens: 100, cacheWriteTokens: 50, outputTokens: 300,
    });
    // Discards never pad the applied cohort.
    const assessment = assessCanary(entries, [], { version: "8.0.0", minCanaryRuns: 5 });
    expect(assessment.canary.runs).toBe(5);
    expect(assessment.canary.appliedRuns).toBe(2);
    expect(assessment.canary.attemptedRuns).toBe(3);
  });

  it("surfaces existing verification-provenance fields in aggregates", () => {
    const provenance = buildQualityProvenanceStats([
      metric("stable", { verificationScore: 95, initialVerificationScore: 80, deterministicPatchCount: 2, llmPatched: true }),
      metric("stable", { verificationScore: 90, initialVerificationScore: 90, qualityFloorUsed: true }),
    ]);
    expect(provenance.measuredRuns).toBe(2);
    expect(provenance.avgInitialQuality).toBe(85);
    expect(provenance.avgRepairGain).toBe(7.5);
    expect(provenance.deterministicPatchRuns).toBe(1);
    expect(provenance.llmPatchRuns).toBe(1);
    expect(provenance.qualityFloorRuns).toBe(1);
  });

  it("exports aggregates without session, project, prompt, path, or error text", () => {
    const report = buildPrivacySafeTelemetry([
      metric("stable", { failureKind: "authentication", status: "error" }),
      metric("canary", { estimatedAfterTokens: 600, estimatedSavedTokens: 400, relaxedSoftBoundaries: ["anchor"] }),
    ], [], { version: "8.0.0", minCanaryRuns: 5 });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("private-session");
    expect(serialized).not.toContain("run-");
    expect(serialized).not.toContain("projectId");
    expect(serialized).not.toContain("estimatedAfterTokens");
    expect(serialized).not.toContain("relaxedSoftBoundaries");
    expect(report.aggregates[0].model).toBe("m");
    expect(report.failures.authentication).toBe(1);
    expect(report.privacy).toContain("aggregate-only");
    expect(formatPrivacySafeTelemetry(report)).toContain("# Smart Compact Telemetry");
  });
});
