# Contributing

Thanks for contributing to **Pi Continuity**, published as the npm package
`pi-smart-compact`.

Pi Continuity is the product name used in documentation. The package name,
`/smart-compact` command, `smart_*` tools, `smartCompact` configuration key,
runtime and UI names, repository URL and stored paths are unchanged. Do not
rename them in code, tests or examples.

The project sits between product UX, LLM orchestration and deterministic safety
checks. Good contributions keep all three in balance.

## Project principles

1. **Hygiene and recoverability before summarization.** Prefer keeping noise
   out of context, or keeping it retrievable, over replacing history.
2. **Deterministic facts before LLM inference.** If something can be
   extracted, validated or repaired without an LLM call, prefer that path.
3. **Preserve the agent's working state.** Goals, files, decisions, errors,
   constraints and open loops must survive; verification is a guard, not a
   guarantee that every detail survives.
4. **Memory stays confined and confirmed.** Cross-session memory uses one
   selected backend; explicit saves need host confirmation, and only the local
   backend indexes derived facts, from confirmed compactions.
5. **Minimize documentation drift.** Update docs in the same change as
   behavior or metadata.
6. **Edit the source of truth.** `dist/` is build output; brand exports come
   from the SVG master in [the identity guide](./docs/identity.md#regenerate-the-exports).

## Local setup

Prerequisites: Bun 1.4.2 (the `packageManager` pin), Node >=22.19 with npm on
`PATH` (the release audit smokes the packed extension under Node), `rg`
(ripgrep) on `PATH` for the offline task evaluation inside the audit, and
network access for package installation.

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run gate
bun run bench
bun run build
bun run release:audit
```

These are the pull-request CI `verify` steps in
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml), which pins Bun to the
`packageManager` version and installs ripgrep before the audit. The adversarial
gate runs on pull requests and pushes. A separate scheduled or manually
dispatched CI job runs `bun run compat:pi` against the latest Pi in an isolated
workspace. The full local `bun run release:check` includes that compatibility
check as well; the locked minimum host is checked with
`bun run compat:pi 0.87.1`.

To try a checkout in Pi, run `bun run build` and install the checkout path
(`pi install /path/to/pi-smart-compact`; Pi loads `dist/index.js` through
`package.json#pi`). Rebuild after each change; never edit `dist/` directly.

## Repository map

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design, organized as
context hygiene, recoverable continuity, verified compaction and optional
cross-session memory.

```text
src/
  index.ts            extension entry point (commands, hooks, tools)
  rtk.ts              optional RTK companion entry point
  constants.ts        version, thresholds, prompts, config keys
  types.ts            shared types and discriminated unions
  app/                orchestration: pipeline, context control, memory, policy
    steps/            ten typed pipeline stages (prepare … metrics) + visual
  domain/             pure semantics, no I/O
  phases/             algorithms (explore / synthesize / verify)
  infra/              external-world adapters (fs, llm, sqlite, hindsight, …)
  ui/                 TUI Home, settings, overlays, dashboard
  utils/              focused helpers (extraction, state, tokens, cache, …)

assets/               shipped runtime files (packed)
  DejaVuSansMono.ttf  font for the optional visual renderer, with its license
  skills/context-management/SKILL.md
                      agent context guide, read only on request via smart_tools
scripts/              build, audit, compatibility, evaluation and pilot CLIs
bench/                hot-path benchmark gate
test/                 unit, integration and regression tests
docs/                 guide, configuration, evaluation, release, migration
  assets/             brand files (banner, package image); not runtime assets
  reports/            dated reports and pilots (historical; not packed)
  findings/           external review findings (advisory; not packed)
.github/              CI workflow, Dependabot, issue and PR templates
dist/                 build output (generated; not committed)
```

The npm package contains `dist/`, `docs/` without `reports/` and `findings/`,
`assets/`, and the root README, ARCHITECTURE, CHANGELOG, LICENSE, SECURITY and
SUPPORT files (`package.json#files`, enforced by `bun run release:audit`).
Shipped docs link to repository-only files, such as reports, findings or this
guide, with absolute GitHub URLs; other links stay relative.

## Development workflow

### 1. Edit the source of truth

Runtime behavior belongs in `src/`; never patch `dist/` by hand. For a docs-only
change, edit the page that owns the topic (below). For branding, edit the master
SVG and regenerate its exports using [the identity guide](./docs/identity.md#regenerate-the-exports).

### 2. Keep version metadata synchronized

A release-worthy change keeps these in step:

- `package.json`
- `src/constants.ts` (`VERSION`, rewritten by `scripts/sync-version.ts` at build time)
- `CHANGELOG.md`

### 3. Keep docs aligned

Update the page that owns the topic:

| Topic | Page |
| --- | --- |
| Landing page, install, quick start | `README.md` |
| Documentation index | `docs/README.md` |
| Naming, visual identity and asset exports | `docs/identity.md` |
| Everyday usage, commands, recovery, storage | `docs/guide.md` |
| Every setting and strategy | `docs/configuration.md` |
| Evaluation commands and evidence limits | `docs/evaluation.md` |
| System design and invariants | `ARCHITECTURE.md` |
| Hindsight backend | `docs/hindsight-memory.md` |
| Release process | `docs/RELEASE.md` |
| Contributor workflow | `CONTRIBUTING.md` |
| Vulnerability reporting, data handling | `SECURITY.md` |
| Support routing | `SUPPORT.md` |

Dated reports (`docs/reports/*-YYYY-MM-DD.md`), `docs/findings/` review reports
and `docs/MIGRATING_TO_V8.md` are historical. Do not rewrite their
measurements, dates or shipped names; add a new dated report or an addendum
instead.

### 4. Run validation before shipping

```bash
bun run release:check      # typecheck, test, gate, bench, build, release:audit, compat:pi latest
bun run compat:pi 0.87.1
bun audit
```

## Testing guidance

Keep nearby tests telling a coherent story:

- extraction logic → `test/extraction.test.ts`
- exploration heuristics / parsing → `test/exploration.test.ts`
- synthesis / end-to-end evaluation → `test/eval.test.ts`
- verification / repair → `test/verify.test.ts`
- state / delta / open loops → `test/state.test.ts`
- token logic / provider caps → `test/tokens.test.ts`
- incremental cache merge → `test/cache.test.ts`
- typed stage chain / lifecycle → `test/stage-machine.test.ts`
- pending slot / cross-session guard → `test/pending-slot.test.ts`
- checkpoint, rewind, trimming → `test/context-control.test.ts`
- tool-output artifacts and long-session storage → `test/tool-artifacts.test.ts`, `test/long-session-storage.test.ts`
- memory backends → `test/memory-backend.test.ts` and the Hindsight/Mnemopi tests
- provider-native compaction → `test/native-compaction.test.ts`

Change summary structure, verification rules or state persistence only with
tests that would catch a consumer-visible regression. Evaluation and pilot
tooling, and what their results can claim, are described in
[`docs/evaluation.md`](./docs/evaluation.md). Never run live provider or memory
server evaluations without explicit approval of their cost and data exposure.

## Documentation standards

- English, plain text, no emojis.
- Prefer durable wording over volatile repository snapshots; avoid hardcoded
  counts such as line, module or passing-test totals.
- Release numbers must match current metadata. Keep the unpublished checkout
  version and the latest npm release distinct.
- Use current configuration keys (`smartCompact`, not only legacy aliases) and
  exact UI labels from `src/ui`.
- Prefer relative links between shipped pages. Use absolute GitHub URLs for
  repository-only content; never leave an installed-package link pointing at
  an excluded file. Keep linked headings stable.
- Do not claim that all details survive losslessly, that the verifier proves
  semantic truth, or that offline results prove live quality or cost.

## Release hygiene

1. Sync `package.json` and `src/constants.ts` (`bun run sync-version`).
2. Update `CHANGELOG.md`.
3. Run `bun run release:check`, the locked compatibility check and `bun audit`.
4. Spot-check docs for drift.

See [`docs/RELEASE.md`](./docs/RELEASE.md) for the full checklist, including
canary gates and approval requirements.

## Security and privacy

Do not include secrets, private session logs, proprietary source or unredacted
tool output in issues, pull requests, tests or screenshots. Use GitHub Security
Advisories for vulnerabilities; see [`SECURITY.md`](./SECURITY.md).

## Pull request expectations

- a clear problem statement
- the smallest reasonable change set
- tests for behavior changes
- docs updates when user-facing behavior changes
- explicit notes for trade-offs and known limitations

## Notes

- The legacy `semanticCompact` configuration key is still read for backward
  compatibility.
- Deterministic extraction, verification and repair are core features, not
  optional polish.
