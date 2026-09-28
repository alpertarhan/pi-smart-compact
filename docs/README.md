# Pi Continuity documentation

Context hygiene and session continuity for Pi Coding Agent. The installed
package remains `pi-smart-compact`; its commands, tools, configuration and stored
data identifiers have not changed. [Identity and naming](./identity.md).

These guides describe the current source checkout, including unreleased work.
Use the [changelog](../CHANGELOG.md) to distinguish source behavior from a
published version. Historical reports below are evidence, not current setup
instructions.

## Find the next step

| I want to… | Read |
| --- | --- |
| Install and choose how the extension runs | [README](../README.md#get-started) |
| Clean up output, compact, or retrieve earlier evidence | [User guide](./guide.md) |
| Understand a setting or fix a trigger/model/budget mismatch | [Configuration](./configuration.md) |
| Use an existing Hindsight server | [Hindsight memory](./hindsight-memory.md) |
| Understand ownership, preservation and apply rules | [Architecture](../ARCHITECTURE.md) |
| Interpret quality, cost, timing or canary results | [Evaluation](./evaluation.md) |
| Work on the code | [Contributing](../CONTRIBUTING.md) |
| Prepare a new package | [Release checklist](./RELEASE.md) |
| Report a problem safely | [Support](../SUPPORT.md) · [Security](../SECURITY.md) |

## Three concepts to keep separate

**Context hygiene** reduces the active working set. Eligible tool output can
be archived and retrieved; local cleanup does not need a summary-model call.

**Session continuity** carries working-state constraints, decisions, failures
and next steps through research, compaction and reload. A checkpoint is a
context boundary, not a filesystem snapshot. A summary is not the complete
original history.

**Project memory** is optional cross-session storage for approved facts. It is
not an automatic transcript upload, a backup, or the tool-output archive. Exactly
one backend is selected at a time.

## Historical evidence

Dates and measured results in these reports are intentionally preserved. They
can describe an older candidate or earlier design; their own limits still apply.

| Report | What it establishes |
| --- | --- |
| [Context hygiene experiments, 2026-09-24](./context-hygiene-2026-09-24.md) | Implementation decisions, local experiments and a dated remediation record. |
| [AgentSession pilot, 2026-09-24](./session-pilot-2026-09-24.md) | Scripted stock-Pi lifecycle, recovery and continuation behavior, with dated follow-ups. |
| [Visual evidence pilot, 2026-09-24](./visual-pilot-2026-09-24.md) | A bounded visual-reader experiment, including measured overhead and limitations. |
| [Hindsight/native research, 2026-09-24](./hindsight-native-compaction-research-2026-09-24.md) | Earlier alternatives, proposals and implementation follow-ups—not all current settings. |
| [Provider baseline, 2026-08-06](./provider-evaluation-2026-08-06.md) | A small historical routing sample, not a current recommendation or reliability ranking. |
| [v7 → v8 migration](./MIGRATING_TO_V8.md) | Instructions for that historical version transition, not the current install baseline. |

A green scripted pilot does not establish live-model fidelity, billed savings or
production readiness. Follow the [evaluation limits](./evaluation.md) and
[release checklist](./RELEASE.md) before making those claims.

## Review findings

Audits written by external models and agent harnesses live under
[`findings/`](./findings/). Each report targets a specific revision range and is
advisory, not a product guarantee or release gate.

| Reviewer | Report | Scope |
| --- | --- | --- |
| `deepseek-v4.1-flash-opencode` | [Recent-changes review, 2026-09-28](./findings/deepseek-v4.1-flash-opencode/2026-09-28-recent-changes-review.md) | Commits #75–#79 (`9.8.0-canary.7` wave) |
| `glm-5.3-pi` | [Recent-changes ponytail review, 2026-09-28](./findings/glm-5.3-pi/2026-09-28-recent-changes-ponytail-review.md) | Commits #75–#79 |
| `claude-opus-5-5-pi` | [Recent-changes review, 2026-09-28](./findings/claude-opus-5-5-pi/2026-09-28-recent-changes-review.md) | Commits #76–#79 line-by-line; #75 packaging only |
| `muse-spark-1.3-contributor-pi` | [Recent-changes ponytail review, 2026-09-28](./findings/muse-spark-1.3-contributor-pi/2026-09-28-recent-changes-ponytail-review.md) | Commits #75–#79 |

Reports are kept out of the npm package (`package.json` `files`).
