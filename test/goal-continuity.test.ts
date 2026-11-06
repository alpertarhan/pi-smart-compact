// pi-lens-ignore: ts:2307
import { describe, it, expect } from "bun:test";
import { assembleFallback } from "../src/phases/synthesize.ts";
import { verifySummary, repairSummaryDeterministically } from "../src/phases/verify.ts";
import { buildState } from "../src/app/steps/state.ts";
import {
	resolveGoalEvidence,
	activeCarrierCompactionState,
} from "../src/utils/state.ts";
import { goalPairLines } from "../src/domain/summary-parse.ts";
import {
	extractGoalEvidence,
	extractMainGoal,
} from "../src/utils/extraction.ts";
import {
	PRIOR_GOAL_LABEL,
	LATEST_DIRECTION_LABEL,
	CARRIED_GOAL_LABEL,
} from "../src/domain/summary-parse.ts";
import { createServices } from "../src/infra/services.ts";
import { makeTokenEstimator, makeReaderTokenEstimator } from "../src/utils/tokens.ts";
import type {
	CompactionState,
	GoalEvidence,
	LlmMessage,
	StructuredExtraction,
} from "../src/types.ts";

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

function makeState(partial: Partial<CompactionState> = {}): CompactionState {
	return {
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
		compactionVersion: "10.8.0",
		updatedAt: 1_000,
		...partial,
	};
}

const user = (text: string): LlmMessage => ({ role: "user", content: text });
const hostSummary = (goalBody: string): LlmMessage =>
	user(
		"The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\n" +
			goalBody +
			"\n</summary>",
	);

const A = "Add login page with password auth";
const B = "Fix the agent-mesh retry bug, do not change the public API";
const B_TR = "Bana OAuth girişi lazım, asla şifre saklama";

describe("extractGoalEvidence (message-pure raw evidence)", () => {
	it("extractMainGoal output is unchanged by the refactor", () => {
		expect(extractMainGoal([user("older"), user("/command"), user("ok"), user(B)])).toBe(B);
		expect(extractMainGoal([user("okay")])).toBeNull();
		expect(extractMainGoal([hostSummary(A), user("thanks")])).toBe(A);
	});

	it("records the first host boundary goal after a fresh user turn", () => {
		const ge = extractGoalEvidence([hostSummary(A), user(B)]);
		expect(ge.direction).toBe(B);
		expect(ge.directionSource).toBe("user-turn");
		expect(ge.hostSummaryGoal).toBe(A);
	});

	it("stops at the first (nearest) host boundary and never scans older raw messages", () => {
		const ge = extractGoalEvidence([hostSummary("Oldest goal"), hostSummary(A), user("okay")]);
		expect(ge.direction).toBe(A);
		expect(ge.directionSource).toBe("carried");
		expect(ge.hostSummaryGoal).toBe(A);
	});
});

describe("resolveGoalEvidence (authoritative raw pair)", () => {
	it("first fallback with no host summary: prior falls to raw previous state goal", () => {
		const ge = resolveGoalEvidence(
			{ direction: B, directionSource: "user-turn", hostSummaryGoal: null },
			makeState({ goal: A }),
			null,
		);
		expect(ge).toMatchObject({ prior: A, direction: B, pair: true });
	});

	it("prefers carrier raw pair over carried composite as direction", () => {
		const composite = goalPairLines(A, B);
		const ge = resolveGoalEvidence(
			{ direction: composite, directionSource: "carried", hostSummaryGoal: composite },
			makeState({ goal: B, priorGoal: A, updatedAt: 2_000 }),
			makeState({ goal: B, priorGoal: A, updatedAt: 2_000 }),
		);
		expect(ge.direction).toBe(B);
		expect(ge.directionSource).toBe("carried-raw");
		expect(ge.prior).toBe(A);
		expect(ge.pair).toBe(true);
	});

	it("stale scoped fallback state never revives an old chain when the carrier is newer (LLM C + raw D)", () => {
		const ge = resolveGoalEvidence(
			{ direction: "Write release notes for 10.9", directionSource: "user-turn", hostSummaryGoal: "Ship OAuth flow" },
			makeState({ goal: B, priorGoal: A, updatedAt: 1_000 }),
			makeState({ goal: "Ship OAuth flow", updatedAt: 5_000 }),
		);
		expect(ge.prior).toBe("Ship OAuth flow");
		expect(ge.direction).toBe("Write release notes for 10.9");
		expect(ge.pair).toBe(true);
	});

	it("carrier wins even when the scoped file's timestamp is newer (unrelated fact write)", () => {
		const ge = resolveGoalEvidence(
			{ direction: "Write release notes", directionSource: "user-turn", hostSummaryGoal: "Ship OAuth flow" },
			makeState({ goal: B, priorGoal: A, updatedAt: 30_000 }),
			makeState({ goal: "Ship OAuth flow", updatedAt: 20_000 }),
		);
		expect(ge.prior).toBe("Ship OAuth flow");
		expect(ge.direction).toBe("Write release notes");
	});

	it("label-shaped host summary goal is rejected as prior when no owned metadata exists", () => {
		const composite = goalPairLines(A, B);
		const ge = resolveGoalEvidence(
			{ direction: "New task C", directionSource: "user-turn", hostSummaryGoal: composite },
			null,
			null,
		);
		expect(ge.prior).toBeNull();
		expect(ge.pair).toBe(false);
	});

	it("equal prior and direction collapse to a single value (no fake pair)", () => {
		const ge = resolveGoalEvidence(
			{ direction: A, directionSource: "carried", hostSummaryGoal: A },
			makeState({ goal: A }),
			null,
		);
		expect(ge.prior).toBeNull();
		expect(ge.pair).toBe(false);
		expect(ge.directionSource).toBe("carried-raw");
	});

	it("opaque label-shaped text never gains raw authority merely by being saved", () => {
		const composite = goalPairLines(A, B);
		// A previous run persisted the opaque composite as state.goal (scoped or carrier).
		const laundered = resolveGoalEvidence(
			{ direction: composite, directionSource: "carried", hostSummaryGoal: composite },
			makeState({ goal: composite }),
			makeState({ goal: composite }),
		);
		expect(laundered.directionSource).toBe("carried-text");
		expect(laundered.pair).toBe(false);
		expect(laundered.prior).toBeNull();
	});

	it("fresh user turn after a persisted opaque goal is never wrapped in labeled prior", () => {
		const composite = goalPairLines(A, B);
		const ge = resolveGoalEvidence(
			{ direction: "New task C", directionSource: "user-turn", hostSummaryGoal: composite },
			makeState({ goal: composite }),
			makeState({ goal: composite }),
		);
		expect(ge.direction).toBe("New task C");
		expect(ge.prior).toBeNull();
		expect(ge.pair).toBe(false);
	});

	it("a genuinely raw user direction containing no label text keeps full authority", () => {
		const ge = resolveGoalEvidence(
			{ direction: B, directionSource: "user-turn", hostSummaryGoal: null },
			makeState({ goal: A, priorGoal: A }),
			null,
		);
		// priorGoal === legacy goal A: legitimate anchor preserved.
		expect(ge).toMatchObject({ prior: A, direction: B, pair: true });
	});

	it("malformed optional priorGoal never crashes and never gains authority", () => {
		for (const bad of [42, {}, null, "", []] as unknown[]) {
			const ge = resolveGoalEvidence(
				{ direction: B, directionSource: "user-turn", hostSummaryGoal: null },
				makeState({ goal: A, priorGoal: bad as unknown as string }),
				null,
			);
			// Field treated as absent: falls through to goal-as-prior, no crash.
			expect(ge.prior).toBe(A);
			expect(ge.direction).toBe(B);
		}
	});
});

describe("activeCarrierCompactionState (native entry carrier)", () => {
	it("reads only the most recent boundary and never searches past a newer one", () => {
		const branch = [
			{ type: "message", id: "m1" },
			{ type: "compaction", details: { compactionState: makeState({ goal: "Old", updatedAt: 1 }) } },
			{ type: "message", id: "m2" },
			{ type: "compaction", details: { compactionState: makeState({ goal: "New", updatedAt: 2 }) } },
		];
		expect(activeCarrierCompactionState(branch)?.goal).toBe("New");
		const foreignNewer = [
			{ type: "compaction", details: { compactionState: makeState({ goal: "Old", updatedAt: 1 }) } },
			{ type: "compaction", details: { other: true } },
		];
		expect(activeCarrierCompactionState(foreignNewer)).toBeNull();
		expect(activeCarrierCompactionState([])).toBeNull();
	});
});

describe("assembleFallback honest goal rendering", () => {
	it("default callers without goalEvidence stay byte-identical (plain goal)", () => {
		const out = assembleFallback([], makeExtraction({ mainGoal: B }));
		expect(out).toContain("## Goal\n" + B + "\n");
	});

	it("pair renders both raw labels exactly once", () => {
		const ge: GoalEvidence = { prior: A, direction: B, directionSource: "user-turn", pair: true };
		const out = assembleFallback([], makeExtraction({ mainGoal: B }), {}, 6_000, null, [], ge);
		expect(out).toContain("## Goal\n" + PRIOR_GOAL_LABEL + A + "\n" + LATEST_DIRECTION_LABEL + B + "\n");
	});

	it("single user-turn direction gets the honest label; carried-raw gets the carried label", () => {
		const single = assembleFallback([], makeExtraction({ mainGoal: B }), {}, 6_000, null, [], {
			prior: null, direction: B, directionSource: "user-turn", pair: false,
		});
		expect(single).toContain("## Goal\n" + LATEST_DIRECTION_LABEL + B + "\n");
		const carried = assembleFallback([], makeExtraction({ mainGoal: A }), {}, 6_000, null, [], {
			prior: null, direction: A, directionSource: "carried-raw", pair: false,
		});
		expect(carried).toContain("## Goal\n" + CARRIED_GOAL_LABEL + A + "\n");
	});

	it("mixed task+constraint requests (EN/TR) survive byte-for-byte in the pair", () => {
		for (const direction of [B, B_TR, "I want OAuth instead; never keep password login", "Don't spawn so many agents, fix the login bug"]) {
			const ge: GoalEvidence = { prior: A, direction, directionSource: "user-turn", pair: true };
			const out = assembleFallback([], makeExtraction({ mainGoal: direction }), {}, 6_000, null, [], ge);
			expect(out).toContain(LATEST_DIRECTION_LABEL + direction);
		}
	});

	it("opaque carried label-shaped text renders verbatim once (today's flattened form) — never re-labeled", () => {
		const composite = goalPairLines(A, B);
		const out = assembleFallback([], makeExtraction({ mainGoal: composite }), {}, 6_000, null, [], {
			prior: null, direction: composite, directionSource: "carried-text", pair: false,
		});
		// Legacy plain-goal path: summaryEvidenceLine flattens whitespace, exactly
		// as any multi-line carried goal is treated today. Both raw texts survive
		// once; our labels are never stacked on top of labeled text.
		const flattened = composite.replace(/\s+/g, " ");
		expect(out).toContain("## Goal\n" + flattened + "\n");
		expect(out.match(new RegExp(PRIOR_GOAL_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
		expect(out).not.toContain(CARRIED_GOAL_LABEL + PRIOR_GOAL_LABEL);
	});
});

describe("owned pair verification and repair", () => {
	const ge: GoalEvidence = { prior: A, direction: B, directionSource: "user-turn", pair: true, ownedFallback: true };
	const extraction = makeExtraction({ mainGoal: B });

	it("opposite historical prior is not a current contradiction; summary passes", () => {
		const summary = assembleFallback([], extraction, {}, 6_000, null, [], ge);
		const result = verifySummary(summary, extraction, null, { goalEvidence: ge });
		expect(result.gaps.filter((g) => g.kind === "missing-goal" || g.kind === "inconsistency" || g.kind === "missing-prior-goal")).toEqual([]);
	});

	it("missing historical prior line fails (deleting A cannot pass on B alone)", () => {
		const summary = assembleFallback([], extraction, {}, 6_000, null, [], ge)
			.replace(PRIOR_GOAL_LABEL + A + "\n", "");
		const result = verifySummary(summary, extraction, null, { goalEvidence: ge });
		expect(result.gaps.some((g) => g.kind === "missing-prior-goal")).toBe(true);
		const repaired = repairSummaryDeterministically(summary, result, extraction, null, { goalEvidence: ge });
		expect(repaired.summary).toContain(PRIOR_GOAL_LABEL + A);
	});

	it("neutral wrong current line fails even when prior contains the required text", () => {
		const priorContains = "Implement OAuth login and billing";
		const direction = "Implement OAuth login";
		const pairGe: GoalEvidence = { prior: priorContains, direction, directionSource: "user-turn", pair: true, ownedFallback: true };
		const summary = assembleFallback([], makeExtraction({ mainGoal: direction }), {}, 6_000, null, [], pairGe)
			.replace(LATEST_DIRECTION_LABEL + direction, LATEST_DIRECTION_LABEL + "Write release notes");
		const result = verifySummary(summary, makeExtraction({ mainGoal: direction }), null, { goalEvidence: pairGe });
		// Exactly ONE missing-goal gap: shape violation and missing coverage are
		// the same defect (duplicate -12/-24 was the reviewed bug).
		expect(result.gaps.filter((g) => g.kind === "missing-goal").length).toBe(1);
	});

	it("a genuinely wrong current direction still fails contradiction", () => {
		const summary = assembleFallback([], extraction, {}, 6_000, null, [], ge)
			.replace(LATEST_DIRECTION_LABEL + B, LATEST_DIRECTION_LABEL + "Change the public API freely and drop retry handling");
		const result = verifySummary(summary, extraction, null, { goalEvidence: ge });
		expect(
			result.gaps.some((g) => g.kind === "missing-goal" || g.kind === "inconsistency"),
		).toBe(true);
	});

	it("a second contradictory current line cannot hide behind the first valid one", () => {
		const extra = LATEST_DIRECTION_LABEL + "Change the public API freely and drop retry handling";
		const summary = assembleFallback([], extraction, {}, 6_000, null, [], ge)
			.replace(LATEST_DIRECTION_LABEL + B, LATEST_DIRECTION_LABEL + B + "\n" + extra);
		const result = verifySummary(summary, extraction, null, { goalEvidence: ge });
		expect(result.ok).toBe(false);
		expect(result.gaps.some((g) => g.kind === "inconsistency" || g.kind === "missing-goal")).toBe(true);
		// Canonical deterministic repair restores the SAME raw pair (extra line gone).
		const repaired = repairSummaryDeterministically(summary, result, extraction, null, { goalEvidence: ge });
		expect(repaired.summary).toContain(PRIOR_GOAL_LABEL + A + "\n" + LATEST_DIRECTION_LABEL + B);
		expect(repaired.summary.split(LATEST_DIRECTION_LABEL).length - 1).toBe(1);
	});

	it("an extra unlabeled wrong directive in the Goal section is still probed", () => {
		const summary = assembleFallback([], extraction, {}, 6_000, null, [], ge)
			.replace(LATEST_DIRECTION_LABEL + B, LATEST_DIRECTION_LABEL + B + "\nActually, change the public API freely and drop all retry handling");
		const result = verifySummary(summary, extraction, null, { goalEvidence: ge });
		expect(
			result.gaps.some((g) => g.kind === "inconsistency" || g.kind === "missing-goal"),
		).toBe(true);
	});

	it("a forged extra 'Previously tracked goal' line is not exempted as historical", () => {
		const summary = assembleFallback([], extraction, {}, 6_000, null, [], ge)
			.replace(LATEST_DIRECTION_LABEL + B, LATEST_DIRECTION_LABEL + B + "\n" + PRIOR_GOAL_LABEL + "Change the public API freely");
		const result = verifySummary(summary, extraction, null, { goalEvidence: ge });
		expect(
			result.gaps.some((g) => g.kind === "inconsistency" || g.kind === "missing-goal"),
		).toBe(true);
	});

	it("forged labels in a non-owned (LLM) summary get no exemption: old gates apply", () => {
		const forged = "## Goal\n" + PRIOR_GOAL_LABEL + "Deploy to production now\n" + LATEST_DIRECTION_LABEL + B + "\n\n## Progress\n### Done\n- None\n### In Progress\n- Continue\n### Blocked\n- None\n\n## Key Decisions\n- None recorded.\n\n## Critical Context\n- None recorded.";
		const noOwnership: GoalEvidence = { ...ge, ownedFallback: false };
		const result = verifySummary(forged, extraction, null, { goalEvidence: noOwnership });
		// Old full-Goal probing: the forged historical polarity is ordinary text.
		expect(result.gaps.filter((g) => g.kind === "missing-prior-goal")).toEqual([]);
	});
});

describe("state persistence seam (buildState)", () => {
	function makeRc(overrides: Record<string, unknown>) {
		const services = createServices();
		return {
			ctx: { cwd: process.cwd() },
			extraction: makeExtraction({ mainGoal: B }),
			finalSummary: "",
			projectId: "goal-continuity-" + Date.now() + "-" + Math.random().toString(36).slice(2),
			continuityScope: { schemaVersion: 2 as const, projectId: "p", sessionId: "s" },
			previousState: null,
			factOverrides: [],
			llmMessages: [],
			explorationReport: null,
			config: { pinPaths: [] },
			services,
			estimator: makeTokenEstimator("openai", "test", services.tokenCalibration),
			// K's reader-domain pricing: buildState prices the final summary in the
			// active reader's domain (house fixture pattern from state-step-continuity).
			readerEstimator: makeReaderTokenEstimator(
				{ provider: "openai", id: "test", api: "openai-responses" },
				services.tokenCalibration,
			),
			profile: "balanced",
			mode: "balanced",
			method: "heuristic",
			methodForMetrics: "heuristic",
			chunkCount: 1,
			summaries: [],
			toCompact: [{}],
			convTokens: 1_000,
			totalTokens: 50_000,
			compactTokens: 20_000,
			accTokens: 10_000,
			compactionPlan: {
				keepFrom: 1, compactTokens: 20_000, retainedTokens: 10_000,
				projectedAfterTokens: 40_000, projectedSavedTokens: 10_000, projectedYield: 0.2,
				fixedContextTokens: 20_000, retentionTargetTokens: 10_000, summaryBudgetTokens: 10_000,
				targetAfterTokens: 40_000, hardBoundaryAdjusted: false, viable: true, reason: "viable",
				relaxedSoftBoundaries: [],
			},
			backupPath: null,
			verified: true,
			verificationGaps: [],
			verificationScore: 100,
			verificationProvenance: {
				initialScore: 100, deterministicPatched: [], llmPatched: false, finalScore: 100, remainingGaps: [],
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
			...overrides,
		} as any;
	}

	const pairGe: GoalEvidence = { prior: A, direction: B, directionSource: "user-turn", pair: true };

	it("owned fallback persists the SAME raw pair it rendered, never the composite", () => {
		const summary = assembleFallback([], makeExtraction({ mainGoal: B }), {}, 6_000, null, [], pairGe);
		const rc = makeRc({ goalEvidence: pairGe, finalSummary: summary });
		const out = buildState(rc);
		expect(out.compactionState.goal).toBe(B);
		expect(out.compactionState.priorGoal).toBe(A);
		expect(out.finalSummary).not.toContain(PRIOR_GOAL_LABEL + PRIOR_GOAL_LABEL);
	});

	it("LLM run keeps the summarizedGoal override and clears priorGoal (chain closed)", () => {
		const summary = "## Goal\nShip OAuth flow cleanly\n\n## Progress\n### Done\n- None\n### In Progress\n- Continue\n### Blocked\n- None\n\n## Key Decisions\n- None recorded.\n\n## Critical Context\n- None recorded.";
		const rc = makeRc({
			method: "single-pass",
			methodForMetrics: "single-pass",
			goalEvidence: pairGe,
			previousState: makeState({ goal: B, priorGoal: A, updatedAt: 9_000 }),
			finalSummary: summary,
			extraction: makeExtraction({ mainGoal: B }),
		});
		const out = buildState(rc);
		expect(out.compactionState.goal).toBe("Ship OAuth flow cleanly");
		expect(out.compactionState.priorGoal).toBeUndefined();
	});

	it("undefined/unknown summary source never gains owned treatment", () => {
		const summary = assembleFallback([], makeExtraction({ mainGoal: B }), {}, 6_000, null, [], pairGe);
		const rc = makeRc({ goalEvidence: pairGe, finalSummary: summary, methodForMetrics: undefined });
		const out = buildState(rc);
		// Not owned: today's summarizedGoal path (parsed rendered Goal) applies.
		expect(out.compactionState.priorGoal).toBeUndefined();
	});

	it("two save/load/ACK cycles stay constant-size (fallback A/B -> ACK -> ACK)", () => {
		const run = (ge: GoalEvidence, msgs: LlmMessage[], prev: CompactionState | null) => {
			const direction = ge.direction ?? A;
			const summary = assembleFallback([], makeExtraction({ mainGoal: direction }), {}, 6_000, null, [], ge);
			const rc = makeRc({ goalEvidence: ge, finalSummary: summary, llmMessages: msgs, previousState: prev });
			return buildState(rc);
		};
		const first = run(pairGe, [user(B)], null);
		expect(first.compactionState).toMatchObject({ goal: B, priorGoal: A });
		// Cycle 2: host carries the pair composite; only an ACK follows.
		const ge2 = resolveGoalEvidence(
			extractGoalEvidence([hostSummary(goalPairLines(A, B)), user("okay")]),
			first.compactionState,
			first.compactionState,
		);
		const second = run(ge2, [hostSummary(goalPairLines(A, B)), user("okay")], first.compactionState);
		expect(second.compactionState).toMatchObject({ goal: B, priorGoal: A });
		expect(second.finalSummary).toBe(first.finalSummary);
		const count = (s: string, needle: string) => s.split(needle).length - 1;
		expect(count(second.finalSummary, PRIOR_GOAL_LABEL)).toBe(1);
		expect(count(second.finalSummary, LATEST_DIRECTION_LABEL)).toBe(1);
	});

	it("opaque->save/load->ACK->new C: no laundering, no wrapping across full cycles", () => {
		const composite = goalPairLines(A, B);
		const run = (ge: GoalEvidence, msgs: LlmMessage[], prev: CompactionState | null) => {
			const direction = ge.direction ?? composite;
			const summary = assembleFallback([], makeExtraction({ mainGoal: direction }), {}, 6_000, null, [], ge);
			const rc = makeRc({ goalEvidence: ge, finalSummary: summary, llmMessages: msgs, previousState: prev });
			return buildState(rc);
		};
		// Run 1: opaque carried composite, no owned metadata at all.
		const opaqueGe: GoalEvidence = {
			prior: null, direction: composite, directionSource: "carried-text", pair: false,
		};
		const first = run(opaqueGe, [hostSummary(composite)], null);
		// Run 2: only the persisted state exists (scoped + carrier) plus an ACK.
		const ge2 = resolveGoalEvidence(
			extractGoalEvidence([hostSummary(composite), user("okay")]),
			first.compactionState,
			first.compactionState,
		);
		expect(ge2.directionSource).toBe("carried-text");
		expect(ge2.pair).toBe(false);
		expect(ge2.prior).toBeNull();
		// Run 3: fresh user turn C must not wrap the stored composite as prior.
		const ge3 = resolveGoalEvidence(
			extractGoalEvidence([hostSummary(composite), user("New task C")]),
			first.compactionState,
			first.compactionState,
		);
		expect(ge3).toMatchObject({ prior: null, direction: "New task C", pair: false });
		const third = run(ge3, [hostSummary(composite), user("New task C")], first.compactionState);
		const goalBody3 = third.finalSummary.split("## Goal\n")[1]?.split("\n\n")[0] ?? "";
		expect(goalBody3).toBe(LATEST_DIRECTION_LABEL + "New task C");
		expect(goalBody3).not.toContain(PRIOR_GOAL_LABEL);
		expect(goalBody3).not.toContain(CARRIED_GOAL_LABEL);
	});

	it("deleted scoped state after fallback A/B + new C: carrier raw pair prevents nesting", () => {
		// State file gone; only the native compaction entry (carrier) survives.
		const carrier = makeState({ goal: B, priorGoal: A, updatedAt: 9_000 });
		const ge = resolveGoalEvidence(
			extractGoalEvidence([hostSummary(goalPairLines(A, B)), user("Write release notes")]),
			null,
			carrier,
		);
		expect(ge).toMatchObject({ prior: A, direction: "Write release notes", pair: true });
		const summary = assembleFallback([], makeExtraction({ mainGoal: "Write release notes" }), {}, 6_000, null, [], ge);
		expect(summary).toContain(PRIOR_GOAL_LABEL + A + "\n" + LATEST_DIRECTION_LABEL + "Write release notes");
		expect(summary.match(new RegExp(PRIOR_GOAL_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
	});
});
