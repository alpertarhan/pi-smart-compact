/**
 * Build structured machine-readable compaction state.
 * Produced alongside the human-readable Markdown summary.
 * Supports cross-compaction tracking and delta computation.
 */

import fs from "node:fs";
import type { StructuredExtraction, OpenLoop, CompactionState, ExplorationReport, SessionType, LoopOverride } from "../types.ts";
import { VERSION, SEVEN_DAYS_MS, TRUNC, ID_PREFIX } from "../constants.ts";
import { inferSessionType, normalizeFactKey } from "./helpers.ts";
import * as log from "./logger.ts";
import { compactionStateFile } from "../infra/paths.ts";
import { writeJsonSync, readJsonSync } from "../infra/fs.ts";
import { parseSummary, findSection, upsertSection, renderSummary, appendToSection } from "../domain/summary-parse.ts";
import { buildPathNeedles } from "./file-needles.ts";

function getStatePath(projectId: string): string {
  return compactionStateFile(projectId);
}

/**
 * Persist compaction state for cross-compaction tracking.
 *
 * Atomic temp+rename writes via writeJsonSync ensure that a crash mid-save
 * leaves the previous valid state file untouched instead of a truncated JSON
 * blob that would crash the next loadCompactionState parse.
 */
export function saveCompactionState(projectId: string, state: CompactionState): void {
  try {
    writeJsonSync(getStatePath(projectId), state, true);
  } catch (e) { log.warn("saveCompactionState failed", e); }
}

/**
 * Load previous compaction state for delta computation.
 */
export function loadCompactionState(projectId: string): CompactionState | null {
  const fp = getStatePath(projectId);
  const data = readJsonSync<CompactionState>(fp);
  if (!data) return null;
  // Expire after 7 days — updatedAt from v7.8.0+, fallback to file mtime for older states
  if (data.compactionVersion) {
    let updatedAt = data.updatedAt;
    if (!updatedAt) {
      try { updatedAt = fs.statSync(fp).mtimeMs; } catch (e) { log.debug("statSync failed for state file", e); updatedAt = 0; }
    }
    if (Date.now() - updatedAt > SEVEN_DAYS_MS) return null;
  }
  return data;
}

export function applyLoopOverrides(loops: OpenLoop[], overrides: LoopOverride[]): OpenLoop[] {
  // Loop ids are positional (`loop-1`, `loop-2`) and regenerated every run;
  // normalized summary identity is the only stable cross-compaction key.
  const bySummary = new Map(overrides.map(override => [override.summaryKey, override]));
  return loops.map(loop => {
    const override = bySummary.get(normalizeFactKey(loop.summary));
    return override ? {
      ...loop,
      ...(override.status ? { status: override.status } : {}),
      ...(override.priority ? { priority: override.priority } : {}),
    } : loop;
  }).sort((a, b) => {
    const aOverride = bySummary.get(normalizeFactKey(a.summary));
    const bOverride = bySummary.get(normalizeFactKey(b.summary));
    return Number(Boolean(bOverride?.pinned)) - Number(Boolean(aOverride?.pinned));
  });
}

export function upsertLoopOverride(overrides: LoopOverride[], loop: OpenLoop, patch: Partial<Omit<LoopOverride, "id" | "summaryKey">>): LoopOverride[] {
  const summaryKey = normalizeFactKey(loop.summary);
  const index = overrides.findIndex(override => override.summaryKey === summaryKey);
  const next: LoopOverride = { ...(index >= 0 ? overrides[index] : { id: loop.id, summaryKey }), ...patch, id: loop.id, summaryKey };
  if (index < 0) return [...overrides, next];
  const copy = overrides.slice();
  copy[index] = next;
  return copy;
}

export function buildCompactionState(
  extraction: StructuredExtraction,
  openLoops: OpenLoop[],
  report: ExplorationReport | null,
  nextActions: string[],
  criticalContext: string[],
  loopOverrides: LoopOverride[] = [],
): CompactionState {
  let decisionId = 0;
  let constraintId = 0;
  let errorId = 0;

  // Precompute path-suffix needles once (drops generic basenames like index.ts
  // so an error about lib/index.ts doesn't attach to src/index.ts). Same helper
  // extractOpenLoops uses, keeping error→file attribution consistent pipeline-wide.
  const fileNeedles = extraction.modifiedFiles.map(f => ({ path: f.path, needles: buildPathNeedles(f.path) }));

  return {
    goal: extraction.mainGoal,
    decisions: extraction.decisions.map(d => ({
      id: ID_PREFIX.DECISION + (++decisionId),
      summary: d.summary.slice(0, TRUNC.DECISION_SUMMARY),
      ...(d.userResponse ? { userResponse: d.userResponse.slice(0, TRUNC.USER_RESPONSE) } : {}),
      type: d.type,
    })),
    constraints: extraction.constraints.map(c => ({
      id: "constraint-" + (++constraintId),
      text: c.text.slice(0, TRUNC.CONSTRAINT_TEXT),
      category: c.category,
      confidence: c.confidence,
    })),
    modifiedFiles: extraction.modifiedFiles.map(f => f.path),
    readFiles: extraction.readFiles,
    deletedFiles: extraction.deletedFiles,
    unresolvedErrors: extraction.errors.filter(e => !e.resolved).map(e => {
      const msgLower = e.message.toLowerCase();
      const match = fileNeedles.find(({ needles }) => needles.some(n => msgLower.includes(n)));
      return {
        id: ID_PREFIX.ERROR + (++errorId),
        message: e.message.slice(0, TRUNC.MESSAGE),
        tool: e.tool,
        files: match ? [match.path] : [],
      };
    }),
    resolvedErrors: extraction.errors.filter(e => e.resolved).map(e => ({
      id: ID_PREFIX.ERROR + (++errorId),
      message: e.message.slice(0, TRUNC.MESSAGE),
      tool: e.tool,
    })),
    openLoops,
    ...(loopOverrides.length ? { loopOverrides } : {}),
    topics: extraction.topics.map((t, i) => ({
      title: t.primaryFile ? t.primaryFile.split("/").pop() + " (" + t.type + ")" : "Topic " + (i + 1),
      type: t.type,
      priority: t.errorDensity > 2 ? "high" : "normal",
    })),
    nextActions,
    criticalContext,
    sessionType: inferSessionType(extraction, report),
    compactionVersion: VERSION,
    updatedAt: Date.now(),
  };
}

/**
 * Inject Open Loops section into the Markdown summary.
 *
 * Implementation goes through the canonical summary parser so that string
 * variants of "## Next Steps" (different capitalization, an extra blank line,
 * H3 instead of H2) still result in `Open Loops` being placed *before* the
 * next-steps section. Falls back to append-at-end when the section is absent.
 */
export function injectOpenLoopsSection(summary: string, openLoops: OpenLoop[]): string {
  if (!openLoops.length) return summary;

  const body = openLoops.map(l => {
    const prio = l.priority === "critical" || l.priority === "high" ? "[" + l.priority + "] " : "";
    const files = l.files.length ? " — " + l.files.join(", ") : "";
    return "- " + prio + l.summary + files;
  }).join("\n");

  const parsed = parseSummary(summary);
  const updated = upsertSection(parsed, "open-loops", body, "next-steps");
  return renderSummary(updated);
}

/**
 * Compute delta between previous and current compaction state.
 */
export interface CompactionDelta {
  /** Decisions added since last compaction */
  newDecisions: string[];
  /** Decisions that appear to have been superseded or removed */
  removedDecisions: string[];
  /** Open loops that were resolved */
  resolvedLoops: string[];
  /** Open loops still open from last time */
  persistentLoops: string[];
  /** New open loops */
  newLoops: string[];
  /** Files modified since last compaction */
  newModifiedFiles: string[];
  /** Errors that were resolved since last compaction */
  resolvedErrors: string[];
  /** New unresolved errors */
  newErrors: string[];
  /** Goal changed? */
  goalChanged: boolean;
  /** Previous goal if changed */
  previousGoal: string | null;
}

export function computeDelta(prev: CompactionState, current: CompactionState): CompactionDelta {
  // Match on full normalized text. Extraction is deterministic, so the same
  // item yields identical text across compactions — the old `slice(0, N)` prefix
  // keys collided two different items that shared an opening and made the
  // change invisible in the delta (newDecisions/removedDecisions both empty).
  const key = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

  // Decisions
  const prevDecisionTexts = new Set(prev.decisions.map(d => key(d.summary)));
  const currDecisionTexts = new Set(current.decisions.map(d => key(d.summary)));
  const newDecisions = current.decisions
    .filter(d => !prevDecisionTexts.has(key(d.summary)))
    .map(d => d.summary);
  const removedDecisions = prev.decisions
    .filter(d => !currDecisionTexts.has(key(d.summary)))
    .map(d => d.summary);

  // Open loops (summaries are already bounded to ~120 chars at extraction time)
  const prevLoopSummaries = new Map(prev.openLoops.filter(loop => loop.status !== "resolved").map(l => [key(l.summary), l]));
  const currLoopKeys = new Set(current.openLoops.filter(loop => loop.status !== "resolved").map(l => key(l.summary)));
  const resolvedLoops: string[] = [];
  const persistentLoops: string[] = [];
  for (const [k, loop] of prevLoopSummaries) {
    if (currLoopKeys.has(k)) persistentLoops.push(loop.summary);
    else resolvedLoops.push(loop.summary);
  }
  const newLoops = current.openLoops
    .filter(loop => loop.status !== "resolved")
    .filter(l => !prevLoopSummaries.has(key(l.summary)))
    .map(l => l.summary);

  // Files: diff sets
  const prevFiles = new Set(prev.modifiedFiles);
  const newModifiedFiles = current.modifiedFiles.filter(f => !prevFiles.has(f));

  // Errors (messages bounded to ~300 chars at build time)
  const prevErrorMsgs = new Set(prev.unresolvedErrors.map(e => key(e.message)));
  const currErrorMsgs = new Set(current.unresolvedErrors.map(e => key(e.message)));
  const resolvedErrors = prev.unresolvedErrors
    .filter(e => !currErrorMsgs.has(key(e.message)))
    .map(e => e.message);
  const newErrors = current.unresolvedErrors
    .filter(e => !prevErrorMsgs.has(key(e.message)))
    .map(e => e.message);

  // Goal change
  const goalChanged = prev.goal !== current.goal && prev.goal !== null && current.goal !== null;

  return {
    newDecisions, removedDecisions,
    resolvedLoops, persistentLoops, newLoops,
    newModifiedFiles,
    resolvedErrors, newErrors,
    goalChanged, previousGoal: goalChanged ? prev.goal : null,
  };
}

export function hasDeltaChanges(delta: CompactionDelta): boolean {
  return delta.goalChanged
    || delta.removedDecisions.length > 0
    || delta.resolvedLoops.length > 0
    || delta.newLoops.length > 0
    || delta.newDecisions.length > 0
    || delta.resolvedErrors.length > 0
    || delta.newErrors.length > 0
    || delta.newModifiedFiles.length > 0;
}

/**
 * Format delta as Markdown section for injection into summary.
 */
export function formatDeltaSection(delta: CompactionDelta): string {
  const lines: string[] = ["## Changes Since Last Compaction", ""];

  if (delta.goalChanged) {
    lines.push("- **Goal shifted**: " + (delta.previousGoal ?? "?") + " → see current goal above");
  }

  if (delta.resolvedLoops.length) {
    lines.push("- **Resolved loops**: " + delta.resolvedLoops.map(s => "~~" + s.slice(0, TRUNC.DECISION_DETAIL) + "~~").join(", "));
  }
  if (delta.persistentLoops.length) {
    lines.push("- **Still open**: " + delta.persistentLoops.map(s => s.slice(0, TRUNC.DECISION_DETAIL)).join("; "));
  }
  if (delta.newLoops.length) {
    lines.push("- **New loops**: " + delta.newLoops.map(s => s.slice(0, TRUNC.DECISION_DETAIL)).join("; "));
  }
  if (delta.newDecisions.length) {
    lines.push("- **New decisions**: " + delta.newDecisions.map(s => s.slice(0, TRUNC.SNIPPET)).join("; "));
  }
  if (delta.removedDecisions.length) {
    lines.push("- **Removed decisions**: " + delta.removedDecisions.map(s => "~~" + s.slice(0, TRUNC.SNIPPET) + "~~").join("; "));
  }
  if (delta.resolvedErrors.length) {
    lines.push("- **Resolved errors**: " + delta.resolvedErrors.map(s => s.slice(0, TRUNC.DECISION_DETAIL)).join("; "));
  }
  if (delta.newErrors.length) {
    lines.push("- **New errors**: " + delta.newErrors.map(s => s.slice(0, TRUNC.DECISION_DETAIL)).join("; "));
  }
  if (delta.newModifiedFiles.length) {
    lines.push("- **New files touched**: " + delta.newModifiedFiles.join(", "));
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Inject delta section into summary.
 *
 * Placement priority:
 *  1. Immediately after `## Open Loops` if present.
 *  2. Immediately before `## Next Steps` otherwise.
 *  3. Append at the end.
 *
 * Works on the canonical parsed form, so heading-format drift cannot misorder
 * the delta section.
 */
export function injectDeltaSection(summary: string, delta: CompactionDelta): string {
  if (!hasDeltaChanges(delta)) return summary;

  const body = formatDeltaSection(delta)
    // Drop the heading line; upsertSection adds the canonical one back.
    .replace(/^## Changes Since Last Compaction\s*\n?/i, "")
    .trim();
  if (!body) return summary;

  const parsed = parseSummary(summary);
  const hasOpenLoops = parsed.sections.some(s => s.kind === "open-loops");
  // Placement priority:
  //   1. If an `Open Loops` section exists, anchor the delta directly *after*
  //      it so the reader sees `… Open Loops → Changes → Next Steps …`.
  //   2. Otherwise anchor directly *before* `Next Steps`.
  // The `upsertSection` helper falls back to append-at-end when neither anchor
  // is found, so the delta is never silently dropped.
  const placement = hasOpenLoops
    ? { after: "open-loops" as const }
    : { before: "next-steps" as const };
  const updated = upsertSection(parsed, "changes", body, placement);
  return renderSummary(updated);
}

/**
 * Ensure user-pinned paths ("never compact") appear in the summary. Any pinned
 * path not already mentioned is appended to the Files Read section so it
 * survives compaction regardless of what the LLM chose to include. This is a
 * deterministic, LLM-free guarantee — the pin wins over synthesis output.
 */
export function ensurePinnedPaths(summary: string, pinned: readonly string[]): string {
  if (!pinned.length) return summary;
  const lower = summary.toLowerCase();
  const missing = pinned.filter(p => p && p.trim().length > 0 && !lower.includes(p.toLowerCase()));
  if (!missing.length) return summary;
  const parsed = parseSummary(summary);
  const updated = appendToSection(
    parsed,
    "files-read",
    missing.map(p => "- " + p).join("\n"),
    "- Pinned by config (always preserved):",
  );
  return renderSummary(updated);
}

/**
 * Extract next actions from the summary's "Next Steps" section.
 */
export function extractNextActions(summary: string): string[] {
  // Canonical parser (not a raw `## Next Steps` regex) so H1/H2 and capitalization
  // drift ("## Next steps") still resolve — the rest of the pipeline moved off
  // substring scanning for the same reason.
  const section = findSection(summary, "next-steps");
  if (!section) return [];
  return section.body
    .split("\n")
    .map(l => l.replace(/^\d+\.\s*/, "").trim())
    .filter(l => l.length > 0);
}

/**
 * Extract critical context lines from the summary.
 */
export function extractCriticalContext(summary: string): string[] {
  const section = findSection(summary, "critical-context");
  if (!section) return [];
  return section.body.split("\n").map(l => l.replace(/^-\s*/, "").trim()).filter(l => l.length > 0);
}
