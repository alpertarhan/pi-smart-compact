import type { PendingCompaction } from "../types.ts";

interface Entry {
  pending: PendingCompaction;
  createdAt: number;
}

export type CommitDiscardReason = "expired" | "evicted" | "aborted" | "shutdown" | "apply-error";

export interface CompactionCommitStore {
  stage(pending: PendingCompaction): void;
  take(runId: string, sessionId: string): PendingCompaction | null;
  discard(runId: string, reason: CommitDiscardReason): PendingCompaction | null;
  clearSession(sessionId: string, reason?: CommitDiscardReason): PendingCompaction[];
  size(): number;
}

/**
 * Holds summaries only between session_before_compact and session_compact.
 * Nothing durable is written until `take()` confirms both run and session.
 */
export function createCompactionCommitStore(options: {
  ttlMs?: number;
  maxEntries?: number;
  onDiscard?: (pending: PendingCompaction, reason: CommitDiscardReason) => void;
} = {}): CompactionCommitStore {
  const ttlMs = Math.max(1, options.ttlMs ?? 5 * 60_000);
  const maxEntries = Math.max(1, options.maxEntries ?? 16);
  const entries = new Map<string, Entry>();

  const remove = (runId: string, reason: CommitDiscardReason, notify: boolean): PendingCompaction | null => {
    const entry = entries.get(runId);
    if (!entry) return null;
    entries.delete(runId);
    if (notify) options.onDiscard?.(entry.pending, reason);
    return entry.pending;
  };

  const sweep = (): void => {
    const now = Date.now();
    for (const [runId, entry] of entries) {
      if (now - entry.createdAt > ttlMs) remove(runId, "expired", true);
    }
  };

  return {
    stage(pending) {
      sweep();
      if (!pending.runId || pending.details.runId !== pending.runId) {
        throw new Error("Compaction candidate runId mismatch");
      }
      if (entries.has(pending.runId)) throw new Error("Duplicate compaction candidate runId");
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value as string | undefined;
        if (!oldest) break;
        remove(oldest, "evicted", true);
      }
      entries.set(pending.runId, { pending, createdAt: Date.now() });
    },

    take(runId, sessionId) {
      sweep();
      const entry = entries.get(runId);
      if (!entry || entry.pending.sessionId !== sessionId) return null;
      entries.delete(runId);
      return entry.pending;
    },

    discard(runId, reason) {
      sweep();
      return remove(runId, reason, true);
    },

    clearSession(sessionId, reason = "shutdown") {
      sweep();
      const removed: PendingCompaction[] = [];
      for (const [runId, entry] of entries) {
        if (entry.pending.sessionId !== sessionId) continue;
        const pending = remove(runId, reason, true);
        if (pending) removed.push(pending);
      }
      return removed;
    },

    size() {
      sweep();
      return entries.size;
    },
  };
}
