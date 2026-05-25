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

export function isValidSmartCompactDetails(d: unknown): d is SmartCompactDetails {
  if (!d || typeof d !== "object") return false;
  const r = d as Record<string, unknown>;
  return (
    Array.isArray(r.modifiedFiles) && (r.modifiedFiles as unknown[]).every(x => typeof x === "string") &&
    Array.isArray(r.readFiles) && (r.readFiles as unknown[]).every(x => typeof x === "string") &&
    Array.isArray(r.topics) && (r.topics as unknown[]).every(x => typeof x === "string")
  );
}

/**
 * Normalize an arbitrary details-ish object so it is safe to feed into damage
 * detection regardless of provenance. Anything that fails the validator gets
 * coerced to an empty-but-typed shape; the caller can then skip work without
 * crashing.
 */
export function sanitizeSmartCompactDetails(d: unknown): SmartCompactDetails | null {
  if (isValidSmartCompactDetails(d)) return d;
  return null;
}
