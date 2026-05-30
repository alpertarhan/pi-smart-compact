/**
 * Pending-compaction slot.
 *
 * A single-element, owner-private state cell that holds the *most recently
 * prepared* `PendingCompaction` until the next `session_before_compact`
 * event consumes it. Concurrency model:
 *
 *   - One producer (`runSmartCompact` → `stagePendingCompaction`).
 *   - One consumer (`session_before_compact` event handler).
 *   - Single-threaded JS event loop; no atomic primitives needed.
 *
 * Design rationale — why an encapsulated factory instead of a mutable
 * `{ value, createdAt }` ref-cell:
 *
 *   1. **Invariant centralization.** The "set → consume → clear" lifecycle
 *      lives in one file. Callers cannot accidentally null `value` without
 *      also resetting `createdAt`, nor can they read a `value` snapshot
 *      against a freshly-overwritten `createdAt` (the original bare-ref
 *      shape allowed this race; see B3 in code-review #3).
 *
 *   2. **Observable consume result.** `consume()` returns a discriminated
 *      union that records *why* a payload was rejected (empty / expired /
 *      session-mismatch). The previous helper folded all three into
 *      `null`, which hid information the caller might want to surface as
 *      metrics or differentiated notifications.
 *
 *   3. **Atomic snapshot.** Every consume path destructures a single
 *      `{ value, createdAt }` snapshot up front so the TTL and id checks
 *      operate on a coherent view, even if a future maintainer threads an
 *      `await` into the middle of the function.
 *
 *   4. **No host-context coupling.** The slot does NOT call
 *      `ctx.ui.notify` itself — the caller decides the UX (silent metric,
 *      toast, log line). This keeps the module pure / fully unit-testable
 *      without a fake host context.
 */

import type { PendingCompaction } from "../types.ts";
import { resolveSessionId, type SessionIdentityContext } from "../infra/session-identity.ts";

/**
 * Outcome of `PendingSlot.consume()`. Discriminated union so callers can
 * react differently to each rejection reason (e.g. log a stale payload at
 * `warn`, but a cross-session mismatch at `error`).
 */
export type ConsumeResult =
  | { kind: "ok"; pending: PendingCompaction }
  | { kind: "empty" }
  | { kind: "expired"; ageMs: number }
  | { kind: "mismatch"; expected: string; actual: string };

/**
 * Public surface of an owned pending-compaction slot. Producers call
 * `set()` once they have a finished summary; consumers call `consume()` at
 * the next compact boundary. `isPresent()` is a non-mutating peek used by
 * the orchestrator for UI wording ("prepared, awaiting native /compact"
 * vs. "run finished").
 */
export interface PendingSlot {
  set(pending: PendingCompaction): void;
  consume(ctx: SessionIdentityContext): ConsumeResult;
  clear(): void;
  isPresent(): boolean;
  /**
   * Side-effect-free read. Returns the staged payload without consuming it
   * or running any guard checks. Intended for *display* paths (e.g. a tool
   * response that wants to surface `tokensBefore` after a prepare-only run).
   * Callers must NOT pass the returned payload to the host — only `consume`
   * enforces the freshness + session-match invariants.
   */
  peek(): Readonly<PendingCompaction> | null;
}

/**
 * Optional injection seam for `Date.now`. Tests pass a fake clock so they
 * can advance time without `await new Promise(setTimeout)`. Production
 * callers omit this and get real wall-clock time.
 */
export interface PendingSlotOptions {
  ttlMs: number;
  now?: () => number;
}

export function createPendingSlot(opts: PendingSlotOptions): PendingSlot {
  const ttlMs = opts.ttlMs;
  const now = opts.now ?? Date.now;

  let value: PendingCompaction | null = null;
  let createdAt = 0;

  return {
    set(pending: PendingCompaction): void {
      value = pending;
      createdAt = now();
    },

    consume(ctx: SessionIdentityContext): ConsumeResult {
      // Atomic snapshot: read both fields into locals before any further
      // logic. Even though the JS event loop is single-threaded, this
      // protects against future refactors that thread an `await` between
      // the read and the checks below.
      const snapshotValue = value;
      const snapshotCreatedAt = createdAt;

      if (!snapshotValue) return { kind: "empty" };

      const ageMs = now() - snapshotCreatedAt;
      if (ageMs > ttlMs) {
        // Drop the stale payload so a future consume doesn't keep tripping
        // over it. The producer (orchestrator) will simply re-prepare on
        // the next run.
        value = null;
        createdAt = 0;
        return { kind: "expired", ageMs };
      }

      const currentSessionId = resolveSessionId(ctx);
      if (snapshotValue.sessionId !== currentSessionId) {
        // Cross-session leak guard: a payload prepared by session A must
        // never be applied to session B (two pi sessions can share a Node
        // process via sub-agents). Drop the payload; the originating
        // session will re-prepare on its next attempt.
        value = null;
        createdAt = 0;
        return {
          kind: "mismatch",
          expected: snapshotValue.sessionId,
          actual: currentSessionId,
        };
      }

      // Successful consume: clear the slot atomically with the return so
      // a re-entrant consume immediately sees `empty`.
      value = null;
      createdAt = 0;
      return { kind: "ok", pending: snapshotValue };
    },

    clear(): void {
      value = null;
      createdAt = 0;
    },

    isPresent(): boolean {
      return value !== null;
    },

    peek(): Readonly<PendingCompaction> | null {
      return value;
    },
  };
}
