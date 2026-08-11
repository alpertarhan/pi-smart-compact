import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { extractOpenLoops } from "../src/utils/extraction.ts";
import {
  buildCompactionState, injectOpenLoopsSection, extractNextActions, extractCriticalContext,
  computeDelta, formatDeltaSection, hasDeltaChanges, injectDeltaSection,
  saveCompactionState, loadCompactionState, loadScopedCompactionState,
  applyLoopOverrides, upsertLoopOverride, mergeCompactionStates, renderContinuityCapsule,
  sanitizeCompactionStateEvidence, upsertContinuityOverride,
} from "../src/utils/state.ts";
import { scopedCompactionStateFile } from "../src/infra/paths.ts";
import type { LlmMessage, StructuredExtraction, OpenLoop, ExplorationReport, CompactionState } from "../src/types.ts";

function makeExtraction(partial: Partial<StructuredExtraction> = {}): StructuredExtraction {
  return {
    modifiedFiles: [], readFiles: [], deletedFiles: [],
    errors: [], decisions: [], constraints: [], topics: [], timeline: [],
    mainGoal: "Build an app", lastUserMessages: [], lastErrors: [], messageCount: 10,
    ...partial,
  };
}

function makeMsgs(extra: Partial<LlmMessage>[]): LlmMessage[] {
  return extra.map((e, i) => ({ role: e.role ?? "user", content: e.content ?? "", ...e }));
}

describe("extractOpenLoops", () => {
  it("creates bugfix loops from unresolved errors", () => {
    const extraction = makeExtraction({
      errors: [
        { index: 3, tool: "bash", message: "test failed in auth.ts", retryAttempted: false, resolved: false },
      ],
      modifiedFiles: [{ path: "src/auth.ts", toolCalls: 1, lastModifiedIndex: 2 }],
    });
    const msgs = makeMsgs([]);
    const loops = extractOpenLoops(msgs, extraction);
    expect(loops.length).toBe(1);
    expect(loops[0].type).toBe("bugfix");
    expect(loops[0].priority).toBe("normal");
    expect(loops[0].files).toEqual(["src/auth.ts"]);
  });

  it("creates high-priority bugfix loops for retried errors", () => {
    const extraction = makeExtraction({
      errors: [
        { index: 5, tool: "edit", message: "permission denied", retryAttempted: true, resolved: false },
      ],
    });
    const loops = extractOpenLoops([], extraction);
    expect(loops.some(l => l.priority === "high")).toBe(true);
  });

  it("creates follow-up loops from user messages", () => {
    const extraction = makeExtraction({ errors: [] });
    const msgs: LlmMessage[] = [
      { role: "user", content: "next step is to add tests" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "also we still need to fix that bug" },
    ];
    const loops = extractOpenLoops(msgs, extraction);
    expect(loops.some(l => l.type === "follow-up")).toBe(true);
  });

  it("uses actual iteration indexes for repeated message object references", () => {
    const extraction = makeExtraction({ errors: [] });
    const repeated: LlmMessage = { role: "user", content: "next step is to add tests" };
    const msgs: LlmMessage[] = [
      repeated,
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
      { role: "assistant", content: "c" },
      { role: "assistant", content: "d" },
      { role: "assistant", content: "e" },
      repeated,
    ];
    const loops = extractOpenLoops(msgs, extraction).filter(l => l.type === "follow-up");
    expect(loops.map(l => l.sourceIndex)).toEqual([0, 6]);
  });

  it("creates blocked loops", () => {
    const extraction = makeExtraction({ errors: [] });
    const msgs: LlmMessage[] = [
      { role: "user", content: "we're blocked waiting for the API key" },
    ];
    const loops = extractOpenLoops(msgs, extraction);
    expect(loops.some(l => l.type === "blocked")).toBe(true);
    expect(loops[0].priority).toBe("high");
  });

  it("returns empty for resolved-only sessions", () => {
    const extraction = makeExtraction({
      errors: [
        { index: 3, tool: "bash", message: "test failed", retryAttempted: true, resolved: true },
      ],
    });
    const loops = extractOpenLoops([], extraction);
    expect(loops.length).toBe(0);
  });

  it("assigns stable IDs", () => {
    const extraction = makeExtraction({
      errors: [
        { index: 1, tool: "bash", message: "error 1", retryAttempted: false, resolved: false },
        { index: 5, tool: "edit", message: "error 2", retryAttempted: false, resolved: false },
      ],
    });
    const loops = extractOpenLoops([], extraction);
    expect(loops.length).toBe(2);
    expect(loops[0].id).toBe("loop-1");
    expect(loops[1].id).toBe("loop-2");
  });
});

describe("loop overrides", () => {
  const loops: OpenLoop[] = [
    { id: "loop-1", type: "follow-up", priority: "normal", status: "open", summary: "Finish auth", files: ["src/auth.ts"] },
    { id: "loop-2", type: "blocked", priority: "high", status: "open", summary: "Unblock billing", files: [] },
  ];

  it("applies status and priority overrides", () => {
    let overrides = upsertLoopOverride([], loops[0], { status: "resolved", priority: "critical" });
    const result = applyLoopOverrides(loops, overrides);
    expect(result[0].status).toBe("resolved");
    expect(result[0].priority).toBe("critical");
  });

  it("never applies an override to a different loop that reused the same positional id", () => {
    const overrides = upsertLoopOverride([], loops[0], { status: "resolved" });
    const unrelated: OpenLoop = { ...loops[1], id: loops[0].id };
    expect(applyLoopOverrides([unrelated], overrides)[0].status).toBe("open");
  });

  it("matches regenerated ids through the normalized summary key and sorts pins first", () => {
    const overrides = upsertLoopOverride([], loops[0], { pinned: true });
    const regenerated = [loops[1], { ...loops[0], id: "loop-new" }];
    const result = applyLoopOverrides(regenerated, overrides);
    expect(result[0].id).toBe("loop-new");
    expect(result[0].summary).toBe("Finish auth");
  });
});

describe("buildCompactionState", () => {
  it("builds full state from extraction", () => {
    const extraction = makeExtraction({
      modifiedFiles: [{ path: "src/app.ts", toolCalls: 1, lastModifiedIndex: 2 }],
      readFiles: ["src/config.ts"],
      errors: [
        { index: 5, tool: "bash", message: "test failed", retryAttempted: false, resolved: false },
      ],
      decisions: [
        { index: 3, type: "explicit", summary: "Use JWT", userResponse: "confirmed" },
      ],
      constraints: [
        { index: 1, text: "Must use TypeScript", category: "requirement", confidence: 0.9 },
      ],
    });
    const loops: OpenLoop[] = [
      { id: "loop-1", type: "bugfix", priority: "high", status: "open", summary: "test failed", files: [] },
    ];
    const state = buildCompactionState(extraction, loops, null, ["Add tests"], ["Unresolved error"]);

    expect(state.goal).toBe("Build an app");
    expect(state.modifiedFiles).toEqual(["src/app.ts"]);
    expect(state.unresolvedErrors.length).toBe(1);
    expect(state.resolvedErrors.length).toBe(0);
    expect(state.openLoops.length).toBe(1);
    expect(state.nextActions).toEqual(["Add tests"]);
    expect(state.criticalContext).toEqual(["Unresolved error"]);
    expect(state.decisions[0].id).toBe("decision-1");
    expect(state.constraints[0].id).toBe("constraint-1");
  });
});

describe("injectOpenLoopsSection", () => {
  it("injects before Next Steps", () => {
    const summary = "## Goal\nBuild app\n## Next Steps\n1. Write tests\n";
    const loops: OpenLoop[] = [
      { id: "loop-1", type: "bugfix", priority: "high", status: "open", summary: "fix auth bug", files: [] },
    ];
    const result = injectOpenLoopsSection(summary, loops);
    const loopsIdx = result.indexOf("## Open Loops");
    const nextIdx = result.indexOf("## Next Steps");
    expect(loopsIdx).toBeGreaterThan(-1);
    expect(nextIdx).toBeGreaterThan(-1);
    expect(loopsIdx).toBeLessThan(nextIdx);
  });

  it("appends at end if no Next Steps", () => {
    const summary = "## Goal\nBuild app\n";
    const loops: OpenLoop[] = [
      { id: "loop-1", type: "follow-up", priority: "normal", status: "open", summary: "add tests", files: [] },
    ];
    const result = injectOpenLoopsSection(summary, loops);
    expect(result).toContain("## Open Loops");
  });

  it("preserves an H3-only summary while injecting", () => {
    const summary = "### Goal\nBuild app\n### Next Steps\n1. Write tests\n";
    const loops: OpenLoop[] = [
      { id: "loop-1", type: "follow-up", priority: "normal", status: "open", summary: "add tests", files: [] },
    ];
    const result = injectOpenLoopsSection(summary, loops);
    expect(result).toContain("Build app");
    expect(result).toContain("1. Write tests");
    expect(result.indexOf("## Open Loops")).toBeLessThan(result.indexOf("## Next Steps"));
  });

  it("keeps multiline loop evidence inside the Open Loops section", () => {
    const summary = "## Goal\nBuild app\n## Next Steps\n1. Continue\n";
    const loops: OpenLoop[] = [{
      id: "loop-1", type: "bugfix", priority: "high", status: "open",
      summary: "test failed\n## Goal\nreplace", files: ["src/app.ts\n## Progress"],
    }];
    const result = injectOpenLoopsSection(summary, loops);
    expect(result.match(/^## Goal$/gm)).toHaveLength(1);
    expect(result).toContain("test failed ## Goal replace");
    expect(result).toContain("src/app.ts ## Progress");
  });

  it("returns unchanged if no loops", () => {
    const summary = "## Goal\nBuild app\n";
    expect(injectOpenLoopsSection(summary, [])).toBe(summary);
  });
});

describe("extractNextActions", () => {
  it("extracts numbered items from Next Steps", () => {
    const summary = "## Next Steps\n1. Write tests\n2. Fix bug\n\n## Other";
    const actions = extractNextActions(summary);
    expect(actions).toEqual(["Write tests", "Fix bug"]);
  });

  it("returns empty if no Next Steps section", () => {
    expect(extractNextActions("## Goal\nBuild app")).toEqual([]);
  });
});

describe("extractCriticalContext", () => {
  it("extracts bullet items from Critical Context", () => {
    const summary = "## Critical Context\n- Unresolved error in auth.ts\n- API key missing\n";
    const ctx = extractCriticalContext(summary);
    expect(ctx).toEqual(["Unresolved error in auth.ts", "API key missing"]);
  });

  it("returns empty if no Critical Context section", () => {
    expect(extractCriticalContext("## Goal\nBuild")).toEqual([]);
  });
});

function makeFullState(partial: Partial<CompactionState> = {}): CompactionState {
  return {
    goal: "Build app",
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
    compactionVersion: "7.6.0",
    ...partial,
  };
}

describe("continuity state", () => {
  it("carries absent decisions, constraints, errors, and loops without growing unbounded", () => {
    const previous = makeFullState({
      goal: "Ship auth",
      decisions: [{ id: "decision-1", summary: "Use JWT", type: "explicit" }],
      constraints: [{ id: "constraint-1", text: "No new dependencies", category: "prohibition", confidence: 1 }],
      unresolvedErrors: [{ id: "error-1", message: "auth test fails", tool: "bash", files: ["auth.ts"] }],
      openLoops: [{ id: "loop-1", type: "bugfix", priority: "high", status: "open", summary: "fix auth test", files: ["auth.ts"] }],
    });
    const merged = mergeCompactionStates(previous, makeFullState({ goal: null }));

    expect(merged.goal).toBe("Ship auth");
    expect(merged.decisions.map(item => item.summary)).toContain("Use JWT");
    expect(merged.constraints.map(item => item.text)).toContain("No new dependencies");
    expect(merged.unresolvedErrors.map(item => item.message)).toContain("auth test fails");
    expect(merged.openLoops.map(item => item.summary)).toContain("fix auth test");
  });

  it("caps the first state and budgets active loops before resolved history", () => {
    const first = mergeCompactionStates(null, makeFullState({
      openLoops: Array.from({ length: 80 }, (_, index) => ({
        id: "loop-" + index, type: "follow-up" as const, priority: "normal" as const,
        status: "open" as const, summary: "first open " + index, files: [],
      })),
    }));
    expect(first.openLoops).toHaveLength(25);

    const active = Array.from({ length: 10 }, (_, index) => ({
      id: "active-" + index, type: "bugfix" as const, priority: "critical" as const,
      status: "open" as const, summary: "critical open " + index, files: [],
    }));
    const mixed = mergeCompactionStates(
      makeFullState({
        openLoops: Array.from({ length: 30 }, (_, index) => ({
          id: "resolved-" + index, type: "follow-up" as const, priority: "normal" as const,
          status: "resolved" as const, summary: "resolved history " + index, files: [],
        })),
      }),
      makeFullState({ openLoops: active }),
    );
    expect(mixed.openLoops).toHaveLength(25);
    expect(mixed.openLoops.filter(loop => loop.status !== "resolved").map(loop => loop.summary))
      .toEqual(active.map(loop => loop.summary));
  });

  it("drops stale compaction status and transient diagnostics from continuity", () => {
    const clean = sanitizeCompactionStateEvidence(makeFullState({
      goal: "EESV Compact (model, balanced) — 259,782t Warning: Smart compact skipped",
      unresolvedErrors: [{ id: "error-1", message: "Brave Search API error (429): rate limit exceeded", tool: "web_search", files: [] }],
      resolvedErrors: [{ id: "error-2", message: "npm error code ENOLOCK npm audit requires an existing lockfile", tool: "bash" }],
      openLoops: [{ id: "loop-1", type: "bugfix", priority: "normal", status: "open", summary: "Found 2 occurrences of edits[2]; oldText must be unique", files: [] }],
      criticalContext: ["Unresolved error: Unknown JSON field: url Available fields: tagName", "Keep this invariant"],
    }));
    expect(clean.goal).toBeNull();
    expect(clean.unresolvedErrors).toEqual([]);
    expect(clean.resolvedErrors).toEqual([]);
    expect(clean.openLoops).toEqual([]);
    expect(clean.criticalContext).toEqual(["Keep this invariant"]);
  });

  it("records a newer goal without claiming carried diagnostics were resolved", () => {
    const previous = makeFullState({
      goal: "Ship the old release",
      decisions: [{ id: "decision-1", summary: "Keep signed tags", type: "explicit" }],
      unresolvedErrors: [{ id: "error-1", message: "old release test failed", tool: "bash", files: ["src/release.ts"] }],
      openLoops: [
        { id: "loop-1", type: "bugfix", priority: "high", status: "open", summary: "fix old release", files: ["src/release.ts"] },
        { id: "loop-2", type: "follow-up", priority: "normal", status: "open", summary: "keep pinned", files: [] },
      ],
      loopOverrides: [{ id: "loop-2", summaryKey: "keep pinned", pinned: true }],
      nextActions: ["publish old release"],
      criticalContext: ["old release branch"],
    });
    const merged = mergeCompactionStates(previous, makeFullState({
      goal: "Also add a regression test",
      modifiedFiles: ["test/release.test.ts"],
    }));

    expect(merged.goal).toBe("Also add a regression test");
    expect(merged.unresolvedErrors.map(error => error.message)).toContain("old release test failed");
    expect(merged.resolvedErrors).toEqual([]);
    expect(merged.openLoops.map(loop => [loop.summary, loop.status])).toEqual([
      ["fix old release", "open"], ["keep pinned", "open"],
    ]);
    expect(merged.nextActions).toContain("publish old release");
    expect(merged.criticalContext).toContain("Previous goal: Ship the old release");
    expect(merged.criticalContext).toContain("old release branch");
    expect(merged.decisions.map(item => item.summary)).toEqual(["Keep signed tags"]);

    const nextCompaction = mergeCompactionStates(merged, makeFullState({ goal: "Also add a regression test" }));
    expect(nextCompaction.unresolvedErrors.map(error => error.message)).toContain("old release test failed");
    expect(nextCompaction.resolvedErrors).toEqual([]);
    expect(nextCompaction.criticalContext.filter(item => item === "Previous goal: Ship the old release")).toHaveLength(1);
  });

  it("uses current file evidence to resolve prior deletion/presence status", () => {
    const revived = mergeCompactionStates(
      makeFullState({ deletedFiles: ["src/a.ts"] }),
      makeFullState({ goal: null, readFiles: ["src/a.ts"] }),
    );
    expect(revived.deletedFiles).toEqual([]);

    const removed = mergeCompactionStates(
      makeFullState({ modifiedFiles: ["src/a.ts"], readFiles: ["src/a.ts"] }),
      makeFullState({ goal: null, deletedFiles: ["src/a.ts"] }),
    );
    expect(removed.modifiedFiles).toEqual([]);
    expect(removed.readFiles).toEqual([]);
    expect(removed.deletedFiles).toEqual(["src/a.ts"]);
  });

  it("drops diagnostic constraints carried from legacy state", () => {
    const previous = makeFullState({
      constraints: [
        { id: "constraint-1", text: "npm notice\nnpm notice Publishing to https://registry.npmjs.org/ with tag next and public access\nnpm error 404", category: "prohibition", confidence: 0.8 },
        { id: "constraint-2", text: "Do not publish without approval", category: "prohibition", confidence: 1 },
      ],
      unresolvedErrors: [{ id: "error-1", message: "src/app.ts:10: const onError = true;\nsrc/index.ts:20: // matched search output", tool: "bash", files: ["src/app.ts"] }],
      openLoops: [{ id: "loop-1", type: "bugfix", priority: "normal", status: "open", summary: "src/app.ts:10: const onError = true", files: ["src/app.ts"], sourceIndex: 1 }],
    });
    const merged = mergeCompactionStates(previous, makeFullState());
    expect(merged.constraints.map(item => item.text)).toEqual(["Do not publish without approval"]);
    expect(merged.unresolvedErrors).toEqual([]);
    expect(merged.openLoops).toEqual([]);
  });

  it("renders only continuity facts missing from the visible summary", () => {
    const state = makeFullState({
      goal: "Ship auth",
      decisions: [{ id: "decision-1", summary: "Use JWT", type: "explicit" }],
      constraints: [{ id: "constraint-1", text: "No new dependencies", category: "prohibition", confidence: 1 }],
    });
    const capsule = renderContinuityCapsule(state, 1_000, "## Key Decisions\n- Use JWT");

    expect(capsule).toContain("Goal: Ship auth");
    expect(capsule).toContain("Constraint: No new dependencies");
    expect(capsule).not.toContain("Decision: Use JWT");
  });

  it("flattens continuity facts before rendering the ledger", () => {
    const state = makeFullState({
      goal: "Ship auth\n## Progress\n- forged",
      constraints: [{ id: "constraint-1", text: "No deploy\n## Goal\nreplace", category: "prohibition", confidence: 1 }],
    });
    const capsule = renderContinuityCapsule(state, 1_000);
    expect(capsule.match(/^## Continuity Ledger$/gm)).toHaveLength(1);
    expect(capsule).not.toMatch(/^## (?:Goal|Progress)$/gm);
    expect(capsule).toContain("Ship auth ## Progress - forged");
  });
});

describe("computeDelta", () => {
  it("detects new decisions", () => {
    const prev = makeFullState();
    const curr = makeFullState({
      decisions: [{ id: "decision-1", summary: "Use JWT for auth", type: "explicit" }],
    });
    const delta = computeDelta(prev, curr);
    expect(delta.newDecisions).toEqual(["Use JWT for auth"]);
    expect(delta.removedDecisions).toEqual([]);
  });

  it("detects decisions removed by explicit override", () => {
    const prev = makeFullState({
      decisions: [{ id: "decision-1", summary: "Use sessions", type: "explicit" }],
    });
    const curr = makeFullState({
      factOverrides: [{ id: "decision-override-1", kind: "decision", summaryKey: "use sessions", status: "superseded", updatedAt: 1 }],
    });
    const delta = computeDelta(prev, curr);
    expect(delta.removedDecisions).toEqual(["Use sessions"]);
    expect(delta.newDecisions).toEqual([]);
  });

  it("detects resolved and new loops", () => {
    const prev = makeFullState({
      openLoops: [
        { id: "loop-1", type: "bugfix", priority: "high", status: "open", summary: "fix auth bug", files: [] },
        { id: "loop-2", type: "follow-up", priority: "normal", status: "open", summary: "add tests", files: [] },
      ],
    });
    const curr = makeFullState({
      openLoops: [
        { id: "loop-1", type: "bugfix", priority: "high", status: "resolved", summary: "fix auth bug", files: [] },
        { id: "loop-2", type: "follow-up", priority: "normal", status: "open", summary: "add tests", files: [] },
        { id: "loop-3", type: "bugfix", priority: "high", status: "open", summary: "fix caching issue", files: [] },
      ],
    });
    const delta = computeDelta(prev, curr);
    expect(delta.resolvedLoops).toEqual(["fix auth bug"]);
    expect(delta.persistentLoops).toEqual(["add tests"]);
    expect(delta.newLoops).toEqual(["fix caching issue"]);
  });

  it("detects new modified files", () => {
    const prev = makeFullState({ modifiedFiles: ["src/app.ts"] });
    const curr = makeFullState({ modifiedFiles: ["src/app.ts", "src/auth.ts"] });
    const delta = computeDelta(prev, curr);
    expect(delta.newModifiedFiles).toEqual(["src/auth.ts"]);
  });

  it("detects resolved and new errors", () => {
    const prev = makeFullState({
      unresolvedErrors: [{ id: "error-1", message: "test failed", tool: "bash", files: [] }],
    });
    const curr = makeFullState({
      unresolvedErrors: [{ id: "error-2", message: "build error", tool: "edit", files: [] }],
      resolvedErrors: [{ id: "error-1", message: "test failed", tool: "bash" }],
    });
    const delta = computeDelta(prev, curr);
    expect(delta.resolvedErrors).toEqual(["test failed"]);
    expect(delta.newErrors).toEqual(["build error"]);
  });

  it("does not resolve cap-evicted loops, errors, or decisions by absence", () => {
    const previous = makeFullState({
      decisions: Array.from({ length: 30 }, (_, index) => ({ id: "decision-" + index, summary: "old decision " + index, type: "explicit" as const })),
      unresolvedErrors: Array.from({ length: 15 }, (_, index) => ({ id: "error-" + index, message: "old error " + index, tool: "bash", files: [] })),
      openLoops: Array.from({ length: 25 }, (_, index) => ({
        id: "loop-" + index, type: "follow-up" as const, priority: "normal" as const,
        status: "open" as const, summary: "old loop " + index, files: [],
      })),
    });
    const merged = mergeCompactionStates(previous, makeFullState({
      decisions: [{ id: "decision-new", summary: "new decision", type: "explicit" }],
      unresolvedErrors: [{ id: "error-new", message: "new error", tool: "bash", files: [] }],
      openLoops: [{ id: "loop-new", type: "bugfix", priority: "critical", status: "open", summary: "new critical loop", files: [] }],
    }));
    const delta = computeDelta(previous, merged);

    expect(merged.decisions).toHaveLength(30);
    expect(merged.unresolvedErrors).toHaveLength(15);
    expect(merged.openLoops).toHaveLength(25);
    expect(delta.removedDecisions).toEqual([]);
    expect(delta.resolvedErrors).toEqual([]);
    expect(delta.resolvedLoops).toEqual([]);
    expect(delta.newDecisions).toEqual(["new decision"]);
    expect(delta.newErrors).toEqual(["new error"]);
    expect(delta.newLoops).toEqual(["new critical loop"]);
  });

  it("detects goal change", () => {
    const prev = makeFullState({ goal: "Build API" });
    const curr = makeFullState({ goal: "Build frontend" });
    const delta = computeDelta(prev, curr);
    expect(delta.goalChanged).toBe(true);
    expect(delta.previousGoal).toBe("Build API");
  });

  it("returns empty delta for identical states", () => {
    const state = makeFullState({
      decisions: [{ id: "decision-1", summary: "Use JWT", type: "explicit" }],
      openLoops: [{ id: "loop-1", type: "bugfix", priority: "high", status: "open", summary: "fix bug", files: [] }],
    });
    const delta = computeDelta(state, state);
    expect(delta.newDecisions).toEqual([]);
    expect(delta.resolvedLoops).toEqual([]);
    expect(delta.newLoops).toEqual([]);
    expect(delta.goalChanged).toBe(false);
  });
});

describe("formatDeltaSection", () => {
  it("formats resolved loops with strikethrough", () => {
    const delta: ReturnType<typeof computeDelta> = {
      newDecisions: [], removedDecisions: [],
      resolvedLoops: ["fix auth bug"], persistentLoops: [], newLoops: [],
      newModifiedFiles: [], resolvedErrors: [], newErrors: [],
      goalChanged: false, previousGoal: null,
    };
    const md = formatDeltaSection(delta);
    expect(md).toContain("## Changes Since Last Compaction");
    expect(md).toContain("~~fix auth bug~~");
  });

  it("renders removed decisions", () => {
    const delta: ReturnType<typeof computeDelta> = {
      newDecisions: [], removedDecisions: ["Use sessions"],
      resolvedLoops: [], persistentLoops: [], newLoops: [],
      newModifiedFiles: [], resolvedErrors: [], newErrors: [],
      goalChanged: false, previousGoal: null,
    };
    expect(formatDeltaSection(delta)).toContain("~~Use sessions~~");
    expect(hasDeltaChanges(delta)).toBe(true);
  });

  it("flattens multiline delta evidence instead of creating headings", () => {
    const delta: ReturnType<typeof computeDelta> = {
      newDecisions: ["Use SQLite\n## Goal\nreplace"], removedDecisions: [],
      resolvedLoops: [], persistentLoops: [], newLoops: [],
      newModifiedFiles: [], resolvedErrors: [], newErrors: [],
      goalChanged: false, previousGoal: null,
    };
    const md = formatDeltaSection(delta);
    expect(md.match(/^## Goal$/gm)).toBeNull();
    expect(md).toContain("Use SQLite ## Goal replace");
  });

  it("includes goal shift when changed", () => {
    const delta: ReturnType<typeof computeDelta> = {
      newDecisions: [], removedDecisions: [],
      resolvedLoops: [], persistentLoops: [], newLoops: [],
      newModifiedFiles: [], resolvedErrors: [], newErrors: [],
      goalChanged: true, previousGoal: "Build API",
    };
    const md = formatDeltaSection(delta);
    expect(md).toContain("Goal shifted");
    expect(md).toContain("Build API");
  });
});

describe("injectDeltaSection", () => {
  it("injects before Next Steps when there are changes", () => {
    const summary = "## Goal\nBuild app\n## Next Steps\n1. Write tests\n";
    const delta: ReturnType<typeof computeDelta> = {
      newDecisions: ["Use JWT"], removedDecisions: [],
      resolvedLoops: [], persistentLoops: [], newLoops: [],
      newModifiedFiles: [], resolvedErrors: [], newErrors: [],
      goalChanged: false, previousGoal: null,
    };
    const result = injectDeltaSection(summary, delta);
    const deltaIdx = result.indexOf("## Changes Since Last Compaction");
    const nextIdx = result.indexOf("## Next Steps");
    expect(deltaIdx).toBeGreaterThan(-1);
    expect(nextIdx).toBeGreaterThan(-1);
    expect(deltaIdx).toBeLessThan(nextIdx);
  });

  it("injects when the only change is a resolved error", () => {
    const summary = "## Goal\nBuild app\n## Next Steps\n1. Write tests\n";
    const delta: ReturnType<typeof computeDelta> = {
      newDecisions: [], removedDecisions: [],
      resolvedLoops: [], persistentLoops: [], newLoops: [],
      newModifiedFiles: [], resolvedErrors: ["old failure"], newErrors: [],
      goalChanged: false, previousGoal: null,
    };
    expect(injectDeltaSection(summary, delta)).toContain("Resolved errors");
  });

  it("returns unchanged summary when no changes", () => {
    const summary = "## Goal\nBuild app\n";
    const delta: ReturnType<typeof computeDelta> = {
      newDecisions: [], removedDecisions: [],
      resolvedLoops: [], persistentLoops: [], newLoops: [],
      newModifiedFiles: [], resolvedErrors: [], newErrors: [],
      goalChanged: false, previousGoal: null,
    };
    expect(injectDeltaSection(summary, delta)).toBe(summary);
  });
});

describe("saveCompactionState / loadCompactionState", () => {
  it("round-trips a compaction state", () => {
    const testId = "test-roundtrip-" + Date.now();
    const state = makeFullState({
      goal: "Round trip test",
      decisions: [{ id: "decision-1", summary: "Use bun", type: "explicit" }],
    });
    saveCompactionState(testId, state);
    const loaded = loadCompactionState(testId);
    expect(loaded).not.toBeNull();
    expect(loaded!.goal).toBe("Round trip test");
    expect(loaded!.decisions.length).toBe(1);
    // Cleanup
    const p = path.join(process.env.HOME ?? "/tmp", ".pi", "agent", ".cache", "smart-compact", "states", testId + ".json");
    try { fs.unlinkSync(p); } catch {}
  });

  it("sanitizes diagnostic constraints before persistence", () => {
    const testId = "test-sanitize-" + Date.now();
    saveCompactionState(testId, makeFullState({
      constraints: [{ id: "constraint-1", text: "npm error You do not have permission", category: "prohibition", confidence: 0.8 }],
    }));
    expect(loadCompactionState(testId)?.constraints).toEqual([]);
    const p = path.join(process.env.HOME ?? "/tmp", ".pi", "agent", ".cache", "smart-compact", "states", testId + ".json");
    try { fs.unlinkSync(p); } catch {}
  });

  it("deletes expired state snapshots when they are observed", () => {
    const testId = "test-stale-" + Date.now();
    saveCompactionState(testId, makeFullState({ updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }));
    const file = path.join(process.env.HOME ?? "/tmp", ".pi", "agent", ".cache", "smart-compact", "states", testId + ".json");
    expect(fs.existsSync(file)).toBe(true);
    expect(loadCompactionState(testId)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("returns null for non-existent state", () => {
    expect(loadCompactionState("nonexistent-" + Date.now())).toBeNull();
  });

  it("isolates state by session and rejects divergent branch ancestry", () => {
    const projectId = "scoped-" + Date.now();
    const sessionId = "session-a";
    const state = makeFullState({
      goal: "Scoped goal",
      scope: { schemaVersion: 2, projectId, sessionId, branchHeadId: "head-a" },
    });
    saveCompactionState(projectId, state);
    const sibling = makeFullState({
      goal: "Sibling goal",
      scope: { schemaVersion: 2, projectId, sessionId, branchHeadId: "head-b" },
    });
    saveCompactionState(projectId, sibling);

    expect(loadScopedCompactionState({ projectId, sessionId }, ["root", "head-a", "new"] )?.goal).toBe("Scoped goal");
    expect(loadScopedCompactionState({ projectId, sessionId: "session-b" }, ["head-a"])).toBeNull();
    expect(loadScopedCompactionState({ projectId, sessionId }, ["root", "other-head"])).toBeNull();
    expect(loadScopedCompactionState({ projectId, sessionId }, ["root", "head-b"])?.goal).toBe("Sibling goal");
    expect(loadScopedCompactionState({ projectId, sessionId }, ["root", "head-a"])?.goal).toBe("Scoped goal");
    expect(loadCompactionState(projectId)).toBeNull();
    try { fs.unlinkSync(scopedCompactionStateFile(projectId, sessionId, "head-a")); } catch {}
    try { fs.unlinkSync(scopedCompactionStateFile(projectId, sessionId, "head-b")); } catch {}
  });

  it("removes a carried fact only through an explicit continuity override", () => {
    const previous = makeFullState({
      decisions: [{ id: "decision-1", summary: "Use JWT", type: "explicit" }],
    });
    const overrides = upsertContinuityOverride([], "decision", "Use JWT", { status: "superseded", replacement: "Use sessions" });
    const merged = mergeCompactionStates(previous, makeFullState({ factOverrides: overrides }));

    expect(merged.decisions.map(item => item.summary)).not.toContain("Use JWT");
    expect(merged.factOverrides?.[0].replacement).toBe("Use sessions");
    expect(merged.criticalContext).toContain("Superseded decision: Use sessions");
  });
});
