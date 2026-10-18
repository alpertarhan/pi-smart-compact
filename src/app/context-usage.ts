/**
 * Context size across our own context edits.
 *
 * Pi's getContextUsage() drops the last provider-measured usage once a `context_edit` or
 * `compaction` entry is newer than it, and falls back to a chars/4 estimate of the visible
 * messages that misses encrypted and signed reasoning. After real rewinds that estimate read
 * 14-33% below the input the provider measured on the next request. Anchoring keeps the measured
 * size and applies only the edits' estimated difference (0.3-2% from the next input there).
 */

import { calculateContextTokens, estimateTokens, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { contextMessageEntries } from "../infra/ai-messages.ts";

type Estimate = (message: Parameters<typeof estimateTokens>[0]) => number;

function estimatedTokens(entries: readonly unknown[], estimate: Estimate): number {
  // SAFETY: contextMessageEntries yields convertToLlm() output, i.e. real LLM messages.
  return contextMessageEntries(entries).reduce((sum, entry) => sum + estimate(entry.message as Parameters<Estimate>[0]), 0);
}

/** Context a finished response measured; 0 for aborted or failed responses, which Pi does not trust either. */
function measuredTokens(entry: SessionEntry): number {
  if (entry.type !== "message" || entry.message.role !== "assistant") return 0;
  const { stopReason, usage } = entry.message;
  return stopReason === "aborted" || stopReason === "error" || !usage ? 0 : calculateContextTokens(usage);
}

/**
 * Last measured usage plus the estimated change since: edits to messages it covered and messages
 * added after it. Null when Pi's own figure is already right (no edit newer than the measurement)
 * or nothing can anchor it (no measured response, or a compaction replaced the measured window).
 * The measured response may itself be edited away: a rewind removes its own call with the research.
 * Pi's own estimator measured the edits most accurately on real rewinds (the provider-calibrated
 * one overcounted removed tool output by up to 8%).
 */
export function anchoredContextTokens(branch: SessionEntry[], estimate: Estimate = estimateTokens): number | null {
  const anchor = branch.findLastIndex(entry => measuredTokens(entry) > 0);
  if (anchor < 0) return null;
  const later = branch.slice(anchor + 1);
  if (!later.some(entry => entry.type === "context_edit") || later.some(entry => entry.type === "compaction")) return null;
  // What the measured request carried versus what the next one carries.
  const then = estimatedTokens(branch.slice(0, anchor + 1), estimate);
  const now = estimatedTokens(branch, estimate);
  return Math.max(0, Math.round(measuredTokens(branch[anchor]) + now - then));
}

type UsageContext = Partial<Pick<ExtensionContext, "getContextUsage" | "sessionManager">>;

/** Whether a context edit is newer than the last measured response, walking back only that far. */
function editedSinceMeasurement(sessionManager: ExtensionContext["sessionManager"]): boolean {
  for (let entry = sessionManager.getLeafEntry(); entry; entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined) {
    if (entry.type === "context_edit") return true;
    if (entry.type === "compaction") return false;
    if (measuredTokens(entry) > 0) return false;
  }
  return false;
}

/** `ctx.getContextUsage()`, anchored across context edits; Pi's value whenever anchoring cannot apply. */
export function contextUsage(ctx: UsageContext): ReturnType<ExtensionContext["getContextUsage"]> {
  const usage = ctx.getContextUsage?.();
  if (!usage || !ctx.sessionManager) return usage;
  try {
    // The common case (no edit since the last response) never copies the branch.
    if (!editedSinceMeasurement(ctx.sessionManager)) return usage;
    const anchored = anchoredContextTokens(ctx.sessionManager.getBranch());
    if (anchored === null) return usage;
    // Pi's message estimate stays the floor: usage that never covered visible messages cannot lower it.
    const tokens = Math.max(anchored, usage.tokens ?? 0);
    return { ...usage, tokens, percent: usage.contextWindow > 0 ? tokens / usage.contextWindow * 100 : usage.percent };
  } catch {
    // A diagnostic estimate must never take Pi's own figure away.
    return usage;
  }
}
