/**
 * TUI overlays: model/profile selection, progress, result screen.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Model, Api } from "@earendil-works/pi-ai";
import type {
  CompactMetricsEntry, CompressionProfile, ModelOption, ProgressState,
  SmartCompactDetails, StructuredExtraction,
} from "../types.ts";
import type { SmartCompactServices } from "../infra/services.ts";
import { effectivePromptInputTokens, getExtractionCacheStats, getMetricsSummary } from "../utils/cache.ts";
import { getProviderCaps } from "../utils/tokens.ts";
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

export function renderContextBar(theme: any, pct: number, tokens: number, barLen = 24): string {
  const clamped = Math.min(Math.max(pct, 0), 100);
  const filled = Math.min(barLen, Math.round((clamped / 100) * barLen));
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
  const color = clamped > 80 ? "error" : clamped > 50 ? "warning" : "success";
  // IMPORTANT: Do NOT destructure theme.fg into a local variable.
  // The Theme.fg() method uses `this.fgColors` internally — destructuring
  // loses the `this` binding and causes "Cannot read properties of undefined (reading 'fgColors')".
  return theme.fg("text", "  Context: ") + theme.fg(color, bar) + theme.fg("text", " " + clamped + "%") + theme.fg("dim", " (" + (tokens ?? 0).toLocaleString() + "t)");
}

export function renderTokenBar(theme: any, before: number, after: number, label: string, barLen = 30): string {
  const ratio = before > 0 ? after / before : 0;
  const savedPct = Math.round((1 - ratio) * 100);
  const filled = Math.min(barLen, Math.round(ratio * barLen));
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
  const savedColor = savedPct >= 50 ? "success" : savedPct >= 25 ? "warning" : "error";
  return theme.fg("text", "  " + label + ": ") + theme.fg(savedColor, bar) + theme.fg("text", " " + (after ?? 0).toLocaleString() + "t") + theme.fg(savedColor, " (saved " + savedPct + "%)");
}

export async function selectModel(
  ctx: ExtensionCommandContext,
  opts: { contextTokens: number; contextPercent: number; currentModel: string; defaultModelIndex: number },
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
    description: i === opts.defaultModelIndex ? "\u2190 session model" : undefined,
  }));
  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const c = new Container();
    c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    c.addChild(new Text(theme.fg("accent", theme.bold("  \uD83D\uDD0D Smart Compact \u2014 Step 1/2")), 1, 0));
    c.addChild(new Text(theme.fg("dim", "  Architecture: EESV (Extract \u2192 Explore \u2192 Synthesize \u2192 Verify)"), 0, 0));
    c.addChild(new Text("", 0, 0));
    c.addChild(new Text(renderContextBar(theme, opts.contextPercent, opts.contextTokens), 0, 0));
    c.addChild(new Text(theme.fg("dim", "  Session: " + opts.currentModel), 0, 0));
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

export async function selectProfile(
  ctx: ExtensionCommandContext,
  selectedModel: ModelOption,
  opts: { contextTokens: number; contextPercent: number },
): Promise<CompressionProfile | null> {
  const estAfter = (budget: number, keep: number) => budget + Math.min(opts.contextTokens, keep);
  const profiles: { value: CompressionProfile; label: string; desc: string; budget: number; keep: number }[] = [
    { value: "light", label: "\u2601\uFE0F  Light", desc: "Max detail", budget: 10000, keep: 30000 },
    { value: "balanced", label: "\u2696\uFE0F  Balanced", desc: "Recommended", budget: 6000, keep: 20000 },
    { value: "aggressive", label: "\uD83D\uDD25 Aggressive", desc: "Minimal", budget: 3000, keep: 10000 },
  ];
  const items: SelectItem[] = profiles.map(p => {
    const after = estAfter(p.budget, p.keep);
    const pct = opts.contextTokens > 0 ? Math.round((1 - after / opts.contextTokens) * 100) : 0;
    return { value: p.value, label: p.label, description: p.desc + " \u2014 est. ~" + after.toLocaleString() + "t after (save ~" + pct + "%)" };
  });
  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const c = new Container();
    c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    c.addChild(new Text(theme.fg("accent", theme.bold("  \uD83D\uDD0D Smart Compact \u2014 Step 2/2")), 1, 0));
    c.addChild(new Text("", 0, 0));
    c.addChild(new Text(theme.fg("dim", "  Model: " + selectedModel.label), 0, 0));
    c.addChild(new Text(renderContextBar(theme, opts.contextPercent, opts.contextTokens), 0, 0));
    c.addChild(new Text("", 0, 0));
    c.addChild(new Text(theme.fg("text", "  Select compression profile:"), 1, 0));
    c.addChild(new Text("", 0, 0));
    const sel = new SelectList(items, 3, {
      selectedPrefix: t => theme.fg("accent", t),
      selectedText: t => theme.fg("accent", t),
      description: t => theme.fg("muted", t),
      scrollInfo: t => theme.fg("dim", t),
      noMatch: t => theme.fg("warning", t),
    });
    sel.setSelectedIndex(1);
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
  if (!result) return null;
  return profiles.find(p => p.value === result)?.value ?? null;
}

export function showProgressOverlay(ctx: ExtensionCommandContext, state: ProgressState): void {
  const phaseNames = ["Extract", "Explore", "Synthesize", "Verify"];
  const progress = Math.round((state.phase / 4) * 100);
  const name = phaseNames[state.phase - 1] ?? "?";
  const detail = state.detail ? " (" + state.detail + ")" : "";
  ctx.ui.notify("EESV [" + progress + "%] Phase " + state.phase + "/4: " + name + detail, state.phase >= 4 ? "info" : "info");
}

export async function showResultScreen(
  ctx: ExtensionCommandContext,
  details: SmartCompactDetails,
  extraction: StructuredExtraction,
  services?: SmartCompactServices,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const c = new Container();
    c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    c.addChild(new Text(theme.fg("accent", theme.bold("  \u2705 Smart Compact Complete")), 1, 0));
    c.addChild(new Text("", 0, 0));

    const estimatedAfter = (details.tokensBefore ?? 0) - (details.tokensSaved ?? 0);
    c.addChild(new Text(renderTokenBar(theme, details.tokensBefore, estimatedAfter, "Result  "), 0, 0));
    c.addChild(new Text(theme.fg("dim", "  Before: " + (details.tokensBefore ?? 0).toLocaleString() + "t \u2192 After: ~" + estimatedAfter.toLocaleString() + "t \u2192 Saved: " + (details.tokensSaved ?? 0).toLocaleString() + "t"), 0, 0));
    c.addChild(new Text("", 0, 0));

    const methodColors: Record<string, import("@earendil-works/pi-coding-agent").ThemeColor> = { eesv: "accent", "single-pass": "success", heuristic: "warning" };
    const methodColor = methodColors[details.method] ?? "text";
    // Do NOT destructure theme.fg — it loses `this` binding (see renderContextBar).
    c.addChild(new Text(
      theme.fg("text", "  Method: ") +
      theme.fg(methodColor, details.method.toUpperCase()) +
      theme.fg("dim", " \u2022 " + details.llmCalls + " LLM call(s) \u2022 Profile: " + details.profile),
      0, 0));
    if (details.model) {
      c.addChild(new Text(theme.fg("dim", "  Model: " + details.model), 0, 0));
    }

    const scoreColor = details.qualityScore >= 80 ? "success" : details.qualityScore >= 50 ? "warning" : "error";
    c.addChild(new Text(theme.fg("text", "  Quality: ") + theme.fg(scoreColor, details.qualityScore + "/100"), 0, 0));
    c.addChild(new Text("", 0, 0));

    c.addChild(new Text(theme.fg("text", theme.bold("  \uD83D\uDCCB Extraction")), 0, 0));
    const ms = getMetricsSummary(services);
    const ecs = getExtractionCacheStats(services);
    if (ms.totalCalls > 0) {
      const providerCachePct = Math.round(ms.cacheHitRate * 100);
      const extractionCachePct = Math.round(ecs.hitRate * 100);
      const promptInput = effectivePromptInputTokens(ms.totalInput, ms.totalCacheHit);
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
      c.addChild(new Text(theme.fg("success", "    \u2705 All facts verified \u2014 no gaps detected"), 0, 0));
    } else if (details.gaps.length > 0) {
      c.addChild(new Text(theme.fg("warning", "    \u26A0\uFE0F  " + details.gaps.length + " gap(s) patched:"), 0, 0));
      for (const g of details.gaps.slice(0, 5)) {
        c.addChild(new Text(theme.fg("dim", "      \u2022 " + g), 0, 0));
      }
    }
    c.addChild(new Text("", 0, 0));

    c.addChild(new Text(theme.fg("text", theme.bold("  \uD83D\uDD04 Pipeline")), 0, 0));
    const phase1Status = theme.fg("success", "\u2713");
    const phase2Status = details.explorationRounds > 0
      ? theme.fg("success", "\u2713 " + details.explorationRounds + " rounds")
      : theme.fg("warning", "\u26A0 skipped");
    const phase2Bounds = details.explorationBoundaries > 0
      ? theme.fg("text", " (" + details.explorationBoundaries + " boundaries)")
      : theme.fg("dim", " (heuristic fallback)");
    const phase4Status = details.verified
      ? theme.fg("success", "\u2713 verified")
      : details.gaps.length > 0
        ? theme.fg("warning", "\u2713 patched (" + details.gaps.length + " gaps)")
        : theme.fg("dim", "\u2014");
    c.addChild(new Text(theme.fg("dim", "    Phase 1 Extract: ") + phase1Status, 0, 0));
    c.addChild(new Text(theme.fg("dim", "    Phase 2 Explore: ") + phase2Status + phase2Bounds, 0, 0));
    c.addChild(new Text(theme.fg("dim", "    Phase 3 Synthesize: ") + theme.fg("success", "\u2713 " + details.chunkCount + " chunks"), 0, 0));
    c.addChild(new Text(theme.fg("dim", "    Phase 4 Verify: ") + phase4Status, 0, 0));
    c.addChild(new Text("", 0, 0));

    if (details.backupPath) {
      c.addChild(new Text(theme.fg("dim", "  \uD83D\uDCBE Backup: " + details.backupPath), 0, 0));
      c.addChild(new Text("", 0, 0));
    }

    c.addChild(new Text(theme.fg("dim", "  Press any key to close"), 0, 0));
    c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w: number) => c.render(w),
      invalidate: () => c.invalidate(),
      handleInput: (_d: string) => done(undefined),
    };
  }, { overlay: true, overlayOptions: { width: "70%", anchor: "center", maxHeight: "80%" } });
}

type DashboardView = "menu" | "overview" | "latest" | "session" | "recent";
type DashboardAction = "html" | null;

export async function showMetricsDashboardUI(
  ctx: ExtensionCommandContext,
  opts: { entries: CompactMetricsEntry[]; currentSessionId?: string; report: string },
): Promise<DashboardAction> {
  const entries = opts.entries;
  const latest = entries[entries.length - 1];
  const currentRuns = opts.currentSessionId ? entries.filter(entry => entry.sessionId === opts.currentSessionId) : [];
  const menuItems: Array<{ view?: DashboardView; action?: DashboardAction; label: string; desc: string }> = [
    { view: "overview", label: "Overview report", desc: entries.length + " recent run(s), profile/provider comparison" },
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
      truncateToWidth(theme.fg("dim", "  session: " + (opts.currentSessionId ?? "unknown")) + theme.fg("dim", latest ? " • latest score " + metricScore(latest) : ""), width),
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
  opts: { contextTokens: number; contextPercent: number; currentModel: string; defaultModelIndex: number },
): Promise<{ model: ModelOption; profile: CompressionProfile } | null> {
  const selectedModel = await selectModel(ctx, opts);
  if (!selectedModel) return null;
  const selectedProfile = await selectProfile(ctx, selectedModel, { contextTokens: opts.contextTokens, contextPercent: opts.contextPercent });
  if (!selectedProfile) return null;
  return { model: selectedModel, profile: selectedProfile };
}
