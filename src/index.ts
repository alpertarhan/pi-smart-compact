/**
 * Smart Compact Extension for Pi Coding Agent (EESV Architecture)
 *
 * Architecture: Extract -> Explore -> Synthesize -> Verify
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { CompressionProfile, PendingCompaction } from "./types.ts";
import { VERSION, MIN_TOKEN_THRESHOLD, CONFIG_KEY, CONFIG_KEY_ALT } from "./constants.ts";
import { loadConfig, extractUserNote } from "./utils/helpers.ts";
import { getProviderCaps } from "./utils/tokens.ts";
import { buildMetricsReport, readMetricsLog, writeMetricsDashboard } from "./utils/cache.ts";
import { runSmartCompact } from "./core.ts";
import { showCompactUI, showMetricsDashboardUI } from "./ui/overlays.ts";
import * as log from "./utils/logger.ts";

function resolveModelArg(ctx: ExtensionCommandContext, modelArg: string): Model<Api> | undefined {
  const [p, ...r] = modelArg.split("/");
  return ctx.modelRegistry.find(p, r.join("/"));
}

function resolveModels(
  ctx: ExtensionCommandContext,
  primary: Model<Api> | undefined,
  config: ReturnType<typeof loadConfig>,
): { segModel: Model<Api> | undefined; sumModel: Model<Api> | undefined } {
  const fallback = primary ?? ctx.model;
  const available = ctx.modelRegistry.getAvailable();
  let sumModel = fallback;

  const configuredSumModels = [config.summaryModel].filter(Boolean) as string[];
  for (const modelId of configuredSumModels) {
    const [p, ...r] = modelId.split("/");
    const found = ctx.modelRegistry.find(p, r.join("/"));
    if (found) { sumModel = found; break; }
  }
  if (sumModel === fallback && !fallback) sumModel = available[0];

  let segModel = sumModel;
  if (config.segmentationModel) {
    const [p, ...r] = config.segmentationModel.split("/");
    segModel = ctx.modelRegistry.find(p, r.join("/")) ?? sumModel;
  }

  return { segModel, sumModel };
}

export default function smartCompactExtension(pi: ExtensionAPI) {
  const pendingRef: { value: PendingCompaction | null; createdAt: number } = { value: null, createdAt: 0 };
  const isRunning: { value: boolean } = { value: false };
  const PENDING_TTL_MS = 5 * 60 * 1000;

  pi.registerCommand("smart-compact", {
    description: "EESV smart compaction v" + VERSION + ". Usage: /smart-compact [model] [light|balanced|aggressive] [verbose|debug|dry-run] [note]",
    getArgumentCompletions: (prefix: string) => {
      const m = ["verbose", "debug", "dry-run", "metrics", "dashboard", "light", "balanced", "aggressive"].filter(o => o.startsWith(prefix)).map(o => ({ value: o, label: o }));
      return m.length ? m : null;
    },
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const flags = tokens.map(t => t.toLowerCase());
        const verbose = flags.includes("verbose") || flags.includes("debug");
        const dryRun = flags.includes("dry-run");
        if (flags.includes("metrics") || flags.includes("dashboard")) {
          if (flags.includes("dashboard")) {
            const entries = readMetricsLog(200);
            const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
            const action = await showMetricsDashboardUI(ctx, {
              entries,
              currentSessionId: sessionId,
              report: buildMetricsReport(entries),
            });
            if (action === "html") {
              const fp = writeMetricsDashboard(entries);
              ctx.ui.notify(fp ? "Dashboard written: " + fp : "Dashboard could not be written", fp ? "info" : "error");
            }
          } else {
            ctx.ui.notify(buildMetricsReport(), "info");
          }
          return;
        }
        const modelArg = tokens.find(t => t.includes("/"));
        const profileArg = tokens.find(t => ["light", "balanced", "aggressive"].includes(t)) as CompressionProfile | undefined;
        const profile = profileArg ?? loadConfig().profile;

        if (!tokens.length) {
          const usage = ctx.getContextUsage();
          const totalTokens = usage?.tokens ?? 0;
          const pct = ctx.model && totalTokens ? Math.round((totalTokens / ctx.model.contextWindow) * 100) : 0;
          if (!totalTokens || totalTokens < MIN_TOKEN_THRESHOLD) { ctx.ui.notify("Context OK or unknown", "info"); return; }
          const cur = ctx.model;
          const avail = ctx.modelRegistry.getAvailable();
          const opts = avail.map(m => ({ value: m.provider + "/" + m.id, label: m.provider + "/" + m.id + (m.contextWindow >= 200000 ? " (" + Math.round(m.contextWindow / 1000) + "K)" : ""), model: m }));
          const defIdx = cur ? opts.findIndex(o => o.value === cur.provider + "/" + cur.id) : 0;
          const selected = await showCompactUI(ctx, { contextTokens: totalTokens, contextPercent: pct, currentModel: cur ? cur.provider + "/" + cur.id : "?", defaultModelIndex: defIdx >= 0 ? defIdx : 0 });
          if (!selected) { ctx.ui.notify("Cancelled", "info"); return; }
          const { segModel, sumModel } = resolveModels(ctx, selected.model.model, loadConfig());
          if (!sumModel) { ctx.ui.notify("Could not resolve model", "error"); return; }
          await runSmartCompact({ ctx, summaryModel: sumModel, segModel: segModel ?? sumModel, profile: selected.profile, pendingRef, isRunning, force: true });
          return;
        }

        const { segModel, sumModel } = resolveModels(ctx, modelArg ? resolveModelArg(ctx, modelArg) : ctx.model, loadConfig());
        if (!sumModel) { ctx.ui.notify("Could not resolve model", "error"); return; }
        const note = extractUserNote(args);
        await runSmartCompact({ ctx, summaryModel: sumModel, segModel: segModel ?? sumModel, profile, verbose, dryRun, pendingRef, isRunning, userNote: note, force: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message + "\n" + error.stack : String(error);
        ctx.ui.notify("smart-compact error: " + msg, "error");
      }
    },
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    if (pendingRef.value) {
      const age = Date.now() - pendingRef.createdAt;
      if (age > PENDING_TTL_MS) {
        log.warn("Discarding expired pending smart compaction after " + Math.round(age / 1000) + "s");
        (ctx as unknown as ExtensionCommandContext).ui?.notify?.("Expired pending smart compaction discarded", "warning");
        pendingRef.value = null;
        pendingRef.createdAt = 0;
      } else {
        const c = pendingRef.value;
        pendingRef.value = null;
        pendingRef.createdAt = 0;
        return { compaction: { summary: c.summary, firstKeptEntryId: c.firstKeptEntryId, tokensBefore: c.tokensBefore, details: c.details } };
      }
    }
    const config = loadConfig();
    if (!config.autoTrigger) return;
    try {
      const usage = ctx.getContextUsage();
      const totalTokens = usage?.tokens ?? 0;
      if (!totalTokens || totalTokens < MIN_TOKEN_THRESHOLD) return;
      // Guard: don't auto-compact if context is below threshold — tool=97% doesn't mean context is full
      const pct = ctx.model && totalTokens ? (totalTokens / ctx.model.contextWindow) * 100 : 0;
      if (pct < config.minContextPercent) return;
      const cur = ctx.model;
      if (!cur) return;
      const { segModel, sumModel } = resolveModels(ctx as unknown as ExtensionCommandContext, cur, config);
      if (!sumModel) return;
      if (!isRunning.value) {
        const caps = getProviderCaps(sumModel.provider);
        const effectiveTimeoutMs = Math.round(config.autoTriggerTimeoutMs * caps.timeoutMultiplier);
        const compactPromise = runSmartCompact({ ctx: ctx as unknown as ExtensionCommandContext, summaryModel: sumModel, segModel: segModel ?? sumModel, profile: config.profile, pendingRef, isRunning, autoTriggered: true, timeoutMs: effectiveTimeoutMs });
        // Hard timeout: even if the LLM provider ignores AbortSignal, we won't block native compact.
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<"timeout">((resolve) => {
          timeoutId = setTimeout(() => resolve("timeout"), effectiveTimeoutMs + 100);
        });
        let result: "done" | "timeout";
        try {
          result = await Promise.race([compactPromise.then(() => "done" as const), timeoutPromise]);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
        if (result === "timeout") {
          log.warn("Smart compact auto-trigger hard timeout after " + effectiveTimeoutMs + "ms");
          // Do not reset isRunning here: runSmartCompact owns that lifecycle in
          // its finally block. Resetting here can allow overlapping background
          // smart compactions while the timed-out provider call is still unwinding.
          pendingRef.value = null;
          pendingRef.createdAt = 0;
          return; // fall back to native compact
        }
        const pending = pendingRef.value as PendingCompaction | null;
        if (pending) {
          pendingRef.value = null;
          pendingRef.createdAt = 0;
          return { compaction: { summary: pending.summary, firstKeptEntryId: pending.firstKeptEntryId, tokensBefore: pending.tokensBefore, details: pending.details } };
        }
      }
    } catch (e) { log.warn("session_before_compact error", e); }
  });

  pi.registerTool({
    name: "smart_compact", label: "Smart Compact",
    description: "EESV smart compaction v" + VERSION + " with deterministic extraction, exploration, and verification. Compacts the conversation into a structured summary preserving goals, decisions, open loops, modified files, and critical context. Call only when actual context usage is high; ignore pi-auto-context tool=XX% because that is tool-output ratio, not context fullness. The tool internally checks context usage and skips if not needed.",
    promptSnippet: "Smart compaction",
    promptGuidelines: [
      "Use only when actual context usage is high (for example pi-auto-context context>=60%).",
      "Do NOT call just because pi-auto-context shows tool=XX%; tool% is tool-output ratio, not context fullness.",
      "Prefer this over default compact only when compaction is actually needed.",
    ],
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "light, balanced, or aggressive. Default: balanced." },
        verbose: { type: "boolean", description: "Show detailed pipeline output." },
        dry_run: { type: "boolean", description: "Run the pipeline but skip applying the compaction." },
        report: { type: "boolean", description: "Return recent performance metrics instead of compacting." },
        dashboard: { type: "boolean", description: "Write a local HTML metrics dashboard and return its path." },
      },
    },
    async execute(_id, params, _sig, _onUp, ctx) {
      const profile = (params.profile === "light" || params.profile === "balanced" || params.profile === "aggressive") ? params.profile : undefined;
      const verbose = !!params.verbose;
      const dryRun = !!params.dry_run;
      if (params.report || params.dashboard) {
        const report = buildMetricsReport();
        const fp = params.dashboard ? writeMetricsDashboard() : null;
        return { content: [{ type: "text", text: report + (fp ? "\n\nDashboard: " + fp : "") }], details: undefined };
      }
      const config = loadConfig();
      const resolvedProfile = profile ?? config.profile;
      const cmdCtx = ctx as unknown as ExtensionCommandContext;

      // Check context usage — skip if not enough tokens or context too small
      const usage = ctx.getContextUsage?.();
      const totalTokens = usage?.tokens ?? 0;
      const rawPct = ctx.model && totalTokens ? (totalTokens / ctx.model.contextWindow) * 100 : 0;
      const pct = Math.round(rawPct);
      if (!totalTokens || totalTokens < MIN_TOKEN_THRESHOLD) {
        return { content: [{ type: "text", text: "Context is not large enough for compaction (" + totalTokens.toLocaleString() + " tokens, " + pct + "%). No action needed." }], details: undefined };
      }
      // Guard: don't compact if context is below threshold — tool=97% doesn't mean context is full
      if (rawPct < config.minContextPercent) {
        return { content: [{ type: "text", text: "Context is only " + pct + "% full (" + totalTokens.toLocaleString() + " tokens). Compaction is not needed yet. The tool=97% in status means tool output ratio, NOT context usage." }], details: undefined };
      }

      const cur = ('model' in ctx) ? (ctx as unknown as Record<string, unknown>).model as Model<Api> | undefined : undefined;
      const { segModel, sumModel } = resolveModels(cmdCtx, cur, config);
      if (!sumModel) {
        return { content: [{ type: "text", text: "Error: Could not resolve model." }], details: undefined };
      }
      try {
        const toolStart = Date.now();
        // Prepare summary only — do NOT call ctx.compact() from within a tool.
        // The agent loop holds its own message array; compacting mid-turn would cause
        // (a) the current LLM call to still use the old un-compacted context, and
        // (b) tool_result referencing a tool_call in a message that no longer exists.
        // Instead, store the summary in pendingRef and let the session_before_compact
        // hook apply it on the next natural compact (or auto-trigger).
        await runSmartCompact({ ctx: cmdCtx, summaryModel: sumModel, segModel: segModel ?? sumModel, profile: resolvedProfile, verbose, dryRun, pendingRef, isRunning, autoTriggered: true, skipCompact: true });
        const toolSecs = ((Date.now() - toolStart) / 1000).toFixed(1);
        if (pendingRef.value) {
          return { content: [{ type: "text", text: "Smart summary prepared (" + resolvedProfile + "). Tokens: " + (pendingRef.value.tokensBefore ?? 0).toLocaleString() + " — summary cached for " + Math.round(PENDING_TTL_MS / 60000) + " min. The next /compact will use this summary automatically." }], details: undefined };
        }
        return { content: [{ type: "text", text: "Compaction finished (" + resolvedProfile + ") but no summary was generated." }], details: undefined };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: "Compaction error: " + msg }], details: undefined };
      }
    },
  });
}

// extractUserNote is imported from utils/helpers.ts — no local duplicate
