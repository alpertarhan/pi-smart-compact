/**
 * Smart Compact Extension for Pi Coding Agent (EESV Architecture)
 *
 * Architecture: Extract -> Explore -> Synthesize -> Verify
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { CompressionProfile, PendingCompaction, Cell } from "./types.ts";
import { VERSION, MIN_TOKEN_THRESHOLD, CONFIG_KEY, CONFIG_KEY_ALT, FIVE_MINUTES_MS } from "./constants.ts";
import { loadConfig, extractUserNote, listBackups, readBackupContent, buildRestoreMessage } from "./utils/helpers.ts";
import { getProviderCaps } from "./utils/tokens.ts";
import { readMetricsLog } from "./utils/cache.ts";
import { buildMetricsReport, writeMetricsDashboard } from "./ui/metrics-report.ts";
import { runSmartCompact } from "./app/run-smart-compact.ts";
import { showCompactUI, showMetricsDashboardUI, showRestorePicker, showBackupViewer, showRestoreAction } from "./ui/overlays.ts";
import { resolveSessionId, isUnresolvedSessionId } from "./infra/session-identity.ts";
import { createPendingSlot, type PendingSlot, type ConsumeResult } from "./app/pending-slot.ts";
import { persistConsumedState } from "./app/steps/persist.ts";
import * as log from "./utils/logger.ts";

/**
 * Translate a `ConsumeResult` into the side-effects the host expects:
 *   - log the reason (warn for expired/mismatch, debug for empty)
 *   - surface a user-facing notification *only* when something interesting
 *     happened (we don't toast for the common "nothing pending" case)
 *   - return the unwrapped payload, or `null` if no payload should be used
 *
 * Keeping this orchestration in the extension entry point — instead of
 * inside `PendingSlot.consume` itself — lets the slot stay a pure,
 * host-agnostic state machine that's trivial to unit-test.
 */
function unwrapConsumed(result: ConsumeResult, ctx: ExtensionContext): PendingCompaction | null {
  switch (result.kind) {
    case "ok":
      // Durable state (project fingerprint + compaction state) is persisted
      // here — consume is the single moment, on every path (manual, auto,
      // tool), where we know Pi is about to apply the payload. Persisting
      // anywhere earlier would record success for a compact that never ran.
      persistConsumedState(result.pending);
      return result.pending;
    case "empty":
      return null;
    case "expired":
      log.warn("Discarding expired pending smart compaction after " + Math.round(result.ageMs / 1000) + "s");
      ctx.ui.notify("Expired pending smart compaction discarded", "warning");
      return null;
    case "mismatch":
      log.warn(
        "Discarding pending smart compaction prepared for a different session (" +
        result.expected + " vs " + result.actual + ")",
      );
      return null;
  }
}

// These helpers only depend on `modelRegistry` + `model`, which are part of
// the shared `ExtensionContext` surface; no command-only methods are needed.
/** Resolve a "provider/id" string through the model registry. */
export function findModelById(ctx: ExtensionContext, modelId: string): Model<Api> | undefined {
  const [p, ...r] = modelId.split("/");
  return ctx.modelRegistry.find(p, r.join("/"));
}

export function resolveModels(
  ctx: ExtensionContext,
  primary: Model<Api> | undefined,
  config: ReturnType<typeof loadConfig>,
  explicit = false,
): { segModel: Model<Api> | undefined; sumModel: Model<Api> | undefined } {
  const fallback = primary ?? ctx.model;
  const available = ctx.modelRegistry.getAvailable();
  let sumModel = fallback;

  // An explicit user selection (TUI picker or CLI model arg) wins over the
  // configured default; only fall back to config.summaryModel when no model
  // was explicitly chosen (auto-trigger / tool path).
  if (!explicit && config.summaryModel) {
    const found = findModelById(ctx, config.summaryModel);
    if (found) sumModel = found;
  }
  if (sumModel === fallback && !fallback) sumModel = available[0];

  let segModel = sumModel;
  if (config.segmentationModel) {
    segModel = findModelById(ctx, config.segmentationModel) ?? sumModel;
  }

  return { segModel, sumModel };
}

export default function smartCompactExtension(pi: ExtensionAPI) {
  const PENDING_TTL_MS = FIVE_MINUTES_MS;
  // Encapsulated slot: producers call `.set(...)`, the event handler calls
  // `.consume(...)`. The lifecycle (set/consume/clear/expire/mismatch) lives
  // entirely inside the slot factory — see src/app/pending-slot.ts.
  const pendingRef: PendingSlot = createPendingSlot({ ttlMs: PENDING_TTL_MS });
  const isRunning: Cell<boolean> = { value: false };

  pi.registerCommand("smart-compact", {
    description: "EESV smart compaction v" + VERSION + ". Usage: /smart-compact [model] [light|balanced|aggressive] [verbose|debug|dry-run|restore|metrics|dashboard] [note]",
    getArgumentCompletions: (prefix: string) => {
      const m = ["verbose", "debug", "dry-run", "metrics", "dashboard", "restore", "light", "balanced", "aggressive"].filter(o => o.startsWith(prefix)).map(o => ({ value: o, label: o }));
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
            // Dashboard read-only display: a real id when present, an
            // opaque "(no session)" placeholder otherwise. We don't share
            // resolveSessionId here because the unique-fallback id would
            // surface as cryptic noise in the UI — leak-guard isn't a
            // concern for a passive read.
            // Dashboard read-only display: route through the shared
            // resolver so we always get *some* opaque id, then collapse
            // an `unresolved:*` sentinel into a human-friendly placeholder
            // for the UI. This is the only legitimate consumer of
            // `isUnresolvedSessionId` outside the slot — keeps the helper
            // and its semantics co-located.
            const resolved = resolveSessionId(ctx);
            const sessionId = isUnresolvedSessionId(resolved) ? "(no session)" : resolved;
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
        if (flags.includes("restore")) {
          const backups = listBackups();
          if (!backups.length) { ctx.ui.notify("No smart-compact backups found", "info"); return; }
          const selected = await showRestorePicker(ctx, backups);
          if (!selected) { ctx.ui.notify("Cancelled", "info"); return; }
          const content = readBackupContent(selected);
          if (!content) { ctx.ui.notify("Could not read backup: " + selected, "error"); return; }
          const action = await showRestoreAction(ctx, selected);
          if (action === "restore") {
            // The command context exposes a read-only session manager, so we
            // can't inject into the *current* session. True restore forks from
            // the current leaf (preserving recent work) and injects the backup
            // as context via the replacement session's sendMessage.
            const branch = ctx.sessionManager.getBranch() as Array<{ id?: string }>;
            const leafId = branch.length ? branch[branch.length - 1].id : undefined;
            if (!leafId) {
              ctx.ui.notify("Cannot restore: no session leaf to fork from — showing content instead", "warning");
              await showBackupViewer(ctx, content, selected);
              return;
            }
            try {
              const result = await ctx.fork(leafId, {
                withSession: async (rctx) => {
                  await rctx.sendMessage(buildRestoreMessage(content, selected), { deliverAs: "nextTurn" });
                },
              });
              ctx.ui.notify(result.cancelled ? "Restore cancelled" : "Restored backup into a new session", "info");
            } catch (e) {
              log.warn("Restore fork failed", e);
              ctx.ui.notify("Restore failed (" + (e instanceof Error ? e.message : String(e)) + ") — showing content instead", "warning");
              await showBackupViewer(ctx, content, selected);
            }
          } else if (action === "view") {
            await showBackupViewer(ctx, content, selected);
          }
          return;
        }
        // A token is a model arg when it resolves in the registry, or when
        // its provider prefix is a known provider (i.e. a typo'd model id we
        // must reject loudly rather than let fall through as note text).
        // Note tokens like "src/auth.ts" have no registered provider prefix
        // and pass through to extractUserNote untouched.
        const knownProviders = new Set(ctx.modelRegistry.getAvailable().map(m => m.provider));
        const modelArg = tokens.find(t =>
          /^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(t) &&
          (findModelById(ctx, t) || knownProviders.has(t.split("/")[0])));
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
          const { segModel, sumModel } = resolveModels(ctx, selected.model.model, loadConfig(), true);
          if (!sumModel) { ctx.ui.notify("Could not resolve model", "error"); return; }
          await runSmartCompact({ ctx, summaryModel: sumModel, segModel: segModel ?? sumModel, profile: selected.profile, pendingRef, isRunning, force: true });
          return;
        }

        // An explicit model arg that doesn't resolve must fail loudly —
        // silently falling back to ctx.model would compact with a model the
        // user did not choose (the old behaviour).
        const explicitModel = modelArg ? findModelById(ctx, modelArg) : undefined;
        if (modelArg && !explicitModel) {
          ctx.ui.notify("Unknown model: " + modelArg + " — check available models", "error");
          return;
        }
        const { segModel, sumModel } = resolveModels(ctx, explicitModel ?? ctx.model, loadConfig(), Boolean(modelArg));
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
    const consumed = unwrapConsumed(pendingRef.consume(ctx), ctx);
    if (consumed) {
      return { compaction: { summary: consumed.summary, firstKeptEntryId: consumed.firstKeptEntryId, tokensBefore: consumed.tokensBefore, details: consumed.details } };
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
      const { segModel, sumModel } = resolveModels(ctx, cur, config);
      if (!sumModel) return;
      if (!isRunning.value) {
        const caps = getProviderCaps(sumModel.provider);
        const effectiveTimeoutMs = Math.round(config.autoTriggerTimeoutMs * caps.timeoutMultiplier);

        // Outer hard timeout: providers occasionally ignore AbortSignal, so we
        // need a second line of defense that cannot be subverted from inside.
        // We hand a shared cancellation handle to runSmartCompact; firing it
        // sets `timedOut = true` on the run's context which propagates to:
        //   - every cancellation gate in run-smart-compact.ts (skips compact, clears pending),
        //   - the finally block (records a timeout metric, frees isRunning).
        // No Promise.race is needed: we await the run normally and let the
        // shared flag drive the bailout. This removes the race window where
        // the outer race resolved "timeout" while the inner pipeline was
        // still mid-applyCompaction.
        const cancellationOut: { value: import("./app/run-smart-compact.ts").ExternalCancellation | null } = { value: null };
        const timeoutId = setTimeout(() => {
          // Fires 100ms AFTER the inner deadline — this is the outer backstop
          // for providers that ignore AbortSignal, not the primary timeout.
          // The inner setTimeout in prepareRun (at effectiveTimeoutMs) is what
          // normally aborts the run; this one only acts when that abort was
          // swallowed.
          if (cancellationOut.value && !cancellationOut.value.timedOut) {
            log.warn("Smart compact auto-trigger hard timeout after " + effectiveTimeoutMs + "ms");
            cancellationOut.value.abort();
          }
        }, effectiveTimeoutMs + 100);

        try {
          await runSmartCompact({
            ctx,
            summaryModel: sumModel,
            segModel: segModel ?? sumModel,
            profile: config.profile,
            pendingRef, isRunning,
            autoTriggered: true,
            timeoutMs: effectiveTimeoutMs,
            cancellationOut,
          });
        } catch (err) {
          log.warn("Smart compact auto-trigger threw", err);
        } finally {
          clearTimeout(timeoutId);
        }

        // If the outer timer fired, runSmartCompact's finally has already
        // cleared pendingRef. Falling through to native compact is the right
        // behavior — we don't need to re-check the timeout flag here.
        const fresh = unwrapConsumed(pendingRef.consume(ctx), ctx);
        if (fresh) {
          return { compaction: { summary: fresh.summary, firstKeptEntryId: fresh.firstKeptEntryId, tokensBefore: fresh.tokensBefore, details: fresh.details } };
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
    async execute(_id, params, signal, _onUp, ctx) {
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

      const cur = ctx.model as Model<Api> | undefined;
      const { segModel, sumModel } = resolveModels(ctx, cur, config);
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
        await runSmartCompact({ ctx, summaryModel: sumModel, segModel: segModel ?? sumModel, profile: resolvedProfile, verbose, dryRun, pendingRef, isRunning, autoTriggered: true, skipCompact: true, abortSignal: signal });
        const toolSecs = ((Date.now() - toolStart) / 1000).toFixed(1);
        const staged = pendingRef.peek();
        if (staged) {
          return { content: [{ type: "text", text: "Smart summary prepared (" + resolvedProfile + "). Tokens: " + (staged.tokensBefore ?? 0).toLocaleString() + " — summary cached for " + Math.round(PENDING_TTL_MS / 60000) + " min. The next /compact will use this summary automatically." }], details: undefined };
        }
        // Dry-run returns before staging, so an empty slot is the *expected*
        // outcome — not a failure. Report it as such.
        if (dryRun) {
          return { content: [{ type: "text", text: "Dry run finished (" + resolvedProfile + ", " + toolSecs + "s). Pipeline ran successfully; no summary was staged (dry-run skips staging by design)." }], details: undefined };
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
