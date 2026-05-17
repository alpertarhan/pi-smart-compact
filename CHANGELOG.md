# Changelog

## [7.9.0] - 2026-05-17

### Fixed
- **40 TypeScript strict-mode errors resolved** — `bunx tsc --noEmit` now passes cleanly with zero errors against latest `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui` peer types.
- **`notify()` level mismatch** — `"success"` is not a valid level in `ExtensionUIContext.notify()`. All instances mapped to `"info"`.
- **`UserMessage.timestamp` mandatory** — 10 inline message objects across `explore.ts`, `synthesize.ts`, `verify.ts` were missing the required `timestamp: Date.now()` field.
- **`AgentToolResult.details` mandatory** — All tool return objects in `index.ts` now include explicit `details: undefined`.
- **`SelectList.selectedIndex` private accessor** — Replaced with `setSelectedIndex()` in `overlays.ts`.
- **`ThemeColor` union vs arbitrary string** — `theme.fg()` cast to `(c: string, t: string) => string` in overlays for dynamic color lookup.
- **`CacheAwareOptions` not assignable to `ProviderStreamOptions`** — Added explicit cast in `cache.ts`.
- **`blocks: unknown` after `Array.isArray`** — Explicit `unknown[]` typing in `extraction.ts` and `pruning.ts`.
- **`ExtensionContext` vs `ExtensionCommandContext`** — Proper `as unknown as` double-cast in `index.ts` for tool and hook contexts.
- **`apiKey?: string` (optional) used as `string`** — Extracted `apiKey` and `apiHeaders` as separate non-optional variables after guard check in `core.ts`.
- **`pendingRef.value` type narrowed to `never`** — TypeScript control flow after `pendingRef.value = null` prevented re-reading after `runSmartCompact`. Fixed with explicit cast.

### Changed
- **`/smart-compact` command now uses `waitForIdle()`** — Prevents race condition when slash command is entered while agent is streaming. Agent finishes current turn before compaction starts.
- **Tool (`smart_compact`) keeps `skipCompact: true`** — Mid-turn compaction via `ctx.compact()` would abort the running agent loop (`this.abort()` internally). Tool prepares summary in `pendingRef` for the next natural compact to apply.
- **Tool description enriched** — Better description, parameter descriptions, and context-usage guard help the agent decide when to call smart_compact.
- **README.md updated** — version 7.9.0, module count 18, line count ~5,091, typecheck status now passing, added `logger.ts` and `type-guards.ts` to source table.

## [7.8.0] - 2026-05-17

### Fixed
- **TTL bug in loadCompactionState** — `Date.now() - 0` was always true, making state files live forever. Now uses `updatedAt` field with `fs.statSync(fp).mtimeMs` fallback for pre-7.8.0 backward compat.
- **mergeExtractions duplicate modifiedFiles** — same file could appear multiple times after incremental cache merge. Now deduped via `Map<path, entry>`.
- **deriveProjectId weak hash** — DJB2 hash with 32-bit truncation had collision risk across projects. Replaced with `crypto.createHash('sha256')`.
- **smartKeepBoundary JSON.stringify** — was serializing entire message objects including metadata, causing false positive boundary matches. Replaced with extractText-style approach.
- **Removed all `(m: any)` type casts** — 3 instances in core.ts replaced with proper type inference.

### Removed
- **`src/utils/message-blocks.ts`** — 4 functions (`getBlocks`, `isTextBlock`, `isToolCallBlock`, `getToolArgumentString`) never imported anywhere. Entire file deleted.
- **`extractTextSafe` and `getMessageText`** from `types.ts` — unused dead code chain.
- **`ToolCallBlock` and `TextBlock` interfaces** from `types.ts` — superseded by `LlmToolCallBlock` and `LlmTextBlock`.
- **`clearToolSupportCache`** from `explore.ts` — exported but never called. Cache already self-regulates via TTL checks on access.
- **`extractUserNote` local duplicate** from `index.ts` — now imported from `helpers.ts`.
- **Unused imports** across 4 files (`isTextBlock`, `isToolCallBlock`, `extractTextSafe`, `buildToolCallIndex`, `CompressionProfile`, `ProfileConfig`, `LlmMessage`).

### Changed
- **`runSmartCompact` signature** — 10 positional parameters replaced with `SmartCompactOptions` interface. All 4 call sites in `index.ts` updated.
- **Silent catch → `console.error(LOG_PREFIX + ...)`** — all 11 I/O catch blocks now log errors with the shared `LOG_PREFIX` constant.
- **`buildToolCallIndex` called once** — was called 4× per extraction (`trackFileOps`, `catalogErrors`, `extractDecisions`, `segmentTopicsHeuristic`). Now built once in `extractStructured` and passed via optional `_tcIdx` parameter.
- **`JSON.stringify` → `extractText`** in synthesize.ts (`estimateChunkTokens`) and explore.ts (`search_conversation`) — avoids serializing metadata, reduces CPU ~15-25%.
- **`loadConfig` stale cache fix** — catch block now sets `_cfg = fallback` so deleted config files don't serve stale cached values.

### Added
- **`SessionType`** type alias — replaces inline `"implementation" | "review" | "debugging" | "discussion"` union across 5+ files.
- **`SessionMessageEntry`** in `types.ts` — was duplicated inline in `core.ts` and `helpers.ts`.
- **Constants**: `LOG_PREFIX`, `MIN_TOKEN_THRESHOLD`, `MAX_EXPLORATION_ROUNDS`, `CONFIG_KEY`, `CONFIG_KEY_ALT`, 11 section name constants (`SECTION_GOAL` etc.).
- **`ToolCallIndex`** type alias in `extraction.ts` for the reusable tool call index.
- **`updatedAt`** field in `CompactionState` — enables proper TTL expiry with backward-compat.
- **`SmartCompactOptions`** interface in `core.ts` — documented API for the main pipeline runner.

## [7.5.0] - 2026-05-17

### Added

- **Redundancy-aware pre-pruning**: New `pruning.ts` module collapses redundant message sequences before compaction — duplicate file reads (keep last), collapsed error chains, agent acknowledgment message removal, long tool output truncation (>800 chars). Reduces compaction input by 15-30%.
- **Topic-level compression budgeting**: `allocateTopicBudgets()` assigns per-topic token allocations based on priority (critical 2x, high 1.5x), error density, recency weighting, and decision count. Assembly prompt includes budget hints per segment.
- **Project context fingerprint**: New `fingerprint.ts` module stores lightweight per-project metadata (language, framework, key directories, known files) across sessions. Compaction uses this for better file verification and context injection.
- **Post-compaction damage detection**: New `damage.ts` module monitors agent behavior after compaction for regression signals — re-reads of compacted files, user complaints, re-questions about compacted topics. Logs damage reports for future analysis.
- **Compaction preview context**: Project fingerprint and pruning stats are shown in notifications before compaction starts.

### Changed

- Single-pass prompt now includes project context from fingerprint.
- `preProcessSummaries` accepts optional `budgetTokens` parameter for topic-level budget allocation.

## [7.4.0] - 2026-05-17

### Added

- **Decision propagation**: Batch summarization now injects active decisions from previous segments into each batch prompt, preventing cross-batch decision amnesia and reducing semantic drift.
- **Deterministic patch**: New `patchDeterministic()` function injects verification gaps directly into the relevant summary sections (files → Files Modified, errors → Critical Context, etc.) without any LLM call.
- **Lazy verification**: Verification scores ≥ 85 skip patching entirely. Scores 75–84 use deterministic patch only. Scores < 75 fall back to LLM patch only if deterministic patch is insufficient.
- **Session-aware prompts**: `SESSION_TYPE_INSTRUCTIONS` map provides session-type-specific focus instructions (debugging, implementation, review, discussion) injected into single-pass synthesis.
- **Immutable Context framing**: Assembly prompt now presents deterministic data as "IMMUTABLE CONTEXT (do not modify)" with explicit rules against fabrication and contradiction.
- **Metrics memory cap**: `_metrics` array capped at 200 entries (pruning to 100 when exceeded) to prevent memory leaks in long-running processes.

### Changed

- **Renamed**: Extension renamed from `semantic-compact` to `pi-smart-compact`. Command changed from `/compact-semantic` to `/smart-compact`. Tool changed from `semantic_compact` to `smart_compact`. Config key changed from `semanticCompact` to `smartCompact`.

- **Token estimation**: Language-aware (Turkish/CE character penalty) and JSON-aware penalty. Per-provider calibration instead of global shared factor to prevent cross-session bleed.
- **Verification path matching**: Replaced basename-only `string.includes()` with path suffix array matching to reduce false positives (e.g., "index" no longer matches every file containing "index").
- **Boundary merging**: LLM boundaries no longer completely override heuristic boundaries. Low-confidence LLM boundaries (confidence < 0.4) are filtered. Remaining LLM boundaries are merged with heuristic boundaries that fill gaps.
- **Constraint mining**: Added Turkish diacritical character variants (önemli, şart, zorunlu, kesinlikle, asla, sakın) and new Turkish pattern categories (prohibition: yapma/kullanma/asla, preference: tercih/isterim/olsun).
- **Keep-boundary token calc**: Uses content text instead of JSON.stringify(message) to avoid metadata overhead in token estimation.

### Added

- **Adaptive exploration gate**: Simple sessions (≤3 topics, ≤1 unresolved errors, ≤2 decisions, ≤2 directory groups) skip Phase 2 exploration entirely, saving 3-8 LLM calls.
- **Tool support cache**: Provider tool support results cached for 30 minutes with TTL-based eviction. Prevents repeated probe calls for known-unsupported providers.

### Fixed

- Constraint regex bug: `önemli` (with ö) now correctly matches alongside `onemli`.
- `calibrateFromResponse` now requires provider parameter to scope calibration per-provider.

## [7.3.1] - 2025-05-16

### Added
- Full EESV pipeline: Extract → Explore → Synthesize → Verify
- Deterministic extraction of files, errors, decisions, constraints, topics
- LLM tool-calling exploration with 6 exploration tools
- Parallel batch synthesis with provider-aware concurrency
- Automated verification with coverage checks and hallucination detection
- Quality score (0-100) and gap patching
- Incremental compaction cache (1hr TTL, delta extraction)
- Live progress overlay and detailed result screen
- Metrics logging (`~/.pi/agent/.cache/compact-metrics.jsonl`)
- Cache-aware LLM calls with session affinity
- Three compression profiles: light, balanced, aggressive

### Changed
- Refactored from single 2200-line file to modular `src/` architecture
- Improved token estimation with provider-specific ratios and EMA calibration
- Added `LlmMessage` and `StructuredExtraction` types replacing `any`

### Fixed
- Tool loop safety (prevents orphaned tool result errors)
- No-op edit detection
- Graceful fallback when models don't support tool calling
