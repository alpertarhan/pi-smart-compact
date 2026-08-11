/**
 * Step 7: verify and repair the synthesized summary.
 *
 * Every safe deterministic repair is applied regardless of scalar score. The
 * mode policy controls whether unresolved findings get an additional LLM call;
 * score remains diagnostic and never suppresses known, zero-cost repairs.
 */

import type { SynthesizedRc, VerifiedRc } from "../run-context.ts";
import { advance } from "../run-context.ts";
import {
  verifySummary, patchSummary, repairSummaryDeterministically,
  formatVerificationGap, isDeterministicallyPatchable, verificationFailureMessage, VerificationGateError,
} from "../../phases/verify.ts";
import { showProgressOverlay } from "../../ui/overlays.ts";
import * as log from "../../utils/logger.ts";
import { MODE_POLICIES, modeFromLegacyProfile } from "../mode-policy.ts";
import { assembleFallback } from "../../phases/synthesize.ts";
import { resolveStageAuth } from "../stage-auth.ts";

export async function verifyAndPatch(rc: SynthesizedRc): Promise<VerifiedRc> {
  const extraction = rc.extraction;
  let summary = rc.finalSummary;
  const evidence = {
    sourceMessages: rc.llmMessages,
    steering: { focus: rc.focus, note: rc.userNote },
  };

  showProgressOverlay(rc.ctx, {
    phase: 4, phaseName: "Verify", detail: "Checking facts, files, constraints, errors, and open loops",
    model: rc.modelLabel, profile: rc.profile, extraction,
    explorationRounds: rc.explorationRounds,
  });

  let verification = verifySummary(summary, extraction, rc.previousState, evidence);
  const initialScore = verification.score;
  const deterministicPatched: typeof verification.gaps = [];
  let llmPatched = false;
  let qualityFloorUsed = false;
  rc.vlog("Verification score=" + verification.score + " ok=" + verification.ok + " gaps=" + verification.gaps.length);

  const initialPatchable = verification.gaps.filter(isDeterministicallyPatchable);
  if (initialPatchable.length > 0) {
    rc.notify(
      "Phase 4 Verify: " + initialPatchable.length + (initialPatchable.length === 1 ? " deterministic gap" : " deterministic gaps") + ", score=" + verification.score + ", applying repair",
      "info",
    );
    showProgressOverlay(rc.ctx, {
      phase: 4, phaseName: "Verify", detail: "Repairing " + initialPatchable.length + (initialPatchable.length === 1 ? " deterministic finding" : " deterministic findings"),
      explorationRounds: rc.explorationRounds,
    })
    const repaired = repairSummaryDeterministically(summary, verification, extraction, rc.previousState, evidence);
    summary = repaired.summary;
    verification = repaired.result;
    deterministicPatched.push(...repaired.patched);
  }

  const mode = rc.mode ?? (rc.profile ? modeFromLegacyProfile(rc.profile) : "balanced");
  if (MODE_POLICIES[mode].allowLlmPatch && !verification.ok) {
    rc.notify("Phase 4 Verify: deterministic repair insufficient (score=" + verification.score + "), requesting LLM patch", "info");
    showProgressOverlay(rc.ctx, {
      phase: 4, phaseName: "Verify", detail: "Requesting a semantic repair for unresolved findings",
      explorationRounds: rc.explorationRounds,
    })
    const beforePatch = summary;
    try {
      const verifyAuth = await resolveStageAuth(rc, "verify");
      summary = await patchSummary(summary, verification.gaps, rc.verifyModel ?? rc.summaryModel, verifyAuth, rc.cancellation.signal, rc.services);
    } catch (error) { log.debugError("LLM verification patch used deterministic fallback", error); }
    if (summary !== beforePatch) {
      llmPatched = true;
      verification = verifySummary(summary, extraction, rc.previousState, evidence);
      const repaired = repairSummaryDeterministically(summary, verification, extraction, rc.previousState, evidence);
      summary = repaired.summary;
      verification = repaired.result;
      deterministicPatched.push(...repaired.patched);
    }
  }

  if (!verification.ok) {
    showProgressOverlay(rc.ctx, {
      phase: 4, phaseName: "Verify", detail: "Trying the deterministic safety summary",
      explorationRounds: rc.explorationRounds,
    })
    let deterministic = assembleFallback([], extraction, evidence.steering);
    let deterministicVerification = verifySummary(deterministic, extraction, rc.previousState, evidence);
    const repaired = repairSummaryDeterministically(deterministic, deterministicVerification, extraction, rc.previousState, evidence);
    deterministic = repaired.summary;
    deterministicVerification = repaired.result;
    // The quality floor is built only from deterministic extraction,
    // continuity, and explicit steering. Untrusted chunk prose is excluded.
    if (deterministicVerification.ok) {
      summary = deterministic;
      verification = deterministicVerification;
      deterministicPatched.push(...repaired.patched);
      qualityFloorUsed = true;
      rc.notify("Quality floor replaced unsafe or unverifiable model output", "info");
    }
  }

  const failure = verificationFailureMessage(verification);
  if (failure) throw new VerificationGateError(verification, initialScore);
  showProgressOverlay(rc.ctx, {
    phase: 4, phaseName: "Verify", detail: "Passed " + verification.score + "/100 · 0 unresolved gaps",
    explorationRounds: rc.explorationRounds,
  })

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
    qualityFloorUsed,
    finalScore: verification.score,
    remainingGaps: verification.gaps,
  };
  // Verification may issue an additional semantic-patch call after synthesis.
  // Refresh the materialized count before the result/details stage consumes it.
  out.llmCalls = rc.services.metrics.summary().totalCalls;
  return advance<SynthesizedRc, VerifiedRc>(out, "_verified");
}
