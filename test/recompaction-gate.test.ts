/**
 * Regression coverage for issue #72: verification gate fail-closes on
 * re-compacted sessions because the deterministic extraction re-mines the
 * prior compaction's summary text (completed items, superseded rules) and
 * this extension's own error prose as live constraints.
 */

import { describe, expect, it } from "bun:test";
import { catalogErrors, mineConstraints, isNonLiveConstraintText } from "../src/utils/extraction.ts";
import { retireSupersededConstraints, buildCompactionState } from "../src/utils/state.ts";
import { formatVerificationGap, verifySummary, releasesConstraint } from "../src/phases/verify.ts";
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

	it("does not re-mine the floor's own Topics Covered lines, so the floor passes its own gate", () => {
		const failedChunk = (summary: string) => ({
			topic: "Working on featured-strip-density.spec.ts",
			startIndex: 0,
			endIndex: 1,
			summary,
			keyDecisions: [],
			filesModified: [],
			filesRead: [],
			filesDeleted: [],
			priority: "normal" as const,
		});
		const prior = assembleFallback([
			failedChunk("[Failed] Ran the density spec; the strip must use the compact rail layout"),
			failedChunk("[Failed] Ran the density spec; the strip must not use the compact rail layout"),
		], makeExtraction());
		expect(prior).toContain("**Working on featured-strip-density.spec.ts** [normal]: [Failed]");
		const mined = mineConstraints([user(prior)]);
		expect(mined).toEqual([]);
		const extraction = makeExtraction({ constraints: mined });
		expect(verifySummary(assembleFallback([], extraction), extraction, null).ok).toBe(true);
	});

	it("mines only the Constraints section of a host compaction summary", () => {
		const summary = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n" +
			"## Goal\nShip the rail\n## Constraints\n- Never push to main\n## Progress\n- [ ] Old anchor must not be reused\n## Next Steps\n1. Do not touch BRIEF.md yet\n</summary>";
		expect(mineConstraints([user(summary)]).map((item) => item.text)).toEqual(["Never push to main"]);
	});

	it("does not catalog this extension's own failure as session work", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "smart_compact", arguments: {} }] },
			{ role: "toolResult", toolCallId: "c1", isError: true, content: [{ type: "text", text: "Verification stopped apply at the post-synthesis gate: 0/100. Conversation unchanged." }] },
		] as unknown as LlmMessage[];
		expect(catalogErrors(msgs)).toEqual([]);
	});

	it("names where a required rule came from in gate findings", () => {
		const extraction = makeExtraction({
			constraints: [{ text: "Never push to main", index: 2, category: "prohibition", confidence: 0.85 }],
		});
		const result = verifySummary(assembleFallback([], makeExtraction()), extraction, null);
		expect(result.gaps.map(formatVerificationGap)).toContain("Missing constraint: Never push to main [message #2]");
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
		expect(isNonLiveConstraintText("- **Working on a.ts** [high]: must use tabs")).toBe(true);
		expect(isNonLiveConstraintText("**Important**: must use tabs")).toBe(false);
	});

	it("keeps a genuine standalone user rule that shares words with this extension's prose (A05)", () => {
		const mined = mineConstraints([user("Do not bypass verification.")]);
		expect(mined.length).toBe(1);
		expect(mined[0].category).toBe("prohibition");
		expect(isNonLiveConstraintText("Do not bypass verification.")).toBe(false);
	});

	it("still excludes the shared phrase when own-output context is in the same text (A05)", () => {
		expect(
			isNonLiveConstraintText(
				"Review /smart-compact metrics; do not bypass verification.",
			),
		).toBe(true);
		expect(isNonLiveConstraintText(OWN_ERROR_TAIL)).toBe(true);
	});

	it("uses whole-message provenance so a wrapped own-output paste cannot reseed rules (A05)", () => {
		const recap = [
			"Smart compact failed.",
			"do not bypass verification.",
			"- Do not run migrations on production without approval",
		].join("\n");
		const mined = mineConstraints([user(recap)]);
		expect(mined.map((item) => item.text)).toEqual([
			"Do not run migrations on production without approval",
		]);
	});

	it("a genuine user rule gates the summary end to end even though it matches extension prose (A05)", () => {
		const text = "Do not bypass verification.";
		const extraction = makeExtraction({
			constraints: [{ text, index: 0, category: "prohibition", confidence: 1 }],
		});
		const state = buildCompactionState(extraction, [], null, [], []);
		// sanitizeCompactionStateEvidence must keep the genuine rule.
		expect(state.constraints.map((item) => item.text)).toContain(text);
		const withoutRule = assembleFallback([], makeExtraction());
		const result = verifySummary(withoutRule, extraction, state);
		expect(result.ok).toBe(false);
		expect(result.gaps.some((gap) => gap.kind === "missing-constraint")).toBe(true);
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

	it("retires the older of two required rules the gate reads as contradicting, so the floor passes", () => {
		const older = "Do not use the old arrow-polish anchor for the featured rail";
		const newer = "Use the old arrow-polish anchor for the featured rail";
		const rule = (text: string, index: number) => ({ text, index, category: "requirement" as const, confidence: 0.85 });
		const extraction = makeExtraction({ constraints: [rule(older, 2), rule(newer, 9)] });
		// Without retirement both rules are required and no summary can satisfy them.
		expect(verifySummary(assembleFallback([], extraction), extraction, null).ok).toBe(false);
		const overrides = retireSupersededConstraints(extraction.constraints, [], []);
		expect(overrides.map((item) => [item.summaryKey, item.status, item.replacement])).toEqual([
			[normalizeFactKey(older), "superseded", newer],
		]);
		const floor = assembleFallback([], extraction, undefined, undefined, null, overrides);
		expect(verifySummary(floor, extraction, null, { factOverrides: overrides }).ok).toBe(true);
		// A state-carried rule is older than any mined one; a same-message tie goes to the later line.
		expect(retireSupersededConstraints([{ text: older }, { text: newer, index: 0 }], [], []).length).toBe(1);
		expect(retireSupersededConstraints([{ text: newer, index: 0 }, { text: older, index: 0 }], [], [])[0]?.summaryKey).toBe(normalizeFactKey(newer));
	});

	it("does not let a question or a non-required rule supersede a required rule", () => {
		const rule = { text: "Do not use the old arrow-polish anchor for the featured rail", index: 2, confidence: 0.85 };
		expect(retireSupersededConstraints([rule, { text: "Must we use the old arrow-polish anchor for the featured rail?", index: 9, confidence: 0.85 }], [], [])).toEqual([]);
		expect(retireSupersededConstraints([rule, { text: "I want to use the old arrow-polish anchor for the featured rail", index: 9, confidence: 0.6 }], [], [])).toEqual([]);
	});

	it("a steering focus names a subject and cannot contradict a rule", () => {
		const extraction = makeExtraction({
			constraints: [{ text: "BRIEF.md must keep the wider rail priority history", index: 2, category: "requirement", confidence: 0.85 }],
		});
		const steering = { focus: "BRIEF.md must not keep the wider rail priority history" };
		const floor = assembleFallback([], extraction, steering);
		expect(verifySummary(floor, extraction, null, { steering }).ok).toBe(true);
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

	it("does not retire a constraint because of a later question mentioning the action (A04)", () => {
		const rule = "Do not deploy until tests pass.";
		const msgs = [user(rule), user("Why did you deploy?")];
		expect(retireSupersededConstraints([{ text: rule, index: 0 }], msgs, [])).toEqual([]);
		// The question form itself is the gate: no "?" but an interrogative lead.
		const noMark = [user(rule), user("why did you deploy at all")];
		expect(retireSupersededConstraints([{ text: rule, index: 0 }], noMark, [])).toEqual([]);
	});

	it("still retires on a genuine explicit release after a question was asked (A04)", () => {
		const rule = "Do not deploy until tests pass.";
		const msgs = [
			user(rule),
			user("Why did you deploy?"),
			user("Tests pass now \u2014 deploy it"),
		];
		const overrides = retireSupersededConstraints([{ text: rule, index: 0 }], msgs, []);
		expect(overrides.length).toBe(1);
		expect(overrides[0].status).toBe("superseded");
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
