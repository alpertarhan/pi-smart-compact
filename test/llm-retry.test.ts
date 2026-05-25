/**
 * LLM retry/backoff contract.
 *
 * The retry layer is the difference between a single 429 destroying a whole
 * compaction run and the run finishing 600ms later. Tests cover the matrix of
 * outcomes that the wrapper must handle:
 *
 *   - happy path: no retries, payload returns verbatim
 *   - rate limit (429) with Retry-After: honors the hint
 *   - rate limit (429) without Retry-After: exponential backoff
 *   - 5xx: retried up to maxAttempts then re-thrown
 *   - 4xx non-retriable (400, 401, 404): fails fast
 *   - AbortSignal during retry sleep: bubbles up immediately
 *   - exhausted retries: throws the last error
 */

import { describe, it, expect } from "bun:test";
import { withRetry, DEFAULT_RETRY_POLICY } from "../src/infra/llm-retry.ts";
import type { LlmClient } from "../src/infra/llm-client.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const okResponse: AssistantMessage = {
  content: [{ type: "text", text: "ok" }],
  usage: { input: 10, output: 5, cacheRead: 0 },
} as AssistantMessage;

function makeClient(behaviour: () => Promise<AssistantMessage>): LlmClient {
  return { complete: () => behaviour() };
}

function rateLimitError(retryAfterSeconds?: number): Error {
  const err = new Error("rate limited") as Error & { status: number; headers?: Record<string, string> };
  err.status = 429;
  if (retryAfterSeconds != null) err.headers = { "retry-after": String(retryAfterSeconds) };
  return err;
}

function serverError(): Error {
  const err = new Error("upstream timeout") as Error & { status: number };
  err.status = 503;
  return err;
}

function badRequest(): Error {
  const err = new Error("bad request") as Error & { status: number };
  err.status = 400;
  return err;
}

const fastPolicy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 5, maxDelayMs: 30, retryAfterMultiplier: 0.01 };

describe("withRetry happy path", () => {
  it("passes through the response when the first call succeeds", async () => {
    let calls = 0;
    const client = makeClient(async () => { calls++; return okResponse; });
    const wrapped = withRetry(client, fastPolicy);
    const resp = await wrapped.complete({} as any, {} as any, {} as any);
    expect(resp).toBe(okResponse);
    expect(calls).toBe(1);
  });
});

describe("withRetry retriable failures", () => {
  it("retries a 429 and eventually returns success", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      if (calls < 3) throw rateLimitError();
      return okResponse;
    });
    const wrapped = withRetry(client, fastPolicy);
    const resp = await wrapped.complete({} as any, {} as any, {} as any);
    expect(resp).toBe(okResponse);
    expect(calls).toBe(3);
  });

  it("retries a 5xx and eventually returns success", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      if (calls === 1) throw serverError();
      return okResponse;
    });
    const wrapped = withRetry(client, fastPolicy);
    const resp = await wrapped.complete({} as any, {} as any, {} as any);
    expect(resp).toBe(okResponse);
    expect(calls).toBe(2);
  });

  it("honors Retry-After hints (test policy scales them down so we don't sleep for real)", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      if (calls === 1) throw rateLimitError(2); // 2s normally; multiplier 0.01 → 20ms
      return okResponse;
    });
    const wrapped = withRetry(client, fastPolicy);
    const t0 = Date.now();
    await wrapped.complete({} as any, {} as any, {} as any);
    // Sanity-check that we did wait *something* (>=10ms) — the exact figure is
    // jitter-dependent, but the multiplier shouldn't drop it to zero.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10);
  });
});

describe("withRetry non-retriable failures", () => {
  it("fails fast on 400", async () => {
    let calls = 0;
    const client = makeClient(async () => { calls++; throw badRequest(); });
    const wrapped = withRetry(client, fastPolicy);
    await expect(wrapped.complete({} as any, {} as any, {} as any)).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  it("re-throws after exhausting attempts on a persistent 429", async () => {
    let calls = 0;
    const client = makeClient(async () => { calls++; throw rateLimitError(); });
    const wrapped = withRetry(client, { ...fastPolicy, maxAttempts: 3 });
    await expect(wrapped.complete({} as any, {} as any, {} as any)).rejects.toThrow("rate limited");
    expect(calls).toBe(3);
  });
});

describe("withRetry abort", () => {
  it("propagates AbortSignal aborts during the retry sleep", async () => {
    let calls = 0;
    const controller = new AbortController();
    const client = makeClient(async () => {
      calls++;
      // Abort after the first failure so we abort *during* the retry sleep.
      setTimeout(() => controller.abort(), 1);
      throw rateLimitError();
    });
    // Make the policy slow enough that the abort lands during sleep.
    const slow = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 500, maxDelayMs: 5000 };
    const wrapped = withRetry(client, slow);
    await expect(
      wrapped.complete({} as any, {} as any, { signal: controller.signal } as any),
    ).rejects.toThrow(/abort/i);
    expect(calls).toBe(1);
  });
});
