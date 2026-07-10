/**
 * C1 regression: durable state (project fingerprint + compaction state) must
 * be persisted when a pending payload is CONSUMED — the auto-trigger and tool
 * paths never reach applyCompaction, so consume is the only apply point they
 * share. Before this fix the fingerprint/state chain silently never ran on
 * the most common (auto) path.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let home: string;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-consumed-"));
  process.env.HOME = home;
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

describe("persistConsumedState", () => {
  it("writes fingerprint + compaction state for a payload carrying projectId", async () => {
    const { persistConsumedState } = await import("../src/app/steps/persist.ts");
    const { loadProjectFingerprint } = await import("../src/utils/fingerprint.ts");
    const { loadCompactionState } = await import("../src/utils/state.ts");
    const { VERSION } = await import("../src/constants.ts");

    const projectId = "test-project-consumed";
    persistConsumedState({
      summary: "## Goal\nx", firstKeptEntryId: "e1", tokensBefore: 100,
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

  it("is a no-op without projectId (legacy payloads) and never throws", async () => {
    const { persistConsumedState } = await import("../src/app/steps/persist.ts");
    expect(() => persistConsumedState({
      summary: "x", firstKeptEntryId: "e", tokensBefore: 0,
      details: {} as never, sessionId: "s",
    })).not.toThrow();
  });
});
