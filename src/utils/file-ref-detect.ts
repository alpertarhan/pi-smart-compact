/**
 * Heuristic file-reference extraction for `verifySummary`.
 *
 * Given a free-form summary paragraph, return every token that *looks like*
 * a file reference the model could have hallucinated. Used to detect
 * "potentially fabricated file" gaps without bothering an LLM.
 *
 * The challenge is precision: pure ext-matching is too noisy ("v7.13.2",
 * "node 22.19.19", "@types/node 24.12.4" all match `word.ext`). Pure
 * path-matching misses common bare filenames ("README.md"). We compromise:
 *
 *   - Reject SemVer-shaped tokens outright.
 *   - For tokens with a `/`, require the last segment not be a version.
 *   - For tokens without `/`, require a known source/config extension.
 *
 * The heuristic is intentionally conservative — false negatives surface as
 * "didn't notice this fabricated file" (annoying), false positives surface
 * as "agent gets a wrong gap and tries to patch a real file" (corrupting).
 * The latter is much worse, so we lean toward strictness.
 */

/**
 * Recognized source-code, build, and config extensions. Sorted by likely
 * frequency in a typical pi session log. Note: `.env` and `.lock` are
 * intentionally included because pi sessions frequently reference them.
 */
export const CODE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|rb|cs|cpp|c|h|hpp|swift|kt|scala|php|css|scss|html|json|yaml|yml|toml|md|mdx|sh|sql|tf|ini|env|lock|gradle|xml)$/i;

/**
 * Permissive SemVer 2.0 shape (with optional `v` prefix and pre-release /
 * build metadata). We reject these so `1.2.3` and `v0.78.0-beta.4` never
 * survive the file-ref filter.
 */
export const VERSION_RE = /^v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/i;

/**
 * Coarse-grained `word.ext` matcher retained as the public candidate grammar.
 * `extractFileRefs` implements the same match semantics with a linear scanner:
 * running this greedy expression directly has quadratic backtracking on long
 * dotless tokens.
 */
export const FILE_REF_CANDIDATE_RE = /[\w.\/-]+\.[\w]+/g;

function isAsciiWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  );
}

function isCandidateCode(code: number): boolean {
  return isAsciiWordCode(code) || code === 45 || code === 46 || code === 47;
}

/**
 * Decide whether a candidate token (already produced by
 * `FILE_REF_CANDIDATE_RE`) should be treated as a potential file reference.
 *
 * Exported separately from `extractFileRefs` so unit tests can pin down
 * the classifier without re-running the candidate generator.
 */
export function isLikelyFileRef(candidate: string): boolean {
  // Candidate generation drops URL schemes at ':', leaving protocol-relative
  // fragments such as //registry.npmjs.org. They are remote hosts, not files.
  if (candidate.startsWith("//") || VERSION_RE.test(candidate)) return false;
  if (candidate.includes("/")) {
    // Path-segment match: must contain at least one directory component
    // and the last segment must not be a bare version literal (e.g.
    // "v7.13.2/something" — the trailing slash sweeps a real path in).
    const last = candidate.split("/").pop() ?? "";
    return last.length > 0 && !VERSION_RE.test(last);
  }
  // Bare tokens (no slash) need a known extension to count.
  return CODE_EXT_RE.test(candidate);
}

/**
 * Extract every plausible file reference from a free-form summary string.
 * Returns the raw token in original case so the caller can match against
 * extraction.modifiedFiles / extraction.readFiles for known-vs-fabricated
 * classification.
 */
export function extractFileRefs(summary: string): string[] {
  const refs: string[] = [];
  let cursor = 0;
  while (cursor < summary.length) {
    while (cursor < summary.length && !isCandidateCode(summary.charCodeAt(cursor))) cursor++;
    const runStart = cursor;
    while (cursor < summary.length && isCandidateCode(summary.charCodeAt(cursor))) cursor++;
    const runEnd = cursor;

    // This is the linear equivalent of the regex's greedy first class: use
    // the last dot that has a word character after it, then consume that word
    // suffix. A literal dot at runStart cannot match because `[...]+` must
    // consume at least one character before the regex's `\.`.
    let extensionDot = -1;
    for (let index = runStart + 1; index + 1 < runEnd; index++) {
      if (
        summary.charCodeAt(index) === 46 &&
        isAsciiWordCode(summary.charCodeAt(index + 1))
      ) {
        extensionDot = index;
      }
    }
    if (extensionDot < 0) continue;

    let matchEnd = extensionDot + 2;
    while (
      matchEnd < runEnd &&
      isAsciiWordCode(summary.charCodeAt(matchEnd))
    ) {
      matchEnd++;
    }
    const candidate = summary.slice(runStart, matchEnd);
    // `Foo.Application/Services` is a directory path, not a file named
    // `Foo.Application`. A separator immediately after the regex match proves
    // the candidate was only a dotted directory prefix.
    if (/[\\/]/.test(summary[matchEnd] ?? "")) continue;
    if (isLikelyFileRef(candidate)) refs.push(candidate);
  }
  return refs;
}
