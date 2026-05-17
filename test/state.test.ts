import { describe, it, expect } from "bun:test";
import { extractOpenLoops } from "../src/utils/extraction.ts";
import { buildCompactionState, injectOpenLoopsSection, extractNextActions, extractCriticalContext } from "../src/utils/state.ts";
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
