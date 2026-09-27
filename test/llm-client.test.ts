/// <reference types="bun" />

/** Provider-bound request limits, routing, and bounded failure behavior. */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  resetLlmClient,
  setLlmClient,
  isChatGptCodex,
  resolveCodexWatchdogMs,
  resolveProviderWatchdogMs,
  withCodexWireLimit,
  withProviderDeadline,
} from "../src/infra/llm-client.ts";
import type { LlmCompleteOptions } from "../src/infra/llm-client.ts";
import { createServices } from "../src/infra/services.ts";
import { trackedComplete } from "../src/utils/cache.ts";
import type { Model, Api, AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as stockStreamSimple } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = {
  id: "test-model",
  provider: "openai",
  contextWindow: 128000,
} as Model<Api>;

describe("llm-client seam", () => {
  beforeEach(() => {
    resetLlmClient();
  });
  afterEach(() => {
    resetLlmClient();
  });

  it("refuses an oversized stage request before reserving budget or dispatching", async () => {
    let dispatches = 0;
    const services = createServices({
      llm: {
        complete: async () => {
          dispatches++;
          throw new Error("unexpected provider dispatch");
        }
      }
    });
    await expect(trackedComplete("batch", { ...model, contextWindow: 8192, maxTokens: 256 },
      { systemPrompt: "x".repeat(48_000), messages: [] },
      { apiKey: "synthetic", maxTokens: 256 }, services,
    )).rejects.toMatchObject({ name: "ModelCapacityError", phase: "batch" });
    expect(dispatches).toBe(0);
    expect(services.budget.callCount()).toBe(0);
  });

  it("includes clamped output headroom in capacity admission", async () => {
    let dispatches = 0;
    const services = createServices({
      llm: {
        complete: async () => {
          dispatches++;
          throw new Error("unexpected provider dispatch");
        }
      }
    });
    await expect(trackedComplete("patch", { ...model, contextWindow: 8192, maxTokens: 8192 },
      { systemPrompt: "short request", messages: [] },
      { apiKey: "synthetic", maxTokens: 100_000 }, services,
    )).rejects.toMatchObject({ name: "ModelCapacityError", phase: "patch" });
    expect(dispatches).toBe(0);
    expect(services.budget.callCount()).toBe(0);
  });

  it("clamps every tracked request to the model output limit", async () => {
    let capturedMaxTokens: number | undefined;
    const limitedModel = { ...model, maxTokens: 2_048 } as Model<Api>;
    const services = createServices({
      llm: {
        complete: async (_model, _body, opts) => {
          capturedMaxTokens = opts.maxTokens;
          return {
            content: [],
            usage: { input: 1, output: 1, cacheRead: 0 },
          } as any;
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

  it("rejects nominally fitting requests that the SDK would shrink below their output allowance", async () => {
    let dispatches = 0;
    const services = createServices({
      llm: {
        complete: async () => {
          dispatches++;
          throw new Error("unexpected provider dispatch");
        }
      }
    });
    await expect(trackedComplete("batch", { ...model, contextWindow: 8192, maxTokens: 2048 },
      { systemPrompt: "x".repeat(12_000), messages: [] },
      { apiKey: "synthetic", maxTokens: 2048 }, services,
    )).rejects.toMatchObject({ name: "ModelCapacityError", phase: "batch" });
    expect(dispatches).toBe(0);
    expect(services.budget.callCount()).toBe(0);
  });

  it("uses the run config snapshot by phase and preserves explicit overrides", async () => {
    const captured: unknown[] = [];
    const services = createServices({
      thinkingLevels: {
        segmentationThinkingLevel: "low",
        summaryThinkingLevel: "high",
      },
      llm: {
        complete: async (_model, _body, opts) => {
          captured.push(opts.reasoning);
          return {
            content: [],
            usage: { input: 0, output: 0, cacheRead: 0 },
          } as any;
        },
      },
    });
    const body = { systemPrompt: "x", messages: [] } as any;

    await trackedComplete("explore", model, body, { apiKey: "k" }, services);
    await trackedComplete("batch", model, body, { apiKey: "k" }, services);
    await trackedComplete(
      "patch",
      model,
      body,
      { apiKey: "k", reasoning: "minimal" },
      services,
    );

    expect(captured).toEqual(["low", "high", "minimal"]);
  });

  it("routes each run through its own session runtime and registered provider override", async () => {
    const wire: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const chunk = (payload: unknown) => "data: " + JSON.stringify(payload) + "\n\n";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        wire.push({ headers: request.headers, body: JSON.parse(await request.text()) });
        return new Response(
          chunk({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }) +
            chunk({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }) +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "llm-runtime-"));
    // One runtime per session, each with its own credential and provider override.
    const session = async (name: string) => {
      const authPath = path.join(home, name + "-auth.json");
      fs.writeFileSync(authPath, JSON.stringify({ loopback: { type: "api_key", key: "key-" + name } }), { mode: 0o600 });
      const runtime = await ModelRuntime.create({
        authPath, modelsPath: null, modelsStorePath: path.join(home, name + "-models.json"),
        allowModelNetwork: false, refreshOnCreate: false,
      });
      runtime.registerProvider("loopback", {
        api: "openai-completions",
        baseUrl: String(server.url),
        models: [{ id: "m1", name: "M1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_000, maxTokens: 1_000 }],
        // Like a subscription adapter: own headers, and final payload normalization after the caller's hook.
        streamSimple: (target: Model<Api>, context: Context, options?: SimpleStreamOptions) => stockStreamSimple(target, context, {
          ...options,
          headers: { ...options?.headers, "x-session": name },
          onPayload: async (payload, requestModel) => {
            const next = ((await options?.onPayload?.(payload, requestModel)) ?? payload) as Record<string, unknown>;
            return { ...next, normalized: name + (next.caller === true ? "+caller" : "") };
          },
        }),
      });
      return { runtime, model: runtime.getModel("loopback", "m1")! };
    };
    try {
      const a = await session("a");
      const b = await session("b");
      const body = { systemPrompt: "s", messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 1 }] };
      const noReasoning = { summaryThinkingLevel: null, segmentationThinkingLevel: null } as const;
      const servicesA = createServices({ modelRuntime: a.runtime, thinkingLevels: noReasoning });
      const servicesB = createServices({ modelRuntime: b.runtime });
      const caller = { apiKey: "stage-key", maxTokens: 50, onPayload: (payload: unknown) => ({ ...(payload as object), caller: true }) };

      await trackedComplete("single-pass", a.model, body, caller, servicesA);
      await trackedComplete("single-pass", b.model, body, { ...caller, reasoning: "low" }, servicesB);

      expect(wire.map(({ headers }) => [headers.get("x-session"), headers.get("authorization")])).toEqual([
        ["a", "Bearer key-a"],
        ["b", "Bearer key-b"],
      ]);
      expect(wire[0].body).toMatchObject({ caller: true, normalized: "a+caller" });
      expect(wire[0].body.reasoning_effort).toBeUndefined();
      expect(wire[1].body).toMatchObject({ caller: true, normalized: "b+caller", reasoning_effort: "low" });

      // A test override still wins over every run's runtime, even when installed late.
      setLlmClient({ complete: async () => ({ role: "assistant", content: [], usage: { input: 1, output: 1 } }) as unknown as AssistantMessage });
      await trackedComplete("single-pass", a.model, body, caller, servicesA);
      expect(wire).toHaveLength(2);
    } finally {
      server.stop(true);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not retry provider requests and caches the growing exploration loop", async () => {
    const captured: any[] = [];
    const services = createServices({
      llm: {
        complete: async (_model, _body, opts) => {
          captured.push(opts);
          return {
            content: [],
            usage: { input: 10, output: 1, cacheRead: 0 },
          } as any;
        },
      },
    });
    const body = { systemPrompt: "x", messages: [] } as any;

    await trackedComplete(
      "explore-loop",
      model,
      body,
      { apiKey: "k" },
      services,
    );
    await trackedComplete("batch", model, body, { apiKey: "k" }, services);

    expect(captured[0]).toMatchObject({
      maxRetries: 0,
      cacheRetention: "short",
      sessionId: services.compactSessionId,
    });
    expect(captured[1]).toMatchObject({
      maxRetries: 0,
      cacheRetention: "none",
    });
    expect(captured[1].sessionId).toBeUndefined();
  });

  it("uses a watchdog for ChatGPT Codex and a wire cap for custom Codex endpoints", async () => {
    const chatgpt = {
      ...model,
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    } as any;
    const custom = { ...chatgpt, baseUrl: "https://codex-proxy.example/v1" };
    const opts: any = {
      maxTokens: 1234,
      onPayload: (payload: any) => ({ ...payload, chained: true }),
    };

    expect(isChatGptCodex(chatgpt)).toBe(true);
    expect(withCodexWireLimit(chatgpt, opts)).toBe(opts);
    const limited = withCodexWireLimit(custom, opts);
    expect(await limited.onPayload?.({ model: "x" }, custom)).toEqual({
      model: "x",
      chained: true,
      max_output_tokens: 1234,
    });
  });

  it("derives a bounded Codex watchdog and accepts a calibrated override", () => {
    expect(resolveCodexWatchdogMs(1)).toBe(15_000);
    expect(resolveCodexWatchdogMs(4_096)).toBe(42_768);
    expect(resolveCodexWatchdogMs(128_000)).toBe(90_000);
    expect(resolveCodexWatchdogMs(4_096, 25_000)).toBe(25_000);
  });

  it("uses provider timeout profiles and leaves explicit watchdogs unchanged", () => {
    expect(resolveProviderWatchdogMs("openai", 1)).toBe(15_000);
    expect(resolveProviderWatchdogMs("anthropic", 1)).toBe(18_000);
    expect(resolveProviderWatchdogMs("kimi-coding", 1)).toBe(22_500);
    expect(resolveProviderWatchdogMs("kimi-coding", 1, 321)).toBe(321);
  });

  it("releases a hung provider call at the configured hard deadline", async () => {
    const never = Promise.withResolvers<AssistantMessage>();
    let aborted = false;
    const startedAt = Date.now();
    await expect(
      withProviderDeadline(
        { apiKey: "k", codexWatchdogMs: 10 } satisfies LlmCompleteOptions,
        async (bounded) => {
          bounded.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          return never.promise;
        },
      ),
    ).rejects.toThrow("Provider watchdog");
    expect(aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

});
