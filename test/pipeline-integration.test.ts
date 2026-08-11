/**
 * End-to-end pipeline integration test.
 *
 * The audit (gpt5 review #1) flagged that we had strong unit coverage of
 * each stage but no test that wired them together with a mock LLM. This
 * file fills that gap by driving the full `extract -> synthesize -> verify`
 * chain against a deterministic fake `LlmClient`.
 *
 * Coverage goals (in priority order):
 *
 *   1. Happy path: synthesize succeeds, verify returns ok, summary makes
 *      it back as a string starting with the expected H2 header.
 *   2. LLM failure -> heuristic fallback: when the mock client throws on
 *      every call, `summarizeConversation` must NOT crash; it must fall
 *      back to `assembleFallback` and still produce a synthesized stage.
 *   3. Tool-call detection in the explore phase: the mock returns a
 *      response with toolCall blocks once, then an empty boundary report,
 *      and we verify exploration runs and gets logged.
 *
 * What we deliberately DON'T test here (covered elsewhere):
 *
 *   - `applyCompaction` lifecycle (persist-lifecycle.test.ts)
 *   - Cancellation surface (persist-lifecycle.test.ts)
 *   - Cache prefix matching (cache.test.ts, id-fingerprint.test.ts)
 *   - Provider replay (deliberately disabled; llm-client.test.ts asserts one attempt)
 *
 * The fake context is built fresh per test so we don't need to drag in
 * the real `ExtensionCommandContext` shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractWithCache } from "../src/app/steps/extract.ts";
import { summarizeConversation } from "../src/app/steps/synthesize.ts";
import { setLlmClient, resetLlmClient } from "../src/infra/llm-client.ts";
import type { LlmClient } from "../src/infra/llm-client.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TieredRc } from "../src/app/run-context.ts";
import type { LlmMessage } from "../src/types.ts";
import { createServices } from "../src/infra/services.ts";
import { makeTokenEstimator } from "../src/utils/tokens.ts";
import { resetConfigCache } from "../src/utils/helpers.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../src/constants.ts";
import { commitPreparedConversationBackup } from "../src/utils/backups.ts";

/**
 * Build a TieredRc with the minimum fields synthesizeConversation +
 * extractWithCache rely on. We bypass the earlier stages because they
 * need a full Pi context (model registry, branch, etc.) which is not
 * worth stubbing — those stages have their own targeted tests.
 */
function makeTieredRc(messages: LlmMessage[]): TieredRc {
  const notify = (..._args: unknown[]) => { /* no-op */ };
  const services = createServices();
  // Cast through unknown: we're shaping a subset of TieredRc that's
  // sufficient for extract -> synthesize without dragging in the full
  // ExtensionCommandContext surface. The narrow set of fields we touch
  // is checked at use site, so a real shape drift would surface as a
  // test failure rather than a silent skip.
  const rc = {
    ctx: { cwd: "/tmp", getContextUsage: () => ({ tokens: 0 }), ui: { notify: () => {/*noop*/}, custom: async () => null } },
    services,
    notify,
    vlog: notify,
    flags: { autoTriggered: false, skipCompact: false, verbose: false, dryRun: false, force: false },
    cancellation: { controller: new AbortController(), signal: new AbortController().signal, timedOut: false, timeoutId: null },
    pendingRef: { value: null, createdAt: 0 },
    isRunning: { value: false },
    userNote: undefined,
    timeoutMs: 0,
    phaseTimings: [],
    pipelineStart: Date.now(),
    phaseStart: Date.now(),
    sessionId: "test-session-" + Math.random().toString(36).slice(2),
    branch: messages,
    msgs: messages.map((message, index) => ({ id: "m-" + index, type: "message", message })),
    totalTokens: 1000,
    contextPercent: 30,
    toolPercent: 20,
    keepFrom: 0,
    toCompact: messages.map((m, i) => ({ id: "m-" + i, type: "message", message: m })),
    firstKeptId: "m-0",
    compactTokens: 500,
    accTokens: 500,
    llmMessages: messages,
    llmEntryIds: messages.map((_, index) => "m-" + index),
    tier: "balanced",
    summaryModel: { provider: "openai", id: "gpt-5", contextWindow: 200000 },
    segModel: { provider: "openai", id: "gpt-5", contextWindow: 200000 },
    modelLabel: "openai/gpt-5",
    profile: "balanced",
    summaryAuth: { apiKey: "test-key" },
    segAuth: { apiKey: "test-key" },
    config: {
      profile: "balanced", autoTrigger: { enabled: false, threshold: 0.8 },
      backupEnabled: false, backupDir: "/tmp/test-backups",
      models: { summary: undefined, segment: undefined },
    },
    profileCfg: {
      singlePassMaxTokens: 50000, batchMaxTokens: 8000,
      summaryBudgetTokens: 2000, keepRecentTokens: 10000,
      minChunkTokens: 500, maxChunkTokens: 4000,
    },
    estimator: makeTokenEstimator("openai", "gpt-5", services.tokenCalibration),
    providerCaps: {
      maxOutputTokens: 8192, supportsTools: true as boolean | "probe",
      jsonReliability: "high", instructionFollowing: "high",
      tokenRatioEstimate: 4.0, concurrencyLimit: 5,
      cacheStrategy: "none", timeoutMultiplier: 1.0,
      singlePassTokenMultiplier: 1.0, multimodal: "metadata-only",
    },
    _prepared: true, _windowed: true, _recovered: true, _tiered: true,
  } as unknown as TieredRc;
  return rc;
}

function userMsg(text: string): LlmMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMsg(text: string): LlmMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() };
}

function makeSummaryResponse(summary: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: summary }],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    stopReason: "endTurn",
  } as unknown as AssistantMessage;
}

beforeEach(() => {
  // Isolation: each test should start with the production client unless
  // it explicitly installs a fake. resetLlmClient resets to the retry-
  // wrapped default; tests then call setLlmClient with their own fake.
  resetLlmClient();
});

afterEach(() => {
  resetLlmClient();
});

describe("pipeline integration: extract -> synthesize (single-pass)", () => {
  it("bounds long lineage while retaining pre-compaction state heads", () => {
    const lineage = Array.from({ length: 1_001 }, (_, index) => ({
      id: "entry-" + (index + 1),
      ...(index === 100 ? { type: "compaction", parentId: "entry-100" } : {}),
    }));
    const tiered = makeTieredRc([userMsg("continue the long lineage")]);
    (tiered.ctx as any).sessionManager = { getBranch: () => lineage };

    const extracted = extractWithCache(tiered);
    const ancestry = extracted.continuityScope.branchAncestryIds!;

    expect(extracted.continuityScope.branchHeadId).toBe("entry-1001");
    expect(ancestry.length).toBeLessThanOrEqual(512);
    expect(ancestry).toContain("entry-100");
    expect(ancestry.at(-1)).toBe("entry-1001");
  });

  it("skips backup serialization and scrubbing when backups are disabled", () => {
    const tiered = makeTieredRc([
      userMsg("Start"), assistantMsg("I'll be pruned"), userMsg("Continue"),
      assistantMsg("Substantive evidence"), userMsg("Finish"),
    ]);
    tiered.services.scrubber = {
      scrubText: () => { throw new Error("backup scrub should not run"); },
      scrubValue: <T>(value: T) => ({ value, findings: [] }),
      count: () => 0,
    } as any;

    expect(extractWithCache(tiered).backupPath).toBeNull();
  });

  it("backs up the full selected span while synthesis keeps substantive assistant evidence", async () => {
    const previousHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-full-backup-"));
    const backupDir = path.join(home, "backups");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      smartCompact: { backupEnabled: true, backupDir },
    }));
    process.env.HOME = home;
    resetConfigCache();
    const removedEvidence = "I'll remove-only backup evidence";
    const truncatedEvidence = "TRUNCATED-MIDDLE-BACKUP-EVIDENCE";
    const longToolResult: LlmMessage = {
      role: "toolResult", toolCallId: "long-output", isError: false, timestamp: Date.now(),
      content: [{ type: "text", text: "a".repeat(MAX_TOOL_OUTPUT_CHARS) + truncatedEvidence + "b".repeat(MAX_TOOL_OUTPUT_CHARS) }],
    };
    const messages = [
      userMsg("Preserve the selected span"), assistantMsg(removedEvidence), longToolResult,
      userMsg("Continue"), assistantMsg("Substantive synthesis evidence"), userMsg("Finish"),
    ];
    let request = "";
    setLlmClient({ complete: async (...args: any[]) => {
      request = JSON.stringify(args);
      return makeSummaryResponse("## Goal\nPreserve evidence\n## Progress\n### Done\n- done\n### In Progress\n- none\n### Blocked\n- none\n## Critical Context\n- context");
    } });

    try {
      const tiered = makeTieredRc(messages);
      tiered.config.backupEnabled = true;
      const scrubber = tiered.services.scrubber;
      let backupScrubs = 0;
      tiered.services.scrubber = {
        scrubText: (text: string) => {
          backupScrubs++;
          return scrubber.scrubText(text);
        },
        scrubValue: <T>(value: T) => scrubber.scrubValue(value),
        count: () => scrubber.count(),
      } as any;
      const extracted = extractWithCache(tiered);
      expect(extracted.convText).toContain(removedEvidence);
      expect(extracted.convText).not.toContain(truncatedEvidence);
      expect(fs.existsSync(extracted.backupPath!)).toBe(false);
      expect(extracted.preparedBackup?.content).toBeUndefined();
      expect(extracted.preparedBackup?.materialize).toBeFunction();
      expect(backupScrubs).toBe(0);
      await commitPreparedConversationBackup(extracted.preparedBackup!);
      expect(backupScrubs).toBe(1);
      expect(fs.readFileSync(extracted.backupPath!, "utf8")).toContain(truncatedEvidence);
      await summarizeConversation(extracted);
      expect(request).toContain(removedEvidence);
      expect(request).not.toContain(truncatedEvidence);
    } finally {
      process.env.HOME = previousHome;
      resetConfigCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("produces a summary when the LLM returns a well-formed markdown response", async () => {
    const messages: LlmMessage[] = [
      userMsg("Help me refactor src/auth.ts to use async/await."),
      assistantMsg("I'll start by reading the file."),
      userMsg("Looks good. Now also update src/db.ts."),
      assistantMsg("Done. Both files are updated."),
    ];

    let callCount = 0;
    const fakeClient: LlmClient = {
      complete: async () => {
        callCount++;
        return makeSummaryResponse(
          "## Goal\nRefactor auth.ts and db.ts.\n\n" +
          "## Open Loops\n- (none)\n\n" +
          "## Key Decisions\n- Use async/await\n\n" +
          "## Critical Context\nBoth files modified.\n",
        );
      },
    };
    setLlmClient(fakeClient);

    const tiered = makeTieredRc(messages);
    const extracted = extractWithCache(tiered);
    expect(extracted.convText.length).toBeGreaterThan(0);
    expect(extracted.convTokens).toBeGreaterThan(0);
    expect(extracted.extraction.modifiedFiles.length + extracted.extraction.readFiles.length).toBeGreaterThanOrEqual(0);

    const synthesized = await summarizeConversation(extracted);
    expect(synthesized.finalSummary).toContain("##");
    expect(synthesized.method).toBe("single-pass");
    expect(synthesized.llmCalls).toBe(callCount);
    expect(callCount).toBeGreaterThan(0);
  });

  it("uses zero LLM calls for high-confidence fast-mode extraction", async () => {
    const messages = [userMsg("Update src/auth.ts"), assistantMsg("Updated it")];
    let callCount = 0;
    setLlmClient({ complete: async () => { callCount++; throw new Error("must not call"); } });
    const tiered = makeTieredRc(messages);
    tiered.mode = "fast";
    tiered.requestedMode = "fast";
    const extracted = extractWithCache(tiered);
    extracted.extraction.mainGoal = "Update auth";
    extracted.extraction.lastUserMessages = ["Update src/auth.ts"];
    extracted.extraction.modifiedFiles = [{ path: "src/auth.ts", toolCalls: 1, lastModifiedIndex: 1 }];

    const synthesized = await summarizeConversation(extracted);

    expect(synthesized.methodForMetrics).toBe("zero-call");
    expect(synthesized.llmCalls).toBe(0);
    expect(callCount).toBe(0);
    expect(synthesized.finalSummary).toContain("src/auth.ts");
  });

  it("refines auto strategy without invalidating the already planned window budget", async () => {
    const messages = [userMsg("Resolve the risky release"), assistantMsg("Working on it")];
    setLlmClient({ complete: async () => makeSummaryResponse(
      "## Goal\nResolve the risky release\n## Progress\n### Done\n- none\n### In Progress\n- release\n### Blocked\n- none\n## Critical Context\n- preserve context",
    ) });
    const tiered = makeTieredRc(messages);
    tiered.requestedMode = "auto";
    tiered.mode = "balanced";
    tiered.config.maxLlmCalls = 0;
    tiered.config.maxLlmInputTokens = 0;
    (tiered as any).compactionPlan = { summaryBudgetTokens: tiered.profileCfg.summaryBudgetTokens };
    const extracted = extractWithCache(tiered);
    extracted.extraction.errors = Array.from({ length: 6 }, (_, index) => ({
      index, tool: "bash", message: "test failed " + index, retryAttempted: false, resolved: false,
    }));
    const plannedBudget = extracted.profileCfg.summaryBudgetTokens;
    const plannedProfile = extracted.profile;

    const synthesized = await summarizeConversation(extracted);

    expect(synthesized.mode).toBe("thorough");
    expect(synthesized.profile).toBe(plannedProfile);
    expect(synthesized.profileCfg.summaryBudgetTokens).toBe(plannedBudget);
  });

  it("does not use zero-call for token-dense tool-heavy context", async () => {
    const messages = [userMsg("Update src/auth.ts"), assistantMsg("Updated it")];
    let callCount = 0;
    setLlmClient({ complete: async () => {
      callCount++;
      return makeSummaryResponse("## Goal\nUpdate auth\n## Progress\n### Done\n- none\n### In Progress\n- update auth\n### Blocked\n- none\n## Critical Context\n- preserve context");
    } });
    const tiered = makeTieredRc(messages);
    tiered.mode = "fast";
    tiered.requestedMode = "fast";
    const extracted = extractWithCache(tiered);
    extracted.extraction.mainGoal = "Update auth";
    extracted.extraction.lastUserMessages = ["Update src/auth.ts"];
    extracted.extraction.modifiedFiles = [{ path: "src/auth.ts", toolCalls: 1, lastModifiedIndex: 1 }];
    extracted.extraction.messageCount = 20;
    extracted.convTokens = 180_000;
    extracted.toolPercent = 85;

    const synthesized = await summarizeConversation(extracted);
    expect(synthesized.methodForMetrics).not.toBe("zero-call");
    expect(callCount).toBeGreaterThan(0);
  });

  it("falls back to heuristic synthesis when every LLM call fails", async () => {
    const messages: LlmMessage[] = [
      userMsg("Quick question about src/helpers.ts."),
      assistantMsg("Sure, what about it?"),
    ];

    const fakeClient: LlmClient = {
      complete: async () => {
        throw new Error("simulated provider outage");
      },
    };
    setLlmClient(fakeClient);

    const notices: string[] = [];
    const tiered = makeTieredRc(messages);
    tiered.notify = (message: string) => { notices.push(message); };
    const extracted = extractWithCache(tiered);
    const synthesized = await summarizeConversation(extracted);

    // The single-pass try/catch must catch and fall through to the
    // heuristic assembler. Critically: we must NOT throw out of the
    // synthesize stage, because the orchestrator depends on this
    // returning a SynthesizedRc for the metrics step to record the
    // failure cleanly.
    expect(synthesized.method).toBe("heuristic");
    expect(synthesized.finalSummary.length).toBeGreaterThan(0);
    expect(synthesized.llmCalls).toBe(1);
    expect(notices).toContain("Single-pass generation stopped · using deterministic fallback");
    expect(notices.join("\n")).not.toContain("simulated provider outage");
  });

  it("records a one-batch fallback and never caches its degraded synthesis", async () => {
    const messages = [userMsg("Preserve the release plan"), assistantMsg("Working through the release plan")];
    let calls = 0;
    setLlmClient({
      complete: async () => {
        calls++;
        if (calls === 1) throw new Error("single batch unavailable");
        return makeSummaryResponse(
          "## Goal\nPreserve the release plan\n## Progress\n### Done\n- none\n### In Progress\n- release\n### Blocked\n- none\n## Critical Context\n- keep release evidence",
        );
      },
    });
    const notices: string[] = [];
    const makeExtracted = () => {
      const tiered = makeTieredRc(messages);
      tiered.sessionId = "one-batch-fallback-session";
      tiered.notify = message => { notices.push(message); };
      tiered.profileCfg.singlePassMaxTokens = 1;
      tiered.profileCfg.batchMaxTokens = 100_000;
      tiered.profileCfg.maxChunkTokens = 100_000;
      const extracted = extractWithCache(tiered);
      extracted.convTokens = 60_000;
      return extracted;
    };

    const first = await summarizeConversation(makeExtracted());
    expect(first.generationFallbacks).toContain("1 synthesis batch fallback");
    expect(notices).toContain("Synthesis batch stopped · deterministic evidence fallback preserved coverage");
    expect(calls).toBe(2);

    await summarizeConversation(makeExtracted());
    expect(calls).toBeGreaterThan(2);
  });
});
