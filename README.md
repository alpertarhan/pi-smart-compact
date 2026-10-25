<p align="center">
  <img src="./docs/assets/banner.png?v=3" alt="Smart Compact: a paper-filled coding workspace becomes a concise working folio, with a return thread to archived evidence." width="960" height="432" />
</p>

# Smart Compact

**Less context noise. More room for the work.**

Smart Compact is a context-management extension for
[Pi Coding Agent](https://github.com/earendil-works/pi). It clears recoverable
tool-output noise, turns long conversations into checked working summaries,
and keeps evidence, decisions and unfinished work within reach.

[Get started](#get-started) · [User guide](./docs/guide.md) ·
[Configuration](./docs/configuration.md) · [Documentation](./docs/README.md)

## Get started

Requires **Pi 0.87.1+** and **Node.js 22.19+**. No memory server is required.

```bash
pi install npm:pi-smart-compact
```

Inside Pi, open the extension:

```text
/smart-compact
```

1. **Open Home.** See context usage, effective permissions and available actions.
   Opening Home changes nothing.
2. **Choose how it runs.** Settings → **How it runs** offers manual, agent-assisted,
   cleanup-only and automatic operation. The default is pressure-first:
   recoverable cleanup under pressure, then compaction when idle at 80%.
3. **Try Compact now.** Review the plan and summary. **A** applies; **C** or
   **Esc** cancels. **Enter does not apply** on the review screen.

Review is on by default. Turning off `requireApproval` also removes the
confirmation dialogs for early-anchor cleanup and memory save/resolve.
Without a UI, the bare command runs compaction rather than opening Home.
[First-run details](./docs/guide.md#install-and-first-run)

> **Release channels:** the command above installs npm `latest`. A release
> candidate is installed explicitly with `pi install npm:pi-smart-compact@next`.
> Check the [changelog](./CHANGELOG.md) for the scope of each version.

Already installed? Follow [Update an existing installation](./docs/guide.md#update-an-existing-installation).

## What it does

### Keep the useful parts in view

Long test logs and repeated research reads do not need to occupy every request.
Smart Compact can archive eligible old output behind a small retrieval marker.
Instructions, failures, recent work and other protected content stay in context.
The agent can search and read the recorded evidence again.

[Cleanup and archives](./docs/guide.md#clean-up-tool-output)

### Carry the task through compaction

Compaction extracts goals, constraints, decisions, files, errors and open work
before generating a summary. Deterministic checks look for missing facts and
unsupported claims before Pi applies it. Recent turns stay raw within the
planned budget; backups are enabled by default.

**Extract → Explore → Synthesize → Verify.** Exploration and model use depend
on the mode. Verification is a guard, not a promise of lossless memory.
[Compaction workflow](./docs/guide.md#compact-now) · [Architecture](./ARCHITECTURE.md)

### Take a detour without losing the route back

Checkpoint a read-only investigation, explore, then rewind with a findings
report. Name milestones with anchors, revisit one on a new branch with explicit
carryover, or hand recorded state to a fresh session. These operations move
conversation context—not files, processes or external side effects.

[Checkpoint and rewind](./docs/guide.md#checkpoint-and-rewind) ·
[Navigation and handoff](./docs/guide.md#session-navigation)

### Remember project facts deliberately

Use one selected store: the built-in local graph, an optional local Mnemopi
engine, or your existing Hindsight server. Stores are project-scoped and never
silently fall back to one another. Explicit saves follow your approval policy;
only the local graph can also index state from confirmed compactions.

Hindsight submissions are tracked in the background for up to two minutes.
A later status message distinguishes completion from acceptance without waking
the agent. No automatic resubmission or remote transcript upload is performed.
[Memory workflows](./docs/guide.md#memory-what-is-stored-where)

### Let notifications wait for a safe boundary

Participating extensions can queue messages during summary preparation and
native compaction. Delivery waits for a safe boundary; cancelled compaction
keeps messages for a natural continuation or successful retry. Healthy senders
are not blocked by a failed sender.

This is an **opt-in extension protocol**, not interception of every Pi message.
Both sender and receiver need compatible versions. The queue is in memory and
does not survive reload. [Message delivery](./docs/message-delivery.md)

## One Home, five choices

| Action | Use it when… |
| --- | --- |
| **Compact now** | You need a smaller working summary and want to review it. |
| **Clean up tool output** | Old output is noisy, but a summary is not needed yet. |
| **Settings** | You want to choose automation, models, memory or permissions. |
| **History & recovery** | You need an anchor, backup, archived source or handoff. |
| **Status & help** | You need readiness checks, effective settings or diagnostics. |

Useful shortcuts:

```text
/smart-compact trim              Queue recoverable cleanup; no model call
/smart-compact context           Browse anchors and session navigation
/smart-compact handoff dry-run   Preview a fresh-session handoff
/smart-compact metrics           Inspect outcomes and cache estimates
/smart-compact storage           Inspect archives; never deletes them
```

Cleanup is queued: the first next request remains untrimmed, and the edit commits
at the next natural completed-turn boundary. Agent tools are normally visible
from session start to keep tool definitions stable; action permissions and
pressure gates still apply.
[All commands](./docs/guide.md#command-reference) · [Agent tools](./docs/guide.md#agent-tools)

## Optional components

The default installation works without these components. Nothing installs a
memory server, downloads a model or enables an optional engine on your behalf.

| Feature | Install only when needed |
| --- | --- |
| Separate local Mnemopi store | `@oh-my-pi/pi-mnemopi@18.12.6` |
| Mnemopi without Bun 1.3.14+ on `PATH` | `bun@1.4.4` |
| Experimental image snapshots of old output | `@resvg/resvg-js@2.6.2` |

**Status & help → Readiness & details** provides the exact command for your
Pi package directory. For a standard npm-managed installation, Mnemopi uses:

```bash
npm install @oh-my-pi/pi-mnemopi@18.12.6 bun@1.4.4 --prefix ~/.pi/agent/npm --legacy-peer-deps
```

Pi's `--legacy-peer-deps` installation does not pull optional peers in by itself.
Explicitly added components survive `pi update`, but are not automatically
synchronized with the versions listed above. To refresh Mnemopi components you
already use, rerun the command above; **Readiness & details** supplies the prefix
for your actual installation. These components live in Pi's package directory,
not in a global npm install.
[Memory setup](./docs/guide.md#memory-store-memorybackend)

## Boundaries worth knowing

- **Recovery is bounded.** Archived evidence contains what Pi actually recorded;
  it cannot recover bytes a tool omitted. Rewind is not filesystem rollback.
- **A smaller prompt is not proof of savings.** Retrieval, cache rebuilds and
  discarded summary preparation can cost. [Evaluation limits](./docs/evaluation.md)
- **Verification is not semantic proof.** Review important constraints and
  decisions. Provider-native summaries are experimental and not EESV-verified.
- **Privacy has limits.** Secret scrubbing reduces exposure; it is not a DLP
  system. Raw session logs and debug output may contain sensitive content.
  [Security](./SECURITY.md) · [Storage](./docs/guide.md#storage-and-privacy)
- **Provider integrations differ.** Claude OAuth needs a compatible adapter
  for nested requests; image snapshots need a supported reader and cost check.
  [Compatibility details](./docs/guide.md#summary-format-provider-compaction-and-images)

## Documentation and development

| For | Start here |
| --- | --- |
| Everyday use and recovery | [User guide](./docs/guide.md) |
| Settings, defaults and model routes | [Configuration](./docs/configuration.md) |
| Design and extension integrations | [Architecture](./ARCHITECTURE.md) · [Message delivery](./docs/message-delivery.md) |
| Development and releases | [Contributing](https://github.com/alpertarhan/pi-smart-compact/blob/main/CONTRIBUTING.md) · [Release checklist](./docs/RELEASE.md) |
| Help, naming and visual assets | [Support](./SUPPORT.md) · [Identity](./docs/identity.md) · [All docs](./docs/README.md) |

**One name throughout:** Smart Compact. Package `pi-smart-compact`, command
`/smart-compact`, tools `smart_*`, settings `smartCompact`. No data migration.

[MIT](./LICENSE) © [Alper Tarhan](https://github.com/alpertarhan).
