/**
 * Phase 4: Verification + Quality Score.
 *
 * Verification was historically a long chain of `summary.toLowerCase().includes(...)`
 * checks. That worked but coupled the score to the exact markdown wording, so
 * `### Goal` instead of `## Goal` registered as a missing section even though
 * the content was right there. We now parse the summary once into a
 * `CanonicalSummary` (see `domain/summary-schema.ts`) and run section-level
 * checks against the structured form. The text-content checks (file names,
 * error snippets, decisions) still run on the body string, but only after the
 * section has been positively identified by `kind`.
 *
 * Deterministic patching writes structured sections back into the summary via
 * `appendToSection` / `upsertSection`, so a follow-up parse round always sees
 * the canonical headings even when the LLM produced something idiosyncratic.
 */

import type { Model, Api } from "@earendil-works/pi-ai";
import type { StructuredExtraction, VerificationResult, CacheAwareOptions } from "../types.ts";
import { COMPACT_SYSTEM_PREFIX } from "../constants.ts";
import { trackedComplete } from "../utils/cache.ts";
import * as log from "../utils/logger.ts";
import { parseSummary, findSection, appendToSection, renderSummary, upsertSection } from "../domain/summary-parse.ts";
import type { CanonicalSummary } from "../domain/summary-schema.ts";

export function verifySummary(summary: string, extraction: StructuredExtraction): VerificationResult {
  const parsed = parseSummary(summary);
  const gaps: string[] = [];
  const lower = summary.toLowerCase();
  let score = 100;

  // Section presence checks now run on parsed kinds, which means `### Goal`
  // and `## Goals` both satisfy the `goal` requirement.
  const requiredSections: Array<{ kind: import("../domain/summary-schema.ts").SectionKind; label: string; penalty: number }> = [
    { kind: "goal", label: "## Goal", penalty: 5 },
    { kind: "progress", label: "## Progress", penalty: 5 },
    { kind: "critical-context", label: "## Critical Context", penalty: 3 },
  ];
  for (const req of requiredSections) {
    if (!findSection(parsed, req.kind)) {
      gaps.push("Missing section: " + req.label);
      score -= req.penalty;
    }
  }

  for (const f of extraction.modifiedFiles) {
    const pathLower = f.path.toLowerCase();
    const parts = pathLower.split("/");
    const suffixes: string[] = [];
    for (let j = 0; j < parts.length; j++) {
      suffixes.push(parts.slice(j).join("/"));
    }
    const pathMatch = suffixes.some(s => s.length > 2 && lower.includes(s));
    if (!pathMatch) {
      gaps.push("Missing modified file: " + f.path);
      score -= 5;
    }
  }

  for (const e of extraction.errors.filter(e => !e.resolved)) {
    const snippet = e.message.slice(0, 30).toLowerCase();
    if (snippet.length > 5 && !lower.includes(snippet)) {
      gaps.push("Missing error: " + e.message.slice(0, 80));
      score -= 5;
    }
  }

  for (const c of extraction.constraints.filter(c => c.confidence >= 0.8)) {
    const keywords = c.text.split(/\s+/).filter(w => w.length > 4).slice(0, 3);
    const found = keywords.some(k => lower.includes(k.toLowerCase()));
    if (!found && keywords.length > 0) {
      gaps.push("Missing constraint: " + c.text.slice(0, 100));
      score -= 3;
    }
  }

  if (extraction.mainGoal) {
    const goalWords = extraction.mainGoal.split(/\s+/).filter(w => w.length > 3).slice(0, 4);
    const goalFound = goalWords.some(w => lower.includes(w.toLowerCase()));
    if (!goalFound) { gaps.push("Main goal may be missing from summary"); score -= 10; }
  }

  const summaryFileRefs = (summary.match(/[\w.\/-]+\.[\w]+/g) ?? []).filter(
    p => p.includes("/") || p.match(/\.(ts|tsx|js|jsx|rs|py|go|java|rb|css|html|json|yaml|yml|toml|md|sh|sql)$/i)
  );
  const knownFiles = new Set([
    ...extraction.modifiedFiles.map(f => f.path.toLowerCase()),
    ...extraction.readFiles.map(f => f.toLowerCase()),
  ]);
  for (const ref of summaryFileRefs) {
    const refLower = ref.toLowerCase();
    const isKnown = [...knownFiles].some(kf => (kf.endsWith("/" + refLower) || kf === refLower || (kf.endsWith(refLower) && refLower.length > 3)));
    if (!isKnown) {
      gaps.push("Potentially fabricated file: " + ref);
      score -= 4;
    }
  }

  // Inconsistency check: a file marked Done that has an unresolved error in
  // the extraction signals stale completion claims. We pull the Progress
  // section structurally so heading-case differences don't bypass the check.
  const progressSection = findSection(parsed, "progress");
  if (progressSection) {
    const doneMatch = progressSection.body.match(/###\s*Done[\s\S]*?(?=###|$)/i);
    const doneSection = doneMatch?.[0] ?? "";
    if (doneSection) {
      for (const f of extraction.modifiedFiles) {
        const bn = f.path.split("/").pop() ?? "";
        const markedDone = doneSection.toLowerCase().includes(bn.toLowerCase());
        if (!markedDone) continue;
        const unresolved = extraction.errors.find(e => e.message.toLowerCase().includes(bn.toLowerCase()) && !e.resolved);
        if (unresolved) {
          gaps.push("Inconsistency: " + bn + " marked Done but has unresolved error");
          score -= 5;
        }
      }
    }
  }

  const highConfDecisions = extraction.decisions.filter(d => d.type === "explicit");
  if (highConfDecisions.length > 0) {
    const decisionSection = findSection(parsed, "decisions");
    const decisionBody = decisionSection?.body.toLowerCase() ?? "";
    for (const d of highConfDecisions) {
      const keywords = d.summary.split(/\s+/).filter(w => w.length > 4).slice(0, 3);
      if (keywords.length > 0 && !keywords.some(k => decisionBody.includes(k.toLowerCase()))) {
        gaps.push("Missing decision: " + d.summary.slice(0, 100));
        score -= 3;
      }
    }
  }

  // Open Loop coverage: if extraction surfaces multiple unresolved errors but
  // the summary has no dedicated open-loop section (or any unresolved-style
  // language), call out the gap structurally.
  const unresolvedCount = extraction.errors.filter(e => !e.resolved).length;
  if (unresolvedCount >= 2) {
    const hasOpenLoops = findSection(parsed, "open-loops") || lower.includes("unresolved");
    if (!hasOpenLoops) {
      gaps.push("Missing Open Loops section despite " + unresolvedCount + " unresolved errors");
      score -= 5;
    }
  }

  const finalScore = Math.max(0, score);
  return { ok: gaps.length === 0 && finalScore >= 85, gaps, score: finalScore };
}

/**
 * Deterministic patch — injects missing items directly into the summary
 * without an LLM call. All structural mutations go through the canonical
 * parse/upsert path so the resulting markdown always has the canonical
 * headings, even if the LLM produced lowercase or differently punctuated ones.
 */
export function patchDeterministic(summary: string, gaps: string[], extraction: StructuredExtraction): string {
  let canonical: CanonicalSummary = parseSummary(summary);

  const fileGaps = gaps.filter(g => g.startsWith("Missing modified file:"));
  const errorGaps = gaps.filter(g => g.startsWith("Missing error:"));
  const constraintGaps = gaps.filter(g => g.startsWith("Missing constraint:"));
  const decisionGaps = gaps.filter(g => g.startsWith("Missing decision:"));
  const sectionGaps = gaps.filter(g => g.startsWith("Missing section:"));
  const otherGaps = gaps.filter(g =>
    !g.startsWith("Missing modified file:") &&
    !g.startsWith("Missing error:") &&
    !g.startsWith("Missing constraint:") &&
    !g.startsWith("Missing decision:") &&
    !g.startsWith("Missing section:") &&
    !g.startsWith("Potentially fabricated") &&
    !g.startsWith("Inconsistency")
  );

  const ensureMissingSection = (header: string): void => {
    // Map the heading literal back to a structural kind so upsertSection can
    // produce canonical markdown regardless of what the LLM emitted before.
    if (header === "## Goal") {
      canonical = upsertSection(canonical, "goal", (extraction.mainGoal ?? "Continue the current coding task.") + "\n");
    } else if (header === "## Progress") {
      canonical = upsertSection(canonical, "progress", "### Done\n- See preceding summary.\n### In Progress\n- Continue from the latest user request.\n### Blocked\n- None recorded.\n");
    } else if (header === "## Critical Context") {
      canonical = upsertSection(canonical, "critical-context", "- None recorded.\n");
    }
  };

  for (const gap of sectionGaps) {
    ensureMissingSection(gap.replace("Missing section: ", ""));
  }

  if (fileGaps.length > 0) {
    const entries = fileGaps.map(g => "- " + g.replace("Missing modified file: ", "")).join("\n");
    canonical = appendToSection(canonical, "files-modified", entries);
  }

  if (errorGaps.length > 0) {
    const entries = errorGaps.map(g => "- " + g).join("\n");
    canonical = appendToSection(canonical, "critical-context", entries);
  }

  if (constraintGaps.length > 0) {
    const entries = constraintGaps.map(g => "- " + g).join("\n");
    canonical = appendToSection(canonical, "constraints", entries);
  }

  if (decisionGaps.length > 0) {
    const entries = decisionGaps.map(g => "- **" + g.replace("Missing decision: ", "") + "**").join("\n");
    canonical = appendToSection(canonical, "decisions", entries);
  }

  // Patching renders with canonical headings so a later verify pass cannot
  // miss a section because the original markdown used `### Goal` or `Goals:`.
  let rendered = renderSummary(canonical, { canonicalHeadings: true });
  if (otherGaps.length > 0) {
    rendered += "\n## Verification Note\n" + otherGaps.map(g => "- " + g).join("\n") + "\n";
  }
  return rendered;
}

export async function patchSummary(
  summary: string, gaps: string[],
  model: Model<Api>, auth: { apiKey: string; headers?: Record<string, string> }, signal?: AbortSignal,
): Promise<string> {
  const patchPrompt = "The summary below is missing some critical information. Add the missing items WITHOUT restructuring the summary.\n\nMissing items:\n" +
    gaps.map((g, i) => (i + 1) + ". " + g).join("\n") +
    "\n\nCurrent summary:\n" + summary +
    "\n\nReturn the COMPLETE updated summary with missing items integrated. Keep the same format.";

  try {
    const resp = await trackedComplete("patch", model, {
      systemPrompt: COMPACT_SYSTEM_PREFIX,
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: patchPrompt }], timestamp: Date.now() }],
    }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal });
    const patched = resp.content.filter((c): c is import("@earendil-works/pi-ai").TextContent => c.type === "text").map(c => c.text).join("\n").trim();
    return patched.startsWith("##") ? patched : summary;
  } catch (e) { log.debug("patchSummary LLM failed", e); return summary; }
}
