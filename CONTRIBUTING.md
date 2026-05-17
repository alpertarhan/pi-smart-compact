# Contributing

Thanks for contributing to `pi-smart-compact`.

This project sits on the boundary between product UX, LLM orchestration, and deterministic safety checks. Good contributions keep all three in balance.

## Project principles

When making changes, prefer these priorities:

1. **Deterministic facts before LLM inference**
   - If something can be extracted, validated, or repaired without an LLM call, prefer that path.
2. **Preserve agent working state**
   - The package exists to preserve goals, files, decisions, errors, constraints, and follow-up loops.
3. **Keep README user-facing**
   - Put deep implementation detail in `ARCHITECTURE.md` or code comments, not `README.md`.
4. **Minimize documentation drift**
   - If behavior or metadata changes, update docs in the same change.
5. **Do not edit generated output manually**
   - `dist/` is build output.

## Local setup

```bash
bun install
```

## Common commands

```bash
bun test
bun run build
bun run typecheck
```

## Repository map

```text
src/
  index.ts            extension entrypoint
  core.ts             end-to-end pipeline orchestration
  phases/             explore / synthesize / verify
  utils/              extraction, state, tokens, cache, helpers, etc.
  ui/                 compact UI overlays and result screens

test/                 unit and regression tests
```

## Development workflow

### 1. Make changes in `src/`
Never patch `dist/` by hand. Build output is generated from source.

### 2. Keep version metadata synchronized
If a release-worthy change affects published behavior, sync:

- `package.json`
- `src/constants.ts`
- `CHANGELOG.md`

### 3. Keep docs aligned
Depending on the change, update the relevant docs:

- `README.md` — package overview, install, usage, config
- `ARCHITECTURE.md` — system design and execution model
- `CONTRIBUTING.md` — contributor workflow and expectations
- `DEVPLAN.md` — archival implementation plan only
- `ROADMAP.md` — current forward-looking priorities

### 4. Run validation before shipping
Minimum expectation:

```bash
bun test
bun run build
bun run typecheck
```

## Testing guidance

When touching specific areas, make sure nearby tests still tell a coherent story:

- extraction logic → `test/extraction.test.ts`
- exploration heuristics / parsing → `test/exploration.test.ts`
- synthesis / end-to-end evaluation → `test/eval.test.ts`
- verification / repair logic → `test/verify.test.ts`
- state / delta / open loops → `test/state.test.ts`
- token logic / provider caps → `test/tokens.test.ts`
- incremental cache merge behavior → `test/cache.test.ts`

If you change summary structure, verification rules, or state persistence, add or update tests.

## Documentation standards

- Prefer durable wording over volatile repo snapshots.
- Avoid hardcoding temporary counts like line counts, module counts, or passing-test totals in `README.md`.
- If you reference a release number, make sure it matches current metadata.
- Keep examples realistic and consistent with current config keys (`smartCompact`, not only legacy aliases).

## Release hygiene

Before a release:

1. sync `package.json` and `src/constants.ts`
2. update `CHANGELOG.md`
3. rebuild `dist/`
4. run tests
5. run typecheck
6. spot-check `README.md` for drift

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
