import { beforeEach, describe, expect, it } from "bun:test";
import {
  batchCacheKey, clearSynthesisCache, getCachedBatch, getCachedSynthesis,
  setCachedBatch, setCachedSynthesis, synthesisCacheKey, synthesisCacheSize,
} from "../src/infra/synthesis-cache.ts";

const rc = (sessionId: string, entries = ["a"], mode = "balanced") => ({
  sessionId, projectId: "project", currentKeptEntryIds: entries, prevContext: "previous",
  mode, profile: "balanced", modelLabel: "openai/test", config: { focusWeighting: true },
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
  });

  it("caches chunk summaries by content without sharing mutable arrays", () => {
    const key = batchCacheKey({ model: "x", text: "chunk" });
    setCachedBatch(key, [{
      topic: "t", startIndex: 0, endIndex: 1, summary: "s", keyDecisions: ["d"],
      filesModified: [], filesRead: [], priority: "normal",
    }]);
    const first = getCachedBatch(key)!;
    first[0].keyDecisions.push("mutated");
    expect(getCachedBatch(key)?.[0].keyDecisions).toEqual(["d"]);
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
