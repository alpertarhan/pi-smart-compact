import { describe, it, expect } from "bun:test";
import {
  extractText,
  buildToolCallIndex,
  trackFileOps,
  catalogErrors,
  extractDecisions,
  mineConstraints,
  segmentTopicsHeuristic,
  extractMainGoal,
  extractStructured,
} from "../src/utils/extraction.ts";
import type { LlmMessage, ProfileConfig } from "../src/types.ts";

const PC: ProfileConfig = {
  summaryBudgetTokens: 6000, keepRecentTokens: 20000,
  minChunkTokens: 500, maxChunkTokens: 8000,
  singlePassMaxTokens: 30000, batchMaxTokens: 24000,
};

function msg(role: LlmMessage["role"], content: string, extras?: Partial<LlmMessage>): LlmMessage {
  return { role, content, ...extras };
}

describe("extractText", () => {
  it("extracts plain string", () => {
    expect(extractText("hello")).toBe("hello");
  });
  it("extracts text blocks", () => {
    expect(extractText([{ type: "text", text: "hi" }, { type: "text", text: " there" }])).toBe("hi there");
  });
  it("returns empty for unknown", () => {
    expect(extractText(42)).toBe("");
  });
});

describe("trackFileOps", () => {
  it("detects file modifications", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "write", arguments: { path: "/tmp/foo.ts" } }] },
      { role: "toolResult", toolCallId: "1", content: "written" },
    ];
    const ops = trackFileOps(msgs);
    expect(ops.modified.length).toBe(1);
    expect(ops.modified[0].path).toBe("/tmp/foo.ts");
    expect(ops.read.length).toBe(0);
  });

  it("detects file reads", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "/tmp/bar.ts" } }] },
      { role: "toolResult", toolCallId: "1", content: "content" },
    ];
    const ops = trackFileOps(msgs);
    expect(ops.read.length).toBe(1);
    expect(ops.read[0]).toBe("/tmp/bar.ts");
  });

  it("ignores no-op edits", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "edit", arguments: { path: "/tmp/x.ts" } }] },
      { role: "toolResult", toolCallId: "1", content: "applied: 0" },
    ];
    const ops = trackFileOps(msgs);
    expect(ops.modified.length).toBe(0);
  });
});

describe("catalogErrors", () => {
  it("catalogs tool errors", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { cmd: "ls" } }] },
      { role: "toolResult", toolCallId: "1", isError: true, content: "command not found" },
    ];
    const errs = catalogErrors(msgs);
    expect(errs.length).toBe(1);
    expect(errs[0].tool).toBe("bash");
  });

  it("detects bash errors in successful results", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { cmd: "npm test" } }] },
      { role: "toolResult", toolCallId: "1", content: "test failed with 3 errors" },
    ];
    const errs = catalogErrors(msgs);
    expect(errs.length).toBe(1);
    expect(errs[0].message).toContain("test failed");
  });
});

describe("extractDecisions", () => {
  it("extracts explicit ask_user decisions", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "ask_user", arguments: { question: "Which approach?" } }] },
      { role: "toolResult", toolCallId: "1", content: "Option A" },
    ];
    const dec = extractDecisions(msgs);
    expect(dec.length).toBe(1);
    expect(dec[0].type).toBe("explicit");
    expect(dec[0].summary).toContain("Which approach?");
  });

  it("extracts implicit decisions from user messages", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "Let's go with React instead of Vue" },
    ];
    const dec = extractDecisions(msgs);
    expect(dec.length).toBe(1);
    expect(dec[0].type).toBe("implicit");
  });
});

describe("mineConstraints", () => {
  it("mines requirement constraints", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "You must use TypeScript" },
    ];
    const cons = mineConstraints(msgs);
    expect(cons.length).toBe(1);
    expect(cons[0].category).toBe("requirement");
  });

  it("ignores short messages and commands", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "/help" },
      { role: "user", content: "ok" },
    ];
    const cons = mineConstraints(msgs);
    expect(cons.length).toBe(0);
  });
});

describe("extractMainGoal", () => {
  it("extracts first non-command user message", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "/compact" },
      { role: "user", content: "Build a todo app" },
    ];
    expect(extractMainGoal(msgs)).toBe("Build a todo app");
  });
});

describe("extractStructured", () => {
  it("returns empty extraction for empty messages", () => {
    const ext = extractStructured([], PC);
    expect(ext.messageCount).toBe(0);
    expect(ext.modifiedFiles.length).toBe(0);
    expect(ext.errors.length).toBe(0);
  });

  it("extracts all facets from a realistic conversation", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "Create a login page" },
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "write", arguments: { path: "/src/Login.tsx" } }] },
      { role: "toolResult", toolCallId: "1", content: "file written" },
      { role: "assistant", content: [{ type: "toolCall", id: "2", name: "bash", arguments: { cmd: "npm test" } }] },
      { role: "toolResult", toolCallId: "2", content: "test failed" },
    ];
    const ext = extractStructured(msgs, PC);
    expect(ext.messageCount).toBe(5);
    expect(ext.modifiedFiles.length).toBe(1);
    expect(ext.modifiedFiles[0].path).toBe("/src/Login.tsx");
    expect(ext.errors.length).toBe(1);
    expect(ext.mainGoal).toBe("Create a login page");
  });
});

// ── multi_tool_use.parallel wrapper shape ──

describe("buildToolCallIndex — multi_tool_use.parallel", () => {
  it("flattens nested tool_uses with real ids when present", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_mtu_abc",
          name: "multi_tool_use.parallel",
          arguments: {
            tool_uses: [
              { id: "call_read1", recipient_name: "functions.read", parameters: { path: "/src/a.ts" } },
              { id: "call_write1", recipient_name: "functions.write", parameters: { path: "/src/b.ts", content: "x" } },
            ],
          },
        }],
      },
      { role: "toolResult", toolCallId: "call_read1", content: "a content" },
      { role: "toolResult", toolCallId: "call_write1", content: "written" },
    ];
    const idx = buildToolCallIndex(msgs);
    expect(idx.has("call_read1")).toBe(true);
    expect(idx.has("call_write1")).toBe(true);
    expect(idx.get("call_read1")!.name).toBe("read");
    expect(idx.get("call_write1")!.name).toBe("write");
  });

  it("falls back to synthetic ids when real ids are missing", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_mtu_xyz",
          name: "multi_tool_use.parallel",
          arguments: {
            tool_uses: [
              { recipient_name: "functions.read", parameters: { path: "/src/a.ts" } },
            ],
          },
        }],
      },
      { role: "toolResult", toolCallId: "call_mtu_xyz_0", content: "a content" },
    ];
    const idx = buildToolCallIndex(msgs);
    expect(idx.has("call_mtu_xyz_0")).toBe(true);
    expect(idx.get("call_mtu_xyz_0")!.name).toBe("read");
  });

  it("trackFileOps sees flattened multi-tool file ops", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_mtu",
          name: "multi_tool_use.parallel",
          arguments: {
            tool_uses: [
              { id: "r1", recipient_name: "functions.read", parameters: { path: "/src/config.ts" } },
              { id: "w1", recipient_name: "functions.write", parameters: { path: "/src/out.ts", content: "x" } },
            ],
          },
        }],
      },
      { role: "toolResult", toolCallId: "r1", content: "config content" },
      { role: "toolResult", toolCallId: "w1", content: "file written" },
    ];
    const ops = trackFileOps(msgs);
    expect(ops.read).toContain("/src/config.ts");
    expect(ops.modified.map(m => m.path)).toContain("/src/out.ts");
  });

  it("catalogErrors links multi-tool errors via real ids", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_mtu",
          name: "multi_tool_use.parallel",
          arguments: {
            tool_uses: [
              { id: "b1", recipient_name: "functions.bash", parameters: { cmd: "npm test" } },
            ],
          },
        }],
      },
      { role: "toolResult", toolCallId: "b1", content: "FAIL src/auth.test.ts\n  ● login should return token\n    Error: connect ECONNREFUSED" },
    ];
    const errs = catalogErrors(msgs);
    expect(errs.length).toBe(1);
    expect(errs[0].tool).toBe("bash");
  });

  it("segmentTopicsHeuristic sees flattened multi-tool file ops", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "Do parallel work" },
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_mtu",
          name: "multi_tool_use.parallel",
          arguments: {
            tool_uses: [
              { id: "w1", recipient_name: "functions.write", parameters: { path: "/src/a.ts", content: "x" } },
              { id: "r1", recipient_name: "functions.read", parameters: { path: "/src/b.ts" } },
            ],
          },
        }],
      },
      { role: "toolResult", toolCallId: "w1", content: "written" },
      { role: "toolResult", toolCallId: "r1", content: "content" },
    ];
    const topics = segmentTopicsHeuristic(msgs, PC);
    // Should have at least one topic classified as implementation (write)
    expect(topics.some(t => t.type === "implementation")).toBe(true);
  });

  it("detects retry and resolution inside multi_tool_use.parallel", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_mtu1",
          name: "multi_tool_use.parallel",
          arguments: {
            tool_uses: [
              { id: "b1", recipient_name: "functions.bash", parameters: { cmd: "npm test" } },
            ],
          },
        }],
      },
      { role: "toolResult", toolCallId: "b1", content: "FAIL src/auth.test.ts\n  ● login should return token\n    Error: connect ECONNREFUSED" },
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_mtu2",
          name: "multi_tool_use.parallel",
          arguments: {
            tool_uses: [
              { id: "b2", recipient_name: "functions.bash", parameters: { cmd: "npm test -- --retry" } },
            ],
          },
        }],
      },
      { role: "toolResult", toolCallId: "b2", content: "Tests passing ✓" },
    ];
    const errs = catalogErrors(msgs);
    expect(errs.length).toBe(1);
    expect(errs[0].tool).toBe("bash");
    expect(errs[0].retryAttempted).toBe(true);
    expect(errs[0].resolved).toBe(true);
  });
});
