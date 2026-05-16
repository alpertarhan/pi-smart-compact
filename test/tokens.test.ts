import { describe, it, expect } from "bun:test";
import { estimateTokens, calibrateFromResponse, getProviderCaps } from "../src/utils/tokens.ts";

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
  });

  it("returns default caps for unknown provider", () => {
    const caps = getProviderCaps("unknown-provider");
    expect(caps.maxOutputTokens).toBe(8192);
    expect(caps.concurrencyLimit).toBe(2);
  });
});
