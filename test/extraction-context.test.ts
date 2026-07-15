import { describe, expect, it } from "bun:test";
import { buildExtractionContext, preProcessSummaries } from "../src/utils/helpers.ts";
import type { StructuredExtraction } from "../src/types.ts";

function extraction(): StructuredExtraction {
  return {
    modifiedFiles: [], readFiles: [], deletedFiles: [], mediaAttachments: [],
    errors: [
      { index: 1, tool: "bash", message: "test failed", retryAttempted: false, resolved: false },
      { index: 2, tool: "bash", message: "test failed", retryAttempted: false, resolved: false },
      { index: 3, tool: "bash", message: "test failed", retryAttempted: false, resolved: false },
    ],
    decisions: [
      { index: 1, type: "implicit", summary: "Use TypeScript" },
      { index: 2, type: "implicit", summary: "Use TypeScript" },
    ],
    constraints: [], topics: [], timeline: [], mainGoal: null,
    lastUserMessages: [], lastErrors: [], messageCount: 4,
  };
}

describe("buildExtractionContext", () => {
  it("deduplicates repeated facts and preserves their frequency", () => {
    const context = buildExtractionContext(extraction());
    expect(context.match(/test failed/g)).toHaveLength(1);
    expect(context).toContain("test failed ×3");
    expect(context.match(/Use TypeScript/g)).toHaveLength(1);
    expect(context).toContain("Use TypeScript ×2");
  });
});

describe("focus-weighted topic budgets", () => {
  it("allocates more assembly budget to the focused topic", () => {
    const result = preProcessSummaries([
      { topic: "auth", startIndex: 0, endIndex: 1, summary: "JWT auth", keyDecisions: [], filesModified: ["src/auth.ts"], filesRead: [], priority: "normal" },
      { topic: "billing", startIndex: 2, endIndex: 3, summary: "invoice UI", keyDecisions: [], filesModified: ["src/billing.ts"], filesRead: [], priority: "normal" },
    ], 2000, "auth");
    const budgets = [...result.text.matchAll(/Segment \d+: ([^\n]+)[\s\S]*?Budget: ~(\d+) tokens/g)]
      .map(match => ({ topic: match[1], budget: Number(match[2]) }));
    expect(budgets.find(item => item.topic === "auth")!.budget)
      .toBeGreaterThan(budgets.find(item => item.topic === "billing")!.budget);
  });
});
