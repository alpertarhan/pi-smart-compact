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
import { prepareRun } from "../src/app/steps/prepare.ts";
import { buildState } from "../src/app/steps/state.ts";
import { verifyAndPatch } from "../src/app/steps/verify.ts";
import { assembleFallback } from "../src/phases/synthesize.ts";
import { AUTO_TRIGGER_MAX_LLM_CALLS, DEFAULT_CONFIG, PROFILES } from "../src/constants.ts";
import { aggregateProviderRoutes } from "../src/domain/provider-evaluation.ts";
import { summarizeConversation } from "../src/app/steps/synthesize.ts";
import { explorationToolSupportKey } from "../src/phases/explore.ts";
import { setLlmClient, resetLlmClient } from "../src/infra/llm-client.ts";
import type { LlmClient } from "../src/infra/llm-client.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TieredRc } from "../src/app/run-context.ts";
import type { LlmMessage } from "../src/types.ts";
import { BudgetGuard, createServices } from "../src/infra/services.ts";
import { makeTokenEstimator } from "../src/utils/tokens.ts";
import { resetConfigCache } from "../src/utils/helpers.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../src/constants.ts";
import { commitPreparedConversationBackup } from "../src/utils/backups.ts";
import { saveCachedExtraction } from "../src/utils/cache.ts";
import { extractionCacheFile } from "../src/infra/paths.ts";

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
  it("resolves zero budget overrides before enforcing the automatic call ceiling", async () => {
    const rc = makeTieredRc([]);
    rc.config = { ...DEFAULT_CONFIG, maxLatencyMs: 0, maxLlmCalls: 0 };
    rc.mode = "balanced";
    rc.maxLlmCalls = 0;
    rc.flags.autoTriggered = true;
    await prepareRun(rc);
    for (let i = 0; i < AUTO_TRIGGER_MAX_LLM_CALLS; i++) rc.services.budget.reserveCall(1, 1);
    expect(() => rc.services.budget.reserveCall(1, 1)).toThrow("budget");
  });

  it.each([
    { route: "tool-loop", limit: AUTO_TRIGGER_MAX_LLM_CALLS, phases: ["explore", "explore-loop", "batch", "assemble"] },
    { route: "direct", limit: 3, phases: ["explore", "batch", "assemble"] },
    { route: "unsupported", limit: 3, phases: ["explore-direct", "batch", "assemble"] },
    { route: "rejected", limit: AUTO_TRIGGER_MAX_LLM_CALLS, phases: ["explore", "explore-direct", "batch", "assemble"] },
    { route: "truncated-batch", limit: AUTO_TRIGGER_MAX_LLM_CALLS, phases: ["explore", "explore-loop", "batch", "assemble"] },
    { route: "tool-loop", limit: 2, phases: ["batch", "assemble"] },
    { route: "tool-loop", limit: 1, phases: ["assemble"] },
  ])("keeps synthesis available with exploration route $route and call limit $limit", async ({ route, limit, phases }) => {
    let calls = 0;
    setLlmClient({ complete: async (_model, body) => {
      calls++;
      if (body.tools?.length && route === "rejected") throw Object.assign(new Error("tools are not supported"), { status: 400 });
      if (body.tools?.length && (route === "tool-loop" || route === "truncated-batch")) {
        return { ...makeSummaryResponse(""), stopReason: "toolUse", content: [
          { type: "toolCall", id: "explore-" + calls, name: "get_context_around", arguments: { index: 0, radius: 1 } },
        ] };
      }
      if (JSON.stringify(body.messages).includes("--- CHUNK 1:")) {
        const batch = makeSummaryResponse([
          "### CHUNK 1: Release plan", "**Priority**: normal",
          "**Summary**: Preserve the release plan.", "**Decisions**: None",
          "**Modified**: None", "**Deleted**: None", "**Read**: None",
        ].join("\n"));
        return route === "truncated-batch" ? { ...batch, stopReason: "length" } : batch;
      }
      return makeSummaryResponse("## Goal\nPreserve the release plan\n## Critical Context\nLLM_ASSEMBLY_SENTINEL");
    } });
    const tiered = makeTieredRc([userMsg("Preserve the release plan"), assistantMsg("Inspect the release blockers")]);
    tiered.mode = "thorough";
    tiered.requestedMode = "thorough";
    tiered.flags.autoTriggered = true;
    tiered.services.budget = new BudgetGuard(limit);
    if (route === "truncated-batch") tiered.services.thinkingLevels.summaryThinkingLevel = "high";
    const toolKey = explorationToolSupportKey(tiered.segModel);
    if (route === "unsupported") tiered.services.toolSupport.set(toolKey, false, Date.now());
    tiered.profileCfg.singlePassMaxTokens = 1;
    tiered.profileCfg.batchMaxTokens = 100_000;
    tiered.profileCfg.maxChunkTokens = 100_000;
    const extracted = extractWithCache(tiered);
    extracted.convTokens = 60_000;
    extracted.extraction.errors = [0, 1].map(index => ({
      index, tool: "bash", message: "release blocker " + index, retryAttempted: false, resolved: false,
    }));

    const synthesized = await summarizeConversation(extracted);

    expect(tiered.services.metrics.snapshot().map(metric => metric.phase)).toEqual([...phases]);
    expect(calls).toBe(limit);
    expect(tiered.services.budget.callCount()).toBe(calls);
    expect(synthesized.llmCalls).toBe(calls);
    expect(synthesized.finalSummary).toContain("LLM_ASSEMBLY_SENTINEL");
    expect(synthesized.generationFallbacks).toEqual(limit === 1
      ? ["call budget reserved for final assembly"]
      : route === "truncated-batch" ? ["1 synthesis batch fallback"] : []);
    if (route === "tool-loop" && limit > 2) expect(tiered.services.toolSupport.get(toolKey, Date.now())).toBe(true);
    if (route === "direct" || limit <= 2) expect(tiered.services.toolSupport.get(toolKey, Date.now())).toBeUndefined();
  });

  it.each([1, 2, 4])("keeps the assembly call with retries and queued batches (%i workers)", async (concurrency) => {
    let batches = 0;
    setLlmClient({ complete: async (_model, body) => {
      if (JSON.stringify(body.messages).includes("--- CHUNK 1:")) {
        batches++;
        const batch = makeSummaryResponse([
          "### CHUNK 1: Evidence", "**Priority**: normal", "**Summary**: Preserve the evidence.",
          "**Decisions**: None", "**Modified**: None", "**Deleted**: None", "**Read**: None",
        ].join("\n"));
        return batches <= 2 ? { ...batch, stopReason: "length" } : batch;
      }
      return makeSummaryResponse("## Goal\nPreserve evidence\n## Critical Context\nLLM_ASSEMBLY_SENTINEL");
    } });
    const messages = Array.from({ length: 6 }, (_, index) => {
      const text = "Detail " + index + ": " + "evidence ".repeat(40);
      return index % 2 ? assistantMsg(text) : userMsg(text);
    });
    const tiered = makeTieredRc(messages);
    tiered.mode = "balanced";
    tiered.requestedMode = "balanced";
    tiered.services.budget = new BudgetGuard(4);
    tiered.services.thinkingLevels.summaryThinkingLevel = "high";
    tiered.providerCaps.concurrencyLimit = concurrency;
    Object.assign(tiered.profileCfg, {
      singlePassMaxTokens: 1, batchMaxTokens: 40, maxChunkTokens: 40, minChunkTokens: 1,
    });
    const extracted = extractWithCache(tiered);
    const synthesized = await summarizeConversation(extracted);

    expect(synthesized.chunkCount).toBeGreaterThan(2);
    expect(tiered.services.metrics.snapshot().map(metric => metric.phase)).toEqual(["batch", "batch", "batch", "assemble"]);
    expect(tiered.services.budget.callCount()).toBe(4);
    expect(synthesized.finalSummary).toContain("LLM_ASSEMBLY_SENTINEL");
  });

  it("keeps Fast path encoding stable through post-state verification", async () => {
    const rc = makeTieredRc([]);
    rc.profileCfg = { ...PROFILES.aggressive };
    rc.profile = "aggressive";
    rc.mode = "fast";
    rc.totalTokens = 100_000;
    (rc as any).compactionPlan = { summaryBudgetTokens: 3_000, retainedTokens: 1_000, fixedContextTokens: 0, targetAfterTokens: 80_000, projectedAfterTokens: 80_000 };
    const extracted = extractWithCache(rc);
    extracted.extraction.readFiles = Array.from({ length: 200 }, (_, i) => "src/" + "directory/".repeat(15) + `module-${i}.ts`);
    const summary = assembleFallback([], extracted.extraction, undefined, 3_000);
    const synthesized = Object.assign(extracted, { _synthesized: true, finalSummary: summary, summaries: [], method: "heuristic" }) as any;
    const verified = await verifyAndPatch(synthesized);
    const stated = buildState(verified);
    expect(stated.verificationProvenance.deterministicPatched).toEqual([]);
    expect(stated.finalSummary.length).toBeLessThan(summary.length + 2_000);
  });

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

  it("reuses the exact pruned extraction instead of recomputing full history", () => {
    const messages = [userMsg("Preserve exact cache evidence"), assistantMsg("Working on it")];
    const sessionId = "exact-cache-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    try {
      const firstRc = makeTieredRc(messages);
      firstRc.sessionId = sessionId;
      const first = extractWithCache(firstRc);
      const cached = { ...first.extraction, mainGoal: "Exact cached extraction sentinel" };
      saveCachedExtraction(
        sessionId,
        cached,
        first.llmMessages.length,
        first.currentEntryIds[0],
        first.currentEntryIds.at(-1),
        first.currentEntryIds,
        first.currentKeptEntryIds,
        first.llmMessages,
      );

      const notices: string[] = [];
      const secondRc = makeTieredRc(messages);
      secondRc.sessionId = sessionId;
      secondRc.notify = message => { notices.push(message); };
      const second = extractWithCache(secondRc);

      expect(second.extraction.mainGoal).toBe("Exact cached extraction sentinel");
      expect(second.services.extractionCacheStats.snapshot().hits).toBe(1);
      expect(notices).toContain("Phase 1 Cached: exact pruned conversation reused");
    } finally {
      try { fs.unlinkSync(extractionCacheFile(sessionId)); } catch {}
    }
  });

  it("invalidates cached evidence when content changes under the same entry IDs", () => {
    const sessionId = "edited-cache-" + crypto.randomUUID();
    try {
      const firstRc = makeTieredRc([userMsg("Implement obsolete payments"), assistantMsg("Working on it")]);
      firstRc.sessionId = sessionId;
      extractWithCache(firstRc);
      const nextRc = makeTieredRc([userMsg("Implement current authentication"), assistantMsg("Working on it")]);
      nextRc.sessionId = sessionId;
      const next = extractWithCache(nextRc);
      expect(next.services.extractionCacheStats.snapshot().hits).toBe(0);
      expect(next.extraction.mainGoal).toContain("current authentication");
      expect(JSON.stringify(next.extraction)).not.toContain("obsolete payments");
    } finally {
      fs.rmSync(extractionCacheFile(sessionId), { force: true });
    }
  });

  it("skips backup materialization while preserving mandatory extraction scrubbing", () => {
    const tiered = makeTieredRc([
      userMsg("Start"), assistantMsg("I'll be pruned"), userMsg("Continue"),
      assistantMsg("Substantive evidence"), userMsg("Finish"),
    ]);
    const scrubber = tiered.services.scrubber;
    let textScrubs = 0;
    let valueScrubs = 0;
    // Instrument the existing scrubber without changing its boundary behavior.
    tiered.services.scrubber = {
      scrubText: (text: string) => { textScrubs++; return scrubber.scrubText(text); },
      scrubValue: <T>(value: T) => { valueScrubs++; return scrubber.scrubValue(value); },
      count: () => scrubber.count(),
    } as unknown as typeof tiered.services.scrubber;

    expect(extractWithCache(tiered).backupPath).toBeNull();
    expect(textScrubs).toBe(1);
    expect(valueScrubs).toBeGreaterThanOrEqual(2);
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
      content: [{ type: "text", text: "a".repeat(4_000) + truncatedEvidence + "b".repeat(MAX_TOOL_OUTPUT_CHARS) }],
    };
    const messages = [
      userMsg("Preserve the selected span"), assistantMsg(removedEvidence), longToolResult,
      userMsg("Continue"), assistantMsg("Substantive synthesis evidence"), userMsg("Finish"),
    ];
    let request = "";
    setLlmClient({ complete: async (...args: Parameters<LlmClient["complete"]>) => {
      request = JSON.stringify(args);
      return makeSummaryResponse("## Goal\nPreserve evidence\n## Progress\n### Done\n- done\n### In Progress\n- none\n### Blocked\n- none\n## Critical Context\n- context");
    } });

    try {
      const tiered = makeTieredRc(messages);
      tiered.config.backupEnabled = true;
      const scrubber = tiered.services.scrubber;
      let backupScrubs = 0;
      // Instrument only text scrubbing; the production scrubber still performs every redaction.
      tiered.services.scrubber = {
        scrubText: (text: string) => {
          backupScrubs++;
          return scrubber.scrubText(text);
        },
        scrubValue: <T>(value: T) => scrubber.scrubValue(value),
        count: () => scrubber.count(),
      } as unknown as typeof tiered.services.scrubber;
      const extracted = extractWithCache(tiered);
      expect(extracted.convText).toContain(removedEvidence);
      expect(extracted.convText).not.toContain(truncatedEvidence);
      expect(fs.existsSync(extracted.backupPath!)).toBe(false);
      expect(extracted.preparedBackup?.content).toBeUndefined();
      expect(extracted.preparedBackup?.materialize).toBeFunction();
      expect(backupScrubs).toBe(1);
      await commitPreparedConversationBackup(extracted.preparedBackup!);
      expect(backupScrubs).toBe(2);
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

  it("does not re-truncate preserved assistant and tool evidence at serialization", () => {
    const tool: LlmMessage = { role: "toolResult", toolName: "bash", toolCallId: "long", isError: true, content: [{ type: "text", text: "output ".repeat(600) + "CRITICAL_END_SENTINEL" }] };
    // Error output survives pruning and must survive the synthesis serializer too.
    const extracted = extractWithCache(makeTieredRc([userMsg("Diagnose the failure"), tool]));
    expect(extracted.convText).toContain("CRITICAL_END_SENTINEL");
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

  it("falls back deterministically and does not cache a truncated single-pass summary (A09)", async () => {
    const messages = [userMsg("Refactor the auth module"), assistantMsg("Working on it")];
    const truncatedBody =
      "## Goal\nRefactor the auth module.\n\n## Critical Context\nKeep the plan.\n\n```ts\nconst unfinished =";
    let calls = 0;
    setLlmClient({ complete: async () => {
      calls++;
      return { ...makeSummaryResponse(truncatedBody), stopReason: "length" };
    } });
    const tiered = makeTieredRc(messages);
    const extracted = extractWithCache(tiered);

    const synthesized = await summarizeConversation(extracted);

    expect(synthesized.method).toBe("heuristic");
    expect(synthesized.finalSummary).not.toContain("const unfinished");
    expect(synthesized.generationFallbacks).toContain("single-pass generation failed");
    // Reject-before-cache: a later identical run must still call the model
    // instead of replaying the rejected truncated output from the cache.
    const second = await summarizeConversation(extractWithCache(tiered));
    expect(calls).toBeGreaterThan(1);
    expect(second.finalSummary).not.toContain("const unfinished");
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
    const warnings: string[] = [];
    const tiered = makeTieredRc(messages);
    tiered.notify = (message, type) => { notices.push(message); if (type === "warning") warnings.push(message); };
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
    expect(notices.join("\n")).toContain("Single-pass generation stopped");
    expect(notices.join("\n")).toContain("provider");
    expect(notices.join("\n")).toContain("provider (simulated provider outage)");
    expect(warnings).toEqual([]); // Outcome feedback belongs to verification/apply, not recovery attempts.
    expect(aggregateProviderRoutes(tiered.services.metrics.snapshot())[0]?.failures).toEqual({ provider: 1 });
    expect(JSON.stringify(tiered.services.metrics.snapshot())).not.toContain("simulated provider outage");
  });

  it("records a malformed one-batch fallback and never caches its degraded synthesis", async () => {
    const messages = [userMsg("Preserve the release plan"), assistantMsg("Working through the release plan")];
    let calls = 0;
    setLlmClient({
      complete: async () => {
        calls++;
        if (calls === 1) return makeSummaryResponse("");
        return makeSummaryResponse(
          "## Goal\nPreserve the release plan\n## Progress\n### Done\n- none\n### In Progress\n- release\n### Blocked\n- none\n## Critical Context\n- keep release evidence",
        );
      },
    });
    const notices: string[] = [];
    const warnings: string[] = [];
    const makeExtracted = () => {
      const tiered = makeTieredRc(messages);
      tiered.sessionId = "one-batch-fallback-session";
      tiered.notify = (message, type) => { notices.push(message); if (type === "warning") warnings.push(message); };
      tiered.profileCfg.singlePassMaxTokens = 1;
      tiered.profileCfg.batchMaxTokens = 100_000;
      tiered.profileCfg.maxChunkTokens = 100_000;
      const extracted = extractWithCache(tiered);
      extracted.convTokens = 60_000;
      return extracted;
    };

    const first = await summarizeConversation(makeExtracted());
    expect(first.generationFallbacks).toContain("1 synthesis batch fallback");
    expect(notices.join("\n")).toContain("Synthesis batch stopped · deterministic evidence fallback preserved coverage");
    expect(warnings).toEqual([]);
    expect(calls).toBe(2);

    await summarizeConversation(makeExtracted());
    expect(calls).toBeGreaterThan(2);
  });
});
