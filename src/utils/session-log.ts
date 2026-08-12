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
import { StringDecoder } from "node:string_decoder";
import { extractText, TRUNCATE_RE } from "./extraction.ts";
import type { LlmMessage, SessionMessageEntry } from "../types.ts";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { asBranchMessage } from "../infra/ai-messages.ts";
import { sessionsDir as sessionsDirPath } from "../infra/paths.ts";
// LRU helpers live in a sibling module so they can be unit-tested in
// isolation and reused by other bounded caches.
import { lruGet, lruSet } from "./lru.ts";
import * as log from "./logger.ts";

function getSessionsDir(): string {
  return sessionsDirPath();
}

/**
 * Async, bounded-memory JSONL parser. Large active logs are read to EOF:
 * truncating at a byte cap loses the newest branch IDs and silently defeats
 * recovery. Awaiting each chunk yields I/O back to the event loop instead of
 * blocking the agent while preserving exact UTF-8 line boundaries.
 */
async function* streamJsonlLines(file: string, chunkSize = 64 * 1024): AsyncGenerator<string> {
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(chunkSize);
    const decoder = new StringDecoder("utf8");
    let leftover = "";
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      const data = leftover + decoder.write(buffer.subarray(0, bytesRead));
      const lines = data.split("\n");
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) yield line;
      }
    }
    leftover += decoder.end();
    if (leftover.length > 0) yield leftover;
  } finally {
    await handle.close().catch(error => log.debug("streamJsonlLines close failed", error));
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
const messageMapCache = new Map<string, { logPath: string; mtimeMs: number; size: number; requestedIds: Set<string>; map: Map<string, LlmMessage> }>();

/** @internal Test-only: drop both module caches between cases. */
export function __resetSessionLogCachesForTests(): void {
  logPathCache.clear();
  messageMapCache.clear();
}

function sessionDirectoryForCwd(cwd: string): string {
  const safeCwd = path.resolve(cwd).replace(/^[/\\]/, "").replace(/[:/\\]/g, "-");
  return path.join(getSessionsDir(), "--" + safeCwd + "--");
}

function findLogInDirectory(directory: string, sessionId: string): string | null {
  if (!fs.existsSync(directory)) return null;
  if (/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    const exact = path.join(directory, sessionId + ".jsonl");
    if (fs.existsSync(exact)) return exact;
  }
  const match = fs.readdirSync(directory, { withFileTypes: true })
    .find(entry => entry.isFile() && entry.name.endsWith("_" + sessionId + ".jsonl"));
  return match ? path.join(directory, match.name) : null;
}

/**
 * Find the session .jsonl log file for a given session ID.
 *
 * pi-coding-agent stores sessions under ~/.pi/agent/sessions/{cwdHash}/
 * with filenames like 2026-05-19T12-34-56_abc123.jsonl.
 * We try the bare id first, then the glob suffix pattern.
 */
function findSessionLogFile(sessionId: string, cwd?: string): string | null {
  const home = process.env.HOME ?? "/tmp";
  const now = Date.now();
  const directDirectory = cwd ? sessionDirectoryForCwd(cwd) : null;
  const cacheKey = sessionId + "\0" + (directDirectory ?? "*");
  const remember = (foundPath: string | null) => {
    lruSet(logPathCache, cacheKey, { path: foundPath, expiresAt: now + LOG_PATH_CACHE_TTL_MS, home }, getMaxEntries());
    return foundPath;
  };

  try {
    const cached = lruGet(logPathCache, cacheKey);
    if (cached && cached.home === home && cached.expiresAt > now) return cached.path;

    const sessionsDir = getSessionsDir();
    if (!fs.existsSync(sessionsDir)) return remember(null);
    if (directDirectory) {
      const direct = findLogInDirectory(directDirectory, sessionId);
      if (direct) return remember(direct);
    }

    for (const subdir of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!subdir.isDirectory()) continue;
      const subdirPath = path.join(sessionsDir, subdir.name);
      if (subdirPath === directDirectory) continue;
      const found = findLogInDirectory(subdirPath, sessionId);
      if (found) return remember(found);
    }
  } catch (error) {
    log.debug("findSessionLogFile failed", error);
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
async function readOriginalMessageMap(
  sessionId: string,
  wantedIds: ReadonlySet<string>,
  cwd?: string,
): Promise<Map<string, LlmMessage> | null> {
  const logPath = findSessionLogFile(sessionId, cwd);
  if (!logPath) {
    log.debug("Session log not found for " + sessionId);
    return null;
  }
  try {
    const stat = await fs.promises.stat(logPath);
    const cached = lruGet(messageMapCache, sessionId);
    if (
      cached
      && cached.logPath === logPath
      && cached.mtimeMs === stat.mtimeMs
      && cached.size === stat.size
      && Array.from(wantedIds).every(id => cached.requestedIds.has(id))
    ) {
      return cached.map;
    }

    const map = new Map<string, LlmMessage>();
    const remaining = new Set(wantedIds);
    for await (const line of streamJsonlLines(logPath)) {
      if (!line.trim()) continue;
      let entry: LogEntry;
      try {
        entry = JSON.parse(line) as LogEntry;
      } catch {
        continue;
      }
      if (entry.type !== "message" || !entry.id || !remaining.has(entry.id) || !entry.message) continue;
      remaining.delete(entry.id);
      const normalized = normalizeLogMessage(entry.message, entry.timestamp);
      if (normalized) map.set(entry.id, normalized);
      if (remaining.size === 0) break;
    }

    log.debug("readOriginalMessageMap: " + map.size + "/" + wantedIds.size + " requested msgs from " + logPath);
    lruSet(messageMapCache, sessionId, {
      logPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      requestedIds: new Set(wantedIds),
      map,
    }, getMaxEntries());
    return map;
  } catch (error) {
    log.debug("readOriginalMessageMap failed", error);
    return null;
  }
}

export interface ResolvedCompactionMessage {
  entryId: string;
  message: LlmMessage;
}

/**
 * Recover untruncated messages while preserving the exact entry-id/message
 * association after `convertToLlm` filters context-excluded branch entries.
 *
 * Each returned tuple is in the same domain as the LLM messages. Raw branch
 * cardinality is deliberately not preserved: entries excluded from provider
 * context must not shift cache fingerprints for every later message.
 */
export async function resolveCompactionMessages(
  sessionId: string,
  toCompactEntries: SessionMessageEntry[],
  cwd?: string,
): Promise<ResolvedCompactionMessage[] | null> {
  const wantedIds = new Set(toCompactEntries.flatMap(entry => entry.id ? [entry.id] : []));
  const logMap = await readOriginalMessageMap(sessionId, wantedIds, cwd);
  if (!logMap) return null;

  let restoredCount = 0;
  const result: ResolvedCompactionMessage[] = [];

  for (const entry of toCompactEntries) {
    if (!entry.id) continue;
    const converted = convertToLlm([asBranchMessage(entry.message)]) as LlmMessage[];
    if (!converted.length) continue;
    const logMsg = logMap.get(entry.id);
    if (logMsg && !hasTruncatedMessages([logMsg])) {
      result.push({ entryId: entry.id, message: logMsg });
      restoredCount++;
    } else {
      for (const message of converted) result.push({ entryId: entry.id, message });
    }
  }

  if (restoredCount > 0) {
    log.info("Session log recovery: " + restoredCount + "/" + result.length + " LLM messages restored from log");
  }
  return result;
}
