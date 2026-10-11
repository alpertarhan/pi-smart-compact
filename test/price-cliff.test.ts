// Price-cliff awareness (M): Anthropic bills long-context pricing above 200K
// prompt tokens; on large-window models the policy window reaches far past
// that. contextPressure exposes the crossing point so status JSON, the
// preflight card and the footer can show it. Attention bands (70%+) always sit
// past the cliff on big windows, so no advice line lives there.
// Exact first-party provider match only — proxies price differently.
import { describe, expect, it } from "bun:test";
import { contextPressure } from "../src/app/background-preparation.ts";
import { LONG_CONTEXT_PRICING_THRESHOLD_TOKENS } from "../src/constants.ts";

const config = { minContextPercent: 80, prepareContextPercent: null, maxContextTokens: 0 };

function pressure(provider: string | undefined, window: number, tokens: number) {
  return contextPressure(
    { model: provider ? { provider, id: "m", contextWindow: window, maxTokens: 8_192 } : undefined, getContextUsage: () => ({ tokens }) } as never,
    config,
  );
}

describe("contextPressure long-context pricing cliff", () => {
  it("threshold matches the documented first-party cliff", () => {
    expect(LONG_CONTEXT_PRICING_THRESHOLD_TOKENS).toBe(200_000);
  });

  it("exposes the cliff crossing for first-party anthropic on large windows", () => {
    const p = pressure("anthropic", 1_000_000, 100_000);
    expect(p.longContextPricing).toEqual({ thresholdTokens: 200_000, thresholdPercent: 20 });
    expect(p.percent).toBe(10); // 100k of a 1M policy window: still below the cliff
  });

  it("rounds the crossing percent for awkward windows", () => {
    const p = pressure("anthropic", 700_000, 100_000);
    expect(p.longContextPricing?.thresholdPercent).toBeCloseTo(200_000 / 700_000 * 100, 1);
  });

  it("stays silent on windows at or below the threshold", () => {
    expect(pressure("anthropic", 200_000, 50_000).longContextPricing).toBeUndefined();
  });

  it("does not guess pricing for proxies or other providers", () => {
    for (const provider of ["kimi-coding", "zai-anthropic", "openai", "claudin"]) {
      expect(pressure(provider, 1_000_000, 100_000).longContextPricing).toBeUndefined();
    }
  });

  it("stays silent without a model or window", () => {
    expect(pressure(undefined, 0, 100_000).longContextPricing).toBeUndefined();
  });
});
