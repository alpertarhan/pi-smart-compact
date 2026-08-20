/**
 * Extraction cache, metrics, and cache-aware LLM options.
 *
 * Filesystem writes go through `src/infra/fs.ts` (atomic temp+rename for
 * snapshots, advisory lock for the metrics append log) so that two pi
 * sessions racing to compact the same project cannot corrupt each other's
 * state. All LLM I/O routes through the services bag's `llm` client so tests
 * can swap a fake provider in without resolving the real peer dependency.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  LLMCallMetric,
  StructuredExtraction,
  ExtractionEvidenceOverflow,
  CachedExtraction,
  CacheAwareOptions,
  CompactMetricsEntry,
  LlmMessage,
} from "../types.ts";
import {
  flattenToolCallBlock,
  isTransientToolDiagnostic,
  type ToolCallIndex,
} from "./extraction.ts";
import {
  estimateTokens,
  calibrateFromResponse,
  getProviderCaps,
} from "./tokens.ts";
import * as log from "./logger.ts";
import type {
  Model,
  Api,
  AssistantMessage,
  Context,
} from "@earendil-works/pi-ai";
import { extractionCacheFile, metricsLogFile } from "../infra/paths.ts";
import {
  appendLineLockedAsync,
  readJsonSync,
  writeJsonSync,
} from "../infra/fs.ts";
import {
  ONE_HOUR_MS,
  SEVEN_DAYS_MS,
  EXTRACTION_CACHE_PREFIX,
  RUNTIME_LOG_MAX_BYTES,
  ERROR_RETRY_WINDOW,
  ERROR_RESOLVE_WINDOW,
  EXTRACTION_LIMITS,
} from "../constants.ts";
import { buildEntryIdFingerprint } from "./id-fingerprint.ts";
import {
  getDefaultServices,
  type SmartCompactServices,
} from "../infra/services.ts";
import { toolOperationSignature } from "../domain/tool-semantics.ts";

// ── Cache Options ──

// Prompt-cache namespace id comes from the services bag's `compactSessionId`
// (set once per run by `createServices`).
/** One-shot phases that should not pay a provider prompt-cache write cost. */
const INTERNAL_PHASES: ReadonlySet<LLMCallMetric["phase"]> = new Set([
  "explore-retry",
  "explore-direct",
  "single-pass",
  "batch",
  "assemble",
  "patch",
]);
const SEGMENTATION_PHASES: ReadonlySet<LLMCallMetric["phase"]> = new Set([
  "probe",
  "explore",
  "explore-loop",
  "explore-retry",
  "explore-direct",
]);

function cacheOpts(
  opts: CacheAwareOptions,
  provider: string | undefined,
  phase: LLMCallMetric["phase"] | undefined,
  services: SmartCompactServices,
): CacheAwareOptions & { sessionId?: string } {
  // pi-ai/provider retries would bypass the run call budget and can replay a
  // six-figure prompt. Phase fallbacks are cheaper and already deterministic.
  const safeOpts = {
    ...opts,
    maxRetries: opts.maxRetries ?? 0,
    codexWatchdogMs: opts.codexWatchdogMs ?? services.codexWatchdogMs,
  };
  if (phase && INTERNAL_PHASES.has(phase)) {
    return { ...safeOpts, cacheRetention: "none" as const };
  }

  const strategy = provider ? getProviderCaps(provider).cacheStrategy : "none";
  const retention =
    strategy === "none"
      ? ("none" as const)
      : (opts.cacheRetention ?? ("short" as const));
  if (retention === "none") {
    return { ...safeOpts, cacheRetention: "none" as const };
  }
  return {
    ...safeOpts,
    sessionId: services.compactSessionId,
    cacheRetention: retention,
  };
}

// ── Metrics ──
//
// Metrics live on the per-run services container, injected explicitly by
// every caller (orchestrator threads `rc.services`; overlays receive it as a
// parameter). No hidden `getDefaultServices()` fallback on this surface: a
// missing bag is a compile error, not a silent cross-session leak. The one
// sanctioned fallback lives at the top of `trackedComplete` — the deep
// phases seam — and is resolved exactly once there.

export function recordMetric(
  m: LLMCallMetric,
  services: SmartCompactServices,
): void {
  services.metrics.record(m);
}

export function effectivePromptInputTokens(
  inputTokens: number,
  cacheHitTokens: number,
  cacheWriteTokens = 0,
): number {
  // pi-ai normalizes supported providers so `usage.input` excludes cache
  // reads and writes. The complete wire prompt is therefore always the sum.
  return (
    Math.max(0, inputTokens || 0) +
    Math.max(0, cacheHitTokens || 0) +
    Math.max(0, cacheWriteTokens || 0)
  );
}

export function getMetricsSummary(services: SmartCompactServices): {
  totalCalls: number;
  totalInput: number;
  totalOutput: number;
  totalCacheHit: number;
  totalCacheWrite: number;
  avgLatency: number;
  cacheHitRate: number;
} {
  const sum = services.metrics.summary();
  // The services container computes a structurally identical summary but
  // uses a slightly different cache-hit denominator. Keep the previously
  // published denominator (capped at <=1) so dashboards don't show >100%.
  const cacheDenominator = effectivePromptInputTokens(
    sum.totalInput,
    sum.totalCacheHit,
    sum.totalCacheWrite,
  );
  return {
    ...sum,
    cacheHitRate:
      cacheDenominator > 0
        ? Math.min(1, sum.totalCacheHit / cacheDenominator)
        : 0,
  };
}

// ── Tracked complete wrapper ──
// We resolve the LLM client on every call rather than caching the reference so
// that tests which call `setLlmClient` mid-suite see their fake immediately.
function clampCompletionMaxTokens(
  model: Model<Api>,
  requested: number | undefined,
): number | undefined {
  if (requested === undefined) return undefined;
  const modelLimit =
    Number.isFinite(model.maxTokens) && model.maxTokens > 0
      ? model.maxTokens
      : requested;
  return Math.max(1, Math.min(requested, modelLimit));
}

export async function trackedComplete(
  phase: LLMCallMetric["phase"],
  model: Model<Api>,
  reqBody: Context,
  opts: CacheAwareOptions,
  services?: SmartCompactServices,
): Promise<AssistantMessage> {
  // Single sanctioned fallback point: direct callers (legacy tests, REPL)
  // may omit services; everything downstream of here receives the resolved
  // bag explicitly.
  const svc = services ?? getDefaultServices();
  const safeRequest = svc.scrubber.scrubValue(reqBody).value;
  const rawRequest = JSON.stringify(safeRequest);
  const estimatedInput = estimateTokens(
    rawRequest,
    model.provider,
    model.id,
    svc.tokenCalibration,
  );
  const maxTokens = clampCompletionMaxTokens(model, opts.maxTokens);
  const outputReservation = svc.budget.reserveCall(
    estimatedInput,
    maxTokens ?? 0,
  );
  const start = Date.now();
  try {
    const boundedOpts =
      maxTokens === opts.maxTokens ? opts : { ...opts, maxTokens };
    const configuredReasoning = SEGMENTATION_PHASES.has(phase)
      ? svc.thinkingLevels.segmentationThinkingLevel
      : svc.thinkingLevels.summaryThinkingLevel;
    const callOpts =
      boundedOpts.reasoning !== undefined || configuredReasoning === null
        ? boundedOpts
        : { ...boundedOpts, reasoning: configuredReasoning };
    const resolvedOpts = cacheOpts(callOpts, model.provider, phase, svc);
    const resp = await svc.llm.complete(model, safeRequest, resolvedOpts);
    const latency = Date.now() - start;
    const usage = resp.usage;
    const hasInputUsage =
      typeof usage?.input === "number" && Number.isFinite(usage.input);
    const hasOutputUsage =
      typeof usage?.output === "number" && Number.isFinite(usage.output);
    const inputT = hasInputUsage ? Math.max(0, usage.input) : estimatedInput;
    const outputT = hasOutputUsage
      ? Math.max(0, usage.output)
      : estimateTokens(
          JSON.stringify(resp.content),
          model.provider,
          model.id,
          svc.tokenCalibration,
        );
    // Cache counters are meaningful only alongside provider-reported input.
    // When input usage is absent, `estimatedInput` already covers the complete
    // wire prompt and adding partial cache counters would double count it.
    const cacheT = hasInputUsage ? Math.max(0, usage?.cacheRead ?? 0) : 0;
    const cacheWriteT = hasInputUsage ? Math.max(0, usage?.cacheWrite ?? 0) : 0;
    const usageEstimated = !hasInputUsage || !hasOutputUsage;
    svc.budget.reconcileInput(
      estimatedInput,
      effectivePromptInputTokens(inputT, cacheT, cacheWriteT),
    );
    svc.budget.reconcileOutput(outputReservation, outputT);
    recordMetric(
      {
        phase,
        model: model.id,
        provider: model.provider,
        inputTokens: inputT,
        outputTokens: outputT,
        cacheHitTokens: cacheT,
        cacheWriteTokens: cacheWriteT,
        latencyMs: latency,
        success: true,
        usageEstimated,
      },
      svc,
    );
    try {
      if (hasInputUsage && inputT > 0) {
        const calibration = svc.tokenCalibration;
        calibrateFromResponse(
          estimateTokens(rawRequest, model.provider, model.id, calibration),
          effectivePromptInputTokens(inputT, cacheT, cacheWriteT),
          model.provider,
          model.id,
          calibration,
        );
      }
    } catch (e) {
      log.debug("token calibration failed", e);
    }
    return resp;
  } catch (err) {
    svc.budget.commitFailedOutput(outputReservation);
    recordMetric(
      {
        phase,
        model: model.id,
        provider: model.provider,
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: Date.now() - start,
        success: false,
      },
      svc,
    );
    throw err;
  }
}

// ── Extraction Cache ──

function getCachePath(sessionId: string): string {
  return extractionCacheFile(sessionId);
}

// Extraction cache stats delegate to the caller's services container —
// explicit injection, same contract as the metrics surface above.
export function getExtractionCacheStats(services: SmartCompactServices): {
  hits: number;
  misses: number;
  hitRate: number;
} {
  return services.extractionCacheStats.snapshot();
}

export function recordExtractionCacheHit(services: SmartCompactServices): void {
  services.extractionCacheStats.recordHit();
}
export function recordExtractionCacheMiss(
  services: SmartCompactServices,
): void {
  services.extractionCacheStats.recordMiss();
}

/**
 * Save extraction cache with entry-id fingerprints for branch-aware
 * invalidation.
 *
 * We store **compact fingerprints** rather than the raw id arrays so the cache
 * file stays a few hundred bytes regardless of session size. The fingerprint
 * carries enough information (count + tail + prefix hash) for the next run to
 * prove that the cached extraction's domain is a strict prefix of the current
 * pruned/unpruned conversation.
 *
 * @param msgCount — Length of the **pruned** llmMessages array. This is the
 *   domain for all index-bearing fields inside `extraction` (topics, errors,
 *   decisions, etc.). It must NOT be the unpruned toCompact length.
 * @param entryIds — FULL ordered list of original toCompact entry IDs. Used
 *   for branch/pivot detection on subsequent incremental runs.
 * @param keptEntryIds — Ordered entry IDs that survived pruning. This is the
 *   index domain used for safe incremental extraction prefix matching.
 */
export function saveCachedExtraction(
  sessionId: string,
  extraction: StructuredExtraction,
  msgCount: number,
  firstEntryId?: string,
  lastEntryId?: string,
  entryIds?: string[],
  keptEntryIds?: string[],
): void {
  try {
    const cached: CachedExtraction = {
      lastMessageIndex: msgCount - 1,
      extraction,
      messageCount: msgCount,
      timestamp: Date.now(),
      firstEntryId,
      lastEntryId,
      entryIdsFp: entryIds ? buildEntryIdFingerprint(entryIds) : undefined,
      keptEntryIdsFp: keptEntryIds
        ? buildEntryIdFingerprint(keptEntryIds)
        : undefined,
    };
    writeJsonSync(getCachePath(sessionId), cached);
  } catch (e) {
    log.warn("saveCachedExtraction failed", e);
  }
}

export function loadCachedExtraction(
  sessionId: string,
): CachedExtraction | null {
  const cached = readJsonSync<CachedExtraction>(getCachePath(sessionId));
  if (!cached) return null;
  if (Date.now() - cached.timestamp > EXTRACTION_CACHE_TTL_MS) return null; // 1hr TTL
  // Piggyback on every cache load to opportunistically prune sibling caches.
  // The actual scan is deferred to a later event-loop turn; collapse repeated
  // triggers with an in-flight guard.
  scheduleExtractionCacheCleanup();
  return cached;
}

const EXTRACTION_CACHE_TTL_MS = ONE_HOUR_MS;
const EXTRACTION_CACHE_PRUNE_MAX_AGE_MS = SEVEN_DAYS_MS;

/**
 * Stale extraction caches (sessions we'll never see again because the user
 * closed pi) accumulate in `~/.pi/agent/cache/` indefinitely. The TTL check
 * in `loadCachedExtraction` only filters at read time, never deletes; on a
 * heavy user's machine this can grow to thousands of files. We deferred-
 * prune on cache load, mirroring the backup-prune strategy in helpers.ts.
 *
 * - Schedule guard prevents repeated readdir during a single compaction.
 * - Files older than 7 days are unlinked (way beyond the 1-hour TTL, so
 *   we're only deleting caches that are definitely abandoned).
 */
let _extractionPruneInFlight = false;
function scheduleExtractionCacheCleanup(): void {
  if (_extractionPruneInFlight) return;
  _extractionPruneInFlight = true;
  setTimeout(() => {
    try {
      const dir = path.dirname(getCachePath("_")); // any sessionId gives us the dir
      if (!fs.existsSync(dir)) return;
      const now = Date.now();
      for (const name of fs.readdirSync(dir)) {
        if (
          !name.startsWith(EXTRACTION_CACHE_PREFIX) ||
          !name.endsWith(".json")
        )
          continue;
        const fp = path.join(dir, name);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > EXTRACTION_CACHE_PRUNE_MAX_AGE_MS) {
            try {
              fs.unlinkSync(fp);
            } catch (e) {
              log.debug("extraction-cache prune unlink failed", e);
            }
          }
        } catch (e) {
          log.debug("extraction-cache stat failed", e);
        }
      }
    } catch (e) {
      log.debug("extraction-cache cleanup failed", e);
    } finally {
      _extractionPruneInFlight = false;
    }
  });
}

/**
 * Merge a delta extraction into a base extraction, offsetting all
 * index-bearing fields so they align with the global message array.
 *
 * When `extractStructured` is called on `msgs.slice(cached.lastMessageIndex + 1)`
 * the delta's indexes start at 0 in the slice — but in the full conversation
 * they start at `baseMsgCount` (= `cached.messageCount` = `cached.lastMessageIndex + 1`).
 *
 * Without this offset, incremental extraction produces corrupted indexes that
 * break timeline ordering, topic segmentation, and downstream verification.
 */
function reconcileCachedErrors(
  errors: StructuredExtraction["errors"],
  deltaMessages: LlmMessage[],
  deltaToolCalls: ToolCallIndex,
  baseMsgCount: number,
): StructuredExtraction["errors"] {
  return errors.map((error) => {
    if (error.resolved) return { ...error };
    // Legacy cache entries lack the failed call's arguments. Preserve them as
    // unresolved rather than attributing an unrelated successful operation.
    if (!error.operationSignature) return { ...error };
    let retryAttempted = error.retryAttempted;
    let resolved = false;
    for (let j = 0; j < deltaMessages.length; j++) {
      const globalIndex = baseMsgCount + j;
      if (
        globalIndex <= error.index ||
        globalIndex > error.index + ERROR_RETRY_WINDOW
      )
        continue;
      const message = deltaMessages[j];
      if (message.role !== "assistant" || !Array.isArray(message.content))
        continue;
      const retry = message.content
        .flatMap(flattenToolCallBlock)
        .find(
          (call) =>
            toolOperationSignature(call.name, call.arguments) ===
            error.operationSignature,
        );
      if (!retry) continue;
      retryAttempted = true;
      for (
        let k = j + 1;
        k < Math.min(deltaMessages.length, j + ERROR_RESOLVE_WINDOW);
        k++
      ) {
        const result = deltaMessages[k];
        if (result.role !== "toolResult" || result.isError) continue;
        const resultCall = deltaToolCalls.get(result.toolCallId ?? "");
        const matches =
          retry.id == null
            ? Boolean(
                resultCall &&
                  toolOperationSignature(
                    resultCall.name,
                    resultCall.arguments,
                  ) === error.operationSignature,
              )
            : result.toolCallId === retry.id;
        if (matches) {
          resolved = true;
          break;
        }
      }
      break;
    }
    return { ...error, retryAttempted, resolved };
  });
}

interface BoundedEvidence<T> {
  values: T[];
  dropped: number;
}

function boundedTail<T>(items: T[], limit: number): BoundedEvidence<T> {
  const dropped = Math.max(0, items.length - limit);
  return { values: dropped ? items.slice(-limit) : items, dropped };
}

/** Keep the most recent occurrence of every identity while bounding memory. */
function recentUnique(items: string[], limit: number): BoundedEvidence<string> {
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (seen.has(item)) continue;
    seen.add(item);
    if (newestFirst.length < limit) newestFirst.push(item);
  }
  return {
    values: newestFirst.reverse(),
    dropped: Math.max(0, seen.size - limit),
  };
}

export function mergeExtractions(
  base: StructuredExtraction,
  delta: StructuredExtraction,
  baseMsgCount: number,
  deltaMessages: LlmMessage[] = [],
  deltaToolCalls: ToolCallIndex = new Map(),
): StructuredExtraction {
  // Offset every index-bearing field in the suffix into the cached domain.
  const offsetErrors = delta.errors.map((error) => ({
    ...error,
    index: error.index + baseMsgCount,
  }));
  const offsetDecisions = delta.decisions.map((decision) => ({
    ...decision,
    index: decision.index + baseMsgCount,
  }));
  const offsetConstraints = delta.constraints.map((constraint) => ({
    ...constraint,
    index: constraint.index + baseMsgCount,
  }));
  const offsetTopics = delta.topics.map((topic) => ({
    ...topic,
    startIndex: topic.startIndex + baseMsgCount,
    endIndex: topic.endIndex + baseMsgCount,
  }));
  const offsetTimeline = delta.timeline.map((event) => ({
    ...event,
    index: event.index + baseMsgCount,
  }));
  const offsetModifiedFiles = delta.modifiedFiles.map((file) => ({
    ...file,
    lastModifiedIndex: file.lastModifiedIndex + baseMsgCount,
  }));
  const offsetMedia = (delta.mediaAttachments ?? []).map((attachment) => ({
    ...attachment,
    index: attachment.index + baseMsgCount,
  }));

  const modified = new Map(
    base.modifiedFiles.map((file) => [file.path, { ...file }]),
  );
  for (const file of offsetModifiedFiles) {
    const previous = modified.get(file.path);
    modified.set(
      file.path,
      previous
        ? {
            ...file,
            toolCalls: previous.toolCalls + file.toolCalls,
            lastModifiedIndex: Math.max(
              previous.lastModifiedIndex,
              file.lastModifiedIndex,
            ),
          }
        : file,
    );
  }
  const deltaPresent = new Set([
    ...offsetModifiedFiles.map((file) => file.path),
    ...delta.readFiles,
  ]);
  const deltaDeleted = new Set(delta.deletedFiles);
  for (const file of deltaDeleted) modified.delete(file);

  const modifiedFiles = boundedTail(
    [...modified.values()].sort(
      (a, b) => a.lastModifiedIndex - b.lastModifiedIndex,
    ),
    EXTRACTION_LIMITS.MODIFIED_FILES,
  );
  const readFiles = recentUnique(
    [...base.readFiles, ...delta.readFiles].filter(
      (file) => !deltaDeleted.has(file),
    ),
    EXTRACTION_LIMITS.READ_FILES,
  );
  const deletedFiles = recentUnique(
    [...base.deletedFiles, ...delta.deletedFiles].filter(
      (file) => !deltaPresent.has(file),
    ),
    EXTRACTION_LIMITS.DELETED_FILES,
  );
  const referencedFiles = recentUnique(
    [...(base.referencedFiles ?? []), ...(delta.referencedFiles ?? [])],
    EXTRACTION_LIMITS.REFERENCED_FILES,
  );
  const mediaAttachments = boundedTail(
    [...(base.mediaAttachments ?? []), ...offsetMedia],
    EXTRACTION_LIMITS.MEDIA_ATTACHMENTS,
  );
  const reconciledBaseErrors = reconcileCachedErrors(
    base.errors,
    deltaMessages,
    deltaToolCalls,
    baseMsgCount,
  );
  const errors = boundedTail(
    [...reconciledBaseErrors, ...offsetErrors].filter(
      (error) => !isTransientToolDiagnostic(error.message),
    ),
    EXTRACTION_LIMITS.ERRORS,
  );
  const decisions = boundedTail(
    [...base.decisions, ...offsetDecisions],
    EXTRACTION_LIMITS.DECISIONS,
  );
  const constraints = boundedTail(
    [...base.constraints, ...offsetConstraints],
    EXTRACTION_LIMITS.CONSTRAINTS,
  );
  const topics = boundedTail(
    [...base.topics, ...offsetTopics],
    EXTRACTION_LIMITS.TOPICS,
  );
  const timeline = boundedTail(
    [...base.timeline, ...offsetTimeline],
    EXTRACTION_LIMITS.TIMELINE,
  );

  const dropped: Partial<Record<keyof ExtractionEvidenceOverflow, number>> = {
    modifiedFiles: modifiedFiles.dropped,
    referencedFiles: referencedFiles.dropped,
    readFiles: readFiles.dropped,
    deletedFiles: deletedFiles.dropped,
    errors: errors.dropped,
    decisions: decisions.dropped,
    constraints: constraints.dropped,
    topics: topics.dropped,
    timeline: timeline.dropped,
    mediaAttachments: mediaAttachments.dropped,
  };
  const evidenceOverflow: ExtractionEvidenceOverflow = {};
  for (const key of Object.keys(dropped) as Array<
    keyof ExtractionEvidenceOverflow
  >) {
    const total =
      (base.evidenceOverflow?.[key] ?? 0) +
      (delta.evidenceOverflow?.[key] ?? 0) +
      (dropped[key] ?? 0);
    if (total > 0) Object.assign(evidenceOverflow, { [key]: total });
  }

  return {
    modifiedFiles: modifiedFiles.values,
    readFiles: readFiles.values,
    deletedFiles: deletedFiles.values,
    referencedFiles: referencedFiles.values,
    mediaAttachments: mediaAttachments.values,
    errors: errors.values,
    decisions: decisions.values,
    constraints: constraints.values,
    topics: topics.values,
    timeline: timeline.values,
    mainGoal: delta.mainGoal ?? base.mainGoal,
    lastUserMessages: [
      ...base.lastUserMessages,
      ...delta.lastUserMessages,
    ].slice(-5),
    lastErrors: errors.values
      .filter((error) => !error.resolved)
      .map((error) => error.message)
      .slice(-3),
    messageCount: baseMsgCount + delta.messageCount,
    ...(Object.keys(evidenceOverflow).length ? { evidenceOverflow } : {}),
  };
}

// ── Metrics log ──
/** Extended metrics entry including pipeline context for regression detection. */
async function appendMetricsEntry(entry: CompactMetricsEntry): Promise<void> {
  const logPath = metricsLogFile();
  await appendLineLockedAsync(
    logPath,
    JSON.stringify(entry),
    RUNTIME_LOG_MAX_BYTES,
  );
}

/** Append a fully materialized payload after an external lifecycle commits. */
export async function appendMetricsSnapshot(
  sessionId: string,
  snapshot: Omit<CompactMetricsEntry, "ts" | "sessionId">,
): Promise<boolean> {
  try {
    await appendMetricsEntry({
      ts: new Date().toISOString(),
      sessionId,
      ...snapshot,
    });
    return true;
  } catch (error) {
    log.warn("appendMetricsSnapshot failed", error);
    return false;
  }
}

export async function appendMetricsLog(
  sessionId: string,
  extra:
    | Partial<
        Omit<
          CompactMetricsEntry,
          | "ts"
          | "sessionId"
          | "totalCalls"
          | "totalInput"
          | "totalOutput"
          | "totalCacheHit"
          | "totalCacheWrite"
          | "avgLatency"
          | "cacheHitRate"
        >
      >
    | undefined,
  services: SmartCompactServices,
): Promise<boolean> {
  try {
    await appendMetricsEntry({
      ts: new Date().toISOString(),
      sessionId,
      ...getMetricsSummary(services),
      ...extra,
    });
    return true;
  } catch (error) {
    log.warn("appendMetricsLog failed", error);
    return false;
  }
}

/**
 * Read the last `limit` valid entries from the metrics log without loading
 * the whole file. We start from the tail, walking backwards in 64 KB chunks
 * until we have enough lines (`limit * 4` raw lines is a generous safety
 * factor against corrupt entries that get filtered out). The old
 * implementation read the entire log into memory before slicing, which on
 * a long-lived install with a multi-megabyte log was a noticeable IO + GC
 * hit on every dashboard render.
 *
 * Behavior guarantees:
 *   - At most `limit` entries returned (always sliced from the tail).
 *   - Corrupt JSON lines are dropped with a warning, NOT counted toward limit.
 *   - Returned in chronological order (oldest -> newest within the window).
 */
export function readMetricsLog(limit = 100): CompactMetricsEntry[] {
  try {
    const logPath = metricsLogFile();
    if (!fs.existsSync(logPath)) return [];
    const stat = fs.statSync(logPath);
    const TAIL_CHUNK = 64 * 1024;
    // Heuristic budget: most lines are ~400 B; reading limit*8 lines worth of
    // bytes gives plenty of headroom while staying well under a 1 MB read for
    // limit=200. Cap by file size so we never read past the start.
    const wantBytes = Math.min(
      stat.size,
      Math.max(TAIL_CHUNK, limit * 8 * 512),
    );
    const startPos = Math.max(0, stat.size - wantBytes);

    const fd = fs.openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(wantBytes);
      const bytesRead = fs.readSync(fd, buf, 0, wantBytes, startPos);
      let text = buf.subarray(0, bytesRead).toString("utf8");
      // Drop the (potentially) partial first line when we didn't start at
      // byte 0; otherwise we'd half-parse it and emit a corrupt warning.
      if (startPos > 0) {
        const nl = text.indexOf("\n");
        if (nl >= 0) text = text.slice(nl + 1);
      }
      const lines = text.split("\n").filter(Boolean);
      const entries: CompactMetricsEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as CompactMetricsEntry);
        } catch {
          log.warn("Skipping corrupt compact metrics line");
        }
      }
      return entries.slice(-limit);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    log.warn("readMetricsLog failed", e);
    return [];
  }
}

// ── Backup ──
