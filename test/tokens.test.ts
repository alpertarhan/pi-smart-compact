import { describe, it, expect } from "bun:test";
import { estimateTokens, calibrateFromResponse, getProviderCaps, makeTokenEstimator, TokenCalibrationStore } from "../src/utils/tokens.ts";

describe("estimateTokens", () => {
  it("estimates based on char length", () => {
    const text = "a".repeat(380);
    expect(estimateTokens(text)).toBe(100);
  });

  it("uses provider-specific ratio", () => {
    const text = "a".repeat(330);
    expect(estimateTokens(text, "xiaomi-token-plan")).toBe(100);
  });

  it("returns at least 1 for non-empty", () => {
    expect(estimateTokens("hi")).toBe(1);
  });

  it("returns 0 for empty", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("makeTokenEstimator", () => {
  it("counts structured tool-call arguments", () => {
    const estimator = makeTokenEstimator("openai", "test", new TokenCalibrationStore());
    const textOnly = estimator.message({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    const withToolArgs = estimator.message({
      role: "assistant",
      content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: "src/a.ts", content: "x".repeat(4000) } }],
    });
    expect(withToolArgs).toBeGreaterThan(textOnly + 500);
  });

  it("applies provider/model calibration", () => {
    const store = new TokenCalibrationStore();
    const before = makeTokenEstimator("openai", "model-a", store).text("x".repeat(1000));
    store.calibrate(before, Math.floor(before / 2), "openai", "model-a");
    const after = makeTokenEstimator("openai", "model-a", store).text("x".repeat(1000));
    expect(after).toBeLessThan(before);
  });

  it("converges to the observed absolute factor rather than its square root", () => {
    const store = new TokenCalibrationStore();
    for (let i = 0; i < 20; i++) {
      const factor = store.get("p", "m");
      store.calibrate(100 * factor, 50, "p", "m");
    }
    expect(store.get("p", "m")).toBeCloseTo(0.5, 2);
  });

  it("keeps only the bounded least-recently-used calibration set", () => {
    const store = new TokenCalibrationStore(2);
    store.calibrate(100, 50, "p", "a");
    store.calibrate(100, 60, "p", "b");
    store.get("p", "a");
    store.calibrate(100, 70, "p", "c");
    expect(store.size()).toBe(2);
    expect(store.get("p", "b")).toBe(1);
    expect(store.get("p", "a")).not.toBe(1);
  });
});

describe("calibrateFromResponse", () => {
  it("adjusts factor after calibration", () => {
    const provider = "openai";
    const before = estimateTokens("a".repeat(380), provider);
    calibrateFromResponse(before, 50, provider); // actual half of estimated
    const after = estimateTokens("a".repeat(380), provider);
    expect(after).not.toBe(before);
  });
});

describe("getProviderCaps", () => {
  it("returns known provider caps", () => {
    const caps = getProviderCaps("openai");
    expect(caps.maxOutputTokens).toBe(16384);
    expect(caps.concurrencyLimit).toBe(5);
    expect(caps.cacheStrategy).toBe("openai");
  });

  it("returns default caps for unknown provider", () => {
    const caps = getProviderCaps("unknown-provider");
    expect(caps.maxOutputTokens).toBe(8192);
    expect(caps.concurrencyLimit).toBe(2);
    expect(caps.cacheStrategy).toBe("none");
  });

  it("fuzzy matches provider names", () => {
    // Exact match
    expect(getProviderCaps("anthropic").cacheStrategy).toBe("anthropic");
    // Fuzzy: partial match via alias
    expect(getProviderCaps("anthropic/claude-sonnet-4").cacheStrategy).toBe("anthropic");
    expect(getProviderCaps("google/gemini-pro").concurrencyLimit).toBe(3);
    expect(getProviderCaps("deepseek-v3").cacheStrategy).toBe("none");
    expect(getProviderCaps("mistral/mistral-large").concurrencyLimit).toBe(3);
    expect(getProviderCaps("xai/grok-3").concurrencyLimit).toBe(3);
    expect(getProviderCaps("kimi-coding/moonshot").cacheStrategy).toBe("anthropic");
    expect(getProviderCaps("xiaomi-mimo").cacheStrategy).toBe("anthropic");
    expect(getProviderCaps("crofai/claude").timeoutMultiplier).toBe(1.2);
  });

  it("all providers have valid caps", () => {
    const providers = ["zai-anthropic", "kimi-coding", "anthropic", "openai", "google", "deepseek", "minimax", "xiaomi-token-plan", "xiaomi-mimo", "crofai", "mistral", "xai"];
    for (const p of providers) {
      const caps = getProviderCaps(p);
      expect(caps.maxOutputTokens).toBeGreaterThan(0);
      expect(caps.concurrencyLimit).toBeGreaterThan(0);
      expect(caps.tokenRatioEstimate).toBeGreaterThan(0);
      expect(caps.timeoutMultiplier).toBeGreaterThanOrEqual(1);
      expect(caps.singlePassTokenMultiplier).toBeGreaterThan(0);
      expect(["native", "metadata-only"]).toContain(caps.multimodal);
      expect(["anthropic", "openai", "none"]).toContain(caps.cacheStrategy);
    }
  });
});
