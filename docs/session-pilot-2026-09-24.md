# Full AgentSession offline pilot — 2026-09-24

> **Scope:** Historical pilot report, dated 2026-09-24. Scripted model transport; it does not measure autonomous task quality or provider billing. Results are kept as recorded.
> Current documentation for Pi Continuity (the `pi-smart-compact` package):
> [guide](./guide.md) · [configuration](./configuration.md) ·
> [evaluation](./evaluation.md) · [documentation index](./README.md).

## What ran

`scripts/session-pilot.ts` creates a real Pi **0.87.1 AgentSession**, loads the
local updated Toolkit and Smart Compact factories, and drives `session.prompt()`.
Pi—not the pilot—executes built-in `read`, `grep`, `bash`, `write`, extension tools,
boundary changes, compaction and JSONL persistence. No synthetic session entries
are inserted, and no lifecycle handlers are called directly.

Only the model boundary is scripted: a custom offline provider emits assistant
text/tool calls. EESV's external LLM transport delegates to the same registered
ModelRuntime; extraction, planning, synthesis processing, verification, staging,
correlated apply and metrics remain real. The summary fixture contains facts that
are also checked against the summarizer's actual input. This demonstrates protocol
and lifecycle continuity, **not autonomous model reasoning or summary quality**.

Isolation:

- Temporary project, HOME, agent directory, credentials/catalog paths and sessions.
- No installed extensions or global settings changed; no dependency installation.
- Explicit Toolkit source path; unrelated resources and context-file discovery off.
- `fetch` blocked; catalog network refresh disabled; zero attempted fetches observed.
- Shell commands only emit a synthetic error and exit with code 7.
- Temporary data removed, environment/model transport restored on completion.
- Each prompt/compaction bounded to 30 seconds.

Configuration deliberately separates the mechanisms: Toolkit thinning off; Smart
hygiene/artifacts on; automatic summarization and Pi automatic compaction off.
The early-pressure percentage is zero to exercise hygiene on modest fixtures,
while the existing minimum savings, recent-turn protection and cooldown remain.
Compaction is deliberately requested after history grows; no production threshold
or planner code was changed to make the pilot pass. Bitmap/RTK/Hindsight are not
part of this pilot. Lens coverage remains covered by the separate two-order
`context-compat-pilot.ts`, not a claim about loading full Lens here.

## Scenarios and observed results

### 1. Automatic hygiene → retrieval

A real file read delivers the required middle line. A real large `grep` result is
stored as an artifact before the next scripted provider request; its hidden middle
is absent from the preview. AGENTS.md and an unresolved bash error are then read,
and Toolkit records an anchor without thinning them.

At the completed native boundary, Smart Compact automatically archives the old
file output. The next provider request contains its recovery marker, not the full
body. `smart_context search` finds the middle fact, and `read` retrieves the exact
line. The artifact's independently hidden middle is also searched and read.

| Conversation representation | Characters |
| --- | ---: |
| Before automatic trim | 64,233 |
| Next request after trim and anchor | 11,938 |
| Reduction at this boundary | 52,295 (about 81.4%) |

These counts serialize conversation roles/content and include the changing tool
exchange. They are **not tokenizer counts, complete provider-wire sizes, total-task
savings or billed-cache measurements**. The native read tool's own limits still
apply; the pilot does not claim recovery of bytes truncated before offload.

Required instructions, unresolved failure and artifact reference remain present.
Every outgoing scripted-model context is checked for complete, non-duplicated
tool-call/result pairs.

### 2. Checkpoint → research → side effect/error → rewind

The model requests a checkpoint, confirms its committed status, reads research,
then requests a file write and a failing bash command in the same assistant batch.
It requests context-only rewind with an explicit research report.

After the real boundary:

- The research tool result is removed from active model context.
- Its finding survives in the handoff and can be recovered through search/read.
- The unresolved failure remains; the mixed side-effecting batch is preserved.
- `side-effect.txt` still contains the exact written bytes—no filesystem rollback.

### 3. Staging → native apply → new session → retrieval

The first compaction attempt deliberately occurred at **52,559 / 200,000 synthetic
usage tokens (26.28%)**, below the fast mode's 30% target. It correctly returned
`window not viable` without a summary call. This initially broke the pilot's
assumption, not the product: it is now an explicit negative assertion.

After additional scripted user observations, the reported scheduling usage reached
**100,999 / 200,000 (50.50%)**. `smart_compact` ran the real EESV pipeline and staged
its summary. `session.compact()` applied the same run ID through the native host:

- Exactly one scripted summarizer request overall.
- No second summary request during staged apply.
- Success metrics appeared only after correlated application.
- A disposed AgentSession was replaced with a new AgentSession and ModelRuntime,
  opening the existing session file rather than reusing its in-memory transcript.
- The next model input retained the constraint and unresolved failure.
- The artifact could still be found and its requested line retrieved.
- An artifact-only sentinel that was never requested did not reappear in the
  summarizer input: compaction did not undo offload by expanding the full body.

Reopen is within the same test process, with new host/model-runtime objects; this
is **not an OS-process restart or crash-recovery test**. Model token usage is a
synthetic character-based scheduling input, not provider evidence.

## Validation

- **57 scripted reader requests + 1 scripted summarizer request**.
- **21 real tool executions**, 37 settled agent runs; zero attempted network fetches
  and zero paid/provider requests.
- `bun run release:check`: **1210 tests passed**, 356 adversarial checks, typechecks,
  benchmarks, packed Node/Bun audit and isolated Pi compatibility passed.
- Active LSP check on the pilot script: no diagnostics; both repository diffs clean.
- No production code or Toolkit source changed during this pilot. The only initial
  failure was the pilot expecting compaction below the existing target, corrected
  by retaining the refusal test and adding history—not relaxing product policy.

## Limits and next steps

This pilot validates the complete offline execution/storage path that the earlier
handler tests did not cover. No new production-source defect was found in these
three scenarios. It does not establish:

- Whether a real agent chooses the right checkpoint, pruning or retrieval action.
- Whether a real summarizer preserves all task-critical meaning.
- Real provider token/cache cost, latency, quota behavior or interruptions.
- Full runtime session switching/pivot scheduling under concurrent user input.
- Cross-process recovery after a crash or native opaque-compaction support.

The next quality experiment is a separately approved, capped live-model canary.
Toolkit PR and optional Hindsight integration research remain in the backlog.

## Reproduce

Requires Bun and local ripgrep (`rg`), plus the updated Toolkit source checkout.
It is intentionally not in the default test command because Toolkit is not a
Smart Compact runtime dependency.

```bash
bun scripts/session-pilot.ts /absolute/path/to/pi-toolkit
```

The script prints PASS markers and a JSON report with phase-local character sizes,
request/tool counts and network-attempt counts. The latest run's recorded report
is [session-pilot-2026-09-24.json](./session-pilot-2026-09-24.json).

## Isolated candidate follow-up — 2026-09-25

The extension-only candidate was installed into a separate HOME and npm prefix,
not over the daily Pi installation. The actual installed versions are Pi
**0.87.1**, Smart Compact **9.8.0-canary.0**, Toolkit **0.14.2-coop.0**, and the
physical TypeBox peer **1.3.11**. No Pi source change or upstream PR is required.

The isolated launcher is
`$HOME/.local/share/pi-smart-compact/canary-20260925.4w2DyI/launch`.
It uses a separate project and HOME, clears inherited credentials from the
environment, and disables catalog refresh. Automatic compaction is **off**.
Its optional background settings are prepare **60%**, apply **70%**; the selected
memory backend is local, project-scoped Mnemopi. Toolkit thinning is off and the
three existing Toolkit extension exclusions are retained.

Observed checks:

- The complete `bun run release:check` passed: **1348 tests**, **355 adversarial
  gate checks**, four typechecks, hot-path benchmarks, packaged Node/Bun audit,
  and the isolated compatibility run against latest Pi **0.87.1**.
- Real Node/Pi TUI replays exercised consent, decline, save, recall, resolve,
  session reopening, and source/packed-worker loading. Missing engine or TypeBox
  failed before sending a memory request or creating a memory store.
- After the real npm installation, the stock Pi CLI loaded both filtered
  packages, returned the expected empty Mnemopi recall, and refused a headless
  save without interactive confirmation. Outbound networking was sandbox-denied
  for those scripted-provider checks; they did not make paid model calls.
- SHA-256 checks before/after installation matched for the daily Pi settings,
  npm manifest, and npm lockfile. No daily settings or package replacement.

Frozen tarballs in the isolated root's `artifacts/` directory:

| Artifact | SHA-256 |
| --- | --- |
| `pi-smart-compact-9.8.0-canary.0.tgz` | `a36d4efbaf59be2b500826b17c7b0ad705f15124980578b8d5d89e0300bd2f6d` |
| `ersintarhan-pi-toolkit-0.14.2-coop.0.tgz` | `cbe3ca046c750000ab2419745a467ab849016e9c08e4c2ab4bf6dcc818cef836` |

The root also holds `baseline.json`, `install.log`, `release-check.log`, and the
archived Node/Pi memory receipts in `mnemopi-runtime-evidence.tar.gz`.
These are local candidates, **not published releases** or evidence for a
20-run production promotion. These offline checks do not establish live
summarizer quality, provider billing limits, or live preparation/application.

### Packaged background lifecycle — scripted transport

A separate offline run loaded the frozen Smart Compact package into a real
stock Pi AgentSession, with the staged Toolkit `claude-oauth` and
`context-management` extensions. Only the Codex SSE responses were scripted.
The fixture explicitly used a **21,000-token synthetic window**, prepare **40%**,
and apply **42%**; these are not production model capacity or the launcher's
disabled-by-default 60%/70% settings.

- At 36.1%, no preparation or application.
- At 40.8%, exactly one summary was prepared and staged, with no premature apply.
- At the native idle, empty-queue threshold boundary, the prepared run was
  applied through the real EESV single-pass path: no second summarizer request
  and no host fallback summarizer.
- A new AgentSession reopened the persisted session. Its next request retained
  the summary, constraint, unresolved failure, and verbatim tail sentinel.

The six requests and every reported usage/cache number in this rehearsal came
from the local scripted transport, **not a live provider or invoice**. It proves
lifecycle mechanics, not semantic summary quality or real token savings.
Canonical evidence is `background-canary-official-report.json` and
`ledger-official-6.json` in the isolated root. The throwaway fixture and duplicate
extractions were removed after verification; the immutable tarballs are retained.

### Live canary explicitly deferred

The user chose **no live run** after the transport preflight found that stock
Pi's ChatGPT/Codex route does not send a provider-enforced output-token limit.
Smart Compact's ChatGPT output watchdog can cancel a stream but cannot guarantee
that provider output (including reasoning tokens) stays below a hard ceiling.
The separate proposed **8-request / 120,000-input / 4,000-output** allowance was
therefore **not consumed**: **zero new live provider requests**. The earlier
native-canary ledger remains **23/24**, not reset or reused.

No authentication was copied into the isolated installation, and automatic
compaction remains off. A future live run needs a new explicit budget decision;
the offline evidence above must not be presented as live quality evidence.

## Polish follow-up — 9.8.0-canary.1, 2026-09-25

The `.0` artifacts and live deferral above are unchanged. This follow-up used
temporary stores and scripted/loopback transports only; no real provider or
Hindsight request and no daily configuration/authentication change.

Observed runtime checks:

- Stock Pi 0.87.1 executed six registered memory-tool calls. A foreign-project
  Hindsight ref caused zero HTTP requests and no confirmation; an unknown retain
  blocked deletion. After completion was observed, the actual recalled ref
  deleted exactly one owned synthetic document, then recall returned no facts.
  The fetch guard observed zero forbidden requests. Separate regressions cover
  target-tail swapping, missing targets, unrelated remote documents and
  same-content Mnemopi facts in two data roots.
- The background-discard process-exit smoke used the exported metrics path:
  `~/.pi/agent/.cache/compact-metrics.jsonl`. The old unawaited wrapper exited
  with zero records; the awaited path persisted exactly one `discarded`/`session`
  record before exit. Real-file shutdown regressions also cover preparation
  finishing after cancellation, original reason preservation and timing.
- Real TUI checks covered 44-column rows, empty model availability, changing and
  resetting values, uppercase/Kitty review keys, and effective-state access from
  preflight/metrics. Cancel left the conversation unchanged; Apply compacted
  60,201 synthetic tokens with zero LLM compaction calls. The effective view
  showed the attached idle/preparation state and inherited background hygiene.
- Scoped forget deleted nine derived items while preserving two saved facts
  and one legacy item. Cancel/No preserved those three; explicit all-scope
  confirmation deleted them, while compaction restore data remained. Without
  a TUI, forgetting was refused and the saved fact remained. These TUI checks
  used an isolated HOME with outbound networking denied.
- The corrected source evaluator ran all four paired arms: **19/19 oracles in
  each**, with five real compactions in EESV and hybrid and probes at rounds
  two/five. Every arm performed the same approved synthetic memory task. The
  independent oracle executes the actual server consumer; memory success
  requires the saved fact/ref in the real recall result and continuation use.

All model responses and benchmark usage above are synthetic. They establish
lifecycle, safety and accounting behavior, not semantic quality or real cost
savings. Live input estimates, output reservations and reported usage remain
distinct; the live SDK fetch guard is not a tool-process sandbox. A stock-SDK
loopback test verified a requested 5,000-token output cap was clamped to 50 on
the wire and reported usage was read from SSE; no live provider was involved.
The separate live benchmark remains unrun and needs new explicit authorization.

The subsequent complete `bun run release:check` passed under a separate HOME
without inherited provider credentials: **1391 tests**, **369 adversarial gate
tests**, four typechecks, hot-path benchmarks, the 231-file packed Node/Mnemopi
audit (including all four offline evaluator arms), and compatibility against
latest Pi **0.87.1**. Daily settings/npm manifest/npm lock SHA-256 values and
both frozen `.0` tarball hashes still matched the baseline above. The daily
installation remained Smart Compact **9.7.1** / Toolkit **0.14.1**. This is a
local `.1` candidate, not a published release or a production `PROMOTE`.
