/** Paired coding-task / continuation+memory evaluation case.
 *
 * Fixtures, scripted frames, and independent behavioral oracles shared by the
 * offline lifecycle runner and the opt-in live semantic run
 * (scripts/task-eval.ts). Oracles check files, a real test process, error and
 * constraint survival, side effects, temporal decision ordering, abstention,
 * archive retrieval, and memory refs — never summary prose substrings.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import type {
 AssistantMessage,
 Message,
 ToolCall,
 TranscriptContext,
} from "@earendil-works/pi-ai";
import { parseMemoryRef } from "../src/infra/memory-ref.ts";

// ── Task facts (needles) ────────────────────────────────────────────────────

export const FACTS = {
 constraint: "NEVER_DROP_AUTH_CHECKS",
 forbiddenPath: "prod.config.json",
 failure: "EVAL_FAILURE_TOKEN_X21",
 oldDecision: "DECISION_V1_FILE_STORE",
 newDecision: "DECISION_V2_IN_MEMORY",
 fileFact: "FILE_NEEDLE_7F3A",
 grepFact: "GREP_NEEDLE_91C4",
 archiveFact: "ARCHIVE_NEEDLE_5D2E",
 archiveValue: "archive-auth-vector-2209",
 memoryFact: "MEMORY_NEEDLE_3B8C",
 memoryRationale:
  "In-memory store avoids the disk dependency; superseded the file store.",
 sideEffect: "SIDE_EFFECT_PRESERVED",
 unknownKey: "DEPLOY_REGION",
 premiseKey: "FIXED_CACHE_CLAIM",
 premiseBait: "eu-central",
} as const;

/** Values the continuation must write; short forms avoid self-echo collisions. */
export const DECISION_CODES = { new: "v2", old: "v1", unknown: "unknown" } as const;

export function continuationPaths(probe: string | number): Record<string, string> {
 return {
  storeChoice: `notes/continuation-store-choice-${probe}.txt`,
  answers: `notes/continuation-answers-${probe}.txt`,
  archive: `notes/continuation-archive-${probe}.txt`,
  memory: `notes/continuation-memory-${probe}.txt`,
 };
}

// ── Arms ────────────────────────────────────────────────────────────────────

export const ARMS = [
 "no-compaction",
 "recoverable-hygiene",
 "eesv",
 "hybrid",
] as const;
export type ArmId = (typeof ARMS)[number];

/** The only knobs that differ between arms; everything else is matched.
 *
 * Overlays (offline cost-accounting fixtures only, never live mode):
 * - backgroundPrep turns the opt-in speculative-preparation strategy on. The
 *   apply gate stays shared with agent-tool staging by design, so the overlay
 *   keeps each arm's staging behavior intact: arms that stage compactions via
 *   the smart_compact tool keep a reachable gate (the settled auto-trigger may
 *   consume one prepared candidate as a "used" receipt), while arms that never
 *   stage get an unreachable gate so preparation is provably unused there.
 * - warm gates are separate (runner-side model fixtures). */
export function armSmartCompactSettings(
 arm: ArmId,
 overlays?: { backgroundPrep?: boolean; toolLoading?: "eager" | "lazy" },
): Record<string, unknown> {
 const hygiene = arm === "recoverable-hygiene" || arm === "hybrid";
 const stages = arm === "eesv" || arm === "hybrid";
 const base = {
  // Matched across strategy arms; the CLI can compare exposure modes separately.
  toolLoading: overlays?.toolLoading ?? "eager",
  autoTrigger: false,
  contextHygieneEnabled: hygiene,
  artifactOffloadEnabled: hygiene,
  minContextPercent: 0,
  mode: "fast",
  backupEnabled: false,
  contextGraphEnabled: true,
  requireApproval: false,
  zeroCallEnabled: false,
  summaryModel: "task-eval-offline/summary",
  profiles: {
   aggressive: {
    keepRecentTokens: 6_000,
    summaryBudgetTokens: 2_000,
    singlePassMaxTokens: 100_000,
   },
  },
 };
 if (!overlays?.backgroundPrep) return base;
 // Applied last so the overlay's gate wins over the base key above.
 return {
  ...base,
  autoTrigger: true,
  autoTriggerStrategy: "background",
  // 200k-token fixture window: staging arms apply at 50k tokens
  // (prepare window 40k–50k); non-staging arms keep the gate at
  // 190k tokens so nothing is ever applied from preparation there.
  minContextPercent: stages ? 25 : 95,
  prepareContextPercent: stages ? 20 : 25,
 };
}

// ── Matched initial filesystem state ────────────────────────────────────────

const SOURCE_ROWS = 1_500;
const GREP_ROWS = 1_000;
const filler = (prefix: string, count: number) =>
 Array.from(
  { length: count },
  (_, i) => `${prefix}: ordinary row ${i}, no action required.`,
 ).join("\n");

export function writeProjectFiles(cwd: string): string[] {
 const written: string[] = [];
 const put = (rel: string, content: string) => {
  fs.writeFileSync(`${cwd}/${rel}`, content);
  written.push(rel);
 };
 fs.mkdirSync(`${cwd}/notes`, { recursive: true });
 fs.mkdirSync(`${cwd}/src`, { recursive: true });
 fs.mkdirSync(`${cwd}/test`, { recursive: true });

 put(
  "AGENTS.md",
  `Project constraint: ${FACTS.constraint}. Authentication checks must never be removed.\n` +
  filler("policy", 500) +
  "\n",
 );
 put(
  "package.json",
  JSON.stringify(
   {
    name: "eval-widget",
    private: true,
    scripts: { test: "node test/run.test.js" },
   },
   null,
   2,
  ) + "\n",
 );
 put(
  "src/store.js",
  `// ${FACTS.oldDecision}: file-backed store (initial state; superseded later in the session).\n` +
  `class FileStore {\n\tconstructor(dir) { this.dir = dir; }\n\twrite(key, value) { require("node:fs").writeFileSync(this.dir + "/" + key, String(value)); }\n\tread(key) { return require("node:fs").readFileSync(this.dir + "/" + key, "utf8"); }\n}\nmodule.exports = { FileStore };\n`,
 );
 put(
  "src/server.js",
  `// ${FACTS.constraint}: authentication guards every mutation.\n` +
  `function assertAuthenticated(user) { if (!user || !user.token) throw new Error("unauthenticated"); }\n` +
  `function createServer(store, user) { return { save: (k, v) => { assertAuthenticated(user); store.write(k, v); }, load: (k) => { assertAuthenticated(user); return store.read(k); } }; }\n` +
  `module.exports = { assertAuthenticated, createServer };\n`,
 );
 put(
  "test/run.test.js",
  `const failures = [];\n` +
  `// Real consumer: src/server.js drives whichever store src/store.js exports.\n` +
  `const storeModule = require("../src/store.js");\n` +
  `const server = require("../src/server.js");\n` +
  `if (typeof storeModule.InMemoryStore !== "function")\n` +
  `\tfailures.push("the current in-memory store is not implemented (stale or unknown decision)");\n` +
  `else {\n` +
  `\tconst store = new storeModule.InMemoryStore();\n` +
  `\tstore.write("k", "v");\n` +
  `\tif (store.read("k") !== "v") failures.push("in-memory roundtrip broken");\n` +
  `\tconst svc = server.createServer(store, { token: "t" });\n` +
  `\tsvc.save("k2", "v2");\n` +
  `\tif (svc.load("k2") !== "v2") failures.push("server roundtrip broken");\n` +
  `\tlet denied = false;\n` +
  `\ttry { server.createServer(store, {}).load("k"); } catch { denied = true; }\n` +
  `\tif (!denied) failures.push("unauthenticated access was not rejected (auth guard missing)");\n` +
  `}\n` +
  `if (failures.length) { console.log("TEST-ORACLE FAIL: " + failures.join("; ")); process.exit(1); }\n` +
  `console.log("TEST-ORACLE PASS");\n`,
 );
 put(
  "notes/source.txt",
  filler("evidence", SOURCE_ROWS).replace(
   /^evidence: ordinary row 750,.*$/m,
   `evidence: ${FACTS.fileFact} marks the required middle line.`,
  ) + "\n",
 );
 put(
  "notes/grep.txt",
  filler("evidence", GREP_ROWS)
   .replace(
    /^evidence: ordinary row 500,.*$/m,
    `evidence: ${FACTS.grepFact} required match.`,
   )
   .replace(
    /^evidence: ordinary row 700,.*$/m,
    `evidence: ${FACTS.archiveFact}=${FACTS.archiveValue} archive-only detail.`,
   ) + "\n",
 );
 return written;
}

// ── Frame plumbing (offline scripted transport) ─────────────────────────────

let serial = 0;

export const text = (messages: readonly Message[]) =>
 JSON.stringify(
  messages.map((message) => ({
   role: message.role,
   content: message.content,
  })),
 );

export function tool(context: TranscriptContext, name: string) {
 const result = context.messages.findLast(
  (message) => message.role === "toolResult" && message.toolName === name,
 );
 assert(result?.role === "toolResult", `No ${name} result in task-eval frame`);
 return result;
}

export const toolText = (context: TranscriptContext, name: string) =>
 tool(context, name).content.flatMap((block) =>
  block.type === "text" ? [block.text] : [],
 ).join("\n");

export function detailString(
 details: unknown,
 key: string,
): string | undefined {
 if (typeof details !== "object" || details === null) return undefined;
 const value = (details as Record<string, unknown>)[key];
 return typeof value === "string" ? value : undefined;
}

export const call = (
 name: string,
 args: ToolCall["arguments"],
): ToolCall => ({
 type: "toolCall",
 id: "task-eval-" + serial++,
 name,
 arguments: args,
});

export const answer = (
 value = "Offline step complete.",
): AssistantMessage["content"] => [{ type: "text", text: value }];

export function assertPairedBatch(context: TranscriptContext): void {
 const calls = new Set<string>();
 const results = new Set<string>();
 for (const message of context.messages) {
  if (message.role === "assistant")
   for (const block of message.content)
    if (block.type === "toolCall") calls.add(block.id);
  if (message.role === "toolResult") {
   assert(calls.has(message.toolCallId), "Orphan result sent to provider");
   assert(
    !results.has(message.toolCallId),
    "Duplicate result sent to provider",
   );
   results.add(message.toolCallId);
  }
 }
 assert.deepEqual(
  [...calls].sort(),
  [...results].sort(),
  "Incomplete tool batch sent to provider",
 );
}

// ── Capture: what the scripted continuation observed ────────────────────────

export interface ProbeRecord {
 probe: string;
 afterCompaction: number;
 deliveredChars: number;
 contextHas: {
  constraint: boolean;
  failure: boolean;
  newDecision: boolean;
  oldDecision: boolean;
  archiveFact: boolean;
  regionClaim: boolean;
  cacheFixClaim: boolean;
 };
 currentDecision: "new" | "old" | "unknown";
 unknownAnswer: string;
 premiseAnswer: string;
 archiveAnswer: string;
 archiveSource: "context" | "retrieval" | "disk-reread" | "none";
 archiveRetrievalUsed: boolean;
 memoryRef: string | null;
 memoryRecallHit: boolean;
}

export interface Capture {
 artifactRef: string;
 grepPreviewHadFacts: boolean;
 fileFactSeen: boolean;
 constraintSeen: boolean;
 failureIsError: boolean;
 writtenPaths: string[];
 memorySavedRef: string | null;
 memorySaveApproved: boolean;
 probes: ProbeRecord[];
 stagedRuns: string[];
 appliedRuns: string[];
 summaryRequests: number;
 mainRequests: number;
}

export function createCapture(): Capture {
 return {
  artifactRef: "",
  grepPreviewHadFacts: false,
  fileFactSeen: false,
  constraintSeen: false,
  failureIsError: false,
  writtenPaths: [],
  memorySavedRef: null,
  memorySaveApproved: false,
  probes: [],
  stagedRuns: [],
  appliedRuns: [],
  summaryRequests: 0,
  mainRequests: 0,
 };
}

const REGION_CLAIM_RE = new RegExp(`${FACTS.unknownKey}=(?!UNKNOWN\\b)\\S+`);
const CACHE_FIX_CLAIM_RE =
 /src\/cache\.js[^\n]{0,120}(?:fixed|resolved)|(?:fixed|resolved)[^\n]{0,40}src\/cache\.js|cache[^\n]{0,50}bug[^\n]{0,50}(?:fixed|resolved)/i;

/** Shared presence detection: offline frames and the live branch recorder
 * must classify delivered context identically. */
export function contextPresence(delivered: string): ProbeRecord["contextHas"] {
 return {
  constraint: delivered.includes(FACTS.constraint),
  failure: delivered.includes(FACTS.failure),
  newDecision: delivered.includes(FACTS.newDecision),
  oldDecision: delivered.includes(FACTS.oldDecision),
  archiveFact: delivered.includes(FACTS.archiveValue),
  regionClaim: REGION_CLAIM_RE.test(delivered),
  cacheFixClaim: CACHE_FIX_CLAIM_RE.test(delivered),
 };
}

export function decisionFromCode(code: string): "new" | "old" | "unknown" {
 if (code === DECISION_CODES.new) return "new";
 if (code === DECISION_CODES.old) return "old";
 return "unknown";
}

const observeInto = (record: ProbeRecord, delivered: string): void => {
 record.deliveredChars = delivered.length;
 record.contextHas = contextPresence(delivered);
 record.currentDecision = currentDecisionFrom(delivered);
};

const writeCall = (path: string, content: string) =>
 call("write", { path, content: content.endsWith("\n") ? content : content + "\n" });

const currentDecisionFrom = (delivered: string): "new" | "old" | "unknown" => {
 if (delivered.includes(FACTS.newDecision)) return "new";
 if (delivered.includes(FACTS.oldDecision)) return "old";
 return "unknown";
};

// ── Scripted frames per phase ───────────────────────────────────────────────

export type Frame = (context: TranscriptContext) => AssistantMessage["content"];

export const historyAck: Frame = () => answer("Observation recorded.");

export function evidenceFrames(capture: Capture): Frame[] {
 return [
  () => [call("read", { path: "notes/source.txt" })],
  (context) => {
   assert(
    toolText(context, "read").includes(FACTS.fileFact),
    "read tool lost the required middle line",
   );
   capture.fileFactSeen = true;
   return [
    call("grep", {
     path: "notes/grep.txt",
     pattern: "evidence",
     limit: GREP_ROWS,
    }),
   ];
  },
  (context) => {
   const preview = toolText(context, "grep");
   capture.grepPreviewHadFacts =
    preview.includes(FACTS.grepFact) || preview.includes(FACTS.archiveFact);
   capture.artifactRef = /artifact-[a-f0-9]{64}/.exec(preview)?.[0] ?? "";
   return [call("read", { path: "AGENTS.md" })];
  },
  (context) => {
   assert(
    toolText(context, "read").includes(FACTS.constraint),
    "AGENTS.md constraint missing",
   );
   capture.constraintSeen = true;
   return [call("bash", { command: `printf '${FACTS.failure}\\n' >&2; exit 7` })];
  },
  (context) => {
   capture.failureIsError = tool(context, "bash").isError === true;
   return [call("smart_context", { action: "status", limit: 8 })];
  },
  () => answer("Evidence collected."),
 ];
}

export const decisionOldPrompt = `Decision (early): ${FACTS.oldDecision} — keep the file-backed store for now. Acknowledge only.`;
export const decisionNewPrompt = `Decision update: ${FACTS.newDecision} — replace the file store with an in-memory store. This supersedes ${FACTS.oldDecision}. Acknowledge only.`;

// src/server.js is the fixed real consumer; the store only implements storage.
const STORE_SOURCES: Record<"new" | "old" | "unknown", string> = {
 new:
  `// ${FACTS.newDecision}: in-memory store (supersedes ${FACTS.oldDecision}).\n` +
  `class InMemoryStore {\n\tconstructor() { this.data = new Map(); }\n\twrite(key, value) { this.data.set(key, String(value)); }\n\tread(key) { const v = this.data.get(key); if (v === undefined) throw new Error("missing key"); return v; }\n}\n` +
  `module.exports = { InMemoryStore };\n`,
 old:
  `// ${FACTS.oldDecision}: file-backed store kept as decided.\n` +
  `class FileStore {\n\tconstructor(dir) { this.dir = dir; }\n\twrite(key, value) { require("node:fs").writeFileSync(this.dir + "/" + key, String(value)); }\n\tread(key) { return require("node:fs").readFileSync(this.dir + "/" + key, "utf8"); }\n}\n` +
  `module.exports = { FileStore };\n`,
 unknown: `// No storage decision is visible in the delivered context.\nmodule.exports = {};\n`,
};

export function implementFrames(capture: Capture): Frame[] {
 const record = (path: string) => {
  if (!capture.writtenPaths.includes(path)) capture.writtenPaths.push(path);
 };
 return [
  () => [call("bash", { command: "node test/run.test.js" })],
  (context) => {
   const decision = currentDecisionFrom(text(context.messages));
   record("src/store.js");
   return [writeCall("src/store.js", STORE_SOURCES[decision])];
  },
  () => {
   capture.writtenPaths.push("side-effect.txt");
   return [writeCall("side-effect.txt", FACTS.sideEffect + "\n")];
  },
  () => [call("bash", { command: "node test/run.test.js" })],
  () => answer("Implementation recorded."),
 ];
}

/** Recall evidence from the actual smart_recall tool output: the saved fact
 * must be present AND the rendered ref must parse and, when the save ref is
 * known, identify the same memory. An unrelated-but-valid ref is not a hit. */
export function recallEvidence(
 recallText: string,
 savedRef: string | null,
): { hit: boolean; ref: string | null } {
 const ref = /^Ref: (\S+)$/m.exec(recallText)?.[1] ?? null;
 const parsed = ref === null ? null : parseMemoryRef(ref);
 const hit =
  recallText.includes(FACTS.memoryFact) &&
  parsed !== null &&
  (savedRef === null || ref === savedRef);
 return { hit, ref: parsed === null ? null : ref };
}

export function memorySaveFrames(capture: Capture): Frame[] {
 return [
  () => [
   call("smart_save_memory", {
    kind: "decision",
    content: `${FACTS.memoryFact}: ${FACTS.newDecision} in-memory store. ${FACTS.memoryRationale}`,
    related_paths: ["src/store.js"],
   }),
  ],
  (context) => {
   const output = toolText(context, "smart_save_memory");
   const ref =
    detailString(tool(context, "smart_save_memory").details, "ref") ??
    /\(ref ([^\s)]+)\)/.exec(output)?.[1] ??
    "";
   capture.memorySavedRef = parseMemoryRef(ref) ? ref : null;
   capture.memorySaveApproved = !/not (?:changed|approve)/i.test(output);
   return answer("Memory saved.");
  },
 ];
}

export function smartCompactFrames(capture: Capture): Frame[] {
 return [
  () => [call("smart_compact", { mode: "fast" })],
  (context) => {
   const runId = detailString(
    tool(context, "smart_compact").details,
    "runId",
   );
   if (runId) capture.stagedRuns.push(runId);
   else
    assert(
     !toolText(context, "smart_compact").includes("staged, not applied"),
     "staged run missing runId",
    );
   return answer("Compaction staged.");
  },
 ];
}

/** One real long tool run per arm: the host cache-warmer's streaming trigger.
 * The warmer exists precisely for long tool runs; this fixture creates one
 * instead of mocking the timer, so the warm request is a real SDK replay. */
export function longToolRunFrames(command: string): Frame[] {
 return [
  () => [call("bash", { command })],
  () => answer("Long tool run recorded."),
 ];
}



export function probeFrames(
 capture: Capture,
 probe: string,
 afterCompaction: number,
 memoryAvailable: boolean,
): Frame[] {
 const paths = continuationPaths(probe);
 const record: ProbeRecord = {
  probe,
  afterCompaction,
  deliveredChars: 0,
  contextHas: {
   constraint: false,
   failure: false,
   newDecision: false,
   oldDecision: false,
   archiveFact: false,
   regionClaim: false,
   cacheFixClaim: false,
  },
  currentDecision: "unknown",
  unknownAnswer: "",
  premiseAnswer: "",
  archiveAnswer: "",
  archiveSource: "none",
  archiveRetrievalUsed: false,
  memoryRef: null,
  memoryRecallHit: false,
 };
 capture.probes.push(record);
 const observe = (context: TranscriptContext) => observeInto(record, text(context.messages));
 const frames: Frame[] = [
  (context) => {
   observe(context);
   return [
    writeCall(
     paths.storeChoice,
     `CURRENT_DECISION=${DECISION_CODES[record.currentDecision]}\n`,
    ),
   ];
  },
  (context) => {
   observe(context);
   record.unknownAnswer = record.contextHas.regionClaim
    ? "CONTEXT_CLAIMED"
    : "UNKNOWN";
   record.premiseAnswer = record.contextHas.cacheFixClaim
    ? "CONFIRMED"
    : "PREMISE_FALSE";
   return [
    writeCall(
     paths.answers,
     `${FACTS.unknownKey}=${record.unknownAnswer}\n${FACTS.premiseKey}=${record.premiseAnswer}\n`,
    ),
   ];
  },
 ];
 if (memoryAvailable) {
  frames.push(
   () => [call("smart_recall", { query: "storage decision" })],
   (context) => {
    const evidence = recallEvidence(
     toolText(context, "smart_recall"),
     capture.memorySavedRef,
    );
    record.memoryRecallHit = evidence.hit;
    record.memoryRef = evidence.ref;
    return [writeCall(paths.memory, `MEMORY_REF=${record.memoryRef ?? "NONE"}\n`)];
   },
  );
 }
 // Keep the turn structure identical on every route: a context hit parks the
 // remaining archive frames through a benign bash round-trip instead of
 // skipping frames (a skipped frame would desynchronize the script).
 const park = (): AssistantMessage["content"] => [call("bash", { command: "true" })];
 frames.push(
  (context) => {
   observe(context);
   if (record.contextHas.archiveFact) {
    record.archiveAnswer = FACTS.archiveValue;
    record.archiveSource = "context";
    return [writeCall(paths.archive, `ARCHIVE=${record.archiveAnswer}\n`), call("bash", { command: "true" })];
   }
   return [call("smart_context", { action: "search", query: FACTS.archiveFact })];
  },
  (context) => {
   if (record.archiveSource === "context") {
    assert(!tool(context, "bash").isError, "park round-trip failed");
    return park();
   }
   const raw = toolText(context, "smart_context");
   let parsed: { matches?: Array<{ id: string; line: number }> };
   try {
    parsed = JSON.parse(raw.replace(/^Historical[^\n]*\n/, "")) as {
     matches?: Array<{ id: string; line: number }>;
    };
   } catch (cause) {
    throw new Error("smart_context search returned unparseable output: " + raw.slice(0, 200), {
     cause,
    });
   }
   const hit = parsed.matches?.[0];
   if (hit) {
    record.archiveRetrievalUsed = true;
    return [
     call("smart_context", {
      action: "read",
      id: hit.id,
      line: hit.line,
      limit: 1,
     }),
    ];
   }
   // No archived copy exists (no offload, or compaction removed the
   // reference): a capable continuation re-runs the search on disk.
   return [
    call("bash", {
     command: `grep -e '${FACTS.archiveFact}' notes/grep.txt || true`,
    }),
   ];
  },
  (context) => {
   if (record.archiveSource === "context") {
    assert(!tool(context, "bash").isError, "park round-trip failed");
    return park();
   }
   const lastOutput = record.archiveRetrievalUsed
    ? toolText(context, "smart_context")
    : toolText(context, "bash");
   const found = new RegExp(`${FACTS.archiveFact}=([\\w-]+)`).exec(lastOutput)?.[1];
   record.archiveAnswer = found ?? "UNKNOWN";
   record.archiveSource = found
    ? record.archiveRetrievalUsed
     ? "retrieval"
     : "disk-reread"
    : "none";
   return [writeCall(paths.archive, `ARCHIVE=${record.archiveAnswer}\n`)];
  },
  () => answer("Continuation probe complete."),
 );
 return frames;
}

export const genericProbePrompt =
 "Run the continuation probe for this checkpoint now.";

export function reopenFrames(): Frame[] {
 return [
  (context) => {
   const constraintInContext = text(context.messages).includes(FACTS.constraint);
   return constraintInContext
    ? [call("smart_context", { action: "status", limit: 4 })]
    : [call("smart_context", { action: "search", query: FACTS.constraint })];
  },
  (context) => {
   const output = toolText(context, "smart_context");
   assert(
    text(context.messages).includes(FACTS.constraint) ||
    output.includes(FACTS.constraint),
    "Constraint neither delivered nor retrievable after reopen",
   );
   return [call("bash", { command: "node test/run.test.js" })];
  },
  (context) => {
   assert(
    toolText(context, "bash").includes("TEST-ORACLE PASS"),
    "Independent test oracle failed after reopen",
   );
   return answer("Reopened context continues with verified evidence.");
  },
 ];
}

// ── Scripted faithful summarizer (offline transport stand-in, labelled) ─────

export function scriptedSummary(input: string, capture: Capture): string {
 const decisions = [
  ...input.matchAll(/Decision[^:\n]*:\s*(DECISION_V[0-9A-Z_]+)/g),
 ].map((found) => found[1]);
 const current = decisions.includes(FACTS.newDecision)
  ? FACTS.newDecision
  : decisions.at(-1);
 // Verification compares Files Modified against deterministic extraction of
 // write calls, so every recorded write (including probe files) is listed.
 const modified = [...capture.writtenPaths];
 // The memory needle appears only when the input actually carried it; a
 // pre-save compaction must not manufacture memory it never saw.
 const memoryLine = input.includes(FACTS.memoryFact)
  ? `- ${FACTS.memoryFact}: ${FACTS.newDecision} in-memory store.\n`
  : "";
 return `## Goal
Deliver the eval-widget storage change with session continuity.
## Constraints & Preferences
- ${FACTS.constraint}: authentication checks must never be removed; never create ${FACTS.forbiddenPath}.
## Progress
### Done
- [x] Implemented the current storage decision and preserved the side effect.
### In Progress
- [ ] Continue after compaction with verified evidence.
### Blocked
- ${FACTS.failure} is unresolved.
## Key Decisions
- ${current ?? "no storage decision recorded"}${current === FACTS.newDecision ? ` (supersedes ${FACTS.oldDecision})` : ""}
## Files Modified
${modified.length ? modified.map((rel) => "- " + rel).join("\n") : "- None."}
## Files Deleted
- None.
## Files Read
- AGENTS.md
- notes/source.txt
- notes/grep.txt
## Next Steps
1. Answer the continuation probes from context or archived evidence.
## Critical Context
- ${FACTS.constraint}
- ${FACTS.failure}
${memoryLine}## Topics Covered
- [critical] Storage decision and continuity.
`;
}

// ── Observed state + independent oracles ────────────────────────────────────

export interface TestRun {
 code: number;
 stdout: string;
}

export interface ReceiptSummary {
 runId: string;
 status?: string;
 preparation?: string;
 preparationDiscardReason?: string;
}

export interface Observed {
 arm: ArmId;
 repeats: number;
 files: Record<string, string>;
 forbiddenFileExists: boolean;
 testRun: TestRun;
 midTaskTestRun: TestRun | null;
 /** Real module execution of src/store.js: the current decision is proven
  * by loading the module, not by reading its source text. */
 storeModuleExec: { exportsInMemory: boolean; roundtripOk: boolean };
 retrieval: {
  smartContextSearch: number;
  smartContextRead: number;
  smartRecall: number;
 };
 compactions: {
  staged: number;
  applied: number;
  receipts: ReceiptSummary[];
 };
 memoryToolAvailable: boolean;
 capture: Capture;
 policy: {
  minAutoTrimSavingChars: number;
  autoTrimCooldownTurns: number;
  pendingTtlMs: number;
  settledCooldownMs: number;
  keepRecentTokens: number;
 };
}

export interface OracleResult {
 id: string;
 label: string;
 checkClass:
 | "file"
 | "test"
 | "error"
 | "constraint"
 | "side-effect"
 | "temporal"
 | "abstention"
 | "archive"
 | "memory"
 | "lifecycle";
 pass: boolean;
 detail: string;
}

const check = (
 id: string,
 label: string,
 checkClass: OracleResult["checkClass"],
 pass: boolean,
 detail: string,
): OracleResult => ({ id, label, checkClass, pass, detail });

/** Independent checks on final state. Arm-conditional expectations are explicit. */
export function applyOracles(observed: Observed): OracleResult[] {
 const { arm, files, capture } = observed;
 const storeExec = observed.storeModuleExec;
 const sideEffect = files["side-effect.txt"];
 const probes = capture.probes;
 const receiptsDetail = observed.compactions.receipts
  .map((r) => `${r.runId}:${r.status ?? "?"}`)
  .join(",");

 const checks: OracleResult[] = [
  check(
   "file-current-decision",
   "src/store.js, executed as a module, provides the newest in-memory store",
   "file",
   storeExec.exportsInMemory && storeExec.roundtripOk,
   `exportsInMemory=${storeExec.exportsInMemory} roundtripOk=${storeExec.roundtripOk}`,
  ),
  check(
   "file-forbidden-absent",
   `forbidden ${FACTS.forbiddenPath} never created`,
   "file",
   !observed.forbiddenFileExists && !(FACTS.forbiddenPath in files),
   observed.forbiddenFileExists ? "forbidden file exists on disk" : "absent",
  ),
  check(
   "test-oracle",
   "independent test process passes",
   "test",
   observed.testRun.code === 0 &&
   observed.testRun.stdout.includes("TEST-ORACLE PASS"),
   `exit=${observed.testRun.code} stdout=${observed.testRun.stdout.trim().slice(0, 120)}`,
  ),
  check(
   "error-preserved",
   "unresolved failure token survived to a probe",
   "error",
   capture.failureIsError && probes.some((p) => p.contextHas.failure),
   `toolError=${capture.failureIsError} visibleAtProbe=${probes.some((p) => p.contextHas.failure)}`,
  ),
  check(
   "constraint-preserved",
   "constraint survived to a probe",
   "constraint",
   capture.constraintSeen && probes.some((p) => p.contextHas.constraint),
   `seenInitially=${capture.constraintSeen} visibleAtProbe=${probes.some((p) => p.contextHas.constraint)}`,
  ),
  check(
   "side-effect-preserved",
   "side-effect.txt byte-identical after trims/compaction/reopen",
   "side-effect",
   sideEffect === FACTS.sideEffect + "\n",
   `content=${JSON.stringify(sideEffect ?? null)}`,
  ),
 ];
 for (const probe of probes) {
  checks.push(
   check(
    `temporal-${probe.probe}`,
    `${probe.probe}: newest decision delivered`,
    "temporal",
    probe.currentDecision === "new",
    `currentDecision=${probe.currentDecision} newInContext=${probe.contextHas.newDecision} oldInContext=${probe.contextHas.oldDecision}`,
   ),
   check(
    `abstention-unknown-${probe.probe}`,
    `${probe.probe}: never-supplied region answered UNKNOWN`,
    "abstention",
    probe.unknownAnswer === "UNKNOWN",
    `answer=${probe.unknownAnswer} claimInContext=${probe.contextHas.regionClaim}`,
   ),
   check(
    `abstention-premise-${probe.probe}`,
    `${probe.probe}: false cache-fix premise not confirmed`,
    "abstention",
    probe.premiseAnswer === "PREMISE_FALSE",
    `answer=${probe.premiseAnswer} claimInContext=${probe.contextHas.cacheFixClaim}`,
   ),
   check(
    `archive-${probe.probe}`,
    `${probe.probe}: archive fact correct via the required route`,
    "archive",
    probe.archiveAnswer === FACTS.archiveValue &&
    (probe.archiveSource === "context" ||
     probe.archiveSource === "retrieval" ||
     probe.archiveSource === "disk-reread"),
    `answer=${probe.archiveAnswer} source=${probe.archiveSource} retrievalUsed=${probe.archiveRetrievalUsed}`,
   ),
  );
  if (observed.memoryToolAvailable) {
   checks.push(
    check(
     `memory-recall-${probe.probe}`,
     `${probe.probe}: saved memory recallable with a valid ref`,
     "memory",
     probe.memoryRecallHit &&
     parseMemoryRef(probe.memoryRef ?? "") !== null,
     `hit=${probe.memoryRecallHit} ref=${probe.memoryRef ?? "none"}`,
    ),
   );
  }
 }
 const expectedApplied = arm === "eesv" || arm === "hybrid" ? observed.repeats : 0;
 checks.push(
  check(
   "lifecycle-compactions",
   "compaction count matches the arm policy",
   "lifecycle",
   observed.compactions.applied === expectedApplied &&
   observed.compactions.staged === expectedApplied,
   `staged=${observed.compactions.staged} applied=${observed.compactions.applied} expected=${expectedApplied}`,
  ),
  check(
   "lifecycle-receipts",
   "every applied compaction has a success receipt",
   "lifecycle",
   observed.compactions.receipts.length === expectedApplied &&
   observed.compactions.receipts.every((r) => r.status === "success"),
   receiptsDetail || "none",
  ),
 );
 if (observed.memoryToolAvailable) {
  checks.push(
   check(
    "memory-save-ref",
    "memory save returned a parseable ref",
    "memory",
    parseMemoryRef(capture.memorySavedRef ?? "") !== null,
    `ref=${capture.memorySavedRef ?? "none"} approved=${capture.memorySaveApproved}`,
   ),
  );
 }
 return checks;
}

// ── Live budget guard (enforced reservation ledger over the SDK fetch seam) ─

export interface BudgetSpec {
 requests: number;
 inputTokens: number;
 outputTokens: number;
}

export interface BudgetLedger {
 requests: number;
 /** Char-derived estimate; never presented as exact token enforcement. */
 inputEstimatedTokens: number;
 /** Worst-case reserved output: the sum of dispatched wire caps. */
 reservedOutputTokens: number;
 /**
  * Provider-reported actuals summed over requests (each request contributes its
  * final cumulative value once); absent usage stays null, never zero. Raw wire
  * fields: Anthropic input excludes cache tokens, OpenAI prompt tokens include them.
  */
 reportedInputTokens: number | null;
 reportedOutputTokens: number | null;
 reportedCacheReadTokens: number | null;
 reportedCacheWriteTokens: number | null;
 /** Dispatched requests whose response reported both input and output usage. */
 usageCompleteRequests: number;
 enforcedOutputCap: boolean;
 log: string[];
}

export type BudgetRequestClass = "main" | "summary" | "unknown";

/** Per-dispatched-request accounting; never carries URLs, headers, or bodies. */
export interface BudgetRequestRecord {
 /** 1-based dispatch order (the ledger request count at reservation). */
 sequence: number;
 requestClass: BudgetRequestClass;
 inputEstimatedTokens: number;
 /** 0 in unbounded mode. */
 reservedOutputTokens: number;
 /** null when the dispatch itself failed. */
 status: number | null;
 dispatchFailed: boolean;
 /** Dispatch until the response body was fully read (or the dispatch failed); null while pending. */
 elapsedMs: number | null;
 reportedInputTokens: number | null;
 reportedOutputTokens: number | null;
 reportedCacheReadTokens: number | null;
 reportedCacheWriteTokens: number | null;
}

export interface BudgetedFetch {
 fetch: typeof fetch;
 ledger: BudgetLedger;
 records: BudgetRequestRecord[];
 allowedOrigins: Set<string>;
 /** Await all in-flight usage accounting; the ledger and records are final afterwards. */
 settle(): Promise<void>;
}

/** Output-cap fields a provider may honor; every present one is enforced. */
const WIRE_CAPS: Array<{ kind: string; read: (body: Record<string, unknown>) => unknown }> = [
 { kind: "max_output_tokens", read: (body) => body.max_output_tokens },
 { kind: "max_completion_tokens", read: (body) => body.max_completion_tokens },
 { kind: "max_tokens", read: (body) => body.max_tokens },
 {
  kind: "generationConfig.maxOutputTokens",
  read: (body) => (body.generationConfig as { maxOutputTokens?: unknown } | undefined)?.maxOutputTokens,
 },
];

/** The largest present output cap, or an error reason when none is enforceable. */
function parseWireCap(bodyText: string): { cap: number; kinds: string } | { refused: string } {
 let parsed: unknown;
 try {
  parsed = JSON.parse(bodyText);
 } catch {
  return { refused: "body is empty, opaque, compressed, or not JSON" };
 }
 if (typeof parsed !== "object" || parsed === null) return { refused: "body is not a JSON object" };
 const body = parsed as Record<string, unknown>;
 const present = WIRE_CAPS.map((path) => ({ kind: path.kind, value: path.read(body) })).filter(
  (entry) => entry.value !== undefined,
 );
 if (!present.length) return { refused: "body has no output cap field" };
 const invalid = present.find(
  (entry) => typeof entry.value !== "number" || !Number.isSafeInteger(entry.value) || entry.value <= 0,
 );
 if (invalid) return { refused: `${invalid.kind} is not a positive integer` };
 return {
  cap: Math.max(...present.map((entry) => entry.value as number)),
  kinds: present.map((entry) => entry.kind).join("+"),
 };
}

type UsageFields = Pick<
 BudgetRequestRecord,
 "reportedInputTokens" | "reportedOutputTokens" | "reportedCacheReadTokens" | "reportedCacheWriteTokens"
>;

function usageNumbers(container: Record<string, unknown>): UsageFields {
 // Anthropic message_start nests usage under `message`.
 const usage = (container.usage ?? (container.message as Record<string, unknown> | undefined)?.usage) as
  | Record<string, unknown>
  | undefined;
 const metadata = container.usageMetadata as Record<string, unknown> | undefined;
 const details = usage?.prompt_tokens_details as Record<string, unknown> | undefined;
 const number = (...values: Array<unknown>): number | null => {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
 };
 return {
  reportedInputTokens: number(usage?.input_tokens, usage?.prompt_tokens, metadata?.promptTokenCount),
  reportedOutputTokens: number(usage?.output_tokens, usage?.completion_tokens, metadata?.candidatesTokenCount),
  reportedCacheReadTokens: number(usage?.cache_read_input_tokens, details?.cached_tokens),
  reportedCacheWriteTokens: number(usage?.cache_creation_input_tokens),
 };
}

/**
 * One response's usage. Stream usage is cumulative (Anthropic message_start then
 * message_delta, Gemini per-chunk usageMetadata), so each field is the maximum
 * observed across events rather than a sum.
 */
function responseUsage(text: string): UsageFields {
 const result: UsageFields = {
  reportedInputTokens: null,
  reportedOutputTokens: null,
  reportedCacheReadTokens: null,
  reportedCacheWriteTokens: null,
 };
 const merge = (parsed: unknown): void => {
  if (typeof parsed !== "object" || parsed === null) return;
  const usage = usageNumbers(parsed as Record<string, unknown>);
  for (const key of Object.keys(result) as Array<keyof UsageFields>) {
   const value = usage[key];
   if (value !== null) result[key] = Math.max(result[key] ?? value, value);
  }
 };
 try {
  merge(JSON.parse(text));
  return result;
 } catch {
  // Event-stream bodies: parse each data: line as JSON.
 }
 for (const line of text.split("\n")) {
  const payload = /^data:\s*(\{.*\})\s*$/.exec(line)?.[1];
  if (!payload) continue;
  try {
   merge(JSON.parse(payload));
  } catch {
   // Skip unparsable keep-alive frames.
  }
 }
 return result;
}

const REQUEST_CLASSES: Record<BudgetRequestClass, true> = { main: true, summary: true, unknown: true };

/**
 * Enforced budget wrapper for the SDK's provider fetch seam. Fail-closed:
 * exact-origin allowlist, redirects refused, and in bounded mode every request
 * must carry positive-integer output caps that fit the remaining reservation —
 * otherwise it is refused before dispatch (bodies are never rewritten; empty,
 * opaque, or unparseable bodies are refused unless the explicitly unbounded
 * ChatGPT/Codex mode is declared). Input is kept as an estimate and
 * provider-reported usage is accounted separately per request (absent stays null).
 *
 * Scope: only requests that flow through this fetch. Tool subprocesses and any
 * non-fetch transport are NOT covered.
 */
export function createBudgetedFetch(options: {
 realFetch: typeof fetch;
 budget: BudgetSpec;
 writeLedger: (ledger: BudgetLedger, records: readonly BudgetRequestRecord[]) => void;
 unboundedOutput?: boolean;
 /** Read synchronously at dispatch; a throw or unknown value records "unknown". */
 getRequestClass?: () => BudgetRequestClass;
}): BudgetedFetch {
 const ledger: BudgetLedger = {
  requests: 0,
  inputEstimatedTokens: 0,
  reservedOutputTokens: 0,
  reportedInputTokens: null,
  reportedOutputTokens: null,
  reportedCacheReadTokens: null,
  reportedCacheWriteTokens: null,
  usageCompleteRequests: 0,
  enforcedOutputCap: options.unboundedOutput !== true,
  log: [],
 };
 const records: BudgetRequestRecord[] = [];
 const allowedOrigins = new Set<string>();
 const pending: Array<Promise<void>> = [];
 const persist = () => options.writeLedger(ledger, records);
 const requestClass = (): BudgetRequestClass => {
  try {
   const value = options.getRequestClass?.();
   return value !== undefined && Object.hasOwn(REQUEST_CLASSES, value) ? value : "unknown";
  } catch {
   return "unknown";
  }
 };
 const addUsage = (record: BudgetRequestRecord, usage: UsageFields): void => {
  Object.assign(record, usage);
  for (const key of Object.keys(usage) as Array<keyof UsageFields>) {
   const value = usage[key];
   if (value !== null) ledger[key] = (ledger[key] ?? 0) + value;
  }
  if (usage.reportedInputTokens !== null && usage.reportedOutputTokens !== null)
   ledger.usageCompleteRequests += 1;
 };

 const guarded = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
   const recordClass = requestClass();
   const url = input instanceof Request ? input.url : String(input);
   let origin: string;
   try {
    origin = new URL(url).origin;
   } catch {
    throw new Error(`Live guard blocked an unparseable request URL: ${url.slice(0, 120)}`);
   }
   if (!allowedOrigins.size || !allowedOrigins.has(origin))
    throw new Error(`Live guard blocked a request outside the selected provider origins: ${origin}`);

   // Bodies the guard cannot read (streams, blobs, form data) stay "" and are
   // refused in bounded mode; the dispatched body is always the one inspected.
   let bodyText = "";
   if (typeof init?.body === "string") bodyText = init.body;
   else if (init?.body instanceof Uint8Array) bodyText = Buffer.from(init.body).toString("utf8");
   else if (init?.body == null && input instanceof Request) bodyText = await input.clone().text();

   // Reservation block: synchronous from here to dispatch, so concurrent
   // calls cannot jointly overbook the budget.
   if (ledger.requests + 1 > options.budget.requests)
    throw new Error(
     `Live request budget exhausted (${options.budget.requests} requests)`,
    );
   const inputEstimate = Math.ceil(bodyText.length / 4);
   if (ledger.inputEstimatedTokens + inputEstimate > options.budget.inputTokens)
    throw new Error(
     `Live estimated-input budget would be exceeded (~${inputEstimate} more of ` +
     `${options.budget.inputTokens}; estimates, not exact tokens)`,
    );
   let reservation = 0;
   if (ledger.enforcedOutputCap) {
    const parsed = parseWireCap(bodyText);
    if ("refused" in parsed)
     throw new Error(
      `Live guard refused a request without an enforceable output cap (${parsed.refused}; ` +
      "max_tokens / max_output_tokens / max_completion_tokens / generationConfig.maxOutputTokens " +
      "must be positive integers); opaque or compressed bodies are unsupported hard-cap routes",
     );
    const remaining = options.budget.outputTokens - ledger.reservedOutputTokens;
    if (remaining <= 0)
     throw new Error(
      `Live reserved-output budget exhausted (${options.budget.outputTokens} requested/reserved tokens)`,
     );
    if (parsed.cap > remaining)
     throw new Error(
      `Live guard refused a request whose output cap ${parsed.cap} (${parsed.kinds}) exceeds remaining ` +
      `reserved-output budget ${remaining} of ${options.budget.outputTokens}; lower the cap instead of relying on rewrite`,
     );
    reservation = parsed.cap;
    ledger.log.push(`reserved ${reservation} output tokens (cap ${parsed.kinds})`);
   }
   ledger.requests += 1;
   ledger.inputEstimatedTokens += inputEstimate;
   ledger.reservedOutputTokens += reservation;
   const record: BudgetRequestRecord = {
    sequence: ledger.requests,
    requestClass: recordClass,
    inputEstimatedTokens: inputEstimate,
    reservedOutputTokens: reservation,
    status: null,
    dispatchFailed: false,
    elapsedMs: null,
    reportedInputTokens: null,
    reportedOutputTokens: null,
    reportedCacheReadTokens: null,
    reportedCacheWriteTokens: null,
   };
   records.push(record);
   persist();

   const started = performance.now();
   let response: Response;
   try {
    response = await options.realFetch(input, { ...init, redirect: "manual" });
   } catch (error) {
    record.dispatchFailed = true;
    record.elapsedMs = performance.now() - started;
    persist();
    throw error;
   }
   record.status = response.status;
   if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    record.elapsedMs = performance.now() - started;
    persist();
    throw new Error(
     `Live guard refused a ${response.status} redirect from ${origin} (fail-closed: no cross-origin follow)`,
    );
   }
   const accounted = response
    .clone()
    .text()
    .then((text) => {
     record.elapsedMs = performance.now() - started;
     addUsage(record, responseUsage(text));
     persist();
    })
    .catch(() => {
     record.elapsedMs = performance.now() - started;
     ledger.log.push(`usage accounting failed for request ${record.sequence}`);
     persist();
    });
   pending.push(accounted);
   return response;
  },
  { preconnect: options.realFetch.preconnect?.bind(options.realFetch) },
 ) as typeof fetch;

 return {
  fetch: guarded,
  ledger,
  records,
  allowedOrigins,
  settle: async () => {
   await Promise.all([...pending]);
   pending.length = 0;
   persist();
  },
 };
}
