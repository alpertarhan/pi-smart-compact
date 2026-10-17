import { ESTIMATOR_ROUNDING_TOLERANCE_TOKENS, MIN_COMPACTION_SAVING_RATIO, YIELD_TARGET_TOLERANCE_RATIO } from "../constants.ts";
import type { CompactionWindowPlan } from "../app/run-context.ts";

export interface CompactionYieldEstimate {
  plannedAfterTokens: number;
  plannedSavedTokens: number;
  plannedYield: number;
  estimatedAfterTokens: number;
  estimatedSavedTokens: number;
  estimatedYield: number;
  retainedTailTokens: number;
  summaryTokens: number;
  summaryBudgetTokens: number;
  targetAfterTokens: number;
  relaxedSoftBoundaries: CompactionWindowPlan["relaxedSoftBoundaries"];
  hardBoundaryAdjusted: boolean;
}

/** Content-free failure raised before any compaction side effect. */
export class YieldGateError extends Error implements CompactionYieldEstimate {
  readonly name = "YieldGateError";

  constructor(public readonly reason: "target-miss" | "insufficient-saving", estimate: CompactionYieldEstimate) {
    super(reason === "target-miss"
      ? "Final summary estimate misses the planned compaction target"
      : "Final summary estimate does not meet the minimum saving policy");
    Object.assign(this, estimate);
  }

  plannedAfterTokens!: number;
  plannedSavedTokens!: number;
  plannedYield!: number;
  estimatedAfterTokens!: number;
  estimatedSavedTokens!: number;
  estimatedYield!: number;
  retainedTailTokens!: number;
  summaryTokens!: number;
  summaryBudgetTokens!: number;
  targetAfterTokens!: number;
  relaxedSoftBoundaries!: CompactionWindowPlan["relaxedSoftBoundaries"];
  hardBoundaryAdjusted!: boolean;
}

/**
 * A summary a few percent over the planned target still frees most of the
 * context; rejecting it discards the run while the context keeps growing.
 */
export function exceedsYieldTarget(afterTokens: number, targetAfterTokens: number): boolean {
  return afterTokens > targetAfterTokens + Math.max(
    ESTIMATOR_ROUNDING_TOLERANCE_TOKENS,
    Math.floor(targetAfterTokens * YIELD_TARGET_TOLERANCE_RATIO),
  );
}

export function verifyCompactionYield(
  totalTokens: number,
  summaryTokens: number,
  plan: CompactionWindowPlan,
): CompactionYieldEstimate {
  const estimatedAfterTokens = plan.fixedContextTokens + plan.retainedTokens + summaryTokens;
  const estimatedSavedTokens = Math.max(0, totalTokens - estimatedAfterTokens);
  const estimatedYield = totalTokens > 0 ? estimatedSavedTokens / totalTokens : 0;
  const estimate: CompactionYieldEstimate = {
    plannedAfterTokens: plan.projectedAfterTokens,
    plannedSavedTokens: plan.projectedSavedTokens,
    plannedYield: plan.projectedYield,
    estimatedAfterTokens,
    estimatedSavedTokens,
    estimatedYield,
    retainedTailTokens: plan.retainedTokens,
    summaryTokens,
    summaryBudgetTokens: plan.summaryBudgetTokens,
    targetAfterTokens: plan.targetAfterTokens,
    relaxedSoftBoundaries: plan.relaxedSoftBoundaries,
    hardBoundaryAdjusted: plan.hardBoundaryAdjusted,
  };
  if (exceedsYieldTarget(estimatedAfterTokens, plan.targetAfterTokens)) {
    throw new YieldGateError("target-miss", estimate);
  }
  if (estimatedYield < MIN_COMPACTION_SAVING_RATIO) {
    throw new YieldGateError("insufficient-saving", estimate);
  }
  return estimate;
}
