/**
 * Salient-keyword extraction for fuzzy "is this concept covered?" checks.
 *
 * Pure (no I/O) — lives in the domain layer so both the verify phase and the
 * damage detector share one implementation instead of each re-deriving a
 * "first N long words" heuristic (which picked positional noise and missed the
 * real term further into the text).
 *
 * ponytail ceiling: this is still keyword/substring matching. A paraphrase
 * ("TS" vs "TypeScript") can't be recognized — an inherent limit of the cheap
 * proxy, not fixable without an LLM judge (which would defeat deterministic-first).
 */

/**
 * Extract salient keyword tokens from a source string. Strips punctuation and
 * prefers proper nouns / identifiers (capitalized or digit-bearing) over
 * positional fillers. Returns at most `max` tokens, original case preserved
 * (callers lower-case as needed for comparison).
 */
export function extractCheckKeywords(text: string, max: number): string[] {
  const words = text.split(/\s+/)
    .map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(w => w.length > 3);
  if (!words.length) return [];
  const salient = (w: string) => /^[A-ZÀ-Þ]/.test(w) || /[0-9]/.test(w);
  const preferred = words.filter(salient);
  return (preferred.length ? preferred : words).slice(0, max);
}
