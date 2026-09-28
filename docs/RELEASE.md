# Release checklist

Use this checklist before publishing Pi Continuity as the npm package
`pi-smart-compact`. The package name, command, tool names and configuration
key do not change with the documentation brand.

> **Stop condition:** validation, packing, and isolated installation are safe.
> `npm publish`, Git tags, GitHub releases, and deployment require separate
> explicit approval. The automated checks never perform them.

Evidence classes and their limits are defined in
[evaluation](./evaluation.md#offline-and-live-evidence). Keep the unpublished
checkout version and the version currently on npm distinct in every note.

## 1. Prepare the candidate

- [ ] Use a distinct prerelease version (for example `9.8.0-canary.8`) until
      the stable/canary gates pass; stamp it in `package.json` and sync
      `src/constants.ts` before packing.
- [ ] Move shipped notes from `[Unreleased]` into the dated version in
      `CHANGELOG.md`; never word a candidate entry as if the final release
      check or canary promotion already passed.
- [ ] Update the guide, configuration, evaluation, architecture and migration
      notes for behavior/config changes. Dated reports (`docs/reports/`) stay
      historical and are not packed; add a new report or addendum instead of
      rewriting them.
- [ ] For Claude subscription routes, pair the fresh candidate with the exact
      `pi-claude-oauth-adapter` build used in the proofs (published `0.2.2`
      plus the final-payload patch, [upstream PR #10](https://github.com/minzique/pi-claude-oauth-adapter/pull/10),
      until it is released) and record
      the paired archive paths and hashes at final packaging — do not
      reconstruct them from memory. pi-toolkit's auto-context must not be
      loaded with the candidate.
- [ ] Confirm Pi remains a host peer (`">=0.87.1"`) and TypeBox a wildcard peer (`"*"`); neither is bundled.
- [ ] Confirm the visual renderer remains optional/external and the font plus its license ship in `assets/`. Verify default Node loading without the optional addon and a real PNG render where supported.
- [ ] Confirm Mnemopi stays an optional external engine with TypeBox external in its worker, and that `bun`, `@oh-my-pi/pi-mnemopi` and `@resvg/resvg-js` remain optional peers pinned to `OPTIONAL_COMPONENTS` (never `optionalDependencies`). Verify a plain install pulls none of them in, the failure names the install command for the install root, the installed Node-host worker runs on the user-installed `bun` component under a Pi-style npm root with no Bun on `PATH`, and the fail-closed missing-engine and missing-Bun failures submit no memory request and create no store.
- [ ] Confirm no secrets, local JSONL, SQLite data, backups, or generated
      credentials are tracked or packed.

## 2. Run the deterministic release gate

```bash
bun install --frozen-lockfile
bun run release:check
```

`release:check` runs the full local chain: source, scripts, test and bench
typechecking; all tests; the adversarial `gate`; the hot-path `bench`; build;
`release:audit`; and `compat:pi latest`. The audit verifies the packed
manifest/version/peers, supported SECURITY major, package contents
(runtime-only `dist`: exactly `index.js`, `rtk.js`, and `mnemopi-worker.js` plus
declarations), isolated and frozen installs, extension/tool registration, Node
SQLite, and the optional Mnemopi worker through real Node-host tools. It also
runs the installed worker under a Bun-free `PATH` on the user-installed
pinned `bun` component (installed with the command Readiness shows into a
Pi-style npm root, then kept across a Pi update) and checks the
install-command, missing-engine and missing-Bun negatives (no store, no
model/network request). Evaluation and report CLIs are source-checkout tools,
not packed: the audit runs `scripts/provider-eval.ts`,
`scripts/telemetry-report.ts`, and all four offline continuation/memory arms of
`scripts/task-eval.ts` under its isolated HOME; scripted transport is not
live quality evidence. The test suite covers storage durability with real
`SessionManager` artifacts aged past 20 days by timestamps — deterministic
aging, not a wall-clock soak — through actual reload and fork.

Run the full chain on the exact candidate. A green result from before any
later change, including UI or documentation edits, does not count. Pull-request
CI includes the adversarial gate, but latest-Pi compatibility runs only on a
schedule or manual dispatch, so a green CI badge does not replace this step.

Then validate the host boundary in an isolated workspace:

```bash
bun run compat:pi 0.87.1
bun run compat:pi latest
bun audit
```

The compatibility runner temporarily pins only its copied workspace; source
peer ranges and minimum-version development pins must remain unchanged.

## 3. Inspect artifacts

```bash
npm pack --dry-run
bun run provider-eval --min-samples=5
bun run telemetry-report --min-canary-runs=20
bun run task-eval --out=/tmp/psc-task-eval-new
```

Check that:

- [ ] packed files are limited to `dist`, `docs`, `assets`, README, LICENSE,
      CHANGELOG, SECURITY, SUPPORT, ARCHITECTURE, and package metadata;
- [ ] `dist` holds only `index.js`, `rtk.js`, `mnemopi-worker.js`, and
      declarations — no evaluation/report CLI bundles;
- [ ] the extension registers `smart_compact`, `smart_context`,
      `smart_recall`, and `smart_save_memory` from the packed install;
- [ ] no provider route was selected automatically;
- [ ] Data Confidence is honest (legacy evidence may keep it below 85).

The task evaluator defaults to real stock Pi sessions with offline scripted
transport and temporary memory stores. Live mode needs a fresh explicit
request/input/output budget and selected-provider credentials; it is not part
of `release:check`. Input estimates and output reservations are not invoices.
The SDK fetch guard is not a subprocess network/filesystem sandbox. Codex is
rejected unless explicitly selected as unbounded output; that exception never
satisfies a hard output-token budget. No provider-quality or savings claim
follows from a passing offline report.

## 4. Canary the RC

After explicit approval to publish an RC, use the npm `next` tag rather than
`latest`. On only the externally selected cohort, set:

```json
{
  "smartCompact": {
    "telemetryChannel": "canary"
  }
}
```

Keep all stage model routes null unless a separate routing decision is approved.
Collect at least 20 non-dry, host-confirmed **applied** schema-v2 canary runs
of the candidate version, a stable baseline of at least 20 applied runs,
≥70% verifier-quality coverage and ≥70% run-correlated damage-observation
coverage **in both stable and canary cohorts**, and canary data confidence ≥85.
Inspect the report's total/attempted/applied counts: dry runs, staged-but-
unapplied runs, voluntary user cancellations, and discarded speculative
preparations are not promotion evidence (cancellations are neutral — real
timeouts and provider failures still count). Every metrics entry must carry an
explicit `releaseChannel`; entries without one are excluded from both cohorts
and surfaced in the report, never silently pooled as stable. Missing
observations are missing evidence, never clean runs. A deterministic green
release check never implies `PROMOTE`. Promotion requires:

- [ ] `telemetry-report` says `PROMOTE`;
- [ ] canary data confidence is ≥85 (report `HOLD` at 82 is a hold, not a pass);
- [ ] dashboard Data Confidence is ≥85;
- [ ] canary success is ≥95% and absolute verifier quality is ≥85;
- [ ] both cohorts have ≥70% quality and damage-observation coverage;
- [ ] canary failure rate is at most 5% and not 5pp or more above stable;
- [ ] verifier quality did not fall by 5 points or more;
- [ ] p95 duration and average tokens did not rise by 50% or more;
- [ ] fallback and damage rates did not rise by 10pp or more;
- [ ] no unresolved security, data-loss, cross-session, or cancellation issue.

The report evaluates rollback triggers once the canary has at least three
attempted runs; exact rules are in
[evaluation](./evaluation.md#decision-rules).

The preparation-policy block (prepared/used/discarded, discard reasons,
time-to-ready, reuse rate, discarded spend) is measurement only: thresholds,
TTLs, and cooldowns stay manual policy decisions. Route reports keep the
input/cache-read/cache-write/output split, mark estimated usage, and label
subscription (OAuth) routes — never price subscription usage at API rates or
strip cached tokens from quota.

A `ROLLBACK` result blocks promotion. `HOLD` means collect evidence or fix data
coverage; it is not a pass. Promotion authority remains manual: these gates
inform the release owner, they never publish anything.

## 5. Publish — explicit approval required

Only after the user/release owner explicitly approves:

```bash
# RC
npm publish --tag next

# Stable, after canary approval and a stable SemVer bump
npm publish
```

`prepublishOnly` reruns `release:check`; it does not bypass any gate.

## 6. After publishing

1. Verify npm package contents and integrity.
2. Create the matching Git tag and GitHub release with migration/compatibility
   notes.
3. Install through Pi in a clean profile:

   ```bash
   pi install npm:pi-smart-compact@next   # RC
   # or npm:pi-smart-compact for stable
   ```

4. Re-run tool registration, one manual compaction, Smart Recall, and the local
   dashboard.
5. Keep canary monitoring active through the agreed observation window.
