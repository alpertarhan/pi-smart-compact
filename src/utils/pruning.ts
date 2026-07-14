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
import { MAX_TOOL_OUTPUT_CHARS, LIKELY_ERROR_RE, ERROR_SCAN_MAX_LEN } from "../constants.ts";
import { classifyTool, extractToolPath } from "../domain/tool-semantics.ts";

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
  const removedToolCallIds = new Set<string>();
  const reasonMap = new Map<string, number>();

  // ── 1. Duplicate file reads: keep only last read per file ──
  const readIndices = new Map<string, number[]>(); // filepath → [indices of toolResult]
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "toolResult") continue;
    const tc = tcIdx.get(msgs[i].toolCallId ?? "");
    // Dedup lookups by argument shape (read/grep/find/ls…), not tool name —
    // same name-agnostic rule as the other consumers. See domain/tool-semantics.ts.
    if (!tc || classifyTool(tc.arguments) !== "accesses") continue;
    const fp = extractToolPath(tc.arguments);
    if (!fp) continue;
    const arr = readIndices.get(fp) ?? [];
    arr.push(i);
    readIndices.set(fp, arr);
  }
  for (const [fp, indices] of readIndices) {
    // Keep last read, prune the rest
    for (let j = 0; j < indices.length - 1; j++) {
      const toolCallId = msgs[indices[j]].toolCallId ?? "";
      keep.delete(indices[j]);
      if (tcIdx.has(toolCallId)) removedToolCallIds.add(toolCallId);
    }
    if (indices.length > 1) {
      reasonMap.set("Duplicate file reads", (reasonMap.get("Duplicate file reads") ?? 0) + indices.length - 1);
    }
  }

  // ── 2. Failed → retry → success chains: keep first failure + success only ──
  const failedToolResults: Array<{ index: number; tool: string; toolCallId: string }> = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "toolResult" || !msgs[i].isError) continue;
    const toolCallId = msgs[i].toolCallId ?? "";
    const tc = tcIdx.get(toolCallId);
    failedToolResults.push({ index: i, tool: tc?.name ?? "unknown", toolCallId });
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
        if (tcIdx.has(failedToolResults[k].toolCallId)) removedToolCallIds.add(failedToolResults[k].toolCallId);
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

  // ── 4. Truncate long tool result outputs + build final list in one pass ──
  //
  // The previous implementation materialized a `kept` array, then walked
  // the original `msgs` again to build the final list, then walked both
  // arrays a third+fourth time inside two `estimateTokens(map+join)` calls
  // just to compute the saving. On 5k-message sessions that's ~40-60ms of
  // pure overhead. We fold all of it into a single forward pass.
  //
  // Important: this is not just a perf rewrite — it also FIXES a latent
  // accuracy bug. `estimateTokens` applies a JSON-shape penalty only when
  // the *first* character of the input looks like JSON (`{` / `[`). With
  // `map(...).join("")` the global string almost never starts with JSON,
  // so the penalty fired for at most one of N messages. Estimating per
  // message means JSON-heavy tool outputs are now counted accurately, and
  // `prunedTokenSaving` reflects the true token reduction the pruning
  // achieved. The trade-off is N calls to `estimateTokens` instead of 2,
  // which is still net cheaper because each call sees a much smaller
  // string and we no longer build a multi-MB concatenation.
  const keptIndices: number[] = [];
  const finalMsgs: LlmMessage[] = [];
  let originalTokens = 0;
  let prunedTokens = 0;
  const half = Math.floor(MAX_TOOL_OUTPUT_CHARS / 2);

  for (let idx = 0; idx < msgs.length; idx++) {
    const m = msgs[idx];
    const originalText = extractText(m.content);
    // Skip empty messages: `estimateTokens("")` still runs regex/Math.ceil,
    // which is wasted work in long sessions where many entries are pure
    // tool-call wrappers (no text payload).
    if (originalText.length > 0) originalTokens += estimateTokens(originalText);
    if (!keep.has(idx)) continue;

    // A single assistant message may carry multiple independent tool calls.
    // Remove only the redundant call, never the whole message: deleting the
    // wrapper would also erase unrelated writes/edits and make verification
    // blind to facts that disappeared before extraction.
    let keptMessage = m;
    if (m.role === "assistant" && removedToolCallIds.size > 0 && Array.isArray(m.content)) {
      let changed = false;
      const content: unknown[] = [];
      for (const block of m.content) {
        if (!isToolCallBlock(block)) {
          content.push(block);
          continue;
        }
        if (block.name === "multi_tool_use.parallel" && Array.isArray(block.arguments?.tool_uses)) {
          const tools = block.arguments.tool_uses as Record<string, unknown>[];
          const retained = tools.filter((tool, toolIndex) => {
            const id = typeof tool.id === "string"
              ? tool.id
              : block.id ? block.id + "_" + toolIndex : "mtu_" + idx + "_" + toolIndex;
            return !removedToolCallIds.has(id);
          });
          if (retained.length !== tools.length) changed = true;
          if (retained.length > 0) {
            content.push(retained.length === tools.length
              ? block
              : { ...block, arguments: { ...block.arguments, tool_uses: retained } });
          }
          continue;
        }
        if (block.id && removedToolCallIds.has(block.id)) {
          changed = true;
          continue;
        }
        content.push(block);
      }
      if (changed) {
        if (content.length === 0) continue;
        keptMessage = { ...m, content };
      }
    }

    const text = extractText(keptMessage.content);
    // Don't truncate tool outputs catalogErrors would actually scan for errors
    // (short enough to be scanned + containing an error keyword) — truncation
    // can drop a mid-output error keyword and hide a real error from extraction.
    const protectFromTruncation = keptMessage.role === "toolResult"
      && text.length > MAX_TOOL_OUTPUT_CHARS
      && text.length < ERROR_SCAN_MAX_LEN
      && LIKELY_ERROR_RE.test(text);
    if (keptMessage.role === "toolResult" && text.length > MAX_TOOL_OUTPUT_CHARS && !protectFromTruncation) {
      // Split the budget evenly between head and tail. Derived from
      // MAX_TOOL_OUTPUT_CHARS so future bumps to the constant don't
      // silently leave the slice sizes out of date.
      const head = text.slice(0, half);
      const tail = text.slice(-half);
      const truncated = head + "\n... [truncated " + (text.length - MAX_TOOL_OUTPUT_CHARS) + " chars] ...\n" + tail;
      finalMsgs.push({ ...keptMessage, content: [{ type: "text" as const, text: truncated }] });
      prunedTokens += estimateTokens(truncated);
    } else {
      finalMsgs.push(keptMessage);
      if (text.length > 0) prunedTokens += estimateTokens(text);
    }
    keptIndices.push(idx);
  }

  const prunedCount = msgs.length - finalMsgs.length;

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
