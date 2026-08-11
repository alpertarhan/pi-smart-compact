/**
 * Git root resolver with a bounded, expiring cwd cache.
 *
 * Positive entries avoid repeated synchronous `git rev-parse` calls during
 * compaction. Negative entries use a short TTL because a directory may become
 * a repository while the extension process is still running.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import * as log from "../utils/logger.ts";

const POSITIVE_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 5_000;
const ROOT_CACHE_MAX = 128;
const ROOT_CACHE = new Map<string, { root: string | null; expiresAt: number }>();

export function findGitRoot(cwd: string, now = Date.now()): string | null {
  if (!cwd) return null;
  const key = path.resolve(cwd);
  const cached = ROOT_CACHE.get(key);
  if (cached && cached.expiresAt > now) {
    ROOT_CACHE.delete(key);
    ROOT_CACHE.set(key, cached);
    return cached.root;
  }
  if (cached) ROOT_CACHE.delete(key);
  let root: string | null = null;
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd: key, encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    });
    root = out.trim() || null;
  } catch (e) {
    log.debug("git rev-parse failed for " + key, e);
  }
  ROOT_CACHE.set(key, {
    root,
    expiresAt: now + (root ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
  while (ROOT_CACHE.size > ROOT_CACHE_MAX) {
    const oldest = ROOT_CACHE.keys().next().value;
    if (oldest === undefined) break;
    ROOT_CACHE.delete(oldest);
  }
  return root;
}

/** Test helper — clears the cache between runs. */
export function _resetGitRootCacheForTests(): void {
  ROOT_CACHE.clear();
}
