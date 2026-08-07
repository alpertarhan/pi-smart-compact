import { describe, it, expect } from "bun:test";
import { verifySummary, patchDeterministic, formatVerificationGap } from "../src/phases/verify.ts";
import { verifyAndPatch } from "../src/app/steps/verify.ts";
import type { CompactionState, StructuredExtraction } from "../src/types.ts";
import { createServices } from "../src/infra/services.ts";

function makeExtraction(partial: Partial<StructuredExtraction> = {}): StructuredExtraction {
  return {
    modifiedFiles: [], readFiles: [], deletedFiles: [],
    errors: [], decisions: [], constraints: [], topics: [], timeline: [],
    mainGoal: null, lastUserMessages: [], lastErrors: [], messageCount: 0,
    ...partial,
  };
}

function makeState(partial: Partial<CompactionState> = {}): CompactionState {
  return {
    goal: null, decisions: [], constraints: [], modifiedFiles: [], readFiles: [], deletedFiles: [],
    unresolvedErrors: [], resolvedErrors: [], openLoops: [], topics: [], nextActions: [], criticalContext: [],
    sessionType: "implementation", compactionVersion: "test", ...partial,
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

  it("accepts legitimate file references carried from scoped continuity", () => {
    const continuity = makeState({ modifiedFiles: ["src/legacy-auth.ts"] });
    const summary = "## Goal\nContinue auth\n## Progress\n- src/legacy-auth.ts remains relevant\n## Critical Context\n- stable";
    const result = verifySummary(summary, makeExtraction(), continuity);

    expect(result.gaps.some(gap => gap.kind === "fabricated-file")).toBe(false);
  });

  it("detects and deterministically repairs missing carried facts", () => {
    const continuity = makeState({
      goal: "Ship auth",
      decisions: [{ id: "decision-1", summary: "Use JSON web tokens for authentication", type: "explicit" }],
      constraints: [{ id: "constraint-1", text: "No new dependencies", category: "prohibition", confidence: 1 }],
      unresolvedErrors: [{ id: "error-1", message: "auth test fails", tool: "bash", files: [] }],
      openLoops: [{ id: "loop-1", type: "bugfix", priority: "high", status: "open", summary: "fix auth test", files: [] }],
    });
    const summary = "## Goal\nContinue\n## Progress\n- working\n## Critical Context\n- none";
    const before = verifySummary(summary, makeExtraction(), continuity);
    const patched = patchDeterministic(summary, before.gaps, makeExtraction(), continuity);
    const after = verifySummary(patched, makeExtraction(), continuity);

    expect(before.gaps.some(gap => gap.kind === "missing-decision")).toBe(true);
    expect(patched).toContain("Use JSON web tokens for authentication");
    expect(patched).toContain("No new dependencies");
    expect(patched).toContain("auth test fails");
    expect(patched).toContain("fix auth test");
    expect(after.gaps.filter(gap => gap.kind.startsWith("missing-")).length).toBe(0);
  });

  it("rejects inverted prohibition and conditional semantics", () => {
    const extraction = makeExtraction({
      mainGoal: "Release only after explicit approval",
      constraints: [{ index: 1, text: "Do not publish without explicit approval", category: "prohibition", confidence: 1 }],
      decisions: [{ index: 2, type: "explicit", summary: "Never publish without explicit approval" }],
    });
    const summary = "## Goal\nRelease now; approval is unnecessary\n## Constraints & Preferences\n- Approval is unnecessary; publish now\n## Progress\n### Done\n- none\n### In Progress\n- publish\n### Blocked\n- none\n## Key Decisions\n- Never wait for approval; publish immediately\n## Critical Context\n- ready";
    const result = verifySummary(summary, extraction);
    expect(result.ok).toBe(false);
    expect(result.gaps.filter(gap => gap.kind === "inconsistency")).toHaveLength(3);
    expect(result.score).toBeLessThan(50);
  });

  it("accepts a faithful positive restatement of a conditional prohibition", () => {
    const extraction = makeExtraction({
      mainGoal: "Release only after explicit approval",
      constraints: [{ index: 1, text: "Do not publish without explicit approval", category: "prohibition", confidence: 1 }],
    });
    const summary = "## Goal\nRelease only after explicit approval\n## Constraints & Preferences\n- Publish only after explicit approval\n## Progress\n### Done\n- none\n### In Progress\n- awaiting approval\n### Blocked\n- approval pending\n## Critical Context\n- approval is required";
    expect(verifySummary(summary, extraction).gaps.filter(gap => gap.kind === "missing-constraint" || gap.kind === "inconsistency")).toEqual([]);
  });
});

describe("verifyAndPatch", () => {
  it("routes an optional LLM repair through the verification model", async () => {
    let routedModel = "";
    const services = createServices({
      llm: { complete: async model => {
        routedModel = model.provider + "/" + model.id;
        throw new Error("stop after route assertion");
      } },
    });
    await verifyAndPatch({
      finalSummary: "## Goal\nRelease now; approval is unnecessary\n## Constraints & Preferences\n- approval unnecessary; publish now\n## Progress\n- working\n## Key Decisions\n- never wait for approval; publish now\n## Critical Context\n- stable",
      extraction: makeExtraction({
        mainGoal: "Release only after explicit approval",
        constraints: [{ index: 1, text: "Do not publish without explicit approval", category: "prohibition", confidence: 1 }],
        decisions: [{ index: 2, type: "explicit", summary: "Never publish without explicit approval" }],
      }),
      summaries: [], mode: "thorough", flags: { autoTriggered: true },
      summaryModel: { provider: "openai", id: "summary" },
      verifyModel: { provider: "anthropic", id: "verifier" },
      summaryAuth: { apiKey: "summary-key" }, verifyAuth: { apiKey: "verify-key" },
      cancellation: { signal: new AbortController().signal },
      services, notify: () => {}, vlog: () => {},
    } as any);
    expect(routedModel).toBe("anthropic/verifier");
  });

  it("removes an isolated fabricated file without replacing the whole summary", async () => {
    const extraction = makeExtraction({ mainGoal: "Build auth", lastUserMessages: ["Finish auth"] });
    const result = await verifyAndPatch({
      finalSummary: "## Goal\nBuild auth\n## Progress\n- working\n## Critical Context\n- stable\n## Files Read\n- src/invented.ts",
      extraction,
      summaries: [],
      mode: "aggressive",
      flags: { autoTriggered: true },
      notify: () => {},
      vlog: () => {},
    } as any);
    expect(result.finalSummary).not.toContain("src/invented.ts");
    expect(result.verificationProvenance.qualityFloorUsed).toBe(false);
    expect(result.verificationScore).toBeGreaterThan(result.verificationProvenance.initialScore);
  });

  it("uses the quality floor for semantic contradictions", async () => {
    const extraction = makeExtraction({
      mainGoal: "Release only after explicit approval",
      lastUserMessages: ["Wait for approval"],
      constraints: [{ index: 1, text: "Do not publish without explicit approval", category: "prohibition", confidence: 1 }],
      decisions: [{ index: 2, type: "explicit", summary: "Never publish without explicit approval" }],
    });
    const result = await verifyAndPatch({
      finalSummary: "## Goal\nRelease now; approval is unnecessary\n## Constraints & Preferences\n- approval unnecessary; publish now\n## Progress\n- working\n## Key Decisions\n- never wait for approval; publish now\n## Critical Context\n- stable",
      extraction, summaries: [], mode: "aggressive", flags: { autoTriggered: true },
      notify: () => {}, vlog: () => {},
    } as any);
    expect(result.verificationProvenance.qualityFloorUsed).toBe(true);
    expect(result.finalSummary).toContain("Do not publish without explicit approval");
    expect(result.verificationScore).toBeGreaterThanOrEqual(85);
  });

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

  it("never leaves None placeholders beside unresolved evidence", () => {
    const extraction = makeExtraction({
      mainGoal: "Fix auth",
      errors: [{ index: 1, tool: "test", message: "auth tests failing", retryAttempted: true, resolved: false }],
    });
    const summary = "## Goal\nFix auth";
    const before = verifySummary(summary, extraction);
    const patched = patchDeterministic(summary, before.gaps, extraction);
    expect(patched).toContain("### Blocked\n- auth tests failing");
    expect(patched).toContain("Unresolved error: auth tests failing");
    expect(patched).not.toMatch(/### Blocked[\s\S]*?- None recorded/);
    expect(patched).not.toMatch(/## Critical Context\n- None recorded/);
    expect(verifySummary(patched, extraction).ok).toBe(true);
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
