/**
 * Type guards and utility functions for content block inspection.
 * Extracted from types.ts to keep type definitions pure.
 */

/** Type guard for text content blocks */
export function isTextBlock(c: unknown): c is { type: "text"; text: string } {
  return typeof c === "object" && c !== null && (c as { type?: string }).type === "text" && typeof (c as { text?: unknown }).text === "string";
}

/** Type guard for tool call content blocks */
export function isToolCallBlock(c: unknown): c is { type: "toolCall"; id?: string; name: string; arguments: Record<string, unknown> } {
  return typeof c === "object" && c !== null && (c as { type?: string }).type === "toolCall" && typeof (c as { name?: unknown }).name === "string";
}

/** Get tool call names from unknown content */
export function getToolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isToolCallBlock).map(b => b.name);
}

/** Filter tool call blocks from unknown content */
export function filterToolCalls(content: unknown): Array<{ type: "toolCall"; id?: string; name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  return content.filter(isToolCallBlock);
}

/**
 * Best-effort runtime validator for `SmartCompactDetails` payloads that we
 * read back from compaction entries on the branch.
 *
 * The branch can contain compactions written by:
 *  - an older version of this extension (different shape),
 *  - a completely different compaction extension (arbitrary shape),
 *  - a corrupted session file.
 *
 * Damage detection passes these straight to `new Set([...])`, so a `null` or a
 * non-array `modifiedFiles` would crash the post-success path. We narrow the
 * shape just enough for `detectDamage` and refuse anything that fails.
 */
import type { SmartCompactDetails } from "../types.ts";

/**
 * Field validators. We deliberately accept anything reasonable rather than
 * strict-checking every field so that older v7.x entries with slightly
 * different shapes still pass — the goal is "safe to feed into
 * `detectDamage` and the dashboard", not "perfectly matches the current
 * TypeScript interface".
 */
const KNOWN_METHODS = new Set(["eesv", "single-pass", "heuristic"]);
const KNOWN_PROFILES = new Set(["light", "balanced", "aggressive"]);

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === "string");
}

export function isValidSmartCompactDetails(d: unknown): d is SmartCompactDetails {
  if (!d || typeof d !== "object") return false;
  const r = d as Record<string, unknown>;

  // Required array fields: these are the ones `detectDamage` iterates so a
  // missing/non-array value here is an immediate runtime crash risk.
  if (!isStringArray(r.modifiedFiles)) return false;
  if (!isStringArray(r.readFiles)) return false;
  if (!isStringArray(r.topics)) return false;

  // Required enum fields with a narrow set of valid values. detectDamage and
  // the dashboard both branch on these; an unexpected string is preferable
  // to `undefined.toLowerCase()` somewhere downstream.
  if (typeof r.method !== "string" || !KNOWN_METHODS.has(r.method)) return false;
  if (typeof r.profile !== "string" || !KNOWN_PROFILES.has(r.profile)) return false;

  // Required numeric fields with a sane lower bound. We coerce silently if
  // they're missing on legacy entries (handled in `sanitizeSmartCompactDetails`).
  if (typeof r.qualityScore !== "number" || !Number.isFinite(r.qualityScore)) return false;
  if (typeof r.totalMessages !== "number" || !Number.isFinite(r.totalMessages)) return false;

  // Optional but commonly accessed fields. We don't reject when missing
  // (legacy entries omit them) but we do reject if present-and-wrong-type.
  if (r.gaps !== undefined && !isStringArray(r.gaps)) return false;
  if (r.verified !== undefined && typeof r.verified !== "boolean") return false;
  if (r.backupPath !== undefined && r.backupPath !== null && typeof r.backupPath !== "string") return false;

  return true;
}

/**
 * Normalize an arbitrary details-ish object so it is safe to feed into damage
 * detection regardless of provenance. Anything that fails the validator gets
 * coerced to an empty-but-typed shape; the caller can then skip work without
 * crashing.
 */
export function sanitizeSmartCompactDetails(d: unknown): SmartCompactDetails | null {
  if (isValidSmartCompactDetails(d)) return d;

  // Best-effort recovery: if the object has the *array* fields that
  // `detectDamage` actually iterates, synthesize the remaining required
  // fields with safe defaults. Anything that's still wrong gets filtered
  // out one level up by the validator on the returned value.
  if (!d || typeof d !== "object") return null;
  const r = d as Record<string, unknown>;
  if (!isStringArray(r.modifiedFiles) || !isStringArray(r.readFiles) || !isStringArray(r.topics)) return null;

  const repaired: SmartCompactDetails = {
    method: KNOWN_METHODS.has(r.method as string) ? (r.method as SmartCompactDetails["method"]) : "heuristic",
    chunkCount: typeof r.chunkCount === "number" ? r.chunkCount : 0,
    topics: r.topics,
    readFiles: r.readFiles,
    modifiedFiles: r.modifiedFiles,
    totalMessages: typeof r.totalMessages === "number" ? r.totalMessages : 0,
    totalTokensSummarized: typeof r.totalTokensSummarized === "number" ? r.totalTokensSummarized : 0,
    llmCalls: typeof r.llmCalls === "number" ? r.llmCalls : 0,
    profile: KNOWN_PROFILES.has(r.profile as string) ? (r.profile as SmartCompactDetails["profile"]) : "balanced",
    backupPath: typeof r.backupPath === "string" ? r.backupPath : null,
    tokensSaved: typeof r.tokensSaved === "number" ? r.tokensSaved : 0,
    verified: typeof r.verified === "boolean" ? r.verified : false,
    gaps: isStringArray(r.gaps) ? r.gaps : [],
    explorationRounds: typeof r.explorationRounds === "number" ? r.explorationRounds : 0,
    explorationBoundaries: typeof r.explorationBoundaries === "number" ? r.explorationBoundaries : 0,
    model: typeof r.model === "string" ? r.model : "unknown",
    qualityScore: typeof r.qualityScore === "number" ? r.qualityScore : 0,
    tokensBefore: typeof r.tokensBefore === "number" ? r.tokensBefore : 0,
  };
  return isValidSmartCompactDetails(repaired) ? repaired : null;
}
