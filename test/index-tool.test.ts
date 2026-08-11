import { describe, expect, it } from "bun:test";
import smartCompactExtension from "../src/index.ts";
import { BUDGET_LIMITS } from "../src/constants.ts";

describe("smart_compact tool cancellation", () => {
  it("publishes mode and aggregate token-budget controls", () => {
    let tool: any;
    smartCompactExtension({
      registerCommand: () => {},
      registerTool: (definition: any) => { if (definition.name === "smart_compact") tool = definition; },
      on: () => {},
    } as any);

    expect(tool.parameters.properties.mode.description).toContain("fast, balanced, thorough");
    expect(tool.parameters.properties.mode.description).not.toContain("aggressive");
    expect(tool.parameters.properties.max_input_tokens.description).toContain(BUDGET_LIMITS.INPUT_TOKENS.min + "-" + BUDGET_LIMITS.INPUT_TOKENS.max);
    expect(tool.parameters.properties.max_calls.description).toContain(BUDGET_LIMITS.CALLS.min + "-" + BUDGET_LIMITS.CALLS.max);
    expect(tool.parameters.properties.max_latency_ms.description).toBe("Optional pipeline cancellation budget in milliseconds (" + BUDGET_LIMITS.LATENCY_MS.min + "-" + BUDGET_LIMITS.LATENCY_MS.max + ").");
  });

  it("does not start the pipeline when the host signal is already aborted", async () => {
    let tool: any;
    smartCompactExtension({
      registerCommand: () => { /* noop */ },
      registerTool: (definition: any) => { if (definition.name === "smart_compact") tool = definition; },
      on: () => { /* noop */ },
    } as any);

    const model = { provider: "openai", id: "test", contextWindow: 100_000 };
    const ctx = {
      cwd: "/tmp",
      model,
      modelRegistry: {
        getAvailable: () => [model],
        find: () => model,
        getApiKeyAndHeaders: async () => { throw new Error("aborted pipeline must not authenticate"); },
      },
      getContextUsage: () => ({ tokens: 90_000 }),
      ui: { notify: () => { /* noop */ } },
    };
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute("call-1", {}, controller.signal, () => { /* noop */ }, ctx);

    expect(result.content[0].text).toContain("cancelled by host");
  });
});
