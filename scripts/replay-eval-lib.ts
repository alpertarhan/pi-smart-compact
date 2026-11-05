/**
 * Read-only replay of recorded Pi sessions under alternative automatic-trim policies.
 * Every figure except the measured baseline is an estimate: projected prompt tokens from Pi's
 * estimator plus the recorded unprojected payload, cache reuse modelled per provider, catalog prices.
 */
import {
  estimateTokens, parseSessionEntries, SessionManager, type FileEntry, type SessionBoundaryDraft, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ModelCost, ModelPromptCache, Usage } from "@earendil-works/pi-ai";
import {
  CONTEXT_CONTROL_TYPE, inspectContext, missesWholePrompt, planContextTrim, trimBreakEvenRequests, trimEntries, trimTokens, type TrimCause,
} from "../src/app/context-operations.ts";
import { cacheLifetimeMs } from "../src/app/host-cache-ledger.ts";
import { unchangedSince } from "../src/app/register-smart-context-tool.ts";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";

/** Settled pressure gate of the old rule: estimated prompt ≥ 0.8 · contextWindow. */
export const PRESSURE_RATIO = 0.8;
const AUTOMATIC_CAUSES: readonly unknown[] = ["pressure", "break-even", "cold"];

export interface ModelInfo { cost?: Partial<ModelCost>; contextWindow?: number; promptCache?: ModelPromptCache }
export type Catalog = (provider: string, model: string) => ModelInfo | undefined;
export type Policy = { name: string; kind: "none" | "pressure" } | { name: string; kind: "timed"; breakEven: number };
type AutoCause = Extract<TrimCause, "pressure" | "break-even" | "cold">;

export interface Baseline {
  requests: number; input: number; cacheRead: number; cacheWrite: number; output: number;
  /** Σ usage.cost.total as recorded; subscription requests contribute nothing. */
  recordedCost: number;
  /** Requests reporting tokens but no (or zero) cost: quota, never priced at API rates. */
  subscriptionRequests: number;
  /** Observed cache misses: requests after the first whose input + cacheWrite meets the replay's rebuild rule. */
  misses: number;
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

/** Same rule as a replay rebuild, applied to recorded usage. */
const isRebuild = (uncached: number, prompt: number, rebuildMin: number) => uncached >= Math.max(rebuildMin, 0.5 * prompt);

export function measuredBaseline(branch: SessionEntry[], rebuildMin: number): Baseline {
  const baseline: Baseline = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, recordedCost: 0, subscriptionRequests: 0, misses: 0, models: [] };
  const models = new Set<string>();
  for (const entry of branch) {
    const message = requestOf(entry);
    if (!message) continue;
    const { usage } = message;
    const uncached = num(usage.input) + num(usage.cacheWrite);
    if (baseline.requests && isRebuild(uncached, uncached + num(usage.cacheRead), rebuildMin)) baseline.misses++;
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

/** Per route, what recorded usage shows the provider does: serve cache reads, bill cache writes. */
type CacheEvidence = Map<string, { reads: boolean; writes: boolean }>;

function cacheEvidence(branch: SessionEntry[]): CacheEvidence {
  const routes: CacheEvidence = new Map();
  for (const entry of branch) {
    const message = requestOf(entry);
    if (!message) continue;
    const key = `${message.provider}/${message.model}`;
    const route = routes.get(key) ?? { reads: false, writes: false };
    route.reads ||= num(message.usage.cacheRead) > 0;
    route.writes ||= num(message.usage.cacheWrite) > 0;
    routes.set(key, route);
  }
  return routes;
}

/**
 * Lifetime of the prefix a request leaves cached. A write reports its tier (Anthropic: cacheWrite1h 0
 * means the short tier), a pure read keeps the route's last one, else the longest advertised tier.
 * Null without promptCache metadata.
 */
function lifetimeOf(usage: Usage, promptCache: ModelPromptCache | undefined, prior: number | null | undefined): number | null {
  const longest = cacheLifetimeMs(usage, promptCache);
  if (longest === null || num(usage.cacheWrite1h) > 0) return longest;
  if (num(usage.cacheWrite) > 0 && usage.cacheWrite1h === 0 && num(promptCache?.short) > 0)
    // A short-tier write must not shorten a longer-lived prefix written earlier on the route.
    return Math.max(prior ?? 0, promptCache!.short! * 1000);
  return prior ?? longest;
}

/**
 * Per request, recorded prompt tokens the projection does not see: system prompt, tool
 * schemas and provider-side tokens. They do not depend on the trim policy, so every policy adds them.
 * Measured against the context as recorded (recorded trims applied), so a recorded trim cannot
 * make the payload disappear: usage was measured on the trimmed prompt, not the untrimmed one.
 */
function unseenTokens(branch: SessionEntry[], project: Projector): number[] {
  return branch.flatMap((entry, index) => {
    const usage = requestOf(entry)?.usage;
    return usage ? [Math.max(0, num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite) - project(branch.slice(0, index)).total)] : [];
  });
}

/** Catalog rates for a prompt of `tokens`, choosing long-context tiers as Pi's calculateCost does. */
function ratesFor(cost: Partial<ModelCost>, tokens: number): Partial<ModelCost> {
  let rates = cost;
  let above = -1;
  for (const tier of cost.tiers ?? []) if (tokens > tier.inputTokensAbove && tier.inputTokensAbove > above) [rates, above] = [tier, tier.inputTokensAbove];
  if (rates === cost) return rates;
  // A tier may omit rate fields; every omitted one falls back to the base cost so no NaN is priced.
  const present = Object.fromEntries(Object.entries(rates).filter(([, value]) => value !== undefined));
  return { ...cost, ...present };
}


/**
 * Projected prompt of `entries` as per-message keys and estimated tokens. A key names the source
 * entry, the message's index within it and the context edit applied to it, so equal keys are
 * byte-equal projected messages. Pi's own estimator counts what providers bill: an image as a
 * fixed size and thinking as its text, not base64 image data or encrypted reasoning signatures.
 */
interface Projection { keys: string[]; tokens: number[]; total: number }
type Projector = (entries: SessionEntry[]) => Projection;

function projector(): Projector {
  const memo = new Map<string, number>();
  return (entries: SessionEntry[]) => {
    const edits = new Map(entries.flatMap(entry => entry.type === "context_edit" ? [[entry.targetId, entry.id] as const] : []));
    const keys: string[] = [];
    const tokens: number[] = [];
    let previousId: string | undefined;
    let index = 0;
    for (const { id, message } of contextMessageEntries(entries)) {
      index = id === previousId ? index + 1 : 0;
      previousId = id;
      const key = `${id}\0${index}\0${edits.get(id) ?? ""}`;
      let count = memo.get(key);
      // SAFETY: contextMessageEntries yields convertToLlm() output, i.e. real agent messages.
      if (count === undefined) memo.set(key, count = estimateTokens(message as Parameters<typeof estimateTokens>[0]));
      keys.push(key);
      tokens.push(count);
    }
    return { keys, tokens, total: tokens.reduce((sum, value) => sum + value, 0) };
  };
}

interface Mark { leafId: string; entries: SessionEntry[]; removedTokens: number }

function replayPolicy(
  sessionId: string, branch: SessionEntry[], policy: Policy, catalog: Catalog, rebuildMin: number,
  project: Projector, evidence: CacheEvidence, unseen: number[],
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
  let previous: { message: AssistantMessage; keys: string[]; lifetimeMs: number | null } | undefined;
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
    // The pressure gate sees the real prompt size: the next request also carries its unseen payload.
    const pressure = window > 0 && project(working).total + (unseen[result.requests] ?? 0) >= PRESSURE_RATIO * window;
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
      const info = catalog(message.provider, message.model);
      const route = evidence.get(`${message.provider}/${message.model}`);
      const prior = previous && previous.message.provider === message.provider && previous.message.model === message.model ? previous : undefined;
      const lifetimeMs = lifetimeOf(message.usage, info?.promptCache, prior?.lifetimeMs);
      if (!prior) mark = null;
      const expired = prior && prior.lifetimeMs !== null && lifetimeMs !== null
        && message.timestamp - Math.max(prior.message.timestamp, warmedAt ?? 0) > prior.lifetimeMs;
      if (mark && !applied && expired && unchangedSince(working, mark.leafId)) {
        applied = mark;
        mark = null;
        record("cold", result.requests, applied.removedTokens);
      }
      const context = applied ? [...working, ...chain(applied.entries, working.at(-1)?.id ?? null)] : working;
      const { keys, tokens, total: projected } = project(context);
      // The unseen part leads the prompt (system prompt, tool schemas), so it is cached with any reused prefix.
      const total = projected + unseen[result.requests - 1];
      let cached = 0;
      // A route that recorded cache reads reuses its prefix; an unknown lifetime never expires it
      // but is not permission to trim.
      if (prior && !expired && route?.reads) {
        let index = 0;
        for (; index < keys.length && keys[index] === prior.keys[index]; index++) cached += tokens[index];
        if (index) cached += unseen[result.requests - 1];
        if (index < prior.keys.length && missesWholePrompt(message.api)) cached = 0;
      }
      const uncached = total - cached;
      result.prompt += total;
      result.cached += cached;
      result.uncached += uncached;
      if (previous && isRebuild(uncached, total, rebuildMin)) result.rebuilds++;
      const cost = info?.cost;
      if (num(message.usage.cost?.total) > 0 && cost && typeof cost.input === "number" && typeof cost.cacheRead === "number") {
        const rates = ratesFor(cost, total);
        // A route that never reported a cache write bills uncached tokens as input.
        const write = route?.writes && num(rates.cacheWrite) > 0 ? rates.cacheWrite! : rates.input!;
        result.pricedRequests++;
        // Output is identical across policies and priced as recorded.
        result.cost = (result.cost ?? 0) + (rates.cacheRead! * cached + write * uncached) / 1_000_000 + num(message.usage.cost.output);
      }
      previous = { message, keys, lifetimeMs };
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
  const evidence = cacheEvidence(branch);
  const unseen = unseenTokens(session.branch, project);
  const policies = options.policies.map(policy => replayPolicy(session.id, branch, policy, catalog, options.rebuildMin, project, evidence, unseen));
  const none = policies.find(policy => policy.policy === "none")?.cost ?? null;
  for (const policy of policies) policy.deltaVsNone = policy.cost === null || none === null ? null : policy.cost - none;
  return { id: session.id, strippedTrims: stripped, baseline: measuredBaseline(session.branch, options.rebuildMin), policies };
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
    ["session", "models", "requests", "input", "cacheRead", "cacheWrite", "output", "misses", "recorded cost", "subscription req"],
    ...sessions.map(({ id, baseline: b }) => [id.slice(0, 8), b.models.join(",") || "-", String(b.requests), String(b.input),
      String(b.cacheRead), String(b.cacheWrite), String(b.output), String(b.misses), usd(b.recordedCost), String(b.subscriptionRequests)]),
  ]));
  lines.push("", "Replay estimates (est. = local token estimator + catalog prices; not real savings or billing)",
    "Routes with recorded cache reads reuse the unchanged prefix; unknown lifetimes never expire it nor trigger cold trims.",
    "Known horizons use the tier recorded writes report (else the longest); openai-codex misses the whole prompt after an edit.");
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
