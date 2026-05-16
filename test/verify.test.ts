import { describe, it, expect } from "bun:test";
import { verifySummary, patchDeterministic } from "../src/phases/verify.ts";
import type { StructuredExtraction } from "../src/types.ts";

function makeExtraction(partial: Partial<StructuredExtraction> = {}): StructuredExtraction {
  return {
    modifiedFiles: [], readFiles: [], deletedFiles: [],
    errors: [], decisions: [], constraints: [], topics: [], timeline: [],
    mainGoal: null, lastUserMessages: [], lastErrors: [], messageCount: 0,
    ...partial,
  };
}

describe("verifySummary", () => {
  it("returns perfect score for complete coverage", () => {
    const extraction = makeExtraction({
      modifiedFiles: [{ path: "/src/App.tsx", toolCalls: 1, lastModifiedIndex: 2 }],
      mainGoal: "Build an app",
      errors: [],
      constraints: [],
      decisions: [],
    });
    const summary = `
## Goal
Build an app
## Progress
### Done
- [x] /src/App.tsx updated
### In Progress
- nothing
### Blocked
- nothing
## Critical Context
- none
`;
    const result = verifySummary(summary, extraction);
    expect(result.ok).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.gaps.length).toBe(0);
  });

  it("detects missing modified files", () => {
    const extraction = makeExtraction({
      modifiedFiles: [{ path: "/src/Auth.ts", toolCalls: 1, lastModifiedIndex: 2 }],
    });
    const summary = `
## Goal
Something
## Progress
### Done
- [x] other stuff
## Critical Context
- none
`;
    const result = verifySummary(summary, extraction);
    expect(result.ok).toBe(false);
    expect(result.gaps.some(g => g.includes("Auth.ts"))).toBe(true);
    expect(result.score).toBeLessThan(100);
  });

  it("detects missing unresolved errors", () => {
    const extraction = makeExtraction({
      errors: [{ index: 3, tool: "bash", message: "Syntax error at line 42", retryAttempted: false, resolved: false }],
    });
    const summary = `
## Goal
Something
## Progress
### Done
- [x] all good
## Critical Context
- none
`;
    const result = verifySummary(summary, extraction);
    expect(result.ok).toBe(false);
    expect(result.gaps.some(g => g.includes("Syntax error"))).toBe(true);
  });

  it("detects missing high-confidence constraints", () => {
    const extraction = makeExtraction({
      constraints: [{ index: 1, text: "You must use TypeScript strict mode", category: "requirement", confidence: 0.9 }],
    });
    const summary = `
## Goal
Something
## Progress
### Done
- [x] done
## Critical Context
- none
`;
    const result = verifySummary(summary, extraction);
    expect(result.ok).toBe(false);
    expect(result.gaps.some(g => g.includes("constraint"))).toBe(true);
  });

  it("detects missing structure sections", () => {
    const extraction = makeExtraction({});
    const summary = "Just some random text without headers";
    const result = verifySummary(summary, extraction);
    expect(result.score).toBeLessThan(100);
    expect(result.score).toBeLessThan(100);
  });

  it("penalizes potentially fabricated files", () => {
    const extraction = makeExtraction({
      modifiedFiles: [{ path: "/src/real.ts", toolCalls: 1, lastModifiedIndex: 2 }],
    });
    const summary = `
## Goal
Build
## Files Modified
- /src/real.ts
- /src/fake-file.rs
## Critical Context
- none
`;
    const result = verifySummary(summary, extraction);
    expect(result.gaps.some(g => g.includes("fabricated"))).toBe(true);
  });
});

describe("patchDeterministic", () => {
  it("injects missing files into Files Modified section", () => {
    const extraction = makeExtraction({
      modifiedFiles: [{ path: "/src/Auth.ts", toolCalls: 1, lastModifiedIndex: 2 }],
    });
    const summary = "## Goal\nBuild app\n## Files Modified\n- none\n## Critical Context\n- none";
    const gaps = ["Missing modified file: /src/Auth.ts"];
    const patched = patchDeterministic(summary, gaps, extraction);
    expect(patched).toContain("/src/Auth.ts");
    expect(patched).toContain("## Files Modified");
  });

  it("injects missing errors into Critical Context section", () => {
    const extraction = makeExtraction({});
    const summary = "## Goal\nFix bug\n## Critical Context\n- none";
    const gaps = ["Missing error: test failed at line 42"];
    const patched = patchDeterministic(summary, gaps, extraction);
    expect(patched).toContain("test failed");
  });

  it("injects missing decisions into Key Decisions section", () => {
    const extraction = makeExtraction({});
    const summary = "## Goal\nBuild\n## Key Decisions\n- none\n## Critical Context\n- none";
    const gaps = ["Missing decision: Use React instead of Vue"];
    const patched = patchDeterministic(summary, gaps, extraction);
    expect(patched).toContain("Use React instead of Vue");
  });

  it("appends other gaps as Verification Note", () => {
    const extraction = makeExtraction({});
    const summary = "## Goal\nBuild\n## Critical Context\n- none";
    const gaps = ["Main goal may be missing from summary"];
    const patched = patchDeterministic(summary, gaps, extraction);
    expect(patched).toContain("Verification Note");
    expect(patched).toContain("Main goal may be missing");
  });
});
