# Changelog

## [7.17.0] - 2026-06-26

### Added
- **Name-agnostic tool classification** (`src/domain/tool-semantics.ts`) — a pure `classifyTool(args)` that classifies a tool call by its argument shape (`mutates` / `accesses` / `executes` / `other`) plus `extractToolPath(args)`. A tool is a write because its arguments carry a content payload, not because its name contains "write" — so this auto-adapts to tools the code has never seen (`hypa_*`, MCP servers, custom extensions) with no name list to maintain.

### Changed
- **Extraction is now name-agnostic.** `trackFileOps`, `catalogErrors`, `segmentTopicsHeuristic` (`utils/extraction.ts`), `get_file_changes` (`phases/explore.ts`), and re-read detection (`utils/damage.ts`) all classify via `classifyTool` instead of substring name matching. Removes the `WRITE/DELETE/READ_TOOL_HINTS` lists, `hasToolHint`, and the hardcoded `=== "bash"` gate. Shell-like tools (`hypa_shell`, …) and path-bearing readers (`hypa_grep`/`find`/`ls`) are now detected correctly by argument shape.
- **Model resolution deduplicated** (`index.ts`) — the `provider/id` split + `modelRegistry.find` pattern (duplicated three times) is now a single `findModelById` helper; `resolveModelArg` removed.
- **`SHIFT_RE` Turkish coverage** — the topic-shift cue regex was ASCII-only and silently missed natural Turkish spellings (`şimdi`, `geçelim`, `bakalım`, `yapalım`, `başka`); both spellings now match, consistent with `FOLLOWUP_RE`'s dual-spelling convention.
- **`CONSTRAINT_PATTERNS` readability** — the Turkish regexes use raw UTF-8 characters instead of `\u00f6`/`\u015f` escapes (the source is UTF-8; the escapes added no value and hurt readability).

### Fixed
- **`trackFileOps` duplicated branch** — the `isTruncated` and `!NO_OP_RE` arms had identical bodies; collapsed into one condition (`isTruncated(resultText) || !NO_OP_RE.test(resultText)`).
- **Dead locals in `segmentTopicsHeuristic`** — `type` and `primaryFile` were assigned every iteration but never read (the topic push uses `currentType`/`currentPrimaryFile`); removed. Path lookup now uses `extractToolPath`, matching the other consumers.

### Tests
- New `test/tool-semantics.test.ts` covering all four tool classes, the path-only delete/read ambiguity, and `extractToolPath` across key variants. Extraction fixtures updated to realistic content payloads; a regression case proves an unknown tool name (`totally_unknown_mcp_tool`) is still classified correctly. Suite: 501 tests across 43 files.

## [7.16.0] - 2026-06-18

### Added
- **Pinned never-compact context** (`smartCompact.pinPaths`) — file paths that must always survive compaction regardless of what the LLM summary includes. Surfaced in the summary's Files Read via a deterministic, LLM-free `ensurePinnedPaths` step in `buildState`.
- **Damage auto-remediation** — `detectDamage` now collects the files the agent re-reads after a compaction (`reReadFiles`), persists them as remediation hints, and the *next* compaction re-preserves them (merged with `pinPaths`) so lost context stops being lost twice. Closes the detect → remediate loop.
- **`/smart-compact restore`** — list, view, and restore backups. `listBackups`/`readBackupContent` make the previously write-only backups browsable; `showRestorePicker` + `showRestoreAction` + `showBackupViewer` provide a TUI; and a true restore forks from the current leaf and re-injects the pre-compaction content as context via `sendMessage` (graceful fallback to view on any failure).
- `asBranchMessage` / `asSerializableMessages` boundary adapters in `src/infra/ai-messages.ts`, documenting why each cross-package upcast is sound.

### Fixed
- **session-log timestamp** — `normalizeLogMessage` stamped `Date.now()` (the recovery wall-clock) gated on a nonsensical content-shape condition, and dropped `toolName`. Now parses the log entry's real timestamp and preserves `toolName`.
- **`synthesize` empty-batch guard** — `batches[0]` could be dereferenced when the chunk list was empty; now guarded with a deterministic fallback.
- **`backupDir` config validation** — the one config key without type validation now rejects non-string values.
- **result-screen timer** — the `setTimeout` used in the result-screen `Promise.race` is now cleared in a `finally` instead of lingering up to 5s.
- **negative exploration boundary clamp** — `normalizeBoundaries` now lower-clamps `afterIndex` to 0 (LLMs occasionally emit negative values) and guards `confidence` against non-numeric values.
- **`computeToolCharPercentage` dead branch** — removed the unreachable `block.content` path (text blocks carry `.text`).
- **`ctx.ui.notify` invalid type** — restore used `"success"`, which `ctx.ui.notify` does not accept; corrected to `"info"`.
- **state.ts basename recompute** — the per-error file-attribution basename is now precomputed once instead of recomputed for every (error × file) pair.

### Changed
- **Message cast normalization** — the explore feedback loop now builds native `Message[]` (assistant turns are the real `AssistantMessage` from `trackedComplete`, no longer downcast to `LlmMessage`); `recover`/`persist`/`extract` route through the documented `asBranchMessage`/`asSerializableMessages` adapters. Removes the lossy `as unknown as Message[]` casts and the silent dropping of `usage`/`api`/`provider`/`model`/`stopReason`.
- **Tools cast normalization** — `EXPLORATION_TOOLS` is now declared as native `Tool[]` using typebox schemas, removing both `as unknown as Parameters<...>["tools"]` casts. Behavior-preserving: every pi-ai provider only serializes the schema, so real typebox schemas are wire-identical to the previous plain JSON-schema objects.
- `failedChunkSummary` co-located with `assembleFallback` in `phases/synthesize.ts` and exported (was an untested module-private in the step module).
- `buildExplorationReportFromParsed` parameter narrowed `any` → `unknown` with proper field validation.

### Build
- **pi runtime peers resolved 0.79.4 → 0.79.6** and **typebox 1.2.11 → 1.2.16** in the lockfile. `peerDependencies`/`devDependencies` keep their `*` wildcard ranges per the forward-compatibility policy from 7.15.0.

### Tests
- **+79 tests (414 → 493):** type-guards validators (`isValidSmartCompactDetails`/`sanitizeSmartCompactDetails`), synthesize fallback contracts (`assembleFallback`/`failedChunkSummary`), `ai-messages` adapters, pinned-paths injection, remediation-hints round-trip, backup restore (list/read/build-restore-message), and exploration boundary normalization (negative clamp, confidence guard, non-string mainGoal).

### Docs
- README, ARCHITECTURE, CONTRIBUTING, SECURITY, SUPPORT, RELEASE, and CODE_OF_CONDUCT redesigned; new `docs/assets/banner.svg` hero. CONTRIBUTING drift fixed (`core.ts`/`DEVPLAN.md`/`ROADMAP.md` references removed; repo map updated to the layered architecture).

## [7.15.1] - 2026-06-15

### Fixed
- **Delta section placement** — `injectDeltaSection` contained a dead ternary (`hasOpenLoops ? "next-steps" : "next-steps"`) that made the `hasOpenLoops` computation unreachable, so the "Changes Since Last Compaction" section always anchored before `Next Steps` regardless of whether `Open Loops` was present. The domain layer (`summary-parse.ts`) now supports a structured `SectionPlacement` hint with both `before` and `after` semantics; the delta injector anchors *after* `Open Loops` when present, otherwise *before* `Next Steps`. The new object form is additive — the legacy positional `before` argument remains backward-compatible.
- **Shadowed catch binding in exploration parser** — `parseExplorationReport` used `e` for both `lastIndexOf("}")` and the per-`catch` error, which compiled but was a confusing trap for future edits. Renamed the loop bounds to `startIdx`/`endIdx` and the catch bindings to `err`.
- **Defensive guards in LLM-output parsing** — `buildExplorationReportFromParsed` now validates `typeof parsed === "object"` before touching it, so a model that returns a primitive JSON value (`42`, `"ok"`, `true`, `null`) falls back to heuristic boundaries instead of risking a `TypeError`.
- **Non-negative index guard** — `branchIndexToMsgIndex` (used by anchor-aware keep-boundary resolution) now clamps to `Math.max(0, ...)`, so a future code path that reaches it without a prior message entry can never produce a negative index.

### Changed
- **Typed theme in TUI overlays** — `renderContextBar` and `renderTokenBar` no longer take `theme: any`; they now use the real `Theme` class exported from `@earendil-works/pi-coding-agent`, restoring compile-time type safety over `.fg()` / `.bold()` calls without inventing a parallel local interface.

### Build
- **Pi runtime peers 0.79.4** — `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` resolved from 0.79.0 → 0.79.4. Peer dependency ranges remain wide (`*`).
- **`typebox` 1.2.11** — Patch upgrade from 1.2.3.
- **`@types/node` 25.9.3** — Patch upgrade from 25.9.2.

### Docs
- **Architecture tables synchronized** — `ARCHITECTURE.md`'s layer tables now list every `src` module, including previously missing `pending-slot.ts`, `explore-wrap.ts`, `infra/session-identity.ts`, `utils/file-needles.ts`, `utils/file-ref-detect.ts`, and `utils/lru.ts`. README repository-layout tree and module counts updated to match (15 utility modules; 414 tests across 36 files).

### Tests
- **7 new test cases (407 → 414)** covering `upsertSection` before/after placement and legacy back-compat, plus `buildExplorationReportFromParsed` primitive/null guards.

### Chore
- **Ignore npm lockfile** — `.gitignore` now excludes `package-lock.json`; this project uses `bun` and the stray lockfile created by incidental `npm` commands should not be committed.

## [7.15.0] - 2026-06-08

### Changed
- **Wildcard peer/dev dependencies for Pi packages** — `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` now use `*` version ranges in both `peerDependencies` and `devDependencies`, ensuring forward compatibility with all future Pi runtime versions without extension-level pinning. Resolved to 0.79.0 (pi-*) and 1.2.3 (typebox) at install time.

### Fixed
- **Cross-session leak guard** — The pending compaction payload now carries the originating pi session id and is refused if the consuming session does not match. Two pi sessions sharing the same Node process (a common sub-agent setup) can no longer apply each other's prepared summaries. The fallback identifier for sessions that the host cannot resolve is per-call unique (`unresolved:<uuid>`) so two unresolved sessions never collide.
- **`patchSummary` provider cap** — The verifier's repair LLM call now clamps `maxTokens` to the active provider's true output ceiling instead of a hard-coded 8192, preventing provider-side errors on DeepSeek/MiniMax (cap 4096) and wasted budget elsewhere.
- **File-reference heuristic** — Verification no longer flags version strings (`v7.13.2`, `0.78.0`), runtime versions (`node 22.19.19`), or package identifiers as "potentially fabricated files". The classifier now rejects SemVer-shaped tokens, requires the last path segment to be a non-version when a slash is present, and otherwise requires a known source/config extension.
- **Bugfix-loop file attribution** — Unresolved errors are no longer attached to every file in the tree whose basename happens to appear in the error message. Attribution now uses progressively-longer path-suffix needles and skips generic basenames (`index.ts`, `types.ts`, ...) unless the error mentions the full `dir/<basename>` segment.
- **Auto-trigger notification wording** — The post-pipeline toast no longer claims "Compaction completed" when only the smart summary has been staged (the native compact has not yet run). The wording now reflects whether a payload is pending ("Smart compact prepared in ... — awaiting native /compact") or no payload was produced ("run finished").
- **LRU promotion correctness** — The session-log cache promotion check now gates on `Map.has`, not `value !== undefined`, so future cache value types that legitimately include `undefined` are still promoted to the most-recent slot.

### Added
- **Encapsulated `PendingSlot` API** — The pending compaction payload now lives in a closure-based factory (`src/app/pending-slot.ts`) with a discriminated `ConsumeResult` (`ok` | `empty` | `expired` | `mismatch`). The slot owns its entire lifecycle (set / consume / clear / expire / mismatch) inside a single file, exposes a side-effect-free `peek()` for read-only display paths, accepts an injectable clock for deterministic tests, and is fully host-agnostic.
- **Bounded session-log caches with env override** — Both `logPathCache` and `messageMapCache` are now LRU-bounded (default 8 entries). The cap is tunable via the `SMART_COMPACT_LOG_CACHE_MAX` environment variable; invalid values silently fall back to the default so a `.env` typo never disables the cache. LRU helpers extracted to `src/utils/lru.ts` for isolation and reuse.
- **Single-source-of-truth `VERSION`** — The version literal in `src/constants.ts` is regenerated from `package.json` at `prebuild` time by `scripts/sync-version.ts`. The validator refuses any non-SemVer value, defending the generated source line against an attacker-controlled or merge-corrupted `package.json`. Pure validation/rewrite logic lives in `scripts/sync-version-lib.ts` and is unit-tested without filesystem access.
- **Test-only resets** — `__resetSessionLogCachesForTests` and `_getMaxEntriesForTests` allow deterministic test setup of the session-log module.

### Changed
- **Pipeline narrowed to `ExtensionContext`** — The smart-compact orchestrator no longer requires `ExtensionCommandContext`; the same code path now serves both interactive commands and the `session_before_compact` event handler with zero `as unknown as` casts. The narrower type makes "the pipeline only touches the shared host surface" a compile-time invariant.
- **Module-level singletons removed** — The historical `_compactSessionId` cache singleton was redundant with the per-run `services.compactSessionId` and has been deleted. Production callers always flow through the services container; a private `fallbackSessionId()` is retained only for callers that omit `services` entirely.
- **`extractText` / `flattenToolCallBlock` deduplicated** — The `multi_tool_use.parallel` flatten logic that was previously inlined in three places is now a single module-level helper with a typed `FlatToolCall` interface. `extractText` uses the shared `isTextBlock` type guard rather than inline structural casts.
- **`Cell<T>` type alias** — Shared mutable single-slot ref cells (`isRunning`, `cancellationOut`) are now typed as `Cell<T>` instead of `{ value: T }` inline literals.

### Performance
- **Pruning single-pass walk** — `pruneRedundant` previously walked the message list up to four times (build kept list, build final list, two `estimateTokens(map+join)` calls) for ~40-60ms of overhead on 5k-message sessions. Now folded into a single forward pass. As a side effect the rewrite **fixes a latent token-accuracy bug**: `estimateTokens` only applies the JSON-shape penalty when the input *starts* with `{`/`[`, so the previous global-string concatenation under-counted JSON-heavy tool outputs. Per-message estimation now reflects the true token count.
- **Open-loop attribution** — File-needle generation is hoisted out of the inner error loop, eliminating the prior N(errors) × M(files) re-computation.

### Tests
- **115 new test cases (289 → 404)** across seven new files covering `resolveSessionId` (1000-iteration uniqueness loop), `PendingSlot` lifecycle (15 cases including TTL boundary, set overwrite, cross-session mismatch), `lruGet`/`lruSet` (undefined/null value regressions), `getMaxEntries` env override, file-reference heuristic (SemVer rejection integration), file-needle generator (generic-basename gate, length threshold), and `sync-version` SemVer validation (injection vector).

### Build
- **TypeScript 6.0** — Upgraded from 5.9 with no source changes required; the project's `tsconfig.json` was already aligned with every 6.0 mandatory default.
- **`@earendil-works/pi-*` 0.78.0** — Pi runtime peers upgraded from 0.75.5. Peer dependency ranges remain wide (`*`).
- **`@types/node` 24 LTS** — Upgraded from 22. Node 25 deliberately skipped (not LTS).
- **`typebox` 1.1.39** — Patch upgrade.

## [7.13.2] - 2026-05-26

### Changed
- **Package gallery presentation** — Replaced README badge images with plain text links so Pi package pages do not render badges as extra image cards.
- **Logo asset cleanup** — Replaced the oversized logo with a square transparent icon-only PNG and reduced README display size.
- **Repository hygiene** — Removed stale audit and archived planning markdown files from the tracked repository.
- **CI maintenance** — Updated GitHub Actions checkout from v4 to v6.

## [7.13.1] - 2026-05-26

### Fixed
- **Run-scoped service isolation** — Smart compaction runs now create isolated service containers for LLM calls, metrics, extraction-cache stats, token calibration, and provider prompt-cache session ids, reducing cross-run state pollution in concurrent Pi sessions.
- **Phase timing accuracy** — Prune, extract, explore, and synthesize timings are now measured at their actual phase boundaries instead of adjacent marker calls that could report near-zero durations.
- **Tool/noise accounting** — Tool character percentages now count only text blocks, avoiding accidental inclusion of provider tool-call fields with text-like payloads.
- **File operation extraction coverage** — File-change detection now recognizes common patch/create/append/update/apply-style tool names in addition to write/edit/delete/read variants.

### Tests
- Added regression coverage for run-scoped LLM metrics isolation, text-only tool character accounting, and broader file-operation tool matching.

## [7.13.0] - 2026-05-25

### Added
- **Interactive metrics dashboard TUI** — `/smart-compact dashboard` now opens an in-terminal dashboard with overview, latest-run details, current-session runs, recent runs, and an explicit HTML export action.
- **Dashboard run detail formatting** — Added tested formatter helpers for legacy metrics, empty states, phase timings, compact run descriptions, and bounded percentage display.

### Fixed
- **Provider cache percentage accounting** — Provider prompt-cache hit rates now use an effective prompt-token denominator and are capped at 100%, preventing impossible values such as `572610%` when providers report cached tokens separately from new input tokens.
- **Verification repair for malformed summaries** — Missing canonical sections are now reported as verification gaps and deterministic repair can create sections such as `## Goal`, `## Progress`, `## Critical Context`, and `## Files Modified` before injecting required facts.
- **Dashboard comparison noise** — Legacy metrics entries without profile/provider metadata are omitted from profile/provider comparison groups instead of appearing as misleading `unknown` rows.

### Changed
- **Metrics readability** — Result overlays and notifications distinguish prompt, new, and cached input tokens when provider cache reads are present.
- **Dashboard navigation** — The TUI supports keybinding-aware navigation plus page-up/page-down and home/end scrolling.

## [7.12.5] - 2026-05-23

### Fixed
- **Extraction cache safety** — Incremental extraction now reuses cache only when both the original entry prefix and the pruned-message prefix still match, preventing corrupted merges when pruning changes or when legacy cache entries lack pruning metadata.
- **Chunk synthesis robustness** — Batch summarization now emits stable `CHUNK N` ids, includes tool-call context in segment text, parses returned sections by chunk id instead of raw position, and falls back to section/chunk previews when the model omits a clean summary line.
- **Verification result accuracy** — Metrics and result details now use the post-patch verification result after deterministic/LLM repair instead of the pre-patch score.
- **Auto-trigger overlap guard** — Hard-timeout cleanup no longer resets `isRunning` early while a timed-out compaction is still unwinding, avoiding overlapping background compactions.
- **Nested parallel tool boundaries** — Keep-boundary protection now understands nested `multi_tool_use.parallel` tool call ids so compaction does not split wrapper calls from kept tool results.

### Changed
- **Extraction-cache observability** — Metrics, dashboard/report rows, notifications, and result overlays now distinguish provider prompt-cache hit rate from deterministic extraction-cache hit rate and record extraction-cache miss reasons.
- **Pending summary visibility** — Expired pending smart summaries now raise a user-visible warning when discarded.

## [7.12.4] - 2026-05-20

### Fixed
- **Manual command override** — Explicit user-run `/smart-compact` commands now bypass the adaptive `minContextPercent` tier gate, while auto-trigger and agent tool calls still respect it. This keeps cache-protective behavior for agents but preserves user control.

## [7.12.3] - 2026-05-20

### Changed
- **Safer pi-toolkit threshold** — Raised the default `minContextPercent` from 30 to 60 so high `tool=XX%` ratios from pi-auto-context do not trigger smart compaction while actual context usage is still moderate.
- **Agent guidance** — Updated the `smart_compact` tool description and guidelines to explicitly ignore pi-auto-context `tool=XX%` as a compaction signal and use actual `context=XX%` instead.
- **Package image metadata** — Switched the package gallery image URL to the stable `main` asset path to avoid version-tag drift.

### Fixed
- **Provider capability mapping** — Added explicit pi-toolkit provider entries for `kimi-coding`, `xiaomi-mimo`, and `crofai` so timeout/concurrency/cache metadata does not fall through to generic defaults.
- **Open-loop indexing** — Replaced `msgs.indexOf(msg)` with indexed loops in open-loop extraction to avoid O(n²) scans and incorrect source indexes for repeated message references.
- **Batch summary fallback** — Hardened `summarizeBatch()` so a missing or merged LLM section falls back to the original chunk preview instead of producing an empty segment summary.
- **Pending summary observability** — Log when an expired pending smart summary is discarded.

## [7.12.2] - 2026-05-20

### Fixed
- **Context threshold guard completion** — Completed the `minContextPercent` guard across config, types, tier selection, core pipeline, tool handler, and tests.
- **Precise threshold comparison** — `smart_compact` now compares raw context percentage for the guard and uses rounded percentage only for user-facing text.

## [7.12.1] - 2026-05-19

### Fixed
- **Pi package gallery preview** — Added `pi.image` metadata pointing to the packaged logo asset so pi.dev/package listings can render the package image.

## [7.12.0] - 2026-05-19

### Added
- **Performance monitoring report** — Metrics now include run status, method, provider/model, run type, total duration, verification gaps, and phase timings. `/smart-compact metrics` and the `smart_compact` tool's `report` parameter return a profile/provider comparison report for A/B-style evaluation.
- **Professional local HTML dashboard** — `/smart-compact dashboard` and `smart_compact({ dashboard: true })` write `.cache/smart-compact-report.html` with KPI cards, reliability badges, duration trends, profile/provider comparison tables, phase timing bars, recent-run diagnostics, responsive dark/light styling, and aggregate metrics.
- **Provider strategy fields** — Provider capabilities now include timeout multipliers, single-pass threshold multipliers, and multimodal support mode. Auto-trigger timeout and single-pass selection adapt to the selected provider.
- **Multimodal metadata extraction** — The deterministic extractor now preserves image/file/audio/video attachment metadata without embedding binary/base64 payloads in summaries.

### Fixed
- **Manual tool timeout warning** — `smart_compact` tool calls no longer inherit the native auto-trigger timeout. The timeout guard now only applies when Pi's `session_before_compact` hook is trying to prepare a summary before native compaction.
- **Auto-trigger robustness** — Increased the default `autoTriggerTimeoutMs` from 45s to 120s, cleared the hook timeout timer deterministically, and kept the native fallback warning specific to auto-trigger runs.
- **Single-pass output budget** — Single-pass compaction now caps `maxTokens` to the selected profile's `summaryBudgetTokens` instead of the provider's maximum output size.
- **Runtime version drift** — Synced the exported runtime `VERSION` with `package.json` and added a regression test.
- **Config validation hardening** — Invalid per-profile overrides are now sanitized instead of reaching the compaction pipeline as non-numeric budget values.
- **Metrics failure observability** — Timeout and unexpected error exits now write metrics entries with `status: "timeout"` or `status: "error"` before rethrowing.
- **Dashboard hardening** — The local HTML dashboard escapes metric values and the metrics reader skips corrupt JSONL rows instead of dropping the whole report.

### Performance
- **Session log recovery cache** — Session log path lookup and parsed message maps are cached with mtime/size invalidation to avoid repeatedly scanning `~/.pi/agent/sessions` during recovery.

## [7.11.0] - 2026-05-19

### Changed
- **README compatibility guidance** — Added a prominent note documenting conflict-prone extension behavior around compaction hooks, session/branch history, message and tool metadata, tool output rewriting, compaction boundaries, and session log storage. Also clarified that `pi-smart-compact` is recommended alongside `pi-toolkit` for complementary context hygiene and verified compaction.

## [7.10.0] - 2026-05-19

### Added
- **`multi_tool_use.parallel` support** — `buildToolCallIndex()` now flattens nested `tool_uses` from `multi_tool_use.parallel` into synthetic tool-call entries. Reads real `use.id` when present (matching downstream `toolResult.toolCallId`), falls back to deterministic synthetic id. `trackFileOps`, `catalogErrors`, `segmentTopicsHeuristic`, and retry/resolution detection all support nested calls. 6 new tests.
- **Entry-id cache invalidation** — `CachedExtraction` now stores `firstEntryId` and `lastEntryId`. Cache check in `core.ts` validates `firstEntryId === currentFirstId && lastEntryId === cachedLastMsgId`, so appended-message sessions preserve incremental extraction while pivot/branch changes auto-invalidate. 2 new tests.
- **Auto-trigger hard timeout** — `index.ts` `session_before_compact` hook now wraps `runSmartCompact` in `Promise.race` with `config.autoTriggerTimeoutMs` (default 45s). If provider ignores `AbortSignal`, hook still returns to native compact on time. `core.ts` guards all side-effects (`pendingRef`, fingerprint, state, metrics) if `timedOut`.
- **Config validation** — `validateSmartCompactConfig` now validates `autoTriggerTimeoutMs` range (1000–300000 ms). Invalid values are deleted and fallback to default. 8 new tests.
- **Session log Pi filename format** — `findSessionLogFile` now supports `*_\${sessionId}.jsonl` glob pattern (e.g. `2026-05-19T12-00-00_abc123.jsonl`) in addition to exact match. 3 new tests.
- **Git-root projectId priority** — `deriveProjectId(cwd, extraction, sessionId)` now prefers git root over file paths, surviving discussion-only sessions. `findGitRoot(cwd)` exported and tested. 3 new tests.
- **Verbose pipeline diagnostics** — `vlog()` helper in `core.ts` logs tier, convTokens, extraction mode (incremental/full), explore boundaries, chunk topics, verification score, and pipeline completion stats when `/smart-compact verbose` is used.
- **Rich metrics logging** — `appendMetricsLog` now records `profile`, `tier`, `contextPercent`, `toolPercent`, `tokensBefore`, `tokensSaved`, `pruneSavedTokens`, `chunkCount`, `verificationScore` for regression detection.
- **Prepublish guard** — `package.json` `prepublishOnly`: `bun run typecheck && bun test && bun run build`.

### Fixed
- **Cache incremental check** — `lastEntryId` now compares against `toCompact[cachedExt.lastMessageIndex]?.id` instead of `toCompact[toCompact.length - 1]?.id`, so appended messages don't falsely invalidate the cache.
- **catalogErrors retry flatten** — Retry/resolution scan now uses `flattenToolCallBlock()` to detect retries inside `multi_tool_use.parallel`. Previously only flat tool calls were matched.
- **Segment topic type persistence** — `segmentTopicsHeuristic` now carries the most significant type (`implementation` > `debugging` > `review` > `exploration`) into the final trailing topic instead of defaulting to `exploration`.
- **Tool-call boundary guard** — `guardToolCallBoundary()` prevents splitting `toolCall`/`toolResult` pairs across compaction boundary, eliminating `"tool_call_id is not found"` errors. 9 new tests.
- **Session log ID-based alignment** — `resolveCompactionMessages` walks `toCompact` entries by `id` instead of tail-slice, guaranteeing exact 1:1 alignment regardless of pivot/branch changes.

## [7.9.5] - 2026-05-18

### Added

- **pi-toolkit truncation detection + session log fallback** — New `src/utils/session-log.ts` reads the original untruncated conversation from pi-coding-agent's `.jsonl` session log when pi-toolkit's context hook has mutated branch entries (tool results truncated to `…✂N`). `resolveCompactionMessages()` auto-detects truncation and falls back to disk, preserving extraction accuracy. [pi-toolkit](https://github.com/ersintarhan/pi-toolkit) compatible.
- **Anchor-aware keep boundary** — `smartKeepBoundary()` now accepts branch entries and guarantees the last on-branch pi-toolkit anchor is never compacted out of the keep window. Prevents pivot target loss. 5 test cases in `test/pi-toolkit-truncate.test.ts`.
- **Tiered compaction** — Context pressure and tool-noise percentage now select pipeline depth automatically:
  - `none` (< 45% context, < 60% tool): skip compaction entirely — pi-toolkit handles it.
  - `prune` (45–60% context): deterministic redundancy pruning only, zero LLM calls.
  - `light` (60–80% context): extract + single-pass, skip exploration.
  - `full` (> 80% context): complete EESV pipeline.
- **pi-toolkit status message pruning** — `pruneRedundant()` now detects and removes stale `[pi-auto-context]` status messages, keeping only the latest. Reduces per-turn noise injected by pi-toolkit.
- **Internal LLM cache disable** — One-shot compaction phases (`explore`, `single-pass`, `batch`, `assemble`, `patch`) now automatically set `cacheRetention: "none"`. Cache write cost (1.25×–2×) is never amortized for internal calls. Centralized in `trackedComplete()` via phase-based `INTERNAL_PHASES` set.
- **19 pi-toolkit integration tests** — New `test/pi-toolkit-truncate.test.ts` documents and validates truncation behavior, anchor boundary protection, extraction degradation under truncation, and toolCall-level fallback inference.

### Changed

- **Truncate-aware extraction** — `trackFileOps()` treats truncated write/edit results as "modified" (safe default; no-op cannot be verified). `catalogErrors()` adds `FAIL` and `ERROR:` to bash error regex for earlier-match resilience when content is truncated past keywords.
- **Call-site cleanup** — Removed ~9 inline `cacheOpts()` calls across `explore.ts`, `synthesize.ts`, `verify.ts`. All caching logic now handled centrally by `trackedComplete()`.

### Fixed

- **pi-toolkit truncation data loss** — Before this release, pi-toolkit's context hook (which truncates tool results older than the last anchor) caused pi-smart-compact to extract from corrupted data. Errors, file modifications, and no-op edits were silently mis-detected. Now auto-detected and bypassed via session log.

## [7.9.4] - 2026-05-18

### Changed
- **Fingerprint fixture sanitization** — Removed personal absolute paths from `test/fingerprint.test.ts` and replaced them with neutral helper-generated fixture paths while preserving the absolute-path regression coverage.
- **No runtime behavior changes** — This is a test-only/docs hygiene patch intended to keep the repository and GitHub source free of personal machine paths.

## [7.9.3] - 2026-05-18

### Changed
- **README refocused** — Rewrote `README.md` as a concise, user-facing overview. It now explains the package in terms of agentic compaction, Kamradt-style chunking, and the EESV pipeline without repo-audit noise or drift-prone implementation snapshots.
- **Docs cleanup** — `DEVPLAN.md` is now positioned as an archived implementation record, `ROADMAP.md` serves as the live planning document, and new `CONTRIBUTING.md` / `ARCHITECTURE.md` files document contributor workflow and system design.
- **Version metadata synchronized** — `package.json`, runtime version constants, and generated `dist/` metadata now align on `7.9.3`.
- **TS script invocation stabilized** — `build` and `typecheck` now use `bun x tsc`, matching the working local invocation more reliably.

## [7.9.1] - 2026-05-17

### Fixed
- **`/smart-compact` race condition** — Added `waitForIdle()` to slash command handler. Previously the command could execute concurrently with agent streaming since extension commands bypass the input queue.
- **Tool `skipCompact` safety** — `ctx.compact()` internally calls `this.abort()`, which would kill the running agent loop if called from within a tool. Tool path now correctly keeps `skipCompact: true` and caches summary in `pendingRef` for the next natural compact.
- **Tool context-usage guard** — Tool now checks `getContextUsage()` before running and returns early with token info if context is too small.
- **Tool description enriched** — Better description and parameter hints so the agent knows when and how to call `smart_compact`.

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
