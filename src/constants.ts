/**
 * Constants, prompts, and profile defaults.
 */

import type { CompressionProfile, ProfileConfig } from "./types.ts";

/**
 * Single-source-of-truth note: this literal is rewritten in place by
 * `scripts/sync-version.ts` (wired to `prebuild`/`prepublishOnly`) from
 * `package.json#version`. Do not hand-edit this line for releases; bump
 * package.json and run `bun run sync-version`.
 */
export const VERSION = "7.21.0";
export const CHARS_PER_TOKEN = 3.8;

export const COMPACT_SYSTEM_PREFIX =
  "You are an expert conversation summarizer for a coding agent. " +
  "Produce structured markdown summaries. " +
  "Follow output format exactly. " +
  "Use EXACT names — never paraphrase code identifiers. " +
  "Trust deterministic extraction data over intuition.";

export const PROFILES: Record<CompressionProfile, ProfileConfig> = {
  light: {
    summaryBudgetTokens: 10000,
    keepRecentTokens: 30000,
    minChunkTokens: 800,
    maxChunkTokens: 12000,
    singlePassMaxTokens: 40000,
    batchMaxTokens: 30000,
  },
  balanced: {
    summaryBudgetTokens: 6000,
    keepRecentTokens: 20000,
    minChunkTokens: 500,
    maxChunkTokens: 8000,
    singlePassMaxTokens: 30000,
    batchMaxTokens: 24000,
  },
  aggressive: {
    summaryBudgetTokens: 3000,
    keepRecentTokens: 10000,
    minChunkTokens: 300,
    maxChunkTokens: 6000,
    singlePassMaxTokens: 20000,
    batchMaxTokens: 18000,
  },
};

export const DEFAULT_CONFIG = {
  profile: "balanced" as CompressionProfile,
  profiles: PROFILES,
  summaryModel: null as string | null,
  segmentationModel: null as string | null,
  summaryThinkingLevel: null,
  segmentationThinkingLevel: null,
  autoTrigger: true,
  autoTriggerTimeoutMs: 120000,
  backupEnabled: true,
  backupDir: "",
  minContextPercent: 60, // Don't compact below this context threshold (tool=97% ≠ context full)
  requireApproval: false,
  scrubSecrets: true,
  scrubPii: false,
  maxLlmCalls: 0,
  maxLatencyMs: 0,
  focusWeighting: true,
  adaptiveDamageFeedback: false,
  onlineDamageMonitor: true,
  pinPaths: [] as string[],
};

export const NO_OP_RE = /applied:\s*0|no changes applied|nothing to (?:do|change)|0 edits? applied/i;
// Turkish cues in both proper (şimdi/geçelim/bakalım/yapalım/başka) and ASCII
// (simdi/gecelim/...) spellings — users mix the two. The `u` flag matches
// FOLLOWUP_RE's convention for Turkish-bearing patterns.
export const SHIFT_RE = /şimdi|simdi|peki|bi de|bide|geçelim|gecelim|bakalım|bakalim|yapalım|yapalim|başka|baska|sonra|tamam şimdi|tamam simdi|now let|also|next|let's|moving on|switch to/iu;
export const CHOICE_RE = /use\s+\S+\s+(?:instead|not|rather)|don't\s+use|avoid\s+|switch\s+to\s+|go\s+with\s+|prefer\s+/i;

// ── Prompt Templates ──

export const SINGLE_PASS_PREFIX =
  "Summarize this coding agent conversation. Produce ONE structured summary.\n" +
  "\nRules for Accuracy:\n" +
  "1. Session Type: read-only tool calls = REVIEW, not implementation\n" +
  "2. Status: Check for user complaints before marking \"Done\"\n" +
  "3. Exact Names: Quote specific variable/function/parameter names, don't paraphrase\n" +
  "4. Files: Use the VERIFIED file lists above (deterministically extracted, zero hallucination risk)\n" +
  "\nOutput EXACTLY this format:\n\n" +
  "## Goal\n[What the user is trying to accomplish]\n" +
  "## Constraints & Preferences\n- [CRITICAL: user requirements, preferences, constraints]\n" +
  "## Progress\n### Done\n- [x] [Completed tasks with file references]\n### In Progress\n- [ ] [Current work state]\n### Blocked\n- [Issues]\n" +
  "## Key Decisions\n- **[Decision]**: [Rationale]\n" +
  "## Files Modified\n- [Verified list from deterministic extraction]\n" +
  "## Files Read\n- [Verified list from deterministic extraction]\n" +
  "## Next Steps\n1. [What should happen next]\n" +
  "## Critical Context\n- [Specific data, patterns, info needed to continue]\n- [Error patterns or gotchas]\n" +
  "## Topics Covered\n[Chronological bullet list with priority in brackets]\n";

export const SINGLE_PASS_SUFFIX =
  "\n{PREV_CONTEXT}\n\n{EXTRACTION_CONTEXT}\n\n{EXPLORATION_CONTEXT}\n\n<conversation>\n{CONVERSATION}\n</conversation>";

export const BATCH_PROMPT_PREFIX =
  "Summarize these conversation segments.\n\nRules for Accuracy:\n" +
  "1. Use EXACT file paths from extraction data\n" +
  "2. Status: only mark \"done\" if there's clear evidence (successful test run, user confirmation)\n" +
  "3. Quote specific values, don't paraphrase code\n\n" +
  "For EACH segment produce EXACTLY:\n" +
  "### CHUNK {NUMBER}: {TOPIC_NAME}\n" +
  "**Priority**: [critical|high|normal|low]\n" +
  "**Summary**: [2-4 sentences: what happened, errors, code changes with paths]\n" +
  "**Decisions**: [comma-separated, or \"None\"]\n" +
  "**Modified**: [comma-separated paths, or \"None\"]\n" +
  "**Read**: [comma-separated paths, or \"None\"]\n";

export const BATCH_PROMPT_SUFFIX = "\n{EXTRACTION_CONTEXT}\n\n<segments>\n{TEXT}\n</segments>";

export const ASSEMBLY_PROMPT_PREFIX =
  "Merge these topic summaries into ONE coherent summary.\n\n" +
  "## IMMUTABLE CONTEXT (do not modify or contradict these facts)\n" +
  "These are deterministically verified from the original conversation. They take priority over ANY summary content below.\n\n" +
  "Rules:\n" +
  "1. Preserve ALL critical/high info. Condense normal, minimize low.\n" +
  "2. Chronological order.\n" +
  "3. The pre-processed data below is GROUND TRUTH — trust it over individual summaries.\n" +
  "4. Files Modified list is deterministically verified — if a summary says a file was modified but it's NOT in the list above, omit it.\n" +
  "5. Key Decisions below are verified — preserve them exactly, do not paraphrase the decision text.\n" +
  "6. Do NOT fabricate file paths, function names, or error messages not present in the verified data.\n\n" +
  "Format:\n" +
  "## Goal\n[Overall objective]\n" +
  "## Constraints & Preferences\n- [CRITICAL requirements, preferences, constraints]\n" +
  "## Progress\n### Done\n- [x] [Completed tasks with file refs]\n### In Progress\n- [ ] [Current work state]\n### Blocked\n- [Issues]\n" +
  "## Key Decisions\n- **[Decision]**: [Rationale]\n" +
  "## Files Modified\n- [Verified deterministic list]\n" +
  "## Files Read\n- [Verified deterministic list]\n" +
  "## Next Steps\n1. [What should happen next]\n" +
  "## Critical Context\n- [Data, patterns, info needed]\n" +
  "## Topics Covered\n[Chronological bullets with priority]\n";

export const ASSEMBLY_PROMPT_SUFFIX =
  "\nIMMUTABLE CONTEXT (verified deterministic data):\n- Key Decisions: {DECISIONS}\n- Files Modified (VERIFIED): {MODIFIED}\n- Files Read (VERIFIED): {READ}\n\n{EXPLORATION_CONTEXT}\n{PREV_CONTEXT}\n\n<summaries>{SUMMARIES}</summaries>";

// ── Session-type-specific prompt instructions ──

export const SESSION_TYPE_INSTRUCTIONS: Record<string, string> = {
  debugging: "Focus on: error chains, root cause analysis, attempted fixes, resolution status. Prioritize error messages and stack traces. Mark files as Done only if all errors resolved.",
  implementation: "Focus on: files created/modified, architectural decisions, feature completeness, test coverage. Prioritize code changes with exact paths.",
  review: "Focus on: files read, issues found, recommendations, approval status. Prioritize findings over changes. Read-only tool calls = REVIEW, not implementation.",
  discussion: "Focus on: decisions made, trade-offs discussed, consensus reached. Prioritize rationale over implementation details.",
};

// ── Section name constants ──
export const SECTION_GOAL = "## Goal";
export const SECTION_CONSTRAINTS = "## Constraints & Preferences";
export const SECTION_PROGRESS = "## Progress";
export const SECTION_DECISIONS = "## Key Decisions";
export const SECTION_FILES_MODIFIED = "## Files Modified";
export const SECTION_FILES_READ = "## Files Read";
export const SECTION_NEXT_STEPS = "## Next Steps";
export const SECTION_CRITICAL_CONTEXT = "## Critical Context";
export const SECTION_TOPICS = "## Topics Covered";
export const SECTION_OPEN_LOOPS = "## Open Loops";
export const SECTION_CHANGES = "## Changes Since Last Compaction";

// ── Log prefix ──
export const LOG_PREFIX = "[smart-compact]";

// ── Thresholds ──
export const MIN_TOKEN_THRESHOLD = 5000;
export const MAX_EXPLORATION_ROUNDS = 8;

// ── Backup retention policy ──
//
// Backups are written every successful compaction; without retention the
// directory grows without bound. We cap by both count (most recent N kept)
// and age (anything older is dropped). Pruning runs asynchronously so the
// compact path doesn't pay the readdir/stat cost in the hot loop.
export const BACKUP_MAX_FILES = 20;
export const BACKUP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// ── Shared durations (eliminate duplicated 7d×3 / 1h×2 inline literals) ──
export const FIVE_MINUTES_MS = 5 * 60 * 1000;
export const ONE_HOUR_MS = 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// ── Extraction-cache filename prefix (paths.ts builds it, cache.ts prunes by it) ──
export const EXTRACTION_CACHE_PREFIX = "compact-extraction-";

// ── ID prefixes (were inline string literals scattered across modules) ──
export const ID_PREFIX = {
  PROJECT: "proj-",
  COMPACT_SESSION: "sc-",
  MULTI_TOOL_USE_SYNTHETIC: "mtu_",
  OPEN_LOOP: "loop-",
  DECISION: "decision-",
  ERROR: "error-",
} as const;

// ── Tuning factors (calibration EMA/clamp + constraint confidence) ──
export const TUNING = {
  EMA_PREV: 0.7,
  EMA_SAMPLE: 0.3,
  CALIBRATION_CLAMP_MIN: 0.3,
  CALIBRATION_CLAMP_MAX: 3.0,
  CONFIDENCE_HIGH: 0.85,
  CONFIDENCE_MEDIUM: 0.8,
  CONFIDENCE_LOW: 0.6,
} as const;

// ── Truncation budgets (named, not inline literals) ──
export const TRUNC = {
  // storage caps (extraction produces, state re-caps defensively)
  MESSAGE: 300,
  ERROR_DETAIL: 500,
  DECISION_SUMMARY: 200,
  USER_RESPONSE: 300,
  CONSTRAINT_TEXT: 300,
  OPEN_LOOP_SUMMARY: 120,
  TIMELINE_EVENT: 150,
  TIMELINE_ERROR: 100,
  // prompt / context snippets
  SNIPPET: 80,
  PREVIEW: 150,
  PREVIEW_MID: 200,
  DETAIL: 300,
  PREVIEW_LONG: 400,
  PREVIEW_XL: 500,
  CHUNK_FALLBACK: 180,
  DECISION_DETAIL: 60,
  TOPIC_LABEL: 100,
  // hash / id / display
  PROJ_ID_HASH: 12,
  CONV_HASH: 8,
  RESULT_GAPS: 5,
  SESSION_ID_DISPLAY: 20,
  ERROR_SNIPPET: 30,
  TIMELINE_DISPLAY: 10,
  EXPLORE_RESULTS: 15,
  BACKUP_PREVIEW_LINES: 5,
  FINGERPRINT_SEG: 2,
} as const;

// ── Truncation lengths used by damage paths ──
export const DAMAGE_RECENT_MSG_WINDOW = 15;

// ── Pruning ──
export const MAX_TOOL_OUTPUT_CHARS = 800;

// ── Error detection (shared by pruning + extraction) ──
/** Shell-output patterns signalling a likely error even in a non-`isError` result. */
export const LIKELY_ERROR_RE = /(?:command not found|no such file|permission denied|syntax error|cannot find|module not found|compilation error|build failed|test failed|^FAIL\b|ERROR:)/i;
/** catalogErrors only scans outputs shorter than this — pruning must not truncate below it. */
export const ERROR_SCAN_MAX_LEN = 2000;
/** How far forward to look for a retry of the same tool after an error. */
export const ERROR_RETRY_WINDOW = 6;
/** How far forward to look for that retry's resolving (non-error) result. */
export const ERROR_RESOLVE_WINDOW = 10;

// ── Per-run metrics buffer ──
//
// MetricsSink keeps at most this many records; once exceeded it trims down
// to half. The cap protects against runaway batches without losing the
// recent history the result screen needs.
export const METRICS_BUFFER_MAX = 200;
// Append-only runtime JSONL logs are tail-read and capped on disk. Five MiB
// keeps thousands of recent runs without allowing years of silent growth.
export const RUNTIME_LOG_MAX_BYTES = 5 * 1024 * 1024;

// ── Damage detection window ──
export const DAMAGE_LOOKBACK_MSGS = 15;

// ── Damage report regex slicing ──
export const VERIFICATION_GAP_SNIPPET_LEN = 80;

// ── Config keys ──
export const CONFIG_KEY = "smartCompact";
export const CONFIG_KEY_ALT = "semanticCompact";

export const EXPLORER_SYSTEM_PROMPT =
  "You are a conversation analyst. You have deterministic extraction data and can query the raw conversation using tools.\n\n" +
  "Your job:\n" +
  "1. Verify/enrich the extracted boundaries (merge, split, or add as needed)\n" +
  "2. Identify cross-topic relationships\n" +
  "3. Find implicit constraints (user tone, frustration, urgency)\n" +
  "4. Assess completion status accurately\n" +
  "5. Extract the narrative arc\n\n" +
  "Use tools BEFORE forming conclusions. You may make up to 8 tool calls.\n\n" +
  "After exploration, output ONLY a JSON object (no markdown):\n" +
  '{"boundaries":[{"afterIndex":N,"topic":"...","priority":"critical|high|normal|low","confidence":0.0-1.0}],"mainGoal":"...","sessionType":"implementation|review|debugging|discussion","enrichedConstraints":[...],"crossReferences":[...],"statusAssessment":{"done":[...],"inProgress":[...],"blocked":[...]},"criticalContext":[...],"keyDecisions":[...]}';
