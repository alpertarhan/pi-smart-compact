/**
 * LLM client seam.
 *
 * Why we have a seam at all:
 *
 *  - pi-ai's completers are the only runtime entry points into a model.
 *    Importing them directly from utility modules tied even the metrics test
 *    path to the peer dependency, which made `bun test` fail when the peer
 *    was not installed.
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
 * The default implementation keeps `complete()` for existing calls and uses
 * `completeSimple()` when generic reasoning is explicitly configured.
 * `setLlmClient` is exposed for tests and wrapping/fallback clients. Both
 * completers are resolved below through the host's compat alias.
 */

import type { Model, Api, AssistantMessage, Context, ProviderStreamOptions, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { withRetry } from "./llm-retry.ts";

// pi-ai 0.80 moved the completers to the `/compat` subpath. They are resolved
// with dynamic imports rather than static ones:
//
//  - A STATIC `import { complete }` breaks either context: the root specifier
//    has no `complete` export in raw node/test resolution, and importing the
//    `/compat` subpath statically is not aliased by some host builds and fails
//    at module load.
//  - A dynamic `import("@earendil-works/pi-ai/compat")` works in BOTH: the pi
//    host's extension loader (getAliases + VIRTUAL_MODULES) aliases the
//    `/compat` subpath to the compat entrypoint, and raw resolution finds
//    `/compat` directly. It runs on first use (never at module load), so a
//    resolution hiccup can never break extension loading, and test fakes that
//    inject their own client via setLlmClient never trigger it.
type CompleteFn<TOptions> = (model: Model<Api>, body: Context, opts: TOptions) => Promise<AssistantMessage>;
export type LlmCompleteOptions = SimpleStreamOptions;

let _complete: CompleteFn<ProviderStreamOptions> | null = null;
let _completeSimple: CompleteFn<SimpleStreamOptions> | null = null;

async function resolveComplete(): Promise<CompleteFn<ProviderStreamOptions>> {
  if (_complete) return _complete;
  const mod = await import("@earendil-works/pi-ai/compat");
  const fn = mod.complete;
  if (typeof fn !== "function") throw new Error("smart-compact: pi-ai /compat did not export complete()");
  _complete = fn;
  return fn;
}

async function resolveCompleteSimple(): Promise<CompleteFn<SimpleStreamOptions>> {
  if (_completeSimple) return _completeSimple;
  const mod = await import("@earendil-works/pi-ai/compat");
  const fn = mod.completeSimple;
  if (typeof fn !== "function") throw new Error("smart-compact: pi-ai /compat did not export completeSimple()");
  _completeSimple = fn;
  return fn;
}

export interface LlmClient {
  complete(model: Model<Api>, body: Context, opts: LlmCompleteOptions): Promise<AssistantMessage>;
}

/** Raw client — map generic reasoning only when explicitly configured. */
export const rawLlmClient: LlmClient = {
  complete: async (model, body, opts) => opts.reasoning === undefined
    ? (await resolveComplete())(model, body, opts as ProviderStreamOptions)
    : (await resolveCompleteSimple())(model, body, opts),
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
