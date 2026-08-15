/**
 * Markdown ↔ CanonicalSummary parser.
 *
 * The synthesis phase produces markdown because LLMs and humans both read it
 * well. Verification, patching, and delta-injection used to operate by
 * lowercasing the markdown and substring-scanning for headings, which gave
 * us a long tail of regex fragility: `## Goal` matched but `### Goal` did not,
 * `Files Modified` matched but `Files modified` had to be lowercased first,
 * etc.
 *
 * This module performs one structural parse up front: H1/H2 headings and
 * recognized canonical H3 headings start sections. Unknown H3 headings remain
 * in their parent body so Progress subsections retain their structure. After
 * that, the rest of the code can ask `findSection(summary, "goal")` and let
 * the classifier handle aliases.
 *
 * Duplicate recognized kinds are merged at their first position with exact
 * duplicate body lines removed. Unknown sections remain independent.
 */

import { createHash } from "node:crypto";
import { PROFILES } from "../constants.ts";
import { classifyHeading, canonicalHeading } from "./summary-schema.ts";
import type {
	CanonicalSummary,
	Section,
	SectionKind,
} from "./summary-schema.ts";

/** H1/H2 always start sections; H3 starts one only when its kind is recognized. */
const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;

/** Collapse untrusted extracted evidence to one Markdown-safe line. */
export function summaryEvidenceLine(value: string, maxLength: number): string {
	return value
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^(?:(?:#{1,6}|[-*+]|>)\s+)+/, "")
		.slice(0, maxLength)
		.trim();
}

/** Lossless Markdown-safe representation for one path. */
function summaryPathLine(value: string): string {
	return JSON.stringify(value);
}

function compactPathLine(
	value: string,
	maxLength: number,
	digest: string,
): string {
	const minimal = JSON.stringify("#" + digest);
	if (minimal.length >= maxLength) return minimal;
	const chars = Array.from(value.replace(/\\/g, "/"));
	let low = 0;
	let high = chars.length;
	let best = minimal;
	while (low <= high) {
		const length = Math.floor((low + high) / 2);
		const candidate = JSON.stringify(
			"…/" + chars.slice(-length).join("") + "#" + digest,
		);
		if (candidate.length <= maxLength) {
			best = candidate;
			low = length + 1;
		} else {
			high = length - 1;
		}
	}
	return best;
}

/**
 * Build stable, collision-resistant path evidence within one aggregate budget.
 * Small sets remain lossless; large sets retain a readable tail plus a digest.
 */
export function buildSummaryPathEvidence(
	paths: readonly string[],
	budgetTokens: number = PROFILES.balanced.summaryBudgetTokens,
): Map<string, string> {
	const unique = Array.from(new Set(paths.filter(Boolean)));
	if (!unique.length) return new Map();
	const full = unique.map((path) => [path, summaryPathLine(path)] as const);
	const minimumPerLine = JSON.stringify("#" + "x".repeat(12)).length + 3;
	const budgetChars = Math.max(
		unique.length * minimumPerLine,
		Math.min(20_000, Math.max(4_000, Math.floor(budgetTokens * 2))),
	);
	if (
		full.reduce((total, [, line]) => total + line.length + 3, 0) <= budgetChars
	) {
		return new Map(full);
	}

	const digests = new Map<string, string>();
	const owners = new Map<string, string>();
	for (const path of unique) {
		const fullDigest = createHash("sha256").update(path).digest("base64url");
		let digest = fullDigest.slice(0, 12);
		const owner = owners.get(digest);
		if (owner && owner !== path) {
			digest = fullDigest;
			digests.set(
				owner,
				createHash("sha256").update(owner).digest("base64url"),
			);
		}
		owners.set(digest, path);
		digests.set(path, digest);
	}

	const perPath = Math.max(
		JSON.stringify("#" + "x".repeat(12)).length,
		Math.floor((budgetChars - unique.length * 3) / unique.length),
	);
	return new Map(
		unique.map((path) => [
			path,
			compactPathLine(path, perPath, digests.get(path) ?? ""),
		]),
	);
}

function mergeBodies(first: string, second: string): string {
	const seen = new Set<string>();
	return [first, second]
		.filter(Boolean)
		.flatMap((body) => body.split("\n"))
		.filter((line) => (seen.has(line) ? false : (seen.add(line), true)))
		.join("\n")
		.trim();
}

export function parseSummary(markdown: string): CanonicalSummary {
	const sections: Section[] = [];
	const lines = markdown.split("\n");
	let currentHeading = "";
	let currentKind: SectionKind = "unknown";
	let bodyLines: string[] = [];
	let fence: { marker: "`" | "~"; length: number } | null = null;
	let started = false;

	const flush = () => {
		if (!started) return;
		const body = bodyLines.join("\n").trim();
		const existing =
			currentKind === "unknown"
				? undefined
				: sections.find((s) => s.kind === currentKind);
		if (existing) existing.body = mergeBodies(existing.body, body);
		else
			sections.push({
				kind: currentKind,
				heading: currentHeading.trim(),
				body,
			});
	};

	for (const line of lines) {
		const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
		if (fenceMatch) {
			const marker = fenceMatch[1][0] as "`" | "~";
			const markerLength = fenceMatch[1].length;
			if (!fence) {
				fence = { marker, length: markerLength };
			} else if (
				marker === fence.marker &&
				markerLength >= fence.length &&
				!fenceMatch[2].trim()
			) {
				fence = null;
			}
			if (started) bodyLines.push(line);
			continue;
		}
		if (!fence) {
			const heading = line.match(HEADING_RE);
			if (heading) {
				const kind = classifyHeading(heading[2]);
				if (heading[1].length <= 2 || kind !== "unknown") {
					flush();
					// Normalize heading depth while preserving the model's label.
					currentHeading = "## " + heading[2].trim();
					currentKind = kind;
					bodyLines = [];
					started = true;
					continue;
				}
			}
		}
		if (started) bodyLines.push(line);
	}
	flush();

	return { sections };
}

/** Find the first section matching the requested kind. */
export function findSection(
	summary: CanonicalSummary | string,
	kind: SectionKind,
): Section | undefined {
	const parsed = typeof summary === "string" ? parseSummary(summary) : summary;
	return parsed.sections.find((s) => s.kind === kind);
}

export function hasSection(
	summary: CanonicalSummary | string,
	kind: SectionKind,
): boolean {
	return findSection(summary, kind) !== undefined;
}

/** Stringify the canonical form back to markdown.
 *
 * `opts.canonicalHeadings` rewrites recognized headings to their canonical
 * form. Patch routines turn this on so downstream verification cannot miss a
 * section because the LLM emitted `### Goal` instead of `## Goal`.
 */
export function renderSummary(
	summary: CanonicalSummary,
	opts: { canonicalHeadings?: boolean } = {},
): string {
	return (
		summary.sections
			.map((s) => {
				const heading =
					opts.canonicalHeadings && s.kind !== "unknown"
						? canonicalHeading(s.kind)
						: s.heading;
				return heading + "\n" + s.body;
			})
			.join("\n\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim() + "\n"
	);
}

/**
 * Placement hint for `upsertSection` when inserting a *new* section.
 *
 * `before`/`after` name the *kind* of an existing section that the new entry
 * should anchor against. `before` inserts immediately ahead of the anchor;
 * `after` inserts immediately behind it. When both are given, `before` wins
 * (kept for back-compat with positional callers). When neither anchor is found
 * the section falls back to append-at-end.
 *
 * This is how the synthesis pipeline keeps `Open Loops` ahead of `Next Steps`
 * deterministically, and the delta injector places `Changes Since Last
 * Compaction` directly after `Open Loops` when present.
 */
export interface SectionPlacement {
	before?: SectionKind;
	after?: SectionKind;
}

/**
 * Insert or replace a section. If a section with the same `kind` exists, its
 * heading is replaced with the canonical one and the body is overwritten. If
 * not, the section is inserted according to `placement` (or appended).
 */
export function upsertSection(
	summary: CanonicalSummary,
	kind: SectionKind,
	body: string,
	placement?: SectionKind | SectionPlacement,
): CanonicalSummary {
	const heading = canonicalHeading(kind);
	const existing = summary.sections.findIndex((s) => s.kind === kind);
	if (existing >= 0) {
		const sections = summary.sections.slice();
		sections[existing] = { kind, heading, body: body.trim() };
		return { sections };
	}
	// Back-compat: positional callers pass a bare SectionKind as `before`.
	const hint: SectionPlacement =
		placement == null
			? {}
			: typeof placement === "string"
				? { before: placement }
				: placement;
	const section: Section = { kind, heading, body: body.trim() };
	if (hint.before) {
		const idx = summary.sections.findIndex((s) => s.kind === hint.before);
		if (idx >= 0) {
			const sections = summary.sections.slice();
			sections.splice(idx, 0, section);
			return { sections };
		}
	}
	if (hint.after) {
		// findLastIndex so duplicate-kind sections insert after the final one.
		let idx = -1;
		for (let i = summary.sections.length - 1; i >= 0; i--) {
			if (summary.sections[i].kind === hint.after) {
				idx = i;
				break;
			}
		}
		if (idx >= 0) {
			const sections = summary.sections.slice();
			sections.splice(idx + 1, 0, section);
			return { sections };
		}
	}
	return { sections: [...summary.sections, section] };
}

/**
 * Append text to an existing section body. If the section is missing, it is
 * created with the provided body. This is the structural equivalent of the
 * old `findOrCreateSectionInsert` helper in `verify.ts`.
 */
export function appendToSection(
	summary: CanonicalSummary,
	kind: SectionKind,
	text: string,
	fallbackBody = "",
): CanonicalSummary {
	const heading = canonicalHeading(kind);
	const idx = summary.sections.findIndex((s) => s.kind === kind);
	if (idx >= 0) {
		const sections = summary.sections.slice();
		const existing = sections[idx];
		const body = /^-\s*(?:none|none recorded|no blockers?|yok)[.!]?$/i.test(
			existing.body.trim(),
		)
			? ""
			: existing.body.trim();
		const combined = body ? body + "\n" + text.trim() : text.trim();
		sections[idx] = { kind, heading, body: combined };
		return { sections };
	}
	return upsertSection(
		summary,
		kind,
		(fallbackBody.trim() ? fallbackBody.trim() + "\n" : "") + text.trim(),
	);
}
