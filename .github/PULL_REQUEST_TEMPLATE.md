## Summary

<!-- What changed and why? Link the issue if there is one. -->

## Validation

The same steps as the CI `verify` job (see `CONTRIBUTING.md`):

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun run gate`
- [ ] `bun run bench`
- [ ] `bun run build`
- [ ] `bun run release:audit`

<!-- Note any live provider or memory-server run separately; those need explicit approval of cost and data exposure. -->

## Checklist

- [ ] User-facing behavior is documented on the page that owns the topic (see `CONTRIBUTING.md`)
- [ ] Release-worthy changes update `CHANGELOG.md`, `package.json`, and `src/constants.ts`
- [ ] Tests cover changed behavior or the PR explains why tests are not needed
- [ ] Generated output in `dist/` was not edited by hand
- [ ] Dated reports and review findings were not rewritten (addenda only)
- [ ] No secrets, private session logs or unredacted tool output in code, tests, logs or screenshots

## Notes

<!-- Trade-offs, known limitations, compatibility notes, or screenshots/logs. -->
