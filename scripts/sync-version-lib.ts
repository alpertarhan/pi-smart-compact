/**
 * Pure functions used by `sync-version.ts`. Separated from the CLI
 * orchestration so they can be unit-tested without touching the filesystem
 * or shelling out to bun.
 *
 * The two responsibilities:
 *
 *   1. `isValidSemver` — strict SemVer 2.0 validator. We refuse to embed
 *      anything that doesn't pass so a corrupted/attacker-controlled
 *      package.json cannot inject arbitrary TypeScript via the generated
 *      `export const VERSION = "...";` line.
 *
 *   2. `rewriteVersionLiteral` — surgical regex replacement of the version
 *      line in `src/constants.ts`. Returns `{ found, changed, result }` so
 *      the CLI wrapper can report idempotent vs updated states without
 *      reading the file twice.
 */

/**
 * Permissive subset of SemVer 2.0 with optional pre-release / build
 * metadata. We deliberately do NOT accept a leading `v` here \u2014 npm
 * package.json versions are always bare.
 */
export const SEMVER_RE =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isValidSemver(s: unknown): s is string {
  return typeof s === "string" && SEMVER_RE.test(s);
}

/**
 * Locates the single `export const VERSION = "...";` line in a TypeScript
 * source file and replaces its literal. Returns:
 *
 *   - `found: false` when no matching line exists (caller should error).
 *   - `changed: false` when the literal already matched the new version.
 *   - `changed: true` with the rewritten source otherwise.
 *
 * The regex is anchored to the line start (`^`) with the `m` flag, so it
 * cannot accidentally match a comment fragment or a string in a doc block.
 */
const VERSION_LINE_RE = /^export const VERSION\s*=\s*"[^"]*";$/m;

export interface RewriteResult {
  found: boolean;
  changed: boolean;
  result: string;
}

export function rewriteVersionLiteral(source: string, newVersion: string): RewriteResult {
  if (!VERSION_LINE_RE.test(source)) {
    return { found: false, changed: false, result: source };
  }
  const updated = source.replace(VERSION_LINE_RE, `export const VERSION = "${newVersion}";`);
  return {
    found: true,
    changed: updated !== source,
    result: updated,
  };
}
