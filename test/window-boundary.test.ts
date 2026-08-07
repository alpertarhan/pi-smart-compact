import { describe, expect, it } from "bun:test";
import { planCompactionWindow, resolveCompactionWindow } from "../src/app/steps/window.ts";
import type { PreparedRc } from "../src/app/run-context.ts";
import type { SessionMessageEntry } from "../src/types.ts";
import { makeTokenEstimator, TokenCalibrationStore } from "../src/utils/tokens.ts";

function messageEntry(
  id: string,
  parentId: string | null,
  message: Record<string, unknown>,
): SessionMessageEntry & { parentId: string | null; timestamp: string } {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-06-15T00:00:00.000Z",
    message,
  };
}

function makePreparedRc(branch: SessionMessageEntry[], keepRecentTokens = 30_000): PreparedRc {
  return {
    ctx: {
      cwd: "/tmp/pi-smart-compact-test",
      model: { contextWindow: 150_000 },
      getContextUsage: () => ({ tokens: 135_000, contextWindow: 150_000, percent: 90 }),
      sessionManager: {
        getBranch: () => branch,
        buildContextEntries: () => branch,
        getSessionId: () => "test-session",
      },
    },
    estimator: makeTokenEstimator("openai", "test", new TokenCalibrationStore()),
    profileCfg: {
      keepRecentTokens,
      summaryBudgetTokens: 6_000,
      minChunkTokens: 500,
      maxChunkTokens: 8_000,
      singlePassMaxTokens: 30_000,
      batchMaxTokens: 24_000,
    },
    config: { minContextPercent: 60 },
    flags: { verbose: false, dryRun: false, autoTriggered: false, skipCompact: true, force: true },
    notify: () => {},
    _prepared: true,
  } as unknown as PreparedRc;
}

describe("resolveCompactionWindow tool-result boundary", () => {
  it("does not compact the only user turn just to retain a trailing tool result", () => {
    const toolCallId = "call_test|fc_test";
    const branch: SessionMessageEntry[] = [
      messageEntry("m1-user", null, {
        role: "user",
        content: [{ type: "text", text: "please run a tool" }],
        timestamp: 1,
      }),
      messageEntry("m2-assistant-toolcall", "m1-user", {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "bash",
            arguments: { command: "echo ok" },
          },
        ],
        timestamp: 2,
        provider: "openai-codex",
        model: "gpt-5.5",
        stopReason: "tool_use",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      }),
      messageEntry("m3-tool-result", "m2-assistant-toolcall", {
        role: "toolResult",
        toolCallId,
        toolName: "bash",
        content: [{ type: "text", text: "ok\n" }],
        isError: false,
        timestamp: 3,
      }),
    ];

    const result = resolveCompactionWindow(makePreparedRc(branch));

    expect(result).toBeNull();
  });

  it("warns instead of silently blocking an immediate repeated manual compaction", () => {
    const notices: string[] = [];
    const branch = [
      messageEntry("u1", null, { role: "user", content: [{ type: "text", text: "recent request" }] }),
      messageEntry("a1", "u1", { role: "assistant", content: [{ type: "text", text: "recent response" }] }),
      messageEntry("u2", "a1", { role: "user", content: [{ type: "text", text: "latest request" }] }),
    ];
    const rc = makePreparedRc(branch);
    rc.notify = message => { notices.push(message); };

    expect(resolveCompactionWindow(rc)).toBeNull();
    expect(notices.join(" ")).toContain("no eligible prefix remains");
  });

  it("backs up when the token window naturally starts at a toolResult", () => {
    const toolCallId = "call_cut|fc_cut";
    const branch: SessionMessageEntry[] = [
      messageEntry("m1-user", null, {
        role: "user",
        content: [{ type: "text", text: "please run a tool" }],
        timestamp: 1,
      }),
      messageEntry("m2-assistant-toolcall", "m1-user", {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "bash",
            arguments: { command: "echo ok" },
          },
        ],
        timestamp: 2,
      }),
      messageEntry("m3-tool-result", "m2-assistant-toolcall", {
        role: "toolResult",
        toolCallId,
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 3,
      }),
    ];

    const result = resolveCompactionWindow(makePreparedRc(branch, 1));

    expect(result).toBeNull();
  });

  it("summarizes a complete tool exchange when retaining it would exceed the target", () => {
    const callId = "hard-adjust";
    const branch = [
      messageEntry("old-user", null, { role: "user", content: [{ type: "text", text: "old" }] }),
      messageEntry("old-answer", "old-user", { role: "assistant", content: [{ type: "text", text: "old answer" }] }),
      messageEntry("call", "old-answer", { role: "assistant", content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "x" } }] }),
      messageEntry("result", "call", { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text: "result" }] }),
      messageEntry("tail", "result", { role: "assistant", content: [{ type: "text", text: "tail" }] }),
    ];
    const rc = makePreparedRc(branch, 350);
    rc.profileCfg.summaryBudgetTokens = 10;

    const plan = planCompactionWindow({
      msgs: branch,
      branch,
      messageTokens: [1_000, 1_000, 100, 100, 300],
      totalTokens: 2_500,
      modelContextWindow: 10_000,
      mode: "thorough",
      profileCfg: rc.profileCfg,
      force: true,
      overflowedContext: false,
    });

    expect(plan.hardBoundaryAdjusted).toBeTrue();
    expect(plan.keepFrom).toBe(4);
    expect(plan.retentionTargetTokens).toBe(400);
    expect(plan.retainedTokens).toBe(300);
    expect(plan.reason).toBe("viable");
  });

  it("counts large tool-call arguments in the recent-tail budget", () => {
    const branch: SessionMessageEntry[] = [];
    for (let i = 0; i < 100; i++) {
      branch.push(messageEntry("a" + i, i ? "r" + (i - 1) : null, {
        role: "assistant",
        content: [{ type: "toolCall", id: "w" + i, name: "write", arguments: { path: "src/f" + i + ".ts", content: "x".repeat(2000) } }],
      }));
      branch.push(messageEntry("r" + i, "a" + i, {
        role: "toolResult", toolCallId: "w" + i, content: [{ type: "text", text: "ok" }],
      }));
    }

    const rc = makePreparedRc(branch, 20_000);
    const estimated = branch.reduce((sum, entry) => sum + rc.estimator.message(entry.message as any), 0);
    rc.ctx.model = { id: "tool-test", provider: "test", contextWindow: estimated * 2 } as any;
    rc.ctx.getContextUsage = () => ({ tokens: estimated, contextWindow: estimated * 2, percent: 50 } as any);
    const result = resolveCompactionWindow(rc);

    expect(result).not.toBeNull();
    expect(branch.length - result!.keepFrom).toBeGreaterThan(50);
    expect(result!.accTokens).toBeGreaterThanOrEqual(20_000);
  });

  it("does not emit a compaction if the first kept entry would still be a toolResult", () => {
    const branch: SessionMessageEntry[] = [
      messageEntry("m1-user", null, {
        role: "user",
        content: [{ type: "text", text: "please run a tool" }],
        timestamp: 1,
      }),
      messageEntry("m2-assistant", "m1-user", {
        role: "assistant",
        content: [{ type: "text", text: "running it" }],
        timestamp: 2,
      }),
      messageEntry("m3-orphan-tool-result", "m2-assistant", {
        role: "toolResult",
        toolCallId: "missing-call",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 3,
      }),
    ];

    const result = resolveCompactionWindow(makePreparedRc(branch));

    expect(result).toBeNull();
  });

  it("uses Pi's compaction-aware active entries instead of append-only history", () => {
    const active = [
      messageEntry("active-1", null, { role: "user", content: [{ type: "text", text: "old " + "x".repeat(140_000) }] }),
      messageEntry("active-2", "active-1", { role: "assistant", content: [{ type: "text", text: "old answer" }] }),
      messageEntry("active-3", "active-2", { role: "user", content: [{ type: "text", text: "recent request" }] }),
      messageEntry("active-4", "active-3", { role: "assistant", content: [{ type: "text", text: "recent answer" }] }),
      messageEntry("active-5", "active-4", { role: "user", content: [{ type: "text", text: "latest request" }] }),
      messageEntry("active-6", "active-5", { role: "assistant", content: [{ type: "text", text: "latest answer" }] }),
    ];
    const rc = makePreparedRc([], 1);
    const estimated = active.reduce((sum, entry) => sum + rc.estimator.message(entry.message as any), 0);
    rc.ctx.getContextUsage = () => ({ tokens: estimated, contextWindow: 150_000, percent: estimated / 1_500 } as any);
    rc.profileCfg.summaryBudgetTokens = 100;
    (rc.ctx.sessionManager as any).getBranch = () => { throw new Error("append-only history must not be read"); };
    (rc.ctx.sessionManager as any).buildContextEntries = () => active;

    const result = resolveCompactionWindow(rc);

    expect(result?.msgs.map(message => message.id)).toEqual(active.map(message => message.id));
    expect(result?.toCompact.length).toBeGreaterThan(0);
  });

  it("keeps the two most recent user turns when that soft boundary fits", () => {
    const branch = [
      messageEntry("u1", null, { role: "user", content: [{ type: "text", text: "first " + "x".repeat(30_000) }] }),
      messageEntry("a1", "u1", { role: "assistant", content: [{ type: "text", text: "first answer " + "x".repeat(30_000) }] }),
      messageEntry("u2", "a1", { role: "user", content: [{ type: "text", text: "second" }] }),
      messageEntry("a2", "u2", { role: "assistant", content: [{ type: "text", text: "second answer" }] }),
      messageEntry("u3", "a2", { role: "user", content: [{ type: "text", text: "third" }] }),
      messageEntry("a3", "u3", { role: "assistant", content: [{ type: "text", text: "third answer" }] }),
    ];
    const rc = makePreparedRc(branch, 100);
    const estimated = branch.reduce((sum, entry) => sum + rc.estimator.message(entry.message as any), 0);
    rc.profileCfg.summaryBudgetTokens = 10;
    rc.ctx.model = { id: "soft", provider: "test", contextWindow: estimated * 4 } as any;
    rc.ctx.getContextUsage = () => ({ tokens: estimated, contextWindow: estimated * 4, percent: 25 } as any);

    const result = resolveCompactionWindow(rc)!;
    expect(result.keepFrom).toBeLessThanOrEqual(branch.findIndex(entry => entry.id === "u2"));
    expect(result.compactionPlan.relaxedSoftBoundaries).not.toContain("recent-user-turn");
  });

  it("summarizes an old prefix of one long user turn when the full turn exceeds the tail budget", () => {
    const branch: SessionMessageEntry[] = [
      messageEntry("long-turn-user", null, {
        role: "user",
        content: [{ type: "text", text: "Implement the requested feature without losing the active constraints." }],
      }),
    ];
    for (let index = 0; index < 45; index++) {
      const parentId = branch.at(-1)!.id;
      branch.push(messageEntry("long-turn-call-" + index, parentId, {
        role: "assistant",
        content: [{ type: "toolCall", id: "long-call-" + index, name: "bash", arguments: { command: "echo " + index } }],
      }));
      branch.push(messageEntry("long-turn-result-" + index, "long-turn-call-" + index, {
        role: "toolResult",
        toolCallId: "long-call-" + index,
        toolName: "bash",
        content: [{ type: "text", text: "result " + index + " " + "x".repeat(8_000) }],
        isError: false,
      }));
    }
    branch.push(messageEntry("long-turn-tail", branch.at(-1)!.id, {
      role: "assistant",
      content: [{ type: "text", text: "Current implementation status and next action." }],
    }));

    const rc = makePreparedRc(branch, 10_000);
    const estimated = branch.reduce((sum, entry) => sum + rc.estimator.message(entry.message as any), 0);
    rc.profileCfg.summaryBudgetTokens = 3_000;
    rc.ctx.model = { id: "long-turn", provider: "test", contextWindow: estimated * 2 } as any;
    rc.ctx.getContextUsage = () => ({ tokens: estimated, contextWindow: estimated * 2, percent: 50 } as any);

    const result = resolveCompactionWindow(rc)!;

    expect(result.firstKeptId).not.toBe("long-turn-user");
    expect(result.toCompact.some(entry => entry.id === "long-turn-user")).toBeTrue();
    expect(result.compactionPlan.relaxedSoftBoundaries).toContain("recent-user-turn");
    expect((result.msgs[result.keepFrom].message as any).role).not.toBe("toolResult");
    expect(result.compactionPlan.projectedYield).toBeGreaterThanOrEqual(0.1);
  });

  it("manually compacts a 219K session on a 1M window without requiring aggressive mode", () => {
    const notices: string[] = [];
    const branch = Array.from({ length: 100 }, (_, index) => messageEntry(
      "large-" + index,
      index ? "large-" + (index - 1) : null,
      {
        role: index % 5 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: "message " + index + " " + "x".repeat(8_000) }],
      },
    ));
    const rc = makePreparedRc(branch, 30_000);
    rc.mode = "thorough";
    rc.profile = "light";
    rc.profileCfg.summaryBudgetTokens = 10_000;
    rc.ctx.model = { id: "million", provider: "test", contextWindow: 1_000_000 } as any;
    rc.ctx.getContextUsage = () => ({ tokens: 219_000, contextWindow: 1_000_000, percent: 21.9 } as any);
    rc.notify = message => { notices.push(message); };

    const result = resolveCompactionWindow(rc);

    expect(result).not.toBeNull();
    expect(result!.compactTokens).toBeGreaterThan(100_000);
    expect(result!.accTokens).toBeGreaterThanOrEqual(30_000);
    expect(notices.join(" ")).toContain("Manual compaction override at 22%");
    expect(notices.join(" ")).toContain("verification remains fail-closed");
  });

  it("accepts a manual absolute-tail plan even when fixed context exceeds the relative mode target", () => {
    const branch = Array.from({ length: 120 }, (_, index) => messageEntry(
      "fixed-" + index,
      index ? "fixed-" + (index - 1) : null,
      {
        role: index % 40 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: "message " + index + " " + "x".repeat(10_000) }],
      },
    ));
    const rc = makePreparedRc(branch, 30_000);
    rc.mode = "thorough";
    rc.profile = "light";
    rc.profileCfg.summaryBudgetTokens = 10_000;
    rc.ctx.model = { id: "million-fixed", provider: "test", contextWindow: 1_000_000 } as any;
    rc.ctx.getContextUsage = () => ({ tokens: 900_000, contextWindow: 1_000_000, percent: 90 } as any);

    const result = resolveCompactionWindow(rc)!;
    const plan = result.compactionPlan;

    expect(plan.viable).toBeTrue();
    expect(plan.projectedAfterTokens).toBeGreaterThan(500_000);
    expect(plan.projectedYield).toBeGreaterThanOrEqual(0.1);
    expect(plan.fixedContextTokens).toBeGreaterThan(500_000);
    expect(plan.summaryBudgetTokens).toBe(10_000);
    expect(plan.targetAfterTokens).toBe(plan.fixedContextTokens + plan.retentionTargetTokens + plan.summaryBudgetTokens);
    expect(plan.projectedAfterTokens).toBeLessThanOrEqual(plan.targetAfterTokens);
    expect(plan.hardBoundaryAdjusted).toBeFalse();
  });

  it("retains context up to the mode target instead of stopping at the minimum tail", () => {
    const branch = Array.from({ length: 100 }, (_, index) => messageEntry(
      "m" + index,
      index ? "m" + (index - 1) : null,
      {
        role: index % 5 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: "message " + index + " " + "x".repeat(4_000) }],
      },
    ));
    const rc = makePreparedRc(branch, 1);
    const estimated = branch.reduce((sum, entry) => sum + rc.estimator.message(entry.message as any), 0);
    rc.flags.force = false;
    rc.ctx.model = { id: "target", provider: "test", contextWindow: estimated / 0.9 } as any;
    rc.ctx.getContextUsage = () => ({ tokens: estimated, contextWindow: estimated / 0.9, percent: 90 } as any);
    const result = resolveCompactionWindow(rc)!;
    expect(result.accTokens).toBeGreaterThan(estimated * 0.25);
    expect(result.accTokens).toBeLessThan(estimated * 0.5);
  });

  it("normalizes replaced and retained estimates to Pi's measured context", () => {
    const branch = [
      messageEntry("u1", null, { role: "user", content: [{ type: "text", text: "first" }] }),
      messageEntry("a1", "u1", { role: "assistant", content: [{ type: "text", text: "x".repeat(300_000) }] }),
      messageEntry("u2", "a1", { role: "user", content: [{ type: "text", text: "second" }] }),
      messageEntry("a2", "u2", { role: "assistant", content: [{ type: "text", text: "y".repeat(300_000) }] }),
      messageEntry("u3", "a2", { role: "user", content: [{ type: "text", text: "third" }] }),
      messageEntry("a3", "u3", { role: "assistant", content: [{ type: "text", text: "z".repeat(300_000) }] }),
    ];
    const result = resolveCompactionWindow(makePreparedRc(branch, 1))!;
    expect(result.compactTokens).toBeGreaterThan(20_000);
    expect(result.compactTokens + result.accTokens).toBeLessThanOrEqual(result.totalTokens + 1);
  });

  it("recounts the retained tail after anchor protection expands it", () => {
    const toolCallId = "anchor-call";
    const branch = [
      messageEntry("old", null, { role: "user", content: [{ type: "text", text: "old " + "x".repeat(20_000) }] }),
      messageEntry("anchor-request", "old", { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "context", arguments: { action: "anchor" } }] }),
      messageEntry("anchor", "anchor-request", { role: "toolResult", toolCallId, toolName: "context", details: { anchor: true }, content: [{ type: "text", text: "checkpoint" }] }),
      messageEntry("kept-1", "anchor", { role: "assistant", content: [{ type: "text", text: "kept " + "y".repeat(500) }] }),
      messageEntry("u2", "kept-1", { role: "user", content: [{ type: "text", text: "second turn" }] }),
      messageEntry("a2", "u2", { role: "assistant", content: [{ type: "text", text: "second answer" }] }),
      messageEntry("u3", "a2", { role: "user", content: [{ type: "text", text: "tail" }] }),
    ];
    const rc = makePreparedRc(branch, 100);
    const estimated = branch.reduce((sum, entry) => sum + rc.estimator.message(entry.message as any), 0);
    rc.profileCfg.summaryBudgetTokens = 10;
    rc.ctx.model = { id: "anchor", provider: "test", contextWindow: estimated * 4 } as any;
    rc.ctx.getContextUsage = () => ({ tokens: estimated, contextWindow: estimated * 4, percent: 25 } as any);

    const result = resolveCompactionWindow(rc);

    expect(result?.firstKeptId).toBe("anchor-request");
    expect(result?.accTokens).toBe(branch.slice(1).reduce((sum, item) => sum + rc.estimator.message(item.message as any), 0));
  });

  it("prioritizes the 30K tail over two old user turns in a production-shaped session", () => {
    const branch: SessionMessageEntry[] = [
      messageEntry("old-user", null, { role: "user", content: [{ type: "text", text: "old constraint" }] }),
    ];
    for (let i = 0; i < 52; i++) {
      const callId = "long-call-" + i;
      branch.push(messageEntry("long-call-msg-" + i, branch.at(-1)!.id as string, {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "src/f" + i + ".ts" } }],
      }));
      branch.push(messageEntry("long-result-" + i, "long-call-msg-" + i, {
        role: "toolResult",
        toolCallId: callId,
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(13_000) }],
      }));
    }
    branch.push(messageEntry("second-user", branch.at(-1)!.id as string, {
      role: "user", content: [{ type: "text", text: "older target that must be summarized" }],
    }));
    branch.push(messageEntry("tail", "second-user", {
      role: "assistant", content: [{ type: "text", text: "z".repeat(145_000) }],
    }));

    const rc = makePreparedRc(branch, 30_000);
    rc.mode = "thorough";
    rc.profile = "light";
    rc.profileCfg.summaryBudgetTokens = 10_000;
    rc.ctx.model = { id: "gpt-5.6-sol", provider: "openai-codex", contextWindow: 272_000 } as any;
    rc.ctx.getContextUsage = () => ({ tokens: 174_797, contextWindow: 272_000, percent: 64.3 } as any);

    const result = resolveCompactionWindow(rc)!;

    expect(result.compactTokens).toBeGreaterThan(130_000);
    expect(result.accTokens).toBeGreaterThan(28_000);
    expect(result.accTokens).toBeLessThan(35_000);
    expect(result.compactionPlan.projectedYield).toBeGreaterThan(0.5);
    expect(result.compactionPlan.fixedContextTokens).toBeGreaterThanOrEqual(0);
    expect(result.compactionPlan.retentionTargetTokens).toBeGreaterThanOrEqual(result.accTokens);
    expect(result.compactionPlan.summaryBudgetTokens).toBe(10_000);
    expect(result.compactionPlan.targetAfterTokens).toBe(
      result.compactionPlan.fixedContextTokens + result.compactionPlan.retentionTargetTokens + 10_000,
    );
    expect(result.compactionPlan.hardBoundaryAdjusted).toBeFalse();
    expect(result.compactionPlan.relaxedSoftBoundaries).toContain("recent-user-turn");
  });

  it("stops a low-yield manual plan before LLM work", () => {
    const notices: string[] = [];
    const branch = [
      messageEntry("old", null, { role: "user", content: [{ type: "text", text: "x".repeat(20_000) }] }),
      messageEntry("recent", "old", { role: "user", content: [{ type: "text", text: "y".repeat(75_000) }] }),
      messageEntry("tail", "recent", { role: "assistant", content: [{ type: "text", text: "z".repeat(75_000) }] }),
    ];
    const rc = makePreparedRc(branch, 30_000);
    const estimated = branch.reduce((sum, entry) => sum + rc.estimator.message(entry.message as any), 0);
    rc.profileCfg.summaryBudgetTokens = 6_000;
    rc.ctx.model = { id: "manual", provider: "test", contextWindow: 100_000 } as any;
    rc.ctx.getContextUsage = () => ({ tokens: estimated, contextWindow: 100_000, percent: estimated / 1_000 } as any);
    rc.notify = message => { notices.push(message); };

    expect(resolveCompactionWindow(rc)).toBeNull();
    expect(notices.join(" ")).toContain("projected saving is below 10%");
  });

  it("recovers with EESV when reported usage exceeds the active model window", () => {
    const notices: string[] = [];
    const branch = Array.from({ length: 16 }, (_, index) => messageEntry(
      "overflow-" + index,
      index ? "overflow-" + (index - 1) : null,
      {
        role: index === 2 ? "user" : "assistant",
        content: [{ type: "text", text: "message " + index + " " + "x".repeat(10_000) }],
      },
    ));
    const rc = makePreparedRc(branch, 10_000);
    rc.flags.force = false;
    rc.mode = "aggressive";
    rc.profileCfg.summaryBudgetTokens = 3_000;
    rc.ctx.model = { id: "gpt-5.6-sol", provider: "openai-codex", contextWindow: 272_000 } as any;
    rc.ctx.getContextUsage = () => ({ tokens: 372_358, contextWindow: 272_000, percent: 137 } as any);
    rc.notify = message => { notices.push(message); };

    const result = resolveCompactionWindow(rc);

    expect(result).not.toBeNull();
    expect(result!.compactTokens).toBeGreaterThan(200_000);
    expect(result!.accTokens + rc.profileCfg.summaryBudgetTokens).toBeLessThan(rc.ctx.model!.contextWindow);
    expect(notices.join(" ")).toContain("native fallback would resend the oversized context");
  });

  it("falls back before spending tokens when a protected tail cannot drop below the trigger", () => {
    const notices: string[] = [];
    const toolCallId = "anchor-call";
    const branch = [
      messageEntry("very-old", null, { role: "user", content: [{ type: "text", text: "very old" }] }),
      messageEntry("very-old-answer", "very-old", { role: "assistant", content: [{ type: "text", text: "old answer" }] }),
      messageEntry("old", "very-old-answer", { role: "user", content: [{ type: "text", text: "old context" }] }),
      messageEntry("anchor-request", "old", { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "context", arguments: { action: "anchor" } }] }),
      messageEntry("anchor", "anchor-request", { role: "toolResult", toolCallId, toolName: "context", details: { anchor: true }, content: [{ type: "text", text: "checkpoint" }] }),
      messageEntry("kept", "anchor", { role: "assistant", content: [{ type: "text", text: "protected " + "y".repeat(2_000) }] }),
      messageEntry("latest", "kept", { role: "user", content: [{ type: "text", text: "latest request" }] }),
    ];
    const rc = makePreparedRc(branch, 1);
    rc.flags.force = false;
    rc.ctx.model = { id: "primary", provider: "openai", contextWindow: 1_000 } as any;
    rc.ctx.getContextUsage = () => ({ tokens: 900, contextWindow: 1_000, percent: 90 } as any);
    rc.profileCfg.summaryBudgetTokens = 100;
    rc.notify = message => { notices.push(message); };

    expect(resolveCompactionWindow(rc)).toBeNull();
    expect(notices[0]).toContain("using native compaction instead");
  });
});
