import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import smartCompactExtension from "../src/index.ts";
import { branchEntryIds } from "../src/infra/session-identity.ts";
import { resetLlmClient, setLlmClient } from "../src/infra/llm-client.ts";
import { loadProjectFingerprint } from "../src/utils/fingerprint.ts";
import { resetConfigCache } from "../src/utils/helpers.ts";
import { loadScopedCompactionState } from "../src/utils/state.ts";
import { readMetricsLog } from "../src/utils/cache.ts";
import {
  makeTokenEstimator,
  TokenCalibrationStore,
} from "../src/utils/tokens.ts";

const originalHome = process.env.HOME;
let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-lifecycle-e2e-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "psc-lifecycle-project-"));
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({
      smartCompact: {
        autoTrigger: true,
        autoTriggerTimeoutMs: 120_000,
        minContextPercent: 0,
        mode: "fast",
        backupEnabled: false,
        profiles: {
          aggressive: {
            summaryBudgetTokens: 3_000,
            keepRecentTokens: 10_000,
            minChunkTokens: 300,
            maxChunkTokens: 6_000,
            singlePassMaxTokens: 100_000,
            batchMaxTokens: 18_000,
          },
        },
        contextGraphEnabled: false,
        requireApproval: false,
      },
    }),
  );
  process.env.HOME = home;
  resetConfigCache();
  resetLlmClient();
});

afterEach(() => {
  resetLlmClient();
  process.env.HOME = originalHome;
  resetConfigCache();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function activeBranch() {
  return Array.from({ length: 52 }, (_, index) => {
    const role = index % 2 === 0 ? "user" : "assistant";
    const evidence =
      index === 0
        ? "Preserve lifecycle continuity. We decided to use SQLite. "
        : role === "user"
          ? "Lifecycle evidence segment. "
          : "Lifecycle evidence recorded. ";
    return {
      type: "message",
      id: "entry-" + index,
      parentId: index > 0 ? "entry-" + (index - 1) : null,
      timestamp: "2026-08-09T00:00:00.000Z",
      message: {
        role,
        content: [{ type: "text", text: evidence + "x".repeat(12_000) }],
      },
    };
  });
}

describe("extension lifecycle end to end", () => {
  it("runs auto compaction through correlated host apply exactly once", async () => {
    const handlers = new Map<
      string,
      Array<(event: any, ctx: any) => unknown>
    >();
    const extensionApi = new Proxy(
      {
        on: (name: string, handler: (event: any, ctx: any) => unknown) => {
          const list = handlers.get(name) ?? [];
          list.push(handler);
          handlers.set(name, list);
        },
        registerCommand: () => {},
        registerTool: () => {},
      },
      {
        get(target, key) {
          return key in target ? target[key as keyof typeof target] : () => {};
        },
      },
    );
    smartCompactExtension(extensionApi as any);

    const branch = activeBranch();
    const estimator = makeTokenEstimator(
      "openai",
      "lifecycle",
      new TokenCalibrationStore(),
    );
    const totalTokens = branch.reduce(
      (sum, entry) => sum + estimator.message(entry.message as any),
      0,
    );
    const notifications: string[] = [];
    const widgets: Array<unknown> = [];
    const model = {
      provider: "openai",
      id: "lifecycle",
      contextWindow: 300_000,
      maxTokens: 16_384,
    };
    const ctx = {
      hasUI: true,
      model,
      modelRegistry: {
        getAvailable: () => [model],
        find: () => model,
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: "test-key",
          headers: {},
        }),
      },
      sessionManager: {
        getBranch: () => branch,
        buildContextEntries: () => branch,
        getSessionId: () => "lifecycle-session",
      },
      getContextUsage: () => ({
        tokens: totalTokens,
        contextWindow: model.contextWindow,
        percent: (totalTokens / model.contextWindow) * 100,
      }),
      compact: () => {
        throw new Error(
          "auto hook must return its compaction instead of calling compact()",
        );
      },
      ui: {
        notify: (message: string) => notifications.push(message),
        setWidget: (_key: string, value: unknown) => widgets.push(value),
        setStatus: () => {},
        custom: async () => null,
      },
    };
    setLlmClient({
      complete: async () =>
        ({
          role: "assistant",
          content: [
            {
              type: "text",
              text:
                "## Goal\nPreserve lifecycle continuity\n\n" +
                "## Progress\n### Done\n- No completion claimed\n### In Progress\n- Preserve lifecycle continuity\n### Blocked\n- None\n\n" +
                "## Key Decisions\n- Use SQLite\n\n" +
                "## Critical Context\n- Lifecycle evidence remains active",
            },
          ],
          usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
          stopReason: "endTurn",
        }) as any,
    });

    const before = handlers.get("session_before_compact")![0];
    const response = (await before(
      { reason: "threshold", signal: new AbortController().signal },
      ctx,
    )) as any;
    if (!response?.compaction) {
      throw new Error(
        "auto hook returned no compaction: " +
          JSON.stringify({ totalTokens, notifications }),
      );
    }
    expect(response?.compaction?.summary).toContain(
      "Preserve lifecycle continuity",
    );
    expect(response?.compaction?.details?.runId).toBeString();
    expect(widgets.some((value) => value != null)).toBe(true);

    const projectId = response.compaction.details.compactionState.scope
      .projectId as string;
    expect(loadProjectFingerprint(projectId)).toBeNull();
    const applied = handlers.get("session_compact")![0];
    const event = {
      fromExtension: true,
      compactionEntry: {
        id: "compaction-entry",
        details: response.compaction.details,
      },
    };
    await applied(event, ctx);

    const fingerprint = loadProjectFingerprint(projectId);
    if (!fingerprint) {
      throw new Error(
        "confirmed apply did not persist: " +
          JSON.stringify({
            notifications,
            runId: response.compaction.details.runId,
            metrics: readMetricsLog(),
          }),
      );
    }
    expect(fingerprint.sessionCount).toBe(1);
    expect(
      loadScopedCompactionState(
        { projectId, sessionId: "lifecycle-session" },
        branchEntryIds(branch),
      )?.goal,
    ).toContain("Lifecycle evidence segment");
    expect(
      readMetricsLog().filter(
        (entry) =>
          entry.sessionId === "lifecycle-session" && entry.status === "success",
      ),
    ).toHaveLength(1);
    expect(
      notifications.some((message) =>
        message.toLowerCase().includes("applied"),
      ),
    ).toBe(true);

    await applied(event, ctx);
    expect(loadProjectFingerprint(projectId)?.sessionCount).toBe(1);
    expect(
      readMetricsLog().filter(
        (entry) =>
          entry.sessionId === "lifecycle-session" && entry.status === "success",
      ),
    ).toHaveLength(1);

    const shutdown = handlers.get("session_shutdown")![0];
    await shutdown({}, ctx);
  }, 20_000);

  it("requests proactive compaction through the existing correlated host lifecycle", async () => {
    const settingsFile = path.join(home, ".pi", "agent", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    settings.smartCompact.autoTriggerStrategy = "settled";
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    resetConfigCache();

    const handlers = new Map<
      string,
      Array<(event: any, ctx: any) => unknown>
    >();
    const tools = new Map<string, any>();
    const extensionApi = new Proxy(
      {
        on: (name: string, handler: (event: any, ctx: any) => unknown) => {
          const list = handlers.get(name) ?? [];
          list.push(handler);
          handlers.set(name, list);
        },
        registerCommand: () => {},
        registerTool: (tool: any) => {
          tools.set(tool.name, tool);
        },
      },
      {
        get(target, key) {
          return key in target ? target[key as keyof typeof target] : () => {};
        },
      },
    );
    smartCompactExtension(extensionApi as any);

    const branch = activeBranch();
    const estimator = makeTokenEstimator(
      "openai",
      "lifecycle-settled",
      new TokenCalibrationStore(),
    );
    const totalTokens = branch.reduce(
      (sum, entry) => sum + estimator.message(entry.message as any),
      0,
    );
    const model = {
      provider: "openai",
      id: "lifecycle-settled",
      contextWindow: 300_000,
      maxTokens: 16_384,
    };
    const appliedRunIds: string[] = [];
    const notifications: string[] = [];
    let compactRequests = 0;
    let llmCalls = 0;
    let sessionId = "settled-lifecycle-session";
    let ctx: any;

    ctx = {
      hasUI: true,
      model,
      modelRegistry: {
        getAvailable: () => [model],
        find: () => model,
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: "test-key",
          headers: {},
        }),
      },
      sessionManager: {
        getBranch: () => branch,
        buildContextEntries: () => branch,
        getSessionId: () => sessionId,
      },
      getContextUsage: () => ({
        tokens: totalTokens,
        contextWindow: model.contextWindow,
        percent: (totalTokens / model.contextWindow) * 100,
      }),
      isIdle: () => true,
      hasPendingMessages: () => false,
      compact: (options: any) => {
        compactRequests++;
        void (async () => {
          try {
            const before = handlers.get("session_before_compact")![0];
            const response = (await before(
              { reason: "manual", signal: new AbortController().signal },
              ctx,
            )) as any;
            if (!response?.compaction)
              throw new Error("settled host request returned no compaction");
            appliedRunIds.push(response.compaction.details.runId);
            const applied = handlers.get("session_compact")![0];
            await applied(
              {
                fromExtension: true,
                compactionEntry: {
                  id: "settled-compaction-entry",
                  details: response.compaction.details,
                },
              },
              ctx,
            );
            options?.onComplete?.(response.compaction);
          } catch (error) {
            options?.onError?.(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        })();
      },
      ui: {
        notify: (message: string) => notifications.push(message),
        setWidget: () => {},
        setStatus: () => {},
        custom: async () => null,
      },
    };
    setLlmClient({
      complete: async () => {
        llmCalls++;
        return {
          role: "assistant",
          content: [
            {
              type: "text",
              text:
                "## Goal\nPreserve lifecycle continuity\n\n" +
                "## Progress\n### Done\n- No completion claimed\n### In Progress\n- Preserve lifecycle continuity\n### Blocked\n- None\n\n" +
                "## Key Decisions\n- Use SQLite\n\n" +
                "## Critical Context\n- Lifecycle evidence remains active",
            },
          ],
          usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
          stopReason: "endTurn",
        } as any;
      },
    });

    const settled = handlers.get("agent_settled")![0];
    await settled({ type: "agent_settled" }, ctx);

    expect(compactRequests).toBe(1);
    expect(llmCalls).toBe(1);
    expect(appliedRunIds).toHaveLength(1);
    expect(
      readMetricsLog().filter(
        (entry) =>
          entry.sessionId === "settled-lifecycle-session" &&
          entry.status === "success" &&
          entry.runId === appliedRunIds[0],
      ),
    ).toHaveLength(1);
    expect(
      notifications.some((message) =>
        message.toLowerCase().includes("applied"),
      ),
    ).toBe(true);

    await settled({ type: "agent_settled" }, ctx);
    expect(compactRequests).toBe(1);
    expect(llmCalls).toBe(1);

    sessionId = "settled-tool-session";
    const callsBeforeTool = llmCalls;
    const toolResult = await tools
      .get("smart_compact")
      .execute(
        "tool-call",
        { mode: "fast" },
        new AbortController().signal,
        () => {},
        ctx,
      );
    const stagedRunId = toolResult.details?.runId;
    expect(stagedRunId).toBeString();
    expect(llmCalls).toBe(callsBeforeTool + 1);

    await settled({ type: "agent_settled" }, ctx);
    expect(compactRequests).toBe(2);
    expect(llmCalls).toBe(callsBeforeTool + 1);
    expect(appliedRunIds.at(-1)).toBe(stagedRunId);
    expect(
      readMetricsLog().filter(
        (entry) =>
          entry.sessionId === "settled-tool-session" &&
          entry.status === "success" &&
          entry.runId === stagedRunId,
      ),
    ).toHaveLength(1);

    const shutdown = handlers.get("session_shutdown")![0];
    await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
  }, 15_000);
});
