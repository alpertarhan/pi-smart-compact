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

function context(confirmed: boolean) {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  return {
    ui: {
      custom: async (factory: any) => await new Promise(resolve => {
        const component = factory({ requestRender: () => {} }, theme, {}, resolve);
        component.handleInput("x");
      }),
      confirm: async () => confirmed,
    },
  } as any;
}

describe("manual compaction approval", () => {
  it("returns cancel when the user declines after reviewing provenance", async () => {
    expect(await showResultScreen(context(false), details, extraction, createServices(), { approval: true })).toBe("cancel");
  });

  it("returns apply only after explicit confirmation", async () => {
    expect(await showResultScreen(context(true), details, extraction, createServices(), { approval: true })).toBe("apply");
  });
});
