/**
 * Coverage for the encapsulated `PendingSlot` lifecycle.
 *
 * The slot replaces a bare `{ value, createdAt }` ref-cell with an opaque
 * factory that enforces three invariants the previous shape allowed
 * callers to violate:
 *
 *   1. `consume()` is atomic (snapshot before checks)
 *   2. TTL expiry clears the slot as a side effect
 *   3. A pending payload from session A never satisfies a consume from
 *      session B, even if both happen inside the same Node process
 *
 * We exercise each invariant with a fake clock + minimal context.
 */
import { describe, it, expect } from "bun:test";
import { createPendingSlot, type ConsumeResult } from "../src/app/pending-slot.ts";
import type { PendingCompaction } from "../src/types.ts";
import type { SessionIdentityContext } from "../src/infra/session-identity.ts";

function makePayload(sessionId: string, summary = "## Done\n- thing"): PendingCompaction {
  return {
    summary,
    firstKeptEntryId: "entry_1",
    tokensBefore: 12345,
    details: {} as PendingCompaction["details"],
    sessionId,
  };
}

function ctxWith(id: string): SessionIdentityContext {
  return {
    sessionManager: { getSessionId: () => id },
  } as unknown as SessionIdentityContext;
}

function assertOk(r: ConsumeResult): asserts r is { kind: "ok"; pending: PendingCompaction } {
  if (r.kind !== "ok") throw new Error("expected ok, got " + JSON.stringify(r));
}

describe("PendingSlot — empty + isPresent", () => {
  it("returns empty when no payload has been staged", () => {
    const slot = createPendingSlot({ ttlMs: 60_000 });
    expect(slot.isPresent()).toBe(false);
    expect(slot.peek()).toBeNull();
    expect(slot.consume(ctxWith("sess_a")).kind).toBe("empty");
  });

  it("isPresent flips true after set and false after consume", () => {
    const slot = createPendingSlot({ ttlMs: 60_000 });
    slot.set(makePayload("sess_a"));
    expect(slot.isPresent()).toBe(true);
    const r = slot.consume(ctxWith("sess_a"));
    assertOk(r);
    expect(slot.isPresent()).toBe(false);
  });

  it("peek does not consume", () => {
    const slot = createPendingSlot({ ttlMs: 60_000 });
    const p = makePayload("sess_a");
    slot.set(p);
    expect(slot.peek()).toMatchObject({ sessionId: "sess_a", tokensBefore: 12345 });
    expect(slot.peek()).toMatchObject({ sessionId: "sess_a" });
    expect(slot.isPresent()).toBe(true);
  });
});

describe("PendingSlot — happy path", () => {
  it("returns the staged payload on a same-session consume", () => {
    const slot = createPendingSlot({ ttlMs: 60_000 });
    const payload = makePayload("sess_a", "## Summary");
    slot.set(payload);
    const r = slot.consume(ctxWith("sess_a"));
    assertOk(r);
    expect(r.pending).toBe(payload);
    // Slot is cleared after a successful consume so a re-entrant call sees empty.
    expect(slot.consume(ctxWith("sess_a")).kind).toBe("empty");
  });
});

describe("PendingSlot — TTL expiry", () => {
  it("returns expired and clears when age > ttl", () => {
    let t = 1_000;
    const slot = createPendingSlot({ ttlMs: 100, now: () => t });
    slot.set(makePayload("sess_a"));    // createdAt = 1000
    t = 1_200;                          // age = 200 > 100
    const r = slot.consume(ctxWith("sess_a"));
    expect(r.kind).toBe("expired");
    if (r.kind === "expired") expect(r.ageMs).toBe(200);
    expect(slot.isPresent()).toBe(false);
  });

  it("does not expire at exactly the boundary (age === ttl)", () => {
    let t = 1_000;
    const slot = createPendingSlot({ ttlMs: 100, now: () => t });
    slot.set(makePayload("sess_a"));
    t = 1_100;                          // age === 100, NOT > 100
    const r = slot.consume(ctxWith("sess_a"));
    expect(r.kind).toBe("ok");
  });

  it("a second consume after expiry sees empty (the slot self-clears)", () => {
    let t = 0;
    const slot = createPendingSlot({ ttlMs: 50, now: () => t });
    slot.set(makePayload("sess_a"));
    t = 1_000;
    expect(slot.consume(ctxWith("sess_a")).kind).toBe("expired");
    expect(slot.consume(ctxWith("sess_a")).kind).toBe("empty");
  });
});

describe("PendingSlot — cross-session leak guard", () => {
  it("returns mismatch when the consume ctx is a different session", () => {
    const slot = createPendingSlot({ ttlMs: 60_000 });
    slot.set(makePayload("sess_A"));
    const r = slot.consume(ctxWith("sess_B"));
    expect(r.kind).toBe("mismatch");
    if (r.kind === "mismatch") {
      expect(r.expected).toBe("sess_A");
      expect(r.actual).toBe("sess_B");
    }
    // Mismatched payloads are dropped — session B must never see session A's data.
    expect(slot.isPresent()).toBe(false);
  });

  it("two unresolved sessions never satisfy each other (regression: B1)", () => {
    // The previous sentinel fallback (`?? \"unknown\"`) would have let this pass.
    // `resolveSessionId` now mints a unique id per call, so even two consecutive
    // unresolved ctxs compare unequal.
    const unresolvedCtx = (): SessionIdentityContext =>
      ({ sessionManager: { getSessionId: () => undefined as unknown as string } }) as SessionIdentityContext;
    const slot = createPendingSlot({ ttlMs: 60_000 });

    // Producer: set a payload whose sessionId was minted in session A.
    // We have to simulate that by importing resolveSessionId for the producer side too.
    const { resolveSessionId } = require("../src/infra/session-identity.ts");
    const producerId = resolveSessionId(unresolvedCtx());
    slot.set({
      summary: "x",
      firstKeptEntryId: "e",
      tokensBefore: 0,
      details: {} as PendingCompaction["details"],
      sessionId: producerId,
    });

    // Consumer is also unresolved but mints a fresh id, so mismatch fires.
    const r = slot.consume(unresolvedCtx());
    expect(r.kind).toBe("mismatch");
  });
});

describe("PendingSlot — clear", () => {
  it("clear() empties the slot regardless of contents", () => {
    const slot = createPendingSlot({ ttlMs: 60_000 });
    slot.set(makePayload("sess_a"));
    slot.clear();
    expect(slot.isPresent()).toBe(false);
    expect(slot.consume(ctxWith("sess_a")).kind).toBe("empty");
  });

  it("clear() on an already-empty slot is a no-op", () => {
    const slot = createPendingSlot({ ttlMs: 60_000 });
    expect(() => slot.clear()).not.toThrow();
    expect(slot.isPresent()).toBe(false);
  });
});

describe("PendingSlot — set overwrite", () => {
  it("a second set replaces the previous payload and resets createdAt", () => {
    let t = 0;
    const slot = createPendingSlot({ ttlMs: 100, now: () => t });
    slot.set(makePayload("sess_a", "first"));
    t = 80;
    slot.set(makePayload("sess_a", "second"));   // resets createdAt to 80
    t = 170;                                     // age relative to new = 90, NOT expired
    const r = slot.consume(ctxWith("sess_a"));
    assertOk(r);
    expect(r.pending.summary).toBe("second");
  });
});
