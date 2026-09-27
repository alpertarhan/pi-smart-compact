import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import type { MetricsSnapshot } from "../types.ts";

export type RouteModelResolver = (provider: string, model: string) => Model<Api> | undefined;

const zeroCost = (): Usage["cost"] => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function routeUsage(input: number, output: number, cacheRead: number, cacheWrite: number): Usage {
 return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: zeroCost() };
}

/**
 * Provider-reported usage of one compaction run in Pi's `Usage` shape, so a
 * `session_before_compact` result can carry it into Pi's session totals.
 *
 * Tokens come from the run's per-route metrics (or the run totals when no
 * route rows exist). Cost uses the catalog rates of each route's model, the
 * way Pi prices its own requests; an unresolvable model contributes tokens
 * but no cost. Returns undefined when the run made no provider call or when
 * any route's usage was estimated rather than reported: Pi's totals must not
 * mix local estimates with provider counts.
 */
export function compactionUsage(
 snapshot: Pick<MetricsSnapshot, "totalCalls" | "totalInput" | "totalOutput" | "totalCacheHit" | "totalCacheWrite" | "providerRoutes" | "provider" | "model">,
 resolveModel: RouteModelResolver,
): Usage | undefined {
 if (!(snapshot.totalCalls > 0)) return undefined;
 const routes = snapshot.providerRoutes?.length
  ? snapshot.providerRoutes
  : snapshot.provider && snapshot.model
   ? [{
    provider: snapshot.provider, model: snapshot.model, inputTokens: snapshot.totalInput, outputTokens: snapshot.totalOutput,
    cacheReadTokens: snapshot.totalCacheHit, cacheWriteTokens: snapshot.totalCacheWrite, usageBasis: undefined,
   }]
   : [];
 if (!routes.length || routes.some(route => route.usageBasis === "estimated")) return undefined;
 const total = routeUsage(0, 0, 0, 0);
 for (const route of routes) {
  const usage = routeUsage(
   Math.max(0, route.inputTokens), Math.max(0, route.outputTokens),
   Math.max(0, route.cacheReadTokens ?? 0), Math.max(0, route.cacheWriteTokens ?? 0),
  );
  const model = resolveModel(route.provider, route.model);
  const cost = model ? calculateCost(model, usage) : zeroCost();
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += cost[key];
 }
 return total;
}
