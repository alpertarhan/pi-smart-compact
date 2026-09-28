# Recent-changes review: commits #76–#79, plus a bloat pass over #75

- **Date:** 2026-09-28
- **Reviewer:** Claude Opus 5.5 (model, `claude-opus-5-5`) running in Pi (harness)
- **Repository state:** `main` at `6554063` (`9.8.0-canary.7` + 4 commits)
- **Scope:**
  - Line-by-line: `9322923` → `6554063`
    - `fdcbc33`: economics, trim timing/scope, handoff, archive integrity, lineage evidence, replay-eval (#76)
    - `9f8a54a`: docs (#77)
    - `46c041a`: cache-warming-aware held trims, extension conflict notice, trim bench (#78)
    - `6554063`: background strategy trims only under pressure (#79)
  - Package and repository bloat only: `9322923` (#75, `9.8.0-canary.7`, +63k/−14k lines)
- **Lens:** possible bugs, performance gaps and anti-patterns, judged by the
  ponytail rule: each feature must justify its existence and its cost.
- **Method:**
  - Read the full diffs of #76–#79.
  - Ran `bun x tsc --noEmit` (clean).
  - Ran one full `bun test` (1564 pass / 0 fail, 120 files).
  - Checked Pi 0.87.1 host types in `node_modules` (`Usage.cacheWrite1h`, `SessionManager.inMemory`, `turn_end.outcome`).
  - Ran `npm pack --dry-run` to measure package contents.

**Verification legend:** ✅ verified directly (types, tooling output, grep) · 🔍 code reading only, not reproduced

**Not reviewed:**
- The EESV core (`phases/*`, `utils/extraction.ts`, `utils/state.ts`).
- The #75 feature modules beyond packaging: native compaction, memory backends, navigation UI.
- Scripts under `scripts/task-eval*` and `scripts/replay-eval*`. They were only sized, not read.

A missing finding in those areas is not evidence of correctness.

---

## Bugs

### B1: A cold-applied trim is dropped on non-committing `turn_end` paths, flipping the cached prefix (medium–high) 🔍

`src/app/register-smart-context-tool.ts:302-320`

- `turn_end` sets `applied = null` unconditionally at the top.
- It only restores the value in the contested-boundary branch (`event.entries.length || pendingMessages.length`).
- Every other early return discards it:
  - `outcome !== "completed"`
  - `isPaused` (pending pivot)
  - `!enabled`
  - `canAutoTrim === false` (background work, a staged candidate or a running compaction)
- `mark` survives, so the next `context_with_system` re-evaluates coldness. In Pi, an aborted or errored turn still appends an assistant message with a fresh timestamp. The cache therefore looks warm, the next request goes out **untrimmed**, and the prefix the aborted request just cached (the trimmed one) is rebuilt. This is exactly the flip the held-trim design exists to avoid.
- `test/context-control.test.ts:1037` ("keeps nothing from an aborted turn…") passes only because its harness does not append an assistant message for the aborted turn.

**Direction:**
- Do not clear `applied` at the top.
- Drop it only when it commits (`entries = pending.entries`), when `unchangedSince` fails, or when an explicit request supersedes it.
- Add a test whose aborted turn appends an assistant message.

### B2: Cold check can treat a 1 h-retention prefix as 5 min (low–medium) 🔍 / ✅ types

`src/app/register-smart-context-tool.ts:267`

- `cacheLifetimeMs(message.usage)` reads only the last assistant message.
- `Usage.cacheWrite1h` is reported only on requests that wrote 1 h cache. Two cases lose that signal:
  - an aborted or zero-usage message
  - a request with `cacheWrite = 0`
- In both cases the lifetime falls back to 5 min, and the held trim is applied while the 1 h prefix is still warm.
- `host-cache-ledger.ts` already solves this: it keeps the lifetime of the last request that *wrote* cache.

**Direction:** reuse that rule. For example, walk back to the last assistant with `cacheWrite > 0`, or share the ledger's lifetime.

### B3: Conflict notice is truncated, and fires every session for `pi-toolkit` users (low–medium) ✅

`src/app/extension-conflicts.ts`, `src/utils/issues.ts:49`

- `formatIssueMessage` caps messages at `MAX_MESSAGE_CHARS = 400`.
- `conflictNotice` exceeds that with two or more conflicts. The actionable tail ("Keep only one loaded (Pi: /settings › packages…)") is the part that gets cut.
- `pi-toolkit`'s `context` tool is on the list. Delivery is deduplicated per session only, so any setup that loads `pi-toolkit` (including the reviewer's) gets a warning on every new session.

**Direction:**
- Put the action first and the evidence last, or drop the evidence list.
- Reconsider listing `pi-toolkit` (see A3).

### B4: Control flow keyed on user-facing text (low) ✅

`src/index.ts:254`

`noteForeignCompaction` branches on `actor.startsWith("Another")`. Rewording the message changes behavior.

**Direction:** pass an explicit `kind: "extension" | "native"`.

### B5: Redundant ledger resets on `before_switch` / `before_fork` (low) ✅

`src/index.ts:398,400`

- Both resets use the *outgoing* session id, and they wipe the ledger before a switch that may still be cancelled.
- The ledger `message_end` handler (`src/index.ts:677`) already resets on a session-id mismatch.

**Direction:** delete both calls.

### B6: Misleading "superseded: read again" note (low) 🔍

`src/app/context-operations.ts` (`supersededResults`)

An old read is annotated as reread even when the later full read is itself old and trimmed in the same plan. The text is still retrievable, but the note implies a live copy exists.

### B7: Break-even formula ignores the first request's own saving (low) 🔍

`src/app/context-operations.ts` (`trimBreakEvenRequests`)

- The first trimmed request costs `w·T` instead of `r·(T+X)`, so it already saves `r·X`.
- The exact break-even is therefore `N* = (w−r)·T / (r·X) − 1`.
- The error is conservative (it errs toward holding), but the doc comment states the formula as exact.

---

## Performance gaps

### P1: Automatic hygiene rescans the whole session every turn (medium) 🔍 / ✅ bench scope

`src/app/register-smart-context-tool.ts` `turn_end`, `src/app/context-operations.ts`

- Since #78/#79, with `contextHygieneEnabled` on, `planContextTrim` runs at **every** `turn_end`, with no pressure gate.
- One call builds three projections (`toolGroups` → `buildSessionProjection`, `planContextTrim`'s own, `inspectContext`) plus a full `supersededResults` pass.
- While a trim is held, `mark` is cleared and recomputed each turn. That repeats `trimTokens`, which JSON-stringifies and estimates the entire rebuilt tail.
- Cost grows linearly with session length on every turn.
- `bench/hot-paths.bench.ts` covers only `planContextTrim` over 120 reads (25 ms budget). It does not cover `trimTokens` or long sessions.

**Direction:**
- Build the projection once and pass it down.
- Skip re-planning and re-pricing while the held `leafId` is unchanged.
- Bench a large branch that includes `trimTokens`.

### P2: `scope=lineage` re-reads every parent on every call (medium) 🔍

`src/app/session-lineage.ts`, `src/app/context-evidence.ts`

- Each `smart_context status|search|read scope=lineage` call does the following, with no caching:
  - stat, read and parse up to `LINEAGE_MAX_DEPTH` (3) × `LINEAGE_MAX_FILE_BYTES` (64 MB)
  - build `SessionManager.inMemory` for each parent
  - rebuild full evidence maps
- Reading a single id loads the entire chain.

**Direction:**
- Memoize by `(file, size, mtimeMs)`.
- For `read`, stop at the first scope that owns the id.

---

## Anti-patterns / necessity (ponytail)

### A1: Cold-cache trim + warming veto is the most fragile code in the wave

`src/app/register-smart-context-tool.ts`

- Five mutable closure states (`queued`, `staged`, `mark`, `applied`, `warm`) must stay consistent across seven events: `context`, `context_with_system`, `message_end`, `cache_warming_decision`, `turn_end`, and the `session_*` hooks.
- Outgoing messages are rewritten before commit on the assumption that the rewrite is byte-identical to the host's future `context_edit` projection.
- The mechanism is about 150 lines, all to save *estimated* cache cost. B1 and B2 both live here.
- Pressure-driven trims plus the break-even rule already cover the common case.

**Recommendation:**
- Keep this path only if `replay-eval` shows a measurable net saving over pressure + break-even.
- Otherwise delete it: `mark`, `applied`, `warm`, `applyDeferredTrim`, `vetoWarming`, `DeferredTrim`, `formatDeferredTrim` and the Home cleanup-row text.

### A2: Host cache ledger is diagnostics-only, but its plumbing spreads across modules

`src/app/host-cache-ledger.ts` (~180 lines) plus ~50 lines of plumbing:
- `staged` / `confirmStaged`
- `onContextEdit` in two registrars
- `onCacheWarm`
- a second `message_end` handler in `index.ts`

Tests add ~230 lines.

- It feeds no decision. Its only outputs are 1–3 Home lines and one heuristic warning, which classifies a request as a rebuild when uncached tokens reach `max(16 384, 50 % of prompt)`.

**Recommendation:**
- Delete it unless a concrete decision will consume it.
- If it stays, drop `staged` / `confirmStaged`: attributing at staging time is accurate enough for a diagnostic.

### A3: Static third-party name list duplicates runtime evidence

`src/app/extension-conflicts.ts` (83 lines)

- It hard-codes competitor package, command and tool names (`pi-dcp`, `pi-fold`, `context-fold`, `pi-toolkit`, …).
- `noteForeignCompaction` in `index.ts` already detects the harmful case, a foreign compaction applied, from real lifecycle evidence.
- The list needs maintenance forever and produces B3.

**Recommendation:** delete the list and rely on runtime detection. If context-editing extensions must be flagged, do so only from observed foreign `context_edit` entries.

### A4: Archive SHA-256 records defend against hand-edited session JSONL

`src/app/context-operations.ts` `controlData`, `inspectContext`, `planContextRewind`, `readContextReference`; `EvidenceSource.hashed`

- The threat model is narrow: a user editing their own session file.
- The price:
  - a dense one-expression validator in `controlData`
  - a new `hashed` field exposed in `status`
  - mismatch branches in rewind and read

**Recommendation:** either drop it (YAGNI), or keep it and split the validator into a named, readable function.

### A5: Small duplications and leaks

- Two token formatters were written in the same diff: `register-smart-context-tool.ts:56` and `host-cache-ledger.ts:156`.
- `__resetProcessCalibrationForTests` is exported from production `src/infra/services.ts`.

### A6: Large-window readiness warning nags

`src/app/effective-state.ts:68`

Every user of a model window above 400k tokens sees a *warning* until they set `maxContextTokens`. It is informational, so it belongs in the effective-state lines, not in `warnings`.

### A7: Tool schema and docs grow with every feature

- The `smart_context` tool description and the new `scope` parameter are sent in **every provider request**. Each feature added there is a per-request token cost for every user.
- #77 ("cover … on every user-facing surface") copies the same feature text into 8 places: README, guide, configuration, evaluation, ARCHITECTURE, SKILL, CHANGELOG and tool descriptions. That guarantees drift.

**Recommendation:**
- Keep tool descriptions minimal and stable.
- Give each feature one canonical doc and have other surfaces link to it.

---

## #75 (`9.8.0-canary.7`): package and repository bloat

### C1: Optional dependencies install for everyone ✅

`package.json`

- `optionalDependencies` contains `bun` (1.4.2), `@oh-my-pi/pi-mnemopi` and `@resvg/resvg-js`.
- npm installs optional dependencies by default, so every user downloads a Bun runtime and native renderer.
- Only the Mnemopi memory backend and visual archive need them.

**Recommendation:** make them `peerDependencies` with `peerDependenciesMeta: { optional: true }` and report a clear error when a feature needs a missing one.

### C2: Dated research and pilot documents ship in the npm package ✅

- `files` includes `docs`, so `npm pack` ships ~120 KB of dated material:
  - `context-hygiene-2026-09-24.md`
  - `hindsight-native-compaction-research-2026-09-24.md`
  - `session-pilot-2026-09-24.{md,json}`
  - `visual-pilot-2026-09-24.{md,json}`
  - `provider-evaluation-2026-08-06.md`
- Totals: 269 files, 845 kB packed, 2.4 MB unpacked.
- This `findings/` folder will ship too unless it is excluded.

**Recommendation:** narrow `files` to user docs (`guide`, `configuration`, `hindsight-memory`, `MIGRATING_TO_V8`, assets).

### C3: One-shot scripts and evidence committed to the repo ✅

- Five pilot scripts are not wired into `package.json` and are referenced only by dated docs. Together they are ~1.7k lines:
  - `scripts/native-host-pilot.ts`
  - `scripts/session-pilot.ts`
  - `scripts/visual-pilot.ts`
  - `scripts/rtk-pilot.ts`
  - `scripts/context-compat-pilot.ts`
- `task-eval-reports/item14-cost-evidence-2026-09-25/` (~20k lines of JSON) is force-included by a `.gitignore` exception.
- The `task-eval*` harness (~3.5k lines plus a Dockerfile) is not part of `release:check`.

**Recommendation:** move pilots and dated evidence to a branch, a release asset or a separate repository. Keep in `main` only what CI or the release gate runs.

---

## What is good

- `compactionUsage` (`src/domain/compaction-usage.ts`) is small and correct. It refuses to mix estimated and provider-reported usage.
- `maxContextTokens` is applied consistently through one helper (`effectiveContextWindow`), and hard headroom checks correctly keep using the real window.
- Handoff reuses existing pieces (`executeRecall`, `renderContinuityCapsule`, navigation overlay primitives) instead of re-implementing them.
- The trim marker digest is deterministic and bounded, and it is surrogate-safe.

## Suggested order

1. B1 (with a realistic aborted-turn test), B2, B5: small diffs, real cost impact.
2. Decide A1 and A2. Deleting both removes ~400 lines and the root of B1/B2.
3. A3, C1, C2: user-visible noise and install size.
4. P1, P2.
