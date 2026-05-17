# pi-smart-compact

[![npm version](https://img.shields.io/npm/v/pi-smart-compact.svg)](https://www.npmjs.com/package/pi-smart-compact)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-alpertarhan%2Fpi--smart--compact-blue)](https://github.com/alpertarhan/pi-smart-compact)

<p align="center">
  <img src="./docs/assets/pi-smart-compact.png" alt="pi-smart-compact" width="760" />
</p>

> Verification-oriented smart compaction for the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

`pi-smart-compact` replaces blind conversation trimming with a structured compaction pipeline that tries to preserve what an agent actually needs to continue working: the goal, modified files, unresolved errors, decisions, constraints, and open follow-up loops.

It uses an **EESV** pipeline:

**Extract → Explore → Synthesize → Verify**

Under the hood, the design is grounded in two core ideas:

- **agentic compaction**: let the system inspect and reason about the session instead of collapsing everything into generic prose
- **Kamradt-style chunking**: break large conversations into more coherent segments before synthesis

---

## What this project is

This package is a **Pi extension** with three integration surfaces:

| Surface | Purpose |
| --- | --- |
| `/smart-compact` | manual compaction from the chat UI |
| `session_before_compact` | auto-run before Pi's default compaction |
| `smart_compact` tool | agent-callable compaction for long sessions |

The extension stages a short-lived pending summary in memory, then hands it back to Pi when compaction is applied.

---

## Why it exists

Default compaction often loses the parts that matter most during coding work:

- which files were actually changed
- which errors are still unresolved
- what the user explicitly asked for
- what decisions already won
- what should happen next

`pi-smart-compact` is built to preserve that operational context instead of producing a vague recap.

---

## How it works

```mermaid
flowchart LR
    A[Extract<br/>deterministic facts] --> B[Explore<br/>optional targeted analysis]
    B --> C[Synthesize<br/>single-pass or chunked summary]
    C --> D[Verify<br/>score gaps and repair]
    D --> E[Return smart compaction to Pi]
```

### Pipeline summary

1. **Extract**
   - deterministically pulls files, errors, decisions, constraints, topics, and open loops from the session
2. **Explore**
   - optionally inspects the conversation more deeply when the session is complex
3. **Synthesize**
   - creates either a single-pass summary or a chunked hierarchical summary
4. **Verify**
   - checks the result against extracted facts and patches missing critical details

In short: **facts first, synthesis second, verification last**.

---

## What it tries to preserve

- user goal
- constraints and preferences
- modified / read / deleted files
- unresolved and resolved errors
- key decisions
- open follow-up work
- critical context needed for the next turn
- delta from the previous compaction

---

## Installation

### npm / Pi package

```bash
pi install npm:pi-smart-compact
```

### GitHub

```bash
pi install git:github.com/alpertarhan/pi-smart-compact
```

### Local development

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/alpertarhan/pi-smart-compact.git
cd pi-smart-compact
bun install
bun run build
```

---

## Quick start

### Interactive

```bash
/smart-compact
```

With no arguments, the extension opens a small picker for:

1. model
2. profile

### Direct command examples

```bash
/smart-compact anthropic/claude-sonnet-4 balanced
/smart-compact dry-run
/smart-compact debug
/smart-compact "focus on auth changes and unresolved follow-up work"
```

### Tool usage

```json
{
  "name": "smart_compact",
  "parameters": {
    "profile": "balanced",
    "verbose": false,
    "dry_run": false
  }
}
```

The tool prepares a pending smart summary and lets Pi consume it on the next natural compaction.

---

## Usage notes

- compaction is skipped when the context is still small enough
- the tool path does **not** compact the conversation mid-turn
- pending summaries are kept in memory for **5 minutes**
- exploration is adaptive and may be skipped for simple sessions

This keeps the extension helpful without forcing extra work when it is not needed.

---

## Configuration

Add this to `~/.pi/agent/settings.json`:

```json
{
  "smartCompact": {
    "profile": "balanced",
    "summaryModel": "anthropic/claude-sonnet-4",
    "segmentationModel": "anthropic/claude-haiku-3",
    "autoTrigger": true,
    "backupEnabled": true,
    "profiles": {
      "balanced": {
        "summaryBudgetTokens": 6000,
        "keepRecentTokens": 20000
      }
    }
  }
}
```

### Supported keys

| Key | Type | Default |
| --- | --- | --- |
| `profile` | `light \| balanced \| aggressive` | `balanced` |
| `summaryModel` | `string \| null` | `null` |
| `segmentationModel` | `string \| null` | `null` |
| `autoTrigger` | `boolean` | `true` |
| `backupEnabled` | `boolean` | `true` |
| `backupDir` | `string` | `~/.pi/agent/compact-backups` |
| `profiles` | partial per-profile overrides | built-ins |

### Profiles

| Profile | Summary budget | Keep recent | Typical use |
| --- | ---: | ---: | --- |
| `light` | 10000 | 30000 | preserve more detail |
| `balanced` | 6000 | 20000 | default general use |
| `aggressive` | 3000 | 10000 | tighter summaries |

### Backward compatibility

The extension still accepts the old config key `semanticCompact`, but `smartCompact` is the current key.

---

## Output contract

Generated summaries are expected to use this structure:

```markdown
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Files Modified
## Files Read
## Open Loops
## Changes Since Last Compaction
## Next Steps
## Critical Context
## Topics Covered
```

The extension also builds a structured `CompactionState` for reuse across later compactions.

---

## Safeguards

The current design includes:

- deterministic extraction before summarization
- adaptive exploration
- chunked synthesis for larger sessions
- deterministic verification scoring
- deterministic patching before LLM patching
- hallucinated file-reference detection
- open-loop injection
- project fingerprinting and delta tracking
- backup creation before compaction
- metrics logging and damage detection

---

## Runtime artifacts

At runtime, the extension writes to paths under `~/.pi/agent/`, including:

- `settings.json`
- `compact-backups/`
- `.cache/compact-extraction-<session>.json`
- `.cache/compact-metrics.jsonl`
- `.cache/smart-compact/projects/<projectId>.json`
- `.cache/smart-compact/states/<projectId>.json`
- `.cache/smart-compact/damage-reports.jsonl`

---

## Repository layout

```text
.
├── src/
│   ├── index.ts
│   ├── core.ts
│   ├── phases/
│   ├── ui/
│   └── utils/
├── test/
├── docs/
├── dist/
└── package.json
```

---

## Development

```bash
bun install
bun test
bun run build
bun run typecheck
```

Build output is published from `dist/`.

---

## Project docs

- [`CHANGELOG.md`](./CHANGELOG.md) — release history
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system design and execution model
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — contributor workflow and expectations
- [`ROADMAP.md`](./ROADMAP.md) — current priorities
- [`DEVPLAN.md`](./DEVPLAN.md) — archived implementation plan

---

## License

MIT © [Alper Tarhan](https://github.com/alpertarhan)
