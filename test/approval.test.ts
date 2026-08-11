import { describe, expect, it } from "bun:test";
import { showResultScreen } from "../src/ui/overlays.ts";
import { createServices } from "../src/infra/services.ts";
import type { SmartCompactDetails, StructuredExtraction } from "../src/types.ts";

const details: SmartCompactDetails = {
  method: "eesv", chunkCount: 1, topics: ["auth"], readFiles: [], modifiedFiles: ["src/auth.ts"],
  totalMessages: 10, totalTokensSummarized: 1000, llmCalls: 2, profile: "balanced", backupPath: null,
  tokensSaved: 500, verified: true, gaps: [], explorationRounds: 1, explorationBoundaries: 1,
  model: "openai/test", qualityScore: 100, tokensBefore: 1500,
  provenance: { initialScore: 95, deterministicPatched: [{ kind: "missing-file", path: "src/auth.ts" }], llmPatched: false, finalScore: 100, remainingGaps: [] },
};
const extraction: StructuredExtraction = {
  modifiedFiles: [{ path: "src/auth.ts", toolCalls: 1, lastModifiedIndex: 1 }], readFiles: [], deletedFiles: [],
  errors: [], decisions: [], constraints: [], topics: [], timeline: [], mainGoal: "auth", lastUserMessages: [], lastErrors: [], messageCount: 10,
};

function context(action: "a" | "c", calls: { custom: number }) {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  return {
    ui: {
      custom: async (factory: any) => await new Promise(resolve => {
        calls.custom++;
        const component = factory(
          { requestRender: () => {} },
          theme,
          { matches: () => false },
          resolve,
        );
        component.handleInput(action);
      }),
      confirm: async () => { throw new Error("approval must stay in the review screen"); },
    },
  } as any;
}

describe("manual compaction approval", () => {
  it("returns cancel from the single review screen", async () => {
    const calls = { custom: 0 };
    expect(await showResultScreen(context("c", calls), details, extraction, createServices(), { approval: true })).toBe("cancel");
    expect(calls.custom).toBe(1);
  });

  it("applies only from the explicit review-screen action", async () => {
    const calls = { custom: 0 };
    expect(await showResultScreen(context("a", calls), details, extraction, createServices(), { approval: true })).toBe("apply");
    expect(calls.custom).toBe(1);
  });
});
