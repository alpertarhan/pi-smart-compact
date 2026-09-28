# Recent-changes ponytail review — commits #75–#79 (`9.8.0-canary.7` wave)

- **Date:** 2026-09-28
- **Reviewer:** Muse Spark 1.3 Contributor (model, `muse-spark-1.3-contributor`) running in Pi Coding Agent (harness)
- **Repository state:** `main` at `6554063` (`9.8.0-canary.7` + 4 commits), plus uncommitted `docs/README.md` findings section and untracked `docs/findings/`
- **Scope:** `4754047` (v9.7.1) → `6554063`
  - `9322923` — Pi Continuity 9.8.0-canary.7: session navigation, on-demand tools, native compaction, memory backends (#75)
  - `fdcbc33` — economics, trim timing/scope, handoff, archive integrity, lineage evidence, replay-eval (#76)
  - `9f8a54a` — docs (#77)
  - `46c041a` — cache-warming-aware held trims, extension conflict notice, C9 invariant test, trim bench (#78)
  - `6554063` — background strategy trims only under pressure without `contextHygieneEnabled` (#79)
- **Lens:** ponytail — possible bugs, performance gaps, anti-patterns; every feature must justify its existence and its cost. Explicit question from the maintainer: is this bloated or an AI-slop ecosystem shaped around compaction?
- **Method:** full-stat review of #75–#79; line-level reading of `register-smart-context-tool.ts` (hold/veto/`turn_end`), `extension-conflicts.ts` (full), `session-lineage.ts` (full), `session-handoff.ts` (partial), `context-operations.ts` / `host-cache-ledger.ts` / `replay-eval-lib.ts` (entry points via grep); `ponytail:`/`TODO` sweep over `src/`; constants/config surface sizing. Cross-read against the two parallel reports already in `docs/findings/` (deepseek, claude) and the glm ponytail report where they overlap — agreements are noted, new items are mine.
- **Not run:** `bun test` (timed out at 60 s in this session), `typecheck`, `bench`. No live Pi session, no Hindsight/Mnemopi server.

**Verification legend:** ✅ verified directly (read/grep output in hand) · 🔍 code reading only, not reproduced · 🤝 agrees with a parallel report I did not independently reproduce

**What was not reviewed line-by-line:** EESV core (`phases/*`, `utils/extraction.ts`, `utils/state.ts`); `infra/context-graph.ts` and `infra/hindsight-*` internals; `native-compaction.ts` / `native-protocol.ts` beyond entry points; UI overlay files beyond structure; `scripts/task-eval*` bodies. A missing finding in those areas is not evidence of correctness.

**Verdict.** Not slop. Invariants are written down (C9: assistant content never rewritten, `test/context-invariants.test.ts`), features are gated and opt-in, deliberate ceilings carry `ponytail:` annotations, and the #79 commit message shows the team re-running evaluators and reverting over-eager behavior. The real exposure is **breadth, not quality**: `src/` is ~38k lines, this wave added 35 new `src` files, and trim timing is now a 4-event mini-scheduler (`context`, `context_with_system`, `message_end`, `cache_warming_decision`, `turn_end` in one 442-line module). Nothing here needs deletion to fix a defect, but three subsystems are one feature away from needing a split, and the dead-code/duplication backlog below is real.

---

## P0 — Defects (narrow fixes, real user-visible impact)

### P0-1. `markedAt` is written but never read ✅

**Evidence:** `src/app/register-smart-context-tool.ts:70` (interface field), `:380` (only write: `markedAt: now()`). `grep -rn "markedAt" src/` returns exactly these two lines.

**Impact:** dead field on the held-trim record; confuses the next reader about ordering semantics (coldness is actually evaluated from branch leaf + message timestamps, not this field).

**Fix direction:** delete the field. 2-line diff.

### P0-2. #79's early return can drop an already-applied held trim 🔍 (🤝 claude B1 covers the wider variant)

**Evidence:** `src/app/register-smart-context-tool.ts:315-328`. `pending = applied; applied = null` is taken at the top of `turn_end`, but the new `if (!hygiene && !pressure) return;` exits without restoring `applied = pending` — while the contested-boundary branch at `:333-337` does restore it (`if (!request && pending?.sessionId === sessionId) applied = pending`).

**Impact:** reachable when `contextHygieneEnabled` is turned off after a mark was held and a cold request already carried the trim: the visible trim flips back and is never committed until pressure returns or the setting is re-enabled. Exactly the prefix-flip the held-trim design exists to avoid.

**Fix direction:** preserve `pending` before the early return, or commit what a live request already carried.

### P0-3. Warming-veto math over-subtracts while the comment claims exactness ✅

**Evidence:** `src/app/register-smart-context-tool.ts:284-299`. The docstring says after a cold miss the request "really costs `missCost − w·X`", but the avoided miss cost is `(w−r)·X` (`missCost` already nets out the cache read — cf. Pi's `cache-warmer.js` `evaluate()`). The subtraction `mark.savedTokens * price` is `w·X`, overstating the saving and making the veto slightly more aggressive; ignoring later per-request `r·X` savings biases the other way.

**Impact:** low per-decision, but the `$0.05` rule (`CACHE_WARMING_MIN_SAVINGS_USD`, `src/constants.ts:44`) is presented as principled while its key input is approximate in an undocumented direction.

**Fix direction:** state the approximation and its direction in the docstring; optionally use `(w−r)·X`.

### P0-4. Native metrics snapshot is hand-rolled and drifts from the EESV builder ✅ (🤝 deepseek P1-4)

**Evidence:** `src/app/native-compaction.ts:321-322` hardcode `avgLatency:0`/`cacheHitRate:0` while cache tokens are recorded; `:347` sets `providerRoutes[0].avgLatencyMs` to whole-pipeline duration (`:298`); `runType` checks `autoTriggered` first (`:328`) while `app/steps/metrics.ts:52-57` checks `skipCompact` first — the `smart_compact` tool (both flags) records as `"auto"` natively, `"tool"` on EESV. Verified by reading, not executed.

**Fix direction:** reuse `buildSuccessMetrics`; align `runType` precedence.

### P0-5. Auto-trim reachability is documented but not enforced ✅

**Evidence:** `ARCHITECTURE.md:221` says automatic trimming "requires active `smart_context`", but the automatic `turn_end` path (`register-smart-context-tool.ts:315-328`) gates only on hygiene/background + `canAutoTrim`. With `toolLoading:"off"`, trims can commit while no retrieval tool can read them back (`readContextReference`, archived-output reads become unreachable).

**Impact:** medium-low (trim content is recoverable via rewind records, but the documented invariant is false).

**Fix direction:** gate on tool reachability (as `registerArtifactOffload` does) or correct the doc.

---

## P1 — Behavior and consistency risks

### P1-1. `vetoWarming` + `mark.warmingStopped` is one-directional state 🔍

Once `vetoWarming` returns true, `mark.warmingStopped = true` is set (`register-smart-context-tool.ts:252-255`) and `formatDeferredTrim` advertises it. If the held trim later goes stale (`unchangedSince` fails, mark cleared), nothing re-enables warming — Pi keeps `stop` for a trim that will never land. Check whether `cache_warming_decision` callers re-arm automatically per request; if the `stop` is sticky per session, this needs a reset on `mark = null`.

### P1-2. `unchangedSince` is O(n) per event and runs on every `context_with_system` 🔍

`register-smart-context-tool.ts:75-79`: `branch.findIndex` + `slice().some()` over three entry types, executed on every request carrying a system prompt while a mark is held. Correct but linear; fine at current branch sizes, worth a leaf-index cache if branches grow (see P2).

### P1-3. `extension-conflicts.ts` known-list is a snapshot needing maintenance ✅ — keep, don't expand

Verified full file (83 lines): exact command/tool names + whole path segments, never substrings (`segments()` splits on `[\\/:]+`, strips `@version` and extensions); Continuity's own entries excluded; unknown extensions not claimed; registry errors tolerated by the caller. This is the right ceiling — a heuristic, honestly labeled ("Name-based evidence, not proof"). Do NOT grow it into a blocklist or a fuzzy matcher; the maintenance cost would exceed the value. One gap to annotate: `bareFold` disambiguation (`fold` → `context-fold` iff `context-fold` already found, else `pi-fold`) silently attributes an ambiguous name; fine, but it deserves a one-line comment.

### P1-4. `session-lineage.ts` bounds are right ✅ — keep as is

`LINEAGE_MAX_DEPTH=3`, `LINEAGE_MAX_FILE_BYTES=64 MiB`, absolute-path-only, cycle-safe via `seen`, `SessionManager.inMemory` (never opened through Pi, never written), abort-aware. Model ceiling for a file-walking feature. No finding; cited so absence isn't mistaken for non-review.

### P1-5. Handoff seed cap cuts recall first, never header/pointers ✅ — correct priority

`session-handoff.ts` (partial read: interfaces, `collectHandoffSources` head, constants `HANDOFF_MAX_CHARS=16_000`, `HANDOFF_RECALL_LIMIT=5`): ordering note → anchor → ledger → pinPaths → recall → parent pointers, scrubbed once, branch render failures skipped not fatal. The "with no anchor, ledger or note, nothing opens" guard prevents empty-session spam. No finding on the reviewed portion; `prepareHandoff`/`openHandoff` split and overlay wiring not reviewed.

---

## P2 — Hot-path performance (per-request / per-turn / per-tool-result)

None catastrophic alone; together they tax the extension's hottest events. All ✅ (grep/read verified locations, costs reasoned not benchmarked — except the committed trim bench below).

| # | Where | Problem | Direction |
| --- | ----- | ------- | --------- |
| P2-1 | `app/anchor-cache.ts:92-95`, `:235-246` | Config gate checked *after* `listMarkers` walks every payload block; same walk repeats 4–5×/request | Check config first; collect marker state once |
| P2-2 | `app/register-navigation.ts:66-79`, `:229` | `context` handler runs `footer` → full-branch `findLastIndex` per request | Cache newest anchor index keyed by leaf id |
| P2-3 | `index.ts:650-654` | `before_agent_start` runs `nativeContinuity.take()` every turn (mkdir+chmod+lock+readdir+stat), usually finding nothing | Short-circuit on `statSync(fileFor(scope))` |
| P2-4 | `app/visual-archive.ts:140-154`; `index.ts:686-693`; `register-smart-context-tool.ts:256-263` | Eager token reduce / PNG re-validation / branch fetch before cheap guards (usage known? damage monitoring on? mark present?) | Move cheap guards above expensive work |
| P2-5 | `app/tool-artifacts.ts:142`; `src/utils/config.ts:83-94` | `config()` per tool result even with offload off; `readGlobalConfigValue` re-reads/parses/validates settings.json per path | Reuse mtime cache; narrow getters |
| P2-6 | `src/utils/config.ts` 883 lines; `src/constants.ts` 428 lines | Config + constants are the two largest non-pipeline files; every new feature adds keys, bounds, and a settings row | Budget: new settings must reuse existing rows/bounds or justify a new one in the PR |
| P2-7 | `infra/context-graph.ts:495-510` (🤝 deepseek P2-7) | `latestLineageFact` fresh SELECT + JS sort per fact; quadratic at 2,000-node cap inside one sync transaction | Snapshot lineage rows once per transaction, index by fact key |

Counterweight (credit where due): #78 added a real trim bench — 120 archived reads, 560-entry/2.3 MB branch, median 2.4 ms / p95 4.7 ms vs 25 ms limit (`bench/hot-paths.bench.ts`, +34 lines). Hot-path claims now have a number. Keep this pattern: any new per-request work should extend that bench, not ship with prose.

---

## Hygiene — dead code, duplication, unnecessary API

### Dead / unused ✅ (all grep-verified, zero callers)

- `markedAt` — `register-smart-context-tool.ts:70,380` (P0-1).
- `STAGES`, `Stage`, `STAGE_MODEL_PATH` — `ui/profiles.ts:192-199`; `settings-complex.ts:622-626` re-implements the mapping as `STAGE_BY_SETTING`.
- `__resetTokenCalibrationForTests` (`utils/tokens.ts:181`), `__resetSessionLogCachesForTests` (`utils/session-log.ts:155`).
- `RemoteSaveOutcome` `"skipped"` variant (`app/hindsight-memory.ts:178`) never produced.
- `isSessionActive ≡ isRunning` (`app/session-run-lock.ts:145-146`); `pendingRef.peek(sessionId)?.sessionId === sessionId` (`register-smart-compact-tool.ts:133`) tautological.
- Export-only test seams used solely by tests (`indexCompactionState`, `getContextGraphStats`, `appendLineLocked`, `trimFileTailLocked`, `readBackupContent`, `clearSynthesisCache`, `synthesisCacheSize`, `setDefaultServices`, `resetDefaultServices`, …). Convention wanted: `// test-only` marker or a test-helper home.

### Duplication ✅

- NUL-joined SHA-256 of parts ×3: `infra/hindsight-receipts.ts:70`, `infra/context-graph.ts:308`, `infra/memory-ref.ts:33-54` → one helper.
- Message-stream hashing ×2: `app/pending-slot.ts:10-14` vs `utils/id-fingerprint.ts:30-37`.
- Magnitude formatters ×4: `ui/metrics-report.ts:25`, `ui/overlays.ts:283`, `app/host-cache-ledger.ts:156`, `ui/dashboard-format.ts:23` → one.
- `findGitRoot` wrapper shadows canonical export (`utils/fingerprint.ts:103-105` vs `infra/git.ts:18`).
- `ScreenStack`/`Framed`/`TextArea` exported from `navigation-overlay.ts:73,150,220` and imported by `handoff-overlay.ts:13-15` — feature modules depending on each other for neutral primitives. Extract UI primitives to one module before the third consumer arrives.
- `ui/settings-overlay.ts:788-793` rebuilds all choice rows of a group once per row (N² item builds + N config reads per category open).

---

## Ponytail audit

**Existing `ponytail:` annotations (6 in `src/`)** — 5 accurate and worth keeping (`tool-artifacts.ts:103` bounded scan; `background-preparation.ts:111` one speculative task; `visual-archive.ts:17` glyph ceiling; `domain/tool-semantics.ts:68` conservative allowlist; `utils/state.ts:652` goal identity). 1 wrong: `infra/native-protocol.ts:295` claims "Codex also truncates the one that straddles it" but `:303` is `if (size > budget) break` — abort, not truncation. Fix the comment.

**Missing annotations for deliberate ceilings:** native compaction's absent backup; `extension-conflicts` known-list snapshot maintenance; replay-eval's ~4× absolute-estimate error (documented in `docs/evaluation.md` as deltas-only — good — but the script itself should print the caveat on every run, not rely on the doc being read).

**Does each big-ticket item earn its keep?**

| Subsystem | Verdict |
| --------- | ------- |
| Held-trim / break-even / cold / warming-veto (#76+#78) | Keep. Solves a measured problem (every auto-trim rewrote a warm cache). But STOP here: 4 timing mechanisms is the ceiling. Any 5th (e.g. per-model tuning) must replace, not add. |
| Handoff + lineage (#76) | Keep. No model-written summaries, recorded-state-only seed, hard caps, honest empty-guard. Textbook ponytail feature. |
| Extension conflicts (#78) | Keep. 83 lines, advisory only, honestly labeled. Freeze its ambition. |
| Host cache ledger (#76) | Keep, watch. Justified (attributes rebuilds: continuity/idle-expiry/foreign), but it is a second cache model next to Pi's own — drift risk. One owner, one metric definition. |
| replay-eval (#76) | Keep as advisory tooling, never a gate. Deltas-only is load-bearing; print the caveat in the script output. |
| Archive SHA-256 + verify-on-read (#76) | Keep. Integrity refusal beats silent corruption; cost is one hash at plan time. |
| Superseded-first trim ordering (#76) | Keep. Pure ranking change inside the existing 32-output cap — zero new surface. This is the ideal shape for future trim work: better ordering, same budget. |
| `maxContextTokens` (#76) | Keep. A cap behind every percentage gate is a guardrail, not a feature. |
| Settings/Home/navigation UI (~5k incl. #75) | Watch. Largest surface in the wave. The inert "This branch" row (deepseek P0-7) and N² settings rebuild above suggest velocity exceeded review here. Next UI PR should be deletion/refactor-only. |

**Bloat test (ladder):** nothing reviewed fails rung 1 ("need to exist at all?") — every subsystem traces to a named failure (warm-cache rewrites, unresumable sessions, conflicting extensions, unreadable trims, unmeasurable policy). The risk is rung-2/3 drift: second cache models, second metric builders, fourth hash helpers. The fix is consolidation PRs, not deletions.

---

## Suggested fix order

**Quick wins (small diffs, high value):** P0-1 `markedAt` · P0-2 #79 restore · P0-3 veto comment · wrong `ponytail:` comment (`native-protocol.ts:295`) · `bareFold` one-line comment · dead-code sweep (`STAGES`, unused resets, tautological guards) · P2-1/P2-4 guard ordering.

**Next:** P0-4 native metrics builder · P0-5 reachability gate-or-doc · P1-1 warming re-arm · hash/formatter/`findGitRoot` consolidation · UI primitives extraction · settings N² rebuild.

**Later / other owners:** deepseek P0-1…P0-5 (storage chunk views, tombstone pruning, receipt fail-open, native budget/backup, bridge lock) — agreed on reading, not independently reproduced here; deepseek P1-6 receipt TOCTOU; P2-7 lineage batching.

---

## Appendix A — scope notes

- `src/` ≈ 38.4k lines across 119 `.ts` files; `test/` 120 files; `scripts/` eval ecosystem ~7k (replay-eval-lib 316 lines, replay-eval 116 lines — sized, not read).
- `src/utils/config.ts` (883) and `src/app/register-smart-compact-command.ts` (714) are the largest files; both grow monotonically with settings/commands — the natural bloat front to watch.
- `bun test` not run in this session (60 s timeout); test counts cited (1564) are from the parallel reports against the same revision `6554063`.
- No finding in this report has been implemented or tested as a patch.

## Appendix B — relation to the other findings reports

- Agree with deepseek P1-4 (native metrics), P2-1…P2-7 direction, dead-code/duplication lists — re-verified the items marked ✅ above, took the rest on reading.
- Agree with claude B1's wider variant of my P0-2 (all early-return paths, not just #79's); my report adds the minimal #79-specific trigger.
- P0-3 (veto math), P0-5 (reachability doc/code drift), P1-1 (warming re-arm), and the subsystem keep/watch table are new to this report as far as I checked.
