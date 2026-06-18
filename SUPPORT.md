# Support

For usage questions or bug reports specific to `pi-smart-compact`, open an
issue in this repository:

<https://github.com/alpertarhan/pi-smart-compact/issues>

For Pi Coding Agent core behavior that reproduces **without** this extension,
use the upstream Pi repository:

<https://github.com/earendil-works/pi>

## Before you file

Helpful things to include:

- `pi-smart-compact` version (from `package.json` or `/smart-compact` output)
- Pi Coding Agent version
- the integration surface used (`/smart-compact`, `smart_compact`, or auto-trigger)
- relevant non-secret `smartCompact` configuration
- redacted error output or logs

## Self-service diagnostics

- `/smart-compact metrics` — profile / provider comparison from the metrics log
- `/smart-compact dashboard` — interactive TUI dashboard (overview, latest run, current session, recent runs)
- `/smart-compact dashboard` → *Write HTML dashboard* — a local `~/.pi/agent/.cache/smart-compact-report.html`

For security issues, see [`SECURITY.md`](./SECURITY.md) — please do **not**
open a public issue for vulnerabilities.
