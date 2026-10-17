// Tail-aware trim plan selection (A): the rewritten suffix runs from the FIRST
// edited entry to the branch end, so an early low-value eligible entry can
// drag a huge tail into the break-even bill while later entries are free.
// Candidates are the prefix-drop frontier of the position-sorted eligible set
// — provably complete, because savings are position-independent and the tail
// is determined solely by the earliest position. The best feasible candidate
// wins; when none is feasible the full plan is returned and callers hold as
// before.
//
// Fixture notes: KEEP_RECENT_TURNS=4 keeps the last four assistant turns, so
// sessions carry 6+ rounds with only the earliest rounds eligible, and every
// output clears MIN_TRIM_CHARS=2048.
import { describe, expect, it } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { planContextTrim, trimBreakEvenRequests, trimTokens } from "../src/app/context-operations.ts";
import { AUTO_TRIM_BREAK_EVEN_REQUESTS } from "../src/constants.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
// write premium high enough that a bloated tail cannot pay back quickly:
// N* = 19 * tail / saved with these rates.
const PRICY = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6, total: 0 };

function assistant(ts: number, callId: string, pattern: string): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "toolCall", id: callId, name: "grep", arguments: { pattern } }],
    api: "openai-completions", provider: "test", model: "m", stopReason: "toolUse", timestamp: ts,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
  };
}

/** Rounds of [outputChars, fillerChars] pairs; fillers grow the tail after that round's output. */
function session(rounds: Array<{ id: string; chars: number; filler: number }>): SessionManager {
  const sm = SessionManager.inMemory();
  sm.appendMessage({ role: "user", content: "Investigate the parser", timestamp: 1 });
  let ts = 10;
  rounds.forEach(({ id, chars, filler }, i) => {
    sm.appendMessage(assistant(ts++, id, `pattern-${i}`));
    sm.appendMessage({
      role: "toolResult", toolCallId: id, toolName: "grep", isError: false, timestamp: ts++,
      content: [{ type: "text", text: `match ${i}\n${"x".repeat(chars)}` }],
    });
    if (filler > 0) {
      sm.appendMessage({ role: "user", content: "y".repeat(filler), timestamp: ts++ });
      sm.appendMessage(assistant(ts++, `probe-${i}`, "probe"));
    }
  });
  return sm;
}

function economicsOf(sm: SessionManager, plan: ReturnType<typeof planContextTrim>) {
  const economics = trimTokens(sm.getBranch(), plan.entries, "test", "m");
  return { ...economics, breakEven: trimBreakEvenRequests(PRICY, economics.savedTokens, economics.tailTokens) };
}

/** Entry ids are host-generated hashes; map my fixture toolCallIds to them. */
function idOf(sm: SessionManager, callId: string): string | undefined {
  const entry = sm.getBranch().find(entry => entry.type === "message"
    && (entry.message as { role?: string; toolCallId?: string }).role === "toolResult"
    && (entry.message as { toolCallId?: string }).toolCallId === callId);
  return entry?.id;
}

describe("tail-aware trim plan selection", () => {
  it("keeps the full plan when it already passes break-even", () => {
    const sm = session([
      { id: "call-0", chars: 30_000, filler: 0 },
      { id: "call-1", chars: 30_000, filler: 0 },
      ...Array.from({ length: 4 }, (_, i) => ({ id: `tail-${i}`, chars: 500, filler: 0 })),
    ]);
    const plan = planContextTrim(sm.getBranch(), undefined, { minSavingChars: 1_000, economy: { provider: "test", model: "m", cost: PRICY } });
    expect(plan.automatic).toBe("ready");
    expect(plan.references).toHaveLength(2);
    expect(economicsOf(sm, plan).breakEven).toBeLessThanOrEqual(AUTO_TRIM_BREAK_EVEN_REQUESTS);
  });

  it("drops early low-value stragglers to shrink the tail and pass break-even", () => {
    // call-0/call-1 clear MIN_TRIM_CHARS but save little while sitting before
    // a huge filler: the full plan's rewritten suffix is enormous
    // (N* ≈ 43 > 24). The frontier drops both, the first edit lands past the
    // filler, and the remaining batch pays for itself (N* ≈ 2 ≤ 24).
    const sm = session([
      { id: "call-0", chars: 5_000, filler: 0 },
      { id: "call-1", chars: 5_000, filler: 150_000 },
      { id: "call-2", chars: 30_000, filler: 0 },
      { id: "call-3", chars: 30_000, filler: 0 },
      ...Array.from({ length: 4 }, (_, i) => ({ id: `tail-${i}`, chars: 500, filler: 0 })),
    ]);
    const plan = planContextTrim(sm.getBranch(), undefined, { minSavingChars: 1_000, economy: { provider: "test", model: "m", cost: PRICY } });
    expect(plan.references).not.toContain(idOf(sm, "call-0"));
    expect(plan.references).not.toContain(idOf(sm, "call-1"));
    expect(idOf(sm, "call-2")).toBeTruthy();
    expect(plan.references).toContain(idOf(sm, "call-2")!);
    expect(idOf(sm, "call-3")).toBeTruthy();
    expect(plan.references).toContain(idOf(sm, "call-3")!);
    expect(economicsOf(sm, plan).breakEven).toBeLessThanOrEqual(AUTO_TRIM_BREAK_EVEN_REQUESTS);
  });

  it("selected plan starts after the dropped prefix and matches trimTokens", () => {
    const sm = session([
      { id: "call-0", chars: 5_000, filler: 0 },
      { id: "call-1", chars: 5_000, filler: 150_000 },
      { id: "call-2", chars: 30_000, filler: 0 },
      { id: "call-3", chars: 30_000, filler: 0 },
      ...Array.from({ length: 4 }, (_, i) => ({ id: `tail-${i}`, chars: 500, filler: 0 })),
    ]);
    const plan = planContextTrim(sm.getBranch(), undefined, { minSavingChars: 1_000, economy: { provider: "test", model: "m", cost: PRICY } });
    const economics = trimTokens(sm.getBranch(), plan.entries, "test", "m");
    expect(economics.savedTokens).toBeGreaterThan(0);
    const first = plan.entries.find(entry => entry.type === "context_edit")?.targetId;
    expect(first).toBe(idOf(sm, "call-2"));
  });

  it("returns the full plan when no candidate is feasible", () => {
    const sm = session([
      ...Array.from({ length: 6 }, (_, i) => ({ id: `call-${i}`, chars: 5_000, filler: 0 })),
    ]);
    const plan = planContextTrim(sm.getBranch(), undefined, { minSavingChars: 30_000 });
    expect(plan.automatic).toBe("insufficient-savings");
    expect(plan.references).toHaveLength(2);
  });

  it("prefers the plan with more saved characters among feasible candidates", () => {
    // Everything feasible; the full set saves more than any dropped variant,
    // so no entries are dropped even with a modest filler after call-0.
    const sm = session([
      ...Array.from({ length: 6 }, (_, i) => ({ id: `call-${i}`, chars: 20_000, filler: i === 0 ? 10_000 : 0 })),
    ]);
    const plan = planContextTrim(sm.getBranch(), undefined, { minSavingChars: 1_000, economy: { provider: "test", model: "m", cost: PRICY } });
    expect(plan.references).toHaveLength(2);
    expect(plan.automatic).toBe("ready");
  });

  it("respects MAX_TRIM_EDITS while choosing candidates", () => {
    const sm = session(Array.from({ length: 8 }, (_, i) => ({ id: `call-${i}`, chars: 6_000, filler: 0 })));
    const plan = planContextTrim(sm.getBranch(), undefined, { minSavingChars: 1_000, economy: { provider: "test", model: "m", cost: PRICY } });
    expect(plan.references.length).toBeLessThanOrEqual(32);
    expect(plan.references.length).toBeGreaterThan(0);
  });
});
