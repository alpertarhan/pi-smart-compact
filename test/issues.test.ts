import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  flushIssues,
  formatIssueMessage,
  formatRecentIssues,
  recentIssues,
  recordIssue,
  reportIssue,
  resetIssuesForTests,
} from "../src/utils/issues.ts";
import { loadConfig, resetConfigCache } from "../src/utils/config.ts";
import { readJsonSync } from "../src/infra/fs.ts";

function sink(sessionId = "s1", hasUI = true) {
  const notices: Array<{ message: string; type?: string }> = [];
  return {
    notices,
    hasUI,
    ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
    sessionManager: { getSessionId: () => sessionId },
  };
}

const originalHome = process.env.HOME;
let home = "";
beforeEach(() => {
  resetIssuesForTests();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-issues-"));
  process.env.HOME = home;
  resetConfigCache();
});
afterEach(() => {
  resetIssuesForTests();
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
  resetConfigCache();
});

describe("issue reporter", () => {
  it("shows a cause once per session, counts repeats, and shows it again in a new session", () => {
    const ctx = sink("s1");
    for (let index = 0; index < 3; index++) {
      reportIssue({ key: "x", message: "Thing failed. Conversation unchanged. Retry." }, ctx);
    }
    expect(ctx.notices).toEqual([
      { message: "Smart Compact: Thing failed. Conversation unchanged. Retry.", type: "warning" },
    ]);
    expect(recentIssues()[0]).toMatchObject({ key: "x", count: 3 });

    const next = sink("s2");
    reportIssue({ key: "x", message: "Thing failed. Conversation unchanged. Retry." }, next);
    expect(next.notices).toHaveLength(1);
  });

  it("falls back to stderr without a UI", () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      const ctx = sink("s1", false);
      reportIssue({ key: "headless", message: "No UI here." }, ctx);
      expect(ctx.notices).toHaveLength(0);
      expect(writes).toEqual(["Smart Compact: No UI here.\n"]);
    } finally {
      (process.stderr as any).write = original;
    }
  });

  it("queues context-less reports and flushes them at the next event", () => {
    reportIssue({ key: "bg", message: "Background write failed." });
    reportIssue({ key: "bg", message: "Background write failed." });
    const ctx = sink();
    flushIssues(ctx);
    flushIssues(ctx);
    expect(ctx.notices.map((notice) => notice.message)).toEqual(["Smart Compact: Background write failed."]);
  });

  it("records without toasting when the caller already surfaces the failure", () => {
    const ctx = sink();
    recordIssue({ key: "quiet", message: "Metrics could not be recorded." });
    flushIssues(ctx);
    expect(ctx.notices).toHaveLength(0);
    expect(formatRecentIssues()).toContain("Metrics could not be recorded.");
  });

  it("scrubs secrets, drops stack traces, and bounds length", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const message = formatIssueMessage("Auth failed with " + token + "\n    at foo (bar.ts:1:1)\n    at baz");
    expect(message).not.toContain(token);
    expect(message).not.toContain("bar.ts");
    expect(message).not.toContain("\n");
    expect(formatIssueMessage("x".repeat(2000)).length).toBeLessThanOrEqual(400);
  });

  it("lists the last 20 issues, newest first, with age and count", () => {
    for (let index = 0; index < 25; index++) recordIssue({ key: "k" + index, message: "Issue " + index + "." });
    recordIssue({ key: "k24", message: "Issue 24." });
    const text = formatRecentIssues(Date.now());
    expect(text.split("\n")[0]).toBe("Recent issues (20):");
    expect(text.split("\n")[1]).toContain("×2 — Issue 24.");
    expect(text).not.toContain("Issue 4.");
    expect(text).toMatch(/\ds ago/);
    resetIssuesForTests();
    expect(formatRecentIssues()).toBe("Recent issues: none");
  });
});

describe("representative problems by class", () => {
  it("user-actionable: invalid settings are visible with a fix, not only in debug output", () => {
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ smartCompact: { hindsightApiKeyEnv: "sk-live-secret-value" } }),
    );
    loadConfig();
    const ctx = sink();
    flushIssues(ctx);
    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0].message).toStartWith("Smart Compact: settings.json: hindsightApiKeyEnv must be");
    expect(ctx.notices[0].message).toContain("/smart-compact settings");
    expect(ctx.notices[0].message).not.toContain("sk-live-secret-value");
  });

  it("transient/expected: a missing settings file is silent", () => {
    loadConfig();
    const ctx = sink();
    flushIssues(ctx);
    expect(ctx.notices).toHaveLength(0);
    expect(recentIssues()).toHaveLength(0);
  });

  it("user-actionable: an unreadable JSON file is reported with its path", () => {
    const file = path.join(home, "broken.json");
    fs.writeFileSync(file, "{not json");
    expect(readJsonSync(file)).toBeNull();
    const ctx = sink();
    flushIssues(ctx);
    expect(ctx.notices[0].message).toContain("Could not read " + file);
  });

});
