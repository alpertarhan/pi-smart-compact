/**
 * Phase 2: Targeted LLM Exploration.
 */

import type {
  Model,
  Api,
  ToolCall,
  TextContent,
  Message,
  Tool,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type {
  LlmMessage,
  StructuredExtraction,
  ExplorationReport,
  TopicBoundary,
} from "../types.ts";
import { getToolCallNames, filterToolCalls } from "../utils/type-guards.ts";
import {
  COMPACT_SYSTEM_PREFIX,
  EXPLORER_SYSTEM_PROMPT,
  MAX_EXPLORATION_ROUNDS,
  MAX_EXPLORER_OUTPUT_CHARS,
  TRUNC,
} from "../constants.ts";
import { extractText, extractMainGoal } from "../utils/extraction.ts";
import { classifyTool } from "../domain/tool-semantics.ts";
import { trackedComplete } from "../utils/cache.ts";
import { getProviderCaps } from "../utils/tokens.ts";
import * as log from "../utils/logger.ts";
import type { SmartCompactServices } from "../infra/services.ts";
import { getDefaultServices } from "../infra/services.ts";
import { buildExtractionContext } from "../utils/helpers.ts";
import { classifyTelemetryFailure } from "../domain/telemetry.ts";
import { SecretScrubber } from "../domain/scrub.ts";

// Production services share bounded provider/model capability knowledge across
// runs; tests keep isolated service bags. Only an explicit provider rejection
// is cached as unsupported, so rate limits/outages cannot poison later runs.

function explicitlyRejectsTools(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const status = Number(
    record.status ??
      record.statusCode ??
      (record.response as Record<string, unknown> | undefined)?.status,
  );
  const message = String(record.message ?? "");
  return (
    (status === 400 || status === 404 || status === 422) &&
    /(?:(?:tools?|function(?:[ -]calling)?).{0,60}(?:unsupported|not supported|unknown|unavailable|invalid)|(?:unsupported|does not support|doesn't support).{0,60}(?:tools?|function))/i.test(
      message,
    )
  );
}

/**
 * Determine whether exploration is worthwhile based on session complexity.
 * Simple sessions (few topics, few errors, few decisions) skip exploration
 * and rely on heuristic boundaries instead — saving 3-8 LLM calls.
 */
export function shouldExplore(extraction: StructuredExtraction): boolean {
  const unresolvedErrors = extraction.errors.filter((e) => !e.resolved).length;
  const topicCount = extraction.topics.length;
  const decisionCount = extraction.decisions.length;
  const crossFileWork = new Set(
    extraction.modifiedFiles.map((f) => {
      const parts = f.path.split("/");
      return parts.length > 1 ? parts.slice(0, -1).join("/") : "root";
    }),
  ).size;

  // Skip exploration if session is simple
  if (
    topicCount <= 3 &&
    unresolvedErrors <= 1 &&
    decisionCount <= 2 &&
    crossFileWork <= 2
  ) {
    return false;
  }
  return true;
}

// Exploration tools declared in pi-ai's native `Tool[]` shape using typebox
// schemas. pi-ai types `Tool.parameters` as a typebox `TSchema`; the providers
// only ever *serialize* the schema (anthropic reads `properties`/`required`;
// google/mistral strip symbol keys via Object.entries; openai forwards and
// relies on JSON dropping symbols), so a real typebox schema is wire-identical
// to the plain JSON-schema objects used here previously — but now type-checks
// without a cast and survives any future typebox-aware validation.
const EXPLORATION_TOOLS: Tool[] = [
  {
    name: "get_message_range",
    description:
      "Get compact summaries of messages from start to end index (0-based).",
    parameters: Type.Object({ start: Type.Number(), end: Type.Number() }),
  },
  {
    name: "search_conversation",
    description: "Search for text in conversation messages.",
    parameters: Type.Object({ query: Type.String() }),
  },
  {
    name: "get_recent_user_messages",
    description: "Get the last N user messages.",
    parameters: Type.Object({ count: Type.Optional(Type.Number()) }),
  },
  {
    name: "get_context_around",
    description: "Get context around a specific message index.",
    parameters: Type.Object({
      index: Type.Number(),
      radius: Type.Optional(Type.Number()),
    }),
  },
  {
    name: "get_file_changes",
    description: "Get tool calls that modified a specific file.",
    parameters: Type.Object({ path: Type.String() }),
  },
  {
    name: "get_error_chain",
    description: "Get all messages related to a specific error.",
    parameters: Type.Object({
      index: Type.Number(),
      context_radius: Type.Optional(Type.Number()),
    }),
  },
];

function boundedExplorationValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > TRUNC.PREVIEW_XL
      ? value.slice(0, TRUNC.PREVIEW_XL) + "…"
      : value;
  }
  if (value == null || typeof value !== "object") return value;
  if (depth >= 3) return "[bounded]";
  if (Array.isArray(value))
    return value
      .slice(0, 50)
      .map((item) => boundedExplorationValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 16)
      .map(([key, item]) => [key, boundedExplorationValue(item, depth + 1)]),
  );
}

function serializeExplorationResult(
  value: unknown,
  scrubber: SecretScrubber,
): string {
  const safe = boundedExplorationValue(scrubber.scrubValue(value).value);
  const serialized = JSON.stringify(safe);
  if (serialized.length <= MAX_EXPLORER_OUTPUT_CHARS) return serialized;

  let excerptChars = Math.max(
    0,
    Math.floor((MAX_EXPLORER_OUTPUT_CHARS - 160) / 2),
  );
  for (;;) {
    const result = JSON.stringify({
      truncated: true,
      originalChars: serialized.length,
      head: serialized.slice(0, excerptChars),
      tail: serialized.slice(-excerptChars),
    });
    if (result.length <= MAX_EXPLORER_OUTPUT_CHARS) return result;
    if (excerptChars === 0)
      return JSON.stringify({
        truncated: true,
        originalChars: serialized.length,
      });
    excerptChars = Math.max(
      0,
      excerptChars - Math.max(1, result.length - MAX_EXPLORER_OUTPUT_CHARS),
    );
  }
}

export function executeExplorationTool(
  call: { name: string; arguments: Record<string, unknown> },
  llmMessages: LlmMessage[],
  scrubber = new SecretScrubber(),
): string {
  const args = call.arguments ?? {};
  const boundedInteger = (
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.trunc(value)))
      : fallback;
  let output: unknown;
  switch (call.name) {
    case "get_message_range": {
      const s = boundedInteger(args.start, 0, 0, llmMessages.length);
      const e = boundedInteger(
        args.end,
        llmMessages.length,
        s,
        llmMessages.length,
      );
      output = llmMessages.slice(s, e).map((m, i) => ({
        idx: s + i,
        role: m?.role,
        preview: extractText(m?.content).slice(0, TRUNC.PREVIEW),
        toolCalls: getToolCallNames(m?.content),
        isError: m?.isError,
      }));
      break;
    }
    case "search_conversation": {
      const q =
        typeof args.query === "string" ? args.query.toLowerCase().trim() : "";
      if (!q) {
        output = [{ error: "query must be a non-empty string" }];
        break;
      }
      const matches: { idx: number; m: LlmMessage }[] = [];
      for (let i = 0; i < llmMessages.length && matches.length < 10; i++) {
        const m = llmMessages[i];
        const text = extractText(m?.content).toLowerCase();
        if (text.includes(q)) {
          matches.push({ idx: i, m });
          continue;
        }
        let argumentsMatch = false;
        for (const tc of filterToolCalls(m?.content)) {
          const stack: Array<{ value: unknown; depth: number }> = [
            { value: tc.arguments, depth: 0 },
          ];
          let inspected = 0;
          while (stack.length && inspected++ < 64 && !argumentsMatch) {
            const current = stack.pop()!;
            if (typeof current.value === "string") {
              argumentsMatch = current.value
                .slice(0, 2_000)
                .toLowerCase()
                .includes(q);
            } else if (
              current.value &&
              typeof current.value === "object" &&
              current.depth < 3
            ) {
              const values = Array.isArray(current.value)
                ? current.value.slice(0, 16)
                : Object.values(current.value as Record<string, unknown>).slice(
                    0,
                    16,
                  );
              for (const value of values)
                stack.push({ value, depth: current.depth + 1 });
            }
          }
          if (argumentsMatch) break;
        }
        if (argumentsMatch) matches.push({ idx: i, m });
      }
      output = matches.map(({ idx, m }) => ({
        idx,
        role: m?.role,
        preview: extractText(m?.content).slice(0, TRUNC.PREVIEW),
      }));
      break;
    }
    case "get_recent_user_messages": {
      const count = boundedInteger(args.count, 10, 1, 50);
      output = llmMessages
        .filter((m) => m?.role === "user")
        .slice(-count)
        .map((m) => extractText(m.content).slice(0, TRUNC.PREVIEW_XL));
      break;
    }
    case "get_context_around": {
      const idx = boundedInteger(
        args.index,
        0,
        0,
        Math.max(0, llmMessages.length - 1),
      );
      const radius = boundedInteger(args.radius, 5, 0, 25);
      const s = Math.max(0, idx - radius),
        e = Math.min(llmMessages.length, idx + radius + 1);
      output = llmMessages.slice(s, e).map((m, i) => ({
        idx: s + i,
        role: m?.role,
        text: extractText(m?.content).slice(0, TRUNC.DETAIL),
        toolCalls: getToolCallNames(m?.content),
        isError: m?.isError,
      }));
      break;
    }
    case "get_file_changes": {
      const target =
        typeof args.path === "string" ? args.path.toLowerCase().trim() : "";
      if (!target) {
        output = [{ error: "path must be a non-empty string" }];
        break;
      }
      const results: unknown[] = [];
      for (
        let i = 0;
        i < llmMessages.length && results.length < TRUNC.EXPLORE_RESULTS;
        i++
      ) {
        for (const block of filterToolCalls(llmMessages[i]?.content)) {
          const a = (block.arguments ?? {}) as Record<string, unknown>;
          const fileFields = [a.path, a.file, a.filePath, a.file_path]
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.toLowerCase());
          if (
            classifyTool(block.arguments) !== "mutates" ||
            !fileFields.some((file) => file.includes(target))
          )
            continue;

          const preview = extractText(llmMessages[i]?.content).slice(
            0,
            TRUNC.PREVIEW_LONG,
          );
          const surgicalKeys = [
            "path",
            "file",
            "filePath",
            "file_path",
            "oldText",
            "newText",
            "edits",
            "patch",
          ] as const;
          const argsPreview = Object.fromEntries(
            surgicalKeys
              .filter((key) => a[key] !== undefined)
              .map((key) => [key, a[key]]),
          );
          const surgical =
            a.oldText != null ||
            a.newText != null ||
            a.edits != null ||
            a.patch != null;
          results.push(
            surgical
              ? {
                  idx: i,
                  role: "assistant",
                  toolCall: block.name ?? "mutates",
                  args: argsPreview,
                  preview,
                }
              : {
                  idx: i,
                  role: "assistant",
                  toolCall: block.name ?? "mutates",
                  preview,
                },
          );
        }
      }
      output = results.length
        ? results
        : [{ info: "No edits found for: " + args.path }];
      break;
    }
    case "get_error_chain": {
      const errIdx = boundedInteger(
        args.index,
        0,
        0,
        Math.max(0, llmMessages.length - 1),
      );
      const ctxRadius = boundedInteger(args.context_radius, 8, 0, 25);
      const s = Math.max(0, errIdx - ctxRadius),
        e = Math.min(llmMessages.length, errIdx + ctxRadius + 1);
      output = llmMessages.slice(s, e).map((m, i) => ({
        idx: s + i,
        role: m?.role,
        text: extractText(m?.content).slice(0, TRUNC.PREVIEW_XL),
        isError: m?.isError,
        toolCalls: getToolCallNames(m?.content),
      }));
      break;
    }
    default:
      output = { error: "Unknown tool: " + call.name };
  }
  return serializeExplorationResult(output, scrubber);
}

export function parseExplorationReport(
  text: string,
  llmMessages: LlmMessage[],
): ExplorationReport {
  let json = text.trim();
  const md = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (md) json = md[1].trim();

  // Note: `startIdx`/`endIdx` (not `s`/`e`) so the `catch (err)` blocks below
  // cannot accidentally shadow a single-letter outer binding. Earlier code
  // used `e` for both lastIndexOf and the catch error, which compiled but
  // was a confusing trap for future edits.
  const startIdx = json.indexOf("{"),
    endIdx = json.lastIndexOf("}");
  if (startIdx === -1 || endIdx === -1)
    return fallbackExplorationReport(llmMessages);
  const rawJson = json.slice(startIdx, endIdx + 1);

  try {
    return buildExplorationReportFromParsed(JSON.parse(rawJson), llmMessages);
  } catch (err) {
    log.debug("JSON parse attempt 1 failed", err);
  }

  // Strip trailing commas + line/block comments. We deliberately do NOT do
  // a blanket `'` -> `"` replacement: a model that returns valid JSON
  // containing apostrophes inside string values (e.g. "don't refactor")
  // would otherwise be corrupted into `"don"t refactor"`. If a model emits
  // single-quoted JSON we'd rather fall through to the regex-based
  // boundary-array recovery below than silently produce wrong text.
  const cleaned = rawJson
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  try {
    return buildExplorationReportFromParsed(JSON.parse(cleaned), llmMessages);
  } catch (err) {
    log.debug("JSON parse attempt 2 (cleaned) failed", err);
  }

  const boundaryMatch = rawJson.match(/"boundaries"\s*:\s*\[([\s\S]*?)\]/);
  if (boundaryMatch) {
    try {
      const boundaries = JSON.parse("[" + boundaryMatch[1] + "]");
      return {
        ...fallbackExplorationReport(llmMessages),
        boundaries: normalizeBoundaries(boundaries, llmMessages.length),
      };
    } catch (err) {
      log.debug("Boundary JSON parse failed", err);
    }
  }
  return fallbackExplorationReport(llmMessages);
}

const BOUNDARY_PRIORITIES = ["critical", "high", "normal", "low"] as const;
type BoundaryPriority = (typeof BOUNDARY_PRIORITIES)[number];
const SESSION_TYPES = [
  "implementation",
  "review",
  "debugging",
  "discussion",
] as const;
type SessionTypeLiteral = (typeof SESSION_TYPES)[number];

/** Coerce an unknown value into a clean `string[]` (non-strings pass through `String()`). */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/**
 * Normalize a raw `boundaries` JSON value (from an LLM) into validated
 * {@link TopicBoundary}s. Centralized so the boundary-recovery path and the
 * full-report path share identical validation, including:
 *  - a lower clamp of 0 (LLMs occasionally emit negative `afterIndex`), and
 *  - a numeric guard on `confidence` (a string would otherwise become `NaN`
 *    via Math.min before reaching the 0.5 fallback).
 */
function normalizeBoundaries(raw: unknown, llmLength: number): TopicBoundary[] {
  if (!Array.isArray(raw)) return [];
  const maxIndex = Math.max(0, llmLength - 2);
  return raw
    .filter((b): b is Record<string, unknown> => {
      if (!b || typeof b !== "object") return false;
      const afterIndex = (b as Record<string, unknown>).afterIndex;
      return typeof afterIndex === "number" && Number.isFinite(afterIndex);
    })
    .map((b) => {
      const priority = b.priority;
      const confidence = b.confidence;
      return {
        afterIndex: Math.max(
          0,
          Math.min(Math.trunc(b.afterIndex as number), maxIndex),
        ),
        topic: String(b.topic ?? "").slice(0, TRUNC.TOPIC_LABEL),
        priority:
          typeof priority === "string" &&
          (BOUNDARY_PRIORITIES as readonly string[]).includes(priority)
            ? (priority as BoundaryPriority)
            : "normal",
        confidence:
          typeof confidence === "number" && Number.isFinite(confidence)
            ? Math.min(1, Math.max(0, confidence))
            : 0.5,
      };
    })
    .sort((left, right) => left.afterIndex - right.afterIndex)
    .filter(
      (boundary, index, all) =>
        index === 0 || boundary.afterIndex !== all[index - 1].afterIndex,
    );
}

export function buildExplorationReportFromParsed(
  parsed: unknown,
  llmMessages: LlmMessage[],
): ExplorationReport {
  // Defend against primitives: a model can return JSON that parses to a
  // number/string/boolean (e.g. just `42` or `"ok"`). Make the object
  // assumption explicit so a future field access can't introduce a TypeError
  // on `(42).something`.
  if (typeof parsed !== "object" || parsed === null) {
    return fallbackExplorationReport(llmMessages);
  }
  const p = parsed as Record<string, unknown>;
  const statusAssessment = (p.statusAssessment ?? null) as Record<
    string,
    unknown
  > | null;
  const sessionTypeRaw = p.sessionType;
  return {
    boundaries: normalizeBoundaries(p.boundaries, llmMessages.length),
    mainGoal: typeof p.mainGoal === "string" ? p.mainGoal : "",
    sessionType:
      typeof sessionTypeRaw === "string" &&
      (SESSION_TYPES as readonly string[]).includes(sessionTypeRaw)
        ? (sessionTypeRaw as SessionTypeLiteral)
        : "implementation",
    enrichedConstraints: stringArray(p.enrichedConstraints),
    crossReferences: stringArray(p.crossReferences),
    statusAssessment: {
      done: stringArray(statusAssessment?.done),
      inProgress: stringArray(statusAssessment?.inProgress),
      blocked: stringArray(statusAssessment?.blocked),
    },
    criticalContext: stringArray(p.criticalContext),
    keyDecisions: stringArray(p.keyDecisions),
  };
}

export function fallbackExplorationReport(
  llmMessages: LlmMessage[],
): ExplorationReport {
  return {
    boundaries: [],
    mainGoal: extractMainGoal(llmMessages) ?? "",
    sessionType: "implementation",
    enrichedConstraints: [],
    crossReferences: [],
    statusAssessment: { done: [], inProgress: [], blocked: [] },
    criticalContext: [],
    keyDecisions: [],
  };
}

/**
 * Top-level exploration entry point.
 *
 * `services` is threaded in explicitly so concurrent production runs never
 * share mutable tool-support state. The optional `getDefaultServices()`
 * fallback exists only for legacy direct callers and test/REPL use; the
 * production orchestrator always supplies a run-scoped container.
 */
export async function exploreConversation(
  llmMessages: LlmMessage[],
  extraction: StructuredExtraction,
  model: Model<Api>,
  auth: { apiKey: string; headers?: ProviderHeaders },
  prevSummary: string | undefined,
  userNote: string | undefined,
  signal?: AbortSignal,
  maxRounds = MAX_EXPLORATION_ROUNDS,
  notify?: (
    msg: string,
    type?: "info" | "success" | "warning" | "error",
  ) => void,
  services?: SmartCompactServices,
): Promise<{
  report: ExplorationReport;
  rounds: number;
  toolSupported: boolean;
}> {
  const svc = services ?? getDefaultServices();

  const extractionContext = [
    buildExtractionContext(extraction),
    "Message count: " + extraction.messageCount,
    "Main goal: " + (extraction.mainGoal ?? "unknown"),
    "Files read: " + (extraction.readFiles.join(", ") || "none"),
    "Heuristic topics: " +
      (extraction.topics
        .map((t) => "[" + t.startIndex + "-" + t.endIndex + "] " + t.type)
        .join("; ") || "none"),
    extraction.lastUserMessages.length
      ? "Last user messages: " +
        extraction.lastUserMessages
          .map((m) => m.slice(0, TRUNC.TOPIC_LABEL))
          .join(" | ")
      : "",
    extraction.lastErrors.length
      ? "Last errors: " +
        extraction.lastErrors
          .map((e) => e.slice(0, TRUNC.TOPIC_LABEL))
          .join(" | ")
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const userContent =
    "Explore this conversation and produce the structured report.\n\n" +
    extractionContext +
    (prevSummary ? "\n\n## Previous Summary\n" + prevSummary : "") +
    (userNote ? '\n\n## User Steering\n"' + userNote + '"' : "");

  // Check tool support cache before probe
  const cacheLabel = model.provider + "/" + model.id;
  const cacheKey = [
    model.provider,
    model.api,
    model.baseUrl ?? "",
    model.id,
  ].join("\0");
  const toolSupport = svc.toolSupport;
  const now = svc.clock.now();
  const cachedSupport = toolSupport.get(cacheKey, now);

  let supportsTools = cachedSupport === true;
  try {
    if (cachedSupport === false) {
      // Provider known to not support tools — skip probe
      if (notify)
        notify("Tool support cached: unsupported (" + cacheLabel + ")", "info");
      const report = await directExploration(
        llmMessages,
        extraction,
        model,
        auth,
        prevSummary,
        userNote,
        signal,
        svc,
      );
      if (!report.boundaries.length) {
        const retried = await explorationRetry(
          model,
          auth,
          llmMessages,
          extraction,
          userNote,
          signal,
          svc,
        );
        if (retried.boundaries.length)
          return { report: retried, rounds: 1, toolSupported: false };
      }
      return { report, rounds: 1, toolSupported: false };
    }

    const probeResp = await trackedComplete(
      "explore",
      model,
      {
        systemPrompt: COMPACT_SYSTEM_PREFIX + "\n\n" + EXPLORER_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userContent }],
            timestamp: Date.now(),
          },
        ],
        tools: EXPLORATION_TOOLS,
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal,
        maxTokens: Math.min(4096, model.maxTokens || 4096),
      },
      svc,
    );

    const toolCalls = probeResp.content.filter(
      (c): c is ToolCall => c.type === "toolCall",
    );

    if (toolCalls.length > 0) {
      supportsTools = true;
      toolSupport.set(cacheKey, true, svc.clock.now());
      // Conversation buffer for the explore-tool feedback loop, kept in
      // pi-ai's native `Message[]` shape so it can be fed straight to
      // `complete()` with no cast. The assistant turn is the *whole*
      // `AssistantMessage` returned by `trackedComplete` — previously the
      // code downcast it to `LlmMessage` and discarded
      // `usage`/`api`/`provider`/`model`/`stopReason`, then cast back to
      // `Message[]` at the call site. Keeping the real object avoids both.
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: userContent }],
          timestamp: Date.now(),
        },
        probeResp,
      ];
      for (const tc of toolCalls) {
        const result = executeExplorationTool(
          { name: tc.name, arguments: tc.arguments },
          llmMessages,
          svc.scrubber,
        );
        messages.push({
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: "text", text: result }],
          isError: false,
          timestamp: Date.now(),
        });
      }

      let rounds = 1;
      while (rounds < maxRounds) {
        rounds++;
        let response: Awaited<ReturnType<typeof trackedComplete>>;
        try {
          response = await trackedComplete(
            "explore-loop",
            model,
            {
              systemPrompt:
                COMPACT_SYSTEM_PREFIX + "\n\n" + EXPLORER_SYSTEM_PROMPT,
              messages,
              tools: EXPLORATION_TOOLS,
            },
            {
              apiKey: auth.apiKey,
              headers: auth.headers,
              signal,
              maxTokens: Math.min(4096, model.maxTokens || 4096),
            },
            svc,
          );
        } catch (err) {
          log.debugError("Explore loop stopped", err);
          break;
        }

        const nextToolCalls = response.content.filter(
          (c): c is ToolCall => c.type === "toolCall",
        );
        if (nextToolCalls.length === 0) {
          const text = response.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim();
          let report = parseExplorationReport(text, llmMessages);
          if (!report.boundaries.length) {
            report = await directExploration(
              llmMessages,
              extraction,
              model,
              auth,
              prevSummary,
              userNote,
              signal,
              svc,
            );
            if (report.boundaries.length) rounds++;
          }
          return { report, rounds, toolSupported: true };
        }

        messages.push(response);
        for (const tc of nextToolCalls) {
          const result = executeExplorationTool(
            { name: tc.name, arguments: tc.arguments },
            llmMessages,
            svc.scrubber,
          );
          messages.push({
            role: "toolResult",
            toolCallId: tc.id,
            toolName: tc.name,
            content: [{ type: "text", text: result }],
            isError: false,
            timestamp: Date.now(),
          });
        }
      }

      // Tool-call loop hit `maxRounds` without producing a parseable report.
      // Try the last assistant message anyway; otherwise fall through to the
      // direct-exploration fallback below. Provider IS tool-capable here
      // (we did see toolCalls in the probe), so `supportsTools` stays true.
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      if (lastAssistant?.content) {
        const text = (
          lastAssistant.content as readonly { type: string; text?: string }[]
        )
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
          .trim();
        const report = parseExplorationReport(text, llmMessages);
        if (report.boundaries.length)
          return { report, rounds, toolSupported: true };
      }
    } else {
      // Probe responded without any toolCall blocks. Two cases:
      //   1. Provider doesn't support function calling and just answered
      //      with text.
      //   2. Provider supports tools but chose not to call any (rare).
      // If the text already parses into a usable boundary report we treat
      // the provider as tool-capable for this session; otherwise we leave
      // `supportsTools` false so the next session reprobes.
      const text = probeResp.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      let report = parseExplorationReport(text, llmMessages);
      const parsedOk = report.boundaries.length > 0;
      if (!parsedOk) {
        report = await directExploration(
          llmMessages,
          extraction,
          model,
          auth,
          prevSummary,
          userNote,
          signal,
          svc,
        );
      }
      if (parsedOk) toolSupport.set(cacheKey, true, svc.clock.now());
      return { report, rounds: 1, toolSupported: parsedOk };
    }
  } catch (e) {
    // Cache only a definitive capability rejection. Transient/auth failures
    // must be retried by a later run rather than poisoning the shared cache.
    const rejected = explicitlyRejectsTools(e);
    const failureKind = classifyTelemetryFailure(e);
    log.debugError(
      "Tool calling probe failed for " + cacheLabel + " (" + failureKind + ")",
      e,
    );
    if (rejected) toolSupport.set(cacheKey, false, svc.clock.now());
    if (notify) {
      const detail = rejected
        ? "Tool calling is unsupported by this provider"
        : failureKind === "rate-limit"
          ? "Tool probe was rate limited"
          : failureKind === "authentication"
            ? "Tool probe authentication failed"
            : "Tool probe temporarily failed (" + failureKind + ")";
      notify(detail + "; using direct exploration for this run", "warning");
    }
    if (!rejected) supportsTools = false;
  }

  const report = await directExploration(
    llmMessages,
    extraction,
    model,
    auth,
    prevSummary,
    userNote,
    signal,
    svc,
  );
  if (!report.boundaries.length) {
    const retried = await explorationRetry(
      model,
      auth,
      llmMessages,
      extraction,
      userNote,
      signal,
      svc,
    );
    if (retried.boundaries.length)
      return { report: retried, rounds: 1, toolSupported: false };
  }
  return { report, rounds: 1, toolSupported: supportsTools };
}

async function explorationRetry(
  model: Model<Api>,
  auth: { apiKey: string; headers?: ProviderHeaders },
  llmMessages: LlmMessage[],
  extraction: StructuredExtraction,
  userNote: string | undefined,
  signal?: AbortSignal,
  services?: SmartCompactServices,
): Promise<ExplorationReport> {
  const last5 = llmMessages
    .slice(-5)
    .map(
      (m) =>
        "[" + m?.role + "] " + extractText(m?.content).slice(0, TRUNC.PREVIEW),
    )
    .join("\n");
  const retryPrompt =
    "IMPORTANT: Output ONLY valid raw JSON. No markdown. No explanation. No code fences. Just the JSON object.\n\n" +
    'Produce this exact structure:\n{"mainGoal":"...","sessionType":"implementation|review|debugging|discussion","boundaries":[{"afterIndex":N,"topic":"...","priority":"normal","confidence":0.5}],"enrichedConstraints":[],"crossReferences":[],"statusAssessment":{"done":[],"inProgress":[],"blocked":[]},"criticalContext":[],"keyDecisions":[]}\n\n' +
    "Context:\nFiles: " +
    extraction.modifiedFiles.map((f) => f.path).join(", ") +
    "\n" +
    "Topics heuristic: " +
    extraction.topics
      .map((t) => "[" + t.startIndex + "-" + t.endIndex + "]")
      .join(", ") +
    "\n" +
    "Last messages:\n" +
    last5 +
    (userNote ? "\nUser steering: " + userNote : "");

  try {
    const resp = await trackedComplete(
      "explore-retry",
      model,
      {
        systemPrompt: COMPACT_SYSTEM_PREFIX,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: retryPrompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: Math.min(
          4096,
          getProviderCaps(model.provider).maxOutputTokens,
        ),
        signal,
      },
      services,
    );
    const text = resp.content
      .filter(
        (c): c is import("@earendil-works/pi-ai").TextContent =>
          c.type === "text",
      )
      .map((c) => c.text)
      .join("")
      .trim();
    return parseExplorationReport(text, llmMessages);
  } catch (e) {
    log.debug("explorationRetry failed", e);
    return fallbackExplorationReport(llmMessages);
  }
}

async function directExploration(
  llmMessages: LlmMessage[],
  extraction: StructuredExtraction,
  model: Model<Api>,
  auth: { apiKey: string; headers?: ProviderHeaders },
  prevSummary: string | undefined,
  userNote: string | undefined,
  signal?: AbortSignal,
  services?: SmartCompactServices,
): Promise<ExplorationReport> {
  const first3 = llmMessages
    .filter((m) => m?.role === "user")
    .slice(0, 3)
    .map((m) => extractText(m?.content).slice(0, TRUNC.PREVIEW_MID))
    .join("\n---\n");
  const last30 = llmMessages
    .slice(-30)
    .map(
      (m) =>
        "[" + m?.role + "] " + extractText(m?.content).slice(0, TRUNC.DETAIL),
    )
    .join("\n");
  const prompt =
    "Analyze this conversation and produce a JSON report.\n\nFirst user messages:\n" +
    first3 +
    "\n\nDeterministic data:\n" +
    "- Files modified: " +
    (extraction.modifiedFiles.map((f) => f.path).join(", ") || "none") +
    "\n- Errors: " +
    (extraction.errors
      .map((e) => e.message.slice(0, TRUNC.SNIPPET))
      .join("; ") || "none") +
    "\n- Decisions: " +
    (extraction.decisions
      .map((d) => d.summary.slice(0, TRUNC.SNIPPET))
      .join("; ") || "none") +
    "\n- Constraints: " +
    (extraction.constraints
      .map((c) => c.text.slice(0, TRUNC.SNIPPET))
      .join("; ") || "none") +
    "\n\nLast 30 messages:\n" +
    last30 +
    (prevSummary ? "\n\nPrevious summary:\n" + prevSummary : "") +
    (userNote ? '\n\nUser note: "' + userNote + '"' : "") +
    '\n\nOutput ONLY JSON: {"mainGoal":"...","sessionType":"implementation|review|debugging|discussion","boundaries":[{"afterIndex":N,"topic":"...","priority":"normal","confidence":0.5}],"enrichedConstraints":[...],"crossReferences":[...],"statusAssessment":{"done":[...],"inProgress":[...],"blocked":[...]},"criticalContext":[...],"keyDecisions":[...]}';

  try {
    const resp = await trackedComplete(
      "explore-direct",
      model,
      {
        systemPrompt: COMPACT_SYSTEM_PREFIX,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: Math.min(
          4096,
          getProviderCaps(model.provider).maxOutputTokens,
        ),
        signal,
      },
      services,
    );
    const text = resp.content
      .filter(
        (c): c is import("@earendil-works/pi-ai").TextContent =>
          c.type === "text",
      )
      .map((c) => c.text)
      .join("\n")
      .trim();
    return parseExplorationReport(text, llmMessages);
  } catch (e) {
    log.debug("directExploration failed", e);
    return fallbackExplorationReport(llmMessages);
  }
}
