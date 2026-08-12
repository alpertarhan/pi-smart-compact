/**
 * General helpers: config, backup, batching, preprocessing.
 */

import fs from "node:fs";
import type { CompactConfig, CompressionProfile, ChunkSummary, LlmChunk, StructuredExtraction, ExplorationReport, SessionType, SessionMessageEntry } from "../types.ts";
import { DEFAULT_CONFIG, PROFILES, CONFIG_KEY, CONFIG_KEY_ALT, TRUNC } from "../constants.ts";
import * as log from "./logger.ts";
import { settingsFile, defaultBackupDir } from "../infra/paths.ts";
import { flattenToolCallBlock } from "./extraction.ts";
import { extractToolPath } from "../domain/tool-semantics.ts";
import { isRecord } from "./type-guards.ts";

const VALID_PROFILES = ["light", "balanced", "aggressive"] as const;
const VALID_MODES = ["auto", "fast", "balanced", "thorough"] as const;
const VALID_AUTO_TRIGGER_STRATEGIES = ["native-hook", "settled"] as const;
const VALID_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const PROFILE_NUMERIC_KEYS = ["summaryBudgetTokens", "keepRecentTokens", "minChunkTokens", "maxChunkTokens", "singlePassMaxTokens", "batchMaxTokens"] as const;
const PROFILE_NUMERIC_BOUNDS: Record<(typeof PROFILE_NUMERIC_KEYS)[number], readonly [number, number]> = {
  summaryBudgetTokens: [256, 100_000],
  keepRecentTokens: [1_000, 500_000],
  minChunkTokens: [100, 100_000],
  maxChunkTokens: [500, 200_000],
  singlePassMaxTokens: [1_000, 500_000],
  batchMaxTokens: [1_000, 500_000],
};

/**
 * Validate user-supplied smart-compact config values.
 *
 * Invalid keys are **deleted** from `sc` so that the subsequent
 * `{ ...DEFAULT_CONFIG, ...sc }` merge falls back to the default.
 * This prevents silent misconfiguration (e.g. profile: "super").
 */
export function validateSmartCompactConfig(sc: Record<string, unknown>): void {
  if (sc.mode === "aggressive") {
    log.warn("smart-compact config: mode 'aggressive' is deprecated; using 'fast'.");
    sc.mode = "fast";
  }
  if ("mode" in sc && !(VALID_MODES as readonly string[]).includes(sc.mode as string)) {
    log.warn("smart-compact config: invalid mode '" + sc.mode + "', expected auto|fast|balanced|thorough. Using default 'auto'.");
    delete sc.mode;
  }
  if ("telemetryChannel" in sc && sc.telemetryChannel !== "stable" && sc.telemetryChannel !== "canary") {
    log.warn("smart-compact config: telemetryChannel must be stable|canary, got " + String(sc.telemetryChannel));
    delete sc.telemetryChannel;
  }
  if ("profile" in sc && !(VALID_PROFILES as readonly string[]).includes(sc.profile as string)) {
    log.warn("smart-compact config: invalid profile '" + sc.profile + "', expected light|balanced|aggressive. Using default 'balanced'.");
    delete sc.profile;
  }
  if ("autoTrigger" in sc && typeof sc.autoTrigger !== "boolean") {
    log.warn("smart-compact config: autoTrigger must be boolean, got " + typeof sc.autoTrigger);
    delete sc.autoTrigger;
  }
  if ("autoTriggerStrategy" in sc
    && !(VALID_AUTO_TRIGGER_STRATEGIES as readonly unknown[]).includes(sc.autoTriggerStrategy)) {
    log.warn(
      "smart-compact config: autoTriggerStrategy must be native-hook|settled, got "
        + String(sc.autoTriggerStrategy) + ". Using default '" + DEFAULT_CONFIG.autoTriggerStrategy + "'.",
    );
    delete sc.autoTriggerStrategy;
  }
  if ("backupEnabled" in sc && typeof sc.backupEnabled !== "boolean") {
    log.warn("smart-compact config: backupEnabled must be boolean, got " + typeof sc.backupEnabled);
    delete sc.backupEnabled;
  }
  for (const key of ["requireApproval", "scrubSecrets", "scrubPii", "focusWeighting", "zeroCallEnabled", "contextGraphEnabled", "adaptiveDamageFeedback", "onlineDamageMonitor"] as const) {
    if (key in sc && typeof sc[key] !== "boolean") {
      log.warn("smart-compact config: " + key + " must be boolean, got " + typeof sc[key]);
      delete sc[key];
    }
  }
  for (const key of ["summaryModel", "segmentationModel", "verificationModel"] as const) {
    if (key in sc && sc[key] !== null && typeof sc[key] !== "string") {
      log.warn("smart-compact config: " + key + " must be string|null, got " + typeof sc[key]);
      delete sc[key];
    }
  }
  for (const key of ["summaryThinkingLevel", "segmentationThinkingLevel"] as const) {
    const value = sc[key];
    if (key in sc && value !== null && !(typeof value === "string" && (VALID_THINKING_LEVELS as readonly string[]).includes(value))) {
      log.warn("smart-compact config: " + key + " must be minimal|low|medium|high|xhigh|max|null.");
      delete sc[key];
    }
  }
  if ("profiles" in sc) {
    if (typeof sc.profiles !== "object" || sc.profiles === null || Array.isArray(sc.profiles)) {
      log.warn("smart-compact config: profiles must be an object, got " + typeof sc.profiles);
      delete sc.profiles;
    } else {
      const profiles = sc.profiles as Record<string, unknown>;
      for (const [profileName, value] of Object.entries(profiles)) {
        if (!(VALID_PROFILES as readonly string[]).includes(profileName)) {
          log.warn("smart-compact config: ignoring unknown profile override '" + profileName + "'.");
          delete profiles[profileName];
          continue;
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          log.warn("smart-compact config: profile '" + profileName + "' must be an object.");
          delete profiles[profileName];
          continue;
        }
        const profileCfg = value as Record<string, unknown>;
        for (const [key, raw] of Object.entries(profileCfg)) {
          if (!(PROFILE_NUMERIC_KEYS as readonly string[]).includes(key)) {
            log.warn("smart-compact config: ignoring unknown profile key '" + profileName + "." + key + "'.");
            delete profileCfg[key];
            continue;
          }
          const [min, max] = PROFILE_NUMERIC_BOUNDS[key as keyof typeof PROFILE_NUMERIC_BOUNDS];
          if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) {
            log.warn(
              "smart-compact config: profile '" + profileName + "." + key
                + "' must be an integer in " + min + "–" + max + ".",
            );
            delete profileCfg[key];
          }
        }
        const merged = {
          ...PROFILES[profileName as CompressionProfile],
          ...profileCfg,
        };
        if (merged.minChunkTokens > merged.maxChunkTokens || merged.maxChunkTokens > merged.batchMaxTokens) {
          log.warn(
            "smart-compact config: profile '" + profileName
              + "' requires minChunkTokens <= maxChunkTokens <= batchMaxTokens; ignoring the override.",
          );
          delete profiles[profileName];
      }
    }
  }
  }
  if ("autoTriggerTimeoutMs" in sc) {
    const v = sc.autoTriggerTimeoutMs;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1000 || v > 300000) {
      log.warn("smart-compact config: autoTriggerTimeoutMs must be 1000–300000, got " + v + ". Using default " + DEFAULT_CONFIG.autoTriggerTimeoutMs + "ms.");
      delete sc.autoTriggerTimeoutMs;
    }
  }
  if ("maxLlmCalls" in sc) {
    const value = sc.maxLlmCalls;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
      log.warn("smart-compact config: maxLlmCalls must be 0–100; 0 uses the selected mode cap.");
      delete sc.maxLlmCalls;
    }
  }
  if ("maxLlmInputTokens" in sc) {
    const value = sc.maxLlmInputTokens;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
      log.warn("smart-compact config: maxLlmInputTokens must be 0–1000000; 0 uses the mode cap.");
      delete sc.maxLlmInputTokens;
    }
  }
  if ("codexMaxCallMs" in sc) {
    const value = sc.codexMaxCallMs;
    if (typeof value !== "number" || !Number.isInteger(value) || (value !== 0 && (value < 5_000 || value > 300_000))) {
      log.warn("smart-compact config: codexMaxCallMs must be 0 or 5000–300000; 0 derives a cap from maxTokens.");
      delete sc.codexMaxCallMs;
    }
  }
  if ("maxLatencyMs" in sc) {
    const value = sc.maxLatencyMs;
    if (typeof value !== "number" || !Number.isFinite(value) || (value !== 0 && (value < 5000 || value > 600000))) {
      log.warn("smart-compact config: maxLatencyMs must be 0 or 5000–600000; 0 means unlimited.");
      delete sc.maxLatencyMs;
    }
  }
  if ("minContextPercent" in sc) {
    const v = sc.minContextPercent;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
      log.warn("smart-compact config: minContextPercent must be 0–100, got " + v + ". Using default " + DEFAULT_CONFIG.minContextPercent + ".");
      delete sc.minContextPercent;
    }
  }
  if ("backupDir" in sc && sc.backupDir !== undefined && typeof sc.backupDir !== "string") {
    log.warn("smart-compact config: backupDir must be a string, got " + typeof sc.backupDir + ". Using default.");
    delete sc.backupDir;
  }
  if ("pinPaths" in sc && sc.pinPaths !== undefined) {
    if (!Array.isArray(sc.pinPaths) || !sc.pinPaths.every(x => typeof x === "string")) {
      log.warn("smart-compact config: pinPaths must be a string[], ignoring.");
      delete sc.pinPaths;
    }
  }
}

// Module-level config cache keyed by file mtime. Kept private so tests cannot
// accidentally observe stale config across HOME swaps; `resetConfigCache`
// gives them an explicit hook.
let _cfg: CompactConfig | null = null;
let _cfgMtime = 0;
let _cfgPath: string | null = null;

/** Test helper — forces the next loadConfig() to re-read settings.json. */
export function resetConfigCache(): void {
  _cfg = null;
  _cfgMtime = 0;
  _cfgPath = null;
}

export function loadConfig(): CompactConfig {
  try {
    const p = settingsFile();
    const stat = fs.statSync(p);
    // Re-key the cache on file path so swapping HOME in tests invalidates it.
    if (_cfg && _cfgPath === p && stat.mtimeMs === _cfgMtime) return _cfg;
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const sc = raw[CONFIG_KEY] ?? raw[CONFIG_KEY_ALT] ?? {};
    validateSmartCompactConfig(sc as Record<string, unknown>);
    const merged = { ...DEFAULT_CONFIG, ...sc } as CompactConfig;
    // Existing installs used only `profile`; preserve their behavior until
    // they opt into the new mode key.
    if (!("mode" in sc) && "profile" in sc) {
      merged.mode = sc.profile === "light" ? "thorough" : sc.profile as CompactConfig["mode"];
    }
    if (sc.profiles) merged.profiles = { ...PROFILES, ...sc.profiles } as Record<CompressionProfile, import("../types.ts").ProfileConfig>;
    if (!merged.backupDir) merged.backupDir = defaultBackupDir();
    _cfg = merged; _cfgMtime = stat.mtimeMs; _cfgPath = p; return _cfg;
  } catch (e) {
    log.debug("loadConfig: settings.json not found or unreadable, using defaults", e);
    const fallback: CompactConfig = { ...DEFAULT_CONFIG, backupDir: defaultBackupDir() } as CompactConfig;
    _cfg = fallback;
    _cfgPath = null;
    return fallback;
  }
}


export function getPreviousCompactionContext(branch: unknown[]): string {
  interface BranchEntry { type: string; timestamp?: string; summary?: string; details?: { topics?: string[]; method?: string } }
  const compactions = branch.filter((e): e is BranchEntry => (e as BranchEntry).type === "compaction");
  if (!compactions.length) return "";
  const last = compactions.reduce((latest, entry) => {
    const latestTime = Date.parse(latest.timestamp ?? "") || 0;
    const entryTime = Date.parse(entry.timestamp ?? "") || 0;
    return entryTime >= latestTime ? entry : latest;
  });
  const topics = last.details?.topics ?? [];
  const previousSummary = typeof last.summary === "string" ? last.summary.slice(0, TRUNC.PREVIOUS_SUMMARY) : "";
  return [
    "[IMPORTANT: Previous compaction exists (" + (last.details?.method ?? "unknown") + "). Already summarized topics: " + (topics.join(", ") || "unknown") + ". Build upon this, don't drop still-relevant facts.]",
    previousSummary ? "Previous verified summary:\n" + previousSummary : "",
  ].filter(Boolean).join("\n\n");
}

// SessionMessageEntry is now imported from types.ts

/**
 * Detect pi-toolkit anchor entries in the branch.
 * Anchors are toolResult entries with toolName=="context" and details.anchor.
 */
function findLastAnchorIndex(branchEntries: unknown[]): number {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const e = branchEntries[i] as Record<string, unknown> | undefined;
    if (e?.type !== "message") continue;
    const msg = e.message as Record<string, unknown> | undefined;
    if (msg?.role !== "toolResult") continue;
    if (msg?.toolName === "context" && (msg?.details as Record<string, unknown>)?.anchor) {
      return i;
    }
  }
  return -1;
}

/**
 * Map a branch entry index to its corresponding position in the filtered msgs array.
 * Branch may contain non-message entries (compaction, etc.), so indices don't align 1:1.
 */
function branchIndexToMsgIndex(branchEntries: unknown[], branchIdx: number, msgs: SessionMessageEntry[]): number {
  let msgCount = 0;
  for (let i = 0; i <= branchIdx && i < branchEntries.length; i++) {
    const e = branchEntries[i] as Record<string, unknown> | undefined;
    if (e?.type === "message") {
      if (msgCount >= msgs.length) return msgs.length - 1;
      msgCount++;
    }
  }
  return Math.max(0, Math.min(msgCount - 1, msgs.length - 1));
}

export type SmartBoundaryKind = "anchor" | "topical";

/** Return soft boundary candidates in application order. */
export function smartKeepBoundaryCandidates(
  msgs: SessionMessageEntry[],
  keepFromIndex: number,
  branchEntries?: unknown[],
): Array<{ kind: SmartBoundaryKind; keepFrom: number }> {
  const candidates: Array<{ kind: SmartBoundaryKind; keepFrom: number }> = [];

  if (branchEntries?.length) {
    const lastAnchorBranchIdx = findLastAnchorIndex(branchEntries);
    if (lastAnchorBranchIdx >= 0) {
      const anchor = branchIndexToMsgIndex(branchEntries, lastAnchorBranchIdx, msgs);
      if (keepFromIndex > anchor && anchor >= 0) candidates.push({ kind: "anchor", keepFrom: anchor });
    }
  }

  if (keepFromIndex <= 0 || keepFromIndex >= msgs.length) return candidates;

  const touchedFiles = (msg: unknown): Set<string> => {
    const m = msg as Record<string, unknown>;
    const blocks = Array.isArray(m?.content) ? m.content : [];
    const files = new Set<string>();
    for (const b of blocks) {
      for (const tc of flattenToolCallBlock(b)) {
        const fp = extractToolPath(tc.arguments);
        if (fp) files.add(fp.split("/").pop() ?? fp);
      }
    }
    return files;
  };
  const lastFiles = touchedFiles(msgs[keepFromIndex - 1].message);
  if (lastFiles.size > 0) {
    const keptFiles = touchedFiles(msgs[keepFromIndex].message);
    if ([...lastFiles].some(f => keptFiles.has(f))) {
      candidates.push({ kind: "topical", keepFrom: keepFromIndex - 1 });
    }
  }
  return candidates;
}

export function smartKeepBoundary(
  msgs: SessionMessageEntry[],
  keepFromIndex: number,
  branchEntries?: unknown[],
): number {
  const anchor = smartKeepBoundaryCandidates(msgs, keepFromIndex, branchEntries).find(candidate => candidate.kind === "anchor");
  const adjusted = anchor?.keepFrom ?? keepFromIndex;
  return smartKeepBoundaryCandidates(msgs, adjusted).find(candidate => candidate.kind === "topical")?.keepFrom ?? adjusted;
}

/**
 * Recursively collect tool call IDs from assistant message blocks.
 * Handles top-level toolCall blocks and nested multi_tool_use.parallel wrappers.
 */
function collectToolCallIds(blocks: unknown[], msgIndex: number, out: Map<string, number>): void {
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    if (typeof block.id === "string") out.set(block.id, msgIndex);
    // Flatten nested tool calls inside multi_tool_use.parallel.
    const args = block.arguments;
    if (block.name !== "multi_tool_use.parallel" || !isRecord(args) || !Array.isArray(args.tool_uses)) continue;
    for (const nested of args.tool_uses) {
      if (isRecord(nested) && typeof nested.id === "string") out.set(nested.id, msgIndex);
    }
  }
}

/**
 * Tool-call boundary guard: never split a toolCall / toolResult pair across the compaction boundary.
 *
 * If a kept message is a toolResult whose corresponding toolCall would be compacted,
 * pull keepFrom back to include the assistant message containing that toolCall.
 * This prevents "tool_call_id is not found" API errors after compaction.
 *
 * Also handles multi_tool_use.parallel wrappers where the actual tool call IDs are nested
 * inside arguments.tool_uses rather than on the wrapper block itself.
 */
export type ToolCallBoundaryIndex = ReadonlyMap<string, number>;

export function buildToolCallBoundaryIndex(msgs: SessionMessageEntry[]): ToolCallBoundaryIndex {
  const map = new Map<string, number>();
  for (let i = 0; i < msgs.length; i++) {
    const message = msgs[i].message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    collectToolCallIds(blocks, i, map);
  }
  return map;
}

export function guardToolCallBoundary(
  msgs: SessionMessageEntry[],
  keepFrom: number,
  tcMap: ToolCallBoundaryIndex = buildToolCallBoundaryIndex(msgs),
): number {
  if (keepFrom <= 0 || keepFrom >= msgs.length) return keepFrom;
  let adjusted = keepFrom;
  let changed = true;
  // Bound the transitive walk. Each iteration MUST shrink `adjusted` (we
  // only set `changed = true` when `tcIdx < adjusted`), so in practice this
  // converges in at most `keepFrom` steps. The explicit cap defends against
  // a corrupted session where a toolCall index would point past itself,
  // which would otherwise spin until process termination.
  const MAX_ITER = msgs.length + 1;
  let iter = 0;
  while (changed) {
    if (++iter > MAX_ITER) {
      // Should be unreachable; log loudly so a real upstream regression
      // surfaces in the metrics rather than as a silent hang.
      log.warn("guardToolCallBoundary hit MAX_ITER=" + MAX_ITER + " at adjusted=" + adjusted);
      break;
    }
    changed = false;
    for (let i = adjusted; i < msgs.length; i++) {
      const message = msgs[i].message;
      if (!isRecord(message) || message.role !== "toolResult") continue;
      const tcId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      if (!tcId) continue;
      const tcIdx = tcMap.get(tcId);
      if (tcIdx !== undefined && tcIdx < adjusted) {
        adjusted = tcIdx;
        changed = true;
        break;
      }
    }
  }

  return Math.max(0, Math.min(adjusted, msgs.length));
}

/**
 * Prefer summarizing a complete tool exchange when pulling its call backward
 * would exceed the retention target. Returns msgs.length when no later kept
 * message exists; callers can then retain the pair or reject the plan.
 */
export function advancePastToolCallBoundary(
  msgs: SessionMessageEntry[],
  keepFrom: number,
  tcMap: ToolCallBoundaryIndex = buildToolCallBoundaryIndex(msgs),
): number {
  if (keepFrom <= 0 || keepFrom >= msgs.length) return keepFrom;
  let adjusted = keepFrom;
  for (let iter = 0; iter <= msgs.length; iter++) {
    let next = adjusted;
    for (let i = adjusted; i < msgs.length; i++) {
      const message = msgs[i].message;
      if (!isRecord(message) || message.role !== "toolResult") continue;
      const tcIdx = typeof message.toolCallId === "string" ? tcMap.get(message.toolCallId) : undefined;
      if ((i === adjusted && tcIdx === undefined) || (tcIdx !== undefined && tcIdx < adjusted)) {
        next = i + 1;
        break;
      }
    }
    if (next === adjusted) return adjusted;
    adjusted = next;
    if (adjusted >= msgs.length) return msgs.length;
  }
  return msgs.length;
}


export function createBatches(chunks: LlmChunk[], maxTokens: number): LlmChunk[][] {
  const batches: LlmChunk[][] = [];
  let batch: LlmChunk[] = [], bt = 0;
  for (const ch of chunks) {
    if (batch.length && bt + ch.tokenEstimate > maxTokens) { batches.push(batch); batch = []; bt = 0; }
    batch.push(ch); bt += ch.tokenEstimate;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * Allocate token budget per topic based on priority, error density, and recency.
 * Topics with higher weights get more detail preserved.
 */
function allocateTopicBudgets(summaries: ChunkSummary[], totalBudget: number, focus?: string): Map<string, number> {
  const n = summaries.length;
  if (n === 0) return new Map();

  const weights = summaries.map((s, i) => {
    let w = 1.0;
    // Priority weighting
    if (s.priority === "critical") w *= 2.0;
    else if (s.priority === "high") w *= 1.5;
    else if (s.priority === "low") w *= 0.6;
    // Error density — topics with errors need more context
    const errorKeywords = (s.summary.match(/error|fail|bug|fix|crash|exception/gi) ?? []).length;
    w *= (1 + errorKeywords * 0.2);
    // Recency — later topics are more relevant
    const recency = (i + 1) / n;
    w *= (0.6 + recency * 0.4);
    // Topics with decisions are important
    if (s.keyDecisions.length > 0) w *= 1.3;
    if (focus) {
      const needle = normalizeFactKey(focus);
      const haystack = normalizeFactKey([s.topic, s.summary, ...s.filesModified, ...s.filesRead].join(" "));
      if (needle && haystack.includes(needle)) w *= 1.75;
    }
    return w;
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const baseTokensPerTopic = Math.floor(totalBudget / n);
  const budgetMap = new Map<string, number>();
  for (let i = 0; i < summaries.length; i++) {
    const allocated = Math.round(baseTokensPerTopic * (weights[i] / (totalWeight / n)));
    budgetMap.set(summaries[i].topic, Math.max(200, allocated)); // minimum 200 tokens per topic
  }
  return budgetMap;
}

export function preProcessSummaries(summaries: ChunkSummary[], budgetTokens?: number, focus?: string) {
  const topicBudgets = budgetTokens ? allocateTopicBudgets(summaries, budgetTokens, focus) : null;
  return {
    decisions: [...new Set(summaries.flatMap(s => s.keyDecisions))],
    modified: [...new Set(summaries.flatMap(s => s.filesModified))].sort(),
    read: [...new Set(summaries.flatMap(s => s.filesRead))].sort(),
    deleted: [...new Set(summaries.flatMap(s => s.filesDeleted ?? []))].sort(),
    text: summaries.map((cs, i) => {
      const budgetHint = topicBudgets?.get(cs.topic);
      const budgetLine = budgetHint ? "\nBudget: ~" + budgetHint + " tokens" : "";
      return "### Segment " + (i + 1) + ": " + cs.topic + "\nPriority: " + cs.priority + " | msgs " + cs.startIndex + "-" + cs.endIndex + budgetLine + "\n\n" + cs.summary + "\n\nDecisions: " + (cs.keyDecisions.join("; ") || "None") + "\nModified: " + (cs.filesModified.join(", ") || "None") + "\nRead: " + (cs.filesRead.join(", ") || "None") + "\nDeleted: " + ((cs.filesDeleted ?? []).join(", ") || "None");
    }).join("\n---\n"),
  };
}

export function normalizeFactKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function renderDeduped<T>(items: readonly T[], keyOf: (item: T) => string, render: (item: T) => string): string {
  const grouped = new Map<string, { item: T; count: number }>();
  for (const item of items) {
    const key = normalizeFactKey(keyOf(item));
    const existing = grouped.get(key);
    if (existing) existing.count++;
    else grouped.set(key, { item, count: 1 });
  }
  return [...grouped.values()].map(({ item, count }) => render(item) + (count > 1 ? " ×" + count : "")).join("; ");
}

export function buildExtractionContext(extraction: StructuredExtraction, forRange?: { start: number; end: number }): string {
  const inRange = (index: number): boolean => !forRange || (index >= forRange.start && index <= forRange.end);
  const files = forRange ? extraction.modifiedFiles.filter(f => inRange(f.lastModifiedIndex)) : extraction.modifiedFiles;
  const readFiles = forRange ? [] : extraction.readFiles;
  const deletedFiles = forRange ? [] : extraction.deletedFiles;
  const errors = extraction.errors.filter(error => inRange(error.index));
  const decisions = extraction.decisions.filter(decision => inRange(decision.index));
  const constraints = extraction.constraints.filter(constraint => inRange(constraint.index));
  const media = (extraction.mediaAttachments ?? []).filter(attachment => inRange(attachment.index));
  const overflow = Object.entries(extraction.evidenceOverflow ?? {})
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([kind, count]) => kind + ": +" + count)
    .join(", ");
  return [
    "## Deterministic Extraction (verified facts)",
    "Files modified: " + (files.map(f => f.path).join(", ") || "none"),
    "Files read: " + (readFiles.join(", ") || "none"),
    "Files deleted: " + (deletedFiles.join(", ") || "none"),
    "Errors: " + (renderDeduped(errors, e => e.tool + ":" + e.message + ":" + e.resolved, e => "[" + e.tool + "] " + e.message.slice(0, TRUNC.SNIPPET) + (e.resolved ? " ✓" : "")) || "none"),
    "Decisions: " + (renderDeduped(decisions, d => d.type + ":" + d.summary, d => d.type + ": " + d.summary.slice(0, TRUNC.DECISION_DETAIL)) || "none"),
    "Constraints: " + (renderDeduped(constraints, c => c.category + ":" + c.text, c => "[" + c.category + "] " + c.text.slice(0, TRUNC.DECISION_DETAIL)) || "none"),
    "Media attachments: " + (media.map(a => a.kind + (a.name ? ":" + a.name : "") + (a.mimeType ? " (" + a.mimeType + ")" : "") + " @msg" + a.index).join("; ") || "none"),
    "Evidence omitted by safety bounds: " + (overflow || "none"),
  ].join("\n");
}

/**
 * Infer session type from extraction data when exploration report is absent.
 *
 * Previously defaulted blindly to "implementation", which caused review-only
 * and discussion-only sessions to be summarized with the wrong prompt strategy.
 *
 * Heuristic priority:
 *  1. If exploration report provides a classification → trust it
 *  2. Active errors + code changes → debugging
 *  3. Reads only, no modifications → review
 *  4. Decisions but no code changes → discussion
 *  5. Code modifications → implementation
 *  6. Fallback → implementation (most common agent activity)
 */
/**
 * Minimal structural shape of a branch entry we care about for tool-share
 * accounting. Defined locally so we don't drag the full SessionEntry type
 * (which carries fields irrelevant to char counting) into a hot-path helper.
 */
interface BranchEntryLike {
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * Compute tool-output character percentage from branch entries.
 * Mirrors pi-toolkit's context hook logic for consistent tier decisions.
 */
export function computeToolCharPercentage(branchEntries: readonly unknown[]): number {
  let totalChars = 0;
  let toolChars = 0;
  for (const raw of branchEntries) {
    const m = (raw as BranchEntryLike | null | undefined)?.message;
    if (!m) continue;
    let mc = 0;
    if (typeof m.content === "string") {
      mc = m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== "object") continue;
        const block = part as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") mc += block.text.length;
      }
    }
    totalChars += mc;
    if (m.role === "toolResult") toolChars += mc;
  }
  return totalChars > 0 ? Math.round((toolChars / totalChars) * 100) : 0;
}

export type CompactionTier = "none" | "light" | "full";

export function selectCompactionTier(
  contextPercent: number,
  // toolPercent is recorded by the caller for metrics but deliberately NOT used in
  // the tier decision: a high tool-output ratio (tool=97%) ≠ context window full.
  toolPercent: number,
  totalTokens: number,
  minThreshold: number,
  minContextPercent: number = 60,
): CompactionTier {
  if (totalTokens < minThreshold) return "none";
  // Guard: don't compact if context is below threshold — tool=97% doesn't mean context is full
  if (contextPercent < minContextPercent) return "none";
  if (contextPercent < 80) return "light";
  return "full";
}

export function inferSessionType(
  extraction: StructuredExtraction,
  report: ExplorationReport | null,
): SessionType {
  if (report?.sessionType) return report.sessionType;

  const hasModifications = extraction.modifiedFiles.length > 0;
  const hasUnresolvedErrors = extraction.errors.some(e => !e.resolved);
  const hasResolvedErrors = extraction.errors.some(e => e.resolved);
  const hasReadsOnly = extraction.readFiles.length > 2 && !hasModifications;
  const hasDecisions = extraction.decisions.length > 0;

  if (hasUnresolvedErrors && (hasModifications || hasResolvedErrors)) return "debugging";
  if (hasReadsOnly && !hasDecisions) return "review";
  if (hasDecisions && !hasModifications && !hasUnresolvedErrors) return "discussion";
  if (hasModifications) return "implementation";

  return "implementation";
}

export function buildExplorationContext(report: ExplorationReport): string {
  if (!report.mainGoal && !report.crossReferences.length && !report.enrichedConstraints.length) return "";
  return [
    "## Exploration Report",
    "Main goal: " + report.mainGoal,
    "Session type: " + report.sessionType,
    report.crossReferences.length ? "Cross-references: " + report.crossReferences.join("; ") : "",
    report.enrichedConstraints.length ? "Enriched constraints: " + report.enrichedConstraints.join("; ") : "",
    report.statusAssessment.done.length ? "Assessed done: " + report.statusAssessment.done.join("; ") : "",
    report.statusAssessment.inProgress.length ? "Assessed in-progress: " + report.statusAssessment.inProgress.join("; ") : "",
    report.criticalContext.length ? "Critical context: " + report.criticalContext.join("; ") : "",
  ].filter(Boolean).join("\n");
}
