# Hindsight and provider-native compaction research

> **Scope:** Historical research record, dated 2026-09-24. Sections and measurements are kept as written; current Hindsight behavior is documented in [Hindsight memory backend](./hindsight-memory.md).
> Current documentation for Pi Continuity (the `pi-smart-compact` package):
> [guide](./guide.md) · [configuration](./configuration.md) ·
> [evaluation](./evaluation.md) · [documentation index](./README.md).

Date: 2026-09-24. Sections 1–5 are the original research and design, written before
anything was implemented. They made no Hindsight server call or live compaction request.
Three existing offline native-transport regression tests were rerun: **3 passed / 14
assertions** on Pi 0.87.1. Web documentation and source inspection are not proof
that a particular user's account supports an endpoint. The implementation and its
measured results are in [section 6](#6-implementation-and-live-results).

## Executive recommendation

Keep three different forms of state separate:

| State | Owner/purpose |
| --- | --- |
| Active session evidence and exact recovery | Pi session tree + Smart Compact artifacts/hygiene |
| Compacted continuation | EESV or a selected, capability-checked provider-native engine |
| Curated cross-session semantic memory | Existing local project graph, optionally Hindsight |

Hindsight is not a replacement for exact artifact retrieval. A native compaction
block is not a portable long-term memory record. Neither should cause automatic
upload of all old tool results or a second full summary on every compaction.

Recommended first implementation: explicit Hindsight retain/recall with host
consent, and separately a native continuation prototype. Prefer caller-controlled
Anthropic on-demand and OpenAI standalone compaction before server-driven automatic
compaction. Leave EESV as the existing default; do not silently select native just
because a model ID starts with `claude` or `gpt`.

## 1. Hindsight options actually found

These are distinct integrations, not aliases for one package. Repository versions
below are inspected snapshots, not a claim about the newest npm publication.

| Candidate | Verified strengths | Important fit/compatibility concerns |
| --- | --- | --- |
| Official `@vectorize-io/hindsight-coding-agents` | Official Pi entry point, native tools, automatic git/session ingestion and knowledge pages | Default first-prompt `reflect`, automatic ingestion and runtime auto-update are broader than our consent/noise contract. Installer changes Pi settings/skills; not a normal `pi install npm:...` package. |
| `@luxusai/pi-hindsight` 0.13.0 | Current `@earendil-works` imports, ephemeral recall, queued durable retain, IDs/receipts, explicit tools, project/user policies | Tests pin Pi 0.84.1, not our 0.87.1. Default automatic retain and optional mental-model injection need coordination. Source manifest says 0.13.0 while some docs describe a 1.0 policy. |
| Unscoped `pi-hindsight` 1.4.2 (`anh-chu`) | Small entry point, separate self-hosted backend, manual tools and automatic opt-outs | Inspected shipped JS imports old `@mariozechner` packages. It persists a displayed recall message from `before_agent_start`; not the same ephemeral design as Luxus. README's zero-extra-dependency claim disagrees with its manifest. |
| `@walodayeet/hindsight-pi` 0.4.0 | Queue/cursor state, explicit tools, ephemeral recall default, project/tag profiles | Manifest uses old Pi namespace and Hindsight client `^0.4.19`; current server/API compatibility must be checked separately. |
| Small Smart Compact adapter to the existing Hindsight HTTP API | Keeps current save confirmation, tools, project policy and minimal surface | We own bounded requests, acknowledgement/failure handling and ID mapping. It should not grow another ingestion/index/queue framework. |

Inspected source commits:

- Luxus: `d5c6f6e6dc309830a4dd70b6bef12f029a1c35a8`
- anh-chu: `407d3f98656568a73f6edba4d9fccd491a04e592`
- walodayeet: `538c7352717e3b8e2b901d81d14d70e09181527e`

**Recommendation:** use a narrow API adapter for our confirmed-memory path, or
cooperate with one chosen existing extension through a documented public interface.
Luxus is the strongest source-inspected standalone candidate for a compatibility
spike, not yet a verified drop-in recommendation. The official package is worth
considering if broad multi-agent automatic ingestion is wanted. Do not run several
Hindsight lifecycle owners simultaneously.

### Official integration details

The documented installer for Pi is
`npx @vectorize-io/hindsight-coding-agents install pi`. It adds an extension entry
in `~/.pi/agent/settings.json` and a companion skill. The package intentionally has
no `pi` manifest key; `pi install npm:@vectorize-io/hindsight-coding-agents` is not
the supported route. **No installer was run.**

Defaults documented in the current integration guide include:

- `autoInject: "reflect"` on the first prompt, with retrieval fallbacks;
- `autoInject: "pages" | "recall" | "none"` alternatives;
- default recall options: observations, low budget, 2000 fact tokens;
- automatic git history/session ingestion and knowledge-page maintenance;
- `autoUpdate: true` for its installer-managed runtime.

These are useful features, not automatically appropriate defaults for a package
whose purpose is low noise and user-approved durable facts.

### Luxus integration details relevant to coexistence

Source registers `session_start`, `context`, `agent_end`, `session_shutdown`.
Automatic recall creates ephemeral messages, and default append mode requires the
last role to be user; it does not blindly append recall during every tool-result
continuation. Defaults include `recall.maxTokens: 800`, optional user recall 400,
`mentalModels.inject: true` with up to 12000 characters, automatic retain on,
secret redaction on, and post-retain reflect off. Setup is initially incomplete.

An 800-token recall setting therefore does **not** cap all possible memory-related
context. Its optional mental models and tool definitions have their own costs.

`hindsight:retrieval` is an observability event. The inspected package does not
expose a corresponding public retain request/ack bridge. Its explicit retain tool
calls its operation directly; it does not reproduce Smart Compact's interactive
host-confirmation gate. Calling private internal modules would couple us to its
implementation and still would not establish our consent policy.

Its default retain filter excludes its own memory tools, but not Smart Compact's
memory tools/continuity messages. If both paths are enabled, test feedback loops,
branch/compaction cursor behavior and duplicate ingestion. Agent-end notification
is not the same thing as Pi's finally settled boundary.

### Minimum Hindsight contract for Smart Compact

Keep `smart_save_memory` and `smart_recall` rather than adding another tool family:

1. **Explicit selection:** local memory remains default; enabling Hindsight names
   the server, bank and allowed scope. Do not infer project isolation from cwd
   basename or use a shared global bank without an explicit decision.
2. **Consent:** show the scrubbed fact and remote destination before writing.
   Enabling a server is not permission to upload entire transcripts.
3. **Small input:** retain the user-approved durable decision/constraint/preference,
   not full artifacts, signed compaction state, temporary status or recalled text.
4. **Stable IDs:** bind local fact ID/revision and remote document ID; track pending,
   accepted and completed states truthfully. Document identity and operation
   idempotency are different controls.
5. **Bounded recall:** project-scoped query, small fact budget, local rendered-output
   cap and source IDs. Fetch chunks/source facts only when verification requires
   them. Retrieved memories are untrusted evidence, not instructions.
6. **Optional reflect:** server-side reasoning only when explicitly requested. Do
   not invoke reflect for every save, recall or compaction.
7. **No silent dual-write success:** if Hindsight fails, retain the approved local
   record only under the configured fallback policy and report the remote outcome.
   Do not invent a cross-database transaction or claim queued data is searchable.
8. **Resolve/forget:** explicitly map the current local `resolved` operation to
   remote status/replacement/deletion semantics. Merely appending “resolved” does
   not guarantee obsolete extracted facts disappear from recall.

Existing `contextGraphEnabled` currently gates both local graph tools. A future
backend option must avoid accidentally disabling remote approved memory while
still preserving local verified compaction facts. This is a concrete existing
caller seam, not a reason to build a generic memory framework.

### API, privacy and cost facts

- Retain performs model-based fact extraction. Reflect runs additional retrieval
  and LLM synthesis; a final-answer `max_tokens` limit does not bound total reasoning
  cost. Recall is retrieval, with embedding/reranking costs dependent on deployment.
- Async retain returns an operation acknowledgement, not completion. Caller-provided
  `operation_id` supports safe async retries; conflicting reuse can return 409.
- Caller-supplied `document_id` enables deterministic updates. Default replacement
  and append/delta processing have different obsolete-fact and retry semantics.
- `max_tokens` on recall limits selected fact text, not all metadata/chunks/source
  facts; the documented API can return a fact whole beyond that fact budget. Apply
  a local output cap too.
- Default `tags_match: any` can include untagged records; strict modes matter for
  scoped retrieval. Tags/bank names are not a substitute for authenticated access
  control. Separate banks can reduce accidental scope mixing.
- Although retain prose describes extracted facts, the document API exposes
  `original_text` and recall can return raw chunks. **Do not promise that source
  text is never stored.** Self-hosted Hindsight may still call external extraction,
  embedding, reranking or reflect providers depending on server configuration.
- Deleting a document is documented to remove its extracted memories. Do not
  extend this into a guarantee that backups/logs/all derived copies are erased.
- Built-in MCP is an alternative when a trusted Pi MCP bridge is already used,
  but exposes many tools (27 single-bank/30 multi-bank in the current docs). Tool
  read-only hints are not permission enforcement. It is not the minimal default
  merely to support two existing Smart Compact tools.

## 2. Provider-native compaction mechanisms

### Anthropic

| Mode | Request | Best fit here |
| --- | --- | --- |
| On demand | Messages API `compaction: {type:"summarize"}`, beta `compact-2026-09-04` | First candidate: our controller chooses the snapshot/time and stages the result |
| Token threshold | `context_management.edits` with `compact_20260112`, beta `compact-2026-01-12` | Later, after native streaming and lifecycle integration are proven |

Current on-demand docs explicitly list Sonnet 4.6/5 and several Opus/Fable/Mythos
models. Prefer the documented Models API capability `capabilities.compaction`
with the beta header to guessing by family. On-demand is documented for Claude
API, Claude Platform on AWS, Google Cloud and Foundry; **not Bedrock**. Threshold
mode has a different platform matrix and does include Bedrock.

On-demand contract:

- Send the current system prompt/tools and a completed conversation prefix that
  still fits the model window. An unresolved tool call is rejected.
- The response contains a whole readable summary plus signature, `type:compaction`,
  with `stop_reason:compaction`. Streaming sends the whole block at block-start,
  not normal text deltas.
- Keep the block unchanged. Put exactly one—the newest—first in future messages,
  remove precisely the summarized prefix, and keep appended turns unchanged.
- Include the beta header on every replay. Do not mix on-demand `compaction` with
  `context_management`; threshold compaction cannot run on signed-block requests.
- Custom instructions replace the default summarization prompt, up to 16384
  characters. A 200 with empty content/non-compaction stop is not successful apply.
- Count `usage.iterations`: top-level usage is zero for an on-demand summary call.
  Failed/incomplete attempts can still be billed. Replaying a block has no new
  *compaction-call* charge, not necessarily zero inference input cost.

Threshold mode triggers at a documented minimum of 50000 tokens (default 150000),
can pause with `pause_after_compaction:true`, and also reports iteration usage.
Its block ordering/truncation behavior differs from on-demand; do not share a
serializer merely because both blocks are named `compaction`.

**Model/system/tool changes:** Anthropic explicitly says the signed compaction
block can still be accepted with changed model/system/tools. The extra binding
restrictions apply to *kept tail thinking*. Keeping that thinking may require
unchanged contiguous turns and the same system/tools. This is subtler than saying
“every model switch invalidates every block.” Start conservatively and test before
allowing same-provider model migrations. Cross-provider portability is not implied.
Smart pruning must not mutate a signature-bound kept tail and then silently discard
its thinking; a native-aware protection policy is required.

### OpenAI public Responses API

| Mode | Request | Best fit here |
| --- | --- | --- |
| Standalone | `POST /v1/responses/compact` | First candidate: controlled, stateless compact/apply |
| In-request | `POST /responses` with `context_management: [{type:"compaction", compact_threshold:...}]` | Later: compaction arrives amid the normal response stream |

Standalone returns a **canonical output window**, not merely one summary string.
It can include retained messages/items alongside encrypted compaction items. Replay
its complete output as returned and append only genuinely new items. Do not run
our old-message dedup/pruning over that canonical window or duplicate a local kept
tail that the returned window already retained.

The compacted state is opaque; neither Smart Compact nor Hindsight should try to
decode or summarize it as text. A generic string summary cannot replace it. The
input must still fit before compaction. Stateless standalone compaction and
`store:false` server-side flow are documented as ZDR-friendly; this does not make
our local session records ephemeral.

The API reference's broad model type enum is not a tested capability matrix.
Support must be bound to the real provider/API/base URL/model/auth route. Using a
GPT-named model through Chat Completions or an arbitrary compatible proxy does not
establish native Responses compaction support.

### OpenAI Codex / ChatGPT OAuth is a separate route

Do not treat public API-key Responses and Pi's `openai-codex` as one adapter.
Current official Codex source selects `https://chatgpt.com/backend-api/codex` for
ChatGPT-related auth versus `https://api.openai.com/v1` for API-key auth. Its current
`RemoteCompactionSupport` exposes `V2`, described as `compaction_trigger` input
controls over Responses; its protocol includes both opaque compaction items and
new context-compaction variants.

This is evidence of native compaction in the Codex stack, **not** a blanket public
API contract for Pi to reuse. Historical `/codex/responses/compact` failures are
reported even with valid ChatGPT credentials. Do not append `/compact` to a base
URL and declare OAuth supported. Validate the actual V2 route, auth refresh,
request controls and resulting item lifecycle separately; do not manufacture
first-party headers or bypass entitlement checks.

Claude API-key documentation likewise does not establish subscription OAuth
access. No account capability or paid endpoint probe was performed in this work.

## 3. What Pi 0.87.1 needs

The existing real-adapter probes still demonstrate:

- Anthropic drops the signed compaction block, rejects the compaction stop reason,
  and misses iteration-only usage.
- OpenAI Responses drops native compaction output and cannot replay opaque content.
- JSON session storage can physically hold foreign metadata; transport conversion
  is what loses it. These are not proofs that the remote server rejects the feature.

Two implementation paths:

### Preferred: host/adapter support

Add durable provider-native continuation types, parser/replay support, correct
usage/stop semantics and a supported compaction call in Pi/`pi-ai`. Smart Compact
then owns policy/selection/staging through those public seams. This gives normal
requests, reload, branch changes, exporters, counting and tool pairing one coherent
representation. In-request/server-triggered compaction especially belongs here.

### Experimental alternative: explicit native snapshot bridge

For caller-controlled on-demand/standalone compaction only, an extension could call
the endpoint itself, parse JSON directly, store a provider-bound native payload in
compaction metadata or a private referenced file, and reconstruct native request
payloads using Pi's request/header hooks. This avoids forcing a special response
through the currently lossy normal stream parser.

This is an **engineering option, not a verified implementation**. It must solve:

- exact snapshot-to-entry mapping and replay after every restart/fork;
- one provider-native snapshot plus the genuinely new local tail;
- full Responses canonical-output preservation and tool-call ID accounting;
- authenticated/header routing without copying credentials into state;
- dynamic system/tools and signature-bound thinking rules;
- provider usage vs Pi's local context estimates (a tiny plaintext placeholder
  must not make Pi believe a large opaque state uses no context);
- stale/pivot/model changes, cancellation, failure before correlated apply;
- startup without the extension: never silently continue from an opaque record
  that has been replaced by an empty human-readable placeholder;
- interoperability with context rewriting and Toolkit anchor cache: a marker on
  a replaced native prefix may no longer exist in the actual wire request.

A request-only flag is still insufficient. Do not present the bridge as a free
workaround, copy an entire provider implementation, or silently replace Pi's
providers. A small offline prototype should determine whether upstream host work
is less risky than maintaining this conversion bridge.

## 4. User-facing selection (proposal, not current settings)

Keep engine selection separate from the existing fast/balanced/thorough budget
policy. Suggested settings presentation:

```text
Compaction engine:       EESV | Provider native
Apply to:                current provider/model route
If unavailable:          Stop and explain | EESV (explicit opt-in)
Capabilities:            Supported | Not verified | Unsupported (reason)
```

Route-specific choices can choose Anthropic on-demand for supported Anthropic
routes and OpenAI standalone for supported Responses routes. Codex OAuth and
third-party proxy routes have their own capability state. Existing `native-hook`
means Pi's compaction event, NOT provider-native compaction.

A later `auto` mode may choose among previously verified routes; do not default to
it before capability and quality measurements. Avoid a separate tool per provider
or a schema that churns every turn. Do not claim native output received full EESV
semantic verification, especially when OpenAI's state is opaque.

On errors, keep the old context untouched. Opt-in fallback must disclose additional
calls/cost and stop when its budget is exhausted. If opaque provider state already
exists, changing to another provider cannot send that blob to the new provider;
use an explicitly prepared portable handoff from authorized local evidence, or
stop and ask. Do not resurrect foreign-redacted raw messages.

Native payloads can contain sensitive information even if encrypted/opaque. Treat
them as private session data, not harmless telemetry or material to upload into
Hindsight. Scrub approved inputs before compaction where valid; never mutate the
returned signed/opaque payload to perform after-the-fact redaction.

## 5. Proposed development order and acceptance gates

1. Decide Hindsight integration owner and inspect the user's actual server version,
   auth and desired bank scope with permission. No need to install a new server.
2. Add manual confirmed retain/recall at the existing tools' seam, with idempotency,
   source receipts and local caps; auto-ingestion/reflect remain off initially.
3. Prototype native payload persistence/replay offline on current Pi and prepare a
   narrowly scoped upstream host proposal if transport support is required.
4. Implement capability-gated Anthropic on-demand and OpenAI standalone paths.
   Reuse pending-prefix/model/budget checks, not the EESV synthesis call as an extra
   mandatory layer. Retain deterministic continuity facts separately when useful.
5. Validate Codex OAuth V2 and Claude OAuth separately, with explicit provider-call
   budget and ordinary permitted authentication. Never assume API-key success proves
   OAuth success.
6. Only then consider in-request threshold compaction and automatic Hindsight recall.

Tests must cover exact native replay across reopen/fork, invalid signature/opaque
payload refusal, custom instructions, system/tool changes, complete tool batches,
canonical retained items, request aborts, new turns during preparation, expiry,
provider change, actual token accounting, cache behavior, missing extension on
resume, memory provenance/confirmation, duplicate ingest, privacy and backend
outages. Live task quality remains a separate test from wire compatibility.

## 6. Implementation and live results

> Superseded (2026-09-25): Pi is not changed. Native compaction now runs on stock
> Pi 0.87.1+ as an extension (nested request plus `before_provider_request`
> replay; see ARCHITECTURE.md). The host implementation and live results below came
> from a modified Pi and no longer count; current live results are in README "Compaction engines".

Implemented as host support plus a Smart Compact engine, following section 3's
preferred option.

- **Pi host.** Built in a source checkout of v0.87.1 (`../pi-native-compaction`); stock
  Pi 0.87.1 does not have it.
  - `ModelRegistry.compact()` runs one request with no retries, through the session's
    provider hooks.
  - `CompactionEntry.native` stores the provider state. It is replayed verbatim only on
    its own provider/API/model and only as the first message; every other request
    gets the readable `summary`.
  - Anthropic on-demand compaction, OpenAI `/responses/compact`, and Codex
    `compaction_trigger`.
  - Server-driven automatic modes (Anthropic `compact_20260112`, Codex inline
    compaction) are not used.
- **Smart Compact.** `compactionEngines` is an ordered list; the default is `["eesv"]`.
  Native runs only when selected, on the current route. Unavailable engines are
  skipped with a reason.
- **Toolkit.** Its Claude OAuth adapter only edits the system prompt and the last user
  message. The Anthropic compaction block is replayed as its own leading assistant
  message, so the adapter never touches it. No conflict was found in either live run.

Offline tests:

- host: pi-ai 12 native tests; coding-agent compaction suite 31;
- `npm run check` passes, and full-suite failures are identical to the unmodified
  v0.87.1 checkout (unbuilt workspace `dist`);
- `scripts/native-host-pilot.ts` runs real `AgentSession`s with Smart Compact and the
  installed Toolkit through the full flow (details below) for both routes.

That flow is: compact, reload from JSONL, verbatim replay, re-compaction from earlier
state, and fallback to readable text after a model switch.

Live canary (`PSC_NATIVE_LIVE=1`, ledger-capped): 22 of 24 approved requests,
~134k of 300k input tokens, ~1.3k of 16k output tokens. Live testing stopped there.

| Route | Compaction | Replay after reload | Recall of a compacted tool-output fact | Re-compaction |
| --- | --- | --- | --- | --- |
| Claude subscription, `claude-sonnet-4-6` | accepted, one signed block | accepted | yes | accepted, built on the previous block |
| Codex subscription, `gpt-5.6-luna` | accepted, one encrypted item | accepted | **no**: once a refusal ("codeword" framing), once "cannot tell without re-reading the file" | offline only |
| OpenAI Responses, API key | offline tests only | offline only | not run | offline only |

Reading: the Codex route works at the protocol level, but its provider summary lost an
incidental detail from tool output that the Claude route kept. Both runs used
`thinkingLevel: off`, and the Claude fact carried a "keep it for later" hint that the
second Codex run lacked, so this is not a like-for-like quality comparison. Treat
native compaction on Codex as lossy for details; EESV remains the default.

Known limitation: when a session is smaller than Pi's `compaction.keepRecentTokens`,
Pi refuses to apply a compaction after the engine has already run. Smart Compact
reports it and leaves the conversation unchanged.

## Sources inspected

### Hindsight

- [Official coding-agent integration](https://hindsight.vectorize.io/sdks/integrations/coding-agents)
- [Luxus Pi integration](https://github.com/luxus/pi-hindsight/tree/d5c6f6e6dc309830a4dd70b6bef12f029a1c35a8)
- [Unscoped pi-hindsight](https://github.com/anh-chu/pi-hindsight/tree/407d3f98656568a73f6edba4d9fccd491a04e592)
- [Walodayeet integration](https://github.com/walodayeet/hindsight-pi/tree/538c7352717e3b8e2b901d81d14d70e09181527e)
- [Retain and safe operation retries](https://hindsight.vectorize.io/developer/api/retain)
- [Recall and scope/output budgets](https://hindsight.vectorize.io/developer/api/recall)
- [Reflect](https://hindsight.vectorize.io/developer/api/reflect)
- [Original documents and deletion](https://hindsight.vectorize.io/developer/api/documents)
- [MCP server](https://hindsight.vectorize.io/developer/mcp-server)
- [oh-my-pi integration case study](https://hindsight.vectorize.io/blog/2026/06/08/oh-my-pi-hindsight-memory)

### Native compaction

- [Anthropic overview](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Anthropic on-demand contract](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)
- [Anthropic threshold contract](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)
- [Background prefix/tail behavior](https://platform.claude.com/docs/en/build-with-claude/compaction-background)
- [Preserved thinking and model/tool changes](https://platform.claude.com/docs/en/build-with-claude/compaction-thinking-blocks)
- [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [OpenAI compact reference](https://developers.openai.com/api/reference/resources/responses/methods/compact)
- [Codex provider capabilities/V2](https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/provider.rs)
- [Codex auth-dependent routing](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs)
- [Codex opaque items and trigger controls](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs)
- [Codex route failure report — user evidence, not API documentation](https://github.com/openai/codex/issues/38323)
- Local Pi 0.87.1 docs/declarations/adapters and `test/native-compaction-compat.test.ts`.
