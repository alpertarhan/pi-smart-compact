import { describe, expect, it } from "bun:test";
import { buildState } from "../src/app/steps/state.ts";
import { createServices } from "../src/infra/services.ts";
import { makeTokenEstimator } from "../src/utils/tokens.ts";
import type { CompactionState, StructuredExtraction } from "../src/types.ts";

describe("buildState continuity integration", () => {
  it("injects prior unresolved facts into the final summary and persisted details", () => {
    const projectId = "continuity-step-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const previous: CompactionState = {
      goal: "Ship auth", decisions: [{ id: "decision-1", summary: "Use JWT", type: "explicit" }],
      constraints: [{ id: "constraint-1", text: "No new dependencies", category: "prohibition", confidence: 1 }],
      modifiedFiles: [], readFiles: [], deletedFiles: ["package.json", "missing-v807-file.ts"],
      unresolvedErrors: [{ id: "error-1", message: "auth test still fails", tool: "bash", files: [] }],
      resolvedErrors: [{ id: "error-2", message: "legacy migration test failed", tool: "bash", files: [] }],
      openLoops: [{ id: "loop-1", type: "bugfix", priority: "high", status: "open", summary: "fix auth test", files: [] }],
      topics: [], nextActions: [], criticalContext: [], sessionType: "implementation", compactionVersion: "7.22.0", updatedAt: Date.now(),
    };
    previous.scope = { schemaVersion: 2, projectId, sessionId: "session-1", branchHeadId: "entry-1" };
    const extraction: StructuredExtraction = {
      modifiedFiles: [], readFiles: [], deletedFiles: [], errors: [], decisions: [], constraints: [], topics: [], timeline: [],
      mainGoal: "Ship auth", lastUserMessages: [], lastErrors: [], messageCount: 2,
    };
    const services = createServices();
    const rc: any = {
      ctx: { cwd: process.cwd() },
      extraction, finalSummary: "## Goal\nShip auth safely\n\n## Next Steps\n1. Continue",
      projectId, continuityScope: previous.scope, previousState: previous,
      llmMessages: [], explorationReport: null, config: { pinPaths: [] }, services,
      estimator: makeTokenEstimator("openai", "test", services.tokenCalibration),
      profile: "balanced", mode: "balanced", method: "eesv", chunkCount: 1, summaries: [],
      toCompact: [{}, {}], convTokens: 1_000, totalTokens: 50_000, compactTokens: 20_000, accTokens: 10_000,
      compactionPlan: {
        keepFrom: 2, compactTokens: 20_000, retainedTokens: 10_000, projectedAfterTokens: 40_000,
        projectedSavedTokens: 10_000, projectedYield: 0.2, fixedContextTokens: 20_000,
        retentionTargetTokens: 10_000, summaryBudgetTokens: 10_000, targetAfterTokens: 40_000,
        hardBoundaryAdjusted: false, viable: true, reason: "viable", relaxedSoftBoundaries: [],
      },
      backupPath: null, verified: true, verificationGaps: [], verificationScore: 100,
      verificationProvenance: { initialScore: 100, deterministicPatched: [], llmPatched: false, finalScore: 100, remainingGaps: [] },
      explorationRounds: 0, modelLabel: "openai/test", notify: () => {},
    };

    const result = buildState(rc);

    expect(result.finalSummary).toContain("Use JWT");
    expect(result.finalSummary).toContain("No new dependencies");
    expect(result.finalSummary).toContain("auth test still fails");
    expect(result.finalSummary).toContain("Resolved error: legacy migration test failed");
    expect(result.finalSummary).toContain("fix auth test");
    expect(result.finalSummary).not.toContain("Goal shifted");
    expect(result.details.mode).toBe("balanced");
    expect(result.compactionState.goal).toBe("Ship auth safely");
    expect(result.compactionState.deletedFiles).not.toContain("package.json");
    expect(result.compactionState.deletedFiles).toContain("missing-v807-file.ts");
    expect(result.tokensSaved).toBeGreaterThan(10_000);
    expect(result.tokensSaved).toBeLessThan(20_000);
  });

  it("rejects gaps introduced by merged continuity before state can be applied", () => {
    const projectId = "continuity-conflict-" + Math.random().toString(36).slice(2);
    const previous: CompactionState = {
      goal: "Release", decisions: [],
      constraints: [{ id: "old", text: "Do not publish stable", category: "prohibition", confidence: 1 }],
      modifiedFiles: [], readFiles: [], deletedFiles: [], unresolvedErrors: [], resolvedErrors: [], openLoops: [],
      topics: [], nextActions: [], criticalContext: [], sessionType: "implementation", compactionVersion: "8.0.0-rc.3",
    };
    const extraction: StructuredExtraction = {
      modifiedFiles: [], readFiles: [], deletedFiles: [], errors: [], decisions: [],
      constraints: [{ index: 1, text: "Must publish stable now", category: "requirement", confidence: 1 }],
      topics: [], timeline: [], mainGoal: "Release", lastUserMessages: [], lastErrors: [], messageCount: 2,
    };
    const services = createServices();
    expect(() => buildState({
      extraction,
      finalSummary: "## Goal\nRelease\n## Constraints & Preferences\n- Must publish stable now\n## Progress\n- working\n## Critical Context\n- none",
      projectId, continuityScope: { schemaVersion: 2, projectId, sessionId: "s", branchHeadId: "b" }, previousState: previous,
      llmMessages: [], explorationReport: null, config: { pinPaths: [] }, services,
      estimator: makeTokenEstimator("openai", "test", services.tokenCalibration),
      profile: "balanced", mode: "balanced", method: "eesv", chunkCount: 1, summaries: [],
      toCompact: [{}, {}], convTokens: 1_000, totalTokens: 50_000, compactTokens: 20_000, accTokens: 10_000,
      compactionPlan: {
        keepFrom: 2, compactTokens: 20_000, retainedTokens: 10_000, projectedAfterTokens: 40_000,
        projectedSavedTokens: 10_000, projectedYield: 0.2, fixedContextTokens: 20_000,
        retentionTargetTokens: 10_000, summaryBudgetTokens: 10_000, targetAfterTokens: 40_000,
        hardBoundaryAdjusted: false, viable: true, reason: "viable", relaxedSoftBoundaries: [],
      },
      backupPath: null, verified: true, verificationGaps: [], verificationScore: 100,
      verificationProvenance: { initialScore: 100, deterministicPatched: [], llmPatched: false, finalScore: 100, remainingGaps: [] },
      explorationRounds: 0, modelLabel: "openai/test", notify: () => {},
    } as any)).toThrow("Verification gate rejected summary");
  });

  it("rejects an oversized verified final state before details can exist", () => {
    const services = createServices();
    const extraction: StructuredExtraction = {
      modifiedFiles: [], readFiles: [], deletedFiles: [], errors: [], decisions: [], constraints: [], topics: [], timeline: [],
      mainGoal: null, lastUserMessages: [], lastErrors: [], messageCount: 2,
    };
    const rc: any = {
      extraction,
      finalSummary: "## Goal\nContinue safely\n\n## Progress\n" + "oversized-safe-text ".repeat(1_000),
      projectId: "yield-state", continuityScope: { schemaVersion: 2, projectId: "yield-state", sessionId: "s" }, previousState: null,
      llmMessages: [], explorationReport: null, config: { pinPaths: [] }, services,
      estimator: makeTokenEstimator("openai", "test", services.tokenCalibration),
      profile: "balanced", mode: "balanced", method: "eesv", chunkCount: 1, summaries: [],
      toCompact: [{}, {}], convTokens: 1_000, totalTokens: 1_000, compactTokens: 900, accTokens: 100,
      compactionPlan: {
        keepFrom: 2, compactTokens: 900, retainedTokens: 100, projectedAfterTokens: 200,
        projectedSavedTokens: 800, projectedYield: 0.8, fixedContextTokens: 0,
        retentionTargetTokens: 100, summaryBudgetTokens: 100, targetAfterTokens: 200,
        hardBoundaryAdjusted: true, viable: true, reason: "viable", relaxedSoftBoundaries: ["anchor"],
      },
      backupPath: null, verified: true, verificationGaps: [], verificationScore: 100,
      verificationProvenance: { initialScore: 100, deterministicPatched: [], llmPatched: false, finalScore: 100, remainingGaps: [] },
      explorationRounds: 0, modelLabel: "openai/test", notify: () => {},
    };

    try {
      buildState(rc);
      throw new Error("expected YieldGateError");
    } catch (error) {
      expect(error).toMatchObject({
        name: "YieldGateError", reason: "target-miss", plannedAfterTokens: 200,
        retainedTailTokens: 100, summaryBudgetTokens: 100, targetAfterTokens: 200,
        relaxedSoftBoundaries: ["anchor"], hardBoundaryAdjusted: true,
      });
      expect((error as { estimatedAfterTokens: number }).estimatedAfterTokens).toBeGreaterThan(200);
      expect(JSON.stringify(error)).not.toContain("oversized-safe-text");
      expect(rc.details).toBeUndefined();
      expect(rc.compactionState).toBeUndefined();
      expect(rc.openLoops).toBeUndefined();
    }
  });
});
