/**
 * Step 8: build the post-summary state, open loops, and delta against last run.
 *
 * Stage: `VerifiedRc` → `StatedRc`.
 *
 * The structured state is what later sessions reason against — `loadCompactionState`
 * reads it to compute the delta, `damage.ts` reads it to detect post-compaction
 * regression. Persistence itself happens later in the persist step so that we
 * never write stale state when the native compact ultimately fails to apply.
 */

import type { VerifiedRc, StatedRc } from "../run-context.ts";
import { advance } from "../run-context.ts";
import {
  buildCompactionState, injectOpenLoopsSection, extractNextActions,
  extractCriticalContext, loadCompactionState, computeDelta, injectDeltaSection,
  hasDeltaChanges, ensurePinnedPaths, applyLoopOverrides,
} from "../../utils/state.ts";
import { extractOpenLoops } from "../../utils/extraction.ts";
import { readRemediationHints } from "../../utils/damage.ts";
import type { SmartCompactDetails, OpenLoop, CompactionState } from "../../types.ts";

export function buildState(rc: VerifiedRc): StatedRc {
  const extraction = rc.extraction;
  let summary = rc.finalSummary;

  const prevState = loadCompactionState(rc.projectId);
  const loopOverrides = prevState?.loopOverrides ?? [];
  const extractedLoops = extractOpenLoops(rc.llmMessages, extraction);
  const currentKeys = new Set(extractedLoops.map(loop => loop.summary.toLowerCase().replace(/\s+/g, " ").trim()));
  const pinnedPrevious = (prevState?.openLoops ?? []).filter(loop => {
    const key = loop.summary.toLowerCase().replace(/\s+/g, " ").trim();
    const override = loopOverrides.find(item => item.summaryKey === key);
    return override?.pinned && !currentKeys.has(key);
  });
  const managedLoops = applyLoopOverrides([...extractedLoops, ...pinnedPrevious], loopOverrides);
  const openLoops = managedLoops.filter(loop => loop.status !== "resolved");
  if (openLoops.length > 0) {
    rc.notify(
      "Open Loops: " + openLoops.length + " detected (" +
        openLoops.filter(l => l.priority === "high").length + " high)",
      "info",
    );
    summary = injectOpenLoopsSection(summary, openLoops);
  }

  // Pinned paths ("never compact") + remediation hints (files the agent
  // re-read after a prior compaction) — a deterministic guarantee that survives
  // whatever the LLM chose to include. Ensured before state/delta so the
  // canonical headings exist for downstream injectors.
  const pinPaths = rc.config.pinPaths ?? [];
  const remediated = readRemediationHints(rc.projectId);
  const preserve = remediated.length
    ? Array.from(new Set([...pinPaths, ...remediated]))
    : pinPaths;
  if (remediated.length) {
    rc.notify("Remediation: re-preserving " + remediated.length + " file(s) lost in a prior compaction", "info");
  }
  if (preserve.length > 0) {
    summary = ensurePinnedPaths(summary, preserve);
  }

  const nextActions = extractNextActions(summary);
  const criticalContextItems = extractCriticalContext(summary);
  let compactionState = buildCompactionState(
    extraction, managedLoops, rc.explorationReport, nextActions, criticalContextItems, loopOverrides,
  );

  // Cross-compaction delta: when previous state exists, surface what changed
  // since last time so the agent sees a focused diff rather than the entire
  // recomputed state.
  if (prevState) {
    const delta = computeDelta(prevState, compactionState);
    if (hasDeltaChanges(delta)) {
      summary = injectDeltaSection(summary, delta);
      rc.notify(
        "Delta: " + delta.newLoops.length + " new loops, " + delta.resolvedLoops.length +
          " resolved, " + delta.newModifiedFiles.length + " new files",
        "info",
      );
    }
  }

  // Defense in depth: LLM requests and extraction caches are already scrubbed,
  // but deterministic state/delta injection is another write boundary.
  summary = rc.services.scrubber.scrubText(summary).value;
  compactionState = rc.services.scrubber.scrubValue(compactionState).value;

  const detModified = extraction.modifiedFiles.map(f => f.path);
  const detRead = extraction.readFiles;
  const estimatedAfter = rc.estimator.text(summary) + rc.accTokens;
  const tokensSaved = Math.max(0, rc.totalTokens - estimatedAfter);

  const details: SmartCompactDetails = {
    method: rc.method,
    chunkCount: rc.chunkCount || 1,
    topics: rc.summaries.length ? rc.summaries.map(s => s.topic) : [rc.method],
    readFiles: detRead, modifiedFiles: detModified,
    totalMessages: rc.toCompact.length, totalTokensSummarized: rc.convTokens,
    llmCalls: rc.llmCalls, profile: rc.profile, backupPath: rc.backupPath, tokensSaved,
    verified: rc.verified, gaps: rc.verificationGaps,
    explorationRounds: rc.explorationRounds, explorationBoundaries: rc.explorationReport?.boundaries.length ?? 0,
    model: rc.modelLabel, qualityScore: rc.verificationScore,
    tokensBefore: rc.totalTokens,
    provenance: rc.verificationProvenance,
    compactionState, openLoops,
    redactions: rc.services.scrubber.count(),
  };

  const out = rc as VerifiedRc & {
    _stated: true;
    openLoops: OpenLoop[];
    compactionState: CompactionState;
    details: SmartCompactDetails;
    tokensSaved: number;
  };
  out.finalSummary = summary;
  out.openLoops = openLoops;
  out.compactionState = compactionState;
  out.details = details;
  out.tokensSaved = tokensSaved;
  return advance<VerifiedRc, StatedRc>(out, "_stated");
}
