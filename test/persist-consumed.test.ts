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
import { commitAppliedCompaction, persistAppliedState } from "../src/app/steps/persist.ts";
import { createCompactionCommitStore } from "../src/app/compaction-commit-store.ts";
import { loadProjectFingerprint } from "../src/utils/fingerprint.ts";
import { loadCompactionState } from "../src/utils/state.ts";
import { readMetricsLog } from "../src/utils/cache.ts";
import { flushCompactionStateIndexes, recallContext } from "../src/infra/context-graph.ts";
import { VERSION } from "../src/constants.ts";

const originalHome = process.env.HOME;
let home: string;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-consumed-"));
  process.env.HOME = home;
});
afterAll(async () => {
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

    const projectId = "test-project-consumed";
    await persistAppliedState({
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
    const projectId = "test-project-graph";
    await persistAppliedState({
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

    await commitAppliedCompaction(store.take("run-commit-point", "s-commit")!);
    expect(loadProjectFingerprint(projectId)?.sessionCount).toBe(1);
    expect(readMetricsLog().filter(entry => entry.sessionId === "s-commit")).toHaveLength(1);
  });


  it("writes the prepared backup only at confirmed commit and records complete persistence", async () => {
    const backupPath = path.join(home, "confirmed-backup.md");
    const candidate = {
      runId: "run-backup-confirmed", sessionId: "s-backup", summary: "summary",
      firstKeptEntryId: "e1", tokensBefore: 10, details: { runId: "run-backup-confirmed" },
      preparedBackup: { path: backupPath, content: "# Smart Compact Backup\n\nexact" },
      metricsSnapshot: {
        totalCalls: 0, totalInput: 0, totalOutput: 0, totalCacheHit: 0,
        avgLatency: 0, cacheHitRate: 0, status: "success",
      },
    } as never;
    const store = createCompactionCommitStore();
    store.stage(candidate);
    expect(fs.existsSync(backupPath)).toBe(false);
    expect(await commitAppliedCompaction(store.take("run-backup-confirmed", "s-backup")!)).toEqual([]);
    expect(fs.readFileSync(backupPath, "utf8")).toContain("exact");
    expect(readMetricsLog().find(entry => entry.sessionId === "s-backup")?.persistenceStatus).toBe("complete");
  });

  it("surfaces backup persistence failure in return value and telemetry", async () => {
    const blocker = path.join(home, "not-a-directory");
    fs.writeFileSync(blocker, "x");
    const failures = await commitAppliedCompaction({
      runId: "run-backup-failed", sessionId: "s-backup-failed", summary: "summary",
      firstKeptEntryId: "e1", tokensBefore: 10, details: { runId: "run-backup-failed" } as never,
      preparedBackup: { path: path.join(blocker, "backup.md"), content: "exact" },
      metricsSnapshot: {
        totalCalls: 0, totalInput: 0, totalOutput: 0, totalCacheHit: 0,
        avgLatency: 0, cacheHitRate: 0, status: "success",
      },
    });
    expect(failures).toContain("conversation backup");
    const metric = readMetricsLog().find(entry => entry.sessionId === "s-backup-failed");
    expect(metric?.persistenceStatus).toBe("partial");
    expect(metric?.persistenceFailures).toContain("conversation backup");
  });
  it("is a no-op without projectId (legacy payloads) and never throws", async () => {
    await persistAppliedState({
      runId: "run-applied-3", summary: "x", firstKeptEntryId: "e", tokensBefore: 0,
      details: {} as never, sessionId: "s",
    });
  });
});
