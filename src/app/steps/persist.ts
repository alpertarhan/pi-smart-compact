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
 *    host emits the matching `session_compact` entry. `ctx.compact.onComplete`
 *    is UI feedback only and is not a durable-commit authority. If we wrote state
 *    eagerly and the compact failed, the next run would believe a successful
 *    compaction had happened — corrupting damage detection and the
 *    cross-compaction delta. This addresses P1 #5 in the audit.
 *
 *  - For manual / tool runs we run damage detection against the existing
 *    branch's previous compaction as a best-effort signal.
 */

import type { RunContext } from "../run-context.ts";
import type {
  MetricsSnapshot,
  PendingCompaction,
  LlmMessage,
} from "../../types.ts";
import { saveProjectFingerprint } from "../../utils/fingerprint.ts";
import { saveCompactionState } from "../../utils/state.ts";
import { scheduleCompactionStateIndex } from "../../infra/context-graph.ts";
import { loadConfig } from "../../utils/config.ts";
import { appendMetricsSnapshot } from "../../utils/cache.ts";
import { commitPreparedConversationBackup } from "../../utils/backups.ts";
import {
  detectDamage,
  logDamageReport,
  writeRemediationHints,
} from "../../utils/damage.ts";
import { sanitizeSmartCompactDetails } from "../../utils/type-guards.ts";
import { recordFailureMetrics } from "./metrics.ts";
import type { StatedRc } from "../run-context.ts";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { asBranchMessage } from "../../infra/ai-messages.ts";
import { clearCompactProgress } from "../../ui/overlays.ts";
import { formatCompactErrorForUi } from "../../ui/error-format.ts";
import { branchEntryIds } from "../../infra/session-identity.ts";

import * as log from "../../utils/logger.ts";

/**
 * Persist durable state for an applied payload.
 *
 * `session_before_compact` only stages a candidate; Pi may still abort. The
 * extension calls this function exactly once from the correlated
 * `session_compact` event after the compaction entry exists. Best-effort:
 * persistence failures are logged without corrupting the host session.
 */
export async function persistAppliedState(
  pending: PendingCompaction,
): Promise<string[]> {
  if (!pending.projectId)
    return pending.compactionState || pending.extraction
      ? ["project state (project identity unavailable)"]
      : [];
  const failures: string[] = [];
  if (
    pending.extraction &&
    !(await saveProjectFingerprint(
      pending.projectId,
      pending.sessionId,
      pending.extraction,
    ))
  ) {
    failures.push("project fingerprint");
  }
  if (pending.compactionState) {
    if (!saveCompactionState(pending.projectId, pending.compactionState)) {
      failures.push("continuity state");
    } else if (
      loadConfig().contextGraphEnabled &&
      !(await scheduleCompactionStateIndex(
        pending.projectId,
        pending.compactionState,
      ))
    ) {
      failures.push("context graph");
    }
  }
  return failures;
}

export async function commitAppliedCompaction(
  pending: PendingCompaction,
): Promise<string[]> {
  const startedAt = Date.now();
  const failures = await persistAppliedState(pending);
  if (
    pending.preparedBackup &&
    !(await commitPreparedConversationBackup(pending.preparedBackup))
  )
    failures.push("conversation backup");
  if (!pending.metricsSnapshot) return failures;
  const metricsWritten = await appendMetricsSnapshot(pending.sessionId, {
    ...pending.metricsSnapshot,
    persistenceStatus: failures.length ? "partial" : "complete",
    persistenceFailures: failures.length ? failures : undefined,
    phaseTimings: [
      ...(pending.metricsSnapshot.phaseTimings ?? []),
      { phase: "persist", durationMs: Date.now() - startedAt },
    ],
  });
  if (!metricsWritten) failures.push("metrics log");
  return failures;
}

/** Run post-compaction damage detection. Best-effort — never throws. */
export function runDamageDetection(rc: RunContext): void {
  try {
    const postCompactMsgs = rc.msgs
      .slice(rc.keepFrom)
      .map((e) => convertToLlm([asBranchMessage(e.message)]))
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
      rc.vlog(
        "Damage detection skipped: previous compaction details have an unrecognized shape",
      );
      return;
    }

    const damage = detectDamage(
      postCompactMsgs.slice(0, Math.min(15, postCompactMsgs.length)),
      safeDetails,
    );
    if (damage.damageScore > 0) {
      rc.notify("Previous compaction damage: " + damage.summary, "warning");
    }
    logDamageReport(rc.sessionId, damage, safeDetails, rc.projectId);
    // Feed re-read files forward as remediation hints so the next compaction
    // preserves them instead of losing them again.
    if (damage.reReadFiles.length > 0) {
      writeRemediationHints(rc.projectId, damage.reReadFiles);
    }
  } catch (err) {
    log.debugError("Damage detection skipped", err);
  }
}

/**
 * Stash the prepared compaction in pendingRef and trigger the native compact
 * if appropriate. Returns the pending summary so callers can decide whether
 * the run should keep running side effects (it does until the timeout/cleanup
 * step decides otherwise).
 */
export function stagePendingCompaction(
  rc: RunContext,
  metricsSnapshot?: MetricsSnapshot,
): PendingCompaction {
  // The producing branch head is immutable provenance. The consumer rejects
  // this payload unless both it and the kept-entry boundary remain in the
  // active branch ancestry.
  const originBranchHeadId = branchEntryIds(
    rc.branch as Array<{ id?: unknown }>,
  ).at(-1);
  if (!originBranchHeadId)
    throw new Error("Pending compaction requires an identifiable branch head");
  const pending: PendingCompaction = {
    runId: rc.runId,
    summary: rc.finalSummary,
    firstKeptEntryId: rc.firstKeptId,
    originBranchHeadId,
    tokensBefore: rc.totalTokens,
    details: rc.details,
    metricsSnapshot,
    compactionState: rc.compactionState,
    projectId: rc.projectId,
    extraction: rc.extraction,
    sessionId: rc.sessionId,
    preparedBackup: rc.preparedBackup,
  };
  rc.pendingRef.set(pending);
  return pending;
}

/**
 * Trigger Pi's native compact in non-auto/non-tool runs. Failure clears the
 * pendingRef so the next compact event cannot grab a stale summary (audit
 * P1 #4).
 *
 * `session_compact` owns success metrics and durable commit. onError removes
 * the correlated staged candidate; direct/test callers retain a safe metrics
 * fallback when no lifecycle handler is installed.
 */
export function applyCompaction(rc: StatedRc): void {
  if (rc.flags.skipCompact || rc.flags.autoTriggered) return;
  rc.ctx.compact({
    customInstructions: "Use pre-computed smart summary from /smart-compact",
    onComplete: () => {
      /* session_compact owns correlated success feedback */
    },
    onError: (e) => {
      clearCompactProgress(rc.ctx);
      rc.pendingRef.clear(rc.sessionId);
      const handled = rc.onNativeApplyError?.(rc.runId, e) ?? false;
      if (!handled) {
        void recordFailureMetrics(rc, e, {
          sessionId: rc.sessionId,
          tier: rc.tier,
          contextPercent: rc.contextPercent,
          toolPercent: rc.toolPercent,
          totalTokens: rc.totalTokens,
          methodForMetrics: rc.method,
          profile: rc.profile,
          mode: rc.mode,
        });
      }
      log.debugError("Native compaction apply failed", e);
      rc.ctx.ui.notify(formatCompactErrorForUi(e), "error");
    },
  });
}
