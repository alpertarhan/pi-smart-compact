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
  const maxEntries = Math.max(1, opts.maxEntries ?? 16);
  const entries = new Map<string, PendingEntry>();

  const prune = () => {
    const timestamp = now();
    for (const [sessionId, entry] of entries) {
      if (timestamp - entry.createdAt > ttlMs) entries.delete(sessionId);
    }
  };

  const newest = (): PendingEntry | undefined => {
    let result: PendingEntry | undefined;
    for (const entry of entries.values()) {
      if (!result || entry.createdAt >= result.createdAt) result = entry;
    }
    return result;
  };

  return {
    set(pending): void {
      prune();
      entries.delete(pending.sessionId);
      while (entries.size >= maxEntries) {
        const oldestSession = entries.keys().next().value as string | undefined;
        if (!oldestSession) break;
        entries.delete(oldestSession);
      }
      entries.set(pending.sessionId, { value: pending, createdAt: now() });
    },

    consume(ctx): ConsumeResult {
      const currentSessionId = resolveSessionId(ctx);
      const entry = entries.get(currentSessionId);
      if (!entry) {
        const other = entries.values().next().value as PendingEntry | undefined;
        return other
          ? { kind: "mismatch", expected: other.value.sessionId, actual: currentSessionId }
          : { kind: "empty" };
      }
      const ageMs = now() - entry.createdAt;
      if (ageMs > ttlMs) {
        entries.delete(currentSessionId);
        return { kind: "expired", ageMs };
      }
      entries.delete(currentSessionId);
      return { kind: "ok", pending: entry.value };
    },

    clear(sessionId): void {
      if (sessionId) entries.delete(sessionId);
      else entries.clear();
    },

    isPresent(sessionId): boolean {
      prune();
      return sessionId ? entries.has(sessionId) : entries.size > 0;
    },

    peek(sessionId): Readonly<PendingCompaction> | null {
      prune();
      return (sessionId ? entries.get(sessionId) : newest())?.value ?? null;
    },

    size(): number { prune(); return entries.size; },
  };
}
