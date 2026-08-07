import { describe, expect, it } from "bun:test";
import { resolveCompactionWindow } from "../src/app/steps/window.ts";
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

  it("counts large tool-call arguments in the recent-tail budget", () => {
    const branch: SessionMessageEntry[] = [];
    for (let i = 0; i < 45; i++) {
      branch.push(messageEntry("a" + i, i ? "r" + (i - 1) : null, {
        role: "assistant",
        content: [{ type: "toolCall", id: "w" + i, name: "write", arguments: { path: "src/f" + i + ".ts", content: "x".repeat(2000) } }],
      }));
      branch.push(messageEntry("r" + i, "a" + i, {
        role: "toolResult", toolCallId: "w" + i, content: [{ type: "text", text: "ok" }],
      }));
    }

    const result = resolveCompactionWindow(makePreparedRc(branch, 20_000));

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
    (rc.ctx.sessionManager as any).getBranch = () => { throw new Error("append-only history must not be read"); };
    (rc.ctx.sessionManager as any).buildContextEntries = () => active;

    const result = resolveCompactionWindow(rc);

    expect(result?.msgs.map(message => message.id)).toEqual(active.map(message => message.id));
    expect(result?.toCompact.map(message => message.id)).toEqual(active.slice(0, 2).map(message => message.id));
  });

  it("keeps the two most recent user turns when enough history exists", () => {
    const branch = [
      messageEntry("u1", null, { role: "user", content: [{ type: "text", text: "first" }] }),
      messageEntry("a1", "u1", { role: "assistant", content: [{ type: "text", text: "first answer" }] }),
      messageEntry("u2", "a1", { role: "user", content: [{ type: "text", text: "second" }] }),
      messageEntry("a2", "u2", { role: "assistant", content: [{ type: "text", text: "second answer" }] }),
      messageEntry("u3", "a2", { role: "user", content: [{ type: "text", text: "third" }] }),
      messageEntry("a3", "u3", { role: "assistant", content: [{ type: "text", text: "third answer" }] }),
    ];

    const result = resolveCompactionWindow(makePreparedRc(branch, 1));

    expect(result?.firstKeptId).toBe("u2");
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
    const result = resolveCompactionWindow(rc)!;
    expect(result.accTokens).toBeGreaterThan(6_000); // 4% adaptive minimum
    expect(result.accTokens).toBeLessThan(30_000); // bounded near the 40% target
  });

  it("recounts the retained tail after anchor protection expands it", () => {
    const toolCallId = "anchor-call";
    const branch = [
      messageEntry("old", null, { role: "user", content: [{ type: "text", text: "old " + "x".repeat(500) }] }),
      messageEntry("anchor-request", "old", { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "context", arguments: { action: "anchor" } }] }),
      messageEntry("anchor", "anchor-request", { role: "toolResult", toolCallId, toolName: "context", details: { anchor: true }, content: [{ type: "text", text: "checkpoint" }] }),
      messageEntry("kept-1", "anchor", { role: "assistant", content: [{ type: "text", text: "kept " + "y".repeat(500) }] }),
      messageEntry("u2", "kept-1", { role: "user", content: [{ type: "text", text: "second turn" }] }),
      messageEntry("a2", "u2", { role: "assistant", content: [{ type: "text", text: "second answer" }] }),
      messageEntry("u3", "a2", { role: "user", content: [{ type: "text", text: "tail" }] }),
    ];
    const rc = makePreparedRc(branch, 1);

    const result = resolveCompactionWindow(rc);

    expect(result?.firstKeptId).toBe("anchor-request");
    expect(result?.accTokens).toBe(rc.estimator.messages(branch.slice(1).map(item => item.message as any)));
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
