import { describe, it, expect } from "bun:test";
import {
  isTextBlock,
  isToolCallBlock,
  getToolCallNames,
  filterToolCalls,
  isValidSmartCompactDetails,
  sanitizeSmartCompactDetails,
} from "../src/utils/type-guards.ts";
import type { SmartCompactDetails } from "../src/types.ts";

/** A fully-populated details object that passes the validator. */
function validDetails(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    method: "eesv",
    chunkCount: 3,
    topics: ["auth", "db"],
    readFiles: ["a.ts"],
    modifiedFiles: ["b.ts", "c.ts"],
    totalMessages: 100,
    totalTokensSummarized: 5000,
    llmCalls: 4,
    profile: "balanced",
    backupPath: null,
    tokensSaved: 2000,
    verified: true,
    gaps: [],
    explorationRounds: 2,
    explorationBoundaries: 3,
    model: "anthropic/claude-sonnet-4",
    qualityScore: 90,
    tokensBefore: 7000,
    ...overrides,
  };
}

// ── Content block guards ────────────────────────────────────────────────────

describe("isTextBlock", () => {
  it("accepts a well-formed text block", () => {
    expect(isTextBlock({ type: "text", text: "hello" })).toBe(true);
  });
  it("rejects non-object input", () => {
    expect(isTextBlock(null)).toBe(false);
    expect(isTextBlock("text")).toBe(false);
    expect(isTextBlock(42)).toBe(false);
    expect(isTextBlock(undefined)).toBe(false);
  });
  it("rejects wrong type discriminator", () => {
    expect(isTextBlock({ type: "toolCall", text: "x" })).toBe(false);
    expect(isTextBlock({ type: "image" })).toBe(false);
  });
  it("rejects when text is not a string", () => {
    expect(isTextBlock({ type: "text", text: 123 })).toBe(false);
    expect(isTextBlock({ type: "text" })).toBe(false);
  });
});

describe("isToolCallBlock", () => {
  it("accepts a well-formed tool call block", () => {
    expect(isToolCallBlock({ type: "toolCall", name: "write", arguments: {} })).toBe(true);
    expect(isToolCallBlock({ type: "toolCall", id: "1", name: "edit", arguments: { x: 1 } })).toBe(true);
  });
  it("rejects non-object input", () => {
    expect(isToolCallBlock(null)).toBe(false);
    expect(isToolCallBlock([])).toBe(false);
  });
  it("rejects wrong type discriminator", () => {
    expect(isToolCallBlock({ type: "text", name: "x" })).toBe(false);
  });
  it("rejects when name is not a string", () => {
    expect(isToolCallBlock({ type: "toolCall", arguments: {} })).toBe(false);
    expect(isToolCallBlock({ type: "toolCall", name: 5, arguments: {} })).toBe(false);
  });
});

describe("getToolCallNames / filterToolCalls", () => {
  const content = [
    { type: "text", text: "hi" },
    { type: "toolCall", id: "1", name: "write", arguments: { path: "a" } },
    { type: "toolCall", id: "2", name: "bash", arguments: { command: "ls" } },
    { type: "text", text: "bye" },
  ];
  it("getToolCallNames returns only tool-call names in order", () => {
    expect(getToolCallNames(content)).toEqual(["write", "bash"]);
  });
  it("getToolCallNames returns [] for non-array input", () => {
    expect(getToolCallNames(null)).toEqual([]);
    expect(getToolCallNames("x")).toEqual([]);
    expect(getToolCallNames(undefined)).toEqual([]);
  });
  it("filterToolCalls returns only tool-call blocks", () => {
    const out = filterToolCalls(content);
    expect(out.length).toBe(2);
    expect(out[0].name).toBe("write");
    expect(out[1].name).toBe("bash");
    expect(out[0].arguments).toEqual({ path: "a" });
  });
  it("filterToolCalls returns [] for non-array input", () => {
    expect(filterToolCalls({})).toEqual([]);
  });
});

// ── SmartCompactDetails validators (safety-critical for damage detection) ───

describe("isValidSmartCompactDetails", () => {
  it("accepts a fully-populated valid details object", () => {
    expect(isValidSmartCompactDetails(validDetails())).toBe(true);
  });
  it("accepts a minimal object (only required fields)", () => {
    expect(isValidSmartCompactDetails({
      method: "heuristic",
      profile: "aggressive",
      qualityScore: 50,
      totalMessages: 10,
      modifiedFiles: [],
      readFiles: [],
      topics: [],
    })).toBe(true);
  });
  it("accepts backupPath as null or string", () => {
    expect(isValidSmartCompactDetails(validDetails({ backupPath: null }))).toBe(true);
    expect(isValidSmartCompactDetails(validDetails({ backupPath: "/tmp/x.md" }))).toBe(true);
  });

  // Non-object rejection
  it("rejects null, primitives, arrays", () => {
    expect(isValidSmartCompactDetails(null)).toBe(false);
    expect(isValidSmartCompactDetails(undefined)).toBe(false);
    expect(isValidSmartCompactDetails("string")).toBe(false);
    expect(isValidSmartCompactDetails(42)).toBe(false);
    expect(isValidSmartCompactDetails([])).toBe(false);
  });

  // Required string-array fields (detectDamage iterates these → crash risk)
  it("rejects missing/non-array modifiedFiles", () => {
    expect(isValidSmartCompactDetails(validDetails({ modifiedFiles: undefined }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ modifiedFiles: "a.ts" }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ modifiedFiles: [1, 2] }))).toBe(false);
  });
  it("rejects missing/non-array readFiles", () => {
    expect(isValidSmartCompactDetails(validDetails({ readFiles: undefined }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ readFiles: {} }))).toBe(false);
  });
  it("rejects missing/non-array topics", () => {
    expect(isValidSmartCompactDetails(validDetails({ topics: undefined }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ topics: [42] }))).toBe(false);
  });

  // Enum fields
  it("rejects unknown / non-string method", () => {
    expect(isValidSmartCompactDetails(validDetails({ method: "magic" }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ method: 5 }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ method: undefined }))).toBe(false);
  });
  it("rejects unknown / non-string profile", () => {
    expect(isValidSmartCompactDetails(validDetails({ profile: "turbo" }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ profile: null }))).toBe(false);
  });

  // Numeric fields
  it("rejects missing / NaN / Infinity qualityScore", () => {
    expect(isValidSmartCompactDetails(validDetails({ qualityScore: undefined }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ qualityScore: NaN }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ qualityScore: Infinity }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ qualityScore: "90" }))).toBe(false);
  });
  it("rejects missing / non-finite totalMessages", () => {
    expect(isValidSmartCompactDetails(validDetails({ totalMessages: undefined }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ totalMessages: NaN }))).toBe(false);
  });

  // Optional-but-typed fields: present-and-wrong-type must reject
  it("rejects present-but-wrong-type gaps", () => {
    expect(isValidSmartCompactDetails(validDetails({ gaps: "not-array" }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ gaps: [1, 2] }))).toBe(false);
    // missing gaps is fine
    const { gaps: _drop, ...withoutGaps } = validDetails() as Record<string, unknown>;
    expect(isValidSmartCompactDetails(withoutGaps)).toBe(true);
  });
  it("rejects present-but-non-boolean verified", () => {
    expect(isValidSmartCompactDetails(validDetails({ verified: "yes" }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ verified: 1 }))).toBe(false);
  });
  it("rejects present-but-non-string non-null backupPath", () => {
    expect(isValidSmartCompactDetails(validDetails({ backupPath: 42 }))).toBe(false);
    expect(isValidSmartCompactDetails(validDetails({ backupPath: false }))).toBe(false);
  });
});

describe("sanitizeSmartCompactDetails", () => {
  it("passes a valid object through unchanged (same reference)", () => {
    const d = validDetails();
    expect(sanitizeSmartCompactDetails(d)).toBe(d);
  });
  it("returns null for null / primitives / arrays", () => {
    expect(sanitizeSmartCompactDetails(null)).toBe(null);
    expect(sanitizeSmartCompactDetails(undefined)).toBe(null);
    expect(sanitizeSmartCompactDetails("x")).toBe(null);
    expect(sanitizeSmartCompactDetails(42)).toBe(null);
    expect(sanitizeSmartCompactDetails([])).toBe(null);
  });
  it("returns null when the required string arrays are absent", () => {
    expect(sanitizeSmartCompactDetails({ method: "eesv", profile: "balanced" })).toBe(null);
    expect(sanitizeSmartCompactDetails({ modifiedFiles: "a.ts", readFiles: [], topics: [] })).toBe(null);
    expect(sanitizeSmartCompactDetails({ modifiedFiles: [1], readFiles: [], topics: [] })).toBe(null);
  });

  it("repairs a legacy entry: arrays present, enums/numbers missing → safe defaults", () => {
    const legacy = {
      modifiedFiles: ["src/a.ts"],
      readFiles: ["lib/b.ts"],
      topics: ["auth"],
      // method/profile/qualityScore/totalMessages all missing
    };
    const repaired = sanitizeSmartCompactDetails(legacy) as SmartCompactDetails | null;
    expect(repaired).not.toBeNull();
    expect(repaired!.method).toBe("heuristic");
    expect(repaired!.profile).toBe("balanced");
    expect(repaired!.qualityScore).toBe(0);
    expect(repaired!.totalMessages).toBe(0);
    expect(repaired!.model).toBe("unknown");
    expect(repaired!.backupPath).toBeNull();
    expect(repaired!.verified).toBe(false);
    expect(repaired!.gaps).toEqual([]);
    // preserved arrays
    expect(repaired!.modifiedFiles).toEqual(["src/a.ts"]);
    expect(repaired!.readFiles).toEqual(["lib/b.ts"]);
    expect(repaired!.topics).toEqual(["auth"]);
  });

  it("coerces invalid enums to the safe defaults", () => {
    const repaired = sanitizeSmartCompactDetails({
      modifiedFiles: [], readFiles: [], topics: [],
      method: "superturbo", profile: "ultra",
    }) as SmartCompactDetails | null;
    expect(repaired).not.toBeNull();
    expect(repaired!.method).toBe("heuristic");
    expect(repaired!.profile).toBe("balanced");
  });

  it("keeps valid enums and numbers during repair", () => {
    const repaired = sanitizeSmartCompactDetails({
      modifiedFiles: [], readFiles: [], topics: [],
      method: "single-pass", profile: "light",
      qualityScore: 77, totalMessages: 42, tokensSaved: 100, llmCalls: 3,
      model: "openai/gpt-x", verified: true, backupPath: "/x.md",
    }) as SmartCompactDetails | null;
    expect(repaired).not.toBeNull();
    expect(repaired!.method).toBe("single-pass");
    expect(repaired!.profile).toBe("light");
    expect(repaired!.qualityScore).toBe(77);
    expect(repaired!.totalMessages).toBe(42);
    expect(repaired!.tokensSaved).toBe(100);
    expect(repaired!.llmCalls).toBe(3);
    expect(repaired!.model).toBe("openai/gpt-x");
    expect(repaired!.verified).toBe(true);
    expect(repaired!.backupPath).toBe("/x.md");
  });

  it("the repaired result always passes isValidSmartCompactDetails", () => {
    const repaired = sanitizeSmartCompactDetails({
      modifiedFiles: ["a"], readFiles: ["b"], topics: ["c"],
    });
    expect(repaired).not.toBeNull();
    expect(isValidSmartCompactDetails(repaired)).toBe(true);
  });
});
