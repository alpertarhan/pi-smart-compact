import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  BUDGET_LIMITS,
  MIN_TOKEN_THRESHOLD,
} from "../constants.ts";
import {
  buildMetricsReport,
  writeMetricsDashboard,
} from "../ui/metrics-report.ts";
import { formatCompactErrorForUi } from "../ui/error-format.ts";
import { loadConfig } from "../utils/config.ts";
import { errorDetail, recordIssue } from "../utils/issues.ts";
import { effectiveContextWindow, safeContextPercent } from "../utils/tokens.ts";
import { resolveSessionId } from "../infra/session-identity.ts";
import { resolveModels } from "./model-routing.ts";
import type { PendingSlot } from "./pending-slot.ts";
import { runSmartCompact } from "./run-smart-compact.ts";
import {
 expandedRow,
 firstTextContent,
 metaLine,
 rawFallbackRow,
 safeArg,
 statusLabel,
 summarizeLine,
 tryRow,
} from "../ui/tool-rows.ts";
import type { SessionRunLock } from "./session-run-lock.ts";
import { parseSmartCompactTool } from "./smart-compact-input.ts";
import type { SmartCompactPolicy } from "./smart-compact-policy.ts";

interface SmartCompactToolDependencies {
  pendingRef: PendingSlot;
  runLock: SessionRunLock;
  onNativeApplyError: (runId: string) => boolean;
  policy: SmartCompactPolicy;
}

export function registerSmartCompactTool(
  pi: ExtensionAPI,
  dependencies: SmartCompactToolDependencies,
): void {
  const { pendingRef, runLock, onNativeApplyError, policy } = dependencies;
  pi.registerTool({
    name: "smart_compact",
    label: "Smart Compact",
    description:
      "Prepares and stages a verified summary for the next /compact (configured staging TTL; never applies mid-turn). Call only when actual context usage is high; tool=XX% is tool-output share, not fullness.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: "fast, balanced, thorough or auto (default).",
        },
        profile: {
          type: "string",
          description: "Deprecated mode alias.",
        },
        verbose: {
          type: "boolean",
          description: "Detailed output.",
        },
        dry_run: {
          type: "boolean",
          description: "Do not stage.",
        },
        report: {
          type: "boolean",
          description: "Return metrics only.",
        },
        dashboard: {
          type: "boolean",
          description: "Write metrics dashboard.",
        },
        focus: {
          type: "string",
          description: "Topic/path to preserve more.",
        },
        max_calls: {
          type: "number",
          description:
            "LLM call cap (" +
            BUDGET_LIMITS.CALLS.min +
            "-" +
            BUDGET_LIMITS.CALLS.max +
            ").",
        },
        max_input_tokens: {
          type: "number",
          description:
            "Prompt-token cap (" +
            BUDGET_LIMITS.INPUT_TOKENS.min +
            "-" +
            BUDGET_LIMITS.INPUT_TOKENS.max +
            ").",
        },
        max_latency_ms: {
          type: "number",
          description:
            "Latency cap ms (" +
            BUDGET_LIMITS.LATENCY_MS.min +
            "-" +
            BUDGET_LIMITS.LATENCY_MS.max +
            ").",
        },
      },
    },
    renderCall(args, theme) {
      const label = theme.fg("toolTitle", "smart_compact ");
      const flags = [
        safeArg(args.mode, 20),
        args.dry_run === true ? "dry-run" : "",
        args.report === true ? "report" : "",
        args.dashboard === true ? "dashboard" : "",
      ].filter(Boolean).join(" ");
      return new Text(label + theme.fg("muted", flags || "auto"), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      return tryRow(theme, () => renderCompactRow(result, expanded, theme, context), result, expanded);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!policy.isAgentToolEnabled()) {
        return textResult(
          "smart_compact is hidden from the agent for this session. The user can still run /smart-compact manually.",
        );
      }
      const parsedInput = parseSmartCompactTool(params);
      if (!parsedInput.ok) {
        return textResult("Invalid smart_compact input: " + parsedInput.error);
      }
      const {
        mode,
        verbose,
        dryRun,
        action,
        focus,
        maxLlmCalls,
        maxLlmInputTokens,
        timeoutMs: maxLatencyMs,
      } = parsedInput.value;
      if (action === "metrics" || action === "dashboard") {
        const report = buildMetricsReport();
        const dashboard =
          action === "dashboard" ? writeMetricsDashboard() : null;
        return textResult(
          report + (dashboard ? "\n\nDashboard: " + dashboard : ""),
          { display: { kind: "metrics", dashboard: dashboard !== null } },
        );
      }

      const config = loadConfig();
      const resolvedMode = mode ?? config.mode;
      const sessionId = resolveSessionId(ctx);
      if (!dryRun && pendingRef.peek(sessionId)) {
        return textResult(
          "A smart summary is already staged; context is unchanged. Run /compact before the configured staging TTL expires to apply it. No LLM calls were made.",
        );
      }

      const usage = ctx.getContextUsage?.();
      const totalTokens = usage?.tokens ?? 0;
      const window = effectiveContextWindow(ctx.model, config);
      const contextPercent = safeContextPercent(totalTokens, window);
      const percent = Math.round(contextPercent);
      if (!totalTokens || totalTokens < MIN_TOKEN_THRESHOLD) {
        return textResult(
          "Context is not large enough for compaction (" +
          totalTokens.toLocaleString() +
          " tokens, " +
          percent +
          "%). No action needed.",
        );
      }
      if (contextPercent < config.minContextPercent) {
        return textResult(
          "Compaction skipped: context " + percent + "% (" + totalTokens.toLocaleString() +
          " / " + (window ?? 0).toLocaleString() + " tokens), below the " +
          config.minContextPercent + "% agent-tool threshold. tool=XX% measures tool-output ratio, not context usage. " +
          "For deliberate early compaction, the user can run /smart-compact; preview and safety checks still apply.",
        );
      }

      const current = ctx.model as Model<Api> | undefined;
      const { segModel, sumModel, verifyModel } = resolveModels(
        ctx,
        current,
        config,
      );
      if (!sumModel) return textResult("Error: Could not resolve model.");

      try {
        const startedAt = Date.now();
        const outcome = await runSmartCompact({
          ctx,
          summaryModel: sumModel,
          segModel: segModel ?? sumModel,
          verifyModel: verifyModel ?? sumModel,
          mode: resolvedMode,
          verbose,
          dryRun,
          pendingRef,
          isRunning: runLock,
          onNativeApplyError,
          autoTriggered: true,
          skipCompact: true,
          abortSignal: signal,
          focus,
          maxLlmCalls,
          maxLlmInputTokens,
          timeoutMs: maxLatencyMs,
        });
        if (outcome.kind === "staged" || outcome.kind === "apply-requested") {
          const staged = outcome.pending;
          return {
            content: [
              {
                type: "text" as const,
                text:
                  (staged.details.method === "native"
                    ? "Native compaction prepared (" + staged.details.model + "; provider state, not EESV-verified). Tokens: "
                    : "Smart summary prepared (" +
                    resolvedMode +
                    " → " +
                    (staged.details.mode ?? staged.details.profile) +
                    "). Tokens: ") +
                  (staged.tokensBefore ?? 0).toLocaleString() +
                  " — staged, not applied, for " +
                  config.pendingTtlMs / 60_000 +
                  " min. Context is unchanged. Run /compact within that time to apply it; expiry discards the candidate.",
              },
            ],
            // Explicit display discriminant: staged is NEVER applied — the
            // renderer must not guess from the shared details shape.
            details: {
              ...staged.details,
              display: {
                state: "staged",
                method: staged.details.method,
                mode: staged.details.mode ?? staged.details.profile ?? resolvedMode,
                tokens: staged.tokensBefore ?? 0,
                ttlMinutes: config.pendingTtlMs / 60_000,
              },
            },
          };
        }
        if (outcome.kind === "dry-run") {
          const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "Dry run finished (" +
                  resolvedMode +
                  ", " +
                  seconds +
                  "s). Pipeline ran successfully; no summary was staged.",
              },
            ],
            details: {
              ...outcome.details,
              display: { state: "dry-run", mode: resolvedMode, seconds: Number(seconds) },
            },
          };
        }
        if (outcome.kind === "cancelled") {
          return textResult(
            "Smart compact cancelled by " +
            outcome.source +
            "; no summary was staged.",
            { display: { state: "cancelled", source: outcome.source } },
          );
        }
        return textResult(
          "Smart compact skipped: " +
          outcome.reason.replace(/-/g, " ") +
          ". No summary was staged.",
          { display: { state: "skipped" } },
        );
      } catch (error) {
        recordIssue({ key: "tool.smart-compact", message: "smart_compact failed: " + errorDetail(error) + ".", error });
        throw new Error(formatCompactErrorForUi(error));
      }
    },
  });
}

function textResult(
  text: string,
  details: unknown = undefined,
): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return { content: [{ type: "text", text }], details };
}

interface RenderableResult {
  content?: ReadonlyArray<{ type: string; text?: string }>;
  details?: unknown;
}

interface RenderContext {
  isError: boolean;
}

/** Honest states only: staged is never green — only an actually applied
 * compaction would be, and this tool never applies. */
function renderCompactRow(
  result: RenderableResult,
  expanded: boolean,
  theme: Theme,
  context: RenderContext,
): Text {
  if (context.isError) {
    const head = theme.fg("error", "smart_compact failed:");
    return expanded
      ? expandedRow(theme, result, [head])
      : new Text(head + " " + summarizeLine(firstTextContent(result.content), 140), 0, 0);
  }
  const display = (result.details as { display?: Record<string, unknown> } | undefined)?.display;
  if (!display) return rawFallbackRow(theme, result, expanded);
  const lines: string[] = [];
  if (display.state === "staged") {
    lines.push(
      statusLabel(theme, "pending") + " " +
      theme.fg("muted", "staged — NOT applied; run /compact within " + (Number(display.ttlMinutes) || 0) + " min"),
    );
    lines.push(
      metaLine(theme, "summary", (display.method === "native" ? "native" : String(display.mode ?? "")) +
        " · " + (Number(display.tokens) || 0).toLocaleString() + " tokens"),
    );
  } else if (display.state === "dry-run") {
    lines.push(statusLabel(theme, "info") + " " + theme.fg("muted", "dry run — nothing staged"));
    if (display.seconds) lines.push(metaLine(theme, "pipeline", display.seconds + "s"));
  } else if (display.state === "cancelled") {
    lines.push(statusLabel(theme, "cancelled") + " " + theme.fg("muted", "by " + String(display.source ?? "host")));
  } else if (display.state === "skipped") {
    lines.push(statusLabel(theme, "skipped") + " " + theme.fg("dim", summarizeLine(firstTextContent(result.content), 140)));
  } else if (display.kind === "metrics") {
    lines.push(statusLabel(theme, "info") + " " + theme.fg("muted", "metrics report" + (display.dashboard ? " (dashboard written)" : "")));
  } else {
    return rawFallbackRow(theme, result, expanded);
  }
  return expanded ? expandedRow(theme, result, lines) : new Text(lines.join("\n"), 0, 0);
}
