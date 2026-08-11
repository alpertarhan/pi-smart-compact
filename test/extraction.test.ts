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
  extractMediaAttachments,
  extractStructured,
  nestedToolCallId,
} from "../src/utils/extraction.ts";
import type { LlmMessage, ProfileConfig } from "../src/types.ts";
import { EXTRACTION_LIMITS } from "../src/constants.ts";

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

describe("extractMediaAttachments", () => {
  it("captures image/file metadata without text payload", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: [{ type: "text", text: "inspect this" }, { type: "image", mimeType: "image/png", name: "screen.png", sizeBytes: 1234, data: "base64..." }] },
      { role: "user", content: [{ type: "file", mime_type: "application/pdf", filename: "spec.pdf", url: "https://example.test/spec.pdf" }] },
    ];
    const media = extractMediaAttachments(msgs);
    expect(media).toHaveLength(2);
    expect(media[0]).toMatchObject({ index: 0, kind: "image", mimeType: "image/png", name: "screen.png", sizeBytes: 1234, source: "inline" });
    expect(media[1]).toMatchObject({ index: 1, kind: "file", mimeType: "application/pdf", name: "spec.pdf", source: "url" });
  });
});

describe("trackFileOps", () => {
  it("detects file modifications", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "write", arguments: { path: "/tmp/foo.ts", content: "export const foo = 1;" } }] },
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

  it("does not infer deletion from source prose and lets newer access revive a path", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "delete", arguments: { path: "/tmp/bar.ts" } }] },
      { role: "toolResult", toolCallId: "1", content: "deleted" },
      { role: "assistant", content: [{ type: "toolCall", id: "2", name: "read", arguments: { path: "/tmp/bar.ts" } }] },
      { role: "toolResult", toolCallId: "2", content: "// removed legacy branch, file remains" },
    ];
    const ops = trackFileOps(msgs);
    expect(ops.deleted).toEqual([]);
    expect(ops.read).toEqual(["/tmp/bar.ts"]);
  });

  it("classifies payload-carrying path tools as modifications (name-agnostic)", () => {
    // Names are deliberately varied/unknown to prove classification is by
    // argument shape, not name: any tool carrying a path + content payload is
    // a write, including ones this code has never seen.
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [
        { type: "toolCall", id: "1", name: "patch_file", arguments: { path: "/tmp/a.ts", patch: "@@ diff @@" } },
        { type: "toolCall", id: "2", name: "create_file", arguments: { path: "/tmp/b.ts", content: "b" } },
        { type: "toolCall", id: "3", name: "append_file", arguments: { path: "/tmp/c.ts", content: "c" } },
        { type: "toolCall", id: "4", name: "update_file", arguments: { path: "/tmp/d.ts", content: "d" } },
        { type: "toolCall", id: "5", name: "hypa_write", arguments: { path: "/tmp/e.ts", content: "e" } },
        { type: "toolCall", id: "6", name: "totally_unknown_mcp_tool", arguments: { path: "/tmp/f.ts", content: "f" } },
      ] },
      { role: "toolResult", toolCallId: "1", content: "patched" },
      { role: "toolResult", toolCallId: "2", content: "created" },
      { role: "toolResult", toolCallId: "3", content: "appended" },
      { role: "toolResult", toolCallId: "4", content: "updated" },
      { role: "toolResult", toolCallId: "5", content: "written" },
      { role: "toolResult", toolCallId: "6", content: "written" },
    ];
    const ops = trackFileOps(msgs);
    expect(ops.modified.map(f => f.path).sort()).toEqual(["/tmp/a.ts", "/tmp/b.ts", "/tmp/c.ts", "/tmp/d.ts", "/tmp/e.ts", "/tmp/f.ts"]);
  });

  it("detects MCP edit aliases without treating generic path + text as a write", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [
        { type: "toolCall", id: "1", name: "mcp__filesystem__edit_file", arguments: { target_file: "/tmp/a.ts", old_str: "a", new_str: "b" } },
        { type: "toolCall", id: "2", name: "read_text_file", arguments: { absolute_path: "/tmp/b.ts", text: "display mode" } },
      ] },
      { role: "toolResult", toolCallId: "1", content: "edited" },
      { role: "toolResult", toolCallId: "2", content: "content" },
    ];

    const ops = trackFileOps(msgs);
    expect(ops.modified.map(file => file.path)).toEqual(["/tmp/a.ts"]);
    expect(ops.read).toEqual(["/tmp/b.ts"]);
  });

  it("ignores no-op edits", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "edit", arguments: { path: "/tmp/x.ts", oldText: "a", newText: "b" } }] },
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

  it("excludes transient provider and invocation diagnostics from continuity errors", () => {
    const messages = [
      "Brave Search API error (429): rate limit exceeded for plan",
      "npm error code ENOLOCK\nnpm error audit This command requires an existing lockfile",
      "Found 2 occurrences of edits[2] in test/a.ts. Each oldText must be unique.",
      "Unknown JSON field: url Available fields: tagName name",
    ];
    for (const [index, content] of messages.entries()) {
      const id = String(index);
      expect(catalogErrors([
        { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "failing command" } }] },
        { role: "toolResult", toolCallId: id, isError: true, content },
      ])).toEqual([]);
    }
    expect(catalogErrors([
      { role: "assistant", content: [{ type: "toolCall", id: "real", name: "bash", arguments: { command: "bun test" } }] },
      { role: "toolResult", toolCallId: "real", isError: true, content: "test failed in auth.ts" },
    ])).toHaveLength(1);
  });

  it("keeps real project test failures that mention HTTP 429 rate limits", () => {
    const errors = catalogErrors([
      { role: "assistant", content: [{ type: "toolCall", id: "429-test", name: "bash", arguments: { command: "bun test" } }] },
      {
        role: "toolResult", toolCallId: "429-test", isError: true,
        content: "FAIL rate limiter returns HTTP 429 when rate limit is exceeded\nExpected: 429\nReceived: 200",
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].tool).toBe("bash");
  });

  it("ignores rg/grep exit 1 when every chained command is a search", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "rg missing src && grep absent README.md" } }] },
      { role: "toolResult", toolCallId: "1", isError: true, content: "(no output)\n\nCommand exited with code 1" },
    ];
    expect(catalogErrors(msgs)).toEqual([]);
  });

  it("ignores a successful search whose piped output was truncated and marked as an error", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "rg runId src | head -n 120" } }] },
      { role: "toolResult", toolCallId: "1", isError: true, content: "src/index.ts:1: runId\n... [truncated 4805 chars] ..." },
    ];
    expect(catalogErrors(msgs)).toEqual([]);
  });

  it("does not hide a failing command chained after a search", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "rg present src && bun test" } }] },
      { role: "toolResult", toolCallId: "1", isError: true, content: "1 test failed\n\nCommand exited with code 1" },
    ];
    expect(catalogErrors(msgs)).toHaveLength(1);
  });

  it("does not treat source text mentioning ERROR as a failed command", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "cat src/status.ts" } }] },
      { role: "toolResult", toolCallId: "1", content: "export const STATUS = {\n  label: 'ERROR: shown when validation fails'\n};" },
    ];
    expect(catalogErrors(msgs)).toEqual([]);
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

  it("mines multiline recap bullets without absorbing later command errors", () => {
    const msgs: LlmMessage[] = [{
      role: "user",
      content: "## Constraints\n- Do not publish stable before approval\n\nnpm audit This command requires an existing lockfile\nnpm error The package could not be found or you do not have permission\nnpm notice Publishing with public access",
    }];
    const cons = mineConstraints(msgs);
    expect(cons.map(item => item.text)).toEqual(["Do not publish stable before approval"]);
  });


  it("prioritizes Turkish prohibition semantics over embedded requirement words", () => {
    const constraints = mineConstraints([{
      role: "user",
      content: "Bunu yapma; onay olmadan release kesinlikle yapılmamalı",
    }]);
    expect(constraints).toHaveLength(1);
    expect(constraints[0].category).toBe("prohibition");
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
  it("uses the latest substantive request while ignoring commands and acknowledgements", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "/compact" },
      { role: "user", content: "Build a todo app" },
      { role: "user", content: "Now fix the authentication regression" },
      { role: "user", content: "tamam devam et" },
    ];
    expect(extractMainGoal(msgs)).toBe("Now fix the authentication regression");
  });

  it("recovers the canonical goal from a host compaction summary", () => {
    const compacted = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nShip the stable release\n\n## Progress\n- working\n</summary>";
    expect(extractMainGoal([
      { role: "user", content: compacted },
      { role: "user", content: "okay" },
    ])).toBe("Ship the stable release");
  });

  it("treats a goal-less host summary as a boundary to older raw goals", () => {
    const compacted = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Progress\n- working\n</summary>";
    expect(extractMainGoal([
      { role: "user", content: "Old raw goal that predates compaction" },
      { role: "user", content: compacted },
    ])).toBeNull();
  });

  it("does not revive a compaction status banner as the active goal", () => {
    const compacted = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nEESV Compact (model, balanced) — 259,782t Warning: Smart compact skipped\n</summary>";
    expect(extractMainGoal([{ role: "user", content: compacted }])).toBeNull();
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
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "write", arguments: { path: "/src/Login.tsx", content: "export default function Login() {}" } }] },
      { role: "toolResult", toolCallId: "1", content: "file written" },
      { role: "assistant", content: [{ type: "toolCall", id: "2", name: "bash", arguments: { cmd: "npm test" } }] },
      { role: "toolResult", toolCallId: "2", content: "test failed" },
    ];
    const ext = extractStructured(msgs, PC);
    expect(ext.messageCount).toBe(5);
    expect(ext.mediaAttachments).toEqual([]);
    expect(ext.modifiedFiles.length).toBe(1);
    expect(ext.modifiedFiles[0].path).toBe("/src/Login.tsx");
    expect(ext.errors.length).toBe(1);
    expect(ext.mainGoal).toBe("Create a login page");
  });

  it("grounds file paths mentioned in compacted prose", () => {
    const ext = extractStructured([
      { role: "user", content: "The removed test/llm-retry.test.ts remains relevant." },
    ], PC);
    expect(ext.referencedFiles).toContain("test/llm-retry.test.ts");
  });

  it("bounds high-cardinality evidence and records omitted counts", () => {
    const messages: LlmMessage[] = [];
    for (let index = 0; index < EXTRACTION_LIMITS.READ_FILES + 50; index++) {
      const id = "read-" + index;
      messages.push(
        { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "src/file-" + index + ".ts" } }] },
        { role: "toolResult", toolCallId: id, content: "ok" },
      );
    }
    const extraction = extractStructured(messages, PC);
    expect(extraction.readFiles).toHaveLength(EXTRACTION_LIMITS.READ_FILES);
    expect(extraction.evidenceOverflow?.readFiles).toBe(50);
  });
});

// ── multi_tool_use.parallel wrapper shape ──

describe("buildToolCallIndex — multi_tool_use.parallel", () => {
  it("uses one exact identity contract for real and synthetic nested calls", () => {
    expect(nestedToolCallId("wrapper", 7, 2, "real-id")).toBe("real-id");
    expect(nestedToolCallId("wrapper", 7, 2)).toBe("wrapper_2");
    expect(nestedToolCallId(undefined, 7, 2)).toBe("mtu_7_2");
  });

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
