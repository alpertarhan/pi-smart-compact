/**
 * Phase 1: Deterministic extraction — zero LLM calls.
 */

import path from "node:path";
import type { LlmMessage, ProfileConfig, StructuredExtraction, OpenLoop, MediaAttachment } from "../types.ts";
import { NO_OP_RE, SHIFT_RE, CHOICE_RE } from "../constants.ts";
import { estimateTokens } from "./tokens.ts";
import { isToolCallBlock, isTextBlock } from "../utils/type-guards.ts";
import { buildPathNeedles } from "./file-needles.ts";

/** pi-toolkit truncation marker: content.slice(0, 20) + `…✂${content.length}` */
export const TRUNCATE_RE = /…✂\d+$/;

export function isTruncated(content: unknown): boolean {
  return TRUNCATE_RE.test(extractText(content));
}

const WRITE_TOOL_HINTS = ["write", "edit", "patch", "create", "append", "update", "apply"];
const DELETE_TOOL_HINTS = ["delete", "remove", "unlink"];
const READ_TOOL_HINTS = ["read", "view", "open"];

function hasToolHint(tool: string, hints: readonly string[]): boolean {
  return hints.some(hint => tool.includes(hint));
}

/** Reusable tool call index type */
export type ToolCallIndex = Map<string, { name: string; arguments: Record<string, unknown>; msgIndex: number }>;

/** Flattened tool-call descriptor (post `multi_tool_use.parallel` expansion). */
export interface FlatToolCall {
  name: string;
  id?: string;
  arguments: Record<string, unknown>;
}

/**
 * Flatten a single assistant content block into one or more tool-call descriptors.
 * Transparently expands `multi_tool_use.parallel` wrappers into their nested tool_uses.
 * Returns [] for non-tool-call blocks. Used by extraction, topic segmentation, and
 * error-retry detection to avoid re-implementing the parallel-flatten contract.
 */
export function flattenToolCallBlock(b: unknown): FlatToolCall[] {
  if (!isToolCallBlock(b)) return [];
  if (b.name === "multi_tool_use.parallel" && Array.isArray(b.arguments?.tool_uses)) {
    return (b.arguments.tool_uses as Record<string, unknown>[]).map((u) => {
      const recipient = (u?.recipient_name as string) ?? "";
      return {
        name: recipient.replace(/^functions\./, ""),
        id: (u?.id as string) ?? undefined,
        arguments: (u?.parameters as Record<string, unknown>) ?? {},
      };
    });
  }
  return [{ name: b.name, id: b.id, arguments: b.arguments }];
}

/**
 * Flatten an LLM message content payload into a plain string.
 *
 * Accepts `string`, `Array<string | TextBlock | ToolCallBlock | ...>`, or
 * any other shape (which collapses to `""`). Uses `isTextBlock` so the
 * narrowing logic stays in one place — the previous inline
 * `(b as Record<string, unknown>)?.type === "text"` cast trio had to be
 * kept in sync with the real text-block shape by hand.
 */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: unknown) => {
    if (typeof b === "string") return b;
    if (isTextBlock(b)) return b.text;
    return "";
  }).join("");
}

function mediaKind(type: string, mime?: string): MediaAttachment["kind"] {
  const s = (type + " " + (mime ?? "")).toLowerCase();
  if (/image|input_image|image_url/.test(s)) return "image";
  if (/audio/.test(s)) return "audio";
  if (/video/.test(s)) return "video";
  if (/file|document|pdf|attachment/.test(s)) return "file";
  return "unknown";
}

/** Extract attachment metadata without embedding binary/base64 payloads in summaries. */
export function extractMediaAttachments(msgs: LlmMessage[]): MediaAttachment[] {
  const out: MediaAttachment[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const blocks = Array.isArray(msgs[i].content) ? msgs[i].content as unknown[] : [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      const rec = b as Record<string, unknown>;
      const type = String(rec.type ?? "");
      if (type === "text" || type === "toolCall" || type === "tool_use") continue;
      const mimeType = (rec.mimeType ?? rec.mime_type ?? rec.mediaType ?? rec.media_type) as string | undefined;
      const name = (rec.name ?? rec.filename ?? rec.fileName ?? rec.title) as string | undefined;
      const sizeBytes = (rec.sizeBytes ?? rec.size_bytes ?? rec.size) as number | undefined;
      const source = typeof rec.url === "string" ? "url" : typeof rec.path === "string" ? "path" : typeof rec.data === "string" || typeof rec.base64 === "string" ? "inline" : undefined;
      const kind = mediaKind(type, mimeType);
      if (kind !== "unknown" || source || mimeType || name) {
        out.push({ index: i, kind, mimeType, name, sizeBytes: typeof sizeBytes === "number" ? sizeBytes : undefined, source });
      }
    }
  }
  return out;
}

export function buildToolCallIndex(msgs: LlmMessage[]): ToolCallIndex {
  const idx = new Map<string, { name: string; arguments: Record<string, unknown>; msgIndex: number }>();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (!isToolCallBlock(b)) continue;
      if (b.id) {
        idx.set(b.id, { name: b.name, arguments: b.arguments, msgIndex: i });
      }
      // Flatten multi_tool_use.parallel into synthetic tool-call entries.
      // Prefer the real tool_use id if present (matches downstream toolResult.toolCallId),
      // otherwise fall back to a deterministic synthetic id.
      if (b.name === "multi_tool_use.parallel" && Array.isArray(b.arguments?.tool_uses)) {
        const nested = flattenToolCallBlock(b);
        for (let t = 0; t < nested.length; t++) {
          const tool = nested[t];
          const syntheticId = b.id ? b.id + "_" + t : "mtu_" + i + "_" + t;
          idx.set(tool.id || syntheticId, { name: tool.name, arguments: tool.arguments, msgIndex: i });
        }
      }
    }
  }
  return idx;
}

export function trackFileOps(msgs: LlmMessage[], _tcIdx?: ToolCallIndex): { modified: StructuredExtraction["modifiedFiles"]; read: string[]; deleted: string[] } {
  const tcIdx = _tcIdx ?? buildToolCallIndex(msgs);
  const modMap = new Map<string, { toolCalls: number; lastIdx: number }>();
  const readSet = new Set<string>();
  const delSet = new Set<string>();

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "toolResult" || m.isError) continue;
    const tc = tcIdx.get(m.toolCallId ?? "");
    if (!tc) continue;
    const args = tc.arguments;
    const filePath = (args?.path ?? args?.file_path ?? args?.filePath) as string | undefined;
    if (!filePath) continue;
    const tool = tc.name.toLowerCase();

    if (hasToolHint(tool, WRITE_TOOL_HINTS)) {
      const resultText = extractText(m.content);
      if (isTruncated(resultText)) {
        // pi-toolkit truncated the result — we cannot verify no-op vs actual write.
        // Safe default: treat as modified (the toolCall itself implies intent).
        const existing = modMap.get(filePath);
        modMap.set(filePath, { toolCalls: (existing?.toolCalls ?? 0) + 1, lastIdx: i });
      } else if (!NO_OP_RE.test(resultText)) {
        const existing = modMap.get(filePath);
        modMap.set(filePath, { toolCalls: (existing?.toolCalls ?? 0) + 1, lastIdx: i });
      }
    } else if (hasToolHint(tool, DELETE_TOOL_HINTS)) {
      delSet.add(filePath);
    } else if (hasToolHint(tool, READ_TOOL_HINTS)) {
      readSet.add(filePath);
    }
  }

  return {
    modified: [...modMap.entries()].map(([p, d]) => ({ path: p, toolCalls: d.toolCalls, lastModifiedIndex: d.lastIdx })),
    read: [...readSet], deleted: [...delSet],
  };
}

export function catalogErrors(msgs: LlmMessage[], _tcIdx?: ToolCallIndex): StructuredExtraction["errors"] {
  const tcIdx = _tcIdx ?? buildToolCallIndex(msgs);
  const errors: StructuredExtraction["errors"] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "toolResult") continue;
    const tc = tcIdx.get(m.toolCallId ?? "");

    if (m.isError) {
      errors.push({ index: i, tool: tc?.name ?? "unknown", message: extractText(m.content).slice(0, 500), retryAttempted: false, resolved: false });
      continue;
    }

    if (tc?.name === "bash") {
      const txt = extractText(m.content);
      const isLikelyError = /(?:command not found|no such file|permission denied|syntax error|cannot find|module not found|compilation error|build failed|test failed|^FAIL\b|ERROR:)/i.test(txt);
      if (isLikelyError && txt.length < 2000) {
        errors.push({ index: i, tool: "bash", message: txt.slice(0, 300), retryAttempted: false, resolved: false });
      }
    }
  }

  for (const err of errors) {
    for (let j = err.index + 1; j < Math.min(msgs.length, err.index + 6); j++) {
      if (msgs[j]?.role === "assistant") {
        const rawBlocks = msgs[j]?.content;
        const blocks: unknown[] = Array.isArray(rawBlocks) ? rawBlocks : [];
        for (const b of blocks) {
          for (const tool of flattenToolCallBlock(b)) {
            if (tool.name === err.tool) {
              err.retryAttempted = true;
              for (let k = j + 1; k < Math.min(msgs.length, j + 10); k++) {
                if (msgs[k]?.role === "toolResult" && msgs[k]?.toolCallId === tool.id && !msgs[k]?.isError) {
                  err.resolved = true; break;
                }
              }
              break;
            }
          }
          if (err.retryAttempted) break;
        }
        if (err.retryAttempted) break;
      }
    }
  }
  return errors;
}

export function extractDecisions(msgs: LlmMessage[], _tcIdx?: ToolCallIndex): StructuredExtraction["decisions"] {
  const tcIdx = _tcIdx ?? buildToolCallIndex(msgs);
  const decisions: StructuredExtraction["decisions"] = [];

  for (const [id, tc] of tcIdx) {
    if (tc.name !== "ask_user") continue;
    const args = tc.arguments;
    const question = typeof args === "string" ? args : (args?.question ?? args?.prompt ?? "") as string;
    if (!question) continue;
    for (let i = tc.msgIndex + 1; i < Math.min(msgs.length, tc.msgIndex + 4); i++) {
      if (msgs[i]?.role === "toolResult" && msgs[i]?.toolCallId === id) {
        decisions.push({ index: tc.msgIndex, type: "explicit", summary: question.slice(0, 200), userResponse: extractText(msgs[i].content).slice(0, 300) });
        break;
      }
    }
  }

  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role !== "user") continue;
    const txt = extractText(msgs[i].content);
    if (CHOICE_RE.test(txt)) {
      decisions.push({ index: i, type: "implicit", summary: txt.slice(0, 200) });
    }
  }
  return decisions;
}

const CONSTRAINT_PATTERNS: Array<{ re: RegExp; cat: StructuredExtraction["constraints"][0]["category"]; conf: number }> = [
  { re: /\b(?:must|need|require|has to|important)\b.*\b(?:be|use|have|include|support)\b/i, cat: "requirement", conf: 0.85 },
  { re: /\b(?:don't|never|avoid|shouldn't|must not|do not|no\s+(?:need|want))\b/i, cat: "prohibition", conf: 0.8 },
  { re: /\b(?:prefer|like|want|would rather|should)\b.*\b(?:use|be|have|with)\b/i, cat: "preference", conf: 0.6 },
  // Turkish patterns — both with and without diacriticals
  { re: /\b(?:kritik|kritikal|\u00f6nemli|onemli|\u015fart|sart|zorunlu|\u015fart ko\u015ful|\u00f6nemli \u015fart|kesinlikle|kesinlikle \u015fart|asla|sak\u0131n|sak\u0131nha|bunu yapma|b\u00f6yle olsun|b\u00f6yle yap\u0131n|\u015f\u00f6yle olsun|\u015f\u00f6yle yap\u0131n)\b/iu, cat: "requirement", conf: 0.8 },
  { re: /\b(?:yapma|kullanma|sak\u0131n|asla\s+(?:kullanma|yapma|getirme))\b/iu, cat: "prohibition", conf: 0.8 },
  { re: /\b(?:tercih|isterim|olsun|kullanal\u0131m|yapal\u0131m|istiyorum)\b/iu, cat: "preference", conf: 0.6 },
];

export function mineConstraints(msgs: LlmMessage[]): StructuredExtraction["constraints"] {
  const constraints: StructuredExtraction["constraints"] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role !== "user") continue;
    const txt = extractText(msgs[i].content);
    if (txt.length < 10 || txt.startsWith("/")) continue;
    for (const { re, cat, conf } of CONSTRAINT_PATTERNS) {
      if (re.test(txt)) {
        constraints.push({ index: i, text: txt.slice(0, 300), category: cat, confidence: conf });
        break;
      }
    }
  }
  return constraints;
}

export function segmentTopicsHeuristic(msgs: LlmMessage[], pc: ProfileConfig, maxSegs = 20, _tcIdx?: ToolCallIndex): StructuredExtraction["topics"] {
  const topics: StructuredExtraction["topics"] = [];
  let startIdx = 0, tokenAcc = 0, lastFile: string | null = null, errAcc = 0;
  let currentType: StructuredExtraction["topics"][0]["type"] = "exploration";
  let currentPrimaryFile: string | null = null;
  const tcIdx = _tcIdx ?? buildToolCallIndex(msgs);

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const txt = extractText(m.content);
    tokenAcc += estimateTokens(txt);
    let brk = false;
    let type: StructuredExtraction["topics"][0]["type"] = "exploration";
    let primaryFile: string | null = null;

    if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        for (const tool of flattenToolCallBlock(b)) {
          const fp = (tool.arguments?.path ?? tool.arguments?.file_path) as string | undefined;
          if (!fp) continue;
          const fn = path.basename(fp);
          if (lastFile && fn !== lastFile && tokenAcc > pc.minChunkTokens) brk = true;
          lastFile = fn;
          primaryFile = fp; currentPrimaryFile = fp;
          if (tool.name?.includes("write") || tool.name?.includes("edit")) { type = "implementation"; if (currentType !== "implementation") currentType = "implementation"; }
          else if (tool.name?.includes("read")) { type = "review"; if (currentType === "exploration") currentType = "review"; }
        }
      }
    }
    if (m.role === "toolResult" && m.isError) { errAcc++; type = "debugging"; if (currentType !== "implementation") currentType = "debugging"; }
    if (m.role === "toolResult" && !m.isError) {
      const tc = tcIdx.get(m.toolCallId ?? "");
      if (tc?.name === "bash" && /error|fail/i.test(txt)) { errAcc++; type = "debugging"; if (currentType !== "implementation") currentType = "debugging"; }
    }
    if (m.role === "user" && SHIFT_RE.test(txt) && tokenAcc > pc.minChunkTokens) brk = true;
    if (tokenAcc >= pc.maxChunkTokens) brk = true;

    if (brk && i > startIdx && topics.length < maxSegs - 1) {
      topics.push({ startIndex: startIdx, endIndex: i, primaryFile: currentPrimaryFile, type: currentType, errorDensity: errAcc });
      startIdx = i + 1; tokenAcc = 0; lastFile = null; errAcc = 0;
      currentType = "exploration"; currentPrimaryFile = null;
    }
  }
  if (startIdx < msgs.length) {
    topics.push({ startIndex: startIdx, endIndex: msgs.length - 1, primaryFile: currentPrimaryFile, type: currentType, errorDensity: errAcc });
  }
  return topics;
}

export function buildTimeline(msgs: LlmMessage[], errors: StructuredExtraction["errors"]): StructuredExtraction["timeline"] {
  const timeline: StructuredExtraction["timeline"] = [];
  const errorIndices = new Set(errors.map(e => e.index));
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "user") {
      const txt = extractText(m.content);
      if (!txt.startsWith("/")) timeline.push({ index: i, event: "user_request", summary: txt.slice(0, 150) });
    }
    if (errorIndices.has(i)) timeline.push({ index: i, event: "error", summary: errors.find(e => e.index === i)?.message.slice(0, 100) ?? "error" });
  }
  return timeline.length > 30
    ? [...timeline.filter(t => t.event === "user_request").slice(0, 10), ...timeline.filter(t => t.event === "error")]
    : timeline;
}

export function extractMainGoal(msgs: LlmMessage[]): string | null {
  for (const m of msgs) {
    if (m?.role !== "user") continue;
    const txt = extractText(m.content).trim();
    if (txt && !txt.startsWith("/")) return txt.slice(0, 300);
  }
  return null;
}

/** Extract open loops — unresolved tasks from the conversation */
export function extractOpenLoops(msgs: LlmMessage[], extraction: StructuredExtraction): OpenLoop[] {
  const loops: OpenLoop[] = [];
  let loopId = 0;

  // ── 1. Unresolved errors → bugfix loops ──
  // File-attribution heuristic delegated to `utils/file-needles.ts` so the
  // path-suffix logic can be unit-tested in isolation. Briefly: a bare
  // basename ("index.ts") is too generic to attach — we require a
  // containing directory in the error message.
  //
  // Pre-compute needles once per modified file. Otherwise we'd rebuild the
  // same needles array N (errors) × M (files) times — cheap per call, but
  // pathological for sessions with dozens of unresolved errors and many
  // touched files. With pre-computation the inner loop is a pure substring
  // scan over a fixed-size array.
  const fileNeedles = extraction.modifiedFiles.map(f => ({
    path: f.path,
    needles: buildPathNeedles(f.path),
  }));
  for (const err of extraction.errors.filter(e => !e.resolved)) {
    const errLower = err.message.toLowerCase();
    const errFiles = fileNeedles
      .filter(({ needles }) => needles.some(n => errLower.includes(n)))
      .map(({ path }) => path);
    loops.push({
      id: "loop-" + (++loopId),
      type: "bugfix",
      priority: err.retryAttempted ? "high" : "normal",
      status: "open",
      summary: err.message.slice(0, 120),
      files: errFiles,
      sourceIndex: err.index,
    });
  }

  // ── 2. User "next step" / follow-up patterns → follow-up loops ──
  // Match English + Turkish follow-up cues; allow both ASCII-only and diacritic spellings
  // because users mix the two and we never want to miss an open loop.
  const FOLLOWUP_RE = /(?:next\s+(?:step|thing)|todo|action item|follow\s*up|still (?:need|have) to|gotta|yapalim|yapalım|yapmamiz|yapmamız|gerekiyor|eklenecek|düzeltilecek|duzeltilecek|bitmedi|kaldi|kaldı)/iu;
  for (let idx = 0; idx < msgs.length; idx++) {
    const msg = msgs[idx];
    if (msg.role !== "user") continue;
    const txt = extractText(msg.content);
    if (txt.length < 10 || txt.startsWith("/")) continue;
    if (FOLLOWUP_RE.test(txt)) {
      // Avoid duplicates with errors
      const isDup = loops.some(l => Math.abs((l.sourceIndex ?? 0) - idx) < 5);
      if (!isDup) {
        loops.push({
          id: "loop-" + (++loopId),
          type: "follow-up",
          priority: "normal",
          status: "open",
          summary: txt.slice(0, 120),
          files: [],
          sourceIndex: idx,
        });
      }
    }
  }

  // ── 3. Blocked items → blocked loops ──
  const BLOCKED_RE = /blocked|waiting for|depend|ba[ğg]li|bekliyor|engell/i;
  for (let idx = 0; idx < msgs.length; idx++) {
    const msg = msgs[idx];
    if (msg.role !== "user") continue;
    const txt = extractText(msg.content);
    if (BLOCKED_RE.test(txt)) {
      const isDup = loops.some(l => Math.abs((l.sourceIndex ?? 0) - idx) < 5);
      if (!isDup) {
        loops.push({
          id: "loop-" + (++loopId),
          type: "blocked",
          priority: "high",
          status: "open",
          summary: txt.slice(0, 120),
          files: [],
          sourceIndex: idx,
        });
      }
    }
  }

  // ── 4. Pending tool retries → retry loops ──
  for (const err of extraction.errors.filter(e => e.retryAttempted && !e.resolved)) {
    // Only add if not already captured as bugfix
    const exists = loops.some(l => l.type === "bugfix" && l.sourceIndex === err.index);
    if (!exists) {
      loops.push({
        id: "loop-" + (++loopId),
        type: "retry",
        priority: "high",
        status: "open",
        summary: "Retried but unresolved: " + err.message.slice(0, 80),
        files: [],
        sourceIndex: err.index,
      });
    }
  }

  return loops;
}

/**
 * Run all extractors over a (typically pruned) message list. Accepts an
 * optional pre-built `ToolCallIndex` so callers that have already walked the
 * messages (e.g. the orchestrator caching it on the RunContext) can skip the
 * O(n) rebuild.
 *
 * Important: `tcIdx` must be keyed by the **same** message offsets as `msgs`.
 * Pruning produces an index against the unpruned list; that index is not safe
 * to pass here — build a fresh one over the pruned messages instead.
 */
export function extractStructured(msgs: LlmMessage[], pc: ProfileConfig, precomputedTcIdx?: ToolCallIndex): StructuredExtraction {
  const tcIdx = precomputedTcIdx ?? buildToolCallIndex(msgs);
  const { modified, read, deleted } = trackFileOps(msgs, tcIdx);
  const errors = catalogErrors(msgs, tcIdx);
  const decisions = extractDecisions(msgs, tcIdx);
  const constraints = mineConstraints(msgs);
  const topics = segmentTopicsHeuristic(msgs, pc, 20, tcIdx);
  const timeline = buildTimeline(msgs, errors);
  const mediaAttachments = extractMediaAttachments(msgs);
  const mainGoal = extractMainGoal(msgs);
  const lastUserMessages = msgs.filter(m => m.role === "user").slice(-5).map(m => extractText(m.content));
  const lastErrors = errors.slice(-3).map(e => e.message);
  return {
    modifiedFiles: modified, readFiles: read, deletedFiles: deleted,
    errors, decisions, constraints, topics, timeline, mediaAttachments,
    mainGoal, lastUserMessages, lastErrors, messageCount: msgs.length,
  };
}
