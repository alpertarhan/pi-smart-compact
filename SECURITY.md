# Security Policy

## Supported versions

Security fixes target the latest published version of `pi-smart-compact`.

## Reporting a vulnerability

Please do **not** open a public issue for vulnerabilities, leaked secrets, or private-session data exposure.

Report privately through GitHub Security Advisories:

<https://github.com/alpertarhan/pi-smart-compact/security/advisories/new>

If advisories are unavailable, contact the maintainer listed in `package.json`.

## Data handling notes

`pi-smart-compact` processes Pi session content to produce compaction summaries. Depending on your session, this may include repository paths, command output, tool results, and user-provided context.

Operational guidance:

- Do not paste secrets into sessions you plan to compact.
- Redact private logs before attaching them to issues.
- Treat generated compaction summaries as potentially sensitive project context.
- Review provider/model configuration before enabling auto-triggered compaction.

Runtime artifacts are written under `~/.pi/agent/`; see `README.md` for the current list.
