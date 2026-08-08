# Migrating from v7 to v8

This guide applies to the stable `8.0.7` release.

## Compatibility

- Pi, Pi AI, Pi TUI, and TypeBox remain host-provided wildcard peers (`"*"`).
- The command and primary tool remain `/smart-compact` and `smart_compact`.
- Existing profiles and aliases continue to work.
- Modes never change the selected Pi model.
- Settings are additive; an existing v7 configuration remains valid.

The release is validated against the locked Pi 0.84.0 baseline and the latest
Pi compatibility job. Bun 1.3.14 is the reproducible build baseline.

## What changes on first run

### Scoped continuity state

v8 writes continuity state under:

```text
~/.pi/agent/.cache/smart-compact/states/<projectId>/<sessionId>.json
```

v7's project-wide state file is left in place but is **not automatically
injected**. Treating it as current could contaminate another session or a
divergent branch. The first host-confirmed v8 `session_compact` seeds scoped
state; staging, cancellation, or a failed native apply writes nothing. No conversation log is
rewritten during migration. v8.0.1+ filters legacy RC state that misclassified
`npm error`/`npm notice` diagnostics as constraints, and v8.0.2 also removes legacy
source-search output persisted as unresolved work; the next confirmed save persists
the sanitized state. v8.0.3 keeps the same graph file and transparently opens it
with `node:sqlite` under Pi or `bun:sqlite` in Bun tooling. v8.0.4 changes only
compaction planning, UX, and privacy-safe operational metrics; v8.0.5 bounds
user-facing failure diagnostics; v8.0.6 streamlines the three-mode decision card
and live progress brief. v8.0.7 reserves post-summary planning headroom,
sanitizes known transient diagnostics, bounds active continuity before resolved
history, and introduces branch-occurrence context-graph schema v1. On first graph
open, user-confirmed manual memories remain; older derived compaction nodes are
reset and repopulate from later apply-confirmed compactions.

Facts remain conservative across follow-ups and free-form goal changes: bounded
absence or new wording is never resolution. Goal shifts are retained as
`Previous goal` context; errors and loops retire only through positive resolution
evidence or an explicit override. Newer successful file access/mutation/delete
evidence still resolves contradictory file status. State and graph resolution use
the complete host-visible branch ancestry, not a truncated lineage or siblings.

### Persistent context graph

Applied, verified compactions are indexed into:

```text
~/.pi/agent/.cache/smart-compact/context-graph.sqlite
```

The database is local, project-partitioned, mode `0600`, and bounded to 2,000
non-structural fact nodes per project. Private artifact directories are 0700 and
files are 0600. Apply-confirmed state is queued for the next event-loop turn so
SQLite indexing is not part of the native compaction hook's latency. It enables
`smart_recall` and confirmation-gated `smart_save_memory`. Memory writes fail
closed when the working directory is exactly `HOME` or the filesystem root; the
interactive prompt shows the complete scrubbed memory and paths. A project may
hold at most 500 active manual memories. Set
`contextGraphEnabled` to `false` before first use to disable indexing and both
tools. Disabling does not delete an existing database.

### Metrics schema v2

New metrics add version/channel, stage provider routes, verifier repair
provenance, run-correlated damage observations, and a content-free failure
taxonomy. Route quality is only the synthesis stage's explicit pre-repair
score; the final run score is not copied into Explore/Verify. Legacy JSONL rows
remain readable, but their old verifier scores do not count as route quality.
Consequently Data Confidence may start below 85 and rise as complete v8 runs
replace legacy evidence.

`telemetryChannel` defaults to `stable`. Use `canary` only on an externally
selected canary installation. Reports show total/applied runs, and only non-dry,
host-confirmed applied outcomes count toward promotion; deterministic green
checks do not imply `PROMOTE`. The extension reports Hold/Rollback/Promote but
never deploys, edits configuration, or rolls itself back.

## New optional settings

All defaults preserve the selected model and require no migration edits.

| Key | Default | Purpose |
|---|---|---|
| `mode` | `auto` | Pressure/risk-aware execution policy |
| `zeroCallEnabled` | `true` | Deterministic Fast synthesis when confidence is high |
| `contextGraphEnabled` | `true` | Local scoped graph and memory tools |
| `telemetryChannel` | `stable` | Stable/canary metric tag |
| `segmentationModel` | `null` | Explicit Explore route; selected model when null |
| `summaryModel` | `null` | Explicit Synthesis route; selected model when null |
| `verificationModel` | `null` | Explicit repair route; summary/selected model when null |

See the README configuration table for budgets and monitoring options.

## Backups and rollout

v8.0.7 backs up the complete selected pre-prune conversation after configured
scrubbing, using 0600 files in a 0700 directory. Retention only prunes
marker-owned backups.

1. Back up `~/.pi/agent/settings.json` and the Smart Compact cache directory.
2. Install the exact stable version: `pi install npm:pi-smart-compact@8.0.7`.
3. Leave all model routes null initially.
4. Keep `telemetryChannel: "stable"` unless intentionally running a separate
   canary cohort.
5. Monitor `bun run telemetry-report` or the local dashboard and use the
   rollback procedure below if a rollback trigger appears.

## Rollback

1. Reinstall the previous v7 package.
2. Restore `telemetryChannel`/new settings only if the older version rejects
   unknown keys (normal v7 configuration loading ignores them).
3. Leave scoped state and `context-graph.sqlite` in place for a future v8 retry,
   or remove them manually if local retention policy requires deletion.

Rollback does not require converting scoped state back to the v7 project-wide
format. v7 simply will not consume v8 session-scoped continuity or the context
graph.
