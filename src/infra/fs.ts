/**
 * Filesystem primitives with atomic-write and lock semantics.
 *
 * Why this module exists:
 *
 *  - Several disk writes (extraction cache, project fingerprint, compaction
 *    state, metrics dashboard) used `fs.writeFileSync` directly. A process
 *    crash mid-write leaves the JSON half-truncated, and the next load throws
 *    on `JSON.parse`. We now write to `<file>.tmp.<pid>.<rand>` then rename,
 *    so readers either see the previous payload or the new one — never both.
 *
 *  - The append-only metrics log was written with `appendFileSync`. Multiple
 *    pi sessions writing concurrently could interleave bytes mid-line and
 *    produce a single corrupted JSON record. We hold a short-lived file lock
 *    while opening and appending, so contiguous lines stay intact.
 *
 *  - Several pieces of code re-checked `existsSync` then `mkdirSync`. The
 *    `ensureDir` helper deduplicates that pattern.
 *
 * Sync vs async:
 *  - The extension runs inside the pi event loop. The hot path through
 *    `runSmartCompact` already does many sync FS calls; turning every helper
 *    into async would balloon the diff. We expose both shapes:
 *    `atomicWriteFileSync` for the existing call sites (kept simple) and
 *    `atomicWriteFile` for new async-friendly callers (background metrics).
 *
 * Lock acquisition is fail-closed: callers never continue an append/trim
 * without ownership. Locks older than 5s are reclaimed with an atomic rename.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as log from "../utils/logger.ts";

const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_RETRIES = 80; // ≈2s

/** Ensure a private directory exists and normalize an existing target. */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export async function ensureDirAsync(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
}

function tempPath(target: string): string {
  return target + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
}

/**
 * Atomically write a file: write to a sibling temp file, then rename. This
 * prevents partial readers and preserves the previous file on process failure;
 * it does not claim power-loss durability because it deliberately avoids fsync
 * on latency-sensitive cache/backup writes.
 */
export function atomicWriteFileSync(target: string, data: string | Uint8Array): void {
  ensureDir(path.dirname(target));
  const tmp = tempPath(target);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
  } catch (e) {
    // Clean up the temp file if rename failed — we never want orphans.
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

export async function atomicWriteFile(target: string, data: string | Uint8Array): Promise<void> {
  await ensureDirAsync(path.dirname(target));
  const tmp = tempPath(target);
  try {
    await fsp.writeFile(tmp, data, { mode: 0o600 });
    await fsp.rename(tmp, target);
    await fsp.chmod(target, 0o600);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * Acquire a coarse-grained lock by creating a `<file>.lock` directory.
 * `mkdir` is atomic on every reasonable filesystem, which is exactly what we
 * need for a multi-process advisory lock without depending on `flock`.
 *
 * If it stays held for longer than LOCK_STALE_MS we assume the owning process
 * crashed and reclaim it. Acquisition errors/timeouts throw, so callers never
 * proceed unlocked. Callers should always release through the returned function.
 */
function tryAcquireLock(target: string): (() => void) | null {
  const lockDir = target + ".lock";
  for (let reclaimAttempt = 0; reclaimAttempt < 2; reclaimAttempt++) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      return () => { try { fs.rmdirSync(lockDir); } catch { /* ignore */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw new Error("Failed to acquire lock for " + target, { cause: error });
      }
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return null;
        const stolen = lockDir + ".stale." + process.pid + "." + crypto.randomBytes(4).toString("hex");
        fs.renameSync(lockDir, stolen);
        const stolenStat = fs.statSync(stolen);
        if (Date.now() - stolenStat.mtimeMs > LOCK_STALE_MS) fs.rmdirSync(stolen);
        else try { fs.renameSync(stolen, lockDir); } catch { /* released */ }
      } catch { /* lock changed; retry acquisition once */ }
    }
  }
  return null;
}

/** Immediate lock attempt for synchronous best-effort paths; never parks JS. */
export function acquireLockSync(target: string): () => void {
  const release = tryAcquireLock(target);
  if (!release) throw new Error("Lock busy for " + target);
  return release;
}

/** Bounded blocking acquisition for synchronous durability paths. */
function acquireLockBlockingSync(target: string): () => void {
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    const release = tryAcquireLock(target);
    if (release) return release;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
  }
  throw new Error("Timed out acquiring lock for " + target);
}

/** Cooperative multi-process lock for durable read-modify-write operations. */
export async function acquireLock(target: string): Promise<() => void> {
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    const release = tryAcquireLock(target);
    if (release) return release;
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, LOCK_RETRY_MS);
    await delay.promise;
  }
  throw new Error("Timed out acquiring lock for " + target);
}

/**
 * Append one complete line while enforcing an optional tail-retention cap.
 *
 * Append and trim share the same advisory lock. This matters because O_APPEND
 * only serializes writes to one inode; it does not protect a concurrent
 * temp-file rename from replacing an append that landed after the trim read.
 * Retention therefore happens synchronously, but only when the cap is crossed.
 */
export function appendLineLocked(target: string, line: string, maxBytes?: number): void {
  ensureDir(path.dirname(target));
  const payload = Buffer.from(line.endsWith("\n") ? line : line + "\n");
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  if (maxBytes !== undefined && payload.length > maxBytes) {
    throw new Error("Log entry exceeds retention cap for " + target);
  }
  const release = acquireLockBlockingSync(target);
  try {
    if (maxBytes !== undefined && fs.existsSync(target)) {
      const stat = fs.statSync(target);
      if (stat.size + payload.length > maxBytes) {
        const retainedBudget = Math.max(0, maxBytes - payload.length);
        const retainedLength = Math.min(stat.size, retainedBudget);
        const buffer = Buffer.allocUnsafe(retainedLength);
        if (retainedLength > 0) {
          const fd = fs.openSync(target, "r");
          try { fs.readSync(fd, buffer, 0, retainedLength, stat.size - retainedLength); }
          finally { fs.closeSync(fd); }
        }
        let tail = buffer.toString("utf8");
        if (retainedLength < stat.size) {
          const firstNewline = tail.indexOf("\n");
          tail = firstNewline >= 0 ? tail.slice(firstNewline + 1) : "";
        }
        atomicWriteFileSync(target, tail);
      }
    }
    if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
    fs.appendFileSync(target, payload, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
  } finally {
    release();
  }
}

/** Async append/retention variant for event-loop-sensitive telemetry paths. */
export async function appendLineLockedAsync(target: string, line: string, maxBytes?: number): Promise<void> {
  await ensureDirAsync(path.dirname(target));
  const payload = Buffer.from(line.endsWith("\n") ? line : line + "\n");
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  if (maxBytes !== undefined && payload.length > maxBytes) {
    throw new Error("Log entry exceeds retention cap for " + target);
  }
  const release = await acquireLock(target);
  try {
    let stat: Awaited<ReturnType<typeof fsp.stat>> | null = null;
    try {
      stat = await fsp.stat(target);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (maxBytes !== undefined && stat && stat.size + payload.length > maxBytes) {
      const retainedLength = Math.min(stat.size, Math.max(0, maxBytes - payload.length));
      const buffer = Buffer.allocUnsafe(retainedLength);
      if (retainedLength > 0) {
        const handle = await fsp.open(target, "r");
        try {
          await handle.read(buffer, 0, retainedLength, stat.size - retainedLength);
        } finally {
          await handle.close();
        }
      }
      let tail = buffer.toString("utf8");
      if (retainedLength < stat.size) {
        const firstNewline = tail.indexOf("\n");
        tail = firstNewline >= 0 ? tail.slice(firstNewline + 1) : "";
      }
      await atomicWriteFile(target, tail);
    }
    await fsp.appendFile(target, payload, { mode: 0o600 });
    await fsp.chmod(target, 0o600);
  } finally {
    release();
  }
}

/** Read the newest valid JSONL records without loading an entire bounded log. */
export function readJsonlTail<T>(target: string, limit: number, maxBytes = 512 * 1024): T[] {
  if (limit <= 0 || !fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(target, "r");
  try { fs.readSync(fd, buffer, 0, length, stat.size - length); }
  finally { fs.closeSync(fd); }
  let text = buffer.toString("utf8");
  if (stat.size > length) {
    const newline = text.indexOf("\n");
    text = newline >= 0 ? text.slice(newline + 1) : "";
  }
  const values: T[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { values.push(JSON.parse(line) as T); }
    catch { /* corrupt/incomplete lines are ignored at this recovery boundary */ }
  }
  return values.slice(-limit);
}

/** Keep only complete trailing lines that fit within `maxBytes`. */
export async function trimFileTailLocked(target: string, maxBytes: number): Promise<void> {
  const release = await acquireLock(target);
  try {
    const stat = await fsp.stat(target);
    if (stat.size <= maxBytes) return;
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    const fd = await fsp.open(target, "r");
    try { await fd.read(buffer, 0, length, stat.size - length); }
    finally { await fd.close(); }
    const tail = buffer.toString("utf8");
    const firstNewline = tail.indexOf("\n");
    await atomicWriteFile(target, firstNewline >= 0 ? tail.slice(firstNewline + 1) : "");
  } finally {
    release();
  }
}


export function readJsonSync<T>(target: string): T | null {
  try {
    if (!fs.existsSync(target)) return null;
    const raw = fs.readFileSync(target, "utf8");
    return JSON.parse(raw) as T;
  } catch (e) {
    log.warn("readJsonSync failed for " + target, e);
    return null;
  }
}

export function writeJsonSync(target: string, value: unknown, pretty = false): void {
  atomicWriteFileSync(target, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
}
