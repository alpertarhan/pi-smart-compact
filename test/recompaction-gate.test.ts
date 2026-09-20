/**
 * Regression coverage for issue #72: verification gate fail-closes on
 * re-compacted sessions because the deterministic extraction re-mines the
 * prior compaction's summary text (completed items, superseded rules) and
 * this extension's own error prose as live constraints.
 */

import { describe, expect, it } from "bun:test";
import { mineConstraints, isNonLiveConstraintText } from "../src/utils/extraction.ts";
import { retireSupersededConstraints } from "../src/utils/state.ts";
import { verifySummary, releasesConstraint } from "../src/phases/verify.ts";
import { assembleFallback } from "../src/phases/synthesize.ts";
import { buildState } from "../src/app/steps/state.ts";
import { createServices } from "../src/infra/services.ts";
import { makeTokenEstimator } from "../src/utils/tokens.ts";
import { normalizeFactKey } from "../src/utils/helpers.ts";
import type {
	CompactionState,
	ContinuityOverride,
	LlmMessage,
	StructuredExtraction,
} from "../src/types.ts";

function user(text: string): LlmMessage {
	return { role: "user", content: text } as LlmMessage;
}

const OWN_ERROR_TAIL =
	"unchanged. Review /smart-compact metrics; do not bypass verification. For local evidence, restart Pi with DEBUG=smart-compact.";

const STALE_RULE =
	"Do not push/open PR yet; user wants to test Slice 2 locally first.";

function makeExtraction(
	partial: Partial<StructuredExtraction> = {},
): StructuredExtraction {
	return {
		modifiedFiles: [],
		readFiles: [],
		deletedFiles: [],
		errors: [],
		decisions: [],
		constraints: [],
		topics: [],
		timeline: [],
		mainGoal: null,
		lastUserMessages: [],
		lastErrors: [],
		messageCount: 0,
		...partial,
	};
}

function supersededOverride(text: string, replacement: string): ContinuityOverride {
	return {
		id: "constraint-override-1",
		kind: "constraint",
		summaryKey: normalizeFactKey(text),
		status: "superseded",
		replacement,
		updatedAt: Date.now(),
	};
}

describe("mineConstraints skips non-live text (issue #72 poison classes)", () => {
	it("does not mine this extension's own error prose pasted back by the operator", () => {
		const mined = mineConstraints([user(OWN_ERROR_TAIL)]);
		expect(mined).toEqual([]);
	});

	it("does not mine own-output fragments embedded in a pasted recap", () => {
		const recap = [
			"Session recap:",
			"- " + OWN_ERROR_TAIL,
			"- Do not run migrations on production without approval",
		].join("\n");
		const mined = mineConstraints([user(recap)]);
		expect(mined.map((item) => item.text)).toEqual([
			"Do not run migrations on production without approval",
		]);
	});

	it("treats [x] checklist items as completion records, not live rules", () => {
		const priorSummary = [
			"## Progress",
			"- [x] Diagnosed the flaky auth test and fixed the fixture",
			"- [x] Added regression test for token refresh",
			"- [ ] Do not delete the audit log table without a backup",
		].join("\n");
		const mined = mineConstraints([user(priorSummary)]);
		// Only the open checklist item survives; completion records do not.
		expect(mined.every((item) => !/^\[x\]/i.test(item.text))).toBe(true);
		expect(mined.some((item) => item.text.includes("audit log table"))).toBe(true);
	});

	it("still mines genuine user rules", () => {
		const mined = mineConstraints([user("Never use tabs in this codebase, spaces only")]);
		expect(mined.length).toBe(1);
		expect(mined[0].category).toBe("prohibition");
	});

	it("classifies non-live text directly", () => {
		expect(isNonLiveConstraintText("- " + OWN_ERROR_TAIL)).toBe(true);
		expect(isNonLiveConstraintText("[x] Added the migration")).toBe(true);
		expect(isNonLiveConstraintText("npm error code ELIFECYCLE")).toBe(true);
		expect(isNonLiveConstraintText("EESV Compact completed at 12:00")).toBe(true);
		expect(isNonLiveConstraintText("Do not deploy on Fridays")).toBe(false);
	});
});

describe("retireSupersededConstraints", () => {
	it("retires a deferral constraint released by a terse later message (issue #72 repro)", () => {
		const msgs = [user(STALE_RULE), user("ok push it now")];
		const overrides = retireSupersededConstraints(
			[{ text: STALE_RULE, index: 0 }],
			msgs,
			[],
		);
		expect(overrides.length).toBe(1);
		expect(overrides[0].kind).toBe("constraint");
		expect(overrides[0].status).toBe("superseded");
		expect(overrides[0].replacement).toBe("ok push it now");
	});

	it("retires a deferral constraint released by a verbose later message", () => {
		const msgs = [user(STALE_RULE), user("ok, push the branch and open the PR now")];
		const overrides = retireSupersededConstraints(
			[{ text: STALE_RULE, index: 0 }],
			msgs,
			[],
		);
		expect(overrides.length).toBe(1);
	});

	it("does not retire a standing rule on a terse imperative sharing one verb", () => {
		const rule = "Never commit directly to main; always use a feature branch";
		const msgs = [user(rule), user("commit the fix now")];
		const overrides = retireSupersededConstraints([{ text: rule, index: 0 }], msgs, []);
		expect(overrides).toEqual([]);
	});

	it("retires a standing rule on an explicit rich reversal", () => {
		const rule = "No new dependencies in this project";
		const msgs = [user(rule), user("actually, new dependencies are allowed now")];
		const overrides = retireSupersededConstraints([{ text: rule, index: 0 }], msgs, []);
		expect(overrides.length).toBe(1);
	});

	it("does not retire on a restatement that keeps the polarity", () => {
		const rule = "Do not push until tests pass";
		const msgs = [user(rule), user("reminder: do not push until tests pass, still waiting")];
		const overrides = retireSupersededConstraints([{ text: rule, index: 0 }], msgs, []);
		expect(overrides).toEqual([]);
	});

	it("ignores messages older than the constraint itself", () => {
		const msgs = [user("ok push it now"), user("on reflection, do not push yet, hold off")];
		const overrides = retireSupersededConstraints(
			[{ text: "do not push yet, hold off", index: 1 }],
			msgs,
			[],
		);
		expect(overrides).toEqual([]);
	});

	it("checks state-carried constraints (no index) against every message", () => {
		const msgs = [user("ship it"), user("ok push it now, the deferral is lifted")];
		const overrides = retireSupersededConstraints([{ text: STALE_RULE }], msgs, []);
		expect(overrides.length).toBe(1);
	});

	it("upserts onto and preserves existing overrides", () => {
		const existing: ContinuityOverride[] = [
			{
				id: "constraint-override-old",
				kind: "constraint",
				summaryKey: normalizeFactKey("No CI skips"),
				status: "superseded",
				updatedAt: 1,
			},
		];
		const msgs = [user(STALE_RULE), user("ok push it now")];
		const overrides = retireSupersededConstraints(
			[{ text: STALE_RULE, index: 0 }],
			msgs,
			existing,
		);
		expect(overrides.length).toBe(2);
		expect(
			overrides.some((item) => item.summaryKey === normalizeFactKey("No CI skips")),
		).toBe(true);
	});

	it("releasesConstraint distinguishes deferral from standing semantics", () => {
		expect(releasesConstraint(STALE_RULE, "ok push it now")).toBe(true);
		expect(
			releasesConstraint("Never commit directly to main", "commit the fix now"),
		).toBe(false);
		expect(releasesConstraint("Do not push yet", "what is the plan for tomorrow?")).toBe(false);
	});
});

describe("verifySummary gate with poisoned extraction (issue #72 end-to-end)", () => {
	const NEW_STATE =
		"User wanted to test Slice 2 locally first; local testing passed, so the branch was pushed and the PR opened";
	const msgs: LlmMessage[] = [
		user(STALE_RULE),
		{ role: "assistant", content: "holding off on push" } as LlmMessage,
		user("ok push it now"),
		{ role: "assistant", content: "pushed branch and opened PR #12" } as LlmMessage,
	];
	const extraction = makeExtraction({
		constraints: [
			{ index: 0, text: STALE_RULE, category: "prohibition", confidence: 0.8 },
		],
		messageCount: msgs.length,
	});
	const summary = assembleFallback([], extraction).replace(STALE_RULE, NEW_STATE);

	it("fails closed with a semantic-contradiction gap when the stale rule is live (the bug)", () => {
		const result = verifySummary(summary, extraction, null, { sourceMessages: msgs });
		expect(result.ok).toBe(false);
		expect(
			result.gaps.some(
				(gap) =>
					gap.kind === "inconsistency" &&
					gap.detail.startsWith("semantic-contradiction"),
			),
		).toBe(true);
	});

	it("passes when the run retired the stale constraint via evidence.factOverrides", () => {
		const overrides = retireSupersededConstraints(
			extraction.constraints.map((item) => ({ text: item.text, index: item.index })),
			msgs,
			[],
		);
		expect(overrides.length).toBe(1);
		const result = verifySummary(summary, extraction, null, {
			sourceMessages: msgs,
			factOverrides: overrides,
		});
		expect(result.gaps).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.score).toBe(100);
	});

	it("honors retired constraints carried on the continuity state", () => {
		const continuity: CompactionState = {
			goal: null,
			decisions: [],
			constraints: [],
			modifiedFiles: [],
			readFiles: [],
			deletedFiles: [],
			unresolvedErrors: [],
			resolvedErrors: [],
			openLoops: [],
			topics: [],
			nextActions: [],
			criticalContext: [],
			sessionType: "implementation",
			compactionVersion: "test",
			factOverrides: [supersededOverride(STALE_RULE, "ok push it now")],
		};
		const result = verifySummary(summary, extraction, continuity, {
			sourceMessages: msgs,
		});
		expect(result.gaps).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it("drops own-error constraints replayed from a stale extraction cache", () => {
		const poisoned = makeExtraction({
			constraints: [
				{ index: 0, text: OWN_ERROR_TAIL, category: "prohibition", confidence: 0.8 },
			],
			messageCount: 1,
		});
		const clean = assembleFallback([], poisoned);
		// The fallback echoes the constraint only if it is live evidence; the
		// gate must not demand own-error prose in the summary either way.
		const result = verifySummary(clean, poisoned, null, { sourceMessages: [user(OWN_ERROR_TAIL)] });
		expect(
			result.gaps.some(
				(gap) => gap.kind === "missing-constraint" && gap.text === OWN_ERROR_TAIL,
			),
		).toBe(false);
	});
});

describe("buildState persists retirement through the merged continuity state", () => {
	it("drops the superseded constraint and records its replacement as critical context", () => {
		const projectId =
			"issue72-step-" + Date.now() + "-" + Math.random().toString(36).slice(2);
		const stale = {
			id: "constraint-stale",
			text: STALE_RULE,
			category: "prohibition" as const,
			confidence: 0.8,
		};
		const previous: CompactionState = {
			goal: "Ship Slice 2",
			decisions: [],
			constraints: [stale],
			modifiedFiles: [],
			readFiles: [],
			deletedFiles: [],
			unresolvedErrors: [],
			resolvedErrors: [],
			openLoops: [],
			topics: [],
			nextActions: [],
			criticalContext: [],
			sessionType: "implementation",
			compactionVersion: "test",
		};
		previous.scope = {
			schemaVersion: 2,
			projectId,
			sessionId: "session-issue72",
			branchHeadId: "entry-1",
		};
		const extraction = makeExtraction({ mainGoal: "Ship Slice 2" });
		const services = createServices();
		const rc: any = {
			ctx: { cwd: process.cwd() },
			extraction,
			finalSummary: "## Goal\nShip Slice 2 safely\n\n## Next Steps\n1. Continue",
			projectId,
			continuityScope: previous.scope,
			previousState: previous,
			factOverrides: [supersededOverride(STALE_RULE, "ok push it now")],
			llmMessages: [],
			explorationReport: null,
			config: { pinPaths: [] },
			services,
			estimator: makeTokenEstimator("openai", "test", services.tokenCalibration),
			profile: "balanced",
			mode: "balanced",
			method: "eesv",
			chunkCount: 1,
			summaries: [],
			toCompact: [{}, {}],
			convTokens: 1_000,
			totalTokens: 50_000,
			compactTokens: 20_000,
			accTokens: 10_000,
			compactionPlan: {
				keepFrom: 2,
				compactTokens: 20_000,
				retainedTokens: 10_000,
				projectedAfterTokens: 40_000,
				projectedSavedTokens: 10_000,
				projectedYield: 0.2,
				fixedContextTokens: 20_000,
				retentionTargetTokens: 10_000,
				summaryBudgetTokens: 10_000,
				targetAfterTokens: 40_000,
				hardBoundaryAdjusted: false,
				viable: true,
				reason: "viable",
				relaxedSoftBoundaries: [],
			},
			backupPath: null,
			verified: true,
			verificationGaps: [],
			verificationScore: 100,
			verificationProvenance: {
				initialScore: 100,
				deterministicPatched: [],
				llmPatched: false,
				finalScore: 100,
				remainingGaps: [],
			},
			explorationRounds: 0,
			modelLabel: "openai/test",
			notify: () => {},
			_prepared: true,
			_windowed: true,
			_recovered: true,
			_tiered: true,
			_extracted: true,
			_synthesized: true,
			_verified: true,
		};
		const out = buildState(rc);
		expect(out.compactionState.constraints.some((item) => item.text === STALE_RULE)).toBe(false);
		expect(
			out.compactionState.criticalContext.some((item) =>
				item.includes("Superseded constraint: ok push it now"),
			),
		).toBe(true);
		expect(
			(out.compactionState.factOverrides ?? []).some(
				(item) =>
					item.kind === "constraint" &&
					item.summaryKey === normalizeFactKey(STALE_RULE) &&
					item.status === "superseded",
			),
		).toBe(true);
	});
});
