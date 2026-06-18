import { describe, it, expect } from "bun:test";
import { assembleFallback, failedChunkSummary } from "../src/phases/synthesize.ts";
import type { StructuredExtraction, ChunkSummary, LlmChunk, LlmMessage } from "../src/types.ts";

function makeExtraction(partial: Partial<StructuredExtraction> = {}): StructuredExtraction {
  return {
    modifiedFiles: [], readFiles: [], deletedFiles: [],
    errors: [], decisions: [], constraints: [], topics: [], timeline: [],
    mainGoal: null, lastUserMessages: [], lastErrors: [], messageCount: 0,
    ...partial,
  };
}

const SECTIONS = [
  "## Goal", "## Constraints & Preferences", "## Progress", "### Done",
  "### In Progress", "### Blocked", "## Key Decisions", "## Files Modified",
  "## Files Read", "## Next Steps", "## Critical Context", "## Topics Covered",
];

describe("assembleFallback (deterministic fallback when LLM assembly fails)", () => {
  it("produces a complete structured summary even with empty input", () => {
    const out = assembleFallback([], makeExtraction());
    expect(out.startsWith("## Goal")).toBe(true);
    for (const h of SECTIONS) expect(out).toContain(h);
  });

  it("uses the extracted mainGoal and falls back to a placeholder when absent", () => {
    expect(assembleFallback([], makeExtraction({ mainGoal: "Ship auth" }))).toContain("Ship auth");
    expect(assembleFallback([], makeExtraction({ mainGoal: null }))).toContain("See topics below.");
  });

  it("includes deterministically-extracted modified and read files", () => {
    const out = assembleFallback([], makeExtraction({
      modifiedFiles: [{ path: "src/a.ts", toolCalls: 1, lastModifiedIndex: 0 }],
      readFiles: ["lib/b.ts"],
    }));
    expect(out).toContain("- src/a.ts");
    expect(out).toContain("- lib/b.ts");
  });

  it("surfaces unresolved errors in Critical Context and high-priority topics in Progress", () => {
    const summaries: ChunkSummary[] = [
      { topic: "Auth", startIndex: 0, endIndex: 3, summary: "wiring jwt", keyDecisions: [], filesModified: [], filesRead: [], priority: "high" },
      { topic: "Docs", startIndex: 4, endIndex: 6, summary: "readme", keyDecisions: [], filesModified: [], filesRead: [], priority: "low" },
    ];
    const out = assembleFallback(summaries, makeExtraction({
      errors: [{ index: 2, tool: "bash", message: "test failed", retryAttempted: false, resolved: false }],
    }));
    expect(out).toContain("Unresolved error: test failed");
    expect(out).toContain("wiring jwt");
    expect(out).toContain("**Auth** [high]");
    expect(out).toContain("**Docs** [low]");
  });

  it("preserves key decisions from extraction", () => {
    const out = assembleFallback([], makeExtraction({
      decisions: [{ index: 1, type: "explicit", summary: "Use JWT", userResponse: "yes" }],
    }));
    expect(out).toContain("Use JWT");
  });
});

describe("failedChunkSummary (per-segment fallback when a batch LLM call fails)", () => {
  const chunk: LlmChunk = {
    topic: "Auth work", startIndex: 0, endIndex: 3, tokenEstimate: 100, priority: "high",
    messages: [
      { role: "user", content: "add login" } as LlmMessage,
      { role: "assistant", content: [{ type: "text", text: "ok doing it" }] } as LlmMessage,
    ],
  };

  it("preserves identity fields (topic / range / priority)", () => {
    const s = failedChunkSummary(chunk);
    expect(s.topic).toBe("Auth work");
    expect(s.startIndex).toBe(0);
    expect(s.endIndex).toBe(3);
    expect(s.priority).toBe("high");
  });

  it("prefixes the summary with [Failed] and carries message text", () => {
    const s = failedChunkSummary(chunk);
    expect(s.summary.startsWith("[Failed]")).toBe(true);
    expect(s.summary).toContain("add login");
    expect(s.summary).toContain("ok doing it");
  });

  it("returns empty decision/file lists (nothing was successfully parsed)", () => {
    const s = failedChunkSummary(chunk);
    expect(s.keyDecisions).toEqual([]);
    expect(s.filesModified).toEqual([]);
    expect(s.filesRead).toEqual([]);
  });

  it("truncates very long message text to keep the placeholder bounded", () => {
    const long: LlmChunk = {
      ...chunk,
      messages: [{ role: "user", content: "x".repeat(1000) } as LlmMessage],
    };
    const s = failedChunkSummary(long);
    // "[Failed] " (9) + up to 300 chars of content
    expect(s.summary.length).toBeLessThanOrEqual(9 + 300);
  });
});
