/**
 * General helpers: config, backup, batching, preprocessing.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CompactConfig, CompressionProfile, ChunkSummary, LlmChunk, StructuredExtraction, ExplorationReport, SessionType, SessionMessageEntry } from "../types.ts";
import { DEFAULT_CONFIG, PROFILES, CONFIG_KEY, CONFIG_KEY_ALT } from "../constants.ts";
import * as log from "./logger.ts";
import { settingsFile, defaultBackupDir } from "../infra/paths.ts";
import { atomicWriteFileSync, ensureDir } from "../infra/fs.ts";

const VALID_PROFILES = ["light", "balanced", "aggressive"] as const;
const PROFILE_NUMERIC_KEYS = ["summaryBudgetTokens", "keepRecentTokens", "minChunkTokens", "maxChunkTokens", "singlePassMaxTokens", "batchMaxTokens"] as const;

/**
 * Validate user-supplied smart-compact config values.
 *
 * Invalid keys are **deleted** from `sc` so that the subsequent
 * `{ ...DEFAULT_CONFIG, ...sc }` merge falls back to the default.
 * This prevents silent misconfiguration (e.g. profile: "super").
 */
export function validateSmartCompactConfig(sc: Record<string, unknown>): void {
  if ("profile" in sc && !(VALID_PROFILES as readonly string[]).includes(sc.profile as string)) {
    log.warn("smart-compact config: invalid profile '" + sc.profile + "', expected light|balanced|aggressive. Using default 'balanced'.");
    delete sc.profile;
  }
  if ("autoTrigger" in sc && typeof sc.autoTrigger !== "boolean") {
    log.warn("smart-compact config: autoTrigger must be boolean, got " + typeof sc.autoTrigger);
    delete sc.autoTrigger;
  }
  if ("backupEnabled" in sc && typeof sc.backupEnabled !== "boolean") {
    log.warn("smart-compact config: backupEnabled must be boolean, got " + typeof sc.backupEnabled);
    delete sc.backupEnabled;
  }
  if ("summaryModel" in sc && sc.summaryModel !== null && typeof sc.summaryModel !== "string") {
    log.warn("smart-compact config: summaryModel must be string|null, got " + typeof sc.summaryModel);
    delete sc.summaryModel;
  }
  if ("segmentationModel" in sc && sc.segmentationModel !== null && typeof sc.segmentationModel !== "string") {
    log.warn("smart-compact config: segmentationModel must be string|null, got " + typeof sc.segmentationModel);
    delete sc.segmentationModel;
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
          if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 1_000_000) {
            log.warn("smart-compact config: profile '" + profileName + "." + key + "' must be a positive finite number.");
            delete profileCfg[key];
          }
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
  if ("minContextPercent" in sc) {
    const v = sc.minContextPercent;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
      log.warn("smart-compact config: minContextPercent must be 0–100, got " + v + ". Using default " + DEFAULT_CONFIG.minContextPercent + ".");
      delete sc.minContextPercent;
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

/**
 * Asynchronous deferred backup pruning.
 *
 * The previous implementation called `pruneOldBackups` synchronously right
 * after every backup write. That works fine when the directory has <20 files,
 * but a long-lived install with 1000+ orphan backups would readdir + statSync
 * every single entry on every compaction — a 20-50ms event-loop block on the
 * hot path. We now defer to `queueMicrotask` so the synchronous compaction
 * finishes first, and the prune happens on the next tick.
 *
 * Concurrency: we guard with a per-directory in-flight flag so two pi
 * sessions writing to the same backup directory don't double-prune. We don't
 * use a filesystem lock here because pruning is idempotent — the worst case
 * is one extra readdir.
 */
import { BACKUP_MAX_FILES, BACKUP_MAX_AGE_MS } from "../constants.ts";

const _pruneInFlight = new Set<string>();

function prunePass(dir: string): void {
  try {
    const entries = fs.readdirSync(dir)
      .filter(name => name.endsWith(".md"))
      .map(name => {
        const full = path.join(dir, name);
        try { return { full, mtimeMs: fs.statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter((v): v is { full: string; mtimeMs: number } => v !== null);

    const now = Date.now();
    const overAge = entries.filter(e => now - e.mtimeMs > BACKUP_MAX_AGE_MS);
    // Sort newest first so older entries get dropped past the count cap.
    const sorted = entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const overCount = sorted.slice(BACKUP_MAX_FILES);
    const toRemove = new Set([...overAge, ...overCount].map(e => e.full));
    for (const full of toRemove) {
      try { fs.unlinkSync(full); } catch (e) { log.debug("prunePass unlink failed", e); }
    }
  } catch (e) { log.debug("prunePass scan failed", e); }
}

/**
 * Queue an asynchronous prune. Returns immediately; the actual scan runs on
 * the next microtask. Multiple queued calls for the same directory collapse
 * to a single pass.
 */
function schedulePruneBackups(dir: string): void {
  if (_pruneInFlight.has(dir)) return;
  _pruneInFlight.add(dir);
  queueMicrotask(() => {
    try { prunePass(dir); } finally { _pruneInFlight.delete(dir); }
  });
}

export function backupConversation(convText: string, sessionId: string): string | null {
  try {
    const cfg = loadConfig(); if (!cfg.backupEnabled) return null;
    const dir = cfg.backupDir;
    ensureDir(dir);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const hash = crypto.createHash("sha256").update(convText).digest("hex").slice(0, 8);
    const fp = path.join(dir, sessionId + "-" + ts + "-" + hash + ".md");
    // Atomic write so a crash mid-write never leaves a half-readable backup.
    atomicWriteFileSync(fp, "# Smart Compact Backup\n# Date: " + new Date().toISOString() + "\n# Session: " + sessionId + "\n\n" + convText);
    // Defer pruning so the hot path returns instantly. Worst case we keep one
    // extra backup until the next compaction triggers a prune.
    schedulePruneBackups(dir);
    return fp;
  } catch (e) { log.warn("backupConversation failed", e); return null; }
}

export function getPreviousCompactionContext(branch: unknown[]): string {
  interface BranchEntry { type: string; details?: { topics?: string[]; method?: string } }
  const compactions = branch.filter((e): e is BranchEntry => (e as BranchEntry).type === "compaction");
  if (!compactions.length) return "";
  const last = compactions[compactions.length - 1] as BranchEntry;
  const topics = last.details?.topics ?? [];
  if (!topics.length) return "";
  return "\n[IMPORTANT: Previous compaction exists (" + (last.details?.method ?? "unknown") + "). Already summarized topics: " + topics.join(", ") + ". Build upon this, don't re-summarize the same content.]";
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

export function smartKeepBoundary(
  msgs: SessionMessageEntry[],
  keepFromIndex: number,
  branchEntries?: unknown[],
): number {
  let adjusted = keepFromIndex;

  // ── pi-toolkit anchor protection: never compact past the last on-branch anchor ──
  if (branchEntries && branchEntries.length > 0) {
    const lastAnchorBranchIdx = findLastAnchorIndex(branchEntries);
    if (lastAnchorBranchIdx >= 0) {
      const lastAnchorMsgIdx = branchIndexToMsgIndex(branchEntries, lastAnchorBranchIdx, msgs);
      if (adjusted > lastAnchorMsgIdx && lastAnchorMsgIdx >= 0) {
        adjusted = lastAnchorMsgIdx;
      }
    }
  }

  if (adjusted <= 0 || adjusted >= msgs.length) return adjusted;

  const last = msgs[adjusted - 1];
  const first = msgs[adjusted];
  if (last && first) {
    // Use extractText-style approach instead of JSON.stringify
    const getText = (msg: unknown): string => {
      const m = msg as Record<string, unknown>;
      const c = m?.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((b: unknown) => {
        if (typeof b === "string") return b;
        if (typeof b === "object" && b !== null && (b as { type?: string }).type === "text") return (b as { text?: string }).text ?? "";
        return "";
      }).join("");
      return "";
    };
    const lastText = getText(last.message).toLowerCase();
    const keptText = getText(first.message).toLowerCase();
    const fileRe = /(?:path|file)=["']([^"']+)["']/g;
    const lastFiles = new Set([...lastText.matchAll(fileRe)].map(m => m[1].split("/").pop()));
    fileRe.lastIndex = 0;
    const keptFiles = new Set([...keptText.matchAll(fileRe)].map(m => m[1].split("/").pop()));
    if ([...lastFiles].filter(f => keptFiles.has(f)).length > 0) return adjusted - 1;
  }
  return adjusted;
}

/**
 * Recursively collect tool call IDs from assistant message blocks.
 * Handles top-level toolCall blocks and nested multi_tool_use.parallel wrappers.
 */
function collectToolCallIds(blocks: unknown[], msgIndex: number, out: Map<string, number>): void {
  for (const b of blocks) {
    const block = b as Record<string, unknown>;
    if (block?.type === "toolCall") {
      if (typeof block.id === "string") {
        out.set(block.id, msgIndex);
      }
      // Flatten nested tool calls inside multi_tool_use.parallel
      const args = block.arguments as Record<string, unknown> | undefined;
      if (block.name === "multi_tool_use.parallel" && args && Array.isArray(args.tool_uses)) {
        for (const nested of args.tool_uses as unknown[]) {
          const n = nested as Record<string, unknown>;
          if (typeof n.id === "string") {
            out.set(n.id, msgIndex);
          }
        }
      }
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
export function guardToolCallBoundary(msgs: SessionMessageEntry[], keepFrom: number): number {
  if (keepFrom <= 0 || keepFrom >= msgs.length) return keepFrom;

  // Map toolCallId -> assistant message index (including nested multi_tool_use.parallel)
  const tcMap = new Map<string, number>();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i].message as Record<string, unknown>;
    if (m?.role !== "assistant") continue;
    const blocks = Array.isArray(m?.content) ? m.content : [];
    collectToolCallIds(blocks, i, tcMap);
  }

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
      const m = msgs[i].message as Record<string, unknown>;
      if (m?.role !== "toolResult") continue;
      const tcId = m?.toolCallId as string | undefined;
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

export function extractUserNote(args: string): string | undefined {
  const SKIP = new Set(["verbose", "debug", "dry-run", "light", "balanced", "aggressive"]);
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  // We only want to strip the *first* token if it looks like a
  // `--flag` / `provider/model` style argument; user notes themselves
  // routinely contain file paths (e.g. "src/auth.ts" or "fix utils/x").
  // The earlier `!t.includes("/")` blanket filter was eating those tokens
  // and silently corrupting the user's steering text.
  const isOptionToken = (t: string): boolean =>
    t.startsWith("--") || SKIP.has(t.toLowerCase()) ||
    // provider/model pattern: one slash, no spaces, slug-y on both sides.
    /^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(t);
  const nonFlags = tokens.filter(t => !isOptionToken(t));
  return nonFlags.length > 0 ? nonFlags.join(" ") : undefined;
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
function allocateTopicBudgets(summaries: ChunkSummary[], totalBudget: number): Map<string, number> {
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

export function preProcessSummaries(summaries: ChunkSummary[], budgetTokens?: number) {
  const topicBudgets = budgetTokens ? allocateTopicBudgets(summaries, budgetTokens) : null;
  return {
    decisions: [...new Set(summaries.flatMap(s => s.keyDecisions))],
    modified: [...new Set(summaries.flatMap(s => s.filesModified))].sort(),
    read: [...new Set(summaries.flatMap(s => s.filesRead))].sort(),
    text: summaries.map((cs, i) => {
      const budgetHint = topicBudgets?.get(cs.topic);
      const budgetLine = budgetHint ? "\nBudget: ~" + budgetHint + " tokens" : "";
      return "### Segment " + (i + 1) + ": " + cs.topic + "\nPriority: " + cs.priority + " | msgs " + cs.startIndex + "-" + cs.endIndex + budgetLine + "\n\n" + cs.summary + "\n\nDecisions: " + (cs.keyDecisions.join("; ") || "None") + "\nModified: " + (cs.filesModified.join(", ") || "None") + "\nRead: " + (cs.filesRead.join(", ") || "None");
    }).join("\n---\n"),
  };
}

export function buildExtractionContext(extraction: StructuredExtraction, forRange?: { start: number; end: number }): string {
  const files = forRange ? extraction.modifiedFiles.filter(f => f.lastModifiedIndex >= forRange.start && f.lastModifiedIndex <= forRange.end) : extraction.modifiedFiles;
  const errors = forRange ? extraction.errors.filter(e => e.index >= forRange.start && e.index <= forRange.end) : extraction.errors;
  const media = forRange ? (extraction.mediaAttachments ?? []).filter(a => a.index >= forRange.start && a.index <= forRange.end) : (extraction.mediaAttachments ?? []);
  return [
    "## Deterministic Extraction (verified facts)",
    "Files modified: " + (files.map(f => f.path).join(", ") || "none"),
    "Errors: " + (errors.map(e => "[" + e.tool + "] " + e.message.slice(0, 80) + (e.resolved ? " ✓" : "")).join("; ") || "none"),
    "Decisions: " + (extraction.decisions.map(d => d.type + ": " + d.summary.slice(0, 60)).join("; ") || "none"),
    "Constraints: " + (extraction.constraints.map(c => "[" + c.category + "] " + c.text.slice(0, 60)).join("; ") || "none"),
    "Media attachments: " + (media.map(a => a.kind + (a.name ? ":" + a.name : "") + (a.mimeType ? " (" + a.mimeType + ")" : "") + " @msg" + a.index).join("; ") || "none"),
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
        else if (block.type === "text" && typeof block.content === "string") mc += block.content.length;
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
