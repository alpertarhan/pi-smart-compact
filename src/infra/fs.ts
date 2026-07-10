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
 * Lock files are best-effort; they prevent the common case (two pi sessions
 * appending at once) without introducing a hard dependency. If a stale lock
 * sticks around for >5s we ignore it.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as log from "../utils/logger.ts";

const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_RETRIES = 80; // ≈2s

/** Ensure a directory exists, ignoring EEXIST races. */
export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
      log.warn("ensureDir failed for " + dir, e);
    }
  }
}

export async function ensureDirAsync(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
      log.warn("ensureDirAsync failed for " + dir, e);
    }
  }
}

function tempPath(target: string): string {
  return target + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
}

/**
 * Atomically write a file: write to a sibling temp file, fsync (best effort),
 * then rename. If anything fails mid-write the original file is preserved.
 */
export function atomicWriteFileSync(target: string, data: string | Uint8Array): void {
  ensureDir(path.dirname(target));
  const tmp = tempPath(target);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
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
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, target);
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
 * The lock is best-effort: if it stays held for longer than LOCK_STALE_MS we
 * assume the owning process crashed and reclaim it. Callers should always
 * release through the returned function.
 */
export function acquireLockSync(target: string): () => void {
  const lockDir = target + ".lock";
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      return () => { try { fs.rmdirSync(lockDir); } catch { /* ignore */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
        log.warn("acquireLockSync failed for " + target, e);
        return () => { /* no-op */ };
      }
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // Reclaim via rename-steal, not rmdir. A bare `rmdirSync(lockDir)`
          // has a classic race: two waiters both observe staleness, waiter A
          // reclaims (rmdir + mkdir), then waiter B's delayed rmdir deletes
          // A's FRESH lock and both end up holding it. `renameSync` is
          // atomic, so exactly one thief wins the steal; the loser gets
          // ENOENT and loops back to mkdir. The thief then re-checks the
          // stolen dir's mtime — if it turned out to be fresh (the owner
          // reclaimed between our stat and our rename), we put it back.
          const stolen = lockDir + ".stale." + process.pid + "." + crypto.randomBytes(4).toString("hex");
          try {
            fs.renameSync(lockDir, stolen);
            const stolenStat = fs.statSync(stolen);
            if (Date.now() - stolenStat.mtimeMs > LOCK_STALE_MS) {
              fs.rmdirSync(stolen);
            } else {
              // Stole a live lock — restore it and keep waiting. If the
              // restore fails (owner released meanwhile) the dir is gone
              // and the next mkdir attempt simply succeeds.
              try { fs.renameSync(stolen, lockDir); } catch { /* released */ }
            }
          } catch { /* another waiter won the steal — loop and retry mkdir */ }
          continue;
        }
      } catch { /* lock vanished between EEXIST and stat */ }
      // Yield the CPU between retries instead of spinning. `Atomics.wait`
      // on a tiny SharedArrayBuffer parks the thread without burning a core.
      // Node and Bun both allow this on the main thread (only browsers
      // forbid it), so the catch branch fires only in exotic sandboxes
      // where SharedArrayBuffer itself is unavailable.
      // ponytail: the spin fallback burns a core for up to 2s under
      // contention; acceptable because it's unreachable on our supported
      // runtimes — revisit if a SAB-less host becomes a target.
      try {
        const sab = new SharedArrayBuffer(4);
        const view = new Int32Array(sab);
        // We never notify, so this always times out after LOCK_RETRY_MS.
        Atomics.wait(view, 0, 0, LOCK_RETRY_MS);
      } catch {
        const until = Date.now() + LOCK_RETRY_MS;
        while (Date.now() < until) { /* spin */ }
      }
    }
  }
  log.warn("acquireLockSync gave up waiting for " + target);
  return () => { /* no-op fallback */ };
}

/**
 * Append a single line of text under a coarse lock. The newline is appended if
 * `line` does not already end with one.
 */
export function appendLineLocked(target: string, line: string): void {
  ensureDir(path.dirname(target));
  const release = acquireLockSync(target);
  try {
    fs.appendFileSync(target, line.endsWith("\n") ? line : line + "\n");
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
