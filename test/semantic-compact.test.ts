import { describe, expect, test } from "bun:test";
import { parseExplorationReport } from "../src/phases/explore";
import { verifySummary } from "../src/phases/verify";
import type { LlmMessage, ProfileConfig, StructuredExtraction } from "../src/types";
import { extractStructured } from "../src/utils/extraction";
import { estimateTokens } from "../src/utils/tokens";

const profile: ProfileConfig = {
  summaryBudgetTokens: 6000,
  keepRecentTokens: 20000,
  minChunkTokens: 10,
  maxChunkTokens: 1000,
  singlePassMaxTokens: 30000,
  batchMaxTokens: 24000,
};

function baseExtraction(): StructuredExtraction {
  return {
    modifiedFiles: [{ path: "src/index.ts", toolCalls: 1, lastModifiedIndex: 2 }],
    readFiles: ["src/index.ts"],
    deletedFiles: [],
    errors: [],
    decisions: [],
    constraints: [],
    topics: [],
    timeline: [],
    mainGoal: "update the extension",
    lastUserMessages: [],
    lastErrors: [],
    messageCount: 3,
  };
}

describe("extractStructured", () => {
  test("captures file modifications", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: [{ type: "text", text: "Update the extension" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "edit", arguments: { path: "src/index.ts" } }] },
      { role: "toolResult", toolCallId: "1", isError: false, content: [{ type: "text", text: "Applied 1 edit" }] },
    ];

    const extraction = extractStructured(messages, profile);
    expect(extraction.modifiedFiles).toHaveLength(1);
    expect(extraction.modifiedFiles[0]?.path).toBe("src/index.ts");
    expect(extraction.mainGoal).toBe("Update the extension");
  });

  test("captures tool errors", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: [{ type: "text", text: "Run tests" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "2", name: "bash", arguments: { command: "bun test" } }] },
      { role: "toolResult", toolCallId: "2", isError: true, content: [{ type: "text", text: "test failed" }] },
    ];

    const extraction = extractStructured(messages, profile);
    expect(extraction.errors).toHaveLength(1);
    expect(extraction.errors[0]?.tool).toBe("bash");
  });

  test("handles empty conversations", () => {
    const extraction = extractStructured([], profile);
    expect(extraction.modifiedFiles).toHaveLength(0);
    expect(extraction.errors).toHaveLength(0);
    expect(extraction.messageCount).toBe(0);
  });
});

describe("verifySummary", () => {
  test("returns score 100 for full coverage", () => {
    const extraction = baseExtraction();
    const summary = [
      "## Goal",
      "update the extension",
      "## Constraints & Preferences",
      "- none",
      "## Progress",
      "### Done",
      "- [x] Updated src/index.ts",
      "### In Progress",
      "- [ ] none",
      "### Blocked",
      "- none",
      "## Key Decisions",
      "- none",
      "## Files Modified",
      "- src/index.ts",
      "## Files Read",
      "- src/index.ts",
      "## Next Steps",
      "1. run tests",
      "## Critical Context",
      "- keep extension stable",
    ].join("\n");

    const result = verifySummary(summary, extraction);
    expect(result.ok).toBe(true);
    expect(result.score).toBe(100);
  });

  test("flags missing file coverage", () => {
    const extraction = baseExtraction();
    const summary = [
      "## Goal",
      "update the extension",
      "## Progress",
      "### Done",
      "- [x] Updated files",
      "## Critical Context",
      "- keep extension stable",
    ].join("\n");

    const result = verifySummary(summary, extraction);
    expect(result.ok).toBe(false);
    expect(result.gaps.some(gap => gap.includes("Missing modified file"))).toBe(true);
    expect(result.score).toBeLessThan(100);
  });
});

describe("estimateTokens", () => {
  test("returns a positive estimate", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
  });
});

describe("parseExplorationReport", () => {
  const messages: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: "Fix the build" }] }];

  test("parses valid JSON", () => {
    const report = parseExplorationReport('{"mainGoal":"Fix the build","sessionType":"implementation","boundaries":[{"afterIndex":0,"topic":"build","priority":"high","confidence":0.9}],"enrichedConstraints":[],"crossReferences":[],"statusAssessment":{"done":[],"inProgress":["build"],"blocked":[]},"criticalContext":[],"keyDecisions":[]}', messages);
    expect(report.mainGoal).toBe("Fix the build");
    expect(report.boundaries).toHaveLength(1);
  });

  test("falls back on invalid JSON", () => {
    const report = parseExplorationReport("not-json", messages);
    expect(report.mainGoal).toBe("Fix the build");
    expect(report.boundaries).toHaveLength(0);
  });
});
