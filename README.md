<div align="center">

<a href="https://github.com/alpertarhan/pi-smart-compact">
  <img src="https://raw.githubusercontent.com/alpertarhan/pi-smart-compact/main/docs/assets/banner.svg" alt="pi-smart-compact" width="860" />
</a>

[![CI](https://github.com/alpertarhan/pi-smart-compact/actions/workflows/ci.yml/badge.svg)](https://github.com/alpertarhan/pi-smart-compact/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-smart-compact?color=60a5fa)](https://www.npmjs.com/package/pi-smart-compact)
[![license](https://img.shields.io/npm/l/pi-smart-compact?color=22c55e)](https://github.com/alpertarhan/pi-smart-compact/blob/main/LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-fbbf24)](https://github.com/earendil-works/pi)

### Verification-oriented context compaction for the Pi Coding Agent

Preserve the agent's **working state**—goals, files, decisions, errors,
constraints, and open loops—not just a vague recap of the conversation.

**Deterministic facts · fail-closed verification · branch-safe continuity · local-first privacy**

[Install](#install) · [Why](#why-smart-compaction) · [Pipeline](#eesv-pipeline) · [Safety](#safety-and-privacy) · [Configuration](#configuration) · [Development](#development)

</div>

## Install

Requires the Pi Coding Agent on Node.js 22.19 or newer. The published extension
uses Pi's host packages and does not bundle a second Pi runtime.

```bash
pi install npm:pi-smart-compact
```

Then run `/smart-compact` for an explainable preflight before anything changes.

## Quick start

```bash
/smart-compact                                      # interactive preflight
/smart-compact auto                                 # adaptive mode selection
/smart-compact anthropic/claude-sonnet-4 fast      # explicit model + mode
/smart-compact balanced --focus=auth                # preserve extra auth detail
/smart-compact --note="keep balanced and fast terminology"
/smart-compact -- preserve this note verbatim after the option boundary
/smart-compact metrics                              # text metrics report
/smart-compact dashboard                            # interactive dashboard
/smart-compact restore                              # browse and restore backups
/smart-compact loops                                # manage persisted open loops
```

Command controls are consumed only from the left edge. Once note text starts,
words such as `fast`, `balanced`, and paths such as `src/auth.ts` remain note
content. Use `--note=...` or `--` when the boundary should be explicit. Invalid
tool modes and budgets return an error instead of silently using defaults.

By default, at 60% context usage the extension participates when Pi starts its
native compaction flow. Set `autoTriggerStrategy` to `settled` to additionally
request that same host flow after an idle agent run crosses the pressure gate.
Long-running agents can also call `smart_compact`, `smart_recall`, and
`smart_save_memory` directly.

> [!IMPORTANT]
> The tool path only stages a verified pending summary for Pi's next natural
> compact. It never compacts the active conversation in the middle of an agent
> turn.

## Why smart compaction?

| Native-style recap | `pi-smart-compact` |
| --- | --- |
| Summarizes prose | Preserves operational coding state |
| Trusts one LLM response | Extracts deterministic ground truth first |
| File/error omissions can be silent | Verifies coverage and repairs known gaps |
| One strategy for every session | Chooses single-pass or hierarchical synthesis |
| No quality feedback | Tracks provenance, damage signals, and metrics |
| No scoped cross-session recall | Searches a project-isolated SQLite FTS5 context graph |

The design principle is simple:

> **Facts first. Synthesis second. Verification before apply.**

Any unresolved verification gap rejects the custom summary before staging or apply. High-risk outcome claims such as “tests passed” or “deployed” must match source messages or a successful related tool result; unsupported claims are removed deterministically. A zero-gap fallback built only from extraction, continuity, and explicit focus/note steering is preferred over unverifiable model output; untrusted chunk prose cannot become the quality floor. A successful compaction must also meet its mode target and at least 10% estimated net savings both before synthesis and after the final summary is measured. Automatic failures leave Pi free to use its native compactor, while manual failures leave the conversation unchanged.

## EESV pipeline

```text
Pi conversation
      │
      ▼
┌───────────┐   ┌───────────┐   ┌────────────┐   ┌───────────┐
│  Extract  │ → │  Explore  │ → │ Synthesize │ → │  Verify   │
│ 0 LLM     │   │ adaptive  │   │ 1-pass or  │   │ + repair  │
│ calls     │   │           │   │ hierarchical│   │           │
└───────────┘   └───────────┘   └────────────┘   └───────────┘
                                                           │
                                                           ▼
                                               staged/applied by Pi
```

| Stage | Responsibility |
| --- | --- |
| **Extract** | Deterministically catalogs files, errors, decisions, constraints, topics, media metadata, and open loops. This is the verification ground truth. |
| **Explore** | Runs only in `thorough` mode (or when `auto` selects it); cheaper modes use deterministic boundaries. |
| **Synthesize** | Uses adaptive single-pass or bounded hierarchical synthesis with per-mode call, prompt-token, chunk, and output budgets. |
| **Verify** | Applies deterministic repairs to a bounded fixed point, then uses a verified deterministic quality floor. Only `thorough` may spend one additional LLM repair call before that fallback. |

### What survives compaction

- The current goal and user constraints
- Modified, read, and deleted files
- Unresolved **and** resolved error history; free-form goal changes never claim an unfixed error was resolved
- Explicit and implicit decisions
- Open follow-ups, blockers, priorities, and pinned loops
- Next actions and critical continuation context
- Changes since the previous compaction
- A bounded **Continuity Ledger** carrying prior decisions, constraints, unresolved errors, and open loops across follow-ups and goal wording changes. Goal shifts are recorded as context; facts retire only through positive resolution evidence or an explicit override.

Summaries use a canonical H1/H2/H3-aware structure, collision-safe file
matching, typed verification gaps, and persisted repair provenance.

### Smart Recall

Applied compactions also index their verified scoped state into a bounded,
project-isolated SQLite FTS5 context graph. `smart_recall` searches goals,
decisions, constraints, unresolved errors, open loops, files, and critical
context across this project's sessions; recall and resolution use the complete
visible branch ancestry, never sibling-branch state. File relationships add
one-hop graph recall without an embedding service or extra LLM call.

`smart_save_memory` persists or explicitly resolves one user-confirmed decision,
constraint, preference, warning, procedure, or context fact. It fails closed
when the working directory is exactly `HOME` or the filesystem root, and
requires an interactive confirmation showing the complete scrubbed title,
content, and paths. Each project may have at most 500 active manual memories.
It rejects empty inputs, scrubs configured secrets/PII, deduplicates exact facts,
and must not be used for guesses, transient progress, secrets, or code that is
cheap to re-read. Set `contextGraphEnabled` to `false` to disable indexing and
both tools.

## Usage surfaces

| Surface | Behavior |
| --- | --- |
| `/smart-compact` | Explicit manual run. Opens a target-first preflight or accepts direct args, dry-run, focus, and budgets. |
| `session_before_compact` | Auto path. Returns/stages a verification-scored summary under pressure; durable state waits for matching `session_compact`. |
| `smart_compact` tool | Agent path. Produces a pending summary for Pi's next natural compact; does not compact mid-turn. |
| `/smart-compact loops` | Project-level open-loop manager: resolve/reopen, priority, pin/unpin. |

### Manual preflight

The interactive command uses the configured summary route and exact execution
planner before spending LLM tokens. Its compact decision card compares the
three modes by estimated after-size and saving, highlights the recommendation,
and keeps only the selected plan plus hard tool-pair/zero-gap guarantees in the
primary view. The plan reserves 25% of the LLM summary allowance for verified
state/delta/continuity sections added after synthesis. Technical estimator,
target, route, and boundary data stays under `D` instead of crowding the decision.

- `↑` / `↓` changes `Fast`, `Balanced`, or `Thorough` and recalculates the plan.
- `Enter` runs only a viable plan; `Esc` cancels without mutation.
- `D` toggles calibrated estimator, target, boundary, and route details.
- `M` opens Advanced model selection and replans with that route's calibration.

Provider-reported token usage is used when available; missing or partial usage
is conservatively estimated for both metrics and aggregate budgets. Every
provider request is clamped to the selected model's advertised output limit
before reservation and dispatch. Smart Compact uses `~`/`≤` language for
post-compaction estimates, measures the completed summary again before staging,
and reports final success only after Pi confirms the matching
`session_compact` run ID. A single long user turn may be
split at a safe message boundary: its older prefix is verified into the summary
while the budgeted working tail stays raw. Tool exchanges remain complete
call/result pairs. Historical exchanges with names outside the portable
provider contract are summarized instead of leaving an unusable raw tail;
oversized result evidence is head/tail bounded only in the synthesis prompt
after deterministic extraction has consumed the full input.
If Verify, yield, provider, or native apply fails, the UI shows one bounded actionable line without evidence text or a
JavaScript stack. A successful `100/100` is labeled **verification coverage**;
the source score and deterministic/LLM/fallback provenance remain visible so
repaired coverage is never presented as raw synthesis quality. Stack diagnostics
are opt-in with `DEBUG=smart-compact`.
During execution a two-line live brief shows the EESV phase chain and the
meaningful current action; it states that the conversation remains unchanged
until verified Apply. Routine phase toasts and raw per-batch watchdog/provider
errors are suppressed by default: handled fallbacks appear as one content-free
brief. `verbose` restores routine phase notices; full stack diagnostics require
`DEBUG=smart-compact`.

### Focus and budgets

```bash
/smart-compact balanced --focus=authentication
/smart-compact fast --max-input-tokens=120000
/smart-compact fast --focus=src/auth.ts --max-calls=3
/smart-compact thorough
```

- `--focus` assigns more synthesis/exploration budget to a topic or path. It
  does **not** attempt unsupported non-contiguous compaction.
- `--max-calls` accepts `1–100`.
- `--max-input-tokens` accepts `10000–1000000` aggregate prompt tokens.
- `--max-latency` accepts `5000–600000` milliseconds as a provider/pipeline cancellation deadline; interactive summary review time is excluded.
- Budget exhaustion is recorded as an explicit fallback outcome and degrades to deterministic summaries instead of dropping context.

The tool exposes equivalent `focus`, `max_calls`, `max_input_tokens`, and
`max_latency_ms` parameters.

## Modes

| Mode | Calls | Prompt cap | Output cap | Behavior |
| --- | ---: | ---: | ---: | --- |
| `fast` | 3 | 100K | 20K | Quickest recovery; 3K summary, 10K recent tail, 30% context target |
| `balanced` | 6 | 200K | 40K | Default quality/speed trade-off; 6K summary, 20K recent tail, 40% target |
| `thorough` | 8 | 300K | 80K | Deepest analysis; 10K summary, 30K recent tail, 50% target, Explore and optional LLM repair |

These are the only three execution modes. Automatic runs choose among them
from context pressure and deterministic session risk; `auto` is a selector,
not a fourth execution policy. Fast can use a zero-call deterministic summary
when extraction confidence is high; otherwise it keeps the bounded LLM path.
The mode token target is binding: recent user turns, pi-toolkit checkpoints,
and topical grouping remain raw only when they fit the planned tail; otherwise
the verified summary carries them forward. Automatic risk refinement may deepen
analysis/repair strategy after extraction, but it does not mutate the profile
allowance or retention window that was already used to prove the target.

Output caps stop subsequent calls after reported or conservatively estimated usage reaches the threshold.
The ChatGPT Codex subscription endpoint rejects `max_output_tokens`,
`max_tokens`, and `max_completion_tokens`; Smart Compact therefore enforces a
15–90 second per-call watchdog plus a streamed visible-output ceiling and falls
back deterministically on abort. Custom Codex endpoints receive
`max_output_tokens` through Pi AI's payload hook.

Legacy compression profiles remain as advanced/backwards-compatible policy:
`light` maps to `thorough`, `balanced` maps to `balanced`, and `aggressive` maps
to `fast` with a deprecation warning. The selected model never changes
automatically; `M` changes the summary route inside preflight and recalculates
all three plans.

### Stage-aware provider routing

All stages use the selected Pi model by default. Routing is explicit and
independent of modes:

| Stage | Config key | Default |
|---|---|---|
| Explore / segmentation | `segmentationModel` | selected model |
| Synthesis / assembly | `summaryModel` | selected model |
| Verification repair | `verificationModel` | summary/selected model |

Every run persists per-stage provider, model, reliability, latency, and token
telemetry with schema-versioned verifier quality. `bun run provider-eval`
builds an advisory matrix by context pressure and tool density; it never edits
configuration or selects a model. Legacy rows contribute operational evidence
but not quality because old verifier score semantics are incompatible.

A reproducible paid-API probe is opt-in only:

```bash
bun run provider-eval:live --live \
  --models=openai/gpt-5.4,anthropic/claude-sonnet-4-6
```

It runs three bounded, identical coding-continuity scenarios and reports
verification score, latency, and token usage. Apply a route manually only after
representative evidence. See the dated [provider evaluation baseline](./docs/provider-evaluation-2026-08-06.md).

### Privacy-safe telemetry and canary gates

Raw local JSONL remains available to the interactive dashboard, while
`bun run telemetry-report` emits aggregate-only telemetry: no session/project
IDs, prompts, summaries, paths, or error text. Failures use a stable taxonomy
(cancelled, timeout, rate limit, authentication, budget, output limit,
provider, persistence, validation, verification, **yield**, internal).
Verification and yield failures retain only content-free diagnostics.

Set `telemetryChannel` to `canary` only on the externally selected canary
cohort. The report shows total/applied counts, but only non-dry, host-confirmed
applied runs satisfy promotion evidence. A deterministic green check never
implies `PROMOTE`; the report compares schema-v2 canary runs with the stable
baseline and returns `HOLD`, `ROLLBACK`, or `PROMOTE`. Rollback triggers are: failure rate
+5pp and ≥10%, verifier quality −5 points, p95 latency +50%, tokens +50%,
heuristic fallback +10pp, or post-compaction damage +10pp. Promotion requires
20 non-dry applied canary runs, a stable baseline, ≥70% verifier-quality coverage,
≥70% run-correlated damage-observation coverage in both cohorts, ≥85 absolute
canary quality, and ≥95% success. The extension reports the decision; it never
edits config or deploys automatically.

The interactive and HTML dashboards make trust evidence explicit: a **Data
Confidence** score (target ≥85) combines recent sample size (25 points),
schema-v2 coverage (25), verifier-quality coverage (20), field completeness
(20), and seven-day freshness (10). Separate views show repair gain and quality
bands, stage/provider/model reliability with quality coverage, stable-vs-canary
deltas, rollback triggers, and the failure taxonomy. Low confidence is shown as
low—not silently filled from incompatible legacy scores—and includes concrete
guidance for reaching the target.

## Safety and privacy

### Deterministic safeguards

- Tool-call-aware recent-tail budgeting
- Exact access-call pruning—different reads, searches, offsets, and patterns do not collapse
- Tool-call/tool-result pair integrity at the compaction boundary
- Collision-safe modified-file verification for monorepos
- Bounded fixed-point repair for patchable verification gaps, followed by a zero-gap deterministic quality floor
- High-risk success claims are grounded only in successful host/tool results or
  deterministic resolved-error/file evidence; assistant prose is never proof
  of its own claim.
- The window planner converts provider output caps through the calibrated local
  estimator and reserves bounded deterministic repair/state additions before
  choosing the retained tail.
- Recent resolved errors remain explicit in the Continuity Ledger instead of
  disappearing when they leave the unresolved set.
- Cross-session guard and five-minute TTL for pending summaries
- Session-log recovery for older, truncated tool results
- The full selected pre-prune conversation is scrubbed and prepared in memory;
  its 0600 backup is written only after the matching native compaction succeeds.
  Marker-owned retention leaves foreign files in custom directories untouched.
- Private artifact directories are enforced as 0700 and files as 0600; stale state snapshots and orphaned atomic-write temp files are removed during bounded retention sweeps.

### Secrets and PII

High-confidence secret scrubbing is enabled by default at every relevant trust
boundary:

```text
provider request · extraction cache · backup · state · context graph · pending summary
```

It covers common API keys (including Google and Stripe), AWS/GitHub/GitLab/npm/
Slack tokens, JWTs, bearer tokens, private keys, secret-bearing object fields,
generic credential assignments, and passwords embedded in connection URIs.
Optional email/phone/payment-card scrubbing is available through `scrubPii`.

Secret scrubbing is defense in depth, **not a replacement for proper secret
handling or a dedicated DLP system**. See the
[security policy](https://github.com/alpertarhan/pi-smart-compact/blob/main/SECURITY.md).

### Approval and feedback

- Manual runs show a fail-closed verified-summary **Apply / Cancel** review by
  default (`requireApproval: true`); set it to `false` only to opt out of the
  second modal after preflight. Review time is not charged to the pipeline
  deadline. Fingerprint, continuity state, context graph, prepared backup, and
  success telemetry commit only after the host confirms the matching native
  `session_compact` event. The UI reports `Applied` at that point and separately
  warns if any durable persistence side effect was partial.
- Online damage monitoring observes the first post-compaction messages and
  records re-read files or repeated context. Observations join the originating
  compaction by a local run id; missing evidence lowers coverage rather than
  counting as a clean run. Remediation hints feed affected files into the next
  compaction.
- `adaptiveDamageFeedback` can opt a project into larger preservation budgets
  after repeated high-damage reports.

## Open-loop control

```bash
/smart-compact loops
```

The manager operates on the project's persisted `CompactionState`:

- resolve or reopen a loop
- change priority
- pin or unpin it across later compactions

Overrides use normalized summary identity instead of positional IDs, so a loop
cannot accidentally inherit another loop's state on a later run.

## Configuration

Add `smartCompact` to `~/.pi/agent/settings.json`:

```json
{
  "smartCompact": {
    "mode": "auto",
    "profile": "balanced",
    "summaryModel": null,
    "segmentationModel": null,
    "verificationModel": null,
    "summaryThinkingLevel": "minimal",
    "segmentationThinkingLevel": "minimal",
    "autoTrigger": true,
    "autoTriggerStrategy": "native-hook",
    "minContextPercent": 60,
    "backupEnabled": true,
    "scrubSecrets": true,
    "scrubPii": false,
    "requireApproval": true,
    "maxLlmCalls": 8,
    "maxLlmInputTokens": 0,
    "codexMaxCallMs": 0,
    "maxLatencyMs": 0,
    "focusWeighting": true,
    "zeroCallEnabled": true,
    "contextGraphEnabled": true,
    "telemetryChannel": "stable",
    "onlineDamageMonitor": true,
    "adaptiveDamageFeedback": false,
    "pinPaths": []
  }
}
```

`native-hook` preserves the existing passive behavior. The opt-in proactive
strategy is:

```json
{
  "smartCompact": {
    "autoTrigger": true,
    "autoTriggerStrategy": "settled",
    "minContextPercent": 80
  }
}
```

`settled` requires a Pi host that emits `agent_settled`; the release boundary is
verified against Pi 0.84.0 and 0.84.1.
The settled handler never runs EESV or mutates pending state itself: after
checking finite context pressure, idle/queue state, per-session in-flight
deduplication, and cooldown, it asks Pi to compact. The existing
`session_before_compact` and correlated `session_compact` handlers still own
summary generation, cancellation, apply, and durable commit.

### Per-phase reasoning

Exploration can use a cheaper reasoning level while final synthesis and repair
use a stronger one:

```json
{
  "smartCompact": {
    "segmentationThinkingLevel": "low",
    "summaryThinkingLevel": "high"
  }
}
```

`segmentationThinkingLevel` applies to exploration; `summaryThinkingLevel`
applies to synthesis, assembly, and repair. Both default to `minimal` because
reasoning tokens from multi-call compaction add up quickly. Supported values
are `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Set either value to
`null` to restore the provider's default behavior. An explicit call-level
reasoning option takes precedence.

### Cost safeguards

Automatic and tool-triggered runs operate on Pi's current active context, not
the append-only session history. A same-session staged summary is reused, the
exploration loop is limited to three rounds, provider and outer retries are
disabled, and every mode has finite call plus aggregate prompt-token budgets.
Complete tool-call/result pairs are the hard window boundary. Provider-incompatible
historical tool names move the boundary past their complete exchanges so a
provider switch cannot leave an unsendable raw tail. Recent user turns,
pi-toolkit checkpoints, and topical grouping are soft and may expand the raw
tail only while remaining inside the selected budget. Automatic/tool runs
normally return to Pi's native compactor without an LLM call when no
provider-safe hard boundary can meet the target. Overflow is the safety
exception: EESV keeps
chunked recovery rather than resending an oversized one-shot prompt to native
compaction. Manual `/smart-compact` uses an absolute adaptive tail rather than
a percentage of a large model window. A plan below 10% projected savings never
starts; if the measured final summary misses the same yield/target contract,
the run fails closed before staging or apply.

<details>
<summary><strong>All configuration keys</strong></summary>

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `mode` | `auto \| fast \| balanced \| thorough` | `auto` | Automatic selector or one of the three execution modes |
| `profile` | `light \| balanced \| aggressive` | `balanced` | Legacy/advanced compression profile; used when mode is absent |
| `summaryModel` | `string \| null` | `null` | Uses the active session model when null |
| `segmentationModel` | `string \| null` | `null` | Optional explicit model for Explore |
| `verificationModel` | `string \| null` | `null` | Optional explicit model for LLM verification repair |
| `summaryThinkingLevel` | `minimal \| low \| medium \| high \| xhigh \| max \| null` | `minimal` | Reasoning level for synthesis and repair; provider default when null |
| `segmentationThinkingLevel` | `minimal \| low \| medium \| high \| xhigh \| max \| null` | `minimal` | Reasoning level for exploration; provider default when null |
| `autoTrigger` | `boolean` | `true` | Allow smart compaction in Pi's native hook and the selected trigger strategy |
| `autoTriggerStrategy` | `native-hook \| settled` | `native-hook` | `settled` additionally requests Pi's normal compact flow after an idle high-pressure agent run; verified with Pi 0.84.0+ |
| `autoTriggerTimeoutMs` | `number` | `120000` | Requested auto cancellation deadline; the host hook clamps it to 60s and four LLM calls, shows live phase progress, then safely unwinds to native recovery |
| `minContextPercent` | `number` | `60` | Auto/tool context gate; manual `/smart-compact` warns and bypasses it |
| `backupEnabled` | `boolean` | `true` | Prepare a scrubbed pre-compaction backup; write it only after confirmed apply |
| `backupDir` | `string` | `~/.pi/agent/compact-backups` | Empty config value uses this path |
| `profiles` | object | built-ins | Per-profile numeric overrides |
| `pinPaths` | `string[]` | `[]` | Always preserve matching paths |
| `requireApproval` | `boolean` | `true` | Manual verified-summary review; cancel/error fails closed |
| `scrubSecrets` | `boolean` | `true` | High-confidence credential redaction |
| `scrubPii` | `boolean` | `false` | Email/phone/card-shaped redaction |
| `maxLlmCalls` | integer `0–100` | `8` | Global ceiling combined with the selected mode |
| `maxLlmInputTokens` | integer `0–1000000` | `0` | `0` uses the selected mode's aggregate prompt-token cap |
| `codexMaxCallMs` | integer `0` or `5000–300000` | `0` | ChatGPT Codex per-call watchdog; `0` derives 15–90s from requested output tokens |
| `maxLatencyMs` | `0` or `5000–600000` | `0` | Pipeline cancellation deadline; `0` means unlimited |
| `focusWeighting` | `boolean` | `true` | Weight focused topics/paths higher |
| `zeroCallEnabled` | `boolean` | `true` | Use deterministic synthesis for high-confidence Fast runs |
| `contextGraphEnabled` | `boolean` | `true` | Index verified state and enable project-scoped recall/save tools |
| `telemetryChannel` | `stable \| canary` | `stable` | Tag local schema-v2 metrics for external canary comparison |
| `onlineDamageMonitor` | `boolean` | `true` | Observe post-compaction regression signals |
| `adaptiveDamageFeedback` | `boolean` | `false` | Increase preservation after repeated damage |

The legacy `semanticCompact` root key is still accepted for compatibility.

</details>

## Example summary

<details>
<summary><strong>Show canonical output</strong></summary>

```markdown
## Goal
Tighten aggregate token budgets without breaking cancellation.

## Constraints & Preferences
- [requirement] Never compact mid-turn from the tool path.

## Progress
### Done
- [x] Reserved concurrent output budgets before provider calls.
### In Progress
- [ ] Collect canary evidence for the new limits.
### Blocked
- None.

## Key Decisions
- **Charge failed streams conservatively**: an interrupted stream consumes its output reservation.

## Files Modified
- src/infra/services.ts
- src/utils/cache.ts

## Open Loops
- [high] Verify provider usage reconciliation across cache-read/write responses.

## Changes Since Last Compaction
- Concurrent output accounting now fails closed.

## Next Steps
1. Run the adversarial release gate.

## Critical Context
- Input accounting includes uncached input, cache reads, and cache writes.
```

</details>

## Observability and recovery

```bash
/smart-compact metrics       # text report
/smart-compact dashboard     # interactive TUI; can write a local HTML report
/smart-compact restore       # browse, inspect, and restore backups
```

Metrics include effective mode, profile, provider, phase timing, token/call estimates,
verification quality, cache behavior, redactions, adaptation, fallbacks, and
cancelled runs.

<details>
<summary><strong>Runtime artifacts</strong></summary>

Default artifacts live under `~/.pi/agent/`. Smart Compact normalizes the
private directories it creates to `0700` and its files to `0600`; a custom
`backupDir` receives the same protection. `settings.json` remains host-owned
and read-only to the extension.

| Path | Purpose |
| --- | --- |
| `settings.json` | Configuration (read only) |
| `compact-backups/` | Full selected pre-prune conversation backups, scrubbed before write and retention-pruned |
| `.cache/compact-extraction-<session>.json` | Incremental extraction cache |
| `.cache/compact-metrics.jsonl` | Tail-retained metrics log; 5 MiB cap |
| `.cache/smart-compact-report.html` | Local HTML dashboard |
| `.cache/smart-compact/projects/<projectId>.json` | Project fingerprint |
| `.cache/smart-compact/states/<projectId>/<sessionId>.json` | Scoped compaction state and loop overrides |
| `.cache/smart-compact/run-locks/` | 0600 cross-process session/global concurrency leases |
| `.cache/smart-compact/native-continuity/` | 0600 one-shot project/session/branch handoffs |
| `.cache/smart-compact/context-graph.sqlite` | Project-isolated FTS5 context graph and explicit saved memory |
| `.cache/smart-compact/damage-reports.jsonl` | Damage reports; 5 MiB cap |
| `.cache/smart-compact/remediation-<projectId>.json` | Files to preserve after damage |

</details>

## Compatibility

Pi core packages are host-provided wildcard peers and are excluded from the
published bundle. The lockfile gives contributors a reproducible baseline,
while CI validates the latest Pi release daily without changing the manifest.
An exact version can be checked with `bun run compat:pi <version>`.

`pi-smart-compact` is designed to coexist with
[`pi-toolkit`](https://github.com/ersintarhan/pi-toolkit): toolkit handles daily
context hygiene; smart-compact handles high-pressure verified compaction. If
another extension also owns `session_before_compact` or rewrites branch history,
coordinate hook order or prefer a single automatic compaction owner.

## Development

```bash
bun install --frozen-lockfile
bun run release:check   # typecheck + tests + adversarial/performance gates + build + package audit
bun run bench           # standalone hot-path p95 regression gate
bun run compat:pi       # isolated latest-Pi compatibility check
```

Pull requests run the same deterministic checks in GitHub Actions. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for focused test commands and
[docs/RELEASE.md](./docs/RELEASE.md) for publication and canary gates.

## Project documentation

- [Architecture](https://github.com/alpertarhan/pi-smart-compact/blob/main/ARCHITECTURE.md)
- [Changelog](https://github.com/alpertarhan/pi-smart-compact/blob/main/CHANGELOG.md)
- [Contributing](https://github.com/alpertarhan/pi-smart-compact/blob/main/CONTRIBUTING.md)
- [Security](https://github.com/alpertarhan/pi-smart-compact/blob/main/SECURITY.md)
- [Support](https://github.com/alpertarhan/pi-smart-compact/blob/main/SUPPORT.md)
- [v8 migration guide](https://github.com/alpertarhan/pi-smart-compact/blob/main/docs/MIGRATING_TO_V8.md)
- [Release checklist](https://github.com/alpertarhan/pi-smart-compact/blob/main/docs/RELEASE.md)

## License

MIT © [Alper Tarhan](https://github.com/alpertarhan)
