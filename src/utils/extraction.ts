/**
 * Phase 1: Deterministic extraction — zero LLM calls.
 */

import path from "node:path";
import type { LlmMessage, ProfileConfig, StructuredExtraction, OpenLoop, MediaAttachment } from "../types.ts";
import { NO_OP_RE, SHIFT_RE, CHOICE_RE, LIKELY_ERROR_RE, ERROR_RETRY_WINDOW, ERROR_RESOLVE_WINDOW, TRUNC, ID_PREFIX, TUNING, EXTRACTION_LIMITS } from "../constants.ts";
import { estimateTokens } from "./tokens.ts";
import { isToolCallBlock, isTextBlock } from "../utils/type-guards.ts";
import { buildPathNeedles } from "./file-needles.ts";
import { classifyToolOperation, extractShellFileOperations, extractToolPath, sameToolOperation, toolOperationSignature } from "../domain/tool-semantics.ts";
import { extractFileRefs } from "./file-ref-detect.ts";
import { findSection, summaryEvidenceLine } from "../domain/summary-parse.ts";

/** pi-toolkit truncation marker: content.slice(0, 20) + `…✂${content.length}` */
export const TRUNCATE_RE = /…✂\d+$/;

export function isTruncated(content: unknown): boolean {
  return TRUNCATE_RE.test(extractText(content));
}

/** Reusable tool call index type */
export type ToolCallIndex = Map<string, { name: string; arguments: Record<string, unknown>; msgIndex: number }>;

/** Flattened tool-call descriptor (post `multi_tool_use.parallel` expansion). */
export interface FlatToolCall {
  name: string;
  id?: string;
  arguments: Record<string, unknown>;
}

/** Identity contract shared by extraction and pruning for nested parallel calls. */
export function nestedToolCallId(wrapperId: string | undefined, messageIndex: number, toolIndex: number, nestedId?: unknown): string {
  return typeof nestedId === "string"
    ? nestedId
    : wrapperId ? wrapperId + "_" + toolIndex : ID_PREFIX.MULTI_TOOL_USE_SYNTHETIC + messageIndex + "_" + toolIndex;
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

export function buildToolCallIndex(msgs: readonly LlmMessage[]): ToolCallIndex {
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
          const id = nestedToolCallId(b.id, i, t, tool.id);
          idx.set(id, { name: tool.name, arguments: tool.arguments, msgIndex: i });
        }
      }
    }
  }
  return idx;
}

export function trackFileOps(msgs: LlmMessage[], _tcIdx?: ToolCallIndex): {
  modified: StructuredExtraction["modifiedFiles"];
  read: string[];
  deleted: string[];
  referenced: string[];
} {
  const tcIdx = _tcIdx ?? buildToolCallIndex(msgs);
  const modMap = new Map<string, { toolCalls: number; lastIdx: number }>();
  const readAt = new Map<string, number>();
  const deletedAt = new Map<string, number>();
  const referencedAt = new Map<string, number>();

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    for (const ref of extractFileRefs((JSON.stringify(m.content) ?? "").replace(/\\[nrt]/g, " "))) {
      referencedAt.set(ref, i);
    }
    if (m.role !== "toolResult" || m.isError) continue;
    const tc = tcIdx.get(m.toolCallId ?? "");
    if (!tc) continue;
    const operation = classifyToolOperation(tc.arguments, tc.name);
    if (operation === "execute") {
      const resultText = extractText(m.content);
      if (hasCommandFailureSignal(resultText)) continue;
      const shell = extractShellFileOperations(tc.arguments);
      for (const file of shell.modified) {
        const existing = modMap.get(file);
        modMap.set(file, { toolCalls: (existing?.toolCalls ?? 0) + 1, lastIdx: i });
        deletedAt.delete(file);
      }
      for (const file of shell.deleted) {
        deletedAt.set(file, i);
        modMap.delete(file);
        readAt.delete(file);
      }
      continue;
    }

    const filePath = extractToolPath(tc.arguments);
    if (!filePath) continue;
    if (operation === "mutate") {
      // pi-toolkit truncation hides whether a write was a no-op, so a truncated
      // result is treated as modified (safe default); otherwise skip true no-ops.
      const resultText = extractText(m.content);
      if (isTruncated(resultText) || !NO_OP_RE.test(resultText)) {
        const existing = modMap.get(filePath);
        modMap.set(filePath, { toolCalls: (existing?.toolCalls ?? 0) + 1, lastIdx: i });
        deletedAt.delete(filePath);
      }
    } else if (operation === "delete") {
      deletedAt.set(filePath, i);
      modMap.delete(filePath);
      readAt.delete(filePath);
    } else if (operation === "read" || operation === "search" || operation === "list") {
      // A successful access proves the path is present now. Record the latest
      // access index so tail caps preserve recently re-read files.
      readAt.set(filePath, i);
      deletedAt.delete(filePath);
    }
  }

  return {
    modified: [...modMap.entries()].map(([p, d]) => ({ path: p, toolCalls: d.toolCalls, lastModifiedIndex: d.lastIdx })),
    read: [...readAt.entries()].sort((a, b) => a[1] - b[1]).map(([file]) => file),
    deleted: [...deletedAt.entries()].sort((a, b) => a[1] - b[1]).map(([file]) => file),
    referenced: [...referencedAt.entries()].sort((a, b) => a[1] - b[1]).map(([file]) => file),
  };
}

function isBenignSearchResult(tc: { arguments: Record<string, unknown> }, result: string): boolean {
  const command = typeof tc.arguments.command === "string"
    ? tc.arguments.command
    : typeof tc.arguments.cmd === "string" ? tc.arguments.cmd : "";
  if (/[;\n]|\|\|/.test(command)) return false;
  const segments = command.split("&&").map(segment => segment.trim()).filter(Boolean);
  const searchOnly = segments.length > 0 && segments.every(segment => /^(?:rg|grep)\b/.test(segment));
  if (!searchOnly || /(?:^|\n)(?:rg|grep):/m.test(result)) return false;
  const exit = result.match(/Command exited with code (\d+)\s*$/i)?.[1];
  return exit === undefined || exit === "1";
}

function hasCommandFailureSignal(text: string): boolean {
  if (/Command exited with code [1-9]\d*\s*$/i.test(text)) return true;
  const firstLine = text.split(/\r?\n/).find(line => line.trim())?.trim() ?? "";
  return LIKELY_ERROR_RE.test(firstLine) || /^(?:npm\s+error|fatal:|traceback\b)/i.test(firstLine);
}

/**
 * Preserve the actionable part of a long command failure instead of blindly
 * returning its prefix. The tail is retained as well because shells commonly
 * report their non-zero exit status there.
 */
export function commandFailureEvidence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const match = /(?:command not found|no such file|permission denied|syntax error|cannot find|module not found|compilation error|build failed|test failed|^FAIL\b|ERROR:|FATAL\b|Traceback\b|(?:failed|failure)\b)/im.exec(text);
  const evidenceBudget = Math.max(1, Math.floor(maxChars * 0.7));
  const tailBudget = Math.max(0, maxChars - evidenceBudget);
  const anchor = match?.index ?? Math.max(0, text.length - evidenceBudget);
  const start = Math.max(0, anchor - Math.floor(evidenceBudget / 4));
  const evidence = text.slice(start, start + evidenceBudget);
  const tail = tailBudget > 0 ? text.slice(-tailBudget) : "";
  return evidence + (tail && !evidence.endsWith(tail) ? "\n...\n" + tail : "");
}

export function isTransientToolDiagnostic(text: string): boolean {
  const candidate = text.trim();
  return /\bBrave Search API error\s*\(429\)/i.test(candidate)
    || (/\bnpm error code ENOLOCK\b/i.test(candidate) && /(?:audit|existing lockfile|loadVirtual)/i.test(candidate))
    || /^Found \d+ occurrences? of edits\[\d+\](?!\w)/i.test(candidate)
    || (/^Unknown JSON field:/i.test(candidate) && /Available fields:/i.test(candidate));
}

export function catalogErrors(msgs: LlmMessage[], _tcIdx?: ToolCallIndex): StructuredExtraction["errors"] {
  const tcIdx = _tcIdx ?? buildToolCallIndex(msgs);
  const errors: StructuredExtraction["errors"] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "toolResult") continue;
    const tc = tcIdx.get(m.toolCallId ?? "");

    const text = extractText(m.content);
    if ((tc && isBenignSearchResult(tc, text)) || isTransientToolDiagnostic(text)) continue;

    if (m.isError) {
      errors.push({
        index: i,
        tool: tc?.name ?? "unknown",
        message: text.slice(0, TRUNC.ERROR_DETAIL),
        retryAttempted: false,
        resolved: false,
        operationSignature: tc ? toolOperationSignature(tc.name, tc.arguments) : undefined,
      });
      continue;
    }

    // Error-pattern scan for command-executing tools (bash/hypa_shell/...).
    // Gated by argument shape, not by tool name, so it auto-covers shell-like
    // tools this code has never seen. Explicit m.isError is handled above.
    if (tc && classifyToolOperation(tc.arguments, tc.name) === "execute") {
      if (hasCommandFailureSignal(text)) {
        errors.push({
          index: i,
          tool: tc.name,
          message: commandFailureEvidence(text, TRUNC.MESSAGE),
          retryAttempted: false,
          resolved: false,
          operationSignature: toolOperationSignature(tc.name, tc.arguments),
        });
      }
    }
  }

  for (const err of errors) {
    const failedCall = tcIdx.get(msgs[err.index]?.toolCallId ?? "");
    if (!failedCall) continue;
    for (let j = err.index + 1; j < Math.min(msgs.length, err.index + ERROR_RETRY_WINDOW); j++) {
      if (msgs[j]?.role !== "assistant") continue;
      const blocks: unknown[] = Array.isArray(msgs[j]?.content) ? msgs[j].content as unknown[] : [];
      const retryTool = blocks
        .flatMap(block => flattenToolCallBlock(block))
        .find(candidate => sameToolOperation(failedCall, candidate));
      if (!retryTool) continue;
      err.retryAttempted = true;
      for (let k = j + 1; k < Math.min(msgs.length, j + ERROR_RESOLVE_WINDOW); k++) {
        const result = msgs[k];
        if (result?.role !== "toolResult" || result.isError) continue;
        const resolved = retryTool.id != null
          ? result.toolCallId === retryTool.id
          : (() => {
            const resultCall = tcIdx.get(result.toolCallId ?? "");
            return Boolean(resultCall && sameToolOperation(retryTool, resultCall));
          })();
        if (resolved) {
          err.resolved = true;
          break;
        }
      }
      break;
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
        decisions.push({ index: tc.msgIndex, type: "explicit", summary: question.slice(0, TRUNC.DECISION_SUMMARY), userResponse: extractText(msgs[i].content).slice(0, TRUNC.USER_RESPONSE) });
        break;
      }
    }
  }

  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role !== "user") continue;
    const txt = extractText(msgs[i].content);
    if (CHOICE_RE.test(txt)) {
      decisions.push({ index: i, type: "implicit", summary: txt.slice(0, TRUNC.DECISION_SUMMARY) });
    }
  }
  return decisions;
}

const CONSTRAINT_PATTERNS: Array<{ re: RegExp; cat: StructuredExtraction["constraints"][0]["category"]; conf: number }> = [
  { re: /\b(?:must|need|require|has to|important)\b.*\b(?:be|use|have|include|support)\b/i, cat: "requirement", conf: TUNING.CONFIDENCE_HIGH },
  { re: /\b(?:don't|never|avoid|shouldn't|must not|do not|no\s+(?:need|want))\b/i, cat: "prohibition", conf: TUNING.CONFIDENCE_MEDIUM },
  { re: /\b(?:prefer|like|want|would rather|should)\b.*\b(?:use|be|have|with)\b/i, cat: "preference", conf: TUNING.CONFIDENCE_LOW },
  // Turkish patterns — raw UTF-8 chars; lookarounds instead of `\b` because
  // JS `\b` is ASCII-only (a leading ö/ş is not a word boundary, so the
  // Turkish-leading forms never matched). (?<![A-Za-z0-9_])…(?![A-Za-z0-9_])
  // treats any non-ASCII letter as a valid edge, so both spellings now work.
  { re: /(?<![A-Za-z0-9_])(?:yapma|kullanma|sakın|sakınha|asla(?:\s+(?:kullanma|yapma|getirme))?|bunu yapma)(?![A-Za-z0-9_])/iu, cat: "prohibition", conf: TUNING.CONFIDENCE_MEDIUM },
  { re: /(?<![A-Za-z0-9_])(?:kritik|kritikal|önemli|onemli|şart|sart|zorunlu|şart koşul|önemli şart|kesinlikle|kesinlikle şart|böyle olsun|böyle yapın|şöyle olsun|şöyle yapın)(?![A-Za-z0-9_])/iu, cat: "requirement", conf: TUNING.CONFIDENCE_MEDIUM },
  { re: /(?<![A-Za-z0-9_])(?:tercih|isterim|olsun|kullanalım|yapalım|istiyorum)(?![A-Za-z0-9_])/iu, cat: "preference", conf: TUNING.CONFIDENCE_LOW },
];

export function isDiagnosticConstraintText(text: string): boolean {
  const candidate = text.replace(/^\s*[-*]\s+/, "").trim();
  return /^(?:\[[^\]]+\]\s*)?(?:npm\s+(?:error|warn|notice|audit|verbose|info)\b|(?:rg|grep):|command exited\b)/i.test(candidate);
}

export function mineConstraints(msgs: LlmMessage[]): StructuredExtraction["constraints"] {
  const constraints: StructuredExtraction["constraints"] = [];
  const seen = new Set<string>();
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role !== "user") continue;
    const text = extractText(msgs[i].content);
    if (text.length < 10 || text.startsWith("/")) continue;
    // A prior compaction is represented as one multiline user message. Match
    // individual bullets/lines so an npm error later in that recap cannot turn
    // the entire recap (including notices) into one bogus constraint.
    for (const raw of text.split(/\n+/)) {
      const candidate = raw.replace(/^\s*[-*]\s+/, "").trim();
      if (candidate.length < 10 || isDiagnosticConstraintText(candidate)) continue;
      for (const { re, cat, conf } of CONSTRAINT_PATTERNS) {
        if (!re.test(candidate)) continue;
        const normalized = candidate.toLowerCase().replace(/\s+/g, " ");
        if (!seen.has(normalized)) {
          seen.add(normalized);
          constraints.push({ index: i, text: candidate.slice(0, TRUNC.CONSTRAINT_TEXT), category: cat, confidence: conf });
        }
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
    const message = msgs[i];
    const text = extractText(message.content);
    const messageTokens = estimateTokens(text);
    const tools = message.role === "assistant"
      ? (Array.isArray(message.content) ? message.content : []).flatMap(flattenToolCallBlock)
      : [];
    const nextFile = tools.map(tool => extractToolPath(tool.arguments)).find((value): value is string => Boolean(value));
    const nextBasename = nextFile ? path.basename(nextFile) : null;
    const closesActiveTool = message.role === "toolResult"
      && (tcIdx.get(message.toolCallId ?? "")?.msgIndex ?? -1) >= startIdx;
    const fileShift = Boolean(lastFile && nextBasename && nextBasename !== lastFile);
    const userShift = message.role === "user" && SHIFT_RE.test(text);
    const sizeShift = tokenAcc > 0 && tokenAcc + messageTokens > pc.maxChunkTokens;
    const breakBefore = !closesActiveTool
      && i > startIdx
      && tokenAcc >= pc.minChunkTokens
      && (fileShift || userShift || sizeShift)
      && topics.length < maxSegs - 1;

    if (breakBefore) {
      topics.push({
        startIndex: startIdx,
        endIndex: i - 1,
        primaryFile: currentPrimaryFile,
        type: currentType,
        errorDensity: errAcc,
      });
      startIdx = i;
      tokenAcc = 0;
      lastFile = null;
      errAcc = 0;
      currentType = "exploration";
      currentPrimaryFile = null;
    }

    tokenAcc += messageTokens;
    for (const tool of tools) {
      const filePath = extractToolPath(tool.arguments);
      if (filePath) {
        lastFile = path.basename(filePath);
        currentPrimaryFile = filePath;
      }
      const operation = classifyToolOperation(tool.arguments, tool.name);
      if (operation === "mutate" || operation === "delete") currentType = "implementation";
      else if ((operation === "read" || operation === "search" || operation === "list") && currentType === "exploration") currentType = "review";
    }
    if (message.role === "toolResult" && message.isError) {
      errAcc++;
      if (currentType !== "implementation") currentType = "debugging";
    } else if (message.role === "toolResult") {
      const tool = tcIdx.get(message.toolCallId ?? "");
      if (tool && classifyToolOperation(tool.arguments, tool.name) === "execute" && /error|fail/i.test(text)) {
        errAcc++;
        if (currentType !== "implementation") currentType = "debugging";
      }
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
      if (!txt.startsWith("/")) timeline.push({ index: i, event: "user_request", summary: txt.slice(0, TRUNC.TIMELINE_EVENT) });
    }
    if (errorIndices.has(i)) timeline.push({ index: i, event: "error", summary: errors.find(e => e.index === i)?.message.slice(0, TRUNC.TIMELINE_ERROR) ?? "error" });
  }
  // Keep the *most recent* N user requests (slice(-N), not slice(0, N)) —
  // for compaction the latest requests are the valuable ones. Re-sort by
  // index so errors interleave chronologically instead of clumping at the end.
  return timeline.length > 30
    ? [
      ...timeline.filter(t => t.event === "user_request").slice(-TRUNC.TIMELINE_DISPLAY),
      ...timeline.filter(t => t.event === "error"),
    ].sort((a, b) => a.index - b.index)
    : timeline;
}

const HISTORY_SUMMARY_RE = /^(?:The conversation history before this point was compacted|The following is a summary of a branch that this conversation came back from)[\s\S]*<summary>/i;
const ACK_ONLY_RE = /^(?:(?:ok(?:ay)?|tamam|evet|yes|thanks?|teşekkürler|continue|devam(?:\s+et)?|go\s+ahead|proceed)[\s.!]*){1,3}$/iu;

/** Machine status from an earlier compaction is context, not an active user goal. */
export function isCompactionStatusText(text: string): boolean {
  const candidate = summaryEvidenceLine(text, TRUNC.MESSAGE).replace(/^["'`]+/, "").trim();
  return /^(?:EESV Compact\b|Smart compact (?:skipped|prepared|run finished)\b|Auto-compacting\b)/i.test(candidate);
}

export function extractMainGoal(msgs: LlmMessage[]): string | null {
  // The latest substantive request is the active goal. Commands and bare
  // acknowledgements do not supersede it; a host compaction message contributes
  // only its canonical Goal section and forms a boundary to older raw history.
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "user") continue;
    const text = extractText(m.content).trim();
    if (!text) continue;
    if (HISTORY_SUMMARY_RE.test(text)) {
      const carried = summaryEvidenceLine(findSection(text, "goal")?.body ?? "", TRUNC.MESSAGE);
      return carried && !isCompactionStatusText(carried) ? carried : null;
    }
    if (text.startsWith("/") || ACK_ONLY_RE.test(text)) continue;
    return summaryEvidenceLine(text, TRUNC.MESSAGE) || null;
  }
  return null;
}

const FOLLOWUP_COMPLETION_RE = /\b(?:done|completed?|finished|implemented|fixed|resolved|updated|added|removed|shipped|tamamland[ıi]|tamamlad[ıi]m|bitti|[çc][öo]z[üu]ld[üu])\b/iu;
const NEGATED_COMPLETION_RE = /\b(?:not|isn['’]?t|wasn['’]?t|hen[üu]z|de[ğg]il)\b.{0,20}\b(?:done|complete|finished|fixed|resolved|bitti)\b/iu;
const FOLLOWUP_TOKEN_STOP: Readonly<Record<string, true>> = {
  next: true, step: true, thing: true, todo: true, action: true, item: true,
  follow: true, still: true, need: true, have: true, gotta: true,
  eklenecek: true, duzeltilecek: true, düzeltilecek: true, gerekiyor: true,
  yapalim: true, yapalım: true, kaldi: true, kaldı: true,
};

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
      id: ID_PREFIX.OPEN_LOOP + (++loopId),
      type: "bugfix",
      priority: err.retryAttempted ? "high" : "normal",
      status: "open",
      summary: err.message.slice(0, TRUNC.OPEN_LOOP_SUMMARY),
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
          id: ID_PREFIX.OPEN_LOOP + (++loopId),
          type: "follow-up",
          priority: "normal",
          status: "open",
          summary: txt.slice(0, TRUNC.OPEN_LOOP_SUMMARY),
          files: [],
          sourceIndex: idx,
        });
      }
    }
  }

  // ── 3. Blocked items → blocked loops ──
  // `\bdepends?\s+on\b` instead of bare `depend`: "dependency/dependencies"
  // appears in routine package talk and was flagging ordinary messages as
  // high-priority blocked loops. Same min-length/command guard as the
  // follow-up scan above — slash commands and tiny fragments are never loops.
  const BLOCKED_RE = /\bblocked\b|waiting for|\bdepends?\s+on\b|ba[ğg]l[iı]|bekliyor|engell/i;
  for (let idx = 0; idx < msgs.length; idx++) {
    const msg = msgs[idx];
    if (msg.role !== "user") continue;
    const txt = extractText(msg.content);
    if (txt.length < 10 || txt.startsWith("/")) continue;
    if (BLOCKED_RE.test(txt)) {
      const isDup = loops.some(l => Math.abs((l.sourceIndex ?? 0) - idx) < 5);
      if (!isDup) {
        loops.push({
          id: ID_PREFIX.OPEN_LOOP + (++loopId),
          type: "blocked",
          priority: "high",
          status: "open",
          summary: txt.slice(0, TRUNC.OPEN_LOOP_SUMMARY),
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
        id: ID_PREFIX.OPEN_LOOP + (++loopId),
        type: "retry",
        priority: "high",
        status: "open",
        summary: "Retried but unresolved: " + err.message.slice(0, TRUNC.SNIPPET),
        files: [],
        sourceIndex: err.index,
      });
    }
  }
  // A follow-up is closed only by later, task-specific completion evidence in
  // the same user turn. Generic "done" text cannot retire an unrelated loop.
  for (const loop of loops) {
    if (loop.type !== "follow-up" || loop.sourceIndex == null) continue;
    const taskTokens = (loop.summary.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? [])
      .filter(token => !FOLLOWUP_TOKEN_STOP[token]);
    if (!taskTokens.length) continue;
    const end = Math.min(msgs.length, loop.sourceIndex + 50);
    for (let index = loop.sourceIndex + 1; index < end; index++) {
      const message = msgs[index];
      if (message?.role === "user") break;
      if (message?.role !== "assistant") continue;
      const response = extractText(message.content);
      const normalized = response.toLowerCase();
      if (!FOLLOWUP_COMPLETION_RE.test(response) || NEGATED_COMPLETION_RE.test(response)) continue;
      if (taskTokens.some(token => normalized.includes(token))) {
        loop.status = "resolved";
        break;
      }
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
  const tracked = trackFileOps(msgs, tcIdx);
  const allErrors = catalogErrors(msgs, tcIdx);
  const allDecisions = extractDecisions(msgs, tcIdx);
  const allConstraints = mineConstraints(msgs);
  const topics = segmentTopicsHeuristic(msgs, pc, 20, tcIdx);
  const allTimeline = buildTimeline(msgs, allErrors);
  const allMediaAttachments = extractMediaAttachments(msgs);
  const recent = <T>(items: T[], max: number): T[] => items.length > max ? items.slice(-max) : items;
  const modifiedFiles = recent(
    tracked.modified.slice().sort((a, b) => a.lastModifiedIndex - b.lastModifiedIndex),
    EXTRACTION_LIMITS.MODIFIED_FILES,
  );
  const readFiles = recent(tracked.read, EXTRACTION_LIMITS.READ_FILES);
  const deletedFiles = recent(tracked.deleted, EXTRACTION_LIMITS.DELETED_FILES);
  const errors = recent(allErrors, EXTRACTION_LIMITS.ERRORS);
  const decisions = recent(allDecisions, EXTRACTION_LIMITS.DECISIONS);
  const constraints = recent(allConstraints, EXTRACTION_LIMITS.CONSTRAINTS);
  const boundedTopics = recent(topics, EXTRACTION_LIMITS.TOPICS);
  const timeline = recent(allTimeline, EXTRACTION_LIMITS.TIMELINE);
  const mediaAttachments = recent(allMediaAttachments, EXTRACTION_LIMITS.MEDIA_ATTACHMENTS);
  const allReferencedFiles = tracked.referenced;
  const referencedFiles = recent(allReferencedFiles, EXTRACTION_LIMITS.REFERENCED_FILES);
  const overflow = {
    modifiedFiles: tracked.modified.length - modifiedFiles.length,
    referencedFiles: allReferencedFiles.length - referencedFiles.length,
    readFiles: tracked.read.length - readFiles.length,
    deletedFiles: tracked.deleted.length - deletedFiles.length,
    errors: allErrors.length - errors.length,
    decisions: allDecisions.length - decisions.length,
    constraints: allConstraints.length - constraints.length,
    topics: topics.length - boundedTopics.length,
    timeline: allTimeline.length - timeline.length,
    mediaAttachments: allMediaAttachments.length - mediaAttachments.length,
  };
  const evidenceOverflow = Object.fromEntries(
    Object.entries(overflow).filter(([, count]) => count > 0),
  );
  const mainGoal = extractMainGoal(msgs);
  const lastUserMessages = msgs.filter(m => m.role === "user").slice(-5).map(m => extractText(m.content));
  const lastErrors = errors.slice(-3).map(e => e.message);
  return {
    modifiedFiles, readFiles, deletedFiles, referencedFiles,
    errors, decisions, constraints, topics: boundedTopics, timeline, mediaAttachments,
    mainGoal, lastUserMessages, lastErrors, messageCount: msgs.length,
    ...(Object.keys(evidenceOverflow).length ? { evidenceOverflow } : {}),
  };
}
