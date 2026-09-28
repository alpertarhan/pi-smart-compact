# Evaluation and evidence

How Pi Continuity (published as the `pi-smart-compact` package) is evaluated,
which commands exist, and what each kind of evidence can and cannot support.

This page is for maintainers and evaluators working from a **development
checkout**. The evaluation and report CLIs run directly from source with Bun;
no build is needed. The installed npm package contains only the extension, the
optional RTK entry, the Mnemopi worker and declarations in `dist/`, not these
tools.

Related pages: [user guide](./guide.md) · [configuration](./configuration.md) ·
[architecture](../ARCHITECTURE.md) · [release checklist](./RELEASE.md) ·
[Hindsight memory backend](./hindsight-memory.md).

## Offline and live evidence

Every result belongs to exactly one evidence class. Do not promote a claim from
one class to another.

| Class | Examples | Can show | Cannot show |
| --- | --- | --- | --- |
| Deterministic checks | `release:check`, `gate`, `bench`, unit tests | Contracts, invariants, bounded hot paths, packed-install behavior | Model quality, real savings, provider behavior |
| Offline lifecycle runs | `task-eval` (default), `session-pilot`, `context-compat-pilot`, `native-host-pilot` (default) | Real Pi `AgentSession`/tool/storage lifecycle with scripted model transport; oracle plumbing | Autonomous model decisions, live token cost or billing |
| Opt-in live probes | `provider-eval:live`, `task-eval --live`, `visual-pilot --live`, `PSC_NATIVE_LIVE=1`, Hindsight live canary | One bounded sample on one date, model and account | Production quality, other models, invoice-level cost |
| Local telemetry | `provider-eval`, `telemetry-report`, dashboards | Aggregates over runs recorded on this machine | Anything about runs not recorded, or statistical confidence |
| Replay estimates | `replay-eval` | Estimated prompt tokens and catalog-priced deltas for recorded sessions under alternative trim policies | Real savings, provider cache behavior, billing |

Rules that apply everywhere:

- A green deterministic or offline result never implies live quality, real
  token savings, or a `PROMOTE` decision.
- Live runs are never part of `release:check`. Each live run needs a fresh,
  explicit approval of the model, request count and token/cost exposure before
  it starts. No approval carries over from an earlier run or document.
- Input guard counts are local estimates. Output reservations and wire caps
  are distinct from provider-reported usage; missing usage stays unknown.
- Subscription (OAuth) usage is quota, not pay-as-you-go spend, and is never
  priced at API rates.
- The verifier checks coverage of deterministic facts, structure and grounded
  claims. It is a regression signal, not proof of semantic truth or of
  lossless preservation.
- Dated reports are historical snapshots. Their measurements are not re-run
  when the code changes; see [dated reports](#pilots-and-dated-reports).

## Deterministic release gates

```bash
bun install --frozen-lockfile
bun run release:check   # typecheck + tests + gate + bench + build + release:audit + compat:pi latest
bun run gate            # adversarial parser/verify/tool/cache/budget/scrub/damage fixtures
bun run bench           # standalone hot-path p95 regression gate
bun run compat:pi 0.87.1   # locked minimum host, isolated workspace
bun run compat:pi latest   # latest Pi host, isolated workspace
```

`release:audit` packs the tarball, installs it in an isolated frozen
workspace, checks the manifest, peers and packed file list, registers the
extension and its tools under stock Node, exercises Node SQLite and the
optional Mnemopi worker on the user-installed `bun` component with no Bun on
`PATH`, and
runs the offline source CLIs (`provider-eval`, `telemetry-report`, and all four
offline `task-eval` arms) under a temporary `HOME`. Apart from package
installation and a local loopback tripwire, it makes no network or model
request. The exact release procedure is in
[the release checklist](./RELEASE.md).

A previous green run does not carry over: rerun the full `release:check` after
any change to the candidate.

Pull-request CI runs frozen install, `typecheck`, `bun test`, `gate`, `bench`,
`build` and `release:audit`. The latest-Pi compatibility job runs only on a
schedule or manual dispatch. A green CI badge therefore does not replace a
full local `release:check` on the exact candidate.

## Provider routing evidence

All stages use the selected Pi model by default. Routing is explicit,
independent of modes, and never inferred or changed automatically:

| Stage | Config key | Fallback when unset |
| --- | --- | --- |
| Explore / segmentation | `segmentationModel` | resolved summary model |
| Synthesis / assembly | `summaryModel` | explicitly selected model, otherwise the chat model |
| Verification repair | `verificationModel` | resolved summary model |

Every run records per-stage provider, model, reliability, latency and token
telemetry, with schema-versioned verifier quality. Failed dispatched calls keep
content-free categories (authentication, rate limit, timeout, and so on), even
when a deterministic fallback completed the run. Older records without
categories stay unclassified.

### Advisory matrix from local telemetry

```bash
bun run provider-eval                    # text report, --min-samples defaults to 5
bun run provider-eval --min-samples=10 --json
```

Reads the local metrics log and groups routes by stage, context pressure and
tool density. Only an explicitly attributed pre-repair synthesis score counts
as route quality; a run's final verifier score is never copied to Explore or
Verify. Legacy rows contribute latency and reliability, not quality. A cell is
eligible for a recommendation only with at least `--min-samples` runs, at least
80% call reliability, at least 50% stage-local quality coverage and an average
attributed quality of at least 85; scores shrink toward neutral under low
confidence. The report is advisory only: it never edits configuration or
selects a model.

### Opt-in live scenario probe

```bash
# Paid API or subscription quota. Run only with explicit approval.
bun run provider-eval:live --live \
  --models=provider/model-a,provider/model-b
```

Refuses to run without both `--live` and `--models` (1 to 8 models). Each model
receives the same three bounded coding-continuity scenarios (`implementation`,
`debugging`, `continuity`) sequentially, with a 1,500-token output cap and a
60-second timeout per call, scored by the deterministic verifier. It reports
score, latency and reported usage. Apply a route manually, and only after
representative evidence; one probe is not that evidence. The dated
[2026-08-06 baseline](./provider-evaluation-2026-08-06.md) is an example of
this output, not a current ranking.

## Paired continuation and memory evaluation

`task-eval` runs the same synthetic coding task through four real stock-Pi
`AgentSession` arms:

| Arm | Meaning |
| --- | --- |
| `no-compaction` | Baseline; context only grows |
| `recoverable-hygiene` | Recoverable trimming and retrieval, no summary |
| `eesv` | Real verified compactions |
| `hybrid` | Hygiene plus verified compactions |

```bash
bun run task-eval --help
bun run task-eval --out=/tmp/psc-task-eval-new           # offline, all arms
bun run task-eval --arms=eesv,hybrid --repeats=3 --out=/tmp/psc-task-eval-eesv
bun run task-eval --repeats=1 --json --out=/tmp/psc-task-eval-smoke
```

Options (from `--help`): `--arms`, `--repeats=1..8` (default five rounds, probes
after rounds two and five), `--out` (absolute directory; defaults to
`./task-eval-reports/<timestamp>`), `--json`, and two offline-only
cost-accounting fixtures, `--cache-warming=off|streaming|idle` and
`--background-prep`. Every arm runs with `toolLoading: "eager"`, so the arms
differ only in hygiene/offload knobs, not in on-demand tool discovery. With
`--cache-warming=idle`, arms that have automatic cleanup on may commit a
break-even trim at an idle boundary; the rebuilt context ends Pi's warming for
that entry, so zero warm replays there is expected, while the `no-compaction`
baseline keeps its refreshes.

The default transport is scripted and offline: the arm sets `PI_OFFLINE=1` so
Pi never downloads tools, and it fails before the first round when `rg`
(ripgrep, used by Pi's grep tool) is not on PATH. Independent oracles execute the
changed store/server and test process, check preserved constraints, errors and
side effects, require the newest decision, test unknown and false-premise
answers, and verify archive retrieval plus actual saved-memory recall and use.
Every arm runs the same explicitly approved synthetic memory task in temporary
stores. Reports compare requests, reported usage and cache classes, tool
interactions, compactions, retrieval, latency, hygiene and preparation
measurements. A green offline report proves lifecycle and oracle behavior, not
autonomous model quality, real token savings, or a production promotion.

### Live mode

```bash
# Prepare once, before approving any provider spend. The empty context sends
# no checkout, credentials or host files to the builder. Pull/apt needs network.
EMPTY_CONTEXT=$(mktemp -d)
docker build --file scripts/task-eval.Dockerfile \
  --tag pi-smart-compact-task-eval:runtime-1 "$EMPTY_CONTEXT"
rmdir "$EMPTY_CONTEXT"

# Only with fresh explicit approval. PRIVATE_HOME contains only the approved
# frozen credential/selected model; PRIVATE_TMPDIR is caller-owned and private.
# Freeze the local endpoint before replacing HOME; do not copy Docker config.
DOCKER_ENDPOINT=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
env -i HOME="$PRIVATE_HOME" TMPDIR="$PRIVATE_TMPDIR" PATH="$PATH" LANG=en_US.UTF-8 \
  DOCKER_HOST="$DOCKER_ENDPOINT" bun run task-eval --live --models=provider/model \
  --main-max-tokens=4096 --context-window=200000 \
  --budget-requests=N --budget-input-tokens=N --budget-output-tokens=N \
  --out=/absolute/private/report-directory
```

Live mode requires the selected model and three positive budgets.
`--summary-model` may select another model on the same approved provider.
`--main-max-tokens` defaults to 4096. The context window is native unless an
explicit `--context-window` fixture is supplied; a fixture cannot exceed the
model catalog. Record both the fixture and native window when comparing arms.
Offline warming/preparation fixtures are refused in live mode.

Only the selected provider and selected custom model definitions enter the
runtime. API keys may come from that provider's stored credential or a literal
`models.json` key; commands and environment templates must already be resolved.
The credential is held by a read-only in-memory store. OAuth refresh material
is removed, mutation is refused, and expiring access tokens fail closed. Never
copy an entire daily auth/models file or source an ambient `.env` for a pilot.

Live tools require a local Unix-socket Docker daemon running Linux containers
and the prebuilt image above. On macOS, use a VM-backed daemon. The image is
resolved to its immutable ID before execution; startup probes must pass before
a provider call. No native fallback exists: raw `KERN_PROCARGS2` defeated the
macOS sandbox used by the rejected canary.5 candidate, even with a restricted
sysctl allowlist.

Model bash/read/write/grep, fixture snapshots and oracle processes run in fresh
containers. Only the synthetic project and owned HOME are bound; the runtime
image is read-only. No host credentials, Docker socket or ambient environment
are mounted/passed. Network and PID namespaces isolate host/sibling processes.
Capabilities are dropped, privilege elevation is disabled, and each container
is bounded to 64 PIDs, 512 MiB and one CPU. Calls are serialized. Tools execute
on Linux even when the evaluator is on macOS; record the image ID and policy
hash with the evidence. Whole-arm latency includes container startup/teardown.
These are evaluation prerequisites, not extension runtime dependencies.

Each container is created before it is started, avoiding a cancellation race
that could start a late container. Normal exit, timeout, abort and disposal
remove its whole process tree, including detached children. File reads have a
30-second command deadline and an 8 MiB output ceiling; local Docker control
operations have a separate 15-second deadline. Normal completion/failure
removes owned arm and child scratch directories. The caller must remove its
frozen-credential HOME/TMPDIR on signals; SIGKILL or a failed daemon can leave
owned resources requiring manual cleanup. Never delete unrelated containers.

The SDK fetch guard allows only the selected origin, refuses redirects, and
reserves a request's full output cap before dispatch. If that cap does not fit,
it refuses rather than shortening the response. Input is a character-derived
estimate, not a billed-token hard limit. Reports snapshot each arm after all
usage accounting settles, including failed dispatched calls, main/summary
classes, HTTP status, provider input/output/cache fields and per-request
elapsed time. Anthropic input excludes its separate cache fields; missing
fields remain null. Whole-arm time also includes tools and local oracles.
`--json` writes the same report to stdout and `task-eval-report.json`.

ChatGPT/Codex is refused by default: `--accept-codex-soft-cap` explicitly
selects unbounded output and can never satisfy a hard output-token budget.
Neither an offline loopback smoke nor one live paired sample satisfies the
production promotion gates below.

## Telemetry and canary gates

Raw local JSONL stays available to the interactive dashboard. The aggregate
report contains no session or project IDs, prompts, summaries, paths or error
text:

```bash
bun run telemetry-report                        # --min-canary-runs defaults to 20 (minimum 5)
bun run telemetry-report --min-canary-runs=20 --json
```

Failures use a stable content-free taxonomy (cancelled, timeout, rate limit,
authentication, budget, output limit, provider, persistence, validation,
verification, yield, internal). Verification and yield failures keep only
content-free diagnostics.

### Cohorts

Set `telemetryChannel: "canary"` only on an externally selected canary
installation; the default is `stable`. Canary evidence is limited to schema-v2
runs of the version under evaluation. Entries without an explicit release
channel are reported as unattributed and excluded from both cohorts, never
treated as stable. Reports separate total, attempted and host-confirmed applied
runs. Dry runs, staged or discarded preparations and voluntary cancellations are
not applied evidence; cancellations are neutral, while real timeouts and
provider failures count.

### Decision rules

The report returns `ROLLBACK`, `HOLD` or `PROMOTE` (implemented in
`src/domain/telemetry.ts`). It never deploys, rolls back or edits
configuration; promotion authority stays with the release owner.

Rollback is evaluated once the canary has at least three attempted runs. Any
trigger returns `ROLLBACK`:

| Metric | Trigger |
| --- | --- |
| Failure rate | Canary above 5% absolute, or at least 5pp above stable |
| Verifier quality | Canary average below 85, or at least 5 points below stable |
| p95 duration | At least +50% versus stable (stable p95 at least 1 s) |
| Average tokens | At least +50% versus stable (stable average at least 1,000) |
| Fallback rate | At least +10pp versus stable |
| Damage rate | At least +10pp versus stable |

Without a trigger, `PROMOTE` requires all of the following; otherwise the
result is `HOLD` with the first missing reason:

- at least `--min-canary-runs` (default 20) host-applied canary runs;
- a stable baseline of at least `max(20, --min-canary-runs)` applied runs;
- at least 70% verifier-quality coverage in both cohorts;
- at least 70% run-correlated damage-observation coverage in both cohorts;
- canary average verifier quality of at least 85 and success of at least 95%;
- canary data confidence of at least 85.

Damage observations join their originating compaction by run ID and are
deduplicated per run. Missing observations are missing evidence, never clean
runs.

### Two confidence scores

Both are completeness heuristics, not statistical confidence:

| Score | Where | Components |
| --- | --- | --- |
| Canary data confidence | `telemetry-report` | canary sample 25, stable sample 15, canary quality coverage 20, canary damage coverage 20, stable damage coverage 20 |
| Dashboard Data Confidence | `/smart-compact dashboard` | recent sample 25, schema-v2 share 25, quality coverage 20, field completeness 20, freshness 10 (last complete run within 7 days) |

Legacy or incompatible evidence stays missing and lowers both. Dashboards also
show initial score, patch, LLM-repair and deterministic-floor provenance instead
of hiding repair behind the final score.

### Preparation and cost measurements

Completed background work that is discarded is recorded once with its reason
and cost, never as applied evidence; graceful shutdown waits for that record.
Reports show used and discarded preparation, time to ready, wait to use or
discard, reuse rate and discarded spend. Stage routes keep input, cache-read,
cache-write and output classes and mark estimated usage. These are measurements
only: savings floors, cooldowns, pressure gates and TTLs are unchanged by them.

### Replay estimates

`bun run replay-eval --sessions=<dir|file[,file…]> [--out=/abs/dir] [--json]
[--break-even=8,16,24,48] [--rebuild-min=16384] [--limit=N]` replays recorded
session files in memory (never written; input mtimes are checked afterwards)
and judges the automatic-trim timing constants `AUTO_TRIM_BREAK_EVEN_REQUESTS`
and `REBUILD_MIN_TOKENS`. Recorded automatic trims are removed first so every
policy starts from the same history. Policies:

- `none`: no automatic trim.
- `pressure`: the old rule; a ready batch commits at a turn boundary only when
  the estimated prompt reaches 0.8 × the catalog context window. Live, the gate
  is the configured start percentage of `min(window, maxContextTokens)` against
  Pi's reported usage, which includes the system prompt and tool definitions, so
  pressure fires later in replay than live.
- `timed-<N>`: the current rule with `N` in place of the break-even limit;
  pressure commits, `N* ≤ N` commits (`break-even`), otherwise the batch is held
  and applied at the first request after the previous request's cache lifetime
  (`cold`). Planning, cooldown and protected prefixes use the extension's own
  `planContextTrim`/`trimEntries`/`trimTokens`.

Cost model per request: the projected context is estimated per message; the
cached prefix is the longest run of identical projected messages shared with
the previous request (0 after the cache lifetime or a model switch);
`uncached = prompt − cached`; a rebuild is `uncached ≥ max(--rebuild-min,
0.5 × prompt)`; price = `cacheRead × cached + (cacheWrite, else input) ×
uncached` at catalog rates. System prompt, tool definitions and output are
identical across policies and excluded. The recorded baseline (usage and
`usage.cost.total`) is the only measured figure; subscription requests report
tokens only. `--json` writes `<out>/replay-eval.json` with session ids and
numbers, no message text or paths. Absolute estimates are not calibrated to
recorded usage (a first run over three Codex sessions estimated about 4× the
recorded `input + cacheRead`); compare policies by their Δ, never by the
absolute column.

## Pilots and dated reports

Pilot scripts are development tools with narrow purposes. Offline defaults make
no provider request.

| Command | Default | Purpose |
| --- | --- | --- |
| `bun scripts/session-pilot.ts` | Offline | Real `AgentSession` with scripted model transport, Pi Continuity only: tools, anchor and pivot with carryover, trimming/retrieval, rewind, compaction and reopen |
| `NODE_PATH="$PWD/node_modules" bun scripts/context-compat-pilot.ts /path/to/pi-lens` | Offline | Real Pi dispatch with an explicit local pi-lens path in both load orders: read-guard coverage and the anchor cached prefix across trim |
| `PSC_CLAUDE_OAUTH_EXTENSION=<pi-claude-oauth-adapter>/extensions/index.ts bun scripts/native-host-pilot.ts` | Offline fake provider | Provider-native compaction on stock Pi; the Anthropic OAuth route needs the standalone adapter (patched final-payload build for billing on nested requests); `PSC_NATIVE_LIVE=1` sends real, ledger-capped requests and needs explicit approval |
| `bun run scripts/rtk-pilot.ts /absolute/path/to/rtk` | Local only | Synthetic RTK rewrite contract; characters, not provider tokens |
| `bun run scripts/visual-pilot.ts --model=provider/id` | Offline planning | Bitmap versus text evidence; `--live` authorizes at most 9 sequential requests and needs explicit approval |
| `PSC_HINDSIGHT_LIVE=1 … bun run test/hindsight-live.canary.ts` | Not run by `bun test` | Live Hindsight contract with a hard call budget; see [Hindsight memory](./hindsight-memory.md#tests) |

Dated reports record what was measured on their date, with the code and host
versions stated inside. They are kept for provenance and are not updated
retroactively. Current behavior is described in the [guide](./guide.md),
[configuration](./configuration.md) and [architecture](../ARCHITECTURE.md).

| Report | Scope |
| --- | --- |
| [Provider evaluation baseline, 2026-08-06](./provider-evaluation-2026-08-06.md) | Live three-scenario probe across five models; advisory |
| [Context hygiene and continuity, 2026-09-24](./context-hygiene-2026-09-24.md) | Hygiene design and offline experiments |
| [Hindsight and provider-native compaction research, 2026-09-24](./hindsight-native-compaction-research-2026-09-24.md) | Pre-implementation research plus later measured results |
| [Full AgentSession offline pilot, 2026-09-24](./session-pilot-2026-09-24.md) | Scripted-transport lifecycle pilot |
| [Visual evidence pilot, 2026-09-24](./visual-pilot-2026-09-24.md) | Live synthetic bitmap-versus-text reading pilot on one model |
