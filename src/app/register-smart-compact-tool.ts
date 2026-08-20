import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BUDGET_LIMITS,
  FIVE_MINUTES_MS,
  MIN_TOKEN_THRESHOLD,
  VERSION,
} from "../constants.ts";
import {
  buildMetricsReport,
  writeMetricsDashboard,
} from "../ui/metrics-report.ts";
import { formatCompactErrorForUi } from "../ui/error-format.ts";
import { loadConfig } from "../utils/config.ts";
import * as log from "../utils/logger.ts";
import { safeContextPercent } from "../utils/tokens.ts";
import { resolveSessionId } from "../infra/session-identity.ts";
import { resolveModels } from "./model-routing.ts";
import type { PendingSlot } from "./pending-slot.ts";
import { runSmartCompact } from "./run-smart-compact.ts";
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
      "EESV smart compaction v" +
      VERSION +
      " with deterministic extraction, exploration, and verification. Compacts the conversation into a structured summary preserving goals, decisions, open loops, modified files, and critical context. Call only when actual context usage is high; ignore pi-auto-context tool=XX% because that is tool-output ratio, not context fullness. The tool internally checks context usage and skips if not needed.",
    promptSnippet: "Smart compaction",
    promptGuidelines: [
      "Use only when actual context usage is high (for example pi-auto-context context>=60%).",
      "Do NOT call just because pi-auto-context shows tool=XX%; tool% is tool-output ratio, not context fullness.",
      "Prefer this over default compact only when compaction is actually needed.",
    ],
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: "fast, balanced, thorough, or auto. Default: auto.",
        },
        profile: {
          type: "string",
          description: "Deprecated alias: light, balanced, or aggressive.",
        },
        verbose: {
          type: "boolean",
          description: "Show detailed pipeline output.",
        },
        dry_run: {
          type: "boolean",
          description: "Run the pipeline but skip applying the compaction.",
        },
        report: {
          type: "boolean",
          description:
            "Return recent performance metrics instead of compacting.",
        },
        dashboard: {
          type: "boolean",
          description:
            "Write a local HTML metrics dashboard and return its path.",
        },
        focus: {
          type: "string",
          description:
            "Topic or path that should receive extra preservation budget.",
        },
        max_calls: {
          type: "number",
          description:
            "Maximum LLM calls for this run (" +
            BUDGET_LIMITS.CALLS.min +
            "-" +
            BUDGET_LIMITS.CALLS.max +
            ").",
        },
        max_input_tokens: {
          type: "number",
          description:
            "Aggregate prompt-token budget for this run (" +
            BUDGET_LIMITS.INPUT_TOKENS.min +
            "-" +
            BUDGET_LIMITS.INPUT_TOKENS.max +
            ").",
        },
        max_latency_ms: {
          type: "number",
          description:
            "Optional pipeline cancellation budget in milliseconds (" +
            BUDGET_LIMITS.LATENCY_MS.min +
            "-" +
            BUDGET_LIMITS.LATENCY_MS.max +
            ").",
        },
      },
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
        );
      }

      const config = loadConfig();
      const resolvedMode = mode ?? config.mode;
      const sessionId = resolveSessionId(ctx);
      if (!dryRun && pendingRef.peek(sessionId)?.sessionId === sessionId) {
        return textResult(
          "A smart summary is already staged for this session. The next /compact will use it; no LLM calls were made.",
        );
      }

      const usage = ctx.getContextUsage?.();
      const totalTokens = usage?.tokens ?? 0;
      const contextPercent = safeContextPercent(
        totalTokens,
        ctx.model?.contextWindow,
      );
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
          "Context is only " +
            percent +
            "% full (" +
            totalTokens.toLocaleString() +
            " tokens). Compaction is not needed yet. The tool=97% in status means tool output ratio, NOT context usage.",
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
                  "Smart summary prepared (" +
                  resolvedMode +
                  " → " +
                  (staged.details.mode ?? staged.details.profile) +
                  "). Tokens: " +
                  (staged.tokensBefore ?? 0).toLocaleString() +
                  " — cached for " +
                  Math.round(FIVE_MINUTES_MS / 60_000) +
                  " min. The next /compact will use it automatically.",
              },
            ],
            details: staged.details,
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
            details: outcome.details,
          };
        }
        if (outcome.kind === "cancelled") {
          return textResult(
            "Smart compact cancelled by " +
              outcome.source +
              "; no summary was staged.",
          );
        }
        return textResult(
          "Smart compact skipped: " +
            outcome.reason.replace(/-/g, " ") +
            ". No summary was staged.",
        );
      } catch (error) {
        log.debugError("Smart compact tool failed", error);
        throw new Error(formatCompactErrorForUi(error));
      }
    },
  });
}

function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
  details: undefined;
} {
  return { content: [{ type: "text", text }], details: undefined };
}
