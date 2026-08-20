/**
 * Phase 4: deterministic verification and repair.
 *
 * Verification findings are structured data. Formatting belongs at the UI/LLM
 * boundary; repair logic switches on `kind` and never reparses its own prose.
 */

import type {
	Model,
	Api,
	ProviderHeaders,
	TextContent,
} from "@earendil-works/pi-ai";
import type {
	CompactionState,
	StructuredExtraction,
	VerificationGap,
	VerificationGateStage,
	VerificationResult,
	LlmMessage,
} from "../types.ts";
import { COMPACT_SYSTEM_PREFIX, LIKELY_ERROR_RE, TRUNC } from "../constants.ts";
import { trackedComplete } from "../utils/cache.ts";
import { getProviderCaps } from "../utils/tokens.ts";
import { extractFileRefs } from "../utils/file-ref-detect.ts";
import {
	buildToolCallIndex,
	extractText,
	isDiagnosticConstraintText,
} from "../utils/extraction.ts";
import {
	buildUniquePathNeedles,
	isKnownPathReference,
	normalizePath,
} from "../utils/file-needles.ts";
import * as log from "../utils/logger.ts";
import {
	buildSummaryPathEvidence,
	parseSummary,
	findSection,
	appendToSection,
	renderSummary,
	summaryEvidenceLine,
	upsertSection,
} from "../domain/summary-parse.ts";
import { canonicalHeading } from "../domain/summary-schema.ts";
import type { CanonicalSummary } from "../domain/summary-schema.ts";
import {
	classifyToolOperation,
	extractToolPath,
	normalizeToolName,
	type ToolOperation,
} from "../domain/tool-semantics.ts";
import { lruGet, lruSet } from "../utils/lru.ts";
import type { SmartCompactServices } from "../infra/services.ts";
export interface VerificationEvidence {
	sourceMessages?: readonly LlmMessage[];
	steering?: { focus?: string; note?: string };
	summaryBudgetTokens?: number;
}

const HIGH_RISK_OUTCOME_RE =
	/(?:\ball\s+tests?\s+(?:pass|passed|passing)\b|\btests?\s+(?:pass|passed|passing)\b|\b(?:build|deployment|migration)\s+(?:completed|succeeded|passed|successful)\b|\b(?:deployed|published|released)\b|\b(?:bug|issue|error)\s+(?:fixed|resolved)\b|\bno\s+(?:errors?|failures?)\b|\bcompleted successfully\b|\btestler?\s+(?:geçti|başarılı)\b|\bbaşarıyla\s+(?:tamamlandı|dağıtıldı|yayınlandı)\b|\b(?:deploy edildi|yayınlandı|hata yok)\b)/iu;
const NEGATED_OUTCOME_RE =
	/\b(?:not|never|pending|failed|failing|unresolved|henüz|değil|başarısız)\b/iu;
const NONE_BLOCKER_VALUE_RE =
	/^(?:none|no blockers?|yok)\s*(?:recorded|known)?[.!]?$/i;
const BULLET_NONE_BLOCKER_RE =
	/^(?:[-*+]|\d+[.)])\s+(?:none|no blockers?|yok)\s*(?:recorded|known)?[.!]?$/i;
const PATH_PLACEHOLDER_RE = /^(?:none|none recorded|no blockers?|yok)[.!]?$/i;

function noneBlockerLineIndexes(lines: readonly string[]): Set<number> {
	const indexes = new Set<number>();
	const nonEmpty = lines
		.map((line, index) => ({ index, text: line.trim() }))
		.filter((item) => item.text);
	for (const item of nonEmpty) {
		if (BULLET_NONE_BLOCKER_RE.test(item.text)) indexes.add(item.index);
	}
	if (nonEmpty.length === 1 && NONE_BLOCKER_VALUE_RE.test(nonEmpty[0].text)) {
		indexes.add(nonEmpty[0].index);
	}
	return indexes;
}

interface ListedPathEvidence {
	values: Set<string>;
	encodedValues: Set<string>;
	normalizedValues: Set<string>;
}

function collectListedPaths(
	body: string,
	expectedPaths: ReadonlySet<string>,
): ListedPathEvidence {
	const values = new Set<string>();
	const encodedValues = new Set<string>();
	for (const line of body.split("\n")) {
		const raw = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
		if (!raw) continue;
		if (raw.startsWith('"')) {
			try {
				const decoded = JSON.parse(raw);
				if (typeof decoded === "string") {
					values.add(decoded);
					encodedValues.add(decoded);
					continue;
				}
			} catch {
				// A model may emit an unquoted legacy path beginning with `"`.
			}
		}
		values.add(raw);
		if (expectedPaths.has(raw)) continue;
		const unwrapped =
			raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
		const unchecked = unwrapped.replace(/^\[[ x]\]\s+/i, "");
		if (expectedPaths.has(unchecked)) values.add(unchecked);
	}
	return {
		values,
		encodedValues,
		normalizedValues: new Set(Array.from(values, normalizePath)),
	};
}

function decodePathDisplay(display: string): string {
	try {
		const decoded = JSON.parse(display);
		return typeof decoded === "string" ? decoded : display;
	} catch {
		return display;
	}
}

function hasListedPath(
	listed: ListedPathEvidence,
	file: string,
	display: string,
	normalizedOwners: ReadonlyMap<string, number>,
): boolean {
	const decodedDisplay = decodePathDisplay(display);
	if (listed.encodedValues.has(decodedDisplay)) return true;
	if (PATH_PLACEHOLDER_RE.test(file)) return false;
	if (listed.values.has(file)) return true;
	for (const candidate of [file, decodedDisplay]) {
		const normalized = normalizePath(candidate);
		if (
			normalizedOwners.get(normalized) === 1 &&
			listed.normalizedValues.has(normalized)
		)
			return true;
	}
	return false;
}

function outcomeClaims(summary: string): string[] {
	return Array.from(
		new Set(
			summary
				.split(/\r?\n/)
				.map((line) =>
					line
						.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
						.replace(/^\[[ x]\]\s+/i, "")
						.trim(),
				)
				.filter((line) => line.length > 0 && !line.startsWith("#"))
				.filter((line) => HIGH_RISK_OUTCOME_RE.test(line))
				.filter(
					(line) =>
						/\bno\s+(?:errors?|failures?)\b/i.test(line) ||
						!NEGATED_OUTCOME_RE.test(line),
				),
		),
	).slice(0, 12);
}

function classifyOutcomeClaim(
	claim: string,
): "test" | "build" | "release" | "error" | "file" | "generic" {
	const lower = claim.toLowerCase();
	if (/\btests?\b|\btestler?\b/.test(lower)) return "test";
	if (/\bbuild\b|\bcompil(?:e|ed|ation)\b|\btypecheck\b/.test(lower))
		return "build";
	if (/\bdeploy(?:ed|ment)?\b|\bpublish(?:ed)?\b|\breleas(?:e|ed)\b/.test(lower))
		return "release";
	if (/\bbug\b|\bissue\b|\berror\b|\bfail(?:ed|ure)?\b|\bhata\b/.test(lower))
		return "error";
	if (/\bfile\b|\bdosya\b/.test(lower)) return "file";
	return "generic";
}

interface SuccessfulToolEvidence {
	name: string;
	operation: ToolOperation;
	command: string;
	path?: string;
	result: string;
}

const successfulToolEvidenceCache = new WeakMap<
	readonly LlmMessage[],
	SuccessfulToolEvidence[]
>();
const sourceTextCache = new WeakMap<readonly LlmMessage[], string[]>();

function sourceSupportsFileReference(
	ref: string,
	messages: readonly LlmMessage[],
): boolean {
	let texts = sourceTextCache.get(messages);
	if (!texts) {
		texts = messages.map((message) =>
			extractText(message.content).replace(/\\/g, "/").toLowerCase(),
		);
		sourceTextCache.set(messages, texts);
	}
	const needle = ref.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
	if (!needle) return false;
	for (const text of texts) {
		let index = text.indexOf(needle);
		while (index >= 0) {
			const before = text[index - 1] ?? "";
			const after = text[index + needle.length] ?? "";
			if ((!before || !/[\w.-]/.test(before)) && (!after || !/[\w.-]/.test(after)))
				return true;
			index = text.indexOf(needle, index + 1);
		}
	}
	return false;
}

function successfulToolEvidence(
	messages: readonly LlmMessage[],
): SuccessfulToolEvidence[] {
	const cached = successfulToolEvidenceCache.get(messages);
	if (cached) return cached;
	const toolCalls = buildToolCallIndex(messages);
	const evidence: SuccessfulToolEvidence[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || message.isError) continue;
		const call = toolCalls.get(message.toolCallId ?? "");
		if (!call) continue;
		const result = extractText(message.content).slice(0, 8_000);
		if (!result.trim() || LIKELY_ERROR_RE.test(result)) continue;
		const command =
			[call.arguments.command, call.arguments.cmd, call.arguments.script].find(
				(value): value is string => typeof value === "string",
			) ?? "";
		evidence.push({
			name: normalizeToolName(call.name),
			operation: classifyToolOperation(call.arguments, call.name),
			command,
			path: extractToolPath(call.arguments),
			result,
		});
	}
	successfulToolEvidenceCache.set(messages, evidence);
	return evidence;
}

function successfulToolSupportsClaim(
	claim: string,
	tools: readonly SuccessfulToolEvidence[],
	extraction: StructuredExtraction,
): boolean {
	const shape = semanticShape(claim);
	const category = classifyOutcomeClaim(claim);
	if (
		category === "error" &&
		extraction.errors.some(
			(error) => error.resolved && hasSemanticEvidence(claim, error.message),
		)
	)
		return true;
	if (
		category === "file" &&
		extraction.modifiedFiles.some((file) =>
			claim.toLowerCase().includes(file.path.toLowerCase()),
		)
	)
		return true;

	// A result can prove only the operation that produced it. This rejects, for
	// example, "All tests passed" text returned by a read/search tool.
	for (const tool of tools) {
		const operationText = tool.name + " " + tool.command;
		const operationSupports =
			category === "test"
				? /\b(?:test|tests|pytest|jest|vitest|mocha|rspec)\b/i.test(operationText)
				: category === "build"
					? /\b(?:build|compile|typecheck|tsc|check)\b/i.test(operationText)
					: category === "release"
						? /\b(?:deploy|publish|release)\b/i.test(operationText)
						: category === "file"
							? tool.operation === "mutate" || tool.operation === "delete"
							: category === "error"
								? tool.operation === "execute" ||
									tool.operation === "mutate" ||
									tool.operation === "delete"
								: tool.operation !== "read" &&
									tool.operation !== "search" &&
									tool.operation !== "list";
		if (!operationSupports) continue;
		if (hasSemanticEvidence(claim, tool.result)) return true;
		const lower = tool.result.toLowerCase();
		if (
			category === "test" &&
			/\b\d+\s+(?:tests?\s+)?pass(?:ed)?\b/.test(lower) &&
			!/\b(?:fail(?:ed|ures?)?|errors?)\s*[:=]?\s*[1-9]\d*\b/.test(lower)
		)
			return true;
		if (
			category === "build" &&
			/\b(?:succeeded|successful|passed|exit(?:ed)?\s+(?:code\s+)?0)\b/.test(lower)
		)
			return true;
		if (
			category === "release" &&
			/\b(?:succeeded|successful|completed|published|deployed|released)\b/.test(
				lower,
			)
		)
			return true;
		if (
			category === "error" &&
			shape.concepts.length > 0 &&
			/\b(?:fixed|resolved|passed|succeeded|successful)\b/.test(lower) &&
			hasSemanticEvidence(claim, tool.result)
		)
			return true;
	}
	return false;
}

function removeUnsupportedClaim(
	summary: CanonicalSummary,
	claim: string,
): CanonicalSummary {
	const normalized = claim.replace(/\s+/g, " ").trim().toLocaleLowerCase();
	return {
		sections: summary.sections.map((section) => ({
			...section,
			body: section.body
				.split("\n")
				.filter((line) => {
					const candidate = line
						.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
						.replace(/^\[[ x]\]\s+/i, "")
						.replace(/\s+/g, " ")
						.trim()
						.toLocaleLowerCase();
					return candidate !== normalized;
				})
				.join("\n")
				.trim(),
		})),
	};
}

export function formatVerificationGap(gap: VerificationGap): string {
	switch (gap.kind) {
		case "missing-section":
			return "Missing section: " + canonicalHeading(gap.section);
		case "missing-file":
			return "Missing modified file: " + gap.path;
		case "missing-read-file":
			return "Missing read file: " + gap.path;
		case "missing-deleted-file":
			return "Missing deleted file: " + gap.path;
		case "missing-error":
			return (
				(gap.resolved ? "Missing resolved error history: " : "Missing error: ") +
				gap.message.slice(0, TRUNC.SNIPPET)
			);
		case "missing-constraint":
			return "Missing constraint: " + gap.text.slice(0, TRUNC.TOPIC_LABEL);
		case "missing-decision":
			return "Missing decision: " + gap.summary.slice(0, TRUNC.TOPIC_LABEL);
		case "missing-goal":
			return "Main goal may be missing from summary";
		case "fabricated-file":
			return "Potentially fabricated file: " + gap.ref;
		case "inconsistency":
			return "Inconsistency: " + gap.detail;
		case "missing-open-loops":
			return (
				"Missing Open Loops section despite " +
				gap.unresolvedCount +
				" unresolved errors"
			);
		case "unsupported-claim":
			return "Unsupported outcome claim: " + gap.claim.slice(0, TRUNC.SNIPPET);
	}
}

export function verificationFailureMessage(
	result: VerificationResult,
): string | null {
	if (result.ok) return null;
	const findings = result.gaps
		.slice(0, 3)
		.map((gap) => formatVerificationGap(gap).replace(/\s+/g, " ").slice(0, 160))
		.join("; ");
	return (
		"Verification gate rejected summary (" +
		result.score +
		"/100, " +
		result.gaps.length +
		(result.gaps.length === 1 ? " unresolved gap)" : " unresolved gaps)") +
		(findings ? ": " + findings : "")
	);
}

/** Content-free diagnostics survive the throw without leaking evidence to telemetry. */
export class VerificationGateError extends Error {
	readonly score: number;
	readonly initialScore: number;
	readonly gapKinds: VerificationGap["kind"][];
	readonly stage: VerificationGateStage;
	readonly gapCount: number;

	constructor(
		result: VerificationResult,
		initialScore: number,
		stage: VerificationGateStage,
	) {
		super(
			verificationFailureMessage(result) ?? "Verification gate rejected summary",
		);
		this.name = "VerificationGateError";
		this.score = result.score;
		this.initialScore = initialScore;
		this.stage = stage;
		this.gapKinds = Array.from(new Set(result.gaps.map((gap) => gap.kind)));
		this.gapCount = result.gaps.length;
	}
}

const NEGATION_MARKERS = new Set([
	"no",
	"not",
	"never",
	"without",
	"avoid",
	"forbidden",
	"prohibit",
	"değil",
	"asla",
	"olmadan",
	"yasak",
	"hayır",
]);
const CONDITION_MARKERS = new Set([
	"only",
	"after",
	"before",
	"with",
	"requir",
	"until",
	"sadece",
	"sonra",
	"önce",
	"gerekli",
	"gerektirir",
]);
const POLARITY_INVERTING_GUARDS = new Set([
	"skip",
	"skipp",
	"forget",
	"forgett",
	"omit",
	"omitt",
	"neglect",
	"fail",
	"avoid",
]);
const SEMANTIC_STOP = new Set([
	"the",
	"and",
	"that",
	"this",
	"with",
	"from",
	"into",
	"must",
	"should",
	"only",
	"after",
	"before",
	"without",
	"never",
	"not",
	"does",
	"have",
	"için",
	"ile",
	"sonra",
	"önce",
	"sadece",
	"asla",
	"değil",
	"olmadan",
]);

// Turkish suffix stripping (coarse): unifies common inflections so a
// constraint "dosyayı sil" still matches a summary "dosyası silindi".
// Longest first; the ≥4-char stem guard also protects short English words
// ("code", "side") from the 2-letter suffixes.
const TR_SUFFIXES = [
	"ları",
	"leri",
	"ının",
	"inin",
	"unun",
	"ünün",
	"ında",
	"inde",
	"unda",
	"ünde",
	"mış",
	"miş",
	"muş",
	"müş",
	"lar",
	"ler",
	"ını",
	"ini",
	"unu",
	"ünü",
	"ına",
	"ine",
	"una",
	"üne",
	"dan",
	"den",
	"tan",
	"ten",
	"dır",
	"dir",
	"dur",
	"dür",
	"tır",
	"tir",
	"tur",
	"tür",
	"yor",
	"mak",
	"mek",
	"da",
	"de",
	"ta",
	"te",
	"dı",
	"di",
	"du",
	"dü",
	"tı",
	"ti",
	"tu",
	"tü",
	"ın",
	"in",
	"un",
	"ün",
	"sa",
	"se",
] as const;

function stemToken(token: string): string {
	const lower = token.toLocaleLowerCase();
	for (const suffix of TR_SUFFIXES) {
		if (lower.length >= 4 + suffix.length && lower.endsWith(suffix)) {
			return lower.slice(0, -suffix.length);
		}
	}
	if (lower.length > 6 && lower.endsWith("ing")) return lower.slice(0, -3);
	if (lower.length > 5 && lower.endsWith("ed")) return lower.slice(0, -2);
	if (lower.length > 5 && lower.endsWith("es")) return lower.slice(0, -2);
	if (lower.length > 4 && lower.endsWith("s")) return lower.slice(0, -1);
	return lower;
}

function semanticTokens(text: string): string[] {
	return (text.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [])
		.map(stemToken)
		.filter((token) => token.length > 2);
}

interface SemanticShape {
	sourceTokens: string[];
	concepts: string[];
	anchor: string;
	negative: boolean;
	conditional: boolean;
}

const semanticShapeCache = new Map<string, SemanticShape>();
const semanticFragmentCache = new Map<string, string[][]>();

function semanticFragments(text: string): string[][] {
	const cached = lruGet(semanticFragmentCache, text);
	if (cached) return cached;
	const fragments = Array.from(
		new Set(
			text
				.split(/\r?\n/)
				.flatMap((line) => [line, ...line.split(/[.;]/)])
				.map((part) => part.replace(/^\s*[-*\d.)]+\s*/, "").trim())
				.filter(Boolean),
		),
	).map(semanticTokens);
	lruSet(semanticFragmentCache, text, fragments, 256);
	return fragments;
}

function hasNearbyMarker(
	tokens: string[],
	anchor: string,
	markers: Set<string>,
): boolean {
	return tokens.some(
		(token, index) =>
			token === anchor &&
			tokens
				.slice(Math.max(0, index - 2), index + 3)
				.some((near) => markers.has(near)),
	);
}

function hasEffectiveTargetNegation(tokens: string[], anchor: string): boolean {
	return tokens.some((token, anchorIndex) => {
		if (token !== anchor) return false;
		const nearbyStart = Math.max(0, anchorIndex - 2);
		const nearbyNegations = tokens
			.slice(nearbyStart, anchorIndex + 3)
			.map((near, offset) =>
				NEGATION_MARKERS.has(near) ? nearbyStart + offset : -1,
			)
			.filter((index) => index >= 0);
		const governingStart = Math.max(0, anchorIndex - 3);
		const preceding = tokens.slice(governingStart, anchorIndex);
		const nearbyGuards = preceding
			.map((near, offset) =>
				POLARITY_INVERTING_GUARDS.has(near) ? governingStart + offset : -1,
			)
			.filter((index) => index >= 0);
		const governingIndex = preceding.findIndex(
			(near, offset) =>
				NEGATION_MARKERS.has(near) &&
				POLARITY_INVERTING_GUARDS.has(preceding[offset + 1] ?? ""),
		);
		if (governingIndex < 0)
			return nearbyNegations.length > 0 || nearbyGuards.length > 0;

		const absoluteGoverningIndex = governingStart + governingIndex;
		const guardIndex = absoluteGoverningIndex + 1;
		const nested = tokens
			.slice(guardIndex + 1, anchorIndex)
			.some(
				(inner) =>
					NEGATION_MARKERS.has(inner) || POLARITY_INVERTING_GUARDS.has(inner),
			);
		return (
			nested ||
			nearbyNegations.some(
				(index) => index !== absoluteGoverningIndex && index !== guardIndex,
			) ||
			nearbyGuards.some((index) => index !== guardIndex)
		);
	});
}

/** Conservative deterministic semantic evidence for goals/constraints/decisions. */
function semanticShape(source: string): SemanticShape {
	const cached = lruGet(semanticShapeCache, source);
	if (cached) return cached;
	const sourceTokens = semanticTokens(source);
	const concepts = Array.from(
		new Set(
			sourceTokens.filter(
				(token) =>
					!/^\d+$/.test(token) &&
					!SEMANTIC_STOP.has(token) &&
					!NEGATION_MARKERS.has(token) &&
					!CONDITION_MARKERS.has(token),
			),
		),
	);
	const negative = sourceTokens.some((token) => NEGATION_MARKERS.has(token));
	const conditional = sourceTokens.some((token) => CONDITION_MARKERS.has(token));
	const anchor =
		concepts.find((concept) =>
			hasNearbyMarker(sourceTokens, concept, NEGATION_MARKERS),
		) ??
		concepts[0] ??
		"";
	const shape = { sourceTokens, concepts, anchor, negative, conditional };
	lruSet(semanticShapeCache, source, shape, 512);
	return shape;
}

function hasSemanticEvidence(source: string, target: string): boolean {
	const { sourceTokens, concepts, anchor, negative, conditional } =
		semanticShape(source);
	if (!concepts.length) return true;
	const required = Math.min(
		concepts.length,
		Math.max(1, Math.ceil(concepts.length * 0.6)),
	);
	return semanticFragments(target).some((tokens) => {
		const overlap = concepts.filter((concept) => tokens.includes(concept)).length;
		if (overlap < required) return false;
		const targetNegative = hasEffectiveTargetNegation(tokens, anchor);
		if (negative && !targetNegative) {
			// A conditional prohibition ("do not X without Y") may be faithfully
			// restated positively as "X only after/with Y".
			const conditionalRestatement =
				sourceTokens.includes("without") &&
				tokens.some((token) => CONDITION_MARKERS.has(token)) &&
				overlap >= Math.min(2, concepts.length);
			if (!conditionalRestatement) return false;
		}
		if (!negative && targetNegative) return false;
		if (
			conditional &&
			!negative &&
			!tokens.some((token) => CONDITION_MARKERS.has(token))
		)
			return false;
		return true;
	});
}

function hasSemanticContradiction(source: string, target: string): boolean {
	const { sourceTokens, concepts, anchor, negative, conditional } =
		semanticShape(source);
	if (!anchor) return false;
	const required = Math.min(
		concepts.length,
		Math.max(1, Math.ceil(concepts.length * 0.6)),
	);
	return semanticFragments(target).some((tokens) => {
		if (!tokens.includes(anchor)) return false;
		const overlap = concepts.filter((concept) => tokens.includes(concept)).length;
		// Sharing a generic anchor such as "release" or "file" is not enough:
		// another constraint in the same section must overlap the actual concepts.
		if (overlap < required) return false;
		const targetNegative = hasEffectiveTargetNegation(tokens, anchor);
		if (negative && !targetNegative) {
			const validConditional =
				sourceTokens.includes("without") &&
				tokens.some((token) => CONDITION_MARKERS.has(token)) &&
				overlap >= Math.min(2, concepts.length);
			return !validConditional;
		}
		if (!negative && targetNegative) return true;
		return (
			conditional &&
			!negative &&
			!tokens.some((token) => CONDITION_MARKERS.has(token))
		);
	});
}

export function isDeterministicallyPatchable(gap: VerificationGap): boolean {
	if (gap.kind === "fabricated-file") return true;
	if (gap.kind === "inconsistency")
		return gap.detail.startsWith("blocked-none:");
	return true;
}

/** Apply safe repairs to a fixed point; newly introduced patchable gaps get another bounded pass. */
export function repairSummaryDeterministically(
	summary: string,
	result: VerificationResult,
	extraction: StructuredExtraction,
	continuity: CompactionState | null = null,
	evidence: VerificationEvidence = {},
	maxRounds = 3,
): { summary: string; result: VerificationResult; patched: VerificationGap[] } {
	const patched: VerificationGap[] = [];
	const seen = new Set<string>();
	for (let round = 0; round < maxRounds; round++) {
		const patchable = result.gaps.filter(isDeterministicallyPatchable);
		if (!patchable.length) break;
		const next = patchDeterministic(
			summary,
			patchable,
			extraction,
			continuity,
			evidence,
		);
		if (next === summary) break;
		for (const gap of patchable) {
			const key = formatVerificationGap(gap);
			if (!seen.has(key)) {
				seen.add(key);
				patched.push(gap);
			}
		}
		summary = next;
		result = verifySummary(summary, extraction, continuity, evidence);
	}
	return { summary, result, patched };
}

interface VerificationAccumulator {
	gaps: VerificationGap[];
	score: number;
}

interface CollectedVerificationEvidence {
	unresolved: Array<{ message: string }>;
	resolved: Array<{ message: string }>;
	constraints: Array<{ text: string }>;
	decisions: Array<{ summary: string }>;
	goal: string | null;
}

interface PathVerificationData {
	modified: string[];
	read: string[];
	deleted: string[];
	rendered: ReadonlyMap<string, string>;
}

function addGap(
	accumulator: VerificationAccumulator,
	gap: VerificationGap,
	penalty: number,
): void {
	accumulator.gaps.push(gap);
	accumulator.score -= penalty;
}

function uniqueByText<T>(items: T[], text: (item: T) => string): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = text(item).toLowerCase().replace(/\s+/g, " ").trim();
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function collectVerificationEvidence(
	extraction: StructuredExtraction,
	continuity: CompactionState | null,
	evidence: VerificationEvidence,
): CollectedVerificationEvidence {
	const unresolved = uniqueByText(
		[
			...extraction.errors.flatMap((error) =>
				!error.resolved ? [{ message: error.message }] : [],
			),
			...(continuity?.unresolvedErrors ?? []).map((error) => ({
				message: error.message,
			})),
		],
		(item) => item.message,
	);
	const resolved = uniqueByText(
		[
			...extraction.errors.flatMap((error) =>
				error.resolved ? [{ message: error.message }] : [],
			),
			...(continuity?.resolvedErrors ?? []).map((error) => ({
				message: error.message,
			})),
		],
		(item) => item.message,
	).slice(-5);
	const steeringConstraints: Array<{ text: string }> = [];
	if (evidence.steering?.focus?.trim()) {
		steeringConstraints.push({
			text: "Preserve detail about: " + evidence.steering.focus,
		});
	}
	if (evidence.steering?.note?.trim()) {
		steeringConstraints.push({ text: evidence.steering.note });
	}
	const constraints = uniqueByText(
		[
			...extraction.constraints.flatMap((item) =>
				item.confidence >= 0.8 ? [{ text: item.text }] : [],
			),
			...(continuity?.constraints ?? []).flatMap((item) =>
				item.confidence >= 0.8 ? [{ text: item.text }] : [],
			),
			...steeringConstraints,
		],
		(item) => item.text,
	).filter((item) => !isDiagnosticConstraintText(item.text));
	const decisions = uniqueByText(
		[
			...extraction.decisions.flatMap((item) =>
				item.type === "explicit" ? [{ summary: item.summary }] : [],
			),
			...(continuity?.decisions ?? []).flatMap((item) =>
				item.type === "explicit" ? [{ summary: item.summary }] : [],
			),
		],
		(item) => item.summary,
	);
	return {
		unresolved,
		resolved,
		constraints,
		decisions,
		goal: extraction.mainGoal ?? continuity?.goal ?? null,
	};
}

function verifyRequiredSections(
	parsed: CanonicalSummary,
	accumulator: VerificationAccumulator,
): void {
	const required = [
		{ kind: "goal", penalty: 5 },
		{ kind: "progress", penalty: 5 },
		{ kind: "critical-context", penalty: 3 },
	] as const;
	for (const item of required) {
		if (!findSection(parsed, item.kind)) {
			addGap(
				accumulator,
				{ kind: "missing-section", section: item.kind },
				item.penalty,
			);
		}
	}
}

function verifyPathCoverage(
	parsed: CanonicalSummary,
	extraction: StructuredExtraction,
	continuity: CompactionState | null,
	evidence: VerificationEvidence,
	accumulator: VerificationAccumulator,
): PathVerificationData {
	const modified = extraction.modifiedFiles.map((file) => file.path);
	const read = extraction.readFiles;
	const deleted = Array.from(
		new Set([...extraction.deletedFiles, ...(continuity?.deletedFiles ?? [])]),
	);
	const required = [...modified, ...read, ...deleted];
	const expected = new Set(required);
	const rendered = buildSummaryPathEvidence(
		required,
		evidence.summaryBudgetTokens,
	);
	const ownerSets = new Map<string, Set<string>>();
	for (const file of required) {
		const display = rendered.get(file);
		for (const candidate of [
			file,
			...(display ? [decodePathDisplay(display)] : []),
		]) {
			const normalized = normalizePath(candidate);
			const owners = ownerSets.get(normalized) ?? new Set<string>();
			owners.add(file);
			ownerSets.set(normalized, owners);
		}
	}
	const ownerCounts = new Map(
		Array.from(ownerSets, ([file, owners]) => [file, owners.size]),
	);
	const listed = (
		kind: "files-modified" | "files-read" | "files-deleted",
	): ListedPathEvidence =>
		collectListedPaths(findSection(parsed, kind)?.body ?? "", expected);
	const modifiedListed = listed("files-modified");
	const readListed = listed("files-read");
	const deletedListed = listed("files-deleted");
	for (const file of modified) {
		const display = rendered.get(file);
		if (display && !hasListedPath(modifiedListed, file, display, ownerCounts)) {
			addGap(accumulator, { kind: "missing-file", path: file }, 5);
		}
	}
	for (const file of read) {
		const display = rendered.get(file);
		if (display && !hasListedPath(readListed, file, display, ownerCounts)) {
			addGap(accumulator, { kind: "missing-read-file", path: file }, 5);
		}
	}
	for (const file of deleted) {
		const display = rendered.get(file);
		if (display && !hasListedPath(deletedListed, file, display, ownerCounts)) {
			addGap(accumulator, { kind: "missing-deleted-file", path: file }, 5);
		}
	}
	return { modified, read, deleted, rendered };
}

function verifyErrorEvidence(
	normalizedSummary: string,
	collected: CollectedVerificationEvidence,
	accumulator: VerificationAccumulator,
): void {
	for (const error of collected.unresolved) {
		const snippet = summaryEvidenceLine(error.message, TRUNC.ERROR_SNIPPET)
			.toLowerCase()
			.replace(/\\/g, "/");
		if (snippet.length > 5 && !normalizedSummary.includes(snippet)) {
			addGap(accumulator, { kind: "missing-error", message: error.message }, 5);
		}
	}
	for (const error of collected.resolved) {
		const snippet = summaryEvidenceLine(error.message, TRUNC.ERROR_SNIPPET)
			.toLowerCase()
			.replace(/\\/g, "/");
		if (snippet.length > 5 && !normalizedSummary.includes(snippet)) {
			addGap(
				accumulator,
				{ kind: "missing-error", message: error.message, resolved: true },
				2,
			);
		}
	}
}

function verifySemanticCoverage(
	parsed: CanonicalSummary,
	collected: CollectedVerificationEvidence,
	accumulator: VerificationAccumulator,
): void {
	const constraintTarget = [
		findSection(parsed, "constraints")?.body ?? "",
		findSection(parsed, "critical-context")?.body ?? "",
	].join("\n");
	for (const constraint of collected.constraints) {
		if (!hasSemanticEvidence(constraint.text, constraintTarget)) {
			addGap(accumulator, { kind: "missing-constraint", text: constraint.text }, 8);
		}
		if (hasSemanticContradiction(constraint.text, constraintTarget)) {
			addGap(accumulator, {
				kind: "inconsistency",
				detail: "semantic-contradiction: constraint contradicts "
					+ constraint.text.slice(0, TRUNC.SNIPPET),
			}, 20);
		}
	}
	if (collected.goal) {
		const goalTarget = findSection(parsed, "goal")?.body ?? "";
		if (!hasSemanticEvidence(collected.goal, goalTarget)) {
			addGap(accumulator, { kind: "missing-goal", goal: collected.goal }, 12);
		}
		if (hasSemanticContradiction(collected.goal, goalTarget)) {
			addGap(accumulator, {
				kind: "inconsistency",
				detail: "semantic-contradiction: goal polarity or condition changed",
			}, 20);
		}
	}
	const decisionBody = findSection(parsed, "decisions")?.body ?? "";
	for (const decision of collected.decisions) {
		if (!hasSemanticEvidence(decision.summary, decisionBody)) {
			addGap(accumulator, { kind: "missing-decision", summary: decision.summary }, 8);
		}
		if (hasSemanticContradiction(decision.summary, decisionBody)) {
			addGap(accumulator, {
				kind: "inconsistency",
				detail: "semantic-contradiction: decision contradicts "
					+ decision.summary.slice(0, TRUNC.SNIPPET),
			}, 20);
		}
	}
}

function verifyFileReferences(
	summary: string,
	extraction: StructuredExtraction,
	continuity: CompactionState | null,
	evidence: VerificationEvidence,
	collected: CollectedVerificationEvidence,
	paths: PathVerificationData,
	accumulator: VerificationAccumulator,
): void {
	const groundedEvidence = [
		...collected.unresolved.map((item) => item.message),
		...collected.resolved.map((item) => item.message),
		...collected.constraints.map((item) => item.text),
		...collected.decisions.map((item) => item.summary),
		...(collected.goal ? [collected.goal] : []),
		...extraction.lastUserMessages,
		...extraction.timeline.map((item) => item.summary),
		...extraction.topics.map((item) => item.primaryFile ?? ""),
		...(continuity?.openLoops.map((item) => item.summary) ?? []),
		...(continuity?.criticalContext ?? []),
	];
	const groundedFiles = groundedEvidence
		.flatMap((value) => [
			value,
			summaryEvidenceLine(value, TRUNC.ERROR_SNIPPET),
			summaryEvidenceLine(value, TRUNC.TOPIC_LABEL),
			summaryEvidenceLine(value, TRUNC.PREVIEW),
			summaryEvidenceLine(value, TRUNC.MESSAGE),
		])
		.flatMap(extractFileRefs);
	const renderedPaths = Array.from(paths.rendered.values()).flatMap((line) => [
		decodePathDisplay(line),
		line.startsWith('"') && line.endsWith('"') ? line.slice(1, -1) : line,
	]);
	const knownFiles = Array.from(new Set([
		...paths.modified,
		...paths.read,
		...paths.deleted,
		...(extraction.referencedFiles ?? []),
		...groundedFiles,
		...renderedPaths,
		...renderedPaths.flatMap(extractFileRefs),
		...(continuity?.modifiedFiles ?? []),
		...(continuity?.readFiles ?? []),
		...(continuity?.unresolvedErrors ?? []).flatMap((error) => error.files),
		...(continuity?.openLoops ?? []).flatMap((loop) => loop.files),
	]));
	for (const ref of new Set(extractFileRefs(summary))) {
		const grounded = isKnownPathReference(ref, knownFiles)
			|| Boolean(evidence.sourceMessages
				&& sourceSupportsFileReference(ref, evidence.sourceMessages));
		if (!grounded) addGap(accumulator, { kind: "fabricated-file", ref }, 4);
	}
}

function verifyProgressConsistency(
	parsed: CanonicalSummary,
	extraction: StructuredExtraction,
	collected: CollectedVerificationEvidence,
	paths: PathVerificationData,
	accumulator: VerificationAccumulator,
): void {
	const progress = findSection(parsed, "progress");
	if (!progress) return;
	const done = progress.body.match(/###\s*Done[\s\S]*?(?=###|$)/i)?.[0] ?? "";
	const blocked = progress.body.match(/###\s*Blocked[\s\S]*?(?=###|$)/i)?.[0] ?? "";
	if (collected.unresolved.length > 0
		&& noneBlockerLineIndexes(blocked.split(/\r?\n/).slice(1)).size > 0) {
		addGap(accumulator, {
			kind: "inconsistency",
			detail: "blocked-none: Blocked says none despite unresolved errors",
		}, 12);
	}
	const doneRefs = new Set(extractFileRefs(done).map(normalizePath));
	for (const file of extraction.modifiedFiles) {
		const needles = buildUniquePathNeedles(file.path, paths.modified);
		if (!needles.some((needle) => doneRefs.has(normalizePath(needle)))) continue;
		const unresolved = collected.unresolved.find((error) => {
			const firstLine = error.message.split(/\r?\n/, 1)[0] ?? "";
			const refs = extractFileRefs(firstLine).map(normalizePath);
			return needles.some((needle) => refs.includes(normalizePath(needle)));
		});
		if (unresolved) {
			addGap(accumulator, {
				kind: "inconsistency",
				detail: file.path + " marked Done but has unresolved error",
			}, 5);
		}
	}
}

function verifyOpenLoopsAndClaims(
	summary: string,
	parsed: CanonicalSummary,
	extraction: StructuredExtraction,
	continuity: CompactionState | null,
	evidence: VerificationEvidence,
	collected: CollectedVerificationEvidence,
	accumulator: VerificationAccumulator,
): void {
	const unresolvedCount = collected.unresolved.length
		+ (continuity?.openLoops.filter((loop) => loop.status !== "resolved").length ?? 0);
	if (unresolvedCount >= 1
		&& !findSection(parsed, "open-loops")
		&& !summary.toLowerCase().replace(/\\/g, "/").includes("unresolved")) {
		addGap(accumulator, { kind: "missing-open-loops", unresolvedCount }, 5);
	}
	if (!evidence.sourceMessages) return;
	const tools = successfulToolEvidence(evidence.sourceMessages);
	for (const claim of outcomeClaims(summary)) {
		if (!successfulToolSupportsClaim(claim, tools, extraction)) {
			addGap(accumulator, { kind: "unsupported-claim", claim }, 20);
		}
	}
}

export function verifySummary(
	summary: string,
	extraction: StructuredExtraction,
	continuity: CompactionState | null = null,
	evidence: VerificationEvidence = {},
): VerificationResult {
	const parsed = parseSummary(summary);
	const accumulator: VerificationAccumulator = { gaps: [], score: 100 };
	const collected = collectVerificationEvidence(extraction, continuity, evidence);
	verifyRequiredSections(parsed, accumulator);
	const paths = verifyPathCoverage(
		parsed,
		extraction,
		continuity,
		evidence,
		accumulator,
	);
	verifyErrorEvidence(
		summary.toLowerCase().replace(/\\/g, "/").replace(/\s+/g, " "),
		collected,
		accumulator,
	);
	verifySemanticCoverage(parsed, collected, accumulator);
	verifyFileReferences(
		summary,
		extraction,
		continuity,
		evidence,
		collected,
		paths,
		accumulator,
	);
	verifyProgressConsistency(parsed, extraction, collected, paths, accumulator);
	verifyOpenLoopsAndClaims(
		summary,
		parsed,
		extraction,
		continuity,
		evidence,
		collected,
		accumulator,
	);
	const score = Math.max(0, accumulator.score);
	return {
		ok: accumulator.gaps.length === 0 && score >= 85,
		gaps: accumulator.gaps,
		score,
	};
}

/** Apply every safe, deterministic repair. Hallucination/inconsistency gaps stay visible for LLM/user review. */
export function patchDeterministic(
	summary: string,
	gaps: VerificationGap[],
	extraction: StructuredExtraction,
	continuity: CompactionState | null = null,
	evidence: VerificationEvidence = {},
): string {
	let canonical: CanonicalSummary = parseSummary(summary);
	const modifiedPaths = extraction.modifiedFiles.map((file) => file.path);
	const readPaths = extraction.readFiles;
	const deletedPaths = Array.from(
		new Set([...extraction.deletedFiles, ...(continuity?.deletedFiles ?? [])]),
	);
	const pathEvidence = buildSummaryPathEvidence(
		[...modifiedPaths, ...readPaths, ...deletedPaths],
		evidence.summaryBudgetTokens,
	);
	const replaceFileSection = (
		kind: "files-modified" | "files-read" | "files-deleted",
		paths: readonly string[],
	): void => {
		const body = paths
			.map((path) => "- " + (pathEvidence.get(path) ?? JSON.stringify(path)))
			.join("\n");
		canonical = upsertSection(canonical, kind, body || "- None recorded.");
	};
	const safe = (value: string, max: number = TRUNC.MESSAGE) =>
		summaryEvidenceLine(value, max);
	const unresolvedMessages = Array.from(
		new Set([
			...extraction.errors
				.filter((error) => !error.resolved)
				.map((error) => error.message),
			...(continuity?.unresolvedErrors ?? []).map((error) => error.message),
		]),
	);
	const unresolvedLoops = (continuity?.openLoops ?? []).filter(
		(loop) => loop.status !== "resolved",
	);
	const blockedItems = [
		...unresolvedMessages
			.map((message) => safe(message))
			.filter(Boolean)
			.map((message) => "- " + message),
		...unresolvedLoops
			.map((loop) => safe(loop.summary))
			.filter(Boolean)
			.map((summary) => "- " + summary),
	];
	const patchBlockedNone = (): void => {
		const progress = findSection(canonical, "progress");
		if (!progress || !blockedItems.length) return;
		const lines = progress.body.split(/\r?\n/);
		const start = lines.findIndex((line) =>
			/^###\s*Blocked\s*$/i.test(line.trim()),
		);
		if (start < 0) return;
		let end = lines.findIndex(
			(line, index) => index > start && /^###\s+/.test(line.trim()),
		);
		if (end < 0) end = lines.length;
		const existing = lines.slice(start + 1, end);
		const noneIndexes = noneBlockerLineIndexes(existing);
		if (!noneIndexes.size) return;
		const replacement = Array.from(
			new Set([
				...blockedItems,
				...existing.filter((line, index) => line.trim() && !noneIndexes.has(index)),
			]),
		);
		lines.splice(start + 1, end - start - 1, ...replacement);
		canonical = upsertSection(canonical, "progress", lines.join("\n"));
	};

	for (const gap of gaps) {
		switch (gap.kind) {
			case "missing-section": {
				if (gap.section === "goal") {
					canonical = upsertSection(
						canonical,
						"goal",
						safe(extraction.mainGoal ?? "", TRUNC.DETAIL) ||
							"Continue the current coding task.",
					);
				} else if (gap.section === "progress") {
					canonical = upsertSection(
						canonical,
						"progress",
						"### Done\n- No explicit completion recorded.\n### In Progress\n- Continue from the latest user request.\n### Blocked\n" +
							(blockedItems.join("\n") || "- None recorded."),
					);
				} else if (gap.section === "critical-context") {
					const critical = unresolvedMessages.flatMap((message) => {
						const text = safe(message);
						return text ? ["- Unresolved error: " + text] : [];
					});
					canonical = upsertSection(
						canonical,
						"critical-context",
						critical.join("\n") || "- None recorded.",
					);
				}
				break;
			}
			case "missing-file":
				replaceFileSection("files-modified", modifiedPaths);
				break;
			case "missing-read-file":
				replaceFileSection("files-read", readPaths);
				break;
			case "missing-deleted-file":
				replaceFileSection("files-deleted", deletedPaths);
				break;
			case "missing-error": {
				const existing =
					findSection(canonical, "critical-context")?.body.toLowerCase() ?? "";
				const message = safe(gap.message);
				if (!existing.includes(message.toLowerCase())) {
					canonical = appendToSection(
						canonical,
						"critical-context",
						"- " +
							(gap.resolved ? "Resolved error: " : "Unresolved error: ") +
							message,
					);
				}
				break;
			}
			case "missing-constraint":
				canonical = appendToSection(
					canonical,
					"constraints",
					"- " + safe(gap.text, TRUNC.CONSTRAINT_TEXT),
				);
				break;
			case "missing-decision":
				canonical = appendToSection(
					canonical,
					"decisions",
					"- **" + safe(gap.summary, TRUNC.DECISION_SUMMARY) + "**",
				);
				break;
			case "missing-goal":
				canonical = upsertSection(
					canonical,
					"goal",
					safe(gap.goal, TRUNC.DETAIL) || "Continue the current task.",
				);
				break;
			case "missing-open-loops": {
				const current = extraction.errors
					.filter((error) => !error.resolved)
					.map((error) => safe(error.message, TRUNC.SNIPPET))
					.filter(Boolean)
					.map((message) => "- [high] Resolve " + message);
				const carriedErrors = (continuity?.unresolvedErrors ?? [])
					.map((error) => safe(error.message, TRUNC.SNIPPET))
					.filter(Boolean)
					.map((message) => "- [high] Resolve " + message);
				const carriedLoops = (continuity?.openLoops ?? [])
					.filter((loop) => loop.status !== "resolved")
					.map((loop) => ({
						priority: loop.priority,
						summary: safe(loop.summary, TRUNC.SNIPPET),
					}))
					.filter((item) => item.summary)
					.map((item) => "- [" + item.priority + "] " + item.summary);
				const body = Array.from(
					new Set([...current, ...carriedErrors, ...carriedLoops]),
				)
					.slice(0, gap.unresolvedCount)
					.join("\n");
				canonical = upsertSection(
					canonical,
					"open-loops",
					body || "- Review unresolved errors.",
					"next-steps",
				);
				break;
			}
			case "fabricated-file": {
				const normalizedRef = gap.ref.replace(/\\/g, "/").toLowerCase();
				canonical = {
					sections: canonical.sections.map((section) => ({
						...section,
						body: section.body
							.split("\n")
							.filter((line) => {
								if (!/^\s*[-*]\s+/.test(line)) return true;
								const matches = extractFileRefs(line).some(
									(ref) => ref.replace(/\\/g, "/").toLowerCase() === normalizedRef,
								);
								return !matches;
							})
							.join("\n")
							.trim(),
					})),
				};
				break;
			}
			case "unsupported-claim":
				canonical = removeUnsupportedClaim(canonical, gap.claim);
				break;
			case "inconsistency":
				if (gap.detail.startsWith("blocked-none:")) patchBlockedNone();
				break;
		}
	}

	return renderSummary(canonical, { canonicalHeadings: true });
}

function hasUnclosedMarkdownFence(markdown: string): boolean {
	let open: { marker: "`" | "~"; length: number } | null = null;
	for (const line of markdown.split(/\r?\n/)) {
		const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
		if (!match) continue;
		const marker = match[1][0] as "`" | "~";
		if (!open) {
			open = { marker, length: match[1].length };
		} else if (
			marker === open.marker &&
			match[1].length >= open.length &&
			!match[2].trim()
		) {
			open = null;
		}
	}
	return open !== null;
}

function patchResponseIsTruncated(
	patched: string,
	stopReason: unknown,
): boolean {
	const reason = String(stopReason ?? "");
	return (
		/(?:length|truncat|max(?:imum)?[_ -]?(?:output[_ -]?)?tokens?|token[_ -]?limit)/i.test(
			reason,
		) ||
		/…✂\d+\s*$/.test(patched) ||
		hasUnclosedMarkdownFence(patched)
	);
}

function sectionIdentity(
	section: CanonicalSummary["sections"][number],
): string {
	return section.kind === "unknown"
		? "unknown:" + section.heading.trim().toLowerCase()
		: section.kind;
}

export async function patchSummary(
	summary: string,
	gaps: VerificationGap[],
	model: Model<Api>,
	auth: { apiKey: string; headers?: ProviderHeaders },
	signal?: AbortSignal,
	services?: SmartCompactServices,
): Promise<string> {
	const patchPrompt =
		"Correct every verification finding below WITHOUT restructuring the summary. Add missing evidence, remove fabricated references, and rewrite contradictory claims so they preserve the source constraint/decision polarity. Do not add a Verification Note.\n\nFindings:\n" +
		gaps
			.map((gap, index) => index + 1 + ". " + formatVerificationGap(gap))
			.join("\n") +
		"\n\nCurrent summary:\n" +
		summary +
		"\n\nReturn the COMPLETE corrected summary in the same format.";

	try {
		const maxTokens = Math.min(
			8192,
			getProviderCaps(model.provider).maxOutputTokens,
		);
		const response = await trackedComplete(
			"patch",
			model,
			{
				systemPrompt: COMPACT_SYSTEM_PREFIX,
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: patchPrompt }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, maxTokens, signal },
			services,
		);
		const patched = response.content
			.filter((content): content is TextContent => content.type === "text")
			.map((content) => content.text)
			.join("\n")
			.trim();
		if (
			!patched.startsWith("##") ||
			patchResponseIsTruncated(patched, response.stopReason)
		)
			return summary;
		const originalSections = parseSummary(summary).sections;
		const patchedSections = parseSummary(patched).sections;
		const patchedBodies = new Map(
			patchedSections.map((section) => [
				sectionIdentity(section),
				section.body.trim(),
			]),
		);
		const preserved = originalSections.every(
			(section) =>
				!section.body.trim() ||
				Boolean(patchedBodies.get(sectionIdentity(section))),
		);
		return preserved ? patched : summary;
	} catch (error) {
		log.debug("patchSummary LLM failed", error);
		return summary;
	}
}
