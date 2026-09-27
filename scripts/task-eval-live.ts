import fs from "node:fs";
import path from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { BudgetedFetch, BudgetRequestRecord, Capture } from "./task-eval-case.ts";
import { FACTS } from "./task-eval-case.ts";
import { parseMemoryRef } from "../src/infra/memory-ref.ts";

const HeadersSchema = Type.Record(Type.String(), Type.String());
const ModelSchema = Type.Object({ id: Type.String(), headers: Type.Optional(HeadersSchema) });
const OverrideSchema = Type.Object({ headers: Type.Optional(HeadersSchema) });
const ProviderSchema = Type.Object({
	apiKey: Type.Optional(Type.String()),
	headers: Type.Optional(HeadersSchema),
	models: Type.Optional(Type.Array(ModelSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), OverrideSchema)),
});
const ConfigSchema = Type.Object({ providers: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });

/** Live eval accepts frozen literals, never key commands or ambient-env templates. */
function literal(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.startsWith("!") || value.includes("$"))
		throw new Error(`${label} must be a frozen literal (no commands or environment templates)`);
	return value;
}

function literalHeaders(headers: unknown): void {
	if (!headers || typeof headers !== "object") return;
	for (const value of Object.values(headers)) literal(value, "Selected provider header");
}

/** Select before loading the host runtime: unrelated providers/credentials never enter it. */
export function prepareLiveProvider(sourceDir: string, scratchDir: string, selectors: string[]): {
	modelsPath: string | null;
	credentials: CredentialStore;
} {
	const split = selectors.map((selector) => {
		const slash = selector.indexOf("/");
		if (slash < 1 || slash === selector.length - 1) throw new Error("Live model must be provider/model");
		return { provider: selector.slice(0, slash), model: selector.slice(slash + 1) };
	});
	const provider = split[0]?.provider;
	if (!provider || split.some((item) => item.provider !== provider))
		throw new Error("Main and summary models must use the same explicitly selected provider");
	const wanted = new Set(split.map((item) => item.model));
	const configPath = path.join(sourceDir, "models.json");
	const document: unknown = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
	if (!Check(ConfigSchema, document)) throw new Error("Invalid models.json provider map");
	const configured = document.providers?.[provider];
	if (configured !== undefined && !Check(ProviderSchema, configured))
		throw new Error("Invalid selected provider configuration");
	let credential = readStoredCredential(provider, path.join(sourceDir, "auth.json"));
	if (!credential && configured?.apiKey !== undefined)
		credential = { type: "api_key", key: literal(configured.apiKey, "Selected provider API key") };
	if (!credential) throw new Error(`No frozen credential for selected provider ${provider}`);
	if (credential.type === "api_key") {
		// Provider-scoped env can itself invoke credential helpers. This evaluator
		// deliberately requires the resolved key rather than broadening its trust.
		if (credential.env && Object.keys(credential.env).length)
			throw new Error("Live evaluation requires a resolved API key without provider environment helpers");
		credential = { type: "api_key", key: literal(credential.key, "Selected stored API key") };
	} else {
		if (!credential.access || !Number.isFinite(credential.expires) || credential.expires - Date.now() < 30 * 60_000)
			throw new Error("Selected OAuth token expires within 30 minutes; live evaluation never refreshes credentials");
		credential = { ...credential, refresh: "" };
	}
	const frozen = Object.freeze(credential);
	const forbidMutation = async (): Promise<never> => {
		throw new Error("Credential refresh and mutation are disabled in live evaluation");
	};
	const credentials: CredentialStore = {
		async read(id) {
			if (id !== provider) return undefined;
			if (frozen.type === "oauth" && frozen.expires - Date.now() < 10 * 60_000)
				throw new Error("Frozen OAuth token is near expiry; refusing rather than refreshing");
			return frozen;
		},
		async list() { return [{ providerId: provider, type: frozen.type }]; },
		modify: forbidMutation,
		delete: forbidMutation,
	};
	let modelsPath: string | null = null;
	if (configured) {
		const selected = { ...configured };
		delete selected.apiKey; // The secret stays in the read-only in-memory store.
		literalHeaders(selected.headers);
		if (selected.models) {
			selected.models = selected.models.filter((model) => wanted.has(model.id));
			for (const model of selected.models) literalHeaders(model.headers);
		}
		if (selected.modelOverrides) {
			selected.modelOverrides = Object.fromEntries(
				Object.entries(selected.modelOverrides).filter(([id]) => wanted.has(id)),
			);
			for (const model of Object.values(selected.modelOverrides)) literalHeaders(model.headers);
		}
		modelsPath = path.join(scratchDir, "models.json");
		fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: { [provider]: selected } }), { mode: 0o600 });
	}
	return { modelsPath, credentials };
}

/** Snapshot after settle(); absent usage is unknown, not a zero-cost request. */
export function liveUsageReport(guard: BudgetedFetch, firstRecord: number): Record<string, unknown> {
	const records = structuredClone(guard.records.slice(firstRecord));
	const sum = (rows: BudgetRequestRecord[], key: "reportedInputTokens" | "reportedOutputTokens" | "reportedCacheReadTokens" | "reportedCacheWriteTokens") =>
		rows.some((row) => row[key] === null) ? null : rows.reduce((total, row) => total + row[key]!, 0);
	const group = (rows: BudgetRequestRecord[]) => ({
		requests: rows.length,
		input: sum(rows, "reportedInputTokens"),
		output: sum(rows, "reportedOutputTokens"),
		cacheRead: sum(rows, "reportedCacheReadTokens"),
		cacheWrite: sum(rows, "reportedCacheWriteTokens"),
		inputEstimatedTokens: rows.reduce((total, row) => total + row.inputEstimatedTokens, 0),
		reservedOutputTokens: rows.reduce((total, row) => total + row.reservedOutputTokens, 0),
		usageCompleteRequests: rows.filter((row) => row.reportedInputTokens !== null && row.reportedOutputTokens !== null).length,
	});
	return {
		main: group(records.filter((row) => row.requestClass === "main")),
		summary: group(records.filter((row) => row.requestClass === "summary")),
		unknown: group(records.filter((row) => row.requestClass === "unknown")),
		totals: group(records),
		requestLedger: records,
		wholeInvocationLedger: structuredClone(guard.ledger),
		ledgerNotes: [
			"Input guard is a char-derived estimate, not a billed-token hard cap.",
			"Output reservations are full requested wire caps; insufficient remaining budget refuses dispatch rather than shrinking the response.",
			"Reported input/cache fields retain provider semantics; Anthropic input excludes cache read/write. Missing usage stays null.",
			"Per-request elapsedMs covers dispatch through response-body completion; arm latency includes local tool and oracle time.",
			"The SDK fetch guard allows only the selected provider origin. Model tool processes and oracle executions use the filesystem/network sandbox.",
		],
		billing: "unknown-subscription-no-usd-conversion",
	};
}

/** Observe the host result, not the model's prose or the offline script counters. */
export function captureLiveToolResult(capture: Capture, name: string, result: unknown, isError: boolean): string {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content))
		throw new Error("Live tool result has no content array");
	const output = result.content.flatMap((block: unknown) =>
		block && typeof block === "object" && "type" in block && block.type === "text" &&
			"text" in block && typeof block.text === "string" ? [block.text] : [],
	).join("\n");
	const details = "details" in result ? result.details : undefined;
	if (name === "read") {
		capture.fileFactSeen ||= output.includes(FACTS.fileFact);
		capture.constraintSeen ||= output.includes(FACTS.constraint);
	}
	if (name === "grep") {
		capture.grepPreviewHadFacts ||= output.includes(FACTS.grepFact) || output.includes(FACTS.archiveFact);
		capture.artifactRef ||= /artifact-[a-f0-9]{64}/.exec(output)?.[0] ?? "";
	}
	if (name === "bash" && output.includes(FACTS.failure)) capture.failureIsError ||= isError;
	if (name === "smart_compact" && !isError && details && typeof details === "object" &&
		"runId" in details && typeof details.runId === "string" && !capture.stagedRuns.includes(details.runId))
		capture.stagedRuns.push(details.runId);
	if (name === "smart_save_memory" && !isError) {
		const ref = details && typeof details === "object" && "ref" in details && typeof details.ref === "string"
			? details.ref : /\(ref ([^\s)]+)\)/.exec(output)?.[1] ?? "";
		capture.memorySavedRef = parseMemoryRef(ref) ? ref : null;
		capture.memorySaveApproved = capture.memorySavedRef !== null;
	}
	return output;
}
