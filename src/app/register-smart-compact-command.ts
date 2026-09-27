import type {
 ExtensionAPI,
 ExtensionCommandContext,
 ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "../constants.ts";
import {
 buildRestoreMessage,
 listBackups,
 readConversationBackup,
} from "../utils/backups.ts";
import { readMetricsLog } from "../utils/cache.ts";
import { loadConfig, writeGlobalConfigValues } from "../utils/config.ts";
import { localGraphOpsAllowed } from "./memory-backend.ts";
import { createModelFeasibilityResolver, type ModelFeasibility } from "./model-feasibility.ts";
import type { DeferredTrim, ManualTrimRequest } from "./register-smart-context-tool.ts";
import { inspectArtifactStorage } from "./artifact-storage.ts";
import { formatStorageReport } from "../ui/storage-report.ts";
import { type HomeAction, localGraphOffReason, showSmartCompactHome } from "../ui/home-overlay.ts";
import { deriveProjectIdFromCwd } from "../utils/fingerprint.ts";
import { errorDetail, flushIssues, formatRecentIssues, notifyUser, recordIssue } from "../utils/issues.ts";
import * as log from "../utils/logger.ts";
import {
 applyLoopOverrides,
 loadScopedCompactionState,
 saveCompactionState,
} from "../utils/state.ts";
import { estimateTokens, safeContextPercent } from "../utils/tokens.ts";
import { scheduleCompactionStateIndex } from "../infra/context-graph.ts";
import {
 forgetProjectGraph,
 getContextGraphMemoryCounts,
} from "../infra/context-graph.ts";
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
import {
 GlobalSettingsCoordinator,
 showSmartCompactSettings,
} from "../ui/settings-overlay.ts";
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
import { runHandoff } from "./session-handoff.ts";
import type { SessionRunLock } from "./session-run-lock.ts";
import { parseSmartCompactCommand } from "./smart-compact-input.ts";
import type { SmartCompactPolicy } from "./smart-compact-policy.ts";
import { describeEffectiveState, describeReadiness, type EffectiveRuntimeState } from "./effective-state.ts";
import type { GlobalConfigPath } from "../utils/config.ts";
import { showNavigationPanel } from "../ui/navigation-overlay.ts";
import type { NavigationController } from "./register-navigation.ts";
interface SmartCompactCommandDependencies {
 pendingRef: PendingSlot;
 runLock: SessionRunLock;
 onNativeApplyError: (runId: string) => boolean;
 policy: SmartCompactPolicy;
 /** Live run/preparation/pause state; absent means "not attached", never assumed idle. */
 getRuntimeState?: (ctx: ExtensionContext) => EffectiveRuntimeState;
 /** Queue a zero-LLM local cleanup at the next natural turn boundary (smart_context controller). */
 requestManualTrim?: (ctx: ExtensionContext) => ManualTrimRequest;
 /** Automatic trim held for a cold prompt cache in this session, if any. */
 deferredTrim?: (ctx: ExtensionContext) => DeferredTrim | null;
 navigation?: NavigationController;
 toolSummary?: () => string;
 /**
  * Runtime refresh after any global settings write, applied once for all
  * written paths (a one-key edit passes [path]).
  */
 onGlobalSettingsApplied?: (
  paths: GlobalConfigPath[],
  ctx: ExtensionCommandContext,
 ) => void | Promise<void>;
}

const NO_USABLE_MODEL =
 "Smart Compact: no model is available with credentials, so nothing was compacted. Log in with /login or set a provider API key, then run /smart-compact again.";

/** Local, read-only effective state (no provider or Hindsight contact). */
function effectiveState(
 ctx: ExtensionCommandContext,
 dependencies: SmartCompactCommandDependencies,
): Promise<string> {
 return describeEffectiveState(
  ctx,
  loadConfig(),
  dependencies.policy.snapshot(),
  dependencies.getRuntimeState?.(ctx),
 );
}

async function showMetrics(
 ctx: ExtensionCommandContext,
 action: "metrics" | "dashboard",
 dependencies: SmartCompactCommandDependencies,
): Promise<void> {
 const state = "Effective state\n" + await effectiveState(ctx, dependencies);
 if (action === "metrics") {
  notifyUser(ctx, state + "\n\n" + formatRecentIssues() + "\n\n" + buildMetricsReport(), "info");
  return;
 }
 const entries = readMetricsLog(200);
 const resolved = resolveSessionId(ctx);
 const sessionId = isUnresolvedSessionId(resolved) ? "(no session)" : resolved;
 const insights = buildLocalDashboardInsights(entries);
 const selected = await showMetricsDashboardUI(ctx, {
  entries,
  currentSessionId: sessionId,
  report: state + "\n\n" + formatRecentIssues() + "\n\n" + buildMetricsReport(entries, undefined, insights),
  insights,
 });
 if (selected !== "html") return;
 const file = writeMetricsDashboard(entries);
 notifyUser(ctx,
  file ? "Dashboard written: " + file : "Dashboard could not be written",
  file ? "info" : "error",
 );
}

async function restoreBackup(ctx: ExtensionCommandContext): Promise<void> {
 const backups = listBackups();
 if (!backups.length) {
  notifyUser(ctx, "No smart-compact backups found", "info");
  return;
 }
 const selected = await showRestorePicker(ctx, backups);
 if (!selected) {
  notifyUser(ctx, "Cancelled", "info");
  return;
 }
 const backup = readConversationBackup(selected);
 if (!backup) {
  notifyUser(ctx, "Could not read backup: " + selected, "error");
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
  notifyUser(ctx,
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
     notifyUser(restored,
      "Restored the exact pre-compaction branch",
      "info",
     );
    },
   });
   if (result.cancelled) notifyUser(ctx, "Restore cancelled", "info");
   return;
  } catch (error) {
   log.debugError("Exact backup restore fork unavailable", error);
   if (
    !/Invalid entry ID for forking/i.test(
     error instanceof Error ? error.message : String(error),
    )
   ) {
    notifyUser(ctx,
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
    notifyUser(restored, "Restored backup into a new session", "info");
   },
  });
  if (result.cancelled) notifyUser(ctx, "Restore cancelled", "info");
 } catch (error) {
  log.debugError("Backup restore into new session failed", error);
  notifyUser(ctx,
   "Restore failed: " +
   (error instanceof Error ? error.message : String(error)),
   "error",
  );
 }
}

const FORGET_UNTOUCHED =
 "Not affected: Mnemopi and Hindsight memory, compaction restore data, and conversation backups.";

function plural(count: number, word: string): string {
 return count + " " + word + (count === 1 ? "" : "s");
}

async function forgetProjectMemory(ctx: ExtensionCommandContext): Promise<void> {
 // The selected backend is exclusive: local-graph operations run only when
 // "This machine" is selected. Old local data is kept (never auto-deleted)
 // and is reachable again after switching the backend back.
 const forgetConfig = loadConfig();
 if (!localGraphOpsAllowed(forgetConfig)) {
  notifyUser(ctx,
   localGraphOffReason(forgetConfig) + " Local project memory was not changed.",
   "warning",
  );
  return;
 }
 // Deleting needs a real confirmation dialog; without one nothing is deleted.
 if (ctx.mode !== "tui" || !ctx.hasUI) {
  notifyUser(ctx,
   "Forgetting project memory requires TUI mode for its confirmation dialog; nothing was deleted.",
   "warning",
  );
  return;
 }
 const projectId = deriveProjectIdFromCwd(ctx.cwd);
 if (!projectId) {
  notifyUser(ctx,
   "Project memory must be forgotten from a project directory",
   "warning",
  );
  return;
 }
 const counts = getContextGraphMemoryCounts(projectId);
 const total = counts.manual + counts.derived + counts.unknown;
 if (!total) {
  notifyUser(ctx, "No local project memory for this project. " + FORGET_UNTOUCHED, "info");
  return;
 }
 const kept = [
  counts.manual ? plural(counts.manual, "saved fact") : "",
  counts.unknown ? plural(counts.unknown, "legacy item") + " without provenance" : "",
 ].filter(Boolean).join(" and ");
 const derivedOption =
  "Learned from compactions only: delete " + plural(counts.derived, "item") +
  (kept ? "; keep " + kept : "");
 const allOption = "Everything in the local project graph: delete all " + plural(total, "item");
 const options = counts.derived ? [derivedOption, allOption] : [allOption];
 const choice = await ctx.ui.select(
  "Forget local project memory — " +
  plural(counts.manual, "saved fact") + ", " +
  plural(counts.derived, "item") + " learned from compactions (incl. file/session records), " +
  plural(counts.unknown, "legacy item") + " without provenance",
  options,
 );
 if (!choice) {
  notifyUser(ctx, "Forget cancelled — project memory untouched", "info");
  return;
 }
 const scope: "derived-only" | "all" = choice === derivedOption ? "derived-only" : "all";
 const deleted = scope === "derived-only" ? counts.derived : total;
 const confirmed = await ctx.ui.confirm(
  scope === "derived-only" ? "Forget compaction-learned memory?" : "Forget all local project memory?",
  "Permanently delete " + plural(deleted, "item") + " from this project's local memory graph, " +
  "including search copies and links. This cannot be undone.\n" +
  (scope === "derived-only" && kept ? "Kept: " + kept + ".\n" : "") +
  FORGET_UNTOUCHED,
 );
 if (!confirmed) {
  notifyUser(ctx, "Forget cancelled — project memory untouched", "info");
  return;
 }
 if (!forgetProjectGraph(projectId, scope)) {
  notifyUser(ctx,
   "Smart Compact: forgetting project memory failed. Project memory is unchanged. /smart-compact metrics shows the error.",
   "error",
  );
  return;
 }
 notifyUser(ctx,
  "Forgotten: deleted " + plural(deleted, "item") + " from the local project graph" +
  (scope === "derived-only" && kept ? "; kept " + kept : "") + ". " + FORGET_UNTOUCHED,
  "info",
 );
}

async function manageOpenLoops(ctx: ExtensionCommandContext): Promise<void> {
 const projectId = deriveProjectIdFromCwd(ctx.cwd);
 if (!projectId) {
  notifyUser(ctx,
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
  notifyUser(ctx, "No persisted open loops for this project", "info");
  return;
 }
 const overrides = await showOpenLoopsUI(
  ctx,
  state.openLoops,
  state.loopOverrides ?? [],
 );
 if (!overrides) {
  notifyUser(ctx, "Open-loop manager closed without changes", "info");
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
  notifyUser(ctx, "Open-loop overrides could not be saved", "error");
  return;
 }
 if (
  localGraphOpsAllowed(loadConfig()) &&
  !(await scheduleCompactionStateIndex(projectId, state))
 ) {
  notifyUser(ctx,
   "Open-loop overrides saved, but Smart Recall indexing failed",
   "warning",
  );
 } else {
  notifyUser(ctx, "Open-loop overrides saved", "info");
 }
}

/**
 * Queue local cleanup (no model call). Nothing is changed now: it applies at
 * the next natural turn boundary, so the next provider request is untrimmed.
 */
function queueLocalCleanup(ctx: ExtensionCommandContext, dependencies: SmartCompactCommandDependencies): void {
 const result = dependencies.requestManualTrim?.(ctx) ??
 { state: "unavailable" as const, notice: "Local cleanup is not available in this session." };
 notifyUser(ctx, result.notice, result.state === "queued" ? "info" : "warning");
}

/** Read-only storage inventory; works without a UI (print/RPC) as a message. */
async function showStorage(ctx: ExtensionCommandContext): Promise<void> {
 const report = formatStorageReport(await inspectArtifactStorage());
 // Info notices are dropped without a UI; plain print mode owns a text
 // stdout, so the report goes there. JSON/RPC stdout is a protocol: untouched.
 if (ctx.mode === "print") process.stdout.write(report + "\n");
 else notifyUser(ctx, report, "info");
}

/** Value of the Home "Compact now" row, or why it cannot run. */
function compactNowState(ctx: ExtensionCommandContext, dependencies: SmartCompactCommandDependencies): { value: string; blocked?: string } {
 const config = loadConfig();
 const tokens = ctx.getContextUsage()?.tokens;
 const value = tokens == null ? "not measured yet"
  : Math.round(tokens / 1000) + "k tokens · " + Math.round(safeContextPercent(tokens, ctx.model?.contextWindow)) + "%";
 const runtime = dependencies.getRuntimeState?.(ctx);
 if (runtime?.running) return { value, blocked: "Compaction is already running. Wait for it to finish." };
 if (runtime?.paused) return { value, blocked: "A context change is pending. Finish or cancel it before compacting." };
 if (!ctx.modelRegistry.getAvailable().length || !resolveModels(ctx, ctx.model, config).sumModel) {
  return { value, blocked: "No model is ready. Close this menu and use /login, then choose a model in Pi. Status & help explains the available routes." };
 }
 return { value };
}

async function showHome(
 ctx: ExtensionCommandContext,
 dependencies: SmartCompactCommandDependencies,
 coordinator: GlobalSettingsCoordinator,
): Promise<HomeAction | undefined> {
 // Local capacity snapshot (no provider, auth or memory-backend calls). It is
 // rebuilt after every successful settings write on this screen, so readiness
 // and model rows never judge against the config they were opened with.
 let snapshot: ModelFeasibility | undefined;
 let pending: Promise<void> = Promise.resolve();
 const rebuild = (): Promise<void> => {
  snapshot = undefined;
  const next = createModelFeasibilityResolver(ctx, loadConfig()).then((value) => {
   if (pending === next) snapshot = value;
  });
  pending = next;
  return next;
 };
 await rebuild();
 const feasibility: ModelFeasibility = (model, stage, mode) =>
  snapshot?.(model, stage, mode) ?? { selectable: false, reason: "Request sizes are being rechecked after a settings change; try again" };
 const onApplied = async (path: GlobalConfigPath) => {
  await dependencies.onGlobalSettingsApplied?.([path], ctx);
  await rebuild();
 };
 return showSmartCompactHome({
  ctx,
  policy: dependencies.policy,
  coordinator,
  onApplied,
  applyPatch: async (patch) => {
   const config = await writeGlobalConfigValues(patch);
   await dependencies.onGlobalSettingsApplied?.(Object.keys(patch) as GlobalConfigPath[], ctx);
   await rebuild();
   return config;
  },
  compactNow: () => compactNowState(ctx, dependencies),
  readiness: async () => {
   await pending;
   return describeReadiness(ctx, { ...loadConfig(), autoTrigger: dependencies.policy.snapshot().autoTrigger }, dependencies.getRuntimeState?.(ctx), snapshot);
  },
  feasibility,
  effectiveState: () => effectiveState(ctx, dependencies),
  navigation: dependencies.navigation?.panel(ctx),
  toolSummary: dependencies.toolSummary,
  deferredTrim: () => dependencies.deferredTrim?.(ctx) ?? null,
 });
}

async function runInteractiveCompaction(
 ctx: ExtensionCommandContext,
 config: CompactConfig,
 dependencies: SmartCompactCommandDependencies,
): Promise<boolean> {
 const usage = ctx.getContextUsage();
 const totalTokens = usage?.tokens ?? 0;
 const contextPercent = Math.round(
  safeContextPercent(totalTokens, ctx.model?.contextWindow),
 );
 const available = ctx.modelRegistry.getAvailable();
 const initialRoutes = resolveModels(ctx, ctx.model, config);
 // The picker lists only models with credentials; an empty list is a setup
 // problem, not a user cancel.
 if (!available.length || !initialRoutes.sumModel) {
  notifyUser(ctx, NO_USABLE_MODEL, "error");
  return false;
 }
 const defaultModelIndex = available.findIndex(
  (model) =>
   model.provider === initialRoutes.sumModel?.provider &&
   model.id === initialRoutes.sumModel.id,
 );
 // Snapshot before the picker: ineligible models stay visible but unselectable.
 const feasibility = await createModelFeasibilityResolver(ctx, config);
 const selected = await showCompactUI(ctx, {
  feasibility,
  contextTokens: totalTokens,
  contextPercent,
  activeModelLabel: ctx.model ? ctx.model.provider + "/" + ctx.model.id : "?",
  defaultModelIndex: Math.max(0, defaultModelIndex),
  config,
  // Computed only on request (S): it may run a local `bun --version` check.
  showEffectiveState: async () => notifyUser(ctx, "Effective state\n" + await effectiveState(ctx, dependencies), "info"),
 });
 if (!selected) return false;
 const { segModel, sumModel, verifyModel } = resolveModels(
  ctx,
  selected.model.model,
  config,
  true,
 );
 if (!sumModel) {
  notifyUser(ctx, NO_USABLE_MODEL, "error");
  return false;
 }
 // Revalidate every resolved stage route for the mode actually chosen.
 const stageRoutes = [["summary", sumModel], ["segmentation", segModel ?? sumModel], ["verification", verifyModel ?? sumModel]] as const;
 for (const [stage, model] of stageRoutes) {
  const check = feasibility(model, stage, selected.mode);
  if (!check.selectable) {
   notifyUser(ctx, `Not started: ${stage} model ${model.provider}/${model.id} cannot run ${selected.mode}: ${check.reason ?? "the planned requests do not fit"}`, "error");
   return false;
  }
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
 return true;
}

export function registerSmartCompactCommand(
 pi: ExtensionAPI,
 dependencies: SmartCompactCommandDependencies,
): void {
 const settingsCoordinator = new GlobalSettingsCoordinator();
 pi.registerCommand("smart-compact", {
  description:
   "EESV smart compaction v" +
   VERSION +
   ". Usage: /smart-compact [model|settings|handoff] [mode] [flags] [--focus=topic] [--max-calls=N] [--max-input-tokens=N] [--note=text | -- text]",
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
    "forget",
    "storage",
    "trim",
    "handoff",
    "context",
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
   flushIssues(ctx);
   try {
    if (await dependencies.navigation?.handleCommand(args.trim(), ctx)) return;
    if (args.trim() === "context") {
     if (!dependencies.navigation) throw new Error("Context navigation is not attached.");
     if (!ctx.hasUI || ctx.mode !== "tui") {
      notifyUser(ctx, "Context navigation UI needs TUI mode. Agent workflows can load navigation with smart_tools.", "warning");
      return;
     }
     await showNavigationPanel(ctx, dependencies.navigation.panel(ctx));
     return;
    }
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
     notifyUser(ctx, parsed.error, "error");
     return;
    }
    const input = parsed.value;
    if (input.action === "metrics" || input.action === "dashboard") {
     await showMetrics(ctx, input.action, dependencies);
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
    if (input.action === "trim") {
     queueLocalCleanup(ctx, dependencies);
     return;
    }
    if (input.action === "storage") {
     await showStorage(ctx);
     return;
    }
    if (input.action === "forget") {
     await forgetProjectMemory(ctx);
     return;
    }
    if (input.action === "handoff") {
     await runHandoff(ctx, input.note);
     return;
    }
    if (input.action === "settings") {
     if (ctx.mode !== "tui") {
      notifyUser(ctx,
       "Smart Compact settings require TUI mode. Use settings.json for permanent defaults.",
       "warning",
      );
      return;
     }
     await showSmartCompactSettings(
      ctx,
      dependencies.policy,
      settingsCoordinator,
      (path) => dependencies.onGlobalSettingsApplied?.([path], ctx),
     );
     return;
    }
    const config = loadConfig();
    // Without a UI (print/RPC/SDK) the home screen cannot open: run with
    // the configured defaults, exactly like an explicit mode argument.
    if (!args.trim() && ctx.hasUI && ctx.mode === "tui") {
     while (true) {
      const action = await showHome(ctx, dependencies, settingsCoordinator);
      if (action === "compact") {
       if (!await runInteractiveCompaction(ctx, loadConfig(), dependencies)) continue;
      } else if (action === "metrics" || action === "dashboard") await showMetrics(ctx, action, dependencies);
      else if (action === "restore") await restoreBackup(ctx);
      else if (action === "loops") await manageOpenLoops(ctx);
      else if (action === "forget") await forgetProjectMemory(ctx);
      else if (action === "storage") await showStorage(ctx);
      else if (action === "trim") queueLocalCleanup(ctx, dependencies);
      else if (action === "navigation" && dependencies.navigation) await showNavigationPanel(ctx, dependencies.navigation.panel(ctx));
      break;
     }
     return;
    }
    if (!args.trim() && ctx.hasUI) {
     await runInteractiveCompaction(ctx, config, dependencies);
     return;
    }
    const explicitModel = input.modelArg
     ? findModelById(ctx, input.modelArg)
     : undefined;
    if (input.modelArg && !explicitModel) {
     notifyUser(ctx,
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
     notifyUser(ctx, NO_USABLE_MODEL, "error");
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
    recordIssue({ key: "manual.run", message: "Manual compaction failed: " + errorDetail(error) + ".", error });
    notifyUser(ctx, formatCompactErrorForUi(error), "error");
   }
  },
 });
}
