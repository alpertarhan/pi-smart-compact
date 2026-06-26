import { describe, it, expect } from "bun:test";
import { mergeExtractions, saveCachedExtraction, loadCachedExtraction } from "../src/utils/cache.ts";
import { pruneRedundant } from "../src/utils/pruning.ts";
import { extractStructured } from "../src/utils/extraction.ts";
import { PROFILES } from "../src/constants.ts";
import { buildEntryIdFingerprint, isPrefixOf } from "../src/utils/id-fingerprint.ts";
import type { LlmMessage, StructuredExtraction } from "../src/types.ts";

function makeExtraction(partial: Partial<StructuredExtraction> = {}): StructuredExtraction {
  return {
    modifiedFiles: [],
    readFiles: [],
    deletedFiles: [],
    mediaAttachments: [],
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

// ── Index offset correctness ──

describe("mergeExtractions — index offset", () => {
  it("offsets error indexes by baseMsgCount", () => {
    const base = makeExtraction({
      errors: [
        { index: 2, tool: "bash", message: "error in base", retryAttempted: false, resolved: false },
      ],
      messageCount: 10,
    });
    const delta = makeExtraction({
      errors: [
        { index: 0, tool: "edit", message: "delta error 0", retryAttempted: false, resolved: false },
        { index: 3, tool: "bash", message: "delta error 3", retryAttempted: true, resolved: false },
      ],
      messageCount: 5,
    });
    const merged = mergeExtractions(base, delta, 10);

    expect(merged.errors.length).toBe(3);
    expect(merged.errors[0].index).toBe(2);  // base, unchanged
    expect(merged.errors[1].index).toBe(10); // delta[0].index (0) + baseMsgCount (10)
    expect(merged.errors[2].index).toBe(13); // delta[1].index (3) + baseMsgCount (10)
  });

  it("offsets decision indexes by baseMsgCount", () => {
    const base = makeExtraction({
      decisions: [
        { index: 1, type: "explicit", summary: "base decision" },
      ],
      messageCount: 8,
    });
    const delta = makeExtraction({
      decisions: [
        { index: 2, type: "implicit", summary: "delta decision", userResponse: "yes" },
      ],
      messageCount: 3,
    });
    const merged = mergeExtractions(base, delta, 8);

    expect(merged.decisions.length).toBe(2);
    expect(merged.decisions[0].index).toBe(1);  // base
    expect(merged.decisions[1].index).toBe(10); // 2 + 8
  });

  it("offsets constraint indexes by baseMsgCount", () => {
    const base = makeExtraction({
      constraints: [
        { index: 0, text: "Must use TS", category: "requirement", confidence: 0.9 },
      ],
      messageCount: 5,
    });
    const delta = makeExtraction({
      constraints: [
        { index: 1, text: "No any", category: "prohibition", confidence: 0.8 },
      ],
      messageCount: 2,
    });
    const merged = mergeExtractions(base, delta, 5);

    expect(merged.constraints.length).toBe(2);
    expect(merged.constraints[0].index).toBe(0); // base
    expect(merged.constraints[1].index).toBe(6); // 1 + 5
  });

  it("offsets topic start/end indexes by baseMsgCount", () => {
    const base = makeExtraction({
      topics: [
        { startIndex: 0, endIndex: 4, primaryFile: "a.ts", type: "implementation", errorDensity: 0 },
      ],
      messageCount: 5,
    });
    const delta = makeExtraction({
      topics: [
        { startIndex: 0, endIndex: 2, primaryFile: "b.ts", type: "debugging", errorDensity: 2 },
      ],
      messageCount: 3,
    });
    const merged = mergeExtractions(base, delta, 5);

    expect(merged.topics.length).toBe(2);
    expect(merged.topics[0].startIndex).toBe(0); // base
    expect(merged.topics[0].endIndex).toBe(4);
    expect(merged.topics[1].startIndex).toBe(5); // 0 + 5
    expect(merged.topics[1].endIndex).toBe(7);   // 2 + 5
  });

  it("offsets media attachment indexes by baseMsgCount", () => {
    const base = makeExtraction({ mediaAttachments: [{ index: 1, kind: "image", name: "before.png" }], messageCount: 4 });
    const delta = makeExtraction({ mediaAttachments: [{ index: 2, kind: "file", name: "after.pdf" }], messageCount: 3 });
    const merged = mergeExtractions(base, delta, 4);
    expect(merged.mediaAttachments).toEqual([
      { index: 1, kind: "image", name: "before.png" },
      { index: 6, kind: "file", name: "after.pdf" },
    ]);
  });

  it("offsets timeline indexes by baseMsgCount", () => {
    const base = makeExtraction({
      timeline: [
        { index: 0, event: "user_request", summary: "hello" },
      ],
      messageCount: 4,
    });
    const delta = makeExtraction({
      timeline: [
        { index: 1, event: "error", summary: "oops" },
      ],
      messageCount: 2,
    });
    const merged = mergeExtractions(base, delta, 4);

    expect(merged.timeline.length).toBe(2);
    expect(merged.timeline[0].index).toBe(0); // base
    expect(merged.timeline[1].index).toBe(5); // 1 + 4
  });

  it("offsets modifiedFiles.lastModifiedIndex by baseMsgCount", () => {
    const base = makeExtraction({
      modifiedFiles: [
        { path: "src/a.ts", toolCalls: 1, lastModifiedIndex: 3 },
      ],
      messageCount: 5,
    });
    const delta = makeExtraction({
      modifiedFiles: [
        { path: "src/b.ts", toolCalls: 2, lastModifiedIndex: 1 },
      ],
      messageCount: 3,
    });
    const merged = mergeExtractions(base, delta, 5);

    // src/a.ts from base, src/b.ts from delta (different paths → both kept)
    expect(merged.modifiedFiles.length).toBe(2);
    expect(merged.modifiedFiles.find(f => f.path === "src/a.ts")!.lastModifiedIndex).toBe(3);
    expect(merged.modifiedFiles.find(f => f.path === "src/b.ts")!.lastModifiedIndex).toBe(6); // 1 + 5
  });
});

// ── Deduplication and field merge ──

describe("mergeExtractions — deduplication", () => {
  it("deduplicates modifiedFiles by path (delta overwrites base)", () => {
    const base = makeExtraction({
      modifiedFiles: [
        { path: "src/a.ts", toolCalls: 1, lastModifiedIndex: 3 },
      ],
      messageCount: 5,
    });
    const delta = makeExtraction({
      modifiedFiles: [
        { path: "src/a.ts", toolCalls: 2, lastModifiedIndex: 2 },
      ],
      messageCount: 3,
    });
    const merged = mergeExtractions(base, delta, 5);

    expect(merged.modifiedFiles.length).toBe(1);
    // Last write wins (Map insertion order)
    expect(merged.modifiedFiles[0].toolCalls).toBe(2);
    expect(merged.modifiedFiles[0].lastModifiedIndex).toBe(7); // 2 + 5
  });

  it("deduplicates readFiles", () => {
    const base = makeExtraction({ readFiles: ["a.ts", "b.ts"], messageCount: 5 });
    const delta = makeExtraction({ readFiles: ["b.ts", "c.ts"], messageCount: 3 });
    const merged = mergeExtractions(base, delta, 5);

    expect([...merged.readFiles].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

// ── messageCount ──

describe("mergeExtractions — messageCount", () => {
  it("sums baseMsgCount and delta.messageCount", () => {
    const base = makeExtraction({ messageCount: 10 });
    const delta = makeExtraction({ messageCount: 5 });
    const merged = mergeExtractions(base, delta, 10);

    expect(merged.messageCount).toBe(15);
  });

  it("uses baseMsgCount parameter, not base.messageCount", () => {
    // baseMsgCount can differ from base.messageCount if the caller
    // uses cachedExt.messageCount which may be stale
    const base = makeExtraction({ messageCount: 10 });
    const delta = makeExtraction({ messageCount: 5 });
    const merged = mergeExtractions(base, delta, 12); // explicit baseMsgCount=12

    expect(merged.messageCount).toBe(17); // 12 + 5, NOT 10 + 5
  });
});

// ── mainGoal / lastUserMessages / lastErrors ──

describe("mergeExtractions — field precedence", () => {
  it("preserves the original (base) mainGoal over the delta suffix", () => {
    // mainGoal is the FIRST user message (the original objective). The delta
    // suffix's first user message is mid-conversation, not the goal — so base wins.
    const base = makeExtraction({ mainGoal: "old goal" });
    const delta = makeExtraction({ mainGoal: "new goal" });
    expect(mergeExtractions(base, delta, 5).mainGoal).toBe("old goal");
  });

  it("falls back to base.mainGoal when delta is null", () => {
    const base = makeExtraction({ mainGoal: "old goal" });
    const delta = makeExtraction({ mainGoal: null });
    expect(mergeExtractions(base, delta, 5).mainGoal).toBe("old goal");
  });

  it("spans the cache boundary for lastUserMessages", () => {
    // "last N" must cross the base/delta boundary; the suffix alone is
    // incomplete when it carries fewer than N user messages.
    const base = makeExtraction({ lastUserMessages: ["old msg"] });
    const delta = makeExtraction({ lastUserMessages: ["new msg 1", "new msg 2"] });
    expect(mergeExtractions(base, delta, 5).lastUserMessages).toEqual(["old msg", "new msg 1", "new msg 2"]);
  });

  it("falls back to base.lastUserMessages when delta is empty", () => {
    const base = makeExtraction({ lastUserMessages: ["old msg"] });
    const delta = makeExtraction({ lastUserMessages: [] });
    expect(mergeExtractions(base, delta, 5).lastUserMessages).toEqual(["old msg"]);
  });
});

// ── Regression: zero baseMsgCount edge case ──

describe("mergeExtractions — edge cases", () => {
  it("works correctly with baseMsgCount = 0", () => {
    const base = makeExtraction({ errors: [], messageCount: 0 });
    const delta = makeExtraction({
      errors: [{ index: 5, tool: "bash", message: "err", retryAttempted: false, resolved: false }],
      messageCount: 10,
    });
    const merged = mergeExtractions(base, delta, 0);

    expect(merged.errors[0].index).toBe(5); // 5 + 0
  });

  it("merges empty base with populated delta", () => {
    const base = makeExtraction();
    const delta = makeExtraction({
      errors: [{ index: 0, tool: "bash", message: "err", retryAttempted: false, resolved: false }],
      decisions: [{ index: 1, type: "explicit", summary: "decide" }],
      constraints: [{ index: 2, text: "constraint", category: "requirement", confidence: 0.9 }],
      topics: [{ startIndex: 0, endIndex: 3, primaryFile: null, type: "exploration", errorDensity: 0 }],
      timeline: [{ index: 0, event: "user_request", summary: "hi" }],
      modifiedFiles: [{ path: "a.ts", toolCalls: 1, lastModifiedIndex: 2 }],
      readFiles: ["b.ts"],
      messageCount: 5,
    });
    const merged = mergeExtractions(base, delta, 0);

    expect(merged.errors[0].index).toBe(0);
    expect(merged.decisions[0].index).toBe(1);
    expect(merged.constraints[0].index).toBe(2);
    expect(merged.topics[0].startIndex).toBe(0);
    expect(merged.topics[0].endIndex).toBe(3);
    expect(merged.timeline[0].index).toBe(0);
    expect(merged.modifiedFiles[0].lastModifiedIndex).toBe(2);
    expect(merged.readFiles).toEqual(["b.ts"]);
    expect(merged.messageCount).toBe(5);
  });
});

// ── Entry-id cache round-trip ──

describe("saveCachedExtraction / loadCachedExtraction", () => {
  it("round-trips with firstEntryId and lastEntryId", () => {
    const sessionId = "test-cache-roundtrip-" + Date.now();
    const ext = makeExtraction({ modifiedFiles: [{ path: "a.ts", toolCalls: 1, lastModifiedIndex: 2 }], messageCount: 5 });
    saveCachedExtraction(sessionId, ext, 5, "entry-0", "entry-4");
    const loaded = loadCachedExtraction(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.firstEntryId).toBe("entry-0");
    expect(loaded!.lastEntryId).toBe("entry-4");
    expect(loaded!.messageCount).toBe(5);
    expect(loaded!.extraction.modifiedFiles[0].path).toBe("a.ts");
  });

  it("round-trips a compact entry-id fingerprint instead of the full id array", () => {
    // We deliberately do NOT persist the full id array anymore — it grows
    // linearly with the session and bloats the cache. The fingerprint
    // carries enough information (count + tail + prefix hash) to prove that
    // the cached extraction is a prefix of the current run.
    const sessionId = "test-cache-entryids-" + Date.now();
    const ext = makeExtraction({ modifiedFiles: [{ path: "b.ts", toolCalls: 1, lastModifiedIndex: 1 }], messageCount: 3 });
    const entryIds = ["e-0", "e-1", "e-2"];
    saveCachedExtraction(sessionId, ext, 3, "e-0", "e-2", entryIds);
    const loaded = loadCachedExtraction(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.entryIdsFp).toBeDefined();
    expect(loaded!.entryIdsFp!.count).toBe(3);
    expect(loaded!.entryIdsFp!.tail).toEqual(entryIds);
    expect(isPrefixOf(loaded!.entryIdsFp, entryIds)).toBe(true);
    // Prefix logic still works after extending the id list.
    expect(isPrefixOf(loaded!.entryIdsFp, [...entryIds, "e-3"])).toBe(true);
    // ...and rejects a divergent branch.
    expect(isPrefixOf(loaded!.entryIdsFp, ["e-0", "e-1", "e-XX"])).toBe(false);
  });

  it("preserves pruned domain messageCount for correct merge offset", () => {
    // Scenario: toCompact had 5 entries but pruning removed 1 → llmMessages.length = 4.
    // messageCount must reflect the pruned domain (4), not the unpruned entry count (5).
    const sessionId = "test-pruned-domain-" + Date.now();
    const base = makeExtraction({
      topics: [{ startIndex: 0, endIndex: 3, primaryFile: "a.ts", type: "implementation", errorDensity: 0 }],
      errors: [{ index: 2, tool: "read", message: "base err", retryAttempted: false, resolved: false }],
      messageCount: 4,
    });
    const entryIds = ["e-0", "e-1", "e-2", "e-3", "e-4"]; // 5 unpruned entries
    saveCachedExtraction(sessionId, base, 4, "e-0", "e-4", entryIds);

    const loaded = loadCachedExtraction(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.messageCount).toBe(4); // pruned domain preserved
    expect(loaded!.entryIdsFp!.count).toBe(entryIds.length);

    // Simulate delta from 2 new pruned messages
    const delta = makeExtraction({
      topics: [{ startIndex: 0, endIndex: 1, primaryFile: "b.ts", type: "debugging", errorDensity: 1 }],
      errors: [{ index: 1, tool: "bash", message: "err", retryAttempted: false, resolved: false }],
      messageCount: 2,
    });
    const merged = mergeExtractions(loaded!.extraction, delta, loaded!.messageCount);
    expect(merged.messageCount).toBe(6); // 4 + 2
    expect(merged.topics[0].startIndex).toBe(0);  // base topic unchanged
    expect(merged.topics[1].startIndex).toBe(4);  // 0 + 4 (pruned offset)
    expect(merged.topics[1].endIndex).toBe(5);    // 1 + 4
    expect(merged.errors[0].index).toBe(2);       // base error unchanged
    expect(merged.errors[1].index).toBe(5);       // 1 + 4 (delta offset)
  });

  it("round-trips keptEntryIdsFp for pruned-prefix validation", () => {
    const sessionId = "test-cache-kept-entryids-" + Date.now();
    const ext = makeExtraction({ messageCount: 2 });
    const entryIds = ["e-0", "e-1", "e-2", "e-3"];
    const keptEntryIds = ["e-0", "e-3"];
    saveCachedExtraction(sessionId, ext, 2, "e-0", "e-3", entryIds, keptEntryIds);
    const loaded = loadCachedExtraction(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.entryIdsFp!.count).toBe(4);
    expect(loaded!.keptEntryIdsFp!.count).toBe(2);
    expect(loaded!.keptEntryIdsFp!.tail).toEqual(keptEntryIds);
    expect(isPrefixOf(loaded!.keptEntryIdsFp, keptEntryIds)).toBe(true);
    expect(loaded!.messageCount).toBe(2);
  });

  it("detects when new messages change the pruned prefix and forces full extraction", () => {
    const pc = PROFILES.balanced;
    const user = (text: string): LlmMessage => ({ role: "user", content: [{ type: "text", text }] });
    const readCall = (id: string, path: string): LlmMessage => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }] });
    const readResult = (id: string, text: string): LlmMessage => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }] });

    const baseMsgs = [
      user("please inspect a.ts"),
      readCall("r1", "a.ts"),
      readResult("r1", "old content"),
      user("continue"),
      user("keep going"),
    ];
    const baseEntryIds = baseMsgs.map((_, i) => "e-" + i);
    const basePruning = pruneRedundant(baseMsgs);
    const cachedKeptEntryIds = basePruning.keptIndices.map(i => baseEntryIds[i]);
    const cachedExtraction = extractStructured(basePruning.messages, pc);

    const currentMsgs = [...baseMsgs, readCall("r2", "a.ts"), readResult("r2", "new content")];
    const currentEntryIds = currentMsgs.map((_, i) => "e-" + i);
    const currentPruning = pruneRedundant(currentMsgs);
    const currentKeptEntryIds = currentPruning.keptIndices.map(i => currentEntryIds[i]);

    const prunedPrefixMatch = cachedKeptEntryIds.length <= currentKeptEntryIds.length &&
      cachedKeptEntryIds.every((id, i) => id === currentKeptEntryIds[i]);
    expect(prunedPrefixMatch).toBe(false);

    // The old unsafe approach pruned only the new suffix, retaining cached messages
    // that full pruning would now evict.
    const suffixPruning = pruneRedundant(currentMsgs.slice(baseMsgs.length));
    const unsafeDelta = extractStructured(suffixPruning.messages, pc);
    const unsafeMerged = mergeExtractions(cachedExtraction, unsafeDelta, cachedExtraction.messageCount);
    const full = extractStructured(currentPruning.messages, pc);
    expect(unsafeMerged.messageCount).not.toBe(full.messageCount);
  });

  it("returns null for stale entry ids (same count, different ids)", () => {
    // Simulate: first save with ids [A, B, C], then pivot/branch so ids [X, Y, Z]
    // Same message count but different content → cache should NOT match
    const sessionId = "test-cache-invalidation-" + Date.now();
    const ext = makeExtraction({ messageCount: 3 });
    saveCachedExtraction(sessionId, ext, 3, "entry-A", "entry-C");
    const loaded = loadCachedExtraction(sessionId);
    // loaded itself is not null, but a caller would compare firstEntryId/lastEntryId
    expect(loaded).not.toBeNull();
    expect(loaded!.firstEntryId).toBe("entry-A");
    expect(loaded!.lastEntryId).toBe("entry-C");
    // In core.ts, the caller checks: loaded.firstEntryId === currentFirstId && loaded.lastEntryId === currentLastId
    // If current ids are ["entry-X", "entry-Z"], this would fail → full extraction
    const idsMatch = loaded!.firstEntryId === "entry-X" && loaded!.lastEntryId === "entry-Z";
    expect(idsMatch).toBe(false);
  });
});
