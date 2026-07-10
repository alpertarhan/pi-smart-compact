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
import { recordSuccessMetrics, recordFailureMetrics } from "./metrics.ts";
import type { StatedRc } from "../run-context.ts";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { asBranchMessage } from "../../infra/ai-messages.ts";
import { markPhase } from "../run-context.ts";
import * as log from "../../utils/logger.ts";

/**
 * Persist durable state for a *consumed* pending payload.
 *
 * Single persist point for every run type. All three paths (manual, auto,
 * tool) apply the summary through `session_before_compact` consuming the
 * slot — the manual path's `ctx.compact()` fires that same event. Persisting
 * at consume therefore covers every path exactly once; persisting anywhere
 * else either misses the auto/tool paths (the old onComplete-only wiring) or
 * double-writes on manual (incrementing the fingerprint sessionCount twice).
 * Best-effort: never throws.
 */
export function persistConsumedState(pending: PendingCompaction): void {
  if (!pending.projectId) return;
  try {
    if (pending.extraction) saveProjectFingerprint(pending.projectId, pending.extraction);
    if (pending.compactionState) saveCompactionState(pending.projectId, pending.compactionState);
  } catch (e) { log.warn("persistConsumedState failed", e); }
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
    projectId: rc.projectId,
    extraction: rc.extraction,
    sessionId: rc.sessionId,
  };
  rc.pendingRef.set(pending);
  return pending;
}

/**
 * Trigger Pi's native compact in non-auto/non-tool runs. Failure clears the
 * pendingRef so the next compact event cannot grab a stale summary (audit
 * P1 #4).
 *
 * The run's outcome metric is recorded HERE, not before the apply: a
 * "success" row written pre-apply would inflate dashboard reliability when
 * the native compact then rejects. onComplete → success; onError → error.
 */
export function applyCompaction(rc: StatedRc): void {
  if (rc.flags.skipCompact || rc.flags.autoTriggered) return;
  rc.ctx.compact({
    customInstructions: "Use pre-computed smart summary from /smart-compact",
    onComplete: () => {
      // Durable state is persisted when `session_before_compact` consumes
      // the pending slot (see persistConsumedState) — doing it here as well
      // would double-increment the project fingerprint's sessionCount.
      markPhase(rc, "persist");
      recordSuccessMetrics(rc, "success");
      rc.ctx.ui.notify("Applied \u2713", "info");
    },
    onError: e => {
      // Clear the pending summary so a later `session_before_compact` event
      // can't apply a half-rotten payload that Pi already refused.
      rc.pendingRef.clear();
      recordFailureMetrics(rc, e, {
        sessionId: rc.sessionId, tier: rc.tier, contextPercent: rc.contextPercent,
        toolPercent: rc.toolPercent, totalTokens: rc.totalTokens,
        methodForMetrics: rc.method, profile: rc.profile,
      });
      rc.ctx.ui.notify("Failed: " + e.message, "error");
    },
  });
}
