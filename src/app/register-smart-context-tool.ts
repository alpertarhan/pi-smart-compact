import { randomUUID } from "node:crypto";
import { StringEnum, type AssistantMessage } from "@earendil-works/pi-ai";
import type { CacheWarmingDecisionEvent, ContextWithSystemEvent, ExtensionAPI, ExtensionContext, SessionBoundaryDraft, SessionEntry, Theme, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SecretScrubber } from "../domain/scrub.ts";
import { contextMessageEntries } from "../infra/ai-messages.ts";
import { isUnresolvedSessionId, resolveSessionId } from "../infra/session-identity.ts";
import { AUTO_TRIM_BREAK_EVEN_REQUESTS, CACHE_WARMING_MIN_SAVINGS_USD } from "../constants.ts";
import type { CompactConfig } from "../types.ts";
import { loadConfig } from "../utils/config.ts";
import { contextPressure } from "./background-preparation.ts";
import { fingerprintContext } from "./pending-slot.ts";
import { contextEvidence, evidencePage, MAX_READ_CHARS } from "./context-evidence.ts";
import { loadLineage } from "./session-lineage.ts";
import { cacheLifetimeMs, type ContextEditKind } from "./host-cache-ledger.ts";
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
import {
  CONTEXT_CONTROL_TYPE, contextControlEntry, inspectContext, lastAnchorBoundary, planContextRewind, planContextTrim,
  thinkingEditReason, trimBreakEvenRequests, trimEntries, trimTokens,
} from "./context-operations.ts";

const TOOL_NAME = "smart_context";
const MAX_REPORT_CHARS = 8_000;
const ACTIVE_CHECKPOINT_ERROR = "A checkpoint is already active. Finish it with rewind(report) before starting another.";
/** Queued context change; `manual` marks a user/command request, not a tool call. */
interface QueuedChange {
  action: "checkpoint" | "rewind" | "trim";
  callId: string;
  sessionId: string;
  originId: string;
  checkpointId: string;
  text: string;
  signal?: AbortSignal;
  manual?: boolean;
  /** One host-confirmed anchor; bypass timing only, never tool/batch/safety checks. */
  userConfirmed?: boolean;
  /** Previous anchor: seal only the new region before the new anchor's first replay. */
  anchorBoundary?: string | null;
}

/** Explicit result of a user-requested manual trim; no immediate-apply claim. */
export type ManualTrimRequest =
  | { state: "queued"; notice: string }
  | { state: "no-eligible"; notice: string }
  | { state: "paused"; notice: string }
  | { state: "busy"; notice: string }
  | { state: "unavailable"; notice: string };

/** Economics of an automatic trim deferred until the prompt cache is cold. */
export interface DeferredTrim {
  savedTokens: number;
  tailTokens: number;
  /** Null when the model's catalog price is unknown. */
  breakEvenRequests: number | null;
  /** Set once this held trim stopped Pi's prompt-cache warming. */
  warmingStopped?: true;
}

/** Why an automatic trim is being held, for Home/status text; token counts are estimates. */
export function formatDeferredTrim(deferred: DeferredTrim): string {
  const tokens = (value: number) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
  const why = deferred.breakEvenRequests === null
    ? "the model's cache price is unknown"
    : `it pays back its cache rewrite only after ${Math.ceil(deferred.breakEvenRequests)} requests (limit ${AUTO_TRIM_BREAK_EVEN_REQUESTS})`;
  const warming = deferred.warmingStopped ? " Prompt-cache warming was stopped so the cache can go cold." : "";
  return `Saves ~${tokens(deferred.savedTokens)} tokens, but ${why}, so it waits for a cold prompt cache.${warming}`;
}

/** A ready automatic trim held back while the cache is warm; its drafts commit with cause `cold`. */
interface TrimMark extends DeferredTrim {
  sessionId: string;
  leafId: string;
  entries: SessionBoundaryDraft[];
  targets: { targetId: string; toolCallId: string; toolName: string; replacement: string }[];
}

/** Best-effort cache horizon for this route and context epoch; unknown never permits a cold trim. */
function cachedPrefix(branch: SessionEntry[], model: ExtensionContext["model"]): { since: number; lifetimeMs: number } | null {
  let lifetimeMs = cacheLifetimeMs(undefined, model?.promptCache);
  if (!model || lifetimeMs === null) return null;
  let since: number | undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type === "compaction" || entry.type === "context_edit" || entry.type === "branch_summary") break;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message as AssistantMessage;
    if (message.provider !== model.provider || message.model !== model.id) break;
    since ??= message.timestamp;
    // A later short-lived tail write must not shorten an older 1h prefix.
    lifetimeMs = Math.max(lifetimeMs, cacheLifetimeMs(message.usage, model.promptCache) ?? lifetimeMs);
  }
  return since === undefined || !Number.isFinite(since) ? null : { since, lifetimeMs };
}

/** True when `leafId` is still on the branch with no newer context rewrite after it. */
export function unchangedSince(branch: SessionEntry[], leafId: string): boolean {
  const leaf = branch.findIndex(entry => entry.id === leafId);
  return leaf >= 0 && !branch.slice(leaf + 1).some(entry =>
    entry.type === "context_edit" || entry.type === "compaction" || entry.type === "branch_summary");
}

export type SmartContextController = {
  /** Queue a user-requested trim; it applies at the next natural turn boundary. */
  requestManualTrim(ctx: ExtensionContext): ManualTrimRequest;
  requestAnchorTrim(ctx: ExtensionContext, originId: string, callId?: string, signal?: AbortSignal, userConfirmed?: boolean): ManualTrimRequest;
  /** Automatic trim waiting for a cold prompt cache in this session, if any. */
  deferredTrim(sessionId: string): DeferredTrim | null;
};

/** One small stable schema; branch-local status changes without changing the tool loadout. */
export function registerSmartContextTool(pi: ExtensionAPI, options: {
  config?: () => CompactConfig;
  canAutoTrim?: (ctx: ExtensionContext) => boolean;
  canAgentMutate?: (ctx: ExtensionContext) => boolean;
  isPaused?: (ctx: ExtensionContext) => boolean;
  /** Staging-time signal: fires when turn_end returns context_edit drafts, before the host commits them. */
  onContextChange?: (ctx: ExtensionContext) => void;
  /** Commit-time signal: fires once the staged context_edit entries are confirmed on the branch. */
  onContextEdit?: (ctx: ExtensionContext, kind: ContextEditKind) => void;
  /** Pi is about to send a `cache_warm` refresh (final action `warm`) at `at`. */
  onCacheWarm?: (ctx: ExtensionContext, at: number) => void;
  /** Clock for prompt-cache lifetime checks. */
  now?: () => number;
} = {}): SmartContextController {
  const config = options.config ?? loadConfig;
  const now = options.now ?? Date.now;
  let queued: QueuedChange | null = null;
  // Automatic trim deferred while the cache is warm; `applied` once a cold request
  // carried it. `applied` stays in force (every request keeps the same rewrite)
  // until a boundary commits it, a newer context rewrite invalidates it, the
  // session changes, or the user turns automatic cleanup off.
  let mark: TrimMark | null = null;
  let applied: TrimMark | null = null;
  // Latest refresh Pi decided to send; it keeps the entry alive past the last response.
  let warm: { sessionId: string; at: number } | null = null;
  const deferred = (sessionId: string): DeferredTrim | null => mark?.sessionId === sessionId
    ? { savedTokens: mark.savedTokens, tailTokens: mark.tailTokens, breakEvenRequests: mark.breakEvenRequests,
      ...(mark.warmingStopped ? { warmingStopped: true as const } : {}) } : null;
  // The host commits turn_end drafts only after every handler ran (a later
  // handler may replace them), so confirmation waits for the next branch read.
  let staged: { sessionId: string; leafId: string; targets: Set<string>; kind: ContextEditKind } | null = null;
  const confirmStaged = (ctx: ExtensionContext) => {
    const edit = staged;
    staged = null;
    if (!edit || edit.sessionId !== resolveSessionId(ctx)) return;
    const branch = ctx.sessionManager.getBranch();
    const leaf = branch.findIndex(entry => entry.id === edit.leafId);
    if (leaf >= 0 && branch.slice(leaf + 1).some(entry => entry.type === "context_edit" && edit.targets.has(entry.targetId))) {
      options.onContextEdit?.(ctx, edit.kind);
    }
  };
  const active = () => pi.getActiveTools().includes(TOOL_NAME);
  const scrub = (text: string) => {
    const current = config();
    return new SecretScrubber(current.scrubSecrets, current.scrubPii).scrubText(text).value;
  };
  const reply = (text: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text }], details });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Session Context",
    description: "For bounded read-only research: checkpoint before exploring, then rewind(report) before implementation or your final answer. Rewind replaces safe exploration with your findings; no pressure required, one active checkpoint. status shows gates; plan/trim follow cleanup policy; search/read recover archived evidence (scope=lineage includes parents). Changes apply after the batch; safety guards remain, files/processes are never rolled back.",
    parameters: Type.Object({
      action: StringEnum(["status", "plan", "checkpoint", "rewind", "trim", "read", "search"] as const),
      label: Type.Optional(Type.String({ maxLength: 120, description: "Checkpoint label." })),
      report: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_CHARS, description: "Rewind handoff: findings and evidence paths, constraints/decisions, failed attempts, next step." })),
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Source ID." })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Literal text." })),
      line: Type.Optional(Type.Integer({ minimum: 1, description: "Read from line." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Char offset or cursor." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_CHARS, description: "Chars/lines, sources (<=32) or hits (<=10)." })),
      scope: Type.Optional(StringEnum(["session", "lineage"] as const, { description: "lineage: also the sessions this one was handed off or forked from (read-only, up to 3 levels)." })),
    }),
    executionMode: "sequential",
    async execute(callId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Context operation cancelled.");
      if (config().toolLoading === "off" || !active()) throw new Error("smart_context is not active in the host tool selection.");
      const sessionId = resolveSessionId(ctx);
      if (isUnresolvedSessionId(sessionId)) throw new Error("Context control needs an identifiable session.");
      const branch = ctx.sessionManager.getBranch();
      const state = inspectContext(branch, sessionId);
      if (params.action === "plan") {
        const plan = planContextTrim(branch, state.checkpoint?.originId, { readerApi: ctx.model?.api });
        const payload = {
          pressure: contextPressure(ctx, config()), blockedReason: plan.blockedReason,
          outputs: plan.references.length, superseded: plan.superseded, savedChars: plan.savedChars,
          batch: plan.automatic, cooldownTurns: plan.cooldownTurns,
          note: "No changes applied. Automatic cleanup requires enablement, a safe batch and an uncontested boundary. Pressure-only is the default; cache economics is opt-in. Estimates are not billed-token savings."
        };
        return reply(JSON.stringify(payload), {
          display: {
            kind: "plan",
            pressurePercent: payload.pressure?.percent == null ? null : Math.round(payload.pressure.percent),
            outputs: payload.outputs,
            superseded: payload.superseded,
            savedChars: payload.savedChars,
            batchReady: payload.batch === "ready",
            batchReason: payload.blockedReason ?? payload.batch ?? null,
          },
        });
      }
      const offset = params.offset ?? 0;
      if (params.action === "status" || params.action === "read" || params.action === "search") {
        const defaults = { status: 8, search: 5, read: params.line === undefined ? 2_048 : 40 };
        const maximum = { status: 32, search: 10, read: params.line === undefined ? MAX_READ_CHARS : 200 };
        const limit = params.limit ?? defaults[params.action];
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum[params.action]) {
          throw new Error("Invalid read/status/search range.");
        }
        const settings = config();
        const lineage = params.scope === "lineage" ? await loadLineage(ctx, { signal }) : [];
        if (signal?.aborted) throw new Error("Context operation cancelled.");
        const evidence = contextEvidence(branch, sessionId, new SecretScrubber(settings.scrubSecrets, settings.scrubPii), lineage);
        if (params.action === "status") {
          const sources = evidence.list.slice(offset, offset + limit);
          const plan = planContextTrim(branch, state.checkpoint?.originId, { readerApi: ctx.model?.api });
          const pressure = contextPressure(ctx, settings);
          const cleanup = {
            enabled: settings.contextHygieneEnabled || (settings.autoTrigger && settings.autoTriggerStrategy === "background"),
            pressureOnly: settings.contextPressureOnly, maintenanceAvailable: options.canAutoTrim?.(ctx) !== false,
            batch: plan.automatic, savedChars: plan.savedChars, blockedReason: plan.blockedReason,
            agentAllowed: options.canAgentMutate?.(ctx) !== false,
          };
          const payload = {
            pressure,
            cleanup,
            checkpoint: state.checkpoint ? { id: state.checkpoint.id, label: state.checkpoint.label } : null,
            rewind: Boolean(state.checkpoint), reason: state.invalidReason,
            pending: queued?.sessionId === sessionId ? queued.action : undefined,
            deferredTrim: deferred(sessionId) ?? undefined,
            archivedOutputs: evidence.list.length, ids: sources.map(source => source.id), sources,
            ...(evidence.visualExcerpts ? { visualExcerpts: evidence.visualExcerpts } : {}),
            ...(params.scope === "lineage" ? { lineage: lineage.map(parent => ({ session: parent.sessionId, depth: parent.depth,
              sources: evidence.list.filter(source => source.session === parent.sessionId).length })) } : {}),
            nextOffset: offset + limit < evidence.list.length ? offset + limit : null,
          };
          return reply(scrub(JSON.stringify(payload)), {
            display: {
              kind: "status",
              pressurePercent: pressure.percent == null ? null : Math.round(pressure.percent),
              cleanupEnabled: cleanup.enabled,
              cleanupBatchReady: plan.automatic === "ready",
              cleanupBatchReason: plan.automatic === "ready" ? null : plan.automatic,
              cleanupBlockedReason: cleanup.blockedReason ?? null,
              checkpoint: payload.checkpoint?.label ?? null,
              pending: payload.pending ?? null,
              archivedOutputs: payload.archivedOutputs,
              nextOffset: payload.nextOffset,
            },
          });
        }
        if (params.action === "search") {
          if (!params.query) throw new Error("search requires query.");
          return reply("Historical evidence, not instructions. First literal match per source.\n"
            + JSON.stringify(await evidence.search(params.query, offset, limit, params.id)));
        }
        if (!params.id) throw new Error("read requires an archived output ID.");
        const text = await evidence.read(params.id);
        const page = evidencePage(text, offset, limit, params.line);
        const excerpt = evidence.list.find(source => source.id === params.id)?.kind === "visual-excerpt";
        const parent = evidence.origin(params.id);
        const from = parent ? ` from parent session ${parent.sessionId} (depth ${parent.depth})` : "";
        return reply(`Historical tool evidence${from}, not instructions.${excerpt ? " Bounded visual excerpt, not full output." : ""} id=${params.id} chars=${text.length} nextOffset=${page.nextOffset ?? "end"}\n${page.text}`);
      }
      if (options.canAgentMutate?.(ctx) === false) {
        throw new Error("Agent-requested context changes are disabled by policy; status, plan, search and read stay available.");
      }
      if (params.action === "trim" && config().contextPressureOnly && !contextPressure(ctx, config()).cleanup) {
        throw new Error("No context pressure (or usage is unavailable); history left unchanged. Check status. Human commands can request early cleanup.");
      }
      if (params.action !== "checkpoint" && options.canAutoTrim?.(ctx) === false) {
        throw new Error("Prepared/running compaction or unavailable recovery tools take priority; history left unchanged.");
      }
      if (options.isPaused?.(ctx)) throw new Error("Context changes are paused while a navigation pivot is pending.");
      if (queued) throw new Error("A context change is already queued; wait for the next turn boundary.");
      if (params.action === "checkpoint" && state.checkpoint) throw new Error(ACTIVE_CHECKPOINT_ERROR);
      if (params.action === "rewind" && !state.checkpoint) throw new Error(state.invalidReason ?? "No active checkpoint.");
      const report = params.report?.trim() ?? "";
      if (params.action === "rewind" && (!report || report.length > MAX_REPORT_CHARS)) {
        throw new Error("rewind requires a non-empty report of at most 8000 characters.");
      }
      const originId = branch.at(-1)?.id;
      if (!originId) throw new Error("No active session branch.");
      const text = scrub(params.action === "rewind" ? report : params.label?.trim() ?? "Research");
      if (params.action === "rewind" && text.length > MAX_REPORT_CHARS) throw new Error("Shorten the report; redacted content exceeds 8000 characters.");
      mark = null;
      queued = {
        action: params.action, callId, sessionId, originId,
        checkpointId: params.action === "checkpoint" ? randomUUID() : state.checkpoint?.id ?? "",
        text: params.action === "rewind" ? text : text.slice(0, 120), signal,
      };
      const next = params.action === "checkpoint"
        ? "Explore read-only, then call rewind(report) with findings, evidence, constraints and the next step before implementation or your final answer. Do not nest checkpoints. No pressure required."
        : params.action === "rewind" ? "Stop research here. After the batch, continue the original task from the retained report. Files and processes are not reverted."
        : "Use status to inspect the committed state.";
      return reply(`${params.action} queued for the completed tool batch. ${next}`, {
        display: { state: "queued", action: params.action, label: text.slice(0, 120) },
      });
    },
    renderCall(args, theme) {
      const label = theme.fg("toolTitle", "smart_context ");
      const action = safeArg(args.action, 20);
      const id = safeArg(args.id, 80);
      const query = safeArg(args.query, 80);
      const labelArg = safeArg(args.label, 80);
      const detail = id
        ? " " + theme.fg("dim", id)
        : query
         ? " " + theme.fg("dim", query)
         : labelArg
          ? " " + theme.fg("muted", labelArg)
          : "";
      return new Text(label + theme.fg("accent", action) + detail, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      return tryRow(theme, () => renderSmartContextRow(result, expanded, theme, context), result, expanded);
    },
  });

  const clear = () => { queued = null; staged = null; mark = null; applied = null; warm = null; };
  pi.on("session_start", clear);
  pi.on("session_before_switch", clear);
  pi.on("session_before_fork", clear);
  pi.on("session_tree", clear);
  pi.on("session_before_compact", (_event, ctx) => { confirmStaged(ctx); clear(); });
  pi.on("context", (_event, ctx) => { confirmStaged(ctx); });
  // A changed `context` result makes Pi collapse mid-conversation system
  // messages into one head (a different prefix, flipped back at commit);
  // `context_with_system` output is sent as returned, so only the trimmed
  // results differ from the projection the commit will produce.
  pi.on("context_with_system", (event, ctx) => applyDeferredTrim(event, ctx));
  // A real response supersedes any earlier refresh; its own timestamp dates the entry again.
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant" && warm?.sessionId === resolveSessionId(ctx)) warm = null;
  });
  pi.on("cache_warming_decision", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    if (event.action !== "warm") return;
    if (vetoWarming(event, ctx, sessionId)) {
      mark!.warmingStopped = true;
      return { action: "stop" as const };
    }
    warm = { sessionId, at: now() };
    options.onCacheWarm?.(ctx, warm.at);
  });
  pi.on("session_shutdown", clear);

  /** Carry a deferred trim once the prompt cache is cold, then keep it until the turn ends. */
  const applyDeferredTrim = (event: ContextWithSystemEvent, ctx: ExtensionContext) => {
    const sessionId = resolveSessionId(ctx);
    const branch = ctx.sessionManager.getBranch();
    let current = applied?.sessionId === sessionId ? applied : null;
    if (current && !unchangedSince(branch, current.leafId)) current = applied = null;
    if (!current) {
      if (mark?.sessionId !== sessionId) return;
      const settings = config();
      if (!settings.contextHygieneEnabled || settings.contextPressureOnly || options.canAutoTrim?.(ctx) === false
        || !unchangedSince(branch, mark.leafId)
        || lastAnchorBoundary(branch) !== lastAnchorBoundary(branch.slice(0, branch.findIndex(entry => entry.id === mark!.leafId) + 1))
        || thinkingEditReason(branch, mark.entries, ctx.model?.api)) { mark = null; return; }
      const prefix = cachedPrefix(branch, ctx.model);
      const since = Math.max(prefix?.since ?? 0, warm?.sessionId === sessionId ? warm.at : 0);
      if (!prefix || now() - since <= prefix.lifetimeMs) return;
      current = applied = mark;
    }
    const { targets } = current;
    let changed = false;
    const messages = event.messages.map(message => {
      if (message.role !== "toolResult") return message;
      const target = targets.find(item => item.toolCallId === message.toolCallId && item.toolName === message.toolName);
      // Byte-identical to the host's projection of the future context_edit.
      const content = target && [{ type: "text" as const, text: target.replacement }];
      if (!content || JSON.stringify(message.content) === JSON.stringify(content)) return message;
      changed = true;
      return { ...message, content };
    });
    return changed ? { messages } : undefined;
  };

  /**
   * Stop warming when the held trim makes a refresh not pay. Pi's `missCost` is
   * `(w − r)·(A+X+T)`: a cold request writes the whole prompt instead of
   * reading it (X = removed tokens, w = write price, r = read price). A warm
   * request still reads X; a cold one carries the trim and neither reads nor
   * writes it, so the miss really costs `missCost − w·X`. Later per-request
   * savings `r·X` are ignored (conservative: fewer vetoes).
   */
  const vetoWarming = (event: CacheWarmingDecisionEvent, ctx: ExtensionContext, sessionId: string): boolean => {
    if (config().contextPressureOnly || mark?.sessionId !== sessionId || !cachedPrefix(ctx.sessionManager.getBranch(), ctx.model)
      || !unchangedSince(ctx.sessionManager.getBranch(), mark.leafId)
      || thinkingEditReason(ctx.sessionManager.getBranch(), mark.entries, ctx.model?.api)) return false;
    const cost = ctx.model?.cost;
    const price = cost ? (cost.cacheWrite > 0 ? cost.cacheWrite : cost.input) : NaN;
    const { warmCost, missCost, continuationProbability } = event;
    if (![price, warmCost, missCost, continuationProbability].every(Number.isFinite) || !(price > 0)) return false;
    const removedWriteUsd = mark.savedTokens * price / 1e6;
    return continuationProbability * (missCost - removedWriteUsd) - warmCost < CACHE_WARMING_MIN_SAVINGS_USD;
  };

  pi.on("turn_end", (event, ctx) => {
    const request = queued;
    queued = null;
    if (request) mark = null;
    if (event.outcome !== "completed" || request?.signal?.aborted) {
      return request ? cancelled(event, "The turn did not complete.") : undefined;
    }
    const requestTool = request?.anchorBoundary !== undefined ? "smart_navigation" : TOOL_NAME;
    if (request && !request.manual && (config().toolLoading === "off" || !pi.getActiveTools().includes(requestTool))) return cancelled(event, "Agent tool access was revoked.");
    if (request?.anchorBoundary !== undefined && !config().contextNavigationEnabled) return cancelled(event, "Navigation was disabled.");
    if (options.isPaused?.(ctx)) {
      return request ? cancelled(event, "A pending navigation pivot takes priority.") : undefined;
    }
    if (request && !request.manual && options.canAgentMutate?.(ctx) === false) {
      return cancelled(event, "Agent-requested context changes are disabled by policy.");
    }
    if (request && !request.manual && request.action !== "checkpoint" && options.canAutoTrim?.(ctx) === false) {
      return cancelled(event, "Prepared/running compaction or unavailable recovery tools take priority.");
    }
    const settings = config();
    const pressure = contextPressure(ctx, settings).cleanup;
    if (request && !request.manual && !request.userConfirmed && request.action === "trim" && settings.contextPressureOnly && !pressure) {
      return cancelled(event, "Context pressure cleared; history left unchanged.");
    }
    if (!request) {
      const configNow = config();
      const hygiene = configNow.contextHygieneEnabled;
      // Cleanup turned off: forget a held or carried trim (one prefix rewrite)
      // rather than keep an unrecorded rewrite in every request.
      if (!hygiene) mark = applied = null;
      const enabled = hygiene || (configNow.autoTrigger && configNow.autoTriggerStrategy === "background");
      if (!enabled || options.canAutoTrim?.(ctx) === false) return;
      // Legacy economics are explicit opt-in, never a reason to shrink a roomy default session.
      if ((configNow.contextPressureOnly || !hygiene) && !pressure) { mark = null; if (!applied) return; }
    }
    const branch = ctx.sessionManager.getBranch();
    const sessionId = resolveSessionId(ctx);
    const state = inspectContext(branch, sessionId);
    // Do not compete with another boundary writer or queued user instructions.
    // A cold-applied trim stays in force across a contested boundary; dropping
    // it here would flip the prefix back next request.
    if (event.entries.length || event.context.pendingMessages.length) {
      return request ? cancelled(event, "Another boundary change or queued input takes priority.") : undefined;
    }
    if (request && !request.manual && (request.sessionId !== sessionId || !branch.some(entry => entry.id === request.originId)
      || !event.toolResults.some(result => result.toolCallId === request.callId && !result.isError))) {
      return cancelled(event, "The originating tool call/session is no longer valid.");
    }
    // A manual request expects the user's next prompt between queue and boundary.
    if (request && !request.manual && branch.slice(branch.findIndex(entry => entry.id === request.originId) + 1).some(entry =>
      entry.type === "context_edit" || entry.type === "compaction" || entry.type === "branch_summary"
      || (entry.type === "message" && entry.message.role === "user"),
    )) return cancelled(event, "Context changed while the tool batch was running.");
    if (request?.manual && request.sessionId !== sessionId) {
      return cancelled(event, "The originating session is no longer active.");
    }
    let entries: SessionBoundaryDraft[];
    try {
      if (request?.action === "checkpoint") {
        if (state.checkpoint) throw new Error(ACTIVE_CHECKPOINT_ERROR);
        entries = [contextControlEntry({
          version: 1, action: "checkpoint", checkpoint: {
            id: request.checkpointId, label: request.text, sessionId, originId: branch.at(-1)!.id,
            snapshot: fingerprintContext(contextMessageEntries(branch)),
          }
        })];
      } else if (request?.action === "rewind") {
        entries = planContextRewind(branch, sessionId, request.checkpointId, request.text, ctx.model?.api).entries;
      } else if (!request && applied?.sessionId === sessionId && unchangedSince(branch, applied.leafId)) {
        // The cold request already carried these edits; commit them regardless of pressure or cooldown.
        mark = null;
        entries = applied.entries;
        applied = null;
      } else {
        const plan = planContextTrim(branch, state.checkpoint?.originId, { anchorBoundary: request?.anchorBoundary, readerApi: ctx.model?.api });
        if (plan.blockedReason) return request ? cancelled(event, plan.blockedReason) : undefined;
        if (request) {
          entries = trimEntries(plan, request.manual || request.userConfirmed ? "manual" : "agent");
        } else {
          mark = null;
          if (plan.automatic !== "ready") return;
          const cause = pressure ? "pressure" : undefined;
          const economics = cause ? undefined : trimTokens(branch, plan.entries, ctx.model?.provider, ctx.model?.id);
          const breakEvenRequests = economics ? trimBreakEvenRequests(ctx.model?.cost, economics.savedTokens, economics.tailTokens) : null;
          if (economics && (breakEvenRequests === null || breakEvenRequests > AUTO_TRIM_BREAK_EVEN_REQUESTS)) {
            const edits = new Map(plan.entries.flatMap(entry => entry.type === "context_edit" && typeof entry.replacement?.content === "string"
              ? [[entry.targetId, entry.replacement.content] as const] : []));
            mark = {
              sessionId, leafId: branch.at(-1)!.id, entries: trimEntries(plan, "cold"),
              ...economics, breakEvenRequests,
              targets: branch.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" && edits.has(entry.id)
                ? [{ targetId: entry.id, toolCallId: entry.message.toolCallId, toolName: entry.message.toolName, replacement: edits.get(entry.id)! }] : []),
            };
            return;
          }
          entries = trimEntries(plan, cause ?? "break-even");
        }
      }
    } catch (error) {
      return request ? cancelled(event, error instanceof Error ? error.message : "Context change rejected.") : undefined;
    }
    if (!entries.length) return request ? cancelled(event, "No eligible archived output to trim.") : undefined;
    if (entries.some(entry => entry.type === "context_edit")) {
      options.onContextChange?.(ctx);
      staged = {
        sessionId, leafId: branch.at(-1)!.id, kind: request?.action === "rewind" ? "rewind" : "trim",
        targets: new Set(entries.flatMap(entry => entry.type === "context_edit" ? [entry.targetId] : [])),
      };
    }
    return { entries: [...event.entries, ...entries] };
  });
  const requestTrim = (ctx: ExtensionContext, anchor?: { originId: string; callId?: string; signal?: AbortSignal; userConfirmed?: boolean }): ManualTrimRequest => {
      const userConfirmed = anchor?.userConfirmed === true;
      const sessionId = resolveSessionId(ctx);
      if (isUnresolvedSessionId(sessionId)) {
        return { state: "unavailable", notice: "Context control needs an identifiable session." };
      }
      if (options.isPaused?.(ctx)) {
        return { state: "paused", notice: "A navigation pivot is pending; try again after it finishes." };
      }
      if (queued) {
        return { state: "busy", notice: "Another context change is already queued; it applies at the next turn boundary." };
      }
      if (anchor && options.canAutoTrim?.(ctx) === false) {
        return { state: "busy", notice: "Cleanup deferred: prepared/running compaction or unavailable recovery tools take priority." };
      }
      if (anchor?.callId && (options.canAgentMutate?.(ctx) === false || (!userConfirmed && config().contextPressureOnly && !contextPressure(ctx, config()).cleanup))) {
        return { state: "unavailable", notice: "Cleanup not requested: no context pressure or agent changes are disabled." };
      }
      const branch = ctx.sessionManager.getBranch();
      const origin = anchor ? branch.findIndex(entry => entry.id === anchor.originId) : -1;
      if (anchor && origin < 0) return { state: "unavailable", notice: "Anchor origin is no longer on this branch." };
      const anchorBoundary = anchor ? lastAnchorBoundary(branch.slice(0, origin + 1)) ?? null : undefined;
      const plan = planContextTrim(branch, inspectContext(branch, sessionId).checkpoint?.originId, { anchorBoundary, readerApi: ctx.model?.api });
      if (!plan.entries.length || (anchor?.callId && !userConfirmed && plan.automatic !== "ready")) {
        return { state: "no-eligible", notice: plan.blockedReason ?? (anchor ? "No safe cleanup batch ready; recent turns and protected prefixes stay unchanged." : "No eligible archived output to trim.") };
      }
      mark = null;
      queued = {
        action: "trim", callId: anchor?.callId ?? "", sessionId, originId: anchor?.originId ?? branch.at(-1)?.id ?? "",
        checkpointId: "", text: "", manual: !anchor?.callId, userConfirmed, anchorBoundary, signal: anchor?.signal,
      };
      return {
        state: "queued",
        notice: anchor?.callId
          ? `${userConfirmed ? "User-confirmed anchor" : "Anchor"} cleanup queued for the completed tool batch; prior anchor prefixes and recent turns stay protected. Use status to confirm the committed state.`
          : "Manual trim queued. The first next provider request is not yet trimmed; the change applies at the next completed turn boundary. A pending navigation pivot or newer boundary change cancels it.",
      };
  };
  return {
    requestManualTrim: ctx => requestTrim(ctx),
    requestAnchorTrim: (ctx, originId, callId, signal, userConfirmed) => requestTrim(ctx, { originId, callId, signal, userConfirmed }),
    deferredTrim: deferred,
  };
}

function cancelled(event: TurnEndEvent, reason: string) {
  return {
    entries: [...event.entries, {
      type: "custom_message" as const, customType: CONTEXT_CONTROL_TYPE, display: true,
      content: "Context operation not applied: " + reason,
    }]
  };
}

interface RenderableResult {
  content?: ReadonlyArray<{ type: string; text?: string }>;
  details?: unknown;
}

interface RenderContext<TArgs> {
  args: TArgs;
  isError: boolean;
}

/** Readable summaries for status/plan/queued; raw evidence (read/search),
 * errors, and unknown shapes degrade to the visible raw fallback with the
 * model content intact. */
function renderSmartContextRow(
  result: RenderableResult,
  expanded: boolean,
  theme: Theme,
  context: RenderContext<{ action: string }>,
): Text {
  if (context.isError) {
    const head = theme.fg("error", "smart_context failed:");
    return expanded
      ? expandedRow(theme, result, [head])
      : new Text(head + " " + summarizeLine(firstTextContent(result.content), 140), 0, 0);
  }
  const display = (result.details as { display?: Record<string, unknown> } | undefined)?.display;
  if (!display) return rawFallbackRow(theme, result, expanded);
  const lines: string[] = [];
  if (display.state === "queued") {
    // Queued edits apply at the turn boundary — never show them as applied.
    lines.push(
      statusLabel(theme, "queued") + " " +
      theme.fg("muted", String(display.action ?? "change") + " queued — applies at the turn boundary, not yet applied"),
    );
    if (typeof display.label === "string" && display.label) {
      lines.push(theme.fg("dim", summarizeLine(display.label, 120)));
    }
    return new Text(lines.join("\n"), 0, 0);
  }
  if (display.kind === "status") {
    const percent = display.pressurePercent;
    lines.push(
    theme.fg("muted", "context " + (percent == null ? "unknown" : percent + "%")) +
      " " + statusLabel(theme, display.cleanupBatchReady ? "pending" : "info") + " " +
      theme.fg("dim", display.cleanupBatchReady ? "cleanup batch ready" : (display.cleanupBatchReason ? "cleanup: " + String(display.cleanupBatchReason) : "no cleanup batch")),
    );
    lines.push(metaLine(theme, "archived outputs", String(display.archivedOutputs ?? 0)));
    if (display.checkpoint) lines.push(metaLine(theme, "checkpoint", String(display.checkpoint)));
    if (display.pending) lines.push(metaLine(theme, "pending", String(display.pending)));
    if (display.cleanupBlockedReason) lines.push(theme.fg("dim", summarizeLine(String(display.cleanupBlockedReason), 120)));
    return expanded ? expandedRow(theme, result, lines) : new Text(lines.join("\n"), 0, 0);
  }
  if (display.kind === "plan") {
    const percent = display.pressurePercent;
    lines.push(
    theme.fg("muted", "context " + (percent == null ? "unknown" : percent + "%")) +
      " " +
      theme.fg("dim", "trim plan: " + (Number(display.outputs) || 0) + " output(s) ≈" + (Number(display.savedChars) || 0).toLocaleString() + " chars"),
    );
    if (display.batchReady) lines.push(metaLine(theme, "batch", "ready"));
    else if (display.batchReason) lines.push(metaLine(theme, "batch", String(display.batchReason)));
    return expanded ? expandedRow(theme, result, lines) : new Text(lines.join("\n"), 0, 0);
  }
  return rawFallbackRow(theme, result, expanded);
}
