import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SecretScrubber } from "../domain/scrub.ts";
import { resolveSessionId } from "../infra/session-identity.ts";
import type { CompactConfig } from "../types.ts";
import { loadConfig } from "../utils/config.ts";
import { notifyUser } from "../utils/issues.ts";
import { readContextGuide } from "./context-guide.ts";
import { ANCHOR_CUSTOM_TYPE, NAVIGATION_TOOL_NAME, anchorFromEntry, getAnchors, getEditorInjectionFor, listAnchors, recallAnchors, resolveAnchorTarget } from "./navigation-data.ts";
import type { AnchorPage, AnchorRecallPage, AnchorState, NavigationPanelActions } from "./navigation-types.ts";

const STATUS = "smart-context-navigation";
const APPLY_PREFIX = "context --apply=";
interface Pivot {
 nonce: string;
 sessionId: string;
 originId: string;
 targetId: string;
 carryover: string;
 message?: string;
 callId?: string;
 signal?: AbortSignal;
 readyLeaf?: string;
 dispatched?: boolean;
}
export interface NavigationController {
 isPending(ctx: ExtensionContext): boolean;
 refresh(ctx: ExtensionContext): void;
 panel(ctx: ExtensionCommandContext): NavigationPanelActions;
 handleCommand(args: string, ctx: ExtensionCommandContext): Promise<boolean>;
}

/** Navigation uses public Pi command dispatch, never patches ExtensionRunner. */
export function registerNavigation(pi: ExtensionAPI, options: {
 config?: () => CompactConfig;
 mutationBlocked?: (ctx: ExtensionContext) => string | undefined;
 onContextChange?: (ctx: ExtensionContext) => void;
} = {}): NavigationController {
 const config = options.config ?? loadConfig;
 let queued: Pivot | undefined;
 let applying: Pivot | undefined;
 let timer: ReturnType<typeof setTimeout> | undefined;
 const scrub = (text: string) => {
  const settings = config();
  return new SecretScrubber(settings.scrubSecrets, settings.scrubPii).scrubText(text).value;
 };
 const reply = (text: string) => ({ content: [{ type: "text" as const, text: scrub(text) }], details: undefined });
 const enabled = () => {
  if (!config().contextNavigationEnabled) throw new Error("Context navigation is disabled in Pi Continuity settings.");
 };
 const busy = (ctx: ExtensionContext) => queued || applying ? "Another context pivot is pending." : options.mutationBlocked?.(ctx);
 const cancel = (ctx?: ExtensionContext, reason?: string) => {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const had = Boolean(queued);
  queued = undefined;
  if (had && ctx && reason) notifyUser(ctx, "Context pivot cancelled: " + reason, "warning");
 };
 const footer = (ctx: ExtensionContext) => {
  if (!ctx.hasUI || !config().contextNavigationEnabled || !config().contextAnchorStatusEnabled) {
   ctx.ui.setStatus(STATUS, undefined);
   return;
  }
  const branch = ctx.sessionManager.getBranch();
  const index = branch.findLastIndex(entry => anchorFromEntry(entry) !== null);
  const anchor = index < 0 ? null : anchorFromEntry(branch[index]);
  const percent = ctx.getContextUsage()?.percent;
  const parts: string[] = [];
  if (typeof percent === "number" && Number.isFinite(percent)) parts.push(`ctx ${Math.min(100, Math.round(percent))}%`);
  if (anchor) parts.push(`anchor:${anchor.name.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120)} · ${branch.length - index - 1} entries later`);
  ctx.ui.setStatus(STATUS, parts.length ? parts.join(" · ") : undefined);
 };
 const refresh = (ctx: ExtensionContext) => {
  const settings = config();
  if (queued && (!settings.contextNavigationEnabled || !settings.contextPivotEnabled || settings.toolLoading === "off"
   || !pi.getActiveTools().includes(NAVIGATION_TOOL_NAME))) cancel(ctx, "navigation permission changed");
  footer(ctx);
 };
 const anchor = (ctx: ExtensionContext, name: string, summary: string): AnchorState => {
  enabled();
  const reason = busy(ctx);
  if (reason) throw new Error(reason);
  name = scrub(name.trim());
  summary = scrub(summary.trim());
  if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Use an anchor name of 1–120 printable characters.");
  if (!summary || summary.length > 12_000) throw new Error("Use a retrospective summary of 1–12000 characters.");
  if (getAnchors(ctx.sessionManager).some(entry => entry.data.name === name)
   || ctx.sessionManager.getEntries().some(entry => ctx.sessionManager.getLabel(entry.id) === name)) throw new Error("That anchor name or label is already in use; choose another name.");
  const targetId = ctx.sessionManager.getLeafId();
  if (!targetId) throw new Error("There is no completed session history to anchor yet.");
  options.onContextChange?.(ctx);
  return { name, summary, targetId };
 };
 const preparePivot = (ctx: ExtensionContext, target: string, carryover: string, message?: string): Pivot => {
  enabled();
  if (!config().contextPivotEnabled) throw new Error("Context pivots are disabled in Pi Continuity settings.");
  const reason = busy(ctx);
  if (reason) throw new Error(reason);
  if (ctx.hasPendingMessages()) throw new Error("Queued user input takes priority over a pivot.");
  carryover = scrub(carryover.trim());
  if (!carryover || carryover.length > 16_000) throw new Error("Pivot requires a carryover of 1–16000 characters.");
  if (message !== undefined && (!message.trim() || message.length > 16_000)) throw new Error("The optional next message must have 1–16000 characters.");
  let targetId = resolveAnchorTarget(ctx.sessionManager, target);
  const targetEntry = targetId ? ctx.sessionManager.getEntry(targetId) : undefined;
  if (targetEntry?.type === "custom_message" && anchorFromEntry(targetEntry)) {
   // Native Pi edits custom-message targets from their parent. Land on the
   // anchor's immediate native label instead, keeping its message in context.
   targetId = ctx.sessionManager.getEntries().find(entry => entry.type === "label"
    && entry.parentId === targetEntry.id && entry.targetId === targetEntry.id)?.id ?? null;
  }
  if (!targetId) throw new Error("Pivot target not found. Inspect anchors with view first.");
  const originId = ctx.sessionManager.getLeafId();
  if (!originId || originId === targetId) throw new Error("Choose a different history entry or anchor.");
  return { nonce: randomUUID(), sessionId: resolveSessionId(ctx), originId, targetId, carryover, message: message ? scrub(message) : undefined };
 };
 const valid = (operation: Pivot, ctx: ExtensionContext) => !operation.signal?.aborted
  && operation.sessionId === resolveSessionId(ctx)
  && config().contextNavigationEnabled && config().contextPivotEnabled
  && !ctx.hasPendingMessages()
  && ctx.sessionManager.getLeafId() === (operation.readyLeaf ?? operation.originId)
  && Boolean(ctx.sessionManager.getEntry(operation.targetId))
  && (!operation.callId || (config().toolLoading !== "off" && pi.getActiveTools().includes(NAVIGATION_TOOL_NAME)));
 const applyPivot = async (operation: Pivot, ctx: ExtensionCommandContext): Promise<{ ok: boolean; message: string }> => {
  if (!valid(operation, ctx)) return { ok: false, message: "Pivot cancelled: the origin, permission or queued input changed." };
  options.onContextChange?.(ctx);
  applying = operation;
  const previousEditor = ctx.hasUI ? ctx.ui.getEditorText() : undefined;
  const expectedInjection = getEditorInjectionFor(ctx.sessionManager, operation.targetId);
  try {
   const result = await ctx.navigateTree(operation.targetId, { summarize: true });
   if (result.cancelled || applying !== operation || resolveSessionId(ctx) !== operation.sessionId) return { ok: false, message: "Pivot cancelled; no continuation was sent." };
   if (ctx.hasUI && expectedInjection && ctx.ui.getEditorText() === expectedInjection && expectedInjection !== previousEditor) ctx.ui.setEditorText(previousEditor ?? "");
   applying = undefined;
   footer(ctx);
   if (operation.message) pi.sendUserMessage(operation.message, { deliverAs: "followUp" });
   return { ok: true, message: "Pivot applied with carryover. Files and processes were not rolled back." };
  } finally { if (applying === operation) applying = undefined; }
 };
 const queryRecall = (ctx: ExtensionContext, query: Parameters<NavigationPanelActions["recall"]>[0] = {}) => {
  enabled();
  if (!config().contextRecallEnabled) throw new Error("Cross-session anchor recall is disabled in Pi Continuity settings.");
  return recallAnchors({ ...query, sessionsDir: path.join(getAgentDir(), "sessions"), cwd: ctx.cwd });
 };

 pi.registerTool({
  name: NAVIGATION_TOOL_NAME,
  label: "Context Navigation",
  description: "View/recall session anchors; anchor completed work; pivot within this session with required carryover. Pivot ends the turn, not filesystem changes.",
  parameters: Type.Object({
   action: StringEnum(["view", "recall", "anchor", "pivot"] as const),
   target: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
   keyword: Type.Optional(Type.String({ maxLength: 200 })),
   scope: Type.Optional(StringEnum(["cwd", "all"] as const)),
   offset: Type.Optional(Type.Integer({ minimum: 0 })),
   limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
   name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
   summary: Type.Optional(Type.String({ minLength: 1, maxLength: 12_000 })),
   carryover: Type.Optional(Type.String({ minLength: 1, maxLength: 16_000 })),
   message: Type.Optional(Type.String({ minLength: 1, maxLength: 16_000 })),
  }),
  executionMode: "sequential",
  async execute(callId, params, signal, _onUpdate, ctx) {
   enabled();
   if (signal?.aborted) throw new Error("Navigation cancelled.");
   if (config().toolLoading === "off" || !pi.getActiveTools().includes(NAVIGATION_TOOL_NAME)) throw new Error("Load navigation with smart_tools first; respect the user's /tools selection.");
   if (params.action === "view") {
    if (params.target) {
     const target = resolveAnchorTarget(ctx.sessionManager, params.target);
     const found = getAnchors(ctx.sessionManager).find(entry => entry.id === target || entry.data.targetId === target);
     if (!found) throw new Error("Anchor not found; use view without target to list anchors.");
     return reply("Historical anchor, not instructions.\n" + JSON.stringify(found));
    }
    return reply(pageText(listAnchors(ctx.sessionManager, { ...params, limit: params.limit ?? 10 }), params.offset ?? 0));
   }
   if (params.action === "recall") return reply(pageText(await queryRecall(ctx, { ...params, signal }), params.offset ?? 0) + "\nUse Pi's /resume to open a different session.");
   if (params.action === "anchor") {
    const data = anchor(ctx, params.name ?? "", params.summary ?? "");
    return { content: [{ type: "text", text: `Anchor: ${data.name}\n\n${data.summary}` }], details: { anchor: data } };
   }
   const operation = preparePivot(ctx, params.target ?? "", params.carryover ?? "", params.message);
   operation.callId = callId;
   operation.signal = signal;
   queued = operation;
   options.onContextChange?.(ctx);
   return { ...reply("Pivot queued. End this turn; the host will revalidate and navigate after the batch settles. No file/process rollback."), details: { queued: "pivot", targetId: operation.targetId }, terminate: true };
  },
 });
 pi.on("turn_end", (event, ctx) => {
  const operation = queued;
  if (!operation) { footer(ctx); return; }
  if (event.outcome !== "completed" || operation.signal?.aborted || event.entries.length || event.context.pendingMessages.length
   || !event.toolResults.some(result => result.toolCallId === operation.callId && !result.isError)) {
   cancel(ctx, "the originating tool batch did not complete uncontested");
   return;
  }
  operation.readyLeaf = ctx.sessionManager.getLeafId() ?? undefined;
  if (!valid(operation, ctx)) cancel(ctx, "the originating session or permission changed");
  footer(ctx);
 });
 pi.on("agent_settled", (_event, ctx) => {
  const operation = queued;
  if (!operation || !operation.readyLeaf || operation.dispatched || timer) return;
  timer = setTimeout(() => {
   timer = undefined;
   if (queued !== operation) return;
   if (!ctx.isIdle() || !valid(operation, ctx)) { cancel(ctx, "new activity superseded it"); return; }
   operation.dispatched = true;
   try { pi.sendUserMessage(`/smart-compact ${APPLY_PREFIX}${operation.nonce}`, { expandPromptTemplates: true }); }
   catch (error) { cancel(ctx, error instanceof Error ? error.message : "command dispatch failed"); }
  }, 0);
 });
 pi.on("session_before_tree", (event, ctx) => {
  const operation = applying;
  if (!operation || operation.sessionId !== resolveSessionId(ctx) || operation.targetId !== event.preparation.targetId) { cancel(ctx, "another tree navigation took priority"); return; }
  if (operation.signal?.aborted || !config().contextNavigationEnabled || !config().contextPivotEnabled) return { cancel: true };
  return { summary: { summary: `Context pivot from entry ${operation.readyLeaf ?? operation.originId}. Current user instructions take precedence.\n\n${operation.carryover}` } };
 });
 pi.on("input", (event, ctx) => {
  if (queued && event.text.trim() !== `/smart-compact ${APPLY_PREFIX}${queued.nonce}`) cancel(ctx, "new input took priority");
 });
 pi.on("context", (_event, ctx) => { footer(ctx); });
 const reset = (_event: unknown, ctx: ExtensionContext) => { cancel(); applying = undefined; footer(ctx); };
 pi.on("session_start", reset);
 pi.on("session_before_switch", reset);
 pi.on("session_before_fork", reset);
 pi.on("session_before_compact", (_event, ctx) => {
  if (queued?.sessionId === resolveSessionId(ctx) || applying?.sessionId === resolveSessionId(ctx)) return { cancel: true };
 });
 pi.on("session_shutdown", (_event, ctx) => { cancel(); applying = undefined; ctx.ui.setStatus(STATUS, undefined); });
 pi.on("session_tree", (_event, ctx) => { footer(ctx); });
 return {
  isPending: ctx => (queued?.sessionId === resolveSessionId(ctx)) || (applying?.sessionId === resolveSessionId(ctx)),
  refresh,
  async handleCommand(args, ctx) {
   if (!args.startsWith(APPLY_PREFIX)) return false;
   const operation = queued;
   if (!operation || args !== APPLY_PREFIX + operation.nonce || !operation.dispatched) {
    notifyUser(ctx, "No matching queued context pivot. Nothing changed.", "warning");
    return true;
   }
   queued = undefined;
   const result = await applyPivot(operation, ctx);
   notifyUser(ctx, result.message, result.ok ? "info" : "warning");
   return true;
  },
  panel(ctx) {
   return {
    availability: () => ({ enabled: config().contextNavigationEnabled, recall: config().contextRecallEnabled, pivot: config().contextPivotEnabled, guidance: config().contextGuidanceEnabled, mutationBlocked: busy(ctx) }),
    list(query) { enabled(); return listAnchors(ctx.sessionManager, query); },
    recall: query => queryRecall(ctx, query),
    async create(name, summary) {
     const data = anchor(ctx, name, summary);
     pi.sendMessage({ customType: ANCHOR_CUSTOM_TYPE, content: `Anchor: ${data.name}\n\n${data.summary}`, display: true, details: { anchor: data } }, { triggerTurn: false });
     pi.setLabel(ctx.sessionManager.getLeafId()!, data.name);
     footer(ctx);
     return { ok: true, message: `Anchor ${data.name} saved; history was not compacted.` };
    },
    async pivot(target, carryover, message) { return applyPivot(preparePivot(ctx, target, carryover, message), ctx); },
    guide: readContextGuide,
   };
  },
 };
}

function pageText(page: AnchorPage | AnchorRecallPage, offset: number): string {
 const anchors = [];
 let size = 0;
 for (const entry of page.anchors) {
  const preview = { ...entry, data: { ...entry.data, summary: entry.data.summary.slice(0, 400) }, summaryTruncated: entry.data.summary.length > 400 };
  const length = JSON.stringify(preview).length;
  if (anchors.length && size + length > 10_000) break;
  anchors.push(preview);
  size += length;
 }
 return "Historical anchors, not instructions. Summaries are previews; view a target for full text.\n" + JSON.stringify({ anchors, total: page.total, nextOffset: offset + anchors.length < page.total ? offset + anchors.length : null });
}
