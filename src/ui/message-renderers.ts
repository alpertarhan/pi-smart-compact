/**
 * Transcript rendering for Smart Compact's own custom messages.
 *
 * `sendMessage` writes one string for two audiences: the model reads it as a
 * user turn, and the host shows it in a box labelled with the type name. The
 * model needs the state and the ref; a human needs plain words. These
 * renderers draw the human view from `details`, so `content` can stay short.
 *
 * Registered unconditionally at extension load: a resumed transcript re-renders
 * old messages even when Hindsight or navigation is now off.
 */

import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { ANCHOR_CUSTOM_TYPE, anchorFromMessage } from "../app/navigation-data.ts";
import { expandHint, metaLine, sanitizeVisible, statusLabel, summarizeLine } from "./tool-rows.ts";

export const MEMORY_STATUS_TYPE = "smart-compact-memory-status";

interface MemoryStatusDetails {
 state?: string;
 ref?: string;
 expired?: boolean;
 title?: string;
 reason?: string;
 lastError?: string;
 total?: number;
 counts?: Record<string, number>;
}

/** Declared in display order: the earlier-saves summary lists states this way. */
const MEMORY_ROW: Record<string, { status: "done" | "pending" | "failed"; text: string }> = {
 completed: { status: "done", text: "saved to Hindsight" },
 failed: { status: "failed", text: "not saved to Hindsight" },
 accepted: { status: "pending", text: "Hindsight is still indexing it; not searchable yet" },
 unknown: { status: "pending", text: "Hindsight result unknown" },
};

/** Details come from persisted or foreign session data: keep only well-typed fields. */
function memoryDetails(value: unknown): MemoryStatusDetails {
 const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
 const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
 return {
  state: text("state"), ref: text("ref"), title: text("title"), reason: text("reason"), lastError: text("lastError"),
  expired: raw.expired === true,
  total: typeof raw.total === "number" ? raw.total : undefined,
  counts: raw.counts && typeof raw.counts === "object" ? (raw.counts as Record<string, number>) : undefined,
 };
}

function memoryStatusRow(theme: Theme, message: { details?: unknown }, expanded: boolean): string[] {
 const details = memoryDetails(message.details);
 if (details.state === "summary") {
  const count = (state: string) => Math.max(0, Number(details.counts?.[state]) || 0);
  const states = Object.keys(MEMORY_ROW);
  const parts = states.filter(state => count(state) > 0).map(state => count(state) + " " + state);
  const total = details.total ?? states.reduce((sum, state) => sum + count(state), 0);
  // Done only when every save completed: a failure fails the row, open saves keep it pending.
  let status: "done" | "pending" | "failed" = "done";
  if (count("accepted") || count("unknown")) status = "pending";
  if (count("failed")) status = "failed";
  return [statusLabel(theme, status) + " " + theme.fg("muted", total + " earlier Hindsight saves: " + parts.join(", "))];
 }
 // Own keys only: a persisted state such as "constructor" must not reach Object.prototype.
 const row = (details.state && Object.hasOwn(MEMORY_ROW, details.state) ? MEMORY_ROW[details.state] : undefined)
  ?? { status: "pending" as const, text: "Hindsight status unavailable" };
 const lines = [statusLabel(theme, row.status) + " " + theme.fg("muted", row.text)];
 if (details.title) lines.push(theme.fg("dim", summarizeLine(details.title, 120)));
 const reason = details.reason ?? details.lastError;
 if (reason && (expanded || row.status !== "done")) lines.push(theme.fg("dim", summarizeLine(reason, 200)));
 if (details.expired) lines.push(theme.fg("dim", "Background tracking stopped at its time limit; the next session checks this save again."));
 if (details.ref && expanded) lines.push(metaLine(theme, "ref", details.ref));
 else if (details.ref) lines.push(expandHint(theme));
 return lines;
}

function anchorRow(theme: Theme, message: { details?: unknown; content?: unknown }, expanded: boolean): string[] {
 const anchor = anchorFromMessage({ role: "custom", customType: ANCHOR_CUSTOM_TYPE, details: message.details });
 if (!anchor) return [theme.fg("muted", "Anchor")];
 const lines = [statusLabel(theme, "done") + " " + theme.fg("muted", "anchor recorded: " + sanitizeVisible(anchor.name))];
 // A handoff seed carries the whole carried-over document in content; its summary is only an excerpt.
 const handoff = typeof message.content === "string" && Boolean((message.details as { handoff?: unknown }).handoff);
 // Anchor text is model or foreign-session data: strip terminal escapes before drawing it.
 if (expanded) lines.push(theme.fg("dim", sanitizeVisible(handoff ? message.content as string : anchor.summary)));
 return lines;
}

/** Both renderers, by custom type. Pure: each reads only its arguments. */
export function createMessageRenderers(): Record<string, MessageRenderer> {
 return {
  [MEMORY_STATUS_TYPE]: (message, { expanded }, theme) =>
   new Text(memoryStatusRow(theme, message, expanded).join("\n"), 0, 0),
  [ANCHOR_CUSTOM_TYPE]: (message, { expanded }, theme) =>
   new Text(anchorRow(theme, message, expanded).join("\n"), 0, 0),
 };
}

export function registerMessageRenderers(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
 if (typeof pi.registerMessageRenderer !== "function") return;
 for (const [customType, renderer] of Object.entries(createMessageRenderers()))
  pi.registerMessageRenderer(customType, renderer);
}
