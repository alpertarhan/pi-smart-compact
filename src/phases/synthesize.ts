/**
 * Phase 3: Hierarchical Synthesis.
 */

import type { Model, Api } from "@earendil-works/pi-ai";
import type {
  LlmMessage, LlmChunk, ChunkSummary, StructuredExtraction,
  ExplorationReport, ProfileConfig,
} from "../types.ts";
import { COMPACT_SYSTEM_PREFIX, SINGLE_PASS_PREFIX, SINGLE_PASS_SUFFIX, BATCH_PROMPT_PREFIX, BATCH_PROMPT_SUFFIX, ASSEMBLY_PROMPT_PREFIX, ASSEMBLY_PROMPT_SUFFIX, SESSION_TYPE_INSTRUCTIONS, TRUNC } from "../constants.ts";
import { getProviderCaps, makeTokenEstimator, type TokenEstimator } from "../utils/tokens.ts";
import { trackedComplete } from "../utils/cache.ts";
import { extractText } from "../utils/extraction.ts";
import { filterToolCalls } from "../utils/type-guards.ts";
import { buildExtractionContext, buildExplorationContext, createBatches, preProcessSummaries, inferSessionType } from "../utils/helpers.ts";
import type { SmartCompactServices } from "../infra/services.ts";

function boundedToolArgs(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > TRUNC.DETAIL ? value.slice(0, TRUNC.DETAIL) + "…" : value;
  if (value == null || typeof value !== "object" || depth >= 2) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map(item => boundedToolArgs(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 12).map(([key, item]) => [key, boundedToolArgs(item, depth + 1)]));
}

/** The exact per-message representation used by batch prompts and planning. */
export function renderBatchMessage(message: LlmMessage): string {
  const content = extractText(message.content).slice(0, TRUNC.PREVIEW_XL);
  const toolCalls = filterToolCalls(message.content)
    .map(call => call.name + " " + JSON.stringify(boundedToolArgs(call.arguments)).slice(0, TRUNC.DETAIL))
    .join("; ");
  return "[" + message.role + "] " + content + (toolCalls ? "\n[tool_calls] " + toolCalls : "");
}

function estimateChunkTokens(msgs: LlmMessage[], estimator: TokenEstimator): number {
  return estimator.text(msgs.map(renderBatchMessage).join("\n"));
}

export function chunkLlmMessages(
  msgs: LlmMessage[],
  boundaries: import("../types.ts").TopicBoundary[],
  pc: ProfileConfig,
  estimator: TokenEstimator = makeTokenEstimator(),
  focus?: string,
): LlmChunk[] {
  if (!msgs.length) return [];
  if (!boundaries.length) {
    return [{
      startIndex: 0, endIndex: msgs.length - 1,
      tokenEstimate: estimateChunkTokens(msgs, estimator),
      topic: "Full conversation", priority: "normal", messages: msgs,
    }];
  }

  const sorted = [...boundaries].sort((a, b) => a.afterIndex - b.afterIndex);
  const chunks: LlmChunk[] = [];
  let start = 0;

  for (const bp of sorted) {
    const end = bp.afterIndex + 1;
    if (end > start && end <= msgs.length) {
      const slice = msgs.slice(start, end);
      chunks.push({
        startIndex: start, endIndex: end - 1,
        tokenEstimate: estimateChunkTokens(slice, estimator),
        topic: bp.topic || "Segment " + (chunks.length + 1),
        priority: bp.priority,
        messages: slice,
      });
    }
    start = end;
  }

  if (start < msgs.length) {
    const slice = msgs.slice(start);
    const lastTopic = sorted.length ? "After: " + sorted[sorted.length - 1].topic : "Full conversation";
    chunks.push({
      startIndex: start, endIndex: msgs.length - 1,
      tokenEstimate: estimateChunkTokens(slice, estimator),
      topic: lastTopic, priority: "normal", messages: slice,
    });
  }

  const merged: LlmChunk[] = [];
  for (const ch of chunks) {
    if (merged.length && ch.tokenEstimate < pc.minChunkTokens) {
      const prev = merged[merged.length - 1];
      prev.endIndex = ch.endIndex;
      prev.tokenEstimate += ch.tokenEstimate;
      prev.messages = msgs.slice(prev.startIndex, prev.endIndex + 1);
      prev.topic = prev.topic + " + " + ch.topic;
    } else {
      merged.push(ch);
    }
  }
  if (focus) {
    const needle = focus.toLowerCase();
    for (const chunk of merged) {
      const haystack = (chunk.topic + " " + chunk.messages.map(renderBatchMessage).join(" ")).toLowerCase();
      if (haystack.includes(needle) && (chunk.priority === "normal" || chunk.priority === "low")) chunk.priority = "high";
    }
  }
  return merged;
}

export async function singlePassCompact(
  convText: string, extraction: StructuredExtraction, report: ExplorationReport | null,
  prevContext: string,
  model: Model<Api>, auth: { apiKey: string; headers?: Record<string, string> }, budgetTokens: number, signal?: AbortSignal,
  services?: SmartCompactServices, focus?: string,
): Promise<{ summary: string; llmCalls: 1 }> {
  const extractionCtx = buildExtractionContext(extraction);
  const explorationCtx = report ? buildExplorationContext(report) : "";
  // Session-aware prompt adaptation
  const sessionType = inferSessionType(extraction, report);
  const sessionInstruction = SESSION_TYPE_INSTRUCTIONS[sessionType] ?? SESSION_TYPE_INSTRUCTIONS.implementation;
  const adaptedPrefix = SINGLE_PASS_PREFIX + "\nSession-specific instructions:\n" + sessionInstruction;
  const dynamicSuffix = (focus ? "## User Focus\nPreserve extra detail about: " + focus + "\n\n" : "") + SINGLE_PASS_SUFFIX
    .replace("{PREV_CONTEXT}", prevContext)
    .replace("{EXTRACTION_CONTEXT}", extractionCtx)
    .replace("{EXPLORATION_CONTEXT}", explorationCtx)
    .replace("{CONVERSATION}", convText);

  const resp = await trackedComplete("single-pass", model, {
    systemPrompt: COMPACT_SYSTEM_PREFIX,
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text: adaptedPrefix }], timestamp: Date.now() },
      { role: "user" as const, content: [{ type: "text" as const, text: dynamicSuffix }], timestamp: Date.now() },
    ],
  }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: Math.min(budgetTokens, getProviderCaps(model.provider).maxOutputTokens), signal }, services);
  const summary = resp.content.filter((c): c is import("@earendil-works/pi-ai").TextContent => c.type === "text").map(c => c.text).join("\n").trim();
  if (!summary.startsWith("##")) throw new Error("Single-pass malformed output");
  return { summary, llmCalls: 1 };
}

export async function summarizeBatch(
  batch: LlmChunk[], extraction: StructuredExtraction,
  model: Model<Api>, auth: { apiKey: string; headers?: Record<string, string> }, signal?: AbortSignal,
  services?: SmartCompactServices,
): Promise<ChunkSummary[]> {
  const range = { start: batch[0].startIndex, end: batch[batch.length - 1].endIndex };
  const extractionCtx = buildExtractionContext(extraction, range);
  // Decision propagation: inject decisions from before this batch's range
  const activeDecisions = extraction.decisions
    .filter(d => d.index < range.start)
    .map(d => "- " + d.summary.slice(0, TRUNC.OPEN_LOOP_SUMMARY) + (d.userResponse ? " → " + d.userResponse.slice(0, TRUNC.DECISION_DETAIL) : ""));
  const decisionCtx = activeDecisions.length
    ? "\n## Active Decisions from previous segments (honour these):\n" + activeDecisions.join("\n")
    : "";

  // Stabil chunk IDs for robust parsing (index-based mapping breaks if LLM skips/adds sections)
  const text = batch.map((ch, i) => {
    const id = i + 1;
    return "--- CHUNK " + id + ": " + ch.topic + " (" + ch.priority + ") ---\n" + ch.messages.map(renderBatchMessage).join("\n");
  }).join("\n\n");

  const promptPrefix = BATCH_PROMPT_PREFIX;

  const dynamicSuffix = BATCH_PROMPT_SUFFIX.replace("{EXTRACTION_CONTEXT}", extractionCtx + decisionCtx).replace("{TEXT}", text);

  const resp = await trackedComplete("batch", model, {
    systemPrompt: COMPACT_SYSTEM_PREFIX,
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text: promptPrefix }], timestamp: Date.now() },
      { role: "user" as const, content: [{ type: "text" as const, text: dynamicSuffix }], timestamp: Date.now() },
    ],
  }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: Math.min(Math.max(4096, batch.length * 1500), getProviderCaps(model.provider).maxOutputTokens), signal }, services);
  const output = resp.content.filter((c): c is import("@earendil-works/pi-ai").TextContent => c.type === "text").map(c => c.text).join("\n");

  // ID-based parsing: map chunk number -> section content
  const sectionMap = new Map<number, string>();
  const sections = output.split(/^### /m).filter(s => s.trim());
  for (const sec of sections) {
    const m = sec.match(/^CHUNK\s+(\d+):\s*(.*?)\n/i);
    if (m) {
      sectionMap.set(parseInt(m[1], 10), sec);
    }
  }

  return batch.map((ch, i) => {
    const id = i + 1;
    const sec = sectionMap.get(id) ?? "";
    const f = (n: string) => { const m = sec.match(new RegExp("\\*\\*" + n + "\\*\\*:\\s*(.+?)(?:\\n|$)", "i")); return m ? m[1].trim() : ""; };
    const l = (n: string) => { const v = f(n); return !v || v === "None" ? [] : v.split(",").map(s => s.trim()).filter(Boolean); };
    const prio = f("Priority").toLowerCase();
    const sectionFallback = sec.split("\n").slice(1).join("\n").trim().slice(0, TRUNC.PREVIEW_XL);
    const chunkFallback = ch.messages.map(m => "[" + (m?.role ?? "unknown") + "] " + extractText(m?.content).slice(0, TRUNC.CHUNK_FALLBACK)).join("\n").slice(0, TRUNC.PREVIEW_XL);
    return {
      topic: ch.topic,
      startIndex: ch.startIndex, endIndex: ch.endIndex,
      summary: f("Summary") || sectionFallback || chunkFallback || "No summary generated for this segment.",
      keyDecisions: l("Decisions"), filesModified: l("Modified"), filesRead: l("Read"),
      priority: ["critical", "high", "normal", "low"].includes(prio) ? prio as ChunkSummary["priority"] : ch.priority,
    };
  });
}

export async function assembleLLM(
  summaries: ChunkSummary[], extraction: StructuredExtraction, report: ExplorationReport | null,
  model: Model<Api>, auth: { apiKey: string; headers?: Record<string, string> }, budget: number,
  prevContext: string, signal?: AbortSignal, services?: SmartCompactServices, focus?: string,
): Promise<string> {
  const pp = preProcessSummaries(summaries, budget, focus);
  const detModified = extraction.modifiedFiles.map(f => f.path);
  const detRead = extraction.readFiles;
  const explorationCtx = report ? buildExplorationContext(report) : "";
  const dynamicSuffix = ASSEMBLY_PROMPT_SUFFIX
    .replace("{DECISIONS}", pp.decisions.join("; ") || "None")
    .replace("{MODIFIED}", detModified.join(", ") || "None")
    .replace("{READ}", detRead.join(", ") || "None")
    .replace("{EXPLORATION_CONTEXT}", explorationCtx)
    .replace("{PREV_CONTEXT}", prevContext)
    .replace("{SUMMARIES}", pp.text);

  const resp = await trackedComplete("assemble", model, {
    systemPrompt: COMPACT_SYSTEM_PREFIX,
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text: ASSEMBLY_PROMPT_PREFIX }], timestamp: Date.now() },
      { role: "user" as const, content: [{ type: "text" as const, text: dynamicSuffix }], timestamp: Date.now() },
    ],
  }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: Math.min(budget, getProviderCaps(model.provider).maxOutputTokens), signal }, services);
  return resp.content.filter((c): c is import("@earendil-works/pi-ai").TextContent => c.type === "text").map(c => c.text).join("\n").trim();
}

export function assembleFallback(summaries: ChunkSummary[], extraction: StructuredExtraction): string {
  const detModified = extraction.modifiedFiles.map(f => f.path);
  const detRead = extraction.readFiles;
  return [
    "## Goal", extraction.mainGoal ?? "See topics below.", "",
    "## Constraints & Preferences", ...extraction.constraints.map(c => "- [" + c.category + "] " + c.text.slice(0, TRUNC.PREVIEW_MID)), "",
    "## Progress", "### Done", "- See topics below", "### In Progress", ...summaries.filter(s => s.priority === "high").map(s => "- [ ] " + s.summary.slice(0, TRUNC.PREVIEW)), "### Blocked", "- None", "",
    "## Key Decisions", ...extraction.decisions.map(d => "- **" + d.summary.slice(0, TRUNC.TOPIC_LABEL) + "**" + (d.userResponse ? " → " + d.userResponse : "")), "",
    "## Files Modified", ...detModified.map(f => "- " + f), "",
    "## Files Read", ...detRead.map(f => "- " + f), "",
    "## Next Steps", "1. See topics below", "",
    "## Critical Context", ...extraction.errors.filter(e => !e.resolved).map(e => "- Unresolved error: " + e.message.slice(0, TRUNC.TOPIC_LABEL)), "",
    "## Topics Covered", ...summaries.map(s => "- **" + s.topic + "** [" + s.priority + "]: " + s.summary.slice(0, TRUNC.PREVIEW_MID)),
  ].join("\n");
}

/**
 * Build a placeholder {@link ChunkSummary} when a batch's LLM call failed, so the
 * assembly step still has something deterministic to merge rather than
 * dropping the segment silently. Co-located with `assembleFallback` so both
 * fallback contracts live in the algorithm layer (no I/O, trivially testable).
 */
export function failedChunkSummary(ch: LlmChunk): ChunkSummary {
  return {
    topic: ch.topic, startIndex: ch.startIndex, endIndex: ch.endIndex,
    summary: "[Failed] " + ch.messages.map(m => extractText(m.content)).join("\n").slice(0, TRUNC.DETAIL),
    keyDecisions: [], filesModified: [], filesRead: [], priority: ch.priority,
  };
}
