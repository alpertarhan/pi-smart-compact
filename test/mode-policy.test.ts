import { describe, expect, it } from "bun:test";
import { batchOutputLimit, deterministicExtractionConfidence, MODE_POLICIES, resolveMode } from "../src/app/mode-policy.ts";
import type { StructuredExtraction } from "../src/types.ts";

const extraction = (partial: Partial<StructuredExtraction> = {}): StructuredExtraction => ({
  modifiedFiles: [], readFiles: [], deletedFiles: [], errors: [], decisions: [], constraints: [], topics: [], timeline: [],
  mainGoal: "goal", lastUserMessages: [], lastErrors: [], messageCount: 10, ...partial,
});

describe("compaction mode policy", () => {
  it("uses pressure first and deterministic risk second in auto mode", () => {
    expect(resolveMode("auto", 90, extraction())).toBe("aggressive");
    expect(resolveMode("auto", 65, extraction())).toBe("fast");
    expect(resolveMode("auto", 75, extraction({
      errors: Array.from({ length: 3 }, (_, index) => ({ index, tool: "bash", message: "failed", retryAttempted: false, resolved: false })),
      decisions: Array.from({ length: 6 }, (_, index) => ({ index, type: "explicit" as const, summary: "d" + index })),
    }))).toBe("thorough");
  });

  it("escalates auto mode when prior damage or continuity adds risk", () => {
    expect(resolveMode("auto", 65, extraction(), 12)).toBe("thorough");
  });

  it("scores deterministic extraction confidence conservatively", () => {
    expect(deterministicExtractionConfidence(extraction({
      modifiedFiles: [{ path: "src/a.ts", operations: ["edit"] }],
      lastUserMessages: ["finish the task"],
    }))).toBeGreaterThanOrEqual(0.85);
    expect(deterministicExtractionConfidence(extraction({
      modifiedFiles: [{ path: "src/a.ts", operations: ["edit"] }],
      lastUserMessages: ["finish"],
      messageCount: 500,
    }))).toBeLessThan(0.85);
    expect(deterministicExtractionConfidence(extraction({
      modifiedFiles: [{ path: "src/a.ts", operations: ["edit"] }],
      lastUserMessages: ["finish"],
      messageCount: 20,
    }), { conversationTokens: 180_000, toolPercent: 85 })).toBeLessThan(0.85);
    expect(deterministicExtractionConfidence(extraction({
      mainGoal: undefined,
      errors: Array.from({ length: 3 }, (_, index) => ({ index, tool: "bash", message: "failed", retryAttempted: false, resolved: false })),
    }))).toBeLessThan(0.5);
  });

  it("keeps explicit modes stable", () => {
    for (const mode of ["fast", "balanced", "aggressive", "thorough"] as const) {
      expect(resolveMode(mode, 99, extraction())).toBe(mode);
    }
  });

  it("gives every preset a finite token and call ceiling", () => {
    for (const policy of Object.values(MODE_POLICIES)) {
      expect(policy.maxLlmCalls).toBeGreaterThan(0);
      expect(policy.maxInputTokens).toBeGreaterThan(0);
      expect(policy.maxOutputTokens).toBeGreaterThan(0);
      expect(policy.targetContextPercent).toBeGreaterThan(0);
    }
  });

  it("bounds batch output by mode and provider", () => {
    expect(batchOutputLimit("fast", 20, 128_000)).toBe(2_400);
    expect(batchOutputLimit("balanced", 2, 128_000)).toBe(1_000);
    expect(batchOutputLimit("thorough", 20, 4_000)).toBe(4_000);
  });
});
