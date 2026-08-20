import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "../constants.ts";
import {
  buildRestoreMessage,
  listBackups,
  readConversationBackup,
} from "../utils/backups.ts";
import { readMetricsLog } from "../utils/cache.ts";
import { loadConfig } from "../utils/config.ts";
import { deriveProjectIdFromCwd } from "../utils/fingerprint.ts";
import * as log from "../utils/logger.ts";
import {
  applyLoopOverrides,
  loadScopedCompactionState,
  saveCompactionState,
} from "../utils/state.ts";
import { estimateTokens, safeContextPercent } from "../utils/tokens.ts";
import { scheduleCompactionStateIndex } from "../infra/context-graph.ts";
import {
  branchEntryIds,
  isUnresolvedSessionId,
  resolveSessionId,
} from "../infra/session-identity.ts";
import type { CompactConfig } from "../types.ts";
import {
  buildLocalDashboardInsights,
  buildMetricsReport,
  writeMetricsDashboard,
} from "../ui/metrics-report.ts";
import { showMetricsDashboardUI } from "../ui/metrics-dashboard-overlay.ts";
import { showSmartCompactSettings } from "../ui/settings-overlay.ts";
import {
  showBackupViewer,
  showCompactUI,
  showOpenLoopsUI,
  showRestoreAction,
  showRestorePicker,
} from "../ui/overlays.ts";
import { formatCompactErrorForUi } from "../ui/error-format.ts";
import { findModelById, resolveModels } from "./model-routing.ts";
import type { PendingSlot } from "./pending-slot.ts";
import { runSmartCompact } from "./run-smart-compact.ts";
import type { SessionRunLock } from "./session-run-lock.ts";
import { parseSmartCompactCommand } from "./smart-compact-input.ts";
import type { SmartCompactPolicy } from "./smart-compact-policy.ts";

interface SmartCompactCommandDependencies {
  pendingRef: PendingSlot;
  runLock: SessionRunLock;
  onNativeApplyError: (runId: string) => boolean;
  policy: SmartCompactPolicy;
}

async function showMetrics(
  ctx: ExtensionCommandContext,
  action: "metrics" | "dashboard",
): Promise<void> {
  if (action === "metrics") {
    ctx.ui.notify(buildMetricsReport(), "info");
    return;
  }
  const entries = readMetricsLog(200);
  const resolved = resolveSessionId(ctx);
  const sessionId = isUnresolvedSessionId(resolved) ? "(no session)" : resolved;
  const insights = buildLocalDashboardInsights(entries);
  const selected = await showMetricsDashboardUI(ctx, {
    entries,
    currentSessionId: sessionId,
    report: buildMetricsReport(entries, undefined, insights),
    insights,
  });
  if (selected !== "html") return;
  const file = writeMetricsDashboard(entries);
  ctx.ui.notify(
    file ? "Dashboard written: " + file : "Dashboard could not be written",
    file ? "info" : "error",
  );
}

async function restoreBackup(ctx: ExtensionCommandContext): Promise<void> {
  const backups = listBackups();
  if (!backups.length) {
    ctx.ui.notify("No smart-compact backups found", "info");
    return;
  }
  const selected = await showRestorePicker(ctx, backups);
  if (!selected) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }
  const backup = readConversationBackup(selected);
  if (!backup) {
    ctx.ui.notify("Could not read backup: " + selected, "error");
    return;
  }
  const action = await showRestoreAction(ctx, selected);
  if (action === "view") {
    await showBackupViewer(ctx, backup.content, selected);
    return;
  }
  if (action !== "restore") return;

  const estimatedTokens =
    backup.contextTokens ??
    estimateTokens(backup.content, ctx.model?.provider, ctx.model?.id);
  const contextWindow = ctx.model?.contextWindow ?? 0;
  if (contextWindow > 0 && estimatedTokens > contextWindow * 0.9) {
    ctx.ui.notify(
      "Restore blocked: backup context is about " +
        estimatedTokens.toLocaleString() +
        " tokens, above the safe limit for this " +
        contextWindow.toLocaleString() +
        "-token model.",
      "warning",
    );
    await showBackupViewer(ctx, backup.content, selected);
    return;
  }

  if (backup.branchLeafId) {
    try {
      const result = await ctx.fork(backup.branchLeafId, {
        position: "at",
        withSession: async (restored) => {
          restored.ui.notify(
            "Restored the exact pre-compaction branch",
            "info",
          );
        },
      });
      if (result.cancelled) ctx.ui.notify("Restore cancelled", "info");
      return;
    } catch (error) {
      log.debugError("Exact backup restore fork unavailable", error);
      if (
        !/Invalid entry ID for forking/i.test(
          error instanceof Error ? error.message : String(error),
        )
      ) {
        ctx.ui.notify(
          "Exact restore failed: " +
            (error instanceof Error ? error.message : String(error)),
          "error",
        );
        return;
      }
    }
  }

  try {
    const result = await ctx.newSession({
      withSession: async (restored) => {
        await restored.sendMessage(
          buildRestoreMessage(backup.content, selected),
          {
            deliverAs: "nextTurn",
          },
        );
        restored.ui.notify("Restored backup into a new session", "info");
      },
    });
    if (result.cancelled) ctx.ui.notify("Restore cancelled", "info");
  } catch (error) {
    log.debugError("Backup restore into new session failed", error);
    ctx.ui.notify(
      "Restore failed: " +
        (error instanceof Error ? error.message : String(error)),
      "error",
    );
  }
}

async function manageOpenLoops(ctx: ExtensionCommandContext): Promise<void> {
  const projectId = deriveProjectIdFromCwd(ctx.cwd);
  if (!projectId) {
    ctx.ui.notify(
      "Project loops must be managed from a project directory",
      "warning",
    );
    return;
  }
  const sessionId = resolveSessionId(ctx);
  const ancestry = branchEntryIds(
    ctx.sessionManager.getBranch() as Array<{ id?: string }>,
  );
  const state = isUnresolvedSessionId(sessionId)
    ? null
    : loadScopedCompactionState({ projectId, sessionId }, ancestry);
  if (!state?.openLoops.length) {
    ctx.ui.notify("No persisted open loops for this project", "info");
    return;
  }
  const overrides = await showOpenLoopsUI(
    ctx,
    state.openLoops,
    state.loopOverrides ?? [],
  );
  if (!overrides) {
    ctx.ui.notify("Open-loop manager closed without changes", "info");
    return;
  }
  state.loopOverrides = overrides;
  state.openLoops = applyLoopOverrides(state.openLoops, overrides);
  const branchHeadId = ancestry.at(-1);
  if (branchHeadId) {
    state.scope = {
      ...state.scope,
      schemaVersion: 2,
      projectId,
      sessionId,
      branchHeadId,
      branchAncestryIds: ancestry.slice(-100),
    };
  }
  state.updatedAt = Date.now();
  if (!saveCompactionState(projectId, state)) {
    ctx.ui.notify("Open-loop overrides could not be saved", "error");
    return;
  }
  if (
    loadConfig().contextGraphEnabled &&
    !(await scheduleCompactionStateIndex(projectId, state))
  ) {
    ctx.ui.notify(
      "Open-loop overrides saved, but Smart Recall indexing failed",
      "warning",
    );
  } else {
    ctx.ui.notify("Open-loop overrides saved", "info");
  }
}

async function runInteractiveCompaction(
  ctx: ExtensionCommandContext,
  config: CompactConfig,
  dependencies: SmartCompactCommandDependencies,
): Promise<void> {
  const usage = ctx.getContextUsage();
  const totalTokens = usage?.tokens ?? 0;
  const contextPercent = Math.round(
    safeContextPercent(totalTokens, ctx.model?.contextWindow),
  );
  const initialRoutes = resolveModels(ctx, ctx.model, config);
  if (!initialRoutes.sumModel) {
    ctx.ui.notify("Could not resolve model", "error");
    return;
  }
  const available = ctx.modelRegistry.getAvailable();
  const defaultModelIndex = available.findIndex(
    (model) =>
      model.provider === initialRoutes.sumModel?.provider &&
      model.id === initialRoutes.sumModel.id,
  );
  const selected = await showCompactUI(ctx, {
    contextTokens: totalTokens,
    contextPercent,
    activeModelLabel: ctx.model ? ctx.model.provider + "/" + ctx.model.id : "?",
    defaultModelIndex: Math.max(0, defaultModelIndex),
    config,
  });
  if (!selected) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }
  const { segModel, sumModel, verifyModel } = resolveModels(
    ctx,
    selected.model.model,
    config,
    true,
  );
  if (!sumModel) {
    ctx.ui.notify("Could not resolve model", "error");
    return;
  }
  await runSmartCompact({
    ctx,
    config,
    summaryModel: sumModel,
    segModel: segModel ?? sumModel,
    verifyModel: verifyModel ?? sumModel,
    mode: selected.mode,
    pendingRef: dependencies.pendingRef,
    isRunning: dependencies.runLock,
    onNativeApplyError: dependencies.onNativeApplyError,
    force: true,
  });
}

export function registerSmartCompactCommand(
  pi: ExtensionAPI,
  dependencies: SmartCompactCommandDependencies,
): void {
  pi.registerCommand("smart-compact", {
    description:
      "EESV smart compaction v" +
      VERSION +
      ". Usage: /smart-compact [model|settings] [mode] [flags] [--focus=topic] [--max-calls=N] [--max-input-tokens=N] [--note=text | -- text]",
    getArgumentCompletions(prefix: string) {
      const matches = [
        "verbose",
        "debug",
        "dry-run",
        "metrics",
        "dashboard",
        "restore",
        "loops",
        "settings",
        "fast",
        "balanced",
        "thorough",
        "--focus=",
        "--max-calls=",
        "--max-input-tokens=",
        "--max-latency=",
      ].flatMap((value) =>
        value.startsWith(prefix) ? [{ value, label: value }] : [],
      );
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      await ctx.waitForIdle();
      try {
        const knownProviders = new Set(
          ctx.modelRegistry.getAvailable().map((model) => model.provider),
        );
        const parsed = parseSmartCompactCommand(args, (token) => {
          const [provider, ...modelPath] = token.split("/");
          return (
            /^[a-z0-9_.-]+$/i.test(provider) &&
            modelPath.length > 0 &&
            modelPath.every((segment) => /^[a-z0-9_.:-]+$/i.test(segment)) &&
            Boolean(findModelById(ctx, token) || knownProviders.has(provider))
          );
        });
        if (!parsed.ok) {
          ctx.ui.notify(parsed.error, "error");
          return;
        }
        const input = parsed.value;
        if (input.action === "metrics" || input.action === "dashboard") {
          await showMetrics(ctx, input.action);
          return;
        }
        if (input.action === "restore") {
          await restoreBackup(ctx);
          return;
        }
        if (input.action === "loops") {
          await manageOpenLoops(ctx);
          return;
        }
        if (input.action === "settings") {
          if (ctx.mode !== "tui") {
            ctx.ui.notify(
              "Smart Compact settings require TUI mode. Use settings.json for permanent defaults.",
              "warning",
            );
            return;
          }
          await showSmartCompactSettings(ctx, dependencies.policy);
          return;
        }
        const config = loadConfig();
        if (!args.trim()) {
          await runInteractiveCompaction(ctx, config, dependencies);
          return;
        }
        const explicitModel = input.modelArg
          ? findModelById(ctx, input.modelArg)
          : undefined;
        if (input.modelArg && !explicitModel) {
          ctx.ui.notify(
            "Unknown model: " + input.modelArg + " — check available models",
            "error",
          );
          return;
        }
        const { segModel, sumModel, verifyModel } = resolveModels(
          ctx,
          explicitModel ?? ctx.model,
          config,
          Boolean(input.modelArg),
        );
        if (!sumModel) {
          ctx.ui.notify("Could not resolve model", "error");
          return;
        }
        await runSmartCompact({
          ctx,
          summaryModel: sumModel,
          segModel: segModel ?? sumModel,
          verifyModel: verifyModel ?? sumModel,
          mode: input.mode ?? config.mode,
          verbose: input.verbose,
          dryRun: input.dryRun,
          pendingRef: dependencies.pendingRef,
          isRunning: dependencies.runLock,
          onNativeApplyError: dependencies.onNativeApplyError,
          userNote: input.note,
          focus: input.focus,
          maxLlmCalls: input.maxLlmCalls,
          maxLlmInputTokens: input.maxLlmInputTokens,
          timeoutMs: input.timeoutMs,
          force: true,
        });
      } catch (error) {
        log.debugError("Manual smart compact failed", error);
        ctx.ui.notify(formatCompactErrorForUi(error), "error");
      }
    },
  });
}
