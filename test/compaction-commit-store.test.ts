import { describe, expect, it } from "bun:test";
import { createCompactionCommitStore } from "../src/app/compaction-commit-store.ts";
import type { PendingCompaction } from "../src/types.ts";

function pending(runId: string, sessionId = "s"): PendingCompaction {
  return {
    runId, sessionId, summary: "summary", firstKeptEntryId: "e", tokensBefore: 1,
    details: { runId } as PendingCompaction["details"],
  };
}

describe("CompactionCommitStore", () => {
  it("commits only the matching run and session exactly once", () => {
    const store = createCompactionCommitStore();
    store.stage(pending("run-123456"));
    expect(store.take("run-123456", "other")).toBeNull();
    expect(store.take("run-123456", "s")?.runId).toBe("run-123456");
    expect(store.take("run-123456", "s")).toBeNull();
  });

  it("rejects mismatched and duplicate correlation ids", () => {
    const store = createCompactionCommitStore();
    expect(() => store.stage({ ...pending("run-123456"), details: { runId: "different-run" } as any })).toThrow("runId mismatch");
    store.stage(pending("run-123456"));
    expect(() => store.stage(pending("run-123456"))).toThrow("Duplicate");
  });

  it("expires and bounds unconfirmed candidates with a failure callback", () => {
    const discarded: string[] = [];
    const store = createCompactionCommitStore({
      ttlMs: 5, maxEntries: 2,
      onDiscard: (item, reason) => discarded.push(item.runId + ":" + reason),
    });
    store.stage(pending("run-one-1"));
    store.stage(pending("run-two-2"));
    store.stage(pending("run-three"));
    expect(discarded).toEqual(["run-one-1:evicted"]);
    Bun.sleepSync(7);
    expect(store.size()).toBe(0);
    expect(discarded).toEqual([
      "run-one-1:evicted", "run-two-2:expired", "run-three:expired",
    ]);
  });

  it("clears only one session", () => {
    const discarded: string[] = [];
    const store = createCompactionCommitStore({ onDiscard: (item, reason) => discarded.push(item.runId + ":" + reason) });
    store.stage(pending("run-a-123", "a"));
    store.stage(pending("run-b-123", "b"));
    expect(store.clearSession("a")).toHaveLength(1);
    expect(store.take("run-b-123", "b")?.sessionId).toBe("b");
    expect(discarded).toEqual(["run-a-123:shutdown"]);
  });
});
