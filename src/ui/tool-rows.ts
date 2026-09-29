/**
 * Shared, PURE rendering helpers for the Smart Compact tool rows.
 *
 * Every function here is synchronous, side-effect free, and reads nothing
 * but its arguments: a tool row is a call-time snapshot and must never
 * trigger implicit polling, filesystem reads, or network requests. Missing
 * or malformed details degrade to a visible raw-text fallback — never to a
 * generic success row — and control characters are sanitized before any
 * text reaches the terminal.
 */

import { stripVTControlCharacters } from "node:util";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";

/** Honest terminal states; each maps to a semantic theme color AND a word,
 * so status never rides on color alone. */
export type RowStatus =
	| "done"
	| "queued"
	| "pending"
	| "failed"
	| "cancelled"
	| "skipped"
	| "info";

const STATUS_COLOR: Record<RowStatus, "success" | "warning" | "error" | "dim" | "muted"> = {
	done: "success",
	queued: "dim",
	pending: "warning",
	failed: "error",
	cancelled: "warning",
	skipped: "dim",
	info: "muted",
};

const STATUS_WORD: Record<RowStatus, string> = {
	done: "done",
	queued: "queued",
	pending: "pending",
	failed: "failed",
	cancelled: "cancelled",
	skipped: "skipped",
	info: "",
};

/** Terminal-safe text: strip ANSI/VT sequences with the platform utility
	* first, then remove remaining C0/C1 control characters. Only ever applied
	* to RAW text — never to strings already carrying theme markup. */
export function sanitizeVisible(text: string): string {
	return stripVTControlCharacters(text).replace(
		/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
		" ",
	);
}

/** First text part of a tool result's model content, sanitized; empty when
 * the content carries none. */
export function firstTextContent(
	content: ReadonlyArray<{ type: string; text?: string }> | undefined,
): string {
	const text = content?.find((part) => part.type === "text" && part.text)?.text;
	return text ? sanitizeVisible(text) : "";
}

/** Single-line preview of a possibly long text. */
export function summarizeLine(text: string, maxLength = 120): string {
	const single = sanitizeVisible(text).split(/\r?\n/).find((line) => line.trim()) ?? "";
	const clipped = single.trim().slice(0, maxLength);
	return clipped + (single.trim().length > maxLength ? "…" : "");
}

export function statusLabel(theme: Theme, status: RowStatus): string {
	const word = STATUS_WORD[status];
	return word ? theme.fg(STATUS_COLOR[status], word) : "";
}

/** `key: value` line with a dimmed key. */
export function metaLine(theme: Theme, key: string, value: string): string {
	return theme.fg("dim", key + ":") + " " + sanitizeVisible(value);
}

/** Bounded, expansion-aware preview block. Collapsed shows at most
	* `maxCollapsed` lines, each char-clipped, with an overflow marker; expanded
	* shows EVERY line in full. */
export function previewBlock(
	lines: readonly string[],
	expanded: boolean,
	maxCollapsed: number,
	maxLength = 160,
): string[] {
	const clean = lines.map((line) => sanitizeVisible(line));
	if (expanded) return clean;
	const shown = clean.slice(0, maxCollapsed).map((line) => line.slice(0, maxLength));
	if (clean.length > maxCollapsed) {
		shown.push("… (" + (clean.length - maxCollapsed) + " more)");
	}
	return shown;
}

/** All text parts of model content, sanitized, in order. */
export function allTextParts(
 content: ReadonlyArray<{ type: string; text?: string }> | undefined,
): string[] {
 return (content ?? [])
  .filter((part) => part.type === "text" && part.text)
  .map((part) => sanitizeVisible(part.text as string));
}

/** Type-guarded, sanitized, bounded argument string for call rows:
 * undefined/null/missing fields render as EMPTY (skipped), never the
 * literal "undefined", and hostile control sequences never survive into
 * theme output. */
export function safeArg(
 value: unknown,
 maxLength = 120,
): string {
 if (typeof value !== "string") return "";
 return sanitizeVisible(value).trim().slice(0, maxLength);
}

/** Native expansion hint using the CONFIGURED keybinding (never a
 * hard-coded key); degrades to plain guidance when bindings are
 * unavailable. Pure display — no state, no polling. */
export function expandHint(theme: Theme): string {
 try {
  return theme.fg("dim", keyHint("app.tools.expand", "expand"));
 } catch {
  return theme.fg("dim", "expand tool output for full details");
 }
}

/** Expanded rows never truncate: the status summary first, then the FULL
 * original model content — every tool, every state. Bounded previews are a
 * collapsed-only concern. */
export function expandedRow(
 theme: Theme,
 result: { content?: ReadonlyArray<{ type: string; text?: string }> },
 summaryLines: readonly string[],
): Text {
 const content = allTextParts(result.content).join("\n");
 const head = summaryLines.filter(Boolean).join("\n");
 return new Text(
  head +
  (content ? "\n" + theme.fg("borderMuted", "──────────") + "\n" + content : ""),
  0,
  0,
 );
}

/** The raw-text fallback row: model content shown sanitized, never a
 * fabricated success. Collapsed shows a bounded prefix with an expansion
 * marker; expanded preserves ALL text parts in full — a truncated tail
 * would hide end-of-content identity like Ref lines. */
export function rawFallbackRow(
	theme: Theme,
	result: { content?: ReadonlyArray<{ type: string; text?: string }> },
	expanded: boolean,
): Text {
	const parts = allTextParts(result.content);
	if (!parts.length) {
		return new Text(theme.fg("warning", "No result details available"), 0, 0);
	}
	if (expanded) return new Text(parts.join("\n"), 0, 0);
	const joined = parts.join("\n");
	const bounded = truncateToWidth(joined.split(/\r?\n/)[0] ?? "", 200, "…");
	return new Text(
		bounded + (joined.length > bounded.length ? "\n… (expanded shows full content)" : ""),
		0,
		0,
	);
}

/** Rendering must never break the row: any renderer defect degrades to the
	* visible raw fallback instead of throwing inside the TUI. */
export function tryRow(
	theme: Theme,
	build: () => Text,
	result: { content?: ReadonlyArray<{ type: string; text?: string }> },
	expanded: boolean,
): Text {
	try {
		return build();
	} catch {
		return rawFallbackRow(theme, result, expanded);
		}
}
