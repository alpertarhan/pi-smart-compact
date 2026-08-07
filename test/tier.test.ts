import { describe, expect, it } from "bun:test";
import { selectTier } from "../src/app/steps/tier.ts";

describe("selectTier overflow recovery", () => {
  it("bypasses the percentage gate after Pi reports a provider overflow", () => {
    const rc = {
      branch: [],
      flags: { force: false, autoTriggered: true, overflowRecovery: true },
      contextPercent: 25,
      totalTokens: 50_000,
      config: { minContextPercent: 60 },
      ctx: { ui: { notify: () => {} } },
      _recovered: true,
    } as any;

    expect(selectTier(rc)?.tier).toBe("full");
  });
});
