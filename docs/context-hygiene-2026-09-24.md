# Context hygiene and continuity: implementation and experiments

> **Scope:** Historical report, dated 2026-09-24. It records the hygiene design and offline experiments as measured then; values, file names and wording are kept unchanged.
> Current documentation for Pi Continuity (the `pi-smart-compact` package):
> [guide](./guide.md) · [configuration](./configuration.md) ·
> [evaluation](./evaluation.md) · [documentation index](./README.md).

Date: 2026-09-24. Pi/host baseline: **0.87.1**. No provider requests were made
for this work. No global extension settings, installation, commit or publication.

## Product boundary

The package now targets **session quality**, not compression alone:

```text
prevent noisy output → keep recoverable evidence → batch safe pruning
                    → preserve task continuity → compact when necessary
```

Package name and existing compaction APIs remain stable. RTK is a separate,
explicitly loaded companion, as chosen by the user. Bitmap remains experimental.
Provider-native compaction is an optional engine (`compactionEngines`) that works
on stock Pi 0.87.1+ through public extension APIs.

### Non-negotiable constraints

- Never infer that matching tool arguments imply unchanged evidence.
- Preserve user instructions, explicit instruction/skill reads, errors, mutations,
  interrupted/incomplete exchanges and unknown tool batches.
- Never resurrect content hidden by another extension's context edit.
- Keep the last four assistant turns and active checkpoint prefix raw.
- Authorize retrieval from the active branch; raw history is not automatically
  injected into future prompts. Paging/search must remain bounded and scrubbed.
- Rewrite context only at a completed, uncontested host boundary; cancellation,
  queued user input and branch changes take priority.
- No recurring model-visible status prompts or dynamic schema churn.
- Saving characters is not proof of reduced billing or improved task success.

## Implemented hygiene policy

`contextHygieneEnabled: true` enables pressure-gated trimming independently of
`autoTrigger`; the existing opt-in `background` strategy also enables it. The
same early-pressure boundary used for background preparation is reused:
`applyTokens - clamp(floor(applyTokens * 0.125), 8192, 32000)`, subject to the
existing minimum token gate. Artifact offload is separate and occurs before the
first model request, independently of pressure.

Automatic trimming requires at least **16,384 net saved characters** and waits
**eight assistant turns** after a trim, rewind or compaction. These constants
batch prefix invalidations; they are not a provider-cache optimizer. History
supplies the cooldown across restart/fork. Existing in-flight compaction and
boundary-owner guards still take precedence. Explicit `trim` bypasses batching
and cooldown, not safety protections. At most 32 results are archived per batch.

### Toolkit anchor coexistence (frozen 0.14.2-coop.0 baseline)

Risk reproduced first, then fixed conservatively: with Toolkit thinning disabled,
Smart Compact trim rewrote delivered content **before the active Toolkit anchor**
while the anchor still carried the provider cache breakpoint — invalidating the
anchor's cached prefix every trim. `planContextTrim` now treats the last on-branch
foreign anchor (a `context` tool result with truthy `details.anchor`, the same
detector shape Toolkit uses) exactly like Smart Compact's own active checkpoint:
everything up to and including it is protected, and only strictly later research
is trimmed. Rewind keeps anchor entries (never removable research) but may still
drop research between a checkpoint and an anchor; that is one deliberate,
report-driven restructure, not repeated churn.

Measured on the real extension loader/dispatcher, SessionManager and Lens guard,
both load orders: the delivered payload prefix through **both** anchors stayed
byte-identical across a trim (105,693 common bytes ≥ 105,386-byte newest-anchor
prefix; marker placement excluded from content comparison), post-anchor research
was still archived and recoverable, and a foreign edit still revoked raw
recovery. The frozen package shows no transition bridge
(`transitionBridgeMarked: false`); the candidate `pi-toolkit-coop-cache` source
shows it in both orders. Honest trade-off: research between the last two anchors
is not reclaimed until a newer anchor, checkpoint or compaction advances the
boundary. These are local byte measurements from a scripted offline run — no
live cache-read/billing claim.

### Agent-aware and manual mutation policy

`smart_context` keeps one stable schema and splits behavior by policy, not by
hiding tools: an optional `canAgentMutate(ctx)` callback (wired by the host
index) rejects agent-requested `checkpoint`/`rewind`/`trim` at execute time and
cancels an already-queued mutation at the boundary with a visible reason, while
`status`, `plan`, `search` and `read` stay available. Deterministic automatic
hygiene is not agent-requested and still runs when enabled. The development
behavior profiles reuse existing flags only — Manual `{autoTrigger: false,
hygiene: false, agent: disabled}`, Agent `{false, false, enabled}`, Local-only
`{false, true, disabled}`, Automatic `{true, true, disabled}` — with no new
config field, threshold or cooldown.

For TUI/command entry points, `registerSmartContextTool` returns a
`SmartContextController` (also published at the versioned
`Symbol.for("pi-smart-compact.smart-context.controller.v1")` global handle).
`requestManualTrim(ctx)` queues a user-requested trim in the same single pending
slot the agent tool uses — no second engine, no metadata store, no fabricated
tool call, no forced provider turn. Stock Pi 0.87.1 exposes only a
`ReadonlySessionManager` to extensions and accepts native boundary entries only
through `turn_end`/`agent_before_settle` results, so the manual trim applies
with the same planner as a native `BoundaryResult` at the next completed turn
boundary; the queued result says explicitly that the first next provider
request is **not yet trimmed** and makes no bytes-saved claim. Pause, session,
uncontested-boundary and pivot-cancellation guards all revalidate at the
boundary; the agent-mutation policy does not gate user requests. Explicit
states: `queued`, `no-eligible`, `paused`, `busy`, `unavailable`, each with an
honest notice. An explicit agent-requested trim that finds nothing eligible
reports "not applied" at the boundary instead of silently doing nothing.

`smart_context plan` reports count, saved characters and batch/cooldown state
without queuing mutations. It does not return source bodies. `status/search/read`
remain the evidence retrieval interface. Recovery tool results are not trimmed
into another chain of references.

The same instruction-source guard now covers trim, rewind, artifact offload,
visual selection and pre-compaction pruning, including supported path aliases
and Windows separators. Pre-compaction dedup requires exact content as well as
normalized tool/arguments; a changed observation resets dedup. `A → B → A` stays
three observations. Unknown operations/errors break the epoch. Media is not
silently replaced by a text-only truncation. A status-looking user-text prefix
has no trusted provenance and cannot authorize deletion.

### Deliberately not implemented

- Clearing old errors merely because they are old: unresolved cause evidence can
  be vital to continuity. Explicit report-based rewind retains unsafe batches.
- Dedup by path/arguments alone, as some pruning extensions do: external writers,
  changing search results and concurrent sessions invalidate that assumption.
- Per-turn pruning at low pressure: prefix rewrites may cost more cache reuse than
  the short-term text saving is worth.
- An embedding index, another agent tool, automatic artifact expiry or a second
  transcript store. Existing native session metadata and artifact files suffice.

## RTK pilot

Built upstream **RTK 0.50.0**, commit
[`1d87b8e719ce0a50c223cd93ca64dd16921f9aec`](https://github.com/rtk-ai/rtk/tree/1d87b8e719ce0a50c223cd93ca64dd16921f9aec),
with `cargo build --release --locked` in a temporary source checkout. Pilot
commands used a synthetic temporary Git/Rust/TypeScript project and isolated
HOME/config/data directories. No hooks were installed. The upstream CLI,
not a mock filter, produced the following results:

| Candidate | Native chars | RTK chars | Change | Native/RTK exit | Required evidence | Companion decision |
| --- | ---: | ---: | --- | --- | --- | --- |
| `git status` | 274 | 25 | 90.9% smaller | 0 / 0 | File path retained | Rewrite |
| `git diff` | 2696 | 1732 | 35.8% smaller | 0 / 0 | Critical added line missing; no recall hint | **Passthrough** |
| `cargo test` | 2164 | 1779 | 17.8% smaller | 101 / 101 | Failure marker retained; `rtk recall --full` verified | Rewrite |
| `tsc --noEmit --pretty false` | 1711 | 1783 | **4.2% larger** | 1 / 1 | Diagnostic code retained; recall verified | **Passthrough** |
| `bun test` | 6037 | 399 | 93.4% smaller | 1 / 1 | Failure marker retained; `rtk recall --full` verified | Rewrite |
| `vitest run` (vitest 5.0.2) | 6120 | 197 | 96.8% smaller | 1 / 1 | Failure text missing; no recall hint | **Passthrough** |

These are **characters from one synthetic run**, not provider tokens, invoices,
or a quality guarantee across real repositories. Compiler timings/paths can vary
counts. Native and RTK cargo each executed the failure test once; the fixture's
execution counter was exactly two. The shared stack fixture (one
runner-agnostic failing test) likewise ran exactly once per arm under each
runner: two `bun` and two `vitest` appends. The companion never retries an RTK-executed
command as the original.

The failed diff and vitest experiments are intentionally retained in the pilot
report. A smaller output that silently drops a critical line is not a successful
result. The vitest exclusion is version-driven, not cosmetic: on the
siblings' pinned vitest **4.1.11**, `rtk vitest` kept the assertion text, stack
trace and advertised `rtk recall <hash>`; on current vitest **5.0.2** the same
rewrite prints `[RTK:PASSTHROUGH] vitest parser: All parsing tiers failed`,
drops the failure text without a recall hint, and leaves evidence only in a
side `.vitest/json/output.json` file the context never sees. Because the
consumer's installed vitest major decides fidelity and a bare command string
cannot carry that gate, `vitest run` stays out until upstream parses vitest 5
output. `npm test` and `node --test` are not rewritten by rtk 0.50.0 at all
(rewrite probe exits 1). Accordingly, the companion accepts **bare
`git status`, `cargo test` and `bun test`**, with whitespace variations. Flags,
diffs, typecheck, arbitrary commands, substitutions, redirections and
pipelines pass unchanged. This is an eligibility policy, not a copied rewrite
registry: all rewrite rules remain in `rtk rewrite`.
Minimum companion version is 0.50 for the tested recall behavior, even though the
upstream rewrite protocol itself dates to 0.23.

RTK's recall database is separate from Smart Compact's artifact store. In the
inspected version its defaults are 200 entries, 10 MiB per entry and 30-day
retention. Failure output below 500 bytes need not produce a recall record, and
successful outputs are not universally archived. **Smart Compact's scrubbing
settings do not govern RTK's raw-output store.** Review RTK privacy/retention
before sensitive use; do not advertise all its filtered output as durable evidence.

The companion adds no agent tool/schema or system prompt. Load it before
permission/command-policy hooks; later handlers must assess the rewritten input.
Do not stack it with the upstream RTK hook. Missing/unsupported binary, unrecognized
version, rewrite error, timeout, abort and session change retain the original input.
`RTK_DISABLED=1` disables it. `command git status` is a per-call passthrough.

Reproduce (requires local Git, Rust/Cargo, TypeScript, Bun, and network for a
fixture-local `bun add -d vitest` under an isolated HOME):

```bash
bun run scripts/rtk-pilot.ts /absolute/path/to/rtk
bun test test/rtk.test.ts
```

Expand eligibility only after fixtures establish exit semantics, important
failure/file facts, no duplicate execution, and an explicit recovery path when
needed. Concrete future candidates: `vitest run` once upstream rtk parses
vitest 5 JSON output (proven working shape on vitest 4.1.11), and `node --test`
or `npm test` if rtk grows rules for them—not arbitrary shell text or
source-code diffs by default.

## Adaptive bitmap experiment

Renderer remains optional resvg with the bundled font. Width now follows the
longest rendered line, rounded to 32 pixels and bounded to 256–1280 px. Font stays
14 px, row height 20 px; source indentation, identifiers and escaping remain.
No OCR, smaller glyphs or lossy semantic rewriting was introduced.

For new archives, the economic gate currently recognizes only direct Anthropic
`claude-sonnet-5`: documented 28×28 patches, maximum 2576px long edge and 4784
visual tokens per image. Inputs requiring provider downscaling are rejected by
this gate rather than assuming small text remains readable. Unknown models/APIs
stay text-only. A 256-token reading-guide allowance and a **25% estimated margin**
are required against the same source text. Conservative old request-headroom
allowances remain separate and still bound final yield.

Offline rerun of the three earlier pilot scenarios:

| Scenario | Fixed-width planning allowance | Adaptive allowance | Estimated equivalent text | Model-rule image + guide | New archive admitted? |
| --- | ---: | ---: | ---: | ---: | --- |
| Turkish/code | 2296 | 1327 | 335 | 712 | No |
| Logs/constraints | 2656 | 2296 | 418 | 1114 | No |
| Two-page evidence | 6992 | 3590 | 1228 | 1598 | No |

Cropping reduces the conservative image allowance by 13.6–48.7%, **but none of
these fixtures beats text**. Skipping them is the intended outcome, not a failed
optimization. This run made zero provider calls and does not measure new reading
accuracy. The earlier [nine-call Sonnet 5 pilot](./visual-pilot-2026-09-24.md) used
fixed-width images; its billing/accuracy observations cannot be relabeled as
measurements of adaptive rendering.

Existing valid version-1 archives remain readable/replayable under the original
branch/model/privacy/headroom checks. The economic gate applies when creating new
archives; it does not rewrite old session records. Normal compaction summary text
remains complete and verified, so supplementary pixels still add cost versus
summary-only. When evidence is not currently needed, an artifact reference is
cheaper than either proactively injected representation.

```bash
bun run scripts/visual-pilot.ts --model=anthropic/claude-sonnet-5 --output=/tmp/visual-plan.json
bun test test/visual-archive.test.ts test/visual-pilot.test.ts
```

Without `--live` this is offline. The representation pilot intentionally renders
all alternatives even if the production economic gate declines them. No new live
quota was authorized or used.

## Provider-native compaction: measured host blockers

> Status: worked around without Pi changes. Smart Compact sends its own
> compaction request through one nested Pi request, stores the state in the
> compaction entry's details and replays it from `before_provider_request`
> (see README "Compaction engines"). The table below still describes what the
> stock adapters drop by themselves.

Follow-up: [provider selection, OAuth/Codex V2 routes and implementation options](./hindsight-native-compaction-research-2026-09-24.md).
The blockers below concern the current normal Pi adapters, not impossibility of
an explicit endpoint plus a separately validated native replay integration.

`native-hook` in existing settings means **Pi's compaction lifecycle**, not a
provider's native compaction API. Do not confuse them.

Official APIs offer useful alternatives:

- Anthropic on-demand: `compaction: {type: "summarize"}` with
  `compact-2026-09-04`; receives a whole signed compaction block, a `compaction`
  stop reason, and `usage.iterations`. Replay the block exactly, first in messages,
  with the beta header. Cannot combine with `context_management` in one request.
- OpenAI standalone `/responses/compact`: returned `output` is the canonical
  next window, including opaque encrypted compaction items and retained items.
  Do not treat only the encrypted item as the entire returned history.
- OpenAI in-request compaction: output compaction items must survive stateless
  chaining. Opaque content cannot be decoded or rewritten by the extension.

The offline test feeds documented wire fixtures through **actual Pi adapters**,
not mock conversion functions:

| Boundary on Pi 0.87.1 | Observed result |
| --- | --- |
| Anthropic request payload | Payload hook can add the compaction request |
| Anthropic response | Signed block omitted; `Unhandled stop reason: compaction` |
| Anthropic usage | Iteration usage is not counted (zero displayed is not zero cost) |
| Session JSON round trip | Opaque fixture data can physically survive storage |
| Anthropic replay | Stored compaction block/signature disappears from outgoing messages |
| OpenAI Responses stream | Compaction output item omitted despite reported token usage |
| OpenAI Responses replay | Injected opaque item not sent back |

A request-only hook is therefore insufficient. Shipping it would appear to work
until continuity silently breaks. No native runtime switch or private SDK patch
was added. OAuth access is **not established** by API-key documentation, and no
paid/auth probe was attempted.

```bash
bun test test/native-compaction-compat.test.ts
```

These tests intentionally pin current blockers. Revisit them when upgrading the
host rather than treating missing support as a permanent invariant. Minimum
upstream acceptance requirements:

1. Typed signed/opaque block support and exact streaming/parser round trip.
2. Correct stop reasons and iteration/in-request usage accounting.
3. Session reload, branch scope and canonical retained-tail handling.
4. Signature/content preservation without generic text scrubbing or normalization.
5. Model/provider change behavior that cannot replay foreign opaque state.
6. Verified support for the actual API/OAuth/platform route in use.
7. Cancellation/stale-prefix checks and correlated host apply, not mid-tool mutation.
8. Separate explicit continuity constraints and measurable regression checks:
   native summaries are not automatically equivalent to EESV verification.

## Remediation backlog (approved after the combined review)

P1 work precedes daily-use rollout; global configuration and installed packages
remain untouched while source repositories are tested.

- [x] **P1 — Apply-time validation:** invalidate staged candidates for new compact
  instructions, reader/model changes and navigation; recheck current headroom and
  appended-tail accounting for both foreground and background candidates.
- [x] **P1 — Honest delivery coverage:** keep file/symbol reads inline until a
  delivery-aware pi-lens contract can attest only the text actually shown.
  Other eligible read-only output may still use early artifact offload.
- [x] **P1 — Toolkit ownership:** add an explicit switch for Toolkit thinning;
  retain anchor/pivot/recall, footer and cache integration. Smart Compact alone
  owns pruning when that switch is off. Update the Toolkit skill accordingly.
- [x] **P1 — Pivot coordination:** pause automatic hygiene/preparation/application
  while a Toolkit pivot is queued/running; invalidate old candidates on navigation
  and release the pause on cancellation/failure. Use native events plus a small
  versioned Pi event notification, not private imports or a new coordinator.
- [x] **P1 verification:** exercise native event/projection boundaries, both
  extension orders, protected instructions/errors/references, pivot cancellation,
  changed-model budgets and unchanged delivery coverage; no paid model calls.
- [x] **P2 — Discovery:** retain source aliases when identical artifact bytes are
  deduplicated; reuse `extractToolPath` for native-history source labels.
- [x] **P2 — Bitmap economics:** compare using the reader's token calibration,
  not the summarizer's calibration.
- [x] **Offline AgentSession pilot:** real prompt/tool/boundary/compaction flow,
  then disposal and reopening from JSONL with a new ModelRuntime. Three scenarios
  passed; see [the pilot report](./session-pilot-2026-09-24.md).
- [ ] **Live canary:** separately approve a model/call budget to measure task
  quality, autonomous retrieval choices, repeated reads and provider cache costs.
- [ ] **Toolkit PR:** prepare an isolated upstream change for thinning ownership,
  pivot notifications, tests and skill/docs; keep unrelated `probe/` and existing
  dependency-maintenance branch work out of the PR.
- [x] **Hindsight/native research:** inspect official and community Pi integrations,
  retain/recall/reflect semantics, Anthropic on-demand/threshold, OpenAI standalone/
  server-side, and Codex OAuth V2. Existing Pi adapter blockers reconfirmed offline.
  Findings and design options: [research report](./hindsight-native-compaction-research-2026-09-24.md).
- [x] **Optional Hindsight memory:** owned by Smart Compact's narrow adapter
  (`memoryBackend: "hindsight"`). Confirmed saves and strict project-scoped recall
  only; no auto-ingestion or reflect. Redaction, receipts, idempotent operation ids
  and honest accepted/completed/unknown states. One live canary against the user's
  server passed. See [hindsight-memory.md](./hindsight-memory.md).
- [x] **Provider-native selection:** `native` engine in the ordered
  `compactionEngines` list, on stock Pi through one nested request and
  `before_provider_request` replay, on the current route only (Anthropic Messages API key/Claude subscription, OpenAI Codex
  subscription, OpenAI Responses API key). Route capability checks, clean-turn
  cuts, size rejection, explicit skip/failure reporting, no silent fallback.
  Live on stock Pi: Codex subscription validated (compaction and replay; recall
  lossy, replay byte-exact after reload, re-compaction offline only). Claude
  subscription experimental: real-session compactions were rejected as "extra
  usage" (cause not isolated). API-key routes offline only. Default stays `["eesv"]`; native is opt-in.
  Server-triggered compaction is not implemented.
- [x] **Lazy tools:** tool exposure decided only at session start/compaction;
  a new session with Toolkit and no project memory exposes only `smart_compact`
  (about 267 tokens of tool text, from about 1.56k).
- [x] **Visible errors, quiet footer, headless:** one-line deduplicated notices
  with an issue history in `/smart-compact metrics`; nothing in the footer while
  healthy; stderr and non-interactive `/smart-compact` without a UI.
- [x] **Settings TUI:** task-grouped categories, named values, per-row reset,
  inactive dependent rows with reasons. Keys unchanged.

Anchor remains a retrospective milestone, not permission to erase preceding
context. Pi's session tree stays canonical; Toolkit and Smart Compact must not
silently restore each other's redactions. Native file-read coverage is a separate
pi-lens responsibility and is not solved by changing extension load order.

### P1 verification record

The local source changes are implemented in this repo and the sibling
`pi-toolkit` checkout; neither installed package nor global settings were changed.
Toolkit's switch is `piToolkit.context.thinningEnabled: false`, with project-over-
global precedence on session start/reload. Missing settings preserve standalone
behavior; invalid/unreadable settings do not enable destructive thinning.

Validation on Pi 0.87.1:

- Smart Compact `release:check`: **1196 tests**, typechecks, adversarial gate,
  benchmarks, packed Node/Bun audit and isolated current-Pi compatibility passed.
- Toolkit `check`: **108 tests**, source typecheck and lint passed.
- New negative regressions first reproduced stale model/instruction/growth reuse,
  false file-read delivery, unconfigurable thinning and missing pivot completion.
- `scripts/context-compat-pilot.ts` used the actual Pi loader/dispatcher,
  SessionManager JSONL save/reload and installed pi-lens 4.2.1 read guard with
  both Smart→Lens→Toolkit and Toolkit→Lens→Smart ordering. It verified preserved
  instructions/errors/artifact refs, accurate initial file delivery, real-boundary
  trimming and recovery, anchor cache, queued-mutation blocking, navigation
  cancellation/failure release, and manual navigation superseding a queued pivot.

Anchor-prefix re-verification for this change (2026-09-25), frozen cooperation
package `ersintarhan-pi-toolkit-0.14.2-coop.0.tgz`
(SHA256 `cbe3ca046c750000ab2419745a467ab849016e9c08e4c2ab4bf6dcc818cef836`,
extracted read-only) plus the candidate `pi-toolkit-coop-cache` source:

- The risk was first reproduced red on the frozen package in both orders: trim
  targeted pre-anchor content while the anchor-cache marker was on the anchor.
  After the fix, the same loop is green: only post-anchor research is edited.
- Byte measurement on post-hook provider payloads (marker placement excluded):
  common prefix 105,693/105,719 bytes ≥ newest-anchor prefix 105,386/105,410
  bytes across a trim, both orders; two-anchor scenario; recovery and foreign
  revocation re-checked.
- `scripts/session-pilot.ts` gained paired continuation oracles (rewind vs
  control arm, two independent fact checks each) plus delivered-size and
  common-prefix measurements: 9,684 chars delivered reduction after rewind,
  divergence only after the 20,401-byte checkpoint-stable prefix, zero network
  attempts, zero paid requests. Deterministic hygiene made no model calls.
- `scripts/session-pilot.ts` also drives the real SDK idle-command path: an
  extension command queues the manual trim through the published controller
  with zero model/summary calls, the first following request is verifiably not
  yet trimmed, the next completed boundary applies it, and the archived
  evidence stays retrievable. Passed against both the frozen package and the
  candidate source.
- Scoped suites for the touched modules: 175 tests across 7 files passed, plus
  46 in `test/context-control.test.ts` after red-green on the anchor boundary
  and the manual controller.

Reproduce from the Smart Compact checkout (explicit local paths, no installation):

```bash
NODE_PATH="$PWD/node_modules" bun scripts/context-compat-pilot.ts \
  /absolute/path/to/pi-toolkit /absolute/path/to/pi-lens
```

This is a real extension-boundary/storage test, **not** a complete AgentSession
model loop or live task-quality measurement. The later
[full offline AgentSession pilot](./session-pilot-2026-09-24.md) covers the model-loop
integration seam; live quality measurement and the Toolkit PR remain open.
The optional confirmed Hindsight integration is now implemented and its separate
live canary passed; see [hindsight-memory.md](./hindsight-memory.md).

### P2 verification record

Byte deduplication remains unchanged on disk. Branch-local source occurrences
now retain their own authorization; distinct tool/source labels share the existing
content-hash read alias without erasing each other. Repeated identical provenance
collapses into one catalog row; source pagination and scan limits remain in effect.
Native-history discovery reuses `extractToolPath` for all eight supported path keys.
Bitmap admission now binds its equivalent-text estimate to the actual reader's
provider/model calibration before and after rendering; summarizer accounting is
unchanged. There is no new schema, dependency, provider call or session migration.

Regression tests first reproduced overwritten source labels, five missed path
aliases and wrong-calibration bitmap admission. Tests also cover direct entry-ID
retrieval, per-source revocation, compaction/fork ancestry, source-label privacy,
35-alias pagination and positive/negative reader-calibration cases. The actual Pi
compatibility script now checks shared-source discovery in both extension orders.

Validation: **1210 tests passed** across 89 files, all `release:check` gates passed
(including 356 adversarial checks, packed Node/Bun audit and isolated current-Pi
compatibility). The 125-test focused suite and both actual Pi extension orders
passed; seven changed TypeScript files had clean active LSP diagnostics. A
pre-existing answer-leak assertion was also corrected to inspect delivered text,
not numeric timestamps that can coincidentally contain expected answer digits.

## Quality gate for the combined pilot

Next integrated evaluation should compare baseline vs hygiene/artifacts and only
then optionally RTK or native compaction. Measure:

- Required constraints, unresolved failures, decisions and next-step fidelity.
- Task completion, repeated investigation and unnecessary source rereads.
- Provider input/output/cache read/cache write, not just local character estimates.
- Full-output retrieval frequency, bytes loaded, unavailable-reference rate.
- Compaction count/latency and unused speculative preparation.
- Restart/fork continuity, simultaneous tool batches and competing context owners.

Success requires preserved quality and lower total task overhead. This work is
local implementation/contract validation, **not yet a production-session canary**.

### Offline total-cost and cache-prefix evidence (2026-09-25, item 14)

The four-arm evaluator (`scripts/task-eval.ts` + `scripts/task-eval-case.ts`)
now measures, per arm, every attempted provider request through the scripted
transport — main turns, foreground staging, background preparation (used,
discarded or abandoned) and host cache-warmer replays — plus serialized
common-prefix bytes between consecutive main requests. All numbers are
labelled synthetic usage (chars/4 inputs, char-derived outputs): scheduling
and accounting evidence, never billing or savings claims. Artifacts:
`task-eval-reports/item14-cost-evidence-2026-09-25/` (run-A baseline,
run-B preparation+idle-warming overlay, run-C streaming-warming, run-D
compaction-in-flight trace; commands in `COMMANDS.txt`, per-request ledgers in
each `task-eval-report.json`, raw causal traces in `compaction-trace-*.json`).

Controlled fixtures, fresh scratch HOME per arm, network denied at the fetch
seam (zero attempts, asserted): Toolkit cooperation with
`piToolkit.context.thinningEnabled: false` (Smart Compact owns pruning);
optional `--background-prep` (speculative preparation on; staging arms keep a
reachable apply gate so one prepared candidate can be consumed by the settled
trigger, non-staging arms keep it unreachable so preparation is provably
unused); optional `--cache-warming=idle|streaming` (host prompt-cache warmer,
12 s TTL fixture and synthetic per-million-token rates sized so the warmer's
own expected-savings decision fires; idle mode adds bounded 2.7 s waits,
streaming mode adds one real ~3 s bash tool run per arm). All hygiene/compaction
constants were held at production values (16,384-char trim floor, 8-turn
cooldown, 5-minute staged TTL, 10-minute settled cooldown); nothing here
warrants a tuning change.

Totals (requests / synthetic input tokens; repeats=2, 32+14 history prompts,
identical scripted task): baseline run-A per arm — no-compaction 72 /
7,116,429; recoverable-hygiene 72 / 5,370,172; eesv 78 / 5,083,590 (2 staging
calls, 99,556 in); hybrid 78 / 4,020,738 (2 staging calls, 99,428 in).
Overlay run-B adds per arm: exactly one extra summary-class call plus 2 idle
warm replays (bodies byte-identical to the warmed request, `max_tokens=1`,
host `cache_warm` usage entries 2/2, e.g. 65,182 synthetic input tokens for
no-compaction). Streaming run-C fired exactly 1 warm per arm during the long
tool run (32,355/32,356 in). Request equation per arm:
`total = main + summary(foreground staging + on-demand/background work) + warm`,
with receipts attributing the summary class run-by-run.

Run-D's direct compaction-in-flight trace (a probe extension registered before
Smart Compact's `session_before_compact` handler; raw traces preserved as
`compaction-trace-*.json`) corrects the first reading of those overlay
numbers:
- In staging arms the mid-history compaction is **fresh on-demand hook work
  inside `session_before_compact`** (eesv trace seq 12→13: the summary call
  arrives with a compaction request in flight, and the applying
  `session_compact` entry carries the same runId, `fromExtension=true`) —
  not a reused background candidate. Background preparation there never
  completed a provider call: it is cancelled in flight by hygiene-trim
  boundary edits at zero cost and is correctly unreceipted, while the five
  preceding settled-trigger requests end `session_compact_failed` with no
  candidate. The resulting `runType:"auto"` metrics entry without a
  `preparation` label is therefore **correct**; no production change.
- Charged unused preparation is fully receipted under the **supported
  shutdown lifecycle**: driving `session.reload()` (which emits
  `session_shutdown`, reason "reload") after the reopened non-staging arm
  drained exactly one discard receipt — `{status "discarded", preparation
  "background", reason "session", calls 1, input 106,268}` — matching the
  arm's single background-origin summary call (trace: no compaction request
  in flight). A bare `AgentSession.dispose()` skips the shutdown event; that
  is a host-lifecycle limit, not grounds for a new journal.
- Fixture note: the host cache-warmer stays inactive ("cache lifetime
  unavailable") for provider registrations without `promptCache` metadata;
  fixture models must declare it to exercise warming.

Limitations: synthetic token estimates, not provider counts; scripted model
decisions, no quality claims; warm economics are decision-coverage fixtures,
not prices; no live cache-hit or billing measurement (the live canary backlog
item remains open).

## Sources inspected

- [RTK Pi hook and rewrite contract](https://github.com/rtk-ai/rtk/tree/1d87b8e719ce0a50c223cd93ca64dd16921f9aec/hooks/pi)
- [RTK recall store](https://github.com/rtk-ai/rtk/blob/1d87b8e719ce0a50c223cd93ca64dd16921f9aec/src/core/retriever.rs)
- [DCP duplicate strategy](https://github.com/Tarquinen/opencode-dynamic-context-pruning/blob/master/lib/strategies/deduplication.ts)
- [Anthropic context editing and cache behavior](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)
- [Anthropic image token rules](https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size)
- [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)
- Installed Pi 0.87.1 declarations, native projection, Anthropic and Responses adapters.
