/**
 * Smart Compact Extension for Pi Coding Agent (EESV Architecture)
 *
 * Architecture: Extract -> Explore -> Synthesize -> Verify
 */

import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum, type Model, type Api } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { CompactionMode, CompressionProfile, PendingCompaction } from "./types.ts";
import { modeFromLegacyProfile } from "./app/mode-policy.ts";
import { VERSION, MIN_TOKEN_THRESHOLD, CONFIG_KEY, CONFIG_KEY_ALT, FIVE_MINUTES_MS } from "./constants.ts";
import { loadConfig, extractUserNote, listBackups, readBackupContent, buildRestoreMessage } from "./utils/helpers.ts";
import { getProviderCaps } from "./utils/tokens.ts";
import { readMetricsLog } from "./utils/cache.ts";
import { buildLocalDashboardInsights, buildMetricsReport, writeMetricsDashboard } from "./ui/metrics-report.ts";
import { runSmartCompact } from "./app/run-smart-compact.ts";
import { showCompactUI, showMetricsDashboardUI, showRestorePicker, showBackupViewer, showRestoreAction, showOpenLoopsUI } from "./ui/overlays.ts";
import { resolveSessionId, isUnresolvedSessionId } from "./infra/session-identity.ts";
import { createPendingSlot, type PendingSlot, type ConsumeResult } from "./app/pending-slot.ts";
import { createSessionRunLock } from "./app/session-run-lock.ts";
import { persistConsumedState } from "./app/steps/persist.ts";
import { OnlineDamageMonitor, logDamageReport, writeRemediationHints } from "./utils/damage.ts";
import * as log from "./utils/logger.ts";
import { deriveProjectIdFromCwd } from "./utils/fingerprint.ts";
import { applyLoopOverrides, loadScopedCompactionState, renderContinuityCapsule, saveCompactionState } from "./utils/state.ts";
import { createNativeContinuityBridge } from "./app/native-continuity-bridge.ts";
import {
  closeContextMemory, formatRecallResults, recallContext, saveContextMemory, type ContextGraphScope,
  type ContextMemoryKind,
} from "./infra/context-graph.ts";
import { SecretScrubber } from "./domain/scrub.ts";

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
): { segModel: Model<Api> | undefined; sumModel: Model<Api> | undefined; verifyModel: Model<Api> | undefined } {
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
  let verifyModel = sumModel;
  if (config.verificationModel) {
    verifyModel = findModelById(ctx, config.verificationModel) ?? sumModel;
  }

  return { segModel, sumModel, verifyModel };
}

function resolveGraphScope(ctx: ExtensionContext): ContextGraphScope | null {
  const sessionId = resolveSessionId(ctx);
  if (isUnresolvedSessionId(sessionId)) return null;
  const branchEntryIds = (ctx.sessionManager.getBranch() as Array<{ id?: string }>)
    .map(entry => entry.id).filter((id): id is string => typeof id === "string");
  return {
    projectId: deriveProjectIdFromCwd(ctx.cwd),
    sessionId,
    branchHeadId: branchEntryIds.at(-1),
    branchEntryIds,
  };
}

export default function smartCompactExtension(pi: ExtensionAPI) {
  const PENDING_TTL_MS = FIVE_MINUTES_MS;
  // Encapsulated slot: producers call `.set(...)`, the event handler calls
  // `.consume(...)`. The lifecycle (set/consume/clear/expire/mismatch) lives
  // entirely inside the slot factory — see src/app/pending-slot.ts.
  const pendingRef: PendingSlot = createPendingSlot({ ttlMs: PENDING_TTL_MS });
  const isRunning = createSessionRunLock();
  const damageMonitor = new OnlineDamageMonitor();
  const nativeContinuity = createNativeContinuityBridge({ ttlMs: PENDING_TTL_MS });
  const monitorCandidates = new Map<string, { projectId: string; details: import("./types.ts").SmartCompactDetails }>();
  const rememberForOnlineDamage = (pending: PendingCompaction): void => {
    if (!loadConfig().onlineDamageMonitor || !pending.projectId) return;
    monitorCandidates.set(pending.sessionId, { projectId: pending.projectId, details: pending.details });
  };

  const recallKinds = [
    "goal", "decision", "constraint", "error", "loop", "next-action", "critical",
    "topic", "file", "preference", "warning", "procedure", "context",
  ] as const;

  pi.registerTool({
    name: "smart_recall",
    label: "Smart Recall",
    description: "Search the current project's persistent, compaction-derived context graph with FTS5 and scope-aware ranking. Returns at most 10 bounded results; never searches another project.",
    promptSnippet: "Recall verified goals, decisions, constraints, loops, errors, files, and saved project memory",
    promptGuidelines: [
      "Use smart_recall when earlier project decisions or unresolved work are relevant but absent from the current context.",
      "Treat smart_recall results as historical evidence; verify mutable code facts against the repository before editing.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500, description: "Terms, file path, decision, error, or topic to recall." }),
      scope: Type.Optional(StringEnum(["project", "session"] as const, { description: "Project (default) searches across sessions; session restricts results." })),
      kinds: Type.Optional(Type.Array(StringEnum(recallKinds), { maxItems: recallKinds.length, description: "Optional memory kinds to include." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum results. Default: 5." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled" }], details: undefined };
      if (!loadConfig().contextGraphEnabled) {
        return { content: [{ type: "text" as const, text: "Smart Recall is disabled by contextGraphEnabled=false." }], details: undefined };
      }
      const scope = resolveGraphScope(ctx);
      if (!scope) return { content: [{ type: "text" as const, text: "Smart Recall needs a persisted session id." }], details: undefined };
      const results = recallContext(scope, params.query, {
        limit: params.limit,
        sessionOnly: params.scope === "session",
        kinds: params.kinds as ContextMemoryKind[] | undefined,
      });
      return { content: [{ type: "text" as const, text: formatRecallResults(results) }], details: { results } };
    },
  });

  pi.registerTool({
    name: "smart_save_memory",
    label: "Save Project Memory",
    description: "Save or resolve one explicit, durable, user-confirmed fact in the current project's context graph. Never use for guesses, transient status, secrets, or facts that can be read cheaply from the repository.",
    promptSnippet: "Save a user-confirmed durable project decision, constraint, preference, warning, procedure, or context fact",
    promptGuidelines: [
      "Use smart_save_memory only when the user explicitly confirms a durable project fact worth recalling across sessions.",
      "Do not use smart_save_memory for inferred facts, transient progress, secrets, or ordinary code contents.",
    ],
    parameters: Type.Object({
      kind: StringEnum(["decision", "constraint", "preference", "warning", "procedure", "context"] as const),
      status: Type.Optional(StringEnum(["active", "resolved"] as const, { description: "Default active. Resolved closes an exact saved fact." })),
      confirmed_by_user: Type.Boolean({ description: "Must be true only when the user explicitly confirmed this durable fact." }),
      title: Type.Optional(Type.String({ maxLength: 200 })),
      content: Type.String({ minLength: 1, maxLength: 2_000, description: "New fact, or exact old fact when resolving it." }),
      related_paths: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 20 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled" }], details: undefined };
      if (params.confirmed_by_user !== true) {
        return { content: [{ type: "text" as const, text: "Memory not saved: explicit user confirmation is required." }], details: undefined };
      }
      const config = loadConfig();
      if (!config.contextGraphEnabled) {
        return { content: [{ type: "text" as const, text: "Project memory is disabled by contextGraphEnabled=false." }], details: undefined };
      }
      const scope = resolveGraphScope(ctx);
      if (!scope) return { content: [{ type: "text" as const, text: "Saving memory needs a persisted session id." }], details: undefined };
      const scrubber = new SecretScrubber(config.scrubSecrets, config.scrubPii);
      const title = scrubber.scrubText(params.title?.trim() || "Saved " + params.kind).value;
      const content = scrubber.scrubText(params.content).value;
      const relatedPaths = (params.related_paths ?? []).map(path => scrubber.scrubText(path).value);
      const status = params.status ?? "active";
      if (status === "resolved") {
        const closed = closeContextMemory(scope.projectId, params.kind, content, status);
        return {
          content: [{ type: "text" as const, text: closed
            ? "Resolved " + closed + " project memory item(s)."
            : "No matching active project memory found; nothing changed." }],
          details: { closed, redactions: scrubber.count() },
        };
      }
      const memory = saveContextMemory(scope, { kind: params.kind, title, content, relatedPaths });
      return {
        content: [{ type: "text" as const, text: "Saved project memory: [" + memory.kind + "] " + memory.title + " (" + memory.id + ")" }],
        details: { memory, redactions: scrubber.count() },
      };
    },
  });

  pi.registerCommand("smart-compact", {
    description: "EESV smart compaction v" + VERSION + ". Usage: /smart-compact [model] [mode] [flags] [--focus=topic] [--max-calls=N] [--max-input-tokens=N] [note]",
    getArgumentCompletions: (prefix: string) => {
      const m = ["verbose", "debug", "dry-run", "metrics", "dashboard", "restore", "loops", "auto", "balanced", "aggressive", "fast", "thorough", "slow", "light", "--focus=", "--max-calls=", "--max-input-tokens=", "--max-latency="].filter(o => o.startsWith(prefix)).map(o => ({ value: o, label: o }));
      return m.length ? m : null;
    },
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const flags = tokens.map(t => t.toLowerCase());
        const verbose = flags.includes("verbose") || flags.includes("debug");
        const dryRun = flags.includes("dry-run");
        const optionValue = (name: string): string | undefined => tokens.find(token => token.startsWith("--" + name + "="))?.slice(name.length + 3);
        const focus = optionValue("focus")?.trim() || undefined;
        const maxCallsRaw = optionValue("max-calls");
        const maxInputRaw = optionValue("max-input-tokens");
        const maxLatencyRaw = optionValue("max-latency");
        const maxLlmCalls = maxCallsRaw == null ? undefined : Number(maxCallsRaw);
        const maxLlmInputTokens = maxInputRaw == null ? undefined : Number(maxInputRaw);
        const maxLatencyMs = maxLatencyRaw == null ? undefined : Number(maxLatencyRaw);
        if (maxLlmCalls !== undefined && (!Number.isInteger(maxLlmCalls) || maxLlmCalls < 1 || maxLlmCalls > 100)) {
          ctx.ui.notify("--max-calls must be an integer from 1 to 100", "error");
          return;
        }
        if (maxLlmInputTokens !== undefined && (!Number.isInteger(maxLlmInputTokens) || maxLlmInputTokens < 10_000 || maxLlmInputTokens > 1_000_000)) {
          ctx.ui.notify("--max-input-tokens must be an integer from 10000 to 1000000", "error");
          return;
        }
        if (maxLatencyMs !== undefined && (!Number.isFinite(maxLatencyMs) || maxLatencyMs < 5000 || maxLatencyMs > 600000)) {
          ctx.ui.notify("--max-latency must be 5000–600000 ms", "error");
          return;
        }
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
            const insights = buildLocalDashboardInsights(entries);
            const action = await showMetricsDashboardUI(ctx, {
              entries,
              currentSessionId: sessionId,
              report: buildMetricsReport(entries, undefined, insights),
              insights,
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
        if (flags.includes("loops")) {
          const projectId = deriveProjectIdFromCwd(ctx.cwd);
          const sessionId = resolveSessionId(ctx);
          const branchIds = (ctx.sessionManager.getBranch() as Array<{ id?: string }>)
            .map(entry => entry.id).filter((id): id is string => typeof id === "string");
          const state = isUnresolvedSessionId(sessionId)
            ? null
            : loadScopedCompactionState({ projectId, sessionId }, branchIds);
          if (!state || state.openLoops.length === 0) {
            ctx.ui.notify("No persisted open loops for this project", "info");
            return;
          }
          const overrides = await showOpenLoopsUI(ctx, state.openLoops, state.loopOverrides ?? []);
          if (!overrides) { ctx.ui.notify("Open-loop manager closed without changes", "info"); return; }
          state.loopOverrides = overrides;
          state.openLoops = applyLoopOverrides(state.openLoops, overrides);
          state.updatedAt = Date.now();
          saveCompactionState(projectId, state);
          ctx.ui.notify("Open-loop overrides saved", "info");
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
        const config = loadConfig();
        const rawMode = tokens.find(t => ["auto", "balanced", "aggressive", "fast", "thorough", "slow"].includes(t));
        const modeArg = (rawMode === "slow" ? "thorough" : rawMode) as CompactionMode | undefined;
        const profileArg = tokens.includes("light") ? "light" as CompressionProfile : undefined;
        const mode = modeArg ?? (profileArg ? modeFromLegacyProfile(profileArg) : config.mode);

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
          const { segModel, sumModel, verifyModel } = resolveModels(ctx, selected.model.model, loadConfig(), true);
          if (!sumModel) { ctx.ui.notify("Could not resolve model", "error"); return; }
          await runSmartCompact({ ctx, summaryModel: sumModel, segModel: segModel ?? sumModel, verifyModel: verifyModel ?? sumModel, mode: selected.mode, pendingRef, isRunning, force: true });
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
        const { segModel, sumModel, verifyModel } = resolveModels(ctx, explicitModel ?? ctx.model, loadConfig(), Boolean(modelArg));
        if (!sumModel) { ctx.ui.notify("Could not resolve model", "error"); return; }
        const note = extractUserNote(args);
        await runSmartCompact({
          ctx, summaryModel: sumModel, segModel: segModel ?? sumModel, verifyModel: verifyModel ?? sumModel, mode, verbose, dryRun,
          pendingRef, isRunning, userNote: note, focus, maxLlmCalls, maxLlmInputTokens,
          timeoutMs: maxLatencyMs, force: true,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message + "\n" + error.stack : String(error);
        ctx.ui.notify("smart-compact error: " + msg, "error");
      }
    },
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    const consumed = unwrapConsumed(pendingRef.consume(ctx), ctx);
    if (consumed) {
      rememberForOnlineDamage(consumed);
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
      const { segModel, sumModel, verifyModel } = resolveModels(ctx, cur, config);
      if (!sumModel) return;
      if (!isRunning.isRunning(resolveSessionId(ctx))) {
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
            verifyModel: verifyModel ?? sumModel,
            mode: config.mode,
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
          rememberForOnlineDamage(fresh);
          return { compaction: { summary: fresh.summary, firstKeptEntryId: fresh.firstKeptEntryId, tokensBefore: fresh.tokensBefore, details: fresh.details } };
        }
      }
    } catch (e) { log.warn("session_before_compact error", e); }
  });

  pi.on("session_compact", async (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const candidate = monitorCandidates.get(sessionId);
    if (candidate) {
      monitorCandidates.delete(sessionId);
      damageMonitor.activate(sessionId, candidate.projectId, candidate.details);
      return;
    }
    if (event.fromExtension || isUnresolvedSessionId(sessionId)) return;
    const projectId = deriveProjectIdFromCwd(ctx.cwd);
    const branchIds = (ctx.sessionManager.getBranch() as Array<{ id?: string }>)
      .map(entry => entry.id).filter((id): id is string => typeof id === "string");
    const state = loadScopedCompactionState({ projectId, sessionId }, branchIds);
    if (state) nativeContinuity.stage(sessionId, renderContinuityCapsule(state));
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const content = nativeContinuity.take(sessionId);
    if (!content) return;
    return {
      message: {
        customType: "smart-compact-native-continuity",
        content: "Native compaction continuity bridge (preserve these unresolved facts):\n\n" + content,
        display: false,
        details: { sessionId },
      },
    };
  });

  pi.on("message_end", async (event, ctx) => {
    try {
      const sessionId = resolveSessionId(ctx);
      const converted = convertToLlm([event.message as never])[0] as import("./types.ts").LlmMessage | undefined;
      if (!converted) return;
      const observation = damageMonitor.observe(sessionId, converted);
      if (!observation) return;
      logDamageReport(sessionId, observation.report, observation.details, observation.projectId);
      if (observation.report.reReadFiles.length > 0) {
        writeRemediationHints(observation.projectId, observation.report.reReadFiles);
      }
      if (observation.report.damageScore > 0) {
        ctx.ui.notify("Post-compaction damage detected: " + observation.report.summary, "warning");
      }
    } catch (error) {
      log.warn("online damage monitor message_end failed", error);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    damageMonitor.clear(sessionId);
    monitorCandidates.delete(sessionId);
    nativeContinuity.clear(sessionId);
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
        mode: { type: "string", description: "auto, balanced, aggressive, fast, or thorough (slow alias). Default: auto." },
        profile: { type: "string", description: "Deprecated alias: light, balanced, or aggressive." },
        verbose: { type: "boolean", description: "Show detailed pipeline output." },
        dry_run: { type: "boolean", description: "Run the pipeline but skip applying the compaction." },
        report: { type: "boolean", description: "Return recent performance metrics instead of compacting." },
        dashboard: { type: "boolean", description: "Write a local HTML metrics dashboard and return its path." },
        focus: { type: "string", description: "Topic or path that should receive extra preservation budget." },
        max_calls: { type: "number", description: "Maximum LLM calls for this run (1-100)." },
        max_input_tokens: { type: "number", description: "Aggregate prompt-token budget for this run (10000-1000000)." },
        max_latency_ms: { type: "number", description: "Optional hard pipeline latency budget in milliseconds (5000-600000). Modes use soft latency targets by default." },
      },
    },
    async execute(_id, params, signal, _onUp, ctx) {
      const profile = (params.profile === "light" || params.profile === "balanced" || params.profile === "aggressive") ? params.profile : undefined;
      const mode = params.mode === "slow"
        ? "thorough"
        : (["auto", "balanced", "aggressive", "fast", "thorough"] as const).find(value => value === params.mode);
      const verbose = !!params.verbose;
      const dryRun = !!params.dry_run;
      const focus = typeof params.focus === "string" ? params.focus.trim() || undefined : undefined;
      const maxLlmCalls = typeof params.max_calls === "number" && Number.isInteger(params.max_calls) && params.max_calls >= 1 && params.max_calls <= 100 ? params.max_calls : undefined;
      const maxLlmInputTokens = typeof params.max_input_tokens === "number" && Number.isInteger(params.max_input_tokens) && params.max_input_tokens >= 10_000 && params.max_input_tokens <= 1_000_000 ? params.max_input_tokens : undefined;
      const maxLatencyMs = typeof params.max_latency_ms === "number" && params.max_latency_ms >= 5000 && params.max_latency_ms <= 600000 ? params.max_latency_ms : undefined;
      if (params.report || params.dashboard) {
        const report = buildMetricsReport();
        const fp = params.dashboard ? writeMetricsDashboard() : null;
        return { content: [{ type: "text", text: report + (fp ? "\n\nDashboard: " + fp : "") }], details: undefined };
      }
      const config = loadConfig();
      const resolvedMode = mode ?? (profile ? modeFromLegacyProfile(profile) : config.mode);
      const sessionId = resolveSessionId(ctx);
      const existing = pendingRef.peek(sessionId);
      if (!dryRun && existing?.sessionId === sessionId) {
        return { content: [{ type: "text", text: "A smart summary is already staged for this session. The next /compact will use it; no LLM calls were made." }], details: undefined };
      }

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
      const { segModel, sumModel, verifyModel } = resolveModels(ctx, cur, config);
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
        await runSmartCompact({
          ctx, summaryModel: sumModel, segModel: segModel ?? sumModel, verifyModel: verifyModel ?? sumModel, mode: resolvedMode,
          verbose, dryRun, pendingRef, isRunning, autoTriggered: true, skipCompact: true,
          abortSignal: signal, focus, maxLlmCalls, maxLlmInputTokens, timeoutMs: maxLatencyMs,
        });
        const toolSecs = ((Date.now() - toolStart) / 1000).toFixed(1);
        const staged = pendingRef.peek(sessionId);
        if (staged?.sessionId === sessionId) {
          return { content: [{ type: "text", text: "Smart summary prepared (" + resolvedMode + " → " + (staged.details.mode ?? staged.details.profile) + "). Tokens: " + (staged.tokensBefore ?? 0).toLocaleString() + " — summary cached for " + Math.round(PENDING_TTL_MS / 60000) + " min. The next /compact will use this summary automatically." }], details: undefined };
        }
        // Dry-run returns before staging, so an empty slot is the *expected*
        // outcome — not a failure. Report it as such.
        if (dryRun) {
          return { content: [{ type: "text", text: "Dry run finished (" + resolvedMode + ", " + toolSecs + "s). Pipeline ran successfully; no summary was staged (dry-run skips staging by design)." }], details: undefined };
        }
        return { content: [{ type: "text", text: "Compaction finished (" + resolvedMode + ") but no summary was generated." }], details: undefined };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: "Compaction error: " + msg }], details: undefined };
      }
    },
  });
}

// extractUserNote is imported from utils/helpers.ts — no local duplicate
