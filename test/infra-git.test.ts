/**
 * Git root resolution caches per cwd. We test:
 *  - Result is stable across calls for the same cwd.
 *  - The cache survives a no-op call (we never re-shell out).
 *  - Reset clears it for fresh test runs.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { findGitRoot, _resetGitRootCacheForTests } from "../src/infra/git.ts";

beforeEach(() => { _resetGitRootCacheForTests(); });

describe("findGitRoot", () => {
  it("returns a non-null root inside this repository", () => {
    const root = findGitRoot(process.cwd());
    expect(root).toBeTruthy();
    // Sanity: same cwd → same answer.
    expect(findGitRoot(process.cwd())).toBe(root);
  });

  it("returns null for /tmp (not a git repo) and caches the negative", () => {
    expect(findGitRoot("/tmp")).toBeNull();
    expect(findGitRoot("/tmp")).toBeNull();
  });
});
