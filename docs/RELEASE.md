# Release checklist

Use this checklist before publishing `pi-smart-compact`.

> **Stop condition:** validation, packing, and isolated installation are safe.
> `npm publish`, Git tags, GitHub releases, and deployment require separate
> explicit approval. The automated checks never perform them.

## 1. Prepare the candidate

- [ ] Choose a SemVer version. Use a prerelease such as `8.0.0-rc.1` until the
      stable/canary gates pass.
- [ ] Update `package.json`; run `bun run sync-version` for `src/constants.ts`.
- [ ] Move shipped notes from `[Unreleased]` into the dated version in
      `CHANGELOG.md`.
- [ ] Update README, architecture, and migration notes for behavior/config
      changes.
- [ ] Confirm Pi and TypeBox remain wildcard peer dependencies (`"*"`).
- [ ] Confirm no secrets, local JSONL, SQLite data, backups, or generated
      credentials are tracked or packed.

## 2. Run the deterministic release gate

```bash
bun install --frozen-lockfile
bun run release:check
```

`release:check` performs source + script typechecking, all tests, the adversarial
EESV gate, the multi-entry build, package allowlist/denylist checks, a packed
manifest/version/peer audit, an isolated install, a second frozen-lockfile
install, extension/tool registration smoke, and packaged CLI smoke tests.

Then validate the host boundary in an isolated workspace:

```bash
bun run compat:pi 0.84.0
bun run compat:pi latest
bun audit
```

The compatibility runner temporarily pins only its copied workspace; the source
manifest must remain wildcard-only.

## 3. Inspect artifacts

```bash
npm pack --dry-run
bun run provider-eval --min-samples=5
bun run telemetry-report --min-canary-runs=20
```

Check that:

- [ ] packed files are limited to `dist`, `docs`, README/license/support files,
      and package metadata;
- [ ] `dist/index.js`, declarations, and all three bundled CLIs are present;
- [ ] the extension registers `smart_compact`, `smart_recall`, and
      `smart_save_memory` from the packed install;
- [ ] no provider route was selected automatically;
- [ ] Data Confidence is honest (legacy evidence may keep it below 85).

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
Collect at least 20 schema-v2 canary runs and ≥70% quality coverage. Promotion
requires:

- [ ] `telemetry-report` says `PROMOTE`;
- [ ] dashboard Data Confidence is ≥85;
- [ ] failure rate did not rise by ≥5pp to at least 10%;
- [ ] verifier quality did not fall by 5 points;
- [ ] p95 duration and average tokens did not rise by 50%;
- [ ] fallback and damage rates did not rise by 10pp;
- [ ] no unresolved security, data-loss, cross-session, or cancellation issue.

A `ROLLBACK` result blocks promotion. `HOLD` means collect evidence or fix data
coverage; it is not a pass.

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
