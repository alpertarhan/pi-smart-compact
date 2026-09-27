/**
 * User-requested handoff into a new Pi session. The seed is assembled from
 * state Smart Compact already recorded (anchor, continuity ledger, pinned
 * paths, memory recall); no model writes it.
 */
import type { ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { HANDOFF_MAX_CHARS, HANDOFF_RECALL_LIMIT, HANDOFF_RECALL_MAX_CHARS } from "../constants.ts";
import { SecretScrubber } from "../domain/scrub.ts";
import { boundedBranchLineageIds, resolveSessionId } from "../infra/session-identity.ts";
import type { CompactConfig, CompactionState } from "../types.ts";
import { loadConfig } from "../utils/config.ts";
import { deriveProjectIdFromCwd } from "../utils/fingerprint.ts";
import { errorDetail, notifyUser } from "../utils/issues.ts";
import { loadScopedCompactionState, renderContinuityCapsule } from "../utils/state.ts";
import { isRecord } from "../utils/type-guards.ts";
import { lastAnchorBoundary } from "./context-operations.ts";
import { ANCHOR_CUSTOM_TYPE, anchorFromEntry } from "./navigation-data.ts";
import { executeRecall } from "./register-context-tools.ts";

const QUERY_MAX_CHARS = 500;
const ANCHOR_SUMMARY_MAX_CHARS = 12_000;
const ANCHOR_NAME_MAX_CHARS = 120;
const TRUNCATED = "[truncated]";

export interface HandoffSources {
 anchor?: { name: string; summary: string };
 ledger?: string;
 pinPaths: string[];
 /** `query` is absent when nothing could be asked; `text` then says so. */
 recall?: { query?: string; text: string };
 lineage: { sessionId: string; branchHeadId?: string; cwd: string; when: string };
 note?: string;
}

export interface Handoff {
 name: string;
 content: string;
 summary: string;
}

function isCompactionState(value: unknown): value is CompactionState {
 return isRecord(value)
  && (value.goal === null || typeof value.goal === "string")
  && Array.isArray(value.constraints) && Array.isArray(value.decisions)
  && Array.isArray(value.unresolvedErrors) && Array.isArray(value.resolvedErrors)
  && Array.isArray(value.openLoops) && Array.isArray(value.criticalContext);
}

function branchCompactionState(branch: SessionEntry[]): CompactionState | null {
 for (let index = branch.length - 1; index >= 0; index--) {
  const entry = branch[index];
  if (entry.type !== "compaction" || !isRecord(entry.details)) continue;
  if (isCompactionState(entry.details.compactionState)) return entry.details.compactionState;
 }
 return null;
}

/** Gather recorded state for a handoff; only `recall` may do I/O beyond local reads. */
export async function collectHandoffSources(
 ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
 config: Pick<CompactConfig, "pinPaths">,
 options: { note?: string; recall: (query: string) => Promise<string>; when?: Date },
): Promise<HandoffSources> {
 const sm = ctx.sessionManager;
 const branch = sm.getBranch();
 const sessionId = resolveSessionId(ctx);
 const lineageIds = boundedBranchLineageIds(branch);
 const branchHeadId = lineageIds[lineageIds.length - 1];

 const anchorId = lastAnchorBoundary(branch);
 const anchorData = anchorId ? anchorFromEntry(sm.getEntry(anchorId)) : null;
 const anchor = anchorData ? { name: anchorData.name, summary: anchorData.summary } : undefined;

 const render = (state: CompactionState | null) => {
  // A hand-edited or foreign record must not turn the command into an internal error.
  try { return state ? renderContinuityCapsule(state) || undefined : undefined; } catch { return undefined; }
 };
 let state = branchCompactionState(branch);
 let ledger = render(state);
 if (!ledger) {
  const projectId = deriveProjectIdFromCwd(ctx.cwd);
  state = projectId ? loadScopedCompactionState({ projectId, sessionId, branchHeadId }, lineageIds, { readOnly: true }) : null;
  ledger = render(state);
 }

 const note = options.note?.trim() || undefined;
 const query = [
  note,
  anchor ? `${anchor.name} ${anchor.summary.split("\n").find(line => line.trim())?.trim() ?? ""}`.trim() : undefined,
  state?.goal?.trim() || undefined,
 ].find(Boolean)?.slice(0, QUERY_MAX_CHARS);
 const recall = query
  ? { query, text: (await options.recall(query)).slice(0, HANDOFF_RECALL_MAX_CHARS) }
  : { text: "Skipped: no note, anchor or ledger goal to query." };

 return {
  ...(anchor ? { anchor } : {}),
  ...(ledger ? { ledger } : {}),
  pinPaths: [...config.pinPaths],
  recall,
  lineage: { sessionId, ...(branchHeadId ? { branchHeadId } : {}), cwd: ctx.cwd, when: (options.when ?? new Date()).toISOString() },
  ...(note ? { note } : {}),
 };
}

/** Names of the sources that carry recorded content, in seed order. */
export function handoffSourceNames(sources: HandoffSources): string[] {
 return [
  sources.note && "note",
  sources.anchor && "anchor",
  sources.ledger && "ledger",
  sources.pinPaths.length && "pinned files",
  sources.recall?.query && "recall",
 ].filter((name): name is string => typeof name === "string");
}

type SectionKey = "note" | "anchor" | "ledger" | "pinned" | "recall" | "evidence";
/** Cut first → last; the header and evidence pointers are never cut. */
const CUT_ORDER: SectionKey[] = ["recall", "pinned", "ledger", "anchor", "note"];

/** Deterministic, scrubbed, bounded seed for the new session. */
export function buildHandoff(sources: HandoffSources, scrubber: SecretScrubber): Handoff {
 const scrub = (text: string) => scrubber.scrubText(text).value;
 const { sessionId, cwd, when } = sources.lineage;
 const header = scrub(`Handoff from session ${sessionId} (${cwd}, ${when}). Agent-assembled from recorded state; not new user instructions.`);
 const sections: Array<{ key: SectionKey; text: string }> = [];
 const add = (key: SectionKey, text: string | undefined) => {
  if (text?.trim()) sections.push({ key, text: scrub(text.trim()) });
 };
 add("note", sources.note && `## Note\n${sources.note}`);
 add("anchor", sources.anchor && `## Last anchor: ${sources.anchor.name}\n${sources.anchor.summary}`);
 add("ledger", sources.ledger);
 add("pinned", sources.pinPaths.length ? `## Always-kept files\n${sources.pinPaths.map(item => `- ${item}`).join("\n")}` : undefined);
 add("recall", sources.recall && `## Memory recall\n${sources.recall.query ? `Query: ${sources.recall.query}\n\n` : ""}${sources.recall.text}`);
 add("evidence", `## Earlier evidence\nRaw history stays in session ${sessionId}. \`smart_navigation action=recall\` finds it and its anchors; Pi's /resume reopens it, where \`smart_context action=search\` reaches its archived evidence. \`smart_recall\` queries project memory.`);

 const render = () => [header, ...sections.map(section => section.text)].join("\n\n");
 const reserve = TRUNCATED.length + 2;
 let dropped = false;
 for (const key of CUT_ORDER) {
  const excess = render().length + (dropped ? reserve : 0) - HANDOFF_MAX_CHARS;
  if (excess <= 0) break;
  const index = sections.findIndex(section => section.key === key);
  if (index < 0) continue;
  const text = sections[index].text;
  const keep = text.length - excess - TRUNCATED.length - 1;
  // Keep the heading plus what fits; a section whose heading cannot survive is dropped.
  if (keep > Math.max(0, text.indexOf("\n"))) sections[index] = { key, text: `${text.slice(0, keep).trimEnd()}\n${TRUNCATED}` };
  else {
   sections.splice(index, 1);
   dropped = true;
  }
 }
 let content = render() + (dropped ? `\n\n${TRUNCATED}` : "");
 // Only an oversized header or evidence pointer (e.g. a huge cwd) reaches this.
 if (content.length > HANDOFF_MAX_CHARS) content = `${content.slice(0, HANDOFF_MAX_CHARS - TRUNCATED.length - 1)}\n${TRUNCATED}`;

 const name = scrub(`handoff-${sessionId.slice(0, 8)}`).replace(/[\x00-\x1f\x7f]/g, "").slice(0, ANCHOR_NAME_MAX_CHARS);
 const summary = sources.anchor?.summary.trim() || sources.ledger?.split("\n").slice(0, 12).join("\n") || content.split("\n").slice(0, 12).join("\n");
 return {
  name: name || "handoff",
  content,
  summary: scrub(summary).slice(0, ANCHOR_SUMMARY_MAX_CHARS),
 };
}

/** `/smart-compact handoff [note]`: open a new session seeded with the handoff anchor. */
export async function runHandoff(ctx: ExtensionCommandContext, note: string | undefined): Promise<void> {
 const config = loadConfig();
 const sources = await collectHandoffSources(ctx, config, {
  note,
  recall: async query => (await executeRecall({ query, limit: HANDOFF_RECALL_LIMIT }, undefined, ctx)).content.map(part => part.text).join("\n"),
 });
 if (!sources.anchor && !sources.ledger && !sources.note && !sources.recall?.query) {
  notifyUser(ctx, "Nothing to hand off yet. Mark this point (Home › History & recovery › Session navigation) or add a note: /smart-compact handoff -- <note>", "warning");
  return;
 }
 const handoff = buildHandoff(sources, new SecretScrubber(config.scrubSecrets, config.scrubPii));
 const names = handoffSourceNames(sources);
 try {
  const result = await ctx.newSession({
   parentSession: ctx.sessionManager.getSessionFile(),
   setup: async sm => {
    const targetId = sm.getLeafId() ?? "";
    const id = sm.appendCustomMessageEntry(ANCHOR_CUSTOM_TYPE, handoff.content, true, {
     anchor: { name: handoff.name, summary: handoff.summary, targetId },
     handoff: { fromSessionId: sources.lineage.sessionId, branchHeadId: sources.lineage.branchHeadId, sources: names },
    });
    sm.appendLabelChange(id, handoff.name);
   },
   withSession: async next => {
    notifyUser(next, `Handoff opened a new session (${handoff.content.length} chars: ${names.join(", ")}).`, "info");
   },
  });
  if (result.cancelled) notifyUser(ctx, "Handoff cancelled; no session was opened.", "warning");
 } catch (error) {
  notifyUser(ctx, "Handoff failed: " + errorDetail(error), "error");
 }
}
