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
    _prepared: true,
  } as unknown as PreparedRc;
}

describe("resolveCompactionWindow tool-result boundary", () => {
  it("does not choose a trailing toolResult as firstKeptId when the recent tail is smaller than keepRecentTokens", () => {
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

    expect(result).not.toBeNull();
    expect(result?.firstKeptId).toBe("m2-assistant-toolcall");
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

    expect(result).not.toBeNull();
    expect(result?.firstKeptId).toBe("m2-assistant-toolcall");
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
});
