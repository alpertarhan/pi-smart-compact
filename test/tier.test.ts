import { describe, expect, it } from "bun:test";
import { selectTier } from "../src/app/steps/tier.ts";

describe("selectTier overflow recovery", () => {
  it("bypasses the percentage gate after Pi reports a provider overflow", () => {
    const rc = {
      branch: [],
      msgs: [],
      flags: { force: false, autoTriggered: true, overflowRecovery: true },
      contextPercent: 25,
      totalTokens: 50_000,
      config: { minContextPercent: 60 },
      ctx: { ui: { notify: () => {} } },
      _prepared: true,
      _windowed: true,
      _recovered: true,
    } as any;

    expect(selectTier(rc)?.tier).toBe("full");
  });

  it("admits an automatic run by the maxContextTokens-capped percent", () => {
    const rc = (maxContextTokens: number) => ({
      branch: [],
      msgs: [],
      flags: { force: false, autoTriggered: true, overflowRecovery: false },
      contextPercent: 18, // 180k of the 1M model window
      totalTokens: 180_000,
      config: { minContextPercent: 60, maxContextTokens },
      ctx: { ui: { notify: () => {} }, model: { contextWindow: 1_000_000 } },
      _prepared: true,
      _windowed: true,
      _recovered: true,
    }) as unknown as Parameters<typeof selectTier>[0]; // partial RecoveredRc: only fields selectTier reads

    expect(selectTier(rc(0))).toBeNull();
    // Admitted at 90% of the cap; the light/full label stays on the real 18%.
    expect(selectTier(rc(200_000))?.tier).toBe("light");
  });
});
