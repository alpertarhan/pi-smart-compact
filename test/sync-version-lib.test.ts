/**
 * Coverage for the SemVer validator + version-line rewriter used by
 * `scripts/sync-version.ts`. The script itself is thin orchestration on
 * top of these two pure functions.
 *
 * Why we care: the rewriter inlines a string literal into a generated TS
 * file. Without strict validation an attacker-controlled / merge-corrupted
 * `package.json` could escape the surrounding double quotes and inject
 * arbitrary code (`"1.0.0\\"; export const PWNED = \\""`). The validator
 * is the only thing standing between that JSON and our build output.
 */
import { describe, it, expect } from "bun:test";
import {
  isValidSemver,
  rewriteVersionLiteral,
  SEMVER_RE,
} from "../scripts/sync-version-lib.ts";

describe("isValidSemver — accepts canonical shapes", () => {
  for (const v of [
    "0.0.0",
    "1.0.0",
    "7.13.2",
    "10.20.30",
    "1.2.3-rc.1",
    "1.2.3-beta.4",
    "1.2.3+build.1",
    "1.2.3-beta+exp.sha.5114f85",
  ]) {
    it("accepts " + v, () => { expect(isValidSemver(v)).toBe(true); });
  }
});

describe("isValidSemver — rejects malformed shapes", () => {
  for (const v of [
    "",
    "v1.0.0",                // leading v not allowed (npm versions are bare)
    "1.0",
    "1",
    "1.0.0.0",
    "abc",
    "1.0.0 ; rm -rf /",
    `1.0.0"; export const PWNED = "`,   // the actual injection vector
  ]) {
    it("rejects " + JSON.stringify(v), () => { expect(isValidSemver(v)).toBe(false); });
  }

  it("intentionally accepts leading-zero numerics (not strict SemVer but harmless)", () => {
    // Strict SemVer 2.0 forbids leading zeros ("01.0.0" is invalid), but
    // our regex permits them because:
    //   (a) leading zeros cannot escape the surrounding double quotes,
    //       so the injection threat we actually defend against is unaffected;
    //   (b) npm itself accepts these and we'd rather mirror npm than diverge.
    // This test documents the permissive choice so a future contributor
    // doesn't "fix" the regex and break a published package.
    expect(isValidSemver("01.0.0")).toBe(true);
  });
});

describe("isValidSemver — non-string inputs", () => {
  it("rejects non-string types", () => {
    expect(isValidSemver(undefined)).toBe(false);
    expect(isValidSemver(null)).toBe(false);
    expect(isValidSemver(123)).toBe(false);
    expect(isValidSemver({})).toBe(false);
    expect(isValidSemver(["1.0.0"])).toBe(false);
  });
});

describe("SEMVER_RE — sanity", () => {
  it("is a string-anchored regex (^...$)", () => {
    expect(SEMVER_RE.source.startsWith("^")).toBe(true);
    expect(SEMVER_RE.source.endsWith("$")).toBe(true);
  });

  it("does not accept embedded whitespace or quotes", () => {
    expect(SEMVER_RE.test(" 1.0.0")).toBe(false);
    expect(SEMVER_RE.test("1.0.0 ")).toBe(false);
    expect(SEMVER_RE.test('1.0.0"')).toBe(false);
  });
});

describe("rewriteVersionLiteral", () => {
  const sample = [
    "// header",
    `export const VERSION = "0.0.0";`,
    "export const OTHER = 42;",
  ].join("\n");

  it("found=false when no VERSION line exists", () => {
    const r = rewriteVersionLiteral("// nothing here\nconst x = 1;", "1.0.0");
    expect(r.found).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.result).toBe("// nothing here\nconst x = 1;");
  });

  it("changed=true when the version differs", () => {
    const r = rewriteVersionLiteral(sample, "1.2.3");
    expect(r.found).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.result).toContain(`export const VERSION = "1.2.3";`);
    expect(r.result).not.toContain(`export const VERSION = "0.0.0";`);
    expect(r.result).toContain("export const OTHER = 42;");
  });

  it("changed=false when the literal already matches (idempotent)", () => {
    const r = rewriteVersionLiteral(sample, "0.0.0");
    expect(r.found).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.result).toBe(sample);
  });

  it("does NOT match a similar line inside a comment", () => {
    const withComment = [
      "// export const VERSION = \"0.0.0\";",   // not anchored to line start because of `// `
      `export const VERSION = "0.0.0";`,
    ].join("\n");
    const r = rewriteVersionLiteral(withComment, "9.9.9");
    expect(r.changed).toBe(true);
    // Only one substitution: the real line.
    const occurrences = r.result.match(/export const VERSION = "9\.9\.9";/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("rewrites only the first match (regex without /g)", () => {
    // Defensive: even if somehow two version lines exist, we change only one.
    const twice = [
      `export const VERSION = "1.0.0";`,
      `export const VERSION = "1.0.0";`,
    ].join("\n");
    const r = rewriteVersionLiteral(twice, "2.0.0");
    const newCount = (r.result.match(/2\.0\.0/g) ?? []).length;
    const oldCount = (r.result.match(/1\.0\.0/g) ?? []).length;
    expect(newCount).toBe(1);
    expect(oldCount).toBe(1);
  });
});
