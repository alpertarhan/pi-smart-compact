import { describe, expect, it } from "bun:test";
import smartCompactExtension from "../src/index.ts";

describe("smart_compact tool cancellation", () => {
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

    expect(result.content[0].text).toContain("no summary was generated");
  });
});
