import { describe, it, expect } from "bun:test";
import { verifySummary, patchDeterministic, formatVerificationGap } from "../src/phases/verify.ts";
import { verifyAndPatch } from "../src/app/steps/verify.ts";
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
    expect(result.gaps.some(g => formatVerificationGap(g).includes("Auth.ts"))).toBe(true);
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
    expect(result.gaps.some(g => formatVerificationGap(g).includes("Syntax error"))).toBe(true);
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
    expect(result.gaps.some(g => formatVerificationGap(g).includes("constraint"))).toBe(true);
  });

  it("detects missing structure sections", () => {
    const extraction = makeExtraction({});
    const summary = "Just some random text without headers";
    const result = verifySummary(summary, extraction);
    expect(result.ok).toBe(false);
    expect(result.gaps.some(g => formatVerificationGap(g).includes("## Goal"))).toBe(true);
    expect(result.score).toBeLessThan(100);
  });

  it("does not let one basename satisfy two monorepo paths", () => {
    const extraction = makeExtraction({
      modifiedFiles: [
        { path: "packages/api/src/auth.ts", toolCalls: 1, lastModifiedIndex: 1 },
        { path: "packages/web/src/auth.ts", toolCalls: 1, lastModifiedIndex: 2 },
      ],
    });
    const summary = "## Goal\nRefactor auth\n## Progress\n- packages/api/src/auth.ts updated\n## Critical Context\n- none";
    const result = verifySummary(summary, extraction);
    expect(result.gaps.some(gap => gap.kind === "missing-file" && gap.path === "packages/web/src/auth.ts")).toBe(true);
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
    expect(result.gaps.some(g => formatVerificationGap(g).includes("fabricated"))).toBe(true);
  });
});

describe("verifyAndPatch", () => {
  it("repairs a patchable high-score gap instead of skipping it", async () => {
    const extraction = makeExtraction({ modifiedFiles: [{ path: "src/auth.ts", toolCalls: 1, lastModifiedIndex: 1 }] });
    const result = await verifyAndPatch({
      finalSummary: "## Goal\nBuild auth\n## Progress\n- setup\n## Critical Context\n- stable",
      extraction,
      flags: { autoTriggered: true },
      notify: () => {},
      vlog: () => {},
    } as any);
    expect(result.finalSummary).toContain("src/auth.ts");
    expect(result.verificationProvenance.initialScore).toBe(95);
    expect(result.verificationProvenance.deterministicPatched).toHaveLength(1);
    expect(result.verificationScore).toBe(100);
  });
});

describe("patchDeterministic", () => {
  it("injects missing files into Files Modified section", () => {
    const extraction = makeExtraction({
      modifiedFiles: [{ path: "/src/Auth.ts", toolCalls: 1, lastModifiedIndex: 2 }],
    });
    const summary = "## Goal\nBuild app\n## Files Modified\n- none\n## Critical Context\n- none";
    const patched = patchDeterministic(summary, [{ kind: "missing-file", path: "/src/Auth.ts" }], extraction);
    expect(patched).toContain("/src/Auth.ts");
    expect(patched).toContain("## Files Modified");
  });

  it("creates canonical sections when deterministic patch target is missing", () => {
    const extraction = makeExtraction({
      modifiedFiles: [
        { path: "/web/src/pages/sessions.tsx", toolCalls: 1, lastModifiedIndex: 2 },
        { path: "/web/src/pages/compare.tsx", toolCalls: 1, lastModifiedIndex: 3 },
      ],
      mainGoal: "Improve dashboard UI",
    });
    const summary = "Goal: dashboard work\nChanged sessions and compare pages.";
    const before = verifySummary(summary, extraction);
    const patched = patchDeterministic(summary, before.gaps, extraction);
    const after = verifySummary(patched, extraction);
    expect(patched).toContain("## Files Modified");
    expect(patched).toContain("/web/src/pages/sessions.tsx");
    expect(patched).toContain("## Progress");
    expect(after.gaps.some(g => g.kind === "missing-section")).toBe(false);
    expect(after.score).toBeGreaterThan(before.score);
  });

  it("injects missing errors into Critical Context section", () => {
    const extraction = makeExtraction({});
    const summary = "## Goal\nFix bug\n## Critical Context\n- none";
    const patched = patchDeterministic(summary, [{ kind: "missing-error", message: "test failed at line 42" }], extraction);
    expect(patched).toContain("test failed");
  });

  it("injects missing decisions into Key Decisions section", () => {
    const extraction = makeExtraction({});
    const summary = "## Goal\nBuild\n## Key Decisions\n- none\n## Critical Context\n- none";
    const patched = patchDeterministic(summary, [{ kind: "missing-decision", summary: "Use React instead of Vue" }], extraction);
    expect(patched).toContain("Use React instead of Vue");
  });

  it("keeps non-deterministic findings as a Verification Note", () => {
    const extraction = makeExtraction({});
    const summary = "## Goal\nBuild\n## Critical Context\n- none";
    const patched = patchDeterministic(summary, [{ kind: "fabricated-file", ref: "src/fake.ts" }], extraction);
    expect(patched).toContain("Verification Note");
    expect(patched).toContain("Potentially fabricated file: src/fake.ts");
  });
});
