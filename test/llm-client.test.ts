/**
 * LLM client seam.
 *
 * Confirms that `trackedComplete` resolves the active client at call time,
 * which is the mechanism that lets tests substitute a fake without touching
 * `complete` from pi-ai. Also verifies `resetLlmClient` restores the default.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { setLlmClient, resetLlmClient, defaultLlmClient, getLlmClient } from "../src/infra/llm-client.ts";
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

  it("resetLlmClient restores the default", () => {
    setLlmClient({ complete: async () => ({} as any) });
    resetLlmClient();
    expect(getLlmClient()).toBe(defaultLlmClient);
  });
});
