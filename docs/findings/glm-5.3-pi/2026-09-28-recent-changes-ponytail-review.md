# Recent-changes ponytail review — commits #75–#79 (`9.8.0-canary.7` wave)

- **Date:** 2026-09-28
- **Reviewer:** GLM-5.3 (model) via Pi Coding Agent (harness)
- **Repository state:** `main` at `6554063` (`9.8.0-canary.7` + 4 commits)
- **Scope:** `4754047` (v9.7.1) → `6554063`
  - `9322923` — feat: Pi Continuity 9.8.0-canary.7 (#75)
  - `fdcbc33` — feat: economics, trim timing/scope, handoff, archive integrity, lineage evidence, replay-eval (#76)
  - `9f8a54a` — docs (#77)
  - `46c041a` — feat: cache-warming-aware held trims, extension conflict notice, C9 invariant test, trim bench (#78)
  - `6554063` — fix(hygiene): background strategy trims only under pressure (#79)
- **Method:** line-by-line reading of the new modules from this wave
  (`register-smart-context-tool.ts`, `context-operations.ts`, `context-evidence.ts`,
  `session-lineage.ts`, `host-cache-ledger.ts`, `extension-conflicts.ts`,
  `memory-backend.ts`, `mnemopi-*`, `hindsight-memory.ts`, `hindsight-client.ts`,
  `navigation-data.ts`, `register-navigation.ts`, `anchor-cache.ts`,
  `session-handoff.ts`, `native-compaction.ts`, `native-protocol.ts`,
  `background-preparation.ts`, `settled-auto-trigger.ts`, `lazy-tools.ts`,
  `tool-artifacts.ts`, `visual-archive.ts`, `rtk.ts`, full `src/index.ts` wiring);
  `bun run typecheck`; full `bun test` (1564 pass); an unused-export sweep over
  every file added in the range; LOC-per-subsystem quantification.

**Verification legend:** ✅ verified directly against the code/tests · 🔍 code reading only

**What was not reviewed line-by-line:** `artifact-storage.ts` (a P0 was filed
against it by the parallel DeepSeek review — not independently examined here),
`infra/context-graph.ts` internals, the EESV core (`phases/*`,
`utils/extraction.ts`, `utils/state.ts` — mostly reformat in #75), the task-eval
scenario bodies (`scripts/task-eval-case.ts`), and the hand-drawn UI overlay
files beyond `navigation-overlay.ts`/`home-overlay.ts` structure.

**Verdict.** Not an AI-slop codebase. This wave is disciplined:
issue-numbered commits, written-down invariants (`test/context-invariants.test.ts`
C9: assistant content is never rewritten), fail-closed guards on every opt-in
path, `ponytail:` annotations on deliberate ceilings, and a green 1564-test
baseline. The real exposure is **breadth, not quality**: the package now carries
three memory backends (~1.9k lines), navigation/pivot (~1.7k), native provider
compaction (~1.1k), handoff (~1.2k), spill/visual (~0.7k), ~2k of settings UI,
and a 7.2k-line eval ecosystem in `scripts/` — 38.4k src lines total. Each piece
looks deliberate; the sum is a maintenance surface question, and it deserves a
product decision rather than silent accretion.

Findings are ordered by impact. No P0: nothing found that corrupts data or
breaks a documented guarantee.

---

## B1. Rewind commits are attributed to the ledger as `trim` 🔍

**Evidence:** `src/app/register-smart-context-tool.ts:116-124` —
`confirmStaged` fires `options.onContextEdit?.(ctx, "trim")` with the kind
hardcoded. Staging (`:447-452`) happens for **any** commit whose entries
contain `context_edit`, and `planContextRewind` (`src/app/context-operations.ts`,
`planContextRewind`) emits `context_edit` entries with `replacement: null`.
So a committed rewind reaches `hostCache.noteContextEdit("trim")` instead of a
rewind kind.

**Impact:** statistics only — the host prompt-cache ledger
(`src/app/host-cache-ledger.ts`) counts continuity rebuilds under the wrong
`ContextEditKind`; no behavioral or data effect. Navigation already reports
`"navigation"` correctly via its own `onContextEdit` (`src/index.ts` wiring).

**Fix direction:** record the kind (or the queued action) in `staged` when
staging, pass it through in `confirmStaged`. One field, one call site.

## B2. Queued context change drops silently on a failed turn 🔍

**Evidence:** `src/app/register-smart-context-tool.ts:306-307` —
`turn_end` clears `queued` first, then `if (event.outcome !== "completed" ||
request?.signal?.aborted) return;` without calling `cancelled(event, …)`.
Every other rejection path in the handler emits a visible
`custom_message` notice.

**Impact:** a user-requested manual trim (or agent checkpoint) vanishes with no
feedback when the turn aborts. UX gap, not data loss — nothing was promised
past the boundary.

**Fix direction:** mirror the other paths: `return cancelled(event, "the turn
did not complete");` (message wording to taste).

## P1. `scope=lineage` re-parses up to 3×64 MB of parent sessions on every call 🔍

**Evidence:** `src/app/register-smart-context-tool.ts:173` calls
`loadLineage` inside `execute` for every `status`/`read`/`search` invocation;
`src/app/session-lineage.ts:13-46` does a full `parseSessionEntries` of each
parent file with `LINEAGE_MAX_FILE_BYTES = 64 * 1024 * 1024`
(`src/constants.ts:402`), no caching. `read` is a paginated action by design
(`evidencePage`, `nextOffset`), so a paging agent re-parses the full lineage
per page.

**Impact:** latency and CPU on the smart_context tool path after a handoff;
worst case is three 64 MB JSONL parses per tool call.

**Fix direction:** the mtime+size-keyed cache pattern already exists in this
wave — `sessionAnchorCache` in `src/app/navigation-data.ts:214-216`. The same
~15 lines over `file → {mtime, size, LineageSession}` removes the re-parse.
Optional: drop `SessionManager.inMemory` (`session-lineage.ts:41`) if only
`getBranch()` resolution justifies it; it likely stays, but the check is free
while touching the file.

## P2. `inspectContext` runs twice per smart_context call 🔍

**Evidence:** `src/app/register-smart-context-tool.ts:155` computes
`inspectContext(branch, sessionId)` in `execute`; `contextEvidence` →
`branchEvidence` (`src/app/context-evidence.ts:33`) computes it again. With an
active checkpoint both runs hash the whole prefix (`fingerprintContext`).

**Impact:** minor duplicate O(branch) work, and double prefix hashing when a
checkpoint exists. Correctness unaffected.

**Fix direction:** pass the already-computed `state` into `contextEvidence`/`
branchEvidence` (parameter, ~2 lines at the seams).

## P3. Per-turn trim planning is hot but bench-gated ✅

`planContextTrim` runs at every `turn_end` while hygiene is enabled
(`register-smart-context-tool.ts:327+`): one `buildSessionProjection` plus the
superseded scan. `bench/hot-paths.bench.ts` covers `planContextTrim` and the
CI runs `bun run bench` as a gate. Acceptable as-is; noted so nobody
"optimizes" it blind.

## P4. `recallAnchors` stats every session file per call 🔍

`src/app/navigation-data.ts` (`listSessionFiles`): readdir + per-file `stat`
across the whole sessions tree on each recall. Opt-in, user/tool-triggered,
and bounded by the sessions directory size. Leave it; revisit only if recall
shows up in a profile.

---

## Over-engineering findings (ponytail format)

- `src/app/memory-backend.ts:142-171: native:` `bunPlatformPackages()` hand-copies
  bun's own optionalDeps platform→package mapping (plus the 4 KiB
  postinstall-placeholder heuristic at `:127`). The package-owned `bun`
  optionalDependency plus a PATH `bun --version` probe cover the cases that
  occur; the platform-package fallback duplicates what bun's installer already
  guarantees. ~80 lines.
- `62 export-only symbols: delete:` the `export` keyword on names with zero
  references outside their own file (sweep covered `src/`, `test/`, `scripts/`,
  `bench/`; `src/index.ts` re-exports only two names, so these are not public
  API). Cosmetic, mechanical, one PR. Examples:
  `host-cache-ledger.ts` ledger types, `hindsight-memory.ts` outcome types,
  `native-compaction.ts:64` `NativeToolSource`, `profiles.ts` profile ids.
- `src/infra/native-protocol.ts:330` + `src/app/navigation-data.ts:149: shrink:`
  two `messageText` copies. One shared util.
- `src/app/register-smart-context-tool.ts:60` + `src/app/host-cache-ledger.ts:160: shrink:`
  two `tokens()` formatters.
- `src/rtk.ts: scope:` a bash-command rewrite companion shipped inside a
  compaction package. Small (57 lines), explicit opt-in entrypoint, guarded
  (no shell metacharacters, generation checks, never retries). Deliberate, but
  it is product-boundary creep; keep-or-split is an owner decision, not a code
  fix.
- `scripts/task-eval*` + `replay-eval*` (7.2k lines) + ~1.3k lines of harness
  tests: **keep** — this is the harness that caught #79 ("Found by re-running
  the item-14 evaluator" in `6554063`'s message). It pays rent. Recommendation:
  freeze growth; raise the bar for new scenarios.
- Three memory backends (`local` graph, Hindsight HTTP+receipts, Mnemopi
  worker) ≈ 1.9k lines: all opt-in, all carefully guarded (cross-process lock,
  idempotent operation ids, honesty rules for unknown outcomes). The question
  is ownership, not implementation: if only one backend has real users, the
  others are triple maintenance surface for a compaction extension.

`net: ~100 lines concretely deletable (bun platform mapping, dedup) plus two
one-line fixes (B1, B2) and one ~15-line cache (P1). The larger lever is the
product decision on scope, not line count.`

## Recommended order

1. B1 + B2 (one-line each, same file) and P1 lineage cache — real user-visible wins.
2. Export-keyword sweep + `messageText`/`tokens` dedupe — mechanical PR.
3. `bunPlatformPackages` simplification — needs a Windows/Android CI check before removal.
4. Owner decisions: `rtk.ts` home and the memory-backend count. Not code tasks.
