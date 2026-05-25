/**
 * Entry-id fingerprint tests.
 *
 * The fingerprint is the contract between `saveCachedExtraction` and
 * `extractWithCache`. If a stale or divergent branch slips past these checks,
 * the extraction cache will offset indexes against the wrong baseline and the
 * resulting summary's topic/error/decision indices will reference unrelated
 * messages. So the assertions here are sharper than typical "round-trip" tests.
 */

import { describe, it, expect } from "bun:test";
import {
  buildEntryIdFingerprint, hashIds, isPrefixOf, legacyPrefixMatch,
  FINGERPRINT_TAIL_LEN,
} from "../src/utils/id-fingerprint.ts";

describe("buildEntryIdFingerprint", () => {
  it("captures count, tail, and a stable prefix hash", () => {
    const ids = Array.from({ length: 50 }, (_, i) => "e-" + i);
    const fp = buildEntryIdFingerprint(ids);
    expect(fp.count).toBe(50);
    expect(fp.tail).toHaveLength(FINGERPRINT_TAIL_LEN);
    expect(fp.tail).toEqual(ids.slice(-FINGERPRINT_TAIL_LEN));
    // Hash is deterministic: rebuilding from the same input yields the same hash.
    expect(buildEntryIdFingerprint(ids).prefixHash).toBe(fp.prefixHash);
  });

  it("handles arrays shorter than the tail window", () => {
    const ids = ["a", "b", "c"];
    const fp = buildEntryIdFingerprint(ids);
    expect(fp.count).toBe(3);
    expect(fp.tail).toEqual(ids);
  });

  it("handles the empty case without exploding", () => {
    const fp = buildEntryIdFingerprint([]);
    expect(fp.count).toBe(0);
    expect(fp.tail).toEqual([]);
    expect(fp.prefixHash).toBe(hashIds([], 0));
  });
});

describe("isPrefixOf", () => {
  it("accepts the exact same id list", () => {
    const ids = ["a", "b", "c", "d"];
    expect(isPrefixOf(buildEntryIdFingerprint(ids), ids)).toBe(true);
  });

  it("accepts an extension of the cached prefix", () => {
    const cached = buildEntryIdFingerprint(["a", "b", "c"]);
    expect(isPrefixOf(cached, ["a", "b", "c", "d", "e"])).toBe(true);
  });

  it("rejects when cached count exceeds the current list", () => {
    const cached = buildEntryIdFingerprint(["a", "b", "c", "d"]);
    expect(isPrefixOf(cached, ["a", "b", "c"])).toBe(false);
  });

  it("rejects a divergent branch even when the prefix has the right length", () => {
    const cached = buildEntryIdFingerprint(["a", "b", "c"]);
    expect(isPrefixOf(cached, ["a", "b", "X"])).toBe(false);
  });

  it("rejects a branch that re-uses the same tail but corrupts an interior id", () => {
    // Tail check passes, hash check must catch the interior divergence.
    const cached = buildEntryIdFingerprint(["a", "b", "c", "d", "e"]);
    const corrupted = ["a", "X", "c", "d", "e", "f"];
    expect(isPrefixOf(cached, corrupted)).toBe(false);
  });

  it("returns false on undefined fingerprint (caller must fall back)", () => {
    expect(isPrefixOf(undefined, ["a"])).toBe(false);
  });
});

describe("legacyPrefixMatch", () => {
  it("matches when legacy ids are a strict prefix", () => {
    expect(legacyPrefixMatch(["a", "b"], ["a", "b", "c"])).toBe(true);
  });

  it("rejects when legacy ids exceed the current list", () => {
    expect(legacyPrefixMatch(["a", "b", "c"], ["a", "b"])).toBe(false);
  });

  it("rejects an interior mismatch", () => {
    expect(legacyPrefixMatch(["a", "X"], ["a", "b", "c"])).toBe(false);
  });

  it("rejects empty / missing legacy lists so the caller forces a full extraction", () => {
    expect(legacyPrefixMatch(undefined, ["a"])).toBe(false);
    expect(legacyPrefixMatch([], ["a"])).toBe(false);
  });
});

describe("fingerprint size in practice", () => {
  it("stays under 1KB even for 5k-message sessions", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => "entry-" + i + "-" + Math.random().toString(36).slice(2));
    const fp = buildEntryIdFingerprint(ids);
    const serialized = JSON.stringify(fp);
    // sha256 hex (64) + 16 ids (~40 chars each = ~640) + count + commas/quotes
    // Comfortably under 1KB. Without this we'd be writing ~250KB per save.
    expect(serialized.length).toBeLessThan(1024);
  });
});
