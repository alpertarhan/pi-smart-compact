/**
 * Context attention: one short note to the model when context pressure enters
 * a band, naming only the actions that are available right now.
 *
 * Pressure used to reach the model only through the human status line and
 * `smart_context status` results, so the navigation, history and compaction
 * tools sat idle until a person asked for them. The note rides along with the
 * next tool batch (steer) during a turn; when a turn ends in the cleanup band
 * it waits for the next prompt instead. One note per band per session,
 * re-armed once pressure clears (compaction, trim, rewind). The note is a
 * tail custom message, so the cached prefix is untouched.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSessionId } from "../infra/session-identity.ts";
import type { CompactConfig } from "../types.ts";
import { contextPressure } from "./background-preparation.ts";
import { inspectContext, planContextTrim } from "./context-operations.ts";
import { NAVIGATION_TOOL_NAME } from "./navigation-data.ts";

export const ATTENTION_CUSTOM_TYPE = "smart-compact-attention";
const CONTEXT_TOOL_NAME = "smart_context";
const LOADER_TOOL_NAME = "smart_tools";

type Band = "cleanup" | "compaction";
type AttentionConfig = Pick<CompactConfig,
  "contextNavigationEnabled" | "contextGuidanceEnabled" | "toolLoading" | "autoTrigger"
  | "minContextPercent" | "prepareContextPercent" | "maxContextTokens">;

export interface ContextAttentionDeps {
  config: () => AttentionConfig;
  /** Agent-driven context changes are permitted and nothing (pivot, running compaction) takes priority. */
  canAgentAct: (ctx: ExtensionContext) => boolean;
  /** A lazy group can still be loaded through `smart_tools`. */
  reachable: (group: "navigation" | "history") => boolean;
}

export function registerContextAttention(
  pi: Pick<ExtensionAPI, "on" | "sendMessage" | "getActiveTools">,
  deps: ContextAttentionDeps,
): void {
  let noted: { sessionId: string; band: Band } | null = null;
  const clear = () => { noted = null; };
  pi.on("session_start", clear);
  pi.on("session_before_switch", clear);
  pi.on("session_before_fork", clear);
  pi.on("session_tree", clear);

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    const settings = deps.config();
    if (!settings.contextNavigationEnabled || !settings.contextGuidanceEnabled || settings.toolLoading === "off") return;
    const sessionId = resolveSessionId(ctx);
    const pressure = contextPressure(ctx, settings);
    const band: Band | null = pressure.compaction ? "compaction" : pressure.cleanup ? "cleanup" : null;
    if (!band) {
      if (noted?.sessionId === sessionId) noted = null;
      return;
    }
    if (noted?.sessionId === sessionId && (noted.band === band || noted.band === "compaction")) return;
    // The model is already attending; do not talk over its own context call.
    if (message.content.some(block => block.type === "toolCall" && (block.name === NAVIGATION_TOOL_NAME || block.name === CONTEXT_TOOL_NAME))) return;
    const midTurn = message.stopReason === "toolUse";
    // A note parked for the next prompt would be stale once settled compaction ran at the turn end.
    if (!midTurn && band === "compaction" && settings.autoTrigger) return;
    if (!deps.canAgentAct(ctx)) return;
    const active = new Set(pi.getActiveTools());
    const content = renderAttention(band, pressure.percent, settings, ctx, active, deps.reachable);
    if (!content) return;
    noted = { sessionId, band };
    pi.sendMessage(
      { customType: ATTENTION_CUSTOM_TYPE, content, display: true, details: { band, percent: pressure.percent } },
      { deliverAs: midTurn ? "steer" : "nextTurn" },
    );
  });
}

function renderAttention(
  band: Band,
  percent: number | null,
  settings: AttentionConfig,
  ctx: ExtensionContext,
  active: ReadonlySet<string>,
  reachable: ContextAttentionDeps["reachable"],
): string | null {
  const lines: string[] = [];
  // Active tools are named directly; a reachable lazy group gets its load step appended.
  const load = (group: "navigation" | "history", tool: string): string | null =>
    active.has(tool) ? "" : reachable(group) && active.has(LOADER_TOOL_NAME) ? ` Load it first: ${LOADER_TOOL_NAME} load ${group}.` : null;
  const navigation = load("navigation", NAVIGATION_TOOL_NAME);
  const history = load("history", CONTEXT_TOOL_NAME);
  if (navigation !== null) {
    lines.push((band === "compaction"
      ? `- Anchor now: ${NAVIGATION_TOOL_NAME} anchor with a name and a concise handoff (done / in progress / next step). The summary starts from it and the prompt cache stays warm up to it.`
      : `- Finishing a unit of work? ${NAVIGATION_TOOL_NAME} anchor with a concise handoff; safe cleanup is queued automatically and the prefix up to the anchor stays cached.`) + navigation);
  }
  if (history !== null) {
    const branch = ctx.sessionManager.getBranch();
    let trimmable = 0;
    let blocked = false;
    try {
      const plan = planContextTrim(branch, inspectContext(branch, resolveSessionId(ctx)).checkpoint?.originId, { readerApi: ctx.model?.api });
      blocked = Boolean(plan.blockedReason);
      trimmable = plan.entries.filter(entry => entry.type === "context_edit").length;
    } catch {
      blocked = true;
    }
    if (!blocked) {
      if (trimmable > 0) lines.push(`- ${CONTEXT_TOOL_NAME} trim: ${trimmable} archived tool output${trimmable === 1 ? "" : "s"} eligible now.${history}`);
      lines.push(`- Starting a large read-only detour? ${CONTEXT_TOOL_NAME} checkpoint first, then rewind(report) when done keeps the findings and drops the research.${trimmable > 0 ? "" : history}`);
    }
  }
  if (!lines.length) return null;
  const where = percent === null ? "" : ` ${Math.round(percent)}% of the policy window`;
  const head = band === "compaction"
    ? `Context attention:${where} (compaction band). ` + (settings.autoTrigger
      ? "Compaction prepares now and applies when the turn settles."
      : "Automatic compaction is off here; the user runs /smart-compact.")
    : `Context attention:${where} (cleanup band). ` + (settings.autoTrigger
      ? `Automatic compaction prepares at ${settings.minContextPercent}%.`
      : "Automatic compaction is off here.");
  return `${head}\n${lines.join("\n")}`;
}
