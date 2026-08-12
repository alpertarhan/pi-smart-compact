/** Session-scoped pending compaction store with TTL and bounded memory. */

import type { PendingCompaction } from "../types.ts";
import { resolveSessionId, type SessionIdentityContext } from "../infra/session-identity.ts";

export type ConsumeResult =
  | { kind: "ok"; pending: PendingCompaction }
  | { kind: "empty" }
  | { kind: "expired"; ageMs: number }
  | { kind: "mismatch"; expected: string; actual: string };

export interface PendingSlot {
  set(pending: PendingCompaction): void;
  consume(ctx: SessionIdentityContext): ConsumeResult;
  clear(sessionId?: string): void;
  isPresent(sessionId?: string): boolean;
  peek(sessionId?: string): Readonly<PendingCompaction> | null;
  size(): number;
}

export interface PendingSlotOptions {
  ttlMs: number;
  now?: () => number;
  maxEntries?: number;
}

interface PendingEntry {
  value: PendingCompaction;
  createdAt: number;
}

export function createPendingSlot(opts: PendingSlotOptions): PendingSlot {
  const ttlMs = opts.ttlMs;
  const now = opts.now ?? Date.now;
  const maxEntries = Math.max(1, opts.maxEntries ?? 64);
  const entries = new Map<string, PendingEntry>();
  let newestSessionId: string | null = null;

  const refreshNewest = (): void => {
    newestSessionId = null;
    for (const sessionId of entries.keys()) newestSessionId = sessionId;
  };
  const deleteEntry = (sessionId: string): void => {
    if (!entries.delete(sessionId)) return;
    if (newestSessionId === sessionId) refreshNewest();
  };
  const prune = (): void => {
    const current = now();
    let removedNewest = false;
    for (const [sessionId, entry] of entries) {
      if (current - entry.createdAt <= ttlMs) continue;
      entries.delete(sessionId);
      if (newestSessionId === sessionId) removedNewest = true;
    }
    if (removedNewest) refreshNewest();
  };

  return {
    set(pending): void {
      prune();
      // Reinsert overwrites at the newest position.
      entries.delete(pending.sessionId);
      entries.set(pending.sessionId, { value: pending, createdAt: now() });
      newestSessionId = pending.sessionId;
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        deleteEntry(oldest);
      }
    },

    consume(ctx): ConsumeResult {
      const currentSessionId = resolveSessionId(ctx);
      const entry = entries.get(currentSessionId);
      if (entry) {
        const ageMs = now() - entry.createdAt;
        if (ageMs > ttlMs) {
          deleteEntry(currentSessionId);
          prune();
          return { kind: "expired", ageMs };
        }
        deleteEntry(currentSessionId);
        return { kind: "ok", pending: entry.value };
      }
      prune();
      const other = newestSessionId == null ? undefined : entries.get(newestSessionId);
      return other
        ? { kind: "mismatch", expected: other.value.sessionId, actual: currentSessionId }
        : { kind: "empty" };
    },

    clear(sessionId): void {
      if (sessionId) deleteEntry(sessionId);
      else {
        entries.clear();
        newestSessionId = null;
      }
    },

    isPresent(sessionId): boolean {
      prune();
      return sessionId ? entries.has(sessionId) : entries.size > 0;
    },

    peek(sessionId): Readonly<PendingCompaction> | null {
      prune();
      const entry = sessionId
        ? entries.get(sessionId)
        : newestSessionId == null ? undefined : entries.get(newestSessionId);
      return entry?.value ?? null;
    },

    size(): number {
      prune();
      return entries.size;
    },
  };
}
