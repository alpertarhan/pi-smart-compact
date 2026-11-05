import { describe, it, expect } from "bun:test";
import { estimateTokens, calibrateFromResponse, getProviderCaps, makeTokenEstimator, safeContextPercent, TokenCalibrationStore } from "../src/utils/tokens.ts";

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

  it("prices a large base64 image as a fixed cost plus its text, not as serialized chars", () => {
    const store = new TokenCalibrationStore();
    const estimator = makeTokenEstimator("openai", "test", store);
    const image = { type: "image", mimeType: "image/png", data: "a".repeat(1_000_000) };
    const text = "x".repeat(4000);
    const withImage = estimator.message({ role: "user", content: [{ type: "text", text }, image] });
    const textAlone = estimator.message({ role: "user", content: [{ type: "text", text }] });
    expect(withImage - textAlone).toBeGreaterThanOrEqual(1_200);
    expect(withImage - textAlone).toBeLessThan(1_300);
    expect(withImage).toBeLessThan(textAlone + 5_000);
  });

  it("does not count provider signatures", () => {
    const estimator = makeTokenEstimator("anthropic", "test", new TokenCalibrationStore());
    const plain = { role: "assistant" as const, content: [
      { type: "thinking" as const, thinking: "plan" },
      { type: "text" as const, text: "done" },
    ] };
    const signed = { role: "assistant" as const, content: [
      { type: "thinking" as const, thinking: "plan", thinkingSignature: "s".repeat(4000) },
      { type: "text" as const, text: "done", textSignature: "t".repeat(4000), thoughtSignature: "u".repeat(4000) },
    ] };
    expect(estimator.message(signed)).toBe(estimator.message(plain));
    expect(estimator.messages([signed])).toBe(estimator.messages([plain]));
  });

  it("keeps text-only message estimates byte-identical to the raw serialization", () => {
    const estimator = makeTokenEstimator("anthropic", "test", new TokenCalibrationStore());
    const messages = [
      { role: "user" as const, content: "plain string content" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }, { type: "toolCall" as const, id: "c1", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult" as const, toolCallId: "c1", toolName: "read", isError: true, content: [{ type: "text" as const, text: "missing" }] },
    ];
    for (const message of messages) {
      expect(estimator.message(message)).toBe(estimator.text(JSON.stringify({
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.isError ? { isError: true } : {}),
      })));
    }
    expect(estimator.messages(messages)).toBe(estimator.text(JSON.stringify(messages.map(message => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.isError ? { isError: true } : {}),
    })))));
  });

  it("applies provider/model calibration", () => {
    const store = new TokenCalibrationStore();
    const before = makeTokenEstimator("openai", "model-a", store).text("x".repeat(1000));
    store.calibrate(before, Math.floor(before / 2), "openai", "model-a");
    const after = makeTokenEstimator("openai", "model-a", store).text("x".repeat(1000));
    expect(after).toBeLessThan(before);
  });

  it("keeps one run's estimator stable while shared calibration changes", () => {
    const store = new TokenCalibrationStore();
    const estimator = makeTokenEstimator("openai", "model-a", store);
    const before = estimator.text("x".repeat(1000));
    store.calibrate(before, Math.floor(before / 2), "openai", "model-a");
    expect(estimator.text("x".repeat(1000))).toBe(before);
    expect(makeTokenEstimator("openai", "model-a", store).text("x".repeat(1000))).toBeLessThan(before);
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

describe("safeContextPercent", () => {
  it("returns a finite zero for missing or invalid context-window metadata", () => {
    expect(safeContextPercent(50_000, undefined)).toBe(0);
    expect(safeContextPercent(50_000, null)).toBe(0);
    expect(safeContextPercent(50_000, 0)).toBe(0);
    expect(safeContextPercent(Number.NaN, 100_000)).toBe(0);
    expect(safeContextPercent(50_000, 100_000)).toBe(50);
  });
});
