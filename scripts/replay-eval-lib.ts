/**
 * Read-only replay of recorded Pi sessions under alternative automatic-trim policies.
 * Every figure except the measured baseline is an estimate: projected prompt tokens
 * from the local estimator, priced with catalog rates.
 */
import {
  parseSessionEntries, SessionManager, type FileEntry, type SessionBoundaryDraft, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ModelCostRates } from "@earendil-works/pi-ai";
import {
  CONTEXT_CONTROL_TYPE, inspectContext, planContextTrim, trimBreakEvenRequests, trimEntries, trimTokens, type TrimCause,
} from "../src/app/context-operations.ts";
import { cacheLifetimeMs } from "../src/app/host-cache-ledger.ts";
import { unchangedSince } from "../src/app/register-smart-context-tool.ts";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";
import type { LlmMessage } from "../src/types.ts";
import { makeTokenEstimator, type TokenEstimator } from "../src/utils/tokens.ts";

/** Settled pressure gate of the old rule: estimated prompt ≥ 0.8 · contextWindow. */
export const PRESSURE_RATIO = 0.8;
const AUTOMATIC_CAUSES: readonly unknown[] = ["pressure", "break-even", "cold"];

export interface ModelInfo { cost?: Partial<ModelCostRates>; contextWindow?: number }
export type Catalog = (provider: string, model: string) => ModelInfo | undefined;
export type Policy = { name: string; kind: "none" | "pressure" } | { name: string; kind: "timed"; breakEven: number };
type AutoCause = Extract<TrimCause, "pressure" | "break-even" | "cold">;

export interface Baseline {
  requests: number; input: number; cacheRead: number; cacheWrite: number; output: number;
  /** Σ usage.cost.total as recorded; subscription requests contribute nothing. */
  recordedCost: number;
  /** Requests reporting tokens but no (or zero) cost: quota, never priced at API rates. */
  subscriptionRequests: number;
  models: string[];
}

export interface TrimEvent { atRequest: number; cause: AutoCause; removedTokens: number }

export interface PolicyResult {
  policy: string;
  requests: number; prompt: number; cached: number; uncached: number; rebuilds: number;
  trims: Record<AutoCause, number>;
  removedTokens: number;
  /** Requests priced at catalog rates (known cost, not subscription). */
  pricedRequests: number;
  cost: number | null;
  deltaVsNone: number | null;
  /** 1-based index of the first request whose prompt carries each trim. */
  events: TrimEvent[];
}

export interface SessionResult { id: string; strippedTrims: number; baseline: Baseline; policies: PolicyResult[] }

export interface ReplayOptions { policies: Policy[]; rebuildMin: number }

export function policiesFor(breakEven: number[]): Policy[] {
  return [
    { name: "none", kind: "none" }, { name: "pressure", kind: "pressure" },
    ...breakEven.map(value => ({ name: `timed-${value}`, kind: "timed" as const, breakEven: value })),
  ];
}

/** Parse a session file's text in memory; null without a valid header. */
export function loadSession(text: string): { id: string; branch: SessionEntry[] } | null {
  const entries = parseSessionEntries(text) as FileEntry[];
  const header = entries[0];
  if (header?.type !== "session" || typeof header.id !== "string" || !header.id) return null;
  const cwd = typeof header.cwd === "string" && header.cwd ? header.cwd : process.cwd();
  return { id: header.id, branch: SessionManager.inMemory(cwd, undefined, entries).getBranch() };
}

const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

function assistantOf(entry: SessionEntry): AssistantMessage | undefined {
  return entry.type === "message" && entry.message.role === "assistant" ? entry.message as AssistantMessage : undefined;
}

/** A provider request: an assistant message whose usage reports prompt tokens (as the cache ledger counts). */
function requestOf(entry: SessionEntry): AssistantMessage | undefined {
  const message = assistantOf(entry);
  const usage = message?.usage;
  return usage && num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite) > 0 ? message : undefined;
}

export function measuredBaseline(branch: SessionEntry[]): Baseline {
  const baseline: Baseline = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, recordedCost: 0, subscriptionRequests: 0, models: [] };
  const models = new Set<string>();
  for (const entry of branch) {
    const message = requestOf(entry);
    if (!message) continue;
    const { usage } = message;
    baseline.requests++;
    baseline.input += num(usage.input);
    baseline.cacheRead += num(usage.cacheRead);
    baseline.cacheWrite += num(usage.cacheWrite);
    baseline.output += num(usage.output);
    if (!num(usage.cost?.total)) baseline.subscriptionRequests++;
    else baseline.recordedCost += num(usage.cost.total);
    models.add(`${message.provider}/${message.model}`);
  }
  baseline.models = [...models].sort();
  return baseline;
}

/** Relink entries into one parent chain so the host projection follows them in order. */
function chain(entries: SessionEntry[], parentId: string | null = null): SessionEntry[] {
  return entries.map(entry => {
    const linked = { ...entry, parentId } as SessionEntry;
    parentId = entry.id;
    return linked;
  });
}

/** Drop recorded automatic trims so every policy starts from the untrimmed history. */
function stripAutomaticTrims(branch: SessionEntry[]): { branch: SessionEntry[]; stripped: number } {
  const controls = new Set<string>();
  const targets = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== CONTEXT_CONTROL_TYPE) continue;
    const data = entry.data as { action?: unknown; cause?: unknown; references?: unknown } | null;
    if (data?.action !== "trim" || !Array.isArray(data.references) || ("cause" in data && !AUTOMATIC_CAUSES.includes(data.cause))) continue;
    controls.add(entry.id);
    for (const id of data.references) if (typeof id === "string") targets.add(id);
  }
  if (!controls.size) return { branch, stripped: 0 };
  const kept = branch.filter(entry => !controls.has(entry.id) && !(entry.type === "context_edit" && targets.has(entry.targetId)));
  return { branch: chain(kept), stripped: controls.size };
}


/**
 * Projected prompt of `entries` as per-message keys and estimated tokens. A key names the source
 * entry, the message's index within it and the context edit applied to it, so equal keys are
 * byte-equal projected messages.
 */
interface Projection { keys: string[]; tokens: number[]; total: number }
type Projector = (entries: SessionEntry[], provider: string, model: string) => Projection;

function projector(): Projector {
  const estimators = new Map<string, TokenEstimator>();
  const memo = new Map<string, number>();
  return (entries: SessionEntry[], provider: string, model: string) => {
    const scope = `${provider}\0${model}`;
    let estimator = estimators.get(scope);
    if (!estimator) estimators.set(scope, estimator = makeTokenEstimator(provider, model));
    const edits = new Map(entries.flatMap(entry => entry.type === "context_edit" ? [[entry.targetId, entry.id] as const] : []));
    const keys: string[] = [];
    const tokens: number[] = [];
    let previousId: string | undefined;
    let index = 0;
    for (const { id, message } of contextMessageEntries(entries)) {
      index = id === previousId ? index + 1 : 0;
      previousId = id;
      const key = `${id}\0${index}\0${edits.get(id) ?? ""}`;
      const memoKey = `${scope}\0${key}`;
      let count = memo.get(memoKey);
      // SAFETY: contextMessageEntries yields convertToLlm() output, i.e. real LLM messages.
      if (count === undefined) memo.set(memoKey, count = estimator.message(message as LlmMessage));
      keys.push(key);
      tokens.push(count);
    }
    return { keys, tokens, total: tokens.reduce((sum, value) => sum + value, 0) };
  };
}

interface Mark { leafId: string; entries: SessionEntry[]; removedTokens: number }

function replayPolicy(
  sessionId: string, branch: SessionEntry[], policy: Policy, catalog: Catalog, rebuildMin: number,
  project: Projector,
): PolicyResult {
  const result: PolicyResult = {
    policy: policy.name, requests: 0, prompt: 0, cached: 0, uncached: 0, rebuilds: 0,
    trims: { pressure: 0, "break-even": 0, cold: 0 }, removedTokens: 0, pricedRequests: 0, cost: null, deltaVsNone: null, events: [],
  };
  const working: SessionEntry[] = [];
  let synthetic = 0;
  const materialize = (drafts: SessionBoundaryDraft[]) => drafts.map(draft =>
    ({ ...draft, id: `replay-${++synthetic}`, parentId: null, timestamp: new Date(0).toISOString() }) as SessionEntry);
  const append = (entries: SessionEntry[]) => { working.push(...chain(entries, working.at(-1)?.id ?? null)); };
  const record = (cause: AutoCause, atRequest: number, removedTokens: number) => {
    result.trims[cause]++;
    result.removedTokens += removedTokens;
    result.events.push({ atRequest, cause, removedTokens });
  };

  let mark = null as Mark | null;
  let applied = null as Mark | null;
  let boundary: AssistantMessage | undefined;
  let previous: { message: AssistantMessage; keys: string[] } | undefined;
  // Latest `cache_warm` refresh since the previous request: it keeps that request's prefix cached.
  let warmedAt: number | undefined;

  const turnEnd = (message: AssistantMessage) => {
    if (policy.kind === "none") return;
    // The cold request already carried these edits; commit them regardless of pressure or cooldown.
    if (applied && unchangedSince(working, applied.leafId)) { append(applied.entries); applied = mark = null; return; }
    applied = mark = null;
    let plan;
    try { plan = planContextTrim(working, inspectContext(working, sessionId).checkpoint?.originId); } catch { return; }
    if (plan.automatic !== "ready") return;
    const info = catalog(message.provider, message.model);
    const window = num(info?.contextWindow);
    const pressure = window > 0 && project(working, message.provider, message.model).total >= PRESSURE_RATIO * window;
    const commit = (cause: AutoCause, removedTokens: number) => {
      append(materialize(trimEntries(plan, cause)));
      record(cause, result.requests + 1, removedTokens);
    };
    if (pressure) return commit("pressure", trimTokens(working, plan.entries, message.provider, message.model).savedTokens);
    if (policy.kind !== "timed") return;
    const economics = trimTokens(working, plan.entries, message.provider, message.model);
    const breakEven = trimBreakEvenRequests(info?.cost, economics.savedTokens, economics.tailTokens);
    if (breakEven !== null && breakEven <= policy.breakEven) return commit("break-even", economics.savedTokens);
    mark = { leafId: working.at(-1)!.id, entries: materialize(trimEntries(plan, "cold")), removedTokens: economics.savedTokens };
  };

  for (const entry of branch) {
    if (entry.type === "usage" && entry.kind === "cache_warm") {
      const at = Date.parse(entry.timestamp);
      if (Number.isFinite(at)) warmedAt = Math.max(warmedAt ?? at, at);
    }
    const assistant = assistantOf(entry);
    if (boundary && entry.type === "message" && (assistant || entry.message.role === "user")) {
      turnEnd(boundary);
      boundary = undefined;
    }
    const message = requestOf(entry);
    if (message) {
      result.requests++;
      const expired = previous !== undefined
        && message.timestamp - Math.max(previous.message.timestamp, warmedAt ?? 0) > cacheLifetimeMs(previous.message.usage);
      if (mark && !applied && expired && unchangedSince(working, mark.leafId)) {
        applied = mark;
        mark = null;
        record("cold", result.requests, applied.removedTokens);
      }
      const context = applied ? [...working, ...chain(applied.entries, working.at(-1)?.id ?? null)] : working;
      const { keys, tokens, total } = project(context, message.provider, message.model);
      let cached = 0;
      if (previous && !expired && previous.message.provider === message.provider && previous.message.model === message.model) {
        for (let index = 0; index < keys.length && keys[index] === previous.keys[index]; index++) cached += tokens[index];
      }
      const uncached = total - cached;
      result.prompt += total;
      result.cached += cached;
      result.uncached += uncached;
      if (previous && uncached >= Math.max(rebuildMin, 0.5 * total)) result.rebuilds++;
      const cost = catalog(message.provider, message.model)?.cost;
      if (num(message.usage.cost?.total) > 0 && cost && typeof cost.input === "number" && typeof cost.cacheRead === "number") {
        const write = num(cost.cacheWrite) > 0 ? cost.cacheWrite! : cost.input;
        result.pricedRequests++;
        result.cost = (result.cost ?? 0) + (cost.cacheRead * cached + write * uncached) / 1_000_000;
      }
      previous = { message, keys };
      warmedAt = undefined;
    }
    append([entry]);
    if (assistant && assistant.stopReason !== "error" && assistant.stopReason !== "aborted") boundary = assistant;
  }
  return result;
}

export function replaySession(session: { id: string; branch: SessionEntry[] }, catalog: Catalog, options: ReplayOptions): SessionResult {
  const { branch, stripped } = stripAutomaticTrims(session.branch);
  const project = projector();
  const policies = options.policies.map(policy => replayPolicy(session.id, branch, policy, catalog, options.rebuildMin, project));
  const none = policies.find(policy => policy.policy === "none")?.cost ?? null;
  for (const policy of policies) policy.deltaVsNone = policy.cost === null || none === null ? null : policy.cost - none;
  return { id: session.id, strippedTrims: stripped, baseline: measuredBaseline(session.branch), policies };
}

/** Per-policy sums across sessions; cost sums only sessions that were priced. */
export function totals(sessions: SessionResult[], policies: Policy[]): PolicyResult[] {
  return policies.map(({ name }) => {
    const rows = sessions.map(session => session.policies.find(policy => policy.policy === name)!);
    const sum = (pick: (row: PolicyResult) => number) => rows.reduce((total, row) => total + pick(row), 0);
    const priced = rows.filter(row => row.cost !== null);
    const deltas = rows.filter(row => row.deltaVsNone !== null);
    return {
      policy: name, requests: sum(row => row.requests), prompt: sum(row => row.prompt), cached: sum(row => row.cached),
      uncached: sum(row => row.uncached), rebuilds: sum(row => row.rebuilds),
      trims: { pressure: sum(row => row.trims.pressure), "break-even": sum(row => row.trims["break-even"]), cold: sum(row => row.trims.cold) },
      removedTokens: sum(row => row.removedTokens), pricedRequests: sum(row => row.pricedRequests),
      cost: priced.length ? priced.reduce((total, row) => total + row.cost!, 0) : null,
      deltaVsNone: deltas.length ? deltas.reduce((total, row) => total + row.deltaVsNone!, 0) : null,
      events: [],
    };
  });
}

const usd = (value: number | null, signed = false) => value === null ? "n/a" : (signed && value >= 0 ? "+" : "") + value.toFixed(4);

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  return rows.map(row => row.map((cell, column) => column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])).join("  ").trimEnd());
}

export function formatReport(sessions: SessionResult[], policies: Policy[]): string {
  const lines = ["Measured baseline (recorded usage; subscription requests are quota, never priced)"];
  lines.push(...table([
    ["session", "models", "requests", "input", "cacheRead", "cacheWrite", "output", "recorded cost", "subscription req"],
    ...sessions.map(({ id, baseline: b }) => [id.slice(0, 8), b.models.join(",") || "-", String(b.requests), String(b.input),
      String(b.cacheRead), String(b.cacheWrite), String(b.output), usd(b.recordedCost), String(b.subscriptionRequests)]),
  ]));
  lines.push("", "Replay estimates (est. = local token estimator + catalog prices; not real savings or billing)");
  const row = (session: string, p: PolicyResult) => [session, p.policy, String(p.requests), String(p.prompt), String(p.cached),
    String(p.uncached), String(p.rebuilds), `${p.trims.pressure}/${p.trims["break-even"]}/${p.trims.cold}`, String(p.removedTokens),
    `${p.pricedRequests}`, usd(p.cost), usd(p.deltaVsNone, true)];
  lines.push(...table([
    ["session", "policy", "requests", "prompt est.", "cached est.", "uncached est.", "rebuilds est.", "trims p/b/c", "removed est.",
      "priced req", "cost est. USD", "Δ vs none est."],
    ...sessions.flatMap(session => session.policies.map(policy => row(session.id.slice(0, 8), policy))),
    ...totals(sessions, policies).map(policy => row("TOTAL", policy)),
  ]));
  return lines.join("\n");
}
