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

</div>

## Install

```bash
pi install npm:pi-smart-compact
```

Or install directly from GitHub:

```bash
pi install git:github.com/alpertarhan/pi-smart-compact
```

## Quick start

```bash
/smart-compact                                         # interactive model + profile picker
/smart-compact balanced                                # direct profile
/smart-compact anthropic/claude-sonnet-4 balanced     # direct model + profile
/smart-compact balanced --focus=auth                   # preserve extra auth detail
/smart-compact metrics                                 # text metrics report
/smart-compact dashboard                               # interactive metrics dashboard
/smart-compact restore                                 # browse and restore backups
/smart-compact loops                                   # manage persisted open loops
```

The extension also participates in Pi's native compaction flow automatically
when actual context usage crosses the configured threshold (60% by default),
and exposes a `smart_compact` tool for long-running agents.

> The tool path stages a safe pending summary. It never compacts the active
> conversation in the middle of an agent turn.

## Why smart compaction?

| Native-style recap | `pi-smart-compact` |
| --- | --- |
| Summarizes prose | Preserves operational coding state |
| Trusts one LLM response | Extracts deterministic ground truth first |
| File/error omissions can be silent | Verifies coverage and repairs known gaps |
| One strategy for every session | Chooses single-pass or hierarchical synthesis |
| No quality feedback | Tracks provenance, damage signals, and metrics |

The design principle is simple:

> **Facts first. Synthesis second. Verification before apply.**

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
| **Explore** | Uses a cheaper segmentation model when a complex session needs deeper topic boundaries or error-chain inspection. Simple sessions skip it. |
| **Synthesize** | Uses one pass for short sessions and bounded chunk/assembly fallbacks for long sessions. Focus and call/latency budgets are enforced here. |
| **Verify** | Checks canonical sections and extracted facts, applies every safe deterministic repair, and escalates only unresolved low-scoring gaps to an LLM patch. |

### What survives compaction

- The current goal and user constraints
- Modified, read, and deleted files
- Unresolved **and** resolved error history
- Explicit and implicit decisions
- Open follow-ups, blockers, priorities, and pinned loops
- Next actions and critical continuation context
- Changes since the previous compaction

Summaries use a canonical H1/H2/H3-aware structure, collision-safe file
matching, typed verification gaps, and persisted repair provenance.

## Usage surfaces

| Surface | Behavior |
| --- | --- |
| `/smart-compact` | Explicit manual run. Supports picker UI, direct args, dry-run, focus, and budgets. |
| `session_before_compact` | Auto path. Runs before Pi's native compaction and returns a verification-scored result when context pressure is high. |
| `smart_compact` tool | Agent path. Produces a pending summary for Pi's next natural compact; does not compact mid-turn. |
| `/smart-compact loops` | Project-level open-loop manager: resolve/reopen, priority, pin/unpin. |

### Focus and budgets

```bash
/smart-compact balanced --focus=authentication
/smart-compact aggressive --max-calls=6 --max-latency=30000
/smart-compact balanced --focus=src/auth.ts --max-calls=8
```

- `--focus` assigns more synthesis/exploration budget to a topic or path. It
  does **not** attempt unsupported non-contiguous compaction.
- `--max-calls` accepts `1–100`.
- `--max-latency` accepts `5000–600000` milliseconds.
- Call-budget exhaustion degrades to deterministic summaries. The latency
  budget is a hard cancellation deadline.

The tool exposes equivalent `focus`, `max_calls`, and `max_latency_ms`
parameters.

## Profiles

| Profile | Summary budget | Recent context kept | Best for |
| --- | ---: | ---: | --- |
| `light` | 10,000 tokens | 30,000 tokens | Maximum continuity and detail |
| `balanced` | 6,000 tokens | 20,000 tokens | General use; default |
| `aggressive` | 3,000 tokens | 10,000 tokens | Tight context budgets |

Profiles are a starting policy. Provider/model calibration, conversation shape,
focus hints, damage feedback, and explicit budgets refine the actual run.

## Safety and privacy

### Deterministic safeguards

- Tool-call-aware recent-tail budgeting
- Exact access-call pruning—different reads, searches, offsets, and patterns do not collapse
- Tool-call/tool-result pair integrity at the compaction boundary
- Collision-safe modified-file verification for monorepos
- Mandatory deterministic repair for patchable verification gaps
- Cross-session guard and five-minute TTL for pending summaries
- Session-log recovery for older, truncated tool results
- Retention-pruned backups before compaction

### Secrets and PII

High-confidence secret scrubbing is enabled by default at every relevant trust
boundary:

```text
provider request · extraction cache · backup · state · pending summary
```

It covers common API keys, cloud/GitHub/Slack tokens, JWTs, bearer tokens,
private keys, and credential assignments. Optional email/phone/payment-card
scrubbing is available through `scrubPii`.

Secret scrubbing is defense in depth, **not a replacement for proper secret
handling or a dedicated DLP system**. See the
[security policy](https://github.com/alpertarhan/pi-smart-compact/blob/main/SECURITY.md).

### Approval and feedback

- `requireApproval: true` adds a fail-closed manual **Apply / Cancel** decision
  after the provenance review screen. Auto and tool paths retain their native
  staged lifecycle.
- Online damage monitoring observes the first post-compaction messages and
  records re-read files or repeated context. Remediation hints feed those files
  into the next compaction.
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
    "profile": "balanced",
    "summaryModel": null,
    "segmentationModel": null,
    "summaryThinkingLevel": null,
    "segmentationThinkingLevel": null,
    "autoTrigger": true,
    "minContextPercent": 60,
    "backupEnabled": true,
    "scrubSecrets": true,
    "scrubPii": false,
    "requireApproval": false,
    "maxLlmCalls": 0,
    "maxLatencyMs": 0,
    "focusWeighting": true,
    "onlineDamageMonitor": true,
    "adaptiveDamageFeedback": false,
    "pinPaths": []
  }
}
```

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
applies to synthesis, assembly, and repair. Supported values are `minimal`,
`low`, `medium`, `high`, `xhigh`, and `max`. Leave either value as `null` to
preserve the provider's existing behavior. An explicit call-level reasoning
option takes precedence over these defaults.

<details>
<summary><strong>All configuration keys</strong></summary>

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `profile` | `light \| balanced \| aggressive` | `balanced` | Default policy profile |
| `summaryModel` | `string \| null` | `null` | Uses the active session model when null |
| `segmentationModel` | `string \| null` | `null` | Optional cheaper model for Explore |
| `summaryThinkingLevel` | `minimal \| low \| medium \| high \| xhigh \| max \| null` | `null` | Reasoning level for synthesis and repair; provider default when null |
| `segmentationThinkingLevel` | `minimal \| low \| medium \| high \| xhigh \| max \| null` | `null` | Reasoning level for exploration; provider default when null |
| `autoTrigger` | `boolean` | `true` | Participate in Pi's native compact hook |
| `autoTriggerTimeoutMs` | `number` | `120000` | Hard timeout for automatic runs |
| `minContextPercent` | `number` | `60` | Actual context usage gate |
| `backupEnabled` | `boolean` | `true` | Write a pre-compaction backup |
| `backupDir` | `string` | `~/.pi/agent/compact-backups` | Empty config value uses this path |
| `profiles` | object | built-ins | Per-profile numeric overrides |
| `pinPaths` | `string[]` | `[]` | Always preserve matching paths |
| `requireApproval` | `boolean` | `false` | Manual UI only; cancel/error fails closed |
| `scrubSecrets` | `boolean` | `true` | High-confidence credential redaction |
| `scrubPii` | `boolean` | `false` | Email/phone/card-shaped redaction |
| `maxLlmCalls` | integer `0–100` | `0` | `0` means unlimited |
| `maxLatencyMs` | `0` or `5000–600000` | `0` | `0` means unlimited |
| `focusWeighting` | `boolean` | `true` | Weight focused topics/paths higher |
| `onlineDamageMonitor` | `boolean` | `true` | Observe post-compaction regression signals |
| `adaptiveDamageFeedback` | `boolean` | `false` | Increase preservation after repeated damage |

The legacy `semanticCompact` root key is still accepted for compatibility.

</details>

## Example summary

<details>
<summary><strong>Show canonical output</strong></summary>

```markdown
## Goal
Add retry/backoff to the LLM client without breaking cancellation.

## Constraints & Preferences
- [requirement] Never compact mid-turn from the tool path.

## Progress
### Done
- [x] Added `withRetry` in `src/infra/llm-retry.ts`.
### In Progress
- [ ] Wire the retry client into run-scoped services.
### Blocked
- None.

## Key Decisions
- **Honor Retry-After verbatim**: provider limits are authoritative.

## Files Modified
- src/infra/llm-retry.ts
- src/infra/llm-client.ts

## Open Loops
- [high] Preserve AbortSignal behavior across providers.

## Changes Since Last Compaction
- New files touched: src/infra/llm-retry.ts

## Next Steps
1. Add an outer timeout as a second line of defense.

## Critical Context
- Retry 408/425/429/5xx; fail fast on other 4xx responses.
```

</details>

## Observability and recovery

```bash
/smart-compact metrics       # text report
/smart-compact dashboard     # interactive TUI; can write a local HTML report
/smart-compact restore       # browse, inspect, and restore backups
```

Metrics include method, profile, provider, phase timing, token/call estimates,
verification quality, cache behavior, redactions, adaptation, fallbacks, and
cancelled runs.

<details>
<summary><strong>Runtime artifacts</strong></summary>

All files live under `~/.pi/agent/`.

| Path | Purpose |
| --- | --- |
| `settings.json` | Configuration (read only) |
| `compact-backups/` | Retention-pruned conversation backups |
| `.cache/compact-extraction-<session>.json` | Incremental extraction cache |
| `.cache/compact-metrics.jsonl` | Tail-retained metrics log; 5 MiB cap |
| `.cache/smart-compact-report.html` | Local HTML dashboard |
| `.cache/smart-compact/projects/<projectId>.json` | Project fingerprint |
| `.cache/smart-compact/states/<projectId>.json` | Compaction state and loop overrides |
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
bun install
bun run typecheck
bun test
bun run gate          # deterministic adversarial EESV release gate
bun run bench
bun run build
bun run compat:pi     # isolated latest-Pi compatibility check
```

Pull requests run typecheck, the complete test suite, the adversarial gate, and
the build in GitHub Actions.

## Project documentation

- [Architecture](https://github.com/alpertarhan/pi-smart-compact/blob/main/ARCHITECTURE.md)
- [Changelog](https://github.com/alpertarhan/pi-smart-compact/blob/main/CHANGELOG.md)
- [Contributing](https://github.com/alpertarhan/pi-smart-compact/blob/main/CONTRIBUTING.md)
- [Security](https://github.com/alpertarhan/pi-smart-compact/blob/main/SECURITY.md)
- [Support](https://github.com/alpertarhan/pi-smart-compact/blob/main/SUPPORT.md)
- [Release checklist](https://github.com/alpertarhan/pi-smart-compact/blob/main/docs/RELEASE.md)

## License

MIT © [Alper Tarhan](https://github.com/alpertarhan)
