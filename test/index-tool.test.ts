import { describe, expect, it } from "bun:test";
import smartCompactExtension from "../src/index.ts";
import { registerSmartCompactTool } from "../src/app/register-smart-compact-tool.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetConfigCache } from "../src/utils/config.ts";
import { recordIssue, resetIssuesForTests } from "../src/utils/issues.ts";

describe("smart_compact tool cancellation", () => {
  it("keeps fullness numbers out of the agent's text and points it to the manual option", async () => {
    let tool: any;
    registerSmartCompactTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
      pendingRef: { peek: () => undefined } as any, runLock: {} as any,
      onNativeApplyError: () => false, policy: { isAgentToolEnabled: () => true } as any,
    });
    const result = await tool.execute("low-usage", {}, undefined, () => {}, {
      model: { contextWindow: 272_000 }, getContextUsage: () => ({ tokens: 102_957 }),
      sessionManager: { getSessionId: () => "early-compact" },
    });
    expect(result.content[0].text).toBe("Compaction is not available from the agent yet. If the user asks for it, they can run /smart-compact.");
    // The numbers stay available to the human renderer.
    expect(result.details.display).toMatchObject({ state: "skipped", reason: "below-threshold", tokens: 102_957, percent: 38, window: 272_000 });
    expect(tool.description).toContain("stages");
  });
  it("includes recent issues in the agent's metrics report so a gate failure is diagnosable", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "smart-compact-tool-report-"));
    resetIssuesForTests();
    try {
      let tool: any;
      registerSmartCompactTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
        pendingRef: { peek: () => undefined } as any, runLock: {} as any,
        onNativeApplyError: () => false, policy: { isAgentToolEnabled: () => true } as any,
      });
      recordIssue({ key: "verify.gate", message: "Verification gate rejected summary (60/100, 2 unresolved gaps): Inconsistency: rule A" });
      const result = await tool.execute("report", { report: true }, undefined, () => {}, {});
      expect(result.content[0].text).toContain("Recent issues (1)");
      expect(result.content[0].text).toContain("Inconsistency: rule A");
    } finally {
      resetIssuesForTests();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("measures the agent-tool threshold against maxContextTokens when set", async () => {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "smart-compact-tool-cap-"));
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ smartCompact: { minContextPercent: 60, maxContextTokens: 200_000 } }));
    process.env.HOME = home;
    resetConfigCache();
    try {
      let tool: any;
      registerSmartCompactTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
        pendingRef: { peek: () => undefined } as any, runLock: {} as any,
        onNativeApplyError: () => false, policy: { isAgentToolEnabled: () => true } as any,
      });
      const result = await tool.execute("capped", {}, undefined, () => {}, {
        model: { contextWindow: 1_000_000 }, getContextUsage: () => ({ tokens: 100_000 }),
        sessionManager: { getSessionId: () => "capped-compact" },
      });
      // 100k of the 200k cap (not 10% of the 1M window).
      expect(result.content[0].text).not.toMatch(/\d%/);
      expect(result.details.display).toMatchObject({ percent: 50, tokens: 100_000, window: 200_000 });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      resetConfigCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
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

  it("publishes mode without per-run budget knobs (configured ceilings apply)", () => {
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
    expect(tool.parameters.properties.max_input_tokens).toBeUndefined();
    expect(tool.parameters.properties.max_calls).toBeUndefined();
    expect(tool.parameters.properties.max_latency_ms).toBeUndefined();
    expect(tool.parameters.properties.profile).toBeUndefined();
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
    expect((failure as Error).message).toContain("internal");
    // Literal first error line is shown (scrubbed, bounded) so failures are diagnosable.
    expect((failure as Error).message).toContain("(synthetic pipeline failure)");
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
