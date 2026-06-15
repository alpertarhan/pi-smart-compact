/**
 * Markdown ↔ CanonicalSummary parser.
 *
 * The synthesis phase produces markdown because LLMs and humans both read it
 * well. Verification, patching, and delta-injection used to operate by
 * lowercasing the markdown and substring-scanning for headings, which gave
 * us a long tail of regex fragility: `## Goal` matched but `### Goal` did not,
 * `Files Modified` matched but `Files modified` had to be lowercased first,
 * etc.
 *
 * This module performs one structural parse up front: every `^#{1,3} ` line
 * becomes a section, and the text between headings becomes its body. After
 * that, the rest of the code can ask `findSection(summary, "goal")` and let
 * the classifier handle aliases.
 *
 * The parser is intentionally tolerant — it accepts H1/H2/H3 and trims
 * surrounding whitespace — because we expect occasional formatting drift from
 * smaller LLMs.
 */

import { CanonicalSummary, Section, SectionKind, classifyHeading, canonicalHeading } from "./summary-schema.ts";

/**
 * When true, `renderSummary` rewrites every recognized section's heading to
 * its canonical form (`## Goal`, `## Next Steps`, ...). This is used by patch
 * paths that want to guarantee verification can find the section regardless
 * of what the LLM emitted. Default behaviour preserves the original heading
 * so user-visible markdown stays close to the model's output.
 */

/**
 * Only H1/H2 lines start a new section. Earlier versions accepted H3 as well,
 * which caused the `## Progress\n### Done\n...\n### In Progress\n...` block
 * to be flattened into 3 separate sections — leaving `Progress` with an empty
 * body and pushing `Done` / `In Progress` to top level. Now H3 stays inside
 * the body of its parent section, which is what every prompt template assumes.
 */
const HEADING_RE = /^(#{1,2})\s+(.+?)\s*$/;

export function parseSummary(markdown: string): CanonicalSummary {
  const sections: Section[] = [];
  const lines = markdown.split("\n");
  let currentHeading = "";
  let currentKind: SectionKind = "unknown";
  let bodyLines: string[] = [];
  let started = false;

  const flush = () => {
    if (!started) return;
    sections.push({
      kind: currentKind,
      heading: currentHeading.trim(),
      body: bodyLines.join("\n").trim(),
    });
  };

  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      flush();
      // Drop the leading hashes so callers see the human label only.
      currentHeading = "## " + m[2].trim();
      currentKind = classifyHeading(m[2]);
      bodyLines = [];
      started = true;
      continue;
    }
    if (started) bodyLines.push(line);
  }
  flush();

  return { sections };
}

/** Find the first section matching the requested kind. */
export function findSection(summary: CanonicalSummary | string, kind: SectionKind): Section | undefined {
  const parsed = typeof summary === "string" ? parseSummary(summary) : summary;
  return parsed.sections.find(s => s.kind === kind);
}

export function hasSection(summary: CanonicalSummary | string, kind: SectionKind): boolean {
  return findSection(summary, kind) !== undefined;
}

/** Stringify the canonical form back to markdown.
 *
 * `opts.canonicalHeadings` rewrites recognized headings to their canonical
 * form. Patch routines turn this on so downstream verification cannot miss a
 * section because the LLM emitted `### Goal` instead of `## Goal`.
 */
export function renderSummary(summary: CanonicalSummary, opts: { canonicalHeadings?: boolean } = {}): string {
  return summary.sections
    .map(s => {
      const heading = opts.canonicalHeadings && s.kind !== "unknown" ? canonicalHeading(s.kind) : s.heading;
      return heading + "\n" + s.body;
    })
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

/**
 * Placement hint for `upsertSection` when inserting a *new* section.
 *
 * `before`/`after` name the *kind* of an existing section that the new entry
 * should anchor against. `before` inserts immediately ahead of the anchor;
 * `after` inserts immediately behind it. When both are given, `before` wins
 * (kept for back-compat with positional callers). When neither anchor is found
 * the section falls back to append-at-end.
 *
 * This is how the synthesis pipeline keeps `Open Loops` ahead of `Next Steps`
 * deterministically, and the delta injector places `Changes Since Last
 * Compaction` directly after `Open Loops` when present.
 */
export interface SectionPlacement {
  before?: SectionKind;
  after?: SectionKind;
}

/**
 * Insert or replace a section. If a section with the same `kind` exists, its
 * heading is replaced with the canonical one and the body is overwritten. If
 * not, the section is inserted according to `placement` (or appended).
 */
export function upsertSection(
  summary: CanonicalSummary,
  kind: SectionKind,
  body: string,
  placement?: SectionKind | SectionPlacement,
): CanonicalSummary {
  const heading = canonicalHeading(kind);
  const existing = summary.sections.findIndex(s => s.kind === kind);
  if (existing >= 0) {
    const sections = summary.sections.slice();
    sections[existing] = { kind, heading, body: body.trim() };
    return { sections };
  }
  // Back-compat: positional callers pass a bare SectionKind as `before`.
  const hint: SectionPlacement = placement == null
    ? {}
    : typeof placement === "string"
      ? { before: placement }
      : placement;
  const section: Section = { kind, heading, body: body.trim() };
  if (hint.before) {
    const idx = summary.sections.findIndex(s => s.kind === hint.before);
    if (idx >= 0) {
      const sections = summary.sections.slice();
      sections.splice(idx, 0, section);
      return { sections };
    }
  }
  if (hint.after) {
    // findLastIndex so duplicate-kind sections insert after the final one.
    let idx = -1;
    for (let i = summary.sections.length - 1; i >= 0; i--) {
      if (summary.sections[i].kind === hint.after) { idx = i; break; }
    }
    if (idx >= 0) {
      const sections = summary.sections.slice();
      sections.splice(idx + 1, 0, section);
      return { sections };
    }
  }
  return { sections: [...summary.sections, section] };
}

/**
 * Append text to an existing section body. If the section is missing, it is
 * created with the provided body. This is the structural equivalent of the
 * old `findOrCreateSectionInsert` helper in `verify.ts`.
 */
export function appendToSection(
  summary: CanonicalSummary,
  kind: SectionKind,
  text: string,
  fallbackBody = "",
): CanonicalSummary {
  const heading = canonicalHeading(kind);
  const idx = summary.sections.findIndex(s => s.kind === kind);
  if (idx >= 0) {
    const sections = summary.sections.slice();
    const existing = sections[idx];
    const combined = existing.body.trim() ? existing.body.trim() + "\n" + text.trim() : text.trim();
    sections[idx] = { kind, heading, body: combined };
    return { sections };
  }
  return upsertSection(summary, kind, (fallbackBody.trim() ? fallbackBody.trim() + "\n" : "") + text.trim());
}
