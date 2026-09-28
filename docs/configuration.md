# Pi Continuity configuration reference

This page lists every setting, its default and how settings combine. For
task-oriented instructions, start with the [user guide](./guide.md).

Pi Continuity is the product name only. Settings keep their technical names:
everything lives under the `smartCompact` key, and the settings screen is opened
with `/smart-compact settings`.

Defaults on this page were checked against the current source checkout
(`9.8.0-canary.6`; local-only, not published). Some capabilities
and keys are newer than the latest stable changelog entry, `9.7.1`; check
[the changelog](../CHANGELOG.md) for your installed version.

## Contents

- [Where settings live](#where-settings-live)
- [How settings combine](#how-settings-combine)
- [Presets](#presets)
- [Automatic strategies](#automatic-strategies)
- [Modes and budgets](#modes-and-budgets)
- [Models and reasoning](#models-and-reasoning)
- [Compaction engines](#compaction-engines)
- [Context hygiene and archives](#context-hygiene-and-archives)
- [Agent tools and session navigation](#agent-tools-and-session-navigation)
- [Memory](#memory)
- [Privacy and backups](#privacy-and-backups)
- [All settings](#all-settings)
- [Legacy and removed keys](#legacy-and-removed-keys)
- [Examples](#examples)

## Where settings live

Global settings are stored in the `smartCompact` section of
`~/.pi/agent/settings.json` (Pi's own settings file). Only this global file is
read for `smartCompact`.

| Way to change | Notes |
| --- | --- |
| Home → **Settings** | Task-level presets: `How it runs`, `Summary format`, `Models`, `Memory` |
| `/smart-compact settings` or Settings → **Advanced settings** | Every setting by category, plus `This branch only` (TUI only) |
| Edit `settings.json` | Any key; read on the next operation |

The categorized screen groups settings as: `Compaction`, `Models & thinking`,
`Memory`, `Tool output cleanup`, `Privacy & safety`, `This branch only`,
`Advanced` (with `› Limits` and `› Mode budgets`). Labels are for reading;
stored keys and values are unchanged.

Settings screen behavior:

- `•` marks a changed setting; each category shows how many are changed.
- `r` resets the selected row: the key is removed from `settings.json` so the
  built-in default applies again. On the branch page, `r` resets to `global`.
- Rows that depend on another setting stay visible, marked inactive with the
  reason (for example "used only when Memory store = Hindsight server").
- Invalid or converted values in `settings.json` are listed in one warning line
  at the top.
- Each change is validated as a whole before writing. A preset is one atomic
  write. Other Pi and extension keys are preserved.

Writes use a lock directory, `~/.pi/agent/settings.json.lock`, and fail closed
while it exists. If Pi was killed during a write, verify that no Pi process is
writing settings, then remove the stale lock directory by hand.

Invalid values in `settings.json` never stop the extension: the value is
discarded with a warning and the default is used. Invalid or unreadable JSON
means all defaults are used.

### When changes take effect

| Change | Takes effect |
| --- | --- |
| Agent access, automatic compaction, footer status, memory tool exposure (from the TUI) | Immediately; tool schemas and prompt guidance update on the next agent turn |
| Mode, models, budgets, privacy, paths, profiles, monitoring | Next compaction or indexing; a running compaction keeps its starting configuration |
| Hand edits to `settings.json` | Next operation (the file's modification time is checked). Active tools and footer refresh on `/reload` or session restore; no file watcher runs. |

Which agent tools are visible is decided only at session start and after a
compaction; see [agent tools](./guide.md#agent-tools).

## How settings combine

From lowest to highest precedence:

1. Built-in defaults.
2. Global `smartCompact` settings in `~/.pi/agent/settings.json`.
3. Branch overrides (`This branch only`) for three settings only.
4. Per-run options on `/smart-compact` or the `smart_compact` tool (mode, focus
   and budgets).

Hard caps apply on top of all of them, for example the
[automatic run cap](#automatic-runs-cap).

### Branch overrides

`This branch only` holds sparse overrides stored in the session history, not in
`settings.json`. Moving in Pi's session tree restores each branch's overrides.

| Row | Values | Overrides |
| --- | --- | --- |
| `Agent can compact` | `global`, `Follow Pi`, `Allowed`, `Not allowed` | `agentToolAccess` |
| `Automatic compaction` | `global`, `enabled`, `disabled` | `autoTrigger` |
| `Footer status` | `global`, `enabled`, `disabled` | `showStatus` |

`global` means "use the saved setting". Each row shows the effective value.

## Presets

Presets are shortcuts. The current preset is derived from the stored flags;
nothing new is stored.

### How it runs

| Preset | `autoTrigger` | `autoTriggerStrategy` | `contextHygieneEnabled` | `agentToolAccess` |
| --- | --- | --- | --- | --- |
| `With Pi (default)` | `true` | `native-hook` | `false` | `inherit` |
| `Manual only` | `false` | unchanged | `false` | `disabled` |
| `Manual + agent` | `false` | unchanged | `false` | `enabled` |
| `Cleanup only` | `false` | unchanged | `true` | `disabled` |
| `Fully automatic` | `true` | `settled` | `true` | `disabled` |

`With Pi (default)` is the unchanged built-in default, not a preset you pick.
Any other combination is shown as `Custom` with a one-line description. Existing
`native-hook` configurations are not migrated to `settled`.

### Summary format

| Preset | `compactionEngines` | `visualArchiveEnabled` |
| --- | --- | --- |
| `Verified text` | default (`["eesv"]`) | default (`false`) |
| `Text + images` | default (`["eesv"]`) | `true` |
| `Provider (experimental)` | `["native", "eesv"]` | default (`false`) |

`Provider (experimental)` needs a second `Enter` to confirm. A row shows
`text only now` when the current chat model cannot use images or provider
compaction; you can still select it.

### Models

| Preset | Effect |
| --- | --- |
| `Chat model` | All stages use the model you are chatting with (all three model keys `null`) |
| `Choose summary model` | Sets `summaryModel`; segmentation and verification inherit it |
| `Advanced model routing` | Set each stage separately |

## Automatic strategies

`autoTrigger` is the master switch for Smart Compact's own automatic
compaction. `autoTriggerStrategy` chooses how it starts.

| `autoTriggerStrategy` | TUI label (`Start when`) | Who decides when | Needs Pi auto-compaction |
| --- | --- | --- | --- |
| `native-hook` (default) | `Before Pi's compaction` | Pi | Yes |
| `settled` | `When idle` | Smart Compact, at an idle boundary | No |
| `background` | `Prepare in background` | Smart Compact; also prepares early | No |

Rules that hold for all strategies:

- `autoTrigger: false` disables **both** `settled` and `background`, and
  `native-hook` replacement. It does not disable Pi's own compactor. Changing
  the strategy never turns a disabled trigger back on.
- All strategies use Pi's normal compaction lifecycle. A summary is committed
  only when Pi confirms the matching compaction.
- `requireApproval` applies to manual runs only.

### native-hook: passive

Smart Compact acts only when Pi starts a compaction. `minContextPercent` is a
**replacement gate**, not a schedule: below it, Smart Compact lets Pi's own
summary run. Overflow recovery skips the percentage gate. Extensions cannot read
whether Pi's auto-compaction is enabled, so readiness reports it as `unknown`,
not as on. If it is off, nothing compacts automatically.

### settled: idle boundary

At the next idle, queue-empty boundary where context is at least
`minContextPercent` of the active model's window (and at least 5,000 tokens),
Smart Compact asks Pi to compact. A running tool loop is not interrupted. After
any confirmed compaction there is a 10-minute cooldown. Pi's own threshold and
overflow triggers stay active.

### background: early preparation

Like `settled`, but a summary is prepared earlier, on a completed turn's
snapshot, without adding a tool call or blocking the next turn. Preparation
hides latency, not cost: an unused summary still spends its model budget.

| Item | Value |
| --- | --- |
| Prepare gate | `prepareContextPercent`; must be 0–100 and strictly below `minContextPercent` |
| `prepareContextPercent: null` (Auto) | Starts 12.5% of the apply-token threshold earlier, bounded to 8,192–32,000 tokens |
| Concurrency | One speculative task per extension |
| Retry cooldown | 10 minutes |
| Ready result lifetime | 5 minutes |
| Context hygiene | Pressure-gated trims run under this strategy even if `contextHygieneEnabled` is off (needs active `smart_context`); break-even and cold-cache trims need `contextHygieneEnabled` |

Example: with `prepareContextPercent: 60` and `minContextPercent: 70` in a 200k
window, preparation starts at 120k and applies at 140k. With Auto and an 80%
apply gate in a 200k window, preparation starts at 140k (160k minus a 20k lead).

At apply, the prepared summary is revalidated against session, branch,
projected content, model, configuration, target and response headroom. A
changed, expired or unfinished preparation is discarded, and Smart Compact
falls back to a normal run or Pi's own compactor. New messages after the
snapshot stay verbatim. When cleanup changes the context first, preparation
waits for a later boundary. Preparation is silent while healthy; its state
appears in the effective-state view (`Readiness & details`, preflight `S`,
`metrics`).

### Context cap for automatic percentages

`maxContextTokens` (default `0`, off) caps the window that automatic trigger
percentages are measured against: `min(model window, maxContextTokens)`. It
applies to the `native-hook` replacement gate, the `settled` trigger, the
`background` preparation window and the automatic run's admission gate. With
`maxContextTokens: 200000` and `minContextPercent: 60`, a 1M-window model
compacts from 120k tokens instead of 600k.

It does not change model requests, the model window Pi reports, Pi's own
compaction threshold, summary and retention sizing, or the hard response
headroom checked before a summary is applied; those keep the real window. A
cap at or above the model window has no effect. When a model window exceeds
400k tokens and no smaller cap is set, Home shows a warning while automatic
compaction is on.

### Automatic runs cap

Automatic runs (native-hook, settled and background) are capped at **60
seconds** and **four model calls**. `autoTriggerTimeoutMs` defaults to 120,000
ms and accepts up to 300,000 ms, but the effective automatic deadline is
`min(autoTriggerTimeoutMs × provider timeout multiplier, 60 s)`. The call cap is
`min(mode call budget, 4)`. When an automatic run times out or fails, it unwinds
so Pi's own compactor can run.

Manual runs are not subject to this cap; they use `maxLatencyMs` (default: no
limit) and the mode budgets below.

## Modes and budgets

| Mode | Calls | Prompt tokens | Output tokens | Summary budget | Recent tail kept raw | Context target | Explore / LLM repair |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `fast` | 3 | 100K | 20K | 3K | 10K | 30% | No / No |
| `balanced` | 6 | 200K | 40K | 6K | 20K | 40% | No / No |
| `thorough` | 8 | 300K | 80K | 10K | 30K | 50% | Yes / Yes |

- `auto` (default) is a selector, not a fourth policy. At 85% context or above
  it picks `fast`. Otherwise it picks by extracted session risk: many
  unresolved errors, decisions, constraints and modified files push toward
  `thorough`, a simple session toward `fast`.
- `fast` can build the summary with no model call (`Local summaries`,
  `zeroCallEnabled`) when extraction confidence is high.
- The mode's token target is binding. Recent turns stay raw only if they fit
  the planned tail.
- The summary and tail sizes come from the profile each mode uses (`fast` →
  `aggressive`, `balanced` → `balanced`, `thorough` → `light`). Change them in
  `› Mode budgets` (`profiles`), which lists them by mode: `Fast`, `Balanced`,
  `Thorough`. `auto` uses the budgets of the mode it picks for the run.

### How a budget is chosen

For calls (`maxLlmCalls`) and prompt tokens (`maxLlmInputTokens`):

| Source | Result |
| --- | --- |
| Per-run option (`--max-calls`, `max_calls`, ...) | Used as given, even above the mode limit |
| Config value `0` | The mode limit |
| Config value above `0` | `min(config value, mode limit)` |
| Automatic run | Additionally capped at 4 calls and 60 s |

With the default `maxLlmCalls: 8`, every mode keeps its own limit, because 8 is
not below any mode's call limit. A config value can only lower the limit.

Per-run options accept narrower ranges than the settings:

| Budget | Per-run option | Setting |
| --- | --- | --- |
| Calls | `--max-calls` / `max_calls`: 1–100 | `maxLlmCalls`: 0–100 |
| Prompt tokens | `--max-input-tokens` / `max_input_tokens`: 10,000–1,000,000 | `maxLlmInputTokens`: 0–1,000,000 |
| Deadline (ms) | `--max-latency` / `max_latency_ms`: 5,000–600,000 | `maxLatencyMs`: 0 or 5,000–7,200,000 |

Running out of calls or tokens falls back to a deterministic summary. A deadline
or cancellation stops the run: no staged summary, no apply, and a manual
timeout does not start Pi's compactor.

### Provider capability guards

- Every request is clamped to the model's advertised output limit before it is
  reserved and sent. 4,096 tokens of SDK headroom are also reserved.
- The model picker and readiness check planned stage requests against each
  model's window. Models that cannot fit are unavailable with a reason. Sizes
  known only after generation are rechecked before each request.
- ChatGPT/Codex subscription endpoints reject output-limit fields. Smart
  Compact uses a client-side per-call watchdog (`codexMaxCallMs`; `0` derives
  15–90 s) and a streamed-output ceiling instead. This is not a hard provider
  limit.
- Missing or partial provider usage is estimated conservatively.

### Legacy `profile`

`profile` (`light`, `balanced`, `aggressive`) is a legacy setting with no
settings-screen row; `Mode` is the only selector. It selects the mode only when
`mode` is absent from `settings.json` (`light` → `thorough`, `balanced` →
`balanced`, `aggressive` → `fast`); the `Mode` row then notes that its current
value comes from the legacy setting. Once `mode` is saved, including `auto`,
each mode uses its own profile and `profile` does not change runs. Saving or
resetting `Mode` never rewrites `profile` or the `profiles` budgets.

## Models and reasoning

| Stage | Key | TUI label | Default |
| --- | --- | --- | --- |
| Synthesis and assembly | `summaryModel` | `Summary model` | The chat model |
| Explore / topic split | `segmentationModel` | `Topic split model` | The summary model |
| Verification repair | `verificationModel` | `Check & repair model` | The summary model |

Model values are `provider/model` strings. Manual, agent and automatic runs use
the same routes. Choosing a summary model never switches the chat model.

| Key | TUI label | Default | Values |
| --- | --- | --- | --- |
| `summaryThinkingLevel` | `Summary thinking` | `minimal` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `null` (provider default) |
| `segmentationThinkingLevel` | `Topic split thinking` | `minimal` | Same |

`summaryThinkingLevel` covers synthesis, assembly and repair. Both default to
`minimal` because reasoning tokens add up over multi-call compaction. An
explicit call-level reasoning option takes precedence.

Choosing a route based on evidence is covered in
[provider routing evidence](./evaluation.md#provider-routing-evidence).

## Compaction engines

`compactionEngines` is an ordered, non-empty list of unique engines. Engines are
tried in order; the first success applies. If none succeeds, the conversation is
unchanged and one message lists every outcome.

| `Engine` label | `compactionEngines` |
| --- | --- |
| `Smart summary` (default) | `["eesv"]` |
| `Provider, then smart summary` | `["native", "eesv"]` |
| `Provider only` | `["native"]` |
| `Smart summary, then provider` | `["eesv", "native"]` |

`eesv` is the verified text summary. `native` is the provider's own compaction
(Anthropic Messages, OpenAI Codex subscription and OpenAI Responses API key
only). It is unverified and replayed only to the same provider and model;
summarizer routing does not apply to it. See the
[user guide](./guide.md#summary-format-provider-compaction-and-images) for
limits. For subscription users, `Provider, then smart summary` is the safer
choice because a rejected provider request falls back to the smart summary.

## Context hygiene and archives

All three switches are off by default. Automatic trimming does not depend on
which tools the agent sees. Offload runs only while the agent can reach
`smart_context`: active, or loadable through `smart_tools` in On demand mode.
With agent tools `off`, or `smart_context` hidden with `/tools`, new offloads
stop; existing archives stay on disk.

| Key | TUI label | Default | Effect |
| --- | --- | --- | --- |
| `contextHygieneEnabled` | `Automatic cleanup` | `false` | Batched, recoverable trimming. Needs 16,384 characters of net savings and eight assistant turns since the last trim, rewind or compaction; commits under pressure, at break-even, or once the prompt cache is cold (below). Works with `autoTrigger: false`. |
| `artifactOffloadEnabled` | `Offload huge outputs` | `false` | Saves eligible read-only text results of 16,384+ characters before the model sees them. Independent of pressure gates. |
| `visualArchiveEnabled` | `Image snapshots` | `false` | Experimental image snapshots beside the verified text. Adds image tokens; needs a vision model with a validated cost rule and the optional renderer. |
| `pinPaths` | `Always-kept files` | `[]` | Paths every summary must keep |

Fixed limits (not configurable): trim at most 32 outputs of 4,096+ characters
per boundary, keep the latest four assistant turns; each trimmed output becomes
a digest marker of at most 6 lines and 400 characters (retrieval line, call
subject, first output line, up to three error/warning lines; see
[Clean up tool output](./guide.md#clean-up-tool-output)). Trimming covers
successful text from read-only tools, shell (`bash`) output whose call stays
in context, and `smart_context` `read` pages, which point back at their source
ID; errors, writes, unknown tools and mixed turns stay whole. Order within the
32: read-only outputs whose path a later call writes, edits or deletes come
first, then those read again in full later (a plain `read` without
`offset`/`limit`), then the rest, each in session order; their markers note
`(superseded: edited later)` or `(superseded: read again in full later)`.
Paths compare after `path.normalize` only
(relative never matches absolute). This changes order and the note, not
eligibility. Trim and rewind records store a SHA-256 and length of each
archived output; `smart_context` `read`/`search` refuse text that no longer
matches, and records from earlier versions have no hash and are read as
before. Artifacts at most
2 MiB each and 256 files or 32 MiB per origin session; retrieval at most 4,096
characters per read. There is no artifact expiry or garbage collection; see
[storage](./guide.md#storage-and-privacy). `smart_context` with
`scope: "lineage"` follows `parentSession` headers (handoff or fork) at most 3
levels, reads only files of at most 64 MiB, stops at a missing file or a
cycle, and never writes them; the search limits above apply across all
sessions, active branch first.

Automatic trim timing. Let `X` be the estimated tokens a batch removes (net of
its markers) and `T` the estimated tokens of every message from the first
trimmed output to the end, the part of the prompt cache a trim rewrites. With
the active model's catalog prices, `r = cacheRead / input` and
`w = cacheWrite / input` (`w = 1` when no write price is listed), the trim
pays back after `N* = ((w - r) × T) / (r × X)` further requests (`0` when
cache reads are free). At a completed turn boundary a ready batch commits with
cause `pressure` when usage reached the early pressure gate, or `break-even`
when `N* ≤ 24`. Otherwise it is held (`smart_context` `status` reports it as
`deferredTrim`); the first request after the cache expired (5 minutes after
the last response, 1 hour when the last response that wrote cache reported 1h
retention) sends the trimmed messages, later requests keep them, and the edits
commit with cause `cold` at the next completed, uncontested turn. A
Pi cache-warming refresh counts as a response for this expiry; while a batch
is held, warming stops once `p × (missCost − w' × X / 1e6) − warmCost < $0.05`
(Pi's own rule, `w'` = cache-write price per million tokens, or input price
when none is listed). An unknown price only allows `pressure` and `cold`. A
newer compaction, context
edit, session change, queued manual/agent request, or turning
`contextHygieneEnabled` off drops the held batch. Automatic trims need
`smart_context` reachable by the model (`toolLoading` not `off`).
Manual and agent trims commit at the next boundary as before (`manual`,
`agent`). Prices are catalog ratios, not measured cache behavior.

## Agent tools and session navigation

Settings → **Agent tools & navigation**.

| Key | TUI label | Default | Effect |
| --- | --- | --- | --- |
| `toolLoading` | `Agent tools` | `lazy` | `lazy` (On demand): the agent sees the `smart_tools` loader and loads the `navigation`, `history`, `memory` or `compaction` group when needed; loaded groups reset at session start, branch change and compaction. `eager` (Always available): every permitted tool is active from the start. `off`: no context tools; Home, `/smart-compact` and the navigation panel keep working. |
| `contextNavigationEnabled` | `Session navigation` | `true` | Anchors, search and returning to an anchor. Off hides the panel and `smart_navigation`; recorded anchors and the keys below are kept. |
| `contextRecallEnabled` | `Search other sessions` | `true` | Read-only search of anchors saved by earlier sessions, this project by default. |
| `contextPivotEnabled` | `Return to an anchor` | `true` | Returning to an anchor on a new branch with a required carryover. |
| `contextAnchorCacheEnabled` | `Anchor prompt cache` | `true` | Anthropic models: keeps a prompt-cache marker on the newest anchor. |
| `contextAnchorStatusEnabled` | `Anchor status` | `true` | Shows the newest anchor on this branch in Pi's footer; display only. |
| `contextGuidanceEnabled` | `Navigation guide` | `true` | Lets you or the agent open the navigation guide on request; it is never added to a request otherwise. |

Group permissions apply in both `lazy` and `eager` modes: `compaction` follows
`agentToolAccess`, `memory` needs `contextGraphEnabled` or a non-local
`memoryBackend`, and `navigation` needs `contextNavigationEnabled`. Tools hidden
with Pi's `/tools` stay hidden until you show them again.

## Memory

| Key | TUI label | Default | Notes |
| --- | --- | --- | --- |
| `contextGraphEnabled` | `Project memory` | `true` | Local store: index verified compaction state and enable recall/save. Explicit Hindsight/Mnemopi stores keep their tools with this off. |
| `memoryBackend` | `Memory store` | `local` | `local` (`This machine`), `hindsight` (`Hindsight server`), `mnemopi` (`Mnemopi (local SQLite)`) |
| `hindsightBaseUrl` | `Server URL` | `null` | HTTPS, no credentials, query or fragment; plain HTTP only for loopback |
| `hindsightBankId` | `Memory bank` | `null` | Required; 1–128 of letters, digits, `.`, `_`, `-`; never guessed |
| `hindsightApiKeyEnv` | `API key variable` | `null` | Name of the environment variable holding the key, not the key |
| `hindsightTimeoutMs` | `Request timeout (ms)` | `12000` | 1,000–60,000 |
| `hindsightRecallMaxTokens` | `Recall size (tokens)` | `2048` | 128–4,096; output is also capped locally |
| `mnemopiDataDir` | `Mnemopi data folder` | `null` | Absolute or `~/` path; relative paths rejected. Default `~/.pi/agent/smart-compact-memory/mnemopi/<projectId>/` |

Selection rules:

- The selected store is the only store read or written. There is no fallback
  to another store and no local copy; `hindsightLocalFallback` is gone.
- `scope: "session"` recall is supported only by `local`. On Hindsight and
  Mnemopi it fails closed: nothing is read from any store.
- Switching stores leaves the others untouched. Refs stay bound to the store
  and target where they were created.
- Continuity state, backups and artifacts do not depend on the memory store.
- Memory readiness never blocks compaction.

Hindsight details: [Hindsight memory backend](./hindsight-memory.md).

## Privacy and backups

| Key | TUI label | Default | Notes |
| --- | --- | --- | --- |
| `scrubSecrets` | `Scrub secrets` | `true` | High-confidence credential redaction before anything is sent or saved |
| `scrubPii` | `Scrub personal data` | `false` | Email, phone and card-shaped values |
| `backupEnabled` | `Backups` | `true` | Prepare a scrubbed backup; written only after Pi confirms the compaction |
| `backupDir` | `Backup folder` | `""` | Empty uses `~/.pi/agent/compact-backups` |
| `requireApproval` | `Ask before applying` | `true` | Manual review; only `A` applies. Cancel or error leaves the conversation unchanged. |

## All settings

| Key | Type or range | Default | TUI label |
| --- | --- | --- | --- |
| `mode` | `auto` \| `fast` \| `balanced` \| `thorough` | `auto` | `Mode` |
| `profile` | `light` \| `balanced` \| `aggressive` | `balanced` | none (legacy; see [Legacy `profile`](#legacy-profile)) |
| `profiles` | per-profile numeric overrides | built-in | `› Mode budgets` |
| `summaryModel` | `provider/model` \| `null` | `null` | `Summary model` |
| `segmentationModel` | `provider/model` \| `null` | `null` | `Topic split model` |
| `verificationModel` | `provider/model` \| `null` | `null` | `Check & repair model` |
| `summaryThinkingLevel` | level \| `null` | `minimal` | `Summary thinking` |
| `segmentationThinkingLevel` | level \| `null` | `minimal` | `Topic split thinking` |
| `agentToolAccess` | `inherit` \| `enabled` \| `disabled` | `inherit` | `Agent can compact` |
| `toolLoading` | `lazy` \| `eager` \| `off` | `lazy` | `Agent tools` |
| `autoTrigger` | boolean | `true` | `Automatic compaction` |
| `autoTriggerStrategy` | `native-hook` \| `settled` \| `background` | `native-hook` | `Start when` |
| `minContextPercent` | 0–100 | `60` | `Start at context %` |
| `prepareContextPercent` | `null` or 0–100, below `minContextPercent` | `null` | `Prepare at context %` |
| `maxContextTokens` | `0` (off) or integer 16,384–2,000,000 | `0` | `Context cap for start % (tokens)` |
| `autoTriggerTimeoutMs` | integer 1,000–300,000 | `120000` | `Automatic run time limit (ms)`; capped at 60 s |
| `compactionEngines` | ordered list of `eesv`, `native` | `["eesv"]` | `Engine` |
| `requireApproval` | boolean | `true` | `Ask before applying` |
| `showStatus` | boolean | `true` | `Footer status` |
| `maxLlmCalls` | integer 0–100 | `8` | `Max model calls per run` |
| `maxLlmInputTokens` | integer 0–1,000,000 | `0` (mode limit) | `Max input tokens per run` |
| `maxLatencyMs` | `0` or integer 5,000–7,200,000 | `0` (no limit) | `Run time limit (ms)` |
| `codexMaxCallMs` | `0` or integer 5,000–3,600,000 | `0` (auto 15–90 s) | `Stuck-call timeout (ms)` |
| `pendingTtlMs` | integer 1,000–3,600,000 | `300000` | `Prepared summary lifetime (ms)` |
| `contextHygieneEnabled` | boolean | `false` | `Automatic cleanup` |
| `artifactOffloadEnabled` | boolean | `false` | `Offload huge outputs` |
| `visualArchiveEnabled` | boolean | `false` | `Image snapshots` |
| `pinPaths` | string array | `[]` | `Always-kept files` |
| `contextNavigationEnabled` | boolean | `true` | `Session navigation` |
| `contextRecallEnabled` | boolean | `true` | `Search other sessions` |
| `contextPivotEnabled` | boolean | `true` | `Return to an anchor` |
| `contextAnchorCacheEnabled` | boolean | `true` | `Anchor prompt cache` |
| `contextAnchorStatusEnabled` | boolean | `true` | `Anchor status` |
| `contextGuidanceEnabled` | boolean | `true` | `Navigation guide` |
| `scrubSecrets` | boolean | `true` | `Scrub secrets` |
| `scrubPii` | boolean | `false` | `Scrub personal data` |
| `backupEnabled` | boolean | `true` | `Backups` |
| `backupDir` | string | `""` | `Backup folder` |
| `contextGraphEnabled` | boolean | `true` | `Project memory` |
| `memoryBackend` | `local` \| `hindsight` \| `mnemopi` | `local` | `Memory store` |
| `hindsightBaseUrl` | URL \| `null` | `null` | `Server URL` |
| `hindsightBankId` | string \| `null` | `null` | `Memory bank` |
| `hindsightApiKeyEnv` | env var name \| `null` | `null` | `API key variable` |
| `hindsightTimeoutMs` | integer 1,000–60,000 | `12000` | `Request timeout (ms)` |
| `hindsightRecallMaxTokens` | integer 128–4,096 | `2048` | `Recall size (tokens)` |
| `mnemopiDataDir` | absolute or `~/` path \| `null` | `null` | `Mnemopi data folder` |
| `focusWeighting` | boolean | `true` | `Prioritize current task` |
| `zeroCallEnabled` | boolean | `true` | `Local summaries` |
| `onlineDamageMonitor` | boolean | `true` | `Watch for lost details` |
| `adaptiveDamageFeedback` | boolean | `false` | `Learn from lost details` |
| `telemetryChannel` | `stable` \| `canary` | `stable` | `Metrics tag`; local only, see [telemetry and canary gates](./evaluation.md#telemetry-and-canary-gates) |

Notes on specific keys:

- `minContextPercent` is relative to the **active model's** window, or to
  `maxContextTokens` for automatic runs when that is smaller. It is the
  apply gate for automatic and agent runs and the replacement gate for
  `native-hook`. Manual `/smart-compact` shows a warning and ignores it. A
  5,000-token floor always applies.
- `pendingTtlMs` is how long a summary returned to Pi waits for Pi's matching
  compaction confirmation. It does not change the fixed 5-minute window in
  which a summary staged by the `smart_compact` tool must be applied with
  `/compact`, or the 5-minute lifetime of a background preparation.
- `showStatus` adds a footer note only when compaction is manual-only or
  disabled. Nothing is shown while healthy, and background preparation is not
  shown in the footer.
- `agentToolAccess: "inherit"` (`Follow Pi`) respects Pi's `/tools`, host
  allowlists and other extensions. Manual `/smart-compact` works regardless.

`profiles` accepts, per profile (`light` for `thorough`, `balanced` for
`balanced`, `aggressive` for `fast`; `› Mode budgets` shows them by mode):

| Field | Range | `light` (Thorough) | `balanced` (Balanced) | `aggressive` (Fast) |
| --- | --- | ---: | ---: | ---: |
| `summaryBudgetTokens` | 256–100,000 | 10,000 | 6,000 | 3,000 |
| `keepRecentTokens` | 1,000–500,000 | 30,000 | 20,000 | 10,000 |
| `minChunkTokens` | 100–100,000 | 800 | 500 | 300 |
| `maxChunkTokens` | 500–200,000 | 12,000 | 8,000 | 6,000 |
| `singlePassMaxTokens` | 1,000–500,000 | 40,000 | 30,000 | 20,000 |
| `batchMaxTokens` | 1,000–500,000 | 30,000 | 24,000 | 18,000 |

## Legacy and removed keys

| Key | Behavior |
| --- | --- |
| `semanticCompact` (root key) | Read when `smartCompact` is absent |
| `agentToolEnabled` | Converted to `agentToolAccess` (`enabled`/`disabled`) with a warning |
| `mode: "aggressive"` | Converted to `fast` with a warning |
| `hindsightLocalFallback` | Removed; reported as stale and ignored |

## Examples

Cleanup and offload without automatic compaction, with every permitted tool
visible to the agent from the start:

```json
{
  "smartCompact": {
    "autoTrigger": false,
    "toolLoading": "eager",
    "contextHygieneEnabled": true,
    "artifactOffloadEnabled": true
  }
}
```

Human-only session navigation, with no context tools shown to the agent:

```json
{
  "smartCompact": {
    "toolLoading": "off",
    "contextNavigationEnabled": true
  }
}
```

Automatic compaction that does not depend on Pi's auto-compaction (the
`Fully automatic` preset):

```json
{
  "smartCompact": {
    "autoTrigger": true,
    "autoTriggerStrategy": "settled",
    "contextHygieneEnabled": true,
    "agentToolAccess": "disabled"
  }
}
```

Background preparation with explicit gates and a separate summary model:

```json
{
  "smartCompact": {
    "autoTrigger": true,
    "autoTriggerStrategy": "background",
    "prepareContextPercent": 60,
    "minContextPercent": 70,
    "summaryModel": "anthropic/claude-sonnet-4-6",
    "summaryThinkingLevel": "high",
    "segmentationThinkingLevel": "low"
  }
}
```

Mnemopi project memory in a custom folder:

```json
{
  "smartCompact": {
    "memoryBackend": "mnemopi",
    "mnemopiDataDir": "~/pi-memory"
  }
}
```
