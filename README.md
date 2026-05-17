# Smart Compact

[![npm version](https://img.shields.io/npm/v/pi-smart-compact.svg)](https://www.npmjs.com/package/pi-smart-compact)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-alpertarhan%2Fpi--smart--compact-blue)](https://github.com/alpertarhan/pi-smart-compact)

> Intelligent, verification-oriented conversation compaction for the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

**Smart Compact** is a Pi extension that compresses long coding sessions by preserving the *working state* of the conversation - not just the words. Instead of blindly truncating old messages, it extracts verified facts, explores ambiguous areas when needed, synthesizes a structured summary, and checks that the result still covers the important parts of the session.

In practice, that means your agent keeps the things that actually matter:

- the real goal
- exact file paths
- unresolved errors
- decisions already made
- constraints and preferences
- follow-up work still pending
- **open loops** — unresolved tasks that survive compaction
- **delta since last compaction** — what changed, what resolved, what's new
- **structured state** — machine-readable JSON alongside the Markdown summary

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [What makes it different](#what-makes-it-different)
- [Design philosophy](#design-philosophy)
- [Inspiration](#inspiration)
- [How it works](#how-it-works)
- [Key capabilities](#key-capabilities)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Output format](#output-format)
- [Architecture details](#architecture-details)
- [Quality and safety controls](#quality-and-safety-controls)
- [Compatibility](#compatibility)
- [Development](#development)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

---

## Why this exists

Large coding sessions have a very specific failure mode: the context window fills up, compaction happens, and the agent loses the operational memory required to continue well.

Typical summaries often miss at least one of these:

- which files were actually changed
- whether an error was resolved or only retried
- what the user explicitly asked for
- which architectural decision already won
- what still needs to happen next

For a coding agent, these omissions are expensive. They lead to redundant reads, repeated questions, contradictory edits, or unfinished follow-up work.

**Smart Compact** is built to reduce those failures.

---

## What makes it different

Smart Compact is not just "another summary prompt." It is a **multi-stage compaction pipeline** with deterministic extraction, targeted exploration, structured synthesis, and verification.

That design gives it a few practical advantages over plain truncation or one-shot summarization:

- **Deterministic first, LLM second** - verified facts are extracted before any model call
- **Cheaper when possible** - simple sessions skip exploration entirely
- **Safer by default** - summaries are checked for missing files, errors, constraints, and fabricated paths
- **More agent-friendly** - output is structured around goal, progress, decisions, files, next steps, and critical context
- **Better continuity** - follow-up work survives compaction more reliably

---

## Design philosophy

Smart Compact is built around a few core principles:

### 1. Accuracy over style
A beautiful summary that invents a file path is worse than a plain summary that is correct.

### 2. Determinism before generation
Anything we can extract mechanically from the conversation should not be guessed by an LLM.

### 3. Preserve working state, not transcript fidelity
The goal is not to recreate the whole conversation. The goal is to preserve the information needed to continue the work correctly.

### 4. Spend tokens where they matter
Easy sessions should stay cheap. Complex sessions should get deeper exploration and better synthesis.

### 5. Optimize for real coding sessions
This extension is designed for implementation, debugging, review, and discussion workflows inside Pi - not for generic meeting notes.

---

## Inspiration

This project is informed by the broader **context engineering** and **agentic context management** space.

In particular, the design is influenced by:

- long-context summarization patterns used in agent systems
- deterministic-plus-LLM hybrid pipelines
- structured memory preservation for coding workflows
- ideas popularized in the ecosystem by people such as **Greg Kamradt** around context quality, retrieval discipline, and practical LLM memory design

Smart Compact is **not** a copy of any single project. It is a Pi-native implementation focused specifically on coding-agent conversations, with strong emphasis on verified facts, exact code references, and safe continuation after compaction.

---

## How it works

Smart Compact uses an **EESV** pipeline:

```text
Extract → Explore → Synthesize → Verify
```

| Phase | Purpose | Typical LLM cost |
| --- | --- | --- |
| **Extract** | Deterministically mine files, errors, decisions, constraints, and topic boundaries | **0 calls** |
| **Explore** | Investigate ambiguous areas with tools and improve topic understanding | 0-8 calls |
| **Synthesize** | Build batch summaries and merge them into one structured compaction summary | N+1 calls |
| **Verify** | Check coverage, detect hallucinations, patch missing facts deterministically first | 0-1 calls |

### Before EESV

Smart Compact first performs lightweight preprocessing:

- **redundancy pruning**
- **project fingerprint loading**
- **incremental extraction cache lookup**

### After EESV

It can also record quality signals for future analysis:

- re-reads after compaction
- user complaints
- weak continuity indicators

---

## Key capabilities

### Deterministic extraction
Before asking any model to summarize anything, Smart Compact extracts:

- modified, read, and deleted files
- error chains and retry attempts
- explicit and implicit decisions
- user constraints and preferences
- heuristic topic segments
- main goal and recent user signals

### Adaptive exploration
Not every session needs expensive model-driven exploration.

Simple sessions can skip Phase 2 entirely when they have:

- few topics
- few unresolved errors
- few decisions
- limited cross-directory work

### Open Loops detection
Every compaction identifies unresolved work and tracks it as **open loops**:

- **bugfix** — unresolved errors from tool calls
- **follow-up** — user mentions of pending next steps
- **blocked** — dependencies waiting on external input
- **retry** — retried but still-unresolved failures

Each loop gets a stable ID, priority, and file references. They appear in both the Markdown summary and the structured JSON state.

### Cross-compaction tracking
Smart Compact persists structured state between compactions. On the next compaction, it loads the previous state and computes a **delta**:

- which open loops were resolved
- which are still persistent
- which decisions carried over
- which errors were fixed vs newly introduced
- which files are newly modified
- whether the goal shifted

This means every compaction builds on the last one — not from scratch.

### Structured JSON state output
Alongside the human-readable Markdown summary, Smart Compact produces a machine-readable `CompactionState` JSON object:

- goal, decisions, constraints
- modified/read/deleted files
- unresolved and resolved errors
- open loops with stable IDs
- next actions and critical context
- session type and version

This structured state enables better verification, follow-up tracking, and future retrieval integration.

### Decision propagation
Batch summaries receive decisions from earlier segments, reducing a common failure mode where later summaries "forget" what was decided earlier.

### Verification-oriented synthesis
The final summary is checked against extracted facts. If important information is missing, Smart Compact tries to patch it deterministically before spending another LLM call.

### Redundancy pruning
Input is reduced by removing or compressing low-value patterns such as:

- duplicate file reads
- repetitive failure chains
- empty acknowledgments
- oversized tool outputs

### Cross-session project context
The extension keeps a small project fingerprint so later compactions can reuse context such as:

- dominant language
- likely framework
- important directories
- recently relevant files

### Auto-triggered compaction
When enabled, Smart Compact hooks into Pi's `session_before_compact` event and can replace default blind compaction with a smarter summary.

---

## Installation

### Recommended: install as a Pi package

```bash
pi install npm:pi-smart-compact
```

### Or install from GitHub

```bash
pi install git:github.com/alpertarhan/pi-smart-compact
```

### Or work on it locally

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/alpertarhan/pi-smart-compact.git
cd pi-smart-compact
bun install
bun run build
```

The published package loads the compiled extension entry at **`dist/index.js`**. Source code lives in `src/`, but the package manifest points Pi at `./dist/index.js` for distribution.

---

## Quick start

### Slash command

```bash
/smart-compact
```

This opens the interactive picker and lets you choose:

- model
- compression profile

### Direct usage

```bash
/smart-compact anthropic/claude-sonnet-4 balanced
```

### Dry run

```bash
/smart-compact dry-run
```

### Verbose mode

```bash
/smart-compact debug
```

### Add steering / follow-up emphasis

```bash
/smart-compact "focus on auth changes and remaining follow-up work"
```

### Tool usage

Smart Compact also registers an agent-callable tool:

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

### Supported options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `profile` | `"light" \| "balanced" \| "aggressive"` | `"balanced"` | Default compaction profile |
| `summaryModel` | `string \| null` | `null` | Override summarization model |
| `segmentationModel` | `string \| null` | `null` | Override exploration model |
| `autoTrigger` | `boolean` | `true` | Run automatically before Pi's built-in compaction |
| `backupEnabled` | `boolean` | `true` | Save a backup before compaction |
| `profiles` | `object` | built-in defaults | Override per-profile budgets |

### Profiles

| Profile | Summary budget | Keep recent | Best for |
| --- | --- | --- | --- |
| **light** | 10K | 30K | sessions where more detail should survive |
| **balanced** | 6K | 20K | general daily development |
| **aggressive** | 3K | 10K | large contexts and faster reduction |

### Backward compatibility

For migration safety, the extension still accepts the older config key:

- `semanticCompact`

but the current key is:

- `smartCompact`

---

## Output format

Smart Compact produces structured Markdown designed to be both human-readable and useful to the agent:

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

New sections:

- **Open Loops** — unresolved tasks with priority and file references
- **Changes Since Last Compaction** — delta from previous compaction state

The format is intentionally opinionated. It is optimized to preserve:

- actionable state
- exact references
- unresolved issues
- open loops and follow-up integrity
- state transitions across compactions
- clear continuation paths

### Structured JSON output

In addition to Markdown, Smart Compact produces a structured `CompactionState` object accessible in compaction details:

```json
{
  "goal": "Build auth module",
  "decisions": [{ "id": "decision-1", "summary": "Use JWT", "type": "explicit" }],
  "constraints": [{ "id": "constraint-1", "text": "Must use TypeScript", "category": "requirement" }],
  "modifiedFiles": ["src/auth.ts"],
  "unresolvedErrors": [],
  "openLoops": [{ "id": "loop-1", "type": "follow-up", "priority": "normal", "summary": "add tests" }],
  "resolvedErrors": [{ "id": "error-1", "message": "login returns undefined", "tool": "bash" }],
  "nextActions": ["Add unit tests for auth"],
  "sessionType": "implementation",
  "compactionVersion": "7.7.0"
}
```

---

## Architecture details

## 1) Extract

The extraction phase performs zero-LLM analysis on message structure.

It identifies:

- file operations from tool calls and tool results
- no-op edits (`applied: 0`, `no changes`)
- tool errors and bash-like failures
- retries and likely resolutions
- explicit `ask_user` decisions
- implicit user choices such as "use X instead of Y"
- English and Turkish constraint language
- topic boundaries from file transitions, error density, and user shift cues

## 2) Explore

Exploration is only used when the session is complex enough to justify it.

When active, the model can use tools such as:

- `get_message_range`
- `search_conversation`
- `get_recent_user_messages`
- `get_context_around`
- `get_file_changes`
- `get_error_chain`

This phase helps refine:

- topic boundaries
- cross-topic relationships
- missing constraints
- completion state
- narrative continuity

## 3) Synthesize

Synthesis supports two modes:

### Single-pass
Used when the compacted portion is small enough.

### Hierarchical
Used for larger sessions:

- chunk messages into segments
- summarize segments in batches
- propagate prior decisions forward
- merge summaries into one final structured summary

## 4) Verify

Verification checks the final summary against deterministic extraction data.

It looks for issues such as:

- missing modified files
- missing unresolved errors
- missing strong constraints
- missing explicit decisions
- missing Open Loops section when unresolved errors exist
- suspicious file references not seen in the conversation
- structural omissions

If needed, Smart Compact applies:

1. **deterministic patching first**
2. **LLM patching only if necessary**

---

## Quality and safety controls

### Exact-name discipline
Prompts explicitly tell the model to preserve exact file paths, identifiers, and verified facts.

### Immutable context framing
Deterministically extracted facts are presented as ground truth during assembly.

### Verification-first fallback strategy
The extension prefers:

- no patch
- deterministic patch
- LLM patch as last resort

### Backups
Conversation backups can be written before compaction.

### Metrics
The pipeline tracks:

- call counts
- input/output token volume
- cache hit rate
- average latency

### Incremental extraction cache
Structured extraction results are cached per session to avoid reprocessing unchanged history.

### Cross-compaction state persistence
After each compaction, the structured state is persisted to disk. On the next compaction, Smart Compact:

1. loads the previous state
2. computes a delta (resolved loops, new errors, goal shifts, etc.)
3. injects `## Changes Since Last Compaction` into the summary
4. saves the updated state for the next cycle

This creates a **compaction memory chain** — every compaction builds on the last.

---

## Compatibility

Smart Compact is designed as a standalone Pi extension, but it is also intended to fit naturally into richer Pi setups.

It should be a good conceptual fit alongside workflow-oriented extensions and packages such as:

- `pi-agent-flow`
- `pi-simplify`
- `pi-lens`

As always with Pi packages, review interactions in your own environment if you combine multiple extensions that hook into related session flows.

---

## Development

### Project structure

```text
src/         TypeScript source
 dist/        compiled package entry for distribution
 test/        Bun tests
 README.md    package documentation
```

### Test suite

Smart Compact has **91 tests** across 9 files, including:

- **Unit tests** — extraction, tokens, verification, pruning, fingerprint, exploration
- **State tests** — open loops, compaction state, delta computation, state persistence
- **Evaluation harness** — 5 gold conversation scenarios with expected extraction results, delta evaluation across compactions, and fabrication safety checks

```bash
bun test                # run all 91 tests
bun test test/eval.test.ts  # evaluation harness only
```

### Local commands

```bash
bun install
bun run build
bun run typecheck
```

### Build output

Published builds use:

- `dist/index.js`

This keeps the distributed package aligned with common npm packaging expectations while preserving a TypeScript-first source layout during development.

### Local package path

If you are developing inside Pi directly, this project commonly lives at:

```text
~/.pi/agent/extensions/pi-smart-compact
```

---

## Limitations

Smart Compact is strong, but it is not magic.

A few honest limitations:

- it still depends on model quality during exploration and synthesis
- very noisy sessions can still produce weaker summaries than ideal
- verification is strong for extracted facts, but not a formal proof system
- project fingerprints are intentionally lightweight, not a full memory database
- token estimates are calibrated heuristics, not exact provider tokenizers

---

## Contributing

Issues, suggestions, and pull requests are welcome.

If you contribute, the best changes tend to be:

- measurable
- easy to validate with tests
- explicit about quality/cost trade-offs
- careful about hallucination risk and continuation quality

Typical flow:

```bash
git checkout -b feat/my-change
bun test
bun run build
git commit -m "feat: ..."
```

---

## License

MIT © [Alper Tarhan](https://github.com/alpertarhan)
