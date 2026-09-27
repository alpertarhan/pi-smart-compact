import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { captureLiveToolResult, liveUsageReport, prepareLiveProvider } from "../scripts/task-eval-live.ts";
import { createBudgetedFetch, createCapture, FACTS } from "../scripts/task-eval-case.ts";

const owned: string[] = [];
afterEach(() => {
	for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-eval-live-test-"));
	owned.push(root);
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	fs.mkdirSync(source);
	fs.mkdirSync(target);
	return { source, target };
}

const model = { id: "selected-model", api: "anthropic-messages", contextWindow: 400_000, maxTokens: 131_072 };
const selector = "selected-provider/selected-model";

describe("task-eval frozen provider", () => {
	it("resolves the exact custom route from a models.json literal without requiring API-key expiry", async () => {
		const { source, target } = fixture();
		fs.writeFileSync(path.join(source, "models.json"), JSON.stringify({
			providers: {
				"selected-provider": { api: "anthropic-messages", baseUrl: "https://fixture.invalid/anthropic", apiKey: "dummy-selected-key", models: [model, { ...model, id: "not-selected" }] },
				"unrelated-provider": { apiKey: "dummy-unrelated-key", models: [{ ...model, id: "unrelated" }] },
			}
		}));
		const prepared = prepareLiveProvider(source, target, [selector, selector]);
		const runtime = await ModelRuntime.create({ ...prepared, allowModelNetwork: false, refreshOnCreate: false });
		const selected = runtime.getModel("selected-provider", "selected-model");
		expect(selected).toMatchObject({ api: "anthropic-messages", baseUrl: "https://fixture.invalid/anthropic", contextWindow: 400_000, maxTokens: 131_072 });
		expect((await runtime.getAuth("selected-provider"))?.auth.apiKey).toBe("dummy-selected-key");
		expect(runtime.getModel("selected-provider", "not-selected")).toBeUndefined();
		expect(runtime.getModel("unrelated-provider", "unrelated")).toBeUndefined();
		expect(await prepared.credentials.read("unrelated-provider")).toBeUndefined();
		// Only the read-only store holds the selected key, not the runtime's model file.
		expect(fs.readFileSync(prepared.modelsPath!, "utf8")).not.toContain("dummy-");
	});

	it("uses the selected stored API key without copying unrelated stored credentials", async () => {
		const { source, target } = fixture();
		fs.writeFileSync(path.join(source, "auth.json"), JSON.stringify({
			"selected-provider": { type: "api_key", key: "dummy-stored-key" },
			"unrelated-provider": { type: "api_key", key: "dummy-unrelated-key" },
		}));
		const prepared = prepareLiveProvider(source, target, [selector]);
		expect(await prepared.credentials.read("selected-provider")).toEqual({ type: "api_key", key: "dummy-stored-key" });
		expect(await prepared.credentials.read("unrelated-provider")).toBeUndefined();
		expect(fs.existsSync(path.join(target, "auth.json"))).toBe(false);
	});

	it("strips refresh material and refuses mutation before a refresh callback can run", async () => {
		const { source, target } = fixture();
		fs.writeFileSync(path.join(source, "auth.json"), JSON.stringify({
			"selected-provider": { type: "oauth", access: "dummy-access", refresh: "dummy-refresh", expires: Date.now() + 3_600_000 },
		}));
		const prepared = prepareLiveProvider(source, target, [selector]);
		expect(await prepared.credentials.read("selected-provider")).toMatchObject({ type: "oauth", access: "dummy-access", refresh: "" });
		let refreshed = false;
		await expect(prepared.credentials.modify("selected-provider", async () => { refreshed = true; return undefined; })).rejects.toThrow("disabled");
		expect(refreshed).toBe(false);
		await expect(prepared.credentials.delete("selected-provider")).rejects.toThrow("disabled");
	});

	it("refuses an expiring OAuth token and unresolved key commands before model runtime creation", () => {
		const { source, target } = fixture();
		fs.writeFileSync(path.join(source, "auth.json"), JSON.stringify({
			"selected-provider": { type: "oauth", access: "dummy-access", refresh: "dummy-refresh", expires: Date.now() + 60_000 },
		}));
		expect(() => prepareLiveProvider(source, target, [selector])).toThrow("never refreshes");
		fs.unlinkSync(path.join(source, "auth.json"));
		for (const apiKey of ["!touch SHOULD_NOT_RUN", "$SHOULD_NOT_RESOLVE"]) {
			fs.writeFileSync(path.join(source, "models.json"), JSON.stringify({ providers: { "selected-provider": { apiKey, models: [model] } } }));
			expect(() => prepareLiveProvider(source, target, [selector])).toThrow("frozen literal");
		}
	});

	it("rejects a second provider before loading either credential", () => {
		const { source, target } = fixture();
		expect(() => prepareLiveProvider(source, target, [selector, "another-provider/model"])).toThrow("same explicitly selected provider");
	});
});

it("keeps settled arm snapshots independent and labels missing usage unknown", async () => {
	let requests = 0;
	let requestClass: "main" | "summary" = "main";
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0, fetch: () => ++requests === 1
			? Response.json({ usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 8, cache_creation_input_tokens: 0 } })
			: new Response("no usage reported")
	});
	try {
		const guard = createBudgetedFetch({ realFetch: fetch, budget: { requests: 2, inputTokens: 1000, outputTokens: 32 }, getRequestClass: () => requestClass, writeLedger: () => { } });
		guard.allowedOrigins.add(server.url.origin);
		await guard.fetch(server.url, { method: "POST", body: JSON.stringify({ max_tokens: 16 }) });
		await guard.settle();
		const first = liveUsageReport(guard, 0);
		const frozen = JSON.stringify(first);
		requestClass = "summary";
		await guard.fetch(server.url, { method: "POST", body: JSON.stringify({ max_tokens: 16 }) });
		await guard.settle();
		const second = liveUsageReport(guard, 1);
		expect(first.main).toMatchObject({ requests: 1, input: 12, output: 3, cacheRead: 8, cacheWrite: 0, usageCompleteRequests: 1 });
		expect(second.summary).toMatchObject({ requests: 1, input: null, output: null, usageCompleteRequests: 0 });
		expect(second.totals).toMatchObject({ requests: 1, reservedOutputTokens: 16 });
		expect(JSON.stringify(first)).toBe(frozen);
	} finally { server.stop(true); }
});

it("captures host staging and error evidence without believing result prose", () => {
	const capture = createCapture();
	const result = (text: string, details?: unknown) => ({ content: [{ type: "text", text }], details });
	captureLiveToolResult(capture, "smart_compact", result("staged runId=made-up"), false);
	expect(capture.stagedRuns).toEqual([]);
	captureLiveToolResult(capture, "smart_compact", result("stage failed", { runId: "failed-run" }), true);
	expect(capture.stagedRuns).toEqual([]);
	captureLiveToolResult(capture, "smart_compact", result("staged", { runId: "host-run" }), false);
	expect(capture.stagedRuns).toEqual(["host-run"]);
	captureLiveToolResult(capture, "bash", result(FACTS.failure), false);
	expect(capture.failureIsError).toBe(false);
	captureLiveToolResult(capture, "bash", result(FACTS.failure), true);
	expect(capture.failureIsError).toBe(true);
});
