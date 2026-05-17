/**
 * Core EESV pipeline runner.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type {
  CompressionProfile, PendingCompaction, LlmMessage, StructuredExtraction,
  ExplorationReport, SmartCompactDetails, ChunkSummary,
} from "./types.ts";
import { PROFILES } from "./constants.ts";
import { estimateTokens, getProviderCaps } from "./utils/tokens.ts";
import {
  resetCompactSessionId, resetMetrics, appendMetricsLog, getMetricsSummary,
  saveCachedExtraction, loadCachedExtraction, mergeExtractions, cacheOpts,
} from "./utils/cache.ts";
import { extractStructured, extractText, extractOpenLoops } from "./utils/extraction.ts";
import { buildCompactionState, injectOpenLoopsSection, extractNextActions, extractCriticalContext, saveCompactionState, loadCompactionState, computeDelta, injectDeltaSection } from "./utils/state.ts";
import { pruneRedundant } from "./utils/pruning.ts";
import { deriveProjectId, loadProjectFingerprint, saveProjectFingerprint, buildProjectContext } from "./utils/fingerprint.ts";
import { detectDamage, logDamageReport } from "./utils/damage.ts";
import {
  loadConfig, backupConversation, getPreviousCompactionContext,
  smartKeepBoundary, createBatches,
} from "./utils/helpers.ts";
import { exploreConversation, shouldExplore } from "./phases/explore.ts";
import { chunkLlmMessages, singlePassCompact, summarizeBatch, assembleLLM, assembleFallback } from "./phases/synthesize.ts";
import { verifySummary, patchSummary, patchDeterministic } from "./phases/verify.ts";
import { showProgressOverlay, showResultScreen } from "./ui/overlays.ts";

export async function runSmartCompact(
  ctx: ExtensionCommandContext,
  summaryModel: Model<Api>, segModel: Model<Api>,
  profile: CompressionProfile,
  verbose: boolean, dryRun: boolean,
  pendingRef: { value: PendingCompaction | null; createdAt: number },
  isRunning: { value: boolean },
  autoTriggered: boolean,
  userNote?: string,
  skipCompact?: boolean,
): Promise<void> {
  if (isRunning.value) return;
  isRunning.value = true;
  const pipelineStart = Date.now();
  resetCompactSessionId();
  resetMetrics();

  if (!summaryModel || !segModel) { isRunning.value = false; if (!autoTriggered) ctx.ui.notify("Model resolve failed", "error"); return; }
  try {
    const config = loadConfig();
    const pc = { ...PROFILES[profile], ...(config.profiles?.[profile] ?? {}) };
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
    const segAuth = segModel !== summaryModel ? await ctx.modelRegistry.getApiKeyAndHeaders(segModel) : auth;
    if ((!auth.ok || !auth.apiKey) || (!segAuth.ok || !segAuth.apiKey)) { isRunning.value = false; if (!autoTriggered) ctx.ui.notify("Auth failed", "error"); return; }

    const usage = ctx.getContextUsage();
    const totalTokens = usage?.tokens ?? 0;
    if (!totalTokens || totalTokens < 5000) { isRunning.value = false; if (!autoTriggered) ctx.ui.notify("Context OK or unknown", "info"); return; }

    const notify = (msg: string, type: "info" | "success" | "warning" | "error" = "info") => { ctx.ui.notify(msg, type); };
    const ctrl = new AbortController();
    const signal = ctrl.signal;
    const modelLabel = summaryModel.provider + "/" + summaryModel.id;
    notify("Smart compact: " + modelLabel + ", " + profile + ", tokens=" + totalTokens, "info");
    notify("EESV Compact (" + modelLabel + ", " + profile + ") — " + (totalTokens ?? 0).toLocaleString() + "t", "info");

    const branch = ctx.sessionManager.getBranch();
    interface SessionMessageEntry { type: "message"; id: string; message: unknown }
    const msgs = branch.filter((e: SessionMessageEntry): e is SessionMessageEntry => e.type === "message" && e.message != null);
    if (msgs.length < 3) { isRunning.value = false; return; }

    let accTokens = 0, keepFrom = msgs.length;
    for (let i = msgs.length - 1; i >= 0; i--) {
      // Use extractText for content instead of JSON.stringify to avoid metadata overhead
      const msg = msgs[i].message as Record<string, unknown>;
      const contentRaw = msg?.content;
      const contentText = typeof contentRaw === "string" ? contentRaw : (contentRaw != null ? JSON.stringify(contentRaw) : "");
      accTokens += estimateTokens(contentText);
      if (accTokens >= pc.keepRecentTokens) { keepFrom = i; break; }
    }
    keepFrom = smartKeepBoundary(msgs, keepFrom);

    const toCompact = msgs.slice(0, keepFrom);
    if (!toCompact.length) { isRunning.value = false; return; }
    const firstKeptId = msgs[keepFrom]?.id ?? msgs[msgs.length - 1]?.id ?? "";

    if (!autoTriggered) {
      showProgressOverlay(ctx, { phase: 1, phaseName: "Extract", detail: "Preparing...", model: modelLabel, profile });
    }

    const llmMessages = convertToLlm(toCompact.map(e => e.message)) as LlmMessage[];

    // ── Pre-compaction redundancy pruning ──
    const pruning = pruneRedundant(llmMessages);
    if (pruning.prunedCount > 0) {
      notify("Pruning: " + pruning.prunedCount + " msgs removed (" + pruning.reasons.map(r => r.count + "x " + r.reason).join(", ") + ")", "info");
    }
    const prunedMessages = pruning.messages;
    const convText = serializeConversation(prunedMessages);
    const convTokens = estimateTokens(convText);

    const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
    const backupPath = backupConversation(convText, sessionId);
    const prevContext = getPreviousCompactionContext(branch);

    // Phase 1
    const cachedExt = loadCachedExtraction(sessionId);
    let extraction: StructuredExtraction;
    if (cachedExt && cachedExt.lastMessageIndex < llmMessages.length - 1) {
      const newMsgs = llmMessages.slice(cachedExt.lastMessageIndex + 1);
      const delta = extractStructured(newMsgs, pc);
      extraction = mergeExtractions(cachedExt.extraction, delta, cachedExt.messageCount);
      notify("Phase 1 Incremental: " + (cachedExt.lastMessageIndex + 1) + " cached + " + newMsgs.length + " new messages", "info");
    } else {
      extraction = extractStructured(llmMessages, pc);
      notify("Phase 1 Full: " + extraction.modifiedFiles.length + " files, " + extraction.errors.length + " errors", "info");
    }
    saveCachedExtraction(sessionId, extraction, llmMessages.length);

    // ── Project fingerprint (cross-session context) ──
    const projectId = deriveProjectId(extraction);
    const fingerprint = loadProjectFingerprint(projectId);
    if (fingerprint) {
      notify("Project: " + fingerprint.language + (fingerprint.framework ? "/" + fingerprint.framework : "") + " (" + fingerprint.sessionCount + " sessions)", "info");
    }
    const projectCtx = buildProjectContext(fingerprint);

    let finalSummary: string;
    let method: string;
    let llmCalls = 0;
    let summaries: ChunkSummary[] = [];
    let explorationReport: ExplorationReport | null = null;
    let explorationRounds = 0;
    let chunkCount = 0;

    if (convTokens < pc.singlePassMaxTokens) {
      if (!autoTriggered) showProgressOverlay(ctx, { phase: 2, phaseName: "Explore", detail: "Single-pass (" + convTokens.toLocaleString() + "t)", model: modelLabel, profile, extraction });
      try {
        const r = await singlePassCompact(convText, extraction, null, prevContext + projectCtx, summaryModel, { apiKey: auth.apiKey, headers: auth.headers }, signal);
        finalSummary = r.summary; method = "single-pass"; llmCalls = r.llmCalls;
      } catch (err) {
        notify("Single-pass failed: " + (err instanceof Error ? err.message : String(err)), "warning");
        finalSummary = assembleFallback([], extraction);
        method = "heuristic"; llmCalls = 0;
      }
    } else {
      // Adaptive exploration gate: skip explore for simple sessions
      const needsExploration = shouldExplore(extraction);
      if (needsExploration) {
        if (!autoTriggered) showProgressOverlay(ctx, { phase: 2, phaseName: "Explore", detail: "Exploring...", model: modelLabel, profile, extraction });
        try {
          const expResult = await exploreConversation(llmMessages, extraction, segModel, { apiKey: segAuth.apiKey, headers: segAuth.headers }, prevContext || undefined, userNote, signal, 8, notify);
          explorationReport = expResult.report;
          explorationRounds = expResult.rounds;
          notify("Phase 2 Explore: " + expResult.rounds + " rounds, " + explorationReport.boundaries.length + " boundaries" + (expResult.toolSupported ? "" : " (no tool support)"), "info");
        } catch (err) {
          notify("Phase 2 Explore: failed - " + (err instanceof Error ? err.message : String(err)), "warning");
        }
      } else {
        notify("Phase 2 Explore: skipped (simple session: " + extraction.topics.length + " topics, " + extraction.errors.filter(e => !e.resolved).length + " unresolved errors)", "info");
      }

      let boundaries: import("./types.ts").TopicBoundary[];
      if (explorationReport?.boundaries.length) {
        // Merge LLM boundaries with heuristic boundaries — don't discard heuristics
        const llmBounds = explorationReport.boundaries.filter(b => b.confidence >= 0.4);
        const heuristicBounds = extraction.topics.map(t => ({
          afterIndex: t.endIndex,
          topic: t.primaryFile ? "Working on " + t.primaryFile.split("/").pop() : "Segment",
          priority: t.errorDensity > 2 ? "high" as const : "normal" as const,
          confidence: 0.6,
        }));
        if (llmBounds.length > 0) {
          // LLM boundaries are primary; fill gaps with heuristic boundaries
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

      const chunks = chunkLlmMessages(llmMessages, boundaries, pc);
      chunkCount = chunks.length;
      notify("Chunked: " + chunkCount + " chunks", "info");

      const batches = createBatches(chunks, pc.batchMaxTokens);
      const totalBatches = batches.length;
      if (!autoTriggered) showProgressOverlay(ctx, { phase: 3, phaseName: "Synthesize", detail: "0/" + totalBatches + " batches", model: modelLabel, profile, extraction, totalBatches });

      const caps = getProviderCaps(summaryModel.provider);
      const concurrency = caps.concurrencyLimit;

      if (totalBatches <= 1) {
        try {
          summaries.push(...await summarizeBatch(batches[0], extraction, summaryModel, { apiKey: auth.apiKey, headers: auth.headers }, signal));
        } catch (err) {
          summaries.push(...batches[0].map(ch => ({
            topic: ch.topic, startIndex: ch.startIndex, endIndex: ch.endIndex,
            summary: "[Failed] " + ch.messages.map((m: any) => extractText(m.content)).join("\n").slice(0, 300),
            keyDecisions: [] as string[], filesModified: [] as string[], filesRead: [] as string[], priority: ch.priority as ChunkSummary["priority"],
          })));
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
              results[idx] = await summarizeBatch(batch, extraction, summaryModel, { apiKey: auth.apiKey, headers: auth.headers }, signal);
            } catch (err) {
              errors[idx] = err instanceof Error ? err : new Error(String(err));
              results[idx] = batch.map(ch => ({
                topic: ch.topic, startIndex: ch.startIndex, endIndex: ch.endIndex,
                summary: "[Failed] " + ch.messages.map((m: any) => extractText(m.content)).join("\n").slice(0, 300),
                keyDecisions: [] as string[], filesModified: [] as string[], filesRead: [] as string[], priority: ch.priority as ChunkSummary["priority"],
              }));
            }
            completed++;
            if (!autoTriggered) showProgressOverlay(ctx, { phase: 3, phaseName: "Synthesize", detail: completed + "/" + totalBatches + " batches", model: modelLabel, profile, extraction, totalBatches, currentBatch: completed });
          });
          await Promise.all(wavePromises);
        }
        for (const r of results) if (r) summaries.push(...r);
        for (let i = 0; i < errors.length; i++) if (errors[i]) notify("Batch " + (i + 1) + " failed: " + errors[i]!.message, "warning");
      }

      if (!autoTriggered) showProgressOverlay(ctx, { phase: 3, phaseName: "Synthesize", detail: "Assembling...", model: modelLabel, profile, extraction, totalBatches: batches.length });
      let assemblyCalls = 1;
      try {
        const r = await assembleLLM(summaries, extraction, explorationReport, summaryModel, { apiKey: auth.apiKey, headers: auth.headers }, pc.summaryBudgetTokens, prevContext, signal);
        if (r?.startsWith("##")) finalSummary = r; else throw new Error("bad");
      } catch (err) {
        console.error("[smart-compact] Assembly failed:", err instanceof Error ? err.message : err);
        finalSummary = assembleFallback(summaries, extraction); assemblyCalls = 0;
      }

      method = "eesv";
      llmCalls = explorationRounds + batches.length + assemblyCalls;
    }

    if (!autoTriggered) showProgressOverlay(ctx, { phase: 4, phaseName: "Verify", detail: "Checking...", model: modelLabel, profile, extraction, explorationRounds });
    const verification = verifySummary(finalSummary, extraction);
    if (!verification.ok) {
      if (verification.score < 85) {
        // Deterministic patch first (zero LLM cost)
        notify("Phase 4 Verify: " + verification.gaps.length + " gap(s), score=" + verification.score + ", applying deterministic patch", "warning");
        finalSummary = patchDeterministic(finalSummary, verification.gaps, extraction);
        // Re-verify after patch — only use LLM patch if still bad
        const recheck = verifySummary(finalSummary, extraction);
        if (!recheck.ok && recheck.score < 75) {
          notify("Phase 4 Verify: deterministic patch insufficient (score=" + recheck.score + "), trying LLM patch", "warning");
          try {
            finalSummary = await patchSummary(finalSummary, recheck.gaps, summaryModel, { apiKey: auth.apiKey, headers: auth.headers }, signal);
            llmCalls++;
          } catch (err) { /* accept deterministic patch as-is */
            console.error("[smart-compact] LLM patch failed:", err instanceof Error ? err.message : err);
          }
        }
      } else {
        notify("Phase 4 Verify: " + verification.gaps.length + " gap(s), score=" + verification.score + " ≥ 85 — skipping patch", "info");
      }
    }

    const detModified = extraction.modifiedFiles.map(f => f.path);
    const detRead = extraction.readFiles;
    const estimatedAfter = estimateTokens(finalSummary) + accTokens;
    const tokensSaved = Math.max(0, totalTokens - estimatedAfter);

    const pipelineInfo = method === "eesv"
      ? "EESV: Extract > Explore (" + explorationRounds + "r) > Synthesize (" + (chunkCount || 1) + " chunks) > Verify (" + (verification.ok ? "pass" : verification.gaps.length + " gaps") + ")"
      : method + " (" + (chunkCount || 1) + " chunks, " + llmCalls + " calls)";
    const pipelineMs = Date.now() - pipelineStart;
    const durationStr = pipelineMs < 1000 ? pipelineMs + "ms" : (pipelineMs / 1000).toFixed(1) + "s";
    notify("Done: " + pipelineInfo + " — saved " + (tokensSaved ?? 0).toLocaleString() + "t (" + durationStr + ")", "success");

    // ── Open Loops extraction ──
    const openLoops = extractOpenLoops(llmMessages, extraction);
    if (openLoops.length > 0) {
      notify("Open Loops: " + openLoops.length + " detected (" + openLoops.filter(l => l.priority === "high").length + " high)", "info");
      finalSummary = injectOpenLoopsSection(finalSummary, openLoops);
    }

    // ── Build structured compaction state ──
    const nextActions = extractNextActions(finalSummary);
    const criticalContextItems = extractCriticalContext(finalSummary);
    const compactionState = buildCompactionState(extraction, openLoops, explorationReport, nextActions, criticalContextItems);

    // ── Delta compaction: compare with previous state ──
    const prevState = loadCompactionState(projectId);
    if (prevState) {
      const delta = computeDelta(prevState, compactionState);
      if (delta.newLoops.length || delta.resolvedLoops.length || delta.newDecisions.length || delta.newErrors.length || delta.newModifiedFiles.length) {
        finalSummary = injectDeltaSection(finalSummary, delta);
        notify("Delta: " + delta.newLoops.length + " new loops, " + delta.resolvedLoops.length + " resolved, " + delta.newModifiedFiles.length + " new files", "info");
      }
    }

    const details: SmartCompactDetails = {
      method: method as SmartCompactDetails["method"],
      chunkCount: chunkCount || 1,
      topics: summaries.length ? summaries.map(s => s.topic) : [method],
      readFiles: detRead, modifiedFiles: detModified,
      totalMessages: toCompact.length, totalTokensSummarized: convTokens,
      llmCalls, profile, backupPath, tokensSaved,
      verified: verification.ok, gaps: verification.gaps,
      explorationRounds, explorationBoundaries: explorationReport?.boundaries.length ?? 0,
      model: modelLabel, qualityScore: verification.score,
      tokensBefore: totalTokens,
      compactionState, openLoops,
    };

    if (dryRun) {
      notify("DRY RUN (" + method + ", " + profile + ") — " + toCompact.length + " msgs, " + llmCalls + " calls", "info");
      return;
    }

    pendingRef.value = { summary: finalSummary, firstKeptEntryId: firstKeptId, tokensBefore: totalTokens, details, compactionState };
    pendingRef.createdAt = Date.now();

    // ── Save project fingerprint for cross-session context ──
    saveProjectFingerprint(projectId, extraction);

    // ── Save compaction state for cross-compaction tracking ──
    saveCompactionState(projectId, compactionState);

    appendMetricsLog(sessionId);

    // ── Damage detection: check if previous compaction caused issues ──
    // This reads post-compaction messages from the current branch to detect regression
    try {
      const postCompactMsgs = msgs.slice(keepFrom).map(e => convertToLlm([e.message])).flat().map((m: any) => m as LlmMessage);
      if (postCompactMsgs.length > 2) {
        // Only detect if there are enough post-compaction messages
        const lastCompaction = branch.filter((e: { type: string }) => e.type === "compaction").slice(-1)[0] as { details?: SmartCompactDetails } | undefined;
        if (lastCompaction?.details) {
          const prevDetails = lastCompaction.details as SmartCompactDetails;
          const damage = detectDamage(postCompactMsgs.slice(0, Math.min(15, postCompactMsgs.length)), prevDetails);
          if (damage.damageScore > 0) {
            notify("Previous compaction damage: " + damage.summary, "warning");
          }
          logDamageReport(sessionId, damage, prevDetails);
        }
      }
    } catch (err) { /* damage detection is best effort */
      console.error("[smart-compact] Damage detection error:", err instanceof Error ? err.message : err);
    }
    const ms = getMetricsSummary();
    if (ms.totalCalls > 0) {
      notify("Metrics: " + ms.totalCalls + " calls, " + ms.totalInput + "t in, " + ms.totalOutput + "t out, cache " + Math.round(ms.cacheHitRate * 100) + "%, " + ms.avgLatency + "ms avg", "info");
    }
    if (!autoTriggered) {
      try {
        const timeout = new Promise<void>(resolve => setTimeout(resolve, 5000));
        await Promise.race([showResultScreen(ctx, details, extraction), timeout]);
      } catch (err) {
        console.error("[smart-compact] Result screen error:", err instanceof Error ? err.message : err);
        notify("Result screen skipped", "info");
      }
    }

    if (!skipCompact) {
      ctx.compact({
        customInstructions: "Use pre-computed smart summary from /smart-compact",
        onComplete: () => { if (!autoTriggered) ctx.ui.notify("Applied \u2713", "success"); },
        onError: e => { if (!autoTriggered) ctx.ui.notify("Failed: " + e.message, "error"); },
      });
    }
  } finally {
    isRunning.value = false;
    const pipelineMs = Date.now() - pipelineStart;
    if (autoTriggered) {
      ctx.ui.notify("Compaction completed in " + (pipelineMs < 1000 ? pipelineMs + "ms" : (pipelineMs / 1000).toFixed(1) + "s"), "info");
    }
  }
}

