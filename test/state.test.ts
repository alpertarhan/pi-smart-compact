import { describe, it, expect } from "bun:test";
import { extractOpenLoops } from "../src/utils/extraction.ts";
import { buildCompactionState, injectOpenLoopsSection, extractNextActions, extractCriticalContext, computeDelta, formatDeltaSection, injectDeltaSection, saveCompactionState, loadCompactionState } from "../src/utils/state.ts";
import type { LlmMessage, StructuredExtraction, OpenLoop, ExplorationReport } from "../src/types.ts";

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

  it("detects removed decisions", () => {
    const prev = makeFullState({
      decisions: [{ id: "decision-1", summary: "Use sessions", type: "explicit" }],
    });
    const curr = makeFullState();
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
    });
    const delta = computeDelta(prev, curr);
    expect(delta.resolvedErrors).toEqual(["test failed"]);
    expect(delta.newErrors).toEqual(["build error"]);
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
    const fs = require("fs");
    const p = require("path").join(process.env.HOME ?? "/tmp", ".pi", "agent", ".cache", "smart-compact", "states", testId + ".json");
    try { fs.unlinkSync(p); } catch {}
  });

  it("returns null for non-existent state", () => {
    expect(loadCompactionState("nonexistent-" + Date.now())).toBeNull();
  });
});
