# Support

For usage questions or bug reports about **Pi Continuity** (the
`pi-smart-compact` package), open an issue in this repository:

<https://github.com/alpertarhan/pi-smart-compact/issues>

For Pi Coding Agent core behavior that reproduces **without** this extension,
use the upstream Pi repository:

<https://github.com/earendil-works/pi>

Start with the [user guide](./docs/guide.md) and
[configuration reference](./docs/configuration.md).

## Before you file

Helpful things to include:

- `pi-smart-compact` version (from `package.json` or `/smart-compact` output),
  and whether it is a published npm release or a source checkout
- Pi Coding Agent version
- the surface involved: `/smart-compact` Home or a subcommand, the
  `smart_compact`, `smart_context`, `smart_recall` or `smart_save_memory` tool,
  or automatic compaction (and which `autoTriggerStrategy`)
- the selected memory backend, if memory is involved
- relevant non-secret `smartCompact` configuration
- redacted error output or logs

## Self-service diagnostics

- `/smart-compact` → **Status & help** → **Readiness & details**: local
  readiness and effective settings; nothing is sent to a provider
- `/smart-compact metrics`: effective state, recent issues and the metrics
  report
- `/smart-compact dashboard`: interactive dashboard; it can also write a local
  HTML report
- `/smart-compact storage`: read-only inventory of saved tool output; nothing
  is deleted
- Restart Pi with `DEBUG=smart-compact` to see full stacks for a failure

For security issues, see [`SECURITY.md`](./SECURITY.md); please do **not**
open a public issue for vulnerabilities.
