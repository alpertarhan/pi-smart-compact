import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { compactionUsage } from "../src/domain/compaction-usage.ts";
import type { ProviderRouteMetric } from "../src/types.ts";

const model = (provider: string, id: string, cost: { input: number; output: number; cacheRead: number; cacheWrite: number }) =>
  ({ provider, id, api: "openai-responses", contextWindow: 200_000, maxTokens: 8_192, cost }) as unknown as Model<Api>;

const catalog = new Map([
  ["openai/summary", model("openai", "summary", { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 })],
  ["anthropic/verify", model("anthropic", "verify", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })],
]);
const resolve = (provider: string, id: string) => catalog.get(provider + "/" + id);

const route = (fields: Partial<ProviderRouteMetric> & Pick<ProviderRouteMetric, "provider" | "model" | "inputTokens" | "outputTokens">): ProviderRouteMetric => ({
  stage: "synthesize", calls: 1, successes: 1, avgLatencyMs: 1, usageBasis: "reported", ...fields,
});

const snapshot = (fields: Partial<Parameters<typeof compactionUsage>[0]>) => ({
  totalCalls: 2, totalInput: 0, totalOutput: 0, totalCacheHit: 0, totalCacheWrite: 0, ...fields,
});

describe("compactionUsage", () => {
  it("sums every route's tokens and prices each route at its own model's catalog rates", () => {
    const usage = compactionUsage(snapshot({
      providerRoutes: [
        route({ provider: "openai", model: "summary", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000 }),
        route({ stage: "verify", provider: "anthropic", model: "verify", inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000 }),
      ],
    }), resolve);
    expect(usage).toEqual({
      input: 2_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 1_000_000, totalTokens: 5_100_000,
      // openai: 1 + 1 (output) + 0.2 (cache read); anthropic: 3 + 3.75 (cache write)
      cost: { input: 4, output: 1, cacheRead: 0.2, cacheWrite: 3.75, total: 8.95 },
    });
  });

  it("keeps tokens but no cost for a route whose model is not in the registry", () => {
    const usage = compactionUsage(snapshot({
      providerRoutes: [route({ provider: "custom", model: "gone", inputTokens: 500, outputTokens: 50 })],
    }), resolve);
    expect(usage?.totalTokens).toBe(550);
    expect(usage?.cost.total).toBe(0);
  });

  it("falls back to the run totals under the run model when no route rows exist", () => {
    const usage = compactionUsage(snapshot({
      provider: "openai", model: "summary", totalInput: 1_000_000, totalOutput: 0, totalCacheHit: 0, totalCacheWrite: 0,
    }), resolve);
    expect(usage?.input).toBe(1_000_000);
    expect(usage?.cost.total).toBe(1);
  });

  it("returns nothing when any route was estimated or the run made no provider call", () => {
    expect(compactionUsage(snapshot({
      providerRoutes: [
        route({ provider: "openai", model: "summary", inputTokens: 10, outputTokens: 1 }),
        route({ stage: "verify", provider: "openai", model: "summary", inputTokens: 10, outputTokens: 1, usageBasis: "estimated" }),
      ],
    }), resolve)).toBeUndefined();
    expect(compactionUsage(snapshot({ totalCalls: 0, provider: "openai", model: "summary" }), resolve)).toBeUndefined();
    expect(compactionUsage(snapshot({}), resolve)).toBeUndefined();
  });
});
