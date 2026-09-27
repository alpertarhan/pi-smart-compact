import { describe, expect, it } from "bun:test";
import { validateSmartCompactConfig } from "../src/utils/config.ts";

describe("hindsight config validation", () => {
  it("keeps valid values and removes the stale local-fallback key", () => {
    const sc: Record<string, unknown> = {
      memoryBackend: "hindsight",
      hindsightBaseUrl: "https://hindsight.example.com",
      hindsightBankId: "team.agents-1",
      hindsightApiKeyEnv: "HINDSIGHT_API_TOKEN",
      hindsightLocalFallback: "on-failure",
      hindsightTimeoutMs: 1_000,
      hindsightRecallMaxTokens: 4_096,
    };
    validateSmartCompactConfig(sc);
    expect(sc).toEqual({
      memoryBackend: "hindsight",
      hindsightBaseUrl: "https://hindsight.example.com",
      hindsightBankId: "team.agents-1",
      hindsightApiKeyEnv: "HINDSIGHT_API_TOKEN",
      hindsightTimeoutMs: 1_000,
      hindsightRecallMaxTokens: 4_096,
    });
    const loopback: Record<string, unknown> = { hindsightBaseUrl: "http://127.0.0.1:8888" };
    validateSmartCompactConfig(loopback);
    expect(loopback.hindsightBaseUrl).toBe("http://127.0.0.1:8888");
    const cleared: Record<string, unknown> = { hindsightBankId: null };
    validateSmartCompactConfig(cleared);
    expect(cleared).toEqual({ hindsightBankId: null });
  });

  it("discards invalid values so defaults win", () => {
    const sc: Record<string, unknown> = {
      memoryBackend: "cloud",
      hindsightBaseUrl: "http://remote.example.com",
      hindsightBankId: "../all",
      hindsightApiKeyEnv: "hs-live-actual-secret-value",
      hindsightTimeoutMs: 999,
      hindsightRecallMaxTokens: 10_000,
    };
    validateSmartCompactConfig(sc);
    expect(sc).toEqual({});
    for (const url of [
      "https://u:p@h.example.com",
      "https://h.example.com/?token=x",
      "https://h.example.com/#x",
      42,
    ]) {
      const bad: Record<string, unknown> = { hindsightBaseUrl: url };
      validateSmartCompactConfig(bad);
      expect(bad).toEqual({});
    }
  });

});
