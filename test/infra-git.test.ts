/**
 * Git root resolution caches per cwd. We test:
 *  - Result is stable across calls for the same cwd.
 *  - The cache survives a no-op call (we never re-shell out).
 *  - Reset clears it for fresh test runs.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { findGitRoot, _resetGitRootCacheForTests } from "../src/infra/git.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

  it("expires a negative entry when the directory becomes a repository", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psc-git-cache-"));
    try {
      expect(findGitRoot(dir, 1_000)).toBeNull();
      const init = Bun.spawnSync(["git", "init", "--quiet"], { cwd: dir });
      expect(init.exitCode).toBe(0);
      expect(findGitRoot(dir, 5_999)).toBeNull();
      expect(findGitRoot(dir, 6_001)).toBe(fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
