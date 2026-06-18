import { describe, it, expect } from "bun:test";
import { parseExplorationReport, fallbackExplorationReport, shouldExplore, buildExplorationReportFromParsed } from "../src/phases/explore.ts";
import type { LlmMessage } from "../src/types.ts";

describe("parseExplorationReport", () => {
  it("parses raw JSON", () => {
    const json = '{"boundaries":[{"afterIndex":5,"topic":"Auth","priority":"high","confidence":0.9}],"mainGoal":"Build auth","sessionType":"implementation","enrichedConstraints":[],"crossReferences":[],"statusAssessment":{"done":[],"inProgress":[],"blocked":[]},"criticalContext":[],"keyDecisions":[]}';
    const report = parseExplorationReport(json, []);
    expect(report.boundaries.length).toBe(1);
    expect(report.boundaries[0].topic).toBe("Auth");
    expect(report.mainGoal).toBe("Build auth");
  });

  it("parses markdown-fenced JSON", () => {
    const json = '```json\n{"boundaries":[],"mainGoal":"x","sessionType":"review"}\n```';
    const report = parseExplorationReport(json, []);
    expect(report.mainGoal).toBe("x");
    expect(report.sessionType).toBe("review");
  });

  it("returns fallback for invalid JSON", () => {
    const report = parseExplorationReport("not json at all", []);
    expect(report.boundaries.length).toBe(0);
    expect(report.mainGoal).toBe("");
  });

  it("extracts boundaries array from malformed JSON", () => {
    const text = 'some text before {"boundaries": [{"afterIndex":3,"topic":"X","priority":"normal","confidence":0.5}]} and after';
    const report = parseExplorationReport(text, []);
    expect(report.boundaries.length).toBe(1);
    expect(report.boundaries[0].topic).toBe("X");
  });
});

describe("buildExplorationReportFromParsed", () => {
  it("returns a fallback for primitive JSON values (number/string/boolean)", () => {
    // A model can return JSON that parses to a non-object (e.g. just `42`).
    // The builder must not throw on such input — it falls back to an empty
    // report so the pipeline can continue with heuristic boundaries.
    expect(() => buildExplorationReportFromParsed(42, [])).not.toThrow();
    expect(() => buildExplorationReportFromParsed("a string", [])).not.toThrow();
    expect(() => buildExplorationReportFromParsed(true, [])).not.toThrow();
    const report = buildExplorationReportFromParsed(42, []);
    expect(report.boundaries.length).toBe(0);
  });

  it("returns a fallback for null", () => {
    expect(() => buildExplorationReportFromParsed(null, [])).not.toThrow();
    const report = buildExplorationReportFromParsed(null, []);
    expect(report.boundaries.length).toBe(0);
  });

  it("parses a well-formed object", () => {
    const report = buildExplorationReportFromParsed(
      { boundaries: [{ afterIndex: 2, topic: "X", priority: "normal", confidence: 0.5 }], mainGoal: "g", sessionType: "review" },
      [],
    );
    expect(report.boundaries.length).toBe(1);
    expect(report.mainGoal).toBe("g");
    expect(report.sessionType).toBe("review");
  });
});

describe("buildExplorationReportFromParsed — boundary normalization", () => {
  const fourMsgs: LlmMessage[] = [1, 2, 3, 4].map(() => ({ role: "user", content: "x" }));

  it("clamps a negative afterIndex up to 0", () => {
    const report = buildExplorationReportFromParsed(
      { boundaries: [{ afterIndex: -5, topic: "X", priority: "normal", confidence: 0.5 }] }, [],
    );
    expect(report.boundaries[0].afterIndex).toBe(0);
  });

  it("clamps afterIndex down to llmLength - 2", () => {
    const report = buildExplorationReportFromParsed(
      { boundaries: [{ afterIndex: 100, topic: "X", priority: "normal", confidence: 0.5 }] }, fourMsgs,
    );
    // fourMsgs.length = 4 → maxIndex = max(0, 4 - 2) = 2
    expect(report.boundaries[0].afterIndex).toBe(2);
  });

  it("falls back to 0.5 confidence when confidence is non-numeric", () => {
    const report = buildExplorationReportFromParsed(
      { boundaries: [{ afterIndex: 1, topic: "X", priority: "normal", confidence: "high" }] }, [],
    );
    expect(report.boundaries[0].confidence).toBe(0.5);
  });

  it("clamps a numeric confidence into [0, 1]", () => {
    const over = buildExplorationReportFromParsed(
      { boundaries: [{ afterIndex: 1, topic: "X", priority: "normal", confidence: 5 }] }, [],
    );
    expect(over.boundaries[0].confidence).toBe(1);
    const under = buildExplorationReportFromParsed(
      { boundaries: [{ afterIndex: 1, topic: "X", priority: "normal", confidence: -3 }] }, [],
    );
    expect(under.boundaries[0].confidence).toBe(0);
  });

  it("defaults an invalid priority to normal", () => {
    const report = buildExplorationReportFromParsed(
      { boundaries: [{ afterIndex: 1, topic: "X", priority: "urgent", confidence: 0.5 }] }, [],
    );
    expect(report.boundaries[0].priority).toBe("normal");
  });

  it("returns empty mainGoal for a non-string value", () => {
    const report = buildExplorationReportFromParsed({ mainGoal: 42 }, []);
    expect(report.mainGoal).toBe("");
  });
});

describe("fallbackExplorationReport", () => {
  it("extracts main goal from messages", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "Build a CLI tool" },
    ];
    const report = fallbackExplorationReport(msgs);
    expect(report.mainGoal).toBe("Build a CLI tool");
    expect(report.boundaries.length).toBe(0);
  });
});

describe("shouldExplore", () => {
  it("skips exploration for simple sessions", () => {
    const extraction: import("../src/types.ts").StructuredExtraction = {
      modifiedFiles: [{ path: "src/index.ts", toolCalls: 2, lastModifiedIndex: 5 }],
      readFiles: [], deletedFiles: [],
      errors: [], decisions: [], constraints: [], topics: [
        { startIndex: 0, endIndex: 5, primaryFile: "src/index.ts", type: "implementation", errorDensity: 0 },
      ], timeline: [], mainGoal: "simple task", lastUserMessages: [], lastErrors: [], messageCount: 10,
    };
    expect(shouldExplore(extraction)).toBe(false);
  });

  it("requires exploration for complex sessions", () => {
    const extraction: import("../src/types.ts").StructuredExtraction = {
      modifiedFiles: [
        { path: "src/auth.ts", toolCalls: 3, lastModifiedIndex: 10 },
        { path: "src/db.ts", toolCalls: 2, lastModifiedIndex: 15 },
        { path: "lib/utils.ts", toolCalls: 1, lastModifiedIndex: 20 },
        { path: "src/api.ts", toolCalls: 1, lastModifiedIndex: 25 },
      ],
      readFiles: [], deletedFiles: [],
      errors: [
        { index: 12, tool: "bash", message: "test failed", retryAttempted: true, resolved: false },
        { index: 18, tool: "bash", message: "build error", retryAttempted: false, resolved: false },
        { index: 22, tool: "bash", message: "lint error", retryAttempted: false, resolved: false },
      ], decisions: [
        { index: 5, type: "explicit", summary: "Use JWT", userResponse: "yes" },
        { index: 8, type: "implicit", summary: "Switch to PostgreSQL" },
        { index: 14, type: "explicit", summary: "Add logging", userResponse: "ok" },
        { index: 19, type: "implicit", summary: "Use bcrypt" },
      ], constraints: [], topics: [
        { startIndex: 0, endIndex: 5, primaryFile: "src/auth.ts", type: "implementation", errorDensity: 0 },
        { startIndex: 6, endIndex: 12, primaryFile: "src/db.ts", type: "debugging", errorDensity: 2 },
        { startIndex: 13, endIndex: 20, primaryFile: "lib/utils.ts", type: "implementation", errorDensity: 1 },
        { startIndex: 21, endIndex: 25, primaryFile: "src/api.ts", type: "review", errorDensity: 0 },
      ], timeline: [], mainGoal: "complex task", lastUserMessages: [], lastErrors: [], messageCount: 30,
    };
    expect(shouldExplore(extraction)).toBe(true);
  });
});
