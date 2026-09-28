# Recent-changes review — commits #75–#79 (`9.8.0-canary.7` wave)

- **Date:** 2026-09-28
- **Reviewer:** DeepSeek V4.1 Flash (model) via OpenCode (harness)
- **Repository state:** `main` at `6554063` (`9.8.0-canary.7` + 4 commits)
- **Scope:** `4754047` (v9.7.1) → `6554063`
  - `9322923` — feat: Pi Continuity 9.8.0-canary.7 (#75)
  - `fdcbc33` — feat: economics, trim timing/scope, handoff, archive integrity, lineage evidence, replay-eval (#76)
  - `9f8a54a` — docs (#77)
  - `46c041a` — feat: cache-warming-aware held trims, extension conflict notice, C9 invariant test, trim bench (#78)
  - `6554063` — fix(hygiene): background strategy trims only under pressure (#79)
- **Method:** full diff reading of #76–#79 and the new modules of #75; `bun run typecheck`; six full `bun test` runs; one end-to-end reproduction; cross-checks against the Pi 0.87.1 host API in `node_modules`; focused sweeps of native compaction, lifecycle wiring, memory backends, UI and dead code.

**Verification legend:** ✅ reproduced or verified directly against the code · 🔍 code reading only · ⚠️ observed once, not reproduced

**What was not reviewed line-by-line:** the pre-existing EESV core (`phases/*`,
`utils/extraction.ts`, `utils/state.ts`). Most of #75's diff there is
reformatting, not behavior change (e.g. `phases/verify.ts` is 1361/1370 raw
changed lines but 19/28 ignoring whitespace).

**Verdict.** This is not an AI-slop codebase: invariants are written down,
features are gated and tested, and deliberate ceilings carry `ponytail:`
annotations. The maintenance surface, however, grew fast in this wave and there
are concrete hygiene gaps. The findings below are ordered by impact; P0 items
are real defects with narrow, identifiable fixes.

---

## P0 — Defects

### P0-1. `artifact-storage.ts` corrupts multi-chunk JSONL lines; the storage report degrades to `unknown` ✅ reproduced

**Evidence:** `src/app/artifact-storage.ts:86-111`. `eachSessionLine` reuses one
1 MiB `chunk` buffer across `handle.read()` calls but keeps unfinished line
fragments as `chunk.subarray(...)` **views** in `pending`. When a JSONL line
crosses a chunk boundary, the next read overwrites the bytes the earlier views
point at; the concatenated line is garbage and `JSON.parse` fails. The file's
own comment (`:45`) says a single line holds "~2 MiB" of pre-offload tool
result, so lines over 1 MiB are expected, not exotic.

**Reproduction (end-to-end, real function):** a session file whose second line
is 1.2 MB → `inspectArtifactStorage()` returns `scanComplete:false`,
`sessionFilesUnreadable:1`, and the only artifact owner becomes
`unknown` with reason `scan-incomplete`. The mirror-function reproduction also
shows an extra empty line emitted at EOF (harmless: skipped by
`scanSessionFile`).

**Impact:** `/smart-compact storage` — a read-only diagnostic whose whole job is
classifying live vs. unreferenced spill — silently stops classifying exactly
the sessions that use artifact offload. No data is deleted.

**Fix direction:** copy the tail (`Buffer.from(chunk.subarray(start, bytesRead))`)
or concatenate `pending` before the next read; optionally drop the trailing
empty emit.

### P0-2. Project pruning evicts tombstones first, defeating the #66 "tombstones are terminal" guarantee ✅

**Evidence:** `src/infra/context-graph.ts:626-634` orders pruning victims
`ORDER BY CASE WHEN status = 'active' THEN 1 ELSE 0 END, updated_at ASC`, i.e.
non-active rows are removed before active ones, within `MAX_PROJECT_NODES = 2000`
(`:15`). The resurrection guard (`:588-593`, `:776-782`) depends on
`latestLineageFact` finding that tombstone. Once pruned, a later compaction that
still contains the old text re-adds the fact as `active`.

**Impact:** the guarantee delivered in `eee04de` ("tombstones are terminal —
re-derivation cannot resurrect facts") holds only below the cap for the facts
that matter most (resolved/open loops are exactly what gets closed).

**Fix direction:** never prune non-active rows, or persist tombstone fact keys
in a bounded side set that survives pruning.

### P0-3. Hindsight: a corrupt receipt ledger fails open — remote deletion and silent ledger wipe ✅

**Evidence:** `src/infra/hindsight-receipts.ts:107-117` → `readJsonSync`
(`src/infra/fs.ts:291-306`) returns `null` on any parse/read error, and
`readAll` maps that to `[]`. Consequences:
- `resolveHindsightMemory` (`src/app/hindsight-memory.ts:353-379`) sees no open
  receipts and deletes the remote document even though receipts may show an
  in-flight retain.
- The next `upsertReceipt` rewrites the file from the empty read, discarding up
  to 500 existing receipts.

**Impact:** remote data deletion on a local file-corruption event, plus loss of
the only record of what was sent where. The module's stated honesty rules
(`hindsight-memory.ts:1-10`) make this a fail-open regression of intent.

**Fix direction:** distinguish ENOENT from parse failure; treat a corrupt ledger
as an error for resolve/save (fail closed), surface the issue, and never
overwrite an unreadable ledger in place.

### P0-4. Native compaction: budget bypass, optimistic after-estimate, and no backup ✅

Three separate defects on the same path (`src/app/native-compaction.ts`):

1. **Budget:** `:157` calls `rc.services.budget.reserveCall(0, 0)` and never
   reconciles (`utils/cache.ts:200-244` is the EESV path with
   `reserveCall(estimatedInput, maxTokens)` + `reconcileInput`/`reconcileOutput`).
   A whole-prefix native request spends nothing against `maxLlmInputTokens`.
2. **Estimate:** `:256-259` scales the retained tail + native tokens by
   `tokensBefore / totalEstimate`. The comment says "like the planner does", but
   the planner uses `fixedContextTokens + retained + summary`
   (`app/steps/window.ts:172-180`, `domain/yield-gate.ts:49`). The proportional
   scale typically *understates* fixed context, making `estimatedAfterTokens`
   optimistic and letting target/yield gates pass for a candidate whose real
   post-context is larger. `revalidatePending` reuses the same optimistic base
   (`app/pending-slot.ts:44-49`).
3. **Backup:** `:278` stages `backupPath: null` with no `preparedBackup`, and
   `app/steps/persist.ts:100-104` silently skips it. `backupEnabled` defaults to
   `true` and `docs/configuration.md:464` documents no native exception, so
   native-only users never get the promised pre-compaction backup. No
   `ponytail:` annotation marks this ceiling.

**Fix direction:** reserve the prefix token estimate and reconcile from
`result.usage`; compute `fixed = max(0, tokensBefore - totalEstimate)` and
`after = fixed + retained + native`; either materialize a backup for the native
cut or annotate and document the omission with a one-time notice.

### P0-5. Native continuity bridge: a hard crash leaves a permanent lock; writes unlink the previous handoff first ✅

**Evidence:** `src/app/native-continuity-bridge.ts:100-106` →
`acquireLockSync` (`src/infra/fs.ts:131-136`) throws immediately on `EEXIST`,
and `tryAcquireLock` (`fs.ts:88-128`) performs no stale-owner recovery by
design ("Crash leftovers require explicit cleanup"). `prune` only removes
`.tmp.*` names (`:78`), never `bridge.lock`. After a crash while staging, every
`stage`/`take`/`size` logs "Lock busy" and the feature is dead for that
directory. Additionally `stage` unlinks the existing target before writing
(`:115`) and `take` unlinks before validating scope/TTL (`:131`).

**Impact:** the bridge exists to survive restarts; its failure mode is
permanently defeating itself after one crash. A failed write also destroys the
previous handoff.

**Fix direction:** use the stale-aware lease pattern from
`app/session-run-lock.ts` (or reclaim locks whose owner PID is dead), write the
temp file first and unlink/rename atomically, and validate before unlinking in
`take`.

### P0-6. Mnemopi readiness contradicts its own reason string ✅

**Evidence:** `src/app/memory-backend.ts:85-90` hardcodes `ready:false` while
`reason` comes from `describeMnemopiRuntime()` (`:249-283`), which returns
positive text when Bun and the package are resolvable
("Bun X … and Mnemopi package found; worker/database operation not verified").
Home renders `"Memory: not ready. " + reason` (`src/ui/home-overlay.ts:298`).

**Impact:** a working Mnemopi configuration is reported as not ready; the
reason line undercutting the headline is confusing and, unlike Hindsight's
presence-only "ready", inconsistent.

**Fix direction:** derive readiness from the probe result (package + supported
Bun) and keep "worker/database not verified" in the reason text.

### P0-7. Home-embedded settings bypass the live-apply hook; the "This branch" row is inert ✅

**Evidence:**
- `src/ui/home-overlay.ts:206-208` calls `settingsCategoryItems(...)` without
  the `writeConfig` argument, so it defaults to raw `writeGlobalConfigValue`
  (`src/ui/settings-overlay.ts:1011`). Input rows (limits, `pinPaths`,
  `backupDir`, Hindsight fields) therefore never invoke `onApplied`; choice
  rows do, through the coordinator (`:824-832`). The standalone settings screen
  wraps the writer explicitly (`:1140-1144`), and the runtime hook it skips is
  `index.ts:356-368` (`invalidatePreparation`, `applyGlobalSettingsRuntime`,
  `navigation.refresh`).
- `home-overlay.ts:137-140` consumes Enter for every id not in
  `BEHAVIOR_PROFILES` (`if (onExtra(id)) return true; if (!option) return true;`),
  while the only extra row is registered with `onExtra: () => false`
  (`:320-333`). The "This branch" row can never open its submenu, yet the
  behavior description points users at it (`:264-266`).

**Fix direction:** pass `(path, value) => options.applyPatch({ [path]: value })`
(or the onApplied wrapper) as `writeConfig`; return `false` for the extra row's
id so `SettingsList.activateItem` can open the retained submenu.

### P0-8. `/smart-compact dashboard` is a silent no-op outside a TUI ✅

**Evidence:** `src/app/register-smart-compact-command.ts:599-601` calls
`showMetrics` with no mode guard, and
`src/ui/metrics-dashboard-overlay.ts:137` calls `ctx.ui.custom` unconditionally.
Non-interactive adapters return `undefined`, so the command discards the
already-built insights/report without a notice. `settings`, `storage` and
`navigation` all warn (`register-smart-compact-command.ts:628-633`, `:575-578`,
`:250-256`); the headless test covers only the no-argument invocation
(`test/headless-and-footer.test.ts:127-138`).

**Fix direction:** mirror the other commands: `if (ctx.mode !== "tui" || !ctx.hasUI)`
notify with a pointer (e.g. to `/smart-compact metrics` or the HTML report).

### P0-9. Intermittent full-suite failure in `lifecycle-e2e` (stale-tail) ⚠️

**Observation:** one of six full `bun test` runs failed:
`extension lifecycle end to end > requests background compaction through the
correlated host lifecycle (stale-tail)`. The other five runs (1564/1564) and
the isolated test pass. Failure details were lost to output truncation; the case
uses real timers and process-wide token calibration, and the test mutates
`process.env.HOME`.

**Impact:** `release:check` runs the suite; an unexplained flake is a gate
reliability risk, especially since the same wave changed this fixture's
intentionally shared process state (`__resetProcessCalibrationForTests`).

**Fix direction:** capture the assertion on failure (run the suite with full
output), pin clock/calibration state per case, and consider serializing the
suite's HOME-dependent files.

---

## P1 — Behavior and data consistency

### P1-1. Settled auto-trigger can hang the settle hook and permanently block the session ✅

`src/app/settled-auto-trigger.ts:62-95` sets `active[sessionId]`, then awaits a
promise resolved only by `ctx.compact`'s `onComplete`/`onError`. With no
watchdog, a host that accepts the request but never calls back leaves the token
set (no future automatic trigger) and the awaited promise pending inside
`agent_settled` (`src/index.ts:412`). Fix: bounded timeout with `finish()`, and
never await unbounded in the hook.

### P1-2. #79's early return can drop an already-applied held trim ✅

`src/app/register-smart-context-tool.ts:315-328`: `pending = applied` is taken
at the top of `turn_end`, but the new `if (!hygiene && !pressure) return;` exits
without restoring `applied = pending` (the contested-boundary branch at
`:333-337` shows the intended pattern). Reachable when `contextHygieneEnabled`
is turned off after a mark was held and a cold request already carried the
trim: the visible trim flips back and is never committed until pressure or the
setting returns. Fix: preserve `pending` before the early return, or commit
what a live request already carried.

### P1-3. Cache-warming veto math is approximate while the comment claims exactness ✅

`register-smart-context-tool.ts:284-299` subtracts `w·X` from `missCost`, but
the miss cost avoided by the trim is `(w − r)·X` (`missCost` already nets out
the cache read; see `pi-coding-agent` `cache-warmer.js` `evaluate()`). The
over-subtraction makes the veto slightly more aggressive, while ignoring
subsequent per-request savings biases the other way. The docstring's "really
costs `missCost − w·X`" should state the approximation and its direction.

### P1-4. Native metrics snapshot is hand-rolled and inconsistent ✅

`native-compaction.ts:321-322` hardcode `avgLatency:0`/`cacheHitRate:0` while
cache tokens are recorded; `:347` sets `providerRoutes[0].avgLatencyMs` to the
whole pipeline duration (`:298`). `buildSuccessMetrics` (`app/steps/metrics.ts`)
is not reused, so fields drift. Also `:328` computes `runType` with
`autoTriggered` first, while `steps/metrics.ts:52-57` checks `skipCompact`
first — the `smart_compact` tool (both flags) is recorded as `"auto"` on the
native path and `"tool"` on EESV.

### P1-5. Other native-path edges ✅

- `native-protocol.ts:229-236`: `anthropicUsage` uses `iterations` whenever it
  is an array; an `iterations: []` response reports all-zero usage into metrics
  and Pi's session totals. Fall back to `top` when empty.
- `native-compaction.ts:71-78`: `nativeStateOf` matches api/provider/model but
  not `baseUrl`, while staging treats `baseUrl` as part of the route
  (`pending-slot.ts:27-30`). Replay can target a same-id endpoint change.
- `compaction-commit-store.ts:62-68`: `take` with a sessionId mismatch returns
  `null` without deleting the entry or invoking `onDiscard`; the lost metrics
  then surface as the misleading `apply.no-candidate` error (`index.ts:566-574`).
- `native-compaction.ts:397-400`: `onError` calls `pendingRef.clear(sessionId)`
  session-wide without checking the failing `runId`.
- `native-compaction.ts:410-421`: `MAX_WARNED_SKIPS` clears the whole warning
  set at capacity, re-warning the same session/route.
- `native-protocol.ts:79-92`: `isNativeState` bounds neither `items.length` nor
  item size, and replay clones/forwards the state per request.
- Native dry-runs return `{ kind: "dry-run" }` without
  `recordSuccessMetrics` (`run-smart-compact.ts:373-383`) while EESV records it
  (`:471-475`), so native dry-runs never appear in metrics.

### P1-6. Hindsight receipt handling: TOCTOU, stuck `unknown` states, ignored server operation id ✅

- `hindsight-memory.ts:353-379`: status checks and `deleteDocument` are not
  covered by one lock; a concurrent save can insert a `submitted` receipt, and
  the post-delete loop stamps `"deleted"` on **every** receipt present,
  clearing the new receipt's extraction-blocking state.
- `:309-321`: `updateReceiptState` calls sit outside `try/catch`; the sync lock
  throws immediately on contention (`fs.ts:131-136`), turning a completed retain
  into a tool error with the receipt left `submitted`.
- `:211-215` + `hindsight-receipts.ts:56-64,153-162`: a `not_found` status
  leaves `unknown`/`submitted` receipts open forever; at the 500-entry cap all
  saves are refused and the error message says "run smart_recall", which cannot
  clear them. An explicit operator reset/acknowledge path is missing (the
  resolve-side wording at `:546-552` is honest; the ledger-full wording is not).
- `hindsight-client.ts:316-334` returns the server-acknowledged `operation_id`,
  but `hindsight-memory.ts:291` discards it; a server-assigned id would make
  every later status check 404 → permanent `unknown`.
- `:448-456`/`:454`: `clean()`/`attr()` preserve `\n`/`\r`, so a hostile server
  can inject newlines into `fact.id`/`type`/`documentId`/metadata and forge
  provenance or `Ref:` lines in the untrusted-evidence block.

### P1-7. Context graph growth and indexing ✅

- `pruneProject`'s cap counts only `source <> 'manual'` rows and `closeContextMemoryByRef`
  (`context-graph.ts:995`) only flips status, so every resolved manual memory
  leaks its row, FTS copy and edges until an explicit `/smart-compact forget`.
- `context_edges` has an `ON DELETE CASCADE` FK on `to_id` but no index on it
  (`:262-275`; PK leads with `from_id`), so every node deletion scans the edge
  table.

### P1-8. UI consistency batch ✅ (each verified)

- `ui/metrics-report.ts:18`: percentile uses `floor(p/100·n)`; p95 over 20
  samples returns the maximum. Nearest-rank is `ceil(p/100·n) − 1`.
- `ui/home-overlay.ts:495-496`: every non-`native-hook` strategy is labeled
  "when idle", so `background` displays wrong next to Settings' "Prepare in
  background".
- `ui/settings-complex.ts:601-608`: mode-budget rows compute `currentValue` once;
  after editing through the nested list the outer row can still read
  "defaults". `:582-592` resets a promise without a rejection handler, unlike
  the other reset paths.
- `ui/home-overlay.ts:284-289`: readiness rejection is swallowed, leaving
  "checking" forever on failure.
- `register-smart-compact-command.ts:393-394`: `/smart-compact storage` writes
  only in `print` mode and is silent in RPC/SDK modes.
- `ui/metrics-dashboard-overlay.ts:243-282`: the dashboard pages with a
  hard-coded 24 lines and ignores terminal height, so ≤30-row terminals clip
  the position line and hints.

### P1-9. Doc/code drift introduced or left by this wave ✅

- `ARCHITECTURE.md:221` — "Automatic trimming … requires active
  `smart_context`" is not enforced: the automatic `turn_end` path
  (`register-smart-context-tool.ts:315-328`) checks hygiene/background and
  `canAutoTrim` only. With `toolLoading:"off"` trims can commit while no
  retrieval tool can read them back. Either gate on reachability (as
  `registerArtifactOffload` does) or correct the doc.
- `ARCHITECTURE.md:70-88` — the integration-surface table omits real surfaces:
  `before_agent_start` (`index.ts:646`), both `message_end` handlers
  (`index.ts:674`, `:686`), `session_start`, `model_select`,
  `session_before_switch`/`fork`, and the `input`,
  `cache_warming_decision`, `context_with_system` handlers.
- `src/infra/native-protocol.ts:294-296` — the `ponytail:` comment says "Codex
  also truncates the one that straddles it", but `:303` is
  `if (size > budget) break;`: an oversized newest user message aborts
  retention entirely; nothing is truncated. The annotation is wrong.
- Native engine backup omission is undocumented (see P0-4.3).

---

## P2 — Hot-path performance

Each item runs per provider request, per turn or per tool result. None is
catastrophic alone; together they add avoidable work to the extension's hottest
events.

| # | Where | Problem | Direction |
| --- | --- | --- | --- |
| P2-1 | `app/anchor-cache.ts:92-95`, `:235-246` | Config gate is checked *after* `listMarkers` walks every payload block; the same walk repeats 4–5 times per request. | Check config first; collect marker state once. |
| P2-2 | `app/register-navigation.ts:66-79`, `:229` | `context` handler runs `footer`, which scans the whole branch with `findLastIndex(anchorFromEntry)` per request. | Cache the newest anchor index keyed by leaf id. |
| P2-3 | `index.ts:650-654` | `before_agent_start` calls `nativeContinuity.take()` every turn: mkdir+chmod, cross-process lock, `readdirSync`, stat/read of every entry — usually finding nothing. | Short-circuit on `statSync(fileFor(scope))`. |
| P2-4 | `app/visual-archive.ts:140-154`; `index.ts:686-693`; `register-smart-context-tool.ts:256-263` | Visual `context` hook eagerly reduces all messages for token counts even when usage is known, and re-validates PNG frames per request; `message_end` converts every message before checking whether damage monitoring is active; `applyDeferredTrim` takes the branch before checking for a mark. | Gate before the expensive work; move cheap guards up. |
| P2-5 | `app/tool-artifacts.ts:142`; `utils/config.ts:83-94`; `app/background-preparation.ts:56,80` | `tool_result` pays `config()` per result even with offload disabled; `readGlobalConfigValue` re-reads/parses/validates settings.json per path (Settings walks dozens); background preparation deep-clones the branch and re-serializes the whole config. | Reuse the mtime cache; narrow getters; snapshot only what the pipeline reads. |
| P2-6 | `infra/hindsight-receipts.ts:148,224`; `app/hindsight-memory.ts:231-240`; `infra/native-protocol.ts:354`, `:155-160` | One confirmed save performs 5–8 full receipt parses and 2–3 pretty rewrites; native replay `structuredClone`s opaque state per request; Codex request bodies are fully buffered and `zstdDecompressSync`'d on the main thread. | One read-modify-write per save; clone only the injected block; bound/stream decompression or annotate. |
| P2-7 | `infra/context-graph.ts:495-510` | `latestLineageFact` runs a fresh `SELECT` + JS sort per fact; index-time work is quadratic at the 2,000-node cap, synchronously inside one transaction. | Snapshot lineage rows once per transaction and index by fact key. |

---

## Hygiene: dead code, duplication, unnecessary API

### Dead / unused ✅

- `markedAt` — `register-smart-context-tool.ts:70,380`; never read.
- `STAGES`, `Stage`, `STAGE_MODEL_PATH` — `ui/profiles.ts:192-199`; no
  references, and `settings-complex.ts:622-626` re-implements the same mapping
  as `STAGE_BY_SETTING`.
- `__resetTokenCalibrationForTests` (`utils/tokens.ts:181`),
  `__resetSessionLogCachesForTests` (`utils/session-log.ts:155`); no callers.
- `NativeToolSource`, `nativeStateOf` exports; no external users.
- `RemoteSaveOutcome`'s `"skipped"` variant (`app/hindsight-memory.ts:178`) is
  never produced.
- `isSessionActive` ≡ `isRunning` (`app/session-run-lock.ts:145-146`); the
  guard `pendingRef.peek(sessionId)?.sessionId === sessionId`
  (`register-smart-compact-tool.ts:133`) is tautological.
- Export-only test seams used solely by tests: `indexCompactionState`,
  `getContextGraphStats`, `appendLineLocked`, `trimFileTailLocked`,
  `readBackupContent`, `clearSynthesisCache`, `synthesisCacheSize`,
  `setDefaultServices`, `resetDefaultServices`, `_getMaxEntriesForTests`,
  `_resetGitRootCacheForTests`. Worth a convention: name, document, or move to
  a test helper.

### Duplication ✅

- NUL-joined SHA-256 of parts implemented three times:
  `infra/hindsight-receipts.ts:70`, `infra/context-graph.ts:308`,
  `infra/memory-ref.ts:33-54`.
- Message-stream hashing implemented twice: `app/pending-slot.ts:10-14` vs
  `utils/id-fingerprint.ts:30-37`.
- Four magnitude formatters: `ui/metrics-report.ts:25`, `ui/overlays.ts:283`,
  `app/host-cache-ledger.ts:156`, `ui/dashboard-format.ts:23`.
- `findGitRoot` wrapper shadows the canonical export
  (`utils/fingerprint.ts:103-105` vs `infra/git.ts:18`).
- `clean()` duplicated in `hindsight-memory.ts` and `context-graph.ts`;
  Mnemopi has none.
- Scripts: `commonPrefixChars`/`commonPrefixLength`, filler helpers.
- UI: ~250–350 LOC of list/scroll/editor behavior duplicated; `TextPanel`
  exported from `home-overlay.ts:77`, and `ScreenStack`/`Framed`/`TextArea`
  from `navigation-overlay.ts:73,150,220`, which `handoff-overlay.ts:13-15`
  imports — feature modules depend on each other for neutral primitives.

### Structural

- `native-compaction.ts:309-356` hand-builds a metrics snapshot that duplicates
  `steps/metrics.ts`'s builder and drifts (see P1-4).
- `ui/settings-overlay.ts:788-793` rebuilds all choice rows of a group once per
  row (N² item builds and N config reads per category open).

---

## Ponytail audit

Existing annotations (code comments beginning with `ponytail:`) were checked
against their code. They are generally accurate and valuable; the wave is
disciplined about marking ceilings. Exceptions and gaps:

- **Incorrect:** `native-protocol.ts:294-296` claims truncation that does not
  happen (P1-9).
- **Missing annotations for deliberate ceilings:** native compaction's absent
  backup; Mnemopi's per-operation Bun process spawn (documented as "bounded
  worker" in ARCHITECTURE but not cost-annotated); the bridge's
  "crash leftovers require explicit cleanup" lock policy, which is unsafe for a
  restart-durability feature; `extension-conflicts`'s known-extensions list is a
  snapshot that needs maintenance.
- **Accurate and useful examples to keep:** `tool-artifacts.ts:103` (bounded
  per-session scan), `background-preparation.ts:111` (one speculative task),
  `visual-archive.ts:17` (Latin/Turkish glyph ceiling),
  `domain/keywords.ts:9` (keyword-matching ceiling),
  `utils/state.ts:652` (goal identity), `file-needles.ts:99`.

---

## Volume context (not a finding)

- `src` 38.4k lines, `test` 31.9k, `scripts` 6.9k, `docs` 4.0k.
- #75's raw stat (+63,300) shrinks to ~12.4k real `src` insertions once
  whitespace is ignored (+9.1k test, +4.7k docs); 35 new `src` files.
- Rough wave surface: EESV core unchanged in behavior; new areas are memory
  backends (~3.3k), Home/Settings/navigation UI (~5k), navigation/anchor
  (~1.5k), artifacts (~0.9k), visual (~0.5k), RTK (57), eval/telemetry tooling
  (~7k).
- Each large surface is opt-in, gated and tested. Whether each earns its
  maintenance cost is a product decision; nothing reviewed here suggests a
  subsystem should be removed to fix a defect.

---

## Suggested fix order

**P0 quick wins (small diffs, high value):**
P0-1 tail copy · P0-3 fail-closed ledger · P0-6 readiness · P0-7 writeConfig +
inert row · P0-8 dashboard guard · P1-4/P1-5 native metric/runType/usage fixes ·
dead-code sweep (`markedAt`, stage mapping, unused seams) · P2-1/P2-4 guard
ordering.

**Next:**
P0-2 tombstone pruning · P0-4 native budget/estimate/backup · P0-5 bridge lease
and atomic write · P1-1 settle watchdog · P1-6 receipt reset path and locks ·
P1-7 edge index · P0-9 flake hardening.

**Later:**
P2-7 lineage query batching · UI primitives extraction · receipts
read-modify-write consolidation · documentation sync (ARCHITECTURE surfaces,
auto-trim reachability, native backup).

---

## Appendix A — `artifact-storage` reproduction

```
session file line 2 = 1.2 MB JSON (one tool result, as :45 documents)
→ inspectArtifactStorage():
   { scanComplete: false, sessionFilesScanned: 0, sessionFilesUnreadable: 1,
     owners[0].status: "unknown", owners[0].reasons: ["scan-incomplete"] }
```

Mirror of `eachSessionLine` on the same input yields a first "line" of
1,200,039 chars that fails `JSON.parse`, plus one empty trailing emit (skipped by
`scanSessionFile`). Root cause: `pending.push(chunk.subarray(...))` while
`chunk` is overwritten by the next `handle.read`.

## Appendix B — test evidence

- `bun run typecheck` (4 configs): clean at `6554063`.
- `bun test`: 1564 tests; 5 of 6 full runs green; 1 run failed
  `lifecycle-e2e > background compaction (stale-tail)` (308 ms).
- Isolated `bun test test/lifecycle-e2e.test.ts -t stale-tail`: pass.
- `bun test test/lifecycle-e2e.test.ts`: 13/13 pass.

## Appendix C — coverage limits

- EESV internals were not re-reviewed; this report does not claim they are
  defect-free.
- The UI sweep findings included here were individually re-checked against the
  code before inclusion; UI duplication estimates are approximate.
- Memory-backend findings marked ✅ were verified by reading the cited code
  paths; server-side behavior of Hindsight/Mnemopi was not exercised live.
- No fix in this report has been implemented or tested as a patch.
