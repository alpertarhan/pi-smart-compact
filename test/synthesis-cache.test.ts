import { beforeEach, describe, expect, it } from "bun:test";
import {
  batchCacheKey, clearSynthesisCache, getCachedBatch, getCachedSynthesis,
  setCachedBatch, setCachedSynthesis, synthesisCacheKey, synthesisCacheSize,
} from "../src/infra/synthesis-cache.ts";

const rc = (sessionId: string, entries = ["a"], mode = "balanced") => ({
  sessionId, projectId: "project", currentKeptEntryIds: entries, prevContext: "previous",
  convText: entries.join("|"), projectCtx: "project context",
  mode, requestedMode: mode, profile: "balanced", modelLabel: "openai/test",
  summaryModel: { provider: "openai", id: "test", api: "responses", baseUrl: "https://summary.example" },
  segModel: { provider: "openai", id: "segmenter", api: "responses", baseUrl: "https://segment.example" },
  verifyModel: { provider: "openai", id: "verifier", api: "responses", baseUrl: "https://verify.example" },
  profileCfg: { summaryBudgetTokens: 6_000, keepRecentTokens: 20_000, minChunkTokens: 4_000, maxChunkTokens: 20_000, singlePassMaxTokens: 20_000, batchMaxTokens: 60_000 },
  config: {
    focusWeighting: true, zeroCallEnabled: true,
    summaryThinkingLevel: "minimal", segmentationThinkingLevel: "minimal",
    maxLlmCalls: 0, maxLlmInputTokens: 0, codexMaxCallMs: 0, maxLatencyMs: 0,
  },
  focus: "auth", userNote: undefined,
}) as any;

beforeEach(() => clearSynthesisCache());

describe("synthesis cache", () => {
  it("reuses only the same session, branch content, mode, and model", () => {
    const key = synthesisCacheKey(rc("s1"));
    setCachedSynthesis(key, {
      finalSummary: "## Goal\nCached", method: "single-pass", summaries: [],
      explorationReport: null, explorationRounds: 0, chunkCount: 0,
    }, 100);

    expect(getCachedSynthesis(key, 101)?.finalSummary).toContain("Cached");
    expect(getCachedSynthesis(synthesisCacheKey(rc("s2")), 101)).toBeNull();
    expect(getCachedSynthesis(synthesisCacheKey(rc("s1", ["b"])), 101)).toBeNull();
    expect(getCachedSynthesis(synthesisCacheKey(rc("s1", ["a"], "fast")), 101)).toBeNull();
    const noZeroCall = rc("s1");
    noZeroCall.config.zeroCallEnabled = false;
    expect(getCachedSynthesis(synthesisCacheKey(noZeroCall), 101)).toBeNull();
    const differentSegmenter = rc("s1");
    differentSegmenter.segModel.id = "other";
    expect(getCachedSynthesis(synthesisCacheKey(differentSegmenter), 101)).toBeNull();
    const differentThinking = rc("s1");
    differentThinking.config.summaryThinkingLevel = "high";
    expect(getCachedSynthesis(synthesisCacheKey(differentThinking), 101)).toBeNull();
    const differentRetention = rc("s1");
    differentRetention.profileCfg.keepRecentTokens++;
    expect(getCachedSynthesis(synthesisCacheKey(differentRetention), 101)).toBeNull();
    const differentBudget = rc("s1");
    differentBudget.maxLlmCalls = 1;
    expect(getCachedSynthesis(synthesisCacheKey(differentBudget), 101)).toBeNull();
    const differentTimeout = rc("s1");
    differentTimeout.timeoutMs = 5_000;
    expect(getCachedSynthesis(synthesisCacheKey(differentTimeout), 101)).toBeNull();
  });
  it("invalidates when content changes under stable entry ids", () => {
    const first = rc("s1");
    const second = rc("s1");
    second.convText = "different recovered content";
    expect(synthesisCacheKey(first)).not.toBe(synthesisCacheKey(second));
  });


  it("separates differing focus even when focus weighting is disabled", () => {
    const first = rc("s1");
    first.config.focusWeighting = false;
    const second = rc("s1");
    second.config.focusWeighting = false;
    second.focus = "database";

    expect(synthesisCacheKey(first)).not.toBe(synthesisCacheKey(second));
  });

  it("caches chunk summaries by content without sharing mutable arrays", () => {
    const key = batchCacheKey({ model: "x", text: "chunk" });
    setCachedBatch(key, [{
      topic: "t", startIndex: 0, endIndex: 1, summary: "s", keyDecisions: ["d"],
      filesModified: [], filesRead: [], filesDeleted: [], priority: "normal",
    }]);
    const first = getCachedBatch(key)!;
    first[0].keyDecisions.push("mutated");
    expect(getCachedBatch(key)?.[0].keyDecisions).toEqual(["d"]);
  });
  it("does not share nested full-synthesis cache values", () => {
    setCachedSynthesis("deep", {
      finalSummary: "## Goal\nCached",
      method: "eesv",
      summaries: [{
        topic: "t", startIndex: 0, endIndex: 1, summary: "s", keyDecisions: ["d"],
        filesModified: ["a.ts"], filesRead: [], filesDeleted: [], priority: "normal",
      }],
      explorationReport: {
        boundaries: [{ afterIndex: 0, topic: "t", priority: "normal", confidence: 1 }],
        mainGoal: "g", sessionType: "implementation", enrichedConstraints: ["c"],
        crossReferences: ["x"], statusAssessment: { done: ["d"], inProgress: [], blocked: [] },
        criticalContext: ["critical"], keyDecisions: ["decision"],
      },
      explorationRounds: 1,
      chunkCount: 1,
    } as any);
    const first = getCachedSynthesis("deep")!;
    first.summaries[0].keyDecisions.push("mutated");
    first.explorationReport!.boundaries[0].topic = "mutated";
    expect(getCachedSynthesis("deep")!.summaries[0].keyDecisions).toEqual(["d"]);
    expect(getCachedSynthesis("deep")!.explorationReport!.boundaries[0].topic).toBe("t");
  });


  it("expires and remains bounded", () => {
    for (let index = 0; index < 20; index++) {
      setCachedSynthesis("key-" + index, {
        finalSummary: "x", method: "heuristic", summaries: [], explorationReport: null,
        explorationRounds: 0, chunkCount: 0,
      }, index);
    }
    expect(synthesisCacheSize()).toBe(16);
    expect(getCachedSynthesis("key-19", 10 * 60_000 + 20)).toBeNull();
  });
});
