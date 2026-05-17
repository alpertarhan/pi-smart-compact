/**
 * Phase 1: Deterministic extraction — zero LLM calls.
 */

import path from "node:path";
import type { LlmMessage, ProfileConfig, StructuredExtraction, ToolCallBlock, OpenLoop } from "../types.ts";
import { NO_OP_RE, SHIFT_RE, CHOICE_RE } from "../constants.ts";
import { estimateTokens } from "./tokens.ts";
import { isToolCallBlock } from "../types.ts";

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: unknown) => {
    if (typeof b === "string") return b;
    if ((b as Record<string, unknown>)?.type === "text") return (b as { text?: string }).text ?? "";
    return "";
  }).join("");
  return "";
}

export function buildToolCallIndex(msgs: LlmMessage[]): Map<string, { name: string; arguments: Record<string, unknown>; msgIndex: number }> {
  const idx = new Map<string, { name: string; arguments: Record<string, unknown>; msgIndex: number }>();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (isToolCallBlock(b) && b.id) {
        idx.set(b.id, { name: b.name, arguments: b.arguments, msgIndex: i });
      }
    }
  }
  return idx;
}

export function trackFileOps(msgs: LlmMessage[]): { modified: StructuredExtraction["modifiedFiles"]; read: string[]; deleted: string[] } {
  const tcIdx = buildToolCallIndex(msgs);
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

    if (tool.includes("write") || tool.includes("edit")) {
      const resultText = extractText(m.content);
      if (!NO_OP_RE.test(resultText)) {
        const existing = modMap.get(filePath);
        modMap.set(filePath, { toolCalls: (existing?.toolCalls ?? 0) + 1, lastIdx: i });
      }
    } else if (tool.includes("delete") || tool.includes("remove")) {
      delSet.add(filePath);
    } else if (tool.includes("read")) {
      readSet.add(filePath);
    }
  }

  return {
    modified: [...modMap.entries()].map(([p, d]) => ({ path: p, toolCalls: d.toolCalls, lastModifiedIndex: d.lastIdx })),
    read: [...readSet], deleted: [...delSet],
  };
}

export function catalogErrors(msgs: LlmMessage[]): StructuredExtraction["errors"] {
  const tcIdx = buildToolCallIndex(msgs);
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
      const isLikelyError = /(?:command not found|no such file|permission denied|syntax error|cannot find|module not found|compilation error|build failed|test failed)/i.test(txt);
      if (isLikelyError && txt.length < 2000) {
        errors.push({ index: i, tool: "bash", message: txt.slice(0, 300), retryAttempted: false, resolved: false });
      }
    }
  }

  for (const err of errors) {
    for (let j = err.index + 1; j < Math.min(msgs.length, err.index + 6); j++) {
      if (msgs[j]?.role === "assistant") {
        const blocks = Array.isArray(msgs[j]?.content) ? msgs[j].content : [];
        for (const b of blocks) {
          if (isToolCallBlock(b) && b.name === err.tool) {
            err.retryAttempted = true;
            for (let k = j + 1; k < Math.min(msgs.length, j + 10); k++) {
              if (msgs[k]?.role === "toolResult" && msgs[k]?.toolCallId === b.id && !msgs[k]?.isError) {
                err.resolved = true; break;
              }
            }
            break;
          }
        }
        if (err.retryAttempted) break;
      }
    }
  }
  return errors;
}

export function extractDecisions(msgs: LlmMessage[]): StructuredExtraction["decisions"] {
  const tcIdx = buildToolCallIndex(msgs);
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

export function segmentTopicsHeuristic(msgs: LlmMessage[], pc: ProfileConfig, maxSegs = 20): StructuredExtraction["topics"] {
  const topics: StructuredExtraction["topics"] = [];
  let startIdx = 0, tokenAcc = 0, lastFile: string | null = null, errAcc = 0;
  const tcIdx = buildToolCallIndex(msgs);

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
        if (isToolCallBlock(b)) {
          const fp = (b.arguments?.path ?? b.arguments?.file_path) as string | undefined;
          if (fp) {
            const fn = path.basename(fp);
            if (lastFile && fn !== lastFile && tokenAcc > pc.minChunkTokens) brk = true;
            lastFile = fn;
            primaryFile = fp;
            if (b.name?.includes("write") || b.name?.includes("edit")) type = "implementation";
            else if (b.name?.includes("read")) type = "review";
          }
        }
      }
    }
    if (m.role === "toolResult" && m.isError) { errAcc++; type = "debugging"; }
    if (m.role === "toolResult" && !m.isError) {
      const tc = tcIdx.get(m.toolCallId ?? "");
      if (tc?.name === "bash" && /error|fail/i.test(txt)) { errAcc++; type = "debugging"; }
    }
    if (m.role === "user" && SHIFT_RE.test(txt) && tokenAcc > pc.minChunkTokens) brk = true;
    if (tokenAcc >= pc.maxChunkTokens) brk = true;

    if (brk && i > startIdx && topics.length < maxSegs - 1) {
      topics.push({ startIndex: startIdx, endIndex: i, primaryFile, type, errorDensity: errAcc });
      startIdx = i + 1; tokenAcc = 0; lastFile = null; errAcc = 0;
    }
  }
  if (startIdx < msgs.length) {
    topics.push({ startIndex: startIdx, endIndex: msgs.length - 1, primaryFile: null, type: "exploration", errorDensity: errAcc });
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
  for (const err of extraction.errors.filter(e => !e.resolved)) {
    const errFiles = extraction.modifiedFiles
      .filter(f => err.message.toLowerCase().includes(f.path.split("/").pop()?.toLowerCase() ?? "__none__"))
      .map(f => f.path);
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
  const FOLLOWUP_RE = /(?:next\s+(?:step|thing)|todo|action item|follow\s*up|still (?:need|have) to|gotta|gotta|yapalim|yapmamiz|gerekiyor|eklenecek|düzeltilecek|bitmedi|kaldi)/i;
  for (const msg of msgs) {
    if (msg.role !== "user") continue;
    const txt = extractText(msg.content);
    if (txt.length < 10 || txt.startsWith("/")) continue;
    if (FOLLOWUP_RE.test(txt)) {
      const idx = msgs.indexOf(msg);
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
  for (const msg of msgs) {
    if (msg.role !== "user") continue;
    const txt = extractText(msg.content);
    if (BLOCKED_RE.test(txt)) {
      const idx = msgs.indexOf(msg);
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

export function extractStructured(msgs: LlmMessage[], pc: ProfileConfig): StructuredExtraction {
  const { modified, read, deleted } = trackFileOps(msgs);
  const errors = catalogErrors(msgs);
  const decisions = extractDecisions(msgs);
  const constraints = mineConstraints(msgs);
  const topics = segmentTopicsHeuristic(msgs, pc);
  const timeline = buildTimeline(msgs, errors);
  const mainGoal = extractMainGoal(msgs);
  const lastUserMessages = msgs.filter(m => m.role === "user").slice(-5).map(m => extractText(m.content));
  const lastErrors = errors.slice(-3).map(e => e.message);
  return {
    modifiedFiles: modified, readFiles: read, deletedFiles: deleted,
    errors, decisions, constraints, topics, timeline,
    mainGoal, lastUserMessages, lastErrors, messageCount: msgs.length,
  };
}
