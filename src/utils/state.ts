/**
 * Build structured machine-readable compaction state.
 * Produced alongside the human-readable Markdown summary.
 * Supports cross-compaction tracking and delta computation.
 */

import fs from "node:fs";
import type { StructuredExtraction, OpenLoop, CompactionState, ExplorationReport, SessionType } from "../types.ts";
import { VERSION } from "../constants.ts";
import { inferSessionType } from "./helpers.ts";
import * as log from "./logger.ts";
import { compactionStateFile } from "../infra/paths.ts";
import { writeJsonSync, readJsonSync } from "../infra/fs.ts";
import { parseSummary, upsertSection, renderSummary, appendToSection } from "../domain/summary-parse.ts";

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
    if (Date.now() - updatedAt > 7 * 24 * 60 * 60 * 1000) return null;
  }
  return data;
}

export function buildCompactionState(
  extraction: StructuredExtraction,
  openLoops: OpenLoop[],
  report: ExplorationReport | null,
  nextActions: string[],
  criticalContext: string[],
): CompactionState {
  let decisionId = 0;
  let constraintId = 0;
  let errorId = 0;

  // Precompute basenames once; previously recomputed for every (error × file) pair.
  const modifiedBasenames = extraction.modifiedFiles.map(f => ({
    path: f.path,
    bn: f.path.split("/").pop()?.toLowerCase() ?? "",
  }));

  return {
    goal: extraction.mainGoal,
    decisions: extraction.decisions.map(d => ({
      id: "decision-" + (++decisionId),
      summary: d.summary.slice(0, 200),
      ...(d.userResponse ? { userResponse: d.userResponse.slice(0, 300) } : {}),
      type: d.type,
    })),
    constraints: extraction.constraints.map(c => ({
      id: "constraint-" + (++constraintId),
      text: c.text.slice(0, 300),
      category: c.category,
      confidence: c.confidence,
    })),
    modifiedFiles: extraction.modifiedFiles.map(f => f.path),
    readFiles: extraction.readFiles,
    deletedFiles: extraction.deletedFiles,
    unresolvedErrors: extraction.errors.filter(e => !e.resolved).map(e => {
      const msgLower = e.message.toLowerCase();
      const bn = modifiedBasenames.find(f => f.bn.length > 0 && msgLower.includes(f.bn));
      return {
        id: "error-" + (++errorId),
        message: e.message.slice(0, 300),
        tool: e.tool,
        files: bn ? [bn.path] : [],
      };
    }),
    resolvedErrors: extraction.errors.filter(e => e.resolved).map(e => ({
      id: "error-" + (++errorId),
      message: e.message.slice(0, 300),
      tool: e.tool,
    })),
    openLoops,
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
  // Decisions: fuzzy match by summary keywords
  const prevDecisionTexts = new Set(prev.decisions.map(d => d.summary.toLowerCase().slice(0, 60)));
  const currDecisionTexts = new Set(current.decisions.map(d => d.summary.toLowerCase().slice(0, 60)));
  const newDecisions = current.decisions
    .filter(d => !prevDecisionTexts.has(d.summary.toLowerCase().slice(0, 60)))
    .map(d => d.summary);
  const removedDecisions = prev.decisions
    .filter(d => !currDecisionTexts.has(d.summary.toLowerCase().slice(0, 60)))
    .map(d => d.summary);

  // Open loops: match by summary fuzzy
  const prevLoopSummaries = new Map(prev.openLoops.map(l => [l.summary.toLowerCase().slice(0, 50), l]));
  const currLoopSummaries = new Map(current.openLoops.map(l => [l.summary.toLowerCase().slice(0, 50), l]));
  const resolvedLoops: string[] = [];
  const persistentLoops: string[] = [];
  for (const [key, loop] of prevLoopSummaries) {
    if (currLoopSummaries.has(key)) {
      persistentLoops.push(loop.summary);
    } else {
      resolvedLoops.push(loop.summary);
    }
  }
  const newLoops = current.openLoops
    .filter(l => !prevLoopSummaries.has(l.summary.toLowerCase().slice(0, 50)))
    .map(l => l.summary);

  // Files: diff sets
  const prevFiles = new Set(prev.modifiedFiles);
  const newModifiedFiles = current.modifiedFiles.filter(f => !prevFiles.has(f));

  // Errors: match by message snippet
  const prevErrorMsgs = new Set(prev.unresolvedErrors.map(e => e.message.toLowerCase().slice(0, 40)));
  const currErrorMsgs = new Set(current.unresolvedErrors.map(e => e.message.toLowerCase().slice(0, 40)));
  const resolvedErrors = prev.unresolvedErrors
    .filter(e => !currErrorMsgs.has(e.message.toLowerCase().slice(0, 40)))
    .map(e => e.message);
  const newErrors = current.unresolvedErrors
    .filter(e => !prevErrorMsgs.has(e.message.toLowerCase().slice(0, 40)))
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

/**
 * Format delta as Markdown section for injection into summary.
 */
export function formatDeltaSection(delta: CompactionDelta): string {
  const lines: string[] = ["## Changes Since Last Compaction", ""];

  if (delta.goalChanged) {
    lines.push("- **Goal shifted**: " + (delta.previousGoal ?? "?") + " → see current goal above");
  }

  if (delta.resolvedLoops.length) {
    lines.push("- **Resolved loops**: " + delta.resolvedLoops.map(s => "~~" + s.slice(0, 60) + "~~").join(", "));
  }
  if (delta.persistentLoops.length) {
    lines.push("- **Still open**: " + delta.persistentLoops.map(s => s.slice(0, 60)).join("; "));
  }
  if (delta.newLoops.length) {
    lines.push("- **New loops**: " + delta.newLoops.map(s => s.slice(0, 60)).join("; "));
  }
  if (delta.newDecisions.length) {
    lines.push("- **New decisions**: " + delta.newDecisions.map(s => s.slice(0, 80)).join("; "));
  }
  if (delta.resolvedErrors.length) {
    lines.push("- **Resolved errors**: " + delta.resolvedErrors.map(s => s.slice(0, 60)).join("; "));
  }
  if (delta.newErrors.length) {
    lines.push("- **New errors**: " + delta.newErrors.map(s => s.slice(0, 60)).join("; "));
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
  const hasChanges = delta.goalChanged
    || delta.resolvedLoops.length > 0
    || delta.newLoops.length > 0
    || delta.newDecisions.length > 0
    || delta.newErrors.length > 0
    || delta.newModifiedFiles.length > 0;
  if (!hasChanges) return summary;

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
  const match = summary.match(/## Next Steps\s*\n([\s\S]*?)(?=##|$)/);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map(l => l.replace(/^\d+\.\s*/, "").trim())
    .filter(l => l.length > 0);
}

/**
 * Extract critical context lines from the summary.
 */
export function extractCriticalContext(summary: string): string[] {
  const match = summary.match(/## Critical Context\s*\n([\s\S]*?)(?=##|$)/);
  if (!match) return [];
  return match[1].split("\n").map(l => l.replace(/^-\s*/, "").trim()).filter(l => l.length > 0);
}
