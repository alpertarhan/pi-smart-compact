/**
 * Step 4: select compaction tier.
 *
 * Stage: `RecoveredRc` → `TieredRc | null`.
 *
 * Returns `null` for tier="none" so the orchestrator can short-circuit. Only
 * "light" and "full" tiers reach later stages, which is enforced statically
 * by the `ActiveTier` type on `TieredRc.tier`.
 */

import type { RecoveredRc, TieredRc, ActiveTier } from "../run-context.ts";
import { advance } from "../run-context.ts";
import { MIN_TOKEN_THRESHOLD } from "../../constants.ts";
import { computeToolCharPercentage, selectCompactionTier } from "../../utils/helpers.ts";

export function selectTier(rc: RecoveredRc): TieredRc | null {
  const toolPercent = computeToolCharPercentage(rc.branch);
  const tier: ActiveTier | "none" = rc.flags.force
    ? (rc.contextPercent >= 80 ? "full" : "light")
    : selectCompactionTier(rc.contextPercent, toolPercent, rc.totalTokens, MIN_TOKEN_THRESHOLD, rc.config.minContextPercent);

  if (tier === "none") {
    if (!rc.flags.autoTriggered) {
      rc.ctx.ui.notify("Context OK (" + Math.round(rc.contextPercent) + "%). pi-toolkit manages context well.", "info");
    }
    return null;
  }

  const out = rc as RecoveredRc & { _tiered: true; tier: ActiveTier };
  out.tier = tier;
  rc.toolPercent = toolPercent;
  return advance<RecoveredRc, TieredRc>(out, "_tiered");
}
