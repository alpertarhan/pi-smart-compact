import { describe, expect, it } from "bun:test";
import { parseSummary, renderSummary } from "../src/domain/summary-parse.ts";
import { verifySummary, patchDeterministic } from "../src/phases/verify.ts";
import { injectOpenLoopsSection, applyLoopOverrides, upsertLoopOverride } from "../src/utils/state.ts";
import { classifyToolOperation } from "../src/domain/tool-semantics.ts";
import { pruneRedundant } from "../src/utils/pruning.ts";
import { extractStructured, buildToolCallIndex } from "../src/utils/extraction.ts";
import { mergeExtractions } from "../src/utils/cache.ts";
import { resolveCompactionWindow } from "../src/app/steps/window.ts";
import { chunkLlmMessages } from "../src/phases/synthesize.ts";
import { makeTokenEstimator } from "../src/utils/tokens.ts";
import { SecretScrubber } from "../src/domain/scrub.ts";
import { BudgetExceededError, BudgetGuard, createServices } from "../src/infra/services.ts";
import { trackedComplete } from "../src/utils/cache.ts";
import { OnlineDamageMonitor } from "../src/utils/damage.ts";
import { PROFILES } from "../src/constants.ts";
import type { LlmMessage, OpenLoop, StructuredExtraction } from "../src/types.ts";

const extraction = (extra: Partial<StructuredExtraction> = {}): StructuredExtraction => ({
  modifiedFiles: [], readFiles: [], deletedFiles: [], errors: [], decisions: [], constraints: [], topics: [], timeline: [],
  mainGoal: null, lastUserMessages: [], lastErrors: [], messageCount: 0, ...extra,
});

describe("adversarial summary shapes", () => {
  it("preserves an H3-only summary through state injection", () => {
    const summary = "### Goal\nBuild auth\n### Progress\n### Done\n- schema\n### Critical Context\n- rotate tokens";
    const output = injectOpenLoopsSection(summary, [{ id: "l", type: "follow-up", priority: "high", status: "open", summary: "Finish API", files: [] }]);
    expect(output).toContain("Build auth");
    expect(output).toContain("rotate tokens");
    expect(output).toContain("Finish API");
  });

  it("collapses duplicate canonical sections without duplicating exact evidence", () => {
    const summary = Array.from({ length: 200 }, () => "## Goal\n- Build auth").join("\n");
    const parsed = parseSummary(summary);
    expect(parsed.sections).toHaveLength(1);
    expect(renderSummary(parsed).match(/Build auth/g)).toHaveLength(1);
  });

  it("parses a one-megabyte section without dropping its tail", () => {
    const tail = "x".repeat(1_000_000);
    const parsed = parseSummary("## Goal\n" + tail);
    expect(parsed.sections[0].body.length).toBe(1_000_000);
  });
});

describe("adversarial verification", () => {
  it("does not cross-satisfy colliding monorepo basenames", () => {
    const facts = extraction({ modifiedFiles: [
      { path: "packages/api/src/index.ts", toolCalls: 1, lastModifiedIndex: 1 },
      { path: "packages/web/src/index.ts", toolCalls: 1, lastModifiedIndex: 2 },
    ] });
    const result = verifySummary("## Goal\nBuild\n## Progress\n- packages/api/src/index.ts\n## Critical Context\n- stable", facts);
    expect(result.gaps.some(gap => gap.kind === "missing-file" && gap.path.includes("web"))).toBe(true);
  });

  it("patches every deterministic gap idempotently", () => {
    const facts = extraction({ modifiedFiles: [{ path: "src/auth.ts", toolCalls: 1, lastModifiedIndex: 1 }] });
    const summary = "## Goal\nBuild\n## Progress\n- setup\n## Critical Context\n- stable";
    const once = patchDeterministic(summary, verifySummary(summary, facts).gaps, facts);
    const twice = patchDeterministic(once, verifySummary(once, facts).gaps, facts);
    expect(twice).toBe(once);
    expect(verifySummary(once, facts).gaps.some(gap => gap.kind === "missing-file")).toBe(false);
  });
});

describe("adversarial tool semantics and cache boundaries", () => {
  it("keeps read and grep evidence independent", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: [{ type: "text", text: "inspect" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "r", name: "read", arguments: { path: "src/a.ts" } }] },
      { role: "toolResult", toolCallId: "r", content: [{ type: "text", text: "full content" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "g", name: "grep", arguments: { path: "src/a.ts", pattern: "x" } }] },
      { role: "toolResult", toolCallId: "g", content: [{ type: "text", text: "no matches" }] },
    ];
    expect(pruneRedundant(messages).messages.filter(message => message.role === "toolResult")).toHaveLength(2);
  });

  it("recognizes MCP snake-case edits without treating path+text universally as mutation", () => {
    expect(classifyToolOperation({ path: "src/a.ts", old_str: "a", new_str: "b" }, "mcp__fs__str_replace")).toBe("mutate");
    expect(classifyToolOperation({ path: "src/a.ts", text: "find x" }, "search")).not.toBe("mutate");
  });

  it("reconciles an error resolved across the incremental cache boundary", () => {
    const failed: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "f", name: "bash", arguments: { command: "test" } }] },
      { role: "toolResult", toolCallId: "f", isError: true, content: [{ type: "text", text: "test failed" }] },
    ];
    const retry: LlmMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "s", name: "bash", arguments: { command: "test" } }] },
      { role: "toolResult", toolCallId: "s", content: [{ type: "text", text: "passed" }] },
    ];
    const base = extractStructured(failed, PROFILES.balanced);
    const index = buildToolCallIndex(retry);
    const merged = mergeExtractions(base, extractStructured(retry, PROFILES.balanced, index), failed.length, retry, index);
    expect(merged.errors[0].resolved).toBe(true);
  });
});

describe("adversarial planning and safety", () => {
  it("counts tool-only messages in both live-tail and batch planning", () => {
    const estimator = makeTokenEstimator("openai", "test");
    const toolMessages: LlmMessage[] = Array.from({ length: 100 }, (_, index) => ({
      role: "assistant", content: [{ type: "toolCall", id: "w" + index, name: "write", arguments: { path: "src/f" + index + ".ts", content: "x".repeat(10_000) } }],
    }));
    expect(chunkLlmMessages(toolMessages, [], PROFILES.balanced, estimator)[0].tokenEstimate).toBeGreaterThan(1000);

    const branch = toolMessages.flatMap((message, index) => [
      { type: "message", id: "a" + index, parentId: index ? "r" + (index - 1) : null, timestamp: new Date().toISOString(), message },
      { type: "message", id: "r" + index, parentId: "a" + index, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "w" + index, content: [{ type: "text", text: "ok" }] } },
    ]);
    const window = resolveCompactionWindow({ ctx: { getContextUsage: () => ({ tokens: 100_000 }), model: { contextWindow: 120_000 }, sessionManager: { getBranch: () => branch, getSessionId: () => "s" } }, profileCfg: { keepRecentTokens: 20_000 }, estimator } as any);
    expect(window!.accTokens).toBeGreaterThanOrEqual(20_000);
  });

  it("enforces the call budget at the shared LLM seam", async () => {
    const services = createServices({
      budget: new BudgetGuard(1),
      llm: { complete: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1 } }) as any },
    });
    const args = [{ id: "m", provider: "openai" } as any, { messages: [] } as any, {}, services] as const;
    await trackedComplete("single-pass", ...args);
    expect(() => services.budget.reserveCall()).toThrow(BudgetExceededError);
  });

  it("redacts secrets recursively and preserves loop overrides", () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    expect(new SecretScrubber().scrubValue({ nested: { secret } }).value.nested.secret).not.toContain(secret);
    const loop: OpenLoop = { id: "old", type: "follow-up", priority: "normal", status: "open", summary: "Finish auth", files: [] };
    const overrides = upsertLoopOverride([], loop, { pinned: true, priority: "critical" });
    const applied = applyLoopOverrides([{ ...loop, id: "new" }], overrides);
    expect(applied[0].priority).toBe("critical");
  });

  it("observes online damage only after activation", () => {
    const monitor = new OnlineDamageMonitor();
    const message: LlmMessage = { role: "assistant", content: [{ type: "toolCall", id: "r", name: "read", arguments: { path: "src/a.ts" } }] };
    expect(monitor.observe("s", message)).toBeNull();
    monitor.activate("s", "p", { modifiedFiles: ["src/a.ts"], readFiles: [], topics: [], method: "eesv" } as any);
    expect(monitor.observe("s", message)?.report.damageScore).toBeGreaterThan(0);
  });
});
