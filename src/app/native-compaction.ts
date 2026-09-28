/**
 * Provider-native compaction engine on stock Pi (public extension APIs only).
 *
 * One nested `ctx.modelRegistry.streamSimple` call lets Pi's adapter build the
 * ordinary request (auth, OAuth, serialization); the fetch from
 * `createCompactionFetch` turns it into the provider's compaction request,
 * sends it once and answers Pi with a non-retryable 400. The returned state is
 * stored in the compaction entry's `details.native` and replayed by
 * `before_provider_request` (see `createNativeReplayHook`). Runs only on the
 * CURRENT session model/route; the state is opaque: never mutated, scrubbed or
 * logged.
 */
import { notifyUser, recordIssue, reportIssue } from "../utils/issues.ts";
import { loadConfig } from "../utils/config.ts";
import type { Api, Message, Model, Tool } from "@earendil-works/pi-ai";
import type {
  EngineAttempt,
  LlmMessage,
  PendingCompaction,
  SessionMessageEntry,
  SmartCompactDetails,
} from "../types.ts";
import { VERSION } from "../constants.ts";
import { cacheHitRateOf } from "../utils/cache.ts";
import { runType } from "./steps/metrics.ts";
import { isRecord } from "../utils/type-guards.ts";
import { fingerprintContext } from "./pending-slot.ts";
import type { WindowedRc } from "./run-context.ts";
import { branchEntryIds } from "../infra/session-identity.ts";
import { clearCompactProgress } from "../ui/overlays.ts";
import { providerErrorDetail } from "../ui/error-format.ts";
import {
  createCompactionFetch,
  isNativeApi,
  isNativeState,
  replayNativeState,
  type JsonObject,
  type NativeCompactionResult,
  type NativeState,
  type NativeUsage,
} from "../infra/native-protocol.ts";
import { usesOAuth } from "../infra/llm-client.ts";

const PRIOR_REPLAY_FAILED = "Prior native compaction state could not be replayed; no request was sent";

/** Appended to an Anthropic OAuth "extra usage" rejection of the compaction request. */
export const CLAUDE_OAUTH_ADAPTER_HINT =
  "Anthropic billed this Claude subscription request as extra usage. Native compaction on Claude subscriptions is experimental; use an Anthropic API key, or put the smart summary engine first.";

function withClaudeOAuthHint(reason: string, api: string, oauth: boolean): string {
  return api === "anthropic-messages" && oauth && /\b400\b/.test(reason) && /extra usage/i.test(reason)
    ? reason + " " + CLAUDE_OAUTH_ADAPTER_HINT
    : reason;
}

/** Active tool definitions for the nested request (Anthropic rejects tool_use history without tools). */
export type NativeToolSource = () => Tool[];
let toolSource: NativeToolSource = () => [];
/** Wired once from the extension entry (`pi.getAllTools()` filtered by `pi.getActiveTools()`). */
export function setNativeToolSource(source: NativeToolSource): void {
  toolSource = source;
}

let transport: typeof fetch | undefined;
/** Test seam: the network behind the one real compaction request. Undefined = global fetch. */
export function setNativeTransportForTests(fetchImpl: typeof fetch | undefined): void {
  transport = fetchImpl;
}

type RouteModel = Pick<Model<Api>, "api" | "provider" | "id">;

/** Native state of a compaction entry, only when valid and for this exact route. */
export function nativeStateOf(entry: unknown, model: RouteModel | undefined): NativeState | undefined {
  if (!model || !isRecord(entry) || entry.type !== "compaction" || !isRecord(entry.details)) return undefined;
  const state = entry.details.native;
  if (!isNativeState(state)) return undefined;
  return state.api === model.api && state.provider === model.provider && state.model === model.id
    ? state
    : undefined;
}

function assistantCompleted(message: unknown): boolean {
  if (!isRecord(message) || message.role !== "assistant") return false;
  if (message.stopReason !== "stop") return false;
  const content = Array.isArray(message.content) ? message.content : [];
  return !content.some((block) => isRecord(block) && block.type === "toolCall");
}

/**
 * Find a clean turn boundary at or before `keepFrom`: the kept tail starts at a
 * user message on an entry boundary, and the prefix ends with a completed
 * assistant reply (no pending tool call). Returns null when none exists.
 */
export function nativeCompactionCut(
  msgs: readonly SessionMessageEntry[],
  keepFrom: number,
): number | null {
  for (let cut = Math.min(keepFrom, msgs.length - 1); cut >= 2; cut--) {
    const kept = msgs[cut];
    const last = msgs[cut - 1];
    if (!isRecord(kept.message) || (kept.message.role as string) !== "user") continue;
    if (kept.id === last.id) continue; // never split one session entry
    if (!assistantCompleted(last.message)) continue;
    return cut;
  }
  return null;
}

export function nativeRouteLabel(model: Pick<Model<Api>, "provider" | "id">): string {
  return model.provider + "/" + model.id;
}

export type NativeAttemptResult =
  | { outcome: "staged"; pending: PendingCompaction; usage: NativeUsage }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string };

/** Literal, single-line, bounded error text for engine outcome reports. */
export function engineErrorText(error: unknown): string {
  return providerErrorDetail(error) || "unknown error";
}

/**
 * Run one native compaction attempt and build a pending candidate. Never
 * retries; applies nothing. Budget: consumes one provider call.
 */
export async function attemptNativeCompaction(
  rc: WindowedRc,
  priorAttempts: readonly EngineAttempt[],
): Promise<NativeAttemptResult> {
  const model = rc.ctx.model;
  if (!model) return { outcome: "skipped", reason: "no current session model" };
  if (!isNativeApi(model.api)) {
    return {
      outcome: "skipped",
      reason: "native compaction is not supported for api " + model.api,
    };
  }
  const api = model.api;
  const cut = nativeCompactionCut(rc.msgs, rc.keepFrom);
  if (cut === null) {
    return {
      outcome: "skipped",
      reason: "no clean turn boundary (user message after a completed assistant reply)",
    };
  }
  const prefix = rc.msgs.slice(0, cut);
  const prefixTokens = prefix.reduce(
    (sum, entry) => sum + rc.estimator.message(entry.message as LlmMessage),
    0,
  );
  const totalEstimate = rc.msgs.reduce(
    (sum, entry) => sum + rc.estimator.message(entry.message as LlmMessage),
    0,
  );
  const retainedTailTokens = Math.max(0, totalEstimate - prefixTokens);

  try {
    rc.services.budget.reserveCall(0, 0);
  } catch (error) {
    return { outcome: "failed", reason: "provider-call budget exhausted: " + engineErrorText(error) };
  }
  // A prefix that starts with an earlier native compaction of this route builds on it.
  const firstEntry = rc.branch.find((entry) => isRecord(entry) && entry.id === prefix[0]?.id);
  const priorState = nativeStateOf(firstEntry, model);
  const prior = priorState && isRecord(firstEntry) && typeof firstEntry.summary === "string"
    ? { state: priorState, summary: firstEntry.summary }
    : undefined;
  const oauth = usesOAuth(rc.ctx, model);
  // The prior block is replayed as the caller's payload hook, so provider
  // overrides that normalize the final payload (e.g. a subscription billing
  // header) run after it and describe the exact messages sent.
  let priorReplayFailed = false;
  const onPayload = prior
    ? (payload: unknown) => {
      const replayed = replayNativeState(api, payload, prior.state, prior.summary);
      if (replayed) return replayed;
      priorReplayFailed = true;
      throw new Error(PRIOR_REPLAY_FAILED);
    }
    : undefined;
  const wrapper = createCompactionFetch({
    api,
    provider: model.provider,
    model: model.id,
    instructions: rc.userNote?.trim() || undefined,
    ...(transport ? { fetch: transport } : {}),
  });
  let streamError = "";
  nestedRequests++;
  try {
    const stream = rc.ctx.modelRegistry.streamSimple(
      model,
      {
        systemPrompt: rc.ctx.getSystemPrompt(),
        messages: prefix.map((entry) => entry.message as Message),
        tools: toolSource(),
      },
      {
        signal: rc.cancellation.signal,
        fetch: wrapper.fetch,
        transport: "sse",
        maxRetries: 0,
        sessionId: rc.sessionId,
        ...(onPayload ? { onPayload } : {}),
      },
    );
    const final = await stream.result();
    streamError = final.errorMessage ?? "";
  } catch (error) {
    streamError = engineErrorText(error);
  } finally {
    nestedRequests--;
  }
  if (rc.cancellation.signal.aborted) return { outcome: "failed", reason: "cancelled" };
  const outcome = wrapper.result();
  // No request left Pi (auth, config): the nested stream's own error is the reason.
  if (outcome === undefined) {
    if (priorReplayFailed) return { outcome: "failed", reason: PRIOR_REPLAY_FAILED };
    return { outcome: "failed", reason: (streamError && providerErrorDetail(new Error(streamError))) || "no request was sent" };
  }
  if (outcome instanceof Error) {
    return { outcome: "failed", reason: withClaudeOAuthHint(engineErrorText(outcome), api, oauth) };
  }
  const result: NativeCompactionResult = outcome;
  const state = result.state;
  if (
    !isNativeState(state) ||
    state.api !== model.api ||
    state.provider !== model.provider ||
    state.model !== model.id
  ) {
    return {
      outcome: "failed",
      reason: "provider returned compaction state for a different or invalid route",
    };
  }
  const summary = typeof result.summary === "string" ? result.summary.trim() : "";
  if (!summary) return { outcome: "failed", reason: "provider returned an empty summary" };

  const nativeTokens = Math.ceil(JSON.stringify(state.items).length / 4);
  if (nativeTokens >= prefixTokens) {
    return {
      outcome: "failed",
      reason:
        "native result (~" +
        nativeTokens.toLocaleString() +
        "t) is not smaller than the compacted prefix (~" +
        prefixTokens.toLocaleString() +
        "t); not applied",
    };
  }

  const originBranchHeadId = branchEntryIds(rc.branch as Array<{ id?: unknown }>).at(-1);
  if (!originBranchHeadId) {
    return { outcome: "failed", reason: "branch head is not identifiable" };
  }
  const tokensBefore = rc.totalTokens;
  // Normalize the local estimate to Pi's measured context like the planner does.
  const scale = totalEstimate > 0 && tokensBefore > 0 ? tokensBefore / totalEstimate : 1;
  const after = Math.round((retainedTailTokens + nativeTokens) * scale);
  const saved = Math.max(0, tokensBefore - after);
  const routeLabel = nativeRouteLabel(model);
  const attempts: EngineAttempt[] = [
    ...priorAttempts,
    { engine: "native", outcome: "applied" },
  ];
  const details: SmartCompactDetails = {
    runId: rc.runId,
    method: "native",
    chunkCount: 1,
    topics: [],
    readFiles: [],
    modifiedFiles: [],
    totalMessages: prefix.length,
    totalTokensSummarized: Math.round(prefixTokens * scale),
    llmCalls: 1,
    profile: rc.profile,
    mode: rc.mode,
    backupPath: null,
    tokensSaved: saved,
    verified: false,
    gaps: [],
    explorationRounds: 0,
    explorationBoundaries: 0,
    model: routeLabel,
    version: VERSION,
    qualityScore: 0,
    tokensBefore,
    estimatedAfterTokens: after,
    estimatedSavedTokens: saved,
    estimatedYield: tokensBefore > 0 ? saved / tokensBefore : 0,
    retainedTailTokens: Math.round(retainedTailTokens * scale),
    summaryTokens: Math.round(nativeTokens * scale),
    engineAttempts: attempts,
    nativeApi: model.api,
    native: state,
  };
  const usage = result.usage;
  const nativeDurationMs = Date.now() - rc.pipelineStart;
  const pending: PendingCompaction = {
    runId: rc.runId,
    summary,
    firstKeptEntryId: rc.msgs[cut].id as string,
    originBranchHeadId,
    contextSnapshot: fingerprintContext(rc.msgs),
    readerSignature: rc.readerSignature,
    tokensBefore,
    details,
    sessionId: rc.sessionId,
    metricsSnapshot: {
      runId: rc.runId,
      metricsSchemaVersion: 2,
      version: VERSION,
      // Every engine states its channel explicitly; unknown channels must
      // never silently pool into the stable baseline.
      releaseChannel: rc.config?.telemetryChannel ?? loadConfig().telemetryChannel,
      totalCalls: 1,
      totalInput: usage?.input ?? 0,
      totalOutput: usage?.output ?? 0,
      totalCacheHit: usage?.cacheRead ?? 0,
      totalCacheWrite: usage?.cacheWrite ?? 0,
      // One provider call: its latency is the run's, and the cache rate uses the shared formula.
      avgLatency: nativeDurationMs,
      cacheHitRate: cacheHitRateOf(usage?.input ?? 0, usage?.cacheRead ?? 0, usage?.cacheWrite ?? 0),
      method: "native",
      model: model.id,
      provider: model.provider,
      mode: rc.mode,
      profile: rc.profile,
      runType: runType(rc),
      status: "success",
      contextPercent: Math.round(rc.contextPercent),
      tokensBefore,
      tokensSaved: saved,
      estimatedAfterTokens: after,
      estimatedSavedTokens: saved,
      estimatedYield: details.estimatedYield,
      retainedTailTokens: details.retainedTailTokens,
      summaryTokens: details.summaryTokens,
      durationMs: nativeDurationMs,
      // One route row keeps the input/cacheRead/cacheWrite/output split and
      // the billing basis visible for provider-route comparison.
      providerRoutes: [{
        stage: "synthesize",
        provider: model.provider,
        model: model.id,
        calls: 1,
        successes: 1,
        avgLatencyMs: nativeDurationMs,
        inputTokens: usage?.input ?? 0,
        ...(usage?.cacheRead ? { cacheReadTokens: usage.cacheRead } : {}),
        ...(usage?.cacheWrite ? { cacheWriteTokens: usage.cacheWrite } : {}),
        outputTokens: usage?.output ?? 0,
        usageBasis: usage ? "reported" : "estimated",
        billing: oauth ? "subscription" : "api",
      }],
      engineAttempts: attempts,
    },
  };
  return { outcome: "staged", pending, usage };
}

export function describeEngineAttempts(attempts: readonly EngineAttempt[]): string {
  return attempts
    .map(
      (attempt) =>
        (attempt.engine === "eesv" ? "EESV" : "native") +
        " " +
        attempt.outcome +
        (attempt.reason ? " (" + attempt.reason + ")" : ""),
    )
    .join("; ");
}

export function nativeRouteLabelOf(ctx: { model?: Pick<Model<Api>, "provider" | "id"> }): string {
  return ctx.model ? nativeRouteLabel(ctx.model) : "no model";
}

/** Every engine was skipped or failed; the conversation is unchanged. */
export class EngineChainError extends Error {
  readonly attempts: readonly EngineAttempt[];
  constructor(attempts: readonly EngineAttempt[]) {
    super(
      "No compaction engine succeeded: " +
        (describeEngineAttempts(attempts) || "no engine attempted") +
        ". Conversation unchanged.",
    );
    this.name = "EngineChainError";
    this.attempts = attempts;
  }
}

/** Ask Pi to apply the staged native candidate; mirrors the EESV apply path. */
export function applyNativeCompaction(rc: WindowedRc, pending: PendingCompaction): void {
  rc.ctx.compact({
    onComplete: () => {
      /* session_compact owns correlated success feedback */
    },
    onError: (error) => {
      clearCompactProgress(rc.ctx);
      // Only this run's candidate: a newer run may already have staged its own.
      if (rc.pendingRef.peek(rc.sessionId)?.runId === pending.runId) rc.pendingRef.clear(rc.sessionId);
      rc.onNativeApplyError?.(pending.runId, error);
      notifyUser(rc.ctx, 
        "Native compaction (" + pending.details.model + ") was not applied: " + engineErrorText(error) +
          ". Conversation unchanged.",
        "error",
      );
    },
  });
}

const warnedSkips = new Set<string>();
const MAX_WARNED_SKIPS = 500;

/**
 * Whether a native skip should be shown: at most once per session and route
 * (e.g. a kimi model with ["native","eesv"] would otherwise warn every run).
 * Failures are always shown by the caller.
 */
export function shouldWarnNativeSkip(sessionId: string, route: string): boolean {
  const key = sessionId + "\u0000" + route;
  if (warnedSkips.has(key)) return false;
  // Drop only the oldest key (Set iteration is insertion order), not every warning.
  if (warnedSkips.size >= MAX_WARNED_SKIPS) warnedSkips.delete(warnedSkips.values().next().value!);
  warnedSkips.add(key);
  return true;
}

export function resetNativeSkipWarningsForTests(): void {
  warnedSkips.clear();
}

/** Structural slice of the extension context the replay hook reads. */
export interface NativeReplayContext {
  model?: RouteModel;
  sessionManager: { getBranch(): unknown[]; getEntries(): unknown[]; getSessionId?(): string | undefined };
  modelRegistry?: unknown;
  hasUI?: boolean;
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

function hasNativeDetails(entry: unknown): boolean {
  return isRecord(entry) && entry.type === "compaction" && isRecord(entry.details) && entry.details.native !== undefined;
}

// True while the engine's own nested request runs, so the hook never touches it.
let nestedRequests = 0;

/**
 * `before_provider_request` replay of stored native state. Swaps Pi's text
 * summary for the provider state only when the latest compaction on the
 * branch carries valid state for the current route. Costs nothing (not even a
 * branch walk) until the session has native state; `refresh` recomputes that
 * flag at session boundaries from in-memory entries, never from disk.
 */
export function createNativeReplayHook() {
  let sessionHasNative = false;
  return {
    refresh(ctx: { sessionManager?: Partial<NativeReplayContext["sessionManager"]> }): void {
      try {
        const manager = ctx.sessionManager;
        const entries = manager?.getEntries?.() ?? manager?.getBranch?.() ?? [];
        sessionHasNative = entries.some(hasNativeDetails);
      } catch (error) {
        // Unknown: keep checking per request rather than silently skip replay.
        sessionHasNative = true;
        recordIssue({ key: "native.replay-scan", message: "Could not scan the session for native compaction state. Replay is checked on every request instead.", error });
      }
    },
    /** Replayed payload copy, or undefined to send Pi's payload unchanged. */
    handle(payload: unknown, ctx: NativeReplayContext): JsonObject | undefined {
      if (!sessionHasNative || nestedRequests > 0) return undefined;
      const model = ctx.model;
      if (!model || !isNativeApi(model.api)) return undefined;
      const branch = ctx.sessionManager.getBranch();
      let latest: unknown;
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (isRecord(entry) && entry.type === "compaction") {
          latest = entry;
          break;
        }
      }
      const state = nativeStateOf(latest, model);
      if (!state || !isRecord(latest) || typeof latest.summary !== "string") return undefined;
      const replayed = replayNativeState(state.api, payload, state, latest.summary);
      if (replayed) return replayed;
      const issue = {
        key: "native.replay:" + String(latest.id),
        message:
          "Native compaction state could not be replayed into this request. " +
          (state.api === "anthropic-messages"
            ? model.id + " reads the text summary instead."
            : model.id + " sees only the retained user messages. Run /smart-compact to replace it with a smart summary."),
      };
      if (state.api === "anthropic-messages") recordIssue(issue);
      else reportIssue({ ...issue, severity: "warning" }, ctx);
      return undefined;
    },
  };
}
