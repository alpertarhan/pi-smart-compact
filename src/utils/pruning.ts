/**
 * Pre-compaction redundancy pruning — deterministic, zero LLM cost.
 * Reduces compaction input by collapsing redundant message sequences.
 */

import type { LlmMessage } from "../types.ts";
import { isToolCallBlock } from "../utils/type-guards.ts";
import { extractText, buildToolCallIndex, type ToolCallIndex } from "./extraction.ts";
import { estimateTokens } from "./tokens.ts";

export interface PruningResult {
  messages: LlmMessage[];
  /** Original input indexes retained in `messages`; same order as `messages`. */
  keptIndices: number[];
  prunedCount: number;
  prunedTokenSaving: number;
  reasons: Array<{ count: number; reason: string }>;
  /**
   * ToolCallIndex computed during pruning, keyed by **input** (unpruned)
   * message offsets. Downstream consumers that work against the pruned
   * message list (e.g. `extractStructured`) MUST NOT reuse this map verbatim
   * because `msgIndex` values refer to the pre-prune positions. It is still
   * useful for callers that want a quick `toolCallId → {name, arguments}`
   * lookup over the original list.
   */
  toolCallIndex: ToolCallIndex;
}

// Pattern for agent acknowledgment messages with no information
const ACK_RE = /^(?:I'?ll |let me |sure|ok[,.]?|got it|i understand|i see|now i|next,? i|alright|great|perfect|sounds good|i can|i will|checking|looking|right away)/i;

// pi-toolkit auto-context status messages injected every turn
const PI_STATUS_RE = /^\[pi-auto-context\]/;

// Maximum chars to keep from a tool result output
import { MAX_TOOL_OUTPUT_CHARS } from "../constants.ts";

/**
 * Detect and collapse redundant message sequences.
 *
 * @param msgs   Input message list (unpruned).
 * @param tcIdx  Optional pre-computed tool-call index. When the caller has
 *               already built the index (e.g. orchestrator caching it on the
 *               RunContext), passing it here avoids a second O(n) walk over
 *               every assistant message.
 */
export function pruneRedundant(msgs: LlmMessage[], precomputedTcIdx?: ToolCallIndex): PruningResult {
  const ensuredIndex = precomputedTcIdx ?? buildToolCallIndex(msgs);
  if (msgs.length < 5) {
    return {
      messages: msgs,
      keptIndices: msgs.map((_, i) => i),
      prunedCount: 0,
      prunedTokenSaving: 0,
      reasons: [],
      toolCallIndex: ensuredIndex,
    };
  }

  // Reuse the index from above; the original implementation called
  // buildToolCallIndex() a second time here, which doubled the cost on every
  // compaction.
  const tcIdx = ensuredIndex;
  const keep = new Set<number>(msgs.map((_, i) => i));
  const reasonMap = new Map<string, number>();

  // ── 1. Duplicate file reads: keep only last read per file ──
  const readIndices = new Map<string, number[]>(); // filepath → [indices of toolResult]
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "toolResult") continue;
    const tc = tcIdx.get(msgs[i].toolCallId ?? "");
    if (!tc || tc.name !== "read") continue;
    const fp = (tc?.arguments?.path ?? tc?.arguments?.file_path) as string | undefined;
    if (!fp) continue;
    const arr = readIndices.get(fp) ?? [];
    arr.push(i);
    readIndices.set(fp, arr);
  }
  for (const [fp, indices] of readIndices) {
    // Keep last read, prune the rest
    for (let j = 0; j < indices.length - 1; j++) {
      keep.delete(indices[j]);
      // Also prune the corresponding assistant tool call message
      const tc = tcIdx.get(msgs[indices[j]].toolCallId ?? "");
      if (tc) keep.delete(tc.msgIndex);
    }
    if (indices.length > 1) {
      reasonMap.set("Duplicate file reads", (reasonMap.get("Duplicate file reads") ?? 0) + indices.length - 1);
    }
  }

  // ── 2. Failed → retry → success chains: keep first failure + success only ──
  const failedToolResults: Array<{ index: number; tool: string; tcIndex: number }> = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "toolResult" || !msgs[i].isError) continue;
    const tc = tcIdx.get(msgs[i].toolCallId ?? "");
    failedToolResults.push({ index: i, tool: tc?.name ?? "unknown", tcIndex: tc?.msgIndex ?? -1 });
  }
  // Group consecutive failures of the same tool
  let i = 0;
  while (i < failedToolResults.length) {
    const tool = failedToolResults[i].tool;
    let j = i + 1;
    while (j < failedToolResults.length && failedToolResults[j].tool === tool && failedToolResults[j].index - failedToolResults[j - 1].index < 10) {
      j++;
    }
    // If 3+ consecutive failures of same tool, keep only first and last
    if (j - i >= 3) {
      for (let k = i + 1; k < j - 1; k++) {
        keep.delete(failedToolResults[k].index);
        if (failedToolResults[k].tcIndex >= 0) keep.delete(failedToolResults[k].tcIndex);
      }
      reasonMap.set("Collapsed error chains", (reasonMap.get("Collapsed error chains") ?? 0) + (j - i - 2));
    }
    i = j;
  }

  // ── 3. Agent acknowledgment messages: no informational content ──
  for (let idx = 0; idx < msgs.length; idx++) {
    if (msgs[idx].role !== "assistant") continue;
    const rawBlocks = msgs[idx].content;
    const blocks: unknown[] = Array.isArray(rawBlocks) ? rawBlocks : [];
    // Only consider messages that are pure text with no tool calls
    const hasToolCall = blocks.some((b: unknown) => isToolCallBlock(b));
    if (hasToolCall) continue;
    const text = extractText(msgs[idx].content).trim();
    if (text.length > 0 && text.length < 100 && ACK_RE.test(text)) {
      keep.delete(idx);
      reasonMap.set("Agent acknowledgments", (reasonMap.get("Agent acknowledgments") ?? 0) + 1);
    }
  }

  // ── 3b. pi-toolkit status messages: keep only the latest ──
  const statusIndices: number[] = [];
  for (let idx = 0; idx < msgs.length; idx++) {
    const text = extractText(msgs[idx].content);
    if (PI_STATUS_RE.test(text)) {
      statusIndices.push(idx);
    }
  }
  for (let i = 0; i < statusIndices.length - 1; i++) {
    keep.delete(statusIndices[i]);
    reasonMap.set("pi-auto-context status", (reasonMap.get("pi-auto-context status") ?? 0) + 1);
  }

  // ── 4. Truncate long tool result outputs ──
  // (Applied as content modification, not message removal)
  const kept = msgs.map((m, idx) => {
    if (!keep.has(idx)) return null;
    if (m.role !== "toolResult") return m;
    const text = extractText(m.content);
    if (text.length > MAX_TOOL_OUTPUT_CHARS) {
      // Keep first 400 chars + last 400 chars with truncation marker
      const head = text.slice(0, 400);
      const tail = text.slice(-400);
      const truncated = head + "\n... [truncated " + (text.length - MAX_TOOL_OUTPUT_CHARS) + " chars] ...\n" + tail;
      return { ...m, content: [{ type: "text" as const, text: truncated }] };
    }
    return m;
  });

  // Build final message list, preserving order, and remember original input indexes.
  const keptIndices: number[] = [];
  const finalMsgs: LlmMessage[] = [];
  for (let idx = 0; idx < kept.length; idx++) {
    const m = kept[idx];
    if (m === null) continue;
    keptIndices.push(idx);
    finalMsgs.push(m);
  }
  const prunedCount = msgs.length - finalMsgs.length;

  // Estimate token saving
  const originalTokens = estimateTokens(msgs.map(m => extractText(m.content)).join(""));
  const prunedTokens = estimateTokens(finalMsgs.map(m => extractText(m.content)).join(""));

  const reasons = [...reasonMap.entries()].map(([reason, count]) => ({ count, reason }));

  return {
    messages: finalMsgs,
    keptIndices,
    prunedCount,
    prunedTokenSaving: Math.max(0, originalTokens - prunedTokens),
    reasons,
    toolCallIndex: tcIdx,
  };
}
