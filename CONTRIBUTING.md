# Contributing

Thanks for contributing to `pi-smart-compact`.

This project sits on the boundary between product UX, LLM orchestration, and
deterministic safety checks. Good contributions keep all three in balance.

## Project principles

When making changes, prefer these priorities:

1. **Deterministic facts before LLM inference**
   If something can be extracted, validated, or repaired without an LLM call, prefer that path.
2. **Preserve agent working state**
   The package exists to preserve goals, files, decisions, errors, constraints, and follow-up loops.
3. **Keep README user-facing**
   Put deep implementation detail in `ARCHITECTURE.md` or code comments, not `README.md`.
4. **Minimize documentation drift**
   If behavior or metadata changes, update docs in the same change.
5. **Never hand-edit generated output**
   `dist/` is build output; rebuild from `src/`.

## Local setup

```bash
bun install
bun test
bun run typecheck
bun run build
bun run compat:pi   # verify against latest host-provided Pi packages
```

The CI `verify` job runs `typecheck → test → build` on every pull request. A
daily `pi-latest` job installs the latest Pi packages in an isolated temporary
workspace and runs the same checks without changing the checkout. To probe an
exact release locally, run `bun run compat:pi 0.80.6`.

## Repository map

The codebase is a layered architecture (see [`ARCHITECTURE.md`](./ARCHITECTURE.md)
for the full responsibility breakdown):

```text
src/
  index.ts            extension entrypoint (command + hook + tool registration)
  constants.ts        version, thresholds, prompts, config keys
  types.ts            shared types and discriminated unions
  app/                orchestration layer
    run-smart-compact.ts   pipeline orchestrator
    run-context.ts         typed stage chain (state machine)
    pending-slot.ts        pending-compaction state cell
    steps/                 10 stage modules (prepare … metrics)
  domain/             pure semantics, no I/O (summary schema + parse)
  phases/             algorithms (explore / synthesize / verify)
  infra/              external-world interaction + boundary adapters (fs, git, services, llm, ai-messages, …)
  ui/                 TUI overlays + dashboard
  utils/              focused helpers (extraction, state, tokens, cache, …)

test/                 unit and regression tests
docs/                 release checklist + assets
```

## Development workflow

### 1. Make changes in `src/`
Never patch `dist/` by hand — it is generated from source.

### 2. Keep version metadata synchronized
A release-worthy change should keep these in step:

- `package.json`
- `src/constants.ts` (`VERSION`, rewritten by `scripts/sync-version.ts` at build time)
- `CHANGELOG.md`

### 3. Keep docs aligned
Depending on the change, update the relevant docs:

- `README.md` — package overview, install, usage, config
- `ARCHITECTURE.md` — system design and execution model
- `CONTRIBUTING.md` — contributor workflow and expectations
- `SECURITY.md` — vulnerability reporting and sensitive-data guidance
- `SUPPORT.md` — support routing
- `docs/RELEASE.md` — release checklist

### 4. Run validation before shipping

```bash
bun run typecheck
bun test
bun run build
```

## Testing guidance

When touching specific areas, keep nearby tests telling a coherent story:

- extraction logic → `test/extraction.test.ts`
- exploration heuristics / parsing → `test/exploration.test.ts`
- synthesis / end-to-end evaluation → `test/eval.test.ts`
- verification / repair logic → `test/verify.test.ts`
- state / delta / open loops → `test/state.test.ts`
- token logic / provider caps → `test/tokens.test.ts`
- incremental cache merge behavior → `test/cache.test.ts`
- the typed stage chain / lifecycle → `test/stage-machine.test.ts`
- pending-slot lifecycle / cross-session guard → `test/pending-slot.test.ts`

If you change summary structure, verification rules, or state persistence, add
or update tests.

## Documentation standards

- Prefer durable wording over volatile repo snapshots.
- Avoid hardcoding temporary counts (line counts, module counts, passing-test totals) in `README.md`.
- If you reference a release number, make sure it matches current metadata.
- Keep examples realistic and consistent with current config keys (`smartCompact`, not only legacy aliases).

## Release hygiene

Before a release:

1. sync `package.json` and `src/constants.ts` (`bun run sync-version`)
2. update `CHANGELOG.md`
3. rebuild `dist/`
4. run tests + typecheck
5. spot-check `README.md` for drift

See [`docs/RELEASE.md`](./docs/RELEASE.md) for the full checklist.

## Security and privacy

Do not include secrets, private session logs, proprietary source, or unredacted
tool output in issues, pull requests, tests, or screenshots. Use GitHub Security
Advisories for vulnerabilities; see [`SECURITY.md`](./SECURITY.md).

## Pull request expectations

Good PRs usually include:

- a clear problem statement
- the smallest reasonable change set
- tests for behavior changes
- docs updates when user-facing behavior changes
- explicit notes for trade-offs, follow-up work, or known limitations

## Notes

- The extension supports both `smartCompact` and the legacy `semanticCompact` config key for backward compatibility.
- The system is safety-oriented: deterministic extraction, verification, and repair are core features, not optional polish.
