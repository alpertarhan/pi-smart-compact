// Cache-inactive route detection (K): a documented-caching route that keeps
// serving large prompts with zero cache reads points at a broken contract
// (ignored markers, unrecognized request fields). The ledger flags the route
// once; surfacing lives in the extension wiring and metrics.
import { describe, expect, it } from "bun:test";
import type { ModelPromptCache } from "@earendil-works/pi-ai";
import {
  CACHE_INACTIVE_ROUTE_MIN_PROMPT_TOKENS,
  CACHE_INACTIVE_ROUTE_MIN_REQUESTS,
} from "../src/constants.ts";
import { createHostCacheLedger, formatCacheLedgerSummary } from "../src/app/host-cache-ledger.ts";

const MINUTE = 60_000;
function usage(input: number, cacheRead: number, cacheWrite = 0) {
  return { input, output: 100, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 100 };
}

function ledgerFor(provider: string, model = "fixture", promptCache: ModelPromptCache = { short: 300, long: 300 }) {
  const ledger = createHostCacheLedger();
  ledger.reset("s1");
  return {
    ledger,
    observe: (input: number, cacheRead: number, at: number, over: Record<string, unknown> = {}) =>
      ledger.observe({ provider, model, usage: usage(input, cacheRead), ...over }, at, promptCache),
  };
}

describe("cache-inactive route detection", () => {
  it("constants stay aligned with the documented provider minimums", () => {
    // 4096 covers the largest documented minimum (older Anthropic/Haiku 4.5),
    // so no prompt below any provider's cacheable floor can trigger a warning.
    expect(CACHE_INACTIVE_ROUTE_MIN_PROMPT_TOKENS).toBe(4_096);
    expect(CACHE_INACTIVE_ROUTE_MIN_REQUESTS).toBe(3);
  });

  it("flags a documented-caching route after the request streak", () => {
    const { ledger, observe } = ledgerFor("anthropic");
    expect(observe(50_000, 0, 0)?.inactive).toBeUndefined();
    expect(observe(50_000, 0, MINUTE)?.inactive).toBeUndefined();
    const third = observe(50_000, 0, 2 * MINUTE);
    expect(third?.inactive).toBe(true);
    const summary = ledger.summary();
    expect(summary.inactiveRoutes).toEqual([
      { provider: "anthropic", model: "fixture", requests: 3, uncached: 150_000 },
    ]);
    expect(formatCacheLedgerSummary(summary).join("\n")).toContain("never hits");
  });

  it("does not re-flag the route after the threshold", () => {
    const { ledger, observe } = ledgerFor("kimi-coding", "kimi-k3");
    observe(50_000, 0, 0);
    observe(50_000, 0, MINUTE);
    expect(observe(50_000, 0, 2 * MINUTE)?.inactive).toBe(true);
    expect(observe(50_000, 0, 3 * MINUTE)?.inactive).toBeUndefined();
    expect(ledger.summary().inactiveRoutes).toHaveLength(1);
  });

  it("full rewrites with large cache writes are rebuild evidence, not inactive evidence", () => {
    // Prefix changed each time: the provider accepted a new cache entry.
    // This is foreign-rebuild territory; the inactive streak must not fire.
    const ledger = createHostCacheLedger();
    ledger.reset("s1");
    for (let i = 0; i < CACHE_INACTIVE_ROUTE_MIN_REQUESTS + 1; i++) {
      const entry = ledger.observe(
        { provider: "anthropic", model: "claude", usage: usage(1_000, 0, 105_000) },
        i * MINUTE,
        { short: 300, long: 300 },
      );
      expect(entry?.inactive).toBeUndefined();
    }
    expect(ledger.summary().inactiveRoutes).toEqual([]);
  });

  it("a cache hit resets the streak", () => {
    const { observe } = ledgerFor("anthropic");
    observe(50_000, 0, 0);
    observe(50_000, 0, MINUTE);
    expect(observe(50_000, 40_000, 2 * MINUTE)?.inactive).toBeUndefined();
    expect(observe(50_000, 0, 3 * MINUTE)?.inactive).toBeUndefined();
    expect(observe(50_000, 0, 4 * MINUTE)?.inactive).toBeUndefined();
    expect(observe(50_000, 0, 5 * MINUTE)?.inactive).toBe(true);
  });

  it("ignores prompts below the cacheable floor", () => {
    const { ledger, observe } = ledgerFor("anthropic");
    for (let i = 0; i < CACHE_INACTIVE_ROUTE_MIN_REQUESTS + 1; i++) {
      expect(observe(1_000, 0, i * MINUTE)?.inactive).toBeUndefined();
    }
    expect(ledger.summary().inactiveRoutes).toEqual([]);
  });

  it("counts routes separately", () => {
    const ledger = createHostCacheLedger();
    ledger.reset("s1");
    const at = (i: number) => i * MINUTE;
    for (let i = 0; i < CACHE_INACTIVE_ROUTE_MIN_REQUESTS - 1; i++) {
      ledger.observe({ provider: "anthropic", model: "a", usage: usage(50_000, 0) }, at(i), { short: 300 });
      ledger.observe({ provider: "kimi-coding", model: "k3", usage: usage(50_000, 0) }, at(i), { short: 300 });
    }
    const flagged = ledger.observe({ provider: "anthropic", model: "a", usage: usage(50_000, 0) }, at(9), { short: 300 });
    expect(flagged?.inactive).toBe(true);
    expect(ledger.summary().inactiveRoutes).toEqual([
      { provider: "anthropic", model: "a", requests: 3, uncached: 150_000 },
    ]);
  });

  it("never flags providers without a documented caching discount", () => {
    const { ledger, observe } = ledgerFor("totally-unknown");
    for (let i = 0; i < CACHE_INACTIVE_ROUTE_MIN_REQUESTS + 1; i++) {
      expect(observe(50_000, 0, i * MINUTE)?.inactive).toBeUndefined();
    }
    expect(ledger.summary().inactiveRoutes).toEqual([]);
  });

  it("session reset clears route state", () => {
    const ledger = createHostCacheLedger();
    ledger.reset("s1");
    for (let i = 0; i < CACHE_INACTIVE_ROUTE_MIN_REQUESTS - 1; i++) {
      ledger.observe({ provider: "anthropic", model: "a", usage: usage(50_000, 0) }, i * MINUTE, { short: 300 });
    }
    ledger.reset("s2");
    expect(ledger.summary().inactiveRoutes).toEqual([]);
    const flagged = ledger.observe({ provider: "anthropic", model: "a", usage: usage(50_000, 0) }, 0, { short: 300 });
    // Fresh session: the streak restarts, one request is not enough.
    expect(flagged?.inactive).toBeUndefined();
  });
});
