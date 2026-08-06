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
      modifiedFiles: [], readFiles: [], deletedFiles: [],
      unresolvedErrors: [{ id: "error-1", message: "auth test still fails", tool: "bash", files: [] }], resolvedErrors: [],
      openLoops: [{ id: "loop-1", type: "bugfix", priority: "high", status: "open", summary: "fix auth test", files: [] }],
      topics: [], nextActions: [], criticalContext: [], sessionType: "implementation", compactionVersion: "7.22.0", updatedAt: Date.now(),
    };
    previous.scope = { schemaVersion: 2, projectId, sessionId: "session-1", branchHeadId: "entry-1" };
    const extraction: StructuredExtraction = {
      modifiedFiles: [], readFiles: [], deletedFiles: [], errors: [], decisions: [], constraints: [], topics: [], timeline: [],
      mainGoal: null, lastUserMessages: [], lastErrors: [], messageCount: 2,
    };
    const services = createServices();
    const rc: any = {
      extraction, finalSummary: "## Goal\nContinue work\n\n## Next Steps\n1. Continue",
      projectId, continuityScope: previous.scope, previousState: previous,
      llmMessages: [], explorationReport: null, config: { pinPaths: [] }, services,
      estimator: makeTokenEstimator("openai", "test", services.tokenCalibration),
      profile: "balanced", mode: "balanced", method: "eesv", chunkCount: 1, summaries: [],
      toCompact: [{}, {}], convTokens: 1_000, totalTokens: 50_000, accTokens: 10_000,
      backupPath: null, verified: true, verificationGaps: [], verificationScore: 100,
      verificationProvenance: { initialScore: 100, deterministicPatched: [], llmPatched: false, finalScore: 100, remainingGaps: [] },
      explorationRounds: 0, modelLabel: "openai/test", notify: () => {},
    };

    const result = buildState(rc);

    expect(result.finalSummary).toContain("Use JWT");
    expect(result.finalSummary).toContain("No new dependencies");
    expect(result.finalSummary).toContain("auth test still fails");
    expect(result.finalSummary).toContain("fix auth test");
    expect(result.details.mode).toBe("balanced");
  });
});
