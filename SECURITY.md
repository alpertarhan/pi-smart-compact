# Security Policy

## Supported versions

Security fixes target the latest published version of `pi-smart-compact`.

| Version | Supported |
| --- | --- |
| Latest `8.x` | ✅ |
| Older | ❌ |

## Reporting a vulnerability

Please do **not** open a public issue for vulnerabilities, leaked secrets, or
private-session data exposure.

Report privately through GitHub Security Advisories:

<https://github.com/alpertarhan/pi-smart-compact/security/advisories/new>

If advisories are unavailable, contact the maintainer listed in `package.json`.

## Data handling

`pi-smart-compact` processes Pi session content to produce compaction summaries.
Depending on the session, this may include repository paths, command output,
tool results, and user-provided context.

Operational guidance:

- Do not paste secrets into sessions you plan to compact.
- Redact private logs before attaching them to issues.
- Treat generated compaction summaries as potentially sensitive project context.
- Review provider / model configuration before enabling auto-triggered compaction.

Runtime artifacts are written under `~/.pi/agent/`; private artifact
directories are enforced as `0700` and files as `0600`. Pre-compaction backups
contain the complete selected pre-prune conversation after configured
secret/PII scrubbing. Project-memory writes fail closed when the working
directory is exactly `HOME` or the filesystem root, require interactive
confirmation of the complete scrubbed content, and are capped at 500 active manual facts per
project. See the [runtime artifacts table](./README.md#runtime-artifacts).
