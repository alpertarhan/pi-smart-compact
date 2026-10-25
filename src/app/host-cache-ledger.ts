/** Session-local ledger of the host's own provider prompt-cache usage, built only from reported usage. */

import type { ModelPromptCache, Usage } from "@earendil-works/pi-ai";
import { CACHE_INACTIVE_ROUTE_MIN_PROMPT_TOKENS, CACHE_INACTIVE_ROUTE_MIN_REQUESTS, ONE_HOUR_MS, REBUILD_MIN_TOKENS } from "../constants.ts";
import { getProviderCacheCaps } from "../utils/tokens.ts";

export type ContextEditKind = "trim" | "rewind" | "navigation" | "compaction";
export type RebuildCause = "continuity" | "idle-expiry" | "foreign";

/** Foreign rebuilds needed before the ledger asks the integrator to warn once. */
export const FOREIGN_REBUILD_WARN_COUNT = 3;

export interface LedgerEntry {
  at: number;
  provider?: string;
  model?: string;
  /** input + cacheRead + cacheWrite */
  prompt: number;
  /** input + cacheWrite */
  uncached: number;
  cacheRead: number;
  /** Milliseconds since the previous observed request; absent for the first. */
  gapMs?: number;
  rebuild: boolean;
  cause?: RebuildCause;
  /** Most recent Smart Compact edit before a `continuity` rebuild. */
  editKind?: ContextEditKind;
  /** Set only on the rebuild that makes the foreign count reach FOREIGN_REBUILD_WARN_COUNT. */
  warn?: true;
  /** Set once, on the request that completes an all-miss streak on a documented-caching route. */
  inactive?: true;
}

export interface TokenTally { count: number; uncached: number }

export interface LedgerSummary {
  sessionId: string | null;
  requests: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  rebuilds: Record<RebuildCause, TokenTally>;
  continuity: Record<ContextEditKind, TokenTally>;
  /** Routes that finished an all-miss streak despite documented caching; one row per route. */
  inactiveRoutes: Array<{ provider: string; model: string; requests: number; uncached: number }>;
  /** Sums of `usage.cost` (Pi prices reported tokens with the model price table); `requests` counts entries that carried a cost. */
  cost: { requests: number; total: number; rebuildUncached: number };
}

export interface ObservedMessage {
  usage?: Partial<Usage>;
  provider?: string;
  model?: string;
  timestamp?: number;
}

export interface HostCacheLedger {
  /** New or switched session: forget all state. */
  reset(sessionId: string): void;
  /** Session the ledger currently tracks; null before the first reset. */
  sessionId(): string | null;
  /** A Smart Compact edit reached the branch; attributes the next observed rebuild. */
  noteContextEdit(kind: ContextEditKind): void;
  /** Pi sent a `cache_warm` refresh at `at`; it keeps the live prefix alive like a request. */
  noteCacheWarm(at: number): void;
  /** Assistant message at message_end; null when it carries no usable usage. */
  observe(message: ObservedMessage, at?: number, promptCache?: ModelPromptCache): LedgerEntry | null;
  summary(): LedgerSummary;
}

const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const tallies = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map(key => [key, { count: 0, uncached: 0 }])) as Record<K, TokenTally>;

/**
 * Best-effort lifetime from Pi's model metadata (seconds). The request's chosen
 * retention is not recorded, so use the longest advertised tier. A reported
 * 1h write can lengthen this estimate, never shorten it. Unknown is not expired.
 */
export function cacheLifetimeMs(usage: Partial<Usage> | undefined, promptCache?: ModelPromptCache): number | null {
  const tiers = [promptCache?.short, promptCache?.long].filter(value => value !== undefined);
  if (!tiers.length || tiers.some(value => !Number.isFinite(value) || value <= 0 || !Number.isFinite(value * 1000))) return null;
  return Math.max(...tiers.map(value => value * 1000), num(usage?.cacheWrite1h) > 0 ? ONE_HOUR_MS : 0);
}

export function createHostCacheLedger(): HostCacheLedger {
  let sessionId: string | null = null;
  let summary: LedgerSummary;
  let previousAt: number | undefined;
  // Latest cache_warm refresh since the previous request; extends the prefix's lifetime.
  let warmedAt: number | undefined;
  // Keep the longest known lifetime on a route; a short tail write must not
  // retire a longer-lived prefix. Unknown metadata and route changes reset it.
  let lifetimeMs: number | null = null;
  let previousRoute: string | undefined;
  let pendingEdit: ContextEditKind | undefined;
  // Per-route all-miss streaks: consecutive large requests with zero cache reads.
  const routeStreaks = new Map<string, { provider: string; model: string; requests: number; uncached: number; warned: boolean }>();

  const reset = (id: string | null) => {
    sessionId = id;
    previousAt = undefined;
    warmedAt = undefined;
    lifetimeMs = null;
    previousRoute = undefined;
    pendingEdit = undefined;
    routeStreaks.clear();
    summary = {
      sessionId: id, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0,
      rebuilds: tallies(["continuity", "idle-expiry", "foreign"] as const),
      continuity: tallies(["trim", "rewind", "navigation", "compaction"] as const),
      inactiveRoutes: [],
      cost: { requests: 0, total: 0, rebuildUncached: 0 },
    };
  };
  reset(null);

  return {
    reset,
    sessionId: () => sessionId,
    noteContextEdit(kind) { pendingEdit = kind; },
    noteCacheWarm(at) { warmedAt = Math.max(warmedAt ?? at, at); },
    observe(message, at, promptCache) {
      const usage = message.usage;
      if (!usage || typeof usage.input !== "number" || !Number.isFinite(usage.input)) return null;
      const input = num(usage.input);
      const cacheRead = num(usage.cacheRead);
      const cacheWrite = num(usage.cacheWrite);
      const prompt = input + cacheRead + cacheWrite;
      // Aborted/failed requests report zero usage: nothing was measured.
      if (prompt === 0) return null;
      const uncached = input + cacheWrite;
      const time = at ?? (typeof message.timestamp === "number" ? message.timestamp : Date.now());
      const entry: LedgerEntry = {
        at: time, provider: message.provider, model: message.model,
        prompt, uncached, cacheRead, rebuild: false,
      };
      const route = JSON.stringify([message.provider, message.model]);
      const sameRoute = route === previousRoute;
      const currentLifetime = cacheLifetimeMs(usage, promptCache);
      if (previousAt !== undefined && sameRoute) {
        entry.gapMs = Math.max(0, time - previousAt);
        if (uncached >= Math.max(REBUILD_MIN_TOKENS, 0.5 * prompt)) {
          entry.rebuild = true;
          const alive = Math.max(previousAt, warmedAt ?? previousAt);
          entry.cause = pendingEdit ? "continuity"
            : lifetimeMs !== null && currentLifetime !== null && time - alive > Math.max(lifetimeMs, currentLifetime) ? "idle-expiry" : "foreign";
          const cause = summary.rebuilds[entry.cause];
          cause.count++;
          cause.uncached += uncached;
          if (pendingEdit) {
            entry.editKind = pendingEdit;
            summary.continuity[pendingEdit].count++;
            summary.continuity[pendingEdit].uncached += uncached;
          }
          if (entry.cause === "foreign" && cause.count === FOREIGN_REBUILD_WARN_COUNT) entry.warn = true;
        }
      }
      summary.requests++;
      summary.input += input;
      summary.cacheRead += cacheRead;
      summary.cacheWrite += cacheWrite;
      // Inactive-route streak: documented-caching routes that keep serving
      // large prompts with zero reads point at a broken marker contract.
      // A large cache WRITE is the opposite evidence — the provider accepted a
      // new cache entry (the prefix genuinely changed) — so it resets the
      // streak instead of feeding it; full rewrites stay foreign-rebuild data.
      if (entry.provider && entry.prompt >= CACHE_INACTIVE_ROUTE_MIN_PROMPT_TOKENS) {
        const caps = getProviderCacheCaps(entry.provider);
        if (caps.level !== "none" && caps.readMultiplier < 1) {
          const key = route;
          const streak = routeStreaks.get(key) ?? { provider: entry.provider, model: entry.model ?? "", requests: 0, uncached: 0, warned: false };
          const writeDominant = cacheWrite > 0 && cacheWrite * 2 >= uncached;
          if (cacheRead > 0 || writeDominant) {
            streak.requests = 0;
            streak.uncached = 0;
          } else {
            streak.requests++;
            streak.uncached += uncached;
            if (streak.requests >= CACHE_INACTIVE_ROUTE_MIN_REQUESTS && !streak.warned) {
              streak.warned = true;
              entry.inactive = true;
              summary.inactiveRoutes.push({ provider: streak.provider, model: streak.model, requests: streak.requests, uncached: streak.uncached });
            }
          }
          routeStreaks.set(key, streak);
        }
      }
      const cost = usage.cost;
      if (cost && typeof cost.total === "number" && Number.isFinite(cost.total)) {
        summary.cost.requests++;
        summary.cost.total += cost.total;
        if (entry.rebuild) summary.cost.rebuildUncached += num(cost.input) + num(cost.cacheWrite);
      }
      lifetimeMs = sameRoute && lifetimeMs !== null && currentLifetime !== null
        ? Math.max(lifetimeMs, currentLifetime) : currentLifetime;
      previousRoute = route;
      previousAt = time;
      warmedAt = undefined;
      pendingEdit = undefined;
      return entry;
    },
    summary: () => structuredClone(summary),
  };
}

const tokens = (value: number) => value >= 1_000_000 ? (value / 1_000_000).toFixed(1) + "M"
  : value >= 1_000 ? Math.round(value / 1_000) + "k" : String(value);

/** 1–3 short Home lines; empty until the host reported usage for a request. */
export function formatCacheLedgerSummary(summary: LedgerSummary): string[] {
  if (!summary.requests) return [];
  const prompt = summary.input + summary.cacheRead + summary.cacheWrite;
  const readPercent = prompt ? Math.round(summary.cacheRead / prompt * 100) : 0;
  const { continuity, "idle-expiry": idle, foreign } = summary.rebuilds;
  const total = continuity.count + idle.count + foreign.count;
  const lines = [`Host prompt cache: ${summary.requests} requests · ${readPercent}% of prompt tokens read from cache · ${total} estimated rebuilds`];
  if (!total) return lines;
  const parts: string[] = [];
  if (continuity.count) {
    const kinds = (Object.entries(summary.continuity) as Array<[ContextEditKind, TokenTally]>)
      .filter(([, tally]) => tally.count).map(([kind, tally]) => `${kind} ${tally.count}`).join(", ");
    parts.push(`${continuity.count} after Smart Compact edits (${kinds}): ${tokens(continuity.uncached)} uncached`);
  }
  if (idle.count) parts.push(`${idle.count} possible idle-expiry: ${tokens(idle.uncached)} uncached`);
  if (foreign.count) parts.push(`${foreign.count} without a Smart Compact edit (cause unknown): ${tokens(foreign.uncached)} uncached`);
  lines.push("Rebuild estimates: " + parts.join(" · "));
  if (summary.cost.total > 0) lines.push(`Cost (Pi model pricing): \$${summary.cost.total.toFixed(4)} total · \$${summary.cost.rebuildUncached.toFixed(4)} uncached input+cache writes on rebuilds`);
  if (summary.inactiveRoutes.length) {
    const routes = summary.inactiveRoutes
      .map(route => `${route.provider}/${route.model} ×${route.requests} (${tokens(route.uncached)} uncached)`)
      .join(", ");
    lines.push(`Caching never hits on: ${routes}. Markers or request fields may be ignored by this provider.`);
  }
  return lines;
}
