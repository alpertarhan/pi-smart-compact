import { describe, expect, it } from "bun:test";
import { zstdCompressSync } from "node:zlib";
import {
	ANTHROPIC_COMPACTION_BETA,
	createCompactionFetch,
	isNativeState,
	type JsonObject,
	type NativeCompactionResult,
	type NativeState,
	replayNativeState,
} from "../src/infra/native-protocol.ts";

const wrap = (summary: string) =>
	`The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`;

interface Sent {
	url: string;
	headers: Headers;
	body: JsonObject;
}

/** The provider side: records each real request and answers it. */
function provider(respond: () => Response): { sent: Sent[]; fetch: typeof globalThis.fetch } {
	const sent: Sent[] = [];
	const record = async (input: string | URL | Request, init?: RequestInit) => {
		sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		return respond();
	};
	return { sent, fetch: record as typeof globalThis.fetch };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (events: unknown[]) =>
	new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});

/** Pi's side: the adapter POSTs the ordinary turn request it built. */
function piSends(
	compaction: ReturnType<typeof createCompactionFetch>,
	url: string,
	headers: Record<string, string>,
	body: JsonObject | Uint8Array,
): Promise<Response> {
	return compaction.fetch(url, {
		method: "POST",
		headers,
		body: body instanceof Uint8Array ? body : JSON.stringify(body),
	});
}

const block = { type: "compaction", content: "Summary of the earlier work.", signature: "sig_abc" };
const anthropicState: NativeState = {
	version: 1,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-x",
	items: [block],
};

describe("anthropic compaction request", () => {
	// A streamed compaction: the block arrives whole, stop reason and usage come in message_delta.
	const completed = () =>
		sse([
			{ type: "message_start", message: { id: "msg_c", usage: { input_tokens: 0, output_tokens: 0 } } },
			{ type: "ping" },
			{ type: "content_block_start", index: 0, content_block: block },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "compaction" },
				usage: { output_tokens: 0, iterations: [{ type: "compaction", input_tokens: 1200, output_tokens: 90 }] },
			},
			{ type: "message_stop" },
		]);

	it("turns Pi's turn request into one streamed on-demand compaction and answers Pi with a 400", async () => {
		const { sent, fetch } = provider(completed);
		const compaction = createCompactionFetch({
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-x",
			instructions: "Keep file paths.",
			fetch,
		});
		const turn = {
			model: "claude-x",
			stream: true,
			max_tokens: 64_000,
			tool_choice: { type: "auto" },
			stop_sequences: ["END"],
			context_management: { edits: [{ type: "compact_20260112" }] },
			messages: [{ role: "user", content: "hi" }],
		};
		const headers = { "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" };

		const answer = await piSends(compaction, "https://api.anthropic.com/v1/messages?beta=true", headers, turn);
		const again = await piSends(compaction, "https://api.anthropic.com/v1/messages?beta=true", headers, turn);

		expect([answer.status, again.status]).toEqual([400, 400]);
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toBe("https://api.anthropic.com/v1/messages?beta=true");
		// Same shape as Pi's own turn, plus the compaction request.
		expect(sent[0].body).toEqual({
			model: "claude-x",
			stream: true,
			max_tokens: 64_000,
			messages: turn.messages,
			compaction: { type: "summarize", instructions: "Keep file paths." },
		});
		expect(sent[0].headers.get("anthropic-beta")).toBe(`oauth-2025-04-20,${ANTHROPIC_COMPACTION_BETA}`);
		expect(compaction.result()).toEqual({
			state: anthropicState,
			summary: block.content,
			usage: { input: 1200, output: 90, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("drops context management a provider override added, keeping the compaction request", async () => {
		const { sent, fetch } = provider(completed);
		const compaction = createCompactionFetch({ api: "anthropic-messages", provider: "anthropic", model: "claude-x", fetch });
		await piSends(compaction, "https://api.anthropic.com/v1/messages", {}, {
			messages: [{ role: "user", content: "newer work" }],
			context_management: { edits: [{ type: "compact_20260112" }] },
		});
		expect(sent[0].body.compaction).toEqual({ type: "summarize" });
		expect(sent[0].body.stream).toBe(true);
		expect(sent[0].body).not.toHaveProperty("context_management");
	});

	it("accepts a JSON answer and reports a streamed error event literally", async () => {
		const jsonAnswer = provider(() =>
			json({ content: [block], stop_reason: "compaction", usage: { input_tokens: 0, output_tokens: 0 } }),
		);
		const fromJson = createCompactionFetch({ api: "anthropic-messages", provider: "anthropic", model: "claude-x", fetch: jsonAnswer.fetch });
		await piSends(fromJson, "https://api.anthropic.com/v1/messages", {}, { messages: [] });
		expect((fromJson.result() as NativeCompactionResult).state).toEqual(anthropicState);

		const overloaded = provider(() => sse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]));
		const failed = createCompactionFetch({ api: "anthropic-messages", provider: "anthropic", model: "claude-x", fetch: overloaded.fetch });
		await piSends(failed, "https://api.anthropic.com/v1/messages", {}, { messages: [] });
		expect((failed.result() as Error).message).toContain("Overloaded");
	});

	it("reports an incomplete compaction or an HTTP error literally", async () => {
		const ended = provider(() => json({ content: [], stop_reason: "end_turn", usage: {} }));
		const incomplete = createCompactionFetch({ api: "anthropic-messages", provider: "anthropic", model: "claude-x", fetch: ended.fetch });
		await piSends(incomplete, "https://api.anthropic.com/v1/messages", {}, { messages: [] });
		expect(incomplete.result()).toBeInstanceOf(Error);

		const rejected = provider(() =>
			json({ type: "error", error: { type: "invalid_request_error", message: "compaction is not supported\nfor this model" } }, 400),
		);
		const failed = createCompactionFetch({ api: "anthropic-messages", provider: "anthropic", model: "claude-x", fetch: rejected.fetch });
		await piSends(failed, "https://api.anthropic.com/v1/messages", {}, { messages: [] });
		expect((failed.result() as Error).message).toBe("400 invalid_request_error: compaction is not supported");
	});

	it("rejects an unsigned compaction block even when the provider reports completion", async () => {
		const { fetch } = provider(() => json({
			content: [{ type: "compaction", content: block.content }], stop_reason: "compaction", usage: {},
		}));
		const compaction = createCompactionFetch({ api: "anthropic-messages", provider: "anthropic", model: "claude-x", fetch });
		await piSends(compaction, "https://api.anthropic.com/v1/messages", {}, { messages: [] });
		expect(compaction.result()).toBeInstanceOf(Error);
	});

	it("sends a replayed prior block with its betas moved into the header", async () => {
		const { sent, fetch } = provider(completed);
		const compaction = createCompactionFetch({ api: "anthropic-messages", provider: "anthropic", model: "claude-x", fetch });
		const turn = {
			messages: [
				{ role: "user", content: [{ type: "text", text: wrap("old summary") }] },
				{ role: "user", content: "newer work" },
			],
		};
		// The caller replays the prior state in Pi's payload hook, before the wrapper sees it.
		const replayed = replayNativeState("anthropic-messages", turn, anthropicState, "old summary");
		expect(replayed).toBeDefined();

		await piSends(compaction, "https://api.anthropic.com/v1/messages", {}, replayed!);

		expect(sent[0].body.messages).toEqual([{ role: "assistant", content: [block] }, turn.messages[1]]);
		expect(sent[0].body.betas).toBeUndefined();
		expect(sent[0].headers.get("anthropic-beta")).toBe(ANTHROPIC_COMPACTION_BETA);
	});
});

describe("codex compaction request", () => {
	const item = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };
	const turn = {
		model: "gpt-x",
		instructions: "system prompt",
		stream: true,
		input: [
			{ role: "user", content: [{ type: "input_text", text: "first request" }] },
			{ type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "c1", output: "file text" },
			{ role: "assistant", content: [{ type: "output_text", text: "done" }] },
		],
	};

	it("reads Pi's compressed request, closes it with a trigger and keeps the user messages", async () => {
		const { sent, fetch } = provider(() =>
			sse([
				{ type: "response.output_item.done", item: { type: "reasoning", id: "rs_1" } },
				{ type: "response.output_item.done", item },
				{
					type: "response.completed",
					response: { usage: { input_tokens: 800, output_tokens: 40, input_tokens_details: { cached_tokens: 100 } } },
				},
			]),
		);
		const compaction = createCompactionFetch({ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-x", fetch });
		const compressed = new Uint8Array(zstdCompressSync(Buffer.from(JSON.stringify(turn))));

		await piSends(
			compaction,
			"https://chatgpt.com/backend-api/codex/responses",
			{ "content-encoding": "zstd", accept: "text/event-stream" },
			compressed,
		);

		expect(sent[0].headers.get("content-encoding")).toBeNull();
		expect(sent[0].body.input).toEqual([...turn.input, { type: "compaction_trigger" }]);
		const result = compaction.result() as NativeCompactionResult;
		expect(result.state.items).toEqual([turn.input[0], item]);
		expect(result.summary).toContain("encrypted openai-codex/gpt-x state");
		expect(result.summary).toContain("first request");
		expect(result.usage).toEqual({ input: 700, output: 40, cacheRead: 100, cacheWrite: 0 });
	});

	it("fails on a provider error event or an unfinished stream", async () => {
		const failing = provider(() => sse([{ type: "response.failed", response: { error: { message: "context too large" } } }]));
		const failed = createCompactionFetch({ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-x", fetch: failing.fetch });
		await piSends(failed, "https://chatgpt.com/backend-api/codex/responses", {}, turn);
		expect((failed.result() as Error).message).toContain("context too large");

		const cut = provider(() => sse([{ type: "response.output_item.done", item }]));
		const unfinished = createCompactionFetch({ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-x", fetch: cut.fetch });
		await piSends(unfinished, "https://chatgpt.com/backend-api/codex/responses", {}, turn);
		expect(unfinished.result()).toBeInstanceOf(Error);
	});
});

describe("openai compaction request", () => {
	it("sends the turn's input to /responses/compact and keeps the returned window", async () => {
		const output = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "first request" }] },
			{ type: "compaction", id: "cmp_2", encrypted_content: "opaque" },
		];
		const { sent, fetch } = provider(() => json({ object: "response.compaction", output, usage: { input_tokens: 500, output_tokens: 20 } }));
		const compaction = createCompactionFetch({ api: "openai-responses", provider: "openai", model: "gpt-y", fetch });
		const input = [{ role: "user", content: [{ type: "input_text", text: "first request" }] }];

		await piSends(compaction, "https://api.openai.com/v1/responses?api-version=1", {}, {
			model: "gpt-y",
			input,
			tools: [{ type: "function", name: "read" }],
			stream: true,
			prompt_cache_key: "session-1",
		});

		expect(sent[0].url).toBe("https://api.openai.com/v1/responses/compact?api-version=1");
		expect(sent[0].body).toEqual({ model: "gpt-y", input, prompt_cache_key: "session-1" });
		const result = compaction.result() as NativeCompactionResult;
		expect(result.state.items).toEqual(output);
		expect(result.summary).toContain("first request");
		expect(result.usage).toEqual({ input: 500, output: 20, cacheRead: 0, cacheWrite: 0 });
	});

	it.each([
		{ label: "without a compaction item", output: [{ type: "message", role: "user", content: [] }] },
		{ label: "without encrypted compaction content", output: [{ type: "compaction", id: "cmp_2" }] },
	])("rejects a window $label", async ({ output }) => {
		const { fetch } = provider(() => json({ output }));
		const compaction = createCompactionFetch({ api: "openai-responses", provider: "openai", model: "gpt-y", fetch });
		await piSends(compaction, "https://api.openai.com/v1/responses", {}, { model: "gpt-y", input: [] });
		expect(compaction.result()).toBeInstanceOf(Error);
	});
});

describe("replaying native state in ordinary requests", () => {
	it("leads an Anthropic request with the block and keeps the rest of the merged user turn", () => {
		const payload = {
			model: "claude-x",
			betas: ["other-beta"],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: `REMINDER\n${wrap("the summary")}` },
						{ type: "text", text: "next prompt" },
					],
				},
				{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			],
		};
		const before = structuredClone(payload);

		const replayed = replayNativeState("anthropic-messages", payload, anthropicState, "the summary");

		expect(replayed).toEqual({
			model: "claude-x",
			betas: ["other-beta", ANTHROPIC_COMPACTION_BETA],
			messages: [
				{ role: "assistant", content: [block] },
				{
					role: "user",
					content: [
						{ type: "text", text: "REMINDER\n" },
						{ type: "text", text: "next prompt" },
					],
				},
				payload.messages[1],
			],
		});
		expect(payload).toEqual(before);
		expect((replayed?.messages as JsonObject[])[0].content).not.toBe(anthropicState.items);
	});

	it("drops a summary-only message and refuses when the summary is not first", () => {
		const alone = { messages: [{ role: "user", content: wrap("s") }, { role: "user", content: "next" }] };
		expect(replayNativeState("anthropic-messages", alone, anthropicState, "s")?.messages).toEqual([
			{ role: "assistant", content: [block] },
			{ role: "user", content: "next" },
		]);

		const later = { messages: [{ role: "user", content: "earlier" }, { role: "user", content: wrap("s") }] };
		expect(replayNativeState("anthropic-messages", later, anthropicState, "s")).toBeUndefined();
		expect(replayNativeState("anthropic-messages", alone, anthropicState, " ")).toBeUndefined();
	});

	it.each(["string", "blocks"])("does not replace a new user instruction containing summary text (%s)", (format) => {
		const instruction = "Do not restore earlier work: it was intentionally removed. Preserve this new instruction.";
		for (const api of ["anthropic-messages", "openai-responses"] as const) {
			const content = format === "string" ? instruction : [{
				type: api === "anthropic-messages" ? "text" : "input_text", text: instruction,
			}];
			const message = { role: "user", content };
			const payload = api === "anthropic-messages" ? { messages: [message] } : { input: [message] };
			const state: NativeState = api === "anthropic-messages" ? anthropicState : {
				version: 1, api, provider: "openai", model: "gpt-x",
				items: [{ type: "compaction", encrypted_content: "opaque" }],
			};
			const before = structuredClone(payload);
			expect(replayNativeState(api, payload, state, "earlier work")).toBeUndefined();
			expect(payload).toEqual(before);
		}
	});

	it("puts an OpenAI window where the summary was, after the developer prompt", () => {
		const window = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "kept" }] },
			{ type: "compaction", id: "cmp_3", encrypted_content: "opaque" },
		];
		const state: NativeState = { version: 1, api: "openai-codex-responses", provider: "openai-codex", model: "gpt-x", items: window };
		const developer = { role: "developer", content: "system prompt" };
		const next = { role: "user", content: [{ type: "input_text", text: "next" }] };
		const payload = { input: [developer, { role: "user", content: [{ type: "input_text", text: wrap("s") }] }, next] };

		expect(replayNativeState("openai-codex-responses", payload, state, "s")?.input).toEqual([developer, ...window, next]);
		expect(replayNativeState("openai-codex-responses", { input: [developer, next] }, state, "s")).toBeUndefined();
		expect(replayNativeState("openai-responses", payload, state, "s")).toBeUndefined();
	});
});

describe("stored state validation", () => {
	it("accepts only complete native state", () => {
		expect(isNativeState(anthropicState)).toBe(true);
		expect(isNativeState({ ...anthropicState, version: 2 })).toBe(false);
		expect(isNativeState({ ...anthropicState, api: "google-generative-ai" })).toBe(false);
		expect(isNativeState({ ...anthropicState, items: [] })).toBe(false);
		expect(isNativeState({ ...anthropicState, items: ["text"] })).toBe(false);
		expect(isNativeState({ ...anthropicState, items: [{}] })).toBe(false);
	});
});
