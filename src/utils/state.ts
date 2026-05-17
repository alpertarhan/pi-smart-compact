/**
 * Build structured machine-readable compaction state.
 * Produced alongside the human-readable Markdown summary.
 * Supports cross-compaction tracking and delta computation.
 */

import fs from "node:fs";
import path from "node:path";
import type { StructuredExtraction, OpenLoop, CompactionState, ExplorationReport } from "../types.ts";
import { VERSION } from "../constants.ts";
import * as log from "./logger.ts";

const STATE_DIR = path.join(process.env.HOME ?? "/tmp", ".pi", "agent", ".cache", "smart-compact", "states");

function getStatePath(projectId: string): string {
  return path.join(STATE_DIR, projectId + ".json");
}

/**
 * Persist compaction state for cross-compaction tracking.
 */
export function saveCompactionState(projectId: string, state: CompactionState): void {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(getStatePath(projectId), JSON.stringify(state, null, 2));
  } catch (e) { log.warn("saveCompactionState failed", e); }
}

/**
 * Load previous compaction state for delta computation.
 */
export function loadCompactionState(projectId: string): CompactionState | null {
  try {
    const fp = getStatePath(projectId);
    if (!fs.existsSync(fp)) return null;
    const data = JSON.parse(fs.readFileSync(fp, "utf8")) as CompactionState;
    // Expire after 7 days — updatedAt from v7.8.0+, fallback to file mtime for older states
    if (data.compactionVersion) {
      let updatedAt = data.updatedAt;
      if (!updatedAt) {
        try { updatedAt = fs.statSync(fp).mtimeMs; } catch (e) { log.debug("statSync failed for state file", e); updatedAt = 0; }
      }
      if (Date.now() - updatedAt > 7 * 24 * 60 * 60 * 1000) return null;
    }
    return data;
  } catch (e) { log.warn("loadCompactionState failed", e); return null; }
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
      const bn = extraction.modifiedFiles.find(f => e.message.toLowerCase().includes(f.path.split("/").pop()?.toLowerCase() ?? "__none__"));
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
    sessionType: report?.sessionType ?? "implementation",
    compactionVersion: VERSION,
    updatedAt: Date.now(),
  };
}

/**
 * Inject Open Loops section into the Markdown summary.
 */
export function injectOpenLoopsSection(summary: string, openLoops: OpenLoop[]): string {
  if (!openLoops.length) return summary;

  const lines = [
    "## Open Loops",
    "",
    ...openLoops.map(l => {
      const prio = l.priority === "critical" || l.priority === "high" ? "[" + l.priority + "] " : "";
      const files = l.files.length ? " — " + l.files.join(", ") : "";
      return "- " + prio + l.summary + files;
    }),
    "",
  ];

  // Insert before Next Steps
  const nextStepsIdx = summary.indexOf("## Next Steps");
  if (nextStepsIdx >= 0) {
    return summary.slice(0, nextStepsIdx) + lines.join("\n") + summary.slice(nextStepsIdx);
  }

  // Fallback: append at the end
  return summary + "\n" + lines.join("\n");
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
 * Inject delta section into summary, after Open Loops (or before Next Steps).
 */
export function injectDeltaSection(summary: string, delta: CompactionDelta): string {
  const section = formatDeltaSection(delta);

  // Check if there's anything to report
  const hasChanges = delta.goalChanged
    || delta.resolvedLoops.length > 0
    || delta.newLoops.length > 0
    || delta.newDecisions.length > 0
    || delta.newErrors.length > 0
    || delta.newModifiedFiles.length > 0;
  if (!hasChanges) return summary;

  // Insert after Open Loops or before Next Steps
  const openLoopsIdx = summary.indexOf("## Open Loops");
  const nextStepsIdx = summary.indexOf("## Next Steps");

  if (openLoopsIdx >= 0) {
    // Find end of Open Loops section
    const afterOL = summary.indexOf("## ", openLoopsIdx + 1);
    if (afterOL >= 0) {
      return summary.slice(0, afterOL) + section + summary.slice(afterOL);
    }
  }
  if (nextStepsIdx >= 0) {
    return summary.slice(0, nextStepsIdx) + section + summary.slice(nextStepsIdx);
  }
  return summary + "\n" + section;
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
