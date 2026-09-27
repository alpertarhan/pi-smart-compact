/** Session-local, append-only context edits. Original evidence stays in Pi's JSONL. */
import { buildSessionProjection, type SessionBoundaryDraft, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ModelCostRates } from "@earendil-works/pi-ai";
import { isReadOnlyResearchTool, normalizeToolName } from "../domain/tool-semantics.ts";
import { contextMessageEntries } from "../infra/ai-messages.ts";
import { extractText, flattenToolCallBlock } from "../utils/extraction.ts";
import type { LlmMessage } from "../types.ts";
import { makeTokenEstimator } from "../utils/tokens.ts";
import { fingerprintContext } from "./pending-slot.ts";
import { anchorFromEntry } from "./navigation-data.ts";

export const CONTEXT_CONTROL_TYPE = "smart-compact-context";
export const CONTEXT_REPORT_TYPE = "smart-compact-rewind";
export const MAX_CONTEXT_EDITS = 512;
export const MAX_TRIM_EDITS = 32;
export const MIN_TRIM_CHARS = 4_096;
const KEEP_RECENT_TURNS = 4;
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

type ControlData =
  | { version: 1; action: "checkpoint"; checkpoint: ContextCheckpoint }
  | { version: 1; action: "trim"; references: string[]; cause?: TrimCause }
  | { version: 1; action: "rewind"; references: string[] };

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
      for (const id of data.references) references.add(id);
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
  return { checkpoint: invalidReason ? null : checkpoint, checkpointIndex, invalidReason, references };
}

function readOnlyCall(block: unknown): boolean {
  const calls = flattenToolCallBlock(block);
  return calls.length > 0 && calls.every(call => isReadOnlyResearchTool(call.name, call.arguments));
}

/** Keep complete call/result groups, including all siblings if any tool may have side effects. */
export function removableResearch(branch: SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  const projected = buildSessionProjection(branch).entries;
  for (let index = 0; index < projected.length; index++) {
    const { sourceEntry, messages } = projected[index];
    const message = messages[0];
    if (sourceEntry.type !== "message" || message?.role !== "assistant"
      || !["stop", "toolUse"].includes(message.stopReason)) continue;
    const calls = message.content.filter(block => block.type === "toolCall");
    if (!calls.every(readOnlyCall)) continue;
    const callIds = new Set(calls.map(call => call.id));
    const results: string[] = [];
    let unsafe = false;
    for (let next = index + 1; next < projected.length; next++) {
      const candidate = projected[next];
      const msg = candidate.messages[0];
      if (msg?.role === "assistant" || msg?.role === "user") break;
      if (msg?.role !== "toolResult" || !callIds.has(msg.toolCallId)) continue;
      if (msg.isError || msg.content.some(block => block.type !== "text")) unsafe = true;
      callIds.delete(msg.toolCallId);
      results.push(candidate.sourceEntry.id);
    }
    if (!unsafe && callIds.size === 0) {
      ids.add(sourceEntry.id);
      for (const id of results) ids.add(id);
    }
  }
  return ids;
}

export function planContextTrim(branch: SessionEntry[], afterId?: string) {
  if (afterId && !branch.some(entry => entry.id === afterId)) throw new Error("Trim boundary is not on the active branch.");
  const candidates = removableResearch(branch);
  const boundaries = [afterId, lastAnchorBoundary(branch)].filter((id): id is string => Boolean(id));
  // Keep an active checkpoint's or foreign anchor's prefix stable, including earlier archived outputs.
  const protectedIds = new Set(boundaries.flatMap(id => branch.slice(0, branch.findIndex(entry => entry.id === id) + 1).map(entry => entry.id)));
  const edited = new Set(branch.flatMap(entry => entry.type === "context_edit" ? [entry.targetId] : []));
  const projection = buildSessionProjection(branch).entries;
  const assistantIndexes = projection.flatMap((entry, index) => entry.messages[0]?.role === "assistant" ? [index] : []);
  const cutoff = assistantIndexes.at(-KEEP_RECENT_TURNS) ?? 0;
  const entries: SessionBoundaryDraft[] = [];
  const references: string[] = [];
  let savedChars = 0;
  for (const { sourceEntry, messages } of projection.slice(0, cutoff)) {
    const message = messages[0];
    if (!candidates.has(sourceEntry.id) || protectedIds.has(sourceEntry.id) || edited.has(sourceEntry.id) || message?.role !== "toolResult"
      || message.isError || normalizeToolName(message.toolName) === "smart_context"
      || message.content.some(block => block.type !== "text")) continue;
    const text = extractText(message.content);
    if (text.length < MIN_TRIM_CHARS) continue;
    const marker = `[Archived ${message.toolName} output, ${text.length} chars. Retrieve with smart_context action=read id=${sourceEntry.id}.]`;
    entries.push({ type: "context_edit", targetId: sourceEntry.id, replacement: { content: marker } });
    references.push(sourceEntry.id);
    savedChars += text.length - marker.length;
    if (entries.length >= MAX_TRIM_EDITS) break;
  }
  if (entries.length) entries.push(contextControlEntry({ version: 1, action: "trim", references }));
  // Branch-persisted cooldown survives reload/fork; never rewrite a cached prefix every turn.
  const lastChange = branch.findLastIndex(entry => {
    const data = controlData(entry);
    return data?.action === "trim" || data?.action === "rewind" || entry.type === "compaction";
  });
  const turnsSinceChange = branch.slice(lastChange + 1).filter(entry => entry.type === "message" && entry.message.role === "assistant").length;
  const cooldownTurns = lastChange < 0 ? 0 : Math.max(0, AUTO_TRIM_COOLDOWN_TURNS - turnsSinceChange);
  const automatic = savedChars < MIN_AUTO_TRIM_SAVING_CHARS ? "insufficient-savings" : cooldownTurns > 0 ? "cooldown" : "ready";
  return { entries, references, savedChars, automatic, cooldownTurns };
}

/** The plan's context edits followed by a trim control entry recording `cause`. */
export function trimEntries(plan: { entries: SessionBoundaryDraft[]; references: string[] }, cause: TrimCause): SessionBoundaryDraft[] {
  const edits = plan.entries.filter(entry => entry.type === "context_edit");
  return edits.length ? [...edits, contextControlEntry({ version: 1, action: "trim", references: plan.references, cause })] : [];
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
  const references = branch.flatMap(entry => targetSet.has(entry.id) && entry.type === "message"
    && entry.message.role === "toolResult" && (!edited.has(entry.id) || state.references.has(entry.id)) ? [entry.id] : []);
  const entries: SessionBoundaryDraft[] = targets.map(targetId => ({ type: "context_edit", targetId, replacement: null }));
  const content = `Research handoff (agent-authored, not new user instructions):\n${report}\n\nContext-only rewind: ${targets.length} research messages removed; errors and potentially side-effecting tool batches kept. Files and processes were NOT reverted. Original outputs remain available via smart_context status/read.`;
  entries.push({ type: "custom_message", customType: CONTEXT_REPORT_TYPE, content, display: true });
  entries.push(contextControlEntry({ version: 1, action: "rewind", references }));
  return { entries, removed: targets.length };
}

/** Explicit, branch-local recovery only; never reveal assistant reasoning or arbitrary session entries. */
export function readContextReference(branch: SessionEntry[], sessionId: string, id: string): string {
  if (!inspectContext(branch, sessionId).references.has(id)) throw new Error("No archived reference with that ID on the active branch.");
  const entry = branch.find(item => item.id === id);
  if (entry?.type !== "message" || entry.message.role !== "toolResult"
    || entry.message.content.some(block => block.type !== "text")) throw new Error("Archived text is unavailable.");
  return extractText(entry.message.content);
}
