/**
 * Phase 4: deterministic verification and repair.
 *
 * Verification findings are structured data. Formatting belongs at the UI/LLM
 * boundary; repair logic switches on `kind` and never reparses its own prose.
 */

import type { Model, Api, ProviderHeaders } from "@earendil-works/pi-ai";
import type { CompactionState, StructuredExtraction, VerificationGap, VerificationResult } from "../types.ts";
import { COMPACT_SYSTEM_PREFIX, TRUNC } from "../constants.ts";
import { trackedComplete } from "../utils/cache.ts";
import { getProviderCaps } from "../utils/tokens.ts";
import { extractFileRefs } from "../utils/file-ref-detect.ts";
import { isDiagnosticConstraintText } from "../utils/extraction.ts";
import { buildUniquePathNeedles, isKnownPathReference } from "../utils/file-needles.ts";
import * as log from "../utils/logger.ts";
import { parseSummary, findSection, appendToSection, renderSummary, upsertSection } from "../domain/summary-parse.ts";
import { canonicalHeading } from "../domain/summary-schema.ts";
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

export function verificationFailureMessage(result: VerificationResult): string | null {
  if (result.ok) return null;
  const findings = result.gaps.slice(0, 3)
    .map(gap => formatVerificationGap(gap).replace(/\s+/g, " ").slice(0, 160))
    .join("; ");
  return "Verification gate rejected summary (" + result.score + "/100, " +
    result.gaps.length + " unresolved gap(s))" + (findings ? ": " + findings : "");
}

const NEGATION_MARKERS = new Set([
  "no", "not", "never", "without", "avoid", "forbidden", "prohibit",
  "değil", "asla", "olmadan", "yasak", "hayır",
]);
const CONDITION_MARKERS = new Set([
  "only", "after", "before", "with", "requir", "until",
  "sadece", "sonra", "önce", "gerekli", "gerektirir",
]);
const SEMANTIC_STOP = new Set([
  "the", "and", "that", "this", "with", "from", "into", "must", "should",
  "only", "after", "before", "without", "never", "not", "does", "have",
  "için", "ile", "sonra", "önce", "sadece", "asla", "değil", "olmadan",
]);

function stemToken(token: string): string {
  const lower = token.toLocaleLowerCase();
  if (lower.length > 6 && lower.endsWith("ing")) return lower.slice(0, -3);
  if (lower.length > 5 && lower.endsWith("ed")) return lower.slice(0, -2);
  if (lower.length > 5 && lower.endsWith("es")) return lower.slice(0, -2);
  if (lower.length > 4 && lower.endsWith("s")) return lower.slice(0, -1);
  return lower;
}

function semanticTokens(text: string): string[] {
  return (text.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .map(stemToken)
    .filter(token => token.length > 2);
}

function evidenceFragments(text: string): string[] {
  return text.split(/(?:\r?\n|[.;])/).map(part => part.replace(/^\s*[-*\d.)]+\s*/, "").trim()).filter(Boolean);
}

function hasNearbyMarker(tokens: string[], anchor: string, markers: Set<string>): boolean {
  return tokens.some((token, index) => token === anchor
    && tokens.slice(Math.max(0, index - 2), index + 3).some(near => markers.has(near)));
}

/** Conservative deterministic semantic evidence for goals/constraints/decisions. */
function semanticShape(source: string): {
  sourceTokens: string[]; concepts: string[]; anchor: string; negative: boolean; conditional: boolean;
} {
  const sourceTokens = semanticTokens(source);
  const concepts = Array.from(new Set(sourceTokens.filter(token =>
    !SEMANTIC_STOP.has(token) && !NEGATION_MARKERS.has(token) && !CONDITION_MARKERS.has(token),
  )));
  const negative = sourceTokens.some(token => NEGATION_MARKERS.has(token));
  const conditional = sourceTokens.some(token => CONDITION_MARKERS.has(token));
  const anchor = concepts.find(concept => hasNearbyMarker(sourceTokens, concept, NEGATION_MARKERS)) ?? concepts[0] ?? "";
  return { sourceTokens, concepts, anchor, negative, conditional };
}

function hasSemanticEvidence(source: string, target: string): boolean {
  const { sourceTokens, concepts, anchor, negative, conditional } = semanticShape(source);
  if (!concepts.length) return true;
  const required = Math.min(concepts.length, Math.max(1, Math.ceil(concepts.length * 0.6)));
  return evidenceFragments(target).some(fragment => {
    const tokens = semanticTokens(fragment);
    const overlap = concepts.filter(concept => tokens.includes(concept)).length;
    if (overlap < required) return false;
    if (negative && !hasNearbyMarker(tokens, anchor, NEGATION_MARKERS)) {
      // A conditional prohibition ("do not X without Y") may be faithfully
      // restated positively as "X only after/with Y".
      const conditionalRestatement = sourceTokens.includes("without")
        && tokens.some(token => CONDITION_MARKERS.has(token))
        && overlap >= Math.min(2, concepts.length);
      if (!conditionalRestatement) return false;
    }
    if (conditional && !negative
      && !tokens.some(token => CONDITION_MARKERS.has(token))) return false;
    return true;
  });
}

function hasSemanticContradiction(source: string, target: string): boolean {
  const { sourceTokens, concepts, anchor, negative, conditional } = semanticShape(source);
  if (!anchor) return false;
  return evidenceFragments(target).some(fragment => {
    const tokens = semanticTokens(fragment);
    if (!tokens.includes(anchor)) return false;
    if (negative && !hasNearbyMarker(tokens, anchor, NEGATION_MARKERS)) {
      const overlap = concepts.filter(concept => tokens.includes(concept)).length;
      const validConditional = sourceTokens.includes("without")
        && tokens.some(token => CONDITION_MARKERS.has(token))
        && overlap >= Math.min(2, concepts.length);
      return !validConditional;
    }
    return conditional && !negative && !tokens.some(token => CONDITION_MARKERS.has(token));
  });
}

export function isDeterministicallyPatchable(gap: VerificationGap): boolean {
  if (gap.kind === "fabricated-file") return true;
  if (gap.kind === "inconsistency") return gap.detail.startsWith("blocked-none:");
  return true;
}

export function verifySummary(
  summary: string,
  extraction: StructuredExtraction,
  continuity: CompactionState | null = null,
): VerificationResult {
  const parsed = parseSummary(summary);
  const gaps: VerificationGap[] = [];
  const lower = summary.toLowerCase().replace(/\\/g, "/");
  const normalizedSummary = lower.replace(/\s+/g, " ");
  let score = 100;
  const uniqueByText = <T>(items: T[], text: (item: T) => string): T[] => {
    const seen = new Set<string>();
    return items.filter(item => {
      const key = text(item).toLowerCase().replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const unresolvedEvidence = uniqueByText([
    ...extraction.errors.filter(error => !error.resolved).map(error => ({ message: error.message })),
    ...(continuity?.unresolvedErrors ?? []).map(error => ({ message: error.message })),
  ], item => item.message);
  const constraintEvidence = uniqueByText([
    ...extraction.constraints.filter(item => item.confidence >= 0.8).map(item => ({ text: item.text })),
    ...(continuity?.constraints ?? []).filter(item => item.confidence >= 0.8).map(item => ({ text: item.text })),
  ], item => item.text).filter(item => !isDiagnosticConstraintText(item.text));
  const decisionEvidence = uniqueByText([
    ...extraction.decisions.filter(item => item.type === "explicit").map(item => ({ summary: item.summary })),
    ...(continuity?.decisions ?? []).filter(item => item.type === "explicit").map(item => ({ summary: item.summary })),
  ], item => item.summary);
  const goalEvidence = extraction.mainGoal ?? continuity?.goal ?? null;

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

  for (const error of unresolvedEvidence) {
    const snippet = error.message.trim().replace(/\s+/g, " ").slice(0, TRUNC.ERROR_SNIPPET).toLowerCase();
    if (snippet.length > 5 && !normalizedSummary.includes(snippet)) {
      gaps.push({ kind: "missing-error", message: error.message });
      score -= 5;
    }
  }

  const constraintTarget = [
    findSection(parsed, "constraints")?.body ?? "",
    findSection(parsed, "critical-context")?.body ?? "",
  ].join("\n");
  for (const constraint of constraintEvidence) {
    if (!hasSemanticEvidence(constraint.text, constraintTarget)) {
      gaps.push({ kind: "missing-constraint", text: constraint.text });
      score -= 8;
    }
    if (hasSemanticContradiction(constraint.text, constraintTarget)) {
      gaps.push({ kind: "inconsistency", detail: "semantic-contradiction: constraint contradicts " + constraint.text.slice(0, TRUNC.SNIPPET) });
      score -= 20;
    }
  }

  if (goalEvidence) {
    const goalTarget = findSection(parsed, "goal")?.body ?? "";
    if (!hasSemanticEvidence(goalEvidence, goalTarget)) {
      gaps.push({ kind: "missing-goal", goal: goalEvidence });
      score -= 12;
    }
    if (hasSemanticContradiction(goalEvidence, goalTarget)) {
      gaps.push({ kind: "inconsistency", detail: "semantic-contradiction: goal polarity or condition changed" });
      score -= 20;
    }
  }

  const groundedEvidenceFiles = [
    ...unresolvedEvidence.map(item => item.message),
    ...constraintEvidence.map(item => item.text),
    ...decisionEvidence.map(item => item.summary),
    ...(goalEvidence ? [goalEvidence] : []),
    ...(continuity?.openLoops.map(item => item.summary) ?? []),
    ...(continuity?.criticalContext ?? []),
  ].flatMap(extractFileRefs);
  const knownFiles = Array.from(new Set([
    ...modifiedPaths, ...extraction.readFiles, ...extraction.deletedFiles, ...(extraction.referencedFiles ?? []),
    ...groundedEvidenceFiles,
    ...(continuity?.modifiedFiles ?? []), ...(continuity?.readFiles ?? []), ...(continuity?.deletedFiles ?? []),
    ...(continuity?.unresolvedErrors ?? []).flatMap(error => error.files),
    ...(continuity?.openLoops ?? []).flatMap(loop => loop.files),
  ]));
  for (const ref of new Set(extractFileRefs(summary))) {
    if (!isKnownPathReference(ref, knownFiles)) {
      gaps.push({ kind: "fabricated-file", ref });
      score -= 4;
    }
  }

  const progressSection = findSection(parsed, "progress");
  if (progressSection) {
    const doneSection = progressSection.body.match(/###\s*Done[\s\S]*?(?=###|$)/i)?.[0] ?? "";
    const blockedSection = progressSection.body.match(/###\s*Blocked[\s\S]*?(?=###|$)/i)?.[0] ?? "";
    if (unresolvedEvidence.length > 0 && /(?:none|no blockers?|yok)\s*(?:recorded|known)?[.!]?\s*$/im.test(blockedSection)) {
      gaps.push({ kind: "inconsistency", detail: "blocked-none: Blocked says none despite unresolved errors" });
      score -= 12;
    }
    for (const file of extraction.modifiedFiles) {
      const basename = file.path.split("/").pop() ?? "";
      if (!doneSection.toLowerCase().includes(basename.toLowerCase())) continue;
      const unresolved = unresolvedEvidence.find(error => error.message.toLowerCase().includes(basename.toLowerCase()));
      if (unresolved) {
        gaps.push({ kind: "inconsistency", detail: basename + " marked Done but has unresolved error" });
        score -= 5;
      }
    }
  }

  const decisionBody = findSection(parsed, "decisions")?.body ?? "";
  for (const decision of decisionEvidence) {
    if (!hasSemanticEvidence(decision.summary, decisionBody)) {
      gaps.push({ kind: "missing-decision", summary: decision.summary });
      score -= 8;
    }
    if (hasSemanticContradiction(decision.summary, decisionBody)) {
      gaps.push({ kind: "inconsistency", detail: "semantic-contradiction: decision contradicts " + decision.summary.slice(0, TRUNC.SNIPPET) });
      score -= 20;
    }
  }

  const unresolvedCount = unresolvedEvidence.length + (continuity?.openLoops.filter(loop => loop.status !== "resolved").length ?? 0);
  if (unresolvedCount >= 1 && !findSection(parsed, "open-loops") && !lower.includes("unresolved")) {
    gaps.push({ kind: "missing-open-loops", unresolvedCount });
    score -= 5;
  }

  const finalScore = Math.max(0, score);
  return { ok: gaps.length === 0 && finalScore >= 85, gaps, score: finalScore };
}

/** Apply every safe, deterministic repair. Hallucination/inconsistency gaps stay visible for LLM/user review. */
export function patchDeterministic(
  summary: string,
  gaps: VerificationGap[],
  extraction: StructuredExtraction,
  continuity: CompactionState | null = null,
): string {
  let canonical: CanonicalSummary = parseSummary(summary);
  const verificationNotes: string[] = [];
  const unresolvedMessages = Array.from(new Set([
    ...extraction.errors.filter(error => !error.resolved).map(error => error.message),
    ...(continuity?.unresolvedErrors ?? []).map(error => error.message),
  ]));
  const unresolvedLoops = (continuity?.openLoops ?? []).filter(loop => loop.status !== "resolved");
  const blockedItems = [
    ...unresolvedMessages.map(message => "- " + message.slice(0, TRUNC.MESSAGE)),
    ...unresolvedLoops.map(loop => "- " + loop.summary.slice(0, TRUNC.MESSAGE)),
  ];
  const patchBlockedNone = (): void => {
    const progress = findSection(canonical, "progress");
    if (!progress || !blockedItems.length) return;
    const body = progress.body.replace(
      /(###\s*Blocked\s*\n)(?:-\s*(?:none|none recorded|no blockers?|yok)[.!]?\s*)/i,
      "$1" + blockedItems.join("\n"),
    );
    canonical = upsertSection(canonical, "progress", body);
  };

  for (const gap of gaps) {
    switch (gap.kind) {
      case "missing-section": {
        if (gap.section === "goal") {
          canonical = upsertSection(canonical, "goal", extraction.mainGoal ?? "Continue the current coding task.");
        } else if (gap.section === "progress") {
          canonical = upsertSection(canonical, "progress", "### Done\n- No explicit completion recorded.\n### In Progress\n- Continue from the latest user request.\n### Blocked\n" + (blockedItems.join("\n") || "- None recorded."));
        } else if (gap.section === "critical-context") {
          const critical = unresolvedMessages.map(message => "- Unresolved error: " + message.slice(0, TRUNC.MESSAGE));
          canonical = upsertSection(canonical, "critical-context", critical.join("\n") || "- None recorded.");
        }
        break;
      }
      case "missing-file":
        canonical = appendToSection(canonical, "files-modified", "- " + gap.path);
        break;
      case "missing-error": {
        const existing = findSection(canonical, "critical-context")?.body.toLowerCase() ?? "";
        const message = gap.message.slice(0, TRUNC.MESSAGE);
        if (!existing.includes(message.toLowerCase())) {
          canonical = appendToSection(canonical, "critical-context", "- Unresolved error: " + message);
        }
        break;
      }
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
        const current = extraction.errors.filter(error => !error.resolved)
          .map(error => "- [high] Resolve " + error.message.slice(0, TRUNC.SNIPPET));
        const carriedErrors = (continuity?.unresolvedErrors ?? [])
          .map(error => "- [high] Resolve " + error.message.slice(0, TRUNC.SNIPPET));
        const carriedLoops = (continuity?.openLoops ?? []).filter(loop => loop.status !== "resolved")
          .map(loop => "- [" + loop.priority + "] " + loop.summary.slice(0, TRUNC.SNIPPET));
        const body = Array.from(new Set([...current, ...carriedErrors, ...carriedLoops])).slice(0, gap.unresolvedCount).join("\n");
        canonical = upsertSection(canonical, "open-loops", body || "- Review unresolved errors.", "next-steps");
        break;
      }
      case "fabricated-file": {
        const normalizedRef = gap.ref.replace(/\\/g, "/").toLowerCase();
        let removed = false;
        canonical = {
          sections: canonical.sections.map(section => ({
            ...section,
            body: section.body.split("\n").filter(line => {
              if (!/^\s*[-*]\s+/.test(line)) return true;
              const matches = extractFileRefs(line).some(ref => ref.replace(/\\/g, "/").toLowerCase() === normalizedRef);
              if (matches) removed = true;
              return !matches;
            }).join("\n").trim(),
          })),
        };
        if (!removed) verificationNotes.push(formatVerificationGap(gap));
        break;
      }
      case "inconsistency":
        if (gap.detail.startsWith("blocked-none:")) patchBlockedNone();
        else verificationNotes.push(formatVerificationGap(gap));
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
  model: Model<Api>, auth: { apiKey: string; headers?: ProviderHeaders }, signal?: AbortSignal,
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
