import { afterEach, describe, expect, it } from "bun:test";
import rtkCompanion from "../src/rtk.ts";
import { resetIssuesForTests } from "../src/utils/issues.ts";

const disabled = process.env.RTK_DISABLED;
afterEach(() => { resetIssuesForTests(); if (disabled === undefined) delete process.env.RTK_DISABLED; else process.env.RTK_DISABLED = disabled; });

function harness(version = "rtk 0.50.0") {
  const handlers = new Map<string, any>();
  const calls: string[][] = [];
  const statuses: string[] = [];
  const notices: string[] = [];
  let outcome = { stdout: "rtk git status\n", stderr: "", code: 0, killed: false };
  let during: (() => void) | undefined;
  let fail = false;
  rtkCompanion({
    on: (name: string, fn: any) => handlers.set(name, fn),
    exec: async (command: string, args: string[], options: { timeout: number }) => {
      expect(command).toBe("rtk"); expect(options.timeout).toBe(2000);
      calls.push(args);
      if (fail) throw new Error("ENOENT");
      if (args[0] === "--version") return { ...outcome, stdout: version };
      during?.();
      return outcome;
    },
  } as any);
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal,
    hasUI: true,
    ui: {
      setStatus: (_key: string, text: string) => statuses.push(text),
      notify: (message: string) => notices.push(message),
    },
    sessionManager: { getSessionId: () => "rtk-session" },
  };
  const run = async (command = "git status", toolName = "bash") => {
    const event = { type: "tool_call", toolCallId: "command", toolName, input: { command, timeout: 60 } };
    const result = await handlers.get("tool_call")(event, ctx);
    expect(result).toBeUndefined(); // No blocking or alternative execution path.
    expect(event.input.timeout).toBe(60);
    return event.input.command;
  };
  return { calls, statuses, notices, handlers, controller, run,
    outcome: (value: Partial<typeof outcome>) => { outcome = { ...outcome, ...value }; },
    during: (fn: () => void) => { during = fn; }, fail: () => { fail = true; } };
}

describe("opt-in RTK companion", () => {
  it.each([0, 3])("delegates once, accepting documented rewrite exit %s without executing bash", async code => {
    const h = harness(); h.outcome({ code });
    // Version probe always requires success; advisory code applies only to rewrite.
    if (code === 3) { h.outcome({ code: 0 }); h.during(() => h.outcome({ code: 3 })); }
    expect(await h.run()).toBe("rtk git status");
    expect(await h.run("git status")).toBe("rtk git status");
    expect(h.calls).toEqual([["--version"], ["rewrite", "git status"], ["rewrite", "git status"]]);
    expect(h.statuses).toHaveLength(0);
  });
  it("rewrites proven bare bun test with probed availability", async () => {
    const h = harness();
    h.outcome({ stdout: "rtk bun test\n" });
    expect(await h.run("bun test")).toBe("rtk bun test");
    expect(await h.run("  bun test  ")).toBe("rtk bun test");
    expect(h.calls).toEqual([["--version"], ["rewrite", "bun test"], ["rewrite", "  bun test  "]]);
  });


  it.each(["rtk 0.22.9", "rtk 0.49.0", "garbage", "rtk 0.50.0-beta"])("passes through unknown/unsupported version %s", async version => {
    const h = harness(version);
    expect(await h.run()).toBe("git status");
    expect(h.calls).toEqual([["--version"]]);
    // A one-time notice, never a permanent footer status.
    expect(h.statuses).toHaveLength(0);
    expect(h.notices).toEqual([
      "Smart Compact: RTK rewriting is inactive: requires rtk >=0.50 in PATH. Commands run unchanged. Install or update rtk, or stop loading the RTK companion.",
    ]);
    await h.run();
    expect(h.notices).toHaveLength(1);
  });

  it.each(["", "   ", "rtk git status", "  rtk git status", "git diff | wc -l", "git diff > patch", "git status && git diff",
    "git status; git diff", "git diff", "tsc --noEmit --pretty false", "git status --porcelain", "cargo test -- --list", "echo $(pwd)", "echo `pwd`", "echo $HOME", "git status\ngit diff", "git diff -- 'a|b'",
    "vitest run", "vitest", "bun test --watch", "bun test foo.test.js", "bun test --reporter=junit", "npm test", "node --test"])("does not rewrite shell composition or bypass: %s", async command => {
    const h = harness();
    expect(await h.run(command)).toBe(command);
    expect(h.calls).toHaveLength(0);
  });

  it.each(["disabled", "aborted", "non-bash"])("does not probe RTK when %s", async kind => {
    const h = harness();
    if (kind === "disabled") process.env.RTK_DISABLED = "1";
    if (kind === "aborted") h.controller.abort();
    expect(await h.run("git status", kind === "non-bash" ? "powershell" : "bash")).toBe("git status");
    expect(h.calls).toHaveLength(0);
  });

  it.each(["missing", "no-rule", "failed", "timeout", "empty", "unsafe", "long", "switch", "abort"])("keeps original on %s without retrying execution", async kind => {
    const h = harness();
    if (kind === "missing") h.fail();
    h.during(() => {
      if (kind === "no-rule") h.outcome({ code: 1 });
      if (kind === "failed") h.outcome({ code: 2 });
      if (kind === "timeout") h.outcome({ killed: true });
      if (kind === "empty") h.outcome({ stdout: "" });
      if (kind === "unsafe") h.outcome({ stdout: "rtk git status; echo unsafe" });
      if (kind === "long") h.outcome({ stdout: "rtk " + "x".repeat(40_000) });
      if (kind === "switch") h.handlers.get("session_before_switch")();
      if (kind === "abort") h.controller.abort();
    });
    expect(await h.run()).toBe("git status");
    expect(h.calls.length).toBeLessThanOrEqual(2);
  });
});
