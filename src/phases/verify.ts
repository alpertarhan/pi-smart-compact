/**
 * Phase 4: deterministic verification and repair.
 *
 * Verification findings are structured data. Formatting belongs at the UI/LLM
 * boundary; repair logic switches on `kind` and never reparses its own prose.
 */

import type { Model, Api } from "@earendil-works/pi-ai";
import type { StructuredExtraction, VerificationGap, VerificationResult } from "../types.ts";
import { COMPACT_SYSTEM_PREFIX, TRUNC } from "../constants.ts";
import { trackedComplete } from "../utils/cache.ts";
import { getProviderCaps } from "../utils/tokens.ts";
import { extractFileRefs } from "../utils/file-ref-detect.ts";
import { buildUniquePathNeedles, isKnownPathReference } from "../utils/file-needles.ts";
import * as log from "../utils/logger.ts";
import { parseSummary, findSection, appendToSection, renderSummary, upsertSection } from "../domain/summary-parse.ts";
import { canonicalHeading } from "../domain/summary-schema.ts";
import { extractCheckKeywords } from "../domain/keywords.ts";
import type { CanonicalSummary } from "../domain/summary-schema.ts";
import type { SmartCompactServices } from "../infra/services.ts";

export function formatVerificationGap(gap: VerificationGap): string {
  switch (gap.kind) {
    case "missing-section": return "Missing section: " + canonicalHeading(gap.section);
    case "missing-file": return "Missing modified file: " + gap.path;
    case "missing-error": return "Missing error: " + gap.message.slice(0, TRUNC.SNIPPET);
    case "missing-constraint": return "Missing constraint: " + gap.text.slice(0, TRUNC.TOPIC_LABEL);
    case "missing-decision": return "Missing decision: " + gap.summary.slice(0, TRUNC.TOPIC_LABEL);
    case "missing-goal": return "Main goal may be missing from summary";
    case "fabricated-file": return "Potentially fabricated file: " + gap.ref;
    case "inconsistency": return "Inconsistency: " + gap.detail;
    case "missing-open-loops": return "Missing Open Loops section despite " + gap.unresolvedCount + " unresolved errors";
  }
}

export function isDeterministicallyPatchable(gap: VerificationGap): boolean {
  return gap.kind !== "fabricated-file" && gap.kind !== "inconsistency";
}

export function verifySummary(summary: string, extraction: StructuredExtraction): VerificationResult {
  const parsed = parseSummary(summary);
  const gaps: VerificationGap[] = [];
  const lower = summary.toLowerCase().replace(/\\/g, "/");
  let score = 100;

  const requiredSections: Array<{ kind: "goal" | "progress" | "critical-context"; penalty: number }> = [
    { kind: "goal", penalty: 5 },
    { kind: "progress", penalty: 5 },
    { kind: "critical-context", penalty: 3 },
  ];
  for (const req of requiredSections) {
    if (!findSection(parsed, req.kind)) {
      gaps.push({ kind: "missing-section", section: req.kind });
      score -= req.penalty;
    }
  }

  const modifiedPaths = extraction.modifiedFiles.map(file => file.path);
  for (const file of extraction.modifiedFiles) {
    const needles = buildUniquePathNeedles(file.path, modifiedPaths);
    if (!needles.some(needle => lower.includes(needle))) {
      gaps.push({ kind: "missing-file", path: file.path });
      score -= 5;
    }
  }

  for (const error of extraction.errors.filter(error => !error.resolved)) {
    const snippet = error.message.trim().replace(/\s+/g, " ").slice(0, TRUNC.ERROR_SNIPPET).toLowerCase();
    if (snippet.length > 5 && !lower.includes(snippet)) {
      gaps.push({ kind: "missing-error", message: error.message });
      score -= 5;
    }
  }

  for (const constraint of extraction.constraints.filter(constraint => constraint.confidence >= 0.8)) {
    const keywords = extractCheckKeywords(constraint.text, 3);
    if (keywords.length > 0 && !keywords.some(keyword => lower.includes(keyword.toLowerCase()))) {
      gaps.push({ kind: "missing-constraint", text: constraint.text });
      score -= 3;
    }
  }

  if (extraction.mainGoal) {
    const keywords = extractCheckKeywords(extraction.mainGoal, 4);
    if (keywords.length > 0 && !keywords.some(keyword => lower.includes(keyword.toLowerCase()))) {
      gaps.push({ kind: "missing-goal", goal: extraction.mainGoal });
      score -= 10;
    }
  }

  const knownFiles = [...modifiedPaths, ...extraction.readFiles];
  for (const ref of extractFileRefs(summary)) {
    if (!isKnownPathReference(ref, knownFiles)) {
      gaps.push({ kind: "fabricated-file", ref });
      score -= 4;
    }
  }

  const progressSection = findSection(parsed, "progress");
  if (progressSection) {
    const doneSection = progressSection.body.match(/###\s*Done[\s\S]*?(?=###|$)/i)?.[0] ?? "";
    for (const file of extraction.modifiedFiles) {
      const basename = file.path.split("/").pop() ?? "";
      if (!doneSection.toLowerCase().includes(basename.toLowerCase())) continue;
      const unresolved = extraction.errors.find(error => !error.resolved && error.message.toLowerCase().includes(basename.toLowerCase()));
      if (unresolved) {
        gaps.push({ kind: "inconsistency", detail: basename + " marked Done but has unresolved error" });
        score -= 5;
      }
    }
  }

  const decisionBody = findSection(parsed, "decisions")?.body.toLowerCase() ?? "";
  for (const decision of extraction.decisions.filter(decision => decision.type === "explicit")) {
    const keywords = extractCheckKeywords(decision.summary, 3);
    if (keywords.length > 0 && !keywords.some(keyword => decisionBody.includes(keyword.toLowerCase()))) {
      gaps.push({ kind: "missing-decision", summary: decision.summary });
      score -= 3;
    }
  }

  const unresolvedCount = extraction.errors.filter(error => !error.resolved).length;
  if (unresolvedCount >= 2 && !findSection(parsed, "open-loops") && !lower.includes("unresolved")) {
    gaps.push({ kind: "missing-open-loops", unresolvedCount });
    score -= 5;
  }

  const finalScore = Math.max(0, score);
  return { ok: gaps.length === 0 && finalScore >= 85, gaps, score: finalScore };
}

/** Apply every safe, deterministic repair. Hallucination/inconsistency gaps stay visible for LLM/user review. */
export function patchDeterministic(summary: string, gaps: VerificationGap[], extraction: StructuredExtraction): string {
  let canonical: CanonicalSummary = parseSummary(summary);
  const verificationNotes: string[] = [];

  for (const gap of gaps) {
    switch (gap.kind) {
      case "missing-section": {
        if (gap.section === "goal") {
          canonical = upsertSection(canonical, "goal", extraction.mainGoal ?? "Continue the current coding task.");
        } else if (gap.section === "progress") {
          canonical = upsertSection(canonical, "progress", "### Done\n- See preceding summary.\n### In Progress\n- Continue from the latest user request.\n### Blocked\n- None recorded.");
        } else if (gap.section === "critical-context") {
          canonical = upsertSection(canonical, "critical-context", "- None recorded.");
        }
        break;
      }
      case "missing-file":
        canonical = appendToSection(canonical, "files-modified", "- " + gap.path);
        break;
      case "missing-error":
        canonical = appendToSection(canonical, "critical-context", "- Unresolved error: " + gap.message.slice(0, TRUNC.MESSAGE));
        break;
      case "missing-constraint":
        canonical = appendToSection(canonical, "constraints", "- " + gap.text.slice(0, TRUNC.CONSTRAINT_TEXT));
        break;
      case "missing-decision":
        canonical = appendToSection(canonical, "decisions", "- **" + gap.summary.slice(0, TRUNC.DECISION_DETAIL) + "**");
        break;
      case "missing-goal":
        canonical = upsertSection(canonical, "goal", gap.goal);
        break;
      case "missing-open-loops": {
        const unresolved = extraction.errors.filter(error => !error.resolved).slice(0, gap.unresolvedCount);
        const body = unresolved.map(error => "- [high] Resolve " + error.message.slice(0, TRUNC.SNIPPET)).join("\n");
        canonical = upsertSection(canonical, "open-loops", body || "- Review unresolved errors.", "next-steps");
        break;
      }
      case "fabricated-file":
      case "inconsistency":
        verificationNotes.push(formatVerificationGap(gap));
        break;
    }
  }

  if (verificationNotes.length > 0) {
    canonical = upsertSection(canonical, "verification-note", verificationNotes.map(note => "- " + note).join("\n"));
  }
  return renderSummary(canonical, { canonicalHeadings: true });
}

export async function patchSummary(
  summary: string, gaps: VerificationGap[],
  model: Model<Api>, auth: { apiKey: string; headers?: Record<string, string> }, signal?: AbortSignal,
  services?: SmartCompactServices,
): Promise<string> {
  const patchPrompt = "The summary below is missing some critical information. Add the missing items WITHOUT restructuring the summary.\n\nMissing items:\n" +
    gaps.map((gap, index) => (index + 1) + ". " + formatVerificationGap(gap)).join("\n") +
    "\n\nCurrent summary:\n" + summary +
    "\n\nReturn the COMPLETE updated summary with missing items integrated. Keep the same format.";

  try {
    const maxTokens = Math.min(8192, getProviderCaps(model.provider).maxOutputTokens);
    const response = await trackedComplete("patch", model, {
      systemPrompt: COMPACT_SYSTEM_PREFIX,
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: patchPrompt }], timestamp: Date.now() }],
    }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens, signal }, services);
    const patched = response.content.filter((content): content is import("@earendil-works/pi-ai").TextContent => content.type === "text").map(content => content.text).join("\n").trim();
    return patched.startsWith("##") ? patched : summary;
  } catch (error) {
    log.debug("patchSummary LLM failed", error);
    return summary;
  }
}
