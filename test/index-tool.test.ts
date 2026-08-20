import { describe, expect, it } from "bun:test";
import smartCompactExtension from "../src/index.ts";
import { BUDGET_LIMITS } from "../src/constants.ts";
import { registerSmartCompactTool } from "../src/app/register-smart-compact-tool.ts";

describe("smart_compact tool cancellation", () => {
  it("keeps manual settings explicit when TUI is unavailable", async () => {
    let command: any;
    const notifications: Array<{ message: string; level: string }> = [];
    smartCompactExtension({
      registerCommand: (name: string, definition: any) => {
        if (name === "smart-compact") command = definition;
      },
      registerTool: () => {},
      on: () => {},
    } as any);

    await command.handler("settings", {
      mode: "rpc",
      waitForIdle: async () => {},
      modelRegistry: { getAvailable: () => [] },
      ui: {
        notify: (message: string, level: string) =>
          notifications.push({ message, level }),
      },
    });

    expect(notifications).toEqual([
      {
        message:
          "Smart Compact settings require TUI mode. Use settings.json for permanent defaults.",
        level: "warning",
      },
    ]);
  });

  it("publishes mode and aggregate token-budget controls", () => {
    let tool: any;
    smartCompactExtension({
      registerCommand: () => {},
      registerTool: (definition: any) => {
        if (definition.name === "smart_compact") tool = definition;
      },
      on: () => {},
    } as any);

    expect(tool.parameters.properties.mode.description).toContain(
      "fast, balanced, thorough",
    );
    expect(tool.parameters.properties.mode.description).not.toContain(
      "aggressive",
    );
    expect(tool.parameters.properties.max_input_tokens.description).toContain(
      BUDGET_LIMITS.INPUT_TOKENS.min + "-" + BUDGET_LIMITS.INPUT_TOKENS.max,
    );
    expect(tool.parameters.properties.max_calls.description).toContain(
      BUDGET_LIMITS.CALLS.min + "-" + BUDGET_LIMITS.CALLS.max,
    );
    expect(tool.parameters.properties.max_latency_ms.description).toBe(
      "Optional pipeline cancellation budget in milliseconds (" +
        BUDGET_LIMITS.LATENCY_MS.min +
        "-" +
        BUDGET_LIMITS.LATENCY_MS.max +
        ").",
    );
  });

  it("fails closed when a stale call arrives after the agent tool was hidden", async () => {
    let tool: any;
    registerSmartCompactTool(
      {
        registerTool: (definition: any) => {
          tool = definition;
        },
      } as any,
      {
        pendingRef: {} as any,
        runLock: {} as any,
        onNativeApplyError: () => false,
        policy: { isAgentToolEnabled: () => false } as any,
      },
    );

    const result = await tool.execute(
      "stale-call",
      {},
      new AbortController().signal,
      () => {},
      {},
    );
    expect(result.content[0].text).toContain("hidden from the agent");
    expect(result.content[0].text).toContain("/smart-compact manually");
  });

  it("throws when the compaction pipeline fails so Pi marks the tool result as an error", async () => {
    let tool: any;
    registerSmartCompactTool(
      {
        registerTool: (definition: any) => {
          tool = definition;
        },
      } as any,
      {
        pendingRef: { peek: () => undefined } as any,
        runLock: {
          acquire: () => {
            throw new Error("synthetic pipeline failure");
          },
        } as any,
        onNativeApplyError: () => false,
        policy: { isAgentToolEnabled: () => true } as any,
      },
    );
    const model = { provider: "openai", id: "test", contextWindow: 100_000 };
    let failure: unknown;
    try {
      await tool.execute(
        "failed-call",
        {},
        new AbortController().signal,
        () => {},
        {
          model,
          modelRegistry: {
            getAvailable: () => [model],
            find: () => model,
          },
          sessionManager: { getSessionId: () => "failed-session" },
          getContextUsage: () => ({ tokens: 90_000 }),
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("synthetic pipeline failure");
  });

  it("does not start the pipeline when the host signal is already aborted", async () => {
    let tool: any;
    smartCompactExtension({
      registerCommand: () => {
        /* noop */
      },
      registerTool: (definition: any) => {
        if (definition.name === "smart_compact") tool = definition;
      },
      on: () => {
        /* noop */
      },
      getActiveTools: () => ["smart_compact"],
      setActiveTools: () => {},
      appendEntry: () => {},
    } as any);

    const model = { provider: "openai", id: "test", contextWindow: 100_000 };
    const ctx = {
      cwd: "/tmp",
      model,
      modelRegistry: {
        getAvailable: () => [model],
        find: () => model,
        getApiKeyAndHeaders: async () => {
          throw new Error("aborted pipeline must not authenticate");
        },
      },
      getContextUsage: () => ({ tokens: 90_000 }),
      ui: {
        notify: () => {
          /* noop */
        },
      },
    };
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(
      "call-1",
      {},
      controller.signal,
      () => {
        /* noop */
      },
      ctx,
    );

    expect(result.content[0].text).toContain("cancelled by host");
  });
});
