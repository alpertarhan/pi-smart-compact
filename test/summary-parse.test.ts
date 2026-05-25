/**
 * Canonical summary parser.
 *
 * Goal: make sure `parseSummary` / `findSection` / `upsertSection` survive the
 * formatting drift that LLMs introduce, and that round-tripping through
 * `renderSummary` doesn't reorder canonical sections.
 */
import { describe, it, expect } from "bun:test";
import { parseSummary, findSection, hasSection, upsertSection, appendToSection, renderSummary } from "../src/domain/summary-parse.ts";

describe("parseSummary", () => {
  it("classifies common section variants", () => {
    const md = "## Goal\nA\n## Constraints & Preferences\nB\n## Progress\nC\n## Key Decisions\nD\n## Files Modified\n- a.ts\n## Files Read\n- b.ts\n## Next Steps\n1. n\n## Critical Context\n- ctx\n## Topics Covered\n- t\n";
    const parsed = parseSummary(md);
    expect(parsed.sections.map(s => s.kind)).toEqual([
      "goal", "constraints", "progress", "decisions", "files-modified",
      "files-read", "next-steps", "critical-context", "topics",
    ]);
  });

  it("tolerates heading drift like # Goal or Goals:", () => {
    // Both H1 and H2 are treated as top-level section starts so a model that
    // emits `# Goal` or `## Goals` ends up in the same `goal` bucket. H3 is
    // deliberately not promoted (see below).
    const md = "# Goal\nA\n## Goals\nB\n";
    const parsed = parseSummary(md);
    expect(parsed.sections.filter(s => s.kind === "goal").length).toBe(2);
  });

  it("keeps H3 sub-headings inside the parent section body", () => {
    // Earlier versions promoted H3 to top level which flattened the
    // Progress -> {Done, In Progress, Blocked} structure into 4 unrelated
    // sections and left Progress empty. We now keep H3 inside the body so
    // verification + delta paths can rely on Progress holding the whole block.
    const md = "## Progress\n### Done\n- a\n### In Progress\n- b\n## Files Modified\n- f.ts\n";
    const parsed = parseSummary(md);
    expect(parsed.sections.map(s => s.kind)).toEqual(["progress", "files-modified"]);
    const progressBody = parsed.sections[0].body;
    expect(progressBody).toContain("### Done");
    expect(progressBody).toContain("### In Progress");
    expect(progressBody).toContain("- a");
    expect(progressBody).toContain("- b");
  });

  it("treats unrelated headings as unknown", () => {
    const parsed = parseSummary("## Some Other Heading\nbody");
    expect(parsed.sections[0].kind).toBe("unknown");
  });
});

describe("findSection / hasSection", () => {
  it("finds by kind without case sensitivity", () => {
    // Canonical classifier lowercases the heading text, so `## goal` and
    // `## GOAL` both resolve to kind=goal. This is the contract that lets
    // verification stop caring about LLM capitalization drift.
    const md = "## goal\nfoo\n";
    expect(hasSection(md, "goal")).toBe(true);
    expect(findSection(md, "goal")?.body).toBe("foo");
  });
});

describe("upsertSection", () => {
  it("replaces an existing section in-place", () => {
    const parsed = parseSummary("## Goal\nold\n## Next Steps\n1. x\n");
    const next = upsertSection(parsed, "goal", "new");
    expect(findSection(next, "goal")?.body).toBe("new");
    expect(next.sections[0].kind).toBe("goal");
    expect(next.sections[1].kind).toBe("next-steps");
  });

  it("inserts before an anchor when adding a new section", () => {
    const parsed = parseSummary("## Goal\ng\n## Next Steps\n1. n\n");
    const next = upsertSection(parsed, "open-loops", "- loop", "next-steps");
    expect(next.sections.map(s => s.kind)).toEqual(["goal", "open-loops", "next-steps"]);
  });

  it("appends when the anchor is missing", () => {
    const parsed = parseSummary("## Goal\ng\n");
    const next = upsertSection(parsed, "open-loops", "- loop", "next-steps");
    expect(next.sections.map(s => s.kind)).toEqual(["goal", "open-loops"]);
  });
});

describe("appendToSection", () => {
  it("appends to an existing section body", () => {
    const parsed = parseSummary("## Files Modified\n- a.ts\n");
    const next = appendToSection(parsed, "files-modified", "- b.ts");
    expect(findSection(next, "files-modified")?.body).toContain("a.ts");
    expect(findSection(next, "files-modified")?.body).toContain("b.ts");
  });

  it("creates the section when missing", () => {
    const parsed = parseSummary("## Goal\ng\n");
    const next = appendToSection(parsed, "critical-context", "- ctx");
    expect(findSection(next, "critical-context")?.body).toBe("- ctx");
  });
});

describe("renderSummary", () => {
  it("preserves heading text by default to keep markdown close to LLM output", () => {
    // H1 stays H1-ish (we emit `## ` prefix on the originally captured label
    // text), but capitalization/spacing of the label is preserved.
    const parsed = parseSummary("# goal\nA\n## NEXT STEPS\nB\n");
    const rendered = renderSummary(parsed);
    expect(rendered).toContain("## goal");
    expect(rendered).toContain("## NEXT STEPS");
  });

  it("normalizes recognized headings when canonicalHeadings is enabled", () => {
    const parsed = parseSummary("# goal\nA\n## NEXT STEPS\nB\n");
    const rendered = renderSummary(parsed, { canonicalHeadings: true });
    expect(rendered).toContain("## Goal");
    expect(rendered).toContain("## Next Steps");
  });
});
