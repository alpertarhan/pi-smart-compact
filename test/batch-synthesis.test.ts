import { beforeEach, describe, expect, it } from "bun:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { BudgetGuard, createServices } from "../src/infra/services.ts";
import { clearSynthesisCache } from "../src/infra/synthesis-cache.ts";
import {
	BatchSummaryFormatError,
	summarizeBatch,
	assembleFallback,
	assembleLLM,
	buildSinglePassRequest,
	buildBatchRequest,
	singlePassCompact,
} from "../src/phases/synthesize.ts";
import type {
	LlmChunk,
	LlmMessage,
	StructuredExtraction,
} from "../src/types.ts";

const model = {
	provider: "test-provider",
	id: "test-model",
	api: "openai-responses",
	contextWindow: 100_000,
} as Model<Api>;

const extraction: StructuredExtraction = {
	modifiedFiles: [],
	readFiles: [],
	deletedFiles: [],
	errors: [],
	decisions: [],
	constraints: [],
	topics: [],
	timeline: [],
	mainGoal: "Preserve the decision",
	lastUserMessages: ["Keep atomic writes"],
	lastErrors: [],
	messageCount: 1,
};

const chunk: LlmChunk = {
	topic: "Persistence",
	startIndex: 0,
	endIndex: 0,
	tokenEstimate: 20,
	priority: "high",
	messages: [
		{
			role: "user",
			content: [{ type: "text", text: "Keep atomic writes" }],
			timestamp: 1,
		} as LlmMessage,
	],
};

function response(text: string, stopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		usage: { input: 1, output: 1 },
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

const valid = [
	"### CHUNK 1: Persistence",
	"**Summary**: Atomic writes remain required.",
	"**Decisions**: Keep atomic writes",
	"**Modified**: None",
	"**Read**: None",
	"**Deleted**: None",
	"**Priority**: high",
].join("\n");

function withoutField(field: string): string {
	return valid
		.split("\n")
		.filter((line) => !line.startsWith("**" + field + "**:"))
		.join("\n");
}

async function expectBatchFormatError(
	promise: Promise<unknown>,
): Promise<void> {
	try {
		await promise;
		throw new Error("Expected batch response validation to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(BatchSummaryFormatError);
	}
}

beforeEach(() => clearSynthesisCache());

describe("summarizeBatch response validation", () => {
	it("does not cache an empty successful response", async () => {
		let calls = 0;
		const services = createServices({
			llm: {
				complete: async () => response(calls++ === 0 ? "" : valid),
			},
		});

		await expectBatchFormatError(summarizeBatch(
				[chunk],
				extraction,
				model,
				{ apiKey: "test" },
				undefined,
				services,
				1_000,
				"session",
			));

		const retried = await summarizeBatch(
			[chunk],
			extraction,
			model,
			{ apiKey: "test" },
			undefined,
			services,
			1_000,
			"session",
		);
		expect(retried[0].summary).toBe("Atomic writes remain required.");
		expect(calls).toBe(2);

		await summarizeBatch(
			[chunk],
			extraction,
			model,
			{ apiKey: "test" },
			undefined,
			services,
			1_000,
			"session",
		);
		expect(calls).toBe(2);
	});

	it("rejects and does not cache sections missing required fields", async () => {
		for (const field of [
			"Priority",
			"Summary",
			"Decisions",
			"Modified",
			"Deleted",
			"Read",
		]) {
			clearSynthesisCache();
			let calls = 0;
			const services = createServices({
				llm: {
					complete: async () => response(calls++ === 0 ? withoutField(field) : valid),
				},
			});

			await expectBatchFormatError(summarizeBatch(
				[chunk],
				extraction,
				model,
				{ apiKey: "test" },
				undefined,
				services,
				1_000,
				"session",
			));
			await summarizeBatch(
				[chunk],
				extraction,
				model,
				{ apiKey: "test" },
				undefined,
				services,
				1_000,
				"session",
			);
			expect(calls).toBe(2);
		}
	});

	it("accepts explicit None values for optional list fields", async () => {
		const services = createServices({
			llm: {
				complete: async () => response(
					valid.replace("**Decisions**: Keep atomic writes", "**Decisions**: None"),
				),
			},
		});
		const result = await summarizeBatch(
			[chunk],
			extraction,
			model,
			{ apiKey: "test" },
			undefined,
			services,
		);
		expect(result[0].keyDecisions).toEqual([]);
		expect(result[0].filesModified).toEqual([]);
		expect(result[0].filesDeleted).toEqual([]);
		expect(result[0].filesRead).toEqual([]);
	});

	it("rejects truncated, partial, and duplicate chunk responses", async () => {
		const second = { ...chunk, topic: "Follow-up", startIndex: 1, endIndex: 1 };
		for (const malformed of [
			response(valid, "length"),
			response(valid),
			response(valid + "\n\n" + valid),
		]) {
			const services = createServices({
				llm: { complete: async () => malformed },
			});
			await expectBatchFormatError(summarizeBatch(
					malformed.stopReason === "length" ? [chunk] : [chunk, second],
					extraction,
					model,
					{ apiKey: "test" },
					undefined,
					services,
				));
		}
	});

	it("self-heals a length-truncated batch with one minimal-reasoning retry (#62)", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const services = createServices({
			thinkingLevels: {
				summaryThinkingLevel: "high",
				segmentationThinkingLevel: null,
			},
			llm: {
				complete: async (_m: unknown, _b: unknown, opts: Record<string, unknown>) => {
				calls.push(opts);
				return response(valid, calls.length === 1 ? "length" : "stop");
			},
			},
		});

		const result = await summarizeBatch(
			[chunk],
			extraction,
			model,
			{ apiKey: "test" },
			undefined,
			services,
			1_000,
			"session",
		);

		expect(result[0].summary).toBe("Atomic writes remain required.");
		expect(calls.length).toBe(2);
		expect(calls[0].reasoning).toBe("high"); // configured level on first attempt
		expect(calls[1].reasoning).toBe("minimal"); // retry caps thinking
	});

	it("still throws (deterministic fallback upstream) when the retry also length-truncates", async () => {
		let calls = 0;
		const services = createServices({
			thinkingLevels: {
				summaryThinkingLevel: "high",
				segmentationThinkingLevel: null,
			},
			llm: {
				complete: async () => {
					calls++;
					return response(valid, "length");
				},
			},
		});

		await expectBatchFormatError(
			summarizeBatch([chunk], extraction, model, { apiKey: "test" }, undefined, services),
		);
		expect(calls).toBe(2); // one attempt + one retry
	});

	it("skips a minimal-reasoning retry when the model has no output headroom", async () => {
		let calls = 0;
		const services = createServices({
			llm: {
				complete: async () => {
					calls++;
					return response(valid, "length");
				},
			},
		});

		await expectBatchFormatError(
			summarizeBatch([chunk], extraction, { ...model, maxTokens: 1_000 }, { apiKey: "test" }, undefined, services, 1_000),
		);
		expect(calls).toBe(1);
	});

	it("recovers a minimal-reasoning length stop with bounded output headroom", async () => {
		const limits: number[] = [];
		const services = createServices({
			budget: new BudgetGuard(3, 0, undefined, 100_000, 20_000),
			llm: { complete: async (_model, _body, options) => {
				limits.push(options.maxTokens!);
				return response(valid, options.maxTokens! < 1_500 ? "length" : "stop");
			} },
		});
		const result = await summarizeBatch([chunk], extraction, model, { apiKey: "test" }, undefined, services, 1_000);
		expect(result[0].summary).toBe("Atomic writes remain required.");
		expect(limits).toEqual([1_000, 2_000]);
		expect(services.budget.remainingCalls()).toBe(1); // Still reserved for assembly.
	});

	it("never spends the final assembly call on a larger-output retry", async () => {
		const services = createServices({
			budget: new BudgetGuard(2),
			llm: { complete: async () => response(valid, "length") },
		});
		await expectBatchFormatError(summarizeBatch([chunk], extraction, model, { apiKey: "test" }, undefined, services, 1_000));
		expect(services.budget.callCount()).toBe(1);
	});

	it("caps a larger-output retry to the model and remaining run allowance", async () => {
		const limits: number[] = [];
		const services = createServices({
			budget: new BudgetGuard(3, 0, undefined, 100_000, 2_500),
			llm: { complete: async (_model, _body, options) => {
				limits.push(options.maxTokens!);
				return { ...response(valid, limits.length === 1 ? "length" : "stop"), usage: { input: 1, output: options.maxTokens! } } as AssistantMessage;
			} },
		});
		await summarizeBatch([chunk], extraction, { ...model, maxTokens: 1_600 }, { apiKey: "test" }, undefined, services, 1_000);
		expect(limits).toEqual([1_000, 1_500]);
	});

	it("does not retry non-length format failures", async () => {
		let calls = 0;
		const second = { ...chunk, topic: "Follow-up", startIndex: 1, endIndex: 1 };
		const services = createServices({
			llm: {
				complete: async () => {
				calls++;
				return response(valid + "\n\n" + valid); // duplicate chunk ids
				},
			},
		});

		await expectBatchFormatError(
			summarizeBatch([chunk, second], extraction, model, { apiKey: "test" }, undefined, services),
		);
		expect(calls).toBe(1);
	});
});

describe("synthesis output budgets", () => {
	it("tells a batch its output budget and required coverage", () => {
		const request = buildBatchRequest([chunk], extraction, model, 1_000);
		const prompt = JSON.stringify(request.context);
		expect(prompt).toContain("1000 output tokens");
		expect(prompt).toContain("all 1 chunk sections");
		expect(request.maxTokens).toBe(1_000);
	});

	it("separates the final summary target from the hard completion ceiling", async () => {
		const text = assembleFallback([], extraction);
		const limits: number[] = [];
		const services = createServices({
			llm: { complete: async (_model, body, options) => {
				limits.push(options.maxTokens!);
				expect(JSON.stringify(body)).toContain("Target summary length: 3000 tokens");
				return response(text, options.maxTokens! <= 3_000 ? "length" : "stop");
			} },
		});
		const request = buildSinglePassRequest("Conversation", extraction, null, "", model, 3_000);
		expect((await singlePassCompact(request, model, { apiKey: "test" }, undefined, services)).summary).toBe(text);
		expect(await assembleLLM([], extraction, null, model, { apiKey: "test" }, 3_000, "", undefined, services)).toBe(text);
		expect(limits).toEqual([6_000, 6_000]);
	});

	it("still obeys model output limits and the run's output budget", async () => {
		const limits: number[] = [];
		const services = createServices({
			budget: new BudgetGuard(3, 0, undefined, 100_000, 1_024),
			llm: { complete: async (_model, _body, options) => {
				limits.push(options.maxTokens!);
				return { ...response(assembleFallback([], extraction)), usage: { input: 1, output: 1_024 } } as AssistantMessage;
			} },
		});
		const cappedModel = { ...model, maxTokens: 1_024 };
		await assembleLLM([], extraction, null, cappedModel, { apiKey: "test" }, 3_000, "", undefined, services);
		expect(limits).toEqual([1_024]);
		await expect(assembleLLM([], extraction, null, cappedModel, { apiKey: "test" }, 3_000, "", undefined, services)).rejects.toThrow(/budget exhausted/);
		expect(limits).toHaveLength(1);
	});
});

describe("final output completion contract (A09)", () => {
	const truncatedText =
		assembleFallback([], extraction) + "\n\n```ts\nconst unfinished =";
	const validText = assembleFallback([], extraction);

	it("rejects a length-truncated single-pass summary instead of returning it", async () => {
		const services = createServices({
			llm: { complete: async () => response(truncatedText, "length") },
		});
		const request = buildSinglePassRequest("Conversation", extraction, null, "", model, 6_000);
		await expect(
			singlePassCompact(request, model, { apiKey: "test" }, undefined, services),
		).rejects.toThrow(/truncat/i);
	});

	it("rejects a length-truncated assembly summary instead of returning it", async () => {
		const services = createServices({
			llm: { complete: async () => response(truncatedText, "length") },
		});
		await expect(
			assembleLLM([], extraction, null, model, { apiKey: "test" }, 512, "", undefined, services),
		).rejects.toThrow(/truncat/i);
	});

	it("rejects an unclosed Markdown fence even with a terminal stop reason", async () => {
		const services = createServices({
			llm: { complete: async () => response(truncatedText, "stop") },
		});
		const request = buildSinglePassRequest("Conversation", extraction, null, "", model, 6_000);
		await expect(
			singlePassCompact(request, model, { apiKey: "test" }, undefined, services),
		).rejects.toThrow(/truncat/i);
		await expect(
			assembleLLM([], extraction, null, model, { apiKey: "test" }, 512, "", undefined, services),
		).rejects.toThrow(/truncat/i);
	});

	it("rejects every nonterminal stop reason in both final paths (A09)", async () => {
		for (const stopReason of ["length", "toolUse", "error", "aborted", "pending", "deferred"]) {
			const services = createServices({
				llm: { complete: async () => response(validText, stopReason) },
			});
			const request = buildSinglePassRequest("Conversation", extraction, null, "", model, 6_000);
			await expect(
				singlePassCompact(request, model, { apiKey: "test" }, undefined, services),
			).rejects.toThrow(/truncat/i);
			await expect(
				assembleLLM([], extraction, null, model, { apiKey: "test" }, 512, "", undefined, services),
			).rejects.toThrow(/truncat/i);
		}
	});

	it("retains valid terminal single-pass and assembly outputs", async () => {
		for (const stopReason of ["stop", "endTurn"]) {
			const services = createServices({
				llm: { complete: async () => response(validText, stopReason) },
			});
			const request = buildSinglePassRequest("Conversation", extraction, null, "", model, 6_000);
			const single = await singlePassCompact(request, model, { apiKey: "test" }, undefined, services);
			expect(single.summary).toBe(validText);
			expect(
				await assembleLLM([], extraction, null, model, { apiKey: "test" }, 512, "", undefined, services),
			).toBe(validText);
		}
	});
});
