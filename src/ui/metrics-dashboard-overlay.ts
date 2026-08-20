import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { CompactMetricsEntry } from "../types.ts";
import {
  DASHBOARD_PAGE_SIZE,
  formatCurrentSession,
  formatMetricRunCompact,
  formatRecentRuns,
  formatRunDetails,
  isDashboardTitleLine,
  metricScore,
} from "./dashboard-format.ts";
import {
  buildDashboardInsights,
  formatDashboardCanary,
  formatDashboardProviders,
  formatDashboardQuality,
  type DashboardInsights,
} from "./dashboard-insights.ts";

type DashboardView =
  | "menu"
  | "overview"
  | "quality"
  | "providers"
  | "canary"
  | "latest"
  | "session"
  | "recent";
type DashboardAction = "html" | null;

interface DashboardMenuItem {
  view?: DashboardView;
  action?: DashboardAction;
  label: string;
  desc: string;
}

export async function showMetricsDashboardUI(
  ctx: ExtensionCommandContext,
  opts: {
    entries: CompactMetricsEntry[];
    currentSessionId?: string;
    report: string;
    insights?: DashboardInsights;
  },
): Promise<DashboardAction> {
  const entries = opts.entries;
  const latest = entries.at(-1);
  const insights = opts.insights ?? buildDashboardInsights(entries);
  const currentRuns = opts.currentSessionId
    ? entries.filter((entry) => entry.sessionId === opts.currentSessionId)
    : [];
  const hasQualityData = entries.some(
    (entry) =>
      Number.isFinite(entry.verificationScore) ||
      Number.isFinite(entry.initialVerificationScore),
  );
  const menuItems: DashboardMenuItem[] = [
    {
      view: "overview",
      label: "Overview report",
      desc:
        entries.length +
        " run(s) · Data Confidence " +
        insights.confidence.score +
        "/100",
    },
    ...(hasQualityData
      ? [
          {
            view: "quality" as const,
            label: "Quality & confidence",
            desc: "Verifier evidence, repair gain, and ≥85 trust target",
          },
        ]
      : []),
    {
      view: "providers",
      label: "Provider routes",
      desc:
        insights.providers.length + " stage/provider/model comparison row(s)",
    },
    {
      view: "canary",
      label: "Canary vs stable",
      desc:
        insights.canary.decision.toUpperCase() +
        " · " +
        insights.canary.dataConfidence +
        "% canary confidence",
    },
    {
      view: "latest",
      label: "Latest run details",
      desc: latest ? formatMetricRunCompact(latest) : "No run recorded yet",
    },
    {
      view: "session",
      label: "Current session",
      desc:
        (opts.currentSessionId ?? "unknown") +
        " — " +
        currentRuns.length +
        " run(s)",
    },
    {
      view: "recent",
      label: "Recent runs",
      desc: "Last " + Math.min(entries.length, 30) + " run(s)",
    },
    {
      action: "html",
      label: "Write HTML dashboard",
      desc: "Generate ~/.pi/agent/.cache/smart-compact-report.html",
    },
  ];

  return ctx.ui.custom<DashboardAction>(
    (tui, theme, keybindings, done) => {
      let view: DashboardView = "menu";
      let selected = 0;
      let scroll = 0;

      const pageLines = (): string[] => {
        switch (view) {
          case "overview":
            return opts.report.split("\n");
          case "quality":
            return formatDashboardQuality(insights);
          case "providers":
            return formatDashboardProviders(insights);
          case "canary":
            return formatDashboardCanary(insights);
          case "latest":
            return formatRunDetails(latest, "Latest run details");
          case "session":
            return formatCurrentSession(entries, opts.currentSessionId);
          case "recent":
            return formatRecentRuns(entries);
          case "menu":
            return [];
          default:
            return [];
        }
      };
      const resetPage = (nextView: DashboardView): void => {
        view = nextView;
        scroll = 0;
      };
      const qualityStatus = (): string => {
        if (!hasQualityData) return theme.fg("dim", " • Quality unavailable");
        return theme.fg(
          insights.quality.targetMet ? "success" : "warning",
          " • Quality " + insights.quality.healthScore + "/100",
        );
      };
      const renderHeader = (width: number): string[] => [
        truncateToWidth(
          theme.fg("accent", theme.bold("  📊 Smart Compact Dashboard")) +
            theme.fg("dim", "  " + entries.length + " recorded run(s)"),
          width,
        ),
        truncateToWidth(
          theme.fg(
            "dim",
            "  session: " + (opts.currentSessionId ?? "unknown"),
          ) +
            theme.fg(
              "dim",
              latest && Number.isFinite(latest.verificationScore)
                ? " • latest score " + metricScore(latest)
                : "",
            ) +
            theme.fg(
              insights.confidence.targetMet ? "success" : "warning",
              " • Data Confidence " + insights.confidence.score + "/100",
            ) +
            qualityStatus(),
          width,
        ),
        truncateToWidth(
          theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
          width,
        ),
      ];

      return {
        render(width: number) {
          const lines = renderHeader(width);
          if (view === "menu") {
            lines.push(
              truncateToWidth(
                theme.fg("text", "  Choose what to inspect:"),
                width,
              ),
              "",
            );
            for (let index = 0; index < menuItems.length; index++) {
              const item = menuItems[index];
              const active = index === selected;
              const label = active
                ? theme.fg("accent", theme.bold(item.label))
                : theme.fg("text", item.label);
              lines.push(
                truncateToWidth((active ? "  › " : "    ") + label, width),
              );
              lines.push(
                truncateToWidth(
                  "      " + theme.fg(active ? "muted" : "dim", item.desc),
                  width,
                ),
              );
            }
            lines.push(
              "",
              truncateToWidth(
                theme.fg("dim", "  ↑↓ navigate • enter open • esc/q close"),
                width,
              ),
            );
            return lines;
          }

          const content = pageLines();
          const maxScroll = Math.max(0, content.length - DASHBOARD_PAGE_SIZE);
          scroll = Math.min(scroll, maxScroll);
          for (const line of content.slice(
            scroll,
            scroll + DASHBOARD_PAGE_SIZE,
          )) {
            let styled = theme.fg("text", line);
            if (isDashboardTitleLine(line))
              styled = theme.fg("accent", theme.bold(line));
            else if (line.startsWith("-")) styled = theme.fg("dim", line);
            lines.push(truncateToWidth("  " + styled, width));
          }
          if (content.length > DASHBOARD_PAGE_SIZE) {
            lines.push(
              truncateToWidth(
                theme.fg(
                  "dim",
                  "  showing " +
                    (scroll + 1) +
                    "-" +
                    Math.min(content.length, scroll + DASHBOARD_PAGE_SIZE) +
                    " of " +
                    content.length,
                ),
                width,
              ),
            );
          }
          lines.push(
            "",
            truncateToWidth(
              theme.fg(
                "dim",
                "  ↑↓ scroll • pgup/pgdn page • home/end jump • b back • esc/q close",
              ),
              width,
            ),
          );
          return lines;
        },
        invalidate() {},
        handleInput(data: string) {
          if (keybindings.matches(data, "tui.select.cancel") || data === "q") {
            done(null);
            return;
          }
          if (view === "menu") {
            if (keybindings.matches(data, "tui.select.up"))
              selected = Math.max(0, selected - 1);
            else if (keybindings.matches(data, "tui.select.down"))
              selected = Math.min(menuItems.length - 1, selected + 1);
            else if (keybindings.matches(data, "tui.select.confirm")) {
              const item = menuItems[selected];
              if (item.action) {
                done(item.action);
                return;
              }
              if (item.view) resetPage(item.view);
            }
          } else {
            const maxScroll = Math.max(
              0,
              pageLines().length - DASHBOARD_PAGE_SIZE,
            );
            if (data === "b" || matchesKey(data, Key.left)) resetPage("menu");
            else if (matchesKey(data, Key.home)) scroll = 0;
            else if (matchesKey(data, Key.end)) scroll = maxScroll;
            else if (keybindings.matches(data, "tui.select.pageUp"))
              scroll = Math.max(0, scroll - DASHBOARD_PAGE_SIZE);
            else if (keybindings.matches(data, "tui.select.pageDown"))
              scroll = Math.min(maxScroll, scroll + DASHBOARD_PAGE_SIZE);
            else if (keybindings.matches(data, "tui.select.up"))
              scroll = Math.max(0, scroll - 1);
            else if (keybindings.matches(data, "tui.select.down"))
              scroll = Math.min(maxScroll, scroll + 1);
          }
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { width: "80%", anchor: "center", maxHeight: "85%" },
    },
  );
}
