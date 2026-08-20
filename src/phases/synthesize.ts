/**
 * Phase 3: Hierarchical Synthesis.
 */

import type { Model, Api, ProviderHeaders } from "@earendil-works/pi-ai";
import type {
	LlmMessage,
	LlmChunk,
	ChunkSummary,
	StructuredExtraction,
	ExplorationReport,
	ProfileConfig,
	CompactionState,
} from "../types.ts";
import {
	COMPACT_SYSTEM_PREFIX,
	SINGLE_PASS_PREFIX,
	SINGLE_PASS_SUFFIX,
	BATCH_PROMPT_PREFIX,
	BATCH_PROMPT_SUFFIX,
	ASSEMBLY_PROMPT_PREFIX,
	ASSEMBLY_PROMPT_SUFFIX,
	SESSION_TYPE_INSTRUCTIONS,
	TRUNC,
} from "../constants.ts";
import {
	getProviderCaps,
	makeTokenEstimator,
	type TokenEstimator,
} from "../utils/tokens.ts";
import { trackedComplete } from "../utils/cache.ts";
import { extractText } from "../utils/extraction.ts";
import { filterToolCalls } from "../utils/type-guards.ts";
import {
	buildExtractionContext,
	buildExplorationContext,
	preProcessSummaries,
	inferSessionType,
} from "../utils/helpers.ts";
import type { SmartCompactServices } from "../infra/services.ts";
import {
	batchCacheKey,
	getCachedBatch,
	setCachedBatch,
} from "../infra/synthesis-cache.ts";
import {
	buildSummaryPathEvidence,
	summaryEvidenceLine,
} from "../domain/summary-parse.ts";

/** Lazily compiled per-field label patterns; labels come from a fixed set. */
const batchFieldPatterns = new Map<string, RegExp>();
function batchFieldPattern(name: string): RegExp {
	let pattern = batchFieldPatterns.get(name);
	if (!pattern) {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		pattern = new RegExp("\\*\\*" + escaped + "\\*\\*:\\s*(.+?)(?:\\n|$)", "i");
		batchFieldPatterns.set(name, pattern);
	}
	return pattern;
}

function boundedToolArgs(value: unknown, depth = 0): unknown {
	if (typeof value === "string")
		return value.length > TRUNC.DETAIL
			? value.slice(0, TRUNC.DETAIL) + "…"
			: value;
	if (value == null || typeof value !== "object" || depth >= 2) return value;
	if (Array.isArray(value))
		return value.slice(0, 8).map((item) => boundedToolArgs(item, depth + 1));
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.slice(0, 12)
			.map(([key, item]) => [key, boundedToolArgs(item, depth + 1)]),
	);
}

/** The exact per-message representation used by batch prompts and planning. */
function renderBatchMessage(message: LlmMessage): string {
	const content = extractText(message.content).slice(0, TRUNC.PREVIEW_XL);
	const toolCalls = filterToolCalls(message.content)
		.map(
			(call) =>
				call.name +
				" " +
				JSON.stringify(boundedToolArgs(call.arguments)).slice(0, TRUNC.DETAIL),
		)
		.join("; ")
		.slice(0, TRUNC.PREVIEW_XL);
	return (
		"[" +
		message.role +
		"] " +
		content +
		(toolCalls ? "\n[tool_calls] " + toolCalls : "")
	);
}

function estimateChunkTokens(
	msgs: LlmMessage[],
	estimator: TokenEstimator,
): number {
	return estimator.text(msgs.map(renderBatchMessage).join("\n"));
}
function fitChunkBudget(
	messages: LlmMessage[],
	maxTokens: number,
	estimator: TokenEstimator,
): LlmMessage[] {
	let fitted = messages;
	let estimate = estimateChunkTokens(fitted, estimator);
	for (let round = 0; estimate > maxTokens && round < 8; round++) {
		const ratio = Math.max(
			0.02,
			Math.min(0.8, (maxTokens / Math.max(1, estimate)) * 0.75),
		);
		let changed = false;
		fitted = fitted.map((message) => {
			const text = extractText(message.content);
			if (!text || message.role === "assistant") return message;
			const target = Math.max(
				16,
				Math.floor(Math.min(text.length, TRUNC.PREVIEW_XL) * ratio),
			);
			if (text.length <= target) return message;
			const head = Math.max(8, Math.floor(target * 0.6));
			const tail = Math.max(4, target - head);
			changed = true;
			return {
				...message,
				content:
					text.slice(0, head) +
					"\n[…tool evidence bounded for synthesis…]\n" +
					text.slice(-tail),
			};
		});
		if (!changed) break;
		estimate = estimateChunkTokens(fitted, estimator);
	}
	if (estimate <= maxTokens) return fitted;

	// Last-resort postcondition for a single giant assistant/tool-call payload
	// or a delayed tool-result span whose structural overhead cannot be split.
	const rendered = fitted.map(renderBatchMessage).join("\n");
	const marker = "[…chunk evidence hard-bounded for synthesis…]";
	const candidate = (chars: number): LlmMessage[] => {
		if (chars <= 0) return [{ role: "user", content: marker }];
		const head = Math.ceil(chars * 0.6);
		return [
			{
				role: "user",
				content:
					rendered.slice(0, head) +
					"\n" +
					marker +
					"\n" +
					rendered.slice(-(chars - head)),
			},
		];
	};
	let best = candidate(0);
	if (estimateChunkTokens(best, estimator) > maxTokens) {
		if (estimateChunkTokens([], estimator) <= maxTokens) return [];
		throw new RangeError(
			"Token estimator cannot represent a chunk within maxChunkTokens",
		);
	}
	let low = 0;
	let high = rendered.length;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const next = candidate(middle);
		if (estimateChunkTokens(next, estimator) <= maxTokens) {
			best = next;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function extendThroughToolResults(
	messages: LlmMessage[],
	start: number,
	proposedEnd: number,
): number {
	const callIndexes = new Map<string, number>();
	for (let index = 0; index < messages.length; index++) {
		if (messages[index].role !== "assistant") continue;
		for (const call of filterToolCalls(messages[index].content)) {
			if (call.id) callIndexes.set(call.id, index);
		}
	}
	let end = Math.max(start + 1, Math.min(proposedEnd, messages.length));
	for (let index = end; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "toolResult" || !message.toolCallId) continue;
		const callIndex = callIndexes.get(message.toolCallId);
		if (callIndex !== undefined && callIndex >= start && callIndex < end)
			end = index + 1;
	}
	return end;
}

function splitOversizedChunk(
	ch: LlmChunk,
	maxTokens: number,
	estimator: TokenEstimator,
): LlmChunk[] {
	if (ch.tokenEstimate <= maxTokens) return [ch];
	if (ch.messages.length <= 1) {
		const messages = fitChunkBudget(ch.messages, maxTokens, estimator);
		const tokenEstimate = estimateChunkTokens(messages, estimator);
		if (tokenEstimate > maxTokens)
			throw new RangeError("Chunk budget postcondition failed");
		return [{ ...ch, tokenEstimate, messages }];
	}
	const parts: LlmChunk[] = [];
	let start = 0;
	while (start < ch.messages.length) {
		let proposedEnd = start;
		let tokens = 0;
		while (proposedEnd < ch.messages.length) {
			const next = estimateChunkTokens([ch.messages[proposedEnd]], estimator);
			if (proposedEnd > start && tokens + next > maxTokens) break;
			tokens += next;
			proposedEnd++;
		}
		const end = extendThroughToolResults(ch.messages, start, proposedEnd);
		const messages = fitChunkBudget(
			ch.messages.slice(start, end),
			maxTokens,
			estimator,
		);
		const tokenEstimate = estimateChunkTokens(messages, estimator);
		if (tokenEstimate > maxTokens)
			throw new RangeError("Chunk budget postcondition failed");
		parts.push({
			...ch,
			startIndex: ch.startIndex + start,
			endIndex: ch.startIndex + end - 1,
			tokenEstimate,
			messages,
		});
		start = end;
	}
	return parts.map((part, index) => ({
		...part,
		topic: ch.topic + " (part " + (index + 1) + "/" + parts.length + ")",
	}));
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
		const full = {
			startIndex: 0,
			endIndex: msgs.length - 1,
			tokenEstimate: estimateChunkTokens(msgs, estimator),
			topic: "Full conversation",
			priority: "normal" as const,
			messages: msgs,
		};
		const parts = splitOversizedChunk(full, pc.maxChunkTokens, estimator);
		if (focus) {
			const needle = focus.toLowerCase();
			for (const part of parts) {
				const haystack = (
					part.topic +
					" " +
					part.messages.map(renderBatchMessage).join(" ")
				).toLowerCase();
				if (haystack.includes(needle)) part.priority = "high";
			}
		}
		return parts;
	}

	const sorted = boundaries
		.filter((boundary) => Number.isFinite(boundary.afterIndex))
		.map((boundary) => ({
			...boundary,
			afterIndex: Math.max(
				0,
				Math.min(Math.trunc(boundary.afterIndex), Math.max(0, msgs.length - 2)),
			),
		}))
		.sort((a, b) => a.afterIndex - b.afterIndex)
		.filter(
			(boundary, index, all) =>
				index === 0 || boundary.afterIndex !== all[index - 1].afterIndex,
		);
	const chunks: LlmChunk[] = [];
	let start = 0;

	for (const bp of sorted) {
		const end = extendThroughToolResults(msgs, start, bp.afterIndex + 1);
		if (end <= start || end > msgs.length) continue;
		const slice = msgs.slice(start, end);
		chunks.push({
			startIndex: start,
			endIndex: end - 1,
			tokenEstimate: estimateChunkTokens(slice, estimator),
			topic: bp.topic || "Segment " + (chunks.length + 1),
			priority: bp.priority,
			messages: slice,
		});
		start = end;
	}

	if (start < msgs.length) {
		const slice = msgs.slice(start);
		const lastTopic = sorted.length
			? "After: " + sorted[sorted.length - 1].topic
			: "Full conversation";
		chunks.push({
			startIndex: start,
			endIndex: msgs.length - 1,
			tokenEstimate: estimateChunkTokens(slice, estimator),
			topic: lastTopic,
			priority: "normal",
			messages: slice,
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
	const bounded = merged.flatMap((chunk) =>
		splitOversizedChunk(chunk, pc.maxChunkTokens, estimator),
	);
	if (focus) {
		const needle = focus.toLowerCase();
		for (const chunk of bounded) {
			const haystack = (
				chunk.topic +
				" " +
				chunk.messages.map(renderBatchMessage).join(" ")
			).toLowerCase();
			if (
				haystack.includes(needle) &&
				(chunk.priority === "normal" || chunk.priority === "low")
			)
				chunk.priority = "high";
		}
	}
	return bounded;
}

export async function singlePassCompact(
	convText: string,
	extraction: StructuredExtraction,
	report: ExplorationReport | null,
	prevContext: string,
	model: Model<Api>,
	auth: { apiKey: string; headers?: ProviderHeaders },
	budgetTokens: number,
	signal?: AbortSignal,
	services?: SmartCompactServices,
	focus?: string,
): Promise<{ summary: string; llmCalls: 1 }> {
	const extractionCtx = buildExtractionContext(extraction);
	const explorationCtx = report ? buildExplorationContext(report) : "";
	// Session-aware prompt adaptation
	const sessionType = inferSessionType(extraction, report);
	const sessionInstruction =
		SESSION_TYPE_INSTRUCTIONS[sessionType] ??
		SESSION_TYPE_INSTRUCTIONS.implementation;
	const adaptedPrefix =
		SINGLE_PASS_PREFIX +
		"\nSession-specific instructions:\n" +
		sessionInstruction;
	const dynamicSuffix =
		(focus
			? "## User Focus\nPreserve extra detail about: " + focus + "\n\n"
			: "") +
		SINGLE_PASS_SUFFIX.replace("{PREV_CONTEXT}", prevContext)
			.replace("{EXTRACTION_CONTEXT}", extractionCtx)
			.replace("{EXPLORATION_CONTEXT}", explorationCtx)
			.replace("{CONVERSATION}", convText);

	const resp = await trackedComplete(
		"single-pass",
		model,
		{
			systemPrompt: COMPACT_SYSTEM_PREFIX,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: adaptedPrefix }],
					timestamp: Date.now(),
				},
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: dynamicSuffix }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: Math.min(
				budgetTokens,
				getProviderCaps(model.provider).maxOutputTokens,
			),
			signal,
		},
		services,
	);
	const summary = resp.content
		.filter(
			(c): c is import("@earendil-works/pi-ai").TextContent => c.type === "text",
		)
		.map((c) => c.text)
		.join("\n")
		.trim();
	if (!summary.startsWith("##")) throw new Error("Single-pass malformed output");
	return { summary, llmCalls: 1 };
}

export async function summarizeBatch(
	batch: LlmChunk[],
	extraction: StructuredExtraction,
	model: Model<Api>,
	auth: { apiKey: string; headers?: ProviderHeaders },
	signal?: AbortSignal,
	services?: SmartCompactServices,
	maxOutputTokens?: number,
	cacheScope?: string,
): Promise<ChunkSummary[]> {
	const range = {
		start: batch[0].startIndex,
		end: batch[batch.length - 1].endIndex,
	};
	const extractionCtx = buildExtractionContext(extraction, range);
	// Decision propagation: inject decisions from before this batch's range
	const activeDecisions = extraction.decisions
		.filter((d) => d.index < range.start)
		.map(
			(d) =>
				"- " +
				d.summary.slice(0, TRUNC.OPEN_LOOP_SUMMARY) +
				(d.userResponse
					? " → " + d.userResponse.slice(0, TRUNC.DECISION_DETAIL)
					: ""),
		);
	const decisionCtx = activeDecisions.length
		? "\n## Active Decisions from previous segments (honour these):\n" +
			activeDecisions.join("\n")
		: "";

	// Stabil chunk IDs for robust parsing (index-based mapping breaks if LLM skips/adds sections)
	const text = batch
		.map((ch, i) => {
			const id = i + 1;
			return (
				"--- CHUNK " +
				id +
				": " +
				ch.topic +
				" (" +
				ch.priority +
				") ---\n" +
				ch.messages.map(renderBatchMessage).join("\n")
			);
		})
		.join("\n\n");

	const promptPrefix = BATCH_PROMPT_PREFIX;

	const dynamicSuffix = BATCH_PROMPT_SUFFIX.replace(
		"{EXTRACTION_CONTEXT}",
		extractionCtx + decisionCtx,
	).replace("{TEXT}", text);
	const cacheKey = cacheScope
		? batchCacheKey({
				scope: cacheScope,
				provider: model.provider,
				model: model.id,
				dynamicSuffix,
				maxOutputTokens: maxOutputTokens ?? null,
				thinkingLevel: services?.thinkingLevels.summaryThinkingLevel ?? null,
			})
		: null;
	const cached = cacheKey ? getCachedBatch(cacheKey) : null;
	if (cached) return cached;

	const resp = await trackedComplete(
		"batch",
		model,
		{
			systemPrompt: COMPACT_SYSTEM_PREFIX,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: promptPrefix }],
					timestamp: Date.now(),
				},
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: dynamicSuffix }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens:
				maxOutputTokens ??
				Math.min(
					Math.max(1_000, batch.length * 250),
					4_096,
					getProviderCaps(model.provider).maxOutputTokens,
				),
			signal,
		},
		services,
	);
	const output = resp.content
		.filter(
			(c): c is import("@earendil-works/pi-ai").TextContent => c.type === "text",
		)
		.map((c) => c.text)
		.join("\n");

	// ID-based parsing: map chunk number -> section content
	const sectionMap = new Map<number, string>();
	const sections = output.split(/^### /m).filter((s) => s.trim());
	for (const sec of sections) {
		const m = sec.match(/^CHUNK\s+(\d+):\s*(.*?)\n/i);
		if (m) {
			sectionMap.set(parseInt(m[1], 10), sec);
		}
	}

	const result = batch.map((ch, i) => {
		const id = i + 1;
		const sec = sectionMap.get(id) ?? "";
		const f = (n: string) => {
			const m = sec.match(batchFieldPattern(n));
			return m ? m[1].trim() : "";
		};
		const l = (n: string) => {
			const v = f(n);
			return !v || v === "None"
				? []
				: v
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
		};
		const prio = f("Priority").toLowerCase();
		const sectionFallback = sec
			.split("\n")
			.slice(1)
			.join("\n")
			.trim()
			.slice(0, TRUNC.PREVIEW_XL);
		const chunkFallback = ch.messages
			.map(
				(m) =>
					"[" +
					(m?.role ?? "unknown") +
					"] " +
					extractText(m?.content).slice(0, TRUNC.CHUNK_FALLBACK),
			)
			.join("\n")
			.slice(0, TRUNC.PREVIEW_XL);
		return {
			topic: ch.topic,
			startIndex: ch.startIndex,
			endIndex: ch.endIndex,
			summary:
				f("Summary") ||
				sectionFallback ||
				chunkFallback ||
				"No summary generated for this segment.",
			keyDecisions: l("Decisions"),
			filesModified: l("Modified"),
			filesRead: l("Read"),
			filesDeleted: l("Deleted"),
			priority: ["critical", "high", "normal", "low"].includes(prio)
				? (prio as ChunkSummary["priority"])
				: ch.priority,
		};
	});
	if (cacheKey) setCachedBatch(cacheKey, result);
	return result;
}

function deterministicFileEvidence(
	extraction: StructuredExtraction,
	budgetTokens: number,
	continuity: CompactionState | null = null,
): { modified: string[]; read: string[]; deleted: string[] } {
	const modifiedPaths = extraction.modifiedFiles.map((file) => file.path);
	const readPaths = extraction.readFiles;
	const deletedPaths = Array.from(
		new Set([...extraction.deletedFiles, ...(continuity?.deletedFiles ?? [])]),
	);
	const evidence = buildSummaryPathEvidence(
		[...modifiedPaths, ...readPaths, ...deletedPaths],
		budgetTokens,
	);
	return {
		modified: modifiedPaths
			.map((path) => evidence.get(path))
			.filter((path): path is string => Boolean(path)),
		read: readPaths
			.map((path) => evidence.get(path))
			.filter((path): path is string => Boolean(path)),
		deleted: deletedPaths
			.map((path) => evidence.get(path))
			.filter((path): path is string => Boolean(path)),
	};
}

export async function assembleLLM(
	summaries: ChunkSummary[],
	extraction: StructuredExtraction,
	report: ExplorationReport | null,
	model: Model<Api>,
	auth: { apiKey: string; headers?: ProviderHeaders },
	budget: number,
	prevContext: string,
	signal?: AbortSignal,
	services?: SmartCompactServices,
	focus?: string,
	continuity: CompactionState | null = null,
): Promise<string> {
	const pp = preProcessSummaries(summaries, budget, focus);
	const files = deterministicFileEvidence(extraction, budget, continuity);
	const detModified = files.modified;
	const detRead = files.read;
	const detDeleted = files.deleted;
	const explorationCtx = report ? buildExplorationContext(report) : "";
	const dynamicSuffix = ASSEMBLY_PROMPT_SUFFIX.replace(
		"{DECISIONS}",
		pp.decisions.join("; ") || "None",
	)
		.replace("{MODIFIED}", detModified.join(", ") || "None")
		.replace("{READ}", detRead.join(", ") || "None")
		.replace("{DELETED}", detDeleted.join(", ") || "None")
		.replace("{EXPLORATION_CONTEXT}", explorationCtx)
		.replace("{PREV_CONTEXT}", prevContext)
		.replace("{SUMMARIES}", pp.text);

	const resp = await trackedComplete(
		"assemble",
		model,
		{
			systemPrompt: COMPACT_SYSTEM_PREFIX,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: ASSEMBLY_PROMPT_PREFIX }],
					timestamp: Date.now(),
				},
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: dynamicSuffix }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: Math.min(budget, getProviderCaps(model.provider).maxOutputTokens),
			signal,
		},
		services,
	);
	return resp.content
		.filter(
			(c): c is import("@earendil-works/pi-ai").TextContent => c.type === "text",
		)
		.map((c) => c.text)
		.join("\n")
		.trim();
}

export function assembleFallback(
	summaries: ChunkSummary[],
	extraction: StructuredExtraction,
	steering: { focus?: string; note?: string } = {},
	budgetTokens: number = 6_000,
	continuity: CompactionState | null = null,
): string {
	const safe = (value: string, max: number = TRUNC.PREVIEW_MID) =>
		summaryEvidenceLine(value, max);
	const files = deterministicFileEvidence(extraction, budgetTokens, continuity);
	const detModified = files.modified;
	const detRead = files.read;
	const detDeleted = files.deleted;
	const unresolved = extraction.errors
		.filter((error) => !error.resolved)
		.map((error) => safe(error.message, TRUNC.PREVIEW))
		.filter(Boolean);
	const resolved = extraction.errors
		.filter((error) => error.resolved)
		.slice(-5)
		.map((error) => safe(error.message, TRUNC.PREVIEW))
		.filter(Boolean);
	const constraints = extraction.constraints
		.map((item) => "- [" + item.category + "] " + safe(item.text))
		.filter((line) => !line.endsWith("] "));
	if (steering.focus?.trim())
		constraints.push(
			"- [focus] Preserve detail about: " +
				safe(steering.focus, TRUNC.CONSTRAINT_TEXT),
		);
	if (steering.note?.trim())
		constraints.push("- [note] " + safe(steering.note, TRUNC.CONSTRAINT_TEXT));
	const decisions = extraction.decisions
		.map((item) => {
			const summary = safe(item.summary, TRUNC.DECISION_SUMMARY);
			const response = item.userResponse
				? safe(item.userResponse, TRUNC.USER_RESPONSE)
				: "";
			return summary
				? "- **" + summary + "**" + (response ? " → " + response : "")
				: "";
		})
		.filter(Boolean);
	const inProgress = summaries
		.filter((item) => item.priority === "critical" || item.priority === "high")
		.map((item) => safe(item.summary, TRUNC.PREVIEW))
		.filter(Boolean)
		.map((item) => "- [ ] " + item);
	if (!inProgress.length) {
		inProgress.push(
			...extraction.lastUserMessages
				.slice(-3)
				.map((message) => safe(message, TRUNC.PREVIEW))
				.filter(Boolean)
				.map((message) => "- [ ] " + message),
		);
	}
	inProgress.push(
		...detModified.slice(-5).map((file) => "- [ ] Continue work in " + file),
	);
	const next =
		safe(
			extraction.lastUserMessages.at(-1) ??
				extraction.timeline.at(-1)?.summary ??
				"",
			TRUNC.PREVIEW,
		) || "Continue from the latest preserved context.";
	const goal =
		safe(extraction.mainGoal ?? "", TRUNC.DETAIL) || "Continue the current task.";
	const overflow = Object.entries(extraction.evidenceOverflow ?? {})
		.filter(([, count]) => typeof count === "number" && count > 0)
		.map(
			([kind, count]) =>
				"- Safety bound omitted " +
				count +
				" older " +
				kind +
				" item(s) from the human summary.",
		);
	const critical = [
		...unresolved.map(
			(error) => "- Unresolved error: " + safe(error, TRUNC.TOPIC_LABEL),
		),
		...resolved.map(
			(error) => "- Resolved error: " + safe(error, TRUNC.TOPIC_LABEL),
		),
		...overflow,
	];
	return [
		"## Goal",
		goal,
		"",
		"## Constraints & Preferences",
		...(constraints.length ? constraints : ["- None recorded."]),
		"",
		"## Progress",
		"### Done",
		"- No explicit completion recorded.",
		"### In Progress",
		...(inProgress.length ? inProgress : ["- Continue current work."]),
		"### Blocked",
		...(unresolved.length
			? unresolved.map((error) => "- " + error)
			: ["- None recorded."]),
		"",
		"## Key Decisions",
		...(decisions.length ? decisions : ["- None recorded."]),
		"",
		"## Files Modified",
		...(detModified.length
			? detModified.map((file) => "- " + file)
			: ["- None recorded."]),
		"",
		"## Files Read",
		...(detRead.length
			? detRead.map((file) => "- " + file)
			: ["- None recorded."]),
		"",
		"## Files Deleted",
		...(detDeleted.length
			? detDeleted.map((file) => "- " + file)
			: ["- None recorded."]),
		"",
		"## Next Steps",
		"1. " + next,
		"",
		"## Critical Context",
		...(critical.length ? critical : ["- None recorded."]),
		"",
		"## Topics Covered",
		...(summaries.length
			? summaries.map((item) => {
					const topic = safe(item.topic, TRUNC.TOPIC_LABEL) || "Segment";
					return (
						"- **" + topic + "** [" + item.priority + "]: " + safe(item.summary)
					);
				})
			: extraction.topics.map(
					(topic, index) =>
						"- Topic " + (index + 1) + ": " + safe(topic.primaryFile ?? topic.type),
				)),
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
		topic: ch.topic,
		startIndex: ch.startIndex,
		endIndex: ch.endIndex,
		summary:
			"[Failed] " +
			summaryEvidenceLine(
				ch.messages.map((m) => extractText(m.content)).join("\n"),
				TRUNC.DETAIL,
			),
		keyDecisions: [],
		filesModified: [],
		filesRead: [],
		filesDeleted: [],
		priority: ch.priority,
	};
}
