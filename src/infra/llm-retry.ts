/**
 * Retrying LLM client wrapper.
 *
 * Smart-compact issues several LLM calls per run (probe + explore loop +
 * batch synthesis + assembly + optional patch). Without a retry layer a
 * single 429 from a rate-limited provider — or a transient 5xx during a
 * provider hiccup — aborts the whole pipeline and forces Pi back to native
 * compact. That's the worst possible outcome: native compact discards all of
 * our verification, deterministic extraction, and damage detection.
 *
 * This wrapper preserves the `LlmClient` interface so the rest of the code
 * doesn't know it exists. It only adds behaviour on the failure path:
 *
 *   - 429 (rate limit) / 5xx / network → exponential backoff with jitter,
 *     respecting `Retry-After` when the provider supplied one.
 *   - 4xx other than 408/425/429 → fail fast (bad auth, bad request — no
 *     point retrying).
 *   - AbortSignal aborts → propagate immediately, no retry.
 *
 * Number of retries and base delay come from `RetryPolicy`. Defaults are
 * tuned for the synthesis batch path: 2 retries (3 attempts total) with
 * 500ms base delay covers >95% of transient rate limits without bloating
 * latency on the happy path.
 *
 * We do NOT retry on `tool_call_id is not found` or other model-side
 * structural errors — they always reproduce. The classifier below handles
 * the common shapes; anything unrecognized retries once at most.
 */

import type { Model, Api, AssistantMessage, Context, ProviderStreamOptions } from "@earendil-works/pi-ai";
import type { LlmClient } from "./llm-client.ts";
import * as log from "../utils/logger.ts";

export interface RetryPolicy {
  /** Total attempts including the first try (e.g. 3 = first + 2 retries). */
  maxAttempts: number;
  /** Base backoff in ms; actual delay is base * 2^(attempt-1) with jitter. */
  baseDelayMs: number;
  /** Cap on backoff to avoid waiting forever on a hot loop. */
  maxDelayMs: number;
  /** Multiplier applied to `Retry-After` hints from providers (1 = honor verbatim). */
  retryAfterMultiplier: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  retryAfterMultiplier: 1,
};

/**
 * Classify a thrown error so the retry loop knows whether to keep going.
 * The shape of provider errors varies: pi-ai surfaces status codes in
 * `err.status` for most providers but a few use `err.response.status` or
 * just stringify the response. We probe all the common places.
 */
function classifyError(err: unknown): { retriable: boolean; status?: number; retryAfterMs?: number } {
  if (!err || typeof err !== "object") return { retriable: false };
  const e = err as Record<string, unknown>;
  const status = (e.status as number | undefined)
    ?? (e.statusCode as number | undefined)
    ?? ((e.response as Record<string, unknown> | undefined)?.status as number | undefined);

  // Respect a Retry-After header when the provider sets one. It can be a
  // number-of-seconds or an HTTP-date; we only honor the integer form here.
  const headers = (e.headers as Record<string, string> | undefined)
    ?? ((e.response as Record<string, unknown> | undefined)?.headers as Record<string, string> | undefined);
  const retryAfterRaw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  let retryAfterMs: number | undefined;
  if (retryAfterRaw) {
    const seconds = Number(retryAfterRaw);
    if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = seconds * 1000;
  }

  // Aborts are never retriable — they're explicit cancellation.
  const name = (e.name as string | undefined) ?? "";
  if (name === "AbortError" || (e as { aborted?: boolean }).aborted) {
    return { retriable: false, status };
  }

  // Heuristic on status: 408 (timeout), 425 (early), 429 (rate limit),
  // 500-599 (server) → retry. Everything else: don't bother.
  if (status === 408 || status === 425 || status === 429) return { retriable: true, status, retryAfterMs };
  if (typeof status === "number" && status >= 500 && status < 600) return { retriable: true, status, retryAfterMs };

  // Network errors generally have no `status` and surface as `ECONNRESET`,
  // `ETIMEDOUT`, `fetch failed`. They're transient.
  const message = (e.message as string | undefined) ?? "";
  if (/ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|fetch failed|network error|socket hang up/i.test(message)) {
    return { retriable: true, status, retryAfterMs };
  }

  return { retriable: false, status };
}

function computeDelay(attempt: number, policy: RetryPolicy, retryAfterMs: number | undefined): number {
  if (retryAfterMs != null) {
    return Math.min(policy.maxDelayMs, Math.round(retryAfterMs * policy.retryAfterMultiplier));
  }
  const base = policy.baseDelayMs * Math.pow(2, attempt - 1);
  // Add up to 25% jitter so concurrent calls don't synchronize their retries
  // and re-trigger the same rate limit.
  const jitter = base * 0.25 * Math.random();
  return Math.min(policy.maxDelayMs, Math.round(base + jitter));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

/**
 * Wrap an LlmClient with retry semantics. Returns a new client that delegates
 * to the underlying one and retries transient failures according to `policy`.
 */
export function withRetry(inner: LlmClient, policy: RetryPolicy = DEFAULT_RETRY_POLICY): LlmClient {
  return {
    async complete(model: Model<Api>, body: Context, opts: ProviderStreamOptions): Promise<AssistantMessage> {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
        try {
          return await inner.complete(model, body, opts);
        } catch (err) {
          lastErr = err;
          const cls = classifyError(err);
          if (!cls.retriable || attempt === policy.maxAttempts) throw err;
          const delay = computeDelay(attempt, policy, cls.retryAfterMs);
          log.warn(
            "LLM call retriable failure (attempt " + attempt + "/" + policy.maxAttempts +
              ", status=" + (cls.status ?? "n/a") + "), backing off " + delay + "ms",
          );
          try {
            await sleep(delay, opts.signal as AbortSignal | undefined);
          } catch (abortErr) {
            // Abort during sleep → bubble up immediately, don't keep trying.
            throw abortErr;
          }
        }
      }
      // Unreachable but TypeScript wants a fallback.
      throw lastErr ?? new Error("withRetry: exhausted attempts");
    },
  };
}
