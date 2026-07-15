/**
 * LLM client seam.
 *
 * Confirms that `trackedComplete` resolves the active client at call time,
 * which is the mechanism that lets tests substitute a fake without touching
 * `complete` from pi-ai. Also verifies `resetLlmClient` restores the default.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { setLlmClient, resetLlmClient, defaultLlmClient, getLlmClient, rawLlmClient } from "../src/infra/llm-client.ts";
import { createServices } from "../src/infra/services.ts";
import { trackedComplete } from "../src/utils/cache.ts";
import type { Model, Api } from "@earendil-works/pi-ai";

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

    await rawLlmClient.complete(openaiModel!, {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    }, {
      apiKey: "test",
      reasoning: "low",
      onPayload: (value) => {
        payload = value;
        throw new Error("payload captured");
      },
    });

    expect(payload?.reasoning?.effort).toBe("low");
  });

  it("resetLlmClient restores the default", () => {
    setLlmClient({ complete: async () => ({} as any) });
    resetLlmClient();
    expect(getLlmClient()).toBe(defaultLlmClient);
  });
});
