# Changelog

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
