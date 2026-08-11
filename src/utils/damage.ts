/**
 * Post-compaction regression signal detection.
 * Monitors agent behavior after compaction to detect quality issues.
 */

import type { LlmMessage, SmartCompactDetails } from "../types.ts";
import { isToolCallBlock } from "../utils/type-guards.ts";
import { extractText } from "./extraction.ts";
import { classifyToolOperation, extractToolPath } from "../domain/tool-semantics.ts";
import * as log from "./logger.ts";
import { damageReportsFile, remediationHintsFile } from "../infra/paths.ts";
import { appendLineLocked, readJsonlTail, writeJsonSync, readJsonSync } from "../infra/fs.ts";
import { RUNTIME_LOG_MAX_BYTES, SEVEN_DAYS_MS, TRUNC } from "../constants.ts";
import { extractCheckKeywords } from "../domain/keywords.ts";

export interface RegressionSignal {
  type: "re-read" | "re-question" | "contradiction" | "user-complaint";
  severity: "low" | "medium" | "high";
  detail: string;
}

export interface DamageReport {
  signals: RegressionSignal[];
  damageScore: number; // 0 = no damage, 100 = severe damage
  summary: string;
  /** Distinct file paths the agent re-read after compaction — fed forward as
   *  remediation hints so the next compaction preserves them. */
  reReadFiles: string[];
}

// User complaint patterns indicating compaction may have lost important info
const COMPLAINT_PATTERNS = [
  /(?:I already (?:told|said|mentioned|explained) you|(?:we|I) (?:already|just) (?:discussed|went over|covered) this|you forgot|you lost|nerede kaldı|hatırlamıyor|unuttun)/i,
  /(?:that'?s? not (?:what I|right)|that'?s? wrong|yanlış|hayır değil|no that'|that doesn'?t match)/i,
];

/**
 * Detect regression signals in messages AFTER compaction.
 * Called with the post-compaction messages (typically 5-20 messages).
 *
 * @param postMessages Messages after compaction was applied
 * @param details The compaction details (contains the files/decisions that were compacted)
 */
export function detectDamage(
  postMessages: LlmMessage[],
  details: SmartCompactDetails,
): DamageReport {
  const signals: RegressionSignal[] = [];
  const reReadFiles: string[] = [];
  const reReadCounts = new Map<string, number>();
  const compactedFiles = new Set(details.modifiedFiles.map(f => f.toLowerCase()));
  const compactedReadFiles = new Set(details.readFiles.map(f => f.toLowerCase()));

  for (let i = 0; i < postMessages.length; i++) {
    const msg = postMessages[i];
    const text = extractText(msg.content).toLowerCase();

    // ── Re-read detection: agent reads files that were in the compacted section ──
    if (msg.role === "assistant") {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        if (isToolCallBlock(b)) {
          const operation = classifyToolOperation(b.arguments, b.name);
          const fp = operation === "read" || operation === "search" || operation === "list"
            ? extractToolPath(b.arguments)
            : undefined;
          if (fp) {
            const fpLower = fp.toLowerCase();
            if (compactedFiles.has(fpLower) || compactedReadFiles.has(fpLower)) {
              if (!reReadFiles.includes(fp)) reReadFiles.push(fp);
              const count = (reReadCounts.get(fpLower) ?? 0) + 1;
              reReadCounts.set(fpLower, count);
              // One re-read is normal continuation behavior. Repeated reads of
              // the same compacted file are a stronger loss signal.
              if (count === 2) {
                signals.push({
                  type: "re-read",
                  severity: "medium",
                  detail: "Agent repeatedly re-read compacted file: " + fp,
                });
              }
            }
          }
        }
      }
    }

    // ── Re-question detection: user re-asks about compacted topics ──
    if (msg.role === "user") {
      for (const pattern of COMPLAINT_PATTERNS) {
        if (pattern.test(text)) {
          signals.push({
            type: "user-complaint",
            severity: "high",
            detail: "User complaint after compaction: \"" + text.slice(0, TRUNC.TOPIC_LABEL) + "\"",
          });
          break;
        }
      }

      // Check if user re-asks about compacted topics
      for (const t of details.topics) {
        // Salient tokens (proper nouns / identifiers) are high-precision, so a
        // single match is enough signal — the old "≥2 long words" guard was for
        // the noisier positional keyword extraction.
        const topicWords = extractCheckKeywords(t, 3);
        if (topicWords.length > 0 && topicWords.some(w => text.includes(w.toLowerCase()))) {
          signals.push({
            type: "re-question",
            severity: "low",
            detail: "User mentions compacted topic: " + t.slice(0, TRUNC.SNIPPET),
          });
        }
      }
    }
  }

  const dedupedSignals = Array.from(new Map(signals.map(signal => [signal.type + ":" + signal.detail, signal])).values());

  // Low-severity topic mentions are observational, not damage by themselves.
  let damageScore = 0;
  for (const s of dedupedSignals) {
    if (s.severity === "high") damageScore += 25;
    else if (s.severity === "medium") damageScore += 10;
  }
  damageScore = Math.min(100, damageScore);

  // Build summary
  const parts: string[] = [];
  const reReads = dedupedSignals.filter(s => s.type === "re-read").length;
  const complaints = dedupedSignals.filter(s => s.type === "user-complaint").length;
  const reQuestions = dedupedSignals.filter(s => s.type === "re-question").length;
  if (reReads) parts.push(reReads + " re-read(s)");
  if (complaints) parts.push(complaints + " user complaint(s)");
  if (reQuestions) parts.push(reQuestions + " re-question(s)");

  return {
    signals: dedupedSignals,
    damageScore,
    summary: parts.length
      ? "Damage score: " + damageScore + "/100 — " + parts.join(", ")
      : "No regression signals detected (score: 0)",
    reReadFiles,
  };
}

/**
 * Save a damage report to the metrics log for future analysis.
 */
export function logDamageReport(
  sessionId: string,
  report: DamageReport,
  details: SmartCompactDetails,
  projectId?: string,
  observationSource: "online-window" | "next-compaction" = "next-compaction",
): void {
  try {
    const entry = {
      ts: new Date().toISOString(),
      runId: details.runId,
      sessionId,
      projectId,
      observationSource,
      method: details.method,
      profile: details.profile,
      mode: details.mode,
      version: details.version,
      releaseChannel: details.releaseChannel,
      qualityScore: details.qualityScore,
      damageScore: report.damageScore,
      signals: report.signals.length,
      summary: report.summary,
    };
    // Append and retention share one lock so an atomic trim cannot replace a
    // line that landed after the trim snapshot was read.
    appendLineLocked(damageReportsFile(), JSON.stringify(entry), RUNTIME_LOG_MAX_BYTES);
  } catch (e) { log.warn("logDamageReport failed", e); }
}

export interface OnlineDamageObservation {
  projectId: string;
  details: SmartCompactDetails;
  report: DamageReport;
  complete: boolean;
}

/** Session-keyed monitor activated only after Pi confirms `session_compact`. */
export class OnlineDamageMonitor {
  private readonly active = new Map<string, { projectId: string; details: SmartCompactDetails; messages: LlmMessage[] }>();

  constructor(private readonly maxMessages = 15) {}

  activate(sessionId: string, projectId: string, details: SmartCompactDetails): void {
    this.active.set(sessionId, { projectId, details, messages: [] });
  }

  observe(sessionId: string, message: LlmMessage): OnlineDamageObservation | null {
    const monitor = this.active.get(sessionId);
    if (!monitor) return null;
    monitor.messages.push(message);
    const report = detectDamage(monitor.messages, monitor.details);
    const complete = report.damageScore > 0 || monitor.messages.length >= this.maxMessages;
    if (!complete) return null;
    this.active.delete(sessionId);
    return { projectId: monitor.projectId, details: monitor.details, report, complete };
  }

  clear(sessionId: string): void { this.active.delete(sessionId); }
  size(): number { return this.active.size; }
}

export function readRecentDamageScores(projectId: string, limit = 5): number[] {
  const entries = readJsonlTail<{ projectId?: string; damageScore?: number }>(damageReportsFile(), Math.max(limit * 8, 40));
  return entries
    .filter(entry => entry.projectId === projectId && typeof entry.damageScore === "number")
    .slice(-limit)
    .map(entry => entry.damageScore!);
}

const REMEDIATION_TTL_MS = SEVEN_DAYS_MS;

/**
 * Persist the files the agent re-read after a compaction so the NEXT
 * compaction treats them as must-preserve (remediation). Overwrites with the
 * latest set; a TTL bounds how long stale hints linger.
 */
export function writeRemediationHints(projectId: string, files: string[]): void {
  if (!files.length) return;
  const cleaned = [...new Set(files.map(f => (f ?? "").trim()).filter(f => f.length > 0))];
  if (!cleaned.length) return;
  try {
    writeJsonSync(remediationHintsFile(projectId), { files: cleaned, updatedAt: Date.now() });
  } catch (e) { log.warn("writeRemediationHints failed", e); }
}

/**
 * Read remediation hints for a project. Returns [] when absent, malformed,
 * or older than the TTL.
 */
export function readRemediationHints(projectId: string): string[] {
  const data = readJsonSync<{ files?: unknown; updatedAt?: number }>(remediationHintsFile(projectId));
  if (!data || !Array.isArray(data.files)) return [];
  if (typeof data.updatedAt === "number" && Date.now() - data.updatedAt > REMEDIATION_TTL_MS) return [];
  return data.files.filter((f): f is string => typeof f === "string");
}
