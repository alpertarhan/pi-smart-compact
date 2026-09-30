/**
 * Step 6: synthesize the conversation summary.
 *
 * Two paths converge here:
 *
 *   Single-pass: short conversations fit in one LLM call. The full convText
 *   gets sent with the deterministic extraction context and we get a single
 *   markdown summary back. We always check the result starts with "##" so a
 *   model that refuses or returns junk falls back to the heuristic assembler
 *   without polluting the conversation history.
 *
 *   EESV: long conversations are explored, chunked, summarized in parallel
 *   batches, then assembled. The Explore phase is gated by `shouldExplore` so
 *   trivially small sessions don't pay 3-8 extra LLM calls.
 *
 * Concurrency is provider-derived (`providerCaps.concurrencyLimit`). Wave
 * scheduling matters because some providers (Kimi, Minimax) throttle hard
 * once you exceed 2-3 concurrent calls.
 */

import type { ChunkSummary, TopicBoundary } from "../../types.ts";
import { showProgressOverlay } from "../../ui/overlays.ts";
import { exploreConversation, shouldExplore } from "../../phases/explore.ts";
import {
 chunkLlmMessages,
 buildSinglePassRequest,
 heuristicTopicBoundaries,
 singlePassCompact,
 summarizeBatch,
 assembleLLM,
 assembleFallback,
 failedChunkSummary,
} from "../../phases/synthesize.ts";
import { MAX_EXPLORATION_ROUNDS } from "../../constants.ts";
import {
 batchOutputLimit,
 continuityRisk,
 deterministicExtractionConfidence,
 effectiveBudget,
 resolveCallBudget,
 MODE_POLICIES,
 modeFromLegacyProfile,
 resolveMode,
} from "../mode-policy.ts";
import { createBatches } from "../../utils/helpers.ts";
import { errorDetail, recordIssue } from "../../utils/issues.ts";
import type { ExtractedRc, SynthesizedRc } from "../run-context.ts";
import { advance, markMeasuredPhase } from "../run-context.ts";
import {
 getCachedSynthesis,
 setCachedSynthesis,
 synthesisCacheKey,
} from "../../infra/synthesis-cache.ts";
import { resolveStageAuth } from "../stage-auth.ts";
import { formatGenerationFailureForUi } from "../../ui/error-format.ts";
import { modelRequestCapacityReason, ModelCapacityError } from "../../domain/model-capacity.ts";
import { estimateTokens } from "../../utils/tokens.ts";

export async function summarizeConversation(
 rc: ExtractedRc,
): Promise<SynthesizedRc> {
 let synthPhaseStart = Date.now();
 const extraction = rc.extraction;
 // Backwards-compatible direct callers/tests may construct a pre-mode Rc.
 rc.mode ??= rc.profile ? modeFromLegacyProfile(rc.profile) : "balanced";
 rc.requestedMode ??= rc.mode;
 if (rc.requestedMode === "auto") {
  const refined = resolveMode(
   "auto",
   rc.contextPercent,
   extraction,
   continuityRisk(rc.previousState) + (rc.adapted ? 12 : 0),
  );
  if (refined !== rc.mode) {
   rc.mode = refined;
   const policy = MODE_POLICIES[refined];
   rc.services.budget.setLimits(
    resolveCallBudget(rc.config.maxLlmCalls, refined, rc.maxLlmCalls, rc.flags.autoTriggered && !rc.flags.skipCompact),
    effectiveBudget(rc.config.maxLlmInputTokens, policy.maxInputTokens, rc.maxLlmInputTokens),
    policy.maxOutputTokens,
   );
   // The retention window and output allowance were already planned before
   // extraction. Refine strategy depth only; changing profileCfg here would
   // invalidate the target contract that the yield gate later enforces.
   rc.notify(
    "Auto strategy refined to " +
    refined +
    " within the planned " +
    rc.profile +
    " window",
    "info",
   );
  }
 }
 const pc = rc.profileCfg;
 const policy = MODE_POLICIES[rc.mode];
 const cacheKey = synthesisCacheKey(rc);
 const cached = getCachedSynthesis(cacheKey);
 if (cached) {
  rc.notify("Synthesis cache hit — no LLM calls", "info");
  showProgressOverlay(rc.ctx, {
   phase: 3,
   phaseName: "Synthesize",
   detail: "Reusing the cached continuation summary · no LLM call",
  });
  Object.assign(rc, {
   finalSummary: cached.finalSummary,
   method: cached.method,
   methodForMetrics: cached.method + "-cache",
   generationFallbacks: [],
   llmCalls: 0,
   summaries: cached.summaries,
   explorationReport: cached.explorationReport,
   explorationRounds: cached.explorationRounds,
   chunkCount: cached.chunkCount,
  });
  const hit = advance<ExtractedRc, SynthesizedRc>(rc, "_synthesized");
  markMeasuredPhase(hit, "synthesize", synthPhaseStart);
  return hit;
 }
 const zeroCall =
  rc.config.zeroCallEnabled !== false &&
  rc.mode === "fast" &&
  !rc.focus &&
  !rc.userNote &&
  deterministicExtractionConfidence(extraction, {
   conversationTokens: rc.convTokens,
   toolPercent: rc.toolPercent,
  }) >= 0.85;
 if (zeroCall) {
  showProgressOverlay(rc.ctx, {
   phase: 3,
   phaseName: "Synthesize",
   detail: "Building a deterministic continuation summary · no LLM call",
  });
  const finalSummary = assembleFallback(
   [],
   extraction,
   { focus: rc.focus, note: rc.userNote },
   pc.summaryBudgetTokens,
   rc.previousState,
   rc.factOverrides,
  );
  setCachedSynthesis(cacheKey, {
   finalSummary,
   method: "heuristic",
   summaries: [],
   explorationReport: null,
   explorationRounds: 0,
   chunkCount: 0,
  });
  rc.notify(
   "Zero-call deterministic compaction (high-confidence extraction)",
   "info",
  );
  Object.assign(rc, {
   finalSummary,
   method: "heuristic",
   methodForMetrics: "zero-call",
   generationFallbacks: [],
   llmCalls: 0,
   summaries: [],
   explorationReport: null,
   explorationRounds: 0,
   chunkCount: 0,
  });
  const deterministic = advance<ExtractedRc, SynthesizedRc>(
   rc,
   "_synthesized",
  );
  markMeasuredPhase(deterministic, "synthesize", synthPhaseStart);
  return deterministic;
 }
 const shouldSkipExplore = !policy.explore;
 // convText was computed and cached on `rc` in extractWithCache to avoid a
 // second `serializeConversation` over the same pruned array (~50ms on
 // 5k-message sessions).
 const convText = rc.convText;
 const singlePassMaxTokens = Math.round(
  pc.singlePassMaxTokens *
  rc.providerCaps.singlePassTokenMultiplier *
  policy.singlePassMultiplier,
 );
 const singleRequest = rc.convTokens < singlePassMaxTokens ? buildSinglePassRequest(
  convText, extraction, null, rc.prevContext + rc.projectCtx, rc.summaryModel,
  pc.summaryBudgetTokens, rc.config.focusWeighting ? rc.focus : undefined,
 ) : undefined;
 rc.vlog(
  "Tier=" +
  rc.tier +
  " | convTokens=" +
  rc.convTokens +
  " | singlePassMax=" +
  singlePassMaxTokens,
 );

 let finalSummary: string;
 let method: "eesv" | "single-pass" | "heuristic";
 const summaries: ChunkSummary[] = [];
 let explorationReport: import("../../types.ts").ExplorationReport | null =
  null;
 let explorationRounds = 0;
 let chunkCount = 0;
 let cacheable = true;
 const generationFallbacks: string[] = [];
 let summaryAuth;
 try {
  if (singleRequest) {
   const request = rc.services.scrubber.scrubValue(singleRequest.context).value;
   const input = estimateTokens(JSON.stringify(request), rc.summaryModel.provider, rc.summaryModel.id, rc.services.tokenCalibration);
   const reason = modelRequestCapacityReason(rc.summaryModel, input, singleRequest.maxTokens);
   if (reason) throw new ModelCapacityError("single-pass", reason);
  }
  summaryAuth = await resolveStageAuth(rc, "summary");
 } catch (error) {
  rc.cancellation.signal.throwIfAborted();
  cacheable = false;
  generationFallbacks.push("summary route unavailable");
  recordIssue({ key: "synth.route", message: "Summary route unavailable (" + errorDetail(error) + ").", error: error });
  rc.notify(
   "Summary route unavailable · using deterministic fallback [" + formatGenerationFailureForUi(error) + "]",
   "warning",
  );
 }

 rc.cancellation.signal.throwIfAborted();
 if (!summaryAuth) {
  showProgressOverlay(rc.ctx, {
   phase: 3,
   phaseName: "Synthesize",
   detail: "Summary route unavailable · building a deterministic summary",
  });
  finalSummary = assembleFallback(
   [],
   extraction,
   { focus: rc.focus, note: rc.userNote },
   pc.summaryBudgetTokens,
   rc.previousState,
   rc.factOverrides,
  );
  method = "heuristic";
 } else if (singleRequest) {
  showProgressOverlay(rc.ctx, {
   phase: 3,
   phaseName: "Synthesize",
   detail:
    "Writing one continuation summary from " +
    rc.convTokens.toLocaleString() +
    " tokens",
   model: rc.modelLabel,
   profile: rc.profile,
   extraction,
  });
  try {
   const r = await singlePassCompact(
    singleRequest, rc.summaryModel, summaryAuth, rc.cancellation.signal, rc.services,
   );
   finalSummary = r.summary;
   method = "single-pass";
  } catch (err) {
   rc.cancellation.signal.throwIfAborted();
   cacheable = false;
   generationFallbacks.push("single-pass generation failed");
   recordIssue({ key: "synth.single-pass", message: "Single-pass synthesis used deterministic fallback (" + errorDetail(err) + ").", error: err });
   rc.notify(
    "Single-pass generation stopped · using deterministic fallback [" + formatGenerationFailureForUi(err) + "]",
    "info",
   );
   finalSummary = assembleFallback(
    [],
    extraction,
    { focus: rc.focus, note: rc.userNote },
    pc.summaryBudgetTokens,
    rc.previousState,
    rc.factOverrides,
   );
   method = "heuristic";
  }
 } else {
  const needsExploration = !shouldSkipExplore && shouldExplore(extraction);
  if (needsExploration) {
   const exploreStart = Date.now();
   showProgressOverlay(rc.ctx, {
    phase: 2,
    phaseName: "Explore",
    detail: "Mapping topic shifts and continuity risks",
    model: rc.modelLabel,
    profile: rc.profile,
    extraction,
   });
   try {
    const segAuth = await resolveStageAuth(rc, "explore");
    rc.cancellation.signal.throwIfAborted();
    const expResult = await exploreConversation(
     rc.llmMessages,
     extraction,
     rc.segModel,
     segAuth,
     rc.prevContext || undefined,
     [
      rc.userNote,
      rc.config.focusWeighting && rc.focus
       ? "Focus extra preservation on: " + rc.focus
       : undefined,
     ]
      .filter(Boolean)
      .join("\n") || undefined,
     rc.cancellation.signal,
     MAX_EXPLORATION_ROUNDS,
     rc.notify,
     rc.services,
    );
    explorationReport = expResult.report;
    explorationRounds = expResult.rounds;
    rc.notify(
     "Phase 2 Explore: " +
     expResult.rounds +
     " rounds, " +
     explorationReport.boundaries.length +
     " boundaries" +
     (expResult.toolSupported ? "" : " (no tool support)"),
     "info",
    );
    rc.vlog(
     "Explore boundaries: " +
     explorationReport.boundaries
      .map((b) => b.afterIndex + "(" + b.confidence.toFixed(2) + ")")
      .join(", "),
    );
   } catch (err) {
    rc.cancellation.signal.throwIfAborted();
    cacheable = false;
    generationFallbacks.push("exploration unavailable");
    recordIssue({ key: "synth.explore", message: "Explore used deterministic topic boundaries (" + errorDetail(err) + ").", error: err });
    rc.notify(
     "Explore unavailable · using deterministic topic boundaries",
     "info",
    );
   } finally {
    const exploreEnd = Date.now();
    markMeasuredPhase(rc, "explore", exploreStart, exploreEnd);
    synthPhaseStart = exploreEnd;
   }
  } else {
   rc.notify(
    "Phase 2 Explore: skipped (simple session: " +
    extraction.topics.length +
    " topics, " +
    extraction.errors.filter((e) => !e.resolved).length +
    " unresolved errors)",
    "info",
   );
  }

  let boundaries: TopicBoundary[];
  if (explorationReport?.boundaries.length) {
   // Keep both LLM and heuristic boundaries; the union typically captures
   // more accurate splits than either alone. Confidence-filtered LLM
   // boundaries are primary, heuristics fill the gaps.
   const llmBounds = explorationReport.boundaries.filter(
    (b) => b.confidence >= 0.4,
   );
   const heuristicBounds = heuristicTopicBoundaries(extraction);
   if (llmBounds.length > 0) {
    const merged = [...llmBounds];
    for (const hb of heuristicBounds) {
     const nearby = merged.find(
      (m) => Math.abs(m.afterIndex - hb.afterIndex) <= 3,
     );
     if (!nearby) merged.push(hb);
    }
    boundaries = merged.sort((a, b) => a.afterIndex - b.afterIndex);
   } else {
    boundaries = heuristicBounds;
   }
  } else {
   boundaries = heuristicTopicBoundaries(extraction);
  }

  const chunks = chunkLlmMessages(
   rc.llmMessages,
   boundaries,
   pc,
   rc.estimator,
   rc.config.focusWeighting ? rc.focus : undefined,
  );
  chunkCount = chunks.length;
  rc.notify("Chunked: " + chunkCount + " chunks", "info");
  rc.vlog(
   "Chunk topics: " +
   chunks
    .map((c) => c.topic + "[" + c.startIndex + "-" + c.endIndex + "]")
    .join(", "),
  );

  const batches = createBatches(chunks, pc.batchMaxTokens);
  const totalBatches = batches.length;
  showProgressOverlay(rc.ctx, {
   phase: 3,
   phaseName: "Synthesize",
   detail: "Compressing older history · batch 0/" + totalBatches,
   model: rc.modelLabel,
   profile: rc.profile,
   extraction,
   explorationRounds,
   totalBatches,
  });

  const concurrency = rc.providerCaps.concurrencyLimit;

  // Preflight (#62): an unset summary thinking level defers to the
  // provider default, which on local reasoning servers shares the batch
  // output budget with thinking tokens. Self-healing retry handles it,
  // but the user should know why a batch took two calls.
  if (rc.services.thinkingLevels.summaryThinkingLevel == null) {
   rc.notify(
    "Summary thinking level unset — provider-default reasoning may share the batch output budget (length-truncated batches retry once at minimal reasoning)",
    "info",
   );
  }

  rc.cancellation.signal.throwIfAborted();
  if (totalBatches <= 1) {
   const single = batches[0];
   if (single) {
    if (rc.services.budget.remainingCalls() <= 1) {
     summaries.push(...single.map((ch) => failedChunkSummary(ch)));
     cacheable = false;
     generationFallbacks.push("call budget reserved for final assembly");
     rc.notify(
      "Call budget: chunk synthesis uses deterministic evidence so final assembly remains available",
      "info",
     );
    } else {
     try {
      summaries.push(
       ...(await summarizeBatch(
        single,
        extraction,
        rc.summaryModel,
        summaryAuth,
        rc.cancellation.signal,
        rc.services,
        batchOutputLimit(
         rc.mode,
         single.length,
         rc.providerCaps.maxOutputTokens,
        ),
        rc.sessionId,
       )),
      );
     } catch (err) {
      rc.cancellation.signal.throwIfAborted();
      summaries.push(...single.map((ch) => failedChunkSummary(ch)));
      cacheable = false;
      generationFallbacks.push("1 synthesis batch fallback");
      recordIssue({ key: "synth.batch", message: "Synthesis batch used deterministic fallback (" + errorDetail(err) + ").", error: err });
      rc.notify(
       "Synthesis batch stopped · deterministic evidence fallback preserved coverage [" + formatGenerationFailureForUi(err) + "]",
       "info",
      );
      showProgressOverlay(rc.ctx, {
       phase: 3,
       phaseName: "Synthesize",
       detail:
        "1 batch fallback · preserving coverage from deterministic evidence",
       explorationRounds,
      });
     }
    }
   } else {
    // Defensive: empty chunk list (no messages to summarize). Skip batch
    // summarization; the deterministic assembleFallback below covers it.
    rc.vlog(
     "Synthesize: 0 batches — skipping summarization, using fallback assembly",
    );
   }
  } else {
   const results: ChunkSummary[][] = new Array(totalBatches);
   const errors: (Error | null)[] = new Array(totalBatches).fill(null);
   // Reserve one call for final assembly; map calls without reduce produce
   // more prose but a less coherent continuation summary.
   const batchCallLimit = Math.max(
    0,
    Math.min(totalBatches, rc.services.budget.remainingCalls() - 1),
   );
   for (let index = batchCallLimit; index < totalBatches; index++) {
    results[index] = batches[index].map((chunk) =>
     failedChunkSummary(chunk),
    );
   }
   if (batchCallLimit < totalBatches) {
    rc.notify(
     "Call budget: " +
     (totalBatches - batchCallLimit) +
     " batch(es) use deterministic fallback to reserve assembly",
     "info",
    );
    cacheable = false;
    generationFallbacks.push(
     totalBatches - batchCallLimit + " synthesis batch budget fallback(s)",
    );
   }
   let completed = totalBatches - batchCallLimit;
   let nextBatch = 0;
   let budgetStopped = false;
   const runWorker = async (): Promise<void> => {
    while (true) {
     rc.cancellation.signal.throwIfAborted();
     const idx = nextBatch++;
     if (idx >= batchCallLimit) return;
     // Retries can consume the allowance calculated before workers start.
     if (budgetStopped || rc.services.budget.reason() || rc.services.budget.remainingCalls() <= 1) {
      budgetStopped = true;
      results[idx] = batches[idx].map((chunk) =>
       failedChunkSummary(chunk),
      );
     } else {
      try {
       const batch = batches[idx];
       results[idx] = await summarizeBatch(
        batch,
        extraction,
        rc.summaryModel,
        summaryAuth,
        rc.cancellation.signal,
        rc.services,
        batchOutputLimit(
         rc.mode,
         batch.length,
         rc.providerCaps.maxOutputTokens,
        ),
        rc.sessionId,
       );
      } catch (err) {
       rc.cancellation.signal.throwIfAborted();
       errors[idx] = err instanceof Error ? err : new Error(String(err));
       results[idx] = batches[idx].map((chunk) =>
        failedChunkSummary(chunk),
       );
      }
     }
     completed++;
     showProgressOverlay(rc.ctx, {
      phase: 3,
      phaseName: "Synthesize",
      detail:
       "Compressing older history · batch " +
       completed +
       "/" +
       totalBatches,
      model: rc.modelLabel,
      profile: rc.profile,
      extraction,
      explorationRounds,
      totalBatches,
      currentBatch: completed,
     });
    }
   };
   const workerCount = Math.max(1, Math.min(concurrency, batchCallLimit));
   await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
   if (budgetStopped) {
    rc.notify(
     "Synthesis budget reached · remaining batches use deterministic fallback",
     "info",
    );
    cacheable = false;
    generationFallbacks.push(
     "synthesis budget exhausted during batch pool",
    );
   }
   for (const r of results) if (r) summaries.push(...r);
   const failedBatches = errors.filter(Boolean);
   for (const error of failedBatches)
    recordIssue({ key: "synth.batch", message: "Synthesis batch used deterministic fallback (" + errorDetail(error) + ").", error: error });
   if (failedBatches.length) {
    cacheable = false;
    generationFallbacks.push(
     failedBatches.length + " synthesis batch fallback(s)",
    );
    rc.notify(
     failedBatches.length +
     " synthesis batch(es) stopped · deterministic evidence fallback preserved coverage [" + formatGenerationFailureForUi(failedBatches[0]) + "]",
     "info",
    );
    showProgressOverlay(rc.ctx, {
     phase: 3,
     phaseName: "Synthesize",
     detail:
      failedBatches.length +
      " batch fallback(s) · preserving coverage from deterministic evidence",
     explorationRounds,
    });
   }
  }

  rc.cancellation.signal.throwIfAborted();
  showProgressOverlay(rc.ctx, {
   phase: 3,
   phaseName: "Synthesize",
   detail: "Merging summaries with project continuity",
   model: rc.modelLabel,
   profile: rc.profile,
   extraction,
   explorationRounds,
   totalBatches: batches.length,
  });
  method = "eesv";
  try {
   const r = await assembleLLM(
    summaries,
    extraction,
    explorationReport,
    rc.summaryModel,
    summaryAuth,
    pc.summaryBudgetTokens,
    rc.prevContext,
    rc.cancellation.signal,
    rc.services,
    rc.config.focusWeighting ? rc.focus : undefined,
    rc.previousState,
   );
   if (r?.startsWith("##")) finalSummary = r;
   else throw new Error("Invalid summary response");
  } catch (err) {
   rc.cancellation.signal.throwIfAborted();
   cacheable = false;
   generationFallbacks.push("assembly generation failed");
   recordIssue({ key: "synth.assembly", message: "Assembly used deterministic fallback (" + errorDetail(err) + ").", error: err });
   rc.notify("Assembly stopped · using deterministic fallback [" + formatGenerationFailureForUi(err) + "]", "info");
   method = "heuristic";
   finalSummary = assembleFallback(
    summaries,
    extraction,
    { focus: rc.focus, note: rc.userNote },
    pc.summaryBudgetTokens,
    rc.previousState,
    rc.factOverrides,
   );
  }
 }

 rc.cancellation.signal.throwIfAborted();
 Object.assign(rc, {
  finalSummary,
  method,
  methodForMetrics: method,
  // The run-scoped metrics sink is the single source of truth for network
  // calls, including probes, direct/retry fallbacks, failed batches and patch
  // calls that manual round arithmetic cannot represent accurately.
  generationFallbacks,
  llmCalls: rc.services.metrics.summary().totalCalls,
  summaries,
  explorationReport,
  explorationRounds,
  chunkCount,
 });
 const out = advance<ExtractedRc, SynthesizedRc>(rc, "_synthesized");
 if (cacheable) {
  setCachedSynthesis(cacheKey, {
   finalSummary,
   method,
   summaries,
   explorationReport,
   explorationRounds,
   chunkCount,
  });
 }
 markMeasuredPhase(out, "synthesize", synthPhaseStart);
 return out;
}
