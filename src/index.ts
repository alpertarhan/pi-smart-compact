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
import { runSmartCompact } from "./core.ts";
import { showCompactUI } from "./ui/overlays.ts";
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
      const m = ["verbose", "debug", "dry-run", "light", "balanced", "aggressive"].filter(o => o.startsWith(prefix)).map(o => ({ value: o, label: o }));
      return m.length ? m : null;
    },
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const flags = tokens.map(t => t.toLowerCase());
        const verbose = flags.includes("verbose") || flags.includes("debug");
        const dryRun = flags.includes("dry-run");
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
          await runSmartCompact({ ctx, summaryModel: sumModel, segModel: segModel ?? sumModel, profile: selected.profile, pendingRef, isRunning });
          return;
        }

        const { segModel, sumModel } = resolveModels(ctx, modelArg ? resolveModelArg(ctx, modelArg) : ctx.model, loadConfig());
        if (!sumModel) { ctx.ui.notify("Could not resolve model", "error"); return; }
        const note = extractUserNote(args);
        await runSmartCompact({ ctx, summaryModel: sumModel, segModel: segModel ?? sumModel, profile, verbose, dryRun, pendingRef, isRunning, userNote: note });
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
      const cur = ctx.model;
      if (!cur) return;
      const { segModel, sumModel } = resolveModels(ctx, cur, config);
      if (!sumModel) return;
      if (!isRunning.value) {
        await runSmartCompact({ ctx, summaryModel: sumModel, segModel: segModel ?? sumModel, profile: config.profile, pendingRef, isRunning, autoTriggered: true });
        if (pendingRef.value) {
          const c = pendingRef.value;
          pendingRef.value = null;
          pendingRef.createdAt = 0;
          return { compaction: { summary: c.summary, firstKeptEntryId: c.firstKeptEntryId, tokensBefore: c.tokensBefore, details: c.details } };
        }
      }
    } catch (e) { log.warn("session_before_compact error", e); }
  });

  pi.registerTool({
    name: "smart_compact", label: "Smart Compact",
    description: "EESV smart compaction v" + VERSION + " with deterministic extraction, exploration, and verification.",
    promptSnippet: "Smart compaction",
    promptGuidelines: ["Use for long conversations.", "Prefer over default compact."],
    parameters: {
      type: "object",
      properties: {
        profile: { type: "string", description: "light, balanced, or aggressive" },
        verbose: { type: "boolean" },
        dry_run: { type: "boolean" },
      },
    },
    async execute(_id, params, _sig, _onUp, ctx) {
      const profile = (params.profile === "light" || params.profile === "balanced" || params.profile === "aggressive") ? params.profile : undefined;
      const verbose = !!params.verbose;
      const dryRun = !!params.dry_run;
      const config = loadConfig();
      const resolvedProfile = profile ?? config.profile;
      const cur = ('model' in ctx) ? (ctx as any).model : undefined;
      const { segModel, sumModel } = resolveModels(ctx as ExtensionCommandContext, cur, config);
      if (!sumModel) {
        return { content: [{ type: "text", text: "Error: Could not resolve model." }] };
      }
      try {
        const toolStart = Date.now();
        await runSmartCompact({ ctx, summaryModel: sumModel, segModel: segModel ?? sumModel, profile: resolvedProfile, verbose, dryRun, pendingRef, isRunning, autoTriggered: true, skipCompact: true });
        const toolSecs = ((Date.now() - toolStart) / 1000).toFixed(1);
        if (pendingRef.value) {
          return { content: [{ type: "text", text: "Smart summary generated (" + resolvedProfile + "). Tokens: " + (pendingRef.value.tokensBefore ?? "?") + " -> " + (pendingRef.value.summary?.length ?? 0) + " chars (" + toolSecs + "s).\n\nNow run tree compact to apply — the session_before_compact hook will use this summary.\nTTL: " + Math.round(PENDING_TTL_MS / 60000) + " minutes." }] };
        }
        return { content: [{ type: "text", text: "Compaction finished (" + resolvedProfile + ") but no summary was generated." }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: "Compaction error: " + msg }] };
      }
    },
  });
}

// extractUserNote is imported from utils/helpers.ts — no local duplicate
