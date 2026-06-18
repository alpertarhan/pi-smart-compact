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
import { sessionsDir as sessionsDirPath } from "../infra/paths.ts";
// LRU helpers live in a sibling module so they can be unit-tested in
// isolation and reused by other bounded caches.
import { lruGet, lruSet } from "./lru.ts";

function getSessionsDir(): string {
  return sessionsDirPath();
}

/**
 * Maximum bytes we'll read from a session log before bailing out. Real
 * sessions are rarely above a few MB; anything above this cap is almost
 * certainly an orphaned log we'd waste seconds parsing. The cap is generous
 * enough (~50MB) that legitimate long sessions still recover.
 */
const MAX_LOG_BYTES = 50 * 1024 * 1024;

/**
 * Streaming JSONL parser.
 *
 * The old implementation called `fs.readFileSync(logPath, "utf-8")` and then
 * `split("\n")` over the whole buffer. For a 30MB log this blocks the event
 * loop for ~200-500ms while we wait for V8 to materialize the giant string,
 * the giant array, and then GC them after the map is built. This streaming
 * variant reads at most `chunkSize` bytes at a time and processes line
 * fragments as they arrive, keeping the peak buffer to one line + chunkSize.
 *
 * We deliberately stay sync — the call-site is on the hot path inside
 * `runSmartCompact` and switching to an async generator would force every
 * caller into async, with no real concurrency benefit (we're not waiting on
 * IO; we're capped on parse throughput).
 */
function* streamJsonlLines(fp: string, chunkSize = 64 * 1024): Generator<string> {
  let fd: number | null = null;
  try {
    fd = fs.openSync(fp, "r");
    const buf = Buffer.allocUnsafe(chunkSize);
    let leftover = "";
    let totalRead = 0;
    for (;;) {
      const bytes = fs.readSync(fd, buf, 0, chunkSize, null);
      if (bytes <= 0) break;
      totalRead += bytes;
      if (totalRead > MAX_LOG_BYTES) {
        log.warn("streamJsonlLines: log file exceeded " + MAX_LOG_BYTES + " bytes, truncating read");
        break;
      }
      // Concatenating the leftover prefix to the new chunk is cheap because
      // the leftover is at most one line long; we never accumulate the full
      // file in memory.
      const data = leftover + buf.subarray(0, bytes).toString("utf-8");
      const lines = data.split("\n");
      // The last entry may be a partial line; keep it for the next iteration.
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) yield line;
      }
    }
    if (leftover.length > 0) yield leftover;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (e) { log.debug("streamJsonlLines closeSync failed", e); }
    }
  }
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

const DEFAULT_CACHE_MAX_ENTRIES = 8;

/**
 * Maximum entries kept per cache. Both caches were previously unbounded:
 * `logPathCache` had a TTL but no size cap, and `messageMapCache` had no
 * eviction at all (only mtime-driven overwrite). In long-running pi
 * processes that hop between many sessions — sub-agent workflows are a
 * common offender — the message-map cache can hold dozens of giant
 * Map<entryId, LlmMessage> instances indefinitely, each potentially many
 * megabytes. We cap both with a tiny LRU: cheap to maintain, never holds
 * more than `getMaxEntries()` sessions, and re-fetching an evicted entry
 * is a single mtime+stream-parse — already fast and rarely triggered.
 *
 * The default (8) is tuned for a typical interactive workflow. Heavy
 * sub-agent orchestration may want a larger window; set
 * `SMART_COMPACT_LOG_CACHE_MAX` in the environment to override. Invalid
 * values (non-numeric, <=0) silently fall back to the default so a typo
 * in `.env` never disables the cache entirely.
 *
 * We read the env on every call (rather than memoizing at module load) so
 * tests can mutate `process.env.SMART_COMPACT_LOG_CACHE_MAX` between cases
 * without reloading the module. The cost is one env lookup + one parseInt
 * per cache write, which is negligible compared with the surrounding fs
 * stat + JSONL parse.
 */
/**
 * @internal Exposed for unit tests; production callers should NOT depend on
 * this directly. Reads `SMART_COMPACT_LOG_CACHE_MAX` from the environment
 * on every call so tests can mutate process.env between cases.
 */
export function _getMaxEntriesForTests(): number {
  return getMaxEntries();
}

function getMaxEntries(): number {
  const raw = process.env.SMART_COMPACT_LOG_CACHE_MAX;
  if (!raw) return DEFAULT_CACHE_MAX_ENTRIES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_MAX_ENTRIES;
}



const logPathCache = new Map<string, { path: string | null; expiresAt: number; home: string }>();
const messageMapCache = new Map<string, { logPath: string; mtimeMs: number; size: number; map: Map<string, LlmMessage> }>();

/** @internal Test-only: drop both module caches between cases. */
export function __resetSessionLogCachesForTests(): void {
  logPathCache.clear();
  messageMapCache.clear();
}

/**
 * Find the session .jsonl log file for a given session ID.
 *
 * pi-coding-agent stores sessions under ~/.pi/agent/sessions/{cwdHash}/
 * with filenames like 2026-05-19T12-34-56_abc123.jsonl.
 * We try the bare id first, then the glob suffix pattern.
 */
function findSessionLogFile(sessionId: string): string | null {
  const home = process.env.HOME ?? "/tmp";
  const now = Date.now();
  const remember = (path: string | null) => {
    lruSet(logPathCache, sessionId, { path, expiresAt: now + LOG_PATH_CACHE_TTL_MS, home }, getMaxEntries());
    return path;
  };

  try {
    const cached = lruGet(logPathCache, sessionId);
    if (cached && cached.home === home && cached.expiresAt > now) return cached.path;

    const sessionsDir = getSessionsDir();
    if (!fs.existsSync(sessionsDir)) return remember(null);

    for (const subdir of fs.readdirSync(sessionsDir)) {
      const subdirPath = path.join(sessionsDir, subdir);
      const stat = fs.statSync(subdirPath);
      if (!stat.isDirectory()) continue;

      // Try exact match first (future / alternative layout)
      const exact = path.join(subdirPath, sessionId + ".jsonl");
      if (fs.existsSync(exact)) return remember(exact);

      // Try glob suffix: *_<sessionId>.jsonl
      const files = fs.readdirSync(subdirPath);
      const match = files.find(f => f.endsWith("_" + sessionId + ".jsonl"));
      if (match) return remember(path.join(subdirPath, match));
    }
  } catch (e) {
    log.debug("findSessionLogFile failed", e);
  }
  return remember(null);
}

/**
 * Normalize a log message entry to the LlmMessage shape used by extraction.
 *
 * `entryTimestamp` is the ISO timestamp recorded on the surrounding log
 * entry; we parse it to epoch ms when valid. The previous implementation
 * stamped `Date.now()` (the recovery wall-clock) gated on whether `content`
 * was an object — a nonsensical condition that also produced chronologically
 * wrong values. The field is currently write-only internally, but using the
 * real timestamp keeps recovered messages consistent with their neighbors.
 */
function normalizeLogMessage(msg: LogMessage | undefined, entryTimestamp?: string): LlmMessage | null {
  if (!msg || !msg.role) return null;

  const role = msg.role;
  if (role === "user" || role === "assistant" || role === "toolResult") {
    const ts = entryTimestamp ? Date.parse(entryTimestamp) : NaN;
    return {
      role: role as LlmMessage["role"],
      content: msg.content,
      isError: msg.isError,
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      timestamp: Number.isFinite(ts) ? ts : undefined,
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
    const cached = lruGet(messageMapCache, sessionId);
    if (cached && cached.logPath === logPath && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.map;
    }

    // Stream lines instead of materializing the whole file. On a 30MB log
    // this drops the parse pause from ~300ms to ~40ms because we never have
    // to allocate a single string containing every byte.
    const map = new Map<string, LlmMessage>();
    for (const line of streamJsonlLines(logPath)) {
      if (!line.trim()) continue;
      let entry: LogEntry;
      try {
        entry = JSON.parse(line) as LogEntry;
      } catch {
        continue;
      }
      if (entry.type === "message" && entry.id && entry.message) {
        const normalized = normalizeLogMessage(entry.message, entry.timestamp);
        if (normalized) map.set(entry.id, normalized);
      }
    }

    log.debug("readOriginalMessageMap: " + map.size + " msgs from " + logPath);
    if (map.size > 0) {
      lruSet(messageMapCache, sessionId, { logPath, mtimeMs: stat.mtimeMs, size: stat.size, map }, getMaxEntries());
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
