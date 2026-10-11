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
 * Best-effort bookkeeping: without a leaf, nothing is written and nothing
 * throws — callers run this inside post-apply bookkeeping that must not fail
 * the commit path. The anchor targets the post-compaction leaf so pivots land
 * on the summary boundary; `synthetic: true` lets list views keep only the
 * newest few visible. Value = recall surface + pivot target.
 *
 * Compaction summaries can repeat their first line, so a name collision gets
 * a numbered suffix instead of dropping the anchor: the second compaction
 * keeps its recall surface.
 */
export function buildSummaryAnchor(sm: SummaryAnchorSession, details: { summary: string }): SummaryAnchorEntry | null {
  const targetId = sm.getLeafId();
  if (!targetId) return null;
  const taken = new Set(sm.getEntries().flatMap(entry => {
    const anchor = anchorFromEntry(entry);
    return anchor ? [anchor.name] : [];
  }));
  // Reserve room for the collision suffix (" · N" fits in 4 characters).
  const base = ("compaction: " + firstLine(details.summary)).replace(SCRUB_RE, " ").trim().slice(0, ANCHOR_NAME_LIMIT - 4);
  if (!base) return null;
  let name = base;
  for (let attempt = 2; taken.has(name) && attempt < 10; attempt++) name = `${base} · ${attempt}`;
  if (taken.has(name)) return null;
  const summary = details.summary.slice(0, ANCHOR_SUMMARY_LIMIT);
  const anchor: AnchorState = { name, summary, targetId, synthetic: true };
  return { customType: ANCHOR_CUSTOM_TYPE, content: `Anchor: ${name}\n\n${summary}`, display: false, details: { anchor } };
}
