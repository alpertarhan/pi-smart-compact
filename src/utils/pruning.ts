/**
 * Pre-compaction redundancy pruning — deterministic, zero LLM cost.
 * Reduces compaction input by collapsing redundant message sequences.
 */

import type { LlmMessage } from "../types.ts";
import { isToolCallBlock } from "../utils/type-guards.ts";
import { commandFailureEvidence, extractText, buildToolCallIndex, nestedToolCallId, type ToolCallIndex } from "./extraction.ts";
import { estimateTokens } from "./tokens.ts";

export interface PruningResult {
  messages: LlmMessage[];
  /** Original input indexes retained in `messages`; same order as `messages`. */
  keptIndices: number[];
  prunedCount: number;
  prunedTokenSaving: number;
  reasons: Array<{ count: number; reason: string }>;
}


// pi-toolkit auto-context status messages injected every turn
const PI_STATUS_RE = /^\[pi-auto-context\]/;

// Maximum chars to keep from a tool result output
import { MAX_TOOL_OUTPUT_CHARS, LIKELY_ERROR_RE } from "../constants.ts";
import { classifyToolOperation, normalizeToolName } from "../domain/tool-semantics.ts";

function stableArguments(args: Record<string, unknown>): string {
  return JSON.stringify(args, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

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
    };
  }

  // Reuse the index from above; the original implementation called
  // buildToolCallIndex() a second time here, which doubled the cost on every
  // compaction.
  const tcIdx = ensuredIndex;
  const keep = new Set<number>(msgs.map((_, i) => i));
  const removedToolCallIds = new Set<string>();
  const reasonMap = new Map<string, number>();

  // ── 1. Identical idempotent access calls within one mutation epoch ──
  // A successful mutation, delete, or opaque execute call invalidates every
  // prior access result. Reads on opposite sides of a write are observations
  // of different states and must never be deduplicated.
  const accessIndices = new Map<string, number[]>();
  let mutationEpoch = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "toolResult") continue;
    const tc = tcIdx.get(msgs[i].toolCallId ?? "");
    if (!tc) continue;
    const operation = classifyToolOperation(tc.arguments, tc.name);
    if (operation === "mutate" || operation === "delete" || operation === "execute") {
      mutationEpoch++;
      continue;
    }
    if (msgs[i].isError || (operation !== "read" && operation !== "search" && operation !== "list")) continue;
    const key = mutationEpoch + "\0" + normalizeToolName(tc.name) + "\0" + stableArguments(tc.arguments);
    const indices = accessIndices.get(key) ?? [];
    indices.push(i);
    accessIndices.set(key, indices);
  }
  for (const indices of accessIndices.values()) {
    for (let j = 0; j < indices.length - 1; j++) {
      const toolCallId = msgs[indices[j]].toolCallId ?? "";
      keep.delete(indices[j]);
      if (tcIdx.has(toolCallId)) removedToolCallIds.add(toolCallId);
    }
    if (indices.length > 1) {
      reasonMap.set("Duplicate file reads", (reasonMap.get("Duplicate file reads") ?? 0) + indices.length - 1);
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
            const id = nestedToolCallId(block.id, idx, toolIndex, tool.id);
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
    if (keptMessage.role === "toolResult" && text.length > MAX_TOOL_OUTPUT_CHARS) {
      const call = ensuredIndex.get(keptMessage.toolCallId ?? "");
      const executionFailure = Boolean(call
        && classifyToolOperation(call.arguments, call.name) === "execute"
        && (/Command exited with code [1-9]\d*\s*$/i.test(text) || LIKELY_ERROR_RE.test(text)));
      let truncated: string;
      if (keptMessage.isError || executionFailure) {
        const edgeBudget = Math.floor(MAX_TOOL_OUTPUT_CHARS / 4);
        const evidenceBudget = MAX_TOOL_OUTPUT_CHARS - edgeBudget * 2;
        const evidence = commandFailureEvidence(text, evidenceBudget);
        truncated = text.slice(0, edgeBudget)
          + "\n... [error evidence] ...\n" + evidence
          + "\n... [truncated " + (text.length - MAX_TOOL_OUTPUT_CHARS) + " chars] ...\n"
          + text.slice(-edgeBudget);
      } else {
        const head = text.slice(0, half);
        const tail = text.slice(-half);
        truncated = head + "\n... [truncated " + (text.length - MAX_TOOL_OUTPUT_CHARS) + " chars] ...\n" + tail;
      }
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
  };
}
