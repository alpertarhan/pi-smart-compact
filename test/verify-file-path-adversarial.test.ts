// pi-lens-ignore: ts:2307
import { describe, expect, it } from "bun:test";
import { PROFILES } from "../src/constants.ts";
import { assembleFallback } from "../src/phases/synthesize.ts";
import {
	repairSummaryDeterministically,
	verifySummary,
} from "../src/phases/verify.ts";
import { extractStructured } from "../src/utils/extraction.ts";
import { estimateTokens } from "../src/utils/tokens.ts";
import type {
	CompactionState,
	LlmMessage,
	StructuredExtraction,
} from "../src/types.ts";

function extraction(
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
		messageCount: 5_000,
		referencedFiles: [],
		...partial,
	};
}

function state(partial: Partial<CompactionState> = {}): CompactionState {
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
		compactionVersion: "test",
		...partial,
	};
}

const pathMatrix = [
	"/repo/src/Foo.Application/Implementations",
	"/repo/src/Foo.Infrastructure/Dockerfile",
	"/repo/src/Foo.Infrastructure/Directory.Build.props",
	"/repo/db/PostgreSQL.Migrations/V1.2__add_users.sql",
	"/repo/.terraform/providers/registry.terraform.io/hashicorp/aws/current",
	"/repo/My Project/src/Foo.Application/Auth Handler.cs",
	"/repo/My  Project/src/Foo.Application/Auth.cs",
	"/repo/@scope/src/Foo.Infrastructure/Repositories",
	"/repo/çalışma/src/Foo.Application/Messaging",
	"C:\\repo\\src\\Foo.Application\\Dockerfile",
	"./src/Foo.Application/.env",
	"../src/Foo.Application/Auth.cs",
	"file:///repo/Foo.Application/Auth.cs",
	"/repo/[archive]/Foo.Application/(generated)/Auth.cs",
	"/repo/Foo.Application/🚀/Auth.cs",
	"/repo/Foo.Application/line\nAuth.cs",
	"- unusual/Foo.Application/Auth.cs",
	"## generated/Foo.Application/Auth.cs",
	"[x] Foo.Application/Auth.cs",
	"`Foo.Application/Auth.cs`",
	"none",
	"None recorded.",
	"/repo/" + "Company.Platform.Infrastructure/".repeat(14) + "Dockerfile",
];

describe("file verification under long-session path shapes", () => {
	it("keeps modified, read, and deleted path matrices verifiable", () => {
		for (const path of pathMatrix) {
			for (const kind of ["modified", "read", "deleted"] as const) {
				const value = extraction({
					modifiedFiles:
						kind === "modified"
							? [{ path, toolCalls: 1, lastModifiedIndex: 4_999 }]
							: [],
					readFiles: kind === "read" ? [path] : [],
					deletedFiles: kind === "deleted" ? [path] : [],
				});
				const summary = assembleFallback([], value);
				expect(verifySummary(summary, value).gaps, kind + ": " + path).toEqual(
					[],
				);
			}
		}
	});

	it("keeps seeded infrastructure path combinations at a verification fixed point", () => {
		let seed = 0x5eed1234;
		const next = () =>
			(seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32;
		const directories = [
			"Foo.Application",
			"Foo.Infrastructure",
			"PostgreSQL.Migrations",
			"My Project",
			"@scope",
			"çalışma",
			".terraform",
			"registry.terraform.io",
			"[archive]",
		];
		const leaves = [
			"Dockerfile",
			"Auth.cs",
			"Auth Handler.cs",
			"Directory.Build.props",
			"V1.2__init.sql",
			".env",
		];
		for (let index = 0; index < 256; index++) {
			const path =
				"/repo/" +
				directories[Math.floor(next() * directories.length)] +
				"/" +
				directories[Math.floor(next() * directories.length)] +
				"/" +
				leaves[Math.floor(next() * leaves.length)];
			const kind = index % 3;
			const value = extraction({
				modifiedFiles:
					kind === 0 ? [{ path, toolCalls: 1, lastModifiedIndex: index }] : [],
				readFiles: kind === 1 ? [path] : [],
				deletedFiles: kind === 2 ? [path] : [],
				errors:
					index % 7 === 0
						? [
								{
									index,
									tool: "research",
									message: "Research unavailable. Available: none at " + path,
									retryAttempted: false,
									resolved: false,
								},
							]
						: [],
			});
			const budget = [3_000, 6_000, 10_000][index % 3];
			const summary = assembleFallback([], value, {}, budget);
			const result = verifySummary(summary, value, null, {
				summaryBudgetTokens: budget,
			});
			const repaired = repairSummaryDeterministically(
				summary,
				result,
				value,
				null,
				{ summaryBudgetTokens: budget },
			);
			expect(repaired.result.gaps, path).toEqual([]);
		}
	});

	it("keeps collision-prone path identities distinct", () => {
		const shared = "/repo/" + "Company.Platform.Infrastructure/".repeat(300);
		const paths = [
			"/repo/My  Project/Auth.cs",
			"/repo/My Project/Auth.cs",
			"- unusual/Auth.cs",
			"unusual/Auth.cs",
			shared + "A.cs",
			shared + "B.cs",
		];
		const value = extraction({
			modifiedFiles: paths.map((path, index) => ({
				path,
				toolCalls: 1,
				lastModifiedIndex: index,
			})),
		});
		const summary = assembleFallback([], value, {}, 3_000);
		const lines =
			summary
				.match(/## Files Modified\n([\s\S]*?)(?=\n## )/)?.[1]
				.trim()
				.split("\n") ?? [];

		expect(lines).toHaveLength(paths.length);
		expect(new Set(lines).size).toBe(paths.length);
		expect(
			verifySummary(summary, value, null, { summaryBudgetTokens: 3_000 }).gaps,
		).toEqual([]);
	});

	it("survives extraction caps with dotted namespaces and research-agent errors", () => {
		const modifiedFiles = Array.from({ length: 120 }, (_, index) => ({
			path: "/repo/services/Company.Application." + index + "/Dockerfile",
			toolCalls: 3,
			lastModifiedIndex: 4_000 + index,
		}));
		const readFiles = Array.from(
			{ length: 160 },
			(_, index) =>
				"/repo/My Project/Company.Infrastructure." + index + "/Repositories",
		);
		const deletedFiles = Array.from(
			{ length: 120 },
			(_, index) =>
				"/repo/db/PostgreSQL.Migrations/Version." + index + "/archive",
		);
		const error = "Unknown research subagent. Available: none";
		const value = extraction({
			modifiedFiles,
			readFiles,
			deletedFiles,
			errors: [
				{
					index: 4_999,
					tool: "research",
					message: error,
					retryAttempted: false,
					resolved: false,
				},
			],
			referencedFiles: Array.from(
				{ length: 200 },
				(_, index) =>
					"/repo/@scope/Research.Infrastructure." +
					index +
					"/reports/result.json",
			),
		});

		for (const profile of Object.values(PROFILES)) {
			const budget = profile.summaryBudgetTokens;
			const summary = assembleFallback([], value, {}, budget);
			const result = verifySummary(summary, value, null, {
				summaryBudgetTokens: budget,
			});
			expect(result.gaps).toEqual([]);
			expect(estimateTokens(summary)).toBeLessThan(budget);
			expect(summary).toMatch(/#[A-Za-z0-9_-]{12}/);
			expect(summary).not.toContain(modifiedFiles.at(-1)!.path);
		}
	});

	it("grounds references beyond the human-summary cap from source messages", () => {
		const messages: LlmMessage[] = [];
		const firstPath = "/repo/research/Architecture.Document.0.md";
		for (let index = 0; index <= 200; index++) {
			const id = "research-" + index;
			messages.push({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id,
						name: "research",
						arguments: { task: "Inspect architecture " + index },
					},
				],
			});
			messages.push({
				role: "toolResult",
				toolCallId: id,
				toolName: "research",
				content: [
					{
						type: "text",
						text:
							"Finding in /repo/research/Architecture.Document." +
							index +
							".md",
					},
				],
				isError: false,
			});
		}
		const value = extractStructured(messages, PROFILES.balanced);
		const summary =
			assembleFallback([], value) + "\n- Research source: " + firstPath;
		const result = verifySummary(summary, value, null, {
			sourceMessages: messages,
		});

		expect(value.referencedFiles).toHaveLength(200);
		expect(value.referencedFiles).not.toContain(firstPath);
		expect(result.gaps.filter((gap) => gap.kind === "fabricated-file")).toEqual(
			[],
		);

		const partial = firstPath.slice(0, -1);
		const partialResult = verifySummary(
			assembleFallback([], value) + "\n- Research source: " + partial,
			value,
			null,
			{ sourceMessages: messages },
		);
		expect(partialResult.gaps).toContainEqual({
			kind: "fabricated-file",
			ref: partial,
		});
	});

	it("grounds deterministic user, timeline, and topic path evidence", () => {
		const userPath = "/repo/docs/Research.Infrastructure/ROADMAP.md";
		const timelinePath = "/repo/db/PostgreSQL.Migrations/V1.2__init.sql";
		const topicPath = "/repo/src/Foo.Application/Implementations";
		const value = extraction({
			lastUserMessages: ["Continue from " + userPath],
			timeline: [
				{
					index: 4_998,
					event: "action",
					summary: "Investigated " + timelinePath,
				},
			],
			topics: [
				{
					startIndex: 0,
					endIndex: 4_999,
					primaryFile: topicPath,
					type: "exploration",
					errorDensity: 0,
				},
			],
		});

		expect(verifySummary(assembleFallback([], value), value).gaps).toEqual([]);
	});

	it("grounds a path truncated inside deterministic error evidence", () => {
		const path =
			"/repo/@scope/PostgreSQL.Migrations/çalışma/registry.terraform.io/foo-bar/Makefile";
		const error = "x".repeat(80) + " research failed at " + path;
		const value = extraction({
			errors: [
				{
					index: 4_999,
					tool: "research",
					message: error,
					retryAttempted: false,
					resolved: false,
				},
			],
		});

		expect(verifySummary(assembleFallback([], value), value).gaps).toEqual([]);
	});

	it("repairs all path categories without fabricated-file oscillation", () => {
		const value = extraction({
			modifiedFiles: [
				{ path: pathMatrix[1], toolCalls: 2, lastModifiedIndex: 4_900 },
			],
			readFiles: [pathMatrix[0], pathMatrix[6]],
			deletedFiles: [pathMatrix[3]],
		});
		const summary =
			"## Goal\nContinue infrastructure work\n## Progress\n### In Progress\n- Working\n### Blocked\n- None recorded.\n## Critical Context\n- Stable";
		const initial = verifySummary(summary, value);
		const repaired = repairSummaryDeterministically(summary, initial, value);

		expect(repaired.result.gaps).toEqual([]);
		expect(repaired.patched.some((gap) => gap.kind === "missing-file")).toBe(
			true,
		);
		expect(
			repaired.patched.some((gap) => gap.kind === "missing-read-file"),
		).toBe(true);
		expect(
			repaired.patched.some((gap) => gap.kind === "missing-deleted-file"),
		).toBe(true);
	});

	it("replaces stale compact path tokens when the evidence budget changes", () => {
		const path = "/repo/src/Foo.Application/Implementations/Auth.cs";
		const value = extraction({ readFiles: [path] });
		const stale =
			'## Goal\nContinue\n## Progress\n- Working\n## Files Read\n- "…/Auth.cs#old-token"\n## Critical Context\n- Stable';
		const initial = verifySummary(stale, value);
		const repaired = repairSummaryDeterministically(stale, initial, value);

		expect(initial.gaps).toContainEqual({ kind: "missing-read-file", path });
		expect(repaired.result.gaps).toEqual([]);
		expect(repaired.summary).not.toContain("old-token");
		expect(repaired.summary).toContain(JSON.stringify(path));
	});

	it("repairs a deleted path carried across repeated compactions", () => {
		const carried = "/repo/db/PostgreSQL.Migrations/Version.42/archive";
		const value = extraction();
		const continuity = state({ deletedFiles: [carried] });
		const integrated = assembleFallback([], value, {}, 6_000, continuity);
		expect(verifySummary(integrated, value, continuity).gaps).toEqual([]);

		const legacy = assembleFallback([], value);
		const initial = verifySummary(legacy, value, continuity);
		const repaired = repairSummaryDeterministically(
			legacy,
			initial,
			value,
			continuity,
		);
		expect(initial.gaps).toContainEqual({
			kind: "missing-deleted-file",
			path: carried,
		});
		expect(repaired.result.gaps).toEqual([]);
		expect(repaired.summary).toContain(carried);
	});

	it("bounds hostile path input while preserving a verifiable canonical line", () => {
		const path =
			"/repo/" + "Company.Platform.Infrastructure/".repeat(300) + "Dockerfile";
		const value = extraction({ readFiles: [path] });
		const summary = assembleFallback([], value, {}, 3_000);

		expect(path.length).toBeGreaterThan(4_096);
		expect(summary).not.toContain(path);
		expect(summary).toMatch(/Dockerfile#[A-Za-z0-9_-]{12}/);
		expect(
			verifySummary(summary, value, null, { summaryBudgetTokens: 3_000 }).gaps,
		).toEqual([]);
	});
});
