/**
 * Entry-id list fingerprinting for the extraction cache.
 *
 * The extraction cache used to write the full toCompact entry-id array to
 * disk and then re-read it on the next run to verify that the cached
 * extraction's "prefix" was still valid. That scales linearly with session
 * length — a 5k-message session rewrote a 100KB JSON document on every
 * compact, and disk-usage doubled as soon as you turned on auto-trigger.
 *
 * The fingerprint captures only what the cache logic actually inspects:
 *
 *   1. `count` — gives us an O(1) gate before doing any hashing.
 *   2. `tail` — last K ids, cheap first-line check; if the tail differs we
 *      know the prefix differs without computing a hash.
 *   3. `prefixHash` — SHA-256 over `ids.slice(0, count).join("\n")`. This is
 *      the authoritative prefix proof: if `currentIds.slice(0, cached.count)`
 *      hashes to `cached.prefixHash`, the cache is a valid prefix of the
 *      current run.
 *
 * The hash uses `\n` as a separator because pi-coding-agent entry ids are
 * URL-safe and never contain newlines. Tail size of 16 covers the
 * "single new exchange" case (user message + assistant + ≤14 tool turns) so
 * the slow path (hashing) only runs when something meaningful changed.
 */

import crypto from "node:crypto";
import type { EntryIdFingerprint } from "../types.ts";

/** Tail length; chosen to cover one "user → assistant → many tool turns" cycle. */
export const FINGERPRINT_TAIL_LEN = 16;

export function buildEntryIdFingerprint(ids: ReadonlyArray<string>): EntryIdFingerprint {
  const count = ids.length;
  const tail = ids.slice(Math.max(0, count - FINGERPRINT_TAIL_LEN));
  const prefixHash = hashIds(ids, count);
  return { count, prefixHash, tail };
}

/** Stable SHA-256 over the first `count` ids joined by `\n`. */
export function hashIds(ids: ReadonlyArray<string>, count: number): string {
  const h = crypto.createHash("sha256");
  const limit = Math.min(count, ids.length);
  for (let i = 0; i < limit; i++) {
    if (i > 0) h.update("\n");
    h.update(ids[i]);
  }
  return h.digest("hex");
}

/**
 * Does `cached` represent a prefix of `currentIds`?
 *
 * Order of checks is deliberate:
 *
 *   1. `cached.count > currentIds.length` → impossible to be a prefix.
 *   2. Tail mismatch at the boundary → we don't need to hash.
 *   3. Hash check confirms the full prefix.
 *
 * Returns false on missing fingerprint (caller should fall back to the
 * legacy full-array compare).
 */
export function isPrefixOf(cached: EntryIdFingerprint | undefined, currentIds: ReadonlyArray<string>): boolean {
  if (!cached) return false;
  if (cached.count > currentIds.length) return false;
  // Fast tail check: cached.tail must match currentIds[count-tail.length .. count].
  const tailStart = cached.count - cached.tail.length;
  for (let i = 0; i < cached.tail.length; i++) {
    if (currentIds[tailStart + i] !== cached.tail[i]) return false;
  }
  return hashIds(currentIds, cached.count) === cached.prefixHash;
}

/**
 * Backwards-compatible prefix check.
 *
 * Newer caches store a fingerprint; older caches store the full id array. We
 * accept both so the v7.13 upgrade path doesn't invalidate every existing
 * cache file at once — the next save rewrites the cache in the new shape.
 */
export function legacyPrefixMatch(legacy: ReadonlyArray<string> | undefined, currentIds: ReadonlyArray<string>): boolean {
  if (!legacy || legacy.length === 0) return false;
  if (legacy.length > currentIds.length) return false;
  for (let i = 0; i < legacy.length; i++) {
    if (legacy[i] !== currentIds[i]) return false;
  }
  return true;
}
