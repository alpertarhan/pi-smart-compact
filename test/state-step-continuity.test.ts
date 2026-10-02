import { describe, expect, it } from "bun:test";
import { buildState } from "../src/app/steps/state.ts";
import { assembleFallback } from "../src/phases/synthesize.ts";
import { verifySummary } from "../src/phases/verify.ts";
import { previewMergedContinuity } from "../src/utils/state.ts";
import { createServices } from "../src/infra/services.ts";
import { makeTokenEstimator } from "../src/utils/tokens.ts";
import type { CompactionState, StructuredExtraction } from "../src/types.ts";

describe("buildState continuity integration", () => {
  it("injects prior unresolved facts into the final summary and persisted details", () => {
    const projectId =
      "continuity-step-" +
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2);
    const previous: CompactionState = {
      goal: "Ship auth",
      decisions: [{ id: "decision-1", summary: "Use JWT", type: "explicit" }],
      constraints: [
        {
          id: "constraint-1",
          text: "No new dependencies",
          category: "prohibition",
          confidence: 1,
        },
      ],
      modifiedFiles: [],
      readFiles: [],
      deletedFiles: ["package.json", "missing-v807-file.ts"],
      unresolvedErrors: [
        {
          id: "error-1",
          message: "auth test still fails",
          tool: "bash",
          files: [],
        },
      ],
      resolvedErrors: [
        {
          id: "error-2",
          message: "legacy migration test failed",
          tool: "bash",
        },
      ],
      openLoops: [
        {
          id: "loop-1",
          type: "bugfix",
          priority: "high",
          status: "open",
          summary: "fix auth test",
          files: [],
        },
      ],
      topics: [],
      nextActions: [],
      criticalContext: [],
      sessionType: "implementation",
      compactionVersion: "7.22.0",
      updatedAt: Date.now(),
    };
    previous.scope = {
      schemaVersion: 2,
      projectId,
      sessionId: "session-1",
      branchHeadId: "entry-1",
    };
    const extraction: StructuredExtraction = {
      modifiedFiles: [],
      readFiles: [],
      deletedFiles: [],
      errors: [],
      decisions: [],
      constraints: [],
      topics: [],
      timeline: [],
      mainGoal: "Ship auth",
      lastUserMessages: [],
      lastErrors: [],
      messageCount: 2,
    };
    const services = createServices();
    const rc: any = {
      ctx: { cwd: process.cwd() },
      extraction,
      finalSummary: "## Goal\nShip auth safely\n\n## Next Steps\n1. Continue",
      projectId,
      continuityScope: previous.scope,
      previousState: previous,
      factOverrides: [],
      llmMessages: [],
      explorationReport: null,
      config: { pinPaths: [] },
      services,
      estimator: makeTokenEstimator(
        "openai",
        "test",
        services.tokenCalibration,
      ),
      profile: "balanced",
      mode: "balanced",
      method: "eesv",
      chunkCount: 1,
      summaries: [],
      toCompact: [{}, {}],
      convTokens: 1_000,
      totalTokens: 50_000,
      compactTokens: 20_000,
      accTokens: 10_000,
      compactionPlan: {
        keepFrom: 2,
        compactTokens: 20_000,
        retainedTokens: 10_000,
        projectedAfterTokens: 40_000,
        projectedSavedTokens: 10_000,
        projectedYield: 0.2,
        fixedContextTokens: 20_000,
        retentionTargetTokens: 10_000,
        summaryBudgetTokens: 10_000,
        targetAfterTokens: 40_000,
        hardBoundaryAdjusted: false,
        viable: true,
        reason: "viable",
        relaxedSoftBoundaries: [],
      },
      backupPath: null,
      verified: true,
      verificationGaps: [],
      verificationScore: 100,
      verificationProvenance: {
        initialScore: 100,
        deterministicPatched: [],
        llmPatched: false,
        finalScore: 100,
        remainingGaps: [],
      },
      explorationRounds: 0,
      modelLabel: "openai/test",
      notify: () => {},
      _prepared: true,
      _windowed: true,
      _recovered: true,
      _tiered: true,
      _extracted: true,
      _synthesized: true,
      _verified: true,
    };

    const result = buildState(rc);

    expect(result.finalSummary).toContain("Use JWT");
    expect(result.finalSummary).toContain("No new dependencies");
    expect(result.finalSummary).toContain("auth test still fails");
    expect(result.finalSummary).toContain(
      "Resolved error: legacy migration test failed",
    );
    expect(result.finalSummary).toContain("fix auth test");
    expect(result.finalSummary).not.toContain("Goal shifted");
    expect(result.details.mode).toBe("balanced");
    expect(result.compactionState.goal).toBe("Ship auth safely");
    expect(result.compactionState.deletedFiles).not.toContain("package.json");
    expect(result.compactionState.deletedFiles).toContain(
      "missing-v807-file.ts",
    );
    expect(result.tokensSaved).toBeGreaterThan(10_000);
    expect(result.tokensSaved).toBeLessThan(20_000);
  });

  it("rejects gaps introduced by merged continuity before state can be applied", () => {
    const projectId =
      "continuity-conflict-" + Math.random().toString(36).slice(2);
    const previous: CompactionState = {
      goal: "Release",
      decisions: [],
      constraints: [
        {
          id: "old",
          text: "Do not publish stable",
          category: "prohibition",
          confidence: 1,
        },
      ],
      modifiedFiles: [],
      readFiles: [],
      deletedFiles: [],
      unresolvedErrors: [],
      resolvedErrors: [],
      openLoops: [],
      topics: [],
      nextActions: [],
      criticalContext: [],
      sessionType: "implementation",
      compactionVersion: "8.0.0-rc.3",
    };
    const extraction: StructuredExtraction = {
      modifiedFiles: [],
      readFiles: [],
      deletedFiles: [],
      errors: [],
      decisions: [],
      constraints: [
        {
          index: 1,
          text: "Must publish stable now",
          category: "requirement",
          confidence: 1,
        },
      ],
      topics: [],
      timeline: [],
      mainGoal: "Release",
      lastUserMessages: [],
      lastErrors: [],
      messageCount: 2,
    };
    const services = createServices();
    try {
      buildState({
        extraction,
        finalSummary:
          "## Goal\nRelease\n## Constraints & Preferences\n- Must publish stable now\n## Progress\n- working\n## Critical Context\n- none",
        projectId,
        continuityScope: {
          schemaVersion: 2,
          projectId,
          sessionId: "s",
          branchHeadId: "b",
        },
        previousState: previous,
        factOverrides: [],
        llmMessages: [],
        explorationReport: null,
        config: { pinPaths: [] },
        services,
        estimator: makeTokenEstimator(
          "openai",
          "test",
          services.tokenCalibration,
        ),
        profile: "balanced",
        mode: "balanced",
        method: "eesv",
        chunkCount: 1,
        summaries: [],
        toCompact: [{}, {}],
        convTokens: 1_000,
        totalTokens: 50_000,
        compactTokens: 20_000,
        accTokens: 10_000,
        compactionPlan: {
          keepFrom: 2,
          compactTokens: 20_000,
          retainedTokens: 10_000,
          projectedAfterTokens: 40_000,
          projectedSavedTokens: 10_000,
          projectedYield: 0.2,
          fixedContextTokens: 20_000,
          retentionTargetTokens: 10_000,
          summaryBudgetTokens: 10_000,
          targetAfterTokens: 40_000,
          hardBoundaryAdjusted: false,
          viable: true,
          reason: "viable",
          relaxedSoftBoundaries: [],
        },
        backupPath: null,
        verified: true,
        verificationGaps: [],
        verificationScore: 100,
        verificationProvenance: {
          initialScore: 100,
          deterministicPatched: [],
          llmPatched: false,
          finalScore: 100,
          remainingGaps: [],
        },
        explorationRounds: 0,
        modelLabel: "openai/test",
        notify: () => {},
      } as any);
      throw new Error("expected VerificationGateError");
    } catch (error) {
      expect(error).toMatchObject({
        name: "VerificationGateError",
        stage: "post-state",
      });
    }
  });

  it("passes the post-state gate when the merge cap drops a superseded variant the previous snapshot carried", () => {
    // Recorded shape (agent-mesh session, 10.1.2): the previous snapshot held
    // an older variant of a constraint, the current window held it extended
    // with a trailing "`lucky-phoenix` not active". Both were required at the
    // post-synthesis gate (continuity = previous snapshot), so the floor
    // rendered both. The state merge keeps current facts first and caps
    // constraints at 30, dropping the older variant; at the post-state gate it
    // was no longer required, so the extended rule's negated anchor read the
    // older line as a summary-authored contradiction (80/100, not repairable).
    // Every stage now verifies against the merged-continuity preview.
    const projectId = "continuity-cap-" + Math.random().toString(36).slice(2);
    const older =
      "**Ownership:** `lucky-phoenix` writes production code/tests/docs; assistant session `silent-raven` independently reviews/tests. Avoid parallel writes to repository files.";
    const extended = older + " Currently `tidal-dragon` is the sole live writer; `lucky-phoenix` not active.";
    const previous: CompactionState = {
      goal: "Ship agent-mesh 0.4",
      decisions: [],
      constraints: [
        ...Array.from({ length: 29 }, (_, i) => ({
          id: "prev-" + i,
          text: "Keep previous rule " + i + " about module " + i + " intact.",
          category: "requirement" as const,
          confidence: 1,
        })),
        { id: "prev-own", text: older, category: "prohibition", confidence: 0.8 },
      ],
      modifiedFiles: [],
      readFiles: [],
      deletedFiles: [],
      unresolvedErrors: [],
      resolvedErrors: [],
      openLoops: [],
      topics: [],
      nextActions: [],
      criticalContext: [],
      sessionType: "implementation",
      compactionVersion: "10.1.2",
      updatedAt: Date.now(),
    };
    const extraction: StructuredExtraction = {
      modifiedFiles: [],
      readFiles: [],
      deletedFiles: [],
      errors: [],
      decisions: [],
      constraints: [
        { index: 1, text: extended, category: "prohibition", confidence: 0.8 },
        ...Array.from({ length: 29 }, (_, i) => ({
          index: i + 2,
          text: "Keep current rule " + i + " about service " + i + " intact.",
          category: "requirement" as const,
          confidence: 1,
        })),
      ],
      topics: [],
      timeline: [],
      mainGoal: "Ship agent-mesh 0.4",
      lastUserMessages: [],
      lastErrors: [],
      messageCount: 2,
    };
    const preview = previewMergedContinuity(extraction, previous, []);
    expect(preview.constraints).toHaveLength(30);
    expect(preview.constraints.some((item) => item.text === older)).toBe(false);
    expect(preview.constraints.some((item) => item.text === extended)).toBe(true);

    const services = createServices();
    const rc = (finalSummary: string): any => ({
      ctx: { cwd: process.cwd() },
      extraction,
      finalSummary,
      projectId,
      continuityScope: { schemaVersion: 2, projectId, sessionId: "s", branchHeadId: "b" },
      previousState: previous,
      verificationContinuity: preview,
      factOverrides: [],
      llmMessages: [],
      explorationReport: null,
      config: { pinPaths: [] },
      services,
      estimator: makeTokenEstimator("openai", "test", services.tokenCalibration),
      profile: "aggressive",
      mode: "fast",
      method: "heuristic",
      chunkCount: 1,
      summaries: [],
      toCompact: [{}, {}],
      convTokens: 1_000,
      totalTokens: 50_000,
      compactTokens: 20_000,
      accTokens: 10_000,
      compactionPlan: {
        keepFrom: 2, compactTokens: 20_000, retainedTokens: 10_000, projectedAfterTokens: 40_000,
        projectedSavedTokens: 10_000, projectedYield: 0.2, fixedContextTokens: 20_000,
        retentionTargetTokens: 10_000, summaryBudgetTokens: 10_000, targetAfterTokens: 40_000,
        hardBoundaryAdjusted: false, viable: true, reason: "viable", relaxedSoftBoundaries: [],
      },
      backupPath: null,
      verified: true,
      verificationGaps: [],
      verificationScore: 100,
      verificationProvenance: { initialScore: 100, deterministicPatched: [], llmPatched: false, finalScore: 100, remainingGaps: [] },
      explorationRounds: 0,
      modelLabel: "openai/test",
      notify: () => {},
      _prepared: true, _windowed: true, _recovered: true, _tiered: true, _extracted: true, _synthesized: true, _verified: true,
    });

    // Old pipeline: floor built against the previous snapshot carries both variants.
    const oldFloor = assembleFallback([], extraction, {}, 10_000, previous, []);
    expect(oldFloor).toContain("- " + older + "\n");
    expect(verifySummary(oldFloor, extraction, previous).ok).toBe(true);
    expect(() => buildState(rc(oldFloor))).toThrow(
      expect.objectContaining({ name: "VerificationGateError", stage: "post-state" }),
    );

    // New pipeline: floor built against the preview carries exactly the merged set.
    const floor = assembleFallback([], extraction, {}, 10_000, preview, []);
    expect(floor).toContain(extended);
    expect(floor).not.toContain("- " + older + "\n");
    expect(verifySummary(floor, extraction, preview).ok).toBe(true);
    const result = buildState(rc(floor));
    expect(result.verified).toBe(true);
    expect(result.verificationScore).toBe(100);
    expect(result.compactionState.constraints.some((item) => item.text === extended)).toBe(true);
  });

  it("rejects an oversized verified final state before details can exist", () => {
    const services = createServices();
    const extraction: StructuredExtraction = {
      modifiedFiles: [],
      readFiles: [],
      deletedFiles: [],
      errors: [],
      decisions: [],
      constraints: [],
      topics: [],
      timeline: [],
      mainGoal: null,
      lastUserMessages: [],
      lastErrors: [],
      messageCount: 2,
    };
    const rc: any = {
      extraction,
      finalSummary:
        "## Goal\nContinue safely\n\n## Progress\n" +
        "oversized-safe-text ".repeat(1_000),
      projectId: "yield-state",
      continuityScope: {
        schemaVersion: 2,
        projectId: "yield-state",
        sessionId: "s",
      },
      previousState: null,
      factOverrides: [],
      llmMessages: [],
      explorationReport: null,
      config: { pinPaths: [] },
      services,
      estimator: makeTokenEstimator(
        "openai",
        "test",
        services.tokenCalibration,
      ),
      profile: "balanced",
      mode: "balanced",
      method: "eesv",
      chunkCount: 1,
      summaries: [],
      toCompact: [{}, {}],
      convTokens: 1_000,
      totalTokens: 1_000,
      compactTokens: 900,
      accTokens: 100,
      compactionPlan: {
        keepFrom: 2,
        compactTokens: 900,
        retainedTokens: 100,
        projectedAfterTokens: 200,
        projectedSavedTokens: 800,
        projectedYield: 0.8,
        fixedContextTokens: 0,
        retentionTargetTokens: 100,
        summaryBudgetTokens: 100,
        targetAfterTokens: 200,
        hardBoundaryAdjusted: true,
        viable: true,
        reason: "viable",
        relaxedSoftBoundaries: ["anchor"],
      },
      backupPath: null,
      verified: true,
      verificationGaps: [],
      verificationScore: 100,
      verificationProvenance: {
        initialScore: 100,
        deterministicPatched: [],
        llmPatched: false,
        finalScore: 100,
        remainingGaps: [],
      },
      explorationRounds: 0,
      modelLabel: "openai/test",
      notify: () => {},
    };

    try {
      buildState(rc);
      throw new Error("expected YieldGateError");
    } catch (error) {
      expect(error).toMatchObject({
        name: "YieldGateError",
        reason: "target-miss",
        plannedAfterTokens: 200,
        retainedTailTokens: 100,
        summaryBudgetTokens: 100,
        targetAfterTokens: 200,
        relaxedSoftBoundaries: ["anchor"],
        hardBoundaryAdjusted: true,
      });
      expect(
        (error as { estimatedAfterTokens: number }).estimatedAfterTokens,
      ).toBeGreaterThan(200);
      expect(JSON.stringify(error)).not.toContain("oversized-safe-text");
      expect(rc.details).toBeUndefined();
      expect(rc.compactionState).toBeUndefined();
      expect(rc.openLoops).toBeUndefined();
    }
  });
});
