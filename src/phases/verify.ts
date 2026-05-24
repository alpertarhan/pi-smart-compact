/**
 * Phase 4: Verification + Quality Score.
 */

import type { Model, Api } from "@earendil-works/pi-ai";
import type { StructuredExtraction, VerificationResult, CacheAwareOptions } from "../types.ts";
import { COMPACT_SYSTEM_PREFIX } from "../constants.ts";
import { trackedComplete } from "../utils/cache.ts";
import * as log from "../utils/logger.ts";

export function verifySummary(summary: string, extraction: StructuredExtraction): VerificationResult {
  const gaps: string[] = [];
  const lower = summary.toLowerCase();
  let score = 100;

  for (const f of extraction.modifiedFiles) {
    const pathLower = f.path.toLowerCase();
    // Build path suffix array: "src/index.ts", "index.ts", "index"
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

  if (!lower.includes("## goal")) { gaps.push("Missing section: ## Goal"); score -= 5; }
  if (!lower.includes("## progress")) { gaps.push("Missing section: ## Progress"); score -= 5; }
  if (!lower.includes("## critical context")) { gaps.push("Missing section: ## Critical Context"); score -= 3; }

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

  const errorFiles = new Set(extraction.errors.map(e => e.message));
  if (errorFiles.size > 0) {
    const doneSection = (summary.match(/### Done[\s\S]*?(?=###|$)/i) ?? [""])[0];
    if (doneSection) {
      for (const f of extraction.modifiedFiles) {
        const bn = f.path.split("/").pop() ?? "";
        const hasError = [...errorFiles].some(e => e.toLowerCase().includes(bn.toLowerCase()));
        const markedDone = doneSection.toLowerCase().includes(bn.toLowerCase());
        if (hasError && markedDone) {
          const unresolved = extraction.errors.find(e => e.message.toLowerCase().includes(bn.toLowerCase()) && !e.resolved);
          if (unresolved) {
            gaps.push("Inconsistency: " + bn + " marked Done but has unresolved error");
            score -= 5;
          }
        }
      }
    }
  }

  const highConfDecisions = extraction.decisions.filter(d => d.type === "explicit");
  if (highConfDecisions.length > 0) {
    const decisionSection = (summary.match(/## Key Decisions[\s\S]*?(?=##|$)/i) ?? [""])[0];
    for (const d of highConfDecisions) {
      const keywords = d.summary.split(/\s+/).filter(w => w.length > 4).slice(0, 3);
      if (keywords.length > 0 && !keywords.some(k => decisionSection.toLowerCase().includes(k.toLowerCase()))) {
        gaps.push("Missing decision: " + d.summary.slice(0, 100));
        score -= 3;
      }
    }
  }

  // ── Open Loop coverage ──
  if (extraction.errors.some(e => !e.resolved)) {
    const hasOpenLoops = lower.includes("## open loops") || lower.includes("unresolved") || lower.includes("open loop");
    if (!hasOpenLoops && extraction.errors.filter(e => !e.resolved).length >= 2) {
      gaps.push("Missing Open Loops section despite " + extraction.errors.filter(e => !e.resolved).length + " unresolved errors");
      score -= 5;
    }
  }

  const finalScore = Math.max(0, score);
  return { ok: gaps.length === 0 && finalScore >= 85, gaps, score: finalScore };
}

/**
 * Deterministic patch — injects missing items directly into the summary
 * without an LLM call. Appends gaps to the relevant sections.
 */
export function patchDeterministic(summary: string, gaps: string[], extraction: StructuredExtraction): string {
  let patched = summary;
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

  const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Helper: find section header and return insertion point. If the LLM used a
  // non-standard format and the section is absent, create the canonical section
  // deterministically instead of relying on a second LLM patch to repair it.
  const findOrCreateSectionInsert = (header: string, defaultBody = ""): number => {
    const re = new RegExp(escapeRe(header) + "\\s*\\n", "i");
    const m = patched.match(re);
    if (m?.index != null) return m.index + m[0].length;
    const prefix = patched.endsWith("\n") ? (patched.endsWith("\n\n") ? "" : "\n") : "\n\n";
    patched += prefix + header + "\n" + (defaultBody ? defaultBody.replace(/\n?$/, "\n") : "");
    return patched.length;
  };

  const ensureMissingSection = (header: string): void => {
    if (header === "## Goal") {
      findOrCreateSectionInsert(header, (extraction.mainGoal ?? "Continue the current coding task.") + "\n");
    } else if (header === "## Progress") {
      findOrCreateSectionInsert(header, "### Done\n- See preceding summary.\n### In Progress\n- Continue from the latest user request.\n### Blocked\n- None recorded.\n");
    } else if (header === "## Critical Context") {
      findOrCreateSectionInsert(header, "- None recorded.\n");
    } else {
      findOrCreateSectionInsert(header);
    }
  };

  for (const gap of sectionGaps) {
    ensureMissingSection(gap.replace("Missing section: ", ""));
  }

  // Inject missing files into Files Modified section
  if (fileGaps.length > 0) {
    const insertPos = findOrCreateSectionInsert("## Files Modified");
    const entries = fileGaps.map(g => "- " + g.replace("Missing modified file: ", "")).join("\n") + "\n";
    patched = patched.slice(0, insertPos) + entries + patched.slice(insertPos);
  }

  // Inject missing errors into Critical Context section
  if (errorGaps.length > 0) {
    const insertPos = findOrCreateSectionInsert("## Critical Context");
    const entries = errorGaps.map(g => "- " + g).join("\n") + "\n";
    patched = patched.slice(0, insertPos) + entries + patched.slice(insertPos);
  }

  // Inject missing constraints into Constraints section
  if (constraintGaps.length > 0) {
    const insertPos = findOrCreateSectionInsert("## Constraints & Preferences");
    const entries = constraintGaps.map(g => "- " + g).join("\n") + "\n";
    patched = patched.slice(0, insertPos) + entries + patched.slice(insertPos);
  }

  // Inject missing decisions into Key Decisions section
  if (decisionGaps.length > 0) {
    const insertPos = findOrCreateSectionInsert("## Key Decisions");
    const entries = decisionGaps.map(g => "- **" + g.replace("Missing decision: ", "") + "**").join("\n") + "\n";
    patched = patched.slice(0, insertPos) + entries + patched.slice(insertPos);
  }

  // Append any remaining gaps as a verification note
  if (otherGaps.length > 0) {
    patched += "\n## Verification Note\n" + otherGaps.map(g => "- " + g).join("\n");
  }

  return patched;
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
