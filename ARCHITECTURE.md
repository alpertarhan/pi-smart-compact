# Architecture

System-level design of `pi-smart-compact`. This is the maintainer-facing
companion to the user-facing [`README.md`](./README.md).

> **Job:** not to produce a generic recap, but to preserve the agent's working
> state so the next turn can continue with minimal loss.

## Design ideas

The design combines three ideas:

- **Agentic compaction** — let the system inspect the session, not just summarize it.
- **Kamradt-style chunking** — segment large conversations into coherent units before synthesis.
- **EESV** — **Extract → Explore → Synthesize → Verify**: facts first, synthesis second, verification last.

## Integration surfaces

Registered in [`src/index.ts`](./src/index.ts). See the README for usage; this
section is about lifecycle.

| Surface | Lifecycle |
| --- | --- |
| `/smart-compact` | Manual command. Interactive picker or direct args. Bypasses the adaptive gate. |
| `session_before_compact` | Auto hook. Returns/stages a pending summary or runs under pressure; durable commit waits for matching `session_compact`. |
| `smart_compact` tool | Agent-callable. Prepares a pending summary; never compacts mid-turn. |
| `smart_recall` tool | Searches only the current project's bounded context graph; same session/branch ranks first. |
| `smart_save_memory` tool | Persists one explicit user-confirmed project fact after secret/PII scrubbing. |

A short-lived pending compaction is staged in the [`PendingSlot`](#pending-compaction-slot)
and handed to Pi when compaction is applied.

### Host dependency boundary

Pi core modules and `typebox` are wildcard peers supplied by the running host;
they are neither bundled nor duplicated as versioned development dependencies.
The lockfile pins a reproducible local baseline, and `bun run compat:pi [version]`
validates another Pi release in an isolated temporary workspace.

## Pipeline at a glance

```mermaid
flowchart LR
    A[Active Pi context] --> B[Keep recent tail]
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

The orchestrator ([`src/app/run-smart-compact.ts`](./src/app/run-smart-compact.ts))
threads a typed context through ten stages:

| # | Stage | Module | Transition |
| ---: | --- | --- | --- |
| 1 | prepare | `app/steps/prepare.ts` | config + auth + provider caps |
| 2 | window | `app/steps/window.ts` | pick the prefix to compact |
| 3 | recover | `app/steps/recover.ts` | restore log-truncated messages |
| 4 | tier | `app/steps/tier.ts` | choose none / light / full |
| 5 | extract | `app/steps/extract.ts` | prune + deterministic extraction + cache |
| 6 | synthesize | `app/steps/synthesize.ts` | single-pass or EESV |
| 7 | verify | `app/steps/verify.ts` | structural verify + repair |
| 8 | state | `app/steps/state.ts` | state machine + open loops + delta |
| 9 | persist | `app/steps/persist.ts` | stage pending, apply compaction |
| 10 | metrics | `app/steps/metrics.ts` | success / failure record |

## The typed stage machine

[`src/app/run-context.ts`](./src/app/run-context.ts) models the pipeline context
as a **state machine of branded intersection types**. Each step accepts the
previous stage type and returns the next, so reordering or skipping a step is a
**compile-time error**, not a runtime crash:

```
RcBase
  → PreparedRc      (after prepare)
  → WindowedRc      (after window)
  → RecoveredRc     (after recover)
  → TieredRc        (after tier)
  → ExtractedRc     (after extract)
  → SynthesizedRc   (after synthesize)
  → VerifiedRc      (after verify)
  → StatedRc        (after state)
```

Each stage adds a `_prepared` / `_windowed` / … discriminator field that is
**never read at runtime** — it exists only to carry the type-level proof.
Mutation is preserved: a step mutates its input object and casts it to the
next stage (no per-step copy of ~30 fields). The final alias
`RunContext = StatedRc` keeps post-`buildState` consumers readable.

This is what lets `applyCompaction` read `rc.details` with zero `!` non-null
assertions: the type system proves `buildState` has run.

## Core execution model

### Entry and context gate

`src/index.ts` resolves models, parses command arguments, and routes work into
`runSmartCompact()`. Before any expensive work, the system checks context size
against the threshold in `src/constants.ts`. Auto / tool runs are skipped while
context is small; manual `/smart-compact` bypasses the gate with an advisory
warning and uses an absolute adaptive safety tail rather than a percentage of
large model windows. A pending summary
for the same session is reused instead of invoking the pipeline again. The
selected `CompactionMode` resolves to a concrete policy before the first model
call; `auto` uses context pressure and deterministic extraction risk.

Model routes are stage-specific but never inferred from mode. With no explicit
configuration, Explore, Synthesize, and Verify all use the selected Pi model.
`segmentationModel`, `summaryModel`, and `verificationModel` can independently
override those routes. `prepareRun()` resolves credentials once per distinct
provider/model route; call metrics preserve the actual route.

### Keep window and preprocessing

`app/steps/window.ts` starts from Pi's compaction-aware
`buildContextEntries()` view, never the append-only session history, then keeps
a recent tail untouched so very recent context stays live, anchored by:

- **pi-toolkit anchor protection** — normally retain the latest on-branch anchor as a soft fidelity boundary
- **`toolCall` / `toolResult` boundary guard** — never orphan a result from its call; this boundary remains hard

Boundary expansion is re-counted after both guards. If the protected tail plus
the summary budget cannot fall below the configured context trigger, automatic
and tool runs normally return control to Pi's native compactor before any LLM
call. An already-overflowed context is the safety exception: measured usage is
mapped across active messages, soft anchor/recent-turn expansion is removed,
and EESV summarizes to the mode target while the tool boundary remains intact.
This avoids sending a context larger than the active model window to native's
single summarization call. Manual runs instead compact every eligible prefix
outside the adaptive tail; empty/repeated/low-yield attempts are reported
rather than silently ignored.

Before summarization the pipeline also prunes redundant messages, serializes the
compacted portion, creates a backup, loads the previous verified summary plus
bounded continuity state, checks the incremental extraction cache, and loads
the project fingerprint.

### Extract

Primary: [`src/utils/extraction.ts`](./src/utils/extraction.ts). **Zero LLM calls.**

Deterministically pulls: modified / read / deleted files, tool and bash-like
errors, retry / resolution signals, explicit & implicit decisions, constraints
and preferences, heuristic topic segments, timeline events, the main goal, and
open loops. **This is the ground truth** that synthesis and verification trust.

### Explore

Primary: [`src/phases/explore.ts`](./src/phases/explore.ts). Optional — runs only
in `thorough` mode or when `auto` selects that policy from deterministic risk. The model inspects
the conversation through a small toolset: message ranges, conversation search,
recent user messages, local context around an index, file-change lookups, and
error chains. Tool support is runtime-probed once and cached per run; if a
provider has no function calling, the system falls back to a direct structured
analysis path. The growing tool conversation is capped at three rounds, each
response is capped where the provider supports output limits, and the shared
prefix uses short-lived prompt caching.

### Synthesize

Primary: [`src/phases/synthesize.ts`](./src/phases/synthesize.ts). Three paths:

- **Deterministic zero-call** — high-confidence Fast/Aggressive extractions.
- **Single-pass** — when the compacted conversation fits under the configured threshold.
- **Hierarchical** — for larger sessions: merge available boundaries → split oversized semantic chunks → batch by token budget → summarize batches → assemble.

Behaviors: session-aware prompting, decision propagation across later batches,
mode-specific single-pass thresholds and output limits, provider-aware
concurrency (wave scheduling), aggregate prompt-token reservation, and a
deterministic fallback assembly when any budget or LLM call fails.

### Verify

Primary: [`src/phases/verify.ts`](./src/phases/verify.ts). Scores the summary
against the deterministic extraction. It checks for missing modified files,
missing unresolved errors, missing high-confidence constraints, weak goal
coverage, missing structure sections, suspicious fabricated file references,
done/unresolved inconsistencies, missing explicit decisions, and missing
open-loop coverage.

**Repair order is intentional:** (1) deterministic patch first (free,
idempotent) → (2) one LLM patch only in `thorough` mode if still insufficient
→ (3) replace lower-scoring output with the deterministic quality floor → (4)
reject unless final verification has no gaps and meets the verified threshold.
Final verification runs again after continuity injection.

## EESV hardening and control surfaces

- **Canonical summary IR** accepts recognized H1/H2/H3 headings, preserves Progress subsections, and merges duplicate canonical kinds before state mutation.
- **Typed verification gaps** drive mandatory deterministic repair; collision-aware path needles prevent basename cross-satisfaction. Provenance is persisted and shown before optional approval.
- **Fine tool semantics** separate read/search/list/mutate/delete/execute operations. Pruning deduplicates only identical idempotent access signatures.
- **Unified token planning** uses a run-bound estimator with bounded process-shared provider/model calibration, counts structured tool-call arguments, preserves an adaptive recent tail, targets mode-specific post-compaction headroom, and reserves/reconciles every request against the mode's aggregate prompt/output-token caps.
- **Security boundaries** scrub high-confidence secrets before provider calls and durable cache/backup/state writes; PII scrubbing is opt-in.
- **Policy controls** include focus weighting, exact call/latency budgets, fail-closed manual approval, online damage monitoring, and persisted open-loop overrides.
- **Release gate** (`bun run gate`) covers adversarial parser, verification, tool, cache, budget, scrub and damage fixtures.

## State, caching & persistence

Post-verification, `app/steps/state.ts` + `src/utils/state.ts` enrich the
summary. `session_before_compact` only stages it; after the host emits the
matching `session_compact`, `app/steps/persist.ts` commits reusable state and
success telemetry. Aborted/unconfirmed candidates write neither.

| Concern | Where | Notes |
| --- | --- | --- |
| Open-loop injection | `utils/state.ts` | inserted before Next Steps via the canonical parser |
| `CompactionState` | `utils/state.ts` | conservatively merged and bounded; absence is not deletion |
| Continuity Ledger | `utils/state.ts` | deterministic carry-forward of goal, decisions, constraints, unresolved errors, and loops |
| Cross-compaction delta | `utils/state.ts` | "Changes Since Last Compaction" section |
| Incremental extraction cache | `utils/cache.ts` + `utils/id-fingerprint.ts` | SHA-256 prefix fingerprint + tail; safe only when the pruned prefix still matches |
| Session-log recovery | `utils/session-log.ts` | streaming JSONL parse; bypasses pi-toolkit truncation by entry-id mapping |
| Project fingerprint | `utils/fingerprint.ts` | language / framework / key dirs across sessions |
| Damage detection | `utils/damage.ts` | best-effort post-compaction regression signals |
| Context graph | `infra/context-graph.ts` | SQLite FTS5 facts + file edges; 2,000 non-structural nodes per project |

Apply-confirmed verified state is queued and duplicate updates coalesce only
for the exact project/session/branch head, then indexed on the next event-loop
turn so SQLite work is not part of the native
compaction hook's latency. `infra/context-graph.ts` adapts the same synchronous
query/transaction contract to `bun:sqlite` in Bun tests and `node:sqlite`
`DatabaseSync` in Pi's Node runtime; the packed release audit exercises both.
The referenced queue timer survives extension
shutdown/reload in the process; graph data is derived and a later cumulative
state safely supersedes a missed update after a hard process kill. Recall starts from FTS5 lexical matches, expands one hop
through file-reference edges, then applies session, branch, fact-kind,
confidence, recency, and explicit-memory weights. Exact equivalent facts are
deduplicated before bounded output. Resolved/superseded state is removed from
the active FTS index; another project's rows are never eligible.

**Important retention limits:** pending in-memory compaction 5 min · exploration
tool-support cache 1 h / 128 routes · token calibration 128 routes · extraction
cache 1 h · compaction state 7 d · context graph 2,000 non-structural fact nodes
per project · remediation hints 7 d · metrics and damage
JSONL logs 5 MiB each.

## Concurrency & safety model

The extension is built to run safely alongside other Pi sessions and other
extensions.

### Pending-compaction slot

[`src/app/pending-slot.ts`](./src/app/pending-slot.ts) is an encapsulated,
host-agnostic state cell (one producer, one consumer, single-threaded event
loop). `consume()` returns a discriminated result:

| `ConsumeResult.kind` | Meaning |
| --- | --- |
| `ok` | fresh payload for this session |
| `empty` | nothing staged |
| `expired` | older than the 5-minute TTL |
| `mismatch` | staged by a **different** session (cross-session leak guard) |

Session identity comes from [`infra/session-identity.ts`](./src/infra/session-identity.ts):
a real id when the host exposes one, otherwise a per-call unforgeable
`unresolved:<uuid>` — two unresolved sessions can never collide.

### Cancellation & hard timeout

Some providers ignore `AbortSignal`. The auto-trigger therefore uses a shared
[`ExternalCancellation`](./src/app/run-smart-compact.ts) handle as a second line
of defense: an outer `setTimeout` fires `abort()` and sets `timedOut`, and every
side-effect gate in the orchestrator checks that flag before writing state or
applying compaction. No `Promise.race` is needed — the shared flag drives the
bailout, eliminating the race where the outer timer fired while the pipeline was
mid-`applyCompaction`.

### Filesystem & concurrency

JSON/text cache writes use [`src/infra/fs.ts`](./src/infra/fs.ts): atomic
temp-file + rename prevents half-truncated readers but intentionally does not
claim fsync/power-loss durability. Append/trim operations use a `mkdir`-based
cross-process lock and fail closed if ownership cannot be acquired, so sessions
cannot interleave bytes. SQLite supplies its own WAL durability. Native
continuity handoffs are 0600, one-shot, bounded, and keyed by project + session
+ branch head.

## Provider awareness

[`src/utils/tokens.ts`](./src/utils/tokens.ts) keeps a per-provider capability
table (Anthropic, OpenAI, Google, DeepSeek, MiniMax, Xiaomi, Mistral, xAI, …)
with unknowns falling back to a safe default + fuzzy alias matching. Each entry
drives pipeline behavior:

| Capability | Drives |
| --- | --- |
| `maxOutputTokens` | caps synthesis / patch budgets |
| `supportsTools` (`true \| false \| "probe"`) | exploration tool-call probing |
| `concurrencyLimit` | batch synthesis wave scheduling |
| `cacheStrategy` | prompt-cache retention per call |
| `timeoutMultiplier` | auto-trigger hard-timeout headroom |
| `singlePassTokenMultiplier` | single-pass vs chunked threshold |
| `tokenRatioEstimate` | token estimation; refined by per-(provider,model) **EMA calibration** |

The Codex limiter is hybrid. Custom Codex endpoints receive
`max_output_tokens` through Pi AI's payload hook. The ChatGPT subscription
endpoint rejects every wire output-cap field, so it uses a derived 15–90s
per-call stream watchdog plus a visible-output ceiling; aborts route to the
phase's deterministic fallback.

### Provider evaluation and routing evidence

[`src/domain/provider-evaluation.ts`](./src/domain/provider-evaluation.ts)
collapses call telemetry into Explore/Synthesize/Verify routes and compares
provider/models across a deterministic context-pressure × tool-density matrix.
Only an explicitly attributed pre-repair synthesis score contributes route
quality; a run's final verifier score is never copied into Explore/Verify.
Legacy or operational-only routes still contribute latency and reliability.
Recommendations require minimum samples, ≥80% call reliability, and ≥50%
stage-local quality coverage, shrink toward neutral under low confidence, and
are advisory only.
They never mutate config or replace the selected model. The opt-in live harness
runs three identical bounded continuity scenarios across explicitly named
models.

### Privacy-safe telemetry and canary decisions

[`src/domain/telemetry.ts`](./src/domain/telemetry.ts) maps raw exceptions to a
content-free failure taxonomy, aggregates schema-v2 run quality without IDs or
conversation data, and compares an explicitly tagged `canary` cohort against
`stable` history. A deterministic gate returns Hold, Rollback, or Promote from
sample/quality coverage plus failure, verifier quality, p95 latency, token,
heuristic-fallback, and post-compaction-damage thresholds. Damage observations
join their originating compaction by local run id, dedupe per run, and require
≥70% stable/canary coverage before promotion. It is deliberately
advisory: rollout selection, configuration changes, and rollback remain
external operations.

Dashboard trust calculations live in
[`src/ui/dashboard-insights.ts`](./src/ui/dashboard-insights.ts). Data
Confidence is an auditable 100-point score over sample size, schema-v2
coverage, verifier-quality coverage, required-field completeness, and
freshness; ≥85 is the high-confidence target. TUI and HTML surfaces share the
same quality-repair, stage/provider/model, failure-taxonomy, and
stable-vs-canary aggregates. Missing/legacy evidence lowers the score and
produces remediation guidance instead of being imputed.

## Dependency injection

[`src/infra/services.ts`](./src/infra/services.ts) is a per-`runSmartCompact`
service bag. Metrics, budgets, scrubbers, and prompt namespaces are isolated per
run. Production shares only bounded provider/model capability and calibration
knowledge, which contains no conversation/session data; tests use isolated
stores by default:

| Service | Role |
| --- | --- |
| `clock` | injectable wall clock (deterministic tests) |
| `llm` | LLM client seam (production does not replay failed requests) |
| `toolSupport` | process-shared in production; explicit unsupported capability, 1 h TTL / 128 routes |
| `metrics` | bounded metrics sink |
| `extractionCacheStats` | hit / miss counters |
| `tokenCalibration` | process-shared bounded per-(provider,model) EMA factors |
| `compactSessionId` | per-run prompt-cache namespace |

## Layer responsibilities

The code is organized into six layers, each with a single responsibility.

### Entry layer

| File | Responsibility |
| --- | --- |
| `src/index.ts` | extension registration, command parsing, auto-trigger hook |
| `src/constants.ts` | version, thresholds, prompts, config keys |
| `src/types.ts` | shared types and discriminated unions |
| `domain/provider-evaluation.ts` | advisory provider scenario matrix and route telemetry aggregation |
| `domain/telemetry.ts` | privacy-safe aggregates, failure taxonomy, and canary rollback gates |

### Orchestration layer (`src/app/`)

| File | Responsibility |
| --- | --- |
| `app/run-smart-compact.ts` | top-level pipeline orchestrator |
| `app/run-context.ts` | typed stage chain (`RcBase → … → StatedRc`) |
| `app/mode-policy.ts` | Auto planner and finite Fast/Balanced/Aggressive/Thorough policies |
| `app/pending-slot.ts` | encapsulated pending-compaction state cell |
| `app/explore-wrap.ts` | thin re-export shim isolating the explore import for headless tests |
| `app/steps/prepare.ts` | resolve config, auth, provider caps |
| `app/steps/window.ts` | pick the prefix of messages to compact |
| `app/steps/recover.ts` | recover full content for log-truncated messages |
| `app/steps/tier.ts` | choose compaction tier (none / light / full) |
| `app/steps/extract.ts` | pruning + deterministic extraction with incremental cache |
| `app/steps/synthesize.ts` | single-pass / EESV synthesis |
| `app/steps/verify.ts` | structural verification + repair |
| `app/steps/state.ts` | enrich summary with state machine + open loops |
| `app/steps/persist.ts` | apply compaction, save fingerprint, persist state |
| `app/steps/metrics.ts` | record success / failure metrics |

### Domain layer (`src/domain/`)

Pure semantics — no I/O, no async, no globals.

| File | Responsibility |
| --- | --- |
| `domain/summary-schema.ts` | canonical section kinds + heading classification |
| `domain/summary-parse.ts` | parse/render canonical H1/H2/H3 sections; merge duplicates; placement (`before`/`after`) |
| `domain/tool-semantics.ts` | fine tool operation taxonomy with broad compatibility wrapper |
| `domain/scrub.ts` | pure secret/PII redaction primitives and run-scoped scrubber |

### Algorithm layer (`src/phases/`)

| File | Responsibility |
| --- | --- |
| `phases/explore.ts` | targeted exploration with tool-call probing |
| `phases/synthesize.ts` | chunking, single-pass compact, batch summarization, assembly |
| `phases/verify.ts` | typed gap detection, collision-safe coverage, deterministic/LLM repair |

### Infrastructure layer (`src/infra/`)

All external-world interaction.

| File | Responsibility |
| --- | --- |
| `infra/fs.ts` | atomic writes, advisory locks |
| `infra/paths.ts` | canonical cache/session/backup paths |
| `infra/git.ts` | cached git-root discovery |
| `infra/clock.ts` | injectable wall clock |
| `infra/llm-client.ts` | LLM seam, custom-Codex wire cap, and ChatGPT Codex stream watchdog |
| `infra/services.ts` | per-run services container |
| `infra/session-identity.ts` | robust session-id resolution with opaque `unresolved:` fallback |
| `infra/ai-messages.ts` | boundary adapters between `LlmMessage` and pi-ai `Message` |

### Utility layer (`src/utils/`)

| File | Responsibility |
| --- | --- |
| `utils/extraction.ts` | deterministic fact extraction (files, errors, decisions) |
| `utils/pruning.ts` | redundancy removal on the message list |
| `utils/state.ts` | structured state, open loops, delta, pinned-path preservation |
| `utils/helpers.ts` | config, backups, batching, shared helpers, backup list/restore |
| `utils/cache.ts` | metrics log + extraction prefix cache |
| `utils/fingerprint.ts` | project fingerprinting (language, framework, deps) |
| `utils/damage.ts` | post-compaction regression signals + remediation hints |
| `utils/id-fingerprint.ts` | compact SHA-256 fingerprint of entry-id arrays |
| `utils/file-needles.ts` | path-suffix needles for error→file attribution |
| `utils/file-ref-detect.ts` | fabricated file-reference detection (SemVer-rejecting) |
| `utils/session-log.ts` | streaming JSONL parser for the Pi session log |
| `utils/tokens.ts` | per-(provider,model) token estimation with EMA calibration |
| `utils/type-guards.ts` | runtime validators for cross-version compatibility |
| `utils/logger.ts` | stderr-prefixed log shim |
| `utils/lru.ts` | small bounded LRU cache primitive |

### UI layer (`src/ui/`)

| File | Responsibility |
| --- | --- |
| `ui/overlays.ts` | model/mode pickers, progress, result, dashboard screens |
| `ui/dashboard-format.ts` | shared pure formatters for metrics surfaces |
| `ui/dashboard-insights.ts` | Data Confidence, quality/provider drilldowns, and canary trust views |
| `ui/metrics-report.ts` | text report + local HTML metrics dashboard |

## Design principles

The architecture intentionally biases toward safety:

- deterministic extraction before any synthesis
- adaptive exploration instead of always-on tool use
- verified file lists and error context
- deterministic repair before additional LLM calls
- hallucinated file-reference detection
- stateful tracking of open loops and cross-compaction deltas
- tool-driven compaction never compacts mid-turn
- summaries preserve exact file paths and identifiers where possible
- the recent tail stays live outside the compacted region

## Extending the system

When adding features, prefer this order:

1. extract more deterministic signal if possible
2. enrich exploration only when needed
3. keep synthesis prompts structured and bounded
4. strengthen verification before increasing model dependence
5. update tests and docs in the same change
