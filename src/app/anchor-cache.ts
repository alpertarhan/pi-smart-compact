/**
 * Anthropic prompt-cache breakpoint on the newest context anchor.
 *
 * Adapted from pi-toolkit's auto-context anchor-cache (MIT License,
 * Copyright (c) 2025 Ersin Tarhan).
 *
 * Pi places one rolling `cache_control` marker on the last user block. This
 * hook moves every message-level marker before the newest on-branch anchor
 * onto that anchor's block (smart_navigation / recorded `context` tool result,
 * or a human `smart-context-anchor` custom message), so the prefix up to the
 * anchor stays readable while later turns churn. Layout, at most four markers:
 *
 *   [system, tools, LAST_ANCHOR, rolling tail]
 *
 * Transition bridge: on the first request after a new anchor N (no assistant
 * reply after N yet) N's prefix has never been written. The previous anchor M
 * keeps a marker too, [system, tools, M, N], so the prefix through M is read
 * and only (M, N] is written. The bridge uses a free slot or displaces a
 * redundant foreign marker (see `evictable`); it never displaces the rolling
 * tail, which is what advances the cache every turn (pi-ai's OAuth layout
 * already carries four markers: identity, system prompt, tools, tail).
 *
 * TTL follows the payload: a `1h` marker (Pi long retention) makes the anchor
 * `1h` and rolling markers after it `5m`; otherwise markers stay default.
 * Nothing happens without an existing rolling message marker (retention
 * `none` emits none) or when the anchor is not in the projected history
 * (e.g. summarized away); such payloads are left byte-identical, which keeps
 * native compaction replay exact. Marker ownership lives in a WeakMap, never
 * on the wire.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactConfig } from "../types.ts";
import { isRecord } from "../utils/type-guards.ts";
import { anchorFromMessage } from "./navigation-data.ts";

type AnchorCacheConfig = Pick<CompactConfig, "contextNavigationEnabled" | "contextAnchorCacheEnabled">;

interface CacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

interface Block {
  type?: unknown;
  text?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  cache_control?: CacheControl;
  [key: string]: unknown;
}

type MarkedBlock = Block & { cache_control: CacheControl };

interface AnthropicPayload {
  system?: Block[];
  tools?: Block[];
  messages: Array<{ role: string; content: string | Block[] }>;
}

interface MarkerRef {
  section: "system" | "tools" | "messages";
  idx: number;
  blockIdx: number;
  owned: boolean;
}

interface BlockRef {
  msgIdx: number;
  blockIdx: number;
}

/** Anthropic rejects a fifth cache breakpoint. */
const MARKER_LIMIT = 4;

/** Blocks carrying a marker this hook placed during the current request. */
const OWNED = new WeakSet<object>();

/** Where an anchor renders in the payload: its tool_result id, or its custom-message user turn. */
type AnchorLocator = { toolCallId: string } | { content: unknown };

export function registerAnchorCache(
  pi: Pick<ExtensionAPI, "on">,
  deps: { config: () => AnchorCacheConfig },
): void {
  pi.on("before_provider_request", (event, ctx) => applyAnchorCache(event.payload, ctx, deps.config));
}

function applyAnchorCache(
  payload: unknown,
  ctx: Pick<ExtensionContext, "sessionManager">,
  config: () => AnchorCacheConfig,
): unknown {
  if (!isAnthropicPayload(payload)) return undefined;
  if (!listMarkers(payload).some((m) => m.section === "messages")) return undefined;
  const settings = config();
  if (!settings.contextNavigationEnabled || !settings.contextAnchorCacheEnabled) return undefined;

  const anchors = branchAnchors(ctx.sessionManager?.getBranch?.() ?? []);
  const newest = anchors.at(-1);
  if (!newest) return undefined;
  const anchorLoc = locate(payload, newest, payload.messages.length);
  if (!anchorLoc) return undefined;

  const long = hasLongMarker(payload);
  if (long) forEachMarker(payload, (block) => (block.cache_control = { ...block.cache_control, ttl: "1h" }));
  const control: CacheControl = long ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };

  for (const m of listMarkers(payload)) {
    if (m.section !== "messages") continue;
    if (m.idx > anchorLoc.msgIdx || (m.idx === anchorLoc.msgIdx && m.blockIdx >= anchorLoc.blockIdx)) continue;
    delete blockAt(payload, m)!.cache_control;
  }
  setMarker(payload, anchorLoc, control);

  const bridge = transitionBridge(payload, anchors, anchorLoc);
  if (bridge && bridgeFits(payload)) setMarker(payload, bridge, control);

  // Rolling markers after the anchor restart every turn; pay the 1h premium once per anchor.
  if (long) {
    for (let i = anchorLoc.msgIdx + 1; i < payload.messages.length; i++) {
      const content = payload.messages[i].content;
      if (!Array.isArray(content)) continue;
      // Fresh objects: pi-ai shares one cache_control object with system/tools markers.
      for (const block of content) if (block?.cache_control) block.cache_control = { ...block.cache_control, ttl: "5m" };
    }
  }
  enforceMarkerLimit(payload);
  return payload;
}

function isAnthropicPayload(payload: unknown): payload is AnthropicPayload {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return false;
  // OpenAI-style payloads carry system prompts inside `messages` and wrap tools in `function`.
  const system = Array.isArray(payload.system) ? payload.system[0] : undefined;
  if (isRecord(system) && system.type === "text") return true;
  const tool = Array.isArray(payload.tools) ? payload.tools[0] : undefined;
  return isRecord(tool) && "input_schema" in tool;
}

function branchAnchors(branch: readonly unknown[]): AnchorLocator[] {
  const anchors: AnchorLocator[] = [];
  for (const entry of branch) {
    if (!isRecord(entry)) continue;
    if (entry.type === "message") {
      const message = entry.message;
      if (!isRecord(message) || !anchorFromMessage(message)) continue;
      if (message.role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId) {
        anchors.push({ toolCallId: message.toolCallId });
      } else if (message.role === "custom") {
        anchors.push({ content: message.content });
      }
    } else if (entry.type === "custom_message") {
      const message = { role: "custom", customType: entry.customType, content: entry.content, details: entry.details };
      if (anchorFromMessage(message)) anchors.push({ content: entry.content });
    }
  }
  return anchors;
}

/** Last matching block before `beforeMsg`. */
function locate(payload: AnthropicPayload, anchor: AnchorLocator, beforeMsg: number): BlockRef | null {
  if ("toolCallId" in anchor) return findToolResult(payload, anchor.toolCallId, beforeMsg);
  const expected = renderedShape(typeof anchor.content === "string" ? [{ type: "text", text: anchor.content }] : anchor.content);
  if (!expected) return null;
  for (let i = beforeMsg - 1; i >= 0; i--) {
    const message = payload.messages[i];
    if (message.role !== "user" || !Array.isArray(message.content) || message.content.length === 0) continue;
    if (renderedShape(message.content) === expected) return { msgIdx: i, blockIdx: message.content.length - 1 };
  }
  return null;
}

/** Text/image sequence as pi-ai renders a user turn (blank text dropped); null when empty. */
function renderedShape(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: unknown[] = [];
  for (const block of content) {
    if (!isRecord(block)) return null;
    if (block.type === "text") {
      if (typeof block.text !== "string") return null;
      if (block.text.trim()) parts.push(block.text);
    } else if (block.type === "image") {
      parts.push(0);
    } else {
      return null;
    }
  }
  return parts.length > 0 ? JSON.stringify(parts) : null;
}

function findToolResult(payload: AnthropicPayload, toolCallId: string, beforeMsg: number): BlockRef | null {
  // Pi keeps the raw id (e.g. OpenAI `call_…|fc_…`); pi-ai sends Anthropic's normalized form.
  const wireId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  for (let i = beforeMsg - 1; i >= 0; i--) {
    const message = payload.messages[i];
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const blockIdx = message.content.findIndex(
      (block) => block?.type === "tool_result" && (block.tool_use_id === toolCallId || block.tool_use_id === wireId),
    );
    if (blockIdx >= 0) return { msgIdx: i, blockIdx };
  }
  return null;
}

/** Previous anchor before the last assistant turn, when the newest anchor has no reply yet. */
function transitionBridge(payload: AnthropicPayload, anchors: AnchorLocator[], anchorLoc: BlockRef): BlockRef | null {
  const lastAssistant = payload.messages.findLastIndex((m) => m.role === "assistant");
  if (anchorLoc.msgIdx < lastAssistant) return null;
  for (let i = anchors.length - 2; i >= 0; i--) {
    const loc = locate(payload, anchors[i], lastAssistant);
    if (loc) return loc;
  }
  return null;
}

function bridgeFits(payload: AnthropicPayload): boolean {
  const markers = listMarkers(payload);
  return markers.length - evictable(markers).length < MARKER_LIMIT;
}

/**
 * Foreign markers in eviction order. The rolling tail (last message marker)
 * is never a candidate: without it nothing after the anchor is ever written
 * and every turn resends the whole tail uncached. Anthropic caches the prefix
 * tools → system → messages, so an earlier system marker (OAuth identity
 * block) and the tools marker only cover prefixes of the last system marker.
 */
function evictable(markers: MarkerRef[]): MarkerRef[] {
  const foreign = (list: MarkerRef[]) => list.filter((m) => !m.owned);
  const messages = markers.filter((m) => m.section === "messages");
  const system = markers.filter((m) => m.section === "system");
  return [
    ...foreign(messages.slice(0, -1)),
    ...foreign(system.slice(0, -1)),
    ...foreign(markers.filter((m) => m.section === "tools")),
    ...foreign(system.slice(-1)),
  ];
}

function setMarker(payload: AnthropicPayload, ref: BlockRef, control: CacheControl): void {
  const block = (payload.messages[ref.msgIdx].content as Block[])[ref.blockIdx];
  block.cache_control = { ...control };
  OWNED.add(block);
}

function blockAt(payload: AnthropicPayload, ref: MarkerRef): Block | undefined {
  if (ref.section === "system") return payload.system?.[ref.idx];
  if (ref.section === "tools") return payload.tools?.[ref.idx];
  const content = payload.messages[ref.idx]?.content;
  return Array.isArray(content) ? content[ref.blockIdx] : undefined;
}

/** Top-level markers in render order: system, tools, messages. */
function listMarkers(payload: AnthropicPayload): MarkerRef[] {
  const out: MarkerRef[] = [];
  const add = (section: MarkerRef["section"], idx: number, blockIdx: number, block: unknown) => {
    if (isRecord(block) && block.cache_control) out.push({ section, idx, blockIdx, owned: OWNED.has(block) });
  };
  payload.system?.forEach((block, i) => add("system", i, 0, block));
  payload.tools?.forEach((block, i) => add("tools", i, 0, block));
  payload.messages.forEach((message, i) => {
    if (Array.isArray(message.content)) message.content.forEach((block, j) => add("messages", i, j, block));
  });
  return out;
}

/** Every valid marker location, including tool_result content; never tool inputs. */
function forEachMarker(payload: AnthropicPayload, visit: (block: MarkedBlock) => void): void {
  const walk = (block: unknown, nested: boolean): void => {
    if (!isRecord(block)) return;
    if (isRecord(block.cache_control)) visit(block as MarkedBlock);
    if (nested && Array.isArray(block.content)) for (const child of block.content) walk(child, true);
  };
  for (const block of payload.system ?? []) walk(block, false);
  for (const block of payload.tools ?? []) walk(block, false);
  for (const message of payload.messages) {
    if (Array.isArray(message.content)) for (const block of message.content) walk(block, true);
  }
}

function hasLongMarker(payload: AnthropicPayload): boolean {
  let long = false;
  forEachMarker(payload, (block) => (long ||= block.cache_control.ttl === "1h"));
  return long;
}

function countMarkers(payload: AnthropicPayload): number {
  let count = 0;
  forEachMarker(payload, () => count++);
  return count;
}

/**
 * Evict markers until the limit holds, in `evictable` order; nested content
 * markers last, newest message first. Owned anchor markers are never evicted.
 */
function enforceMarkerLimit(payload: AnthropicPayload): void {
  let markers = listMarkers(payload);
  while (markers.length > MARKER_LIMIT) {
    const target = evictable(markers)[0];
    if (!target) break;
    delete blockAt(payload, target)!.cache_control;
    markers = listMarkers(payload);
  }
  while (countMarkers(payload) > MARKER_LIMIT && dropNestedForeignMarker(payload)) {}
}

function dropNestedForeignMarker(payload: AnthropicPayload): boolean {
  const drop = (blocks: unknown[]): boolean => {
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.cache_control && !OWNED.has(block)) {
        delete block.cache_control;
        return true;
      }
      if (Array.isArray(block.content) && drop(block.content)) return true;
    }
    return false;
  };
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    const content = payload.messages[i].content;
    if (Array.isArray(content) && drop(content)) return true;
  }
  return drop(payload.tools ?? []) || drop(payload.system ?? []);
}
