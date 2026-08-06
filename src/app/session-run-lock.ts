import type { Cell } from "../types.ts";

export interface SessionRunLock extends Cell<boolean> {
  acquire(sessionId: string): boolean;
  release(sessionId: string): void;
  isRunning(sessionId: string): boolean;
  size(): number;
}

export function createSessionRunLock(maxConcurrent = 2): SessionRunLock {
  const sessions = new Set<string>();
  return {
    get value() { return sessions.size > 0; },
    set value(next: boolean) { if (!next) sessions.clear(); },
    acquire(sessionId) {
      if (sessions.has(sessionId) || sessions.size >= Math.max(1, maxConcurrent)) return false;
      sessions.add(sessionId);
      return true;
    },
    release(sessionId) { sessions.delete(sessionId); },
    isRunning(sessionId) { return sessions.has(sessionId); },
    size() { return sessions.size; },
  };
}

export function acquireRunLock(lock: Cell<boolean> | SessionRunLock, sessionId: string): boolean {
  if ("acquire" in lock) return lock.acquire(sessionId);
  if (lock.value) return false;
  lock.value = true;
  return true;
}

export function releaseRunLock(lock: Cell<boolean> | SessionRunLock, sessionId: string): void {
  if ("release" in lock) lock.release(sessionId);
  else lock.value = false;
}
