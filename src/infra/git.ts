/**
 * Git root resolver with a cwd-keyed cache.
 *
 * `runSmartCompact` calls `findGitRoot(ctx.cwd)` once per run. Each call shells
 * out via `execSync("git rev-parse --show-toplevel")`, which blocks the event
 * loop for ~5-25ms on typical machines. Under auto-trigger this fires on every
 * compaction. Caching by cwd is safe because the git root for a given cwd
 * never changes within an extension process lifetime, and the cache only holds
 * a few entries per session.
 *
 * Non-git directories are also cached (null result) so we don't re-shell out
 * for every single invocation in a non-repo directory.
 */

import { execSync } from "node:child_process";
import * as log from "../utils/logger.ts";

const ROOT_CACHE = new Map<string, string | null>();

export function findGitRoot(cwd: string): string | null {
  if (!cwd) return null;
  if (ROOT_CACHE.has(cwd)) return ROOT_CACHE.get(cwd) ?? null;
  let root: string | null = null;
  try {
    const out = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", timeout: 2000 });
    root = out.trim() || null;
  } catch (e) {
    log.debug("git rev-parse failed for " + cwd, e);
    root = null;
  }
  ROOT_CACHE.set(cwd, root);
  return root;
}

/** Test helper — clears the cache between runs. */
export function _resetGitRootCacheForTests(): void {
  ROOT_CACHE.clear();
}
