/**
 * Canonical summary schema.
 *
 * The summary that smart-compact produces is consumed by humans (in the result
 * screen and `Pending Compaction` banner) but also re-parsed downstream by the
 * verification phase and by the delta extractor. Originally everything spoke
 * Markdown, and verification ran on string `lower.includes("## goal")`-style
 * checks. That meant:
 *
 *  - A model that emitted `### Goal` or `## Goals` slipped past the check and
 *    triggered a false `Missing section` gap.
 *  - Reordering / renaming sections by an aggressive provider caused phantom
 *    gaps that triggered an LLM patch call — burning tokens just to restore
 *    text the summary already contained.
 *  - Adding new sections required touching three modules (synthesize prompts,
 *    verify regexes, delta injectors).
 *
 * The fix is a tiny canonical representation: a discriminated `Section` array
 * with a `kind` tag. Markdown stays the human/LLM interface, but everything we
 * actually *check* runs on the parsed `CanonicalSummary`. Verification asks
 * "does a section with kind=goal exist?", not "does the lowercased string
 * contain '## goal'".
 *
 * We do not try to parse the body of every section into structured fields
 * here. Body text remains free-form so the LLM can express nuance. Specific
 * sections (`progress`, `files-modified`, etc.) have their bodies inspected
 * by helpers in `summary-parse.ts` when the verification logic needs to look
 * deeper.
 */

import {
  SECTION_GOAL, SECTION_CONSTRAINTS, SECTION_PROGRESS, SECTION_DECISIONS,
  SECTION_FILES_MODIFIED, SECTION_FILES_READ, SECTION_NEXT_STEPS,
  SECTION_CRITICAL_CONTEXT, SECTION_TOPICS, SECTION_OPEN_LOOPS, SECTION_CHANGES,
} from "../constants.ts";

export type SectionKind =
  | "goal"
  | "constraints"
  | "progress"
  | "decisions"
  | "files-modified"
  | "files-read"
  | "next-steps"
  | "critical-context"
  | "topics"
  | "open-loops"
  | "changes"
  | "verification-note"
  | "unknown";

export interface Section {
  kind: SectionKind;
  /** Parsed heading with normalized H2 depth; the user-facing label is preserved. */
  heading: string;
  /** Body of the section, leading/trailing whitespace trimmed. */
  body: string;
}

export interface CanonicalSummary {
  sections: Section[];
}

/**
 * Map a free-form heading text to a known `SectionKind`. We match generously
 * because LLMs reshape capitalization and punctuation: `## Goal`, `# Goal`,
 * `Goals:`, `## GOAL` should all resolve to `goal`.
 */
export function classifyHeading(raw: string): SectionKind {
  const text = raw.replace(/^#+\s*/, "").replace(/[:\s]+$/, "").trim().toLowerCase();
  if (!text) return "unknown";
  if (text === "goal" || text === "goals" || text === "objective" || text === "objectives") return "goal";
  if (text.startsWith("constraint") || text.includes("preference")) return "constraints";
  if (text === "progress" || text === "status") return "progress";
  if (text.includes("key decision") || text === "decisions") return "decisions";
  if (text.includes("file") && text.includes("modif")) return "files-modified";
  if (text.includes("file") && (text.includes("read") || text.includes("viewed"))) return "files-read";
  if (text.includes("next step") || text === "next actions") return "next-steps";
  if (text.includes("critical context") || text === "important context") return "critical-context";
  if (text === "topics" || text.includes("topics covered")) return "topics";
  if (text.includes("open loop") || text.includes("unresolved")) return "open-loops";
  if (text.includes("changes since") || text === "changes") return "changes";
  if (text.includes("verification")) return "verification-note";
  return "unknown";
}

/** Canonical heading text used when synthesizing a missing section. */
export function canonicalHeading(kind: SectionKind): string {
  switch (kind) {
    case "goal": return SECTION_GOAL;
    case "constraints": return SECTION_CONSTRAINTS;
    case "progress": return SECTION_PROGRESS;
    case "decisions": return SECTION_DECISIONS;
    case "files-modified": return SECTION_FILES_MODIFIED;
    case "files-read": return SECTION_FILES_READ;
    case "next-steps": return SECTION_NEXT_STEPS;
    case "critical-context": return SECTION_CRITICAL_CONTEXT;
    case "topics": return SECTION_TOPICS;
    case "open-loops": return SECTION_OPEN_LOOPS;
    case "changes": return SECTION_CHANGES;
    case "verification-note": return "## Verification Note";
    case "unknown":
    default: return "## Section";
  }
}
