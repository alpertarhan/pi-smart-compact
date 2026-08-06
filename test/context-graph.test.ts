import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeContextMemory, getContextGraphStats, indexCompactionState, recallContext, saveContextMemory,
  type ContextGraphScope,
} from "../src/infra/context-graph.ts";
import type { CompactionState } from "../src/types.ts";

const originalHome = process.env.HOME;
let home = "";

function state(projectId: string, sessionId: string, branchHeadId: string, patch: Partial<CompactionState> = {}): CompactionState {
  return {
    goal: "Ship reliable compaction",
    decisions: [],
    constraints: [],
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
    compactionVersion: "test",
    scope: { schemaVersion: 2, projectId, sessionId, branchHeadId },
    ...patch,
  };
}

function scope(projectId = "project-a", sessionId = "session-a", branchHeadId = "branch-a"): ContextGraphScope {
  return { projectId, sessionId, branchHeadId, branchEntryIds: [branchHeadId] };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-context-graph-"));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("persistent context graph", () => {
  it("indexes scoped state and never recalls another project", () => {
    expect(indexCompactionState("project-a", state("project-a", "session-old", "branch-old", {
      decisions: [{ id: "decision-1", summary: "Use SQLite FTS5 for durable recall", type: "explicit" }],
    }))).toBe(true);
    expect(indexCompactionState("project-b", state("project-b", "session-b", "branch-b", {
      decisions: [{ id: "decision-1", summary: "Use a private unrelated vector database", type: "explicit" }],
    }))).toBe(true);

    const results = recallContext(scope("project-a", "session-new", "branch-new"), "durable recall");
    expect(results.some(result => result.content.includes("SQLite FTS5"))).toBe(true);
    expect(results.some(result => result.content.includes("vector database"))).toBe(false);
    expect(results[0].sameSession).toBe(false);
  });

  it("prefers the same session and deduplicates equivalent facts", () => {
    const decision = [{ id: "decision-1", summary: "Keep peer dependencies as wildcards", type: "explicit" as const }];
    indexCompactionState("project-a", state("project-a", "session-old", "old", { decisions: decision }));
    indexCompactionState("project-a", state("project-a", "session-a", "branch-a", { decisions: decision }));

    const results = recallContext(scope(), "peer dependencies wildcards", { limit: 10 });
    expect(results.filter(result => result.kind === "decision")).toHaveLength(1);
    expect(results.find(result => result.kind === "decision")?.sameSession).toBe(true);
  });

  it("excludes divergent branch facts from session-only recall", () => {
    indexCompactionState("project-a", state("project-a", "session-a", "sibling-head", {
      decisions: [{ id: "decision-1", summary: "Use sibling-only deployment", type: "explicit" }],
    }));
    const current = scope("project-a", "session-a", "current-head");
    expect(recallContext(current, "sibling deployment", { sessionOnly: true })).toEqual([]);
    expect(recallContext(current, "sibling deployment", { sessionOnly: false })[0].sameBranch).toBe(false);
  });

  it("expands file matches through graph edges", () => {
    indexCompactionState("project-a", state("project-a", "session-a", "branch-a", {
      modifiedFiles: ["src/auth.ts"],
      openLoops: [{
        id: "loop-1", type: "follow-up", priority: "high", status: "open",
        summary: "Finish token rotation", files: ["src/auth.ts"],
      }],
    }));

    const results = recallContext(scope(), "src/auth.ts", { limit: 10 });
    expect(results.some(result => result.kind === "file")).toBe(true);
    expect(results.some(result => result.kind === "loop" && result.content.includes("token rotation"))).toBe(true);
  });

  it("removes explicitly superseded decisions even when they had a user response", () => {
    indexCompactionState("project-a", state("project-a", "session-a", "branch-a", {
      decisions: [{ id: "decision-1", summary: "Deploy only after approval", userResponse: "Approved", type: "explicit" }],
    }));
    expect(recallContext(scope(), "deploy approval").some(result => result.kind === "decision")).toBe(true);

    indexCompactionState("project-a", state("project-a", "session-a", "branch-a", {
      factOverrides: [{
        id: "decision-override-1", kind: "decision", summaryKey: "deploy only after approval",
        status: "superseded", replacement: "Use the canary gate", updatedAt: Date.now(),
      }],
    }));
    expect(recallContext(scope(), "deploy approval").some(result => result.kind === "decision")).toBe(false);
  });

  it("removes resolved errors from active recall", () => {
    indexCompactionState("project-a", state("project-a", "session-a", "branch-a", {
      unresolvedErrors: [{ id: "error-1", message: "Port 3000 remains occupied", tool: "bash", files: [] }],
    }));
    expect(recallContext(scope(), "port occupied").some(result => result.kind === "error")).toBe(true);

    indexCompactionState("project-a", state("project-a", "session-a", "branch-a", {
      resolvedErrors: [{ id: "error-1", message: "Port 3000 remains occupied", tool: "bash" }],
    }));
    expect(recallContext(scope(), "port occupied").some(result => result.kind === "error")).toBe(false);
  });

  it("saves explicit memory idempotently", () => {
    const input = {
      kind: "procedure" as const,
      title: "Release check",
      content: "Run the frozen-install audit before publishing",
      relatedPaths: ["package.json"],
    };
    const first = saveContextMemory(scope(), input);
    const second = saveContextMemory(scope(), input);

    expect(second.id).toBe(first.id);
    const results = recallContext(scope(), "frozen install audit");
    expect(results[0].source).toBe("manual");
    expect(results[0].relatedPaths).toContain("package.json");
    expect(getContextGraphStats("project-a").activeNodes).toBeGreaterThan(0);
    expect(closeContextMemory("project-a", "procedure", input.content, "resolved")).toBe(1);
    expect(recallContext(scope(), "frozen install audit")).toEqual([]);
  });

  it("handles punctuation-only and FTS syntax-like queries safely", () => {
    indexCompactionState("project-a", state("project-a", "session-a", "branch-a", {
      criticalContext: ["Keep auth migration reversible"],
    }));
    expect(recallContext(scope(), "*** ((( ))")).toEqual([]);
    expect(() => recallContext(scope(), 'auth" OR *')).not.toThrow();
  });
});
