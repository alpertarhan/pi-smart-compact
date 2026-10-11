// Fingerprint-aware pending TTL (E): a prepared summary may serve past its
// wall-clock TTL while its captured context fingerprint still matches the live
// branch. Revalidation at the consume sites already demands that proof, so the
// extension only removes a redundant expiry — it is opt-in and capped.
import { describe, expect, it } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";
import { fingerprintContext, pendingMatchesBranch } from "../src/app/pending-slot.ts";
import { createPendingSlot } from "../src/app/pending-slot.ts";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { validateSmartCompactConfig } from "../src/utils/helpers.ts";
import type { PendingCompaction } from "../src/types.ts";
import type { SessionIdentityContext } from "../src/infra/session-identity.ts";

let runCounter = 0;
function makePayload(sessionId: string): PendingCompaction {
  const runId = "fingerprint-run-" + ++runCounter;
  return {
    runId,
    summary: "## Done\n- thing",
    firstKeptEntryId: "entry_1",
    originBranchHeadId: "entry_1",
    tokensBefore: 12_345,
    details: { runId } as PendingCompaction["details"],
    sessionId,
  };
}

function ctxWith(id: string): SessionIdentityContext {
  return { sessionManager: { getSessionId: () => id } } as unknown as SessionIdentityContext;
}

const FRESH = () => true;

describe("PendingSlot fingerprint-aware TTL", () => {
  it("expires past the TTL when no ceiling is configured (current behavior)", () => {
    let t = 1_000;
    const slot = createPendingSlot({ ttlMs: 5_000, now: () => t });
    slot.set(makePayload("s1"));
    t += 6_000;
    const result = slot.consume(ctxWith("s1"));
    expect(result.kind).toBe("expired");
  });

  it("keeps expiring past the TTL when the ceiling is zero even with a probe", () => {
    let t = 1_000;
    const slot = createPendingSlot({ ttlMs: 5_000, maxAgeMs: 0, stillFresh: FRESH, now: () => t });
    slot.set(makePayload("s1"));
    t += 6_000;
    expect(slot.consume(ctxWith("s1")).kind).toBe("expired");
  });

  it("serves a still-fresh pending past the TTL, within the ceiling", () => {
    let t = 1_000;
    const slot = createPendingSlot({ ttlMs: 5_000, maxAgeMs: 30 * 60_000, stillFresh: FRESH, now: () => t });
    slot.set(makePayload("s1"));
    t += 6_000;
    const result = slot.consume(ctxWith("s1"));
    expect(result.kind).toBe("ok");
  });

  it("expires a diverged pending past the TTL even with a ceiling", () => {
    let t = 1_000;
    const slot = createPendingSlot({ ttlMs: 5_000, maxAgeMs: 30 * 60_000, stillFresh: () => false, now: () => t });
    slot.set(makePayload("s1"));
    t += 6_000;
    expect(slot.consume(ctxWith("s1")).kind).toBe("expired");
  });

  it("expires at the ceiling even when still fresh", () => {
    let t = 1_000;
    const slot = createPendingSlot({ ttlMs: 5_000, maxAgeMs: 30 * 60_000, stillFresh: FRESH, now: () => t });
    slot.set(makePayload("s1"));
    t += 31 * 60_000;
    expect(slot.consume(ctxWith("s1")).kind).toBe("expired");
  });

  it("keeps the entry visible until the ceiling without probing every view", () => {
    let t = 1_000;
    let probes = 0;
    const slot = createPendingSlot({
      ttlMs: 5_000,
      maxAgeMs: 30 * 60_000,
      stillFresh: () => { probes++; return true; },
      now: () => t,
    });
    slot.set(makePayload("s1"));
    t += 6_000; // past the soft TTL, inside the ceiling
    expect(slot.isPresent("s1")).toBe(true);
    expect(slot.peek("s1")).not.toBeNull();
    expect(slot.size()).toBe(1);
    expect(probes).toBe(0); // views prune by age only; the probe is consume-time
    t += 30 * 60_000; // past the ceiling (age > 30 min)
    expect(slot.isPresent("s1")).toBe(false);
    expect(slot.size()).toBe(0);
  });

  it("consumes atomically in the extended path", () => {
    let t = 1_000;
    const slot = createPendingSlot({ ttlMs: 5_000, maxAgeMs: 30 * 60_000, stillFresh: FRESH, now: () => t });
    slot.set(makePayload("s1"));
    t += 6_000;
    expect(slot.consume(ctxWith("s1")).kind).toBe("ok");
    expect(slot.consume(ctxWith("s1")).kind).toBe("empty");
  });

  it("leaves the mismatch path untouched", () => {
    let t = 1_000;
    const slot = createPendingSlot({ ttlMs: 5_000, maxAgeMs: 30 * 60_000, stillFresh: FRESH, now: () => t });
    slot.set(makePayload("s1"));
    t += 6_000;
    const result = slot.consume(ctxWith("s2"));
    expect(result.kind).toBe("mismatch");
  });
});

describe("pendingFingerprintTtlMs config", () => {
  it("defaults to off", () => {
    expect(DEFAULT_CONFIG.pendingFingerprintTtlMs).toBe(0);
  });

  it("accepts 0 and the documented range", () => {
    const zero: Record<string, unknown> = { pendingFingerprintTtlMs: 0 };
    validateSmartCompactConfig(zero);
    expect(zero.pendingFingerprintTtlMs).toBe(0);
    const minute: Record<string, unknown> = { pendingFingerprintTtlMs: 60_000 };
    validateSmartCompactConfig(minute);
    expect(minute.pendingFingerprintTtlMs).toBe(60_000);
    const hour: Record<string, unknown> = { pendingFingerprintTtlMs: 3_600_000 };
    validateSmartCompactConfig(hour);
    expect(hour.pendingFingerprintTtlMs).toBe(3_600_000);
  });

  it("discards out-of-range and non-numeric values", () => {
    const low: Record<string, unknown> = { pendingFingerprintTtlMs: 59_999 };
    validateSmartCompactConfig(low);
    expect("pendingFingerprintTtlMs" in low).toBe(false);
    const high: Record<string, unknown> = { pendingFingerprintTtlMs: 3_600_001 };
    validateSmartCompactConfig(high);
    expect("pendingFingerprintTtlMs" in high).toBe(false);
    const text: Record<string, unknown> = { pendingFingerprintTtlMs: "forever" };
    validateSmartCompactConfig(text);
    expect("pendingFingerprintTtlMs" in text).toBe(false);
  });
});

describe("fingerprint probe wiring (index contract)", () => {
  function branchSession(): SessionManager {
    const sm = SessionManager.inMemory();
    sm.appendMessage({ role: "user", content: "Implement the parser", timestamp: 1 });
    return sm;
  }

  function payloadFor(sm: SessionManager): PendingCompaction {
    const branch = sm.getBranch();
    const pending = makePayload(sm.getSessionId());
    pending.originBranchHeadId = branch.at(-1)!.id;
    pending.firstKeptEntryId = branch[0]!.id;
    pending.contextSnapshot = fingerprintContext(contextMessageEntries(sm.getBranch()));
    return pending;
  }

  function ctxOf(sm: SessionManager): SessionIdentityContext {
    return { sessionManager: sm } as unknown as SessionIdentityContext;
  }

  it("serves a prepared summary past its TTL while the branch is unchanged", () => {
    let t = 1_000;
    const sm = branchSession();
    const slot = createPendingSlot({
      ttlMs: 5_000, maxAgeMs: 30 * 60_000, now: () => t,
      stillFresh: (pending, ctx) => pendingMatchesBranch(pending, ctx.sessionManager.getBranch()),
    });
    slot.set(payloadFor(sm));
    t += 8 * 60_000; // user steps away, then runs /compact
    expect(slot.consume(ctxOf(sm)).kind).toBe("ok");
  });

  it("serves an append-only grown branch: tail growth stays outside the summary", () => {
    let t = 1_000;
    const sm = branchSession();
    const slot = createPendingSlot({
      ttlMs: 5_000, maxAgeMs: 30 * 60_000, now: () => t,
      stillFresh: (pending, ctx) => pendingMatchesBranch(pending, ctx.sessionManager.getBranch()),
    });
    slot.set(payloadFor(sm));
    t += 8 * 60_000;
    sm.appendMessage({ role: "user", content: "Actually, pivot to the CLI first", timestamp: 2 });
    // Append-only growth keeps the captured prefix byte-identical; the new
    // message lives after firstKeptEntryId and survives the compaction, and
    // revalidatePending prices the growth at consume time.
    expect(slot.consume(ctxOf(sm)).kind).toBe("ok");
  });

  it("expires when a context edit rewrote the captured prefix", () => {
    let t = 1_000;
    const sm = branchSession();
    const slot = createPendingSlot({
      ttlMs: 5_000, maxAgeMs: 30 * 60_000, now: () => t,
      stillFresh: (pending, ctx) => pendingMatchesBranch(pending, ctx.sessionManager.getBranch()),
    });
    slot.set(payloadFor(sm));
    t += 8 * 60_000;
    sm.appendContextEdit(sm.getBranch()[0]!.id, { content: "[Archived grep output]" });
    expect(slot.consume(ctxOf(sm)).kind).toBe("expired");
  });
});
