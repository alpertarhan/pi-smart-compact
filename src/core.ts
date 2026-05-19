/**
 * Core EESV pipeline runner.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type {
  CompressionProfile, PendingCompaction, LlmMessage, StructuredExtraction,
  ExplorationReport, SmartCompactDetails, ChunkSummary, SessionMessageEntry, PipelinePhaseTiming,
} from "./types.ts";
import { PROFILES, MIN_TOKEN_THRESHOLD, MAX_EXPLORATION_ROUNDS } from "./constants.ts";
import { estimateTokens, getProviderCaps } from "./utils/tokens.ts";
import {
  resetCompactSessionId, resetMetrics, appendMetricsLog, getMetricsSummary,
  saveCachedExtraction, loadCachedExtraction, mergeExtractions,
} from "./utils/cache.ts";
import { extractStructured, extractText, extractOpenLoops } from "./utils/extraction.ts";
import { resolveCompactionMessages, hasTruncatedMessages } from "./utils/session-log.ts";
import { buildCompactionState, injectOpenLoopsSection, extractNextActions, extractCriticalContext, saveCompactionState, loadCompactionState, computeDelta, injectDeltaSection } from "./utils/state.ts";
import { pruneRedundant } from "./utils/pruning.ts";
import { deriveProjectId, findGitRoot, loadProjectFingerprint, saveProjectFingerprint, buildProjectContext } from "./utils/fingerprint.ts";
import { detectDamage, logDamageReport } from "./utils/damage.ts";
import {
  loadConfig, backupConversation, getPreviousCompactionContext,
  smartKeepBoundary, guardToolCallBoundary, createBatches, computeToolCharPercentage, selectCompactionTier,
} from "./utils/helpers.ts";
import { exploreConversation, shouldExplore } from "./phases/explore.ts";
import { chunkLlmMessages, singlePassCompact, summarizeBatch, assembleLLM, assembleFallback } from "./phases/synthesize.ts";
import { verifySummary, patchSummary, patchDeterministic } from "./phases/verify.ts";
import { showProgressOverlay, showResultScreen } from "./ui/overlays.ts";
import * as log from "./utils/logger.ts";

/** Options for runSmartCompact — avoids 10-parameter positional calls */
export interface SmartCompactOptions {
  ctx: ExtensionCommandContext;
  summaryModel: Model<Api>;
  segModel: Model<Api>;
  profile: CompressionProfile;
  verbose?: boolean;
  dryRun?: boolean;
  pendingRef: { value: PendingCompaction | null; createdAt: number };
  isRunning: { value: boolean };
  autoTriggered?: boolean;
  userNote?: string;
  skipCompact?: boolean;
  /** Optional hard budget for native auto-trigger only. Manual/tool runs do not time out by default. */
  timeoutMs?: number;
}

export async function runSmartCompact(opts: SmartCompactOptions): Promise<void> {
  const { ctx, summaryModel, segModel, profile, verbose = false, dryRun = false, pendingRef, isRunning, autoTriggered = false, userNote, skipCompact, timeoutMs = 0 } = opts;
  if (isRunning.value) return;
  isRunning.value = true;
  const pipelineStart = Date.now();
  const phaseTimings: PipelinePhaseTiming[] = [];
  let phaseStart = pipelineStart;
  const markPhase = (phase: PipelinePhaseTiming["phase"]) => {
    const now = Date.now();
    phaseTimings.push({ phase, durationMs: now - phaseStart });
    phaseStart = now;
  };
  resetCompactSessionId();
  resetMetrics();

  let sessionId = "unknown";
  let totalTokens = 0;
  let contextPercent = 0;
  let toolPercent = 0;
  let tier: string | undefined;
  let methodForMetrics: string | undefined;
  const modelLabel = summaryModel ? summaryModel.provider + "/" + summaryModel.id : "unknown";

  if (!summaryModel || !segModel) { isRunning.value = false; if (!autoTriggered) ctx.ui.notify("Model resolve failed", "error"); return; }

  // Auto-trigger timeout guard — declared outside try so finally can access them
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    const config = loadConfig();
    const pc = { ...PROFILES[profile], ...(config.profiles?.[profile] ?? {}) };
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
    const segAuth = segModel !== summaryModel ? await ctx.modelRegistry.getApiKeyAndHeaders(segModel) : auth;
    if ((!auth.ok || !auth.apiKey) || (!segAuth.ok || !segAuth.apiKey)) { isRunning.value = false; if (!autoTriggered) ctx.ui.notify("Auth failed", "error"); return; }
    const apiKey = auth.apiKey!;
    const apiHeaders = auth.headers;

    const usage = ctx.getContextUsage();
    totalTokens = usage?.tokens ?? 0;

    const notify = (msg: string, type: "info" | "success" | "warning" | "error" = "info") => { ctx.ui.notify(msg, type === "success" ? "info" : type); };
    const vlog = (msg: string) => { if (verbose) log.info(msg); };
    const ctrl = new AbortController();
    const signal = ctrl.signal;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
        notify("Smart compact auto-trigger exceeded " + timeoutMs + "ms; Pi will use native compact for this run", "warning");
      }, timeoutMs);
    }
    notify("Smart compact: " + modelLabel + ", " + profile + ", tokens=" + totalTokens, "info");
    notify("EESV Compact (" + modelLabel + ", " + profile + ") — " + (totalTokens ?? 0).toLocaleString() + "t", "info");

    const branch = ctx.sessionManager.getBranch();
    // Inline filter: branch entries include ThinkingLevelChangeEntry etc., we only want message entries
    const msgs = branch.filter((e: { type: string; id?: string; message?: unknown }) => e.type === "message" && e.message != null) as SessionMessageEntry[];
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
    keepFrom = smartKeepBoundary(msgs, keepFrom, branch);
    keepFrom = guardToolCallBoundary(msgs, keepFrom);

    const toCompact = msgs.slice(0, keepFrom);
    if (!toCompact.length) { isRunning.value = false; return; }
    const firstKeptId = (msgs[keepFrom]?.id ?? msgs[msgs.length - 1]?.id) as string;
    markPhase("prepare");

    if (!autoTriggered) {
      showProgressOverlay(ctx, { phase: 1, phaseName: "Extract", detail: "Preparing...", model: modelLabel, profile });
    }

    let llmMessages = convertToLlm(toCompact.map(e => e.message as import("@earendil-works/pi-ai").Message)) as LlmMessage[];

    // ── Session log fallback: bypass pi-toolkit truncation via entry-id map ──
    if (hasTruncatedMessages(llmMessages)) {
      const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
      const fromLog = resolveCompactionMessages(sessionId, toCompact);
      if (fromLog) {
        llmMessages = fromLog;
        notify("Using untruncated session log (" + llmMessages.length + " msgs)", "info");
      }
    }
    markPhase("recover");

    // ── Tiered compaction: adapt pipeline depth to context pressure ──
    contextPercent = ctx.model && totalTokens ? (totalTokens / ctx.model.contextWindow) * 100 : 0;
    toolPercent = computeToolCharPercentage(branch);
    tier = selectCompactionTier(contextPercent, toolPercent, totalTokens, MIN_TOKEN_THRESHOLD);

    if (tier === "none") {
      isRunning.value = false;
      if (!autoTriggered) ctx.ui.notify("Context OK (" + Math.round(contextPercent) + "%). pi-toolkit manages context well.", "info");
      return;
    }

    const shouldSkipExplore = tier === "light";

    // ── Pre-compaction redundancy pruning ──
    const pruning = pruneRedundant(llmMessages);
    if (pruning.prunedCount > 0) {
      notify("Pruning: " + pruning.prunedCount + " msgs removed (" + pruning.reasons.map(r => r.count + "x " + r.reason).join(", ") + ")", "info");
    }
    llmMessages = pruning.messages;
    markPhase("prune");
    const convText = serializeConversation(llmMessages as unknown as import("@earendil-works/pi-ai").Message[]);
    const convTokens = estimateTokens(convText);

    sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
    const backupPath = backupConversation(convText, sessionId);
    const prevContext = getPreviousCompactionContext(branch);

    // Phase 1
    const cachedExt = loadCachedExtraction(sessionId);
    let extraction: StructuredExtraction;
    const currentFirstId = toCompact[0]?.id;
    const currentLastId = toCompact[toCompact.length - 1]?.id;
    const cachedLastMsgId = toCompact[cachedExt?.lastMessageIndex ?? -1]?.id;
    const idsMatch = cachedExt?.firstEntryId && cachedExt?.lastEntryId
      && cachedExt.firstEntryId === currentFirstId && cachedExt.lastEntryId === cachedLastMsgId;
    const cacheUsable = idsMatch && cachedExt.messageCount <= llmMessages.length && cachedExt.lastMessageIndex < llmMessages.length - 1;
    if (cacheUsable) {
      const newMsgs = llmMessages.slice(cachedExt.lastMessageIndex + 1);
      const delta = extractStructured(newMsgs, pc);
      extraction = mergeExtractions(cachedExt.extraction, delta, cachedExt.messageCount);
      notify("Phase 1 Incremental: " + (cachedExt.lastMessageIndex + 1) + " cached + " + newMsgs.length + " new messages", "info");
      vlog("Incremental extraction — cached messages: " + cachedExt.messageCount + ", current: " + llmMessages.length);
    } else {
      extraction = extractStructured(llmMessages, pc);
      notify("Phase 1 Full: " + extraction.modifiedFiles.length + " files, " + extraction.errors.length + " errors", "info");
      vlog("Full extraction — " + llmMessages.length + " messages, tier=" + tier);
    }
    saveCachedExtraction(sessionId, extraction, llmMessages.length, currentFirstId, currentLastId);
    markPhase("extract");

    // ── Project fingerprint (cross-session context) ──
    const projectId = deriveProjectId(findGitRoot(ctx.cwd) ?? ctx.cwd, extraction, sessionId);
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

    const providerCaps = getProviderCaps(summaryModel.provider);
    const singlePassMaxTokens = Math.round(pc.singlePassMaxTokens * providerCaps.singlePassTokenMultiplier);
    vlog("Tier=" + tier + " | convTokens=" + convTokens + " | singlePassMax=" + singlePassMaxTokens);
    if (convTokens < singlePassMaxTokens) {
      if (!autoTriggered) showProgressOverlay(ctx, { phase: 2, phaseName: "Explore", detail: "Single-pass (" + convTokens.toLocaleString() + "t)", model: modelLabel, profile, extraction });
      try {
        const r = await singlePassCompact(convText, extraction, null, prevContext + projectCtx, summaryModel, { apiKey, headers: apiHeaders }, pc.summaryBudgetTokens, signal);
        finalSummary = r.summary; method = "single-pass"; llmCalls = r.llmCalls;
      } catch (err) {
        notify("Single-pass failed: " + (err instanceof Error ? err.message : String(err)), "warning");
        finalSummary = assembleFallback([], extraction);
        method = "heuristic"; llmCalls = 0;
      }
    } else {
      // Adaptive exploration gate: skip explore for simple sessions or light tier
      const needsExploration = !shouldSkipExplore && shouldExplore(extraction);
      if (needsExploration) {
        if (!autoTriggered) showProgressOverlay(ctx, { phase: 2, phaseName: "Explore", detail: "Exploring...", model: modelLabel, profile, extraction });
        try {
          const expResult = await exploreConversation(llmMessages, extraction, segModel, { apiKey: segAuth.apiKey!, headers: segAuth.headers }, prevContext || undefined, userNote, signal, MAX_EXPLORATION_ROUNDS, notify);
          explorationReport = expResult.report;
          explorationRounds = expResult.rounds;
          notify("Phase 2 Explore: " + expResult.rounds + " rounds, " + explorationReport.boundaries.length + " boundaries" + (expResult.toolSupported ? "" : " (no tool support)"), "info");
        vlog("Explore boundaries: " + explorationReport.boundaries.map(b => b.afterIndex + "(" + b.confidence.toFixed(2) + ")").join(", "));
        } catch (err) {
          notify("Phase 2 Explore: failed - " + (err instanceof Error ? err.message : String(err)), "warning");
        }
      } else {
        notify("Phase 2 Explore: skipped (simple session: " + extraction.topics.length + " topics, " + extraction.errors.filter(e => !e.resolved).length + " unresolved errors)", "info");
      }
      markPhase("explore");

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
      vlog("Chunk topics: " + chunks.map(c => c.topic + "[" + c.startIndex + "-" + c.endIndex + "]").join(", "));

      const batches = createBatches(chunks, pc.batchMaxTokens);
      const totalBatches = batches.length;
      if (!autoTriggered) showProgressOverlay(ctx, { phase: 3, phaseName: "Synthesize", detail: "0/" + totalBatches + " batches", model: modelLabel, profile, extraction, totalBatches });

      const concurrency = providerCaps.concurrencyLimit;

      if (totalBatches <= 1) {
        try {
          summaries.push(...await summarizeBatch(batches[0], extraction, summaryModel, { apiKey, headers: apiHeaders }, signal));
        } catch (err) {
          summaries.push(...batches[0].map(ch => ({
            topic: ch.topic, startIndex: ch.startIndex, endIndex: ch.endIndex,
            summary: "[Failed] " + ch.messages.map(m => extractText(m.content)).join("\n").slice(0, 300),
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
              results[idx] = await summarizeBatch(batch, extraction, summaryModel, { apiKey, headers: apiHeaders }, signal);
            } catch (err) {
              errors[idx] = err instanceof Error ? err : new Error(String(err));
              results[idx] = batch.map(ch => ({
                topic: ch.topic, startIndex: ch.startIndex, endIndex: ch.endIndex,
                summary: "[Failed] " + ch.messages.map(m => extractText(m.content)).join("\n").slice(0, 300),
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
        const r = await assembleLLM(summaries, extraction, explorationReport, summaryModel, { apiKey, headers: apiHeaders }, pc.summaryBudgetTokens, prevContext, signal);
        if (r?.startsWith("##")) finalSummary = r; else throw new Error("bad");
      } catch (err) {
        log.warn("Assembly failed", err);
        finalSummary = assembleFallback(summaries, extraction); assemblyCalls = 0;
      }

      method = "eesv";
      llmCalls = explorationRounds + batches.length + assemblyCalls;
    }
    methodForMetrics = method;
    if (method === "single-pass" || method === "heuristic") markPhase("explore");
    markPhase("synthesize");

    if (!autoTriggered) showProgressOverlay(ctx, { phase: 4, phaseName: "Verify", detail: "Checking...", model: modelLabel, profile, extraction, explorationRounds });
    const verification = verifySummary(finalSummary, extraction);
    vlog("Verification score=" + verification.score + " ok=" + verification.ok + " gaps=" + verification.gaps.length);
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
            finalSummary = await patchSummary(finalSummary, recheck.gaps, summaryModel, { apiKey, headers: apiHeaders }, signal);
            llmCalls++;
          } catch (err) { /* accept deterministic patch as-is */
            log.warn("LLM patch failed", err);
          }
        }
      } else {
        notify("Phase 4 Verify: " + verification.gaps.length + " gap(s), score=" + verification.score + " ≥ 85 — skipping patch", "info");
      }
    }

    markPhase("verify");

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
    vlog("Pipeline complete — method=" + method + " calls=" + llmCalls + " chunks=" + chunkCount + " tokensSaved=" + tokensSaved);

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

    markPhase("state");

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
      appendMetricsLog(sessionId, {
        profile, tier,
        contextPercent: Math.round(contextPercent),
        toolPercent,
        tokensBefore: totalTokens,
        tokensSaved,
        pruneSavedTokens: pruning.prunedTokenSaving,
        chunkCount: chunkCount || 1,
        verificationScore: verification.score,
        verificationGaps: verification.gaps.length,
        method,
        model: modelLabel,
        provider: summaryModel.provider,
        runType: skipCompact ? "tool" : autoTriggered ? "auto" : "manual",
        status: "dry-run",
        phaseTimings,
        durationMs: Date.now() - pipelineStart,
      });
      notify("DRY RUN (" + method + ", " + profile + ") — " + toCompact.length + " msgs, " + llmCalls + " calls", "info");
      return;
    }

    // Guard: if the auto-trigger hard-timeout fired while the pipeline was still
    // running in the background, abort all side-effects so we don't leave a stale
    // pending summary that could be applied on the next compact.
    if (timedOut) {
      return;
    }

    pendingRef.value = { summary: finalSummary, firstKeptEntryId: firstKeptId, tokensBefore: totalTokens, details, compactionState };
    pendingRef.createdAt = Date.now();

    // ── Save project fingerprint for cross-session context ──
    saveProjectFingerprint(projectId, extraction);

    // ── Save compaction state for cross-compaction tracking ──
    saveCompactionState(projectId, compactionState);

    markPhase("persist");

    // ── Damage detection: check if previous compaction caused issues ──
    // This reads post-compaction messages from the current branch to detect regression
    try {
      const postCompactMsgs = msgs.slice(keepFrom).map(e => convertToLlm([e.message as import("@earendil-works/pi-ai").Message])).flat() as LlmMessage[];
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
      log.warn("Damage detection error", err);
    }
    markPhase("damage");
    appendMetricsLog(sessionId, {
      profile, tier,
      contextPercent: Math.round(contextPercent),
      toolPercent,
      tokensBefore: totalTokens,
      tokensSaved,
      pruneSavedTokens: pruning.prunedTokenSaving,
      chunkCount: chunkCount || 1,
      verificationScore: verification.score,
      verificationGaps: verification.gaps.length,
      method,
      model: modelLabel,
      provider: summaryModel.provider,
      runType: skipCompact ? "tool" : autoTriggered ? "auto" : "manual",
      status: "success",
      phaseTimings,
      durationMs: Date.now() - pipelineStart,
    });
    const ms = getMetricsSummary();
    if (ms.totalCalls > 0) {
      notify("Metrics: " + ms.totalCalls + " calls, " + ms.totalInput + "t in, " + ms.totalOutput + "t out, cache " + Math.round(ms.cacheHitRate * 100) + "%, " + ms.avgLatency + "ms avg", "info");
    }
    if (!autoTriggered) {
      try {
        const timeout = new Promise<void>(resolve => setTimeout(resolve, 5000));
        await Promise.race([showResultScreen(ctx, details, extraction), timeout]);
      } catch (err) {
        log.warn("Result screen error", err);
        notify("Result screen skipped", "info");
      }
    }

    if (!skipCompact && !autoTriggered) {
      ctx.compact({
        customInstructions: "Use pre-computed smart summary from /smart-compact",
        onComplete: () => { ctx.ui.notify("Applied \u2713", "info"); },
        onError: e => { ctx.ui.notify("Failed: " + e.message, "error"); },
      });
    }
  } catch (err) {
    appendMetricsLog(sessionId, {
      profile,
      tier,
      contextPercent: Math.round(contextPercent),
      toolPercent,
      tokensBefore: totalTokens,
      method: methodForMetrics,
      model: modelLabel,
      provider: summaryModel.provider,
      runType: skipCompact ? "tool" : autoTriggered ? "auto" : "manual",
      status: timedOut ? "timeout" : "error",
      fallbackReason: err instanceof Error ? err.message : String(err),
      phaseTimings,
      durationMs: Date.now() - pipelineStart,
    });
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    isRunning.value = false;
    if (timedOut) {
      pendingRef.value = null;
      pendingRef.createdAt = 0;
    }
    const pipelineMs = Date.now() - pipelineStart;
    if (autoTriggered && !timedOut) {
      ctx.ui.notify("Compaction completed in " + (pipelineMs < 1000 ? pipelineMs + "ms" : (pipelineMs / 1000).toFixed(1) + "s"), "info");
    }
  }
}

