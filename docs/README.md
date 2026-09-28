# Pi Continuity documentation

[Project overview](../README.md) · [User guide](./guide.md) · [Configuration](./configuration.md)

Pi Continuity is the product name; `pi-smart-compact` remains the package,
command family and repository. [Identity and naming](./identity.md).

These guides follow the **current source checkout**, including unreleased work.
Compare your installed version with the [changelog](../CHANGELOG.md). Dated
reports describe their own revisions, not necessarily today's behavior.

## Start with your task

| I want to… | Read |
| --- | --- |
| Install and choose how the extension runs | [Get started](../README.md#get-started) |
| Clean up output, compact or recover evidence | [User guide](./guide.md) |
| Use anchors or move work to a fresh session | [Session navigation and handoff](./guide.md#session-navigation) |
| Understand a setting, trigger, model route or budget | [Configuration reference](./configuration.md) |
| Choose where project memory lives | [Memory stores](./guide.md#memory-store-memorybackend) |
| Connect an existing Hindsight server | [Hindsight setup and privacy](./hindsight-memory.md) |
| Diagnose unexpected behavior | [Troubleshooting](./guide.md#troubleshooting) · [Support](../SUPPORT.md) |
| Report sensitive information privately | [Security policy](../SECURITY.md) |

## Understand or contribute

| Document | Scope |
| --- | --- |
| [Architecture](../ARCHITECTURE.md) | Ownership, preservation rules, apply boundaries and module responsibilities. |
| [Evaluation](./evaluation.md) | Available checks and experiments; what quality, cost and timing evidence can establish. |
| [Contributing](https://github.com/alpertarhan/pi-smart-compact/blob/main/CONTRIBUTING.md) | Development setup, repository map and pull-request expectations. |
| [Release checklist](./RELEASE.md) | Package validation, compatibility and publication gates. |
| [Identity and assets](./identity.md) | Product naming, logo sources, palette and reproducible image exports. |
| [Changelog](../CHANGELOG.md) | Versioned changes and unpublished work. |

## Keep these concepts separate

| Concept | Purpose | Not a substitute for… |
| --- | --- | --- |
| **Context hygiene** | Reduce active tool-output noise while keeping eligible evidence retrievable. Local cleanup needs no summary-model call. | A new conversation summary. |
| **Session continuity** | Carry constraints, decisions, failures and next steps through research, compaction and reload. | Filesystem rollback or a complete copy of the original history. |
| **Project memory** | Recall scoped facts through one selected backend; explicit saves require confirmation. The local graph can also index derived compaction state. | Backups, output archives or automatic transcript upload. |

The [storage guide](./guide.md#storage-and-privacy) explains where each kind of
state lives and how long it is retained.

## Historical evidence

Reports are preserved as dated evidence. Their measurements, revision limits and
warnings remain part of the record; they are not current setup instructions.

- [Pilot and research reports on GitHub](https://github.com/alpertarhan/pi-smart-compact/tree/main/docs/reports):
  context hygiene, AgentSession lifecycle, visual evidence, Hindsight/native
  compaction research and the earlier provider baseline. The
  [evaluation guide](./evaluation.md#pilots-and-dated-reports) explains each scope.
- [Review findings on GitHub](https://github.com/alpertarhan/pi-smart-compact/blob/main/docs/findings/README.md):
  the index of external-model and agent-harness audits, organized by reviewer
  and date. Findings are advisory, not a release gate or product guarantee.
- [v7 → v8 migration](./MIGRATING_TO_V8.md): instructions for that historical
  transition, **not** the current installation baseline.

`docs/reports/` and `docs/findings/` are repository-only and excluded from npm.
Links to those archives deliberately open GitHub, so this index also works from
an installed package. User guides and brand assets ship with the package;
developer source, tests and evaluation scripts do not.

A green scripted pilot does not establish live-model fidelity, billed savings
or production readiness. Use the [evaluation limits](./evaluation.md) and
[release checklist](./RELEASE.md) before making those claims.
