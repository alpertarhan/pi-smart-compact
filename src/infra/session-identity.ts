/**
 * Session-identity resolution.
 *
 * Pi's `sessionManager.getSessionId()` is typed as `string` and in normal
 * operation always returns a real id. We still defend against a transient
 * `undefined` (older host versions, mocked test contexts, race conditions
 * during shutdown) — but the previous fallback used a *sentinel literal*
 * (`"unknown"`) which silently re-opened the very cross-session leak that
 * `PendingCompaction.sessionId` was introduced to close:
 *
 *   Session A: getSessionId() → undefined → stored as "unknown"
 *   Session B: getSessionId() → undefined → compared as "unknown"
 *   "unknown" === "unknown"  ⇒  payload from A is applied to B.
 *
 * The fix is to make the fallback *unforgeable*: every unresolved call
 * yields a fresh, namespaced id (`unresolved:<random>`). Two unresolved
 * sessions therefore can never collide. The `unresolved:` prefix is also
 * a useful diagnostic signal — debug logs / metrics can see at a glance
 * that the host did not surface a real session id.
 *
 * Centralizing the helper guarantees the producer (window stage) and the
 * consumer (session_before_compact guard) agree on the exact contract;
 * no caller is allowed to reinvent the fallback locally.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Minimal structural slice of `ExtensionContext` we need. Using
 * `Pick<ExtensionContext, "sessionManager">` instead of an ad-hoc
 * `interface CtxLike` ties the helper to the real host contract: if the
 * upstream surface changes, this signature changes with it and the
 * compiler flags every caller — we can no longer silently accept any
 * object that happens to expose a `sessionManager` field.
 */
export type SessionIdentityContext = Pick<ExtensionContext, "sessionManager">;

const UNRESOLVED_PREFIX = "unresolved:";

/**
 * Resolve the current pi session id, or mint a per-call sentinel that can
 * never compare equal to another caller's sentinel.
 *
 * Callers should treat the returned string as opaque; only equality against
 * another id from the same process is meaningful (which is precisely the
 * cross-session-leak guard's contract).
 *
 * The fallback uses `crypto.randomUUID()` (122 bits of randomness, ~12x
 * more entropy than the previous 48-bit hex) and is the idiomatic Node /
 * Bun way to obtain a process-unique token without external deps.
 */
export function resolveSessionId(ctx: SessionIdentityContext): string {
  // The defensive optional chain stays even though `getSessionId` is typed
  // as `string` non-optional: mock contexts in tests and older host versions
  // can return undefined, and a single `undefined.method()` here would crash
  // the entire compact pipeline.
  const resolved = ctx.sessionManager?.getSessionId?.();
  if (typeof resolved === "string" && resolved.length > 0) return resolved;
  return UNRESOLVED_PREFIX + randomUUID();
}

/**
 * True when `id` was produced by `resolveSessionId` as a fallback (no real
 * session id was available). Used by guards that want to refuse to act on
 * an unidentifiable session entirely, rather than relying on equality.
 */
export function isUnresolvedSessionId(id: string): boolean {
  return id.startsWith(UNRESOLVED_PREFIX);
}
