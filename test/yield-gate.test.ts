import { describe, expect, it } from "bun:test";
import { exceedsYieldTarget, verifyCompactionYield, YieldGateError } from "../src/domain/yield-gate.ts";
import type { CompactionWindowPlan } from "../src/app/run-context.ts";

function plan(patch: Partial<CompactionWindowPlan> = {}): CompactionWindowPlan {
  return {
    keepFrom: 2, compactTokens: 700, retainedTokens: 200,
    projectedAfterTokens: 300, projectedSavedTokens: 700, projectedYield: 0.7,
    fixedContextTokens: 0, retentionTargetTokens: 200, summaryBudgetTokens: 100,
    targetAfterTokens: 300, hardBoundaryAdjusted: false, viable: true, reason: "viable",
    relaxedSoftBoundaries: [], ...patch,
  };
}

describe("post-summary yield gate", () => {
  it("fails closed when the verified summary misses the planned target", () => {
    expect(() => verifyCompactionYield(1_000, 116, plan())).toThrow(YieldGateError);
    try { verifyCompactionYield(1_000, 116, plan()); } catch (error) {
      expect(error).toMatchObject({ name: "YieldGateError", reason: "target-miss", estimatedAfterTokens: 316 });
      expect(JSON.stringify(error)).not.toContain("summary content");
    }
  });

  it("accepts an overshoot within 5% of the target, as staged revalidation does", () => {
    expect(verifyCompactionYield(1_000, 115, plan())).toMatchObject({ estimatedAfterTokens: 315 });
    expect(exceedsYieldTarget(315, 300)).toBe(false);
    expect(exceedsYieldTarget(316, 300)).toBe(true);
    // Small targets keep the one-token rounding allowance.
    expect(exceedsYieldTarget(11, 10)).toBe(false);
    expect(exceedsYieldTarget(12, 10)).toBe(true);
  });

  it("fails closed below the 10% net-saving policy", () => {
    const lowYield = plan({ fixedContextTokens: 700, retainedTokens: 100, targetAfterTokens: 1_000 });
    expect(() => verifyCompactionYield(1_000, 101, lowYield)).toThrow(YieldGateError);
    try { verifyCompactionYield(1_000, 101, lowYield); } catch (error) {
      expect(error).toMatchObject({ reason: "insufficient-saving", estimatedSavedTokens: 99, estimatedYield: 0.099 });
    }
  });

  it("passes the exact target and 10% saving boundary", () => {
    const boundary = plan({ fixedContextTokens: 700, retainedTokens: 100, targetAfterTokens: 900 });
    expect(verifyCompactionYield(1_000, 100, boundary)).toMatchObject({
      estimatedAfterTokens: 900, estimatedSavedTokens: 100, estimatedYield: 0.1,
    });
  });
});
