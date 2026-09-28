# Release checklist

Use this checklist before publishing Pi Continuity as the npm package
`pi-smart-compact`. The package name, command, tool names and configuration
key do not change with the documentation brand.

> **Approval boundary:** validation, packing and isolated installation do not
> publish anything. Creating a published GitHub release is the explicit
> approval that starts npm publication through Trusted Publishing. Use a draft
> release for preparation; ordinary commits, tags and pull-request CI do not
> publish packages.

Evidence classes and their limits are defined in
[evaluation](./evaluation.md#offline-and-live-evidence). Keep the unpublished
checkout version and the version currently on npm distinct in every note.
Toolchain prerequisites (Bun pin, Node with npm, ripgrep) are listed at the top
of [evaluation](./evaluation.md); `release:audit` also needs network access for
package installation.

## 1. Prepare the candidate

- [ ] Use a distinct prerelease until the stable/canary gates pass, unless the
      release owner explicitly approves a version-specific stable exception.
      Record any exception and missing evidence in the release notes; it is
      not a `PROMOTE` result. Stamp `package.json` and run
      `bun run sync-version` before packing.
- [ ] Move shipped notes from `[Unreleased]` into the dated version in
      `CHANGELOG.md`; never word a candidate entry as if the final release
      check or canary promotion already passed.
- [ ] Update the guide, configuration, evaluation, architecture and migration
      notes for behavior/config changes. Dated reports (`docs/reports/`) stay
      historical and are not packed; add a new report or addendum instead of
      rewriting them.
- [ ] On a major version change, update the supported-versions row in
      `SECURITY.md`; `release:audit` requires it to read ``Latest `<major>.x` ``.
- [ ] For Claude subscription routes, pair the fresh candidate with the exact
      `pi-claude-oauth-adapter` build used in the proofs (published `0.2.2`
      plus the final-payload patch, [upstream PR #10](https://github.com/minzique/pi-claude-oauth-adapter/pull/10),
      until it is released) and record
      the paired archive paths and hashes at final packaging — do not
      reconstruct them from memory. pi-toolkit's auto-context must not be
      loaded with the candidate.
- [ ] Confirm Pi remains a host peer (`">=0.87.1"`) and TypeBox a wildcard peer (`"*"`); neither is bundled.
- [ ] Confirm the visual renderer remains optional/external and the font plus its license ship in `assets/`, together with the on-demand context guide `assets/skills/context-management/SKILL.md`. Verify default Node loading without the optional addon and a real PNG render where supported.
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

- [ ] packed files are limited to `dist`, `docs` (without `docs/reports/` and
      `docs/findings/`), `assets`, README, LICENSE, CHANGELOG, SECURITY,
      SUPPORT, ARCHITECTURE, and package metadata; `release:audit` requires
      `ARCHITECTURE.md`, `docs/RELEASE.md` and `docs/MIGRATING_TO_V8.md` and
      rejects reports and findings;
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
coverage; it is not a pass. Promotion authority remains manual. A release-owner
exception must name its version and evidence limits; it does not turn missing
evidence into a passing gate.

## 5. Publish — explicit approval required

### One-time npm Trusted Publisher setup

In the npm package settings for `pi-smart-compact`, add a **GitHub Actions**
trusted publisher with these exact values:

| Field | Value |
| --- | --- |
| Organization or user | `alpertarhan` |
| Repository | `pi-smart-compact` |
| Workflow filename | `publish.yml` (not `.github/workflows/publish.yml`) |
| Environment | Leave empty; the workflow does not use an environment |
| Publish permission | Allow direct `npm publish`, not only `npm stage publish` |

The current npm default can permit staging only. Direct publication must be
enabled to avoid a manual approval for every package. npm does not verify these
fields when saving; the first successful workflow publication proves the link.
See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).

No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is needed.
[`publish.yml`](https://github.com/alpertarhan/pi-smart-compact/blob/main/.github/workflows/publish.yml)
uses a GitHub-hosted runner, `id-token: write`, Node 26.10.0, npm 11.19.1 and
the Bun version pinned in `package.json`. npm obtains short-lived OIDC
credentials and automatically attaches provenance for this public repository.
Keep these versions and the workflow filename aligned when changing tooling.

### Release an approved version

1. Merge the version, generated `VERSION`, changelog and release documentation
   through a PR into `main`, with required CI passing. Complete the checks above.
2. Create a GitHub release at that exact `main` commit with tag `v<version>`,
   matching `package.json`. Include upgrade notes and the actual validation
   evidence; document any explicitly approved canary exception.
3. For a SemVer prerelease, mark the GitHub release **pre-release**. For a stable
   version, leave that flag off. Publish the release, not just its tag.
4. Follow **Actions → Publish to npm**. The workflow rejects tags that do not
   match the package version, mismatched prerelease flags and commits outside
   `main`. Prereleases publish to npm `next`; stable versions publish to `latest`.

The workflow checks minimum-Pi compatibility and dependency advisories, then
calls `npm publish`. Its existing `prepublishOnly` hook runs the full
`release:check`, including the packed install audit and latest-Pi compatibility,
before uploading. It never uses `--ignore-scripts` to bypass these gates.

If the first run fails authentication, check the exact owner/repository/workflow
fields, the empty environment and direct-publish permission on npm. After fixing
the configuration, rerun the failed Actions job; do not publish manually to
mask a broken OIDC setup. Once a version is published, it is immutable: a new
package change needs a new version, not a republish or a moved release tag.

## 6. After publishing

1. Confirm **Publish to npm** completed successfully. A published GitHub release
   alone does not prove the package reached npm.
2. Check the registry version, dist-tag, integrity and provenance:

   ```bash
   VERSION=$(node -p 'require("./package.json").version')
   npm view "pi-smart-compact@$VERSION" version dist.integrity dist.attestations --json
   npm view pi-smart-compact dist-tags --json
   ```

3. Install the exact version through Pi in a clean profile, then re-run tool
   registration, one manual compaction, Smart Recall and the local dashboard.
4. Keep canary monitoring active through the agreed observation window;
   successful publication is not production-quality evidence.
