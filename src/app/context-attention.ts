/**
 * Context attention: one short note to the model when context pressure enters
 * a band, naming only the actions that are available right now.
 *
 * Pressure used to reach the model only through the human status line and
 * `smart_context status` results, so the navigation, history and compaction
 * tools sat idle until a person asked for them. The note rides along with the
 * next tool batch (steer) during a turn. Prompt-start notes are computed then,
 * never parked in nextTurn where compaction or permissions can make them stale.
 * One note per band per session, re-armed once pressure clears or the session
 * changes. Notes append to history; they never rewrite the prompt prefix.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSessionId } from "../infra/session-identity.ts";
import type { CompactConfig } from "../types.ts";
import { contextPressure } from "./background-preparation.ts";
import { inspectContext, planContextTrim } from "./context-operations.ts";
import { NAVIGATION_TOOL_NAME } from "./navigation-data.ts";

export const ATTENTION_CUSTOM_TYPE = "smart-compact-attention";
const CONTEXT_TOOL_NAME = "smart_context";
const COMPACTION_TOOL_NAME = "smart_compact";
const LOADER_TOOL_NAME = "smart_tools";

type Band = "cleanup" | "compaction";
type AttentionConfig = Pick<CompactConfig,
  "contextNavigationEnabled" | "contextGuidanceEnabled" | "toolLoading" | "autoTrigger" | "autoTriggerStrategy"
  | "minContextPercent" | "prepareContextPercent" | "maxContextTokens">;

export interface ContextAttentionDeps {
  config: () => AttentionConfig;
  /** Agent-driven context changes are permitted and nothing (pivot, running compaction) takes priority. */
  canAgentAct: (ctx: ExtensionContext) => boolean;
  /** The same maintenance gate used by history cleanup; prepared work takes priority. */
  canCleanup: (ctx: ExtensionContext) => boolean;
  /** A lazy group can still be loaded through `smart_tools`. */
  reachable: (group: "navigation" | "history" | "compaction") => boolean;
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
  pi.on("session_compact", clear);
  pi.on("model_select", clear);
  pi.on("session_shutdown", clear);

  const attention = (ctx: ExtensionContext) => {
    const settings = deps.config();
    if (!settings.contextGuidanceEnabled || settings.toolLoading === "off") return;
    const sessionId = resolveSessionId(ctx);
    const pressure = contextPressure(ctx, settings);
    const band: Band | null = pressure.compaction ? "compaction" : pressure.cleanup ? "cleanup" : null;
    if (!band) {
      if (noted?.sessionId === sessionId) noted = null;
      return;
    }
    if (noted?.sessionId === sessionId && (noted.band === band || noted.band === "compaction")) return;
    if (!deps.canAgentAct(ctx)) return;
    const active = new Set(pi.getActiveTools());
    const content = renderAttention(band, pressure.percent, settings, ctx, active, deps.reachable, deps.canCleanup(ctx));
    if (!content) return;
    noted = { sessionId, band };
    return { customType: ATTENTION_CUSTOM_TYPE, content, display: true, details: { band, percent: pressure.percent } };
  };

  pi.on("before_agent_start", (_event, ctx) => {
    const message = attention(ctx);
    if (message) return { message };
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "toolUse") return;
    // The model is already attending; do not talk over its own context call.
    if (message.content.some(block => block.type === "toolCall"
      && [NAVIGATION_TOOL_NAME, CONTEXT_TOOL_NAME, COMPACTION_TOOL_NAME].includes(block.name))) return;
    const note = attention(ctx);
    if (note) pi.sendMessage(note, { deliverAs: "steer" });
  });
}

function renderAttention(
  band: Band,
  percent: number | null,
  settings: AttentionConfig,
  ctx: ExtensionContext,
  active: ReadonlySet<string>,
  reachable: ContextAttentionDeps["reachable"],
  canCleanup: boolean,
): string | null {
  const lines: string[] = [];
  // Active tools are named directly; a reachable lazy group gets its load step appended.
  const load = (group: Parameters<ContextAttentionDeps["reachable"]>[0], tool: string): string | null =>
    active.has(tool) ? "" : reachable(group) && active.has(LOADER_TOOL_NAME) ? ` Load it first: ${LOADER_TOOL_NAME} load ${group}.` : null;
  const navigation = settings.contextNavigationEnabled ? load("navigation", NAVIGATION_TOOL_NAME) : null;
  const history = load("history", CONTEXT_TOOL_NAME);
  if (navigation !== null) {
    lines.push(`- Finishing a unit of work? ${NAVIGATION_TOOL_NAME} anchor with a concise handoff (done / in progress / next step). An anchor alone does not reduce context; cleanup depends on safety and preparation gates.${navigation}`);
  }
  if (history !== null) {
    let trimmable = 0;
    if (canCleanup) {
      try {
        const branch = ctx.sessionManager.getBranch();
        const plan = planContextTrim(branch, inspectContext(branch, resolveSessionId(ctx)).checkpoint?.originId, { readerApi: ctx.model?.api });
        if (!plan.blockedReason) trimmable = plan.entries.filter(entry => entry.type === "context_edit").length;
      } catch {
        // Advice must not turn an unavailable plan into permission to edit history.
      }
    }
    if (trimmable > 0) lines.push(`- ${CONTEXT_TOOL_NAME} trim: ${trimmable} archived tool output${trimmable === 1 ? "" : "s"} eligible now.${history}`);
    // Checkpoints are metadata; a safe plan today cannot promise a safe rewind later.
    lines.push(`- Starting a large read-only detour? ${CONTEXT_TOOL_NAME} checkpoint first; rewind(report) afterward only when status permits. Keep findings and evidence in the report.${trimmable > 0 ? "" : history}`);
  }
  if (band === "compaction" && !settings.autoTrigger) {
    const compaction = load("compaction", COMPACTION_TOOL_NAME);
    if (compaction !== null) lines.push(`- ${COMPACTION_TOOL_NAME} stages a summary (or reports an existing one); the user runs /compact within its staging TTL to apply it. Staging does not shrink context.${compaction}`);
  }
  if (!lines.length) return null;
  const where = percent === null ? "" : ` ${Math.round(percent)}% of the policy window`;
  let automatic: string;
  if (!settings.autoTrigger) automatic = "Automatic compaction is off here; the user can run /smart-compact.";
  else if (settings.autoTriggerStrategy === "native-hook") automatic = "Preparation runs when Pi requests compaction; this strategy has no settled trigger.";
  else if (band === "compaction") automatic = "Automatic compaction is requested when the turn settles if pressure remains.";
  else {
    automatic = `Automatic compaction is requested at ${settings.minContextPercent}% when the turn settles.`;
    if (settings.autoTriggerStrategy === "background") automatic = "Background preparation can start in the cleanup band. " + automatic;
  }
  return `Context attention:${where} (${band} band). ${automatic}\n${lines.join("\n")}`;
}
