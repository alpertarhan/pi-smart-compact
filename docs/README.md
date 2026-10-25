# Smart Compact documentation

[Project overview](../README.md) · [User guide](./guide.md) · [Configuration](./configuration.md)

Find the workflow first, then the reference. These pages describe the current
checkout; the [changelog](../CHANGELOG.md) separates released versions from
candidates and unpublished work.

## Use Smart Compact

| Your next action | Read |
| --- | --- |
| Install, update or choose how it runs | [Get started](../README.md#get-started) · [Update an existing installation](./guide.md#update-an-existing-installation) |
| Reduce noise or compact a long conversation | [User guide](./guide.md) |
| Recover evidence, revisit an anchor or hand off a task | [Recovery](./guide.md#recovery) · [Navigation](./guide.md#session-navigation) |
| Set a model, permission, threshold or budget | [Configuration reference](./configuration.md) |
| Choose a memory store | [Memory workflows](./guide.md#memory-what-is-stored-where) · [Hindsight setup](./hindsight-memory.md) |

## Understand the boundaries

| Question | Read |
| --- | --- |
| What changes when context is cleaned or compacted? | [Architecture](../ARCHITECTURE.md) |
| Where does data live, and what leaves the machine? | [Storage and privacy](./guide.md#storage-and-privacy) · [Security](../SECURITY.md) |
| What happens to incoming notifications during compaction? | [Message delivery](./message-delivery.md) |
| What do tests, scores and cost estimates actually prove? | [Evaluation and evidence](./evaluation.md) |
| Something did not work—what should I inspect? | [Troubleshooting](./guide.md#troubleshooting) · [Support](../SUPPORT.md) |

## Build and ship

| Task | Reference |
| --- | --- |
| Develop or review a change | [Contributing](https://github.com/alpertarhan/pi-smart-compact/blob/main/CONTRIBUTING.md) |
| Understand modules and invariants | [Architecture](../ARCHITECTURE.md) |
| Validate and publish a package | [Release checklist](./RELEASE.md) |
| Reuse or update the visual identity | [Identity and assets](./identity.md) |
| Compare versions | [Changelog](../CHANGELOG.md) |

## A small vocabulary

**Cleanup** replaces eligible old output with retrievable references. It makes
no summary-model call. **Compaction** replaces older conversation with a checked
summary; it is lossy. **Recovery** reads recorded evidence or navigates recorded
session state—it does not undo file or process changes.

**Project memory** is a separate, selected store for facts across sessions.
It is not the archive, a backup, or an automatic remote transcript upload.
Explicit writes follow `requireApproval`; only the local graph can also index
state from confirmed compactions.

**Staged** means prepared, not applied. **Accepted** means acknowledged, not
completed. Those distinctions are intentional in both tools and the UI.

## Historical material

- [v7 → v8 migration](./MIGRATING_TO_V8.md) applies only to that old transition.
  Use the current guide for installation and configuration.
- Dated research and review material under `docs/reports/` and `docs/findings/`
  is local, ignored and not shipped. Its evidence belongs to its stated date
  and revision; earlier copies may still exist in Git history.

User guides and brand assets ship in the npm package. Developer source, tests
and evaluation scripts do not. A green offline run establishes neither live
model quality nor billed savings; see the [evidence limits](./evaluation.md).
