# Pi Continuity user guide

Pi Continuity keeps a long Pi Coding Agent session usable: it keeps the working
context small, keeps removed evidence retrievable, and carries goals, decisions,
errors and next steps across compaction. Compaction and project memory are the
mechanisms; context hygiene and session continuity are the goal.

Pi Continuity is the product name. Everything you type or configure keeps the
existing technical names: the npm package `pi-smart-compact`, the
`/smart-compact` command, the `smart_*` agent tools and the `smartCompact`
settings key. The UI title still reads "Smart Compact".

This guide is task oriented. For every setting, default and range, see the
[configuration reference](./configuration.md). For measurements, pilots and
release evidence, see [evaluation](./evaluation.md).

> [!NOTE]
> **Which version this describes.** This guide describes the current source
> checkout: `9.8.0-canary.7`, including the Home/settings UI changes, session
> navigation and on-demand agent tools. The 9.8.0 canaries are local-only and
> not published. The most recent stable changelog entry is `9.7.1`, which
> predates most features here: the Home screen, the `trim`, `storage` and
> `context` commands, `smart_context`, `smart_tools`, `smart_navigation`,
> artifact offload, the Hindsight and Mnemopi backends, the provider (native)
> engine, image snapshots and the RTK companion. If you installed from npm,
> check [the changelog](../CHANGELOG.md) for what your version contains.

## Contents

- [How it works in one minute](#how-it-works-in-one-minute)
- [Install and first run](#install-and-first-run)
- [The Home screen](#the-home-screen)
- [Clean up tool output](#clean-up-tool-output)
- [Compact now](#compact-now)
- [Let it run automatically](#let-it-run-automatically)
- [Retrieve archived output](#retrieve-archived-output)
- [Checkpoint and rewind](#checkpoint-and-rewind)
- [Session navigation](#session-navigation)
- [Agent tools](#agent-tools)
- [Memory: what is stored where](#memory-what-is-stored-where)
- [Working with other extensions and features](#working-with-other-extensions-and-features)
- [Recovery](#recovery)
- [Storage and privacy](#storage-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Command reference](#command-reference)

## How it works in one minute

Pi Continuity acts in four layers, from cheapest to most invasive:

| Layer | What happens | Model call? | Default |
| --- | --- | --- | --- |
| 1. Avoid noise | The optional RTK companion shortens a few shell outputs | No | Not loaded |
| 2. Offload | Very large read-only tool outputs are saved to disk; the model sees a preview and an ID | No | Off |
| 3. Trim, checkpoint, rewind | Old read-only and shell output is replaced by short digests with references; research can be rewound to a report | No | Manual; automatic trimming off |
| 4. Compact | Older history becomes a verified summary; recent turns stay raw | Usually (Fast may use none) | Replaces Pi's summary when Pi compacts |

Layers 2 and 3 are recoverable: the original output stays in Pi's session file
or in a private artifact file, and the agent can search and read it back.
Layer 4 replaces history with a summary. The summary is checked against facts
extracted from the conversation first, but it is still a summary: some
incidental details are not kept. A backup of the replaced text is written by
default.

## Install and first run

Requirements: Pi Coding Agent 0.87.1 or newer, Node.js 22.19 or newer.

```bash
pi install npm:pi-smart-compact
```

Then, inside Pi:

```text
/smart-compact
```

Opening Home changes nothing. With the built-in defaults, automatic compaction
depends on Pi starting it. Automatic local cleanup, early output offload and
speculative background preparation are off until selected.

## The Home screen

A bare `/smart-compact` in the TUI opens Home. Without a UI (print, RPC, SDK) it
instead runs one compaction with your configured defaults.

The header shows `Context:` (current usage or why compaction is blocked) and
`Automatic: off | follows Pi | when idle · Agent: allowed | off`.

| Row | What it does |
| --- | --- |
| **Compact now** | Opens the compact picker to choose a mode and summary model. Shows `unavailable` with a reason when blocked. |
| **Clean up tool output** | Queues local cleanup (`no model call`). Applies at the next completed turn. Shows `held for a cold cache` with the reason when automatic cleanup is holding a batch; selecting it applies that batch at the next completed turn instead. |
| **Settings** | `How it runs`, `Summary format`, `Models`, `Memory`, `Agent tools & navigation`, `Advanced settings`. |
| **History & recovery** | `Session navigation`, `Hand off to a new session`, `Restore a backup`, `Unfinished tasks`, `Storage`, `Forget local project memory`. |
| **Status & help** | `Readiness & details`, `Which action should I use?`, `Metrics` (`Report`, `Dashboard`). |

Keys on every list: `↑`/`↓` choose, `Enter` select, `Esc` back (from Home,
back to chat). Long help and result screens also scroll with `PgUp`/`PgDn` and
`Home`/`End`. When a label or value is truncated, the selected row shows it in
full below the list. In settings lists, `r` resets the selected row to its
default (or to `global` on the branch page); `r` typed into an open text field
is just text.

`Readiness & details` uses local evidence only. "local checks pass" means no
local blocker was found. It does not mean a provider accepted a request,
credentials were valid, or billing was checked.

## Clean up tool output

Use this when the context is filling with old tool output but you do not want a
summary yet.

```text
/smart-compact trim
```

Or Home → **Clean up tool output**. Either one:

- makes no model call and does not force a new turn;
- is queued, not applied: **the first next provider request is still sent
  untrimmed**, and the edit applies at the next natural completed-turn boundary;
- replaces old successful text results of at least 4,096 characters with a
  digest marker, up to 32 outputs per boundary: read-only tools, shell
  (`bash`) output and `smart_context` `read` pages;
- keeps the latest four assistant turns, an active checkpoint's prefix, errors,
  every tool call (including shell commands), writes, unknown tools, turns
  that mix shell or read-only calls with any other tool, instruction/skill-file
  reads, `smart_context` results other than `read`, and another extension's
  explicit context edits;
- is cancelled with a visible notice if a return to an anchor is pending or a
  newer boundary change arrives.

Trimmed output stays retrievable with
[`smart_context`](#retrieve-archived-output). Trimming is not secure deletion:
the raw history remains in Pi's session JSONL.

A digest marker has at most 6 lines and 400 characters and is derived only
from the recorded call and output:

```text
[Archived bash output, 18088 chars. Retrieve with smart_context action=read id=3f9a1c2e.]
$ bun test
> bun test v1.4.2
! error: expect(received).toBe(expected)
! warning: snapshot obsolete
```

Line 1 names the tool, size and retrieval ID. Then, when known: the subject
(`path:` for reads, `$ ` and the first command line for shell, the pattern or
path for searches), the first non-empty output line (`> `), and up to three
lines matching error, failure, warning, exception, traceback, panic, exit-code,
`command not found`, `permission denied`, `ENOENT` or `EACCES` (`! `). Each
line is whitespace-normalized and cut to 100 characters; lines past the
limit are dropped from the end. Shell calls are never removed, only their old
output; errored shell results stay whole. An archived `smart_context` `read`
page points back at the source it paged
(`[Archived smart_context read of id=<source-id>, …]`), so the agent re-reads
the source instead of the copy.

Automatic trimming is separate and off by default: turn on
**Automatic cleanup** (`contextHygieneEnabled`). A batch needs at least 16,384
characters of net savings and eight assistant turns after the last trim,
rewind or compaction. It then commits at the turn boundary for one of three
causes, recorded on the trim entry:

- `pressure`: context usage reached the early pressure gate.
- `break-even`: the model's catalog prices say the trim pays back its prompt
  cache rewrite within 24 further requests (see
  [configuration](./configuration.md#context-hygiene-and-archives)).
- `cold`: otherwise the batch is held back until the cache has expired (5
  minutes after the last response, 1 hour when that response wrote 1h
  cache). The first request after that already sends the trimmed context, and
  the edits commit when that turn completes.

The rule uses the model's catalog price ratios and estimated token counts, not
measured cache behavior.

## Compact now

Use this for a deliberate compaction with a preview, even below the automatic
threshold.

1. Home → **Compact now** (or `/smart-compact balanced`, see
   [command reference](#command-reference)).
2. The compact picker compares `Fast`, `Balanced` and `Thorough` by estimated
   saving and highlights a recommendation.
3. Review the summary and choose **Apply** or **Cancel**.

Compact picker keys:

| Key | Action |
| --- | --- |
| `↑` / `↓` | Choose `Fast`, `Balanced` or `Thorough`; the plan is recalculated |
| `Enter` | Compact with the selected mode; only viable plans run |
| `M` | Choose the summary model and replan (the hint appears when the current model does not fit) |
| `D` | Show or hide technical details: estimator, targets, routes, boundaries, recommendation reason |
| `S` | Show the effective state, then return to the picker |
| `PgUp` / `PgDn` | Page the details on short terminals |
| `Esc` | Back to Home; nothing changes |

Review keys: `A` applies. `C` or `Esc` cancels. `Enter` never applies. `D`
toggles details; arrows, `PgUp`/`PgDn` and `Home`/`End` scroll. The review is
on by default (`requireApproval: true`). Review time does not count against the
run time limit.

What to expect:

- The conversation is unchanged until you apply and Pi confirms the matching
  compaction. Backups, continuity state and project memory are written only
  after that confirmation.
- `100/100` is labelled **verification coverage**. The source score and
  whether the text came from the model, deterministic repair or the fallback
  stay visible.
- A plan projected below 10% net savings does not start. A finished summary
  that misses its mode target or savings floor is rejected before apply.
- A manual timeout or failure leaves the conversation unchanged and does not
  start Pi's own compactor.
- Models too small for the planned requests are shown as unavailable with a
  reason. Choosing a summary model never switches your chat model.

Use `--focus=<topic or path>` to give that topic more room in the summary. It
does not keep non-adjacent messages raw.

## Let it run automatically

Settings → **How it runs** offers presets. Each one is a single atomic change
to existing settings.

| Preset | Automatic compaction | Automatic cleanup | Agent can call `smart_compact` |
| --- | --- | --- | --- |
| `With Pi (default)` | Only when Pi's own auto-compaction fires | Off | Follows Pi's tool settings |
| `Manual only` | Off | Off | No |
| `Manual + agent` | Off | Off | Yes |
| `Cleanup only` | Off | On | No |
| `Fully automatic` | Starts itself when idle (`settled`) | On | No |

Two points matter most:

- **`With Pi (default)` is passive.** It replaces the summary only when Pi
  starts a compaction. If Pi's auto-compaction is off, nothing compacts
  automatically. Extensions cannot read Pi's setting, so readiness reports it
  as `unknown`.
- **`Fully automatic` works with Pi's auto-compaction off.** It asks Pi to
  compact at the next idle, queue-empty boundary once context reaches
  `Start at context %`, with a 10-minute cooldown after a compaction.

`Start at context %` counts against the model's full window. On a large-window
model (Home warns above 400k tokens), set `Context cap for start % (tokens)`
(`maxContextTokens`) to measure it against a smaller window instead; requests
and safety headroom still use the real window.

Turning `Automatic compaction` off disables both Smart Compact strategies. It
does not turn off Pi's own compactor. Automatic runs are capped at 60 seconds
and four model calls, whatever the configured limits are. When they fail, Pi
may still use its own compactor. See
[automatic strategies](./configuration.md#automatic-strategies) for the
background strategy and the gate arithmetic.

## Retrieve archived output

The agent retrieves trimmed, rewound, offloaded or image-archived output with
`smart_context`. You normally do not call it yourself; you can ask the agent to.

```json
{"action":"status"}
{"action":"search","query":"AUTH_EXPIRED","limit":3}
{"action":"read","id":"<source-id>","line":120,"limit":20}
{"action":"read","id":"<source-id>","offset":0,"limit":2048}
```

| Action | Behavior |
| --- | --- |
| `status` | Checkpoint validity and archived source IDs, newest first. Default 8, maximum 32 per page; continue with `offset` / `nextOffset`. |
| `search` | Literal, case-sensitive text or source-label match; first match per source with excerpt, line and offset. Default 5 hits, maximum 10; scans at most 32 sources or 4 Mi characters per request. `nextOffset` is a source cursor. No regex or embeddings. |
| `read` | Character `offset`, or 1-based `line` with `limit` lines (default 40, maximum 200). At most 4,096 characters per call. |

Retrieval only returns output this extension archived on the active branch.
Text is scrubbed again with the current privacy settings before search or
paging. You get the originally recorded tool output, not bytes the tool had
already truncated before Pi recorded it.

### Automatic offload of large outputs

With **Offload huge outputs** (`artifactOffloadEnabled`) on and `smart_context`
active, successful, known read-only text results of at least 16,384 characters
are saved before their first model request. The model sees the tool/source
label, size, an `artifact-<hash>` ID and short first/last excerpts.

- Not offloaded: errors, images, shell commands, writes, unknown tools,
  `read`/`read_symbol`/`read_enclosing` deliveries, instruction/skill-file
  reads and `smart_context` itself. File reads stay inline on first delivery,
  so read-before-edit guards such as pi-lens see what was actually read.
- This is not a summary. The agent has to search or read the omitted parts
  when it needs them. Total savings depend on how much it reads back.
- Each file is at most 2 MiB. A session holds at most 256 files or 32 MiB; at
  the limit, new offloads stop instead of evicting older evidence.
- A storage failure, cancellation, unsafe path or quota limit leaves the
  original result unchanged.

## Checkpoint and rewind

Use this for bounded research: set a checkpoint, explore, then replace the
exploration with a short report.

```json
{"action":"checkpoint","label":"Investigate auth expiry"}
{"action":"rewind","report":"Expiry must use <=. Keep async API. Failed approach: local-time parsing. Next: patch and test."}
{"action":"plan"}
{"action":"trim"}
```

- `checkpoint`, `rewind` and `trim` return **queued**. Pi commits them at the
  end of the current tool batch.
- One checkpoint is active at a time; a new one replaces it. It survives reload.
- New user instructions, a compaction, branch changes or edits to the context
  before the checkpoint invalidate rewind. It does not silently drop new
  requirements.
- Rewind removes successful read-only tool exchanges as complete call/result
  pairs. Errors, instruction reads, incomplete exchanges, images, shell
  commands, writes and unknown tools stay.
- **Files, processes, Git state and external effects are never rolled back.**
- The report (maximum 8,000 characters) is written by the agent and is not
  verified. It should include findings, constraints, failed attempts and the
  next step. More than 512 eligible messages requires a normal compaction.
- `plan` previews how many outputs a trim would remove and the characters
  saved, without queuing anything.

## Session navigation

An anchor is a named point in this conversation with a summary of what was
true there: the goal, decisions and the state of the work. Anchors are stored
as messages in the session, so the agent sees them too. Use them to find the
way back after a long detour.

Home → **History & recovery** → **Session navigation**, or `/smart-compact context`:

| Row | What it does |
| --- | --- |
| **Anchors in this session** | Browse and filter anchors. Open one to read its summary before returning to it. |
| **Mark this point** | Save an anchor here: a short name, then a summary written in Pi's editor. |
| **Search other sessions** | Read-only search of anchors saved by earlier sessions of this project (or all projects). Results are history to check, not instructions. Use Pi's `/resume` to open another session. |
| **How navigation works** | Opens the navigation guide. It is read only when you open it. |

Returning to an anchor:

- Open the anchor, choose **Return to this anchor**, write what to carry over
  (required), optionally the next message, then confirm. Nothing changes until
  you confirm; `Esc` goes back one step.
- The conversation continues from the anchor on a new branch. The carryover is
  recorded as Pi's branch summary; the anchor and its summary stay visible to
  the model. The conversation since then stays saved on its own branch.
- **Only the conversation moves.** Files, running processes, Git state and
  anything else changed since the anchor are not rolled back.
- While a return is queued or running, automatic cleanup, compaction and
  `smart_context` changes pause. Typing a new message cancels a queued return
  requested by the agent.

Settings → **Agent tools & navigation** has the switches: **Session
navigation** (off hides the panel and the agent tool; recorded anchors and the
other switches are kept), **Search other sessions**, **Return to an anchor**,
**Anchor prompt cache** (Anthropic models: keeps a prompt-cache marker on the
newest anchor, so the context before it is read from cache while later turns
change), **Anchor status** (footer, display only) and **Navigation guide**.

Anchors recorded by pi-toolkit's `context` tool in earlier sessions stay
readable in browse and search.

### Hand off to a new session

```text
/smart-compact handoff [dry-run] [-- note]
```

Opens a new Pi session seeded with one handoff message assembled from what
this session already recorded, in this order: your note, the latest anchor on
the branch, the continuity ledger (from the last Continuity compaction, else
the saved state for this branch), always-kept files (`pinPaths`), a memory
recall through the selected store (up to 5 results; the query is the note,
else the anchor, else the ledger goal), and pointers back to this session. No
model writes it. It is scrubbed and capped at 16,000 characters; recall is cut
first, then always-kept files, the ledger, the anchor and the note, each marked
`[truncated]`.

The message is saved as an anchor named `handoff-<first 8 characters of this
session id>`, so navigation lists it and cleanup keeps it. The new session
records this one as its parent; this session is not modified. With no anchor,
ledger or note, nothing opens.

From Home → **History & recovery** → **Hand off to a new session**: write an
optional note (`Enter` continues, empty skips), then review the seed: its
size and sources, **Read the full seed**, and **Open the new session**. The
selection starts on **Go back**; `Esc` goes back one step, and on the note
field closes. Nothing opens until you confirm.

`dry-run` only shows the seed and opens nothing: in the TUI as the same
read-only preview, in other UI modes as a message. Without a UI it warns and
does nothing.

## Agent tools

Settings → **Agent tools & navigation** → **Agent tools** (`toolLoading`)
decides what the agent sees:

| Choice | What the agent sees |
| --- | --- |
| **On demand** (default) | One small loader, `smart_tools`. The agent loads a group when it needs it: `navigation`, `history`, `memory` or `compaction`. Loaded groups are forgotten at the next session start, branch change or compaction. |
| **Always available** | Every permitted tool from the start. |
| **Off** | No context tools. The human UI keeps working. |

`smart_tools` also answers `status`, `unload` and `guide`. The guide is the
context workflow text; it is returned only when asked for and is never added
to the system prompt. Loading a group adds only that group's tool declarations.
Each group still needs its own permission: `compaction` follows **Agent can
compact**, `memory` needs project memory or a Hindsight/Mnemopi backend, and
`navigation` needs **Session navigation**. Choices you make with `/tools` win
over the loader. Pi may keep previously loaded declarations in cached history;
turning a group off stops it from being called but does not promise that
earlier request bytes disappear.

| Tool | Group | What it does | When it takes effect |
| --- | --- | --- | --- |
| `smart_navigation` | `navigation` | View or search anchors, record an anchor, return to one with required carryover | A return ends the turn and is revalidated by the host after the tool batch settles |
| `smart_context` | `history` | Status, search, read, plan, trim, checkpoint, rewind | Queued edits apply at the end of the current tool batch |
| `smart_recall` | `memory` | Searches this project's memory in the selected store | Immediately; read-only |
| `smart_save_memory` | `memory` | Saves or resolves one durable fact | Only after **you** approve the host confirmation dialog |
| `smart_compact` | `compaction` | Prepares a verified summary and stages it | Never mid-turn. Staged for 5 minutes; applied by the next `/compact` or a compaction Pi starts. |

Approval and gates:

- `smart_compact` refuses below `Start at context %` (default 60%) or below
  5,000 tokens. `tool=XX%` in Pi's footer is the tool-output share, not
  context fullness. If a summary is already staged, it reports that and makes
  no calls. With automatic compaction off, nothing consumes the staged summary
  unless you run `/compact`.
- `smart_save_memory` always opens a confirmation showing the scrubbed kind,
  title, content, paths and the exact destination. Without an interactive UI
  it changes nothing. The agent cannot approve on your behalf.
- Recall results are untrusted history: the agent is told not to follow
  instructions inside them.

## Memory: what is stored where

Pi Continuity keeps several kinds of state. Only one of them is cross-session
project memory.

| State | Purpose | Scope | Removed by |
| --- | --- | --- | --- |
| Continuity state | Goals, decisions, constraints, errors and open loops carried between compactions | Project, session and branch | Bounded retention; not affected by `forget` |
| Project memory | Facts `smart_recall` can find in later sessions | Project, in the selected store only | Resolve; `forget` (local store only) |
| Backups | Pre-compaction text for restore | Per compaction | Bounded retention |
| Artifacts | Archived tool output for retrieval | Per origin session | Only you, by hand |

A project is the Git root, or the working directory when there is no Git root.
Your home directory and the filesystem root are never projects; memory tools
fail there.

### Memory store (`memoryBackend`)

Exactly one store is active. It is the only store read or written. There is
**no fallback**: if the selected store fails, the failure is reported and no
other store is used. Stores you switch away from are left untouched, not
migrated or cleared.

| `Memory store` | Where facts go | Recall | `scope: "session"` |
| --- | --- | --- | --- |
| `This machine` (`local`, default) | Local SQLite context graph: facts you confirm plus verified state from applied compactions | Full-text plus one-hop file links | Supported |
| `Hindsight server` | Your existing Hindsight server and bank only; confirmed saves only, never transcripts | Strict project-tag-scoped section of that bank | **Not supported**: reads nothing |
| `Mnemopi (local SQLite)` | A separate SQLite database per project | Bounded full-text search, no embeddings | **Not supported**: skipped, nothing else is read |

- Hindsight: Pi Continuity never installs, starts or configures a server. See
  [Hindsight memory backend](./hindsight-memory.md).
- Mnemopi runs in a bounded `bun --no-install` worker. Normal installs include
  the pinned `bun` (1.4.2) and `@oh-my-pi/pi-mnemopi` optional dependencies;
  otherwise a Bun 1.3.14 or newer on `PATH` is used. Missing pieces fail before
  any request is sent. Embeddings, model calls, automatic consolidation and
  model downloads are off. It never opens the shared OMP/Mnemopi default bank.
- Each project can hold at most 500 active manually saved facts in the local
  store.

### Refs and resolving facts

Every save and recall returns a stable `Ref`. To retire a fact, the agent calls
`smart_save_memory` with `status: "resolved"` and that `ref`; copied preview
text does not work. A ref is bound to its project, store and storage target.
Changing the selected store never redirects a ref. To resolve an old ref,
restore the original target configuration first.

| Store | Effect of resolve |
| --- | --- |
| Local | Soft-closes the fact and its links; not a physical deletion |
| Mnemopi | Deletes that one fact from its original database |
| Hindsight | Deletes the named remote document and reports the receipt state |

### Forget local project memory

`/smart-compact forget` (or History & recovery → **Forget local project
memory**) needs the TUI and applies only to the local store. It offers:

- **Learned from compactions only**: deletes compaction-derived items and keeps
  confirmed facts and legacy items without provenance;
- **Everything in the local project graph**.

It shows counts and asks for confirmation. Mnemopi, Hindsight, continuity
state, backups and artifacts are not affected.

## Working with other extensions and features

### pi-toolkit

Session navigation replaces the anchor, recall and pivot features of
pi-toolkit's `context` tool, and Pi Continuity is the only owner of trimming.
Do not load pi-toolkit's context-management extension together with Pi
Continuity: two extensions recording anchors and pruning the same branch are
not safe in any load order. The `piToolkit.context.thinningEnabled` key is not
read by Pi Continuity. Anchors recorded earlier by pi-toolkit stay readable.

### Other compaction extensions and Pi's built-in compaction

Pi applies one compaction per request: the last extension to answer
`session_before_compact` wins, and with no answer Pi's built-in summarizer
runs. When something other than Pi Continuity applies the compaction:

- A summary Pi Continuity had already prepared for that session is discarded
  and recorded in `/smart-compact metrics` as `discarded` with reason
  `native-apply:foreign`; its continuity state is not saved. A notice names
  the winner and the model calls that were wasted.
- Another extension's compaction shows a once-per-session notice even when
  nothing was prepared, because Pi Continuity recorded no state or metrics
  for it. Keep only one compaction extension loaded.
- Pi's built-in compaction shows a notice only while automatic compaction is
  on (nothing was ready when Pi asked); earlier continuity state still carries
  over through the capsule.

Provider usage of the summary Pi Continuity applies (its own explore,
synthesize and verify calls, or the provider-native compaction request) is
returned to Pi with the compaction, so Pi's session totals and cost include
that work at the route model's catalog rates. Runs that reused a cached
summary report no usage; work whose usage a provider did not report is left
out rather than estimated. Discarded preparations are only in
`/smart-compact metrics`, never in Pi's totals.

### Host prompt-cache ledger

For each assistant response in the current session, Pi Continuity records the
prompt usage the provider reported for Pi's own request: uncached input, cache
reads and cache writes. Nothing is estimated; responses without reported
usage, or with zero prompt tokens (aborted or failed requests), are skipped.

A request counts as a cache rebuild when it is not the session's first and
its uncached tokens (input + cache writes) are at least 16,384 and at least
half of its prompt tokens. Each rebuild gets one cause, checked in this order:

- **continuity**: a Continuity edit reached the branch since the previous
  request (an output trim or checkpoint rewind, a navigation pivot, or a Pi
  Continuity compaction). Edits that were queued but not committed do not
  count.
- **idle-expiry**: the gap since the previous request exceeded the cache
  lifetime, 5 minutes, or 1 hour while the cached prefix was written with
  1-hour retention (only Anthropic reports that split).
- **foreign**: neither. Something else changed the prompt prefix, for
  example another extension, a model or tool change, Pi's built-in
  compaction, or eviction by the provider.

Home › Readiness & details lists the request count, the share of prompt
tokens read from cache, rebuilds by cause with their uncached tokens, and the
cost Pi priced from that usage when the model has catalog prices. The third
foreign rebuild in a session shows one notice with the count and uncached
tokens. The ledger is session-local: it resets on a new or switched session,
is not persisted, and covers only Pi's own requests; Pi Continuity's summary
calls are in `/smart-compact metrics` instead.

### RTK companion (optional, experimental)

RTK is not a dependency and is never loaded automatically. Install RTK 0.50 or
newer yourself, then load the companion explicitly:

```bash
# From a source checkout
bun run build
pi -e ./dist/rtk.js
```

The published subpath is `pi-smart-compact/rtk`; Pi can also load the installed
package's `dist/rtk.js` by file path. Keep the core extension loaded as well.

- Only bare `git status`, `cargo test` and `bun test` are rewritten. Commands
  with arguments, pipes, redirections or substitutions pass unchanged.
- Load it **before** permission or command-policy hooks, and do not load it
  together with the upstream RTK Pi hook.
- A failed filtered command is never retried as the original. `RTK_DISABLED=1`
  disables it; `command git status` bypasses it for one call.
- RTK's own recall store is separate: Pi Continuity neither reads nor scrubs it.

### Summary format: provider compaction and images

Settings → **Summary format**:

| Choice | Effect |
| --- | --- |
| `Verified text` (default) | Checked text summary |
| `Text + images` | Adds PNG snapshots of old read-only output when the chat model passes the image-cost check; otherwise text only |
| `Provider (experimental)` | Tries your provider's own compaction first, then verified text. Needs a second `Enter` to confirm. |

Provider (native) compaction:

- Supported routes: Anthropic Messages (API key or Claude subscription),
  OpenAI Codex subscription and the OpenAI Responses API with an API key.
  Other routes are skipped with a notice.
- The provider state is opaque and **not verified** by Pi Continuity. It is
  replayed only to the same provider and model. With another model, or when
  replay is not possible, the model reads the text summary instead; on OpenAI
  routes that is only the retained user messages.
- Claude subscription requests that Pi Continuity makes itself (summaries and
  provider compaction) go through Pi's model runtime, so a provider registered
  by the separate `pi-claude-oauth-adapter` package handles their transport.
  The published adapter `0.2.2` rewrites the request body only inside Pi's
  `before_provider_request` hook, which Pi does not run for these requests; a
  build that normalizes the final payload inside its provider is required for
  full parity. Anthropic may bill the compaction as extra usage.
- A native boundary changes the request prefix, so the provider's prompt cache
  is not reused across it.
- In sessions smaller than Pi's `compaction.keepRecentTokens`, Pi refuses to
  apply the result; the conversation stays unchanged.

Image snapshots:

- Experimental and off by default. They add image tokens; they are not a
  cheaper replacement for the text summary. A synthetic pilot used more input
  tokens than the same excerpts as text (see [evaluation](./evaluation.md)).
- A cost rule is validated only for direct Anthropic `claude-sonnet-5`; other
  models stay text only. Snapshots need the optional `@resvg/resvg-js` renderer;
  when it is missing, output falls back to text.
- Limits: 2 pages, 8 excerpts of up to 3,000 characters, 1 MB of PNG, and only
  Latin/Turkish text. Errors, writes and edited-away messages are never
  rendered.

## Recovery

| Need | Use |
| --- | --- |
| Get back the conversation from before a compaction | `/smart-compact restore` → pick a backup → `View content` or `Restore into a new session` |
| Review tasks carried across compactions | `/smart-compact loops`: resolve/reopen, set priority, pin/unpin |
| See what artifact storage holds | `/smart-compact storage` (read-only) |
| Continue in a fresh session with the recorded state | `/smart-compact handoff [-- note]` (see [Hand off to a new session](#hand-off-to-a-new-session)) |
| See what went wrong recently | `/smart-compact metrics`: effective state, then the last 20 issues |

`Restore into a new session` first tries to fork at the exact pre-compaction
branch point. If that entry no longer exists, it opens a new session with the
backup injected as context for the next turn. Restore is refused when the
backup is above 90% of the current model's window; you can still view it. Your
current session is not modified. Backups contain text, not binary attachments.

## Storage and privacy

### Where files live

Everything is under `~/.pi/agent/`. Directories Pi Continuity creates are `0700`
and its files are `0600`; a custom backup folder gets the same protection.

| Path | Contents | Growth |
| --- | --- | --- |
| `settings.json` | Pi's settings; Pi Continuity only edits its `smartCompact` section | Host-owned |
| `compact-backups/` | Scrubbed pre-compaction text backups | Retention-pruned |
| `smart-compact-artifacts/<session-hash>/` | Archived tool output | **No automatic expiry** |
| `smart-compact-memory/mnemopi/<projectId>/memory.sqlite` | Mnemopi facts (only when selected) | Until resolved |
| `.cache/compact-extraction-<session>.json` | Incremental extraction cache | Cache |
| `.cache/compact-metrics.jsonl` | Local metrics | 5 MiB cap |
| `.cache/smart-compact-report.html` | Local dashboard | Overwritten |
| `.cache/smart-compact/projects/` | Project fingerprints | Small |
| `.cache/smart-compact/states/` | Continuity state and loop overrides | Per branch |
| `.cache/smart-compact/run-locks/` | Cross-process run leases | Transient |
| `.cache/smart-compact/native-continuity/` | One-shot handoffs | Transient |
| `.cache/smart-compact/context-graph.sqlite` | Local project memory | Bounded per project |
| `.cache/smart-compact/hindsight-receipts.json` | Hindsight submission receipts (only when selected) | Small |
| `.cache/smart-compact/damage-reports.jsonl` | Post-compaction damage reports | 5 MiB cap |
| `.cache/smart-compact/remediation-<projectId>.json` | Files to preserve after damage | Small |

### Artifacts have no garbage collection

There is deliberately no `--clean` and no automatic artifact deletion. Total
disk use can grow across sessions. `/smart-compact storage` reports totals,
per-session status (`in use`, `not referenced in scan`, `unknown`) and scan
coverage, but "not referenced in scan" does **not** mean "safe to delete":
sessions can live outside Pi's sessions folder, and a running session can add
references at any time. Delete an origin directory by hand only when that
session **and all its forks** are no longer needed. Missing or modified files
are reported, never replaced with current data.

### Scrubbing

High-confidence secret scrubbing (`Scrub secrets`, on by default) runs before
provider requests, extraction cache, backups, state, project memory and staged
summaries. It covers common API keys and tokens, JWTs, bearer tokens, private
keys, credential assignments and passwords in connection URIs. `Scrub personal
data` (off by default) adds email, phone and card-shaped values. Scrubbing is
defense in depth, not a DLP system; see the [security policy](../SECURITY.md).

What is not covered:

- Raw history stays in Pi's session JSONL; trimming and rewind do not delete it.
- `DEBUG=smart-compact` logs can contain private conversation text.
- The RTK recall store is outside Pi Continuity.

## Troubleshooting

| Symptom | Cause and action |
| --- | --- |
| "Compaction skipped: context 38% ... below the 60% threshold" | Automatic and agent runs wait for `Start at context %` of the **active model's** window. Use Compact now for early compaction. |
| Nothing compacts automatically | With the default `With Pi`, Pi's auto-compaction must be on (readiness shows `unknown`). Choose `Fully automatic` to start without it. Check `Automatic compaction` and `This branch only`. |
| Cleanup did nothing on the next reply | Expected: the next request is sent untrimmed; cleanup applies at the next completed turn. |
| Agent says a summary is staged, but context did not shrink | Run `/compact` within 5 minutes. With automatic compaction off, nothing else consumes it. |
| `smart_context`, `smart_recall`, `smart_save_memory` or `smart_navigation` missing | With **On demand**, the agent loads a group through `smart_tools`; with **Off**, no context tool is shown; see [agent tools](#agent-tools). Check `/tools`. |
| Memory tools fail "must run from a project directory" | Start Pi from inside a project, not from your home directory or `/`. |
| Recall with `scope: "session"` returns nothing | Not supported on Hindsight or Mnemopi; use project scope. |
| Mnemopi lock error | Another writer is active. Retry later. Remove `memory.sqlite.lock` only after confirming no process writes that database. |
| Settings do not save; `settings.json.lock` exists | A Pi process died while writing. Verify no Pi process is writing settings, then remove the lock directory by hand. |
| Edited `settings.json` by hand, tool list or footer not updated | External edits are read on the next operation; tool and footer state refresh on `/reload` or session restore. |
| Warning line at the top of Settings | Some `settings.json` values were invalid or converted and are being ignored; the line names them. |
| Provider compaction was skipped | The chat model's API is not a supported native route; verified text was used. |
| Timeout or verification failure | A single `Smart Compact: ...` line explains the effect and next step. Details: `/smart-compact metrics`. Stack traces: `DEBUG=smart-compact`. |

Without a UI, warnings and errors go to stderr.

## Command reference

```text
/smart-compact                         Home (TUI); without a UI, compact with defaults
/smart-compact trim                    queue local cleanup; no model call
/smart-compact storage                 read-only artifact inventory
/smart-compact settings                categorized settings (TUI only)
/smart-compact context                 session navigation: anchors, search, return (TUI only)
/smart-compact metrics                 effective state, recent issues, metrics report
/smart-compact dashboard               interactive metrics dashboard
/smart-compact restore                 browse and restore backups
/smart-compact loops                   manage open loops
/smart-compact forget                  forget local project memory (TUI only)
/smart-compact handoff [-- note]       new session seeded with anchor, ledger, pinned files, recall
/smart-compact handoff dry-run [-- note]   preview the seed; opens nothing
```

Direct compaction takes, in any order at the start: a model
(`provider/model`), a mode (`auto`, `fast`, `balanced`, `thorough`),
`dry-run`, and `verbose` (or `debug`). Options:

| Option | Range | Effect |
| --- | --- | --- |
| `--focus=<text>` | | Give a topic or path more room |
| `--max-calls=<n>` | 1–100 | Model call budget for this run |
| `--max-input-tokens=<n>` | 10000–1000000 | Aggregate prompt-token budget for this run |
| `--max-latency=<ms>` | 5000–600000 | Cancellation deadline; review time excluded |
| `--note=<text>` or `-- <text>` | | Steering note for the summary |

```bash
/smart-compact balanced --focus=src/auth.ts
/smart-compact anthropic/claude-sonnet-4 fast --max-calls=3
/smart-compact --note="keep the balanced and fast terminology"
/smart-compact -- fast is part of this note, not a mode
```

Controls are read only from the left. Once note text starts, words like `fast`
or paths are part of the note. Unknown `--` options and out-of-range budgets
return an error instead of silently using defaults. Call and input budget
exhaustion falls back to a deterministic summary. A timeout or cancellation
stops the run with no staged summary.

Legacy mode words are still accepted: `aggressive` means `fast`; `slow` and
`light` mean `thorough`.
