/**
 * Post-compaction regression signal detection.
 * Monitors agent behavior after compaction to detect quality issues.
 */

import type { LlmMessage, SmartCompactDetails } from "../types.ts";
import { isToolCallBlock } from "../types.ts";
import { extractText } from "./extraction.ts";
import fs from "node:fs";
import path from "node:path";

export interface RegressionSignal {
  type: "re-read" | "re-question" | "contradiction" | "user-complaint";
  severity: "low" | "medium" | "high";
  detail: string;
}

export interface DamageReport {
  signals: RegressionSignal[];
  damageScore: number; // 0 = no damage, 100 = severe damage
  summary: string;
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
  const compactedFiles = new Set(details.modifiedFiles.map(f => f.toLowerCase()));
  const compactedReadFiles = new Set(details.readFiles.map(f => f.toLowerCase()));

  for (let i = 0; i < postMessages.length; i++) {
    const msg = postMessages[i];
    const text = extractText(msg.content).toLowerCase();

    // ── Re-read detection: agent reads files that were in the compacted section ──
    if (msg.role === "assistant") {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        if (isToolCallBlock(b) && (b.name === "read" || b.name === "bash")) {
          const fp = (b.arguments?.path ?? b.arguments?.file_path) as string | undefined;
          if (fp) {
            const fpLower = fp.toLowerCase();
            if (compactedFiles.has(fpLower) || compactedReadFiles.has(fpLower)) {
              signals.push({
                type: "re-read",
                severity: "medium",
                detail: "Agent re-read compacted file: " + fp,
              });
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
    const dir = path.join(process.env.HOME ?? "/tmp", ".pi", "agent", ".cache", "smart-compact");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "damage-reports.jsonl");
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
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch { /* best effort */ }
}
