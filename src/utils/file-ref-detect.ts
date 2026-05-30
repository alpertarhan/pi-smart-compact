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

/** Coarse-grained `word.ext` matcher used as the candidate generator. */
export const FILE_REF_CANDIDATE_RE = /[\w.\/-]+\.[\w]+/g;

/**
 * Decide whether a candidate token (already produced by
 * `FILE_REF_CANDIDATE_RE`) should be treated as a potential file reference.
 *
 * Exported separately from `extractFileRefs` so unit tests can pin down
 * the classifier without re-running the candidate generator.
 */
export function isLikelyFileRef(candidate: string): boolean {
  if (VERSION_RE.test(candidate)) return false;
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
  const candidates = summary.match(FILE_REF_CANDIDATE_RE) ?? [];
  return candidates.filter(isLikelyFileRef);
}
