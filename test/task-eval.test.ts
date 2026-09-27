import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { parseMemoryRef } from "../src/infra/memory-ref.ts";
import path from "node:path";
import {
	ARMS,
	createBudgetedFetch,
	DECISION_CODES,
	FACTS,
	applyOracles,
	armSmartCompactSettings,
	continuationPaths,
	contextPresence,
	createCapture,
	decisionFromCode,
	recallEvidence,
	scriptedSummary,
	writeProjectFiles,
	type Observed,
	type OracleResult,
	type ProbeRecord,
} from "../scripts/task-eval-case.ts";

/** The ref grammar is owned by the memory module and mid-hardening; the
 * fixture uses whatever shape the real parser currently accepts. */
function validRef(): string {
	const id = "cg-" + "a1b2c3d4e5f6a7b8c9d0e1f2".slice(0, 24);
	for (const candidate of [
		`local:${id}@${"0123456789abcdef0123456789abcdef".slice(0, 24)}`,
		`local:${id}@${"01234567".slice(0, 8)}`,
		`local:${id}`,
	]) {
		if (parseMemoryRef(candidate) !== null) return candidate;
	}
	throw new Error("no candidate memory ref matches the landed grammar");
}

function distinctValidRef(not: string): string {
	for (const id of ["b" + "0".repeat(23), "c" + "0".repeat(23), "d" + "0".repeat(23)]) {
		for (const suffix of ["@" + "9".repeat(24), "@" + "9".repeat(8), ""]) {
			const candidate = `local:cg-${id}${suffix}`;
			if (candidate !== not && parseMemoryRef(candidate) !== null) return candidate;
		}
	}
	throw new Error("no distinct valid memory ref found");
}

function makeProbe(overrides: Partial<ProbeRecord> = {}): ProbeRecord {
	return {
		probe: "2",
		afterCompaction: 2,
		deliveredChars: 10_000,
		contextHas: {
			constraint: true,
			failure: true,
			newDecision: true,
			oldDecision: true,
			archiveFact: false,
			regionClaim: false,
			cacheFixClaim: false,
		},
		currentDecision: "new",
		unknownAnswer: "UNKNOWN",
		premiseAnswer: "PREMISE_FALSE",
		archiveAnswer: FACTS.archiveValue,
		archiveSource: "retrieval",
		archiveRetrievalUsed: true,
		memoryRef: validRef(),
		memoryRecallHit: true,
		...overrides,
	};
}

function baselineObserved(arm: (typeof ARMS)[number] = "eesv"): Observed {
	const capture = createCapture();
	capture.failureIsError = true;
	capture.constraintSeen = true;
	capture.memorySavedRef = validRef();
	capture.probes.push(makeProbe());
	return {
		arm,
		repeats: 2,
		files: {
			"src/store.js": `// ${FACTS.newDecision}\nclass InMemoryStore {}\n`,
			"side-effect.txt": FACTS.sideEffect + "\n",
		},
		forbiddenFileExists: false,
		testRun: { code: 0, stdout: "TEST-ORACLE PASS\n" },
		midTaskTestRun: null,
		storeModuleExec: { exportsInMemory: true, roundtripOk: true },
		retrieval: { smartContextSearch: 1, smartContextRead: 1, smartRecall: 1 },
		compactions: {
			staged: 2,
			applied: 2,
			receipts: [
				{ runId: "run-1", status: "success" },
				{ runId: "run-2", status: "success" },
			],
		},
		memoryToolAvailable: true,
		capture,
		policy: {
			minAutoTrimSavingChars: 16_384,
			autoTrimCooldownTurns: 8,
			pendingTtlMs: 300_000,
			settledCooldownMs: 600_000,
			keepRecentTokens: 6_000,
		},
	};
}

const ids = (oracles: OracleResult[]): Set<string> =>
	new Set(oracles.filter((o) => !o.pass).map((o) => o.id));

describe("task-eval case fixtures", () => {
	it("writes the matched initial state with all needles at their ranks", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-eval-case-"));
		const written = writeProjectFiles(dir);
		expect(written).toContain("src/store.js");
		expect(fs.readFileSync(path.join(dir, "notes/source.txt"), "utf8")).toContain(
			FACTS.fileFact,
		);
		const grep = fs.readFileSync(path.join(dir, "notes/grep.txt"), "utf8");
		expect(grep).toContain(`${FACTS.archiveFact}=${FACTS.archiveValue}`);
		expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain(
			FACTS.constraint,
		);
		expect(fs.readFileSync(path.join(dir, "src/store.js"), "utf8")).toContain(
			FACTS.oldDecision,
		);
		expect(written).not.toContain(FACTS.forbiddenPath);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("differs between arms only in hygiene/offload knobs", () => {
		const base = armSmartCompactSettings("no-compaction");
		for (const arm of ARMS) {
			const settings = armSmartCompactSettings(arm);
			for (const key of Object.keys(settings))
				if (key !== "contextHygieneEnabled" && key !== "artifactOffloadEnabled")
					expect(settings[key as keyof typeof settings]).toEqual(base[key as keyof typeof base]);
		}
		expect(armSmartCompactSettings("recoverable-hygiene").contextHygieneEnabled).toBe(true);
		expect(armSmartCompactSettings("hybrid").artifactOffloadEnabled).toBe(true);
		expect(armSmartCompactSettings("no-compaction").contextHygieneEnabled).toBe(false);
		expect(armSmartCompactSettings("eesv").artifactOffloadEnabled).toBe(false);
	});

	it("classifies shared presence without matching the probe's own answer format", () => {
		const ownWrites = `${FACTS.unknownKey}=UNKNOWN\n${FACTS.premiseKey}=PREMISE_FALSE\n`;
		expect(contextPresence(ownWrites).regionClaim).toBe(false);
		expect(contextPresence(ownWrites).cacheFixClaim).toBe(false);
		expect(contextPresence(`${FACTS.unknownKey}=eu-west-1`).regionClaim).toBe(true);
		expect(contextPresence("the cache bug in src/cache.js was fixed in commit 12").cacheFixClaim).toBe(true);
		expect(decisionFromCode(DECISION_CODES.new)).toBe("new");
		expect(decisionFromCode("junk")).toBe("unknown");
	});

	it("does not treat an archive lookup question as delivery of the missing value", () => {
		expect(contextPresence(`Find the value of ${FACTS.archiveFact}`).archiveFact).toBe(false);
		expect(contextPresence(`${FACTS.archiveFact}=${FACTS.archiveValue}`).archiveFact).toBe(true);
	});

	it("scripted summary keeps the newest decision and never the archive body", () => {
		const capture = createCapture();
		capture.writtenPaths.push("src/store.js", "side-effect.txt", "notes/continuation-answers-2.txt");
		const summary = scriptedSummary(
			`Decision (early): ${FACTS.oldDecision}\nDecision update: ${FACTS.newDecision}\n` +
			`${FACTS.constraint}\n${FACTS.failure}\nevidence: ${FACTS.archiveFact}=${FACTS.archiveValue}`,
			capture,
		);
		expect(summary).toContain(`${FACTS.newDecision} (supersedes ${FACTS.oldDecision})`);
		expect(summary).toContain(FACTS.constraint);
		expect(summary).toContain(FACTS.failure);
		expect(summary).not.toContain(FACTS.archiveValue);
		expect(summary).toContain("- src/store.js");
		expect(summary).toContain("notes/continuation-answers-2.txt");
	});

	it("summary omits the memory needle when the input never carried it", () => {
		const summary = scriptedSummary(
			`Decision update: ${FACTS.newDecision}\n${FACTS.constraint}\n${FACTS.failure}`,
			createCapture(),
		);
		expect(summary).not.toContain(FACTS.memoryFact);
		const withMemory = scriptedSummary(
			`Decision update: ${FACTS.newDecision}\nsaved ${FACTS.memoryFact} to memory\n`,
			createCapture(),
		);
		expect(withMemory).toContain(FACTS.memoryFact);
	});

	it("recall evidence requires the saved fact and the same ref, not any valid ref", () => {
		const ref = validRef();
		const other = distinctValidRef(ref);
		const saved = `${FACTS.memoryFact}: decision saved`;
		expect(recallEvidence(`${saved}\nRef: ${ref}`, ref)).toEqual({ hit: true, ref });
		// Unrelated but structurally valid ref: not a hit.
		expect(recallEvidence(`${saved}\nRef: ${other}`, ref).hit).toBe(false);
		// Missing recall output entirely: not a hit.
		expect(recallEvidence("", ref)).toEqual({ hit: false, ref: null });
		// Ref without the saved fact text: not a hit.
		expect(recallEvidence(`Ref: ${ref}`, ref).hit).toBe(false);
	});
});

describe("task-eval independent oracles and mutation witness", () => {
	it("passes every oracle on the intact baseline", () => {
		const oracles = applyOracles(baselineObserved());
		expect(oracles).not.toHaveLength(0);
		expect(oracles.filter((o) => !o.pass)).toEqual([]);
	});

	it("fails exactly the targeted oracle under each mutation", () => {
		const cases: Array<{ mutate: (observed: Observed) => void; expected: string[] }> = [
			{
				mutate: (o) => {
					o.storeModuleExec = { exportsInMemory: false, roundtripOk: false };
				},
				expected: ["file-current-decision"],
			},
			{
				mutate: (o) => {
					o.forbiddenFileExists = true;
				},
				expected: ["file-forbidden-absent"],
			},
			{
				mutate: (o) => {
					o.testRun = { code: 1, stdout: "TEST-ORACLE FAIL: store does not carry the current decision marker" };
				},
				expected: ["test-oracle"],
			},
			{
				mutate: (o) => {
					o.files["side-effect.txt"] = "ROLLED_BACK\n";
				},
				expected: ["side-effect-preserved"],
			},
			{
				mutate: (o) => {
					o.capture.probes[0].currentDecision = "old";
				},
				expected: [`temporal-2`],
			},
			{
				mutate: (o) => {
					o.capture.probes[0].unknownAnswer = "CONTEXT_CLAIMED";
				},
				expected: ["abstention-unknown-2"],
			},
			{
				mutate: (o) => {
					o.capture.probes[0].premiseAnswer = "CONFIRMED";
				},
				expected: ["abstention-premise-2"],
			},
			{
				mutate: (o) => {
					o.capture.probes[0].archiveAnswer = "fabricated-vector";
					o.capture.probes[0].archiveSource = "retrieval";
				},
				expected: ["archive-2"],
			},
			{
				mutate: (o) => {
					o.capture.probes[0].memoryRef = "hindsight:not-a-ref";
				},
				expected: ["memory-recall-2"],
			},
			{
				mutate: (o) => {
					o.capture.memorySavedRef = null;
				},
				expected: ["memory-save-ref"],
			},
			{
				mutate: (o) => {
					o.capture.failureIsError = false;
				},
				expected: ["error-preserved"],
			},
			{
				mutate: (o) => {
					o.compactions.receipts[1].status = "error";
				},
				expected: ["lifecycle-receipts"],
			},
			{
				mutate: (o) => {
					o.compactions.applied = 1;
				},
				expected: ["lifecycle-compactions"],
			},
		];
		for (const { mutate, expected } of cases) {
			const observed = baselineObserved();
			mutate(observed);
			expect([...ids(applyOracles(observed))].sort()).toEqual([...expected].sort());
		}
	});

	it("accepts the disk re-read route and records it distinctly from archive retrieval", () => {
		const observed = baselineObserved("no-compaction");
		observed.compactions = { staged: 0, applied: 0, receipts: [] };
		observed.memoryToolAvailable = false;
		observed.capture.probes[0].archiveSource = "disk-reread";
		observed.capture.probes[0].archiveRetrievalUsed = false;
		const failed = ids(applyOracles(observed));
		expect(failed.has("archive-2")).toBe(false);
		expect(failed.has("lifecycle-compactions")).toBe(false);
	});

	it("names probe files per checkpoint so earlier answers cannot leak into later probes", () => {
		const first = continuationPaths("2");
		const second = continuationPaths("5");
		for (const key of Object.keys(first))
			expect(first[key as keyof typeof first]).not.toBe(second[key as keyof typeof second]);
		expect(first.answers).toContain("continuation-answers-2.txt");
	});
});

describe("live budget guard (loopback wire fixtures, synthetic credentials)", () => {
	interface Captured {
		url: string;
		body: string;
	}
	const jsonResponse = (payload: string, status = 200) =>
		new Response(payload, { status, headers: { "content-type": "application/json" } });

	function guard(budget: Partial<Parameters<typeof createBudgetedFetch>[0]["budget"]> = {}, unbounded = false) {
		const captured: Captured[] = [];
		const realFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			captured.push({
				url: new URL(input instanceof Request ? input.url : String(input)).href,
				body:
					typeof init?.body === "string"
						? init.body
						: input instanceof Request
							? await input.clone().text()
							: "",
			});
			return jsonResponse('{"ok": true}');
		}) as typeof fetch;
		let saved: unknown = null;
		const budgeted = createBudgetedFetch({
			realFetch,
			budget: { requests: 10, inputTokens: 100_000, outputTokens: 100, ...budget },
			writeLedger: (ledger) => {
				saved = ledger;
			},
			unboundedOutput: unbounded,
		});
		budgeted.allowedOrigins.add("https://api.selected.dev");
		return { budgeted, captured, readLedger: () => saved as Record<string, unknown> | null };
	}

	it("allows only the exact selected origin and rejects lookalike suffix domains", async () => {
		const { budgeted } = guard();
		await budgeted.fetch("https://api.selected.dev/v1/messages", {
			method: "POST",
			body: JSON.stringify({ max_tokens: 10 }),
		});
		await expect(
			budgeted.fetch("https://api.selected.dev.attacker.example/v1/messages", {
				method: "POST",
				body: JSON.stringify({ max_tokens: 10 }),
			}),
		).rejects.toThrow(/outside the selected provider origins/);
		await expect(
			budgeted.fetch("https://evil.test/v1", { method: "POST", body: "{}" }),
		).rejects.toThrow(/outside the selected provider origins/);
	});

	it("refuses redirects fail-closed", async () => {
		const redirecting = Object.assign(
			async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.dev/x" } }),
			{ preconnect() { } },
		) as typeof fetch;
		const budgeted = createBudgetedFetch({
			realFetch: redirecting,
			budget: { requests: 5, inputTokens: 1000, outputTokens: 100 },
			writeLedger: () => { },
		});
		budgeted.allowedOrigins.add("https://api.selected.dev");
		await expect(
			budgeted.fetch("https://api.selected.dev/v1", { method: "POST", body: JSON.stringify({ max_tokens: 5 }) }),
		).rejects.toThrow(/refused a 302 redirect/);
	});

	it("refuses before dispatch when the requested cap exceeds the remaining reservation; never rewrites the body", async () => {
		const { budgeted, captured } = guard({ outputTokens: 100 });
		await expect(
			budgeted.fetch("https://api.selected.dev/v1", { method: "POST", body: '{ "max_tokens" :  5000 }' }),
		).rejects.toThrow(/exceeds remaining reserved-output budget/);
		expect(captured).toHaveLength(0);
		expect(budgeted.ledger.requests).toBe(0);
		expect(budgeted.ledger.reservedOutputTokens).toBe(0);
		expect(budgeted.ledger.inputEstimatedTokens).toBe(0);
		// A cap that fits is dispatched byte-identical (Request bodies included).
		const spaced = '{ "max_output_tokens" :  60 }';
		await budgeted.fetch(new Request("https://api.selected.dev/v1", { method: "POST", body: spaced }));
		expect(captured[0].body).toBe(spaced);
		expect(budgeted.ledger.reservedOutputTokens).toBe(60);
		// 40 remain: exactly-remaining passes, one more token is refused.
		await expect(
			budgeted.fetch("https://api.selected.dev/v1", { method: "POST", body: JSON.stringify({ max_tokens: 41 }) }),
		).rejects.toThrow(/exceeds remaining reserved-output budget/);
		await budgeted.fetch("https://api.selected.dev/v1", { method: "POST", body: JSON.stringify({ max_tokens: 40 }) });
		expect(budgeted.ledger.reservedOutputTokens).toBe(100);
		expect(captured).toHaveLength(2);
		await expect(
			budgeted.fetch("https://api.selected.dev/v1", { method: "POST", body: JSON.stringify({ max_tokens: 1 }) }),
		).rejects.toThrow(/reserved-output budget exhausted/);
	});

	it("empty, opaque, invalid, non-positive, or conflicting caps never escape bounded mode", async () => {
		const { budgeted, captured } = guard({ outputTokens: 100 });
		const refused = [
			{ method: "POST", body: JSON.stringify({ max_tokens: 0 }) },
			{ method: "POST", body: JSON.stringify({ max_tokens: -5 }) },
			{ method: "POST", body: JSON.stringify({ max_tokens: 1.5 }) },
			{ method: "POST", body: JSON.stringify({ max_tokens: "10" }) },
			{ method: "POST", body: JSON.stringify({ generationConfig: { maxOutputTokens: 0 } }) },
			// A second, larger cap field could be honored by the provider instead.
			{ method: "POST", body: JSON.stringify({ max_tokens: 10, max_completion_tokens: 500 }) },
			{ method: "POST", body: "" },
			{ method: "POST", body: "not json" },
			{ method: "POST", body: new Blob([JSON.stringify({ max_tokens: 5 })]) },
			{ method: "GET" },
		] satisfies RequestInit[];
		for (const init of refused)
			await expect(budgeted.fetch("https://api.selected.dev/v1", init)).rejects.toThrow(/output cap/);
		await expect(budgeted.fetch(new Request("https://api.selected.dev/v1"))).rejects.toThrow(/output cap/);
		expect(captured).toHaveLength(0);
		expect(budgeted.ledger.requests).toBe(0);
		expect(budgeted.ledger.reservedOutputTokens).toBe(0);
	});

	it("records per-request metadata for separate-arm accounting without bodies or secrets", async () => {
		let requestClass: "main" | "summary" = "main";
		let call = 0;
		const scripted = Object.assign(
			async () => {
				call++;
				if (call === 3) throw new Error("socket closed");
				return call === 1
					? new Response('{"usage":{"prompt_tokens":9,"completion_tokens":4}}', { status: 200 })
					: new Response('{"error":"overloaded"}', { status: 529 });
			},
			{ preconnect() { } },
		) as typeof fetch;
		let persistedRecords: unknown = null;
		const budgeted = createBudgetedFetch({
			realFetch: scripted,
			budget: { requests: 10, inputTokens: 100_000, outputTokens: 100 },
			writeLedger: (_ledger, records) => {
				persistedRecords = JSON.parse(JSON.stringify(records));
			},
			getRequestClass: () => requestClass,
		});
		budgeted.allowedOrigins.add("https://api.selected.dev");
		const send = () =>
			budgeted.fetch("https://api.selected.dev/v1", {
				method: "POST",
				headers: { authorization: "Bearer secret-token-xyz" },
				body: JSON.stringify({ max_tokens: 20, messages: "body-marker-abc" }),
			});
		await send();
		requestClass = "summary";
		await send();
		await expect(send()).rejects.toThrow(/socket closed/);
		await budgeted.settle();
		const records = budgeted.records;
		expect(records.map((r) => [r.sequence, r.requestClass, r.status, r.dispatchFailed])).toEqual([
			[1, "main", 200, false],
			[2, "summary", 529, false],
			[3, "summary", null, true],
		]);
		// The failed dispatch still consumed its request and reservations.
		expect(budgeted.ledger.requests).toBe(3);
		expect(budgeted.ledger.reservedOutputTokens).toBe(60);
		expect(records.every((r) => r.reservedOutputTokens === 20 && r.inputEstimatedTokens > 0)).toBe(true);
		expect(records.reduce((sum, r) => sum + r.inputEstimatedTokens, 0)).toBe(budgeted.ledger.inputEstimatedTokens);
		expect(records.every((r) => typeof r.elapsedMs === "number" && r.elapsedMs >= 0)).toBe(true);
		expect([records[0].reportedInputTokens, records[0].reportedOutputTokens]).toEqual([9, 4]);
		expect([records[1].reportedInputTokens, records[1].reportedOutputTokens]).toEqual([null, null]);
		expect([records[2].reportedInputTokens, records[2].reportedOutputTokens]).toEqual([null, null]);
		expect(budgeted.ledger.usageCompleteRequests).toBe(1);
		expect(persistedRecords).toEqual(JSON.parse(JSON.stringify(records)));
		const serialized = JSON.stringify({ records, ledger: budgeted.ledger });
		expect(serialized).not.toContain("secret-token-xyz");
		expect(serialized).not.toContain("body-marker-abc");
	});

	it("accounts Anthropic streams once per request from message_start and cumulative deltas", async () => {
		const event = (type: string, payload: Record<string, unknown>) =>
			`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
		const anthropicStream =
			event("message_start", {
				message: {
					id: "m1",
					usage: { input_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 1 },
				},
			}) +
			event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "streamed-secret-output" } }) +
			event("message_delta", { delta: { stop_reason: null }, usage: { output_tokens: 12 } }) +
			event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } }) +
			event("message_stop", {});
		const replies = [anthropicStream, anthropicStream, '{"type":"error"}'];
		let index = 0;
		const streaming = Object.assign(
			async () => new Response(replies[index++], { headers: { "content-type": "text/event-stream" } }),
			{ preconnect() { } },
		) as typeof fetch;
		const budgeted = createBudgetedFetch({
			realFetch: streaming,
			budget: { requests: 10, inputTokens: 100_000, outputTokens: 1000 },
			writeLedger: () => { },
		});
		budgeted.allowedOrigins.add("https://api.selected.dev");
		for (let i = 0; i < 3; i++) {
			const response = await budgeted.fetch("https://api.selected.dev/v1/messages", {
				method: "POST",
				body: JSON.stringify({ max_tokens: 50, stream: true }),
			});
			await response.text();
		}
		await budgeted.settle();
		const first = budgeted.records[0];
		expect([
			first.reportedInputTokens,
			first.reportedOutputTokens,
			first.reportedCacheReadTokens,
			first.reportedCacheWriteTokens,
		]).toEqual([20, 30, 100, 5]);
		expect(budgeted.records[2].reportedOutputTokens).toBeNull();
		expect(budgeted.ledger.reportedInputTokens).toBe(40);
		expect(budgeted.ledger.reportedOutputTokens).toBe(60);
		expect(budgeted.ledger.reportedCacheReadTokens).toBe(200);
		expect(budgeted.ledger.reportedCacheWriteTokens).toBe(10);
		expect(budgeted.ledger.usageCompleteRequests).toBe(2);
		expect(JSON.stringify({ ledger: budgeted.ledger, records: budgeted.records })).not.toContain(
			"streamed-secret-output",
		);
	});

	it("reserves concurrently without overbooking and refuses once exhausted", async () => {
		// Responses are gated (not timed): both dispatches hold until released,
		// proving the reservations complete before either response resolves.
		const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let dispatched = 0;
		const gated = Object.assign(
			async () => {
				const gate = gates[dispatched++];
				await gate.promise;
				return jsonResponse("{}");
			},
			{ preconnect() { } },
		) as typeof fetch;
		const concurrent = createBudgetedFetch({
			realFetch: gated,
			budget: { requests: 10, inputTokens: 100_000, outputTokens: 100 },
			writeLedger: () => { },
		});
		concurrent.allowedOrigins.add("https://api.selected.dev");
		const first = concurrent.fetch("https://api.selected.dev/a", {
			method: "POST",
			body: JSON.stringify({ max_tokens: 60 }),
		});
		// A concurrent over-remaining request is refused, not shrunk to fit.
		const overbook = concurrent.fetch("https://api.selected.dev/b", {
			method: "POST",
			body: JSON.stringify({ max_tokens: 60 }),
		});
		const second = concurrent.fetch("https://api.selected.dev/c", {
			method: "POST",
			body: JSON.stringify({ max_tokens: 40 }),
		});
		// String bodies make each wrapper's reservation prefix synchronous:
		// both requests are fully reserved while responses are still gated.
		expect(concurrent.ledger.reservedOutputTokens).toBe(100);
		expect(concurrent.ledger.requests).toBe(2);
		await expect(overbook).rejects.toThrow(/exceeds remaining reserved-output budget/);
		gates[0].resolve();
		gates[1].resolve();
		await Promise.all([first, second]);
		await expect(
			concurrent.fetch("https://api.selected.dev/c", {
				method: "POST",
				body: JSON.stringify({ max_tokens: 1 }),
			}),
		).rejects.toThrow(/reserved-output budget exhausted/);
	});

	it("refuses bodies without an enforceable cap unless unbounded mode is declared", async () => {
		const { budgeted } = guard();
		await expect(
			budgeted.fetch("https://api.selected.dev/v1", { method: "POST", body: '{"model": "x"}' }),
		).rejects.toThrow(/enforceable output cap/);
		const unbounded = guard({}, true);
		await unbounded.budgeted.fetch("https://api.selected.dev/v1", {
			method: "POST",
			body: '{"model": "x"}',
		});
		expect(unbounded.budgeted.ledger.enforcedOutputCap).toBe(false);
		expect(unbounded.budgeted.ledger.reservedOutputTokens).toBe(0);
	});

	it("accounts provider-reported usage across wire shapes; absent usage stays null", async () => {
		const replies = [
			'{ "usage" : { "output_tokens" :  7, "input_tokens" :  11 } }',
			'{"usage": {"completion_tokens": 3, "prompt_tokens": 5}}',
			'{"usageMetadata": {"candidatesTokenCount": 2, "promptTokenCount": 4}}',
			'data: {"type":"message_delta","usage":{"output_tokens": 1}}\n\ndata: [DONE]\n\n',
			"{}",
		];
		let index = 0;
		const cycling = Object.assign(
			async () => jsonResponse(replies[index++ % replies.length]),
			{ preconnect() { } },
		) as typeof fetch;
		const { budgeted, readLedger } = guard({ requests: 10, outputTokens: 1000 });
		const local = createBudgetedFetch({
			realFetch: cycling,
			budget: { requests: 10, inputTokens: 100_000, outputTokens: 1000 },
			writeLedger: () => { },
		});
		local.allowedOrigins.add("https://api.selected.dev");
		for (let i = 0; i < 5; i++)
			await local.fetch("https://api.selected.dev/r", {
				method: "POST",
				body: JSON.stringify({ max_tokens: 5 }),
			});
		await local.settle();
		expect(local.ledger.reportedOutputTokens).toBe(7 + 3 + 2 + 1);
		expect(local.ledger.reportedInputTokens).toBe(11 + 5 + 4);
		// The empty {} reply contributed no usage; null-absence never became zero.
		expect(local.ledger.reportedCacheReadTokens).toBeNull();
	});
});

describe("stock SDK through the live guard (loopback, synthetic credentials)", () => {
	it("ModelRuntime completion: over-budget cap refused before the wire; fitting cap and usage reach the ledger", async () => {
		const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
		const received: Array<Record<string, unknown>> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				received.push(JSON.parse(await request.text()) as Record<string, unknown>);
				const chunk = (payload: string) => `data: ${payload}\n\n`;
				const sse =
					chunk(JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "loopback-m1", choices: [{ index: 0, delta: { role: "assistant", content: "loopback-ok" }, finish_reason: null }] })) +
					chunk(JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "loopback-m1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })) +
					"data: [DONE]\n\n";
				return new Response(sse, { headers: { "content-type": "text/event-stream" } });
			},
		});
		const budgeted = createBudgetedFetch({
			realFetch: globalThis.fetch,
			budget: { requests: 5, inputTokens: 100_000, outputTokens: 50 },
			writeLedger: () => { },
		});
		budgeted.allowedOrigins.add(new URL(server.url).origin);
		const previousFetch = globalThis.fetch;
		globalThis.fetch = budgeted.fetch;
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "task-eval-sdk-"));
		const agentDir = path.join(home, ".pi", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "auth.json"),
			JSON.stringify({ "loopback-openai": { type: "api_key", key: "synthetic-key" } }),
			{ mode: 0o600 },
		);
		try {
			const runtime = await ModelRuntime.create({
				authPath: path.join(agentDir, "auth.json"),
				modelsPath: null,
				modelsStorePath: path.join(agentDir, "models-cache.json"),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			runtime.registerProvider("loopback-openai", {
				api: "openai-completions",
				baseUrl: String(server.url),
				models: [
					{
						id: "loopback-m1",
						name: "Loopback M1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8_000,
						maxTokens: 4_096,
					},
				],
			});
			const model = runtime.getModel("loopback-openai", "loopback-m1");
			expect(model).toBeDefined();
			const context = {
				systemPrompt: "loopback",
				messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: Date.now() }],
			};
			// Over the remaining reservation: refused before any byte reaches the server
			// (the SDK wraps the guard's throw as a connection error).
			const refused = await runtime.completeSimple(model!, context, { maxTokens: 4_000 });
			expect(refused.stopReason).toBe("error");
			expect(received).toHaveLength(0);
			expect(budgeted.ledger.requests).toBe(0);
			const message = await runtime.completeSimple(model!, context, { maxTokens: 40 });
			expect(JSON.stringify(message.content)).toContain("loopback-ok");
			await budgeted.settle();
			// The stock SDK wire cap passes unchanged and is reserved exactly.
			const wireCap = received[0].max_completion_tokens ?? received[0].max_tokens ?? received[0].max_output_tokens;
			expect(wireCap).toBe(40);
			expect(budgeted.ledger.requests).toBe(1);
			expect(budgeted.ledger.reservedOutputTokens).toBe(40);
			expect(budgeted.ledger.reportedOutputTokens).toBe(2);
			expect(budgeted.ledger.reportedInputTokens).toBe(5);
			expect(budgeted.ledger.usageCompleteRequests).toBe(1);
		} finally {
			globalThis.fetch = previousFetch;
			server.stop(true);
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	it("expired synthetic OAuth fails closed through stock getAuth: no usable refresh, no credential mutation", async () => {
		const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "task-eval-oauth-"));
		const agentDir = path.join(home, ".pi", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const authFile = path.join(agentDir, "auth.json");
		const expired = {
			anthropic: {
				type: "oauth",
				access: "synthetic-access-token",
				expires: Date.now() - 60_000,
			},
		};
		const originalText = JSON.stringify(expired);
		fs.writeFileSync(authFile, originalText, { mode: 0o600 });
		const previousFetch = globalThis.fetch;
		let blockedAttempts = 0;
		globalThis.fetch = Object.assign(
			async () => {
				blockedAttempts++;
				throw new Error("network blocked by task-eval oauth fixture");
			},
			{ preconnect() { } },
		) as typeof fetch;
		try {
			const runtime = await ModelRuntime.create({
				authPath: authFile,
				modelsPath: null,
				modelsStorePath: path.join(agentDir, "models-cache.json"),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			let rejected = false;
			try {
				await runtime.getAuth("anthropic");
			} catch {
				rejected = true;
			}
			// Behavior, not wording: an expired OAuth credential with no refresh
			// token must not resolve, and the store must be byte-identical.
			expect(rejected).toBe(true);
			// Any credential write is synchronous to the failed refresh path;
			// no timer wait needed to observe the store.
			expect(fs.readFileSync(authFile, "utf8")).toBe(originalText);
			expect(blockedAttempts).toBeGreaterThanOrEqual(0);
		} finally {
			globalThis.fetch = previousFetch;
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});
