/**
 * Step 5: deterministic extraction with incremental cache.
 *
 * Stage: `TieredRc` → `ExtractedRc`.
 *
 * Pruning + extraction are paired here because:
 *
 *  1. The extraction indexes (topic ranges, error message offsets, decisions)
 *     live in the pruned message domain. Caching the extraction is only safe
 *     when the pruned *prefix* of the next run matches the previous one.
 *  2. Without the prefix guard, an incremental delta could be merged on top
 *     of a base whose pruning result drifted (e.g. a new duplicate read
 *     evicted an old cached read), producing index offsets that point at the
 *     wrong messages.
 *
 * `extractionCacheMissReason` captures *why* the cache could not be used so
 * the metrics dashboard can show the hit-rate alongside the failure mode.
 */

import type { TieredRc, ExtractedRc } from "../run-context.ts";
import { advance, markMeasuredPhase } from "../run-context.ts";
import type { StructuredExtraction } from "../../types.ts";
import { pruneRedundant } from "../../utils/pruning.ts";
import { extractStructured, buildToolCallIndex, type ToolCallIndex } from "../../utils/extraction.ts";
import type { PruningResult } from "../../utils/pruning.ts";
import {
  loadCachedExtraction, saveCachedExtraction, mergeExtractions,
  recordExtractionCacheHit, recordExtractionCacheMiss,
} from "../../utils/cache.ts";
import { deriveProjectId, findGitRoot, loadProjectFingerprint, buildProjectContext } from "../../utils/fingerprint.ts";
import { getPreviousCompactionContext } from "../../utils/helpers.ts";
import { isPrefixOf, legacyPrefixMatch } from "../../utils/id-fingerprint.ts";
import { estimateTokens } from "../../utils/tokens.ts";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import { asSerializableMessages } from "../../infra/ai-messages.ts";
import { backupConversation } from "../../utils/helpers.ts";

export function extractWithCache(rc: TieredRc): ExtractedRc {
  const extractStepStart = Date.now();
  const currentEntryIds = rc.toCompact.map(e => e.id);

  // Pruning rebuilds the tool-call index from scratch when none is provided.
  // We don't have one yet at this point (recoverSessionLog returns raw
  // messages), so we let pruneRedundant build it; we then build a *second*
  // index over the pruned messages and store it on the RunContext for
  // extractors to reuse.
  const pruning = pruneRedundant(rc.llmMessages);
  const currentKeptEntryIds = pruning.keptIndices
    .map(i => currentEntryIds[i])
    .filter((id): id is string => typeof id === "string");

  if (pruning.prunedCount > 0) {
    rc.notify(
      "Pruning: " + pruning.prunedCount + " msgs removed (" +
        pruning.reasons.map(r => r.count + "x " + r.reason).join(", ") + ")",
      "info",
    );
  }
  rc.llmMessages = pruning.messages;
  const pruneEnd = Date.now();
  markMeasuredPhase(rc, "prune", extractStepStart, pruneEnd);

  const extractionStart = pruneEnd;
  const convText = serializeConversation(asSerializableMessages(rc.llmMessages));
  const convTokens = estimateTokens(convText);

  const backupPath = backupConversation(convText, rc.sessionId);
  const prevContext = getPreviousCompactionContext(rc.branch);

  const cachedExt = loadCachedExtraction(rc.sessionId);
  let extraction: StructuredExtraction;
  let missReason: string | undefined = cachedExt ? "not-incremental" : "no-cache";
  const currentFirstId = rc.toCompact[0]?.id;
  const currentLastId = rc.toCompact[rc.toCompact.length - 1]?.id;

  // Two cache shapes coexist after v7.13:
  //   * New: `entryIdsFp` / `keptEntryIdsFp` (compact prefix fingerprints).
  //   * Legacy: full `entryIds` / `keptEntryIds` arrays from older versions.
  // We accept either so an in-place upgrade doesn't lose every running cache.
  let cacheUsable = false;
  let keptCount = 0;
  if (cachedExt) {
    const hasNewFp = !!(cachedExt.keptEntryIdsFp && cachedExt.entryIdsFp);
    const hasLegacy = !!(cachedExt.keptEntryIds && cachedExt.keptEntryIds.length > 0);

    const branchPrefixMatch = hasNewFp
      ? isPrefixOf(cachedExt.entryIdsFp, currentEntryIds)
      : legacyPrefixMatch(cachedExt.entryIds, currentEntryIds);
    const prunedPrefixMatch = hasNewFp
      ? isPrefixOf(cachedExt.keptEntryIdsFp, currentKeptEntryIds)
      : legacyPrefixMatch(cachedExt.keptEntryIds, currentKeptEntryIds);
    keptCount = hasNewFp
      ? (cachedExt.keptEntryIdsFp?.count ?? 0)
      : (cachedExt.keptEntryIds?.length ?? 0);

    if (hasNewFp || hasLegacy) {
      cacheUsable = branchPrefixMatch && prunedPrefixMatch &&
        cachedExt.messageCount === keptCount &&
        cachedExt.messageCount < rc.llmMessages.length;
      if (!cacheUsable) {
        missReason = !branchPrefixMatch ? "entry-prefix-mismatch"
          : !prunedPrefixMatch ? "pruned-prefix-changed"
            : cachedExt.messageCount !== keptCount ? "cache-shape-mismatch"
              : "no-new-pruned-messages";
      }
    } else {
      missReason = "legacy-no-kept-entryids";
      rc.vlog("Extraction cache ignored: legacy entry lacks keptEntryIds/keptEntryIdsFp");
    }
  }

  if (cacheUsable && cachedExt) {
    const newMsgs = rc.llmMessages.slice(cachedExt.messageCount);
    // Index over the suffix only — we can't reuse prunedTcIdx because its
    // msgIndex values are absolute, while extractStructured against `newMsgs`
    // expects offsets relative to newMsgs[0].
    const deltaTcIdx = buildToolCallIndex(newMsgs);
    const delta = extractStructured(newMsgs, rc.profileCfg, deltaTcIdx);
    extraction = mergeExtractions(cachedExt.extraction, delta, cachedExt.messageCount);
    rc.notify(
      "Phase 1 Incremental: " + cachedExt.messageCount + " cached + " + newMsgs.length + " new pruned messages",
      "info",
    );
    rc.vlog(
      "Incremental extraction — cached pruned messages: " + cachedExt.messageCount +
        ", current pruned: " + rc.llmMessages.length,
    );
    missReason = undefined;
    recordExtractionCacheHit(rc.services);
  } else {
    // Full extraction reuses one pruned-domain index across every extractor.
    // The incremental path deliberately skips this O(n) full-history walk and
    // indexes only its new suffix above.
    const prunedTcIdx: ToolCallIndex = buildToolCallIndex(rc.llmMessages);
    extraction = extractStructured(rc.llmMessages, rc.profileCfg, prunedTcIdx);
    rc.notify(
      "Phase 1 Full: " + extraction.modifiedFiles.length + " files, " + extraction.errors.length + " errors",
      "info",
    );
    rc.vlog("Full extraction — " + rc.llmMessages.length + " messages, tier=" + rc.tier);
    recordExtractionCacheMiss(rc.services);
  }

  // messageCount is the pruned domain; entryIds is unpruned; keptEntryIds is
  // the pruning-prefix used for safe incremental extraction next time.
  saveCachedExtraction(
    rc.sessionId, extraction, rc.llmMessages.length,
    currentFirstId, currentLastId, currentEntryIds, currentKeptEntryIds,
  );

  const projectId = deriveProjectId(findGitRoot(rc.ctx.cwd) ?? rc.ctx.cwd, extraction, rc.sessionId);
  const fingerprint = loadProjectFingerprint(projectId);
  if (fingerprint) {
    rc.notify(
      "Project: " + fingerprint.language + (fingerprint.framework ? "/" + fingerprint.framework : "") +
        " (" + fingerprint.sessionCount + " sessions)",
      "info",
    );
  }
  const projectCtx = buildProjectContext(fingerprint);

  const out = rc as TieredRc & {
    _extracted: true;
    pruning: PruningResult;
    currentEntryIds: string[];
    currentKeptEntryIds: string[];
    extraction: StructuredExtraction;
    extractionCacheMissReason?: string;
    prevContext: string;
    projectCtx: string;
    projectId: string;
    convText: string;
    convTokens: number;
    backupPath: string | null;
  };
  out.pruning = pruning;
  out.currentEntryIds = currentEntryIds;
  out.currentKeptEntryIds = currentKeptEntryIds;
  out.extraction = extraction;
  out.extractionCacheMissReason = missReason;
  out.prevContext = prevContext;
  out.projectCtx = projectCtx;
  out.projectId = projectId;
  out.convText = convText;
  out.convTokens = convTokens;
  out.backupPath = backupPath;
  markMeasuredPhase(out, "extract", extractionStart);
  return advance<TieredRc, ExtractedRc>(out, "_extracted");
}
