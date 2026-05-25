/**
 * Step 7: verify and optionally patch the summary.
 *
 * Stage: `SynthesizedRc` → `VerifiedRc`.
 *
 * Two-stage patch policy:
 *
 *   1. Run deterministic verification. If the score is comfortably high we
 *      accept the summary as-is — no LLM patch cost, no extra latency.
 *   2. If the score is < 85, apply the deterministic patcher first. It is
 *      free, idempotent, and almost always recovers missing sections / file
 *      lists that the LLM elided.
 *   3. Re-verify. Only if the deterministic patch couldn't bring us above 75
 *      do we burn an LLM call on `patchSummary`. This keeps cost predictable
 *      while still preserving the safety net for catastrophic LLM output.
 */

import type { SynthesizedRc, VerifiedRc } from "../run-context.ts";
import { advance } from "../run-context.ts";
import { verifySummary, patchDeterministic, patchSummary } from "../../phases/verify.ts";
import { showProgressOverlay } from "../../ui/overlays.ts";
import * as log from "../../utils/logger.ts";

export async function verifyAndPatch(rc: SynthesizedRc): Promise<VerifiedRc> {
  const extraction = rc.extraction;
  let summary = rc.finalSummary;

  if (!rc.flags.autoTriggered) {
    showProgressOverlay(rc.ctx, {
      phase: 4, phaseName: "Verify", detail: "Checking...",
      model: rc.modelLabel, profile: rc.profile, extraction,
      explorationRounds: rc.explorationRounds,
    });
  }

  let verification = verifySummary(summary, extraction);
  rc.vlog("Verification score=" + verification.score + " ok=" + verification.ok + " gaps=" + verification.gaps.length);

  if (!verification.ok) {
    if (verification.score < 85) {
      rc.notify(
        "Phase 4 Verify: " + verification.gaps.length + " gap(s), score=" + verification.score +
          ", applying deterministic patch",
        "warning",
      );
      summary = patchDeterministic(summary, verification.gaps, extraction);
      let recheck = verifySummary(summary, extraction);
      if (!recheck.ok && recheck.score < 75) {
        rc.notify(
          "Phase 4 Verify: deterministic patch insufficient (score=" + recheck.score + "), trying LLM patch",
          "warning",
        );
        try {
          summary = await patchSummary(summary, recheck.gaps, rc.summaryModel, rc.summaryAuth, rc.cancellation.signal);
          rc.llmCalls += 1;
        } catch (err) { log.warn("LLM patch failed", err); }
        recheck = verifySummary(summary, extraction);
      }
      verification = recheck;
    } else {
      rc.notify(
        "Phase 4 Verify: " + verification.gaps.length + " gap(s), score=" + verification.score +
          " ≥ 85 — skipping patch",
        "info",
      );
    }
  }

  const out = rc as SynthesizedRc & {
    _verified: true;
    verificationScore: number; verificationGaps: string[]; verified: boolean;
  };
  out.finalSummary = summary;
  out.verified = verification.ok;
  out.verificationGaps = verification.gaps;
  out.verificationScore = verification.score;
  return advance<SynthesizedRc, VerifiedRc>(out, "_verified");
}
