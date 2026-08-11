/**
 * Coverage for the session-identity helper that closes the cross-session
 * leak guarded by `PendingCompaction.sessionId`.
 *
 * The invariant we care about is: every call that cannot reach a real id
 * MUST produce a fresh, namespaced sentinel — never a shared literal like
 * `"unknown"` — so that two unrelated sessions can never compare equal by
 * accident.
 */
import { describe, it, expect } from "bun:test";
import {
  boundedBranchLineageIds,
  resolveSessionId,
  isUnresolvedSessionId,
  type SessionIdentityContext,
  branchEntryIds,
} from "../src/infra/session-identity.ts";
import { runSmartCompact } from "../src/app/run-smart-compact.ts";
import { createPendingSlot } from "../src/app/pending-slot.ts";
import { createSessionRunLock } from "../src/app/session-run-lock.ts";

function ctxWith(id: string | undefined): SessionIdentityContext {
  // The helper accepts `Pick<ExtensionContext, "sessionManager">`, which in
  // production has many more fields — we only build the slice we need.
  return {
    sessionManager: {
      getSessionId: () => id as string,
    },
  } as unknown as SessionIdentityContext;
}

describe("branchEntryIds", () => {
  it("preserves full ordered ancestry while excluding absent and non-string ids", () => {
    expect(branchEntryIds([{ id: "root" }, {}, { id: 42 }, { id: "leaf" }])).toEqual(["root", "leaf"]);
  });
});

describe("boundedBranchLineageIds", () => {
  it("keeps a bounded tail plus old pre-compaction snapshot heads", () => {
    const branch = Array.from({ length: 1_000 }, (_, index) => ({
      id: "id-" + index,
      ...(index === 100 ? { type: "compaction", parentId: "id-99" } : {}),
    }));
    const ids = boundedBranchLineageIds(branch, 100);
    expect(ids).toHaveLength(100);
    expect(ids).toContain("id-99");
    expect(ids.at(-1)).toBe("id-999");
  });
});

describe("resolveSessionId — real session id", () => {
  it("returns the host-provided id verbatim when present", () => {
    const id = resolveSessionId(ctxWith("sess_abc123"));
    expect(id).toBe("sess_abc123");
    expect(isUnresolvedSessionId(id)).toBe(false);
  });

  it("treats an empty string as unresolved (host returned no real id)", () => {
    const id = resolveSessionId(ctxWith(""));
    expect(isUnresolvedSessionId(id)).toBe(true);
  });

  it("treats undefined as unresolved (older host versions)", () => {
    const id = resolveSessionId(ctxWith(undefined));
    expect(isUnresolvedSessionId(id)).toBe(true);
  });

  it("tolerates a missing sessionManager.getSessionId entirely", () => {
    const ctx = { sessionManager: {} } as unknown as SessionIdentityContext;
    const id = resolveSessionId(ctx);
    expect(isUnresolvedSessionId(id)).toBe(true);
  });
});

describe("resolveSessionId — unique fallback (cross-session leak guard)", () => {
  it("never produces the same sentinel twice", () => {
    // This is the security-critical invariant. The previous `?? \"unknown\"`
    // fallback returned the same literal across all unresolved callers,
    // which let session A's pending payload be applied to session B.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = resolveSessionId(ctxWith(undefined));
      expect(isUnresolvedSessionId(id)).toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });

  it("two unresolved sessions never compare equal", () => {
    const a = resolveSessionId(ctxWith(undefined));
    const b = resolveSessionId(ctxWith(undefined));
    expect(a).not.toBe(b);
    expect(a === b).toBe(false);
  });

  it("real and unresolved ids never collide", () => {
    const real = resolveSessionId(ctxWith("sess_xyz"));
    const fake = resolveSessionId(ctxWith(undefined));
    expect(real).not.toBe(fake);
    expect(isUnresolvedSessionId(real)).toBe(false);
    expect(isUnresolvedSessionId(fake)).toBe(true);
  });
});

describe("runSmartCompact unresolved identity guard", () => {
  it("stops before config, auth, LLM, or pending work", async () => {
    let authCalls = 0;
    const notices: string[] = [];
    const model = { provider: "openai", id: "test", contextWindow: 128_000 } as any;
    const outcome = await runSmartCompact({
      ctx: {
        sessionManager: { getSessionId: () => undefined },
        modelRegistry: {
          getApiKeyAndHeaders: async () => {
            authCalls++;
            return { ok: true, apiKey: "must-not-be-used" };
          },
        },
        ui: { notify: (message: string) => { notices.push(message); } },
      } as any,
      summaryModel: model,
      segModel: model,
      pendingRef: createPendingSlot({ ttlMs: 300_000 }),
      isRunning: createSessionRunLock(),
      autoTriggered: false,
    });

    expect(outcome).toEqual({ kind: "skipped", reason: "session-unavailable" });
    expect(authCalls).toBe(0);
    expect(notices.join(" ")).toContain("stable session ID");
  });
});

describe("isUnresolvedSessionId", () => {
  it("recognizes the namespaced prefix", () => {
    expect(isUnresolvedSessionId("unresolved:00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  it("rejects empty strings and unrelated tokens", () => {
    expect(isUnresolvedSessionId("")).toBe(false);
    expect(isUnresolvedSessionId("sess_abc")).toBe(false);
    expect(isUnresolvedSessionId("(no session)")).toBe(false);
    expect(isUnresolvedSessionId("unknown")).toBe(false);
  });

  it("is anchored to the start of the string", () => {
    // Defensive: a real id that happens to contain `unresolved:` mid-string
    // must NOT be classified as a fallback.
    expect(isUnresolvedSessionId("sess_unresolved:foo")).toBe(false);
  });
});
