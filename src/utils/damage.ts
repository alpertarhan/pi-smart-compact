/**
 * Post-compaction regression signal detection.
 * Monitors agent behavior after compaction to detect quality issues.
 */

import type { LlmMessage, SmartCompactDetails } from "../types.ts";
import { isToolCallBlock } from "../utils/type-guards.ts";
import { extractText } from "./extraction.ts";
import { classifyTool, extractToolPath } from "../domain/tool-semantics.ts";
import * as log from "./logger.ts";
import { damageReportsFile, remediationHintsFile } from "../infra/paths.ts";
import { appendLineLocked, writeJsonSync, readJsonSync } from "../infra/fs.ts";

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
  /(?:go back to|return to|(?:look|check) again|tekrar bak|geri dön)/i,
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
  const compactedFiles = new Set(details.modifiedFiles.map(f => f.toLowerCase()));
  const compactedReadFiles = new Set(details.readFiles.map(f => f.toLowerCase()));

  for (let i = 0; i < postMessages.length; i++) {
    const msg = postMessages[i];
    const text = extractText(msg.content).toLowerCase();

    // ── Re-read detection: agent reads files that were in the compacted section ──
    if (msg.role === "assistant") {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        // Classify by argument shape, not name — see domain/tool-semantics.ts.
        // bash was never reachable here anyway (it carries `command`, not a
        // path, so fp was always undefined); accesses now also covers
        // grep/find/ls re-reads of compacted files.
        if (isToolCallBlock(b) && classifyTool(b.arguments) === "accesses") {
          const fp = extractToolPath(b.arguments);
          if (fp) {
            const fpLower = fp.toLowerCase();
            if (compactedFiles.has(fpLower) || compactedReadFiles.has(fpLower)) {
              signals.push({
                type: "re-read",
                severity: "medium",
                detail: "Agent re-read compacted file: " + fp,
              });
              if (!reReadFiles.includes(fp)) reReadFiles.push(fp);
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
            detail: "User complaint after compaction: \"" + text.slice(0, 100) + "\"",
          });
          break;
        }
      }

      // Check if user re-asks about compacted topics
      for (const t of details.topics) {
        const topicWords = t.toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 3);
        if (topicWords.length >= 2 && topicWords.some(w => text.includes(w))) {
          signals.push({
            type: "re-question",
            severity: "low",
            detail: "User mentions compacted topic: " + t.slice(0, 80),
          });
        }
      }
    }
  }

  // Calculate damage score
  let damageScore = 0;
  for (const s of signals) {
    if (s.severity === "high") damageScore += 25;
    else if (s.severity === "medium") damageScore += 10;
    else damageScore += 3;
  }
  damageScore = Math.min(100, damageScore);

  // Build summary
  const parts: string[] = [];
  const reReads = signals.filter(s => s.type === "re-read").length;
  const complaints = signals.filter(s => s.type === "user-complaint").length;
  const reQuestions = signals.filter(s => s.type === "re-question").length;
  if (reReads) parts.push(reReads + " re-read(s)");
  if (complaints) parts.push(complaints + " user complaint(s)");
  if (reQuestions) parts.push(reQuestions + " re-question(s)");

  return {
    signals,
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
): void {
  try {
    const entry = {
      ts: new Date().toISOString(),
      sessionId,
      method: details.method,
      profile: details.profile,
      qualityScore: details.qualityScore,
      damageScore: report.damageScore,
      signals: report.signals.length,
      summary: report.summary,
    };
    // Lock the JSONL append so concurrent pi sessions cannot interleave bytes.
    appendLineLocked(damageReportsFile(), JSON.stringify(entry));
  } catch (e) { log.warn("logDamageReport failed", e); }
}

const REMEDIATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
