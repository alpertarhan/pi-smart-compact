/**
 * Build structured machine-readable compaction state.
 * Produced alongside the human-readable Markdown summary.
 */

import type { StructuredExtraction, OpenLoop, CompactionState, ExplorationReport } from "../types.ts";
import { VERSION } from "../constants.ts";

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
