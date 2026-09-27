# Security Policy

This policy covers **Pi Continuity**, published as the npm package
`pi-smart-compact`.

## Supported versions

Security fixes target the latest published version of `pi-smart-compact`.

| Version | Supported |
| --- | --- |
| Latest `9.x` | Yes |
| Older | No |

Prerelease and unpublished source checkouts are not separately supported; fixes
land on the next release.

## Reporting a vulnerability

Please do **not** open a public issue for vulnerabilities, leaked secrets, or
private-session data exposure.

Report privately through GitHub Security Advisories:

<https://github.com/alpertarhan/pi-smart-compact/security/advisories/new>

If advisories are unavailable, contact the maintainer listed in `package.json`.

## Data handling

The extension processes Pi session content for context hygiene, recovery,
compaction and optional memory. Depending on the session, this may include
repository paths, command output, tool results and user-provided context.

Operational guidance:

- Do not paste secrets into sessions you plan to compact or save to memory.
- Redact private logs before attaching them to issues.
- Treat compaction summaries, backups and saved tool output as potentially
  sensitive project context.
- Review provider and model configuration before enabling automatic
  compaction; summaries are produced by the configured model provider.
- Remote memory is opt-in. With the Hindsight backend, confirmed facts and
  recall queries go to the configured server, which may store raw text and run
  its own models; see [Hindsight memory backend](./docs/hindsight-memory.md).

Runtime artifacts are written under `~/.pi/agent/`; private artifact
directories are enforced as `0700` and files as `0600`. Pre-compaction backups
contain the complete selected pre-prune conversation after configured
secret/PII scrubbing. Opt-in tool-output artifacts are scrubbed before they are
written. Scrubbing is pattern-based and PII scrubbing is opt-in; it reduces
exposure but is not a guarantee. Project-memory writes fail closed when the
working directory is exactly `HOME` or the filesystem root, require interactive
confirmation of the complete scrubbed content, and are capped at 500 active
manual facts per project. The optional RTK companion's own recall store is
outside this extension's scrubbing and retention.

File locations and retention are listed in the guide's
[storage and privacy](./docs/guide.md#storage-and-privacy) section; design
details are in [`ARCHITECTURE.md`](./ARCHITECTURE.md).
