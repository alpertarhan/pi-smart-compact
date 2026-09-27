/** Session-local, append-only context edits. Original evidence stays in Pi's JSONL. */
import {
  buildSessionProjection, type ProjectedSessionEntry, type SessionBoundaryDraft, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ModelCostRates, ToolCall } from "@earendil-works/pi-ai";
import { TRIM_MARKER_MAX_CHARS, TRIM_MARKER_MAX_LINES, TRIM_RISK_LINE_RE } from "../constants.ts";
import {
  fileOperationPaths, isArchivableToolResult, isReadOnlyResearchTool, isShellTool, normalizeToolName, toolCallSubject,
} from "../domain/tool-semantics.ts";
import { contextMessageEntries } from "../infra/ai-messages.ts";
import { extractText, flattenToolCallBlock, type FlatToolCall } from "../utils/extraction.ts";
import type { LlmMessage } from "../types.ts";
import { makeTokenEstimator } from "../utils/tokens.ts";
import { fingerprintContext } from "./pending-slot.ts";
import { anchorFromEntry } from "./navigation-data.ts";
import { digest } from "./tool-artifacts.ts";

export const CONTEXT_CONTROL_TYPE = "smart-compact-context";
export const CONTEXT_REPORT_TYPE = "smart-compact-rewind";
export const MAX_CONTEXT_EDITS = 512;
export const MAX_TRIM_EDITS = 32;
export const MIN_TRIM_CHARS = 4_096;
const KEEP_RECENT_TURNS = 4;
/** Per-line digest budget so a long first line cannot crowd out risk lines. */
const TRIM_DIGEST_LINE_CHARS = 100;
const TRIM_RISK_LINES = 3;
export const MIN_AUTO_TRIM_SAVING_CHARS = 16_384;
export const AUTO_TRIM_COOLDOWN_TURNS = 8;

/** Pin the latest owned or historically recorded anchor prefix during cleanup. */
export function lastAnchorBoundary(branch: SessionEntry[]): string | undefined {
  let boundary: string | undefined;
  for (const entry of branch) {
    if (!anchorFromEntry(entry)) continue;
    boundary = entry.id;
  }
  return boundary;
}

export interface ContextCheckpoint {
  id: string;
  label: string;
  sessionId: string;
  originId: string;
  snapshot: ReturnType<typeof fingerprintContext>;
}

/** Why a trim was committed: context pressure, warm-cache break-even, cold-cache apply, or an explicit request. */
export type TrimCause = "pressure" | "break-even" | "cold" | "manual" | "agent";
const TRIM_CAUSES: readonly unknown[] = ["pressure", "break-even", "cold", "manual", "agent"] satisfies TrimCause[];

/** Content evidence for an archived output at commit time; `references` stays the authorization list. */
export interface ArchiveRecord { id: string; sha256: string; chars: number }

type ControlData =
  | { version: 1; action: "checkpoint"; checkpoint: ContextCheckpoint }
  | { version: 1; action: "trim"; references: string[]; archives?: ArchiveRecord[]; cause?: TrimCause }
  | { version: 1; action: "rewind"; references: string[]; archives?: ArchiveRecord[] };

function controlData(entry: SessionEntry): ControlData | null {
  if (entry.type !== "custom" || entry.customType !== CONTEXT_CONTROL_TYPE) return null;
  const data = entry.data as Partial<ControlData> | null;
  if (!data || data.version !== 1) return null;
  if (data.action === "checkpoint") {
    const cp = data.checkpoint;
    if (cp && typeof cp.id === "string" && cp.id.length <= 128 && typeof cp.label === "string" && cp.label.length <= 120
      && typeof cp.originId === "string" && cp.originId.length <= 128 && typeof cp.sessionId === "string"
      && cp.snapshot && Number.isSafeInteger(cp.snapshot.messageCount) && cp.snapshot.messageCount >= 0
      && typeof cp.snapshot.hash === "string" && /^[a-f0-9]{64}$/.test(cp.snapshot.hash)) return data as ControlData;
  } else if ((data.action === "trim" || data.action === "rewind") && Array.isArray(data.references)
    && data.references.length <= MAX_CONTEXT_EDITS && data.references.every(id => typeof id === "string" && id.length <= 128)
    && (!("archives" in data) || (Array.isArray(data.archives) && data.archives.length <= MAX_CONTEXT_EDITS
      && data.archives.every((item: Partial<ArchiveRecord> | null) => item && typeof item.id === "string" && item.id.length <= 128
        && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256) && Number.isSafeInteger(item.chars) && item.chars! >= 0)))
    && (data.action !== "trim" || !("cause" in data) || TRIM_CAUSES.includes(data.cause))) {
    return data as ControlData;
  }
  return null;
}

export function contextControlEntry(data: ControlData): SessionBoundaryDraft {
  return { type: "custom", customType: CONTEXT_CONTROL_TYPE, data };
}

export function inspectContext(branch: SessionEntry[], sessionId: string) {
  let checkpoint: ContextCheckpoint | null = null;
  let checkpointIndex = -1;
  let invalidReason: string | undefined;
  const references = new Set<string>();
  const archives = new Map<string, Omit<ArchiveRecord, "id">>();
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index];
    const data = controlData(entry);
    // A foreign edit revokes raw recovery; only a following owned archive record re-authorizes it.
    if (entry.type === "context_edit") references.delete(entry.targetId);
    if (data?.action === "checkpoint") {
      checkpoint = data.checkpoint;
      checkpointIndex = index;
      invalidReason = undefined;
    } else if (data) {
      const recorded = new Map(data.archives?.map(({ id, sha256, chars }) => [id, { sha256, chars }]));
      // The newest owned record listing an id decides its hash; a record without one (legacy) clears it.
      for (const id of data.references) {
        references.add(id);
        const archive = recorded.get(id);
        if (archive) archives.set(id, archive); else archives.delete(id);
      }
      if (data.action === "rewind") { checkpoint = null; checkpointIndex = -1; invalidReason = undefined; }
    } else if (entry.type === "custom" && entry.customType === CONTEXT_CONTROL_TYPE) {
      checkpoint = null;
      invalidReason = "Checkpoint metadata is invalid; create a new checkpoint.";
    }
  }
  if (checkpoint) {
    const { originId } = checkpoint;
    const suffix = branch.slice(checkpointIndex + 1);
    if (checkpoint.sessionId !== sessionId || !branch.slice(0, checkpointIndex).some(entry => entry.id === originId)) {
      invalidReason = "Checkpoint belongs to a different session or branch.";
    } else if (suffix.some(entry => entry.type === "compaction" || entry.type === "branch_summary")) {
      invalidReason = "Compaction or branch navigation occurred after the checkpoint.";
    } else if (suffix.some(entry => entry.type === "message" && entry.message.role === "user")) {
      invalidReason = "New user instructions arrived after the checkpoint.";
    } else {
      const prefix = contextMessageEntries(branch).slice(0, checkpoint.snapshot.messageCount);
      const current = fingerprintContext(prefix);
      if (current.messageCount !== checkpoint.snapshot.messageCount || current.hash !== checkpoint.snapshot.hash) {
        invalidReason = "The checkpoint's earlier context has changed.";
      }
    }
  }
  return { checkpoint: invalidReason ? null : checkpoint, checkpointIndex, invalidReason, references, archives };
}

/**
 * Complete call/result groups whose every call passes `admit`, mapped to each result's call
 * block (undefined for the assistant entry). One failing or non-text result keeps the whole group.
 */
function toolGroups(branch: SessionEntry[], admit: (call: FlatToolCall) => boolean): Map<string, ToolCall | undefined> {
  const ids = new Map<string, ToolCall | undefined>();
  const projected = buildSessionProjection(branch).entries;
  for (let index = 0; index < projected.length; index++) {
    const { sourceEntry, messages } = projected[index];
    const message = messages[0];
    if (sourceEntry.type !== "message" || message?.role !== "assistant"
      || !["stop", "toolUse"].includes(message.stopReason)) continue;
    const calls = message.content.filter(block => block.type === "toolCall");
    if (!calls.every(block => { const flat = flattenToolCallBlock(block); return flat.length > 0 && flat.every(admit); })) continue;
    const pending = new Map(calls.map(call => [call.id, call]));
    const results: [string, ToolCall][] = [];
    let unsafe = false;
    for (let next = index + 1; next < projected.length; next++) {
      const candidate = projected[next];
      const msg = candidate.messages[0];
      if (msg?.role === "assistant" || msg?.role === "user") break;
      const call = msg?.role === "toolResult" ? pending.get(msg.toolCallId) : undefined;
      if (msg?.role !== "toolResult" || !call) continue;
      if (msg.isError || msg.content.some(block => block.type !== "text")) unsafe = true;
      pending.delete(msg.toolCallId);
      results.push([candidate.sourceEntry.id, call]);
    }
    if (!unsafe && pending.size === 0) {
      ids.set(sourceEntry.id, undefined);
      for (const [id, call] of results) ids.set(id, call);
    }
  }
  return ids;
}

/** Keep complete call/result groups, including all siblings if any tool may have side effects. */
export function removableResearch(branch: SessionEntry[]): Set<string> {
  return new Set(toolGroups(branch, call => isReadOnlyResearchTool(call.name, call.arguments)).keys());
}

function digestLine(line: string, max = TRIM_DIGEST_LINE_CHARS): string {
  const clean = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = /[\ud800-\udbff]/.test(clean[max - 2] ?? "") ? max - 2 : max - 1;
  return clean.slice(0, cut) + "…";
}

/**
 * Deterministic trim marker: a retrieval line, then the call's subject (with an optional note),
 * the first output line and up to three risk lines, bounded by TRIM_MARKER_MAX_LINES / TRIM_MARKER_MAX_CHARS.
 */
export function buildTrimMarker(input: { toolName: string; entryId: string; text: string; call?: { name: string; arguments: unknown }; note?: string }): string {
  const { toolName, entryId, text, call, note } = input;
  const args = call?.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : {};
  const origin = call && normalizeToolName(call.name) === "smart_context" && args.action === "read" && typeof args.id === "string"
    ? digestLine(args.id, 64) : "";
  const head = origin && !origin.endsWith("…")
    ? `[Archived smart_context read of id=${origin}, ${text.length} chars. Retrieve with smart_context action=read id=${origin}.]`
    : `[Archived ${digestLine(toolName, 64)} output, ${text.length} chars. Retrieve with smart_context action=read id=${entryId}.]`;
  const suffix = note ? " " + digestLine(note, 48) : "";
  const subject = call ? digestLine(toolCallSubject(call.name, args) ?? "", TRIM_DIGEST_LINE_CHARS - suffix.length) : "";
  const lines = subject ? [subject + suffix] : [];
  const seen = new Set<string>();
  let risks = 0;
  for (const raw of text.split("\n")) {
    if (lines.length + 1 >= TRIM_MARKER_MAX_LINES || risks >= TRIM_RISK_LINES) break;
    const first = seen.size === 0;
    if (!first && !TRIM_RISK_LINE_RE.test(raw)) continue;
    const line = digestLine(raw);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    if (first) lines.push("> " + line);
    else { lines.push("! " + line); risks++; }
  }
  let marker = head;
  for (const line of lines) {
    const room = TRIM_MARKER_MAX_CHARS - marker.length - 1;
    if (line.length <= room) { marker += "\n" + line; continue; }
    if (room >= 16) marker += "\n" + digestLine(line, room);
    break;
  }
  return marker;
}

/** Old results a trim may archive: read-only or shell groups, never side-effecting siblings. */
function archivableResults(branch: SessionEntry[]): Map<string, ToolCall> {
  const groups = toolGroups(branch, call => isReadOnlyResearchTool(call.name, call.arguments) || isShellTool(call.name));
  const results = new Map<string, ToolCall>();
  for (const [id, call] of groups) {
    if (call && flattenToolCallBlock(call).every(flat => isArchivableToolResult(flat.name, flat.arguments))) results.set(id, call);
  }
  return results;
}

type Superseded = "edited" | "reread";
const SUPERSEDED_NOTE: Record<Superseded, string> = { edited: "(superseded: edited later)", reread: "(superseded: read again in full later)" };

/**
 * Results whose read path a later assistant call writes/deletes (`edited`) or reads again in
 * full (`reread`: a plain `read` without `offset`/`limit`; searches, symbol and ranged reads never count).
 */
function supersededResults(projection: ProjectedSessionEntry[], candidates: Map<string, ToolCall>): Map<string, Superseded> {
  const lastWrite = new Map<string, number>();
  const lastRead = new Map<string, number>();
  projection.forEach(({ messages }, index) => {
    const message = messages[0];
    if (message?.role !== "assistant") return;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      for (const flat of flattenToolCallBlock(block)) {
        const { reads, writes } = fileOperationPaths(flat.name, flat.arguments);
        for (const path of writes) lastWrite.set(path, index);
        const full = normalizeToolName(flat.name) === "read" && flat.arguments.offset == null && flat.arguments.limit == null;
        if (full) for (const path of reads) lastRead.set(path, index);
      }
    }
  });
  const result = new Map<string, Superseded>();
  projection.forEach(({ sourceEntry }, index) => {
    const call = candidates.get(sourceEntry.id);
    const reads = call ? flattenToolCallBlock(call).flatMap(flat => fileOperationPaths(flat.name, flat.arguments).reads) : [];
    if (reads.some(path => (lastWrite.get(path) ?? -1) > index)) result.set(sourceEntry.id, "edited");
    else if (reads.some(path => (lastRead.get(path) ?? -1) > index)) result.set(sourceEntry.id, "reread");
  });
  return result;
}

export function planContextTrim(branch: SessionEntry[], afterId?: string) {
  if (afterId && !branch.some(entry => entry.id === afterId)) throw new Error("Trim boundary is not on the active branch.");
  const candidates = archivableResults(branch);
  const boundaries = [afterId, lastAnchorBoundary(branch)].filter((id): id is string => Boolean(id));
  // Keep an active checkpoint's or foreign anchor's prefix stable, including earlier archived outputs.
  const protectedIds = new Set(boundaries.flatMap(id => branch.slice(0, branch.findIndex(entry => entry.id === id) + 1).map(entry => entry.id)));
  const edited = new Set(branch.flatMap(entry => entry.type === "context_edit" ? [entry.targetId] : []));
  const projection = buildSessionProjection(branch).entries;
  const assistantIndexes = projection.flatMap((entry, index) => entry.messages[0]?.role === "assistant" ? [index] : []);
  const cutoff = assistantIndexes.at(-KEEP_RECENT_TURNS) ?? 0;
  const superseded = supersededResults(projection, candidates);
  const rank = (id: string) => { const reason = superseded.get(id); return reason === "edited" ? 0 : reason === "reread" ? 1 : 2; };
  // Superseded outputs first (edited before reread), each group in branch order; the cap then prefers them.
  const eligible = projection.slice(0, cutoff).flatMap(({ sourceEntry, messages }) => {
    const message = messages[0];
    const call = candidates.get(sourceEntry.id);
    if (!call || protectedIds.has(sourceEntry.id) || edited.has(sourceEntry.id) || message?.role !== "toolResult"
      || message.isError || message.content.some(block => block.type !== "text")) return [];
    const text = extractText(message.content);
    return text.length < MIN_TRIM_CHARS ? [] : [{ id: sourceEntry.id, toolName: message.toolName, call, text }];
  }).sort((left, right) => rank(left.id) - rank(right.id)).slice(0, MAX_TRIM_EDITS);
  const entries: SessionBoundaryDraft[] = [];
  const references: string[] = [];
  const archives: ArchiveRecord[] = [];
  let savedChars = 0;
  for (const { id, toolName, call, text } of eligible) {
    const flat = flattenToolCallBlock(call);
    const reason = superseded.get(id);
    const marker = buildTrimMarker({
      toolName, entryId: id, text, call: flat.length === 1 ? flat[0] : undefined, note: reason && SUPERSEDED_NOTE[reason],
    });
    entries.push({ type: "context_edit", targetId: id, replacement: { content: marker } });
    references.push(id);
    archives.push({ id, sha256: digest(text), chars: text.length });
    savedChars += text.length - marker.length;
  }
  const supersededCount = eligible.filter(item => superseded.has(item.id)).length;
  if (entries.length) entries.push(contextControlEntry({ version: 1, action: "trim", references, archives }));
  // Branch-persisted cooldown survives reload/fork; never rewrite a cached prefix every turn.
  const lastChange = branch.findLastIndex(entry => {
    const data = controlData(entry);
    return data?.action === "trim" || data?.action === "rewind" || entry.type === "compaction";
  });
  const turnsSinceChange = branch.slice(lastChange + 1).filter(entry => entry.type === "message" && entry.message.role === "assistant").length;
  const cooldownTurns = lastChange < 0 ? 0 : Math.max(0, AUTO_TRIM_COOLDOWN_TURNS - turnsSinceChange);
  const automatic = savedChars < MIN_AUTO_TRIM_SAVING_CHARS ? "insufficient-savings" : cooldownTurns > 0 ? "cooldown" : "ready";
  return { entries, references, archives, savedChars, automatic, cooldownTurns, superseded: supersededCount };
}

/** The plan's context edits followed by a trim control entry recording `cause`. */
export function trimEntries(plan: { entries: SessionBoundaryDraft[]; references: string[]; archives: ArchiveRecord[] }, cause: TrimCause): SessionBoundaryDraft[] {
  const edits = plan.entries.filter(entry => entry.type === "context_edit");
  return edits.length ? [...edits, contextControlEntry({ version: 1, action: "trim", references: plan.references, archives: plan.archives, cause })] : [];
}

/**
 * Estimated tokens a trim removes (net of markers) and tokens of the rebuilt tail:
 * every projected message from the first edited target on, with markers in place.
 */
export function trimTokens(branch: SessionEntry[], entries: SessionBoundaryDraft[], provider?: string, model?: string) {
  const markers = new Map(entries.flatMap(entry => entry.type === "context_edit" && typeof entry.replacement?.content === "string"
    ? [[entry.targetId, entry.replacement.content] as const] : []));
  const estimator = makeTokenEstimator(provider, model);
  const projected = contextMessageEntries(branch);
  const first = projected.findIndex(entry => markers.has(entry.id));
  let savedTokens = 0;
  let tailTokens = 0;
  for (const { id, message: raw } of first < 0 ? [] : projected.slice(first)) {
    // SAFETY: contextMessageEntries yields convertToLlm() output, i.e. real LLM messages.
    const message = raw as LlmMessage;
    const marker = markers.get(id);
    if (marker === undefined) { tailTokens += estimator.message(message); continue; }
    const kept = estimator.message({ ...message, content: [{ type: "text", text: marker }] });
    savedTokens += estimator.message(message) - kept;
    tailTokens += kept;
  }
  return { savedTokens, tailTokens };
}

/**
 * Further requests after which a warm-cache trim pays back its prefix rewrite:
 * N* = ((w - r) * T) / (r * X), r = cacheRead/input, w = cacheWrite/input (1 when the
 * catalog lists no write surcharge). 0 when cache reads are free; null when the price is unknown.
 */
export function trimBreakEvenRequests(cost: Partial<ModelCostRates> | undefined, savedTokens: number, tailTokens: number): number | null {
  const input = cost?.input;
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0 || savedTokens <= 0) return null;
  const read = cost?.cacheRead;
  const write = cost?.cacheWrite;
  if (typeof read !== "number" || !Number.isFinite(read) || read < 0) return null;
  const r = read / input;
  const w = typeof write === "number" && Number.isFinite(write) && write > 0 ? write / input : 1;
  return r <= 0 ? 0 : ((w - r) * tailTokens) / (r * savedTokens);
}

export function planContextRewind(branch: SessionEntry[], sessionId: string, checkpointId: string, report: string) {
  const state = inspectContext(branch, sessionId);
  if (!state.checkpoint || state.checkpoint.id !== checkpointId) {
    throw new Error(state.invalidReason ?? "No matching active checkpoint; create one before research.");
  }
  const suffixIds = new Set(branch.slice(state.checkpointIndex + 1).map(entry => entry.id));
  const targets = [...removableResearch(branch)].filter(id => suffixIds.has(id));
  if (targets.length > MAX_CONTEXT_EDITS) throw new Error("Research exceeds the rewind edit limit; compact instead.");
  const targetSet = new Set(targets);
  const edited = new Set(branch.flatMap(entry => entry.type === "context_edit" ? [entry.targetId] : []));
  const references: string[] = [];
  const archives: ArchiveRecord[] = [];
  let mismatched = 0;
  for (const entry of branch) {
    if (!targetSet.has(entry.id) || entry.type !== "message" || entry.message.role !== "toolResult"
      || (edited.has(entry.id) && !state.references.has(entry.id))) continue;
    const text = extractText(entry.message.content);
    const sha256 = digest(text);
    const recorded = state.archives.get(entry.id);
    // Removing content is still safe; only recovery of text that no longer matches its record is withheld.
    if (recorded && recorded.sha256 !== sha256) { mismatched++; continue; }
    references.push(entry.id);
    archives.push({ id: entry.id, sha256, chars: text.length });
  }
  const entries: SessionBoundaryDraft[] = targets.map(targetId => ({ type: "context_edit", targetId, replacement: null }));
  const content = `Research handoff (agent-authored, not new user instructions):\n${report}\n\nContext-only rewind: ${targets.length} research messages removed; errors and potentially side-effecting tool batches kept. Files and processes were NOT reverted. Original outputs remain available via smart_context status/read.${mismatched ? ` ${mismatched} archived outputs no longer match their records and are not offered for recovery.` : ""}`;
  entries.push({ type: "custom_message", customType: CONTEXT_REPORT_TYPE, content, display: true });
  entries.push(contextControlEntry({ version: 1, action: "rewind", references, archives }));
  return { entries, removed: targets.length };
}

/** Explicit, branch-local recovery only; never reveal assistant reasoning or arbitrary session entries. */
export function readContextReference(branch: SessionEntry[], sessionId: string, id: string): string {
  const state = inspectContext(branch, sessionId);
  if (!state.references.has(id)) throw new Error("No archived reference with that ID on the active branch.");
  const entry = branch.find(item => item.id === id);
  if (entry?.type !== "message" || entry.message.role !== "toolResult"
    || entry.message.content.some(block => block.type !== "text")) throw new Error("Archived text is unavailable.");
  const text = extractText(entry.message.content);
  const recorded = state.archives.get(id);
  if (recorded && digest(text) !== recorded.sha256) {
    throw new Error(`Archived text for ${id} no longer matches the record made when it was archived (${recorded.chars} chars then, ${text.length} chars now); the session file may have been edited. Nothing was changed.`);
  }
  return text;
}
