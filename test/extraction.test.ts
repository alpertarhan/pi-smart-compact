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
  collapseDecisionsByQuestion,
  isHarnessInjectedText,
} from "../src/utils/extraction.ts";
import type { LlmMessage, ProfileConfig } from "../src/types.ts";
import { EXTRACTION_LIMITS, PROFILES } from "../src/constants.ts";

const PC: ProfileConfig = {
  summaryBudgetTokens: 6000,
  keepRecentTokens: 20000,
  minChunkTokens: 500,
  maxChunkTokens: 8000,
  singlePassMaxTokens: 30000,
  batchMaxTokens: 24000,
};

function msg(
  role: LlmMessage["role"],
  content: string,
  extras?: Partial<LlmMessage>,
): LlmMessage {
  return { role, content, ...extras };
}

describe("extractText", () => {
  it("extracts plain string", () => {
    expect(extractText("hello")).toBe("hello");
  });
  it("extracts text blocks", () => {
    expect(
      extractText([
        { type: "text", text: "hi" },
        { type: "text", text: " there" },
      ]),
    ).toBe("hi there");
  });
  it("returns empty for unknown", () => {
    expect(extractText(42)).toBe("");
  });
});

describe("extractMediaAttachments", () => {
  it("captures image/file metadata without text payload", () => {
    const msgs: LlmMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          {
            type: "image",
            mimeType: "image/png",
            name: "screen.png",
            sizeBytes: 1234,
            data: "base64...",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "file",
            mime_type: "application/pdf",
            filename: "spec.pdf",
            url: "https://example.test/spec.pdf",
          },
        ],
      },
    ];
    const media = extractMediaAttachments(msgs);
    expect(media).toHaveLength(2);
    expect(media[0]).toMatchObject({
      index: 0,
      kind: "image",
      mimeType: "image/png",
      name: "screen.png",
      sizeBytes: 1234,
      source: "inline",
    });
    expect(media[1]).toMatchObject({
      index: 1,
      kind: "file",
      mimeType: "application/pdf",
      name: "spec.pdf",
      source: "url",
    });
  });
});

describe("trackFileOps", () => {
  it("records no file effects for an exit-1 chain: later commands never ran", () => {
    // A non-zero exit means the chain stopped early; the rm/sed may never have
    // executed, so their file effects are unknowable (isError or not).
    const chain = (command: string) =>
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command } }],
        },
        {
          role: "toolResult",
          toolCallId: "c1",
          isError: true,
          content: "Command exited with code 1",
        },
      ] as unknown as LlmMessage[];
    expect(trackFileOps(chain("test -f old.ts && rm old.ts")).deleted).toEqual([]);
    expect(
      trackFileOps(chain("grep -q TODO src/a.ts && sed -i 's/TODO/DONE/' src/a.ts")).modified,
    ).toEqual([]);
  });

  it("detects file modifications", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "write",
            arguments: {
              path: "/tmp/foo.ts",
              content: "export const foo = 1;",
            },
          },
        ],
      },
      { role: "toolResult", toolCallId: "1", content: "written" },
    ];
    const ops = trackFileOps(msgs);
    expect(ops.modified.length).toBe(1);
    expect(ops.modified[0].path).toBe("/tmp/foo.ts");
    expect(ops.read.length).toBe(0);
  });

  it("detects file reads", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "read",
            arguments: { path: "/tmp/bar.ts" },
          },
        ],
      },
      { role: "toolResult", toolCallId: "1", content: "content" },
    ];
    const ops = trackFileOps(msgs);
    expect(ops.read.length).toBe(1);
    expect(ops.read[0]).toBe("/tmp/bar.ts");
  });

  it("does not infer deletion from source prose and lets newer access revive a path", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "delete",
            arguments: { path: "/tmp/bar.ts" },
          },
        ],
      },
      { role: "toolResult", toolCallId: "1", content: "deleted" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "2",
            name: "read",
            arguments: { path: "/tmp/bar.ts" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "2",
        content: "// removed legacy branch, file remains",
      },
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
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "patch_file",
            arguments: { path: "/tmp/a.ts", patch: "@@ diff @@" },
          },
          {
            type: "toolCall",
            id: "2",
            name: "create_file",
            arguments: { path: "/tmp/b.ts", content: "b" },
          },
          {
            type: "toolCall",
            id: "3",
            name: "append_file",
            arguments: { path: "/tmp/c.ts", content: "c" },
          },
          {
            type: "toolCall",
            id: "4",
            name: "update_file",
            arguments: { path: "/tmp/d.ts", content: "d" },
          },
          {
            type: "toolCall",
            id: "5",
            name: "hypa_write",
            arguments: { path: "/tmp/e.ts", content: "e" },
          },
          {
            type: "toolCall",
            id: "6",
            name: "totally_unknown_mcp_tool",
            arguments: { path: "/tmp/f.ts", content: "f" },
          },
        ],
      },
      { role: "toolResult", toolCallId: "1", content: "patched" },
      { role: "toolResult", toolCallId: "2", content: "created" },
      { role: "toolResult", toolCallId: "3", content: "appended" },
      { role: "toolResult", toolCallId: "4", content: "updated" },
      { role: "toolResult", toolCallId: "5", content: "written" },
      { role: "toolResult", toolCallId: "6", content: "written" },
    ];
    const ops = trackFileOps(msgs);
    expect(ops.modified.map((f) => f.path).sort()).toEqual([
      "/tmp/a.ts",
      "/tmp/b.ts",
      "/tmp/c.ts",
      "/tmp/d.ts",
      "/tmp/e.ts",
      "/tmp/f.ts",
    ]);
  });

  it("detects MCP edit aliases without treating generic path + text as a write", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "mcp__filesystem__edit_file",
            arguments: { target_file: "/tmp/a.ts", old_str: "a", new_str: "b" },
          },
          {
            type: "toolCall",
            id: "2",
            name: "read_text_file",
            arguments: { absolute_path: "/tmp/b.ts", text: "display mode" },
          },
        ],
      },
      { role: "toolResult", toolCallId: "1", content: "edited" },
      { role: "toolResult", toolCallId: "2", content: "content" },
    ];

    const ops = trackFileOps(msgs);
    expect(ops.modified.map((file) => file.path)).toEqual(["/tmp/a.ts"]);
    expect(ops.read).toEqual(["/tmp/b.ts"]);
  });

  it("ignores no-op edits", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "edit",
            arguments: { path: "/tmp/x.ts", oldText: "a", newText: "b" },
          },
        ],
      },
      { role: "toolResult", toolCallId: "1", content: "applied: 0" },
    ];
    const ops = trackFileOps(msgs);
    expect(ops.modified.length).toBe(0);
  });
});

describe("catalogErrors", () => {
  const run = (id: string, command: string, output: string, isError = false) =>
    [
      {
        role: "assistant",
        content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
      },
      { role: "toolResult", toolCallId: id, isError, content: output },
    ] as unknown as LlmMessage[];

  const benignExitOne: Array<[string, string, string]> = [
    [
      "looped tests then a terminal name-only grep with no match",
      "for i in 1 2 3; do bun test test/x.test.ts 2>&1 | grep -E \"^ *[0-9]+ (pass|fail)\" | tr '\\n' ' '; done; git diff main... --name-only | grep -i hindsight",
      " 25 pass  0 fail \n 25 pass  0 fail \n 6 files changed, 63 insertions(+), 20 deletions(-)\nCommand exited with code 1",
    ],
    [
      "in-place edit then a zero-count grep",
      "F=docs/status.md; sed -i 's/\\u2192/→/g' \"$F\"; grep -c 'u2192' \"$F\"",
      "0\n\n\nCommand exited with code 1",
    ],
    [
      "git diff --exit-code with clean hunks",
      "git diff --exit-code main -- src/",
      "3c3\n< old\n---\n> new\nCommand exited with code 1",
    ],
    [
      "cd then a no-match count grep",
      'cd /repo/data && grep -c "needle" sessions.jsonl',
      "0\n\n\nCommand exited with code 1",
    ],
    [
      "no-match search over a zero-failed summary",
      "grep failing summary.txt",
      "Tests: 0 failed, 25 passed, 1 skipped\nCommand exited with code 1",
    ],
    [
      "no-match rg over a zero-failures report",
      "rg \\b[1-9]\\ failing report.txt",
      "0 failures, 42 examples, 0 pending\nCommand exited with code 1",
    ],
    [
      "false test condition",
      "test -f /tmp/lock",
      "\nCommand exited with code 1",
    ],
  ];

  it.each(benignExitOne.map(([label, command, output]) => [label, command, output] as const))(
    "does not catalog a benign-terminal exit 1 (%s)",
    (_label, command, output) => {
      // pi marks the non-zero exit as isError on the tool result; both the
      // isError path and the error-pattern scan must agree it is not a failure.
      expect(catalogErrors(run("c1", command, output))).toEqual([]);
      expect(catalogErrors(run("c2", command, output, true))).toEqual([]);
    },
  );

  it.each([
    ["quiet deploy script", "./deploy --quiet"],
    ["silent python check", "python silent_check.py"],
    ["bare false", "false"],
    ["quiet deploy after tests", "bun test && ./deploy --quiet"],
    ["unknown cli tool", "agm task set -scope /repo -state working 'note'"],
  ])("still catalogs a quiet exit-1 failure (%s)", (_label, command) => {
    const output = "\nCommand exited with code 1";
    for (const isError of [false, true]) {
      const errors = catalogErrors(run("c1", command, output, isError));
      expect(errors).toHaveLength(1);
      expect(errors[0].resolved).toBe(false);
    }
  });

  it.each([
    ["failing test count", " 9 pass\n 1 fail \nRan 10 tests\nCommand exited with code 1"],
    ["failing test count (vitest)", "Tests  1 failed | 9 passed\nCommand exited with code 1"],
    ["failing test count (mocha)", "  2 passing\n  2 failing\nCommand exited with code 1"],
    ["go test FAIL line", "--- FAIL: TestWindow (0.01s)\nFAIL\nexit status 1\nCommand exited with code 1"],
    ["bare go FAIL line mid-body", "run tests: ok\nFAIL\nCommand exited with code 1"],
    ["TAP not-ok line", "ok 1 setup\nnot ok 2 computes the window\nCommand exited with code 1"],
    ["module-not-found body", 'error: Module not found "minimax-probe.mjs"\nCommand exited with code 1'],
    ["typescript errors", "src/a.ts:1:10: error TS2304: Cannot find name 'x'\nCommand exited with code 1"],
    ["stack trace", "Traceback (most recent call last):\n  File \"x.py\"\nCommand exited with code 1"],
  ])("still catalogs a real failure with exit 1 (%s)", (_label, output) => {
    for (const isError of [false, true]) {
      const errors = catalogErrors(run("c1", "bun test", output, isError));
      expect(errors.length).toBe(1);
      expect(errors[0].resolved).toBe(false);
    }
  });

  it("still catalogs a clean-output exit 2 or higher", () => {
    expect(catalogErrors(run("c1", "ls missing", "ls: cannot access 'missing': No such file or directory\nCommand exited with code 2")).length).toBe(1);
    expect(catalogErrors(run("c2", "tsc", "\nCommand exited with code 2")).length).toBe(1);
  });

  it("catalogs tool errors", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "1", name: "bash", arguments: { cmd: "ls" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "1",
        isError: true,
        content: "command not found",
      },
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
      expect(
        catalogErrors([
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id,
                name: "bash",
                arguments: { command: "failing command" },
              },
            ],
          },
          { role: "toolResult", toolCallId: id, isError: true, content },
        ]),
      ).toEqual([]);
    }
    expect(
      catalogErrors([
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "real",
              name: "bash",
              arguments: { command: "bun test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "real",
          isError: true,
          content: "test failed in auth.ts",
        },
      ]),
    ).toHaveLength(1);
  });

  it("keeps real project test failures that mention HTTP 429 rate limits", () => {
    const errors = catalogErrors([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "429-test",
            name: "bash",
            arguments: { command: "bun test" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "429-test",
        isError: true,
        content:
          "FAIL rate limiter returns HTTP 429 when rate limit is exceeded\nExpected: 429\nReceived: 200",
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].tool).toBe("bash");
  });

  it("ignores rg/grep exit 1 when every chained command is a search", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "bash",
            arguments: { command: "rg missing src && grep absent README.md" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "1",
        isError: true,
        content: "(no output)\n\nCommand exited with code 1",
      },
    ];
    expect(catalogErrors(msgs)).toEqual([]);
  });

  it("ignores a successful search whose piped output was truncated and marked as an error", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "bash",
            arguments: { command: "rg runId src | head -n 120" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "1",
        isError: true,
        content: "src/index.ts:1: runId\n... [truncated 4805 chars] ...",
      },
    ];
    expect(catalogErrors(msgs)).toEqual([]);
  });

  it("does not hide a failing command chained after a search", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "bash",
            arguments: { command: "rg present src && bun test" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "1",
        isError: true,
        content: "1 test failed\n\nCommand exited with code 1",
      },
    ];
    expect(catalogErrors(msgs)).toHaveLength(1);
  });

  it("does not treat source text mentioning ERROR as a failed command", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "bash",
            arguments: { command: "cat src/status.ts" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "1",
        content:
          "export const STATUS = {\n  label: 'ERROR: shown when validation fails'\n};",
      },
    ];
    expect(catalogErrors(msgs)).toEqual([]);
  });

  it("detects bash errors in successful results", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "bash",
            arguments: { cmd: "npm test" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "1",
        content: "test failed with 3 errors",
      },
    ];
    const errs = catalogErrors(msgs);
    expect(errs.length).toBe(1);
    expect(errs[0].message).toContain("test failed");
  });
});

describe("extractDecisions", () => {
  it("extracts explicit ask_user decisions", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "ask_user",
            arguments: { question: "Which approach?" },
          },
        ],
      },
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

  it("binds the ask_user result by tool-call id past interleaved parallel results (A06)", () => {
    const assistant = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "decision", name: "ask_user", arguments: { question: "Which database should we use?" } },
        ...Array.from({ length: 3 }, (_, i) => ({
          type: "toolCall",
          id: "other-" + i,
          name: "read",
          arguments: { path: "file-" + i + ".ts" },
        })),
      ],
    };
    const msgs = [
      assistant,
      ...Array.from({ length: 3 }, (_, i) => ({
        role: "toolResult",
        toolCallId: "other-" + i,
        content: "Read completed",
      })),
      { role: "toolResult", toolCallId: "decision", content: "User answered: PostgreSQL" },
    ];
    const decisions = extractDecisions(msgs as unknown as LlmMessage[]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].type).toBe("explicit");
    expect(decisions[0].summary).toContain("Which database should we use?");
    expect(decisions[0].userResponse).toContain("PostgreSQL");
  });

  it("keeps each ask_user answer bound to its own call id (A06)", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "a", name: "ask_user", arguments: { question: "First question?" } },
          { type: "toolCall", id: "b", name: "ask_user", arguments: { question: "Second question?" } },
        ],
      },
      { role: "toolResult", toolCallId: "b", content: "Answer two" },
      { role: "toolResult", toolCallId: "a", content: "Answer one" },
    ];
    const decisions = extractDecisions(msgs as unknown as LlmMessage[]);
    expect(decisions).toHaveLength(2);
    const first = decisions.find((d) => d.summary.includes("First"));
    const second = decisions.find((d) => d.summary.includes("Second"));
    expect(first?.userResponse).toContain("Answer one");
    expect(second?.userResponse).toContain("Answer two");
  });

  it("leaves the decision open when no matching result ever arrives (A06)", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "decision", name: "ask_user", arguments: { question: "Which database?" } },
          { type: "toolCall", id: "other", name: "read", arguments: { path: "x.ts" } },
        ],
      },
      { role: "toolResult", toolCallId: "other", content: "Read completed" },
    ];
    expect(extractDecisions(msgs as unknown as LlmMessage[])).toEqual([]);
  });
});

describe("catalogErrors retry resolution (A07)", () => {
  const exec = (id: string, command = "bun test") =>
    ({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
    }) as unknown as LlmMessage;
  const execResult = (id: string, text: string, isError = false) =>
    ({
      role: "toolResult",
      toolCallId: id,
      isError,
      content: text,
    }) as unknown as LlmMessage;

  it("does not resolve an error when the retry result text still fails (A07)", () => {
    const failure = "Error: assertion failed\nCommand exited with code 1";
    const errors = catalogErrors([
      exec("1"),
      execResult("1", failure),
      exec("2"),
      execResult("2", failure),
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0].retryAttempted).toBe(true);
    expect(errors[0].resolved).toBe(false);
    expect(errors[1].resolved).toBe(false);
  });

  it("resolves an error when the matching retry exits 1 clean (isError, no signal)", () => {
    // pi marks every non-zero exit as isError; the retry ends in a no-match
    // count grep whose zero is the expected outcome.
    const command = "grep -c u2192 notes.md";
    const errors = catalogErrors([
      exec("1", command),
      execResult("1", "grep: notes.md: No such file or directory\nCommand exited with code 2", true),
      exec("2", command),
      execResult("2", "0\n\n\nCommand exited with code 1", true),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].retryAttempted).toBe(true);
    expect(errors[0].resolved).toBe(true);
  });

  it("never resolves through an isError retry that is not a clean command exit", () => {
    const errors = catalogErrors([
      exec("1"),
      execResult("1", "Error: assertion failed", true),
      exec("2"),
      execResult("2", "Command exited with code 2", true),
    ]);
    // The retry's own exit-2 failure is a second error; the original stays open.
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => !error.resolved)).toBe(true);
  });

  it("resolves every related earlier error when a later retry succeeds (A07)", () => {
    const errors = catalogErrors([
      exec("1"),
      execResult("1", "Error: assertion failed", true),
      exec("2"),
      execResult("2", "Error: assertion failed", true),
      exec("3"),
      execResult("3", "3 pass\n0 fail"),
    ]);
    expect(errors).toHaveLength(2);
    expect(errors.map((error) => error.resolved)).toEqual([true, true]);
    expect(errors.map((error) => error.retryAttempted)).toEqual([true, true]);
  });

  it("keeps an unrelated command's success from resolving an error (A07)", () => {
    const errors = catalogErrors([
      exec("1", "bun test"),
      execResult("1", "Error: assertion failed", true),
      exec("2", "rg pattern"),
      execResult("2", "3 matches"),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].resolved).toBe(false);
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
    const msgs: LlmMessage[] = [
      {
        role: "user",
        content:
          "## Constraints\n- Do not publish stable before approval\n\nnpm audit This command requires an existing lockfile\nnpm error The package could not be found or you do not have permission\nnpm notice Publishing with public access",
      },
    ];
    const cons = mineConstraints(msgs);
    expect(cons.map((item) => item.text)).toEqual([
      "Do not publish stable before approval",
    ]);
  });

  it("prioritizes Turkish prohibition semantics over embedded requirement words", () => {
    const constraints = mineConstraints([
      {
        role: "user",
        content: "Bunu yapma; onay olmadan release kesinlikle yapılmamalı",
      },
    ]);
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

describe("collapseDecisionsByQuestion (A08 edges)", () => {
  it("treats whitespace-only responses as absent, not new answers", () => {
    const collapsed = collapseDecisionsByQuestion([
      { summary: "Which database should we use?", userResponse: "PostgreSQL" },
      { summary: "Which database should we use?", userResponse: "   " },
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].userResponse).toBe("PostgreSQL");
  });

  it("keeps the latest ANSWERED record's provenance, not the earliest entry's", () => {
    const collapsed = collapseDecisionsByQuestion([
      { summary: "Which database should we use?", type: "implicit" as const, index: 0 },
      { summary: "Which database should we use?", type: "explicit" as const, index: 2, userResponse: "SQLite" },
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].userResponse).toBe("SQLite");
    expect(collapsed[0].type).toBe("explicit");
    expect(collapsed[0].index).toBe(2);
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
    const compacted =
      "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nShip the stable release\n\n## Progress\n- working\n</summary>";
    expect(
      extractMainGoal([
        { role: "user", content: compacted },
        { role: "user", content: "okay" },
      ]),
    ).toBe("Ship the stable release");
  });

  it("treats a goal-less host summary as a boundary to older raw goals", () => {
    const compacted =
      "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Progress\n- working\n</summary>";
    expect(
      extractMainGoal([
        { role: "user", content: "Old raw goal that predates compaction" },
        { role: "user", content: compacted },
      ]),
    ).toBeNull();
  });

  it("does not revive a compaction status banner as the active goal", () => {
    const compacted =
      "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nEESV Compact (model, balanced) — 259,782t Warning: Smart compact skipped\n</summary>";
    expect(extractMainGoal([{ role: "user", content: compacted }])).toBeNull();
  });

  // The semantic steering-skip guard was removed: noun+directive
  // co-occurrence (even clause-anchored) misclassified the subject matter of
  // real software tasks. These preservation tests pin main's selection
  // semantics — the latest substantive request is the goal — until safe goal
  // continuity lands as a separate bounded task.
  it.each([
    ["desire form without a task verb (EN)", "I want OAuth instead; never keep password login"],
    ["desire form without a task verb (TR)", "Bana OAuth girişi lazım, asla şifre saklama"],
    ["agent noun in subject matter", "Fix the agent-mesh retry bug; do not change the public API."],
    ["worker noun in subject matter", "I want worker retries; never retry non-idempotent work"],
    ["stop + worker subject", "Stop worker crashes by implementing cancellation"],
    ["parallel + never, no agents", "Implement parallel uploads but never store secrets"],
    ["stop processes as behavior under test", "Write tests for stop processes behavior"],
    ["constraint-first mixed message", "Don't spawn so many agents; fix the login bug"],
    ["comma-joined task and constraint", "Fix the agent-mesh retry bug, do not change the public API"],
    ["agent subject with never", "Fix the agent retry bug and never log secrets"],
    ["never + agents clause", "Never crash the agents when their network fails"],
    ["comma-joined admonition and task", "Don't spawn so many agents, fix the login bug"],
  ])("a task request stays the goal even when it mentions agents or prohibitions (%s)", (_label, request) => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "keep the password login working" },
      { role: "user", content: request },
    ];
    expect(extractMainGoal(msgs)).toBe(request);
  });

  it.each([
    ["Turkish", "tamam bulduğun sorunları çözelim"],
    ["English", "now add the retry budget test"],
  ])("a new %s task request still becomes the goal", (_label, request) => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "gather the earlier findings" },
      { role: "user", content: request },
    ];
    expect(extractMainGoal(msgs)).toBe(request);
  });

  it.each([
    ["task + constraint (EN)", "now add the retry budget test, but don't change the public API"],
    ["task + prohibition (EN)", "fix the login bug and never commit secrets"],
    ["task + prohibition (TR)", "bulduğun sorunları çöz ama main'e dokunma"],
    ["verbal noun açma", "PR açma adımını da otomatikleştir"],
    ["verbal noun dokunma", "dokunma olaylarını düzelt"],
  ])("a message that also asks for work stays the goal (%s)", (_label, request) => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "gather the earlier findings" },
      { role: "user", content: request },
    ];
    expect(extractMainGoal(msgs)).toBe(request);
  });

  it("strips the host summary's closing tag from a carried goal", () => {
    const compacted =
      "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nVerify the planner windows\n</summary>";
    expect(extractMainGoal([{ role: "user", content: compacted }])).toBe("Verify the planner windows");
  });
});

describe("extractStructured", () => {
  it("returns empty extraction for empty messages", () => {
    const ext = extractStructured([], PC);
    expect(ext.messageCount).toBe(0);
    expect(ext.modifiedFiles.length).toBe(0);
    expect(ext.errors.length).toBe(0);
  });

  it("does not record a host compaction summary as a user request in the timeline", () => {
    const compacted =
      "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nShip it\n</summary>";
    const ext = extractStructured(
      [
        { role: "user", content: compacted },
        { role: "user", content: "verify the planner windows" },
      ],
      PC,
    );
    expect(ext.timeline).toEqual([
      { index: 1, event: "user_request", summary: "verify the planner windows" },
    ]);
  });

  it("extracts all facets from a realistic conversation", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "Create a login page" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "write",
            arguments: {
              path: "/src/Login.tsx",
              content: "export default function Login() {}",
            },
          },
        ],
      },
      { role: "toolResult", toolCallId: "1", content: "file written" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "2",
            name: "bash",
            arguments: { cmd: "npm test" },
          },
        ],
      },
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
    const ext = extractStructured(
      [
        {
          role: "user",
          content: "The removed test/llm-retry.test.ts remains relevant.",
        },
      ],
      PC,
    );
    expect(ext.referencedFiles).toContain("test/llm-retry.test.ts");
  });

  it("bounds high-cardinality evidence and records omitted counts", () => {
    const messages: LlmMessage[] = [];
    for (let index = 0; index < EXTRACTION_LIMITS.READ_FILES + 50; index++) {
      const id = "read-" + index;
      messages.push(
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id,
              name: "read",
              arguments: { path: "src/file-" + index + ".ts" },
            },
          ],
        },
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
        content: [
          {
            type: "toolCall",
            id: "call_mtu_abc",
            name: "multi_tool_use.parallel",
            arguments: {
              tool_uses: [
                {
                  id: "call_read1",
                  recipient_name: "functions.read",
                  parameters: { path: "/src/a.ts" },
                },
                {
                  id: "call_write1",
                  recipient_name: "functions.write",
                  parameters: { path: "/src/b.ts", content: "x" },
                },
              ],
            },
          },
        ],
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
        content: [
          {
            type: "toolCall",
            id: "call_mtu_xyz",
            name: "multi_tool_use.parallel",
            arguments: {
              tool_uses: [
                {
                  recipient_name: "functions.read",
                  parameters: { path: "/src/a.ts" },
                },
              ],
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_mtu_xyz_0",
        content: "a content",
      },
    ];
    const idx = buildToolCallIndex(msgs);
    expect(idx.has("call_mtu_xyz_0")).toBe(true);
    expect(idx.get("call_mtu_xyz_0")!.name).toBe("read");
  });

  it("trackFileOps sees flattened multi-tool file ops", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_mtu",
            name: "multi_tool_use.parallel",
            arguments: {
              tool_uses: [
                {
                  id: "r1",
                  recipient_name: "functions.read",
                  parameters: { path: "/src/config.ts" },
                },
                {
                  id: "w1",
                  recipient_name: "functions.write",
                  parameters: { path: "/src/out.ts", content: "x" },
                },
              ],
            },
          },
        ],
      },
      { role: "toolResult", toolCallId: "r1", content: "config content" },
      { role: "toolResult", toolCallId: "w1", content: "file written" },
    ];
    const ops = trackFileOps(msgs);
    expect(ops.read).toContain("/src/config.ts");
    expect(ops.modified.map((m) => m.path)).toContain("/src/out.ts");
  });

  it("catalogErrors links multi-tool errors via real ids", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_mtu",
            name: "multi_tool_use.parallel",
            arguments: {
              tool_uses: [
                {
                  id: "b1",
                  recipient_name: "functions.bash",
                  parameters: { cmd: "npm test" },
                },
              ],
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "b1",
        content:
          "FAIL src/auth.test.ts\n  ● login should return token\n    Error: connect ECONNREFUSED",
      },
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
        content: [
          {
            type: "toolCall",
            id: "call_mtu",
            name: "multi_tool_use.parallel",
            arguments: {
              tool_uses: [
                {
                  id: "w1",
                  recipient_name: "functions.write",
                  parameters: { path: "/src/a.ts", content: "x" },
                },
                {
                  id: "r1",
                  recipient_name: "functions.read",
                  parameters: { path: "/src/b.ts" },
                },
              ],
            },
          },
        ],
      },
      { role: "toolResult", toolCallId: "w1", content: "written" },
      { role: "toolResult", toolCallId: "r1", content: "content" },
    ];
    const topics = segmentTopicsHeuristic(msgs, PC);
    // Should have at least one topic classified as implementation (write)
    expect(topics.some((t) => t.type === "implementation")).toBe(true);
  });

  it("does not split segments on generic basename churn across packages", () => {
    const pc = { ...PC, minChunkTokens: 10 };
    const write = (path: string, id: string): LlmMessage => ({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id,
          name: "write",
          arguments: { path, content: "x" },
        },
      ],
    });
    const genericChurn: LlmMessage[] = [
      { role: "user", content: "start working on the packages now" },
      write("/packages/a/index.ts", "w1"),
      { role: "toolResult", toolCallId: "w1", content: "ok" },
      write("/packages/b/index.ts", "w2"),
      { role: "toolResult", toolCallId: "w2", content: "ok" },
    ];
    expect(segmentTopicsHeuristic(genericChurn, pc)).toHaveLength(1);

    const realShift: LlmMessage[] = [
      { role: "user", content: "start working on the packages now" },
      write("/packages/a/auth.ts", "w1"),
      { role: "toolResult", toolCallId: "w1", content: "ok" },
      write("/packages/b/settings.ts", "w2"),
      { role: "toolResult", toolCallId: "w2", content: "ok" },
    ];
    expect(segmentTopicsHeuristic(realShift, pc)).toHaveLength(2);
  });

  it("detects retry and resolution inside multi_tool_use.parallel", () => {
    const msgs: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_mtu1",
            name: "multi_tool_use.parallel",
            arguments: {
              tool_uses: [
                {
                  id: "b1",
                  recipient_name: "functions.bash",
                  parameters: { cmd: "npm test" },
                },
              ],
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "b1",
        content:
          "FAIL src/auth.test.ts\n  ● login should return token\n    Error: connect ECONNREFUSED",
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_mtu2",
            name: "multi_tool_use.parallel",
            arguments: {
              tool_uses: [
                {
                  id: "b2",
                  recipient_name: "functions.bash",
                  parameters: { cmd: "npm test -- --retry" },
                },
              ],
            },
          },
        ],
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

describe("harness-injected user messages", () => {
  const goal = "Fix the flaky login test in auth.spec.ts";

  it("ignores pi-processes notifications for goal and lastUserMessages", () => {
    const event =
      '<process_event type="lifecycle" kind="success" process_id="proc_8d36">\nexited 0\n</process_event>';
    const ex = extractStructured(
      [msg("user", goal), msg("assistant", "ok"), msg("user", event)],
      PROFILES.balanced,
    );
    expect(ex.mainGoal).toBe(goal);
    expect(ex.lastUserMessages).not.toContain(event);
  });

  it.each(["completed", "summary"])("ignores background memory %s status for goals, constraints and recent user requests", state => {
    const notice = `<memory_status backend="hindsight" state="${state}">\nSmart Compact: Hindsight completed. Always keep this status.\n</memory_status>`;
    const ex = extractStructured([msg("user", goal), msg("assistant", "ok"), msg("user", notice)], PROFILES.balanced);
    expect(ex.mainGoal).toBe(goal);
    expect(ex.lastUserMessages).not.toContain(notice);
    expect(ex.constraints.some(c => /keep this status/.test(c.text))).toBe(false);
  });

  it("does not re-mine the native continuity bridge ledger", () => {
    const bridge =
      "Native compaction continuity bridge (preserve these unresolved facts):\n\n## Continuity Ledger\n- Constraint: Do not restart the daemon.\n- Goal: old goal";
    const ex = extractStructured(
      [msg("user", goal), msg("assistant", "ok"), msg("user", bridge)],
      PROFILES.balanced,
    );
    expect(ex.mainGoal).toBe(goal);
    expect(ex.constraints.some((c) => c.text.startsWith("Constraint:"))).toBe(
      false,
    );
  });

  it("does not mine agent-mesh envelopes as constraints", () => {
    const mesh =
      "[agent-mesh] question from peer: Always run make before commit and never skip lint.";
    const ex = extractStructured(
      [msg("user", goal), msg("assistant", "ok"), msg("user", mesh)],
      PROFILES.balanced,
    );
    expect(ex.mainGoal).toBe(goal);
    expect(ex.constraints.some((c) => /make before commit/.test(c.text))).toBe(
      false,
    );
  });
});

describe("harness-injected follow-ups", () => {
  const goal = "Fix the flaky login test in auth.spec.ts";

  it("ignores real agent-mesh envelope shape", () => {
    const mesh =
      "**agent-mesh message from tidal-dragon (01a0f215-aaaa)** [58b57d71cc8cbd20] Always run make before commit and never skip lint.";
    const ex = extractStructured(
      [msg("user", goal), msg("assistant", "ok"), msg("user", mesh)],
      PROFILES.balanced,
    );
    expect(ex.mainGoal).toBe(goal);
    expect(ex.constraints.some((c) => /make before commit/.test(c.text))).toBe(
      false,
    );
  });

  it("ignores agent-mesh questions without provenance", () => {
    const mesh =
      "**agent-mesh question from torro-console-developer (01a19264-b386)** [f6a8efcd9c00f536]\n\nShould we avoid the cache and always run make before commit?";
    expect(isHarnessInjectedText(mesh)).toBe(true);
    const ex = extractStructured(
      [msg("user", goal), msg("assistant", "ok"), msg("user", mesh)],
      PROFILES.balanced,
    );
    expect(ex.mainGoal).toBe(goal);
    expect(ex.constraints).toEqual([]);
    expect(ex.decisions).toEqual([]);
    expect(ex.lastUserMessages).toEqual([goal]);
  });

  it("strips stacked continuity labels and dedupes", () => {
    const summary =
      "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nShip it\n\n## Constraints\n- Constraint: Constraint: Do not restart the daemon.\n- Do not restart the daemon.\n</summary>";
    const constraints = mineConstraints([msg("user", summary)]);
    expect(constraints.map((c) => c.text)).toEqual([
      "Do not restart the daemon.",
    ]);
  });
});
