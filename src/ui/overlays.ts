/**
 * TUI overlays: model/profile selection, progress, result screen.
 */

import { notifyUser } from "../utils/issues.ts";
import type {
 ExtensionCommandContext,
 ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { POST_SUMMARY_RESERVE_RATIO, TRUNC } from "../constants.ts";
import {
 Container,
 Key,
 type KeyId,
 matchesKey,
 type SelectItem,
 SelectList,
 Text,
 truncateToWidth,
 visibleWidth,
 wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ModelFeasibility } from "../app/model-feasibility.ts";
import type {
 CompactConfig,
 CompactionMode,
 ModelOption,
 ProgressState,
 SmartCompactDetails,
 StructuredExtraction,
} from "../types.ts";
import {
 createProductionServices,
 type SmartCompactServices,
} from "../infra/services.ts";
import {
 effectivePromptInputTokens,
 getExtractionCacheStats,
 getMetricsSummary,
} from "../utils/cache.ts";
import { getProviderCaps } from "../utils/tokens.ts";
import {
 planManualPreflight,
 preflightDamageMedian,
 prepareManualPreflightContext,
 type ManualPreflight,
} from "../app/preflight.ts";
import { compactionPlanReasonText } from "../app/steps/window.ts";
import type { CompactionEngine, EffectiveCompactionMode } from "../types.ts";
import { loadConfig } from "../utils/config.ts";
import path from "node:path";

async function selectModel(
 ctx: ExtensionCommandContext,
 opts: {
  contextTokens: number;
  contextPercent: number;
  activeModelLabel: string;
  defaultModelIndex: number;
  feasibility?: ModelFeasibility;
  /** Mode highlighted in the picker; capacity is judged for this plan. */
  mode?: CompactionMode;
 },
): Promise<ModelOption | null> {
 const available = ctx.modelRegistry.getAvailable();
 const modeName = opts.mode
  ? ((MODE_LABELS as Record<string, string>)[opts.mode] ?? opts.mode)
  : undefined;
 const blocked = (model: Model<Api>): string | undefined => {
  const check = opts.feasibility?.(model, "summary", opts.mode);
  return check && !check.selectable ? check.reason ?? "not eligible" : undefined;
 };
 const options: ModelOption[] = available.map((m) => ({
  value: m.provider + "/" + m.id,
  label: m.provider + "/" + m.id,
  model: m,
  // Known-tool-capable providers get `true`; unknown ones get "probe" so
  // exploration runtime-probes them once per run.
  supportsTools: getProviderCaps(m.provider).supportsTools,
 }));
 const items: SelectItem[] = options.map((o, i) => ({
  value: "model:" + i,
  label: o.label,
  description: blocked(o.model)
   ? "unavailable"
   : compactTokenCount(o.model.contextWindow) + " window" + (i === opts.defaultModelIndex ? " · selected" : ""),
 }));
 const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
  const c = new Container();
  c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  c.addChild(
   new Text(theme.fg("accent", theme.bold("Choose summary model")), 1, 0),
  );
  c.addChild(
   new Text(
    theme.fg(
     "dim",
     "Writes the compaction summary. Active context: " +
     opts.activeModelLabel +
     " (unchanged) · " +
     compactTokenCount(opts.contextTokens) +
     ", " +
     Math.round(opts.contextPercent) +
     "% full",
    ),
    1,
    0,
   ),
  );
  c.addChild(new Text("", 0, 0));
  const sel = new SelectList(items, Math.min(items.length, 10), {
   selectedPrefix: (t) => theme.fg("accent", t),
   selectedText: (t) => theme.fg("accent", t),
   description: (t) => theme.fg("muted", t),
   scrollInfo: (t) => theme.fg("dim", t),
   noMatch: (t) => theme.fg("warning", t),
  });
  // Narrow terminals hide SelectList descriptions, so the highlighted
  // model's status and full ineligibility reason always get their own line.
  const detail = new Text("", 1, 0);
  const describe = (index: number, rejected = false) => {
   const option = options[index];
   if (!option) return detail.setText("");
   const reason = blocked(option.model);
   detail.setText(
    reason
     ? theme.fg(
      "warning",
      (rejected ? "Choose another model. " : "") +
      "Can't use" +
      (modeName ? " for " + modeName : "") +
      ": " +
      reason,
     )
     : theme.fg(
      "dim",
      option.value +
      " · " +
      compactTokenCount(option.model.contextWindow) +
      " window" +
      (opts.feasibility && modeName ? " · fits the " + modeName + " plan" : ""),
     ),
   );
  };
  const indexOf = (item: SelectItem) => parseInt(item.value.slice(6), 10);
  sel.setSelectedIndex(opts.defaultModelIndex);
  describe(opts.defaultModelIndex);
  sel.onSelectionChange = (item) => describe(indexOf(item));
  // Ineligible models stay visible with their reason but cannot be chosen.
  sel.onSelect = (item) => {
   const option = options[indexOf(item)];
   if (option && !blocked(option.model)) return done(item.value);
   describe(indexOf(item), true);
   tui.requestRender();
  };
  sel.onCancel = () => done(null);
  c.addChild(sel);
  c.addChild(detail);
  c.addChild(new Text("", 0, 0));
  c.addChild(
   new Text(theme.fg("dim", "↑↓ choose · Enter use model · Esc back"), 1, 0),
  );
  c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  return {
   render: (w: number) => c.render(w),
   invalidate: () => c.invalidate(),
   handleInput: (d: string) => {
    sel.handleInput(d);
    tui.requestRender();
   },
  };
 });
 if (!result?.startsWith("model:")) return null;
 return options[parseInt(result.slice(6), 10)] ?? null;
}

const PRIMARY_MODES: EffectiveCompactionMode[] = [
 "fast",
 "balanced",
 "thorough",
];
const MODE_LABELS: Record<EffectiveCompactionMode, string> = {
 fast: "Fast",
 balanced: "Balanced",
 thorough: "Thorough",
};
/** Row-sized trait; the full tradeoff sentence shows for the highlighted mode. */
const MODE_TRAITS: Record<EffectiveCompactionMode, string> = {
 fast: "quickest",
 balanced: "default",
 thorough: "deepest",
};
const MODE_TRADEOFFS: Record<EffectiveCompactionMode, string> = {
 fast: "Less recent detail and a shorter summary.",
 balanced: "Balances speed and retained detail.",
 thorough: "Most recent detail and the longest summary; slowest.",
};

function explainPreflightReason(reason: ManualPreflight["reason"]): string {
 if (reason === "not-enough-messages" || reason === "no-eligible-prefix")
  return "not enough older history yet; continue chatting";
 return compactionPlanReasonText(reason);
}

function recommendationEvidence(preflight: ManualPreflight): string {
 const yieldPercent = Math.round((preflight.plan?.projectedYield ?? 0) * 100);
 const tail = preflight.plan?.retainedTokens ?? 0;
 return (
  "~" +
  Math.round(preflight.contextPercent) +
  "% window pressure, ~" +
  yieldPercent +
  "% projected saving, ~" +
  tokenCount(tail) +
  " recent tail" +
  (preflight.toolPercent >= 70
   ? "; tool-heavy shape (~" + preflight.toolPercent + "% tool-result text)"
   : "")
 );
}

export function recommendPreflight(
 plans: ReadonlyMap<EffectiveCompactionMode, ManualPreflight>,
): {
 mode: EffectiveCompactionMode;
 reason: string;
} {
 const thorough = plans.get("thorough");
 const balanced = plans.get("balanced");
 const fast = plans.get("fast");
 if (thorough?.adapted && thorough.plan?.viable) {
  return {
   mode: "thorough",
   reason:
    "recent damage feedback favors richer retention; " +
    recommendationEvidence(thorough),
  };
 }
 if (
  (fast?.overflowedContext || (fast?.contextPercent ?? 0) >= 90) &&
  fast?.plan?.viable
 ) {
  return {
   mode: "fast",
   reason:
    "severe context pressure favors faster recovery; " +
    recommendationEvidence(fast),
  };
 }
 if (balanced?.plan?.viable) {
  return {
   mode: "balanced",
   reason:
    "normal pressure favors the default balance; " +
    recommendationEvidence(balanced),
  };
 }
 const fallback = (["fast", "thorough"] as const).find(
  (mode) => plans.get(mode)?.plan?.viable,
 );
 if (fallback) {
  const chosen = plans.get(fallback)!;
  return {
   mode: fallback,
   reason:
    "Balanced is unavailable because " +
    explainPreflightReason(balanced?.reason ?? "not-enough-messages") +
    "; " +
    recommendationEvidence(chosen),
  };
 }
 return {
  mode: "balanced",
  reason: "no preset currently has a safe, useful window",
 };
}

function tokenCount(value: number): string {
 return Math.round(value).toLocaleString() + "t";
}
function compactTokenCount(value: number): string {
 if (Math.abs(value) < 1_000) return Math.round(value) + "t";
 const scaled = value / 1_000;
 return (
  scaled
   .toFixed(scaled >= 10 ? 1 : 2)
   .replace(/\.0+$|(\.\d*[1-9])0+$/, "$1") + "K"
 );
}
function percent(value: number): string {
 return Math.round(value).toLocaleString() + "%";
}

const SOFT_BOUNDARY_COPY: Record<string, string> = {
 "recent-user-turn": "older user turn",
 anchor: "latest checkpoint",
 topical: "adjacent topic",
 "context-anchor": "latest checkpoint",
 "topical-group": "adjacent topic",
};

/** Compact decision copy; technical planner data stays behind D. */
export function formatPreflightSummary(
 preflight: ManualPreflight,
 modelLabel: string,
 details = false,
 engines: readonly CompactionEngine[] = ["eesv"],
): string[] {
 const plan = preflight.plan;
 const safety = engines[0] === "native"
  ? "Provider compaction is not verified." + (engines.includes("eesv") ? " Fallback text is checked." : "")
  : "Summary is checked before it replaces history." + (engines.includes("native") ? " Provider fallback is not verified." : "");
 const lines = plan?.viable
  ? ["Estimated context after: ~" + compactTokenCount(plan.projectedAfterTokens) + " tokens.", safety]
  : ["Unavailable: " + explainPreflightReason(plan?.reason ?? preflight.reason) + ".", safety];
 if (!details) return lines;
 if (!plan) {
  lines.push(
   "Estimator  messages ~" + tokenCount(preflight.rawEstimatedMessageTokens) + " · normalization unavailable",
   "Route  " + modelLabel + " · viability " + preflight.reason,
  );
  return lines;
 }
 const stateReserve = Math.max(0,
  (plan.finalSummaryAllowanceTokens ?? plan.summaryBudgetTokens + Math.ceil(plan.summaryBudgetTokens * POST_SUMMARY_RESERVE_RATIO)) - plan.summaryBudgetTokens,
 );
 lines.push(
  "Plan  " + compactTokenCount(preflight.totalTokens) + " → ~" + compactTokenCount(plan.projectedAfterTokens) +
  " · ~" + compactTokenCount(plan.projectedSavedTokens) + " saved (" + percent(plan.projectedYield * 100) + ")",
  "Keep  ~" + compactTokenCount(plan.retainedTokens) + " recent · summary up to " +
  compactTokenCount(plan.summaryBudgetTokens) + " + ~" + compactTokenCount(stateReserve) + " verified-state reserve",
  "Target  ≤" + tokenCount(plan.targetAfterTokens) + " · tail ≤" + tokenCount(plan.retentionTargetTokens) + " · fixed ~" + tokenCount(plan.fixedContextTokens),
  "Estimator  ~" + tokenCount(preflight.rawEstimatedMessageTokens) + " messages · normalized ×" + preflight.estimatorScale.toFixed(2),
  "Boundary  " + (plan.hardBoundaryAdjusted ? "tool pair kept intact" : "no hard adjustment") +
  " · soft summarized: " + (plan.relaxedSoftBoundaries.map((kind) => SOFT_BOUNDARY_COPY[kind] ?? kind).join(", ") || "none"),
  "Route  " + modelLabel + (preflight.adapted ? " · damage feedback " + preflight.damageMedian + "/100" : ""),
 );
 return lines;
}

const PROGRESS_KEY = "smart-compact-progress";
const PROGRESS_PHASES = ["Extract", "Explore", "Synthesize", "Verify", "Apply"];

export function showProgressOverlay(
 ctx: ExtensionContext,
 state: ProgressState,
): void {
 if (!ctx || ctx.hasUI === false) return;
 try {
  // Progress lives in a transient widget below the editor, never the footer.
  ctx.ui.setWidget?.(
   PROGRESS_KEY,
   (_tui, theme) => ({
    render: (width: number) => {
     const story = PROGRESS_PHASES.map((phase, index) => {
      if (index === 1 && state.phase > 2 && !state.explorationRounds)
       return theme.fg("dim", "– Explore");
      if (index < state.phase - 1)
       return theme.fg("success", "✓ " + phase);
      if (index === state.phase - 1)
       return theme.fg("accent", theme.bold("● " + phase));
      return theme.fg("dim", "○ " + phase);
     }).join(theme.fg("dim", "  "));
     const safety = state.phase < 5 ? " · conversation unchanged" : "";
     return [
      truncateToWidth(story, width),
      truncateToWidth(
       theme.fg("muted", "↳ " + state.detail + safety),
       width,
      ),
     ];
    },
    invalidate: () => { },
   }),
   { placement: "belowEditor" },
  );
 } catch {
  /* non-interactive UI adapters may not implement persistent UI */
 }
}

export function clearCompactProgress(ctx: ExtensionContext): void {
 try {
  ctx.ui.setWidget?.(PROGRESS_KEY, undefined);
 } catch {
  /* non-interactive UI adapter */
 }
}

/** Native routes whose compaction window is opaque (readable only by that model). */
const OPAQUE_NATIVE_APIS = new Set(["openai-codex-responses", "openai-responses"]);

export function notifyNativeText(details: SmartCompactDetails): string {
 const before = details.tokensBefore ?? 0;
 const after =
  details.estimatedAfterTokens ?? Math.max(0, before - details.tokensSaved);
 return (
  "Compaction applied · native (" +
  details.model +
  ") · " +
  before.toLocaleString() +
  "t → ~" +
  after.toLocaleString() +
  "t estimate · provider state, not EESV-verified" +
  (OPAQUE_NATIVE_APIS.has(details.nativeApi ?? "")
   ? ". Other models see only the retained user messages; switch back to " +
   details.model +
   " to use the summary."
   : "")
 );
}

export function notifyAppliedCompaction(
 ctx: ExtensionContext,
 details: SmartCompactDetails,
 concise: boolean,
): void {
 if (details.method === "native") {
  notifyUser(ctx, notifyNativeText(details), "info");
  return;
 }
 const before = details.tokensBefore ?? 0;
 const after =
  details.estimatedAfterTokens ?? Math.max(0, before - details.tokensSaved);
 const saving = Math.round(
  (details.estimatedYield ?? (before ? details.tokensSaved / before : 0)) *
  100,
 );
 const quality = details.qualityScore ?? 0;
 const initial = details.provenance?.initialScore ?? quality;
 const repaired =
  details.provenance &&
  (details.provenance.deterministicPatched.length > 0 ||
   details.provenance.llmPatched ||
   details.provenance.qualityFloorUsed);
 const remainingGapCount = details.gaps?.length ?? 0;
 const verification =
  "verified " +
  quality +
  "/100 coverage" +
  (repaired
   ? " (source " +
   initial +
   "/100" +
   (details.provenance?.qualityFloorUsed ? ", safety fallback" : "") +
   ")"
   : "") +
  " · " +
  remainingGapCount +
  (remainingGapCount === 1 ? " remaining gap" : " remaining gaps");
 const fallback = details.generationFallbacks?.length
  ? " · fallback: " + details.generationFallbacks.join(", ")
  : details.method
   ? " · generation: " + details.method
   : "";
 const planned = details.plannedAfterTokens ?? after;
 notifyUser(ctx,
  concise
   ? "Smart compact applied · " +
   before.toLocaleString() +
   "t → ~" +
   after.toLocaleString() +
   "t estimate (plan ~" +
   planned.toLocaleString() +
   "t) · " +
   saving +
   "% saved · " +
   verification +
   fallback
   : "Smart compact applied — " +
   before.toLocaleString() +
   "t → planned ~" +
   planned.toLocaleString() +
   "t / ~" +
   after.toLocaleString() +
   "t applied estimate · saved " +
   saving +
   "% · " +
   verification +
   fallback,
  "info",
 );
}

/**
 * Review (approval) or completion screen. Outcome, warnings and the full summary
 * are always visible; engine, extraction and pipeline diagnostics sit behind D.
 */
export async function showResultScreen(
 ctx: ExtensionContext,
 details: SmartCompactDetails,
 extraction: StructuredExtraction,
 services: SmartCompactServices,
 opts: { approval?: boolean; summary?: string } = {},
): Promise<"apply" | "cancel" | "closed"> {
 const before = details.tokensBefore ?? 0;
 const after =
  details.estimatedAfterTokens ??
  Math.max(0, before - (details.tokensSaved ?? 0));
 const savedPercent = before > 0 ? Math.round((1 - after / before) * 100) : 0;
 const gaps = details.gaps;
 const provenance = details.provenance;
 const metrics = getMetricsSummary(services);
 const extractionCache = getExtractionCacheStats(services);
 return ctx.ui.custom<"apply" | "cancel" | "closed">(
  (tui, theme, keybindings, done) => {
   let showDetails = false;
   const body = new Container();
   const line = (text: string, color: ThemeColor = "dim") =>
    body.addChild(new Text(theme.fg(color, text), 2, 0));
   const heading = (text: string) =>
    body.addChild(new Text(theme.fg("accent", theme.bold(text)), 1, 0));
   const blank = () => body.addChild(new Text("", 0, 0));

   const addDetails = () => {
    blank();
    heading("Details");
    line(
     "Tokens  before " +
     tokenCount(before) +
     (details.plannedAfterTokens !== undefined
      ? " · planned after ~" + tokenCount(details.plannedAfterTokens)
      : "") +
     " · estimated after ~" +
     tokenCount(after) +
     " · saved " +
     tokenCount(details.tokensSaved ?? 0),
    );
    line(
     "Engine  " +
     details.method.toUpperCase() +
     " · " +
     details.llmCalls +
     " LLM call(s)",
    );
    if (details.providerRoutes)
     line(
      "Routes  explore " +
      details.providerRoutes.explore +
      " · synthesize " +
      details.providerRoutes.synthesize +
      " · verify " +
      details.providerRoutes.verify,
     );
    if (provenance)
     line(
      "Provenance  source " +
      provenance.initialScore +
      " → deterministic " +
      provenance.deterministicPatched.length +
      (provenance.llmPatched ? " → LLM patch" : "") +
      " → verified " +
      provenance.finalScore +
      " (" +
      provenance.remainingGaps.length +
      " remaining)",
     );
    if (metrics.totalCalls > 0) {
     const promptInput = effectivePromptInputTokens(
      metrics.totalInput,
      metrics.totalCacheHit,
      metrics.totalCacheWrite,
     );
     line(
      "LLM  " +
      metrics.totalCalls +
      " calls · " +
      (metrics.totalCacheHit > 0
       ? tokenCount(promptInput) +
       " prompt (" +
       tokenCount(metrics.totalInput) +
       " new, " +
       tokenCount(metrics.totalCacheHit) +
       " cached)"
       : tokenCount(metrics.totalInput) + " in") +
      " · " +
      Math.round(metrics.cacheHitRate * 100) +
      "% provider cache · " +
      Math.round(extractionCache.hitRate * 100) +
      "% extraction cache · " +
      metrics.avgLatency +
      "ms avg",
     );
    }
    line(
     "Files  " +
     details.modifiedFiles.length +
     " modified · " +
     details.readFiles.length +
     " read · " +
     details.totalMessages +
     " messages",
    );
    const resolvedErrors = extraction.errors.filter((e) => e.resolved).length;
    if (extraction.errors.length > 0)
     line(
      "Errors  " +
      extraction.errors.length +
      " total · " +
      resolvedErrors +
      " resolved · " +
      (extraction.errors.length - resolvedErrors) +
      " unresolved",
      extraction.errors.length > resolvedErrors ? "warning" : "dim",
     );
    if (extraction.decisions.length > 0) {
     const explicit = extraction.decisions.filter((d) => d.type === "explicit").length;
     line(
      "Decisions  " +
      extraction.decisions.length +
      " (" +
      explicit +
      " explicit, " +
      (extraction.decisions.length - explicit) +
      " implicit)",
     );
    }
    if (extraction.constraints.length > 0) {
     const count = (category: string) =>
      extraction.constraints.filter((cc) => cc.category === category).length;
     line(
      "Constraints  " +
      extraction.constraints.length +
      " (" +
      count("requirement") +
      " req, " +
      count("prohibition") +
      " prohibit, " +
      count("preference") +
      " pref)",
     );
    }
    if (details.modifiedFiles.length > 0) {
     blank();
     heading("Modified files");
     for (const file of details.modifiedFiles) {
      const tracked = extraction.modifiedFiles.find((e) => e.path === file);
      line(
       "✎ " +
       path.basename(file) +
       (tracked ? " (" + tracked.toolCalls + "x)" : "") +
       " → " +
       file,
      );
     }
    }
    if (details.topics.length > 0) {
     blank();
     heading("Topics");
     details.topics.forEach((topic, index) => line(index + 1 + ". " + topic));
    }
    blank();
    heading("Pipeline");
    line("Extract     ✓");
    line(
     "Explore     " +
     (details.explorationRounds > 0
      ? "✓ " + details.explorationRounds + " rounds"
      : "not required") +
     (details.explorationBoundaries > 0
      ? " (" + details.explorationBoundaries + " boundaries)"
      : " (no model boundaries)"),
    );
    line(
     "Synthesize  " +
     (details.generationFallbacks?.length ? "fallback · " : "✓ ") +
     details.chunkCount +
     " chunks",
     details.generationFallbacks?.length ? "warning" : "dim",
    );
    line(
     "Verify      " +
     (details.verified
      ? "✓ passed"
      : gaps.length > 0
       ? gaps.length + (gaps.length === 1 ? " gap remains" : " gaps remain")
       : "—"),
     details.verified ? "dim" : "warning",
    );
   };

   const build = () => {
    body.clear();
    heading(opts.approval ? "Review compaction" : "Compaction complete");
    if (opts.approval)
     line("Nothing changes until you press A. C or Esc keeps the conversation as it is.");
    blank();
    line(
     "Context  " +
     tokenCount(before) +
     " → ~" +
     tokenCount(after) +
     " · saves ~" +
     savedPercent +
     "% (estimate)",
     savedPercent >= 50 ? "success" : savedPercent >= 25 ? "warning" : "error",
    );
    // details.gaps are the gaps left after repair, not gaps that were patched.
    line(
     "Checks   " +
     (details.verified
      ? "✓ passed"
      : gaps.length > 0
       ? "⚠ " + gaps.length + (gaps.length === 1 ? " gap remains" : " gaps remain")
       : "not verified") +
     " · " +
     details.qualityScore +
     "/100 coverage",
     !details.verified
      ? "warning"
      : details.qualityScore >= 80
       ? "success"
       : details.qualityScore >= 50
        ? "warning"
        : "error",
    );
    const shownGaps = showDetails ? gaps.length : TRUNC.RESULT_GAPS;
    for (const gap of gaps.slice(0, shownGaps)) line("  • " + gap);
    if (gaps.length > shownGaps)
     line("  + " + (gaps.length - shownGaps) + " more (D details)");
    if (provenance?.qualityFloorUsed)
     line("⚠ Safety fallback used · coverage is not raw synthesis quality", "warning");
    if (details.generationFallbacks?.length)
     line("⚠ Generation fallback: " + details.generationFallbacks.join(", "), "warning");
    if ((details.redactions ?? 0) > 0)
     line("⚠ " + details.redactions + " sensitive value(s) redacted", "warning");
    line(
     "Model    " +
     [
      details.model,
      (details.mode ? MODE_LABELS[details.mode] : details.profile) + " mode",
      details.method,
     ]
      .filter(Boolean)
      .join(" · "),
    );
    if (details.backupPath) line("Backup after apply: " + details.backupPath);
    if (showDetails) addDetails();
    if (opts.summary) {
     blank();
     heading(opts.approval ? "Summary to apply" : "Summary");
     body.addChild(new Text(theme.fg("text", opts.summary), 2, 0));
    }
   };
   build();

   let offset = 0;
   let viewport = Number.MAX_SAFE_INTEGER;
   const rule = (width: number) => theme.fg("accent", "─".repeat(Math.max(1, width)));
   return {
    // Pi renders overlays without a height, so this screen sizes and scrolls
    // its own viewport against the same 85% cap as its overlay options.
    render: (width: number) => {
     const content = body.render(width);
     const keys =
      (opts.approval
       ? theme.fg("accent", theme.bold("A apply")) + theme.fg("dim", " · C/Esc cancel")
       : theme.fg("accent", theme.bold("Enter/Q/Esc close"))) +
      theme.fg("dim", " · D " + (showDetails ? "hide details" : "details"));
     const scrollKeys = theme.fg("dim", " · ↑↓ PgUp/PgDn scroll");
     const rows = tui.terminal?.rows;
     // Size with the longest footer so the viewport never outgrows the cap.
     const tallFooter = new Text(keys + scrollKeys, 1, 0).render(width);
     viewport = rows
      ? Math.max(3, Math.floor(rows * 0.85) - 3 - tallFooter.length)
      : Number.MAX_SAFE_INTEGER;
     const scrolls = content.length > viewport;
     offset = Math.max(0, Math.min(offset, content.length - viewport));
     const visible = content.slice(offset, offset + viewport);
     const position = scrolls
      ? " " + (offset + 1) + "–" + (offset + visible.length) + " of " + content.length + " "
      : "";
     const middle = scrolls
      ? truncateToWidth(
       rule(2) + theme.fg("dim", position) + rule(width - 2 - visibleWidth(position)),
       width,
       "",
      )
      : rule(width);
     return [
      rule(width),
      ...visible,
      middle,
      ...(scrolls ? tallFooter : new Text(keys, 1, 0).render(width)),
      rule(width),
     ];
    },
    invalidate: () => body.invalidate(),
    handleInput: (data: string) => {
     const page = Math.max(1, viewport - 2);
     if (keybindings.matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
     else if (keybindings.matches(data, "tui.select.down")) offset += 1;
     else if (keybindings.matches(data, "tui.select.pageUp"))
      offset = Math.max(0, offset - page);
     else if (keybindings.matches(data, "tui.select.pageDown")) offset += page;
     else if (matchesKey(data, Key.home)) offset = 0;
     else if (matchesKey(data, Key.end)) offset = Number.MAX_SAFE_INTEGER;
     else if (letterKey(data, "d")) {
      showDetails = !showDetails;
      build();
     }
     // Approval is explicit: only A applies; Enter never does.
     else if (opts.approval && letterKey(data, "a")) return done("apply");
     else if (
      opts.approval &&
      (letterKey(data, "c") ||
       keybindings.matches(data, "tui.select.cancel"))
     )
      return done("cancel");
     else if (
      !opts.approval &&
      (letterKey(data, "q") ||
       keybindings.matches(data, "tui.select.cancel") ||
       matchesKey(data, Key.enter))
     )
      return done("closed");
     tui.requestRender();
    },
   };
  },
  {
   overlay: true,
   overlayOptions: {
    width: "80%",
    minWidth: 60,
    anchor: "center",
    maxHeight: "85%",
   },
  },
 );
}

/** A letter shortcut, with or without Shift (legacy and Kitty keyboard protocols). */
function letterKey(data: string, letter: string): boolean {
 return matchesKey(data, letter as KeyId) || matchesKey(data, ("shift+" + letter) as KeyId);
}

export async function showCompactUI(
 ctx: ExtensionCommandContext,
 opts: {
  contextTokens: number;
  contextPercent: number;
  activeModelLabel: string;
  defaultModelIndex: number;
  config: CompactConfig;
  /** Capacity snapshot taken before the picker opens; absent = every model selectable. */
  feasibility?: ModelFeasibility;
  /** Shows local effective state; the picker reopens afterwards. */
  showEffectiveState?: () => Promise<void>;
 },
): Promise<{ model: ModelOption; mode: CompactionMode } | null> {
 const available = ctx.modelRegistry.getAvailable();
 const asOption = (model: Model<Api>): ModelOption => ({
  value: model.provider + "/" + model.id,
  label: model.provider + "/" + model.id,
  model,
  supportsTools: getProviderCaps(model.provider).supportsTools,
 });
 // Capacity depends on the planned requests, so it is judged per mode.
 const capacity = (model: Model<Api>, mode?: CompactionMode) =>
  opts.feasibility?.(model, "summary", mode) ?? { selectable: true };
 const usable = (model: Model<Api>) => PRIMARY_MODES.some((mode) => capacity(model, mode).selectable);
 let highlighted: EffectiveCompactionMode | undefined;
 // Start on the configured route when it is eligible, otherwise the first eligible model.
 const configured = available[opts.defaultModelIndex] ?? available[0];
 const initialModel = configured && usable(configured) ? configured : available.find(usable);
 if (!initialModel) return null;
 let selectedModel = asOption(initialModel);
 const calibration = createProductionServices().tokenCalibration;
 const damageMedian = preflightDamageMedian(ctx.cwd, opts.config);

 while (true) {
  const shared = prepareManualPreflightContext(
   ctx,
   selectedModel.model,
   calibration,
  );
  const plans = new Map(
   PRIMARY_MODES.map((mode) => [
    mode,
    planManualPreflight(
     ctx,
     selectedModel.model,
     mode,
     calibration,
     opts.config,
     damageMedian,
     shared,
    ),
   ]),
  );
  const recommended = recommendPreflight(plans);
  const engines = loadConfig().compactionEngines;
  const action = await ctx.ui.custom<
   EffectiveCompactionMode | "model" | "state" | null
  >(
   (tui, theme, keybindings, done) => {
    const fits = (mode: EffectiveCompactionMode) => capacity(selectedModel.model, mode).selectable;
    const preferred = highlighted ?? recommended.mode;
    let selected = Math.max(0, PRIMARY_MODES.indexOf(
     fits(preferred) ? preferred : PRIMARY_MODES.find(fits) ?? preferred,
    ));
    let details = false;
    let blockedEnter = false;
    // Plan-section paging for terminals too short to show it whole.
    let sectionOffset = 0;
    let sectionPage = 1;
    return {
     render: (width: number) => {
      const inner = Math.max(1, width - 2);
      const border = (text: string) => theme.fg("borderMuted", text);
      const cell = (text = "") => {
       const clipped = truncateToWidth(text, inner, "");
       return (
        border("│") +
        clipped +
        " ".repeat(Math.max(0, inner - visibleWidth(clipped))) +
        border("│")
       );
      };
      // Copy wraps inside the frame instead of clipping at narrow widths.
      const para = (text: string, color: ThemeColor, indent = 2) =>
       wrapTextWithAnsi(text, Math.max(1, inner - indent)).map((part) =>
        cell(" ".repeat(indent) + theme.fg(color, part)),
       );
      const divider = border("├" + "─".repeat(inner) + "┤");
      const title = truncateToWidth(" Smart Compact ", Math.max(0, inner - 1), "");
      const top =
       border("╭─") +
       theme.fg("accent", theme.bold(title)) +
       border(
        "─".repeat(Math.max(0, inner - 1 - visibleWidth(title))) + "╮",
       );
      const bottom = border("╰" + "─".repeat(inner) + "╯");
      const selectedMode = PRIMARY_MODES[selected];
      const modeName = MODE_LABELS[selectedMode];
      const current = plans.get(selectedMode)!;
      const check = capacity(selectedModel.model, selectedMode);
      const runnable = (current.plan?.viable ?? false) && check.selectable;
      const contextPct = Math.round(current.contextPercent);
      const barLength = inner >= 60 ? 14 : inner >= 40 ? 8 : 4;
      const barFilled = Math.min(
       barLength,
       Math.round((Math.min(100, contextPct) / 100) * barLength),
      );
      const contextBar =
       theme.fg(
        contextPct >= 90 ? "error" : contextPct >= 70 ? "warning" : "success",
        "█".repeat(barFilled),
       ) + theme.fg("dim", "░".repeat(barLength - barFilled));
      const modelText = "Summary model  " + selectedModel.label;
      const changeModel = "[M] Change";
      // Narrow frames move the model shortcut into the key line.
      const modelFits = visibleWidth(modelText + changeModel) + 4 <= inner;
      const head = [
       top,
       cell(
        "  Context  " +
        compactTokenCount(opts.contextTokens) +
        " / " +
        compactTokenCount(current.contextWindowTokens) +
        "  " +
        contextBar +
        " " +
        contextPct +
        "%",
       ),
       ...(modelFits
        ? [cell("  " + theme.fg("text", modelText) + "  " + theme.fg("accent", changeModel))]
        : para(modelText, "text")),
       divider,
      ];

      const modeRows = PRIMARY_MODES.flatMap((mode, index) => {
       const plan = plans.get(mode)!.plan;
       const fitsModel = fits(mode);
       const viable = (plan?.viable ?? false) && fitsModel;
       const outcome =
        (mode === recommended.mode ? "recommended · " : "") +
        (viable && plan
         ? percent(plan.projectedYield * 100) + " saved"
         : fitsModel
          ? "unavailable"
          : "too large for model");
       const color: ThemeColor =
        index === selected ? "accent" : !viable ? "muted" : mode === recommended.mode ? "success" : "text";
       const paint = (text: string) =>
        index === selected ? theme.fg(color, theme.bold(text)) : theme.fg(color, text);
       const bare = " " + (index === selected ? "› " : "  ") + MODE_LABELS[mode];
       // Prefer one aligned row; drop the trait, then wrap, as width shrinks.
       for (const left of [bare.padEnd(13) + MODE_TRAITS[mode], bare]) {
        const gap = inner - visibleWidth(left) - visibleWidth(outcome) - 1;
        if (gap >= 2) return [cell(paint(left + " ".repeat(gap) + outcome))];
       }
       return [cell(paint(bare)), ...para(outcome, color, 5)];
      });

      const tradeoff = para(
       modeName + " (" + MODE_TRAITS[selectedMode] + "): " + MODE_TRADEOFFS[selectedMode],
       "muted",
      );
      const essentials: string[] = [];
      if (!check.selectable)
       essentials.push(
        ...para(
         "Too large for this model: " +
         (check.reason ?? "the planned requests do not fit"),
         "warning",
        ),
       );
      if (blockedEnter)
       essentials.push(...para("Choose another mode or model.", "warning"));
      const brief = formatPreflightSummary(current, selectedModel.value, false, engines);
      const planLines = details
       ? formatPreflightSummary(current, selectedModel.value, true, engines)
       : brief;
      const summaryColor = (line: string): ThemeColor =>
       line.startsWith("Unavailable") || line.startsWith("Plan unavailable")
        ? "warning"
        : line.startsWith("✓")
         ? "success"
         : "text";
      for (const line of brief) essentials.push(...para(line, summaryColor(line)));
      essentials.push(...para("Estimates, not guarantees.", "dim"));
      for (const line of planLines.slice(brief.length))
       essentials.push(...para(line, "dim"));
      if (details)
       essentials.push(
        ...para(
         "Recommendation: " + MODE_LABELS[recommended.mode] + " — " + recommended.reason,
         "dim",
        ),
       );

      const foot = [
       divider,
       ...para(
        runnable
         ? "Enter  Compact with " + modeName
         : "Enter  Compact — unavailable for " + modeName,
        runnable ? "accent" : "muted",
        1,
       ),
       ...para(
        "↑↓ mode · " +
        (modelFits ? "" : "M model · ") +
        "D " +
        (details ? "hide details" : "details") +
        (opts.showEffectiveState ? " · S state" : "") +
        " · Esc back",
        "dim",
        1,
       ),
       bottom,
      ];
      // The overlay clips from the bottom: on short terminals drop the
      // tradeoff sentence first, then page the plan section — never the actions.
      const rows = tui.terminal?.rows;
      const room = rows
       ? Math.floor(rows * 0.85) - head.length - modeRows.length - foot.length - 1
       : Infinity;
      let section =
       tradeoff.length + essentials.length <= room ? [...tradeoff, ...essentials] : essentials;
      if (section.length > room) {
       sectionPage = Math.max(1, room - 1);
       sectionOffset = Math.max(0, Math.min(sectionOffset, section.length - sectionPage));
       const end = Math.min(section.length, sectionOffset + sectionPage);
       section = [
        ...section.slice(sectionOffset, end),
        cell(
         "  " +
         theme.fg(
          "dim",
          "… " + (sectionOffset + 1) + "–" + end + " of " + section.length + " · PgUp/PgDn",
         ),
        ),
       ];
      } else sectionOffset = 0;
      return [...head, ...modeRows, divider, ...section, ...foot];
     },
     invalidate: () => { },
     handleInput: (data: string) => {
      if (keybindings.matches(data, "tui.select.cancel")) {
       done(null);
       return;
      }
      if (keybindings.matches(data, "tui.select.up")) {
       selected =
        (selected + PRIMARY_MODES.length - 1) % PRIMARY_MODES.length;
       blockedEnter = false;
       sectionOffset = 0;
      } else if (keybindings.matches(data, "tui.select.down")) {
       selected = (selected + 1) % PRIMARY_MODES.length;
       blockedEnter = false;
       sectionOffset = 0;
      } else if (keybindings.matches(data, "tui.select.confirm")) {
       const mode = PRIMARY_MODES[selected];
       if (plans.get(mode)!.plan?.viable && fits(mode)) {
        done(mode);
        return;
       }
       blockedEnter = true;
       sectionOffset = 0;
      } else if (keybindings.matches(data, "tui.select.pageDown")) {
       sectionOffset += sectionPage;
      } else if (keybindings.matches(data, "tui.select.pageUp")) {
       sectionOffset = Math.max(0, sectionOffset - sectionPage);
      } else if (letterKey(data, "d")) {
       details = !details;
      } else if (letterKey(data, "m")) {
       highlighted = PRIMARY_MODES[selected];
       done("model");
       return;
      } else if (opts.showEffectiveState && letterKey(data, "s")) {
       done("state");
       return;
      }
      tui.requestRender();
     },
    };
   },
   {
    overlay: true,
    overlayOptions: {
     width: "70%",
     minWidth: 56,
     anchor: "center",
     maxHeight: "85%",
    },
   },
  );

  if (!action) return null;
  if (action === "state") {
   await opts.showEffectiveState?.();
   continue;
  }
  if (action === "model") {
   const modelIndex = available.findIndex(
    (model) =>
     model.provider === selectedModel.model.provider &&
     model.id === selectedModel.model.id,
   );
   const next = await selectModel(ctx, {
    ...opts,
    defaultModelIndex: Math.max(0, modelIndex),
    ...(highlighted ? { mode: highlighted } : {}),
   });
   if (next) selectedModel = next;
   continue;
  }
  return { model: selectedModel, mode: action };
 }
}

export {
 showBackupViewer,
 showRestoreAction,
 showRestorePicker,
} from "./backup-overlays.ts";
export { showOpenLoopsUI } from "./open-loops-overlay.ts";
