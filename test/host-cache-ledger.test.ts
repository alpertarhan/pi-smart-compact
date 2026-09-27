import { describe, expect, it } from "bun:test";
import { FIVE_MINUTES_MS, ONE_HOUR_MS, REBUILD_MIN_TOKENS } from "../src/constants.ts";
import { createHostCacheLedger, formatCacheLedgerSummary } from "../src/app/host-cache-ledger.ts";

const MINUTE = 60_000;
function usage(input: number, cacheRead: number, cacheWrite = 0, extra: Record<string, unknown> = {}) {
  return { input, output: 100, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 100, ...extra };
}
/** Session with a warm first request at t=0. */
function warm() {
  const ledger = createHostCacheLedger();
  ledger.reset("s1");
  ledger.observe({ usage: usage(1_000, 0, 100_000), provider: "anthropic" }, 0);
  return ledger;
}

describe("host prompt-cache ledger", () => {
  it("never classifies the session's first request as a rebuild", () => {
    const ledger = createHostCacheLedger();
    ledger.reset("s1");
    expect(ledger.observe({ usage: usage(0, 0, 200_000) }, 0)).toMatchObject({ rebuild: false, uncached: 200_000, prompt: 200_000 });
  });

  it("requires uncached >= max(REBUILD_MIN_TOKENS, half the prompt)", () => {
    const ledger = warm();
    // Just under the absolute floor although above half the prompt.
    expect(ledger.observe({ usage: usage(REBUILD_MIN_TOKENS - 1, 0) }, MINUTE)?.rebuild).toBe(false);
    expect(ledger.observe({ usage: usage(REBUILD_MIN_TOKENS, 0) }, 2 * MINUTE)?.rebuild).toBe(true);
    // Above the floor but below half the prompt: a large new tail, not a rebuild.
    expect(ledger.observe({ usage: usage(20_000, 40_001) }, 3 * MINUTE)?.rebuild).toBe(false);
    expect(ledger.observe({ usage: usage(10_000, 20_000, 10_000) }, 4 * MINUTE)).toMatchObject({ rebuild: true, uncached: 20_000, prompt: 40_000 });
  });

  it("attributes continuity before idle-expiry before foreign", () => {
    const ledger = warm();
    ledger.noteContextEdit("trim");
    // Idle gap and a Continuity edit: the edit wins, then is consumed.
    expect(ledger.observe({ usage: usage(0, 0, 90_000) }, 10 * MINUTE)).toMatchObject({ cause: "continuity", editKind: "trim" });
    expect(ledger.observe({ usage: usage(0, 0, 90_000) }, 10 * MINUTE + FIVE_MINUTES_MS + 1)?.cause).toBe("idle-expiry");
    const at = 10 * MINUTE + FIVE_MINUTES_MS + 1;
    expect(ledger.observe({ usage: usage(0, 0, 90_000) }, at + FIVE_MINUTES_MS)?.cause).toBe("foreign");
    // A non-rebuild request still consumes a pending edit.
    ledger.noteContextEdit("navigation");
    ledger.observe({ usage: usage(100, 90_000) }, at + FIVE_MINUTES_MS + MINUTE);
    expect(ledger.observe({ usage: usage(0, 0, 90_000) }, at + FIVE_MINUTES_MS + 2 * MINUTE)?.cause).toBe("foreign");
  });

  it("uses a 1h TTL while the live prefix was written with 1h retention", () => {
    const ledger = createHostCacheLedger();
    ledger.reset("s1");
    ledger.observe({ usage: usage(100, 0, 80_000, { cacheWrite1h: 80_000 }) }, 0);
    // A pure cache read keeps the 1h retention of the prefix it read.
    ledger.observe({ usage: usage(100, 80_000) }, MINUTE);
    expect(ledger.observe({ usage: usage(0, 0, 80_000, { cacheWrite1h: 80_000 }) }, MINUTE + 30 * MINUTE)?.cause).toBe("foreign");
    expect(ledger.observe({ usage: usage(0, 0, 80_000) }, 31 * MINUTE + ONE_HOUR_MS + 1)?.cause).toBe("idle-expiry");
    // That write reported no 1h split: back to 5 minutes.
    expect(ledger.observe({ usage: usage(0, 0, 80_000) }, 31 * MINUTE + ONE_HOUR_MS + 1 + 6 * MINUTE)?.cause).toBe("idle-expiry");
  });

  it("counts a cache_warm refresh as the previous keep-alive for one cache lifetime", () => {
    const ledger = warm();
    ledger.noteCacheWarm(4 * MINUTE);
    // 8 minutes after the last request, 4 after the refresh: the prefix was still cached.
    expect(ledger.observe({ usage: usage(0, 0, 90_000) }, 8 * MINUTE)).toMatchObject({ cause: "foreign", gapMs: 8 * MINUTE });
    ledger.noteCacheWarm(9 * MINUTE);
    ledger.noteContextEdit("trim");
    expect(ledger.observe({ usage: usage(0, 0, 90_000) }, 12 * MINUTE)?.cause).toBe("continuity");
    ledger.noteCacheWarm(30 * MINUTE);
    expect(ledger.observe({ usage: usage(0, 0, 90_000) }, 30 * MINUTE + FIVE_MINUTES_MS + 1)?.cause).toBe("idle-expiry");
  });

  it("warns exactly once, on the third foreign rebuild", () => {
    const ledger = warm();
    const warns = Array.from({ length: 5 }, (_, i) => ledger.observe({ usage: usage(0, 0, 90_000) }, (i + 1) * MINUTE)?.warn);
    expect(warns).toEqual([undefined, undefined, true, undefined, undefined]);
    ledger.reset("s2");
    ledger.observe({ usage: usage(0, 0, 90_000) }, 0);
    const again = Array.from({ length: 3 }, (_, i) => ledger.observe({ usage: usage(0, 0, 90_000) }, (i + 1) * MINUTE)?.warn);
    expect(again).toEqual([undefined, undefined, true]);
  });

  it("sums tokens, rebuilds by cause, per-kind attribution and priced cost", () => {
    const ledger = warm();
    const cost = (input: number, cacheWrite: number) => ({ input, output: 0.01, cacheRead: 0.001, cacheWrite, total: input + cacheWrite + 0.011 });
    ledger.noteContextEdit("compaction");
    ledger.observe({ usage: usage(2_000, 0, 30_000, { cost: cost(0.1, 0.2) }) }, MINUTE);
    ledger.observe({ usage: usage(500, 32_000, 0, { cost: cost(0.01, 0) }) }, 2 * MINUTE);
    ledger.observe({ usage: usage(0, 0, 40_000) }, 20 * MINUTE);
    const summary = ledger.summary();
    expect(summary).toMatchObject({
      sessionId: "s1", requests: 4, input: 3_500, cacheRead: 32_000, cacheWrite: 170_000,
      rebuilds: { continuity: { count: 1, uncached: 32_000 }, "idle-expiry": { count: 1, uncached: 40_000 }, foreign: { count: 0, uncached: 0 } },
      continuity: { trim: { count: 0, uncached: 0 }, navigation: { count: 0, uncached: 0 }, compaction: { count: 1, uncached: 32_000 } },
    });
    expect(summary.cost.requests).toBe(2);
    expect(summary.cost.total).toBeCloseTo(0.332, 10);
    expect(summary.cost.rebuildUncached).toBeCloseTo(0.3, 10);
    expect(formatCacheLedgerSummary(summary)).toEqual([
      "Host prompt cache: 4 requests · 16% of prompt tokens read from cache · 2 rebuilds",
      "Rebuilds: 1 after Continuity edits (compaction 1): 32k uncached · 1 idle-expiry: 40k uncached",
      "Cost (Pi model pricing): $0.3320 total · $0.3000 uncached input+cache writes on rebuilds",
    ]);
  });

  it("skips messages without measured usage and never lets them move the baseline", () => {
    const ledger = warm();
    expect(ledger.observe({}, MINUTE)).toBeNull();
    expect(ledger.observe({ usage: { cacheRead: 5 } }, MINUTE)).toBeNull();
    expect(ledger.observe({ usage: usage(0, 0) }, 30 * MINUTE)).toBeNull();
    expect(ledger.summary().requests).toBe(1);
    expect(ledger.observe({ usage: usage(0, 0, 90_000) }, 2 * MINUTE)?.cause).toBe("foreign");
  });

  it("reset forgets totals, the baseline and pending edits", () => {
    const ledger = warm();
    ledger.observe({ usage: usage(0, 0, 90_000) }, MINUTE);
    ledger.noteContextEdit("trim");
    ledger.reset("s2");
    expect(ledger.summary()).toMatchObject({ sessionId: "s2", requests: 0, rebuilds: { foreign: { count: 0 } } });
    expect(formatCacheLedgerSummary(ledger.summary())).toEqual([]);
    expect(ledger.observe({ usage: usage(0, 0, 90_000) }, 2 * MINUTE)?.rebuild).toBe(false);
    expect(ledger.observe({ usage: usage(0, 0, 90_000) }, 3 * MINUTE)?.cause).toBe("foreign");
  });
});
