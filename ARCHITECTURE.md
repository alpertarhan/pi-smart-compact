# Architecture

This document describes how `pi-smart-compact` works at a system level.

## Overview

`pi-smart-compact` is a Pi extension for **verification-oriented smart compaction**.

Its job is not to produce a generic recap. Its job is to preserve the agent's working state so the next turn can continue with minimal loss.

The design combines three ideas:

- **agentic compaction** — let the system inspect the session, not just summarize it
- **Kamradt-style chunking** — segment large conversations into more coherent units before synthesis
- **EESV** — **Extract → Explore → Synthesize → Verify**

## Integration surfaces

The extension registers three surfaces from `src/index.ts`:

1. `/smart-compact`
   - interactive or direct manual compaction
2. `session_before_compact`
   - auto-triggered smart compaction before Pi's default compaction
3. `smart_compact` tool
   - agent-callable compaction for long sessions

A short-lived pending compaction is kept in memory and consumed by Pi when compaction is applied.

## High-level flow

```mermaid
flowchart LR
    A[Session branch] --> B[Keep recent tail]
    B --> C[Extract deterministic facts]
    C --> D{Complex enough?}
    D -- No --> E[Single-pass synthesis]
    D -- Yes --> F[Explore + segment]
    F --> G[Chunked synthesis]
    E --> H[Verify + repair]
    G --> H
    H --> I[Open loops + delta + state]
    I --> J[Pending compaction returned to Pi]
```

## Core execution model

### 1. Entry and context gate

`src/index.ts` resolves models, parses command arguments, and routes work into `runSmartCompact()` in `src/core.ts`.

Before doing expensive work, the system checks context size. If usage is below the threshold in `src/constants.ts`, compaction is skipped.

## 2. Keep window and preprocessing

`src/core.ts` keeps a recent tail of messages untouched so very recent context stays live.

Before summarization, the pipeline also:

- prunes redundant messages
- serializes the compacted portion of the conversation
- creates a backup when enabled
- loads previous compaction context
- checks incremental extraction cache
- loads project fingerprint data if available

## 3. Extract

Primary implementation: `src/utils/extraction.ts`

This phase is deterministic and uses **zero LLM calls**.

It extracts:

- modified files
- read files
- deleted files
- tool and bash-like errors
- retry / resolution signals
- explicit and implicit decisions
- constraints and preferences
- heuristic topic segments
- timeline events
- main goal
- open loops

This phase provides the ground truth used later by synthesis and verification.

## 4. Explore

Primary implementation: `src/phases/explore.ts`

Exploration is optional. It runs only when the session appears complex enough.

If it runs, the model can inspect the conversation through a small toolset such as:

- message ranges
- conversation search
- recent user messages
- local context around a message
- file-change lookups
- error chains

If tool support is unavailable, the system falls back to a direct structured analysis path.

## 5. Synthesize

Primary implementation: `src/phases/synthesize.ts`

Two synthesis modes exist:

### Single-pass
Used when the compacted conversation still fits under the configured single-pass threshold.

### Hierarchical
Used for larger sessions:

1. merge heuristic and exploratory boundaries
2. create chunks
3. batch chunks according to token budget
4. summarize batches
5. assemble a final summary

Important behaviors:

- session-aware prompting
- decision propagation across later batches
- provider-aware output limits and concurrency
- deterministic fallback assembly when LLM assembly fails

## 6. Verify

Primary implementation: `src/phases/verify.ts`

Verification scores the summary against deterministic extraction data.

It checks for things like:

- missing modified files
- missing unresolved errors
- missing high-confidence constraints
- weak goal coverage
- missing structure sections
- suspicious fabricated file references
- done/unresolved inconsistencies
- missing explicit decisions
- missing open-loop coverage

Repair order is intentional:

1. accept if good enough
2. deterministic patch first
3. LLM patch only if still insufficient

## 7. Post-processing and persistence

After verification, `src/core.ts` and `src/utils/state.ts` enrich the summary and persist reusable state.

Post-processing includes:

- open-loop extraction and injection
- `CompactionState` construction
- delta computation against previous compaction
- changes-since-last-compaction injection
- project fingerprint persistence
- compaction state persistence
- metrics logging
- best-effort damage detection

## Runtime state and artifacts

The extension writes data under `~/.pi/agent/`, including:

- conversation backups
- extraction cache
- metrics logs
- project fingerprints
- compaction states
- damage reports

Important TTLs in the current design:

- pending in-memory compaction: 5 minutes
- exploration tool-support cache: 30 minutes
- extraction cache: 1 hour
- compaction state: 7 days

## Key files

| File | Responsibility |
| --- | --- |
| `src/index.ts` | extension registration and entry surfaces |
| `src/core.ts` | pipeline orchestration |
| `src/constants.ts` | version, thresholds, prompts, config keys |
| `src/phases/explore.ts` | targeted exploration |
| `src/phases/synthesize.ts` | chunking and summary generation |
| `src/phases/verify.ts` | scoring and repair |
| `src/utils/extraction.ts` | deterministic fact extraction |
| `src/utils/state.ts` | structured state, open loops, delta |
| `src/utils/helpers.ts` | config, backups, batching, shared helpers |
| `src/utils/cache.ts` | metrics and extraction cache |
| `src/utils/fingerprint.ts` | project fingerprinting |
| `src/utils/damage.ts` | post-compaction regression signals |
| `src/ui/overlays.ts` | UI picker, progress, result screen |

## Safety properties

The architecture intentionally biases toward safety:

- deterministic extraction before summarization
- adaptive exploration instead of always-on tool use
- verified file lists and error context
- deterministic repair before additional LLM calls
- hallucinated file-reference detection
- stateful tracking of open loops and cross-compaction deltas

## Design constraints

A few constraints shape the implementation:

- tool-driven compaction must not compact the conversation mid-turn
- summaries must preserve exact file paths and identifiers where possible
- recent conversation tail should remain live outside the compacted region
- docs should separate user-facing overview from maintainer-facing internals

## Extending the system

When adding features, prefer this order of operations:

1. extract more deterministic signal if possible
2. enrich exploration only when needed
3. keep synthesis prompts structured and bounded
4. strengthen verification before increasing model dependence
5. update tests and docs in the same change
