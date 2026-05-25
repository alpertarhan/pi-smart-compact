# Release checklist

Use this checklist before publishing `pi-smart-compact`.

## Prepare

1. Decide the version bump using semver.
2. Update version metadata:
   - `package.json`
   - `src/constants.ts`
   - `CHANGELOG.md`
3. Make sure user-facing behavior is reflected in `README.md` or project docs.

## Validate

```bash
bun run typecheck
bun test
bun run build
```

The CI `verify` job runs the same validation on pull requests.

## Publish

```bash
npm publish
```

`prepublishOnly` reruns typecheck, tests, and build before publishing.

## After publishing

1. Verify the npm package page.
2. Create a GitHub release with highlights and compatibility notes.
3. Confirm Pi can install the new version:

```bash
pi install npm:pi-smart-compact
```
