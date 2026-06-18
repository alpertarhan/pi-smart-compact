/**
 * Step 9: apply compaction and persist durable state.
 *
 * Lifecycle invariants:
 *
 *  - `pendingRef` is set immediately so `session_before_compact` can consume
 *    it. We MUST clear it on failure (P1 #4 in the audit) — the previous
 *    implementation left a stale summary alive for up to 5 minutes after a
 *    `ctx.compact()` error.
 *
 *  - Project fingerprint and compaction state are persisted **after** the
 *    native compact's `onComplete` confirms application. If we wrote state
 *    eagerly and the compact failed, the next run would believe a successful
 *    compaction had happened — corrupting damage detection and the
 *    cross-compaction delta. This addresses P1 #5 in the audit.
 *
 *  - For manual / tool runs we run damage detection against the existing
 *    branch's previous compaction as a best-effort signal.
 */

import type { RunContext } from "../run-context.ts";
import type { PendingCompaction, LlmMessage } from "../../types.ts";
import { saveProjectFingerprint } from "../../utils/fingerprint.ts";
import { saveCompactionState } from "../../utils/state.ts";
import { detectDamage, logDamageReport, writeRemediationHints } from "../../utils/damage.ts";
import { sanitizeSmartCompactDetails } from "../../utils/type-guards.ts";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { asBranchMessage } from "../../infra/ai-messages.ts";
import { markPhase } from "../run-context.ts";
import * as log from "../../utils/logger.ts";

/**
 * Persist project fingerprint + compaction state. Pulled into its own function
 * so the post-compact onComplete callback in the orchestrator can invoke it
 * exactly once after the native compact succeeds.
 *
 * `RunContext` is the final `StatedRc` stage, so both `extraction` and
 * `compactionState` are statically known to be present here — no defensive
 * `!` or runtime guards needed.
 */
export function persistDurableState(rc: RunContext): void {
  saveProjectFingerprint(rc.projectId, rc.extraction);
  saveCompactionState(rc.projectId, rc.compactionState);
}

/** Run post-compaction damage detection. Best-effort — never throws. */
export function runDamageDetection(rc: RunContext): void {
  try {
    const postCompactMsgs = rc.msgs.slice(rc.keepFrom)
      .map(e => convertToLlm([asBranchMessage(e.message)]))
      .flat() as LlmMessage[];
    if (postCompactMsgs.length <= 2) return;

    const lastCompaction = rc.branch
      .filter((e: unknown) => (e as { type?: string })?.type === "compaction")
      .slice(-1)[0] as { details?: unknown } | undefined;
    if (!lastCompaction?.details) return;

    // The previous compaction may have been written by an older version of
    // this extension or even a different compaction extension entirely.
    // detectDamage feeds the details into `new Set(modifiedFiles)` and reads
    // `topics.toLowerCase().split(...)`, both of which crash on the wrong
    // shape. Validate before touching it.
    const safeDetails = sanitizeSmartCompactDetails(lastCompaction.details);
    if (!safeDetails) {
      rc.vlog("Damage detection skipped: previous compaction details have an unrecognized shape");
      return;
    }

    const damage = detectDamage(postCompactMsgs.slice(0, Math.min(15, postCompactMsgs.length)), safeDetails);
    if (damage.damageScore > 0) {
      rc.notify("Previous compaction damage: " + damage.summary, "warning");
    }
    logDamageReport(rc.sessionId, damage, safeDetails);
    // Feed re-read files forward as remediation hints so the next compaction
    // preserves them instead of losing them again.
    if (damage.reReadFiles.length > 0) {
      writeRemediationHints(rc.projectId, damage.reReadFiles);
    }
  } catch (err) { log.warn("Damage detection error", err); }
}

/**
 * Stash the prepared compaction in pendingRef and trigger the native compact
 * if appropriate. Returns the pending summary so callers can decide whether
 * the run should keep running side effects (it does until the timeout/cleanup
 * step decides otherwise).
 */
export function stagePendingCompaction(rc: RunContext): PendingCompaction {
  // All four fields are guaranteed by StatedRc, so the previous `!` casts go
  // away. If a future refactor reorders steps the type system will catch it
  // here instead of failing at runtime with a `Cannot read property` error.
  const pending: PendingCompaction = {
    summary: rc.finalSummary,
    firstKeptEntryId: rc.firstKeptId,
    tokensBefore: rc.totalTokens,
    details: rc.details,
    compactionState: rc.compactionState,
    sessionId: rc.sessionId,
  };
  rc.pendingRef.set(pending);
  return pending;
}

/**
 * Trigger Pi's native compact in non-auto/non-tool runs. The state-persist
 * callback fires on success; failure clears the pendingRef so the next
 * compact event cannot grab a stale summary (audit P1 #4).
 */
export function applyCompaction(rc: RunContext): void {
  if (rc.flags.skipCompact || rc.flags.autoTriggered) return;
  rc.ctx.compact({
    customInstructions: "Use pre-computed smart summary from /smart-compact",
    onComplete: () => {
      // Defer durable state until Pi confirms the compaction was applied
      // (audit P1 #5: previously this state was written before apply, so a
      // failed compact would leave the cache claiming success).
      try { persistDurableState(rc); } catch (e) { log.warn("persistDurableState failed", e); }
      markPhase(rc, "persist");
      rc.ctx.ui.notify("Applied \u2713", "info");
    },
    onError: e => {
      // Clear the pending summary so a later `session_before_compact` event
      // can't apply a half-rotten payload that Pi already refused.
      rc.pendingRef.clear();
      rc.ctx.ui.notify("Failed: " + e.message, "error");
    },
  });
}
