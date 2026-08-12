import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Cell } from "../types.ts";
import { runLocksDir } from "../infra/paths.ts";
import { ONE_HOUR_MS } from "../constants.ts";

export interface SessionRunLock extends Cell<boolean> {
  acquire(sessionId: string): boolean;
  release(sessionId: string): void;
  isSessionActive(sessionId: string): boolean;
  isRunning(sessionId: string): boolean;
  activeCount(): number;
  size(): number;
}

interface FileLease { file: string; token: string; heartbeat?: NodeJS.Timeout; }
interface RunLease { session?: FileLease; slot?: FileLease; }

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function readLease(file: string): { pid?: number; createdAt?: number; token?: string } | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; createdAt?: number; token?: string }; }
  catch { return null; }
}

function acquireFileLease(file: string, staleMs: number): FileLease | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const create = (): FileLease | null => {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }) + "\n");
      } catch (error) {
        try { fs.unlinkSync(file); } catch { /* best effort */ }
        throw error;
      } finally { fs.closeSync(fd); }
      const lease: FileLease = { file, token };
      lease.heartbeat = setInterval(() => {
        if (readLease(file)?.token !== token) {
          if (lease.heartbeat) clearInterval(lease.heartbeat);
          lease.heartbeat = undefined;
          return;
        }
        try { fs.utimesSync(file, new Date(), new Date()); }
        catch { /* release or another process won */ }
      }, Math.max(10_000, Math.floor(staleMs / 3)));
      lease.heartbeat.unref();
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return null;
    }
  };
  const first = create();
  if (first) return first;

  const current = readLease(file);
  let observedStat: fs.Stats;
  try { observedStat = fs.statSync(file); } catch { return null; }
  const observedAt = Math.max(Number(current?.createdAt ?? 0), observedStat.mtimeMs);
  const age = Date.now() - observedAt;
  const livePidCeiling = Math.max(ONE_HOUR_MS, staleMs * 4);
  if (age <= staleMs || (current?.pid && processAlive(current.pid) && age <= livePidCeiling)) return null;

  // Re-read both logical ownership and inode metadata immediately before
  // reclaim. A release/reacquire that changed either must never be unlinked.
  const latest = readLease(file);
  let latestStat: fs.Stats;
  try { latestStat = fs.statSync(file); } catch { return null; }
  const latestAt = Math.max(Number(latest?.createdAt ?? 0), latestStat.mtimeMs);
  const latestAge = Date.now() - latestAt;
  if (latestAge <= staleMs || (latest?.pid && processAlive(latest.pid) && latestAge <= livePidCeiling)) return null;
  if (current?.token
    ? latest?.token !== current.token
    : latestStat.dev !== observedStat.dev || latestStat.ino !== observedStat.ino
      || latestStat.size !== observedStat.size || latestStat.mtimeMs !== observedStat.mtimeMs) return null;
  try { fs.unlinkSync(file); } catch { return null; }
  return create();
}

function releaseFileLease(lease?: FileLease): void {
  if (!lease) return;
  clearInterval(lease.heartbeat);
  lease.heartbeat = undefined;
  const current = readLease(lease.file);
  if (current?.token !== lease.token) return;
  try { fs.unlinkSync(lease.file); } catch { /* already removed */ }
}

/**
 * Same-session serialization plus a filesystem-backed process-global
 * semaphore. A crashed process leaves a lease that is reclaimed only when its
 * PID is no longer alive (or an unreadable lease exceeds the stale ceiling).
 */
export function createSessionRunLock(
  maxConcurrent = 2,
  options: { leaseDir?: string | null; staleMs?: number } = {},
): SessionRunLock {
  const active = new Map<string, RunLease>();
  const capacity = Math.max(1, maxConcurrent);
  const leaseDir = options.leaseDir === undefined ? runLocksDir() : options.leaseDir;
  const staleMs = Math.max(60_000, options.staleMs ?? 30 * 60_000);

  const release = (sessionId: string): void => {
    const lease = active.get(sessionId);
    if (!lease) return;
    active.delete(sessionId);
    releaseFileLease(lease.slot);
    releaseFileLease(lease.session);
  };

  const lock: SessionRunLock = {
    acquire(sessionId) {
      if (active.has(sessionId) || active.size >= capacity) return false;
      if (!leaseDir) {
        active.set(sessionId, {});
        return true;
      }
      try {
        const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
        const session = acquireFileLease(path.join(leaseDir, "session-" + sessionHash + ".lock"), staleMs);
        if (!session) return false;
        let slot: FileLease | null = null;
        for (let index = 0; index < capacity && !slot; index++) {
          slot = acquireFileLease(path.join(leaseDir, "slot-" + index + ".lock"), staleMs);
        }
        if (!slot) {
          releaseFileLease(session);
          return false;
        }
        active.set(sessionId, { session, slot });
        return true;
      } catch {
        // Failing closed is safer than silently defeating the global budget.
        return false;
      }
    },
    release,
    isSessionActive(sessionId) { return active.has(sessionId); },
    isRunning(sessionId) { return active.has(sessionId); },
    activeCount() { return active.size; },
    size() { return active.size; },
    get value() { return active.size > 0; },
    set value(next: boolean) {
      if (next || !active.size) return;
      for (const sessionId of [...active.keys()]) release(sessionId);
    },
  };
  return lock;
}

export function acquireRunLock(lock: Cell<boolean> | SessionRunLock, sessionId: string): boolean {
  if ("acquire" in lock && typeof lock.acquire === "function") return lock.acquire(sessionId);
  if (lock.value) return false;
  lock.value = true;
  return true;
}

export function releaseRunLock(lock: Cell<boolean> | SessionRunLock, sessionId: string): void {
  if ("release" in lock && typeof lock.release === "function") lock.release(sessionId);
  else lock.value = false;
}
