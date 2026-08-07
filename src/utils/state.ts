/**
 * Build structured machine-readable compaction state.
 * Produced alongside the human-readable Markdown summary.
 * Supports cross-compaction tracking and delta computation.
 */

import fs from "node:fs";
import type {
  StructuredExtraction, OpenLoop, CompactionState, ExplorationReport, SessionType,
  LoopOverride, ContinuityOverride, ContinuityScope,
} from "../types.ts";
import { VERSION, SEVEN_DAYS_MS, TRUNC, ID_PREFIX } from "../constants.ts";
import { inferSessionType, normalizeFactKey } from "./helpers.ts";
import { isDiagnosticConstraintText } from "./extraction.ts";
import * as log from "./logger.ts";
import { compactionStateFile, scopedCompactionStateFile } from "../infra/paths.ts";
import { writeJsonSync, readJsonSync } from "../infra/fs.ts";
import { parseSummary, findSection, upsertSection, renderSummary, appendToSection } from "../domain/summary-parse.ts";
import { buildPathNeedles } from "./file-needles.ts";

function getStatePath(projectId: string, state?: CompactionState): string {
  return state?.scope?.sessionId
    ? scopedCompactionStateFile(projectId, state.scope.sessionId)
    : compactionStateFile(projectId);
}

function isLegacySearchOutput(text: string): boolean {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "";
  return /^[^\s:][^:]*:\d+(?::\d+)?:/.test(firstLine);
}

export function sanitizeCompactionStateEvidence(state: CompactionState): CompactionState {
  const constraints = state.constraints.filter(item => !isDiagnosticConstraintText(item.text));
  const unresolvedErrors = state.unresolvedErrors.filter(item => !isLegacySearchOutput(item.message));
  const openLoops = state.openLoops.filter(item => !isLegacySearchOutput(item.summary));
  if (constraints.length === state.constraints.length &&
      unresolvedErrors.length === state.unresolvedErrors.length &&
      openLoops.length === state.openLoops.length) return state;
  return { ...state, constraints, unresolvedErrors, openLoops };
}

function freshState(fp: string, data: CompactionState | null): CompactionState | null {
  if (!data) return null;
  let updatedAt = data.updatedAt;
  if (!updatedAt) {
    try { updatedAt = fs.statSync(fp).mtimeMs; } catch (e) { log.debug("statSync failed for state file", e); updatedAt = 0; }
  }
  return Date.now() - updatedAt > SEVEN_DAYS_MS ? null : sanitizeCompactionStateEvidence(data);
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
    writeJsonSync(getStatePath(projectId, state), sanitizeCompactionStateEvidence(state), true);
  } catch (e) { log.warn("saveCompactionState failed", e); }
}

/**
 * Load previous compaction state for delta computation.
 */
export function loadCompactionState(projectId: string): CompactionState | null {
  const fp = getStatePath(projectId);
  return freshState(fp, readJsonSync<CompactionState>(fp));
}

export function loadScopedCompactionState(
  scope: Pick<ContinuityScope, "projectId" | "sessionId">,
  branchEntryIds: readonly string[] = [],
): CompactionState | null {
  const fp = scopedCompactionStateFile(scope.projectId, scope.sessionId);
  const state = freshState(fp, readJsonSync<CompactionState>(fp));
  if (!state?.scope || state.scope.schemaVersion !== 2) return null;
  if (state.scope.projectId !== scope.projectId || state.scope.sessionId !== scope.sessionId) return null;
  if (state.scope.branchHeadId && branchEntryIds.length > 0 && !branchEntryIds.includes(state.scope.branchHeadId)) return null;
  return state;
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

export function upsertContinuityOverride(
  overrides: ContinuityOverride[], kind: ContinuityOverride["kind"], text: string,
  patch: Pick<ContinuityOverride, "status"> & Partial<Pick<ContinuityOverride, "replacement">>,
): ContinuityOverride[] {
  const summaryKey = normalizeFactKey(text);
  const index = overrides.findIndex(item => item.kind === kind && item.summaryKey === summaryKey);
  const next: ContinuityOverride = {
    ...(index >= 0 ? overrides[index] : { id: kind + "-override-" + (overrides.length + 1), kind, summaryKey }),
    ...patch, kind, summaryKey, updatedAt: Date.now(),
  };
  if (index < 0) return [...overrides, next];
  const copy = overrides.slice();
  copy[index] = next;
  return copy;
}

export function applyContinuityOverrides(state: CompactionState, overrides: ContinuityOverride[]): CompactionState {
  const inactive = new Set(
    overrides.filter(item => item.status !== "active").map(item => item.kind + ":" + item.summaryKey),
  );
  const replacements = overrides
    .filter(item => item.status === "superseded" && item.replacement)
    .map(item => "Superseded " + item.kind + ": " + item.replacement);
  const cleanState = sanitizeCompactionStateEvidence(state);
  return {
    ...cleanState,
    decisions: cleanState.decisions.filter(item => !inactive.has("decision:" + normalizeFactKey(item.summary))),
    constraints: cleanState.constraints.filter(item => !inactive.has("constraint:" + normalizeFactKey(item.text))),
    unresolvedErrors: cleanState.unresolvedErrors.filter(item => !inactive.has("error:" + normalizeFactKey(item.message))),
    openLoops: cleanState.openLoops.filter(item => !inactive.has("loop:" + normalizeFactKey(item.summary))),
    criticalContext: mergeBy(replacements, cleanState.criticalContext, normalizeFactKey, 20),
    factOverrides: overrides,
  };
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

function mergeBy<T>(current: T[], previous: T[], key: (item: T) => string, limit: number): T[] {
  const seen = new Set<string>();
  return [...current, ...previous].filter(item => {
    const normalized = key(item);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).slice(0, limit);
}

/**
 * Conservative cross-compaction merge: absence from the latest active window
 * is not evidence that a decision, constraint, error, or loop was resolved.
 * Current facts win, old unresolved facts remain, and every collection is
 * bounded so continuity cannot grow without limit.
 */
export function mergeCompactionStates(previous: CompactionState | null, current: CompactionState): CompactionState {
  if (!previous) return applyContinuityOverrides(current, current.factOverrides ?? []);
  const factOverrides = mergeBy(
    current.factOverrides ?? [], previous.factOverrides ?? [],
    item => item.kind + ":" + item.summaryKey, 50,
  );
  const activeCurrent = applyContinuityOverrides(current, factOverrides);
  const activePrevious = applyContinuityOverrides(previous, factOverrides);
  const resolvedKeys = new Set(activeCurrent.resolvedErrors.map(error => normalizeFactKey(error.message)));
  const decisions = mergeBy(activeCurrent.decisions, activePrevious.decisions, item => normalizeFactKey(item.summary), 30)
    .map((item, index) => ({ ...item, id: ID_PREFIX.DECISION + (index + 1) }));
  const constraints = mergeBy(activeCurrent.constraints, activePrevious.constraints, item => normalizeFactKey(item.text), 30)
    .map((item, index) => ({ ...item, id: "constraint-" + (index + 1) }));
  const unresolvedErrors = mergeBy(
    activeCurrent.unresolvedErrors,
    activePrevious.unresolvedErrors.filter(error => !resolvedKeys.has(normalizeFactKey(error.message))),
    item => normalizeFactKey(item.message),
    15,
  ).map((item, index) => ({ ...item, id: ID_PREFIX.ERROR + (index + 1) }));
  const openLoops = mergeBy(
    activeCurrent.openLoops,
    activePrevious.openLoops.filter(loop => loop.status !== "resolved"),
    item => normalizeFactKey(item.summary),
    25,
  ).map((item, index) => ({ ...item, id: ID_PREFIX.OPEN_LOOP + (index + 1) }));
  const oldGoal = activePrevious.goal && activeCurrent.goal && normalizeFactKey(activePrevious.goal) !== normalizeFactKey(activeCurrent.goal)
    ? ["Previous goal: " + activePrevious.goal]
    : [];
  return applyContinuityOverrides({
    ...activeCurrent,
    goal: activeCurrent.goal ?? activePrevious.goal,
    decisions,
    constraints,
    modifiedFiles: mergeBy(activeCurrent.modifiedFiles, activePrevious.modifiedFiles, normalizeFactKey, 100),
    readFiles: mergeBy(activeCurrent.readFiles, activePrevious.readFiles, normalizeFactKey, 100),
    deletedFiles: mergeBy(activeCurrent.deletedFiles, activePrevious.deletedFiles, normalizeFactKey, 50),
    unresolvedErrors,
    resolvedErrors: mergeBy(activeCurrent.resolvedErrors, activePrevious.resolvedErrors, item => normalizeFactKey(item.message), 20),
    openLoops,
    loopOverrides: mergeBy(activeCurrent.loopOverrides ?? [], activePrevious.loopOverrides ?? [], item => item.summaryKey, 50),
    factOverrides,
    topics: mergeBy(activeCurrent.topics, activePrevious.topics, item => normalizeFactKey(item.title), 30),
    nextActions: mergeBy(activeCurrent.nextActions, activePrevious.nextActions, normalizeFactKey, 15),
    criticalContext: mergeBy([...oldGoal, ...activeCurrent.criticalContext], activePrevious.criticalContext, normalizeFactKey, 20),
    updatedAt: Date.now(),
  }, factOverrides);
}

/** Build the bounded, deterministic context that must survive every generation. */
export function renderContinuityCapsule(state: CompactionState, maxChars = TRUNC.CONTINUITY_CAPSULE, existing = ""): string {
  const haystack = normalizeFactKey(existing);
  const lines: string[] = ["## Continuity Ledger"];
  const add = (label: string, value: string) => {
    const text = value.trim();
    if (!text || haystack.includes(normalizeFactKey(text))) return;
    const line = "- " + label + ": " + text;
    if (lines.join("\n").length + line.length + 1 <= maxChars) lines.push(line);
  };
  if (state.goal) add("Goal", state.goal);
  for (const item of state.constraints) add("Constraint", item.text);
  for (const item of state.decisions) add("Decision", item.summary + (item.userResponse ? " → " + item.userResponse : ""));
  for (const item of state.unresolvedErrors) add("Unresolved error", item.message);
  for (const item of state.openLoops.filter(loop => loop.status !== "resolved")) add("Open loop", item.summary);
  for (const item of state.criticalContext) add("Critical", item);
  return lines.length > 1 ? lines.join("\n") : "";
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
