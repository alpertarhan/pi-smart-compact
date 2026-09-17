import { beforeEach, describe, expect, it } from "bun:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createServices } from "../src/infra/services.ts";
import { clearSynthesisCache } from "../src/infra/synthesis-cache.ts";
import {
	BatchSummaryFormatError,
	summarizeBatch,
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

	it("skips the retry when the configured level is already minimal", async () => {
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
			summarizeBatch([chunk], extraction, model, { apiKey: "test" }, undefined, services),
		);
		expect(calls).toBe(1); // default config is minimal → retry would be a no-op
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
