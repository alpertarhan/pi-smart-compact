/**
 * LLM client seam.
 *
 * Production requests go through the requesting session's public model
 * runtime (`ctx.modelRegistry`), never pi-ai's standalone completers: only the
 * session runtime applies request-time auth, OAuth and extension provider
 * overrides registered with `pi.registerProvider` (e.g. a subscription
 * adapter that owns final payload normalization). Clients are built per run
 * from that runtime, so one session can never route through another's.
 *
 * Test fakes need to assert which `phase` was used, control failures, and
 * return synthetic usage tokens, so `setLlmClient` installs a process-wide
 * test override that takes precedence over every run's runtime client.
 *
 * The interface is intentionally narrow: a single `complete()` method matching
 * the pi-ai shape, plus the same options object existing callers already pass.
 * Provider-specific `stream()` keeps existing calls; `streamSimple()` is used
 * when generic reasoning is explicitly configured.
 */

import type {
  Model,
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getProviderCaps } from "../utils/tokens.ts";

export type LlmCompleteOptions = SimpleStreamOptions & {
  codexWatchdogMs?: number;
};

/** The public session model runtime slice used for requests (`ctx.modelRegistry`). */
export interface LlmModelRuntime {
  stream(model: Model<Api>, context: Context, options?: ProviderStreamOptions): AssistantMessageEventStream;
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/** `ctx.modelRegistry.isUsingOAuth(model)`, false when unavailable or throwing. */
export function usesOAuth(ctx: { modelRegistry?: unknown }, model: Model<Api>): boolean {
  const registry = ctx.modelRegistry as { isUsingOAuth?: (model: Model<Api>) => boolean } | undefined;
  try {
    return registry?.isUsingOAuth?.(model) === true;
  } catch {
    return false;
  }
}

function openStream(
  runtime: LlmModelRuntime,
  model: Model<Api>,
  body: Context,
  opts: LlmCompleteOptions,
): AssistantMessageEventStream {
  // The runtime resolves auth per request: an explicit `apiKey` would force its
  // API-key path and skip stored OAuth, and the pre-resolved headers are the
  // ones it merges itself. Stage auth stays a preflight availability check.
  const { apiKey: _apiKey, headers: _headers, ...options } = opts;
  return options.reasoning === undefined
    ? runtime.stream(model, body, options as ProviderStreamOptions)
    : runtime.streamSimple(model, body, options);
}

export interface LlmClient {
  complete(
    model: Model<Api>,
    body: Context,
    opts: LlmCompleteOptions,
  ): Promise<AssistantMessage>;
}

export function isChatGptCodex(model: Model<Api>): boolean {
  if (model.api !== "openai-codex-responses") return false;
  return !model.baseUrl || model.baseUrl.includes("chatgpt.com");
}

/** ChatGPT rejects wire token caps; OpenAI-compatible custom Codex endpoints may accept them. */
export function withCodexWireLimit(
  model: Model<Api>,
  opts: LlmCompleteOptions,
): LlmCompleteOptions {
  if (
    model.api !== "openai-codex-responses" ||
    isChatGptCodex(model) ||
    !opts.maxTokens
  )
    return opts;
  const previous = opts.onPayload;
  return {
    ...opts,
    onPayload: async (payload, requestModel) => {
      const transformed = await previous?.(payload, requestModel);
      const body = transformed ?? payload;
      return body && typeof body === "object"
        ? {
            ...(body as Record<string, unknown>),
            max_output_tokens: opts.maxTokens,
          }
        : body;
    },
  };
}

export function resolveCodexWatchdogMs(
  maxTokens: number | undefined,
  configuredMs = 0,
): number {
  if (configuredMs > 0) return configuredMs;
  return Math.min(90_000, Math.max(15_000, 10_000 + (maxTokens ?? 4_096) * 8));
}

function streamedChars(event: AssistantMessageEvent): number {
  if (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "toolcall_delta"
  ) {
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
export function resolveProviderWatchdogMs(
  provider: string | undefined,
  maxTokens: number | undefined,
  configuredMs = 0,
): number {
  const multiplier =
    provider && configuredMs <= 0
      ? getProviderCaps(provider).timeoutMultiplier
      : 1;
  return Math.round(
    resolveCodexWatchdogMs(maxTokens, configuredMs) * multiplier,
  );
}

/** @internal Test seam for the transport deadline used by every provider. */
export async function withProviderDeadline(
  opts: LlmCompleteOptions,
  invoke: (bounded: LlmCompleteOptions) => Promise<AssistantMessage>,
  provider?: string,
): Promise<AssistantMessage> {
  if (opts.signal?.aborted)
    throw new Error("LLM request aborted before dispatch");
  const controller = new AbortController();
  // Scale the base watchdog by the provider's timeout profile: slow providers
  // (timeoutMultiplier > 1) were cut at the raw [15s, 90s] window and silently
  // degraded to deterministic fallback summaries. An explicitly configured
  // watchdog value is never scaled.
  const watchdogMs = resolveProviderWatchdogMs(
    provider,
    opts.maxTokens,
    opts.codexWatchdogMs,
  );
  const abort = Promise.withResolvers<never>();
  const abortFromCaller = () => {
    controller.abort(opts.signal?.reason);
    abort.reject(new Error("LLM request aborted by caller"));
  };
  opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    controller.abort("provider-watchdog");
    timeout.reject(
      new Error(
        "Provider watchdog stopped generation after " + watchdogMs + "ms",
      ),
    );
  }, watchdogMs);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  try {
    return await Promise.race([
      invoke({ ...opts, signal: controller.signal }),
      abort.promise,
      timeout.promise,
    ]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function completeChatGptCodex(
  runtime: LlmModelRuntime,
  model: Model<Api>,
  body: Context,
  opts: LlmCompleteOptions,
): Promise<AssistantMessage> {
  const controller = new AbortController();
  const watchdogMs = resolveCodexWatchdogMs(
    opts.maxTokens,
    opts.codexWatchdogMs,
  );
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
    const events = openStream(runtime, model, body, limited);
    let final: AssistantMessage | undefined;
    for await (const event of events) {
      visibleChars += streamedChars(event);
      if (
        !watchdogReason &&
        opts.maxTokens &&
        visibleChars > opts.maxTokens * 3
      ) {
        watchdogReason = "visible-output";
        controller.abort("codex-visible-output-cap");
      }
      if (event.type === "done") final = event.message;
      else if (event.type === "error") final = event.error;
    }
    if (watchdogReason) {
      throw new Error(
        "Codex " +
          watchdogReason +
          " watchdog stopped generation after " +
          watchdogMs +
          "ms / " +
          visibleChars +
          " streamed chars",
      );
    }
    if (!final) throw new Error("Codex stream ended without a final message");
    return assertSuccessful(final);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/** Client for one session runtime — maps generic reasoning only when explicitly configured. */
export function createModelRuntimeLlmClient(runtime: LlmModelRuntime): LlmClient {
  return {
    complete: async (model, body, originalOpts) => {
      const opts = withCodexWireLimit(model, originalOpts);
      return withProviderDeadline(
        opts,
        async (bounded) => {
          if (isChatGptCodex(model))
            return completeChatGptCodex(runtime, model, body, bounded);
          return assertSuccessful(await openStream(runtime, model, body, bounded).result());
        },
        model.provider,
      );
    },
  };
}

let _override: LlmClient | undefined;

/** The test/wrapping override, resolved at call time; undefined in production. */
export function getLlmClient(): LlmClient | undefined {
  return _override;
}

export function setLlmClient(client: LlmClient): void {
  _override = client;
}

/** Remove the override. Tests should always pair `setLlmClient` with this. */
export function resetLlmClient(): void {
  _override = undefined;
}
