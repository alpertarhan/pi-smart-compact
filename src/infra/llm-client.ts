/**
 * LLM client seam.
 *
 * Why we have a seam at all:
 *
 *  - `complete` from `@earendil-works/pi-ai` is the *only* runtime entry point
 *    into a model. Importing it directly from utility modules tied even the
 *    metrics test path to the peer dependency, which made `bun test` fail
 *    when the peer was not installed.
 *
 *  pi-ai 0.80 removed the standalone `complete()`/`stream()` from the package
 *  root and moved them to the `/compat` subpath. We import from `/compat`
 *  deliberately, NOT from `createModels()` + provider factories:
 *
 *    - This is a Pi *extension*. The host (pi-coding-agent) owns model/auth
 *      management via `ctx.modelRegistry` (a `ModelRegistry`), which resolves
 *      auth but exposes no `.complete()`. The host itself imports its types
 *      from `@earendil-works/pi-ai/compat`.
 *    - `createModels()` would build a *second* registry that bypasses the
 *      host's `ctx.modelRegistry` and its auth — wrong for an extension.
 *    - pi-ai's "avoid /compat" advice targets standalone bundled apps, not
 *      host-managed extensions.
 *
 *  The whole pi-coding-agent ecosystem (host + extensions) sits on `/compat`
 *  until the host finishes its ModelManager migration. The compat surface is
 *  pinned to this one file: when the host eventually offers completion on the
 *  context, change only the import + the call on line ~42 below.
 *
 *  - Test fakes need to assert which `phase` was used, control failures, and
 *    return synthetic usage tokens for calibration tests.
 *
 *  - Future provider fallback work (per `implement-llm-provider-fallback`)
 *    becomes a single-file change instead of a cross-module refactor.
 *
 * The interface is intentionally narrow: a single `complete()` method matching
 * the pi-ai shape, plus the same options object existing callers already pass.
 *
 * The default implementation (`defaultLlmClient`) calls `complete()` from
 * pi-ai. `setLlmClient` is exposed for tests and for callers that wish to
 * inject a wrapping/fallback client at extension boot.
 */

import type { Model, Api, AssistantMessage, Context, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { withRetry } from "./llm-retry.ts";

export interface LlmClient {
  complete(model: Model<Api>, body: Context, opts: ProviderStreamOptions): Promise<AssistantMessage>;
}

/** Raw client — direct pass-through to pi-ai. Tests can install this to skip retries. */
export const rawLlmClient: LlmClient = {
  complete: (model, body, opts) => complete(model, body, opts),
};

/**
 * Production default: pi-ai wrapped with the retry/backoff policy from
 * `llm-retry.ts`. The wrapper is transparent on the happy path — the first
 * `complete()` call goes straight through — but on a 429 or transient 5xx it
 * backs off exponentially with jitter so we don't waste an entire compaction
 * run on a single rate-limit blip.
 */
export const defaultLlmClient: LlmClient = withRetry(rawLlmClient);

let _client: LlmClient = defaultLlmClient;

export function getLlmClient(): LlmClient {
  return _client;
}

export function setLlmClient(client: LlmClient): void {
  _client = client;
}

/** Restore the production client. Tests should always pair `setLlmClient` with this. */
export function resetLlmClient(): void {
  _client = defaultLlmClient;
}
