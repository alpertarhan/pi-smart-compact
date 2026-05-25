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
import { complete } from "@earendil-works/pi-ai";
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
