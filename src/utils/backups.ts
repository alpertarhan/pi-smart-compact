import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BACKUP_MAX_FILES, BACKUP_MAX_AGE_MS, ONE_HOUR_MS, TRUNC } from "../constants.ts";
import { atomicWriteFile } from "../infra/fs.ts";
import type { PreparedConversationBackup } from "../types.ts";
import { loadConfig } from "./helpers.ts";
import * as log from "./logger.ts";

const BACKUP_MAGIC = "# Smart Compact Backup\n";
const BACKUP_HEADER_MAX_BYTES = 4 * 1024;
const pruneInFlight = new Set<string>();

function isOwnedBackupFile(full: string): boolean {
  let fd: number | undefined;
  try {
    if (!fs.lstatSync(full).isFile()) return false;
    const prefix = Buffer.alloc(Buffer.byteLength(BACKUP_MAGIC));
    fd = fs.openSync(full, "r");
    return fs.readSync(fd, prefix, 0, prefix.length, 0) === prefix.length
      && prefix.toString("utf8") === BACKUP_MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function readOwnedBackupHeader(full: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(full, "r");
    const buffer = Buffer.allocUnsafe(BACKUP_HEADER_MAX_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead).toString("utf8");
    return header.startsWith(BACKUP_MAGIC) ? header : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function prunePass(dir: string): void {
  try {
    const names = fs.readdirSync(dir);
    for (const name of names) {
      if (!/\.tmp\.\d+\.[0-9a-f]+$/i.test(name)) continue;
      const full = path.join(dir, name);
      try { if (Date.now() - fs.statSync(full).mtimeMs > ONE_HOUR_MS) fs.unlinkSync(full); } catch { /* best effort */ }
    }
    const entries = names
      .filter(name => name.endsWith(".md"))
      .map(name => {
        const full = path.join(dir, name);
        try { return isOwnedBackupFile(full) ? { full, mtimeMs: fs.statSync(full).mtimeMs } : null; } catch { return null; }
      })
      .filter((value): value is { full: string; mtimeMs: number } => value !== null);
    const now = Date.now();
    const overAge = entries.filter(entry => now - entry.mtimeMs > BACKUP_MAX_AGE_MS);
    const overCount = entries.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(BACKUP_MAX_FILES);
    const toRemove = new Set([...overAge, ...overCount].map(entry => entry.full));
    for (const full of toRemove) {
      try { if (isOwnedBackupFile(full)) fs.unlinkSync(full); }
      catch (error) { log.debug("prunePass unlink failed", error); }
    }
  } catch (error) {
    log.debug("prunePass scan failed", error);
  }
}

function schedulePruneBackups(dir: string): void {
  if (pruneInFlight.has(dir)) return;
  pruneInFlight.add(dir);
  setTimeout(() => {
    try { prunePass(dir); } finally { pruneInFlight.delete(dir); }
  }, 0);
}

export function prepareConversationBackup(
  source: string | (() => string),
  sessionId: string,
  metadata: { branchLeafId?: string; contextTokens?: number } = {},
): PreparedConversationBackup | null {
  try {
    const config = loadConfig();
    if (!config.backupEnabled) return null;
    const createdAt = new Date();
    const timestamp = createdAt.toISOString().replace(/[:.]/g, "-");
    const identity = typeof source === "string"
      ? source
      : sessionId + "\0" + (metadata.branchLeafId ?? "") + "\0" + timestamp + "\0" + crypto.randomBytes(8).toString("hex");
    const hash = crypto.createHash("sha256").update(identity).digest("hex").slice(0, TRUNC.CONV_HASH);
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, "_").slice(0, 80) || "session";
    const headerSessionId = sessionId.replace(/[\r\n]/g, " ").slice(0, 256);
    return {
      path: path.join(config.backupDir, safeSessionId + "-" + timestamp + "-" + hash + ".md"),
      ...(typeof source === "string" ? { content: source } : { materialize: source }),
      sessionId: headerSessionId,
      createdAt: createdAt.toISOString(),
      branchLeafId: metadata.branchLeafId,
      contextTokens: metadata.contextTokens,
    };
  } catch (error) {
    log.warn("prepareConversationBackup failed", error);
    return null;
  }
}

/** Materialize and commit the scrubbed payload only after native confirmation. */
export async function commitPreparedConversationBackup(prepared: PreparedConversationBackup): Promise<string | null> {
  try {
    const body = prepared.content ?? prepared.materialize?.();
    if (typeof body !== "string") throw new Error("Prepared backup has no payload");
    const metadata = BACKUP_MAGIC
      + "# Date: " + prepared.createdAt + "\n"
      + "# Session: " + prepared.sessionId + "\n"
      + (prepared.branchLeafId ? "# Branch-Leaf: " + prepared.branchLeafId.replace(/[\r\n]/g, " ").slice(0, 256) + "\n" : "")
      + (prepared.contextTokens !== undefined ? "# Context-Tokens: " + Math.max(0, Math.round(prepared.contextTokens)) + "\n" : "")
      + "\n";
    await atomicWriteFile(prepared.path, metadata + body);
    schedulePruneBackups(path.dirname(prepared.path));
    return prepared.path;
  } catch (error) {
    log.warn("commitPreparedConversationBackup failed", error);
    return null;
  }
}

export interface BackupEntry {
  path: string;
  sessionId: string;
  date: string;
  sizeBytes: number;
}

export function listBackups(limit = 20): BackupEntry[] {
  try {
    const dir = loadConfig().backupDir;
    if (!fs.existsSync(dir)) return [];
    const out: BackupEntry[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        const header = readOwnedBackupHeader(full);
        if (!header) continue;
        const date = header.match(/^# Date:\s*(.+)$/m)?.[1]?.trim();
        const session = header.match(/^# Session:\s*(.+)$/m)?.[1]?.trim();
        out.push({
          path: full,
          sessionId: session ?? name,
          date: date ?? stat.mtime.toISOString(),
          sizeBytes: stat.size,
        });
      } catch { /* skip unreadable backup */ }
    }
    out.sort((left, right) => left.date < right.date ? 1 : left.date > right.date ? -1 : 0);
    return out.slice(0, limit);
  } catch (error) {
    log.warn("listBackups failed", error);
    return [];
  }
}

export interface ConversationBackup {
  content: string;
  branchLeafId?: string;
  contextTokens?: number;
}

export function readConversationBackup(file: string): ConversationBackup | null {
  try {
    if (!isOwnedBackupFile(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n");
    let index = 0;
    while (index < lines.length && lines[index].startsWith("#")) index++;
    if (index < lines.length && lines[index].trim() === "") index++;
    const content = lines.slice(index).join("\n").trim();
    if (!content) return null;
    const branchLeafId = raw.match(/^# Branch-Leaf:\s*(.+)$/m)?.[1]?.trim();
    const contextTokensRaw = raw.match(/^# Context-Tokens:\s*(\d+)$/m)?.[1];
    const contextTokens = contextTokensRaw ? Number(contextTokensRaw) : undefined;
    return {
      content,
      ...(branchLeafId ? { branchLeafId } : {}),
      ...(contextTokens !== undefined && Number.isSafeInteger(contextTokens) ? { contextTokens } : {}),
    };
  } catch (error) {
    log.warn("readConversationBackup failed", error);
    return null;
  }
}

export function readBackupContent(file: string): string | null {
  return readConversationBackup(file)?.content ?? null;
}

export function buildRestoreMessage(content: string, source: string): {
  customType: string;
  content: string;
  display: boolean;
  details: { source: string; restoredAt: number };
} {
  return {
    customType: "smart-compact-restore",
    content: "# Restored pre-compaction context (smart-compact backup)\nSource: " + source + "\n\n" + content,
    display: true,
    details: { source, restoredAt: Date.now() },
  };
}
