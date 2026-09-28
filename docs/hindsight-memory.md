# Hindsight memory backend

Cross-session memory is the optional fourth layer of Pi Continuity (the
`pi-smart-compact` package), after context hygiene, recoverable continuity and
compaction. The guide's [memory section](./guide.md#memory-what-is-stored-where)
compares the three stores; see
[architecture](../ARCHITECTURE.md#4-optional-cross-session-memory) for how the
backends fit together and [configuration](./configuration.md#memory) for all
settings.

Contents: [Set up](#set-up) · [Configuration](#configuration) ·
[Data that leaves the machine](#data-that-leaves-the-machine) ·
[Consent](#consent) · [Identity, refs, and lifecycle](#identity-refs-and-lifecycle) ·
[Readiness](#readiness) · [Troubleshooting](#troubleshooting) · [Tests](#tests)

The extension can optionally send **explicitly confirmed** project memories to
an existing [Hindsight](https://hindsight.vectorize.io) server, and include a
bounded, project-scoped Hindsight recall in `smart_recall`. The default backend
is `local`, which never contacts any server.

**One exclusive backend.** `memoryBackend` selects the single store used by
`smart_save_memory` / `smart_recall` — local graph, Hindsight, or Mnemopi.
While Hindsight is selected, no other memory store is read, written, indexed,
or started: there is no local-graph copy of confirmed saves, no Mnemopi
worker, and no fallback to any other store if the server fails or its outcome
is unknown. Switching backends never moves, merges, or deletes existing
memories; data saved earlier in another store stays on disk, inactive and
untouched, until that backend is selected again.

What this feature does **not** do:

- No automatic retain. Transcripts, compaction summaries, tool output and
  recalled text are never uploaded. Only the single fact shown in a
  confirmation dialog is sent.
- No `reflect`, mental models, or prompt injection of remote memory. It never
  changes bank missions or server settings.
- No provider-opaque memory upload.
- No bank-wide operations. The client has exactly four fixed routes (retain,
  operation status, recall, delete one document) and no generic request
  method, so it cannot reach routes such as `DELETE /memories`.
- No server installation, setup, or bootstrap. An already-running server's
  URL and an explicit bank are required configuration; an API key is
  optional and is read from a named environment variable. Readiness checks
  are presence-level only.

## Set up

1. Have a Hindsight server running and a bank for these memories. Pi
   Continuity never creates either.
2. If the server needs a key, export it in the environment Pi starts from,
   for example `export HINDSIGHT_API_TOKEN=…`. Only the variable's **name**
   goes into settings.
3. Configure the store (below), either in `~/.pi/agent/settings.json` or in
   `/smart-compact settings` → **Memory**: set *Memory store* to *Hindsight
   server*, then fill the *› Hindsight server* submenu (Server URL, Memory
   bank, API key variable, Request timeout (ms), Recall size (tokens)).
4. Open Home → **Status & help** → **Readiness & details**. `configuration
   complete` means the values are present; it does not prove the server is
   reachable or the key is valid.
5. Ask the agent to save one fact. Approve the confirmation dialog, then
   check the reported receipt state (see [receipt states](#identity-refs-and-lifecycle)).

## Configuration

In `~/.pi/agent/settings.json` (only this global file is read):

```json
{
  "smartCompact": {
    "memoryBackend": "hindsight",
    "hindsightBaseUrl": "https://hindsight.example.com",
    "hindsightBankId": "my-agents",
    "hindsightApiKeyEnv": "HINDSIGHT_API_TOKEN",
    "hindsightTimeoutMs": 12000,
    "hindsightRecallMaxTokens": 2048
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `memoryBackend` | `"local"` | `local`, `hindsight`, or `mnemopi` (local SQLite full-text store). The selected backend is the only store contacted. |
| `hindsightBaseUrl` | `null` | HTTPS URL. Plain `http` only for loopback (`localhost`, `127.x`, `::1`). Credentials, query and fragment are rejected. Redirects are refused. |
| `hindsightBankId` | `null` | Required. Never inferred. `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. |
| `hindsightApiKeyEnv` | `null` | Optional. **Name** of the environment variable that holds the API key (`[A-Z_][A-Z0-9_]*`, at most 128 characters), sent as `Authorization: Bearer`. With `null`, requests carry no `Authorization` header. The key itself never goes into settings, receipts, tool output or errors. If the variable is named but unset, Hindsight is treated as not configured: saves and recalls are refused and nothing is written anywhere else. |
| `hindsightTimeoutMs` | `12000` | Per-request timeout, 1000–60000. |
| `hindsightRecallMaxTokens` | `2048` | Server-side recall budget, 128–4096. Rendered output is additionally capped locally at about 3000 characters, 600 per fact. |

Invalid values are dropped with a warning and the defaults apply. Rejected
values are never echoed, because they may be pasted secrets.

The historical `hindsightLocalFallback` setting (`always` / `on-failure` /
`never`) is removed: the selected backend is now exclusive, so no local copy
policy exists. A stale key still present in `settings.json` is ignored with a
one-time notice and otherwise left alone.

With `memoryBackend: "hindsight"`, the memory tools stay available regardless
of `contextGraphEnabled`; that flag only governs the local backend (and its
compaction-state indexing). Saves and recalls contact only the server.

## Data that leaves the machine

- **Save:** the scrubbed fact, formatted as `[kind] title`, the content, and
  the related paths. It is sent with tags `psc-project:<hashed project id>`,
  `psc-kind:<kind>` and `psc-source:smart-compact`, plus metadata (kind, hashed
  project id, local memory id, revision). The raw working directory is not
  sent. `scrubSecrets` and `scrubPii` apply before the confirmation, so the
  user approves exactly what is sent.
- **Recall:** the scrubbed query (at most 500 characters), restricted to the
  current project tag with
  `tags_match: "all_strict"`, `budget: "low"`, and no chunks, source facts or
  entities. Results that lack the project tag are also discarded client-side.
  `scope: "session"` is not supported on this backend and searches nothing.
- **Resolve:** a `DELETE` of that single document id.

Server-side caveats, observed on a real server (API 0.9.2); check your own
server's configuration:

- `store_document_text` is enabled there, so **the raw retained text is
  stored on the server**, not only the extracted facts.
- Hindsight runs its own LLM and embedding models over retained text. Even a
  self-hosted server may forward the text to the model providers it is
  configured with.
- Deleting a document removes its memory units through the API. It makes no
  promise about server backups or logs.

## Consent

- Enabling `memoryBackend: "hindsight"` is the consent for remote **recall**
  of scrubbed queries.
- Every **save and resolve** still requires your approval in Pi's
  confirmation dialog. The dialog shows the kind, title, full scrubbed
  content, paths, and the destination:
  - server URL and bank;
  - project tag;
  - document id and the ref;
  - for resolve, "DELETE this one document".
- Sessions without an interactive UI (print, RPC, SDK) are refused, and
  nothing is sent.

What to save:

- Save: durable engineering decisions with rationale, enforced conventions,
  resolved bugs with root cause, tooling gotchas, and stated preferences.
- Never save: raw files, logs, stack traces, TODOs, narration, unexecuted
  plans, speculation, secrets, or facts that are cheap to re-derive from the
  repository.

## Identity, refs, and lifecycle

- **Memory refs:** saves and recall results for facts confirmed through Pi
  Continuity carry a ref naming the backend, stable id, and a mandatory
  96-bit target digest: `local:cg-…@…`, `mnemopi:cg-…@…`,
  `hindsight:cg-…@…`. The target is the local graph file, Mnemopi database
  path, or Hindsight server+bank respectively. Hindsight additionally binds
  the project and document id: a copied ref or a document id combined with
  another project's target cannot delete across projects. Unsuffixed or
  altered refs are rejected; there is no legacy retargeting path.
  Compaction-derived graph items and unrelated remote documents have no
  actionable ref. Resolving (`smart_save_memory` with `status: "resolved"`)
  requires the ref; recall renders truncated previews, so exact-text matching
  is gone. A ref never
  embeds a URL, bank, or path: the destination is re-derived from current
  configuration and compared against the digest, so after a config switch an
  old ref cannot silently act on another server, bank, or data root.
- **Refs are exclusive to their backend:** resolving requires
  `memoryBackend` to match the ref's own backend. A `local:` or `mnemopi:` ref
  presented while Hindsight is selected (or any other mismatch) is refused
  with an explicit "Switch Memory store to …" message — the inactive store
  is not contacted, and nothing is migrated, copied, or deleted anywhere.
  Switch back to that backend to act on the ref; its data is unchanged.
  Saving the same fact to two backends (by switching between two saves) yields
  two distinct refs and two independent copies that never observe each other.
- **Local close vs remote delete:** a `local:` ref soft-closes the graph node
  (status=resolved); `mnemopi:` and `hindsight:` refs delete the stored fact.
- **Document id:** `psc-` + the local manual memory id. That id is a hash of
  the project, kind and normalized content, so the same fact always maps to
  the same document. Retains use `update_mode: "replace"`.
- **Operation id:** a deterministic UUID derived from origin, bank, project,
  document, content revision and generation. Resending the same confirmed save
  after an unknown outcome is idempotent: the server answers 409, which is
  treated as "already accepted". After a confirmed deletion or a definite
  failure, the generation advances, so a later save gets a new operation id.
  If the server acknowledges a different operation id, the receipt stores it
  and status checks use the server's id.
- **Receipts:** stored at `~/.pi/agent/.cache/smart-compact/hindsight-receipts.json`
  (next to the context graph). They are keyed by origin, bank, project,
  document and revision, so changing the target can never resolve or report
  another server's state. There are at most 500 receipts. Completed, failed
  and deleted receipts are pruned oldest-first. Open receipts are never
  evicted: new remote saves are refused until they are refreshed, and the
  refusal names the receipts file.

Receipt states and how the tools report them:

| State | Meaning | Tool wording |
| --- | --- | --- |
| `submitted` | Request sent; no response yet | — |
| `accepted` | Async operation acknowledged; extraction still running | "accepted, NOT yet searchable" |
| `completed` | Operation completed | "completed … indexed and searchable" |
| `failed` | Server refused the request, or the operation failed or was cancelled | "FAILED" |
| `unknown` | Timeout or network error after sending; the server may have accepted it | "outcome unknown … safe to retry" |
| `deleted` | The owned document was deleted by a confirmed resolve | "deleted document …" |

Status checks are bounded:

- A save makes one status check right after acceptance.
- `smart_recall` refreshes at most 3 open receipts per call — including
  `unknown` ones, which also count against the ledger cap — and lists
  documents that are not yet searchable. An `unknown` receipt stays `unknown`
  on `not_found` (delayed acceptance or pruned status record); a definitive
  terminal status (`completed`/`failed`) frees it. A receipt whose operation
  the server has reported missing for 24 hours since its last state change is
  marked `failed` (`not_found`) so the ledger drains. Uncertain receipts are
  never auto-retried as writes.
- If a retain completed but the local receipt could not be updated (for
  example, another process held the ledger lock), the save reports `unknown`
  and the next `smart_recall` refresh reconciles the receipt.

**Resolve safety:**

- Resolve addresses exactly one document, chosen by the ref. Before deleting,
  it checks open retains for that document (at most 3 status checks). Any
  submitted, accepted or unknown outcome blocks deletion: delayed completion
  could recreate the fact. A missing operation status is not proof of absence.
  The tool reports operation ids and asks for a later retry; if status was
  permanently lost, verify the operation on the server before recovery.
  `smart_recall` marks such a receipt `failed` after 24 hours missing, which
  then unblocks deletion. A deletion marks only the receipts it checked, so a
  save that lands meanwhile stays open. The extension never removes a lock
  automatically.

**Failure honesty:** remote failure is never silent and never triggers a
fallback. The tool text and `details.remote` always carry the remote state;
`failed` and `unknown` outcomes leave every other store untouched (no local
graph file is even created). "Queued" is never reported as "completed".

## Readiness

Home → **Status & help** → **Readiness & details** reports memory readiness
for the selected store only. It is read-only and sends nothing:

- **Hindsight:** checks that the server URL and an explicit bank are
  configured and, when `hindsightApiKeyEnv` is set, that the variable is
  present. Server reachability, authentication and server-side models are
  **not** verified, and no server is installed, started, or configured.
- **Local:** reflects `contextGraphEnabled`.
- **Mnemopi:** checks the optional component, the worker file, and a usable
  Bun executable: first the optional `bun` component installed beside the
  extension (resolved from package metadata and the installed layout, never
  downloaded or self-installed at runtime), then a supported Bun (>= 1.3.14)
  on `PATH`. A missing component is reported with its install command.

## Troubleshooting

| Symptom | Cause and action |
| --- | --- |
| "Project memory not changed: Hindsight is not usable (…)" or "Hindsight recall not contacted: …" | The reason names the problem: missing or invalid URL, missing bank, or a named key variable that is not set in Pi's environment. Fix the setting, or export the variable and restart Pi. |
| URL rejected | Use HTTPS. Plain `http` works only for `localhost`, `127.x` and `::1`; credentials, query and fragment are not allowed, and redirects are refused. |
| Save reports "accepted, NOT yet searchable" | Hindsight extracts asynchronously. The next `smart_recall` refreshes up to 3 open receipts and reports when the document is searchable. |
| Save reports "outcome unknown … safe to retry" | A timeout or network error after sending. Retrying the same confirmed save is idempotent (the server answers 409 for an operation it already accepted). |
| New saves refused, naming the receipts file | 500 receipts are open. Run `smart_recall` so open receipts are refreshed; receipts the server has reported missing for 24 hours are marked `failed` and free their slot. |
| Resolve refused because a retain is still open | A submitted, accepted or unknown save of that document could recreate it. Retry later; verify the operation on the server if its status was lost. |
| Resolve refused with "Switch Memory store to …" | The ref belongs to another store. Select that store to act on it. |
| `scope: "session"` recall returns nothing | Not supported on Hindsight; use project scope. |
| Readiness says complete, but requests fail | Readiness does not contact the server. Check reachability, the key and the server logs. |

## Tests

For maintainers. The test files live in the
[source repository](https://github.com/alpertarhan/pi-smart-compact/tree/main/test),
not in the npm package.

- `test/hindsight-client.test.ts`: HTTP contract against a loopback fake —
  payload shapes, auth, strict tags, path encoding, conflict, redirect refusal,
  response caps, timeout, network errors, and no secret leakage.
- `test/hindsight-memory.test.ts`: end-to-end tool behaviour — confirmation
  destination, non-interactive refusal, scrubbing, the accepted, unknown and
  failed lifecycle, idempotent retry, exclusive-store isolation across
  backend switches (no local fallback on failure/unknown/misconfiguration,
  old data unchanged, foreign refs refused), resolve racing a pending
  retain, target-scoped receipts, cap blocking, render caps and injection
  neutralization.
- `test/hindsight-config.test.ts`: validation, defaults, stale-key removal
  and hot-apply.
- `test/context-tools.test.ts` and `test/context-graph.test.ts`:
  backend-exclusivity regressions at the tool and index layers (mnemopi-only
  recall cannot see local facts, mid-drain backend switches cancel queued
  index jobs without creating the graph).
- `test/memory-backend.test.ts`: Bun executable resolution (installed
  component metadata/layout, placeholder rejection, platform fallback,
  traversal refusal), version gate, readiness evidence, and the
  exclusive-policy guard.
- `test/hindsight-live.canary.ts`: opt-in live canary. It is not run by
  `bun test`.

  ```sh
  PSC_HINDSIGHT_LIVE=1 PSC_HINDSIGHT_URL=https://… PSC_HINDSIGHT_BANK=… \
  PSC_HINDSIGHT_KEY_ENV=HINDSIGHT_API_TOKEN bun run test/hindsight-live.canary.ts
  ```

  - A fetch guard enforces a hard budget: 1 retain, at most 10 status checks,
    1 recall, 1 delete. There are no retries.
  - It uses a synthetic fact under a unique per-run project tag, and cleanup
    deletes only that owned document.
  - `HOME` is a temporary directory during the run.
  - Only ids, states and counts are printed.
  - If cleanup cannot be confirmed, it reports the owned document and
    operation ids.

  Last run (2026-09-24, API 0.9.2): accepted → completed after 4 status
  checks; recall returned 1 in-scope fact from the owned document; the server
  reported the document deleted (1 memory unit). There was no extra call to
  verify the deletion independently.
