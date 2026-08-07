# Migrating from v7 to v8

This guide applies to the stable `8.0.0` release.

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
rewritten during migration.

Facts remain conservative: absence from a new window is not deletion. A fact is
removed only by an explicit resolved/superseded override.

### Persistent context graph

Applied, verified compactions are indexed into:

```text
~/.pi/agent/.cache/smart-compact/context-graph.sqlite
```

The database is local, project-partitioned, mode `0600` where supported, and
bounded to 2,000 non-structural fact nodes per project. Apply-confirmed state is
queued for the next event-loop turn so SQLite indexing is not part of the
native compaction hook's latency. It enables
`smart_recall` and confirmation-gated `smart_save_memory`. Set
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
selected canary installation; the extension reports Hold/Rollback/Promote but
never deploys, edits configuration, or rolls itself back.

## New optional settings

All defaults preserve the selected model and require no migration edits.

| Key | Default | Purpose |
|---|---|---|
| `mode` | `auto` | Pressure/risk-aware execution policy |
| `zeroCallEnabled` | `true` | Deterministic Fast/Aggressive synthesis when confidence is high |
| `contextGraphEnabled` | `true` | Local scoped graph and memory tools |
| `telemetryChannel` | `stable` | Stable/canary metric tag |
| `segmentationModel` | `null` | Explicit Explore route; selected model when null |
| `summaryModel` | `null` | Explicit Synthesis route; selected model when null |
| `verificationModel` | `null` | Explicit repair route; summary/selected model when null |

See the README configuration table for budgets and monitoring options.

## Recommended rollout

1. Back up `~/.pi/agent/settings.json` and the Smart Compact cache directory.
2. Install the exact stable version: `pi install npm:pi-smart-compact@8.0.0`.
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
