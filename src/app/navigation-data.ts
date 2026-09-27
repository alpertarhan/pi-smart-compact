// Anchor and cross-session recall data. Semantics follow pi-toolkit's
// auto-context anchors (MIT, Copyright (c) pi-toolkit contributors); the code
// here is a typed rewrite that also reads Smart Continuity's own anchors.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
 AnchorPage,
 AnchorQuery,
 AnchorRecallHit,
 AnchorRecallPage,
 AnchorRecallQuery,
 AnchorRecord,
 AnchorState,
 NavigationSession,
} from "./navigation-types.ts";
import { isRecord } from "../utils/type-guards.ts";

export const NAVIGATION_TOOL_NAME = "smart_navigation";
/** Tool name used by pi-toolkit; its recorded anchors stay readable as session data. */
export const LEGACY_CONTEXT_TOOL_NAME = "context";
export const ANCHOR_CUSTOM_TYPE = "smart-context-anchor";

const LIST_DEFAULT_LIMIT = 30;
const RECALL_DEFAULT_LIMIT = 10;
const MAX_PAGE_LIMIT = 100;
// Pi reads session headers with a 4KB buffer too; a header that does not fit
// degrades to "unknown cwd" and the full parse decides.
const HEADER_READ_BYTES = 4096;

function anchorFromDetails(details: unknown): AnchorState | null {
 if (!isRecord(details) || !isRecord(details.anchor)) return null;
 const { name, summary, targetId } = details.anchor;
 if (typeof name !== "string" || !name || typeof summary !== "string") return null;
 return { name, summary, targetId: typeof targetId === "string" ? targetId : "" };
}

/** Anchor carried by an owned or legacy anchor tool result, or by a human anchor message. */
export function anchorFromMessage(message: unknown): AnchorState | null {
 if (!isRecord(message)) return null;
 if (message.role === "toolResult") {
  if (message.toolName !== NAVIGATION_TOOL_NAME && message.toolName !== LEGACY_CONTEXT_TOOL_NAME) return null;
  return anchorFromDetails(message.details);
 }
 if (message.role === "custom" && message.customType === ANCHOR_CUSTOM_TYPE) return anchorFromDetails(message.details);
 return null;
}

export function anchorFromEntry(entry: unknown): AnchorState | null {
 if (!isRecord(entry)) return null;
 if (entry.type === "message") return anchorFromMessage(entry.message);
 if (entry.type === "custom_message" && entry.customType === ANCHOR_CUSTOM_TYPE) return anchorFromDetails(entry.details);
 return null;
}

function matchesKeyword(anchor: AnchorState, keyword: string | undefined): boolean {
 if (!keyword) return true;
 return `${anchor.name}\n${anchor.summary}`.toLowerCase().includes(keyword.toLowerCase());
}

function pageBounds(query: AnchorQuery, defaultLimit: number): { limit: number; offset: number } {
 const whole = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
 return { limit: Math.min(MAX_PAGE_LIMIT, whole(query.limit, defaultLimit)), offset: whole(query.offset, 0) };
}

function page<T>(items: T[], query: AnchorQuery, defaultLimit: number): { anchors: T[]; total: number; nextOffset: number | null } {
 const { limit, offset } = pageBounds(query, defaultLimit);
 const anchors = items.slice(offset, offset + limit);
 const end = offset + anchors.length;
 return { anchors, total: items.length, nextOffset: anchors.length > 0 && end < items.length ? end : null };
}

/** Every anchor in the session, in entry order. */
export function getAnchors(sm: NavigationSession): AnchorRecord[] {
 const branch = new Set(sm.getBranch().map(entry => entry.id));
 const anchors: AnchorRecord[] = [];
 for (const entry of sm.getEntries()) {
  const data = anchorFromEntry(entry);
  if (!data) continue;
  anchors.push({ id: entry.id, data, onBranch: branch.has(entry.id), timestamp: entry.timestamp });
 }
 return anchors;
}

/** On-branch anchors newest-first, then off-branch anchors newest-first. */
function orderedAnchors(sm: NavigationSession): AnchorRecord[] {
 const newest = getAnchors(sm).reverse();
 return [...newest.filter(a => a.onBranch), ...newest.filter(a => !a.onBranch)];
}

export function listAnchors(sm: NavigationSession, query: AnchorQuery = {}): AnchorPage {
 return page(orderedAnchors(sm).filter(a => matchesKeyword(a.data, query.keyword)), query, LIST_DEFAULT_LIMIT);
}

function hasAnchorToolCall(entry: SessionEntry | undefined, toolCallId: unknown, name: string): boolean {
 if (entry?.type !== "message" || entry.message.role !== "assistant") return false;
 return entry.message.content.some(block => {
  if (block.type !== "toolCall" || block.id !== toolCallId) return false;
  if (block.name !== NAVIGATION_TOOL_NAME && block.name !== LEGACY_CONTEXT_TOOL_NAME) return false;
  return block.arguments.action === "anchor" && block.arguments.name === name;
 });
}

/**
 * Entry to pivot to so the anchor's summary stays on the new branch.
 *
 * Anchors record targetId as the leaf at creation time: for tool anchors that
 * is the assistant toolCall, whose toolResult child carries the summary. When
 * the anchor entry is that verified child, pivot to it instead. Anything that
 * does not verify falls back to the recorded target, or null if it is gone.
 */
function pivotTargetOf(sm: NavigationSession, anchor: AnchorRecord): string | null {
 const { targetId, name } = anchor.data;
 if (!targetId || targetId === anchor.id) return anchor.id;
 const target = sm.getEntry(targetId);
 if (!target) return null;
 const entry = sm.getEntry(anchor.id);
 if (entry?.parentId !== targetId) return targetId;
 if (entry.type === "custom_message") return anchor.id;
 if (entry.type === "message" && entry.message.role === "toolResult" && hasAnchorToolCall(target, entry.message.toolCallId, name)) {
  return anchor.id;
 }
 return targetId;
}

/** Resolve an entry id, anchor name or label to the entry a pivot should land on. */
export function resolveAnchorTarget(sm: NavigationSession, target: string): string | null {
 if (!target) return null;
 const anchors = orderedAnchors(sm);
 if (sm.getEntry(target)) {
  for (const anchor of anchors) {
   if (anchor.data.targetId !== target) continue;
   const resolved = pivotTargetOf(sm, anchor);
   if (resolved && resolved !== target) return resolved;
  }
  return target;
 }
 const named = anchors.find(a => a.data.name === target);
 if (named) return pivotTargetOf(sm, named);
 for (const entry of sm.getEntries()) {
  if (sm.getLabel(entry.id) === target) return entry.id;
 }
 return null;
}

function messageText(content: unknown): string {
 if (typeof content === "string") return content;
 if (!Array.isArray(content)) return "";
 let text = "";
 for (const block of content) {
  if (isRecord(block) && block.type === "text" && typeof block.text === "string") text += block.text;
 }
 return text;
}

/**
 * Text Pi's navigateTree drops into an empty editor when landing on a user or
 * custom_message entry, so a pivot can clear exactly that and nothing else.
 */
export function getEditorInjectionFor(sm: NavigationSession, targetId: string): string {
 const entry = sm.getEntry(targetId);
 if (entry?.type === "message" && entry.message.role === "user") return messageText(entry.message.content);
 if (entry?.type === "custom_message") return messageText(entry.content);
 return "";
}

// ── Cross-session recall ────────────────────────────

function abortError(): Error {
 const error = new Error("The operation was aborted");
 error.name = "AbortError";
 return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
 if (signal?.aborted) throw abortError();
}

/**
 * Rewrite a leading home directory to "~" so a session synced from another
 * machine (/Users/me/proj vs /home/me/proj) matches the same project. Limited to
 * the current username so two local accounts never collapse together.
 */
function homeRelative(dir: string): string {
 const home = os.homedir();
 const user = path.basename(home);
 for (const prefix of new Set([home, `/Users/${user}`, `/home/${user}`])) {
  if (dir === prefix) return "~";
  if (dir.startsWith(prefix + "/") || dir.startsWith(prefix + path.sep)) return "~" + dir.slice(prefix.length);
 }
 return dir;
}

interface SessionFile {
 file: string;
 mtime: number;
 size: number;
}

/**
 * Every session file under every project directory, newest first. Pi's cwd
 * directory encoding has changed across releases, so one project may own several
 * directories; the header cwd, not the directory name, decides the scope.
 */
async function listSessionFiles(sessionsDir: string, signal: AbortSignal | undefined): Promise<SessionFile[]> {
 const files: SessionFile[] = [];
 const dirs = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
 for (const dir of dirs) {
  throwIfAborted(signal);
  if (!dir.isDirectory()) continue;
  const dirPath = path.join(sessionsDir, dir.name);
  const names = await fs.promises.readdir(dirPath).catch(() => []);
  for (const name of names) {
   if (!name.endsWith(".jsonl")) continue;
   const file = path.join(dirPath, name);
   const stat = await fs.promises.stat(file).catch(() => null);
   if (stat?.isFile()) files.push({ file, mtime: stat.mtimeMs, size: stat.size });
  }
 }
 return files.sort((a, b) => b.mtime - a.mtime);
}

/** Header cwd from a bounded read; undefined means unknown, never a guess. */
async function peekSessionCwd(file: string): Promise<string | undefined> {
 let handle: fs.promises.FileHandle | undefined;
 try {
  handle = await fs.promises.open(file, "r");
  const buffer = Buffer.alloc(HEADER_READ_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_BYTES, 0);
  const chunk = buffer.subarray(0, bytesRead).toString("utf8");
  const newline = chunk.indexOf("\n");
  if (newline < 0) return undefined;
  const header: unknown = JSON.parse(chunk.slice(0, newline));
  return isRecord(header) && header.type === "session" && typeof header.cwd === "string" ? header.cwd : undefined;
 } catch {
  return undefined;
 } finally {
  await handle?.close().catch(() => undefined);
 }
}

interface SessionAnchors {
 mtime: number;
 size: number;
 sessionId: string;
 cwd: string;
 /** Newest first. */
 anchors: Array<{ id: string; data: AnchorState; timestamp: string }>;
}

// Parsed anchor metadata per file, invalidated by mtime+size and pruned to files
// still on disk after each completed scan. Only scanned sessions are stored.
const sessionAnchorCache = new Map<string, SessionAnchors>();

function mayHoldAnchor(line: string): boolean {
 return line.includes('"anchor"') && (
  line.includes(`"${NAVIGATION_TOOL_NAME}"`) || line.includes(`"${LEGACY_CONTEXT_TOOL_NAME}"`) || line.includes(`"${ANCHOR_CUSTOM_TYPE}"`)
 );
}

async function loadSessionAnchors(session: SessionFile, signal: AbortSignal | undefined): Promise<SessionAnchors> {
 const cached = sessionAnchorCache.get(session.file);
 if (cached && cached.mtime === session.mtime && cached.size === session.size) return cached;
 throwIfAborted(signal);

 const input = fs.createReadStream(session.file, { encoding: "utf8" });
 const lines = readline.createInterface({ input, crlfDelay: Infinity });
 const onAbort = () => {
  lines.close();
  input.destroy();
 };
 signal?.addEventListener("abort", onAbort, { once: true });

 const result: SessionAnchors = { mtime: session.mtime, size: session.size, sessionId: "", cwd: "", anchors: [] };
 let first = true;
 try {
  for await (const line of lines) {
   throwIfAborted(signal);
   const isHeader = first;
   first = false;
   if (!isHeader && !mayHoldAnchor(line)) continue;
   let entry: unknown = null;
   try {
    entry = JSON.parse(line);
   } catch {
    // A malformed entry line is skipped; a malformed header disowns the file below.
   }
   if (isHeader) {
    // Without a session header the file is not a session: no project, no anchors.
    if (!isRecord(entry) || entry.type !== "session") break;
    if (typeof entry.id === "string") result.sessionId = entry.id;
    if (typeof entry.cwd === "string") result.cwd = entry.cwd;
    continue;
   }
   const data = anchorFromEntry(entry);
   if (!data || !isRecord(entry) || typeof entry.id !== "string") continue;
   result.anchors.push({ id: entry.id, data, timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "" });
  }
  throwIfAborted(signal);
 } catch {
  if (signal?.aborted) throw abortError();
  // Unreadable file: remember it as anchor-free until it changes on disk.
  Object.assign(result, { sessionId: "", cwd: "", anchors: [] });
 } finally {
  signal?.removeEventListener("abort", onAbort);
  lines.close();
  input.destroy();
 }
 result.anchors.reverse();
 sessionAnchorCache.set(session.file, result);
 return result;
}

function timeValue(timestamp: string): number {
 const value = Date.parse(timestamp);
 return Number.isFinite(value) ? value : 0;
}

/**
 * Search anchors across stored sessions. Only runs when called: no watcher, no
 * timer, no provider or database work. `cwd` scope (default) matches the
 * header cwd home-portably; sessions with an unknown cwd never match it.
 */
export async function recallAnchors(options: AnchorRecallQuery & { sessionsDir: string; cwd: string }): Promise<AnchorRecallPage> {
 const { signal } = options;
 throwIfAborted(signal);
 const scope = options.scope ?? "cwd";
 const wantCwd = homeRelative(options.cwd);
 const files = await listSessionFiles(options.sessionsDir, signal);
 const hits: AnchorRecallHit[] = [];

 for (const session of files) {
  throwIfAborted(signal);
  if (scope === "cwd") {
   const peeked = await peekSessionCwd(session.file);
   if (peeked !== undefined && homeRelative(peeked) !== wantCwd) continue;
  }
  const loaded = await loadSessionAnchors(session, signal);
  if (scope === "cwd" && (!loaded.cwd || homeRelative(loaded.cwd) !== wantCwd)) continue;
  for (const anchor of loaded.anchors) {
   if (!matchesKeyword(anchor.data, options.keyword)) continue;
   hits.push({ ...anchor, onBranch: false, sessionId: loaded.sessionId, sessionFile: session.file, cwd: loaded.cwd });
  }
 }

 const onDisk = new Set(files.map(session => session.file));
 for (const file of sessionAnchorCache.keys()) {
  if (!onDisk.has(file) && file.startsWith(options.sessionsDir + path.sep)) sessionAnchorCache.delete(file);
 }

 // Stable: files are newest first and each file's anchors newest first.
 hits.sort((a, b) => timeValue(b.timestamp) - timeValue(a.timestamp));
 return page(hits, options, RECALL_DEFAULT_LIMIT);
}
