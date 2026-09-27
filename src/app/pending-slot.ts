/** Session-scoped pending compaction store with TTL and bounded memory. */

import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ESTIMATOR_ROUNDING_TOLERANCE_TOKENS, MIN_COMPACTION_SAVING_RATIO } from "../constants.ts";
import type { PendingCompaction, SessionMessageEntry } from "../types.ts";
import { contextMessageEntries } from "../infra/ai-messages.ts";
import { branchEntryIds, resolveSessionId, type SessionIdentityContext } from "../infra/session-identity.ts";

export function fingerprintContext(messages: readonly SessionMessageEntry[]): NonNullable<PendingCompaction["contextSnapshot"]> {
  const hash = createHash("sha256");
  for (const message of messages) hash.update(JSON.stringify(message)).update("\n");
  return { messageCount: messages.length, hash: hash.digest("hex") };
}

/** Permit append-only growth, never branch changes or edits to the captured context. */
export function pendingMatchesBranch(pending: PendingCompaction, branch: readonly { id?: unknown }[]): boolean {
  const ids = new Set(branchEntryIds(branch));
  if (!ids.has(pending.originBranchHeadId) || !ids.has(pending.firstKeptEntryId)) return false;
  if (!pending.contextSnapshot) return true;
  const messages = contextMessageEntries(branch).slice(0, pending.contextSnapshot.messageCount);
  const current = fingerprintContext(messages);
  return current.messageCount === pending.contextSnapshot.messageCount && current.hash === pending.contextSnapshot.hash;
}

/** Capture before preparation starts, not after a possibly long-running provider call. */
export function readerSignature(ctx: Pick<ExtensionContext, "model">): string | undefined {
  const model = ctx.model;
  return model && JSON.stringify([model.provider, model.id, model.api, model.baseUrl, model.contextWindow, model.maxTokens]);
}

/** Shared final gate for foreground and background candidates. Missing proof fails closed. */
export function revalidatePending(pending: PendingCompaction, ctx: ExtensionContext, reserveTokens = 0): PendingCompaction | null {
  const model = ctx.model;
  const tokens = ctx.getContextUsage()?.tokens;
  const estimatedAfter = pending.details.estimatedAfterTokens;
  if (!model || !pending.readerSignature || pending.readerSignature !== readerSignature(ctx)
    || pending.sessionId !== resolveSessionId(ctx) || !pendingMatchesBranch(pending, ctx.sessionManager.getBranch())
    || typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0
    || !Number.isFinite(pending.tokensBefore) || pending.tokensBefore <= 0
    || typeof estimatedAfter !== "number" || !Number.isFinite(estimatedAfter) || estimatedAfter < 0
    || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0 || !Number.isFinite(reserveTokens)) return null;
  const growth = Math.max(0, tokens - pending.tokensBefore);
  const after = estimatedAfter + growth;
  const reserve = Math.max(8_192, model.maxTokens ?? 0, reserveTokens);
  const target = pending.details.targetAfterTokens;
  if (!Number.isFinite(reserve) || after >= model.contextWindow - reserve
    || (tokens - after) / tokens < MIN_COMPACTION_SAVING_RATIO
    || (typeof target === "number" && (!Number.isFinite(target) || after > target + ESTIMATOR_ROUNDING_TOLERANCE_TOKENS))) return null;
  const details = {
    ...pending.details, tokensBefore: tokens, estimatedAfterTokens: after,
    retainedTailTokens: (pending.details.retainedTailTokens ?? 0) + growth,
    tokensSaved: tokens - after, estimatedSavedTokens: tokens - after, estimatedYield: (tokens - after) / tokens,
  };
  return { ...pending, tokensBefore: tokens, details,
    metricsSnapshot: pending.metricsSnapshot && {
      ...pending.metricsSnapshot, tokensBefore: tokens, estimatedAfterTokens: after,
      retainedTailTokens: details.retainedTailTokens, tokensSaved: details.tokensSaved,
      estimatedSavedTokens: details.estimatedSavedTokens, estimatedYield: details.estimatedYield,
      contextPercent: tokens / model.contextWindow * 100,
    },
  };
}

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
