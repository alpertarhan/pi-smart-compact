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

import type {
  Model, Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream,
  Context, ProviderStreamOptions, SimpleStreamOptions,
} from "@earendil-works/pi-ai";

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
type StreamFn<TOptions> = (model: Model<Api>, body: Context, opts: TOptions) => AssistantMessageEventStream;
export type LlmCompleteOptions = SimpleStreamOptions & { codexWatchdogMs?: number };

let _complete: CompleteFn<ProviderStreamOptions> | null = null;
let _completeSimple: CompleteFn<SimpleStreamOptions> | null = null;
let _stream: StreamFn<ProviderStreamOptions> | null = null;
let _streamSimple: StreamFn<SimpleStreamOptions> | null = null;

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

async function resolveStream(): Promise<StreamFn<ProviderStreamOptions>> {
  if (_stream) return _stream;
  const mod = await import("@earendil-works/pi-ai/compat");
  if (typeof mod.stream !== "function") throw new Error("smart-compact: pi-ai /compat did not export stream()");
  _stream = mod.stream;
  return _stream;
}

async function resolveStreamSimple(): Promise<StreamFn<SimpleStreamOptions>> {
  if (_streamSimple) return _streamSimple;
  const mod = await import("@earendil-works/pi-ai/compat");
  if (typeof mod.streamSimple !== "function") throw new Error("smart-compact: pi-ai /compat did not export streamSimple()");
  _streamSimple = mod.streamSimple;
  return _streamSimple;
}

export interface LlmClient {
  complete(model: Model<Api>, body: Context, opts: LlmCompleteOptions): Promise<AssistantMessage>;
}

export function isChatGptCodex(model: Model<Api>): boolean {
  if (model.api !== "openai-codex-responses") return false;
  return !model.baseUrl || model.baseUrl.includes("chatgpt.com");
}

/** ChatGPT rejects wire token caps; OpenAI-compatible custom Codex endpoints may accept them. */
export function withCodexWireLimit(model: Model<Api>, opts: LlmCompleteOptions): LlmCompleteOptions {
  if (model.api !== "openai-codex-responses" || isChatGptCodex(model) || !opts.maxTokens) return opts;
  const previous = opts.onPayload;
  return {
    ...opts,
    onPayload: async (payload, requestModel) => {
      const transformed = await previous?.(payload, requestModel);
      const body = transformed ?? payload;
      return body && typeof body === "object"
        ? { ...(body as Record<string, unknown>), max_output_tokens: opts.maxTokens }
        : body;
    },
  };
}

export function resolveCodexWatchdogMs(maxTokens: number | undefined, configuredMs = 0): number {
  if (configuredMs > 0) return configuredMs;
  return Math.min(90_000, Math.max(15_000, 10_000 + (maxTokens ?? 4_096) * 8));
}

function streamedChars(event: AssistantMessageEvent): number {
  if ((event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")) {
    return event.delta.length;
  }
  return 0;
}

function assertSuccessful(message: AssistantMessage): AssistantMessage {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || "LLM request failed");
  }
  return message;
}

async function completeChatGptCodex(
  model: Model<Api>, body: Context, opts: LlmCompleteOptions,
): Promise<AssistantMessage> {
  const controller = new AbortController();
  const watchdogMs = resolveCodexWatchdogMs(opts.maxTokens, opts.codexWatchdogMs);
  let watchdogReason: "time" | "visible-output" | null = null;
  let visibleChars = 0;
  const abortFromCaller = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (opts.signal?.aborted) abortFromCaller();
  const timer = setTimeout(() => {
    watchdogReason = "time";
    controller.abort("codex-watchdog");
  }, watchdogMs);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();

  try {
    const limited = { ...opts, signal: controller.signal };
    const events = opts.reasoning === undefined
      ? (await resolveStream())(model, body, limited as ProviderStreamOptions)
      : (await resolveStreamSimple())(model, body, limited);
    let final: AssistantMessage | undefined;
    for await (const event of events) {
      visibleChars += streamedChars(event);
      if (!watchdogReason && opts.maxTokens && visibleChars > opts.maxTokens * 3) {
        watchdogReason = "visible-output";
        controller.abort("codex-visible-output-cap");
      }
      if (event.type === "done") final = event.message;
      else if (event.type === "error") final = event.error;
    }
    if (watchdogReason) {
      throw new Error(
        "Codex " + watchdogReason + " watchdog stopped generation after " +
        watchdogMs + "ms / " + visibleChars + " streamed chars",
      );
    }
    if (!final) throw new Error("Codex stream ended without a final message");
    return assertSuccessful(final);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/** Raw client — map generic reasoning only when explicitly configured. */
export const rawLlmClient: LlmClient = {
  complete: async (model, body, originalOpts) => {
    const opts = withCodexWireLimit(model, originalOpts);
    if (isChatGptCodex(model)) return completeChatGptCodex(model, body, opts);
    const response = opts.reasoning === undefined
      ? await (await resolveComplete())(model, body, opts as ProviderStreamOptions)
      : await (await resolveCompleteSimple())(model, body, opts);
    return assertSuccessful(response);
  },
};

/** Production default: never replay an expensive compaction request automatically. */
export const defaultLlmClient: LlmClient = rawLlmClient;

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
