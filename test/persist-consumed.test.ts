/**
 * C1 regression: durable state (project fingerprint + compaction state) must
 * be persisted only after the host emits the correlated session_compact.
 * session_before_compact stages the payload; persistAppliedState is the shared
 * confirmed-apply commit point for manual, auto, and tool paths.
 */
import { afterAll, describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalHome = process.env.HOME;
let home: string;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-consumed-"));
  process.env.HOME = home;
});
afterAll(async () => {
  const { flushCompactionStateIndexes } = await import("../src/infra/context-graph.ts");
  flushCompactionStateIndexes();
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function minimalExtraction() {
  return {
    modifiedFiles: [{ path: "src/a.ts", toolCalls: 1, lastModifiedIndex: 0 }],
    readFiles: ["src/b.ts"], deletedFiles: [],
    errors: [], decisions: [], constraints: [], topics: [], timeline: [],
    mediaAttachments: [], mainGoal: "test goal", lastUserMessages: [], lastErrors: [],
    messageCount: 3,
  };
}

describe("persistAppliedState", () => {
  it("writes fingerprint + compaction state only when called for an applied payload", async () => {
    const { persistAppliedState } = await import("../src/app/steps/persist.ts");
    const { loadProjectFingerprint } = await import("../src/utils/fingerprint.ts");
    const { loadCompactionState } = await import("../src/utils/state.ts");
    const { VERSION } = await import("../src/constants.ts");

    const projectId = "test-project-consumed";
    persistAppliedState({
      runId: "run-applied-1", summary: "## Goal\nx", firstKeptEntryId: "e1", tokensBefore: 100,
      details: {} as never, sessionId: "s1",
      projectId,
      extraction: minimalExtraction() as never,
      compactionState: {
        goal: "test goal", decisions: [], constraints: [],
        modifiedFiles: ["src/a.ts"], readFiles: [], deletedFiles: [],
        unresolvedErrors: [], resolvedErrors: [], openLoops: [], topics: [],
        nextActions: [], criticalContext: [], sessionType: "implementation",
        compactionVersion: VERSION, updatedAt: Date.now(),
      } as never,
    });

    const fp = loadProjectFingerprint(projectId);
    expect(fp).not.toBeNull();
    expect(fp!.sessionCount).toBe(1);
    const state = loadCompactionState(projectId);
    expect(state).not.toBeNull();
    expect(state!.goal).toBe("test goal");
  });

  it("indexes an applied scoped state into Smart Recall", async () => {
    const { persistAppliedState } = await import("../src/app/steps/persist.ts");
    const { flushCompactionStateIndexes, recallContext } = await import("../src/infra/context-graph.ts");
    const { VERSION } = await import("../src/constants.ts");
    const projectId = "test-project-graph";
    persistAppliedState({
      runId: "run-applied-2", summary: "## Goal\nship recall", firstKeptEntryId: "e1", tokensBefore: 100,
      details: {} as never, sessionId: "s-graph", projectId,
      compactionState: {
        goal: "Ship persistent recall", decisions: [{ id: "decision-1", summary: "Use FTS5", type: "explicit" }], constraints: [],
        modifiedFiles: [], readFiles: [], deletedFiles: [], unresolvedErrors: [], resolvedErrors: [],
        openLoops: [], topics: [], nextActions: [], criticalContext: [], sessionType: "implementation",
        compactionVersion: VERSION, updatedAt: Date.now(),
        scope: { schemaVersion: 2, projectId, sessionId: "s-graph", branchHeadId: "b1" },
      } as never,
    });
    flushCompactionStateIndexes();

    expect(recallContext({ projectId, sessionId: "s-graph", branchEntryIds: ["b1"] }, "FTS5")[0].content).toContain("FTS5");
  });

  it("does not persist a staged candidate before explicit applied commit", async () => {
    const { createCompactionCommitStore } = await import("../src/app/compaction-commit-store.ts");
    const { commitAppliedCompaction } = await import("../src/app/steps/persist.ts");
    const { loadProjectFingerprint } = await import("../src/utils/fingerprint.ts");
    const { readMetricsLog } = await import("../src/utils/cache.ts");
    const projectId = "test-project-commit-point";
    const candidate = {
      runId: "run-commit-point", sessionId: "s-commit", projectId,
      summary: "summary", firstKeptEntryId: "e1", tokensBefore: 10,
      details: { runId: "run-commit-point" }, extraction: minimalExtraction(),
      metricsSnapshot: {
        totalCalls: 0, totalInput: 0, totalOutput: 0, totalCacheHit: 0,
        avgLatency: 0, cacheHitRate: 0, status: "success",
      },
    } as never;
    const store = createCompactionCommitStore();
    store.stage(candidate);
    expect(loadProjectFingerprint(projectId)).toBeNull();
    expect(readMetricsLog().some(entry => entry.sessionId === "s-commit")).toBe(false);

    commitAppliedCompaction(store.take("run-commit-point", "s-commit")!);
    expect(loadProjectFingerprint(projectId)?.sessionCount).toBe(1);
    expect(readMetricsLog().filter(entry => entry.sessionId === "s-commit")).toHaveLength(1);
  });

  it("is a no-op without projectId (legacy payloads) and never throws", async () => {
    const { persistAppliedState } = await import("../src/app/steps/persist.ts");
    expect(() => persistAppliedState({
      runId: "run-applied-3", summary: "x", firstKeptEntryId: "e", tokensBefore: 0,
      details: {} as never, sessionId: "s",
    })).not.toThrow();
  });
});
