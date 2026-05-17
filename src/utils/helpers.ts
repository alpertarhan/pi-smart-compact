/**
 * General helpers: config, backup, batching, preprocessing.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CompactConfig, ChunkSummary, LlmChunk, StructuredExtraction, ExplorationReport, SessionMessageEntry } from "../types.ts";
import { DEFAULT_CONFIG, PROFILES, CONFIG_KEY, CONFIG_KEY_ALT, LOG_PREFIX } from "../constants.ts";

let _cfg: CompactConfig | null = null;
let _cfgMtime = 0;

export function loadConfig(): CompactConfig {
  try {
    const p = path.join(process.env.HOME ?? "/tmp", ".pi/agent/settings.json");
    const stat = fs.statSync(p);
    if (_cfg && stat.mtimeMs === _cfgMtime) return _cfg;
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const sc = raw[CONFIG_KEY] ?? raw[CONFIG_KEY_ALT] ?? {};
    const merged = { ...DEFAULT_CONFIG, ...sc } as CompactConfig;
    if (sc.profiles) merged.profiles = { ...PROFILES, ...sc.profiles };
    if (!merged.backupDir) merged.backupDir = path.join(process.env.HOME ?? "/tmp", ".pi/agent/compact-backups");
    _cfg = merged; _cfgMtime = stat.mtimeMs; return _cfg;
  } catch {
    const fallback: CompactConfig = { ...DEFAULT_CONFIG, backupDir: path.join(process.env.HOME ?? "/tmp", ".pi/agent/compact-backups") } as CompactConfig;
    _cfg = fallback;
    return fallback;
  }
}

export function backupConversation(convText: string, sessionId: string): string | null {
  try {
    const cfg = loadConfig(); if (!cfg.backupEnabled) return null;
    const dir = cfg.backupDir; fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const hash = crypto.createHash("sha256").update(convText).digest("hex").slice(0, 8);
    const fp = path.join(dir, sessionId + "-" + ts + "-" + hash + ".md");
    fs.writeFileSync(fp, "# Smart Compact Backup\n# Date: " + new Date().toISOString() + "\n# Session: " + sessionId + "\n\n" + convText);
    return fp;
  } catch (e) { console.error(LOG_PREFIX + " backupConversation failed:", e instanceof Error ? e.message : e); return null; }
}

export function getPreviousCompactionContext(branch: unknown[]): string {
  interface BranchEntry { type: string; details?: { topics?: string[]; method?: string } }
  const compactions = branch.filter((e: BranchEntry) => e.type === "compaction");
  if (!compactions.length) return "";
  const last = compactions[compactions.length - 1] as BranchEntry;
  const topics = last.details?.topics ?? [];
  if (!topics.length) return "";
  return "\n[IMPORTANT: Previous compaction exists (" + (last.details?.method ?? "unknown") + "). Already summarized topics: " + topics.join(", ") + ". Build upon this, don't re-summarize the same content.]";
}

// SessionMessageEntry is now imported from types.ts

export function smartKeepBoundary(msgs: SessionMessageEntry[], keepFromIndex: number): number {
  if (keepFromIndex <= 0 || keepFromIndex >= msgs.length) return keepFromIndex;
  const last = msgs[keepFromIndex - 1];
  const first = msgs[keepFromIndex];
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
    if ([...lastFiles].filter(f => keptFiles.has(f)).length > 0) return keepFromIndex - 1;
  }
  return keepFromIndex;
}

export function extractUserNote(args: string): string | undefined {
  const SKIP = new Set(["verbose", "debug", "dry-run", "light", "balanced", "aggressive"]);
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const nonFlags = tokens.filter(t => !t.includes("/") && !SKIP.has(t.toLowerCase()));
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
  return [
    "## Deterministic Extraction (verified facts)",
    "Files modified: " + (files.map(f => f.path).join(", ") || "none"),
    "Errors: " + (errors.map(e => "[" + e.tool + "] " + e.message.slice(0, 80) + (e.resolved ? " ✓" : "")).join("; ") || "none"),
    "Decisions: " + (extraction.decisions.map(d => d.type + ": " + d.summary.slice(0, 60)).join("; ") || "none"),
    "Constraints: " + (extraction.constraints.map(c => "[" + c.category + "] " + c.text.slice(0, 60)).join("; ") || "none"),
  ].join("\n");
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
