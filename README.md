<p align="center">
  <img src="./docs/assets/banner.png" alt="Pi Continuity — context hygiene and session continuity for Pi" width="960" height="240" />
</p>

# Pi Continuity

**Keep useful context. Keep the way back.**

Pi Continuity helps long-running [Pi Coding Agent](https://github.com/earendil-works/pi)
sessions manage noisy tool output, recover evidence, and carry goals, constraints,
decisions and unfinished work through compaction. Pi owns the session lifecycle;
this extension adds context hygiene and continuity policies around it.

[Get started](#get-started) · [User guide](./docs/guide.md) ·
[Configuration](./docs/configuration.md) · [Documentation index](./docs/README.md)

> **Pi Continuity is the product name; `pi-smart-compact` is the package.**
> `/smart-compact`, `smart_*` tools and `smartCompact` settings are unchanged.
> The TUI still says **Smart Compact**. No data or configuration migration is
> needed. [Identity and naming](./docs/identity.md).
>
> **Pi Continuity 10.1.0:** upgrading from 9.x? Update Pi to 0.87.1 or newer
> and read the [upgrade notes](./docs/guide.md#upgrade-from-9x). Optional memory
> engines and image rendering are installed separately. The
> [changelog](./CHANGELOG.md) records the full release and its evidence limits.
> These defaults (pressure-first cleanup, eager tool exposure, native tool
> rows) ship with 10.1.0.

## What it does

| Task | Use | Boundary |
| --- | --- | --- |
| Reduce old tool-output noise | **Context hygiene**: archive eligible output behind retrievable references | Protected instructions, failures and recent work stay in context. |
| Finish a research detour | **Checkpoint and rewind**: retain a report and a path back to evidence | Not a filesystem or side-effect rollback. |
| Make room for the next stage | **Verified compaction**: extract working state, synthesize a bounded summary, check it before apply | Verification catches known gaps; it does not guarantee semantic truth. |
| Revisit a milestone | **Session navigation**: named anchors, read-only cross-session search, return on a new branch with carryover | Files, processes and external services are unchanged. |
| Continue in a fresh session | **Handoff**: seed a new session from recorded state, without a model call | Not a new summary of the entire transcript; parent evidence remains retrievable. |
| Reuse an approved fact | **Project memory**: scoped recall through one selected backend | Separate from session state, output archives and backups. |

The goal is a smaller **working set**, not an inaccessible history. Compaction
uses **Extract → Explore → Synthesize → Verify (EESV)**; exploration depends on
the mode, and verification is primarily deterministic.
[How it works](./docs/guide.md#how-it-works-in-one-minute) · [Architecture](./ARCHITECTURE.md)

## Get started

Requires **Pi 0.87.1+** and **Node.js 22.19+**.

```bash
pi install npm:pi-smart-compact
```

Then, in Pi's interactive TUI:

```text
/smart-compact
```

Opening Home changes nothing. Without a UI (print, RPC or SDK), the bare command
instead runs a compaction with your configured defaults.

Open **Settings → How it runs** to choose your level of control:

| Preset | Behavior |
| --- | --- |
| **Manual only** | You start compaction or cleanup; no extension-scheduled work. |
| **Manual + agent** | You or the agent can request compaction. |
| **Cleanup only** | Local, recoverable cleanup; no automatic summary generation. |
| **Fully automatic** | Cleanup plus compaction requests when idle at the configured context threshold. |

Pi's own compaction setting is separate. **Pressure-first (default)** keeps
roomy history unchanged, allows cleanup at an early pressure gate, then requests
compaction when idle at 80% if still needed. The optional `native-hook` strategy
participates only when Pi starts compaction. [Trigger settings](./docs/configuration.md).

For your first run, choose **Compact now**, inspect the plan, then review the
result. **A** applies it; **C** or **Esc** cancels. **Enter does not apply** on
the review screen. Approval is required unless you explicitly disable
`requireApproval`.

### Optional components

A normal Pi install does **not** install these opt-in components. Enable them
only for the feature you need; nothing is downloaded, started or configured on
your behalf.

| Feature (off by default) | Component | Approximate disk use¹ |
| --- | --- | --- |
| Mnemopi memory store | `@oh-my-pi/pi-mnemopi@18.3.1` and its engine packages | 195 MB |
| Mnemopi without Bun 1.3.14+ on `PATH` | `bun@1.4.2` | 60 MB |
| Image snapshots (`visualArchiveEnabled`) | `@resvg/resvg-js@2.6.2` | 3.5 MB |

¹ Measured on macOS arm64; not download sizes or cross-platform guarantees.

**Status & help → Readiness & details** shows the exact install command for a
missing component and your Pi install root. A typical Mnemopi setup is:

```bash
npm install @oh-my-pi/pi-mnemopi@18.3.1 bun@1.4.2 --prefix ~/.pi/agent/npm --legacy-peer-deps
```

Pi uses `--legacy-peer-deps`, so optional peers are not pulled in automatically.
Installing them explicitly records them in that package directory; they survive
`pi update`. For a bun- or pnpm-managed Pi install, use the equivalent add command
in the same directory. [Memory setup](./docs/guide.md#memory-store-memorybackend).

## One Home, five choices

**Compact now** · **Clean up tool output** · **Settings** ·
**History & recovery** · **Status & help**

Use arrows and Enter to navigate, Esc to go back, and **D** for planning or
result details. Home shows context usage and effective permissions; unavailable
actions explain why.

| Direct command | What happens |
| --- | --- |
| `/smart-compact trim` | Queues local cleanup without a model call. The next request is still untrimmed; the edit commits at the next natural completed-turn boundary. |
| `/smart-compact storage` | Reports archived output; never deletes it. A scan cannot prove that an unreferenced artifact is safe to remove. |
| `/smart-compact context` | Opens anchors, cross-session search and branch navigation. |
| `/smart-compact handoff dry-run` | Previews a new-session seed without opening one. Use `handoff [-- note]` to proceed. |
| `/smart-compact metrics` | Shows effective state, run outcomes, recent issues and the host prompt-cache ledger. |

By default permitted agent tools stay visible from session start, avoiding late
schema changes to cached prefixes. Actions, not visibility, are pressure-gated;
read-only recovery and metadata checkpoints remain available while roomy.
Optional lazy loading uses `smart_tools`. The context guide is read on request,
not injected. Tool availability and compaction permission are separate controls.
[Agent tools](./docs/guide.md#agent-tools) · [All commands](./docs/guide.md#command-reference)

## Memory is optional; continuity is the core

No remote memory service is needed for session continuity. **Local graph** is
the default for on-machine scoped recall. Choose **Mnemopi** for a separate local
engine, or **Hindsight** for your existing server and bank. Only the selected
backend is read or written; failures never silently fall back to another store.

Explicit saves require confirmation. When enabled, the local graph also indexes
derived state after host-confirmed compactions. None of these stores replaces
session backups or archived tool output.
[Memory workflows](./docs/guide.md#memory-what-is-stored-where) · [Hindsight and privacy](./docs/hindsight-memory.md)

## Boundaries worth knowing

- **Recovery is bounded.** Rewind does not undo file changes. Archives cannot
  restore bytes omitted before Pi recorded the output.
- **Review the summary.** Extraction and deterministic verification can miss
  information. A verifier score is not a measure of task success.
- **Experimental formats are opt-in.** Provider-native summaries are not
  EESV-verified. Image snapshots need a supported reader and a cost check;
  otherwise text is used.
- **Claude OAuth needs a compatible adapter.** The published
  `pi-claude-oauth-adapter@0.2.2` normalizes Pi's own requests, not all nested
  model-runtime calls. Full coverage needs final-payload normalization
  ([upstream PR #10](https://github.com/minzique/pi-claude-oauth-adapter/pull/10)).
  [Compatibility details](./docs/guide.md#summary-format-provider-compaction-and-images).
- **Cost and quality need live evidence.** Cancelled or discarded preparation
  still costs. Offline pilots do not establish billed savings, model fidelity
  or production readiness. [Evaluation limits](./docs/evaluation.md).

## Documentation and development

| Need | Start here |
| --- | --- |
| Use, configure or recover a session | [User guide](./docs/guide.md) · [Configuration](./docs/configuration.md) |
| Understand internals or evaluate behavior | [Architecture](./ARCHITECTURE.md) · [Evaluation](./docs/evaluation.md) |
| Contribute or prepare a package | [Contributing](https://github.com/alpertarhan/pi-smart-compact/blob/main/CONTRIBUTING.md) · [Release checklist](./docs/RELEASE.md) |
| Report a problem safely | [Support](./SUPPORT.md) · [Security](./SECURITY.md) |
| Browse every guide and historical report | [Documentation index](./docs/README.md) |

[MIT](./LICENSE) © [Alper Tarhan](https://github.com/alpertarhan).
