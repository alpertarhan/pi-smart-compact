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

import { Text, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { ANCHOR_CUSTOM_TYPE, anchorFromMessage } from "../app/navigation-data.ts";
import { expandHint, metaLine, statusLabel, summarizeLine } from "./tool-rows.ts";

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

const MEMORY_ROW: Record<string, { status: "done" | "pending" | "failed"; text: string }> = {
 completed: { status: "done", text: "saved to Hindsight" },
 accepted: { status: "pending", text: "Hindsight is still indexing it; not searchable yet" },
 failed: { status: "failed", text: "not saved to Hindsight" },
 unknown: { status: "pending", text: "Hindsight result unknown" },
};

function memoryStatusRow(theme: Theme, message: { details?: unknown }, expanded: boolean): string[] {
 const details = (message.details ?? {}) as MemoryStatusDetails;
 if (details.state === "summary") {
  const counts = details.counts ?? {};
  const parts = ["completed", "failed", "accepted", "unknown"]
   .map(state => (counts[state] ? counts[state] + " " + state : ""))
   .filter(Boolean);
  return [statusLabel(theme, "done") + " " + theme.fg("muted", details.total + " earlier Hindsight saves: " + parts.join(", "))];
 }
 const row = MEMORY_ROW[details.state ?? ""] ?? { status: "pending" as const, text: "Hindsight status unavailable" };
 const lines = [statusLabel(theme, row.status) + " " + theme.fg("muted", row.text)];
 if (details.title) lines.push(theme.fg("dim", summarizeLine(details.title, 120)));
 const reason = details.reason ?? details.lastError;
 if (reason && (expanded || row.status !== "done")) lines.push(theme.fg("dim", summarizeLine(reason, 200)));
 if (details.expired) lines.push(theme.fg("dim", "Background tracking stopped at its time limit; /smart-compact memory shows the current state."));
 if (details.ref && expanded) lines.push(metaLine(theme, "ref", details.ref));
 else if (details.ref) lines.push(expandHint(theme));
 return lines;
}

function anchorRow(theme: Theme, message: { details?: unknown }, expanded: boolean): string[] {
 const anchor = anchorFromMessage({ role: "custom", customType: ANCHOR_CUSTOM_TYPE, details: message.details });
 if (!anchor) return [theme.fg("muted", "Anchor")];
 const lines = [statusLabel(theme, "done") + " " + theme.fg("muted", "anchor recorded: " + anchor.name)];
 if (expanded) lines.push(theme.fg("dim", anchor.summary));
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
