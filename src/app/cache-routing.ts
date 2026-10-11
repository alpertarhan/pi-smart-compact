/**
 * Cache routing-key injection (I).
 *
 * OpenAI documents `prompt_cache_key` as a stickiness aid: requests sharing a
 * prefix and key are routed to the same inference engine, which is what makes
 * implicit caching actually hit under multi-session load (OpenAI measured
 * 60%→87% hit rate for one coding customer). The key is derived from the
 * session id, so one conversation keeps landing on one engine while unrelated
 * sessions spread out.
 *
 * Constraints honored here:
 *  - Opt-in via `promptCacheRoutingEnabled` (default off): unknown request
 *    fields can be rejected by strict gateways, so the user chooses.
 *  - Provider-gated through the caps matrix: only providers whose documented
 *    routing key is a body field are stamped; header keys (xAI
 *    `x-grok-conv-id`) are not reachable from a payload hook and stay
 *    informational.
 *  - OpenAI-shaped payloads only (`messages` or `input` arrays, not the
 *    Anthropic block shape), never overriding an existing key, never for
 *    unresolved sessions whose per-call identity cannot pin a route.
 *  - In-place mutation, always returns undefined: `before_provider_request`
 *    handlers chain independently and must not fight over the returned
 *    payload.
 */

import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../utils/type-guards.ts";
import { getProviderCacheCaps } from "../utils/tokens.ts";
import { isUnresolvedSessionId, resolveSessionId } from "../infra/session-identity.ts";

export type RoutingContext = Pick<ExtensionContext, "sessionManager" | "model">;

/** True for payloads carrying the Anthropic block shape (system block array + tool input_schema). */
function isAnthropicShaped(payload: Record<string, unknown>): boolean {
  const system = Array.isArray(payload.system) ? payload.system[0] : undefined;
  if (isRecord(system) && system.type === "text") return true;
  const tool = Array.isArray(payload.tools) ? payload.tools[0] : undefined;
  return isRecord(tool) && "input_schema" in tool;
}

function sessionKey(sessionId: string): string {
  return "scx-" + createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

export function applyCacheRoutingKey(
  payload: unknown,
  ctx: RoutingContext,
  enabled: () => boolean,
): undefined {
  if (!enabled() || !isRecord(payload)) return undefined;
  if (isAnthropicShaped(payload)) return undefined;
  if (!Array.isArray(payload.messages) && !Array.isArray(payload.input)) return undefined;
  if (Object.hasOwn(payload, "prompt_cache_key")) return undefined;
  const provider = ctx.model?.provider;
  if (!provider) return undefined;
  const routingKey = getProviderCacheCaps(provider).routingKey;
  if (!routingKey || routingKey.location !== "body") return undefined;
  const sessionId = resolveSessionId(ctx);
  if (isUnresolvedSessionId(sessionId)) return undefined;
  payload[routingKey.name] = sessionKey(sessionId);
  return undefined;
}
