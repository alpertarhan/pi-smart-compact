/**
 * Provider-native context editing for direct Anthropic sessions.
 *
 * Signed Anthropic thinking binds everything sent before it, so local trims cannot
 * edit that history. The Messages API can instead clear old tool results (and,
 * optionally, old thinking) server-side before the prompt reaches the model, while
 * the client history stays unchanged:
 * https://platform.claude.com/docs/en/build-with-claude/context-editing
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactConfig } from "../types.ts";
import { isReadOnlyResearchTool, isShellTool } from "../domain/tool-semantics.ts";
import { contextPressure } from "./background-preparation.ts";
import { KEEP_RECENT_TURNS } from "./context-operations.ts";

export const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
/** Recent tool uses the server keeps: about two per protected turn, like local trim's recency floor. */
const KEEP_TOOL_USES = KEEP_RECENT_TURNS * 2;
// The server clears by tool name, so it cannot tell a skill or AGENTS.md read from a source read.
const NEVER_CLEARED = new Set(["read", "read_symbol", "read_enclosing"]);

export type ProviderContextEditing = CompactConfig["providerContextEditing"];
type EditingConfig = Pick<CompactConfig, "providerContextEditing" | "minContextPercent" | "prepareContextPercent" | "maxContextTokens">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only shell and read-only research output is cleared; user answers, writes and unknown tools stay. */
function clearable(name: string): boolean {
  return !NEVER_CLEARED.has(name) && (isShellTool(name) || isReadOnlyResearchTool(name, {}));
}

export function contextManagementEdits(
  level: Exclude<ProviderContextEditing, "off">,
  toolNames: string[],
  triggerTokens: number | null,
): Record<string, unknown>[] {
  const edits: Record<string, unknown>[] = [];
  // The API requires thinking clearing first when strategies are combined.
  if (level === "tool-results-and-thinking") {
    edits.push({ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: KEEP_RECENT_TURNS } });
  }
  edits.push({
    type: "clear_tool_uses_20250919",
    // Start with Smart Compact's cleanup band; an unknown window keeps the API default.
    ...(triggerTokens ? { trigger: { type: "input_tokens", value: triggerTokens } } : {}),
    keep: { type: "tool_uses", value: KEEP_TOOL_USES },
    exclude_tools: toolNames.filter(name => !clearable(name)),
  });
  return edits;
}

/**
 * Adds `context_management` and its beta to the session model's own request, in place.
 * Summarizer routes, other providers and payloads that already carry context management
 * are left untouched; the beta travels in the same payload, so it never reaches another request.
 */
export function applyProviderContextEditing(
  payload: unknown,
  ctx: Pick<ExtensionContext, "model" | "getContextUsage">,
  config: EditingConfig,
): void {
  const level = config.providerContextEditing;
  if (level === "off" || !isRecord(payload) || payload.context_management !== undefined) return;
  if (ctx.model?.api !== "anthropic-messages" || ctx.model.provider !== "anthropic"
    || payload.model !== ctx.model.id || !Array.isArray(payload.messages)) return;
  const toolNames = Array.isArray(payload.tools)
    ? payload.tools.flatMap(tool => isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [])
    : [];
  payload.context_management = { edits: contextManagementEdits(level, toolNames, contextPressure(ctx, config).cleanupTokens) };
  const betas = Array.isArray(payload.betas) ? payload.betas.filter((beta): beta is string => typeof beta === "string") : [];
  if (!betas.includes(CONTEXT_MANAGEMENT_BETA)) payload.betas = [...betas, CONTEXT_MANAGEMENT_BETA];
}

export function registerProviderContextEditing(pi: Pick<ExtensionAPI, "on">, deps: { config: () => EditingConfig }): void {
  pi.on("before_provider_request", (event, ctx) => {
    applyProviderContextEditing(event.payload, ctx, deps.config());
  });
}
