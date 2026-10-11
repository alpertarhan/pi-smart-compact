// Provider cache-caps matrix (J): documented prompt-cache control surfaces.
import { describe, expect, it } from "bun:test";
import { getProviderCacheCaps } from "../src/utils/tokens.ts";

describe("getProviderCacheCaps documented providers", () => {
  it("anthropic: explicit message-level markers, 5m/1h TTLs, 1h write premium", () => {
    const caps = getProviderCacheCaps("anthropic");
    expect(caps.level).toBe("explicit-message");
    expect(caps.ttlOptionsMs).toEqual([300_000, 3_600_000]);
    // Worst selectable tier premium: 1h writes cost 2x base input.
    expect(caps.writeMultiplier).toBe(2);
    expect(caps.readMultiplier).toBe(0.1);
    expect(caps.routingKey).toBeNull();
  });

  it("kimi-coding: only top-level cache_control is honored; message markers are ignored", () => {
    // Documented by Moonshot: the Anthropic-compatible endpoint reads a
    // top-level cache_control field and ignores markers inside messages.
    const caps = getProviderCacheCaps("kimi-coding");
    expect(caps.level).toBe("explicit-toplevel");
    expect(caps.ttlOptionsMs).toEqual([300_000, 3_600_000]);
    expect(caps.writeMultiplier).toBe(2);
    expect(caps.readMultiplier).toBe(0.1);
  });

  it("kimi fuzzy alias resolves to the same caps", () => {
    expect(getProviderCacheCaps("kimi-for-coding").level).toBe("explicit-toplevel");
  });

  it("openai: implicit by default, routing stickiness via prompt_cache_key", () => {
    const caps = getProviderCacheCaps("openai");
    expect(caps.level).toBe("implicit");
    expect(caps.ttlOptionsMs).toEqual([]);
    expect(caps.routingKey).toEqual({ location: "body", name: "prompt_cache_key" });
    expect(caps.writeMultiplier).toBe(1);
  });

  it("xai: implicit caching with an x-grok-conv-id routing header", () => {
    const caps = getProviderCacheCaps("xai");
    expect(caps.level).toBe("implicit");
    expect(caps.routingKey).toEqual({ location: "header", name: "x-grok-conv-id" });
    expect(caps.readMultiplier).toBe(0.25);
  });

  it("deepseek: fully automatic disk cache, no developer control", () => {
    const caps = getProviderCacheCaps("deepseek");
    expect(caps.level).toBe("implicit");
    expect(caps.ttlOptionsMs).toEqual([]);
    expect(caps.routingKey).toBeNull();
  });

  it("zai-anthropic: no documented marker contract, treated as implicit", () => {
    // Unverified whether the Anthropic-compatible Z.ai route honors message
    // markers; conservative default keeps current anchor-cache behavior.
    const caps = getProviderCacheCaps("zai-anthropic");
    expect(caps.level).toBe("implicit");
    expect(caps.ttlOptionsMs).toEqual([]);
  });

  it("minimax and google: implicit defaults without wire TTL control", () => {
    expect(getProviderCacheCaps("minimax").level).toBe("implicit");
    expect(getProviderCacheCaps("minimax").ttlOptionsMs).toEqual([]);
    expect(getProviderCacheCaps("google").level).toBe("implicit");
    expect(getProviderCacheCaps("google").ttlOptionsMs).toEqual([]);
  });

  it("unknown providers get conservative defaults", () => {
    const caps = getProviderCacheCaps("totally-unknown-provider");
    expect(caps.level).toBe("implicit");
    expect(caps.ttlOptionsMs).toEqual([]);
    expect(caps.writeMultiplier).toBe(1);
    expect(caps.readMultiplier).toBe(1);
    expect(caps.routingKey).toBeNull();
  });

  it("every known provider entry carries a complete cacheControl object", () => {
    // Compile-time enforced by ProviderCapabilities; spot-check three families.
    for (const provider of ["anthropic", "openai", "google", "deepseek", "minimax", "xiaomi-mimo", "mistral", "xai", "kimi-coding", "zai-anthropic"]) {
      const caps = getProviderCacheCaps(provider);
      expect(["explicit-message", "explicit-toplevel", "implicit", "none"]).toContain(caps.level);
      expect(typeof caps.writeMultiplier).toBe("number");
      expect(typeof caps.readMultiplier).toBe("number");
      expect(caps.ttlOptionsMs.every(ttl => Number.isFinite(ttl) && ttl > 0)).toBe(true);
    }
  });
});
