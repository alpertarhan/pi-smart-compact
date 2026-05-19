/**
 * Session log reader — bypasses pi-toolkit truncation by reading the
 * original untruncated conversation from pi-coding-agent's .jsonl session log.
 *
 * pi-toolkit's context hook mutates branch entries in-place (tool results
 * truncated to `…✂N`), but the disk log retains the original content until
 * pi-coding-agent itself overwrites it on session save. This module reads
 * from the log and falls back to the branch when the log is unavailable.
 *
 * Recovery strategy (ID-based):
 *  - Branch entries each carry a unique `id`.
 *  - The session .jsonl log also records `id` per entry.
 *  - We build a Map<entryId, LlmMessage> from the log and then walk the
 *    branch's toCompact entries in order, substituting the original
 *    (untruncated) message when the id matches. This avoids tail-slice
 *    misalignment completely.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { extractText, TRUNCATE_RE } from "./extraction.ts";
import type { LlmMessage, SessionMessageEntry } from "../types.ts";
import * as log from "./logger.ts";

function getSessionsDir(): string {
  return path.join(process.env.HOME ?? "/tmp", ".pi", "agent", "sessions");
}

interface LogEntry {
  id?: string;
  type?: string;
  timestamp?: string;
  message?: LogMessage;
  cwd?: string;
}

interface LogMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  toolCall?: { id?: string; name?: string; arguments?: Record<string, unknown> };
  isError?: boolean;
  details?: Record<string, unknown>;
  display?: boolean;
}

const LOG_PATH_CACHE_TTL_MS = 30_000;
const logPathCache = new Map<string, { path: string | null; expiresAt: number; home: string }>();
const messageMapCache = new Map<string, { logPath: string; mtimeMs: number; size: number; map: Map<string, LlmMessage> }>();

/**
 * Find the session .jsonl log file for a given session ID.
 *
 * pi-coding-agent stores sessions under ~/.pi/agent/sessions/{cwdHash}/
 * with filenames like 2026-05-19T12-34-56_abc123.jsonl.
 * We try the bare id first, then the glob suffix pattern.
 */
function findSessionLogFile(sessionId: string): string | null {
  try {
    const home = process.env.HOME ?? "/tmp";
    const cached = logPathCache.get(sessionId);
    if (cached && cached.home === home && cached.expiresAt > Date.now()) return cached.path;

    const sessionsDir = getSessionsDir();
    if (!fs.existsSync(sessionsDir)) {
      logPathCache.set(sessionId, { path: null, expiresAt: Date.now() + LOG_PATH_CACHE_TTL_MS, home });
      return null;
    }
    for (const subdir of fs.readdirSync(sessionsDir)) {
      const subdirPath = path.join(sessionsDir, subdir);
      const stat = fs.statSync(subdirPath);
      if (!stat.isDirectory()) continue;

      // Try exact match first (future / alternative layout)
      const exact = path.join(subdirPath, sessionId + ".jsonl");
      if (fs.existsSync(exact)) {
        logPathCache.set(sessionId, { path: exact, expiresAt: Date.now() + LOG_PATH_CACHE_TTL_MS, home });
        return exact;
      }

      // Try glob suffix: *_<sessionId>.jsonl
      const files = fs.readdirSync(subdirPath);
      const match = files.find(f => f.endsWith("_" + sessionId + ".jsonl"));
      if (match) {
        const found = path.join(subdirPath, match);
        logPathCache.set(sessionId, { path: found, expiresAt: Date.now() + LOG_PATH_CACHE_TTL_MS, home });
        return found;
      }
    }
  } catch (e) {
    log.debug("findSessionLogFile failed", e);
  }
  logPathCache.set(sessionId, { path: null, expiresAt: Date.now() + LOG_PATH_CACHE_TTL_MS, home: process.env.HOME ?? "/tmp" });
  return null;
}

/**
 * Normalize a log message entry to the LlmMessage shape used by extraction.
 */
function normalizeLogMessage(msg: LogMessage | undefined): LlmMessage | null {
  if (!msg || !msg.role) return null;

  const role = msg.role;
  if (role === "user" || role === "assistant" || role === "toolResult") {
    return {
      role: role as LlmMessage["role"],
      content: msg.content,
      isError: msg.isError,
      toolCallId: msg.toolCallId,
      timestamp: msg.content && typeof msg.content === "object"
        ? Date.now() // best-effort
        : undefined,
    };
  }
  // Skip custom/pi-status and other non-LLM roles
  return null;
}

/**
 * Check if any message in the array has been truncated by pi-toolkit.
 */
export function hasTruncatedMessages(msgs: LlmMessage[]): boolean {
  return msgs.some(m => TRUNCATE_RE.test(extractText(m.content)));
}

/**
 * Read original (untruncated) messages from the session .jsonl log and
 * build an id → LlmMessage map.
 *
 * Returns null if the log cannot be read or contains no usable entries.
 */
function readOriginalMessageMap(sessionId: string): Map<string, LlmMessage> | null {
  const logPath = findSessionLogFile(sessionId);
  if (!logPath) {
    log.debug("Session log not found for " + sessionId);
    return null;
  }

  try {
    const stat = fs.statSync(logPath);
    const cached = messageMapCache.get(sessionId);
    if (cached && cached.logPath === logPath && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.map;
    }

    const raw = fs.readFileSync(logPath, "utf-8");
    const map = new Map<string, LlmMessage>();

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: LogEntry;
      try {
        entry = JSON.parse(line) as LogEntry;
      } catch {
        continue;
      }
      if (entry.type === "message" && entry.id && entry.message) {
        const normalized = normalizeLogMessage(entry.message);
        if (normalized) map.set(entry.id, normalized);
      }
    }

    log.debug("readOriginalMessageMap: " + map.size + " msgs from " + logPath);
    if (map.size > 0) {
      messageMapCache.set(sessionId, { logPath, mtimeMs: stat.mtimeMs, size: stat.size, map });
      return map;
    }
    return null;
  } catch (e) {
    log.debug("readOriginalMessageMap failed", e);
    return null;
  }
}

/**
 * Build a fallback LlmMessage from a branch entry's message object.
 * Mirrors the convertToLlm logic used in core.ts.
 */
function entryToLlm(entry: SessionMessageEntry): LlmMessage {
  const msg = entry.message as Record<string, unknown>;
  return {
    role: (msg?.role as LlmMessage["role"]) ?? "user",
    content: msg?.content,
    toolCallId: msg?.toolCallId as string | undefined,
    isError: msg?.isError as boolean | undefined,
  };
}

/**
 * Recover untruncated messages by entry-id mapping.
 *
 * For every entry in `toCompactEntries` (the branch prefix we intend to
 * compact), look up its `id` in the session log. If found and the log
 * message is not truncated, use the log version; otherwise fall back to
 * the branch entry itself.
 *
 * This guarantees:
 *  - Exact alignment with the current branch (same count, same order).
 *  - No tail-slice misalignment (pivot/branch changes, compacted msgs in
 *    log are irrelevant because we only ask for ids present in toCompact).
 *  - Graceful degradation: if log read fails, returns null so caller can
 *    keep using the branch.
 *
 * @param sessionId         Current session ID.
 * @param toCompactEntries  Branch entries selected for compaction.
 * @returns Array of LlmMessages aligned 1:1 with toCompactEntries, or
 *          null if the log could not be read.
 */
export function resolveCompactionMessages(
  sessionId: string,
  toCompactEntries: SessionMessageEntry[],
): LlmMessage[] | null {
  const logMap = readOriginalMessageMap(sessionId);
  if (!logMap) return null;

  let restoredCount = 0;
  const result: LlmMessage[] = [];

  for (const entry of toCompactEntries) {
    const logMsg = entry.id ? logMap.get(entry.id) : undefined;
    if (logMsg && !hasTruncatedMessages([logMsg])) {
      result.push(logMsg);
      restoredCount++;
    } else {
      // Fallback to branch entry (may be truncated, but we tried)
      result.push(entryToLlm(entry));
    }
  }

  if (restoredCount > 0) {
    log.info("Session log recovery: " + restoredCount + "/" + toCompactEntries.length + " messages restored from log");
  }

  return result;
}
