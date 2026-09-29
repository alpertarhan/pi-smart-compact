import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import smartCompactExtension from "../src/index.ts";
import { resetConfigCache } from "../src/utils/helpers.ts";
import { recentIssues, resetIssuesForTests } from "../src/utils/issues.ts";

const originalHome = process.env.HOME;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-cache-ledger-hook-"));
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  process.env.HOME = home;
  resetConfigCache();
  resetIssuesForTests();
});

afterEach(() => {
  process.env.HOME = originalHome;
  resetConfigCache();
  resetIssuesForTests();
  fs.rmSync(home, { recursive: true, force: true });
});

function extension() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const api = new Proxy(
    {
      on: (name: string, handler: (event: any, ctx: any) => unknown) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerCommand: () => { },
      registerTool: () => { },
      getActiveTools: () => [],
      setActiveTools: () => { },
    },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => { }) },
  );
  smartCompactExtension(api as any);
  const dispatch = async (name: string, event: any, ctx: any) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return { dispatch };
}

function context(sessionId: string, notifications: string[]) {
  return {
    hasUI: true,
    cwd: process.cwd(),
    model: { provider: "anthropic", id: "claude", contextWindow: 200_000, maxTokens: 8_192 },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    getContextUsage: () => ({ tokens: 50_000 }),
    ui: { notify: (message: string) => notifications.push(message), setStatus() { }, setWidget() { } },
  };
}

const assistant = (usage: { input: number; cacheRead: number; cacheWrite: number }, timestamp: number) => ({
  role: "assistant", provider: "anthropic", model: "claude", timestamp,
  usage: { ...usage, output: 10, totalTokens: usage.input + usage.cacheRead + usage.cacheWrite + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

describe("host prompt-cache ledger through the extension hooks", () => {
  it("records foreign rebuilds without duplicating Pi's cache-miss notification", async () => {
    const { dispatch } = extension();
    const notifications: string[] = [];
    const ctx = context("ledger-session", notifications);
    await dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
    // Steady prefix reuse: nothing to say.
    await dispatch("message_end", { type: "message_end", message: assistant({ input: 2_000, cacheRead: 100_000, cacheWrite: 0 }, 1_000) }, ctx);
    await dispatch("message_end", { type: "message_end", message: assistant({ input: 3_000, cacheRead: 102_000, cacheWrite: 0 }, 2_000) }, ctx);
    // Three full rewrites within the cache lifetime and with no edit of ours.
    for (let i = 0; i < 3; i++) {
      await dispatch("message_end", { type: "message_end", message: assistant({ input: 1_000, cacheRead: 0, cacheWrite: 105_000 }, 3_000 + i * 1_000) }, ctx);
    }
    // User and tool messages carry no usage and never count.
    await dispatch("message_end", { type: "message_end", message: { role: "user", content: "next", timestamp: 7_000 } }, ctx);
    await dispatch("message_end", { type: "message_end", message: assistant({ input: 1_000, cacheRead: 0, cacheWrite: 105_000 }, 8_000) }, ctx);
    expect(notifications.filter(message => message.includes("prompt cache was rebuilt"))).toHaveLength(0);
    const issue = recentIssues().find(item => item.key === "cache.foreign-rebuilds");
    expect(issue?.message).toContain("318,000 uncached prompt tokens");
    expect(issue?.count).toBe(1);
  });

  it("attributes a rebuild after Continuity's own compaction and stays silent", async () => {
    const { dispatch } = extension();
    const notifications: string[] = [];
    const ctx = context("attributed-session", notifications);
    await dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
    await dispatch("message_end", { type: "message_end", message: assistant({ input: 2_000, cacheRead: 100_000, cacheWrite: 0 }, 1_000) }, ctx);
    for (let i = 0; i < 3; i++) {
      // Our own applied compaction (fromExtension with a Continuity runId) precedes each rewrite.
      await dispatch("session_compact", {
        type: "session_compact", fromExtension: true,
        compactionEntry: { id: "entry-" + i, details: { runId: "run-" + i } },
      }, ctx);
      await dispatch("message_end", { type: "message_end", message: assistant({ input: 1_000, cacheRead: 0, cacheWrite: 60_000 }, 2_000 + i * 1_000) }, ctx);
    }
    expect(notifications.filter((message) => message.includes("prompt cache was rebuilt"))).toHaveLength(0);
  });

  it("forgets the ledger when the session changes", async () => {
    const { dispatch } = extension();
    const notifications: string[] = [];
    const first = context("first-session", notifications);
    await dispatch("session_start", { type: "session_start", reason: "startup" }, first);
    await dispatch("message_end", { type: "message_end", message: assistant({ input: 2_000, cacheRead: 100_000, cacheWrite: 0 }, 1_000) }, first);
    await dispatch("message_end", { type: "message_end", message: assistant({ input: 1_000, cacheRead: 0, cacheWrite: 105_000 }, 2_000) }, first);
    await dispatch("message_end", { type: "message_end", message: assistant({ input: 1_000, cacheRead: 0, cacheWrite: 105_000 }, 3_000) }, first);
    const second = context("second-session", notifications);
    await dispatch("session_start", { type: "session_start", reason: "resume" }, second);
    // The first request of a session is a baseline, never a rebuild; two more
    // rewrites here are only the second session's first two foreign rebuilds.
    for (let i = 0; i < 3; i++) {
      await dispatch("message_end", { type: "message_end", message: assistant({ input: 1_000, cacheRead: 0, cacheWrite: 105_000 }, 10_000 + i * 1_000) }, second);
    }
    expect(notifications.filter((message) => message.includes("prompt cache was rebuilt"))).toHaveLength(0);
  });
});
