/**
 * LLM client seam.
 *
 * Confirms that `trackedComplete` resolves the active client at call time,
 * which is the mechanism that lets tests substitute a fake without touching
 * `complete` from pi-ai. Also verifies `resetLlmClient` restores the default.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  setLlmClient, resetLlmClient, defaultLlmClient, getLlmClient, rawLlmClient,
  isChatGptCodex, resolveCodexWatchdogMs, withCodexWireLimit, withProviderDeadline,
} from "../src/infra/llm-client.ts";
import type { LlmCompleteOptions } from "../src/infra/llm-client.ts";
import { createServices } from "../src/infra/services.ts";
import { trackedComplete } from "../src/utils/cache.ts";
import type { Model, Api, AssistantMessage } from "@earendil-works/pi-ai";

const model = { id: "test-model", provider: "openai", contextWindow: 128000 } as Model<Api>;

describe("llm-client seam", () => {
  beforeEach(() => { resetLlmClient(); });
  afterEach(() => { resetLlmClient(); });

  it("delegates to the installed client", async () => {
    let captured: { phase?: string; model?: Model<Api> } = {};
    setLlmClient({
      complete: async (m) => {
        captured.model = m;
        return {
          content: [{ type: "text" as const, text: "ok" }],
          usage: { input: 10, output: 5, cacheRead: 0 },
        } as any;
      },
    });

    const resp = await trackedComplete("batch", model, { systemPrompt: "x", messages: [] } as any, { apiKey: "k" } as any);
    expect(captured.model?.id).toBe("test-model");
    expect(resp.usage?.input).toBe(10);
  });

  it("clamps every tracked request to the model output limit", async () => {
    let capturedMaxTokens: number | undefined;
    const limitedModel = { ...model, maxTokens: 2_048 } as Model<Api>;
    const services = createServices({
      llm: {
        complete: async (_model, _body, opts) => {
          capturedMaxTokens = opts.maxTokens;
          return { content: [], usage: { input: 1, output: 1, cacheRead: 0 } } as any;
        },
      },
    });

    await trackedComplete(
      "batch",
      limitedModel,
      { systemPrompt: "x", messages: [] } as any,
      { apiKey: "k", maxTokens: 100_000 },
      services,
    );

    expect(capturedMaxTokens).toBe(2_048);
  });

  it("uses the run config snapshot by phase and preserves explicit overrides", async () => {
    const captured: unknown[] = [];
    const services = createServices({
      thinkingLevels: { segmentationThinkingLevel: "low", summaryThinkingLevel: "high" },
      llm: {
        complete: async (_model, _body, opts) => {
          captured.push(opts.reasoning);
          return { content: [], usage: { input: 0, output: 0, cacheRead: 0 } } as any;
        },
      },
    });
    const body = { systemPrompt: "x", messages: [] } as any;

    await trackedComplete("explore", model, body, { apiKey: "k" }, services);
    await trackedComplete("batch", model, body, { apiKey: "k" }, services);
    await trackedComplete("patch", model, body, { apiKey: "k", reasoning: "minimal" }, services);

    expect(captured).toEqual(["low", "high", "minimal"]);
  });

  it("maps generic reasoning through completeSimple before building the provider payload", async () => {
    const { getModel } = await import("@earendil-works/pi-ai/compat");
    const openaiModel = getModel("openai", "gpt-5.4");
    expect(openaiModel).toBeDefined();
    let payload: any;

    await expect(rawLlmClient.complete(openaiModel!, {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    }, {
      apiKey: "test",
      reasoning: "low",
      onPayload: (value) => {
        payload = value;
        throw new Error("payload captured");
      },
    })).rejects.toThrow("payload captured");

    expect(payload?.reasoning?.effort).toBe("low");
  });

  it("does not retry provider requests and caches the growing exploration loop", async () => {
    const captured: any[] = [];
    const services = createServices({
      llm: {
        complete: async (_model, _body, opts) => {
          captured.push(opts);
          return { content: [], usage: { input: 10, output: 1, cacheRead: 0 } } as any;
        },
      },
    });
    const body = { systemPrompt: "x", messages: [] } as any;

    await trackedComplete("explore-loop", model, body, { apiKey: "k" }, services);
    await trackedComplete("batch", model, body, { apiKey: "k" }, services);

    expect(captured[0]).toMatchObject({ maxRetries: 0, cacheRetention: "short", sessionId: services.compactSessionId });
    expect(captured[1]).toMatchObject({ maxRetries: 0, cacheRetention: "none" });
    expect(captured[1].sessionId).toBeUndefined();
  });

  it("uses a watchdog for ChatGPT Codex and a wire cap for custom Codex endpoints", async () => {
    const chatgpt = { ...model, provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" } as any;
    const custom = { ...chatgpt, baseUrl: "https://codex-proxy.example/v1" };
    const opts: any = { maxTokens: 1234, onPayload: (payload: any) => ({ ...payload, chained: true }) };

    expect(isChatGptCodex(chatgpt)).toBe(true);
    expect(withCodexWireLimit(chatgpt, opts)).toBe(opts);
    const limited = withCodexWireLimit(custom, opts);
    expect(await limited.onPayload?.({ model: "x" }, custom)).toEqual({ model: "x", chained: true, max_output_tokens: 1234 });
  });

  it("derives a bounded Codex watchdog and accepts a calibrated override", () => {
    expect(resolveCodexWatchdogMs(1)).toBe(15_000);
    expect(resolveCodexWatchdogMs(4_096)).toBe(42_768);
    expect(resolveCodexWatchdogMs(128_000)).toBe(90_000);
    expect(resolveCodexWatchdogMs(4_096, 25_000)).toBe(25_000);
  });

  it("releases a hung provider call at the configured hard deadline", async () => {
    const never = Promise.withResolvers<AssistantMessage>();
    let aborted = false;
    const startedAt = Date.now();
    await expect(withProviderDeadline(
      { apiKey: "k", codexWatchdogMs: 10 } satisfies LlmCompleteOptions,
      async bounded => {
        bounded.signal?.addEventListener("abort", () => { aborted = true; });
        return never.promise;
      },
    )).rejects.toThrow("Provider watchdog");
    expect(aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("resetLlmClient restores the default", () => {
    setLlmClient({ complete: async () => ({} as any) });
    resetLlmClient();
    expect(getLlmClient()).toBe(defaultLlmClient);
  });
});
