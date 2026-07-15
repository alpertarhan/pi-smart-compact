import { describe, it, expect } from "bun:test";
import { validateSmartCompactConfig, selectCompactionTier, computeToolCharPercentage } from "../src/utils/helpers.ts";
import { DEFAULT_CONFIG, VERSION, MIN_TOKEN_THRESHOLD } from "../src/constants.ts";
import pkg from "../package.json";

describe("validateSmartCompactConfig", () => {
  it("deletes invalid profile", () => {
    const sc = { profile: "super" };
    validateSmartCompactConfig(sc);
    expect("profile" in sc).toBe(false);
  });

  it("keeps valid profile", () => {
    const sc = { profile: "light" };
    validateSmartCompactConfig(sc);
    expect(sc.profile).toBe("light");
  });

  it("validates per-phase thinking levels", () => {
    const sc: Record<string, unknown> = {
      summaryThinkingLevel: "max",
      segmentationThinkingLevel: "extreme",
    };
    validateSmartCompactConfig(sc);
    expect(sc.summaryThinkingLevel).toBe("max");
    expect(sc.segmentationThinkingLevel).toBeUndefined();
    expect(DEFAULT_CONFIG.summaryThinkingLevel).toBeNull();
    expect(DEFAULT_CONFIG.segmentationThinkingLevel).toBeNull();
  });

  it("deletes invalid autoTrigger (string)", () => {
    const sc = { autoTrigger: "true" };
    validateSmartCompactConfig(sc);
    expect("autoTrigger" in sc).toBe(false);
  });

  it("deletes invalid autoTriggerTimeoutMs (string)", () => {
    const sc = { autoTriggerTimeoutMs: "45000" };
    validateSmartCompactConfig(sc);
    expect("autoTriggerTimeoutMs" in sc).toBe(false);
  });

  it("deletes invalid autoTriggerTimeoutMs (negative)", () => {
    const sc = { autoTriggerTimeoutMs: -1000 };
    validateSmartCompactConfig(sc);
    expect("autoTriggerTimeoutMs" in sc).toBe(false);
  });

  it("deletes invalid autoTriggerTimeoutMs (too large)", () => {
    const sc = { autoTriggerTimeoutMs: 600000 };
    validateSmartCompactConfig(sc);
    expect("autoTriggerTimeoutMs" in sc).toBe(false);
  });

  it("deletes invalid autoTriggerTimeoutMs (too small)", () => {
    const sc = { autoTriggerTimeoutMs: 500 };
    validateSmartCompactConfig(sc);
    expect("autoTriggerTimeoutMs" in sc).toBe(false);
  });

  it("keeps valid autoTriggerTimeoutMs", () => {
    const sc = { autoTriggerTimeoutMs: 45000 };
    validateSmartCompactConfig(sc);
    expect(sc.autoTriggerTimeoutMs).toBe(45000);
  });

  it("keeps boundary values (1000 and 300000)", () => {
    const sc1 = { autoTriggerTimeoutMs: 1000 };
    validateSmartCompactConfig(sc1);
    expect(sc1.autoTriggerTimeoutMs).toBe(1000);

    const sc2 = { autoTriggerTimeoutMs: 300000 };
    validateSmartCompactConfig(sc2);
    expect(sc2.autoTriggerTimeoutMs).toBe(300000);
  });

  it("uses a less aggressive default auto-trigger timeout", () => {
    expect(DEFAULT_CONFIG.autoTriggerTimeoutMs).toBe(120000);
  });

  it("sanitizes invalid profile overrides", () => {
    const sc = {
      profiles: {
        balanced: {
          summaryBudgetTokens: 7000,
          keepRecentTokens: "lots",
          unknownKey: 123,
        },
        weird: { summaryBudgetTokens: 1 },
      },
    } as Record<string, unknown>;
    validateSmartCompactConfig(sc);
    const profiles = sc.profiles as Record<string, Record<string, unknown>>;
    expect(profiles.balanced.summaryBudgetTokens).toBe(7000);
    expect("keepRecentTokens" in profiles.balanced).toBe(false);
    expect("unknownKey" in profiles.balanced).toBe(false);
    expect("weird" in profiles).toBe(false);
  });

  it("keeps runtime VERSION in sync with package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("deletes invalid minContextPercent (negative)", () => {
    const sc = { minContextPercent: -10 };
    validateSmartCompactConfig(sc);
    expect("minContextPercent" in sc).toBe(false);
  });

  it("deletes invalid minContextPercent (too large)", () => {
    const sc = { minContextPercent: 150 };
    validateSmartCompactConfig(sc);
    expect("minContextPercent" in sc).toBe(false);
  });

  it("keeps valid minContextPercent", () => {
    const sc = { minContextPercent: 25 };
    validateSmartCompactConfig(sc);
    expect(sc.minContextPercent).toBe(25);
  });

  it("keeps boundary values (0 and 100)", () => {
    const sc1 = { minContextPercent: 0 };
    validateSmartCompactConfig(sc1);
    expect(sc1.minContextPercent).toBe(0);
    const sc2 = { minContextPercent: 100 };
    validateSmartCompactConfig(sc2);
    expect(sc2.minContextPercent).toBe(100);
  });

  it("has default minContextPercent of 60", () => {
    expect(DEFAULT_CONFIG.minContextPercent).toBe(60);
  });

  it("deletes invalid backupDir (number)", () => {
    const sc = { backupDir: 123 };
    validateSmartCompactConfig(sc);
    expect("backupDir" in sc).toBe(false);
  });

  it("deletes invalid backupDir (boolean)", () => {
    const sc = { backupDir: true };
    validateSmartCompactConfig(sc);
    expect("backupDir" in sc).toBe(false);
  });

  it("keeps valid backupDir", () => {
    const sc = { backupDir: "/custom/backup/dir" };
    validateSmartCompactConfig(sc);
    expect(sc.backupDir).toBe("/custom/backup/dir");
  });

  it("deletes invalid pinPaths (non-array)", () => {
    const sc = { pinPaths: "src/a.ts" };
    validateSmartCompactConfig(sc);
    expect("pinPaths" in sc).toBe(false);
  });

  it("deletes invalid pinPaths (mixed types)", () => {
    const sc = { pinPaths: ["src/a.ts", 42] };
    validateSmartCompactConfig(sc);
    expect("pinPaths" in sc).toBe(false);
  });

  it("keeps valid pinPaths", () => {
    const sc = { pinPaths: ["src/auth.ts", "README.md"] };
    validateSmartCompactConfig(sc);
    expect(sc.pinPaths).toEqual(["src/auth.ts", "README.md"]);
  });

  it("validates roadmap security and policy flags", () => {
    const sc: Record<string, unknown> = {
      requireApproval: "yes",
      scrubSecrets: true,
      scrubPii: false,
      focusWeighting: true,
      adaptiveDamageFeedback: false,
      onlineDamageMonitor: true,
    };
    validateSmartCompactConfig(sc);
    expect(sc.requireApproval).toBeUndefined();
    expect(sc.scrubSecrets).toBe(true);
  });

  it("validates optional call and latency budgets", () => {
    const valid: Record<string, unknown> = { maxLlmCalls: 8, maxLatencyMs: 20_000 };
    validateSmartCompactConfig(valid);
    expect(valid).toEqual({ maxLlmCalls: 8, maxLatencyMs: 20_000 });
    const invalid: Record<string, unknown> = { maxLlmCalls: -1, maxLatencyMs: 1000 };
    validateSmartCompactConfig(invalid);
    expect(invalid.maxLlmCalls).toBeUndefined();
    expect(invalid.maxLatencyMs).toBeUndefined();
  });

  it("ships risky roadmap features behind safe defaults", () => {
    expect(DEFAULT_CONFIG.requireApproval).toBe(false);
    expect(DEFAULT_CONFIG.scrubSecrets).toBe(true);
    expect(DEFAULT_CONFIG.scrubPii).toBe(false);
    expect(DEFAULT_CONFIG.adaptiveDamageFeedback).toBe(false);
    expect(DEFAULT_CONFIG.maxLlmCalls).toBe(0);
    expect(DEFAULT_CONFIG.maxLatencyMs).toBe(0);
  });
});

describe("computeToolCharPercentage", () => {
  it("counts only text blocks and ignores tool-call text-like fields", () => {
    const branch = [
      { message: { role: "assistant", content: [
        { type: "toolCall", text: "x".repeat(1000), name: "write", arguments: {} },
        { type: "text", text: "assistant" },
      ] } },
      { message: { role: "toolResult", content: [{ type: "text", text: "tool" }] } },
    ];
    expect(computeToolCharPercentage(branch)).toBe(Math.round(4 / (9 + 4) * 100));
  });

  it("counts text blocks via .text and ignores a stray .content field", () => {
    // A text block carries its payload in `.text`; a sibling `.content` must
    // not be counted (guards against the removed dead branch).
    const branch = [
      { message: { role: "toolResult", content: [{ type: "text", text: "abc", content: "XXXXXXXXXXXXXXXXXX" }] } },
    ];
    // total = 3 (only .text "abc"), tool = 3 → 100%. If .content were
    // counted, total would include the Xs and the share would drop.
    expect(computeToolCharPercentage(branch)).toBe(100);
  });
});

describe("selectCompactionTier", () => {
  it("returns none if below MIN_TOKEN_THRESHOLD", () => {
    expect(selectCompactionTier(50, 90, 4000, MIN_TOKEN_THRESHOLD, 30)).toBe("none");
  });

  it("returns none if contextPercent < minContextPercent (even with high tool%)", () => {
    // This is the key fix: tool=97% but context=5-59% should NOT compact with default-safe threshold
    expect(selectCompactionTier(5, 97, 10000, MIN_TOKEN_THRESHOLD, 60)).toBe("none");
    expect(selectCompactionTier(35, 80, 10000, MIN_TOKEN_THRESHOLD, 60)).toBe("none");
    expect(selectCompactionTier(59, 99, 10000, MIN_TOKEN_THRESHOLD, 60)).toBe("none");
  });

  it("returns none if contextPercent < minContextPercent regardless of toolPercent", () => {
    expect(selectCompactionTier(25, 50, 10000, MIN_TOKEN_THRESHOLD, 30)).toBe("none");
    expect(selectCompactionTier(25, 90, 10000, MIN_TOKEN_THRESHOLD, 30)).toBe("none");
  });

  it("uses 60 as the default minContextPercent", () => {
    expect(selectCompactionTier(50, 97, 10000, MIN_TOKEN_THRESHOLD)).toBe("none");
    expect(selectCompactionTier(69, 93, 10000, MIN_TOKEN_THRESHOLD)).toBe("light");
  });

  it("returns light if contextPercent between 45 and 80", () => {
    expect(selectCompactionTier(50, 70, 10000, MIN_TOKEN_THRESHOLD, 30)).toBe("light");
    expect(selectCompactionTier(60, 80, 10000, MIN_TOKEN_THRESHOLD, 30)).toBe("light");
    expect(selectCompactionTier(79, 90, 10000, MIN_TOKEN_THRESHOLD, 30)).toBe("light");
  });

  it("returns full if contextPercent >= 80", () => {
    expect(selectCompactionTier(80, 90, 10000, MIN_TOKEN_THRESHOLD, 30)).toBe("full");
    expect(selectCompactionTier(95, 99, 10000, MIN_TOKEN_THRESHOLD, 30)).toBe("full");
  });

  it("respects custom minContextPercent", () => {
    // With minContextPercent=10, context=15% should not be blocked
    expect(selectCompactionTier(15, 97, 10000, MIN_TOKEN_THRESHOLD, 10)).toBe("light");
    // With minContextPercent=20, context=15% should be blocked
    expect(selectCompactionTier(15, 97, 10000, MIN_TOKEN_THRESHOLD, 20)).toBe("none");
  });
});
