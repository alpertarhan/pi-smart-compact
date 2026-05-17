/**
 * Phase 2: Targeted LLM Exploration.
 */

import type { Model, Api } from "@earendil-works/pi-ai";
import type { LlmMessage, StructuredExtraction, ExplorationReport, TopicBoundary, CacheAwareOptions } from "../types.ts";
import { getToolCallNames, filterToolCalls } from "../utils/type-guards.ts";
import { COMPACT_SYSTEM_PREFIX, EXPLORER_SYSTEM_PROMPT, MAX_EXPLORATION_ROUNDS } from "../constants.ts";
import { extractText, extractMainGoal, extractStructured } from "../utils/extraction.ts";
import { trackedComplete, cacheOpts } from "../utils/cache.ts";
import { getProviderCaps } from "../utils/tokens.ts";
import * as log from "../utils/logger.ts";

// ── Tool Support Cache with TTL ──
const _toolSupportCache = new Map<string, { result: boolean; timestamp: number }>();
const TOOL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Determine whether exploration is worthwhile based on session complexity.
 * Simple sessions (few topics, few errors, few decisions) skip exploration
 * and rely on heuristic boundaries instead — saving 3-8 LLM calls.
 */
export function shouldExplore(extraction: StructuredExtraction): boolean {
  const unresolvedErrors = extraction.errors.filter(e => !e.resolved).length;
  const topicCount = extraction.topics.length;
  const decisionCount = extraction.decisions.length;
  const crossFileWork = new Set(extraction.modifiedFiles.map(f => {
    const parts = f.path.split("/");
    return parts.length > 1 ? parts.slice(0, -1).join("/") : "root";
  })).size;

  // Skip exploration if session is simple
  if (topicCount <= 3 && unresolvedErrors <= 1 && decisionCount <= 2 && crossFileWork <= 2) {
    return false;
  }
  return true;
}

const EXPLORATION_TOOLS = [
  {
    name: "get_message_range", description: "Get compact summaries of messages from start to end index (0-based).",
    parameters: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } }, required: ["start", "end"] },
  },
  {
    name: "search_conversation", description: "Search for text in conversation messages.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "get_recent_user_messages", description: "Get the last N user messages.",
    parameters: { type: "object", properties: { count: { type: "number" } } },
  },
  {
    name: "get_context_around", description: "Get context around a specific message index.",
    parameters: { type: "object", properties: { index: { type: "number" }, radius: { type: "number" } }, required: ["index"] },
  },
  {
    name: "get_file_changes", description: "Get tool calls that modified a specific file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "get_error_chain", description: "Get all messages related to a specific error.",
    parameters: { type: "object", properties: { index: { type: "number" }, context_radius: { type: "number" } }, required: ["index"] },
  },
];

export function executeExplorationTool(call: { name: string; arguments: Record<string, unknown> }, llmMessages: LlmMessage[]): string {
  const args = call.arguments ?? {};
  switch (call.name) {
    case "get_message_range": {
      const s = (args.start as number) ?? 0, e = Math.min((args.end as number) ?? llmMessages.length, llmMessages.length);
      return JSON.stringify(llmMessages.slice(s, e).map((m, i) => ({
        idx: s + i, role: m?.role,
        preview: extractText(m?.content).slice(0, 150),
        toolCalls: getToolCallNames(m?.content),
        isError: m?.isError,
      })));
    }
    case "search_conversation": {
      const q = ((args.query as string) ?? "").toLowerCase();
      return JSON.stringify(llmMessages.filter((m) => {
        const text = extractText(m?.content).toLowerCase();
        if (text.includes(q)) return true;
        // Also check tool call arguments for file paths
        const tcs = filterToolCalls(m?.content);
        return tcs.some(tc => JSON.stringify(tc.arguments).toLowerCase().includes(q));
      }).slice(0, 10).map((m) => ({
        idx: llmMessages.indexOf(m), role: m?.role, preview: extractText(m?.content).slice(0, 150),
      })));
    }
    case "get_recent_user_messages": {
      const count = (args.count as number) ?? 10;
      return JSON.stringify(llmMessages.filter((m) => m?.role === "user").slice(-count).map((m) => extractText(m.content)));
    }
    case "get_context_around": {
      const idx = (args.index as number) ?? 0, radius = (args.radius as number) ?? 5;
      const s = Math.max(0, idx - radius), e = Math.min(llmMessages.length, idx + radius + 1);
      return JSON.stringify(llmMessages.slice(s, e).map((m, i) => ({
        idx: s + i, role: m?.role,
        text: extractText(m?.content).slice(0, 300),
        toolCalls: getToolCallNames(m?.content),
        isError: m?.isError,
      })));
    }
    case "get_file_changes": {
      const target = ((args.path as string) ?? "").toLowerCase();
      const results: unknown[] = [];
      for (let i = 0; i < llmMessages.length; i++) {
        const tcs = filterToolCalls(llmMessages[i]?.content);
        for (const block of tcs) {
          if (block.name === "edit" && JSON.stringify(block).toLowerCase().includes(target)) {
            results.push({ idx: i, role: "assistant", toolCall: "edit", args: block.arguments, preview: extractText(llmMessages[i]?.content).slice(0, 400) });
          }
          if (block.name === "write" && JSON.stringify(block).toLowerCase().includes(target)) {
            results.push({ idx: i, role: "assistant", toolCall: "write", preview: extractText(llmMessages[i]?.content).slice(0, 400) });
          }
        }
      }
      return JSON.stringify(results.slice(0, 15) || [{ info: "No edits found for: " + args.path }]);
    }
    case "get_error_chain": {
      const errIdx = (args.index as number) ?? 0;
      const ctxRadius = (args.context_radius as number) ?? 8;
      const s = Math.max(0, errIdx - ctxRadius), e = Math.min(llmMessages.length, errIdx + ctxRadius + 1);
      return JSON.stringify(llmMessages.slice(s, e).map((m, i) => ({
        idx: s + i, role: m?.role,
        text: extractText(m?.content).slice(0, 500),
        isError: m?.isError,
        toolCalls: getToolCallNames(m?.content),
      })));
    }
    default: return "Unknown tool: " + call.name;
  }
}

export function parseExplorationReport(text: string, llmMessages: LlmMessage[]): ExplorationReport {
  let json = text.trim();
  const md = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (md) json = md[1].trim();

  let s = json.indexOf("{"), e = json.lastIndexOf("}");
  if (s === -1 || e === -1) return fallbackExplorationReport(llmMessages);
  let rawJson = json.slice(s, e + 1);

  try { return buildExplorationReportFromParsed(JSON.parse(rawJson), llmMessages); } catch (e) { log.debug("JSON parse attempt 1 failed", e); }

  const cleaned = rawJson.replace(/,\s*([}\]])/g, "$1").replace(/'/g, "\"").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  try { return buildExplorationReportFromParsed(JSON.parse(cleaned), llmMessages); } catch (e) { log.debug("JSON parse attempt 2 (cleaned) failed", e); }

  const boundaryMatch = rawJson.match(/"boundaries"\s*:\s*\[([\s\S]*?)\]/);
  if (boundaryMatch) {
    try {
      const boundaries = JSON.parse("[" + boundaryMatch[1] + "]");
      return { ...fallbackExplorationReport(llmMessages), boundaries: boundaries.filter((b: any) => typeof b?.afterIndex === "number").map((b: any) => ({
        afterIndex: Math.min(b.afterIndex, llmMessages.length - 2),
        topic: String(b.topic ?? "").slice(0, 100),
        priority: ["critical", "high", "normal", "low"].includes(b.priority) ? b.priority : "normal",
        confidence: Math.min(1, Math.max(0, b.confidence ?? 0.5)),
      })) };
    } catch (e) { log.debug("Boundary JSON parse failed", e); }
  }
  return fallbackExplorationReport(llmMessages);
}

export function buildExplorationReportFromParsed(parsed: any, llmMessages: LlmMessage[]): ExplorationReport {
  return {
    boundaries: (parsed.boundaries ?? []).filter((b: any) => typeof b?.afterIndex === "number").map((b: any) => ({
      afterIndex: Math.min(b.afterIndex, llmMessages.length - 2),
      topic: String(b.topic ?? "").slice(0, 100),
      priority: ["critical", "high", "normal", "low"].includes(b.priority) ? b.priority : "normal",
      confidence: Math.min(1, Math.max(0, b.confidence ?? 0.5)),
    })),
    mainGoal: parsed.mainGoal ?? "",
    sessionType: ["implementation", "review", "debugging", "discussion"].includes(parsed.sessionType) ? parsed.sessionType : "implementation",
    enrichedConstraints: Array.isArray(parsed.enrichedConstraints) ? parsed.enrichedConstraints.map(String) : [],
    crossReferences: Array.isArray(parsed.crossReferences) ? parsed.crossReferences.map(String) : [],
    statusAssessment: {
      done: Array.isArray(parsed.statusAssessment?.done) ? parsed.statusAssessment.done.map(String) : [],
      inProgress: Array.isArray(parsed.statusAssessment?.inProgress) ? parsed.statusAssessment.inProgress.map(String) : [],
      blocked: Array.isArray(parsed.statusAssessment?.blocked) ? parsed.statusAssessment.blocked.map(String) : [],
    },
    criticalContext: Array.isArray(parsed.criticalContext) ? parsed.criticalContext.map(String) : [],
    keyDecisions: Array.isArray(parsed.keyDecisions) ? parsed.keyDecisions.map(String) : [],
  };
}

export function fallbackExplorationReport(llmMessages: LlmMessage[]): ExplorationReport {
  return {
    boundaries: [], mainGoal: extractMainGoal(llmMessages) ?? "", sessionType: "implementation",
    enrichedConstraints: [], crossReferences: [],
    statusAssessment: { done: [], inProgress: [], blocked: [] },
    criticalContext: [], keyDecisions: [],
  };
}

export async function exploreConversation(
  llmMessages: LlmMessage[], extraction: StructuredExtraction,
  model: Model<Api>, auth: { apiKey: string; headers?: Record<string, string> },
  prevSummary: string | undefined, userNote: string | undefined,
  signal?: AbortSignal, maxRounds = MAX_EXPLORATION_ROUNDS,
  notify?: (msg: string, type?: "info" | "success" | "warning" | "error") => void,
): Promise<{ report: ExplorationReport; rounds: number; toolSupported: boolean }> {

  const extractionContext = [
    "## Deterministic Extraction (verified facts)",
    "Message count: " + extraction.messageCount,
    "Main goal: " + (extraction.mainGoal ?? "unknown"),
    "Files modified (" + extraction.modifiedFiles.length + "): " + (extraction.modifiedFiles.map(f => f.path).join(", ") || "none"),
    "Files read (" + extraction.readFiles.length + "): " + (extraction.readFiles.join(", ") || "none"),
    "Errors (" + extraction.errors.length + "): " + (extraction.errors.map(e => "[" + e.tool + "] " + e.message.slice(0, 80) + (e.resolved ? " (resolved)" : e.retryAttempted ? " (retry attempted)" : "")).join("; ") || "none"),
    "Decisions (" + extraction.decisions.length + "): " + (extraction.decisions.map(d => d.type + ": " + d.summary.slice(0, 80)).join("; ") || "none"),
    "Constraints (" + extraction.constraints.length + "): " + (extraction.constraints.map(cc => "[" + cc.category + "] " + cc.text.slice(0, 80)).join("; ") || "none"),
    "Heuristic topics (" + extraction.topics.length + "): " + (extraction.topics.map(t => "[" + t.startIndex + "-" + t.endIndex + "] " + t.type).join("; ") || "none"),
    extraction.lastUserMessages.length ? "Last user messages: " + extraction.lastUserMessages.map(m => m.slice(0, 100)).join(" | ") : "",
    extraction.lastErrors.length ? "Last errors: " + extraction.lastErrors.map(e => e.slice(0, 100)).join(" | ") : "",
  ].filter(Boolean).join("\n");

  const userContent = "Explore this conversation and produce the structured report.\n\n" +
    extractionContext +
    (prevSummary ? "\n\n## Previous Summary\n" + prevSummary : "") +
    (userNote ? "\n\n## User Steering\n\"" + userNote + "\"" : "");

  // Check tool support cache before probe
  const cacheKey = model.provider + "/" + model.id;
  const cachedSupport = _toolSupportCache.get(cacheKey);
  const cacheValid = cachedSupport && Date.now() - cachedSupport.timestamp < TOOL_CACHE_TTL;

  let supportsTools = false;
  try {
    if (cacheValid && !cachedSupport!.result) {
      // Provider known to not support tools — skip probe
      if (notify) notify("Tool support cached: unsupported (" + cacheKey + ")", "info");
      const report = await directExploration(llmMessages, extraction, model, auth, prevSummary, userNote, signal);
      if (!report.boundaries.length) {
        const retried = await explorationRetry(model, auth, llmMessages, extraction, prevSummary, userNote, signal);
        if (retried.boundaries.length) return { report: retried, rounds: 1, toolSupported: false };
      }
      return { report, rounds: 1, toolSupported: false };
    }

    const probeResp = await trackedComplete("explore", model, {
      systemPrompt: COMPACT_SYSTEM_PREFIX,
      messages: [{ role: "user", content: [{ type: "text", text: userContent }] }],
      tools: EXPLORATION_TOOLS as any,
    }, cacheOpts({ apiKey: auth.apiKey, headers: auth.headers, signal }, model.provider));

    const toolCalls = probeResp.content.filter((c): c is import("@earendil-works/pi-ai").ToolCall => c.type === "toolCall");

    if (toolCalls.length > 0) {
      supportsTools = true;
      _toolSupportCache.set(cacheKey, { result: true, timestamp: Date.now() });
      const messages: any[] = [
        { role: "user", content: [{ type: "text", text: userContent }], timestamp: Date.now() },
        { role: "assistant", content: probeResp.content, timestamp: Date.now() },
      ];
      for (const tc of toolCalls) {
        const result = executeExplorationTool({ name: tc.name, arguments: tc.arguments }, llmMessages);
        messages.push({ role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: [{ type: "text", text: result }], isError: false, timestamp: Date.now() });
      }

      let rounds = 1;
      while (rounds < maxRounds) {
        rounds++;
        let response: any;
        try {
          response = await trackedComplete("explore-loop", model, {
            systemPrompt: COMPACT_SYSTEM_PREFIX + "\n\n" + EXPLORER_SYSTEM_PROMPT,
            messages,
            tools: EXPLORATION_TOOLS as any,
          }, cacheOpts({ apiKey: auth.apiKey, headers: auth.headers, signal }, model.provider));
        } catch (err) {
          log.warn("Explore loop error", err);
          break;
        }

        const nextToolCalls = response.content.filter((c): c is import("@earendil-works/pi-ai").ToolCall => c.type === "toolCall");
        if (nextToolCalls.length === 0) {
          const text = response.content.filter((c): c is import("@earendil-works/pi-ai").TextContent => c.type === "text").map(c => c.text).join("\n").trim();
          let report = parseExplorationReport(text, llmMessages);
          if (!report.boundaries.length) {
            report = await directExploration(llmMessages, extraction, model, auth, prevSummary, userNote, signal);
            if (report.boundaries.length) rounds++;
          }
          return { report, rounds, toolSupported: true };
        }

        messages.push({ role: "assistant", content: response.content, timestamp: Date.now() });
        for (const tc of nextToolCalls) {
          const result = executeExplorationTool({ name: tc.name, arguments: tc.arguments }, llmMessages);
          messages.push({ role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: [{ type: "text", text: result }], isError: false, timestamp: Date.now() });
        }
      }

      const lastAssistant = messages.filter((m: { role: string }) => m.role === "assistant").pop() as { content?: Array<{ type: string; text?: string }> } | undefined;
      if (lastAssistant?.content) {
        const text = lastAssistant.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n").trim();
        const report = parseExplorationReport(text, llmMessages);
        if (report.boundaries.length) return { report, rounds, toolSupported: true };
      }
    } else {
      const text = probeResp.content.filter((c): c is import("@earendil-works/pi-ai").TextContent => c.type === "text").map(c => c.text).join("\n").trim();
      let report = parseExplorationReport(text, llmMessages);
      if (!report.boundaries.length) {
        report = await directExploration(llmMessages, extraction, model, auth, prevSummary, userNote, signal);
      }
      return { report, rounds: 1, toolSupported: true };
    }
    // Provider responded without tool calls — still counts as tool-capable for this session
  } catch (e) {
    // Probe failed — cache as unsupported
    log.warn("Tool calling probe failed for " + cacheKey, e);
    _toolSupportCache.set(cacheKey, { result: false, timestamp: Date.now() });
    if (notify) notify("Tool calling not supported, using direct exploration", "warning");
  }

  const report = await directExploration(llmMessages, extraction, model, auth, prevSummary, userNote, signal);
  if (!report.boundaries.length) {
    const retried = await explorationRetry(model, auth, llmMessages, extraction, prevSummary, userNote, signal);
    if (retried.boundaries.length) return { report: retried, rounds: 1, toolSupported: false };
  }
  return { report, rounds: 1, toolSupported: supportsTools };
}

export async function explorationRetry(
  model: Model<Api>, auth: { apiKey: string; headers?: Record<string, string> },
  llmMessages: LlmMessage[], extraction: StructuredExtraction,
  prevSummary: string | undefined, userNote: string | undefined,
  signal?: AbortSignal,
): Promise<ExplorationReport> {
  const last5 = llmMessages.slice(-5).map((m) => "[" + m?.role + "] " + extractText(m?.content).slice(0, 150)).join("\n");
  const retryPrompt = "IMPORTANT: Output ONLY valid raw JSON. No markdown. No explanation. No code fences. Just the JSON object.\n\n" +
    "Produce this exact structure:\n{\"mainGoal\":\"...\",\"sessionType\":\"implementation|review|debugging|discussion\",\"boundaries\":[{\"afterIndex\":N,\"topic\":\"...\",\"priority\":\"normal\",\"confidence\":0.5}],\"enrichedConstraints\":[],\"crossReferences\":[],\"statusAssessment\":{\"done\":[],\"inProgress\":[],\"blocked\":[]},\"criticalContext\":[],\"keyDecisions\":[]}\n\n" +
    "Context:\nFiles: " + extraction.modifiedFiles.map(f => f.path).join(", ") + "\n" +
    "Topics heuristic: " + extraction.topics.map(t => "[" + t.startIndex + "-" + t.endIndex + "]").join(", ") + "\n" +
    "Last messages:\n" + last5 +
    (userNote ? "\nUser steering: " + userNote : "");

  try {
    const resp = await trackedComplete("explore-retry", model, {
      systemPrompt: COMPACT_SYSTEM_PREFIX,
      messages: [{ role: "user", content: [{ type: "text", text: retryPrompt }] }],
    }, cacheOpts({ apiKey: auth.apiKey, headers: auth.headers, maxTokens: Math.min(4096, getProviderCaps(model.provider).maxOutputTokens), signal }, model.provider));
    const text = resp.content.filter((c): c is import("@earendil-works/pi-ai").TextContent => c.type === "text").map(c => c.text).join("").trim();
    return parseExplorationReport(text, llmMessages);
  } catch (e) { log.debug("explorationRetry failed", e); return fallbackExplorationReport(llmMessages); }
}

export async function directExploration(
  llmMessages: LlmMessage[], extraction: StructuredExtraction,
  model: Model<Api>, auth: { apiKey: string; headers?: Record<string, string> },
  prevSummary: string | undefined, userNote: string | undefined,
  signal?: AbortSignal,
): Promise<ExplorationReport> {
  const first3 = llmMessages.filter((m) => m?.role === "user").slice(0, 3).map((m) => extractText(m?.content).slice(0, 200)).join("\n---\n");
  const last30 = llmMessages.slice(-30).map((m) => "[" + m?.role + "] " + extractText(m?.content).slice(0, 300)).join("\n");
  const prompt = "Analyze this conversation and produce a JSON report.\n\nFirst user messages:\n" + first3 +
    "\n\nDeterministic data:\n" +
    "- Files modified: " + (extraction.modifiedFiles.map(f => f.path).join(", ") || "none") +
    "\n- Errors: " + (extraction.errors.map(e => e.message.slice(0, 80)).join("; ") || "none") +
    "\n- Decisions: " + (extraction.decisions.map(d => d.summary.slice(0, 80)).join("; ") || "none") +
    "\n- Constraints: " + (extraction.constraints.map(c => c.text.slice(0, 80)).join("; ") || "none") +
    "\n\nLast 30 messages:\n" + last30 +
    (prevSummary ? "\n\nPrevious summary:\n" + prevSummary : "") +
    (userNote ? "\n\nUser note: \"" + userNote + "\"" : "") +
    "\n\nOutput ONLY JSON: {\"mainGoal\":\"...\",\"sessionType\":\"implementation|review|debugging|discussion\",\"boundaries\":[{\"afterIndex\":N,\"topic\":\"...\",\"priority\":\"normal\",\"confidence\":0.5}],\"enrichedConstraints\":[...],\"crossReferences\":[...],\"statusAssessment\":{\"done\":[...],\"inProgress\":[...],\"blocked\":[...]},\"criticalContext\":[...],\"keyDecisions\":[...]}";

  try {
    const resp = await trackedComplete("explore-direct", model, {
      systemPrompt: COMPACT_SYSTEM_PREFIX,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    }, cacheOpts({ apiKey: auth.apiKey, headers: auth.headers, maxTokens: Math.min(4096, getProviderCaps(model.provider).maxOutputTokens), signal }, model.provider));
    const text = resp.content.filter((c): c is import("@earendil-works/pi-ai").TextContent => c.type === "text").map(c => c.text).join("\n").trim();
    return parseExplorationReport(text, llmMessages);
  } catch (e) { log.debug("directExploration failed", e); return fallbackExplorationReport(llmMessages); }
}
