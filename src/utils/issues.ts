/**
 * User-visible problem reporting.
 *
 * Every failure that affects the user (or indicates a bug) goes through
 * `reportIssue`. It is shown once per session per cause key via
 * `ctx.ui.notify` (stderr only when no UI exists), queued when no context is
 * available, and kept in a small history that `/smart-compact metrics` lists.
 * Nothing here is model-visible. Stack traces never reach toasts; the raw
 * error goes to the debug trace only.
 */
import { SecretScrubber } from "../domain/scrub.ts";
import * as log from "./logger.ts";

export type IssueSeverity = "warning" | "error";

export interface IssueInput {
  /** Stable cause key used for dedupe, e.g. "hindsight.auth". */
  key: string;
  /** "Smart Compact: <what happened>. <effect>. <what to do>" (prefix optional). */
  message: string;
  severity?: IssueSeverity;
  /** Raw error for the debug trace only. */
  error?: unknown;
}

export interface IssueRecord {
  key: string;
  severity: IssueSeverity;
  message: string;
  firstAt: number;
  lastAt: number;
  count: number;
}

/** Minimal context surface; both extension and command contexts satisfy it. */
export interface IssueSink {
  hasUI?: boolean;
  /**
   * Background snapshot contexts: routine messages are dropped and reported
   * issues are queued for the next real context instead of shown now.
   */
  silentBackground?: boolean;
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
  sessionManager?: { getSessionId?(): string | undefined };
}

const MAX_HISTORY = 20;
const MAX_QUEUE = 20;
const MAX_MESSAGE_CHARS = 400;
const PREFIX = "Smart Compact: ";

const history = new Map<string, IssueRecord>();
const shownThisSession = new Set<string>();
const queue: IssueRecord[] = [];
let currentSessionId: string | undefined;
const scrubber = new SecretScrubber(true, false);

/** Scrub secrets, collapse to one line, bound length, add the prefix. */
export function formatIssueMessage(message: string): string {
  const oneLine = scrubber
    .scrubText(message)
    .value.replace(/\s*\n\s*at .*$/gs, "")
    .replace(/\s+/g, " ")
    .trim();
  const prefixed = oneLine.startsWith(PREFIX) ? oneLine : PREFIX + oneLine;
  return prefixed.length > MAX_MESSAGE_CHARS
    ? prefixed.slice(0, MAX_MESSAGE_CHARS - 1) + "…"
    : prefixed;
}

/** Literal, scrubbed, single-line error text for embedding in a message. */
export function errorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return scrubber.scrubText(text.split("\n")[0] ?? "").value.trim().slice(0, 200);
}

function sessionOf(sink: IssueSink | undefined): string | undefined {
  try {
    return sink?.sessionManager?.getSessionId?.() || undefined;
  } catch {
    return undefined;
  }
}

function syncSession(sink: IssueSink): void {
  const sessionId = sessionOf(sink);
  if (sessionId && sessionId !== currentSessionId) {
    currentSessionId = sessionId;
    shownThisSession.clear();
  }
}

function deliver(record: IssueRecord, sink: IssueSink): void {
  if (shownThisSession.has(record.key)) return;
  shownThisSession.add(record.key);
  if (sink.hasUI !== false && sink.ui) {
    try {
      sink.ui.notify(record.message, record.severity);
      return;
    } catch {
      // fall through to stderr
    }
  }
  process.stderr.write(record.message + "\n");
}

function remember(input: IssueInput): IssueRecord {
  const now = Date.now();
  const message = formatIssueMessage(input.message);
  const existing = history.get(input.key);
  const record: IssueRecord = existing
    ? { ...existing, message, severity: input.severity ?? existing.severity, lastAt: now, count: existing.count + 1 }
    : { key: input.key, severity: input.severity ?? "warning", message, firstAt: now, lastAt: now, count: 1 };
  history.delete(input.key);
  history.set(input.key, record);
  while (history.size > MAX_HISTORY) history.delete(history.keys().next().value!);
  return record;
}

/**
 * Record a problem for the status history without a toast. Use it when the
 * caller already surfaces the failure (e.g. a returned `false` becomes a
 * visible persistence warning) or when the effect is harmless and expected.
 */
export function recordIssue(input: IssueInput): void {
  if (input.error !== undefined) log.debugError(input.key, input.error);
  remember(input);
}

/**
 * Report a user-visible problem. With a context it is shown now (once per
 * session per key); without one it is queued until `flushIssues(ctx)`.
 */
export function reportIssue(input: IssueInput, sink?: IssueSink): void {
  if (input.error !== undefined) log.debugError(input.key, input.error);
  const record = remember(input);
  if (sink && !sink.silentBackground) {
    syncSession(sink);
    flushIssues(sink);
    deliver(record, sink);
    return;
  }
  if (queue.some((item) => item.key === record.key)) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(record);
}

/** Deliver issues reported where no context was available. */
export function flushIssues(sink: IssueSink): void {
  if (!queue.length || sink.silentBackground) return;
  syncSession(sink);
  const pending = queue.splice(0, queue.length);
  for (const record of pending) deliver(history.get(record.key) ?? record, sink);
}

/**
 * Show a user-facing message. With a UI it goes to ctx.ui.notify. Without
 * one (print/RPC/SDK modes, where notify is a no-op) warnings and errors go
 * to stderr with secrets scrubbed; info stays silent.
 */
export function notifyUser(
  sink: IssueSink | undefined,
  message: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (sink?.silentBackground) return;
  if (sink && sink.hasUI !== false && sink.ui) {
    try {
      sink.ui.notify(message, type);
      return;
    } catch {
      // fall through to stderr for warnings/errors
    }
  }
  if (type === "info") return;
  process.stderr.write(formatIssueMessage(message) + "\n");
}

/** Most recent first. */
export function recentIssues(): IssueRecord[] {
  // The map is kept in last-update order.
  return [...history.values()].reverse();
}

export function formatRecentIssues(now = Date.now()): string {
  const issues = recentIssues();
  if (!issues.length) return "Recent issues: none";
  const lines = ["Recent issues (" + issues.length + "):"];
  for (const issue of issues) {
    const age = Math.max(0, Math.round((now - issue.lastAt) / 1000));
    const when = age < 60 ? age + "s ago" : age < 3600 ? Math.round(age / 60) + "m ago" : Math.round(age / 3600) + "h ago";
    lines.push(
      "  " +
        (issue.severity === "error" ? "✗ " : "⚠ ") +
        when +
        (issue.count > 1 ? " ×" + issue.count : "") +
        " — " +
        issue.message.slice(PREFIX.length),
    );
  }
  return lines.join("\n");
}

export function resetIssuesForTests(): void {
  history.clear();
  shownThisSession.clear();
  queue.length = 0;
  currentSessionId = undefined;
}
