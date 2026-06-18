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
import { exploreConversation, shouldExplore } from "../explore-wrap.ts";
import { chunkLlmMessages, singlePassCompact, summarizeBatch, assembleLLM, assembleFallback, failedChunkSummary } from "../../phases/synthesize.ts";
import { MAX_EXPLORATION_ROUNDS } from "../../constants.ts";
import { createBatches } from "../../utils/helpers.ts";
import { extractText } from "../../utils/extraction.ts";
import * as log from "../../utils/logger.ts";
import type { ExtractedRc, SynthesizedRc } from "../run-context.ts";
import { advance, markMeasuredPhase } from "../run-context.ts";

export async function summarizeConversation(rc: ExtractedRc): Promise<SynthesizedRc> {
  let synthPhaseStart = Date.now();
  const extraction = rc.extraction;
  const pc = rc.profileCfg;
  const shouldSkipExplore = rc.tier === "light";
  // convText was computed and cached on `rc` in extractWithCache to avoid a
  // second `serializeConversation` over the same pruned array (~50ms on
  // 5k-message sessions).
  const convText = rc.convText;
  const singlePassMaxTokens = Math.round(pc.singlePassMaxTokens * rc.providerCaps.singlePassTokenMultiplier);
  rc.vlog("Tier=" + rc.tier + " | convTokens=" + rc.convTokens + " | singlePassMax=" + singlePassMaxTokens);

  let finalSummary: string;
  let method: "eesv" | "single-pass" | "heuristic";
  let llmCalls = 0;
  let summaries: ChunkSummary[] = [];
  let explorationReport: import("../../types.ts").ExplorationReport | null = null;
  let explorationRounds = 0;
  let chunkCount = 0;

  if (rc.convTokens < singlePassMaxTokens) {
    if (!rc.flags.autoTriggered) {
      showProgressOverlay(rc.ctx, {
        phase: 2, phaseName: "Explore",
        detail: "Single-pass (" + rc.convTokens.toLocaleString() + "t)",
        model: rc.modelLabel, profile: rc.profile, extraction,
      });
    }
    try {
      const r = await singlePassCompact(
        convText, extraction, null, rc.prevContext + rc.projectCtx,
        rc.summaryModel, rc.summaryAuth, pc.summaryBudgetTokens, rc.cancellation.signal, rc.services,
      );
      finalSummary = r.summary; method = "single-pass"; llmCalls = r.llmCalls;
    } catch (err) {
      rc.notify("Single-pass failed: " + (err instanceof Error ? err.message : String(err)), "warning");
      finalSummary = assembleFallback([], extraction);
      method = "heuristic"; llmCalls = 0;
    }
  } else {
    const needsExploration = !shouldSkipExplore && shouldExplore(extraction);
    if (needsExploration) {
      const exploreStart = Date.now();
      if (!rc.flags.autoTriggered) {
        showProgressOverlay(rc.ctx, {
          phase: 2, phaseName: "Explore", detail: "Exploring...",
          model: rc.modelLabel, profile: rc.profile, extraction,
        });
      }
      try {
        const expResult = await exploreConversation(
          rc.llmMessages, extraction, rc.segModel, rc.segAuth,
          rc.prevContext || undefined, rc.userNote, rc.cancellation.signal,
          MAX_EXPLORATION_ROUNDS, rc.notify, rc.services,
        );
        explorationReport = expResult.report;
        explorationRounds = expResult.rounds;
        rc.notify(
          "Phase 2 Explore: " + expResult.rounds + " rounds, " +
            explorationReport.boundaries.length + " boundaries" +
            (expResult.toolSupported ? "" : " (no tool support)"),
          "info",
        );
        rc.vlog("Explore boundaries: " + explorationReport.boundaries
          .map(b => b.afterIndex + "(" + b.confidence.toFixed(2) + ")").join(", "));
      } catch (err) {
        rc.notify("Phase 2 Explore: failed - " + (err instanceof Error ? err.message : String(err)), "warning");
      } finally {
        const exploreEnd = Date.now();
        markMeasuredPhase(rc, "explore", exploreStart, exploreEnd);
        synthPhaseStart = exploreEnd;
      }
    } else {
      rc.notify(
        "Phase 2 Explore: skipped (simple session: " + extraction.topics.length +
          " topics, " + extraction.errors.filter(e => !e.resolved).length + " unresolved errors)",
        "info",
      );
    }

    let boundaries: TopicBoundary[];
    if (explorationReport?.boundaries.length) {
      // Keep both LLM and heuristic boundaries; the union typically captures
      // more accurate splits than either alone. Confidence-filtered LLM
      // boundaries are primary, heuristics fill the gaps.
      const llmBounds = explorationReport.boundaries.filter(b => b.confidence >= 0.4);
      const heuristicBounds = extraction.topics.map(t => ({
        afterIndex: t.endIndex,
        topic: t.primaryFile ? "Working on " + t.primaryFile.split("/").pop() : "Segment",
        priority: t.errorDensity > 2 ? "high" as const : "normal" as const,
        confidence: 0.6,
      }));
      if (llmBounds.length > 0) {
        const merged = [...llmBounds];
        for (const hb of heuristicBounds) {
          const nearby = merged.find(m => Math.abs(m.afterIndex - hb.afterIndex) <= 3);
          if (!nearby) merged.push(hb);
        }
        boundaries = merged.sort((a, b) => a.afterIndex - b.afterIndex);
      } else {
        boundaries = heuristicBounds;
      }
    } else {
      boundaries = extraction.topics.map(t => ({
        afterIndex: t.endIndex,
        topic: t.primaryFile ? "Working on " + t.primaryFile.split("/").pop() : "Segment",
        priority: t.errorDensity > 2 ? "high" as const : "normal" as const,
        confidence: 0.6,
      }));
    }

    const chunks = chunkLlmMessages(rc.llmMessages, boundaries, pc);
    chunkCount = chunks.length;
    rc.notify("Chunked: " + chunkCount + " chunks", "info");
    rc.vlog("Chunk topics: " + chunks.map(c => c.topic + "[" + c.startIndex + "-" + c.endIndex + "]").join(", "));

    const batches = createBatches(chunks, pc.batchMaxTokens);
    const totalBatches = batches.length;
    if (!rc.flags.autoTriggered) {
      showProgressOverlay(rc.ctx, {
        phase: 3, phaseName: "Synthesize", detail: "0/" + totalBatches + " batches",
        model: rc.modelLabel, profile: rc.profile, extraction, totalBatches,
      });
    }

    const concurrency = rc.providerCaps.concurrencyLimit;

    if (totalBatches <= 1) {
      const single = batches[0];
      if (single) {
        try {
          summaries.push(...await summarizeBatch(single, extraction, rc.summaryModel, rc.summaryAuth, rc.cancellation.signal, rc.services));
        } catch (err) {
          summaries.push(...single.map(ch => failedChunkSummary(ch)));
        }
      } else {
        // Defensive: empty chunk list (no messages to summarize). Skip batch
        // summarization; the deterministic assembleFallback below covers it.
        rc.vlog("Synthesize: 0 batches — skipping summarization, using fallback assembly");
      }
    } else {
      const results: ChunkSummary[][] = new Array(totalBatches);
      const errors: (Error | null)[] = new Array(totalBatches).fill(null);
      let completed = 0;
      for (let wave = 0; wave < totalBatches; wave += concurrency) {
        const waveBatches = batches.slice(wave, Math.min(wave + concurrency, totalBatches));
        const wavePromises = waveBatches.map(async (batch, i) => {
          const idx = wave + i;
          try {
            results[idx] = await summarizeBatch(batch, extraction, rc.summaryModel, rc.summaryAuth, rc.cancellation.signal, rc.services);
          } catch (err) {
            errors[idx] = err instanceof Error ? err : new Error(String(err));
            results[idx] = batch.map(ch => failedChunkSummary(ch));
          }
          completed++;
          if (!rc.flags.autoTriggered) {
            showProgressOverlay(rc.ctx, {
              phase: 3, phaseName: "Synthesize",
              detail: completed + "/" + totalBatches + " batches",
              model: rc.modelLabel, profile: rc.profile, extraction,
              totalBatches, currentBatch: completed,
            });
          }
        });
        await Promise.all(wavePromises);
      }
      for (const r of results) if (r) summaries.push(...r);
      for (let i = 0; i < errors.length; i++) if (errors[i]) rc.notify("Batch " + (i + 1) + " failed: " + errors[i]!.message, "warning");
    }

    if (!rc.flags.autoTriggered) {
      showProgressOverlay(rc.ctx, {
        phase: 3, phaseName: "Synthesize", detail: "Assembling...",
        model: rc.modelLabel, profile: rc.profile, extraction, totalBatches: batches.length,
      });
    }
    let assemblyCalls = 1;
    try {
      const r = await assembleLLM(
        summaries, extraction, explorationReport, rc.summaryModel, rc.summaryAuth,
        pc.summaryBudgetTokens, rc.prevContext, rc.cancellation.signal, rc.services,
      );
      if (r?.startsWith("##")) finalSummary = r; else throw new Error("bad");
    } catch (err) {
      log.warn("Assembly failed", err);
      finalSummary = assembleFallback(summaries, extraction); assemblyCalls = 0;
    }
    method = "eesv";
    llmCalls = explorationRounds + batches.length + assemblyCalls;
  }

  const out = rc as ExtractedRc & {
    _synthesized: true;
    finalSummary: string;
    method: "eesv" | "single-pass" | "heuristic";
    methodForMetrics: string;
    llmCalls: number;
    summaries: ChunkSummary[];
    explorationReport: import("../../types.ts").ExplorationReport | null;
    explorationRounds: number;
    chunkCount: number;
  };
  out.finalSummary = finalSummary;
  out.method = method;
  out.methodForMetrics = method;
  out.llmCalls = llmCalls;
  out.summaries = summaries;
  out.explorationReport = explorationReport;
  out.explorationRounds = explorationRounds;
  out.chunkCount = chunkCount;
  markMeasuredPhase(out, "synthesize", synthPhaseStart);
  return advance<ExtractedRc, SynthesizedRc>(out, "_synthesized");
}

