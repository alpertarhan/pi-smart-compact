import { createHash } from "node:crypto";
import type { ChunkSummary, ExplorationReport } from "../types.ts";
import { VERSION } from "../constants.ts";
import type { ExtractedRc } from "../app/run-context.ts";

export interface CachedSynthesis {
  finalSummary: string;
  method: "eesv" | "single-pass" | "heuristic";
  summaries: ChunkSummary[];
  explorationReport: ExplorationReport | null;
  explorationRounds: number;
  chunkCount: number;
}

interface Entry { value: CachedSynthesis; createdAt: number }
interface BatchEntry { value: ChunkSummary[]; createdAt: number }
const cache = new Map<string, Entry>();
const batchCache = new Map<string, BatchEntry>();
const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 16;
function fingerprint(value: string | undefined): string {
  return createHash("sha256").update(value ?? "").digest("hex");
}

function cloneExplorationReport(report: ExplorationReport | null): ExplorationReport | null {
  if (!report) return null;
  return {
    ...report,
    boundaries: report.boundaries.map(boundary => ({ ...boundary })),
    enrichedConstraints: report.enrichedConstraints.slice(),
    crossReferences: report.crossReferences.slice(),
    statusAssessment: {
      done: report.statusAssessment.done.slice(),
      inProgress: report.statusAssessment.inProgress.slice(),
      blocked: report.statusAssessment.blocked.slice(),
    },
    criticalContext: report.criticalContext.slice(),
    keyDecisions: report.keyDecisions.slice(),
  };
}

function cloneSynthesis(value: CachedSynthesis): CachedSynthesis {
  return {
    ...value,
    summaries: getCachedBatchClone(value.summaries),
    explorationReport: cloneExplorationReport(value.explorationReport),
  };
}


export function synthesisCacheKey(rc: ExtractedRc): string {
  const payload = JSON.stringify({
    version: VERSION,
    session: rc.sessionId,
    project: rc.projectId,
    entries: rc.currentKeptEntryIds,
    conversation: fingerprint(rc.convText),
    projectContext: fingerprint(rc.projectCtx),
    previous: rc.prevContext,
    mode: rc.mode,
    requestedMode: rc.requestedMode,
    profile: rc.profile,
    profileCfg: rc.profileCfg,
    summaryThinkingLevel: rc.config.summaryThinkingLevel,
    segmentationThinkingLevel: rc.config.segmentationThinkingLevel,
    focusWeighting: rc.config.focusWeighting !== false,
    summaryModel: {
      route: rc.modelLabel,
      api: rc.summaryModel.api,
      baseUrl: rc.summaryModel.baseUrl ?? "",
    },
    segmentationModel: {
      route: rc.segModel?.provider + "/" + rc.segModel?.id,
      api: rc.segModel?.api,
      baseUrl: rc.segModel?.baseUrl ?? "",
    },
    verificationModel: {
      route: rc.verifyModel?.provider + "/" + rc.verifyModel?.id,
      api: rc.verifyModel?.api,
      baseUrl: rc.verifyModel?.baseUrl ?? "",
    },
    maxLlmCalls: rc.maxLlmCalls,
    maxLlmInputTokens: rc.maxLlmInputTokens,
    timeoutMs: rc.timeoutMs,
    focus: rc.focus,
    userNote: rc.userNote,
    zeroCall: rc.config.zeroCallEnabled !== false,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function getCachedSynthesis(key: string, now = Date.now()): CachedSynthesis | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (now - entry.createdAt > TTL_MS) { cache.delete(key); return null; }
  cache.delete(key);
  cache.set(key, entry);
  return cloneSynthesis(entry.value);
}

export function setCachedSynthesis(key: string, value: CachedSynthesis, now = Date.now()): void {
  cache.delete(key);
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
  cache.set(key, { value: cloneSynthesis(value), createdAt: now });
}

export function batchCacheKey(value: unknown): string {
  return createHash("sha256").update(VERSION + "\n" + JSON.stringify(value)).digest("hex");
}

export function getCachedBatch(key: string, now = Date.now()): ChunkSummary[] | null {
  const entry = batchCache.get(key);
  if (!entry) return null;
  if (now - entry.createdAt > TTL_MS) { batchCache.delete(key); return null; }
  batchCache.delete(key);
  batchCache.set(key, entry);
  return entry.value.map(item => ({ ...item, keyDecisions: item.keyDecisions.slice(), filesModified: item.filesModified.slice(), filesRead: item.filesRead.slice(), filesDeleted: (item.filesDeleted ?? []).slice() }));
}

export function setCachedBatch(key: string, value: ChunkSummary[], now = Date.now()): void {
  batchCache.delete(key);
  while (batchCache.size >= 64) {
    const oldest = batchCache.keys().next().value as string | undefined;
    if (!oldest) break;
    batchCache.delete(oldest);
  }
  batchCache.set(key, { value: getCachedBatchClone(value), createdAt: now });
}

function getCachedBatchClone(value: ChunkSummary[]): ChunkSummary[] {
  return value.map(item => ({ ...item, keyDecisions: item.keyDecisions.slice(), filesModified: item.filesModified.slice(), filesRead: item.filesRead.slice(), filesDeleted: (item.filesDeleted ?? []).slice() }));
}

export function clearSynthesisCache(): void { cache.clear(); batchCache.clear(); }
export function synthesisCacheSize(): number { return cache.size + batchCache.size; }
