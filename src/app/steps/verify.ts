/**
 * Step 7: verify and repair the synthesized summary.
 *
 * Every safe deterministic repair is applied regardless of scalar score. The
 * score controls only whether unresolved findings justify an additional LLM
 * call; it never suppresses known, zero-cost repairs.
 */

import type { SynthesizedRc, VerifiedRc } from "../run-context.ts";
import { advance } from "../run-context.ts";
import {
  verifySummary, patchDeterministic, patchSummary,
  formatVerificationGap, isDeterministicallyPatchable,
} from "../../phases/verify.ts";
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
  const initialScore = verification.score;
  const deterministicPatched = verification.gaps.filter(isDeterministicallyPatchable);
  let llmPatched = false;
  rc.vlog("Verification score=" + verification.score + " ok=" + verification.ok + " gaps=" + verification.gaps.length);

  if (deterministicPatched.length > 0) {
    rc.notify(
      "Phase 4 Verify: " + deterministicPatched.length + " deterministic gap(s), score=" + verification.score + ", applying repair",
      "warning",
    );
    summary = patchDeterministic(summary, verification.gaps, extraction);
    verification = verifySummary(summary, extraction);
  }

  if (!verification.ok && verification.score < 75) {
    rc.notify("Phase 4 Verify: deterministic repair insufficient (score=" + verification.score + "), requesting LLM patch", "warning");
    const beforePatch = summary;
    try {
      summary = await patchSummary(summary, verification.gaps, rc.summaryModel, rc.summaryAuth, rc.cancellation.signal, rc.services);
    } catch (error) { log.warn("LLM patch failed", error); }
    if (summary !== beforePatch) {
      llmPatched = true;
      verification = verifySummary(summary, extraction);
    }
  }

  const out = rc as SynthesizedRc & {
    _verified: true;
    verificationScore: number;
    verificationGaps: string[];
    verified: boolean;
    verificationProvenance: import("../../types.ts").VerificationProvenance;
  };
  out.finalSummary = summary;
  out.verified = verification.ok;
  out.verificationGaps = verification.gaps.map(formatVerificationGap);
  out.verificationScore = verification.score;
  out.verificationProvenance = {
    initialScore,
    deterministicPatched,
    llmPatched,
    finalScore: verification.score,
    remainingGaps: verification.gaps,
  };
  return advance<SynthesizedRc, VerifiedRc>(out, "_verified");
}
