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

import type { TieredRc, ExtractedRc, WindowedRc } from "../run-context.ts";
import { advance, markMeasuredPhase } from "../run-context.ts";
import type {
 PreparedConversationBackup,
 StructuredExtraction,
 CachedExtraction,
 LlmMessage,
 ProfileConfig,
} from "../../types.ts";
import { pruneRedundant } from "../../utils/pruning.ts";
import {
 extractStructured,
 buildToolCallIndex,
} from "../../utils/extraction.ts";
import type { PruningResult } from "../../utils/pruning.ts";
import {
 loadCachedExtraction,
 saveCachedExtraction,
 mergeExtractions,
 recordExtractionCacheHit,
 recordExtractionCacheMiss,
} from "../../utils/cache.ts";
import {
 deriveProjectId,
 loadProjectFingerprint,
 buildProjectContext,
} from "../../utils/fingerprint.ts";
import { getPreviousCompactionContext } from "../../utils/helpers.ts";
import { hashMessages, isPrefixOf, legacyPrefixMatch } from "../../utils/id-fingerprint.ts";
import {
 serializeConversationText,
 scrubLlmMessages,
} from "../../infra/ai-messages.ts";
import { prepareConversationBackup } from "../../utils/backups.ts";
import {
 loadScopedCompactionState,
 previewMergedContinuity,
 renderContinuityCapsule,
 retireSupersededConstraints,
} from "../../utils/state.ts";
import {
 boundedBranchLineageIds,
 branchEntryIds,
} from "../../infra/session-identity.ts";
import { EXTRACTION_LIMITS } from "../../constants.ts";

/** Shared continuity input; previews must request a read-only state load. */
export function loadExtractionContinuity(
 rc: { cwd: string; branch: unknown[]; sessionId: string; llmMessages: LlmMessage[] },
 extraction: StructuredExtraction,
 options: { readOnly?: boolean } = {},
) {
 const projectId = deriveProjectId(rc.cwd, extraction, rc.sessionId);
 const fingerprint = loadProjectFingerprint(projectId);
 const projectCtx = buildProjectContext(fingerprint);
 const ancestryIds = boundedBranchLineageIds(rc.branch as Array<{ id?: string; parentId?: string | null; type?: string }>);
 const continuityScope = {
  schemaVersion: 2 as const, projectId, sessionId: rc.sessionId,
  ...(ancestryIds.length ? { branchHeadId: ancestryIds[ancestryIds.length - 1], branchAncestryIds: ancestryIds } : {}),
 };
 const previousState = loadScopedCompactionState(continuityScope, ancestryIds, options);
 // A released user constraint must not return through an older snapshot.
 const factOverrides = retireSupersededConstraints([
  ...extraction.constraints.map(item => ({ text: item.text, index: item.index })),
  ...(previousState?.constraints ?? []).map(item => ({ text: item.text })),
 ], rc.llmMessages, previousState?.factOverrides ?? []);
 // Synthesis and both verification gates must agree on the required evidence;
 // the state step's merge is the authority, so preview it here.
 const verificationContinuity = previewMergedContinuity(extraction, previousState, factOverrides);
 return {
  projectId, fingerprint, projectCtx, continuityScope, previousState, factOverrides, verificationContinuity,
  continuity: previousState ? renderContinuityCapsule(previousState) : "",
 };
}

/** Pure cache selection, including branch/content validation and delta extraction. */
export function selectCachedExtraction(input: {
 llmMessages: LlmMessage[]; profileCfg: ProfileConfig;
 currentEntryIds: string[]; currentKeptEntryIds: string[]; cachedExt: CachedExtraction | null;
}): { extraction: StructuredExtraction; cache: "exact" | "incremental" | "miss"; missReason?: string } {
 const { llmMessages, profileCfg, currentEntryIds, currentKeptEntryIds, cachedExt } = input;
 let missReason: string | undefined = cachedExt ? "not-incremental" : "no-cache";
 let cacheUsable = false;
 let cacheExact = false;
 if (cachedExt) {
  const hasNewFp = !!(cachedExt.keptEntryIdsFp && cachedExt.entryIdsFp);
  const hasLegacy = !!(cachedExt.keptEntryIds && cachedExt.keptEntryIds.length > 0);
  const branchPrefixMatch = hasNewFp ? isPrefixOf(cachedExt.entryIdsFp, currentEntryIds) : legacyPrefixMatch(cachedExt.entryIds, currentEntryIds);
  const prunedPrefixMatch = hasNewFp ? isPrefixOf(cachedExt.keptEntryIdsFp, currentKeptEntryIds) : legacyPrefixMatch(cachedExt.keptEntryIds, currentKeptEntryIds);
  const keptCount = hasNewFp ? (cachedExt.keptEntryIdsFp?.count ?? 0) : (cachedExt.keptEntryIds?.length ?? 0);
  if (hasNewFp || hasLegacy) {
   const boundedCacheShape =
    cachedExt.extraction.modifiedFiles.length <= EXTRACTION_LIMITS.MODIFIED_FILES &&
    (cachedExt.extraction.referencedFiles?.length ?? 0) <= EXTRACTION_LIMITS.REFERENCED_FILES &&
    cachedExt.extraction.readFiles.length <= EXTRACTION_LIMITS.READ_FILES &&
    cachedExt.extraction.deletedFiles.length <= EXTRACTION_LIMITS.DELETED_FILES &&
    cachedExt.extraction.errors.length <= EXTRACTION_LIMITS.ERRORS &&
    cachedExt.extraction.decisions.length <= EXTRACTION_LIMITS.DECISIONS &&
    cachedExt.extraction.constraints.length <= EXTRACTION_LIMITS.CONSTRAINTS &&
    cachedExt.extraction.topics.length <= EXTRACTION_LIMITS.TOPICS &&
    cachedExt.extraction.timeline.length <= EXTRACTION_LIMITS.TIMELINE &&
    (cachedExt.extraction.mediaAttachments?.length ?? 0) <= EXTRACTION_LIMITS.MEDIA_ATTACHMENTS;
   cacheUsable = branchPrefixMatch && prunedPrefixMatch && boundedCacheShape &&
    cachedExt.messageCount === keptCount && cachedExt.messageCount <= llmMessages.length;
   cacheExact = cacheUsable && cachedExt.messageCount === llmMessages.length;
   if (!cacheUsable) {
    missReason = branchPrefixMatch ? prunedPrefixMatch ? boundedCacheShape
     ? cachedExt.messageCount === keptCount ? "cache-domain-ahead" : "cache-shape-mismatch"
     : "cache-evidence-unbounded" : "pruned-prefix-changed" : "entry-prefix-mismatch";
   }
   if (cacheUsable && (!cachedExt.messagePrefixHash || cachedExt.messagePrefixHash !== hashMessages(llmMessages, cachedExt.messageCount))) {
    cacheUsable = false; cacheExact = false; missReason = "content-prefix-changed";
   }
  } else {
   missReason = "legacy-no-kept-entryids";
  }
 }
 if (!cacheUsable || !cachedExt) {
  return { extraction: extractStructured(llmMessages, profileCfg, buildToolCallIndex(llmMessages)), cache: "miss", missReason };
 }
 if (cacheExact) return { extraction: cachedExt.extraction, cache: "exact" };
 const newMsgs = llmMessages.slice(cachedExt.messageCount);
 const deltaTcIdx = buildToolCallIndex(newMsgs);
 const delta = extractStructured(newMsgs, profileCfg, deltaTcIdx);
 return { extraction: mergeExtractions(cachedExt.extraction, delta, cachedExt.messageCount, newMsgs, deltaTcIdx), cache: "incremental" };
}

/**
 * Deferred conversation backup of the compacted messages, shared by the EESV
 * and native engines. Nothing is serialized until Pi confirms compaction;
 * structured redaction and the text scrubber run before serialization, and
 * redactions are surfaced because a restore brings back the redacted text.
 * `scrubbedText` reuses an already scrubbed serialization of `messages`.
 */
export function prepareScrubbedBackup(
 rc: Pick<WindowedRc, "config" | "services" | "notify" | "sessionId" | "branch" | "totalTokens">,
 messages: LlmMessage[],
 scrubbedText?: string,
): PreparedConversationBackup | undefined {
 if (!rc.config.backupEnabled) return undefined;
 const materializeBackup = () => {
  if (scrubbedText !== undefined) return scrubbedText;
  const safeMessages = scrubLlmMessages(
   messages,
   rc.services.scrubber,
  );
  const backupText = serializeConversationText(safeMessages);
  const scrubbed = rc.services.scrubber.scrubText(backupText);
  if (scrubbed.findings.length > 0) {
   rc.notify(
    "Backup written with redactions (" +
    scrubbed.findings.map((f) => f.count + "x " + f.kind).join(", ") +
    ") — restore will lack that data",
    "info",
   );
  }
  return scrubbed.value;
 };
 return prepareConversationBackup(materializeBackup, rc.sessionId, {
  branchLeafId: branchEntryIds(rc.branch as Array<{ id?: string }>).at(-1),
  contextTokens: rc.totalTokens,
 }) ?? undefined;
}

export function extractWithCache(rc: TieredRc): ExtractedRc {
 const extractStepStart = Date.now();
 const currentEntryIds = rc.toCompact.map((e) => e.id);

 // Pruning rebuilds the tool-call index from scratch when none is provided.
 // We don't have one yet at this point (recoverSessionLog returns raw
 // messages), so we let pruneRedundant build it; we then build a *second*
 // index over the pruned messages and store it on the RunContext for
 // extractors to reuse.
 const selectedMessages = rc.llmMessages;
 const pruning = pruneRedundant(selectedMessages);
 const pruningUnchanged =
  pruning.messages.length === selectedMessages.length &&
  pruning.messages.every(
   (message, index) => message === selectedMessages[index],
  );
 const currentKeptEntryIds = pruning.keptIndices
  .map((i) => rc.llmEntryIds[i])
  .filter((id): id is string => typeof id === "string");

 if (pruning.prunedCount > 0) {
  rc.notify(
   "Pruning: " +
   pruning.prunedCount +
   " msgs removed (" +
   pruning.reasons.map((r) => r.count + "x " + r.reason).join(", ") +
   ")",
   "info",
  );
 }
 const scrubbedMessages = scrubLlmMessages(
  pruning.messages,
  rc.services.scrubber,
 );
 pruning.messages = scrubbedMessages;
 rc.llmMessages = scrubbedMessages;
 const pruneEnd = Date.now();
 markMeasuredPhase(rc, "prune", extractStepStart, pruneEnd);

 const extractionStart = pruneEnd;
 const convText = rc.services.scrubber.scrubText(
  serializeConversationText(rc.llmMessages),
 ).value;
 const convTokens = rc.estimator.text(convText);
 const preparedBackup = prepareScrubbedBackup(
  rc,
  selectedMessages,
  pruningUnchanged ? convText : undefined,
 );
 const backupPath = preparedBackup?.path ?? null;
 const prevContext = getPreviousCompactionContext(rc.branch);

 const cachedExt = loadCachedExtraction(rc.sessionId);
 const currentFirstId = currentEntryIds[0];
 const currentLastId = currentEntryIds[currentEntryIds.length - 1];
 const selection = selectCachedExtraction({ llmMessages: rc.llmMessages, profileCfg: rc.profileCfg, currentEntryIds, currentKeptEntryIds, cachedExt });
 let extraction = selection.extraction;
 const missReason = selection.missReason;
 if (selection.cache === "miss") {
  recordExtractionCacheMiss(rc.services);
  rc.notify("Phase 1 Full: " + extraction.modifiedFiles.length + " files, " + extraction.errors.length + " errors", "info");
 } else {
  recordExtractionCacheHit(rc.services);
  rc.notify(selection.cache === "exact" ? "Phase 1 Cached: exact pruned conversation reused"
   : "Phase 1 Incremental: " + cachedExt!.messageCount + " cached + " + (rc.llmMessages.length - cachedExt!.messageCount) + " new pruned messages", "info");
 }
 rc.vlog("Extraction cache: " + selection.cache + (missReason ? "; " + missReason : ""));

 // Extraction caches are durable artifacts too: redact sensitive text before
 // it crosses the disk/prompt/state boundary. Paths and indexes are preserved.
 extraction = rc.services.scrubber.scrubValue(extraction).value;

 // messageCount is the pruned domain; entryIds is unpruned; keptEntryIds is
 // the pruning-prefix used for safe incremental extraction next time.
 saveCachedExtraction(
  rc.sessionId,
  extraction,
  rc.llmMessages.length,
  currentFirstId,
  currentLastId,
  currentEntryIds,
  currentKeptEntryIds,
  rc.llmMessages,
 );

 const { projectId, fingerprint, projectCtx, continuityScope, previousState, factOverrides, verificationContinuity, continuity } = loadExtractionContinuity({
  cwd: rc.ctx.cwd, sessionId: rc.sessionId, llmMessages: rc.llmMessages,
  branch: rc.ctx.sessionManager?.getBranch?.() ?? rc.branch,
 }, extraction);
 if (fingerprint) {
  rc.notify(
   "Project: " +
   fingerprint.language +
   (fingerprint.framework ? "/" + fingerprint.framework : "") +
   " (" +
   fingerprint.sessionCount +
   " sessions)",
   "info",
  );
 }

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
  continuityScope: typeof continuityScope;
  previousState: import("../../types.ts").CompactionState | null;
  verificationContinuity: import("../../types.ts").CompactionState;
  factOverrides: import("../../types.ts").ContinuityOverride[];
  convText: string;
  convTokens: number;
  backupPath: string | null;
  preparedBackup?: PreparedConversationBackup;
 };
 out.pruning = pruning;
 out.currentEntryIds = currentEntryIds;
 out.currentKeptEntryIds = currentKeptEntryIds;
 out.extraction = extraction;
 out.extractionCacheMissReason = missReason;
 out.prevContext = [prevContext, continuity].filter(Boolean).join("\n\n");
 out.projectCtx = projectCtx;
 out.projectId = projectId;
 out.continuityScope = continuityScope;
 out.previousState = previousState;
 out.verificationContinuity = verificationContinuity;
 out.factOverrides = factOverrides;
 out.convText = convText;
 out.convTokens = convTokens;
 out.backupPath = backupPath;
 out.preparedBackup = preparedBackup;
 markMeasuredPhase(out, "extract", extractionStart);
 return advance<TieredRc, ExtractedRc>(out, "_extracted");
}
