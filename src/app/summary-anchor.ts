/** Summary pseudo-anchor (C): the compaction summary as a recall surface and pivot target. */

import type { AnchorState } from "./navigation-types.ts";
import { ANCHOR_CUSTOM_TYPE, anchorFromEntry } from "./navigation-data.ts";

const ANCHOR_NAME_LIMIT = 120;
const ANCHOR_SUMMARY_LIMIT = 12_000;
const SCRUB_RE = /[\x00-\x1f\x7f]/g;

interface SummaryAnchorSession {
  getLeafId(): string | null;
  getEntries(): unknown[];
}

export interface SummaryAnchorEntry {
  customType: typeof ANCHOR_CUSTOM_TYPE;
  content: string;
  display: boolean;
  details: { anchor: AnchorState };
}

function firstLine(summary: string): string {
  return summary.split("\n").find(line => line.trim()) ?? "Compaction summary";
}

/**
 * Build a synthetic anchor for a committed compaction summary.
 *
 * Best-effort bookkeeping: without a leaf, or when the derived name already
 * exists on the branch (replay/dupe), null is returned and nothing throws —
 * callers run this inside post-apply bookkeeping that must not fail the
 * commit path. The anchor targets the post-compaction leaf so pivots land on
 * the summary boundary; `synthetic: true` lets list views keep only the
 * newest few visible. Value = recall surface + pivot target.
 */
export function buildSummaryAnchor(sm: SummaryAnchorSession, details: { summary: string }): SummaryAnchorEntry | null {
  const targetId = sm.getLeafId();
  if (!targetId) return null;
  const name = ("compaction: " + firstLine(details.summary)).replace(SCRUB_RE, " ").trim().slice(0, ANCHOR_NAME_LIMIT);
  if (!name) return null;
  const taken = new Set(sm.getEntries().flatMap(entry => {
    const anchor = anchorFromEntry(entry);
    return anchor ? [anchor.name] : [];
  }));
  if (taken.has(name)) return null;
  const summary = details.summary.slice(0, ANCHOR_SUMMARY_LIMIT);
  const anchor: AnchorState = { name, summary, targetId, synthetic: true };
  return { customType: ANCHOR_CUSTOM_TYPE, content: `Anchor: ${name}\n\n${summary}`, display: false, details: { anchor } };
}

/** Convenience for callers holding a writable session manager. */
export function appendSummaryAnchor(sm: SummaryAnchorSession & { appendCustomMessageEntry?: Function }, details: { summary: string }): void {
  const entry = buildSummaryAnchor(sm, details);
  if (!entry) return;
  const append = sm.appendCustomMessageEntry as
    | ((customType: string, content: string, display: boolean, details: { anchor: AnchorState }) => unknown)
    | undefined;
  if (append) {
    append.call(sm, entry.customType, entry.content, entry.display, entry.details);
  }
}
