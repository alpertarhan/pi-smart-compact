/**
 * Task L: full LLM batch coverage within the synthesis call budget.
 *
 * Both 10.8.0 RC dry runs left one synthesis batch on the deterministic
 * fallback purely because the remaining call cap was smaller than the batch
 * count plus assembly — even though the chunks fit in fewer real requests.
 * These tests pin the re-packing contract:
 *   - every chunk is covered by a valid LLM batch request when the summary
 *     model and remaining budget admit it, with final assembly reserved;
 *   - a plan that already fits is passed through unchanged;
 *   - merging is admissible only against the actually built request (scrub +
 *     estimate + model capacity) and never squeezes a chunk below its mode's
 *     per-chunk visible output allowance;
 *   - optional exploration cannot spend a known feasible full-coverage
 *     synthesis allowance (probe, loop, direct and retry paths);
 *   - when full coverage is impossible the safe deterministic fallback from
 *     task I stays, with no oversized dispatch.
 *
 * Synthetic fixtures only; the fake LLM client never touches the network.
 * Chunking is made deterministic by overriding `extraction.topics` after the
 * extraction step (same pattern the pipeline tests use for `errors`).
 */
import { beforeEach, describe, expect, it } from "bun:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { extractWithCache } from "../src/app/steps/extract.ts";
import { repackBatchesForCallBudget, summarizeConversation } from "../src/app/steps/synthesize.ts";
import { exploreConversation, SYNTHESIS_CALL_RESERVE } from "../src/phases/explore.ts";
import { BudgetGuard, createServices } from "../src/infra/services.ts";
import { clearSynthesisCache } from "../src/infra/synthesis-cache.ts";
import { setLlmClient, resetLlmClient } from "../src/infra/llm-client.ts";
import { makeTokenEstimator } from "../src/utils/tokens.ts";
import type { LlmChunk, LlmMessage, StructuredExtraction } from "../src/types.ts";
import type { TieredRc } from "../src/app/run-context.ts";

const LLM_SUMMARY_MARKER = "LLM_SUMMARY_SENTINEL_";

/** Every message renders to exactly 500 chars (TRUNC.PREVIEW_XL) => ~127 estimated tokens. */
function sizedMsg(index: number): LlmMessage {
  return {
    role: "user",
    content: [{ type: "text", text: String(index).padStart(4, "0") + "x".repeat(496) }],
    timestamp: 1,
  } as LlmMessage;
}

/** Minimal TieredRc shaped like the pipeline-integration fixture. */
function makeTieredRc(messages: LlmMessage[], summaryModel: Model<Api>): TieredRc {
  const notify = (..._args: unknown[]) => { /* no-op */ };
  const services = createServices();
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
    sessionId: "task-l-" + Math.random().toString(36).slice(2),
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
    summaryModel,
    segModel: summaryModel,
    modelLabel: summaryModel.provider + "/" + summaryModel.id,
    profile: "balanced",
    summaryAuth: { apiKey: "test-key" },
    segAuth: { apiKey: "test-key" },
    config: {
      profile: "balanced", autoTrigger: { enabled: false, threshold: 0.8 },
      backupEnabled: false, backupDir: "/tmp/test-backups",
      models: { summary: undefined, segment: undefined },
    },
    profileCfg: {
      singlePassMaxTokens: 50_000, batchMaxTokens: 8_000,
      summaryBudgetTokens: 2_000, keepRecentTokens: 10_000,
      minChunkTokens: 500, maxChunkTokens: 4_000,
    },
    estimator: makeTokenEstimator(summaryModel.provider, summaryModel.id, services.tokenCalibration),
    providerCaps: {
      maxOutputTokens: 8_192, supportsTools: true as boolean | "probe",
      jsonReliability: "high", instructionFollowing: "high",
      tokenRatioEstimate: 4.0, concurrencyLimit: 5,
      cacheStrategy: "none", timeoutMultiplier: 1.0,
      singlePassTokenMultiplier: 1.0, multimodal: "metadata-only",
    },
    _prepared: true, _windowed: true, _recovered: true, _tiered: true,
  } as unknown as TieredRc;
  return rc;
}

/** Deterministic topic boundaries: one topic per [start..end] message range. */
function topicsFor(ranges: Array<[number, number]>): StructuredExtraction["topics"] {
  return ranges.map(([startIndex, endIndex]) => ({
    startIndex, endIndex, primaryFile: null, type: "implementation" as const, errorDensity: 0,
  }));
}

function makeSummaryResponse(text: string, stopReason = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input: 100, output: 50, totalTokens: 150 },
    stopReason,
  } as unknown as AssistantMessage;
}

/** Batch answers with one valid section per `--- CHUNK n: topic ---` in the prompt. */
function batchResponse(prompt: string): AssistantMessage {
  const ids = [...prompt.matchAll(/--- CHUNK (\d+):/g)].map(match => Number(match[1]));
  const sections = ids.map(id => [
    "### CHUNK " + id + ": Segment",
    "**Priority**: normal",
    "**Summary**: " + LLM_SUMMARY_MARKER + id,
    "**Decisions**: None",
    "**Modified**: None",
    "**Deleted**: None",
    "**Read**: None",
  ].join("\n"));
  return makeSummaryResponse(sections.join("\n\n"));
}

const ASSEMBLY_TEXT = "## Goal\nPreserve coverage\n## Critical Context\nASSEMBLY_SENTINEL";

/**
 * Fake LLM that answers batch prompts section-complete and everything else
 * (assembly, exploration) with a valid assembly-shaped summary. Records how
 * many chunk sections each batch request carried, so tests can assert that
 * no oversized dispatch happened.
 */
function fakeLlm() {
  const batchChunkCounts: number[] = [];
  setLlmClient({
    complete: async (_model: Model<Api>, body: { messages: unknown }) => {
      const prompt = JSON.stringify(body.messages);
      if (prompt.includes("--- CHUNK ")) {
        batchChunkCounts.push([...prompt.matchAll(/--- CHUNK \d+:/g)].length);
        return batchResponse(prompt);
      }
      return makeSummaryResponse(ASSEMBLY_TEXT);
    },
  } as never);
  return { batchChunkCounts };
}

const openAiModel = { provider: "openai", id: "gpt-5", api: "openai-responses", contextWindow: 200_000 } as Model<Api>;

const unitExtraction: StructuredExtraction = {
  modifiedFiles: [], readFiles: [], deletedFiles: [], errors: [], decisions: [], constraints: [],
  topics: [], timeline: [], mainGoal: "Preserve the decision", lastUserMessages: ["Keep atomic writes"],
  lastErrors: [], messageCount: 1,
};

const unitChunk = (index: number): LlmChunk => ({
  topic: "Chunk " + index,
  startIndex: index,
  endIndex: index,
  tokenEstimate: 20,
  priority: "normal",
  messages: [sizedMsg(index)],
});

beforeEach(() => {
  resetLlmClient();
  clearSynthesisCache();
});

describe("synthesis batch re-packing within the call budget", () => {
  it("re-partitions chunks across batch boundaries into the fewest feasible requests (red: budget fallback on main)", async () => {
    // 12 one-message topics of ~127 tokens: maxChunkTokens 600 keeps each
    // whole; batchMaxTokens 400 packs 3 chunks per batch -> 4 batches, but a
    // budget of 4 allows only 3 batch calls + assembly. The re-pack may cross
    // the old batch boundaries: the minimum is a single request covering all
    // 12 chunks (12*250 visible = 3000 <= the balanced 4096 cap).
    const messages = Array.from({ length: 12 }, (_, index) => sizedMsg(index));
    const tiered = makeTieredRc(messages, openAiModel);
    tiered.mode = "balanced";
    tiered.requestedMode = "balanced";
    tiered.services.budget = new BudgetGuard(4);
    Object.assign(tiered.profileCfg, {
      singlePassMaxTokens: 1, batchMaxTokens: 400, maxChunkTokens: 600, minChunkTokens: 1,
    });
    const extracted = extractWithCache(tiered);
    extracted.extraction.topics = topicsFor(messages.map((_, index) => [index, index] as [number, number]));
    extracted.convTokens = 60_000;

    const { batchChunkCounts } = fakeLlm();
    const synthesized = await summarizeConversation(extracted);

    expect(tiered.services.metrics.snapshot().map(metric => metric.phase))
      .toEqual(["batch", "assemble"]);
    expect(tiered.services.budget.callCount()).toBe(2);
    expect(synthesized.generationFallbacks).toEqual([]);
    expect(synthesized.chunkCount).toBe(12);
    // Same chunk order and IDs, every section from the LLM, none from fallback.
    expect(synthesized.summaries.map(summary => summary.startIndex)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(synthesized.summaries.every(summary => summary.summary.includes(LLM_SUMMARY_MARKER))).toBe(true);
    expect(synthesized.finalSummary).toContain("ASSEMBLY_SENTINEL");
    expect(batchChunkCounts).toEqual([12]);
  });

  it("keeps the original plan when it already fits the remaining calls", async () => {
    const messages = Array.from({ length: 12 }, (_, index) => sizedMsg(index));
    const tiered = makeTieredRc(messages, openAiModel);
    tiered.mode = "balanced";
    tiered.requestedMode = "balanced";
    tiered.services.budget = new BudgetGuard(10);
    Object.assign(tiered.profileCfg, {
      singlePassMaxTokens: 1, batchMaxTokens: 400, maxChunkTokens: 600, minChunkTokens: 1,
    });
    const extracted = extractWithCache(tiered);
    extracted.extraction.topics = topicsFor(messages.map((_, index) => [index, index] as [number, number]));
    extracted.convTokens = 60_000;

    const { batchChunkCounts } = fakeLlm();
    const synthesized = await summarizeConversation(extracted);

    // No budget pressure: one request per batch, the original plan untouched.
    expect(batchChunkCounts).toEqual([3, 3, 3, 3]);
    expect(synthesized.generationFallbacks).toEqual([]);
    expect(synthesized.summaries.every(summary => summary.summary.includes(LLM_SUMMARY_MARKER))).toBe(true);
  });

  it("returns an unchanged plan when no merge is feasible (tiny context, output squeeze, no allowance)", () => {
    const services = createServices();
    const batches = [0, 1, 2].map(index => [unitChunk(index)]);

    // Already fits: identical array, untouched.
    expect(repackBatchesForCallBudget(batches, unitExtraction, openAiModel, "balanced", 8_192, services, 3)).toBe(batches);
    // No batch-call allowance at all: unchanged (deterministic fallback path).
    expect(repackBatchesForCallBudget(batches, unitExtraction, openAiModel, "balanced", 8_192, services, 0)).toBe(batches);
    // Context too small for a merged request: unchanged.
    const tinyWindow = { ...openAiModel, contextWindow: 5_000 } as Model<Api>;
    expect(repackBatchesForCallBudget(batches, unitExtraction, tinyWindow, "balanced", 8_192, services, 2).length).toBe(3);
    // Per-chunk output squeeze: 20 chunks need 20*250 visible tokens, above
    // the balanced mode's 4096 batchOutput max, so no merge is admissible.
    const squeezed = Array.from({ length: 2 }, (_, group) =>
      Array.from({ length: 10 }, (_, i) => unitChunk(group * 10 + i)));
    expect(repackBatchesForCallBudget(squeezed, unitExtraction, openAiModel, "balanced", 8_192, services, 1).length).toBe(2);
    // Real limits only: with an adequate window the same batches merge down to the allowance.
    expect(repackBatchesForCallBudget(batches, unitExtraction, openAiModel, "balanced", 8_192, services, 1).length).toBe(1);
  });

  it("re-partitions globally instead of stopping at a locally-stuck pair merge", () => {
    // [9,6,6,9] with fast output caps (15 chunks max per request): the middle
    // 6+6 pair is the smallest adjacent merge, but taking it strands [9,12,9]
    // with no admissible follow-up. The minimum-count packing crosses the old
    // batch boundaries and finds [15,15].
    const services = createServices();
    const batches = [
      Array.from({ length: 9 }, (_, i) => unitChunk(i)),
      Array.from({ length: 6 }, (_, i) => unitChunk(9 + i)),
      Array.from({ length: 6 }, (_, i) => unitChunk(15 + i)),
      Array.from({ length: 9 }, (_, i) => unitChunk(21 + i)),
    ];
    const plan = repackBatchesForCallBudget(batches, unitExtraction, openAiModel, "fast", 8_192, services, 2);
    expect(plan.map(group => group.length)).toEqual([15, 15]);
    expect(plan.flat().map(ch => ch.startIndex)).toEqual(batches.flat().map(ch => ch.startIndex));
    // [8,8,8] needs a middle batch's chunks split across requests: 16 chunks
    // would squeeze the per-chunk allowance, so the packing stops at 15.
    const triple = [
      Array.from({ length: 8 }, (_, i) => unitChunk(i)),
      Array.from({ length: 8 }, (_, i) => unitChunk(8 + i)),
      Array.from({ length: 8 }, (_, i) => unitChunk(16 + i)),
    ];
    const repartitioned = repackBatchesForCallBudget(triple, unitExtraction, openAiModel, "fast", 8_192, services, 2);
    expect(repartitioned.length).toBe(2);
    expect(repartitioned.every(group => group.length <= 15)).toBe(true);
    expect(repartitioned.flat().map(ch => ch.startIndex)).toEqual(triple.flat().map(ch => ch.startIndex));
  });

  it("refuses a merge whose clamped wire output cannot cover the per-chunk allowance", () => {
    // maxTokens 128: the pre-clamp visible allowance for two fast chunks is
    // 800 >= 2*160, but the wire cap after the model clamp is 128 < 320, so a
    // merged request would truncate and burn retries. No merge is admissible.
    const services = createServices();
    const batches = [[unitChunk(0)], [unitChunk(1)]];
    const tinyOutput = { ...openAiModel, maxTokens: 128 } as Model<Api>;
    const plan = repackBatchesForCallBudget(batches, unitExtraction, tinyOutput, "fast", 8_192, services, 1);
    expect(plan.length).toBe(2); // wire 128 cannot cover 2*160 required visible tokens
  });

  it("re-packs on every API family with the provider's own caps", () => {
    const services = createServices();
    const families: Array<Model<Api>> = [
      { provider: "minimax", id: "MiniMax-M3", api: "anthropic-messages", contextWindow: 200_000 } as Model<Api>,
      { provider: "openai", id: "gpt-5", api: "openai-responses", contextWindow: 200_000 } as Model<Api>,
      { provider: "deepseek", id: "deepseek-chat", api: "openai-completions", contextWindow: 200_000 } as Model<Api>,
      { provider: "mystery-host", id: "mystery-1", api: "mystery-v1" as unknown as Api, contextWindow: 200_000 } as Model<Api>,
    ];
    for (const model of families) {
      const batches = [0, 1, 2].map(index => [unitChunk(index)]);
      const plan = repackBatchesForCallBudget(batches, unitExtraction, model, "balanced", 8_192, services, 2);
      // Text-only summary requests: no protocol branches, so every family
      // that admits the request packs to the minimum request count.
      expect(plan.length).toBe(1);
      expect(plan.flat().map(ch => ch.startIndex)).toEqual([0, 1, 2]);
      const blocked = repackBatchesForCallBudget(
        batches, unitExtraction, { ...model, contextWindow: 5_000 } as Model<Api>, "balanced", 8_192, services, 2,
      );
      expect(blocked.length).toBe(3);
    }
  });

  it("keeps the deterministic fallback when merging cannot reach the allowance (no oversized dispatch)", async () => {
    // 3 chunks of ~10k estimated request tokens with a 17k window: each
    // single-chunk request fits, any merged request exceeds the model's
    // context. A budget of 3 allows 2 batch calls + assembly: the third
    // batch keeps the safe budget fallback from task I.
    const messages = Array.from({ length: 236 }, (_, index) => sizedMsg(index));
    const narrowModel = { ...openAiModel, contextWindow: 17_000 } as Model<Api>;
    const tiered = makeTieredRc(messages, narrowModel);
    tiered.mode = "balanced";
    tiered.requestedMode = "balanced";
    tiered.services.budget = new BudgetGuard(3);
    Object.assign(tiered.profileCfg, {
      singlePassMaxTokens: 1, batchMaxTokens: 10_500, maxChunkTokens: 10_500, minChunkTokens: 200,
    });
    const extracted = extractWithCache(tiered);
    extracted.extraction.topics = topicsFor([[0, 78], [79, 157], [158, 235]]);
    extracted.convTokens = 60_000;

    const { batchChunkCounts } = fakeLlm();
    const synthesized = await summarizeConversation(extracted);

    expect(synthesized.chunkCount).toBe(3);
    expect(batchChunkCounts).toEqual([1, 1]); // no request ever carried a merge
    expect(tiered.services.metrics.snapshot().map(metric => metric.phase))
      .toEqual(["batch", "batch", "assemble"]);
    expect(synthesized.generationFallbacks).toEqual(["1 synthesis batch budget fallback(s)"]);
    expect(synthesized.summaries.slice(0, 2).every(summary => summary.summary.includes(LLM_SUMMARY_MARKER))).toBe(true);
    expect(synthesized.summaries[2].summary.includes(LLM_SUMMARY_MARKER)).toBe(false);
    // No structured evidence lost: the fallback chunk still carries its range.
    expect(synthesized.summaries[2].startIndex).toBe(158);
    expect(synthesized.finalSummary).toContain("ASSEMBLY_SENTINEL");
  });
});

describe("exploration cannot spend a feasible full-coverage synthesis allowance", () => {
  it("skips the exploration probe when synthesis needs the remaining calls (red: probe spends one on main)", async () => {
    // Thorough mode explores, but the 22k window cannot merge two ~15k-token
    // chunks: full coverage needs 2 batch calls + assembly = 3 = the whole
    // budget, so the optional probe must not run.
    const messages = Array.from({ length: 236 }, (_, index) => sizedMsg(index));
    const narrowModel = { ...openAiModel, contextWindow: 22_000 } as Model<Api>;
    const tiered = makeTieredRc(messages, narrowModel);
    tiered.mode = "thorough";
    tiered.requestedMode = "thorough";
    tiered.services.budget = new BudgetGuard(3);
    Object.assign(tiered.profileCfg, {
      singlePassMaxTokens: 1, batchMaxTokens: 16_000, maxChunkTokens: 16_000, minChunkTokens: 200,
    });
    const extracted = extractWithCache(tiered);
    extracted.extraction.topics = topicsFor([[0, 117], [118, 235]]);
    extracted.convTokens = 60_000;
    // Two unresolved errors make shouldExplore() true for this small session.
    extracted.extraction.errors = [0, 1].map(index => ({
      index, tool: "bash", message: "release blocker " + index, retryAttempted: false, resolved: false,
    }));

    const { batchChunkCounts } = fakeLlm();
    const notices: string[] = [];
    tiered.notify = (message: string) => { notices.push(message); };
    const synthesized = await summarizeConversation(extracted);

    expect(tiered.services.metrics.snapshot().map(metric => metric.phase))
      .toEqual(["batch", "batch", "assemble"]); // no explore phase
    expect(tiered.services.budget.callCount()).toBe(3);
    expect(synthesized.generationFallbacks).toEqual([]);
    expect(batchChunkCounts).toEqual([1, 1]);
    expect(synthesized.summaries.every(summary => summary.summary.includes(LLM_SUMMARY_MARKER))).toBe(true);
    expect(notices.some(message => message.includes("Explore skipped"))).toBe(true);
    expect(notices.some(message => message.includes("re-packed"))).toBe(false);
  });

  it("still explores and re-packs when the synthesis floor leaves room for the probe (red: fallback on main)", async () => {
    // Same shape, but a wide window admits merging the two chunks into one
    // request: the full-coverage floor is 1 batch + assembly = 2, so with a
    // budget of 3 the probe may spend the remaining call, and the dispatch
    // re-pack then covers both chunks with the single remaining batch call.
    const messages = Array.from({ length: 236 }, (_, index) => sizedMsg(index));
    const tiered = makeTieredRc(messages, openAiModel);
    tiered.mode = "thorough";
    tiered.requestedMode = "thorough";
    tiered.services.budget = new BudgetGuard(3);
    Object.assign(tiered.profileCfg, {
      singlePassMaxTokens: 1, batchMaxTokens: 16_000, maxChunkTokens: 16_000, minChunkTokens: 200,
    });
    const extracted = extractWithCache(tiered);
    extracted.extraction.topics = topicsFor([[0, 117], [118, 235]]);
    extracted.convTokens = 60_000;
    // Two unresolved errors make shouldExplore() true for this small session.
    extracted.extraction.errors = [0, 1].map(index => ({
      index, tool: "bash", message: "release blocker " + index, retryAttempted: false, resolved: false,
    }));

    const { batchChunkCounts } = fakeLlm();
    const synthesized = await summarizeConversation(extracted);

    const phases = tiered.services.metrics.snapshot().map(metric => metric.phase);
    expect(phases[0]).toBe("explore"); // exploration was not unconditionally disabled
    expect(phases.filter(phase => phase === "batch").length).toBe(1);
    expect(phases.at(-1)).toBe("assemble");
    expect(tiered.services.budget.callCount()).toBe(3);
    expect(synthesized.generationFallbacks).toEqual([]);
    expect(batchChunkCounts).toEqual([2]); // the two chunks merged into one request
    expect(synthesized.summaries.every(summary => summary.summary.includes(LLM_SUMMARY_MARKER))).toBe(true);
  });

  it("honours a caller-supplied reserve on every exploration path", async () => {
    // With 4 remaining calls and a reserve of 4, nothing may be dispatched:
    // not the probe, and not the direct/retry fallbacks behind it.
    const services = createServices({
      llm: {
        complete: async () => {
          throw new Error("no exploration call may be dispatched");
        },
      },
    });
    services.budget = new BudgetGuard(4);
    const messages = [sizedMsg(0)];
    const { exploreConversation: explore } = await import("../src/phases/explore.ts");
    const result = await explore(
      messages, unitExtraction, openAiModel, { apiKey: "k" },
      undefined, undefined, undefined, undefined, undefined, services, 4,
    );
    expect(services.metrics.snapshot()).toEqual([]);
    expect(services.budget.callCount()).toBe(0);
    expect(result.rounds).toBe(0);
    expect(SYNTHESIS_CALL_RESERVE).toBe(2); // default floor stays one batch + assembly
  });
});
