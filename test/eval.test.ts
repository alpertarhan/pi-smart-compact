/**
 * Evaluation harness for pi-smart-compact.
 *
 * Each gold case defines a realistic conversation scenario with expected
 * extraction outputs. Running `bun test test/eval.test.ts` validates that
 * the compaction pipeline produces correct structured output.
 *
 * This file serves as both a test suite and a living specification.
 */

import { describe, it, expect } from "bun:test";
import { extractStructured, extractOpenLoops } from "../src/utils/extraction.ts";
import { buildCompactionState, computeDelta } from "../src/utils/state.ts";
import { verifySummary } from "../src/phases/verify.ts";
import { PROFILES } from "../src/constants.ts";
import type { LlmMessage, StructuredExtraction, CompactionState } from "../src/types.ts";

// ─── Helpers ───

function msg(role: "user" | "assistant" | "toolResult", content: string, extra: Partial<LlmMessage> = {}): LlmMessage {
  return { role, content, ...extra };
}

let tcCounter = 0;
function toolMsg(toolName: string, args: Record<string, unknown>, result: string, isError = false): LlmMessage[] {
  const id = "tc-" + (++tcCounter);
  return [
    {
      role: "assistant",
      content: [
        { type: "toolCall", name: toolName, id, arguments: args },
      ],
    },
    {
      role: "toolResult",
      content: result,
      isError,
      toolCallId: id,
    },
  ];
}

function extract(msgs: LlmMessage[]): StructuredExtraction {
  return extractStructured(msgs, PROFILES.balanced);
}

// ─── Gold Cases ───

const GOLD_CASES = [
  {
    name: "Simple file edit session",
    description: "User asks to fix a bug, assistant edits one file, no errors",
    messages: (): LlmMessage[] => [
      msg("user", "Fix the auth bug in src/auth.ts"),
      msg("assistant", "Let me read the file first."),
      ...toolMsg("read", { path: "src/auth.ts" }, "export function login() { /* buggy */ }"),
      msg("user", "yes fix the null check"),
      ...toolMsg("edit", { path: "src/auth.ts", oldText: "/* buggy */", newText: "/* fixed */" }, "OK"),
      msg("assistant", "Fixed the null check in login()."),
    ],
    expect: {
      modifiedFiles: ["src/auth.ts"],
      readFiles: ["src/auth.ts"],
      unresolvedErrors: 0,
      decisions: 0,
      hasGoal: true,
    },
  },
  {
    name: "Debugging session with errors",
    description: "User reports a failing test, multiple errors occur, one resolved",
    messages: (): LlmMessage[] => [
      msg("user", "Tests are failing after the refactor"),
      ...toolMsg("bash", { command: "bun test" }, "2 tests failed:\n1) auth.test.ts - login returns undefined\n2) user.test.ts - createUser fails", true),
      msg("assistant", "I see 2 failing tests. Let me check auth first."),
      ...toolMsg("read", { path: "src/auth.ts" }, "export function login() { return undefined; }"),
      ...toolMsg("edit", { path: "src/auth.ts", oldText: "return undefined", newText: "return token" }, "OK"),
      ...toolMsg("bash", { command: "bun test test/auth.test.ts" }, "All 5 tests passed!"),
      msg("user", "auth is fixed, but user.test still fails. We'll fix it next."),
    ],
    expect: {
      modifiedFiles: ["src/auth.ts"],
      readFiles: ["src/auth.ts"],
      unresolvedErrors: 1, // bash error from first call still unresolved
      hasGoal: true,
    },
  },
  {
    name: "Multi-file refactoring with decisions",
    description: "User requests architecture change, assistant modifies multiple files",
    messages: (): LlmMessage[] => [
      msg("user", "Refactor the auth module to use dependency injection"),
      msg("assistant", "I'll refactor auth to use DI. Let me check the current structure."),
      ...toolMsg("read", { path: "src/auth.ts" }, "export class AuthService { constructor() {} }"),
      ...toolMsg("read", { path: "src/auth.test.ts" }, "import { AuthService } from './auth'"),
      ...toolMsg("edit", { path: "src/auth.ts", oldText: "constructor() {}", newText: "constructor(private repo: UserRepository) {}" }, "OK"),
      ...toolMsg("edit", { path: "src/auth.test.ts", oldText: "import { AuthService }", newText: "import { AuthService } from './auth'\nconst mockRepo = { find: vi.fn() }" }, "OK"),
      ...toolMsg("edit", { path: "src/container.ts", oldText: "// empty", newText: "register(AuthService, [UserRepository])" }, "OK"),
      msg("assistant", "Done. AuthService now uses constructor injection with UserRepository."),
    ],
    expect: {
      modifiedFiles: ["src/auth.ts", "src/auth.test.ts", "src/container.ts"],
      readFiles: ["src/auth.ts", "src/auth.test.ts"],
      unresolvedErrors: 0,
      hasGoal: true,
    },
  },
  {
    name: "Blocked session with follow-ups",
    description: "Work is blocked on external dependency, user mentions next steps",
    messages: (): LlmMessage[] => [
      msg("user", "Implement the payment integration"),
      msg("assistant", "I'll set up the payment module."),
      ...toolMsg("read", { path: "src/payment.ts" }, "export function processPayment() {}"),
      ...toolMsg("bash", { command: "npm install @stripe/sdk" }, "npm ERR! 403 Forbidden - requires auth token", true),
      msg("assistant", "The Stripe SDK requires an auth token to install."),
      msg("user", "We're blocked waiting for the API key from DevOps. Next step is to add caching behavior to the order module while we wait."),
    ],
    expect: {
      modifiedFiles: [],
      readFiles: ["src/payment.ts"],
      unresolvedErrors: 1,
      hasGoal: true,
      openLoops: true,
    },
  },
  {
    name: "Turkish language conversation",
    description: "Conversation in Turkish with constraints and follow-ups",
    messages: (): LlmMessage[] => [
      msg("user", "Auth modülünü düzelt, JWT kullanmamız gerekiyor"),
      msg("assistant", "Tamam, JWT implementasyonunu yapayım."),
      ...toolMsg("edit", { path: "src/auth.ts", oldText: "session", newText: "jwt" }, "OK"),
      msg("user", "Türkçe locale desteği de eklenmeli, bu bir zorunluluk"),
      msg("assistant", "Türkçe locale desteğini de ekliyorum."),
      ...toolMsg("edit", { path: "src/i18n.ts", oldText: "en only", newText: "en, tr" }, "OK"),
      msg("user", "yapalım bunu, sonra testleri de yazmamiz gerekiyor"),
    ],
    expect: {
      modifiedFiles: ["src/auth.ts", "src/i18n.ts"],
      unresolvedErrors: 0,
      hasGoal: true,
      openLoops: true,
    },
  },
];

// ─── Test Suite ───

describe("Evaluation Harness", () => {
  for (const gold of GOLD_CASES) {
    it(gold.name, () => {
      const msgs = gold.messages();
      const extraction = extract(msgs);

      // Modified files
      if (gold.expect.modifiedFiles) {
        const modPaths = extraction.modifiedFiles.map(f => f.path);
        for (const expected of gold.expect.modifiedFiles) {
          expect(modPaths).toContain(expected);
        }
      }

      // Read files
      if (gold.expect.readFiles) {
        for (const expected of gold.expect.readFiles) {
          expect(extraction.readFiles).toContain(expected);
        }
      }

      // Unresolved errors
      if (gold.expect.unresolvedErrors !== undefined) {
        const unresolved = extraction.errors.filter(e => !e.resolved).length;
        expect(unresolved).toBe(gold.expect.unresolvedErrors);
      }

      // Resolved errors
      if (gold.expect.resolvedErrors !== undefined) {
        const resolved = extraction.errors.filter(e => e.resolved).length;
        expect(resolved).toBeGreaterThanOrEqual(gold.expect.resolvedErrors);
      }

      // Decisions
      if (gold.expect.decisions !== undefined) {
        expect(extraction.decisions.length).toBeGreaterThanOrEqual(gold.expect.decisions);
      }

      // Goal
      if (gold.expect.hasGoal) {
        expect(extraction.mainGoal).not.toBeNull();
      }

      // Open loops
      if (gold.expect.openLoops) {
        const loops = extractOpenLoops(msgs, extraction);
        expect(loops.length).toBeGreaterThan(0);
      }
    });
  }
});

// ─── Delta Evaluation ───

describe("Delta Evaluation", () => {
  it("tracks state transition across two compactions", () => {
    // Simulate first compaction
    const msgs1 = [
      msg("user", "Build auth module"),
      ...toolMsg("edit", { path: "src/auth.ts", oldText: "", newText: "export function login() {}" }, "OK"),
      ...toolMsg("bash", { command: "bun test" }, "1 test failed: login returns undefined", true),
    ];
    const ext1 = extract(msgs1);
    const loops1 = extractOpenLoops(msgs1, ext1);
    const state1: CompactionState = {
      goal: "Build auth module",
      decisions: [],
      constraints: [],
      modifiedFiles: ["src/auth.ts"],
      readFiles: [],
      deletedFiles: [],
      unresolvedErrors: [{ id: "error-1", message: "login returns undefined", tool: "bash", files: [] }],
      resolvedErrors: [],
      openLoops: loops1,
      topics: [],
      nextActions: [],
      criticalContext: [],
      sessionType: "implementation",
      compactionVersion: "7.7.0",
    };

    // Simulate second compaction — bug fixed, new feature added
    const msgs2 = [
      msg("user", "Fix the auth test and add logout"),
      ...toolMsg("edit", { path: "src/auth.ts", oldText: "return undefined", newText: "return token" }, "OK"),
      ...toolMsg("edit", { path: "src/auth.ts", oldText: "", newText: "export function logout() {}" }, "OK"),
      ...toolMsg("edit", { path: "src/session.ts", oldText: "", newText: "export function clearSession() {}" }, "OK"),
      ...toolMsg("bash", { command: "bun test" }, "All tests passed!"),
    ];
    const ext2 = extract(msgs2);
    const loops2 = extractOpenLoops(msgs2, ext2);
    const state2: CompactionState = {
      goal: "Fix auth test and add logout",
      decisions: [],
      constraints: [],
      modifiedFiles: ["src/auth.ts", "src/session.ts"],
      readFiles: [],
      deletedFiles: [],
      unresolvedErrors: [],
      resolvedErrors: [{ id: "error-1", message: "login returns undefined", tool: "bash" }],
      openLoops: loops2,
      topics: [],
      nextActions: [],
      criticalContext: [],
      sessionType: "implementation",
      compactionVersion: "7.7.0",
    };

    const delta = computeDelta(state1, state2);

    // Error resolved
    expect(delta.resolvedErrors.length).toBeGreaterThan(0);
    // New files
    expect(delta.newModifiedFiles).toContain("src/session.ts");
    // No new errors
    expect(delta.newErrors).toEqual([]);
    // Goal changed
    expect(delta.goalChanged).toBe(true);
  });
});

// ─── Fabrication Safety ───

describe("Fabrication Safety", () => {
  it("verification flags fabricated file references", () => {
    const msgs = [
      msg("user", "Fix the bug"),
      ...toolMsg("edit", { path: "src/auth.ts", oldText: "bug", newText: "fix" }, "OK"),
    ];
    const extraction = extract(msgs);

    // Summary that mentions a file never seen in the conversation
    const fabricatedSummary = [
      "## Goal",
      "Fix the bug in auth module",
      "## Files Modified",
      "- src/auth.ts",
      "## Critical Context",
      "- Fixed the bug",
      "## Progress",
      "Bug fixed in src/auth.ts and src/never-seen-file.ts",
    ].join("\n");

    const result = verifySummary(fabricatedSummary, extraction);
    expect(result.ok).toBe(false);
    expect(result.gaps.some(g => g.includes("fabricated"))).toBe(true);
  });

  it("verification accepts all real files", () => {
    const msgs = [
      msg("user", "Fix the bug"),
      ...toolMsg("edit", { path: "src/auth.ts", oldText: "bug", newText: "fix" }, "OK"),
    ];
    const extraction = extract(msgs);

    const goodSummary = [
      "## Goal",
      "Fix the bug",
      "## Files Modified",
      "- src/auth.ts",
      "## Critical Context",
      "- Bug fixed",
      "## Progress",
      "Fixed in src/auth.ts",
    ].join("\n");

    const result = verifySummary(goodSummary, extraction);
    expect(result.gaps.some(g => g.includes("fabricated"))).toBe(false);
  });
});
