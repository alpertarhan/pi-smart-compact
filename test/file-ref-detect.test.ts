/**
 * Coverage for the file-reference detector used by `verifySummary`.
 *
 * The classifier is the line of defense between "summary mentions a real
 * file but model also typed a version string" and the agent trying to
 * "patch a non-existent file v7.13.2". We exercise:
 *
 *   - SemVer rejection (bare, with `v`, with pre-release, with build meta)
 *   - Path-segment acceptance vs trailing-version rejection
 *   - Bare-token acceptance only for known extensions
 *   - Coarse `extractFileRefs` integration
 */
import { describe, it, expect } from "bun:test";
import {
  isLikelyFileRef,
  extractFileRefs,
  CODE_EXT_RE,
  VERSION_RE,
  FILE_REF_CANDIDATE_RE,
} from "../src/utils/file-ref-detect.ts";

describe("VERSION_RE", () => {
  for (const v of ["1.0.0", "v1.0.0", "v7.13.2", "0.78.0", "v1.2.3-beta.4", "v1.0.0+build.1", "0.0.1-rc.1"]) {
    it("matches " + v, () => { expect(VERSION_RE.test(v)).toBe(true); });
  }
  for (const v of ["src/index.ts", "node 22", "v1", "v"]) {
    it("does not match " + v, () => { expect(VERSION_RE.test(v)).toBe(false); });
  }
});

describe("CODE_EXT_RE", () => {
  for (const f of ["foo.ts", "BAR.TSX", "build.gradle", "Cargo.lock", "schema.sql", ".env"]) {
    it("accepts " + f, () => { expect(CODE_EXT_RE.test(f)).toBe(true); });
  }
  for (const f of ["foo", "foo.unknown", "foo.exe", "foo.bin"]) {
    it("rejects " + f, () => { expect(CODE_EXT_RE.test(f)).toBe(false); });
  }
});

describe("isLikelyFileRef — version rejection", () => {
  it("rejects bare SemVer strings", () => {
    expect(isLikelyFileRef("1.0.0")).toBe(false);
    expect(isLikelyFileRef("v7.13.2")).toBe(false);
    expect(isLikelyFileRef("0.78.0")).toBe(false);
  });

  it("rejects SemVer with pre-release / build metadata", () => {
    expect(isLikelyFileRef("v1.2.3-beta.4")).toBe(false);
    expect(isLikelyFileRef("1.0.0+build.1")).toBe(false);
  });

  it("rejects paths whose final segment is a bare version", () => {
    expect(isLikelyFileRef("foo/v7.13.2")).toBe(false);
    expect(isLikelyFileRef("a/b/c/1.0.0")).toBe(false);
  });
});

describe("isLikelyFileRef — path acceptance", () => {
  it("accepts paths with at least one directory component", () => {
    expect(isLikelyFileRef("src/index.ts")).toBe(true);
    expect(isLikelyFileRef("build/dist/bundle.js")).toBe(true);
    expect(isLikelyFileRef("docs/README.md")).toBe(true);
  });

  it("accepts paths whose last segment ends in an extension", () => {
    expect(isLikelyFileRef("foo/bar.json")).toBe(true);
    expect(isLikelyFileRef("foo/.env")).toBe(true);
  });

  it("accepts paths even when the extension is unknown (path semantics dominate)", () => {
    // Once we see a `/`, the candidate is path-shaped; the trailing token
    // doesn't have to live in CODE_EXT_RE for it to count as a file ref.
    // This is deliberate — the agent might reference an extensionless
    // script (e.g. `scripts/build`) but our candidate generator only fires
    // for things with a literal `.<ext>`, so this stays a safety net.
    expect(isLikelyFileRef("foo/bar.unknown")).toBe(true);
  });
});

describe("isLikelyFileRef — bare token acceptance", () => {
  it("accepts bare filenames with known extensions", () => {
    expect(isLikelyFileRef("README.md")).toBe(true);
    expect(isLikelyFileRef("package.json")).toBe(true);
    expect(isLikelyFileRef("index.ts")).toBe(true);
  });

  it("rejects bare filenames with unknown extensions", () => {
    expect(isLikelyFileRef("foo.unknown")).toBe(false);
    expect(isLikelyFileRef("photo.heic")).toBe(false);
  });
});

describe("extractFileRefs — integration", () => {
  it("extracts real file references from prose", () => {
    const summary = "Updated src/index.ts and package.json, fixed README.md typo.";
    const refs = extractFileRefs(summary);
    expect(refs).toContain("src/index.ts");
    expect(refs).toContain("package.json");
    expect(refs).toContain("README.md");
  });

  it("does NOT extract version strings mixed in with prose (regression)", () => {
    const summary = "Bumped @earendil-works/pi-ai 0.75.5 \u2192 0.78.0 and TypeScript 6.0.3, updated src/index.ts.";
    const refs = extractFileRefs(summary);
    expect(refs).toContain("src/index.ts");
    // The whole point of the heuristic:
    expect(refs).not.toContain("0.75.5");
    expect(refs).not.toContain("0.78.0");
    expect(refs).not.toContain("6.0.3");
  });

  it("does NOT extract `node X.Y.Z` style runtime versions", () => {
    const summary = "Tested on node 22.19.19 and bun 1.3.14.";
    const refs = extractFileRefs(summary);
    expect(refs).not.toContain("22.19.19");
    expect(refs).not.toContain("1.3.14");
  });

  it("returns an empty array when no candidates exist", () => {
    expect(extractFileRefs("plain prose without file references")).toEqual([]);
  });

  it("uses a fresh regex each call (no global-flag state leak)", () => {
    // FILE_REF_CANDIDATE_RE has the /g flag; we re-`match` per call so the
    // lastIndex never leaks between callers. This regression test makes
    // sure two consecutive calls see the same candidates.
    const s = "a/b.ts and c/d.ts";
    expect(extractFileRefs(s)).toEqual(extractFileRefs(s));
  });
});

describe("FILE_REF_CANDIDATE_RE", () => {
  it("is a global regex (used with String.match)", () => {
    expect(FILE_REF_CANDIDATE_RE.flags).toContain("g");
  });
});
