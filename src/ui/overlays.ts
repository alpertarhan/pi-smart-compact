/**
 * TUI overlays: model/profile selection, progress, result screen.
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, Theme } from "@earendil-works/pi-coding-agent";
import { POST_SUMMARY_RESERVE_RATIO, TRUNC } from "../constants.ts";
import { Container, Key, matchesKey, ScrollView, type SelectItem, SelectList, Text, truncateToWidth, visibleWidth, VStack } from "@earendil-works/pi-tui";
import type { Model, Api } from "@earendil-works/pi-ai";
import type {
  CompactConfig, CompactMetricsEntry, CompactionMode, ModelOption, ProgressState,
  SmartCompactDetails, StructuredExtraction, OpenLoop, LoopOverride,
} from "../types.ts";
import type { BackupEntry } from "../utils/backups.ts";
import { createProductionServices, type SmartCompactServices } from "../infra/services.ts";
import { effectivePromptInputTokens, getExtractionCacheStats, getMetricsSummary } from "../utils/cache.ts";
import { getProviderCaps } from "../utils/tokens.ts";
import { planManualPreflight, preflightDamageMedian, prepareManualPreflightContext, type ManualPreflight } from "../app/preflight.ts";
import { compactionPlanReasonText } from "../app/steps/window.ts";
import type { EffectiveCompactionMode } from "../types.ts";
import {
  DASHBOARD_PAGE_SIZE,
  formatCurrentSession,
  formatMetricRun,
  formatMetricRunCompact,
  formatRecentRuns,
  formatRunDetails,
  isDashboardTitleLine,
  metricScore,
} from "./dashboard-format.ts";
import path from "node:path";
import { applyLoopOverrides, upsertLoopOverride } from "../utils/state.ts";
import {
  buildDashboardInsights, formatDashboardCanary, formatDashboardProviders,
  formatDashboardQuality, type DashboardInsights,
} from "./dashboard-insights.ts";

export function renderContextBar(theme: Theme, pct: number, tokens: number, barLen = 24): string {
  const clamped = Math.min(Math.max(pct, 0), 100);
  const filled = Math.min(barLen, Math.round((clamped / 100) * barLen));
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
  const color = clamped > 80 ? "error" : clamped > 50 ? "warning" : "success";
  // IMPORTANT: Do NOT destructure theme.fg into a local variable.
  // The Theme.fg() method uses `this.fgColors` internally — destructuring
  // loses the `this` binding and causes "Cannot read properties of undefined (reading 'fgColors')".
  return theme.fg("text", "  Context: ") + theme.fg(color, bar) + theme.fg("text", " " + clamped + "%") + theme.fg("dim", " (" + (tokens ?? 0).toLocaleString() + "t)");
}


export function renderTokenBar(theme: Theme, before: number, after: number, label: string, barLen = 30): string {
  const ratio = before > 0 ? after / before : 0;
  const savedPct = Math.round((1 - ratio) * 100);
  const filled = Math.min(barLen, Math.round(ratio * barLen));
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
  const savedColor = savedPct >= 50 ? "success" : savedPct >= 25 ? "warning" : "error";
  return theme.fg("text", "  " + label + ": ") + theme.fg(savedColor, bar) + theme.fg("text", " " + (after ?? 0).toLocaleString() + "t") + theme.fg(savedColor, " (saved " + savedPct + "%)");
}

export async function selectModel(
  ctx: ExtensionCommandContext,
  opts: { contextTokens: number; contextPercent: number; activeModelLabel: string; defaultModelIndex: number },
): Promise<ModelOption | null> {
  const available = ctx.modelRegistry.getAvailable();
  const options: ModelOption[] = available.map(m => {
    // Mirror the provider caps table: known-tool-capable providers get
    // `true`, unknown ones get "probe" so exploration runtime-probes them
    // exactly once and caches the result on the per-run services container.
    const caps = getProviderCaps(m.provider);
    return {
      value: m.provider + "/" + m.id,
      label: m.provider + "/" + m.id + (m.contextWindow >= 200000 ? " (" + Math.round(m.contextWindow / 1000) + "K)" : ""),
      model: m,
      supportsTools: caps.supportsTools,
    };
  });
  const items: SelectItem[] = options.map((o, i) => ({
    value: "model:" + i,
    label: o.label,
    description: i === opts.defaultModelIndex ? "← selected summary route" : o.value === opts.activeModelLabel ? "active context model" : undefined,
  }));
  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const c = new Container();
    c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    c.addChild(new Text(theme.fg("accent", theme.bold("  Smart Compact — Advanced model")), 1, 0));
    c.addChild(new Text(theme.fg("dim", "  Architecture: EESV (Extract \u2192 Explore \u2192 Synthesize \u2192 Verify)"), 0, 0));
    c.addChild(new Text("", 0, 0));
    c.addChild(new Text(renderContextBar(theme, opts.contextPercent, opts.contextTokens), 0, 0));
    c.addChild(new Text(theme.fg("dim", "  Active context: " + opts.activeModelLabel), 0, 0));
    c.addChild(new Text(theme.fg("dim", "  Selected summary route: " + (options[opts.defaultModelIndex]?.value ?? "?")), 0, 0));
    c.addChild(new Text("", 0, 0));
    c.addChild(new Text(theme.fg("text", "  Select model for compaction:"), 1, 0));
    c.addChild(new Text("", 0, 0));
    const sel = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: t => theme.fg("accent", t),
      selectedText: t => theme.fg("accent", t),
      description: t => theme.fg("muted", t),
      scrollInfo: t => theme.fg("dim", t),
      noMatch: t => theme.fg("warning", t),
    });
    sel.setSelectedIndex(opts.defaultModelIndex);
    sel.onSelect = item => done(item.value);
    sel.onCancel = () => done(null);
    c.addChild(sel);
    c.addChild(new Text("", 0, 0));
    c.addChild(new Text(theme.fg("dim", "  \u2191\u2193 navigate \u2022 enter select \u2022 esc cancel"), 0, 0));
    c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (w: number) => c.render(w),
      invalidate: () => c.invalidate(),
      handleInput: (d: string) => { sel.handleInput(d); tui.requestRender(); },
    };
  });
  if (!result?.startsWith("model:")) return null;
  return options[parseInt(result.slice(6), 10)] ?? null;
}

const PRIMARY_MODES: EffectiveCompactionMode[] = ["fast", "balanced", "thorough"];
const MODE_LABELS: Record<EffectiveCompactionMode, string> = {
  fast: "Fast", balanced: "Balanced", thorough: "Thorough",
};
const MODE_COPY: Record<EffectiveCompactionMode, string> = {
  fast: "quickest · compact 10K recent tail · 3K summary",
  balanced: "default quality/speed · 20K recent tail · 6K summary",
  thorough: "deepest analysis · rich 30K recent tail · 10K summary",
};

export function explainPreflightReason(reason: ManualPreflight["reason"]): string {
  return reason === "not-enough-messages" ? "fewer than 3 active messages" : compactionPlanReasonText(reason);
}

function recommendationEvidence(preflight: ManualPreflight): string {
  const yieldPercent = Math.round((preflight.plan?.projectedYield ?? 0) * 100);
  const tail = preflight.plan?.retainedTokens ?? 0;
  return "~" + Math.round(preflight.contextPercent) + "% window pressure, ~" + yieldPercent + "% projected saving, ~" + tokenCount(tail) + " recent tail" +
    (preflight.toolPercent >= 70 ? "; tool-heavy shape (~" + preflight.toolPercent + "% tool-result text)" : "");
}

export function recommendPreflight(plans: ReadonlyMap<EffectiveCompactionMode, ManualPreflight>): {
  mode: EffectiveCompactionMode; reason: string;
} {
  const thorough = plans.get("thorough");
  const balanced = plans.get("balanced");
  const fast = plans.get("fast");
  if (thorough?.adapted && thorough.plan?.viable) {
    return { mode: "thorough", reason: "recent damage feedback favors richer retention; " + recommendationEvidence(thorough) };
  }
  if ((fast?.overflowedContext || (fast?.contextPercent ?? 0) >= 90) && fast?.plan?.viable) {
    return { mode: "fast", reason: "severe context pressure favors faster recovery; " + recommendationEvidence(fast) };
  }
  if (balanced?.plan?.viable) {
    return { mode: "balanced", reason: "normal pressure favors the default balance; " + recommendationEvidence(balanced) };
  }
  const fallback = (["fast", "thorough"] as const).find(mode => plans.get(mode)?.plan?.viable);
  if (fallback) {
    const chosen = plans.get(fallback)!;
    return {
      mode: fallback,
      reason: "Balanced is unavailable because " + explainPreflightReason(balanced?.reason ?? "not-enough-messages") + "; " + recommendationEvidence(chosen),
    };
  }
  return { mode: "balanced", reason: "no preset currently has a safe, useful window" };
}

function tokenCount(value: number): string { return Math.round(value).toLocaleString() + "t"; }
function compactTokenCount(value: number): string {
  if (Math.abs(value) < 1_000) return Math.round(value) + "t";
  const scaled = value / 1_000;
  return scaled.toFixed(scaled >= 10 ? 1 : 2).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1") + "K";
}
function percent(value: number): string { return Math.round(value).toLocaleString() + "%"; }

const SOFT_BOUNDARY_COPY: Record<string, string> = {
  "recent-user-turn": "older user turn",
  anchor: "latest checkpoint",
  topical: "adjacent topic",
  "context-anchor": "latest checkpoint",
  "topical-group": "adjacent topic",
};

/** Compact decision copy; technical planner data stays behind D. */
export function formatPreflightSummary(preflight: ManualPreflight, modelLabel: string, details = false): string[] {
  const plan = preflight.plan;
  if (!plan) {
    const lines = [
      "Plan unavailable · " + explainPreflightReason(preflight.reason),
      "✓ Complete tool pairs · ✓ zero-gap verification before apply",
    ];
    if (details) lines.push(
      "Estimator  messages ~" + tokenCount(preflight.rawEstimatedMessageTokens) + " · normalization unavailable",
      "Route  " + modelLabel + " · viability " + preflight.reason,
    );
    return lines;
  }
  const stateReserve = Math.ceil(plan.summaryBudgetTokens * POST_SUMMARY_RESERVE_RATIO);
  const lines = [
    "Plan  " + compactTokenCount(preflight.totalTokens) + " → ~" + compactTokenCount(plan.projectedAfterTokens) + " · ~" + compactTokenCount(plan.projectedSavedTokens) + " saved (" + percent(plan.projectedYield * 100) + ")",
    "Keep  ~" + compactTokenCount(plan.retainedTokens) + " recent · summary up to " + compactTokenCount(plan.summaryBudgetTokens) + " + ~" + compactTokenCount(stateReserve) + " verified-state reserve",
    "✓ Complete tool pairs · ✓ zero-gap verification before apply",
  ];
  if (!plan.viable) lines.unshift("Unavailable · " + explainPreflightReason(plan.reason));
  if (details) lines.push(
    "Target  ≤" + tokenCount(plan.targetAfterTokens) + " · tail ≤" + tokenCount(plan.retentionTargetTokens) + " · fixed ~" + tokenCount(plan.fixedContextTokens),
    "Estimator  ~" + tokenCount(preflight.rawEstimatedMessageTokens) + " messages · normalized ×" + preflight.estimatorScale.toFixed(2),
    "Boundary  " + (plan.hardBoundaryAdjusted ? "tool pair kept intact" : "no hard adjustment") + " · soft summarized: " + (plan.relaxedSoftBoundaries.map(kind => SOFT_BOUNDARY_COPY[kind] ?? kind).join(", ") || "none"),
    "Route  " + modelLabel + (preflight.adapted ? " · damage feedback " + preflight.damageMedian + "/100" : ""),
  );
  return lines;
}

const PROGRESS_KEY = "smart-compact-progress";
const PROGRESS_PHASES = ["Extract", "Explore", "Synthesize", "Verify", "Apply"];

export function showProgressOverlay(ctx: ExtensionContext, state: ProgressState): void {
  if (!ctx || ctx.hasUI === false) return;
  const name = PROGRESS_PHASES[state.phase - 1] ?? state.phaseName;
  try {
    ctx.ui.setStatus?.(PROGRESS_KEY, "Smart Compact " + state.phase + "/5 · " + name);
    ctx.ui.setWidget?.(PROGRESS_KEY, (_tui, theme) => ({
      render: (width: number) => {
        const story = PROGRESS_PHASES.map((phase, index) => {
          if (index === 1 && state.phase > 2 && !state.explorationRounds) return theme.fg("dim", "– Explore");
          if (index < state.phase - 1) return theme.fg("success", "✓ " + phase);
          if (index === state.phase - 1) return theme.fg("accent", theme.bold("● " + phase));
          return theme.fg("dim", "○ " + phase);
        }).join(theme.fg("dim", "  "));
        const safety = state.phase < 5 ? " · conversation unchanged" : "";
        return [
          truncateToWidth(story, width),
          truncateToWidth(theme.fg("muted", "↳ " + state.detail + safety), width),
        ];
      },
      invalidate: () => {},
    }), { placement: "belowEditor" });
  } catch { /* non-interactive UI adapters may not implement persistent UI */ }
}

export function clearCompactProgress(ctx: ExtensionContext): void {
  try {
    ctx.ui.setStatus?.(PROGRESS_KEY, undefined);
    ctx.ui.setWidget?.(PROGRESS_KEY, undefined);
  } catch { /* non-interactive UI adapter */ }
}

export function notifyAppliedCompaction(ctx: ExtensionContext, details: SmartCompactDetails, concise: boolean): void {
  const before = details.tokensBefore ?? 0;
  const after = details.estimatedAfterTokens ?? Math.max(0, before - details.tokensSaved);
  const saving = Math.round((details.estimatedYield ?? (before ? details.tokensSaved / before : 0)) * 100);
  const quality = details.qualityScore ?? 0;
  const initial = details.provenance?.initialScore ?? quality;
  const repaired = details.provenance && (details.provenance.deterministicPatched.length > 0 || details.provenance.llmPatched || details.provenance.qualityFloorUsed);
  const remainingGapCount = details.gaps?.length ?? 0;
  const verification = "verified " + quality + "/100 coverage" + (repaired ? " (source " + initial + "/100" + (details.provenance?.qualityFloorUsed ? ", safety fallback" : "") + ")" : "") + " · " + remainingGapCount + (remainingGapCount === 1 ? " remaining gap" : " remaining gaps");
  const fallback = details.generationFallbacks?.length
    ? " · fallback: " + details.generationFallbacks.join(", ")
    : details.method ? " · generation: " + details.method : "";
  const planned = details.plannedAfterTokens ?? after;
  ctx.ui.notify(concise
    ? "Smart compact applied · " + before.toLocaleString() + "t → ~" + after.toLocaleString() + "t estimate (plan ~" + planned.toLocaleString() + "t) · " + saving + "% saved · " + verification + fallback
    : "Smart compact applied — " + before.toLocaleString() + "t → planned ~" + planned.toLocaleString() + "t / ~" + after.toLocaleString() + "t applied estimate · saved " + saving + "% · " + verification + fallback, "info");
}


// touched, which belongs to ExtensionContext.
export async function showResultScreen(
  ctx: ExtensionContext,
  details: SmartCompactDetails,
  extraction: StructuredExtraction,
  services: SmartCompactServices,
  opts: { approval?: boolean; summary?: string } = {},
): Promise<"apply" | "cancel" | "closed"> {
  const decision = await ctx.ui.custom<"apply" | "cancel" | "closed">((tui, theme, keybindings, done) => {
    const c = new Container();
    c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    c.addChild(new Text(theme.fg("accent", theme.bold(opts.approval ? "  \uD83D\uDD0E Smart Compact Review" : "  \u2705 Smart Compact Complete")), 1, 0));
    c.addChild(new Text("", 0, 0));

    const estimatedAfter = details.estimatedAfterTokens ?? (details.tokensBefore ?? 0) - (details.tokensSaved ?? 0);
    c.addChild(new Text(renderTokenBar(theme, details.tokensBefore, estimatedAfter, "Result  "), 0, 0));
    c.addChild(new Text(theme.fg("dim", "  Before: " + (details.tokensBefore ?? 0).toLocaleString() + "t \u2192 After: ~" + estimatedAfter.toLocaleString() + "t \u2192 Saved: " + (details.tokensSaved ?? 0).toLocaleString() + "t"), 0, 0));
    c.addChild(new Text("", 0, 0));

    const methodColors: Record<string, import("@earendil-works/pi-coding-agent").ThemeColor> = { eesv: "accent", "single-pass": "success", heuristic: "warning" };
    const methodColor = methodColors[details.method] ?? "text";
    // Do NOT destructure theme.fg — it loses `this` binding (see renderContextBar).
    c.addChild(new Text(
      theme.fg("text", "  Method: ") +
      theme.fg(methodColor, details.method.toUpperCase()) +
      theme.fg("dim", " \u2022 " + details.llmCalls + " LLM call(s) \u2022 Mode: " + (details.mode ?? details.profile)),
      0, 0));
    if (details.model) {
      c.addChild(new Text(theme.fg("dim", "  Model: " + details.model), 0, 0));
    }
    if (details.providerRoutes) {
      c.addChild(new Text(theme.fg("dim", "  Routes: Explore " + details.providerRoutes.explore + " • Synthesize " + details.providerRoutes.synthesize + " • Verify " + details.providerRoutes.verify), 0, 0));
    }

    const scoreColor = details.qualityScore >= 80 ? "success" : details.qualityScore >= 50 ? "warning" : "error";
    c.addChild(new Text(theme.fg("text", "  Verification coverage: ") + theme.fg(scoreColor, details.qualityScore + "/100"), 0, 0));
    if (details.provenance) {
      const provenance = details.provenance;
      c.addChild(new Text(
        theme.fg("dim", "  Provenance: source " + provenance.initialScore + " → deterministic " + provenance.deterministicPatched.length +
          (provenance.llmPatched ? " → LLM patch" : "") + " → verified " + provenance.finalScore +
          " (" + provenance.remainingGaps.length + " remaining)"),
        0, 0,
      ));
      if (provenance.qualityFloorUsed) {
        c.addChild(new Text(theme.fg("warning", "  Safety fallback used · verified coverage is not raw synthesis quality"), 0, 0));
      }
    }
    if (details.generationFallbacks?.length) {
      c.addChild(new Text(theme.fg("warning", "  Generation fallback: " + details.generationFallbacks.join(", ")), 0, 0));
    }
    if ((details.redactions ?? 0) > 0) {
      c.addChild(new Text(theme.fg("warning", "  Security: " + details.redactions + " sensitive value(s) redacted"), 0, 0));
    }
    c.addChild(new Text("", 0, 0));

    c.addChild(new Text(theme.fg("text", theme.bold("  \uD83D\uDCCB Extraction")), 0, 0));
    const ms = getMetricsSummary(services);
    const ecs = getExtractionCacheStats(services);
    if (ms.totalCalls > 0) {
      const providerCachePct = Math.round(ms.cacheHitRate * 100);
      const extractionCachePct = Math.round(ecs.hitRate * 100);
      const promptInput = effectivePromptInputTokens(ms.totalInput, ms.totalCacheHit, ms.totalCacheWrite);
      const inputLabel = ms.totalCacheHit > 0
        ? promptInput.toLocaleString() + "t prompt (" + ms.totalInput.toLocaleString() + "t new, " + ms.totalCacheHit.toLocaleString() + "t cached)"
        : ms.totalInput.toLocaleString() + "t in";
      const cacheColor = extractionCachePct >= 50 ? "success" : extractionCachePct >= 20 ? "warning" : "dim";
      c.addChild(new Text(
        theme.fg("dim", "  LLM: ") +
        theme.fg("text", ms.totalCalls + " calls") +
        theme.fg("dim", " \u2022 ") +
        theme.fg("text", inputLabel) +
        theme.fg("dim", " \u2022 ") +
        theme.fg("dim", providerCachePct + "% provider cache") +
        theme.fg("dim", " \u2022 ") +
        theme.fg(cacheColor, extractionCachePct + "% extraction cache") +
        theme.fg("dim", " \u2022 ") +
        theme.fg("dim", ms.avgLatency + "ms avg"),
      0, 0));
    }
    const modFiles = details.modifiedFiles;
    const errCount = extraction.errors.length;
    const resolvedErr = extraction.errors.filter(e => e.resolved).length;
    const unresolvedErr = errCount - resolvedErr;
    c.addChild(new Text(
      theme.fg("dim", "  Files: ") +
      theme.fg("success", modFiles.length + " modified") +
      theme.fg("dim", " \u2022 ") +
      theme.fg("text", details.readFiles.length + " read") +
      theme.fg("dim", " \u2022 ") +
      theme.fg("text", details.totalMessages + " messages"),
      0, 0));
    if (errCount > 0) {
      c.addChild(new Text(
        theme.fg("dim", "  Errors: ") +
        theme.fg("warning", errCount + " total") +
        theme.fg("dim", " \u2022 ") +
        theme.fg("success", resolvedErr + " resolved") +
        theme.fg("dim", " \u2022 ") +
        theme.fg("error", unresolvedErr + " unresolved"),
        0, 0));
    }
    if (extraction.decisions.length > 0) {
      const expD = extraction.decisions.filter(d => d.type === "explicit").length;
      const impD = extraction.decisions.filter(d => d.type === "implicit").length;
      c.addChild(new Text(theme.fg("dim", "  Decisions: " + extraction.decisions.length + " (" + expD + " explicit, " + impD + " implicit)"), 0, 0));
    }
    if (extraction.constraints.length > 0) {
      const reqC = extraction.constraints.filter(cc => cc.category === "requirement").length;
      const proC = extraction.constraints.filter(cc => cc.category === "prohibition").length;
      const preC = extraction.constraints.filter(cc => cc.category === "preference").length;
      c.addChild(new Text(theme.fg("dim", "  Constraints: " + extraction.constraints.length + " (" + reqC + " req, " + proC + " prohibit, " + preC + " pref)"), 0, 0));
    }
    c.addChild(new Text("", 0, 0));

    if (modFiles.length > 0) {
      c.addChild(new Text(theme.fg("text", theme.bold("  \uD83D\uDCC1 Modified Files")), 0, 0));
      const maxShow = 8;
      for (let i = 0; i < Math.min(modFiles.length, maxShow); i++) {
        const f = modFiles[i];
        const fc = extraction.modifiedFiles.find(e => e.path === f);
        const count = fc ? " (" + fc.toolCalls + "x)" : "";
        c.addChild(new Text(theme.fg("success", "    \u270E ") + theme.fg("text", path.basename(f)) + theme.fg("dim", count + " \u2192 " + f), 0, 0));
      }
      if (modFiles.length > maxShow) {
        c.addChild(new Text(theme.fg("dim", "    + " + (modFiles.length - maxShow) + " more"), 0, 0));
      }
      c.addChild(new Text("", 0, 0));
    }

    if (details.topics.length > 0) {
      c.addChild(new Text(theme.fg("text", theme.bold("  \uD83D\uDCE6 Topics")), 0, 0));
      const maxTopics = 10;
      for (let i = 0; i < Math.min(details.topics.length, maxTopics); i++) {
        c.addChild(new Text(theme.fg("dim", "    " + (i + 1) + ". " + details.topics[i]), 0, 0));
      }
      if (details.topics.length > maxTopics) {
        c.addChild(new Text(theme.fg("dim", "    + " + (details.topics.length - maxTopics) + " more"), 0, 0));
      }
      c.addChild(new Text("", 0, 0));
    }

    c.addChild(new Text(theme.fg("text", theme.bold("  \uD83D\uDD0D Verification")), 0, 0));
    if (details.verified) {
      c.addChild(new Text(theme.fg("success", "    All configured deterministic checks passed"), 0, 0));
    } else if (details.gaps.length > 0) {
      c.addChild(new Text(theme.fg("warning", "    \u26A0\uFE0F  " + details.gaps.length + (details.gaps.length === 1 ? " gap patched:" : " gaps patched:")), 0, 0));
      for (const g of details.gaps.slice(0, TRUNC.RESULT_GAPS)) {
        c.addChild(new Text(theme.fg("dim", "      \u2022 " + g), 0, 0));
      }
    }
    c.addChild(new Text("", 0, 0));

    c.addChild(new Text(theme.fg("text", theme.bold("  \uD83D\uDD04 Pipeline")), 0, 0));
    const phase1Status = theme.fg("success", "\u2713");
    const phase2Status = details.explorationRounds > 0
      ? theme.fg("success", "✓ " + details.explorationRounds + " rounds")
      : theme.fg("dim", "not required");
    const phase2Bounds = details.explorationBoundaries > 0
      ? theme.fg("text", " (" + details.explorationBoundaries + " boundaries)")
      : theme.fg("dim", " (no model boundaries)");
    const phase4Status = details.verified
      ? theme.fg("success", "\u2713 verified")
      : details.gaps.length > 0
        ? theme.fg("warning", "\u2713 patched (" + details.gaps.length + " gaps)")
        : theme.fg("dim", "\u2014");
    c.addChild(new Text(theme.fg("dim", "    Phase 1 Extract: ") + phase1Status, 0, 0));
    c.addChild(new Text(theme.fg("dim", "    Phase 2 Explore: ") + phase2Status + phase2Bounds, 0, 0));
    c.addChild(new Text(theme.fg("dim", "    Phase 3 Synthesize: ") + theme.fg(details.generationFallbacks?.length ? "warning" : "success", (details.generationFallbacks?.length ? "fallback · " : "✓ ") + details.chunkCount + " chunks"), 0, 0));
    c.addChild(new Text(theme.fg("dim", "    Phase 4 Verify: ") + phase4Status, 0, 0));
    c.addChild(new Text("", 0, 0));

    if (details.backupPath) {
      c.addChild(new Text(theme.fg("dim", "  \uD83D\uDCBE Backup after apply: " + details.backupPath), 0, 0));
      c.addChild(new Text("", 0, 0));
    }

    if (opts.summary) {
      c.addChild(new Text(theme.fg("text", theme.bold("  Summary to apply")), 0, 0));
      c.addChild(new Text(theme.fg("text", opts.summary), 2, 0));
      c.addChild(new Text("", 0, 0));
    }

    const scroll = new ScrollView(c, {
      follow: "none",
      primary: true,
      overscroll: "contain",
      scrollbar: "auto",
      scrollbarStyle: text => theme.fg("borderMuted", text),
    });
    const footer = new Container();
    footer.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    footer.addChild(new Text(
      theme.fg("dim", opts.approval
        ? "  ↑↓/PgUp/PgDn scroll · [A] Apply · [C/Esc] Cancel"
        : "  ↑↓/PgUp/PgDn scroll · [Q/Esc] Close"),
      0,
      0,
    ));
    const root = new VStack([
      { component: scroll, basis: 0, grow: 1, minSize: 5 },
      { component: footer, basis: "auto", shrink: 0, minSize: 2 },
    ]);
    return Object.assign(root, {
      handleInput: (data: string) => {
        const page = Math.max(1, scroll.viewportHeight - 2);
        if (keybindings.matches(data, "tui.select.up")) scroll.scrollBy(-1);
        else if (keybindings.matches(data, "tui.select.down")) scroll.scrollBy(1);
        else if (keybindings.matches(data, "tui.select.pageUp")) scroll.scrollBy(-page);
        else if (keybindings.matches(data, "tui.select.pageDown")) scroll.scrollBy(page);
        else if (matchesKey(data, Key.home)) scroll.scrollToStart();
        else if (matchesKey(data, Key.end)) scroll.scrollToEnd();
        else if (opts.approval && matchesKey(data, "a")) return done("apply");
        else if (opts.approval && (matchesKey(data, "c") || keybindings.matches(data, "tui.select.cancel"))) return done("cancel");
        else if (!opts.approval && (matchesKey(data, "q") || keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.enter))) return done("closed");
        tui.requestRender();
      },
    });
  }, { overlay: true, overlayOptions: { width: "80%", anchor: "center", maxHeight: "85%" } });
  return decision;
}

type DashboardView = "menu" | "overview" | "quality" | "providers" | "canary" | "latest" | "session" | "recent";
type DashboardAction = "html" | null;

export async function showMetricsDashboardUI(
  ctx: ExtensionCommandContext,
  opts: { entries: CompactMetricsEntry[]; currentSessionId?: string; report: string; insights?: DashboardInsights },
): Promise<DashboardAction> {
  const entries = opts.entries;
  const latest = entries[entries.length - 1];
  const insights = opts.insights ?? buildDashboardInsights(entries);
  const currentRuns = opts.currentSessionId ? entries.filter(entry => entry.sessionId === opts.currentSessionId) : [];
  const hasQualityData = entries.some(entry =>
    Number.isFinite(entry.verificationScore) || Number.isFinite(entry.initialVerificationScore));
  const menuItems: Array<{ view?: DashboardView; action?: DashboardAction; label: string; desc: string }> = [
    { view: "overview", label: "Overview report", desc: entries.length + " run(s) · Data Confidence " + insights.confidence.score + "/100" },
    ...(hasQualityData
      ? [{ view: "quality" as const, label: "Quality & confidence", desc: "Verifier evidence, repair gain, and ≥85 trust target" }]
      : []),
    { view: "providers", label: "Provider routes", desc: insights.providers.length + " stage/provider/model comparison row(s)" },
    { view: "canary", label: "Canary vs stable", desc: insights.canary.decision.toUpperCase() + " · " + insights.canary.dataConfidence + "% canary confidence" },
    { view: "latest", label: "Latest run details", desc: latest ? formatMetricRunCompact(latest) : "No run recorded yet" },
    { view: "session", label: "Current session", desc: (opts.currentSessionId ?? "unknown") + " — " + currentRuns.length + " run(s)" },
    { view: "recent", label: "Recent runs", desc: "Last " + Math.min(entries.length, 30) + " run(s)" },
    { action: "html", label: "Write HTML dashboard", desc: "Generate ~/.pi/agent/.cache/smart-compact-report.html" },
  ];

  return await ctx.ui.custom<DashboardAction>((tui, theme, keybindings, done) => {
    let view: DashboardView = "menu";
    let selected = 0;
    let scroll = 0;

    const pageLines = (): string[] => {
      if (view === "overview") return opts.report.split("\n");
      if (view === "quality") return formatDashboardQuality(insights);
      if (view === "providers") return formatDashboardProviders(insights);
      if (view === "canary") return formatDashboardCanary(insights);
      if (view === "latest") return formatRunDetails(latest, "Latest run details");
      if (view === "session") return formatCurrentSession(entries, opts.currentSessionId);
      if (view === "recent") return formatRecentRuns(entries);
      return [];
    };

    const resetPage = (nextView: DashboardView): void => {
      view = nextView;
      scroll = 0;
    };

    const renderHeader = (width: number): string[] => [
      truncateToWidth(theme.fg("accent", theme.bold("  📊 Smart Compact Dashboard")) + theme.fg("dim", "  " + entries.length + " recorded run(s)"), width),
      truncateToWidth(
        theme.fg("dim", "  session: " + (opts.currentSessionId ?? "unknown"))
          + theme.fg("dim", latest && Number.isFinite(latest.verificationScore) ? " • latest score " + metricScore(latest) : "")
          + theme.fg(insights.confidence.targetMet ? "success" : "warning", " • Data Confidence " + insights.confidence.score + "/100")
          + (hasQualityData
            ? theme.fg(insights.quality.targetMet ? "success" : "warning", " • Quality " + insights.quality.healthScore + "/100")
            : theme.fg("dim", " • Quality unavailable")),
        width,
      ),
      truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width),
    ];

    return {
      render: (width: number) => {
        const lines = renderHeader(width);
        if (view === "menu") {
          lines.push(truncateToWidth(theme.fg("text", "  Choose what to inspect:"), width), "");
          for (let i = 0; i < menuItems.length; i++) {
            const item = menuItems[i];
            const active = i === selected;
            const prefix = active ? "  › " : "    ";
            const label = active ? theme.fg("accent", theme.bold(item.label)) : theme.fg("text", item.label);
            lines.push(truncateToWidth(prefix + label, width));
            lines.push(truncateToWidth("      " + theme.fg(active ? "muted" : "dim", item.desc), width));
          }
          lines.push("", truncateToWidth(theme.fg("dim", "  ↑↓ navigate • enter open • esc/q close"), width));
          return lines;
        }

        const content = pageLines();
        const available = DASHBOARD_PAGE_SIZE;
        const maxScroll = Math.max(0, content.length - available);
        if (scroll > maxScroll) scroll = maxScroll;
        for (const line of content.slice(scroll, scroll + available)) {
          const styled = isDashboardTitleLine(line)
            ? theme.fg("accent", theme.bold(line))
            : line.startsWith("-") ? theme.fg("dim", line) : theme.fg("text", line);
          lines.push(truncateToWidth("  " + styled, width));
        }
        if (content.length > available) {
          lines.push(truncateToWidth(theme.fg("dim", "  showing " + (scroll + 1) + "-" + Math.min(content.length, scroll + available) + " of " + content.length), width));
        }
        lines.push("", truncateToWidth(theme.fg("dim", "  ↑↓ scroll • pgup/pgdn page • home/end jump • b back • esc/q close"), width));
        return lines;
      },
      invalidate: () => {},
      handleInput: (data: string) => {
        if (keybindings.matches(data, "tui.select.cancel") || data === "q") { done(null); return; }
        if (view === "menu") {
          if (keybindings.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
          else if (keybindings.matches(data, "tui.select.down")) selected = Math.min(menuItems.length - 1, selected + 1);
          else if (keybindings.matches(data, "tui.select.confirm")) {
            const item = menuItems[selected];
            if (item.action) { done(item.action); return; }
            if (item.view) resetPage(item.view);
          }
        } else {
          const content = pageLines();
          const maxScroll = Math.max(0, content.length - DASHBOARD_PAGE_SIZE);
          if (data === "b" || matchesKey(data, Key.left)) resetPage("menu");
          else if (matchesKey(data, Key.home)) scroll = 0;
          else if (matchesKey(data, Key.end)) scroll = maxScroll;
          else if (keybindings.matches(data, "tui.select.pageUp")) scroll = Math.max(0, scroll - DASHBOARD_PAGE_SIZE);
          else if (keybindings.matches(data, "tui.select.pageDown")) scroll = Math.min(maxScroll, scroll + DASHBOARD_PAGE_SIZE);
          else if (keybindings.matches(data, "tui.select.up")) scroll = Math.max(0, scroll - 1);
          else if (keybindings.matches(data, "tui.select.down")) scroll = Math.min(maxScroll, scroll + 1);
        }
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: "80%", anchor: "center", maxHeight: "85%" } });
}

export async function showCompactUI(
  ctx: ExtensionCommandContext,
  opts: { contextTokens: number; contextPercent: number; activeModelLabel: string; defaultModelIndex: number; config: CompactConfig },
): Promise<{ model: ModelOption; mode: CompactionMode } | null> {
  const available = ctx.modelRegistry.getAvailable();
  const asOption = (model: Model<Api>): ModelOption => ({
    value: model.provider + "/" + model.id,
    label: model.provider + "/" + model.id,
    model,
    supportsTools: getProviderCaps(model.provider).supportsTools,
  });
  const initialModel = available[opts.defaultModelIndex] ?? available[0];
  if (!initialModel) return null;
  let selectedModel = asOption(initialModel);
  const calibration = createProductionServices().tokenCalibration;
  const damageMedian = preflightDamageMedian(ctx.cwd, opts.config);

  while (true) {
    const shared = prepareManualPreflightContext(ctx, selectedModel.model, calibration);
    const plans = new Map(PRIMARY_MODES.map(mode => [
      mode,
      planManualPreflight(ctx, selectedModel.model, mode, calibration, opts.config, damageMedian, shared),
    ]));
    const recommended = recommendPreflight(plans);
    const action = await ctx.ui.custom<EffectiveCompactionMode | "model" | null>((tui, theme, keybindings, done) => {
      let selected = Math.max(0, PRIMARY_MODES.indexOf(recommended.mode));
      let details = false;
      let feedback = "";
      return {
        render: (width: number) => {
          const inner = Math.max(1, width - 2);
          const border = (text: string) => theme.fg("borderMuted", text);
          const fit = (text: string, max = inner) => truncateToWidth(text, Math.max(0, max), "");
          const fill = (text: string) => {
            const clipped = fit(text);
            return clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
          };
          const cell = (text = "") => border("│") + fill(text) + border("│");
          const divider = border("├" + "─".repeat(inner) + "┤");
          const title = fit(" Smart Compact ", Math.max(0, inner - 1));
          const top = border("╭─") + theme.fg("accent", theme.bold(title)) +
            border("─".repeat(Math.max(0, inner - 1 - visibleWidth(title))) + "╮");
          const bottom = border("╰" + "─".repeat(inner) + "╯");
          const selectedMode = PRIMARY_MODES[selected];
          const current = plans.get(selectedMode)!;
          const contextWindow = current.contextWindowTokens;
          const contextPct = Math.round(current.contextPercent);
          const barLength = width >= 72 ? 14 : 8;
          const barFilled = Math.min(barLength, Math.round(Math.min(100, contextPct) / 100 * barLength));
          const contextBar = theme.fg(contextPct >= 90 ? "error" : contextPct >= 70 ? "warning" : "success", "█".repeat(barFilled)) +
            theme.fg("dim", "░".repeat(barLength - barFilled));
          const modelPrefix = "  Summary model  ";
          const modelAction = theme.fg("accent", "  [M] Change");
          const modelWidth = Math.max(1, inner - visibleWidth(modelPrefix) - visibleWidth(modelAction));
          const lines = [
            top,
            cell("  Context  " + compactTokenCount(opts.contextTokens) + " / " + compactTokenCount(contextWindow) + "  " + contextBar + "  " + contextPct + "%"),
            cell(theme.fg("dim", modelPrefix) + fit(selectedModel.label, modelWidth) + modelAction),
            divider,
          ];

          for (let index = 0; index < PRIMARY_MODES.length; index++) {
            const mode = PRIMARY_MODES[index];
            const preview = plans.get(mode)!;
            const plan = preview.plan;
            const viable = plan?.viable ?? false;
            const marker = index === selected ? "› " : "  ";
            const recommendedMark = mode === recommended.mode ? "  recommended" : "             ";
            const trait = mode === "fast" ? "quickest" : mode === "balanced" ? "default" : "deepest";
            const stats = (viable && plan
              ? "~" + compactTokenCount(plan.projectedAfterTokens) + " after · " + percent(plan.projectedYield * 100) + " saved"
              : "unavailable · " + explainPreflightReason(preview.reason)) + " · " + trait;
            const line = " " + marker + MODE_LABELS[mode].padEnd(9) + recommendedMark + "  " + stats;
            lines.push(cell(index === selected
              ? theme.fg("accent", theme.bold(line))
              : theme.fg(viable ? mode === recommended.mode ? "success" : "text" : "muted", line)));
          }

          lines.push(divider);
          for (const line of formatPreflightSummary(current, selectedModel.value, details)) {
            const color = line.startsWith("Unavailable") || line.startsWith("Plan unavailable") ? "warning" : line.startsWith("✓") ? "success" : "text";
            lines.push(cell("  " + theme.fg(color, line)));
          }
          if (details) lines.push(cell("  " + theme.fg("dim", MODE_LABELS[selectedMode] + " · " + MODE_COPY[selectedMode])));
          if (feedback) lines.push(cell("  " + theme.fg("warning", feedback)));
          lines.push(
            divider,
            cell(theme.fg("dim", "  ↑↓ choose · Enter run · D details · M model · Esc cancel")),
            bottom,
          );
          return lines;
        },
        invalidate: () => {},
        handleInput: (data: string) => {
          if (keybindings.matches(data, "tui.select.cancel")) { done(null); return; }
          if (keybindings.matches(data, "tui.select.up")) {
            selected = (selected + PRIMARY_MODES.length - 1) % PRIMARY_MODES.length;
            feedback = "";
          } else if (keybindings.matches(data, "tui.select.down")) {
            selected = (selected + 1) % PRIMARY_MODES.length;
            feedback = "";
          } else if (keybindings.matches(data, "tui.select.confirm")) {
            const mode = PRIMARY_MODES[selected];
            const preview = plans.get(mode)!;
            if (preview.plan?.viable) { done(mode); return; }
            feedback = "Unavailable: " + explainPreflightReason(preview.reason) + ". Choose another mode or model.";
          } else if (data.toLowerCase() === "d") feedback = "", details = !details;
          else if (data.toLowerCase() === "m") { done("model"); return; }
          tui.requestRender();
        },
      };
    }, { overlay: true, overlayOptions: { width: "68%", minWidth: 52, anchor: "center", maxHeight: "85%" } });

    if (!action) return null;
    if (action === "model") {
      const modelIndex = available.findIndex(model => model.provider === selectedModel.model.provider && model.id === selectedModel.model.id);
      const next = await selectModel(ctx, { ...opts, defaultModelIndex: Math.max(0, modelIndex) });
      if (next) selectedModel = next;
      continue;
    }
    return { model: selectedModel, mode: action };
  }
}

/** Picker for `/smart-compact restore` — list backups, return the chosen path. */
export async function showRestorePicker(
  ctx: ExtensionCommandContext,
  backups: BackupEntry[],
): Promise<string | null> {
  const items: SelectItem[] = backups.map(b => ({
    value: b.path,
    label: new Date(b.date).toLocaleString() + "  \u00b7  " + Math.max(1, Math.round(b.sizeBytes / 1024)) + "KB",
    description: b.sessionId.slice(0, TRUNC.SESSION_ID_DISPLAY),
  }));
  return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const c = new Container();
    c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    c.addChild(new Text(theme.fg("accent", theme.bold("  \u21a9 Smart Compact \u2014 Restore")), 1, 0));
    c.addChild(new Text(theme.fg("dim", "  Pick a backup to view its pre-compaction content"), 0, 0));
    c.addChild(new Text("", 0, 0));
    const sel = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: t => theme.fg("accent", t),
      selectedText: t => theme.fg("accent", t),
      description: t => theme.fg("muted", t),
      scrollInfo: t => theme.fg("dim", t),
      noMatch: t => theme.fg("warning", t),
    });
    sel.onSelect = item => done(item.value);
    sel.onCancel = () => done(null);
    c.addChild(sel);
    c.addChild(new Text("", 0, 0));
    c.addChild(new Text(theme.fg("dim", "  \u2191\u2193 navigate \u00b7 enter view \u00b7 esc cancel"), 0, 0));
    c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (w: number) => c.render(w),
      invalidate: () => c.invalidate(),
      handleInput: (d: string) => { sel.handleInput(d); tui.requestRender(); },
    };
  });
}

export async function showOpenLoopsUI(
  ctx: ExtensionCommandContext,
  sourceLoops: OpenLoop[],
  initialOverrides: LoopOverride[] = [],
): Promise<LoopOverride[] | null> {
  let overrides = initialOverrides.slice();
  let changed = false;
  while (true) {
    const loops = applyLoopOverrides(sourceLoops, overrides);
    const labels = loops.map((loop, index) =>
      (index + 1) + ". [" + loop.status + "/" + loop.priority + "] " + loop.summary.slice(0, TRUNC.TOPIC_LABEL),
    );
    const choice = await ctx.ui.select("Open loops", [...labels, "Done"]);
    if (!choice || choice === "Done") return changed ? overrides : null;
    const index = labels.indexOf(choice);
    const loop = loops[index];
    if (!loop) continue;
    const summaryKey = loop.summary.toLowerCase().replace(/\s+/g, " ").trim();
    const existing = overrides.find(item => item.summaryKey === summaryKey);
    const action = await ctx.ui.select("Manage: " + loop.summary.slice(0, 60), [
      loop.status === "resolved" ? "Reopen" : "Resolve",
      existing?.pinned ? "Unpin" : "Pin",
      "Set priority",
      "Back",
    ]);
    if (!action || action === "Back") continue;
    if (action === "Resolve" || action === "Reopen") {
      overrides = upsertLoopOverride(overrides, loop, { status: action === "Resolve" ? "resolved" : "open" });
    } else if (action === "Pin" || action === "Unpin") {
      overrides = upsertLoopOverride(overrides, loop, { pinned: action === "Pin" });
    } else if (action === "Set priority") {
      const priority = await ctx.ui.select("Priority", ["critical", "high", "normal", "low"]);
      if (priority) overrides = upsertLoopOverride(overrides, loop, { priority: priority as OpenLoop["priority"] });
      else continue;
    }
    changed = true;
  }
}

/** Scrollable viewer for a restored backup's content. */
export async function showBackupViewer(
  ctx: ExtensionCommandContext,
  content: string,
  fp: string,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    const lines = content.split("\n");
    const pageSize = 40;
    let scroll = 0;
    const maxScroll = Math.max(0, lines.length - pageSize);
    return {
      render: (w: number) => {
        const out: string[] = [
          truncateToWidth(theme.fg("accent", theme.bold("  \u21a9 Restored backup")) + theme.fg("dim", "  \u00b7  " + lines.length + " lines \u00b7 " + Math.max(1, Math.round(content.length / 1024)) + "KB"), w),
          truncateToWidth(theme.fg("dim", "  " + fp), w),
          truncateToWidth(theme.fg("borderMuted", "\u2500".repeat(Math.max(0, w))), w),
        ];
        for (const line of lines.slice(scroll, scroll + pageSize)) {
          out.push(truncateToWidth(theme.fg("text", line), w));
        }
        if (lines.length > pageSize) {
          out.push(truncateToWidth(theme.fg("dim", "  showing " + (scroll + 1) + "\u2013" + Math.min(lines.length, scroll + pageSize) + " of " + lines.length), w));
        }
        out.push("", truncateToWidth(theme.fg("dim", "  \u2191\u2193 scroll \u00b7 pgup/pgdn \u00b7 home/end \u00b7 esc/q close"), w));
        return out;
      },
      invalidate: () => {},
      handleInput: (data: string) => {
        if (keybindings.matches(data, "tui.select.cancel") || data === "q") { done(undefined); return; }
        if (matchesKey(data, Key.home)) scroll = 0;
        else if (matchesKey(data, Key.end)) scroll = maxScroll;
        else if (keybindings.matches(data, "tui.select.pageUp")) scroll = Math.max(0, scroll - pageSize);
        else if (keybindings.matches(data, "tui.select.pageDown")) scroll = Math.min(maxScroll, scroll + pageSize);
        else if (keybindings.matches(data, "tui.select.up")) scroll = Math.max(0, scroll - 1);
        else if (keybindings.matches(data, "tui.select.down")) scroll = Math.min(maxScroll, scroll + 1);
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: "85%", anchor: "center", maxHeight: "85%" } });
}

/** Action menu after a backup is picked: view its content or restore it. */
export async function showRestoreAction(
  ctx: ExtensionCommandContext,
  backupPath: string,
): Promise<"view" | "restore" | null> {
  const items: SelectItem[] = [
    { value: "view", label: "View content", description: "Read the pre-compaction conversation" },
    { value: "restore", label: "Restore into a new session", description: "Fork from here + inject this backup as context" },
  ];
  return await ctx.ui.custom<"view" | "restore" | null>((tui, theme, _kb, done) => {
    const c = new Container();
    c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    c.addChild(new Text(theme.fg("accent", theme.bold("  \u21a9 Restore action")), 1, 0));
    c.addChild(new Text(theme.fg("dim", "  " + backupPath), 0, 0));
    c.addChild(new Text("", 0, 0));
    const sel = new SelectList(items, 2, {
      selectedPrefix: t => theme.fg("accent", t),
      selectedText: t => theme.fg("accent", t),
      description: t => theme.fg("muted", t),
      scrollInfo: t => theme.fg("dim", t),
      noMatch: t => theme.fg("warning", t),
    });
    sel.onSelect = item => done(item.value as "view" | "restore");
    sel.onCancel = () => done(null);
    c.addChild(sel);
    c.addChild(new Text("", 0, 0));
    c.addChild(new Text(theme.fg("dim", "  \u2191\u2193 navigate \u00b7 enter select \u00b7 esc cancel"), 0, 0));
    c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (w: number) => c.render(w),
      invalidate: () => c.invalidate(),
      handleInput: (d: string) => { sel.handleInput(d); tui.requestRender(); },
    };
  });
}
