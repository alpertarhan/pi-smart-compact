/**
 * Phase 4: deterministic verification and repair.
 *
 * Verification findings are structured data. Formatting belongs at the UI/LLM
 * boundary; repair logic switches on `kind` and never reparses its own prose.
 */

import type {
 Model,
 Api,
 Context,
 ProviderHeaders,
 TextContent,
} from "@earendil-works/pi-ai";
import type {
 CompactionState,
 ContinuityOverride,
 StructuredExtraction,
 VerificationGap,
 VerificationGateStage,
 VerificationResult,
 LlmMessage,
} from "../types.ts";
import { COMPACT_SYSTEM_PREFIX, LIKELY_ERROR_RE, TRUNC } from "../constants.ts";
import { trackedComplete } from "../utils/cache.ts";
import { getProviderCaps } from "../utils/tokens.ts";
import { extractFileRefs } from "../utils/file-ref-detect.ts";
import {
 buildToolCallIndex,
 extractText,
 isNonLiveConstraintText,
 collapseDecisionsByQuestion,
} from "../utils/extraction.ts";
import { normalizeFactKey } from "../utils/helpers.ts";
import {
 buildKnownPathReferenceIndex,
 buildPathNeedleOwnershipIndex,
 buildUniquePathNeedlesFromIndex,
 isKnownPathReferenceInIndex,
 normalizePath,
} from "../utils/file-needles.ts";
import * as log from "../utils/logger.ts";
import {
 buildSummaryPathEvidence,
 parseSummary,
 findSection,
 appendToSection,
 renderSummary,
 summaryEvidenceLine,
 upsertSection,
} from "../domain/summary-parse.ts";
import { canonicalHeading } from "../domain/summary-schema.ts";
import type { CanonicalSummary } from "../domain/summary-schema.ts";
import {
 classifyToolOperation,
 extractToolPath,
 normalizeToolName,
 type ToolOperation,
} from "../domain/tool-semantics.ts";
import { lruGet, lruSet } from "../utils/lru.ts";
import type { SmartCompactServices } from "../infra/services.ts";
export interface VerificationEvidence {
 sourceMessages?: readonly LlmMessage[];
 steering?: { focus?: string; note?: string };
 summaryBudgetTokens?: number;
 /** Run-scoped fact overrides (e.g. constraints retired this run). */
 factOverrides?: readonly ContinuityOverride[];
}

const HIGH_RISK_OUTCOME_RE =
 /(?:\ball\s+tests?\s+(?:pass|passed|passing)\b|\btests?\s+(?:pass|passed|passing)\b|\b(?:build|deployment|migration)\s+(?:completed|succeeded|passed|successful)\b|\b(?:deployed|published|released)\b|\b(?:bug|issue|error)\s+(?:fixed|resolved)\b|\bno\s+(?:errors?|failures?)\b|\bcompleted successfully\b|\btestler?\s+(?:geçti|başarılı)\b|\bbaşarıyla\s+(?:tamamlandı|dağıtıldı|yayınlandı)\b|\b(?:deploy edildi|yayınlandı|hata yok)\b)/iu;
const NEGATED_OUTCOME_RE =
 /\b(?:not|never|pending|failed|failing|unresolved|henüz|değil|başarısız)\b/iu;
const NONE_BLOCKER_VALUE_RE =
 /^(?:none|no blockers?|yok)\s*(?:recorded|known)?[.!]?$/i;
const BULLET_NONE_BLOCKER_RE =
 /^(?:[-*+]|\d+[.)])\s+(?:none|no blockers?|yok)\s*(?:recorded|known)?[.!]?$/i;
const PATH_PLACEHOLDER_RE = /^(?:none|none recorded|no blockers?|yok)[.!]?$/i;

function noneBlockerLineIndexes(lines: readonly string[]): Set<number> {
 const indexes = new Set<number>();
 const nonEmpty = lines
  .map((line, index) => ({ index, text: line.trim() }))
  .filter((item) => item.text);
 for (const item of nonEmpty) {
  if (BULLET_NONE_BLOCKER_RE.test(item.text)) indexes.add(item.index);
 }
 if (nonEmpty.length === 1 && NONE_BLOCKER_VALUE_RE.test(nonEmpty[0].text)) {
  indexes.add(nonEmpty[0].index);
 }
 return indexes;
}

interface ListedPathEvidence {
 values: Set<string>;
 encodedValues: Set<string>;
 normalizedValues: Set<string>;
}

function collectListedPaths(
 body: string,
 expectedPaths: ReadonlySet<string>,
): ListedPathEvidence {
 const values = new Set<string>();
 const encodedValues = new Set<string>();
 for (const line of body.split("\n")) {
  const raw = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
  if (!raw) continue;
  if (raw.startsWith('"')) {
   try {
    const decoded = JSON.parse(raw);
    if (typeof decoded === "string") {
     values.add(decoded);
     encodedValues.add(decoded);
     continue;
    }
   } catch {
    // A model may emit an unquoted legacy path beginning with `"`.
   }
  }
  values.add(raw);
  if (expectedPaths.has(raw)) continue;
  const unwrapped =
   raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
  const unchecked = unwrapped.replace(/^\[[ x]\]\s+/i, "");
  if (expectedPaths.has(unchecked)) values.add(unchecked);
 }
 return {
  values,
  encodedValues,
  normalizedValues: new Set(Array.from(values, normalizePath)),
 };
}

function decodePathDisplay(display: string): string {
 try {
  const decoded = JSON.parse(display);
  return typeof decoded === "string" ? decoded : display;
 } catch {
  return display;
 }
}

function hasListedPath(
 listed: ListedPathEvidence,
 file: string,
 display: string,
 normalizedOwners: ReadonlyMap<string, number>,
): boolean {
 const decodedDisplay = decodePathDisplay(display);
 if (listed.encodedValues.has(decodedDisplay)) return true;
 if (PATH_PLACEHOLDER_RE.test(file)) return false;
 if (listed.values.has(file)) return true;
 for (const candidate of [file, decodedDisplay]) {
  const normalized = normalizePath(candidate);
  if (
   normalizedOwners.get(normalized) === 1 &&
   listed.normalizedValues.has(normalized)
  )
   return true;
 }
 return false;
}

/** Labels the deterministic renderers and the continuity ledger put in front of evidence. */
const EVIDENCE_LINE_LABEL_RE =
 /^(?:(?:constraint|goal|decision|critical|open loop|unresolved error|resolved error|\[focus\]|\[note\]):?\s*)+/i;
/** Shortest rendered prefix of an evidence text that still counts as a quotation of it. */
const EVIDENCE_QUOTE_MIN_CHARS = 80;

/**
 * Lines the verifier itself requires the summary to carry are evidence, not
 * outcome claims by the summary's author. "`send()` returns `{queued:true}`
 * ...; message lost with no error surfaced" is a recorded bug, yet the claim
 * scan read "no error" as a success claim, repair removed the line, and the
 * next pass reported the constraint missing: no candidate could pass. Only
 * exact renderings count: the whole text, or a truncation-length prefix of
 * it, with display labels and bold markers stripped. Prose that merely
 * echoes a phrase from evidence still needs tool evidence.
 */
function isRequiredEvidenceLine(line: string, corpus: readonly string[]): boolean {
 const key = normalizeFactKey(line.replace(/\*\*/g, "").replace(EVIDENCE_LINE_LABEL_RE, ""));
 if (!key) return false;
 return corpus.some((text) =>
  text === key || (key.length >= EVIDENCE_QUOTE_MIN_CHARS && text.startsWith(key)),
 );
}

function requiredEvidenceCorpus(
 collected: CollectedVerificationEvidence,
 continuity: CompactionState | null,
): string[] {
 const texts = [
  ...collected.constraints.map((item) => item.text),
  ...collected.unresolved.map((item) => item.message),
  ...collected.resolved.map((item) => item.message),
  ...(collected.goal ? [collected.goal] : []),
  ...(continuity?.criticalContext ?? []),
  ...collected.decisions.flatMap((item) => {
   // The fallback and the ledger bound the question and the answer
   // separately before joining them with an arrow.
   const question = summaryEvidenceLine(item.summary, TRUNC.DECISION_SUMMARY);
   const answer = item.answer ? summaryEvidenceLine(item.answer, TRUNC.USER_RESPONSE) : "";
   return answer ? [item.summary, item.answer as string, question + " \u2192 " + answer] : [item.summary];
  }),
 ];
 return Array.from(new Set(texts.map((text) => normalizeFactKey(text.replace(/\*\*/g, ""))).filter(Boolean)));
}

function outcomeClaims(
 summary: string,
 pathEvidence: ReadonlyMap<string, string>,
 evidenceCorpus: readonly string[] = [],
): string[] {
 // Only exact, grounded path representations are exempt. Prose in a file
 // section still needs outcome evidence; a heading is not a trust boundary.
 const pathLines = new Set(Array.from(pathEvidence, ([path, display]) => [path, display, "`" + path + "`"]).flat());
 return Array.from(
  new Set(
   summary
    .split(/\r?\n/)
    .map((line) =>
     line
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^\[[ x]\]\s+/i, "")
      .trim(),
    )
    .filter((line) => line.length > 0 && !line.startsWith("#") && !pathLines.has(line))
    .filter((line) => HIGH_RISK_OUTCOME_RE.test(line))
    .filter((line) => !isRequiredEvidenceLine(line, evidenceCorpus))
    .filter(
     (line) =>
      /\bno\s+(?:errors?|failures?)\b/i.test(line) ||
      !NEGATED_OUTCOME_RE.test(line),
    ),
  ),
 ).slice(0, 12);
}

function classifyOutcomeClaim(
 claim: string,
): "test" | "build" | "release" | "error" | "file" | "generic" {
 const lower = claim.toLowerCase();
 if (/\btests?\b|\btestler?\b/.test(lower)) return "test";
 if (/\bbuild\b|\bcompil(?:e|ed|ation)\b|\btypecheck\b/.test(lower))
  return "build";
 if (/\bdeploy(?:ed|ment)?\b|\bpublish(?:ed)?\b|\breleas(?:e|ed)\b/.test(lower))
  return "release";
 if (/\bbug\b|\bissue\b|\berror\b|\bfail(?:ed|ure)?\b|\bhata\b/.test(lower))
  return "error";
 if (/\bfile\b|\bdosya\b/.test(lower)) return "file";
 return "generic";
}

interface SuccessfulToolEvidence {
 name: string;
 operation: ToolOperation;
 command: string;
 path?: string;
 result: string;
}

const successfulToolEvidenceCache = new WeakMap<
 readonly LlmMessage[],
 SuccessfulToolEvidence[]
>();
const sourceTextCache = new WeakMap<readonly LlmMessage[], string[]>();

function sourceSupportsFileReference(
 ref: string,
 messages: readonly LlmMessage[],
): boolean {
 let texts = sourceTextCache.get(messages);
 if (!texts) {
  texts = messages.map((message) =>
   extractText(message.content).replace(/\\/g, "/").toLowerCase(),
  );
  sourceTextCache.set(messages, texts);
 }
 const needle = ref.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
 if (!needle) return false;
 for (const text of texts) {
  let index = text.indexOf(needle);
  while (index >= 0) {
   const before = text[index - 1] ?? "";
   const after = text[index + needle.length] ?? "";
   if ((!before || !/[\w.-]/.test(before)) && (!after || !/[\w.-]/.test(after)))
    return true;
   index = text.indexOf(needle, index + 1);
  }
 }
 return false;
}

function successfulToolEvidence(
 messages: readonly LlmMessage[],
): SuccessfulToolEvidence[] {
 const cached = successfulToolEvidenceCache.get(messages);
 if (cached) return cached;
 const toolCalls = buildToolCallIndex(messages);
 const evidence: SuccessfulToolEvidence[] = [];
 for (const message of messages) {
  if (message.role !== "toolResult" || message.isError) continue;
  const call = toolCalls.get(message.toolCallId ?? "");
  if (!call) continue;
  const result = extractText(message.content).slice(0, 8_000);
  if (!result.trim() || LIKELY_ERROR_RE.test(result)) continue;
  const command =
   [call.arguments.command, call.arguments.cmd, call.arguments.script].find(
    (value): value is string => typeof value === "string",
   ) ?? "";
  evidence.push({
   name: normalizeToolName(call.name),
   operation: classifyToolOperation(call.arguments, call.name),
   command,
   path: extractToolPath(call.arguments),
   result,
  });
 }
 successfulToolEvidenceCache.set(messages, evidence);
 return evidence;
}

function successfulToolSupportsClaim(
 claim: string,
 tools: readonly SuccessfulToolEvidence[],
 extraction: StructuredExtraction,
): boolean {
 const shape = semanticShape(claim);
 const category = classifyOutcomeClaim(claim);
 if (
  category === "error" &&
  extraction.errors.some(
   (error) => error.resolved && hasSemanticEvidence(claim, error.message),
  )
 )
  return true;
 if (
  category === "file" &&
  extraction.modifiedFiles.some((file) =>
   claim.toLowerCase().includes(file.path.toLowerCase()),
  )
 )
  return true;

 // A result can prove only the operation that produced it. This rejects, for
 // example, "All tests passed" text returned by a read/search tool.
 for (const tool of tools) {
  const operationText = tool.name + " " + tool.command;
  const operationSupports =
   category === "test"
    ? /\b(?:test|tests|pytest|jest|vitest|mocha|rspec)\b/i.test(operationText)
    : category === "build"
     ? /\b(?:build|compile|typecheck|tsc|check)\b/i.test(operationText)
     : category === "release"
      ? /\b(?:deploy|publish|release)\b/i.test(operationText)
      : category === "file"
       ? tool.operation === "mutate" || tool.operation === "delete"
       : category === "error"
        ? tool.operation === "execute" ||
        tool.operation === "mutate" ||
        tool.operation === "delete"
        : tool.operation !== "read" &&
        tool.operation !== "search" &&
        tool.operation !== "list";
  if (!operationSupports) continue;
  if (hasSemanticEvidence(claim, tool.result)) return true;
  const lower = tool.result.toLowerCase();
  if (
   category === "test" &&
   /\b\d+\s+(?:tests?\s+)?pass(?:ed)?\b/.test(lower) &&
   !/\b(?:fail(?:ed|ures?)?|errors?)\s*[:=]?\s*[1-9]\d*\b/.test(lower)
  )
   return true;
  if (
   category === "build" &&
   /\b(?:succeeded|successful|passed|exit(?:ed)?\s+(?:code\s+)?0)\b/.test(lower)
  )
   return true;
  if (
   category === "release" &&
   /\b(?:succeeded|successful|completed|published|deployed|released)\b/.test(
    lower,
   )
  )
   return true;
  if (
   category === "error" &&
   shape.concepts.length > 0 &&
   /\b(?:fixed|resolved|passed|succeeded|successful)\b/.test(lower) &&
   hasSemanticEvidence(claim, tool.result)
  )
   return true;
 }
 return false;
}

function removeUnsupportedClaim(
 summary: CanonicalSummary,
 claim: string,
): CanonicalSummary {
 const normalized = claim.replace(/\s+/g, " ").trim().toLocaleLowerCase();
 return {
  sections: summary.sections.map((section) => ({
   ...section,
   body: section.body
    .split("\n")
    .filter((line) => {
     const candidate = line
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^\[[ x]\]\s+/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
     return candidate !== normalized;
    })
    .join("\n")
    .trim(),
  })),
 };
}

export function formatVerificationGap(gap: VerificationGap): string {
 switch (gap.kind) {
  case "missing-section":
   return "Missing section: " + canonicalHeading(gap.section);
  case "missing-file":
   return "Missing modified file: " + gap.path;
  case "missing-read-file":
   return "Missing read file: " + gap.path;
  case "missing-deleted-file":
   return "Missing deleted file: " + gap.path;
  case "missing-error":
   return (
    (gap.resolved ? "Missing resolved error history: " : "Missing error: ") +
    gap.message.slice(0, TRUNC.SNIPPET)
   );
  case "missing-constraint":
   return "Missing constraint: " + gap.text.slice(0, TRUNC.TOPIC_LABEL);
  case "missing-decision":
   return (
    "Missing decision: " +
    gap.summary.slice(0, TRUNC.TOPIC_LABEL) +
    (gap.answer ? " \u2192 " + gap.answer.slice(0, TRUNC.TOPIC_LABEL) : "")
   );
  case "missing-goal":
   return "Main goal may be missing from summary";
  case "fabricated-file":
   return "Potentially fabricated file: " + gap.ref;
  case "inconsistency":
   return "Inconsistency: " + gap.detail;
  case "missing-open-loops":
   return (
    "Missing Open Loops section despite " +
    gap.unresolvedCount +
    " unresolved errors"
   );
  case "unsupported-claim":
   return "Unsupported outcome claim: " + gap.claim.slice(0, TRUNC.SNIPPET);
 }
}

export function verificationFailureMessage(
 result: VerificationResult,
): string | null {
 if (result.ok) return null;
 const findings = result.gaps
  .slice(0, 3)
  .map((gap) => formatVerificationGap(gap).replace(/\s+/g, " ").slice(0, 160))
  .join("; ");
 return (
  "Verification gate rejected summary (" +
  result.score +
  "/100, " +
  result.gaps.length +
  (result.gaps.length === 1 ? " unresolved gap)" : " unresolved gaps)") +
  (findings ? ": " + findings : "")
 );
}

/** Content-free diagnostics survive the throw without leaking evidence to telemetry. */
export class VerificationGateError extends Error {
 readonly score: number;
 readonly initialScore: number;
 readonly gapKinds: VerificationGap["kind"][];
 readonly stage: VerificationGateStage;
 readonly gapCount: number;

 constructor(
  result: VerificationResult,
  initialScore: number,
  stage: VerificationGateStage,
 ) {
  super(
   verificationFailureMessage(result) ?? "Verification gate rejected summary",
  );
  this.name = "VerificationGateError";
  this.score = result.score;
  this.initialScore = initialScore;
  this.stage = stage;
  this.gapKinds = Array.from(new Set(result.gaps.map((gap) => gap.kind)));
  this.gapCount = result.gaps.length;
 }
}

const NEGATION_MARKERS = new Set([
 "no",
 "not",
 "never",
 "without",
 "avoid",
 "forbidden",
 "prohibit",
 "değil",
 "asla",
 "olmadan",
 "yasak",
 "hayır",
]);
const CONDITION_MARKERS = new Set([
 "only",
 "after",
 "before",
 "with",
 "requir",
 "until",
 "sadece",
 "sonra",
 "önce",
 "gerekli",
 "gerektirir",
]);
const POLARITY_INVERTING_GUARDS = new Set([
 "skip",
 "skipp",
 "forget",
 "forgett",
 "omit",
 "omitt",
 "neglect",
 "fail",
 "avoid",
]);
const SEMANTIC_STOP = new Set([
 "the",
 "and",
 "that",
 "this",
 "with",
 "from",
 "into",
 "must",
 "should",
 "only",
 "after",
 "before",
 "without",
 "never",
 "not",
 "does",
 "have",
 "için",
 "ile",
 "sonra",
 "önce",
 "sadece",
 "asla",
 "değil",
 "olmadan",
]);

// Turkish suffix stripping (coarse): unifies common inflections so a
// constraint "dosyayı sil" still matches a summary "dosyası silindi".
// Longest first; the ≥4-char stem guard also protects short English words
// ("code", "side") from the 2-letter suffixes.
const TR_SUFFIXES = [
 "ları",
 "leri",
 "ının",
 "inin",
 "unun",
 "ünün",
 "ında",
 "inde",
 "unda",
 "ünde",
 "mış",
 "miş",
 "muş",
 "müş",
 "lar",
 "ler",
 "ını",
 "ini",
 "unu",
 "ünü",
 "ına",
 "ine",
 "una",
 "üne",
 "dan",
 "den",
 "tan",
 "ten",
 "dır",
 "dir",
 "dur",
 "dür",
 "tır",
 "tir",
 "tur",
 "tür",
 "yor",
 "mak",
 "mek",
 "da",
 "de",
 "ta",
 "te",
 "dı",
 "di",
 "du",
 "dü",
 "tı",
 "ti",
 "tu",
 "tü",
 "ın",
 "in",
 "un",
 "ün",
 "sa",
 "se",
] as const;

function stemToken(token: string): string {
 const lower = token.toLocaleLowerCase();
 for (const suffix of TR_SUFFIXES) {
  if (lower.length >= 4 + suffix.length && lower.endsWith(suffix)) {
   return lower.slice(0, -suffix.length);
  }
 }
 if (lower.length > 6 && lower.endsWith("ing")) return lower.slice(0, -3);
 if (lower.length > 5 && lower.endsWith("ed")) return lower.slice(0, -2);
 if (lower.length > 5 && lower.endsWith("es")) return lower.slice(0, -2);
 if (lower.length > 4 && lower.endsWith("s")) return lower.slice(0, -1);
 return lower;
}

function semanticTokens(text: string): string[] {
 // Continuity labels are display metadata, not changes to a carried fact's polarity.
 // Apostrophes are unified before tokenization so curly typographic quotes
 // (Don\u{2019}t) cannot hide a negation the straight form would expose, and
 // negative contractions (don't, doesn't, can't...) expand to their polarity
 // token "not" before the word tokenizer can drop the apostrophe fragment.
 const normalized = text
  .normalize("NFKC")
  .replace(/[\u{2018}\u{2019}\u{02BC}`\u{00B4}]/gu, "'")
  .replace(/\bcannot\b/gi, "can not")
  .replace(/\b(\w+)n't\b/gi, "$1 not")
  .replace(/^\s*(?:Constraint|Goal|Decision):\s*/i, "");
 return (normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [])
  .map(stemToken)
  .filter((token) => token.length > 2 || NEGATION_MARKERS.has(token));
}

interface SemanticShape {
 sourceTokens: string[];
 concepts: string[];
 anchor: string;
 negative: boolean;
 conditional: boolean;
}

const semanticShapeCache = new Map<string, SemanticShape>();
const semanticFragmentCache = new Map<string, string[][]>();

function semanticFragments(text: string): string[][] {
 const cached = lruGet(semanticFragmentCache, text);
 if (cached) return cached;
 const fragments = Array.from(
  new Set(
   text
    .split(/\r?\n/)
    .flatMap((line) => [line, ...line.split(/[.;]/)])
    .map((part) => part.replace(/^\s*[-*\d.)]+\s*/, "").trim())
    .filter(Boolean),
  ),
 ).map(semanticTokens);
 lruSet(semanticFragmentCache, text, fragments, 256);
 return fragments;
}

function hasNearbyMarker(
 tokens: string[],
 anchor: string,
 markers: Set<string>,
): boolean {
 return tokens.some(
  (token, index) =>
   token === anchor &&
   tokens
    .slice(Math.max(0, index - 2), index + 3)
    .some((near) => markers.has(near)),
 );
}

function hasEffectiveTargetNegation(tokens: string[], anchor: string): boolean {
 return tokens.some((token, anchorIndex) => {
  if (token !== anchor) return false;
  const nearbyStart = Math.max(0, anchorIndex - 2);
  const nearbyNegations = tokens
   .slice(nearbyStart, anchorIndex + 3)
   .map((near, offset) =>
    NEGATION_MARKERS.has(near) && !(near === "without" && nearbyStart + offset > anchorIndex)
     ? nearbyStart + offset : -1,
   )
   .filter((index) => index >= 0);
  const governingStart = Math.max(0, anchorIndex - 3);
  const preceding = tokens.slice(governingStart, anchorIndex);
  const nearbyGuards = preceding
   .map((near, offset) =>
    POLARITY_INVERTING_GUARDS.has(near) ? governingStart + offset : -1,
   )
   .filter((index) => index >= 0);
  const governingIndex = preceding.findIndex(
   (near, offset) =>
    NEGATION_MARKERS.has(near) &&
    POLARITY_INVERTING_GUARDS.has(preceding[offset + 1] ?? ""),
  );
  if (governingIndex < 0)
   return nearbyNegations.length > 0 || nearbyGuards.length > 0;

  const absoluteGoverningIndex = governingStart + governingIndex;
  const guardIndex = absoluteGoverningIndex + 1;
  const nested = tokens
   .slice(guardIndex + 1, anchorIndex)
   .some(
    (inner) =>
     NEGATION_MARKERS.has(inner) || POLARITY_INVERTING_GUARDS.has(inner),
   );
  return (
   nested ||
   nearbyNegations.some(
    (index) => index !== absoluteGoverningIndex && index !== guardIndex,
   ) ||
   nearbyGuards.some((index) => index !== guardIndex)
  );
 });
}

/** Conservative deterministic semantic evidence for goals/constraints/decisions. */
function semanticShape(source: string): SemanticShape {
 const cached = lruGet(semanticShapeCache, source);
 if (cached) return cached;
 const sourceTokens = semanticTokens(source);
 const concepts = Array.from(
  new Set(
   sourceTokens.filter(
    (token) =>
     !/^\d+$/.test(token) &&
     !SEMANTIC_STOP.has(token) &&
     !NEGATION_MARKERS.has(token) &&
     !CONDITION_MARKERS.has(token),
   ),
  ),
 );
 const negative = sourceTokens.some((token) => NEGATION_MARKERS.has(token));
 const conditional = sourceTokens.some((token) => CONDITION_MARKERS.has(token));
 const anchor =
  concepts.find((concept) =>
   hasNearbyMarker(sourceTokens, concept, NEGATION_MARKERS),
  ) ??
  concepts[0] ??
  "";
 const shape = { sourceTokens, concepts, anchor, negative, conditional };
 lruSet(semanticShapeCache, source, shape, 512);
 return shape;
}

function hasSemanticEvidence(source: string, target: string): boolean {
 const { sourceTokens, concepts, anchor, negative, conditional } =
  semanticShape(source);
 if (!concepts.length) return true;
 const required = Math.min(
  concepts.length,
  Math.max(1, Math.ceil(concepts.length * 0.6)),
 );
 const verbatim = sourceTokens.join(" ");
 return semanticFragments(target).some((tokens) => {
  // A fragment that normalizes to the exact source token sequence is
  // faithful evidence by definition; anchor/negation heuristics must not
  // reject a verbatim rule. The separate contradiction scan still checks
  // every OTHER fragment beside the verbatim copy.
  if (tokens.join(" ") === verbatim) return true;
  const overlap = concepts.filter((concept) => tokens.includes(concept)).length;
  if (overlap < required) return false;
  const targetNegative = hasEffectiveTargetNegation(tokens, anchor);
  if (negative && !targetNegative) {
   // A conditional prohibition ("do not X without Y") may be faithfully
   // restated positively as "X only after/with Y".
   const conditionalRestatement =
    sourceTokens.includes("without") &&
    tokens.some((token) => CONDITION_MARKERS.has(token)) &&
    overlap >= Math.min(2, concepts.length);
   if (!conditionalRestatement) return false;
  }
  if (!negative && targetNegative) return false;
  if (
   conditional &&
   !negative &&
   !tokens.some((token) => CONDITION_MARKERS.has(token))
  )
   return false;
  return true;
 });
}

export function hasSemanticContradiction(
 source: string,
 target: string,
 exempt?: ReadonlySet<string>,
): boolean {
 // Do not apply a whole instruction's polarity to one of its own clauses.
 // Other target fragments remain checked, even beside a verbatim copy.
 // `exempt` holds fragments of required evidence lines that share the
 // source's sentence-level polarity: a summary cannot contradict evidence by
 // quoting evidence that agrees with it.
 const sourceFragments = new Set(semanticFragments(source).map(tokens => tokens.join(" ")));
 const { sourceTokens, concepts, anchor, negative, conditional } =
  semanticShape(source);
 if (!anchor) return false;
 const required = Math.min(
  concepts.length,
  Math.max(1, Math.ceil(concepts.length * 0.6)),
 );
 return semanticFragments(target).some((tokens) => {
  const key = tokens.join(" ");
  if (!tokens.includes(anchor) || sourceFragments.has(key) || exempt?.has(key)) return false;
  const overlap = concepts.filter((concept) => tokens.includes(concept)).length;
  // Sharing a generic anchor such as "release" or "file" is not enough:
  // another constraint in the same section must overlap the actual concepts.
  if (overlap < required) return false;
  const targetNegative = hasEffectiveTargetNegation(tokens, anchor);
  if (negative && !targetNegative) {
   const validConditional =
    sourceTokens.includes("without") &&
    tokens.some((token) => CONDITION_MARKERS.has(token)) &&
    overlap >= Math.min(2, concepts.length);
   return !validConditional;
  }
  if (!negative && targetNegative) return true;
  return (
   conditional &&
   !negative &&
   !tokens.some((token) => CONDITION_MARKERS.has(token))
  );
 });
}

/**
 * Deferral semantics: the constraint explicitly postpones an action
 * ("not yet", "until", "first") rather than banning it outright. A user who
 * set a deferral can release it with a terse later message.
 */
const TEMPORAL_CONSTRAINT_RE =
 /\b(?:yet|until|before|first|for now|hold off|wait|henüz|şimdilik|önce)\b/iu;

/**
 * Questions, criticism, and quotations are not permissions. A user asking
 * "Why did you deploy?" is questioning a rule, not releasing it; ambiguity
 * keeps the rule. Only explicit statements and imperatives can release.
 */
const WH_QUESTION_LEAD_RE =
 /^(?:why|what|how|when|where|who|whom|which|whose|neden|ni\u00e7in|niye|nas\u0131l|hangi|kim)\b/iu;
const AUX_QUESTION_LEAD_RE =
 /^(?:do|does|did|can|could|should|would|will|has|have|had|is|are|was|were|am)\b/i;
const QUESTION_SUBJECT_RE =
 /^(?:you|u|i|we|it|they|he|she|this|that|these|those|there)\b/i;

function looksLikeQuestion(text: string): boolean {
 return text.split(/\r?\n/).some((line) => {
  const trimmed = line.trim();
  if (trimmed.endsWith("?")) return true;
  if (WH_QUESTION_LEAD_RE.test(trimmed)) return true;
  // Auxiliary inversion ("Did you deploy?") asks; an emphatic imperative
  // ("Do deploy now.") commands. The auxiliary must be followed by a
  // subject for the line to be a question.
  const rest = trimmed.replace(AUX_QUESTION_LEAD_RE, "").trim();
  return AUX_QUESTION_LEAD_RE.test(trimmed) && QUESTION_SUBJECT_RE.test(rest);
 });
}

/** Directed positive evidence of intent, not permission vocabulary
 * anywhere in the text: a first-person grant ("I approve", "we've allowed")
 * tied to the actor. Go-ahead leads and anchor-led imperative clauses are
 * covered by addressee-modal/policy predicates in positiveImperativeEvidence.
 * Free-floating
 * words like "actually" or "can" in reports ("The code can deploy…") are
 * deliberately NOT grants. */
const FIRST_PERSON_GRANT_RE =
 /\b(?:i|we)(?:'ve|\s+have)?\s+(?:approv\w+|allow\w+|permitt?\w*|ok(?:ay(?:ed)?)?|confirm\w+|green[- ]?light\w*|sanction\w*)\b/iu;

/** Attributed third-party text (quotes of logs, output, other tools) is a
 * report, not the user granting anything. Self-reference ("as I said") is
 * deliberately not listed. */
const QUOTATION_RE =
 /\b(?:the log|logs?\b|the (?:output|console|error|diff|dashboard)|according to|it says|it said|they said|reported that|quoted?)\b/iu;

/** A denial of permission is the opposite of a grant: "Permission was
 * denied", "I did not ask you to" — even when the constrained action and
 * its opposite polarity appear verbatim. */
const DENIAL_RE =
 /\b(?:denied|deny|refus\w*|forbid\w*|retract\w+|did not ask|didn't ask|never asked|never said|not allowed|not permitted|no permission|without permission|wasn't asked|weren't asked)\b/iu;

/**
 * Criticism, demands for explanation, and quotations are not permissions:
 * "Explain why you deployed." names the constrained action but questions the
 * rule instead of lifting it.
 */
const CRITICISM_RE =
 /\b(?:why|how come|explain(?:ing|ed)?|tell me|show me|describe|justify|what were you|supposed to|weren't you|shouldn't you|neden|ni\u00e7in|niye|a\u00e7\u0131kla|anlat|nas\u0131l)\b/iu;

/**
 * A terse release needs positive go-ahead evidence: an acknowledgement or
 * permission lead ("ok push it now", "you can…"), or the constrained action
 * led as a real directive ("deploy it now"). Softeners like "now" or
 * "actually" alone are not evidence — "Now you deployed…" is a report.
 */
/** Acknowledgements and softeners stripped (bounded) before directive
 * analysis: they set tone, not permission — "OK, you deployed…" is still a
 * report, while "OK, deploy it now" carries a real directive in the
 * remainder. Bare copula/permission leads ("you are", "you can") are NOT
 * strippable and NOT evidence alone; they must participate in a grant
 * predicate or addressee-modal form. */
const ACK_STRIP_RE =
 /^(?:ok(?:ay)?|okey|yes|yep|sure|alright|right|now|actually|please|just|go ahead|go for it|proceed|do it|ship it|approved?|alright then|tamam|olur|onay(?:l\u0131yorum|lanm\u0131\u015ft\u0131r| ver)?|devam(?:\s+et)?|ba\u015fla)[,;:.!\s]+/i;

/** Copula/adjective policy grants ("are allowed", "is permitted", "no longer
 * required", "can be"). */
const POLICY_GRANT_PREDICATE_RE =
 /\b(?:are|is|was|were|be|been|remain(?:s|ed)?)\s+(?:now\s+|hereby\s+|officially\s+)?(?:allowed|permitted|approved|authorized|acceptable|optional|fine|okay|ok|enabled|lifted)|\bno longer\s+(?:required|needed|banned|prohibited|forbidden|necessary)|\bcan\s+be\b|\bmay\s+be\b/i;

/** Addressee-modal grants: the actor is told they can/may act ("you can
 * deploy", "we may push") — third-party reports ("the code can deploy") do
 * not authorize anyone. */
function addresseeModalGrant(anchor: string): RegExp {
 return new RegExp(
  "\\b(?:you|y'?all|we|i)\\s+(?:can|could|may|might)\\s+(?:now\\s+|also\\s+|please\\s+|just\\s+)*(?:[\\p{L}]+\\s+){0,2}" +
   anchor.replace(/[^\p{L}\p{N}_-]/gu, "\\$&") +
   "\\b",
  "iu",
 );
}

/** Emphatic/softening leads whose NEXT word may be the commanded anchor
 * ("Do deploy now.", "Please push it"). */
const IMPERATIVE_LEAD_TOKENS = new Set([
 "do",
 "does",
 "did",
 "please",
 "now",
 "just",
 "go",
]);

/** Directive complements: an anchor-led clause is a command only when the
 * action takes a direct object or adverbial right after it ("deploy it",
 * "push this", "push the branch", "ship now"). Anchor-led noun statements
 * ("New dependencies were added…") are reports. Determiners are complements
 * only for deferral releases; see positiveImperativeEvidence. */
const DIRECTIVE_COMPLEMENTS = new Set([
 "it",
 "them",
 "this",
 "that",
 "these",
 "those",
 "everything",
 "now",
 "again",
 "please",
 "immediately",
 "today",
 "tonight",
 "away",
 "ahead",
 "the",
 "a",
 "an",
 "our",
 "your",
 "my",
 "his",
 "her",
 "their",
]);

/** Directive complements checked on the RAW next word: two-letter objects
 * like "it" are filtered out of semantic tokens, so "deploy it" would
 * otherwise lose its complement. */
function anchorFollowedByComplement(
 clause: string,
 anchor: string,
): boolean {
 const words = clause
  .split(/\s+/)
  .map((word) => word.replace(/(^\W+|\W+$)/g, "").toLowerCase())
  .filter(Boolean);
 for (let i = 0; i < words.length; i++) {
  if (stemToken(words[i]) !== anchor) continue;
  const next = words[i + 1];
  return next !== undefined && DIRECTIVE_COMPLEMENTS.has(stemToken(next));
 }
 return false;
}

/** Clause-level positive command/grant of the anchor. Acknowledgements and
 * softeners are stripped first — they are never evidence by themselves —
 * and the remainder must carry a real directive or grant: an
 * auxiliary+anchor imperative ("Do deploy now."), an anchor-led command
 * with a directive complement ("deploy it", "push the branch"), a policy
 * predicate ("are allowed now"), or an addressee-modal grant ("you can
 * deploy"). Imperative complements count only for deferral releases; a
 * standing rule releases on explicit grants alone. Reports, quotes,
 * denials, and criticism are excluded before this runs. */
function positiveImperativeEvidence(
 release: string,
 anchor: string,
 allowImperative: boolean,
): boolean {
 let rest = release.trim();
 for (
  let round = 0;
  round < 3 && ACK_STRIP_RE.test(rest);
  round++
 )
  rest = rest.replace(ACK_STRIP_RE, "").trim();
 const modalGrant = addresseeModalGrant(anchor);
 const clauses = rest
  .split(/\r?\n|[.;]/)
  .flatMap((fragment) =>
   fragment.split(/\s(?:[\u2014\u2013]|-)\s|,\s|;\s|:\s/),
  )
  .map((clause) => clause.trim())
  .filter(Boolean);
 return clauses.some((clause) => {
  const tokens = semanticTokens(clause);
  if (
   !tokens.includes(anchor) ||
   hasEffectiveTargetNegation(tokens, anchor)
  )
   return false;
  // Softener/auxiliary + anchor ("Do deploy now.", "Please push it").
  if (
   allowImperative &&
   IMPERATIVE_LEAD_TOKENS.has(tokens[0] ?? "") &&
   tokens[1] === anchor
  )
   return true;
  // Explicit policy-grant predicate ("are allowed now", "no longer
  // required") or addressee-modal grant ("you can deploy").
  if (POLICY_GRANT_PREDICATE_RE.test(clause)) return true;
  if (modalGrant.test(clause)) return true;
  // Anchor-led command with a directive complement right after the action.
  if (
   allowImperative &&
   tokens[0] === anchor &&
   anchorFollowedByComplement(clause, anchor)
  )
   return true;
  return false;
 });
}

/**
 * True when `release` (a later user message) frees `constraint`.
 *
 * Two safe paths: a rich release trips the full contradiction check, and a
 * terse release ("ok push it now") flips the polarity of the constrained
 * action — but only for deferral constraints, only with positive go-ahead
 * evidence, and never for questions or criticism. Standing rules ("never
 * commit directly to main") keep the strict check: a terse imperative
 * sharing one verb must not silently drop a live rule the summary is still
 * checked against.
 */
export function releasesConstraint(constraint: string, release: string): boolean {
 if (looksLikeQuestion(release)) return false;
 if (CRITICISM_RE.test(release)) return false;
 if (QUOTATION_RE.test(release)) return false;
 if (DENIAL_RE.test(release)) return false;
 const { anchor, negative } = semanticShape(constraint);
 const deferral = TEMPORAL_CONSTRAINT_RE.test(constraint);
 if (hasSemanticContradiction(constraint, release)) {
  // The polarity flip must itself be a directed grant or command — a
  // policy predicate, an addressee-modal grant, a first-person grant, or
  // (for deferrals) a real imperative — never the opposite polarity merely
  // restated in a report, quote, or complaint. Standing rules release on
  // explicit grants alone.
  return (
   FIRST_PERSON_GRANT_RE.test(release) ||
   (Boolean(anchor) &&
    positiveImperativeEvidence(release, anchor, deferral))
  );
 }
 if (!deferral) return false;
 if (!anchor || !negative) return false;
 // One grammar for both paths: after acknowledgement stripping, a real
 // directive or grant in the remainder.
 return positiveImperativeEvidence(release, anchor, true);
}

export function isDeterministicallyPatchable(gap: VerificationGap): boolean {
 if (gap.kind === "fabricated-file") return true;
 if (gap.kind === "inconsistency")
  return gap.detail.startsWith("blocked-none:");
 return true;
}

/** Apply safe repairs to a fixed point; newly introduced patchable gaps get another bounded pass. */
export function repairSummaryDeterministically(
 summary: string,
 result: VerificationResult,
 extraction: StructuredExtraction,
 continuity: CompactionState | null = null,
 evidence: VerificationEvidence = {},
 maxRounds = 3,
): { summary: string; result: VerificationResult; patched: VerificationGap[] } {
 const patched: VerificationGap[] = [];
 const seen = new Set<string>();
 for (let round = 0; round < maxRounds; round++) {
  const patchable = result.gaps.filter(isDeterministicallyPatchable);
  if (!patchable.length) break;
  const next = patchDeterministic(
   summary,
   patchable,
   extraction,
   continuity,
   evidence,
  );
  if (next === summary) break;
  for (const gap of patchable) {
   const key = formatVerificationGap(gap);
   if (!seen.has(key)) {
    seen.add(key);
    patched.push(gap);
   }
  }
  summary = next;
  result = verifySummary(summary, extraction, continuity, evidence);
 }
 return { summary, result, patched };
}

interface VerificationAccumulator {
 gaps: VerificationGap[];
 score: number;
}

interface CollectedVerificationEvidence {
 unresolved: Array<{ message: string }>;
 resolved: Array<{ message: string }>;
 constraints: Array<{ text: string }>;
 decisions: Array<{ summary: string; answer: string | null }>;
 goal: string | null;
}

interface PathVerificationData {
 modified: string[];
 read: string[];
 deleted: string[];
 rendered: ReadonlyMap<string, string>;
}

/**
 * The question and its answer are one unit: the answer counts as verified
 * only on a line whose own question it restates. Section-global answer
 * presence would let swapped answers between two decisions verify 100/100.
 * Ownership is decided by exact structured identity first (the longest
 * question key contained in the line's question slot), then fuzzy overlap —
 * sibling questions share scaffolding like "which … use", so only exact
 * identity or the discriminating concepts can break ties.
 */
function questionOverlapOnLine(question: string, line: string): number {
 const { concepts } = semanticShape(question);
 if (!concepts.length) return 0;
 const required = Math.min(
  concepts.length,
  Math.max(1, Math.ceil(concepts.length * 0.6)),
 );
 const tokens = semanticTokens(line);
 const overlap = concepts.filter((concept) => tokens.includes(concept)).length;
 return overlap >= required ? overlap : 0;
}

function exactQuestionOwner(
 head: string,
 questions: readonly string[],
): string | null {
 const headKey = normalizeFactKey(head);
 if (!headKey) return null;
 let owner: string | null = null;
 let ownerLength = -1;
 for (const question of questions) {
  const key = normalizeFactKey(question);
  if (key && headKey.includes(key) && key.length > ownerLength) {
   owner = question;
   ownerLength = key.length;
  }
 }
 return owner;
}

function lineBelongsToQuestion(
 question: string,
 head: string,
 questions: readonly string[],
): boolean {
 if (exactQuestionOwner(head, questions) === question) return true;
 const own = questionOverlapOnLine(question, head);
 if (!own) return false;
 return questions.every(
  (other) =>
   other === question || questionOverlapOnLine(other, head) < own,
 );
}

/** Boundary-guarded containment: "No" must not match "now", "Go" not "Golang". */
function containsAnswerText(haystack: string, answer: string): boolean {
 const needle = answer.trim().toLowerCase();
 if (!needle) return false;
 const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
 return new RegExp(
  "(?<![\\p{L}\\p{N}])" + escaped + "(?![\\p{L}\\p{N}])",
  "iu",
 ).test(haystack);
}

/**
 * An answer verifies a line through exact structured identity first, then
 * fuzzy semantic evidence. Short or symbolic answers ("Go", "C++", "4")
 * have no semantic concepts, and an empty concept set vacuously matches
 * anything — so containment, not overlap, is the primary contract.
 */
function lineCarriesAnswer(haystack: string, answer: string): boolean {
 if (containsAnswerText(haystack, answer)) return true;
 // Fuzzy evidence only when the answer has concepts: a concept-less
 // answer ("4", "C++") would vacuously match any fragment.
 const { concepts } = semanticShape(answer);
 return concepts.length > 0 && hasSemanticEvidence(answer, haystack);
}

/** Question+answer slot boundary of one decision line, bound to the KNOWN
 * question: the arrow whose left side owns that question — exact key
 * identity preferred over fuzzy overlap, because a partial head before an
 * arrow that lives inside the question or the answer can fuzzy-match. All
 * decision consumers (question coverage, answer presence, answer conflict)
 * share this one parser so the same line can never be re-split differently
 * by one of them. */
interface DecisionLineSlots {
 head: string;
 tail: string;
}

function decisionLineSlots(
 line: string,
 question: string,
 questions: readonly string[],
): DecisionLineSlots | null {
 let fuzzy: DecisionLineSlots | null = null;
 for (
  let index = line.indexOf("\u2192");
  index >= 0;
  index = line.indexOf("\u2192", index + 1)
 ) {
  const candidateHead = line
   .slice(0, index)
   .replace(/\*+/g, "")
   .trim();
  const tail = line.slice(index + 1).replace(/\*+/g, "").trim();
  if (!candidateHead || !tail) continue;
  if (exactQuestionOwner(candidateHead, questions) === question) {
   return { head: candidateHead, tail };
  }
  if (
   !fuzzy &&
   lineBelongsToQuestion(question, candidateHead, questions)
  ) {
   fuzzy = { head: candidateHead, tail };
  }
 }
 return fuzzy;
}

/** Body-level answer-slot stripping for the question coverage scan: cut
 * each line at the first arrow whose head owns any collected question
 * (exact owner first, fuzzy owner as fallback), leaving paraphrased lines
 * uncut when no head owns them. */
function stripDecisionAnswerTails(
 decisionBody: string,
 questions: readonly string[],
): string {
 return decisionBody
  .split(/\r?\n/)
  .map((line) => {
   let fuzzyCut = -1;
   for (
    let index = line.indexOf("\u2192");
    index >= 0;
    index = line.indexOf("\u2192", index + 1)
   ) {
    const candidateHead = line
     .slice(0, index)
     .replace(/\*+/g, "")
     .trim();
    if (!candidateHead) continue;
    if (exactQuestionOwner(candidateHead, questions) !== null) {
     return line.slice(0, index);
    }
    if (
     fuzzyCut < 0 &&
     questions.some((question) =>
      lineBelongsToQuestion(question, candidateHead, questions),
     )
    ) {
     fuzzyCut = index;
    }
   }
   return fuzzyCut >= 0 ? line.slice(0, fuzzyCut) : line;
  })
  .join("\n");
}

function decisionAnswerPresent(
 question: string,
 answer: string,
 decisionBody: string,
 questions: readonly string[],
): boolean {
 return decisionBody.split(/\r?\n/).some((rawLine) => {
  const line = rawLine.replace(/^\s*(?:[-*+]\s+)?/, "").trim();
  return (
   decisionLineSlots(line, question, questions) !== null &&
   lineCarriesAnswer(line, answer)
  );
 });
}

/**
 * A decision line owned by the question but whose arrow slot carries a
 * DIFFERENT answer ("Q → MongoDB" while the active answer is PostgreSQL) is
 * an unresolved conflict, not extra evidence. Presence checks alone would
 * let deterministic repair append the right answer beside the wrong one and
 * pass. The gap this produces is deliberately unpatchable: removing the
 * wrong line needs an edit, not an append.
 */
function decisionAnswerConflict(
 question: string,
 answer: string,
 decisionBody: string,
 questions: readonly string[],
): boolean {
 for (const rawLine of decisionBody.split(/\r?\n/)) {
  const line = rawLine.replace(/^\s*(?:[-*+]\s+)?/, "").trim();
  const slots = decisionLineSlots(line, question, questions);
  if (!slots || !slots.tail) continue;
  // A tail that restates the question is a label form, not an answer slot.
  if (hasSemanticEvidence(question, slots.tail)) continue;
  if (lineCarriesAnswer(slots.tail, answer)) continue;
  return true;
 }
 return false;
}

function addGap(
 accumulator: VerificationAccumulator,
 gap: VerificationGap,
 penalty: number,
): void {
 accumulator.gaps.push(gap);
 accumulator.score -= penalty;
}

function uniqueByText<T>(items: T[], text: (item: T) => string): T[] {
 const seen = new Set<string>();
 return items.filter((item) => {
  const key = text(item).toLowerCase().replace(/\s+/g, " ").trim();
  if (!key || seen.has(key)) return false;
  seen.add(key);
  return true;
 });
}

function collectVerificationEvidence(
 extraction: StructuredExtraction,
 continuity: CompactionState | null,
 evidence: VerificationEvidence,
): CollectedVerificationEvidence {
 const unresolved = uniqueByText(
  [
   ...extraction.errors.flatMap((error) =>
    !error.resolved ? [{ message: error.message }] : [],
   ),
   ...(continuity?.unresolvedErrors ?? []).map((error) => ({
    message: error.message,
   })),
  ],
  (item) => item.message,
 );
 const resolved = uniqueByText(
  [
   ...extraction.errors.flatMap((error) =>
    error.resolved ? [{ message: error.message }] : [],
   ),
   ...(continuity?.resolvedErrors ?? []).map((error) => ({
    message: error.message,
   })),
  ],
  (item) => item.message,
 ).slice(-5);
 const steeringConstraints: Array<{ text: string }> = [];
 if (evidence.steering?.focus?.trim()) {
  steeringConstraints.push({
   text: "Preserve detail about: " + evidence.steering.focus,
  });
 }
 if (evidence.steering?.note?.trim()) {
  steeringConstraints.push({ text: evidence.steering.note });
 }
 // A constraint the user has since released is not evidence the summary must
 // match: state legitimately changes mid-session, and re-mining it from an
 // embedded prior summary would otherwise contradict the correct new state.
 const retired = new Set(
  [...(continuity?.factOverrides ?? []), ...(evidence.factOverrides ?? [])]
   .filter((item) => item.kind === "constraint" && item.status !== "active")
   .map((item) => item.summaryKey),
 );
 const constraints = uniqueByText(
  [
   ...extraction.constraints.flatMap((item) =>
    item.confidence >= 0.8 ? [{ text: item.text }] : [],
   ),
   ...(continuity?.constraints ?? []).flatMap((item) =>
    item.confidence >= 0.8 ? [{ text: item.text }] : [],
   ),
   ...steeringConstraints,
  ],
  (item) => item.text,
 ).filter(
  (item) =>
   !isNonLiveConstraintText(item.text) &&
   !retired.has(normalizeFactKey(item.text)),
 );
 // Decision evidence is the whole question→answer unit, not the bare
 // question. The shared collapse keeps one active answer per question
 // (latest non-empty wins) across fallback rendering, state merge, and this
 // verification — keying on the answer itself would keep both conflicting
 // answers live.
 const decisionEntries: Array<{ summary: string; userResponse?: string }> = [
  ...(continuity?.decisions ?? []),
  ...extraction.decisions,
 ].flatMap((item) =>
  item.type === "explicit"
   ? [{ summary: item.summary, userResponse: item.userResponse }]
   : [],
 );
 const decisions: Array<{ summary: string; answer: string | null }> =
  collapseDecisionsByQuestion(decisionEntries).map((item) => ({
   summary: item.summary,
   answer: item.userResponse?.trim() || null,
  }));
 return {
  unresolved,
  resolved,
  constraints,
  decisions,
  goal: extraction.mainGoal ?? continuity?.goal ?? null,
 };
}

function verifyRequiredSections(
 parsed: CanonicalSummary,
 accumulator: VerificationAccumulator,
): void {
 const required = [
  { kind: "goal", penalty: 5 },
  { kind: "progress", penalty: 5 },
  { kind: "critical-context", penalty: 3 },
 ] as const;
 for (const item of required) {
  if (!findSection(parsed, item.kind)) {
   addGap(
    accumulator,
    { kind: "missing-section", section: item.kind },
    item.penalty,
   );
  }
 }
}

function verifyPathCoverage(
 parsed: CanonicalSummary,
 extraction: StructuredExtraction,
 continuity: CompactionState | null,
 evidence: VerificationEvidence,
 accumulator: VerificationAccumulator,
): PathVerificationData {
 const modified = extraction.modifiedFiles.map((file) => file.path);
 const read = extraction.readFiles;
 const deleted = Array.from(
  new Set([...extraction.deletedFiles, ...(continuity?.deletedFiles ?? [])]),
 );
 const required = [...modified, ...read, ...deleted];
 const expected = new Set(required);
 const rendered = buildSummaryPathEvidence(
  required,
  evidence.summaryBudgetTokens,
 );
 const ownerSets = new Map<string, Set<string>>();
 for (const file of required) {
  const display = rendered.get(file);
  for (const candidate of [
   file,
   ...(display ? [decodePathDisplay(display)] : []),
  ]) {
   const normalized = normalizePath(candidate);
   const owners = ownerSets.get(normalized) ?? new Set<string>();
   owners.add(file);
   ownerSets.set(normalized, owners);
  }
 }
 const ownerCounts = new Map(
  Array.from(ownerSets, ([file, owners]) => [file, owners.size]),
 );
 const listed = (
  kind: "files-modified" | "files-read" | "files-deleted",
 ): ListedPathEvidence =>
  collectListedPaths(findSection(parsed, kind)?.body ?? "", expected);
 const modifiedListed = listed("files-modified");
 const readListed = listed("files-read");
 const deletedListed = listed("files-deleted");
 for (const file of modified) {
  const display = rendered.get(file);
  if (display && !hasListedPath(modifiedListed, file, display, ownerCounts)) {
   addGap(accumulator, { kind: "missing-file", path: file }, 5);
  }
 }
 for (const file of read) {
  const display = rendered.get(file);
  if (display && !hasListedPath(readListed, file, display, ownerCounts)) {
   addGap(accumulator, { kind: "missing-read-file", path: file }, 5);
  }
 }
 for (const file of deleted) {
  const display = rendered.get(file);
  if (display && !hasListedPath(deletedListed, file, display, ownerCounts)) {
   addGap(accumulator, { kind: "missing-deleted-file", path: file }, 5);
  }
 }
 return { modified, read, deleted, rendered };
}

function verifyErrorEvidence(
 normalizedSummary: string,
 collected: CollectedVerificationEvidence,
 accumulator: VerificationAccumulator,
): void {
 for (const error of collected.unresolved) {
  const snippet = summaryEvidenceLine(error.message, TRUNC.ERROR_SNIPPET)
   .toLowerCase()
   .replace(/\\/g, "/");
  if (snippet.length > 5 && !normalizedSummary.includes(snippet)) {
   addGap(accumulator, { kind: "missing-error", message: error.message }, 5);
  }
 }
 for (const error of collected.resolved) {
  const snippet = summaryEvidenceLine(error.message, TRUNC.ERROR_SNIPPET)
   .toLowerCase()
   .replace(/\\/g, "/");
  if (snippet.length > 5 && !normalizedSummary.includes(snippet)) {
   addGap(
    accumulator,
    { kind: "missing-error", message: error.message, resolved: true },
    2,
   );
  }
 }
}

/** Lengths the deterministic renderers cut evidence lines to before they reach a summary. */
const EVIDENCE_RENDER_LIMITS = [
 TRUNC.CONSTRAINT_TEXT, TRUNC.MESSAGE, TRUNC.PREVIEW_MID, TRUNC.PREVIEW,
 TRUNC.DECISION_SUMMARY, TRUNC.USER_RESPONSE, TRUNC.DETAIL, TRUNC.TOPIC_LABEL,
];

/**
 * Fragment keys of the evidence lines the verifier itself requires the summary
 * to carry, split by sentence-level polarity.
 *
 * The contradiction scan judges a target fragment by negation near the anchor
 * token, which cannot see sentence scope: "Continue to avoid commits,
 * installation, or live daemon restart ... (...; `agm restart` deliberately
 * deferred)" reads as a positive "restart" both as a whole line (the
 * coordinated list puts "avoid" six tokens away) and as a split clause,
 * beside "avoid live daemon restart". Both are required lines and the
 * deterministic floor is built from exactly these lines, so scoring the
 * artifact rejected every candidate and left a session uncompacted at 99%
 * context. `semanticShape` already decides a source's polarity at sentence
 * level; evidence lines get the same judgment, so two required lines of the
 * same polarity are not scored against each other.
 *
 * Two required lines of opposite polarity ("Do not publish stable" beside
 * "Must publish stable now") remain a gap, and summary-authored text that
 * contradicts evidence is never exempt.
 */
function requiredEvidenceKeysByPolarity(
 collected: CollectedVerificationEvidence,
 continuity: CompactionState | null,
): { negative: Set<string>; positive: Set<string> } {
 const texts = [
  ...collected.constraints.map((item) => item.text),
  ...collected.decisions.flatMap((item) =>
   item.answer ? [item.summary, item.answer] : [item.summary],
  ),
  ...collected.unresolved.map((item) => item.message),
  ...collected.resolved.map((item) => item.message),
  ...(collected.goal ? [collected.goal] : []),
  ...(continuity?.criticalContext ?? []),
 ];
 const keys = { negative: new Set<string>(), positive: new Set<string>() };
 for (const text of texts) {
  const bucket = semanticShape(text).negative ? keys.negative : keys.positive;
  const variants = [text, ...EVIDENCE_RENDER_LIMITS.map((max) => summaryEvidenceLine(text, max))];
  for (const variant of variants) {
   for (const tokens of semanticFragments(variant)) bucket.add(tokens.join(" "));
  }
 }
 return keys;
}

function verifySemanticCoverage(
 parsed: CanonicalSummary,
 collected: CollectedVerificationEvidence,
 continuity: CompactionState | null,
 accumulator: VerificationAccumulator,
): void {
 const evidenceKeys = requiredEvidenceKeysByPolarity(collected, continuity);
 const exemptFor = (source: string) =>
  semanticShape(source).negative ? evidenceKeys.negative : evidenceKeys.positive;
 const constraintTarget = [
  findSection(parsed, "constraints")?.body ?? "",
  findSection(parsed, "critical-context")?.body ?? "",
 ].join("\n");
 for (const constraint of collected.constraints) {
  if (!hasSemanticEvidence(constraint.text, constraintTarget)) {
   addGap(accumulator, { kind: "missing-constraint", text: constraint.text }, 8);
  }
  if (hasSemanticContradiction(constraint.text, constraintTarget, exemptFor(constraint.text))) {
   addGap(accumulator, {
    kind: "inconsistency",
    detail: "semantic-contradiction: constraint contradicts "
     + constraint.text.slice(0, TRUNC.SNIPPET),
   }, 20);
  }
 }
 if (collected.goal) {
  const goalTarget = findSection(parsed, "goal")?.body ?? "";
  if (!hasSemanticEvidence(collected.goal, goalTarget)) {
   addGap(accumulator, { kind: "missing-goal", goal: collected.goal }, 12);
  }
  if (hasSemanticContradiction(collected.goal, goalTarget, exemptFor(collected.goal))) {
   addGap(accumulator, {
    kind: "inconsistency",
    detail: "semantic-contradiction: goal polarity or condition changed",
   }, 20);
  }
 }
 const decisionBody = findSection(parsed, "decisions")?.body ?? "";
 const questions = collected.decisions.map((decision) => decision.summary);
 // The answer slot is not part of the question: an answer like "No" — or
 // "No → wait for approval" — must not read as question-level text in the
 // coverage and contradiction scans.
 const decisionQuestionBody = stripDecisionAnswerTails(
  decisionBody,
  questions,
 );
 for (const decision of collected.decisions) {
  // The question and the answer are separate evidence requirements: a
  // single composite would let the question's concept overlap satisfy the
  // check while a wrong or missing answer rides along unverified.
  const questionVerified = hasSemanticEvidence(
   decision.summary,
   decisionQuestionBody,
  );
  const answerVerified =
   !decision.answer ||
   decisionAnswerPresent(
    decision.summary,
    decision.answer,
    decisionBody,
    questions,
   );
  if (!questionVerified || !answerVerified) {
   addGap(
    accumulator,
    {
     kind: "missing-decision",
     summary: decision.summary,
     // Structured, already-bounded fields: a display composite would have
     // to be re-split on arrows, which breaks when the question or the
     // answer itself contains " → ".
     ...(decision.answer ? { answer: decision.answer } : {}),
    },
    8,
   );
  }
  if (
   decision.answer &&
   decisionAnswerConflict(
    decision.summary,
    decision.answer,
    decisionBody,
    questions,
   )
  ) {
   addGap(
    accumulator,
    {
     kind: "inconsistency",
     detail:
      "decision-answer-conflict: summary carries a different active answer for " +
      decision.summary.slice(0, TRUNC.SNIPPET),
    },
    20,
   );
  }
  if (hasSemanticContradiction(decision.summary, decisionQuestionBody, exemptFor(decision.summary))) {
   addGap(accumulator, {
    kind: "inconsistency",
    detail: "semantic-contradiction: decision contradicts "
     + decision.summary.slice(0, TRUNC.SNIPPET),
   }, 20);
  }
 }
}

function verifyFileReferences(
 summary: string,
 extraction: StructuredExtraction,
 continuity: CompactionState | null,
 evidence: VerificationEvidence,
 collected: CollectedVerificationEvidence,
 paths: PathVerificationData,
 accumulator: VerificationAccumulator,
): void {
 const groundedEvidence = [
  ...collected.unresolved.map((item) => item.message),
  ...collected.resolved.map((item) => item.message),
  ...collected.constraints.map((item) => item.text),
  ...collected.decisions.map((item) =>
   item.answer ? item.summary + " \u2192 " + item.answer : item.summary,
  ),
  ...(collected.goal ? [collected.goal] : []),
  ...extraction.lastUserMessages,
  ...extraction.timeline.map((item) => item.summary),
  ...extraction.topics.map((item) => item.primaryFile ?? ""),
  ...(continuity?.openLoops.map((item) => item.summary) ?? []),
  ...(continuity?.criticalContext ?? []),
 ];
 const groundedFiles = groundedEvidence
  .flatMap((value) => [
   value,
   summaryEvidenceLine(value, TRUNC.ERROR_SNIPPET),
   summaryEvidenceLine(value, TRUNC.TOPIC_LABEL),
   summaryEvidenceLine(value, TRUNC.PREVIEW),
   summaryEvidenceLine(value, TRUNC.MESSAGE),
  ])
  .flatMap(extractFileRefs);
 const renderedPaths = Array.from(paths.rendered.values()).flatMap((line) => [
  decodePathDisplay(line),
  line.startsWith('"') && line.endsWith('"') ? line.slice(1, -1) : line,
 ]);
 const knownFiles = Array.from(new Set([
  ...paths.modified,
  ...paths.read,
  ...paths.deleted,
  ...(extraction.referencedFiles ?? []),
  ...groundedFiles,
  ...renderedPaths,
  ...renderedPaths.flatMap(extractFileRefs),
  ...(continuity?.modifiedFiles ?? []),
  ...(continuity?.readFiles ?? []),
  ...(continuity?.unresolvedErrors ?? []).flatMap((error) => error.files),
  ...(continuity?.openLoops ?? []).flatMap((loop) => loop.files),
 ]));
 const knownFileIndex = buildKnownPathReferenceIndex(knownFiles);
 for (const ref of new Set(extractFileRefs(summary))) {
  const grounded = isKnownPathReferenceInIndex(ref, knownFileIndex)
   || Boolean(evidence.sourceMessages
    && sourceSupportsFileReference(ref, evidence.sourceMessages));
  if (!grounded) addGap(accumulator, { kind: "fabricated-file", ref }, 4);
 }
}

function verifyProgressConsistency(
 parsed: CanonicalSummary,
 extraction: StructuredExtraction,
 collected: CollectedVerificationEvidence,
 paths: PathVerificationData,
 accumulator: VerificationAccumulator,
): void {
 const progress = findSection(parsed, "progress");
 if (!progress) return;
 const done = progress.body.match(/###\s*Done[\s\S]*?(?=###|$)/i)?.[0] ?? "";
 const blocked = progress.body.match(/###\s*Blocked[\s\S]*?(?=###|$)/i)?.[0] ?? "";
 if (collected.unresolved.length > 0
  && noneBlockerLineIndexes(blocked.split(/\r?\n/).slice(1)).size > 0) {
  addGap(accumulator, {
   kind: "inconsistency",
   detail: "blocked-none: Blocked says none despite unresolved errors",
  }, 12);
 }
 const doneRefs = new Set(extractFileRefs(done).map(normalizePath));
 const modifiedPathOwners = buildPathNeedleOwnershipIndex(paths.modified);
 for (const file of extraction.modifiedFiles) {
  const needles = buildUniquePathNeedlesFromIndex(file.path, modifiedPathOwners);
  // Indexed needles are already normalized, as are the extracted Done refs.
  if (!needles.some((needle) => doneRefs.has(needle))) continue;
  const unresolved = collected.unresolved.find((error) => {
   const firstLine = error.message.split(/\r?\n/, 1)[0] ?? "";
   const refs = extractFileRefs(firstLine).map(normalizePath);
   return needles.some((needle) => refs.includes(normalizePath(needle)));
  });
  if (unresolved) {
   addGap(accumulator, {
    kind: "inconsistency",
    detail: file.path + " marked Done but has unresolved error",
   }, 5);
  }
 }
}

function verifyOpenLoopsAndClaims(
 summary: string,
 parsed: CanonicalSummary,
 paths: PathVerificationData,
 extraction: StructuredExtraction,
 continuity: CompactionState | null,
 evidence: VerificationEvidence,
 collected: CollectedVerificationEvidence,
 accumulator: VerificationAccumulator,
): void {
 const unresolvedCount = collected.unresolved.length
  + (continuity?.openLoops.filter((loop) => loop.status !== "resolved").length ?? 0);
 if (unresolvedCount >= 1
  && !findSection(parsed, "open-loops")
  && !summary.toLowerCase().replace(/\\/g, "/").includes("unresolved")) {
  addGap(accumulator, { kind: "missing-open-loops", unresolvedCount }, 5);
 }
 if (!evidence.sourceMessages) return;
 const tools = successfulToolEvidence(evidence.sourceMessages);
 const evidenceCorpus = requiredEvidenceCorpus(collected, continuity);
 for (const claim of outcomeClaims(summary, paths.rendered, evidenceCorpus)) {
  if (!successfulToolSupportsClaim(claim, tools, extraction)) {
   addGap(accumulator, { kind: "unsupported-claim", claim }, 20);
  }
 }
}

export function verifySummary(
 summary: string,
 extraction: StructuredExtraction,
 continuity: CompactionState | null = null,
 evidence: VerificationEvidence = {},
): VerificationResult {
 const parsed = parseSummary(summary);
 const accumulator: VerificationAccumulator = { gaps: [], score: 100 };
 const collected = collectVerificationEvidence(extraction, continuity, evidence);
 verifyRequiredSections(parsed, accumulator);
 const paths = verifyPathCoverage(
  parsed,
  extraction,
  continuity,
  evidence,
  accumulator,
 );
 verifyErrorEvidence(
  summary.toLowerCase().replace(/\\/g, "/").replace(/\s+/g, " "),
  collected,
  accumulator,
 );
 verifySemanticCoverage(parsed, collected, continuity, accumulator);
 verifyFileReferences(
  summary,
  extraction,
  continuity,
  evidence,
  collected,
  paths,
  accumulator,
 );
 verifyProgressConsistency(parsed, extraction, collected, paths, accumulator);
 verifyOpenLoopsAndClaims(
  summary,
  parsed,
  paths,
  extraction,
  continuity,
  evidence,
  collected,
  accumulator,
 );
 const score = Math.max(0, accumulator.score);
 return {
  ok: accumulator.gaps.length === 0 && score >= 85,
  gaps: accumulator.gaps,
  score,
 };
}

/** Apply every safe, deterministic repair. Hallucination/inconsistency gaps stay visible for LLM/user review. */
export function patchDeterministic(
 summary: string,
 gaps: VerificationGap[],
 extraction: StructuredExtraction,
 continuity: CompactionState | null = null,
 evidence: VerificationEvidence = {},
): string {
 let canonical: CanonicalSummary = parseSummary(summary);
 const modifiedPaths = extraction.modifiedFiles.map((file) => file.path);
 const readPaths = extraction.readFiles;
 const deletedPaths = Array.from(
  new Set([...extraction.deletedFiles, ...(continuity?.deletedFiles ?? [])]),
 );
 const pathEvidence = buildSummaryPathEvidence(
  [...modifiedPaths, ...readPaths, ...deletedPaths],
  evidence.summaryBudgetTokens,
 );
 const replaceFileSection = (
  kind: "files-modified" | "files-read" | "files-deleted",
  paths: readonly string[],
 ): void => {
  const body = paths
   .map((path) => "- " + (pathEvidence.get(path) ?? JSON.stringify(path)))
   .join("\n");
  canonical = upsertSection(canonical, kind, body || "- None recorded.");
 };
 const safe = (value: string, max: number = TRUNC.MESSAGE) =>
  summaryEvidenceLine(value, max);
 const unresolvedMessages = Array.from(
  new Set([
   ...extraction.errors
    .filter((error) => !error.resolved)
    .map((error) => error.message),
   ...(continuity?.unresolvedErrors ?? []).map((error) => error.message),
  ]),
 );
 const unresolvedLoops = (continuity?.openLoops ?? []).filter(
  (loop) => loop.status !== "resolved",
 );
 const blockedItems = [
  ...unresolvedMessages
   .map((message) => safe(message))
   .filter(Boolean)
   .map((message) => "- " + message),
  ...unresolvedLoops
   .map((loop) => safe(loop.summary))
   .filter(Boolean)
   .map((summary) => "- " + summary),
 ];
 const patchBlockedNone = (): void => {
  const progress = findSection(canonical, "progress");
  if (!progress || !blockedItems.length) return;
  const lines = progress.body.split(/\r?\n/);
  const start = lines.findIndex((line) =>
   /^###\s*Blocked\s*$/i.test(line.trim()),
  );
  if (start < 0) return;
  let end = lines.findIndex(
   (line, index) => index > start && /^###\s+/.test(line.trim()),
  );
  if (end < 0) end = lines.length;
  const existing = lines.slice(start + 1, end);
  const noneIndexes = noneBlockerLineIndexes(existing);
  if (!noneIndexes.size) return;
  const replacement = Array.from(
   new Set([
    ...blockedItems,
    ...existing.filter((line, index) => line.trim() && !noneIndexes.has(index)),
   ]),
  );
  lines.splice(start + 1, end - start - 1, ...replacement);
  canonical = upsertSection(canonical, "progress", lines.join("\n"));
 };

 for (const gap of gaps) {
  switch (gap.kind) {
   case "missing-section": {
    if (gap.section === "goal") {
     canonical = upsertSection(
      canonical,
      "goal",
      safe(extraction.mainGoal ?? "", TRUNC.DETAIL) ||
      "Continue the current coding task.",
     );
    } else if (gap.section === "progress") {
     canonical = upsertSection(
      canonical,
      "progress",
      "### Done\n- No explicit completion recorded.\n### In Progress\n- Continue from the latest user request.\n### Blocked\n" +
      (blockedItems.join("\n") || "- None recorded."),
     );
    } else if (gap.section === "critical-context") {
     const critical = unresolvedMessages.flatMap((message) => {
      const text = safe(message);
      return text ? ["- Unresolved error: " + text] : [];
     });
     canonical = upsertSection(
      canonical,
      "critical-context",
      critical.join("\n") || "- None recorded.",
     );
    }
    break;
   }
   case "missing-file":
    replaceFileSection("files-modified", modifiedPaths);
    break;
   case "missing-read-file":
    replaceFileSection("files-read", readPaths);
    break;
   case "missing-deleted-file":
    replaceFileSection("files-deleted", deletedPaths);
    break;
   case "missing-error": {
    const existing =
     findSection(canonical, "critical-context")?.body.toLowerCase() ?? "";
    const message = safe(gap.message);
    if (!existing.includes(message.toLowerCase())) {
     canonical = appendToSection(
      canonical,
      "critical-context",
      "- " +
      (gap.resolved ? "Resolved error: " : "Unresolved error: ") +
      message,
     );
    }
    break;
   }
   case "missing-constraint":
    canonical = appendToSection(
     canonical,
     "constraints",
     "- " + safe(gap.text, TRUNC.CONSTRAINT_TEXT),
    );
    break;
   case "missing-decision": {
    // Structured fields survive the roundtrip: question (≤ DECISION_SUMMARY)
    // and answer (≤ USER_RESPONSE) are bounded separately — a composite
    // slice truncated long answers mid-sentence (and re-splitting display
    // text on arrows breaks when the fields themselves contain " → ").
    const question = safe(gap.summary, TRUNC.DECISION_SUMMARY);
    const answer = gap.answer
     ? safe(gap.answer, TRUNC.USER_RESPONSE)
     : "";
    canonical = appendToSection(
     canonical,
     "decisions",
     "- **" +
     question +
     "**" +
     (answer ? " \u2192 " + answer : ""),
    );
    break;
   }
   case "missing-goal":
    canonical = upsertSection(
     canonical,
     "goal",
     safe(gap.goal, TRUNC.DETAIL) || "Continue the current task.",
    );
    break;
   case "missing-open-loops": {
    const current = extraction.errors
     .filter((error) => !error.resolved)
     .map((error) => safe(error.message, TRUNC.SNIPPET))
     .filter(Boolean)
     .map((message) => "- [high] Resolve " + message);
    const carriedErrors = (continuity?.unresolvedErrors ?? [])
     .map((error) => safe(error.message, TRUNC.SNIPPET))
     .filter(Boolean)
     .map((message) => "- [high] Resolve " + message);
    const carriedLoops = (continuity?.openLoops ?? [])
     .filter((loop) => loop.status !== "resolved")
     .map((loop) => ({
      priority: loop.priority,
      summary: safe(loop.summary, TRUNC.SNIPPET),
     }))
     .filter((item) => item.summary)
     .map((item) => "- [" + item.priority + "] " + item.summary);
    const body = Array.from(
     new Set([...current, ...carriedErrors, ...carriedLoops]),
    )
     .slice(0, gap.unresolvedCount)
     .join("\n");
    canonical = upsertSection(
     canonical,
     "open-loops",
     body || "- Review unresolved errors.",
     "next-steps",
    );
    break;
   }
   case "fabricated-file": {
    const normalizedRef = gap.ref.replace(/\\/g, "/").toLowerCase();
    canonical = {
     sections: canonical.sections.map((section) => ({
      ...section,
      body: section.body
       .split("\n")
       .filter((line) => {
        if (!/^\s*[-*]\s+/.test(line)) return true;
        const matches = extractFileRefs(line).some(
         (ref) => ref.replace(/\\/g, "/").toLowerCase() === normalizedRef,
        );
        return !matches;
       })
       .join("\n")
       .trim(),
     })),
    };
    break;
   }
   case "unsupported-claim":
    canonical = removeUnsupportedClaim(canonical, gap.claim);
    break;
   case "inconsistency":
    if (gap.detail.startsWith("blocked-none:")) patchBlockedNone();
    break;
  }
 }

 return renderSummary(canonical, { canonicalHeadings: true });
}

function hasUnclosedMarkdownFence(markdown: string): boolean {
 let open: { marker: "`" | "~"; length: number } | null = null;
 for (const line of markdown.split(/\r?\n/)) {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) continue;
  const marker = match[1][0] as "`" | "~";
  if (!open) {
   open = { marker, length: match[1].length };
  } else if (
   marker === open.marker &&
   match[1].length >= open.length &&
   !match[2].trim()
  ) {
   open = null;
  }
 }
 return open !== null;
}

/** Terminal stop reasons for a complete text response: current pi-ai
 * normalizes ordinary completion to "stop"; "endTurn" is retained for older
 * pi-ai/provider fixtures (same contract as assertCompleteBatchResponse). */
const TERMINAL_STOP_REASON_RE = /^(?:stop|endturn)$/i;

/** Shared completion contract for every LLM-produced text: a terminal stop
 * reason (any non-terminal reason — "length", "toolUse", "error", "aborted",
 * "pending", "deferred" — means the response never finished), no truncation
 * marker, and no dangling Markdown fence. Used by the LLM patch path,
 * single-pass, and final assembly; the batch path layers its section
 * contract on top via assertCompleteBatchResponse. */
export function patchResponseIsTruncated(
 patched: string,
 stopReason: unknown,
): boolean {
 const reason = String(stopReason ?? "").trim();
 // Legacy fixtures may omit the reason; a concrete non-terminal string is
 // always incomplete regardless of how plausible the text looks.
 if (reason && !TERMINAL_STOP_REASON_RE.test(reason)) return true;
 return (
  /…✂\d+\s*$/.test(patched) ||
  hasUnclosedMarkdownFence(patched)
 );
}

function sectionIdentity(
 section: CanonicalSummary["sections"][number],
): string {
 return section.kind === "unknown"
  ? "unknown:" + section.heading.trim().toLowerCase()
  : section.kind;
}

export function buildPatchRequest(
 summary: string, gaps: VerificationGap[], model: Model<Api>,
): { context: Context; maxTokens: number } {
 const patchPrompt =
  "Correct every verification finding below WITHOUT restructuring the summary. Add missing evidence, remove fabricated references, and rewrite contradictory claims so they preserve the source constraint/decision polarity. Do not add a Verification Note.\n\nFindings:\n" +
  gaps
   .map((gap, index) => index + 1 + ". " + formatVerificationGap(gap))
   .join("\n") +
  "\n\nCurrent summary:\n" +
  summary +
  "\n\nReturn the COMPLETE corrected summary in the same format.";

 return {
  context: { systemPrompt: COMPACT_SYSTEM_PREFIX, messages: [{ role: "user", content: [{ type: "text", text: patchPrompt }], timestamp: Date.now() }] },
  maxTokens: Math.min(8192, getProviderCaps(model.provider).maxOutputTokens),
 };
}

export async function patchSummary(
 summary: string, gaps: VerificationGap[], model: Model<Api>,
 auth: { apiKey: string; headers?: ProviderHeaders }, signal?: AbortSignal,
 services?: SmartCompactServices,
): Promise<string> {
 const request = buildPatchRequest(summary, gaps, model);
 try {
  const response = await trackedComplete("patch", model, request.context, {
   apiKey: auth.apiKey, headers: auth.headers, maxTokens: request.maxTokens, signal,
  }, services);
  const patched = response.content
   .filter((content): content is TextContent => content.type === "text")
   .map((content) => content.text)
   .join("\n")
   .trim();
  if (
   !patched.startsWith("##") ||
   patchResponseIsTruncated(patched, response.stopReason)
  )
   return summary;
  const originalSections = parseSummary(summary).sections;
  const patchedSections = parseSummary(patched).sections;
  const patchedBodies = new Map(
   patchedSections.map((section) => [
    sectionIdentity(section),
    section.body.trim(),
   ]),
  );
  const preserved = originalSections.every(
   (section) =>
    !section.body.trim() ||
    Boolean(patchedBodies.get(sectionIdentity(section))),
  );
  return preserved ? patched : summary;
 } catch (error) {
  log.debug("patchSummary LLM failed", error);
  return summary;
 }
}
