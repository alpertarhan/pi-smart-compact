/**
 * Canonical summary parser.
 *
 * Goal: make sure `parseSummary` / `findSection` / `upsertSection` survive the
 * formatting drift that LLMs introduce, and that round-tripping through
 * `renderSummary` doesn't reorder canonical sections.
 */
import { describe, it, expect } from "bun:test";
import { parseSummary, findSection, hasSection, upsertSection, appendToSection, renderSummary } from "../src/domain/summary-parse.ts";
import type { SectionPlacement } from "../src/domain/summary-parse.ts";

describe("parseSummary", () => {
  it("classifies common section variants", () => {
    const md = "## Goal\nA\n## Constraints & Preferences\nB\n## Progress\nC\n## Key Decisions\nD\n## Files Modified\n- a.ts\n## Files Read\n- b.ts\n## Next Steps\n1. n\n## Critical Context\n- ctx\n## Topics Covered\n- t\n";
    const parsed = parseSummary(md);
    expect(parsed.sections.map(s => s.kind)).toEqual([
      "goal", "constraints", "progress", "decisions", "files-modified",
      "files-read", "next-steps", "critical-context", "topics",
    ]);
  });

  it("starts sections for H1/H2 and merges recognized aliases", () => {
    const parsed = parseSummary("# Goal\nA\n## Goals\nB\n## Done\nC\n");
    expect(parsed.sections.map(s => s.kind)).toEqual(["goal", "unknown"]);
    expect(parsed.sections[0].body).toBe("A\nB");
  });

  it("starts recognized H3 sections, including an H3-only summary", () => {
    const parsed = parseSummary("### Goal\nBuild it\n### Critical Context\n- Keep this\n### Next Steps\n1. Test it\n");
    expect(parsed.sections.map(s => s.kind)).toEqual(["goal", "critical-context", "next-steps"]);
    expect(findSection(parsed, "goal")?.body).toBe("Build it");
  });

  it("keeps unknown H3 progress subsections inside the parent body", () => {
    const md = "## Progress\n### Done\n- a\n### In Progress\n- b\n### Blocked\n- c\n## Files Modified\n- f.ts\n";
    const parsed = parseSummary(md);
    expect(parsed.sections.map(s => s.kind)).toEqual(["progress", "files-modified"]);
    expect(parsed.sections[0].body).toBe("### Done\n- a\n### In Progress\n- b\n### Blocked\n- c");
  });

  it("merges duplicate canonical kinds, dedupes exact lines, and keeps unknown sections separate", () => {
    const parsed = parseSummary("## Goal\nShared\n- first\n## Custom\none\n### Goal\nShared\n- second\n## Custom\ntwo\n");
    expect(parsed.sections.map(s => s.kind)).toEqual(["goal", "unknown", "unknown"]);
    expect(parsed.sections[0].body).toBe("Shared\n- first\n- second");
    expect(parsed.sections[1].body).toBe("one");
    expect(parsed.sections[2].body).toBe("two");
  });

  it("treats unrelated H1/H2 headings as unknown sections", () => {
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

  it("inserts after an anchor when placement.after is given", () => {
    const parsed = parseSummary("## Goal\ng\n## Open Loops\n- loop\n## Next Steps\n1. n\n");
    const next = upsertSection(parsed, "changes", "- delta", { after: "open-loops" });
    // Order must be: Goal, Open Loops, Changes, Next Steps — changes sits
    // directly behind Open Loops, not appended after Next Steps.
    expect(next.sections.map(s => s.kind)).toEqual(["goal", "open-loops", "changes", "next-steps"]);
  });

  it("inserts before an anchor when placement.before is given", () => {
    const parsed = parseSummary("## Goal\ng\n## Next Steps\n1. n\n");
    const next = upsertSection(parsed, "changes", "- delta", { before: "next-steps" });
    expect(next.sections.map(s => s.kind)).toEqual(["goal", "changes", "next-steps"]);
  });

  it("falls back to append when neither placement anchor exists", () => {
    const parsed = parseSummary("## Goal\ng\n");
    const next = upsertSection(parsed, "changes", "- delta", { after: "open-loops" });
    expect(next.sections.map(s => s.kind)).toEqual(["goal", "changes"]);
  });

  it("treats a bare SectionKind as the legacy positional `before` arg", () => {
    const parsed = parseSummary("## Goal\ng\n## Next Steps\n1. n\n");
    const next = upsertSection(parsed, "open-loops", "- loop", "next-steps");
    expect(next.sections.map(s => s.kind)).toEqual(["goal", "open-loops", "next-steps"]);
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

  it("round-trips H3-only summaries deterministically", () => {
    const once = renderSummary(parseSummary("### Goal\nA\n### Next Steps\n- B\n"));
    expect(renderSummary(parseSummary(once))).toBe(once);
  });
});
