import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildSessionProjection, collectEntriesForBranchSummary, createEventBus, CURRENT_SESSION_VERSION, SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import smartCompactExtension from "../src/index.ts";
import { branchEntryIds } from "../src/infra/session-identity.ts";
import { resetLlmClient, setLlmClient } from "../src/infra/llm-client.ts";
import { __resetProcessCalibrationForTests } from "../src/infra/services.ts";
import { loadProjectFingerprint } from "../src/utils/fingerprint.ts";
import { resetConfigCache } from "../src/utils/helpers.ts";
import { loadScopedCompactionState } from "../src/utils/state.ts";
import { readMetricsLog } from "../src/utils/cache.ts";
import { resetIssuesForTests } from "../src/utils/issues.ts";
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
  resetIssuesForTests();
  // Reported usage in these fixtures feeds process-wide token calibration;
  // start every case from the uncalibrated estimator.
  __resetProcessCalibrationForTests();
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

/** Native notification/transform dispatch runs every handler, not just the first. */
async function dispatch(handlers: Map<string, Array<(event: any, ctx: any) => unknown>>, name: string, event: any, ctx: any): Promise<any> {
  let result: any;
  for (const handler of handlers.get(name) ?? []) {
    const next: any = await handler(event, ctx);
    if (next !== undefined) result = next;
    if (next?.cancel) break;
  }
  return result;
}

describe("extension lifecycle end to end", () => {
  it.each([false, true])("runs correlated host apply once, keeping an unmeasured model text-only (visual requested=%s)", async visual => {
    if (visual) {
      const settingsFile = path.join(home, ".pi", "agent", "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      settings.smartCompact.visualArchiveEnabled = true;
      fs.writeFileSync(settingsFile, JSON.stringify(settings));
      resetConfigCache();
    }
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
        getActiveTools: () => [],
        setActiveTools: () => {},
      },
      {
        get(target, key) {
          return key in target ? target[key as keyof typeof target] : () => {};
        },
      },
    );
    smartCompactExtension(extensionApi as any);

    const branch: any[] = activeBranch();
    if (visual) {
      branch[2].message = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "visual-read", name: "read", arguments: { path: "auth.ts" } }] };
      branch[3].message = {
        role: "toolResult", toolCallId: "visual-read", toolName: "read", isError: false,
        content: [{ type: "text", text: "ARCHIVE_ONLY_LITERAL Türkçe auth evidence and exact source locations.\n".repeat(40) }]
      };
    }
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
      api: "openai-responses",
      input: ["text", "image"],
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

    const before = (event: any, ctx: any) => dispatch(handlers, "session_before_compact", event, ctx);
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
    // This synthetic OpenAI model has no validated bitmap cost rule. Opt-in is not
    // permission to attach unprofitable/unmeasured pixels; native text must still commit.
    expect(response.compaction.details.visualArchive).toBeUndefined();
    expect(readMetricsLog().filter(entry => entry.status === "success")).toHaveLength(0);

    const projectId = response.compaction.details.compactionState.scope
      .projectId as string;
    expect(loadProjectFingerprint(projectId)).toBeNull();
    const applied = (event: unknown, ctx: unknown) => dispatch(handlers, "session_compact", event, ctx);
    const event = {
      type: "session_compact",
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
    if (visual) {
      const metrics = readMetricsLog().find(entry => entry.runId === response.compaction.details.runId)!;
      expect(metrics.visualTokens ?? 0).toBe(0);
      expect(metrics.visualFrames ?? 0).toBe(0);
      expect(JSON.stringify(metrics)).not.toContain("ARCHIVE_ONLY_LITERAL");
    }
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

    await applied(event, ctx);
    expect(loadProjectFingerprint(projectId)?.sessionCount).toBe(1);
    expect(
      readMetricsLog().filter(
        (entry) =>
          entry.sessionId === "lifecycle-session" && entry.status === "success",
      ),
    ).toHaveLength(1);

    const failedResponse = (await before(
      { reason: "threshold", signal: new AbortController().signal },
      ctx,
    )) as any;
    const failedRunId = failedResponse.compaction.details.runId as string;
    const failed = (event: unknown, ctx: unknown) => dispatch(handlers, "session_compact_failed", event, ctx);
    const failedEvent = {
      type: "session_compact_failed",
      reason: "threshold",
      errorMessage: "Compaction failed: synthetic host failure",
      aborted: false,
      willRetry: false,
      fromExtension: true,
    };
    await failed(failedEvent, ctx);
    expect(
      readMetricsLog().filter(
        (entry) => entry.runId === failedRunId && entry.status === "error",
      ),
    ).toHaveLength(1);

    // Failure delivery is idempotent, and a late success cannot commit the
    // candidate that the failed lifecycle already discarded.
    await failed(failedEvent, ctx);
    await applied(
      {
        fromExtension: true,
        compactionEntry: {
          id: "failed-compaction-entry",
          details: failedResponse.compaction.details,
        },
      },
      ctx,
    );
    expect(loadProjectFingerprint(projectId)?.sessionCount).toBe(1);
    expect(
      readMetricsLog().filter((entry) => entry.runId === failedRunId),
    ).toHaveLength(1);

    const abortedResponse = (await before(
      { reason: "threshold", signal: new AbortController().signal },
      ctx,
    )) as any;
    const abortedRunId = abortedResponse.compaction.details.runId as string;
    await failed({ ...failedEvent, errorMessage: undefined, aborted: true }, ctx);
    expect(
      readMetricsLog().filter(
        (entry) => entry.runId === abortedRunId && entry.status === "cancelled",
      ),
    ).toHaveLength(1);

    // A native failure not supplied by an extension must not touch a staged
    // smart-compaction candidate.
    const unaffectedResponse = (await before(
      { reason: "threshold", signal: new AbortController().signal },
      ctx,
    )) as any;
    const unaffectedRunId = unaffectedResponse.compaction.details.runId as string;
    await failed({ ...failedEvent, fromExtension: false }, ctx);
    await applied(
      {
        fromExtension: true,
        compactionEntry: {
          id: "unaffected-compaction-entry",
          details: unaffectedResponse.compaction.details,
        },
      },
      ctx,
    );
    expect(
      readMetricsLog().filter(
        (entry) => entry.runId === unaffectedRunId && entry.status === "success",
      ),
    ).toHaveLength(1);

    // A foreign compaction (another extension's, or Pi's own) displaces a
    // staged candidate: the candidate is recorded as discarded (neutral, not
    // a failure) and the user learns the applied summary is not Continuity's.
    const displacedResponse = (await before(
      { reason: "threshold", signal: new AbortController().signal },
      ctx,
    )) as any;
    const displacedRunId = displacedResponse.compaction.details.runId as string;
    const notificationsBefore = notifications.length;
    await applied(
      { fromExtension: true, compactionEntry: { id: "foreign-extension-entry", details: { summary: "theirs" } } },
      ctx,
    );
    expect(readMetricsLog().filter((entry) => entry.runId === displacedRunId)).toEqual([
      expect.objectContaining({ status: "discarded", fallbackReason: "native-apply:foreign" }),
    ]);
    expect(notifications.slice(notificationsBefore).join("\n")).toMatch(
      /Another extension's compaction was applied instead of Continuity's prepared summary; that summary \(\d+ model calls?\) was discarded/,
    );
    // A late apply of the displaced run cannot commit it any more.
    await applied(
      { fromExtension: true, compactionEntry: { id: "late-entry", details: displacedResponse.compaction.details } },
      ctx,
    );
    expect(loadProjectFingerprint(projectId)?.sessionCount).toBe(1);
    expect(readMetricsLog().filter((entry) => entry.runId === displacedRunId)).toHaveLength(1);

    // Pi's built-in compaction with nothing staged while automatic compaction
    // is on: one notice per session, no metrics entry.
    const metricsBefore = readMetricsLog().length;
    await applied({ fromExtension: false, compactionEntry: { id: "native-entry" } }, ctx);
    await applied({ fromExtension: false, compactionEntry: { id: "native-entry-2" } }, ctx);
    expect(readMetricsLog()).toHaveLength(metricsBefore);
    expect(notifications.filter((message) => message.includes("Pi's built-in compaction was applied without a Continuity summary"))).toHaveLength(1);

    await dispatch(handlers, "session_shutdown", {}, ctx);
  }, 20_000);

  it("commits local trimming before background preparation can snapshot stale context", async () => {
    const settingsFile = path.join(home, ".pi", "agent", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    settings.smartCompact.autoTriggerStrategy = "background";
    settings.smartCompact.minContextPercent = 80;
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    resetConfigCache();
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    smartCompactExtension({
      registerCommand() {}, registerTool() {}, getActiveTools: () => ["smart_context"],
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(name, [...handlers.get(name) ?? [], handler]);
      },
    } as any);
    const branch: any[] = [
      { type: "message", id: "goal", message: { role: "user", content: "Implement auth" } },
      { type: "message", id: "call", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read", id: "read-id", arguments: { path: "auth.ts" } }] } },
      { type: "message", id: "result", message: { role: "toolResult", toolName: "read", toolCallId: "read-id", isError: false, content: [{ type: "text", text: "source evidence".repeat(2_000) }] } },
      ...Array.from({ length: 4 }, (_, i) => ({ type: "message", id: "tail-" + i, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recent" }] } })),
    ].map((entry, index, entries) => ({ ...entry, parentId: entries[index - 1]?.id ?? null, timestamp: new Date().toISOString() }));
    let routeLookups = 0;
    const ctx: any = {
      sessionManager: { getBranch: () => branch, getSessionId: () => "trim-before-background", getSessionFile: () => undefined },
      model: { provider: "test", id: "test", contextWindow: 200_000 }, cwd,
      modelRegistry: { getAvailable: () => { routeLookups++; return []; } },
      getContextUsage: () => ({ tokens: 140_000 }),
      ui: { setStatus() {}, notify() {}, setWidget() {} },
    };
    const event: any = { type: "turn_end", outcome: "completed", entries: [], context: { pendingMessages: [] }, toolResults: [] };
    for (const handler of handlers.get("turn_end") ?? []) {
      const result: any = await handler(event, ctx);
      if (result?.entries) event.entries = result.entries;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(event.entries.some((entry: any) => entry.type === "context_edit" && entry.targetId === "result")).toBe(true);
    expect(routeLookups).toBe(0);
    expect(branch.some(entry => entry.type === "context_edit")).toBe(false); // host has not committed yet
    await dispatch(handlers, "session_shutdown", {}, ctx);
  });

  it.each([
    ["settled", "unchanged"], ["background", "unchanged"], ["background", "stale-tail"],
    ["settled", "instructions"], ["settled", "model-event"], ["settled", "model-silent"], ["settled", "grown-tail"],
    ["settled", "pivot-cancelled"], ["settled", "pivot-finished"], ["settled", "native-reserve"],
  ])("requests %s compaction through the correlated host lifecycle (%s)", async (strategy, change) => {
    const settingsFile = path.join(home, ".pi", "agent", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    settings.smartCompact.autoTriggerStrategy = strategy;
    if (strategy === "background") settings.smartCompact.minContextPercent = 80;
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    resetConfigCache();

    const handlers = new Map<
      string,
      Array<(event: any, ctx: any) => unknown>
    >();
    const tools = new Map<string, any>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const hostPrompts: Array<Promise<void>> = [];
    const events = createEventBus();
    let activeTools: string[] = [];
    const extensionApi = new Proxy(
      {
        on: (name: string, handler: (event: any, ctx: any) => unknown) => {
          const list = handlers.get(name) ?? [];
          list.push(handler);
          handlers.set(name, list);
        },
        registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
          commands.set(name, command);
        },
        registerTool: (tool: any) => {
          tools.set(tool.name, tool);
        },
        getActiveTools: () => [...activeTools],
        getAllTools: () => [...tools.values()],
        setActiveTools: (names: string[]) => {
          activeTools = names.filter(name => tools.has(name));
        },
        // Host prompt(): an extension command runs directly, without an input event.
        sendUserMessage: (text: string) => {
          const [name, ...args] = text.slice(1).split(" ");
          const command = text.startsWith("/") ? commands.get(name!) : undefined;
          if (!command) throw new Error("unexpected user message: " + text);
          hostPrompts.push(command.handler(args.join(" "), ctx));
        },
        appendEntry: () => {},
        events,
      },
      {
        get(target, key) {
          return key in target ? target[key as keyof typeof target] : () => {};
        },
      },
    );
    smartCompactExtension(extensionApi as any);
    activeTools = [...tools.keys()]; // Pi activates every registered tool until an owner narrows it.

    const header = (id: string) => ({ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: "2026-08-09T00:00:00.000Z", cwd });
    const branch = activeBranch();
    let session = SessionManager.inMemory(cwd, undefined, [header("settled-lifecycle-session"), ...branch] as FileEntry[]);
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
      contextWindow: strategy === "background" ? totalTokens / 0.75 : 300_000,
      maxTokens: 16_384,
      cost: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 },
    };
    const appliedRunIds: string[] = [];
    let compactRequests = 0;
    let llmCalls = 0;
    let usageTokens = totalTokens;
    const statusWrites: Array<string | undefined> = [];
    let ctx: any;

    ctx = {
      cwd,
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
      get sessionManager() {
        return session;
      },
      getContextUsage: () => ({
        tokens: usageTokens,
        contextWindow: model.contextWindow,
        percent: (usageTokens / model.contextWindow) * 100,
      }),
      getSystemPrompt: () => "Stable lifecycle system prompt",
      isIdle: () => true,
      hasPendingMessages: () => false,
      waitForIdle: async () => {},
      // Host navigateTree(): session_before_tree may supply the summary; the
      // summary branches at an assistant target, then session_tree is emitted.
      navigateTree: async (targetId: string, options: { summarize?: boolean }) => {
        const oldLeafId = session.getLeafId();
        const { entries, commonAncestorId } = collectEntriesForBranchSummary(session, oldLeafId, targetId);
        const result = await dispatch(handlers, "session_before_tree", {
          type: "session_before_tree", signal: new AbortController().signal,
          preparation: { targetId, oldLeafId, commonAncestorId, entriesToSummarize: entries, userWantsSummary: options.summarize ?? false },
        }, ctx);
        if (result?.cancel) return { cancelled: true };
        if (!result?.summary) throw new Error("offline host has no default branch summarizer");
        const summaryId = session.branchWithSummary(targetId, result.summary.summary, result.summary.details, true);
        await dispatch(handlers, "session_tree", {
          type: "session_tree", newLeafId: session.getLeafId(), oldLeafId, summaryEntry: session.getEntry(summaryId), fromExtension: true,
        }, ctx);
        return { cancelled: false };
      },
      compact: (options: any) => {
        compactRequests++;
        void (async () => {
          try {
            const response = (await dispatch(handlers, "session_before_compact",
              { reason: "manual", signal: new AbortController().signal },
              ctx,
            )) as any;
            if (!response?.compaction)
              throw new Error("settled host request returned no compaction");
            appliedRunIds.push(response.compaction.details.runId);
            // Provider-reported usage of the extension's own calls rides the
            // result into Pi's session totals, priced at the run model's rates.
            // The first applied run owns every call so far (settled fresh run
            // or the prepared background candidate); later runs, and the fresh
            // run after a stale discard, may reuse caches and report only
            // their own calls, or none.
            const usage = response.compaction.usage;
            if (appliedRunIds.length === 1 && change !== "stale-tail") {
              const { cost, ...tokens } = usage;
              expect(tokens).toEqual({ input: reportedInput, output: 100 * llmCalls, cacheRead: 0, cacheWrite: 0, totalTokens: reportedInput + 100 * llmCalls });
              expect(cost.input).toBeCloseTo(reportedInput / 1_000_000, 12);
              expect(cost.output).toBeCloseTo(1_000 * llmCalls / 1_000_000, 12);
              expect(cost.total).toBeCloseTo((reportedInput + 1_000 * llmCalls) / 1_000_000, 12);
            } else if (usage) {
              expect(usage.output % 100).toBe(0);
              expect(usage.cost.total).toBeCloseTo((usage.input + 10 * usage.output) / 1_000_000, 12);
            }
            if (strategy === "background" && appliedRunIds.length === 1) {
              const projected = buildSessionProjection([...session.getBranch(), {
                type: "compaction", id: "projected-apply", parentId: session.getLeafId(),
                timestamp: new Date().toISOString(), ...response.compaction,
              }]);
              expect(JSON.stringify(projected.messages)).toContain("TAIL_AFTER_BACKGROUND_SNAPSHOT");
              expect(response.compaction.tokensBefore).toBe(usageTokens);
            }
            await dispatch(handlers, "session_compact", {
              type: "session_compact",
              fromExtension: true,
              compactionEntry: {
                id: "settled-compaction-entry",
                details: response.compaction.details,
              },
            }, ctx);
            options?.onComplete?.(response.compaction);
          } catch (error) {
            options?.onError?.(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        })();
      },
      ui: {
        notify: () => {},
        setWidget: () => {},
        setStatus: (_key: string, text?: string) => { statusWrites.push(text); },
        getEditorText: () => "",
        setEditorText: () => {},
        custom: async () => null,
      },
    };
    let reportedInput = 0;
    setLlmClient({
      complete: async (_target: unknown, body: unknown) => {
        llmCalls++;
        // Realistic reported input keeps token calibration honest; output is fixed.
        const input = Math.ceil(JSON.stringify(body).length / 4);
        reportedInput += input;
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
          usage: { input, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: input + 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "endTurn",
        } as any;
      },
    });

    await dispatch(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const toolSignal = new AbortController().signal;
    const loadTools = (group: string) => tools.get("smart_tools").execute("load-" + group, { action: "load", group }, toolSignal, () => {}, ctx);

    if (strategy === "background") {
      const turnEnd = { type: "turn_end", outcome: "completed", entries: [], context: { pendingMessages: [] }, toolResults: [] };
      expect(await dispatch(handlers, "turn_end", turnEnd, ctx)).toBeUndefined();
      const backgroundStatusFrom = statusWrites.length;
      // Background preparation is silent (no footer status): wait for its one
      // model call, then let the pipeline finish staging.
      for (let waited = 0; llmCalls < 1 && waited < 5_000; waited += 10) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(llmCalls).toBe(1);
      expect(statusWrites.slice(backgroundStatusFrom).filter(Boolean)).toEqual([]);
      expect(compactRequests).toBe(0);
      expect(readMetricsLog().filter(entry => entry.status === "success")).toHaveLength(0);
      session.appendMessage({ role: "user", content: [{ type: "text", text: "TAIL_AFTER_BACKGROUND_SNAPSHOT" }], timestamp: Date.now() });
      // Growth that crosses the 80% apply gate but stays inside the mode
      // target's headroom keeps the prepared candidate valid at apply; growth
      // past the headroom is discarded as stale and a fresh run (synthesis
      // cache, no new model call) applies instead.
      usageTokens = change === "stale-tail" ? model.contextWindow * 0.85 : totalTokens + Math.ceil(model.contextWindow * 0.05) + 1;
    }
    const settled = () => dispatch(handlers, "agent_settled", { type: "agent_settled" }, ctx);
    await settled();

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
    if (strategy === "background") {
      const applied = readMetricsLog().find(entry => entry.runId === appliedRunIds[0] && entry.status === "success")!;
      // Discard accounting is asynchronous; host apply need not wait for its write.
      if (change === "stale-tail") {
        for (let waited = 0; !readMetricsLog().some(entry => entry.status === "discarded") && waited < 1_000; waited += 10) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      const discarded = readMetricsLog().filter(entry => entry.status === "discarded");
      if (change === "stale-tail") {
        expect(applied.preparation).toBeUndefined();
        expect(discarded.map(entry => entry.preparationDiscardReason)).toEqual(["stale"]);
      } else {
        expect(applied.preparation).toBe("background");
        expect(discarded).toHaveLength(0);
      }
    }

    await settled();
    expect(compactRequests).toBe(1);
    expect(llmCalls).toBe(1);

    session = SessionManager.inMemory(cwd, undefined, [header("settled-tool-session"), ...session.getBranch()] as FileEntry[]);
    await dispatch(handlers, "session_start", { type: "session_start", reason: "resume" }, ctx);
    await loadTools("compaction"); // lazy: the agent loads smart_compact before calling it
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
    expect([callsBeforeTool, callsBeforeTool + 1]).toContain(llmCalls); // identical prefixes may hit synthesis cache
    const callsAfterTool = llmCalls;

    if (change !== "unchanged" && change !== "stale-tail") {
      // Isolate staged reuse: rejected candidates must fall through to the native
      // host, not silently apply an old plan or make another nested model call.
      settings.smartCompact.autoTrigger = false;
      fs.writeFileSync(settingsFile, JSON.stringify(settings));
      resetConfigCache();
      if (change.startsWith("model")) {
        model.id = "changed-reader";
        model.contextWindow = 16_384;
        model.maxTokens = 2_048;
        if (change === "model-event") await dispatch(handlers, "model_select", {}, ctx);
      }
      if (change === "grown-tail") usageTokens += model.contextWindow;
      if (change.startsWith("pivot")) {
        await loadTools("navigation");
        const pivotArgs = { action: "pivot", target: "entry-11", carryover: "PIVOT_CARRYOVER keep the SQLite decision." };
        const pivot = await tools.get("smart_navigation").execute("pivot-call", pivotArgs, toolSignal, () => {}, ctx);
        expect(pivot.terminate).toBe(true);
        // The host records the terminating tool batch, then closes the turn.
        session.appendMessage({
          role: "assistant", content: [{ type: "toolCall", id: "pivot-call", name: "smart_navigation", arguments: pivotArgs }],
          api: "openai-responses", provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        });
        const pivotResult = { role: "toolResult" as const, toolCallId: "pivot-call", toolName: "smart_navigation", content: pivot.content, isError: false, timestamp: Date.now() };
        session.appendMessage(pivotResult);
        const originLeaf = session.getLeafId();
        await dispatch(handlers, "turn_end", { type: "turn_end", outcome: "completed", entries: [], context: { pendingMessages: [] }, toolResults: [pivotResult] }, ctx);
        // A stale apply command must not release the queued pivot.
        await commands.get("smart-compact")!.handler("context --apply=stale-nonce", ctx);
        // Pi checks threshold compaction at agent_end, before agent_settled: our own queued pivot pauses it.
        const paused = await dispatch(handlers, "session_before_compact", { type: "session_before_compact", reason: "threshold", signal: new AbortController().signal }, ctx);
        expect(paused?.cancel).toBe(true);
        expect(paused?.compaction).toBeUndefined();
        if (change === "pivot-cancelled") {
          await dispatch(handlers, "input", { type: "input", text: "Take a different direction", source: "interactive" }, ctx);
        }
        await settled();
        // The navigation apply is a zero-delay host prompt; FIFO timers run it before this one.
        await new Promise(resolve => setTimeout(resolve, 0));
        await Promise.all(hostPrompts);
        const leaf = session.getLeafEntry();
        if (change === "pivot-cancelled") {
          expect(hostPrompts).toHaveLength(0);
          expect(session.getLeafId()).toBe(originLeaf);
        } else {
          expect(leaf?.type === "branch_summary" && leaf.parentId === "entry-11" && leaf.summary.includes("PIVOT_CARRYOVER")).toBe(true);
        }
      }
      // Rejected candidates fall through to Pi's native compaction: no staged
      // apply, no nested model call, and a finished or cancelled pivot no longer pauses it.
      const response = await dispatch(handlers, "session_before_compact", {
        type: "session_before_compact",
        reason: "manual", signal: new AbortController().signal,
        customInstructions: change === "instructions" ? "Preserve rollback steps in exact order" : undefined,
        preparation: change === "native-reserve" ? { settings: { reserveTokens: model.contextWindow - 1 } } : undefined,
      }, ctx);
      expect(response).toBeUndefined();
      expect(llmCalls).toBe(callsAfterTool);
      expect(readMetricsLog().some(entry => entry.runId === stagedRunId && entry.status === "success")).toBe(false);
      await dispatch(handlers, "session_shutdown", {}, ctx);
      return;
    }

    await settled();
    expect(compactRequests).toBe(2);
    expect(llmCalls).toBe(callsAfterTool);
    expect(appliedRunIds.at(-1)).toBe(stagedRunId);
    expect(
      readMetricsLog().filter(
        (entry) =>
          entry.sessionId === "settled-tool-session" &&
          entry.status === "success" &&
          entry.runId === stagedRunId,
      ),
    ).toHaveLength(1);

    await dispatch(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  }, 15_000);
});
