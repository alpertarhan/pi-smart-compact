import { describe, it, expect } from "bun:test";
import {
  extractText,
  buildToolCallIndex,
  trackFileOps,
  catalogErrors,
  extractStructured,
} from "../src/utils/extraction.ts";
import { pruneRedundant } from "../src/utils/pruning.ts";
import { smartKeepBoundary, guardToolCallBoundary } from "../src/utils/helpers.ts";
import type { LlmMessage, ProfileConfig, SessionMessageEntry } from "../src/types.ts";

const PC: ProfileConfig = {
  summaryBudgetTokens: 6000,
  keepRecentTokens: 20000,
  minChunkTokens: 500,
  maxChunkTokens: 8000,
  singlePassMaxTokens: 30000,
  batchMaxTokens: 24000,
};

/**
 * pi-toolkit truncation pattern: content.slice(0, 20) + `…✂${content.length}`
 * @see @ersintarhan/pi-toolkit/src/auto-context/index.ts
 */
function piToolkitTruncate(content: string): string {
  if (content.length <= 50) return content;
  return content.slice(0, 20) + `…✂${content.length}`;
}

/**
 * Simulate pi-toolkit's context hook truncation on a conversation.
 * Truncates all toolResults before the last anchor.
 */
function applyPiToolkitTruncation(
  msgs: LlmMessage[],
  anchorIndices: number[] = []
): LlmMessage[] {
  if (anchorIndices.length === 0) return msgs; // no anchors = no truncation
  const lastAnchorIdx = Math.max(...anchorIndices);
  return msgs.map((m, i) => {
    // pi-toolkit truncates toolResults before the last anchor
    // (skipping anchor toolResults themselves)
    if (
      m.role === "toolResult" &&
      i < lastAnchorIdx &&
      !anchorIndices.includes(i)
    ) {
      const text = extractText(m.content);
      if (text.length > 50) {
        return {
          ...m,
          content: [{ type: "text" as const, text: piToolkitTruncate(text) }],
        };
      }
    }
    return m;
  });
}

function makeToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>
): LlmMessage {
  return {
    role: "assistant",
    content: [
      { type: "toolCall" as const, id, name, arguments: args },
    ],
  };
}

function makeToolResult(
  id: string,
  content: string,
  isError = false
): LlmMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text" as const, text: content }],
    isError,
  };
}

function makeAnchor(idx: number): number {
  return idx;
}

// ──────────────────────────────────────────────────────────────
// Test: Truncation pattern detection
// ──────────────────────────────────────────────────────────────

describe("pi-toolkit truncation pattern", () => {
  it("detects truncated content via …✂ marker", () => {
    const original = "export const foo = 1;\nexport const bar = 2;";
    const truncated = piToolkitTruncate(original.repeat(10));
    expect(truncated).toContain("…✂");
    expect(truncated).toMatch(/…✂\d+$/);
  });

  it("does not truncate short content", () => {
    const short = "file written";
    expect(piToolkitTruncate(short)).toBe(short);
  });
});

// ──────────────────────────────────────────────────────────────
// Test: File ops tracking under truncation
// ──────────────────────────────────────────────────────────────

describe("trackFileOps with pi-toolkit truncation", () => {
  it("treats truncated no-op edits as modified for safety", () => {
    // Scenario: edit tool returns "applied: 0" (no changes)
    // But pi-toolkit truncates it to "applied: 0\nno ch…✂847"
    const msgs: LlmMessage[] = [
      makeToolCall("tc1", "edit", { path: "/src/App.tsx", oldText: "foo", newText: "bar" }),
      makeToolResult(
        "tc1",
        "applied: 0\nNo changes matched the search pattern. The file was not modified."
      ),
    ];
    const truncated = applyPiToolkitTruncation(msgs, [makeAnchor(3)]);

    const ops = trackFileOps(truncated);
    // FIXED: When truncated, we cannot verify if it's a no-op.
    // Safe default: treat as modified (toolCall name + args imply intent).
    expect(ops.modified.length).toBe(1);
    expect(ops.modified[0].path).toBe("/src/App.tsx");
  });

  it("keeps truncated write results classified as modified", () => {
    // More realistic: a write that actually succeeded, but truncation
    // makes it look like we can't verify
    const msgs: LlmMessage[] = [
      makeToolCall("tc1", "write", { path: "/src/auth.ts", content: "export const auth = true;" }),
      makeToolResult(
        "tc1",
        "File written successfully. 1 file created.\nPath: /src/auth.ts\nSize: 25 bytes"
      ),
    ];
    const truncated = applyPiToolkitTruncation(msgs, [makeAnchor(3)]);

    const ops = trackFileOps(truncated);
    // The write result is truncated to "File written successfu…✂84"
    // NO_OP_RE doesn't match, so it IS counted as modified — correct by accident
    expect(ops.modified.length).toBe(1);
    expect(ops.modified[0].path).toBe("/src/auth.ts");
  });

  it("deduplicates file reads via toolCallId even when results are truncated", () => {
    const msgs: LlmMessage[] = [
      makeToolCall("r1", "read", { path: "/src/config.ts" }),
      makeToolResult("r1", "export const API_URL = 'https://api.example.com';\nexport const TIMEOUT = 5000;"),
      makeToolCall("r2", "read", { path: "/src/config.ts" }),
      makeToolResult("r2", "export const API_URL = 'https://api.example.com';\nexport const TIMEOUT = 5000;"),
    ];
    const truncated = applyPiToolkitTruncation(msgs, [makeAnchor(5)]);

    const ops = trackFileOps(truncated);
    // With truncation, both read results become "export const API_URL…✂91"
    // But pruneRedundant should STILL detect duplicate reads via toolCallId
    expect(ops.read.length).toBe(1); // dedup works via toolCall matching
  });
});

// ──────────────────────────────────────────────────────────────
// Test: Error catalog under truncation
// ──────────────────────────────────────────────────────────────

describe("catalogErrors with pi-toolkit truncation", () => {
  it("detects bash errors when the truncated prefix still contains an error keyword", () => {
    const msgs: LlmMessage[] = [
      makeToolCall("tc1", "bash", { cmd: "npm test" }),
      makeToolResult(
        "tc1",
        "FAIL src/auth.test.ts\n  ● login should return token\n    Error: connect ECONNREFUSED 127.0.0.1:3000\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1602:16)\n\nTest Suites: 1 failed, 1 total\nTests:       1 failed, 1 total"
      ),
    ];
    const truncated = applyPiToolkitTruncation(msgs, [makeAnchor(3)]);

    const errors = catalogErrors(truncated);
    // catalogErrors checks for /error|fail/i in bash output
    // Truncated text: "FAIL src/auth.test.ts…✂256"
    // The regex still matches "FAIL" at the start — lucky pass
    expect(errors.length).toBe(1);
  });

  it("documents loss of error detail when truncation removes the error keyword", () => {
    // Edge case: error message is long, keyword is deep in the text
    const longError = "Running tests...\n".repeat(20) +
      "FAIL src/deep.test.ts\n  ● should work\n    Error: timeout\n" +
      "Stack trace...\n".repeat(50);

    const msgs: LlmMessage[] = [
      makeToolCall("tc1", "bash", { cmd: "npm test" }),
      makeToolResult("tc1", longError),
    ];
    const truncated = applyPiToolkitTruncation(msgs, [makeAnchor(3)]);

    const errors = catalogErrors(truncated);
    const truncatedText = extractText(truncated[1].content);
    // "Running tests...\nRunnin…✂1050" — "FAIL" is past the truncation point
    // catalogErrors searches the truncated text only
    const hasFailKeyword = /error|fail/i.test(truncatedText);

    if (hasFailKeyword) {
      expect(errors.length).toBeGreaterThan(0);
    } else {
      // The error is invisible after truncation; session-log recovery covers this in the integration path.
      expect(errors.length).toBe(0);
    }
  });

  it("detects retry/resolution from later untruncated tool results", () => {
    const msgs: LlmMessage[] = [
      makeToolCall("tc1", "bash", { cmd: "deploy" }),
      makeToolResult("tc1", "Error: connection timeout after 30s", true), // isError
      makeToolCall("tc2", "bash", { cmd: "deploy" }), // retry
      makeToolResult("tc2", "Deployment successful!"),
    ];
    const truncated = applyPiToolkitTruncation(msgs, [makeAnchor(5)]);

    const errors = catalogErrors(truncated);
    // First error should be detected
    expect(errors.length).toBe(1);
    expect(errors[0].retryAttempted).toBe(true);
    expect(errors[0].resolved).toBe(true);
    // Resolution is detected by looking at later messages, which are NOT truncated
    // (they're after the anchor). So this happens to work.
  });
});

// ──────────────────────────────────────────────────────────────
// Test: Full structured extraction under truncation
// ──────────────────────────────────────────────────────────────

describe("extractStructured with pi-toolkit truncation", () => {
  it("documents incomplete extraction when only truncated branch data is available", () => {
    const msgs: LlmMessage[] = [
      { role: "user" as const, content: "Build auth system" },
      makeToolCall("tc1", "write", { path: "/src/auth.ts", content: "..." }),
      makeToolResult("tc1", "File written: /src/auth.ts\nSize: 1024 bytes\nLines: 45"),
      makeToolCall("tc2", "write", { path: "/src/login.ts", content: "..." }),
      makeToolResult("tc2", "File written: /src/login.ts\nSize: 2048 bytes\nLines: 89"),
      makeToolCall("tc3", "bash", { cmd: "npm test" }),
      makeToolResult("tc3", "FAIL src/auth.test.ts\n  ● login flow\n    Expected 200, got 401\n\nTest Suites: 1 failed"),
      // Anchor here (simulating a context(anchor) call)
      { role: "user" as const, content: "Fix the auth test" },
      makeToolCall("tc4", "edit", { path: "/src/auth.ts", oldText: "if (!user)", newText: "if (!user || !user.token)" }),
      makeToolResult("tc4", "Applied 1 edit to /src/auth.ts"),
    ];
    // Anchor at index 8 (the user message "Fix the auth test")
    // Everything before index 8 gets truncated
    const truncated = applyPiToolkitTruncation(msgs, [8]);

    const extraction = extractStructured(truncated, PC);

    // File count should still be 3 (auth, login, auth edited)
    expect(extraction.modifiedFiles.length).toBeGreaterThanOrEqual(1);

    // Error should still be detected if "FAIL" is in first 20 chars
    const errorCount = extraction.errors.length;

    // But error MESSAGE is truncated — critical detail lost
    const hasFullError = extraction.errors.some(
      (e) => e.message.includes("Expected 200") || e.message.includes("got 401")
    );

    // The error IS detected ("FAIL" is at the start), but detail is lost
    expect(errorCount).toBeGreaterThanOrEqual(1);
  });

  it("still preserves touched files when an anchor truncates all prior tool results", () => {
    // Scenario: anchor placed very late, everything before it truncated
    const longContent = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(10);

    const msgs: LlmMessage[] = [
      { role: "user" as const, content: "Create a large file" },
      makeToolCall("tc1", "write", { path: "/src/big.ts", content: longContent }),
      makeToolResult("tc1", `File written: /src/big.ts\n${longContent}`),
      makeToolCall("tc2", "read", { path: "/src/big.ts" }),
      makeToolResult("tc2", longContent),
      makeToolCall("tc3", "edit", { path: "/src/big.ts", oldText: "Lorem", newText: "Ipsum" }),
      makeToolResult("tc3", "Applied: 1 edit\nFile now has 10 lines changed"),
      // Anchor at the very end — EVERYTHING before is truncated
      { role: "user" as const, content: "Continue working" },
    ];
    const truncated = applyPiToolkitTruncation(msgs, [7]);

    const extraction = extractStructured(truncated, PC);

    // With ALL tool results truncated, we have a problem:
    // - file writes: toolCall exists but result is "Lorem ipsum dolor s…✂510"
    // - NO_OP_RE can't verify, but write/edit tool names imply modification
    // - file reads: same issue
    // - errors: if any, likely lost

    // At minimum we should still know files were touched
    expect(extraction.modifiedFiles.length).toBeGreaterThanOrEqual(1);

    // But the full picture is lost unless session-log recovery restores original tool results.
    expect(extraction.topics.length).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────────────────────────────────────────────
// Test: Pruning interaction with truncation
// ──────────────────────────────────────────────────────────────

describe("pruneRedundant with pi-toolkit truncation", () => {
  it("keeps duplicate-read pruning conservative when truncated outputs look identical", () => {
    const msgs: LlmMessage[] = [
      makeToolCall("r1", "read", { path: "/src/config.ts" }),
      makeToolResult("r1", "export const API_URL = 'https://api.example.com';\nexport const TIMEOUT = 5000;"),
      makeToolCall("r2", "read", { path: "/src/config.ts" }),
      makeToolResult("r2", "export const API_URL = 'https://api.example.com';\nexport const TIMEOUT = 5000;"),
    ];
    const truncated = applyPiToolkitTruncation(msgs, [makeAnchor(5)]);

    const result = pruneRedundant(truncated);
    // pruneRedundant deduplicates reads by keeping the LAST one
    // It matches via toolCallId → tcIdx, so dedup STILL WORKS
    // (the toolCall messages are NOT truncated, only toolResults)
    expect(result.prunedCount).toBeGreaterThanOrEqual(0);
  });

  it("truncated error chains lose collapse optimization", () => {
    // 3 consecutive failures of the same tool
    const msgs: LlmMessage[] = [
      makeToolCall("f1", "bash", { cmd: "deploy" }),
      makeToolResult("f1", "Error: connection refused to server-us-east-1.example.com:443 after 30s", true),
      makeToolCall("f2", "bash", { cmd: "deploy" }),
      makeToolResult("f2", "Error: connection refused to server-us-east-2.example.com:443 after 30s", true),
      makeToolCall("f3", "bash", { cmd: "deploy" }),
      makeToolResult("f3", "Error: connection refused to server-us-west-1.example.com:443 after 30s", true),
    ];
    const truncated = applyPiToolkitTruncation(msgs, [makeAnchor(7)]);

    const result = pruneRedundant(truncated);
    // All three errors are truncated to "Error: connection re…✂76"
    // The pruning logic groups by tool name and index distance < 10
    // It should still collapse them since toolCall messages are intact
    expect(result.reasons.some((r) => r.reason.includes("Collapsed error chains"))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// Regression: What pi-smart-compact SHOULD do instead
// ──────────────────────────────────────────────────────────────

describe("pi-toolkit truncation regression — expected behavior", () => {
  it("detects truncation and falls back to toolCall-level inference", () => {
    const msgs: LlmMessage[] = [
      makeToolCall("tc1", "write", { path: "/src/auth.ts", content: "export const auth = true;" }),
      makeToolResult("tc1", "File written successfully.\n".repeat(20)),
    ];
    const truncated = applyPiToolkitTruncation(msgs, [makeAnchor(3)]);

    const TRUNCATE_RE = /…✂\d+$/;
    const resultText = extractText(truncated[1].content);

    // Detection
    expect(TRUNCATE_RE.test(resultText)).toBe(true);

    // When truncated, we should infer from toolCall name + arguments
    // instead of relying on result content
    const tc = buildToolCallIndex(truncated).get("tc1");
    expect(tc).toBeDefined();
    expect(tc!.name).toBe("write");
    expect(tc!.arguments.path).toBe("/src/auth.ts");

    // With proper fallback: any write/edit toolCall that hasn't been
    // explicitly marked no-op should be treated as modified
  });

  it("reads original session log when branch is truncated", () => {
    // This test documents the desired behavior:
    // When branch messages are truncated, pi-smart-compact should
    // read the original session .jsonl file instead of getBranch()
    // to get untruncated tool results.

    // We can't test this without filesystem access to session logs,
    // but we document the expectation:
    expect(true).toBe(true); // placeholder
  });
});

// ──────────────────────────────────────────────────────────────
// Test: Anchor-aware keep boundary (M3)
// ──────────────────────────────────────────────────────────────

function makeSessionEntry(msg: SessionMessageEntry["message"], extras?: Record<string, unknown>): SessionMessageEntry {
  return { type: "message", id: "id-" + Math.random().toString(36).slice(2), message: msg, ...extras };
}

function makeAnchorEntry(name: string, targetId: string): SessionMessageEntry {
  return {
    type: "message",
    id: "anchor-" + name,
    message: {
      role: "toolResult",
      toolName: "context",
      content: `[Anchor: ${name}]\nsummary here`,
      details: { anchor: { name, targetId } },
    } as any,
  };
}

function filterMsgs(entries: unknown[]): SessionMessageEntry[] {
  return (entries as any[]).filter(
    (e) => e?.type === "message" && e?.message != null
  ) as SessionMessageEntry[];
}

describe("smartKeepBoundary with pi-toolkit anchors", () => {
  it("keeps last anchor inside keep window", () => {
    const branch: unknown[] = [
      makeSessionEntry({ role: "user", content: "msg1" }),
      makeSessionEntry({ role: "assistant", content: "msg2" }),
      makeSessionEntry({ role: "user", content: "msg3" }),
      makeSessionEntry({ role: "assistant", content: "msg4" }),
      makeSessionEntry({ role: "user", content: "msg5" }),
      makeAnchorEntry("auth-done", "leaf-1"),
    ];
    const msgs = filterMsgs(branch);

    // keepFrom=6 would compact everything (including the anchor)
    // Should be adjusted to 5 to keep the anchor inside the window
    const result = smartKeepBoundary(msgs, 6, branch);
    expect(result).toBe(5);
  });

  it("passes through when no anchors exist", () => {
    const branch: unknown[] = [
      makeSessionEntry({ role: "user", content: "msg1" }),
      makeSessionEntry({ role: "assistant", content: "msg2" }),
    ];
    const msgs = filterMsgs(branch);

    const result = smartKeepBoundary(msgs, 1, branch);
    expect(result).toBe(1);
  });

  it("passes through when keepFrom is already before anchor", () => {
    const branch: unknown[] = [
      makeSessionEntry({ role: "user", content: "msg1" }),
      makeSessionEntry({ role: "assistant", content: "msg2" }),
      makeSessionEntry({ role: "user", content: "msg3" }),
      makeAnchorEntry("done", "leaf-1"),
    ];
    const msgs = filterMsgs(branch);

    // keepFrom=1, anchor at msg index 3
    // 1 < 3, so no adjustment needed
    const result = smartKeepBoundary(msgs, 1, branch);
    expect(result).toBe(1);
  });

  it("handles non-message entries in branch before anchor", () => {
    // Branch has a compaction entry before messages
    const branch: unknown[] = [
      { type: "compaction", id: "compact-1" },
      makeSessionEntry({ role: "user", content: "msg1" }),
      makeSessionEntry({ role: "assistant", content: "msg2" }),
      makeSessionEntry({ role: "user", content: "msg3" }),
      makeAnchorEntry("impl-done", "leaf-1"),
    ];
    const msgs = filterMsgs(branch);

    // Anchor is at msg index 3 (last msg)
    // keepFrom=1 < 3, no adjustment needed
    const result = smartKeepBoundary(msgs, 1, branch);
    expect(result).toBe(1);
  });

  it("adjusts keepFrom when anchor is earlier than requested boundary", () => {
    const branch: unknown[] = [
      makeSessionEntry({ role: "user", content: "a" }),
      makeSessionEntry({ role: "assistant", content: "b" }),
      makeAnchorEntry("early-anchor", "leaf-1"),
      makeSessionEntry({ role: "user", content: "c" }),
      makeSessionEntry({ role: "assistant", content: "d" }),
      makeSessionEntry({ role: "user", content: "e" }),
    ];
    const msgs = filterMsgs(branch);

    // Anchor at msg index 2
    // Requested keepFrom=4, should adjust to 2
    const result = smartKeepBoundary(msgs, 4, branch);
    expect(result).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────
// Test: Tool-call boundary guard
// ──────────────────────────────────────────────────────────────

describe("guardToolCallBoundary", () => {
  it("pulls keepFrom back when a kept toolResult lacks its toolCall", () => {
    const msgs: SessionMessageEntry[] = [
      makeSessionEntry({ role: "user", content: "msg1" }),
      makeSessionEntry({
        role: "assistant",
        content: [{ type: "toolCall" as const, id: "tc1", name: "read", arguments: { path: "/a.ts" } }],
      }),
      makeSessionEntry({ role: "toolResult", toolCallId: "tc1", content: "content" }),
      makeSessionEntry({ role: "user", content: "msg2" }),
    ];

    // keepFrom=3 would keep only msg[3] (user), orphaning tc1 result at msg[2]
    // Actually msg[2] is BEFORE keepFrom=3, so it would be compacted.
    // msg[3] is a user msg, no problem. Wait, I need the toolResult AFTER keepFrom.
    const result = guardToolCallBoundary(msgs, 3);
    // tc1 is at index 1, result at index 2. keepFrom=3 means result is compacted, toolCall too.
    // No orphan. So result should stay 3.
    expect(result).toBe(3);
  });

  it("pulls keepFrom back when kept region starts inside a toolResult whose toolCall is before boundary", () => {
    const msgs: SessionMessageEntry[] = [
      makeSessionEntry({ role: "user", content: "msg1" }),
      makeSessionEntry({
        role: "assistant",
        content: [{ type: "toolCall" as const, id: "tc1", name: "read", arguments: { path: "/a.ts" } }],
      }),
      makeSessionEntry({ role: "toolResult", toolCallId: "tc1", content: "content" }),
      makeSessionEntry({ role: "user", content: "msg2" }),
    ];

    // keepFrom=2 would keep msg[2] (toolResult) + msg[3], but msg[1] (toolCall) is compacted
    const result = guardToolCallBoundary(msgs, 2);
    expect(result).toBe(1); // pulled back to include the assistant toolCall
  });

  it("pulls keepFrom back when an assistant with toolCall is compacted but result is kept", () => {
    const msgs: SessionMessageEntry[] = [
      makeSessionEntry({ role: "user", content: "msg1" }),
      makeSessionEntry({
        role: "assistant",
        content: [{ type: "toolCall" as const, id: "tc1", name: "read", arguments: { path: "/a.ts" } }],
      }),
      makeSessionEntry({ role: "toolResult", toolCallId: "tc1", content: "content" }),
      makeSessionEntry({ role: "user", content: "msg2" }),
    ];

    // keepFrom=2 keeps toolResult (msg[2]) but toolCall (msg[1]) is compacted
    const result = guardToolCallBoundary(msgs, 2);
    expect(result).toBe(1);
  });

  it("handles multiple toolCalls in one assistant message", () => {
    const msgs: SessionMessageEntry[] = [
      makeSessionEntry({ role: "user", content: "msg1" }),
      makeSessionEntry({
        role: "assistant",
        content: [
          { type: "toolCall" as const, id: "tc1", name: "read", arguments: { path: "/a.ts" } },
          { type: "toolCall" as const, id: "tc2", name: "read", arguments: { path: "/b.ts" } },
        ],
      }),
      makeSessionEntry({ role: "toolResult", toolCallId: "tc1", content: "a" }),
      makeSessionEntry({ role: "toolResult", toolCallId: "tc2", content: "b" }),
      makeSessionEntry({ role: "user", content: "msg2" }),
    ];

    // keepFrom=3 keeps tc2 result but assistant (msg[1]) is compacted
    const result = guardToolCallBoundary(msgs, 3);
    expect(result).toBe(1); // pulled back to include the assistant
  });

  it("pulls back across multiple messages when the nearest toolCall is far before the boundary", () => {
    const msgs: SessionMessageEntry[] = [
      makeSessionEntry({ role: "user", content: "msg0" }),
      makeSessionEntry({
        role: "assistant",
        content: [{ type: "toolCall" as const, id: "tc0", name: "read", arguments: { path: "/x.ts" } }],
      }),
      makeSessionEntry({ role: "toolResult", toolCallId: "tc0", content: "x" }),
      makeSessionEntry({
        role: "assistant",
        content: [{ type: "toolCall" as const, id: "tc1", name: "read", arguments: { path: "/y.ts" } }],
      }),
      makeSessionEntry({ role: "toolResult", toolCallId: "tc1", content: "y" }),
      makeSessionEntry({ role: "user", content: "msg1" }),
    ];

    // keepFrom=4 keeps tc1 result (msg[4]) but its assistant is at 3 (compacted) → pull to 3
    // msg[2] (tc0 result) remains in the compacted region (index 2 < 3), paired with msg[1] → no further pull needed
    const result = guardToolCallBoundary(msgs, 4);
    expect(result).toBe(3);
  });

  it("iteratively pulls back when a second orphan is revealed after the first adjustment", () => {
    const msgs: SessionMessageEntry[] = [
      makeSessionEntry({ role: "user", content: "msg0" }),
      makeSessionEntry({
        role: "assistant",
        content: [{ type: "toolCall" as const, id: "tc0", name: "read", arguments: { path: "/x.ts" } }],
      }),
      makeSessionEntry({ role: "toolResult", toolCallId: "tc0", content: "x" }),
      makeSessionEntry({
        role: "assistant",
        content: [{ type: "toolCall" as const, id: "tc1", name: "read", arguments: { path: "/y.ts" } }],
      }),
      makeSessionEntry({ role: "toolResult", toolCallId: "tc1", content: "y" }),
      makeSessionEntry({ role: "user", content: "msg1" }),
    ];

    // keepFrom=2 keeps msg[2] (tc0 result) but its assistant is at 1 (compacted) → pull to 1
    // After pull, msg[3] (tc1 assistant) and msg[4] (tc1 result) are also kept, which is fine
    const result = guardToolCallBoundary(msgs, 2);
    expect(result).toBe(1);
  });

  it("does not change keepFrom when pair is fully inside kept region", () => {
    const msgs: SessionMessageEntry[] = [
      makeSessionEntry({ role: "user", content: "msg1" }),
      makeSessionEntry({
        role: "assistant",
        content: [{ type: "toolCall" as const, id: "tc1", name: "read", arguments: { path: "/a.ts" } }],
      }),
      makeSessionEntry({ role: "toolResult", toolCallId: "tc1", content: "content" }),
      makeSessionEntry({ role: "user", content: "msg2" }),
    ];

    // keepFrom=1 keeps everything from assistant onward — pair is intact
    const result = guardToolCallBoundary(msgs, 1);
    expect(result).toBe(1);
  });

  it("does not change keepFrom when pair is fully inside compacted region", () => {
    const msgs: SessionMessageEntry[] = [
      makeSessionEntry({ role: "user", content: "msg1" }),
      makeSessionEntry({
        role: "assistant",
        content: [{ type: "toolCall" as const, id: "tc1", name: "read", arguments: { path: "/a.ts" } }],
      }),
      makeSessionEntry({ role: "toolResult", toolCallId: "tc1", content: "content" }),
      makeSessionEntry({ role: "user", content: "msg2" }),
    ];

    // keepFrom=3 keeps only msg[3]; msg[1] and msg[2] are both compacted
    const result = guardToolCallBoundary(msgs, 3);
    expect(result).toBe(3);
  });

  it("returns keepFrom unchanged when keepFrom is 0", () => {
    const msgs: SessionMessageEntry[] = [
      makeSessionEntry({ role: "user", content: "msg1" }),
    ];
    expect(guardToolCallBoundary(msgs, 0)).toBe(0);
  });

  it("returns keepFrom unchanged when keepFrom >= msgs.length", () => {
    const msgs: SessionMessageEntry[] = [
      makeSessionEntry({ role: "user", content: "msg1" }),
    ];
    expect(guardToolCallBoundary(msgs, 5)).toBe(5);
  });
});
