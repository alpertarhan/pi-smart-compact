import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import smartCompactExtension from "../src/index.ts";
import { notifyUser, resetIssuesForTests } from "../src/utils/issues.ts";
import { resetConfigCache } from "../src/utils/config.ts";

const originalHome = process.env.HOME;
let home = "";
let stderr: string[] = [];
const originalWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-headless-"));
  process.env.HOME = home;
  resetConfigCache();
  resetIssuesForTests();
  stderr = [];
  (process.stderr as any).write = (chunk: string) => {
    stderr.push(String(chunk));
    return true;
  };
});

afterEach(() => {
  (process.stderr as any).write = originalWrite;
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
  resetConfigCache();
  resetIssuesForTests();
});

const MODEL = {
  provider: "test",
  id: "model",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1",
  contextWindow: 100_000,
  maxTokens: 4_096,
} as any;

function extension() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const commands = new Map<string, any>();
  const active = new Set<string>(["read", "smart_compact"]);
  smartCompactExtension({
    registerTool: () => { },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools: () => [...active],
    getAllTools: () => [...active].map((name) => ({ name })),
    setActiveTools: (names: string[]) => {
      active.clear();
      for (const name of names) active.add(name);
    },
    appendEntry: () => { },
    events: { on: () => { }, emit: () => { } },
  } as any);
  return { handlers, commands };
}

function context(hasUI: boolean) {
  const statuses: Array<[string, string | undefined]> = [];
  const notices: string[] = [];
  const customCalls: unknown[] = [];
  let branchReads = 0;
  const branch = [
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
    },
  ];
  const ctx: any = {
    cwd: home,
    hasUI,
    mode: hasUI ? "tui" : "print",
    model: MODEL,
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: (key: string, text?: string) => statuses.push([key, text]),
      setWidget: () => { },
      custom: async (...args: unknown[]) => {
        customCalls.push(args);
        return undefined;
      },
      confirm: async () => false,
    },
    sessionManager: {
      getSessionId: () => "headless-session",
      getBranch: () => {
        branchReads++;
        return branch;
      },
      getEntries: () => branch,
    },
    modelRegistry: {
      getAvailable: () => [MODEL],
      find: () => MODEL,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
    },
    getContextUsage: () => ({ tokens: 10, percent: 0.01, contextWindow: MODEL.contextWindow }),
    waitForIdle: async () => { },
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact: () => { },
  };
  return { ctx, statuses, notices, customCalls, branchReads: () => branchReads };
}


describe("no-UI modes", () => {
  it("sends warnings and errors to stderr and keeps info silent", () => {
    const sink = { hasUI: false, ui: { notify: () => { throw new Error("should not be called"); } } };
    notifyUser(sink, "Routine progress", "info");
    notifyUser(sink, "Manual compaction skipped: fewer than 3 active messages are available.", "warning");
    expect(stderr).toEqual([
      "Smart Compact: Manual compaction skipped: fewer than 3 active messages are available.\n",
    ]);
  });

  it("runs /smart-compact without arguments non-interactively instead of cancelling", async () => {
    const { commands } = extension();
    const harness = context(false);
    await commands.get("smart-compact").handler("", harness.ctx);
    expect(harness.customCalls).toHaveLength(0);
    expect(harness.branchReads()).toBeGreaterThan(0);
    expect(harness.notices).toEqual([]);
    expect(stderr.join("")).toContain(
      "Smart Compact: Manual compaction skipped: fewer than 3 active messages are available.",
    );
    expect(stderr.join("")).not.toContain("Cancelled");
  });

  it("still opens the interactive picker when a UI exists", async () => {
    const { commands } = extension();
    const harness = context(true);
    await commands.get("smart-compact").handler("", harness.ctx);
    expect(harness.customCalls.length).toBeGreaterThan(0);
    expect(stderr).toEqual([]);
  });
});
