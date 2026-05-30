/**
 * Coverage for the Map-backed LRU helpers used by session-log and any other
 * bounded cache in the project. The contract we're locking in:
 *
 *   - `lruGet` promotes accessed entries to the most-recent slot.
 *   - `lruGet` returns undefined cleanly on missing keys.
 *   - `lruGet` correctly handles value types that include `undefined` /
 *     `null` (the previous shape used `v !== undefined` and silently
 *     dropped LRU promotion for those cases — see B2).
 *   - `lruSet` evicts the oldest entry first when the cap is exceeded.
 *   - `lruSet` overwrites without doubling the entry count.
 */
import { describe, it, expect } from "bun:test";
import { lruGet, lruSet } from "../src/utils/lru.ts";

describe("lruGet", () => {
  it("returns undefined for an absent key", () => {
    const m = new Map<string, number>();
    expect(lruGet(m, "missing")).toBeUndefined();
  });

  it("returns the value when present", () => {
    const m = new Map<string, number>([["a", 1]]);
    expect(lruGet(m, "a")).toBe(1);
  });

  it("promotes the accessed entry to most-recent", () => {
    const m = new Map<string, number>();
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    // Order: a, b, c (oldest → newest).
    lruGet(m, "a");
    // After promotion: b, c, a.
    expect([...m.keys()]).toEqual(["b", "c", "a"]);
  });

  it("correctly handles `undefined` values (regression for B2)", () => {
    // The old `v !== undefined && delete` shape silently skipped LRU
    // promotion when a stored value happened to be undefined. With the
    // has-based check, the entry is still promoted.
    const m = new Map<string, number | undefined>();
    m.set("x", undefined);
    m.set("y", 2);
    const v = lruGet(m, "x");
    expect(v).toBeUndefined();
    // x should be the newest now.
    expect([...m.keys()]).toEqual(["y", "x"]);
  });

  it("correctly handles `null` values", () => {
    const m = new Map<string, number | null>();
    m.set("a", null);
    m.set("b", 1);
    const v = lruGet(m, "a");
    expect(v).toBeNull();
    expect([...m.keys()]).toEqual(["b", "a"]);
  });
});

describe("lruSet", () => {
  it("inserts a new entry and respects the cap", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 2);
    lruSet(m, "b", 2, 2);
    expect(m.size).toBe(2);
    expect([...m.keys()]).toEqual(["a", "b"]);
  });

  it("evicts the oldest entry first when over the cap", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 2);
    lruSet(m, "b", 2, 2);
    lruSet(m, "c", 3, 2);   // evicts a
    expect(m.size).toBe(2);
    expect([...m.keys()]).toEqual(["b", "c"]);
    expect(lruGet(m, "a")).toBeUndefined();
  });

  it("overwriting an existing key does NOT double-count for eviction", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 2);
    lruSet(m, "b", 2, 2);
    // Re-set "a" — size stays at 2, no eviction triggered.
    lruSet(m, "a", 10, 2);
    expect(m.size).toBe(2);
    expect(lruGet(m, "a")).toBe(10);
    expect(lruGet(m, "b")).toBe(2);
  });

  it("overwriting promotes the entry to most-recent", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 3);
    lruSet(m, "b", 2, 3);
    lruSet(m, "c", 3, 3);
    lruSet(m, "a", 11, 3);              // a moves to tail
    lruSet(m, "d", 4, 3);                // evicts b (oldest), not a
    expect([...m.keys()]).toEqual(["c", "a", "d"]);
  });

  it("can shrink an existing cache when a smaller cap is used", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 5);
    lruSet(m, "b", 2, 5);
    lruSet(m, "c", 3, 5);
    lruSet(m, "d", 4, 2);   // cap=2 forces eviction
    expect(m.size).toBe(2);
    expect([...m.keys()]).toEqual(["c", "d"]);
  });

  it("preserves invariant when promoting recent entries via lruGet", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 3);
    lruSet(m, "b", 2, 3);
    lruSet(m, "c", 3, 3);
    lruGet(m, "a");                      // a promoted; order: b, c, a
    lruSet(m, "d", 4, 3);                // evicts b
    expect([...m.keys()]).toEqual(["c", "a", "d"]);
  });
});
