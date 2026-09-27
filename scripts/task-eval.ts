/** Paired coding-task / continuation+memory evaluation runner.
 *
 *   bun scripts/task-eval.ts [--arms=...] [--repeats=5] [--out=DIR]
 *
 * Offline default: real stock AgentSession, real tools and storage, scripted
 * local provider transport (labelled lifecycle checks — no claims about live
 * model decision quality, no provider traffic, synthetic usage only).
 *
 * Live (opt-in, paid, NOT run by default):
 *   bun scripts/task-eval.ts --live --models=provider/model
 *     --budget-requests=N --budget-input-tokens=N --budget-output-tokens=N --out=DIR
 *     [--summary-model=provider/model] [--accept-codex-soft-cap]
 *
 * Live guards: exactly one selected provider/model; a fresh explicit budget is
 * mandatory and ledger-checked before every request; OAuth credentials are
 * read once from the real auth file and copied into a private temporary HOME
 * (never refreshed, never globally written); only the selected provider's
 * hosts are reachable. The ChatGPT/Codex route has no wire output cap — it is
 * refused by default and only runs as an explicitly declared unbounded mode
 * (--accept-codex-soft-cap) whose report labels the cap as a soft
 * visible-output watchdog, never a hard bound. No USD conversion: the
 * subscription behind OAuth routes is unknown.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { prepareLiveProvider, liveUsageReport, captureLiveToolResult } from "./task-eval-live.ts";
import { createEvalSandbox, type EvalSandbox } from "./task-eval-sandbox.ts";
import type {
 Api,
 AssistantMessage,
 Model,
 SimpleStreamOptions,
 TranscriptContext,
 Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
 AgentSession,
 CompactionResult,
 ExtensionAPI,
 ExtensionUIContext,
 ModelRuntime,
 Theme,
} from "@earendil-works/pi-coding-agent";
import * as host from "@earendil-works/pi-coding-agent";
import smartCompact from "../src/index.ts";
import { isChatGptCodex, resetLlmClient, setLlmClient } from "../src/infra/llm-client.ts";
import { loadConfig, resetConfigCache } from "../src/utils/config.ts";
import { readMetricsLog } from "../src/utils/cache.ts";
import { readJsonlTail } from "../src/infra/fs.ts";
import { damageReportsFile } from "../src/infra/paths.ts";
import {
 AUTO_TRIM_COOLDOWN_TURNS,
 MIN_AUTO_TRIM_SAVING_CHARS,
} from "../src/app/context-operations.ts";
import { SETTLED_TRIGGER_COOLDOWN_MS, VERSION } from "../src/constants.ts";
import {
 buildPrivacySafeTelemetry,
 type DamageTelemetryEntry,
} from "../src/domain/telemetry.ts";
import {
 ARMS,
 DECISION_CODES,
 FACTS,
 applyOracles,
 armSmartCompactSettings,
 answer,
 assertPairedBatch,
 continuationPaths,
 contextPresence,
 createBudgetedFetch,
 createCapture,
 type BudgetedFetch,
 probeFrames,
 recallEvidence,
 decisionFromCode,
 decisionNewPrompt,
 decisionOldPrompt,
 evidenceFrames,
 genericProbePrompt,
 historyAck,
 implementFrames,
 longToolRunFrames,
 memorySaveFrames,
 reopenFrames,
 scriptedSummary,
 smartCompactFrames,
 text,
 type ArmId,
 type Capture,
 type Frame,
 type Observed,
 type OracleResult,
 type ProbeRecord,
 writeProjectFiles,
} from "./task-eval-case.ts";

// ── CLI ─────────────────────────────────────────────────────────────────────

interface Args {
 arms: ArmId[];
 repeats: number;
 round1History: number;
 historyPerRound: number;
 out: string;
 json: boolean;
 live: boolean;
 models: string;
 summaryModel: string;
 budgetRequests: number;
 budgetInputTokens: number;
 budgetOutputTokens: number;
 mainMaxTokens: number;
 contextWindow: number;
 acceptCodexSoftCap: boolean;
 /** Offline cost-accounting fixtures; refused in live mode. */
 cacheWarming: "off" | "streaming" | "idle";
 backgroundPrep: boolean;
}

function parseArgs(): Args {
 const argv = process.argv.slice(2);
 const flag = (name: string): string | undefined =>
  argv.find((arg) => arg.startsWith("--" + name + "="))?.slice(name.length + 3);
 const numberFlag = (name: string): number | undefined => {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
 };
 const armsRaw = flag("arms") ?? "all";
 const arms = (
  armsRaw === "all" ? [...ARMS] : armsRaw.split(",").map((v) => v.trim()).filter(Boolean)
 ) as ArmId[];
 for (const arm of arms)
  if (!ARMS.includes(arm))
   throw new Error("Unknown arm: " + arm + " (use: " + ARMS.join(",") + ")");
 if (!arms.length) throw new Error("No arms selected");
 const repeats = numberFlag("repeats") ?? 5;
 if (!Number.isInteger(repeats) || repeats < 1 || repeats > 8)
  throw new Error("--repeats must be an integer 1-8 (repeated compactions per arm)");
 const out =
  flag("out") ??
  path.join(
   process.cwd(),
   "task-eval-reports",
   new Date().toISOString().replace(/[:.]/g, "-"),
  );
 const args: Args = {
  arms,
  repeats,
  round1History: numberFlag("round1-history") ?? 32,
  historyPerRound: numberFlag("history-per-round") ?? 32,
  out,
  json: argv.includes("--json"),
  live: argv.includes("--live"),
  models: flag("models") ?? "",
  summaryModel: flag("summary-model") ?? "",
  budgetRequests: numberFlag("budget-requests") ?? -1,
  budgetInputTokens: numberFlag("budget-input-tokens") ?? -1,
  budgetOutputTokens: numberFlag("budget-output-tokens") ?? -1,
  mainMaxTokens: flag("main-max-tokens") === undefined ? 4096 : Number(flag("main-max-tokens")),
  contextWindow: flag("context-window") === undefined ? 0 : Number(flag("context-window")),
  acceptCodexSoftCap: argv.includes("--accept-codex-soft-cap"),
  cacheWarming: (["off", "streaming", "idle"] as const).includes(
   flag("cache-warming") as Args["cacheWarming"],
  )
   ? (flag("cache-warming") as Args["cacheWarming"])
   : "off",
  backgroundPrep: argv.includes("--background-prep"),
 };
 if (flag("cache-warming") !== undefined && !["off", "streaming", "idle"].includes(flag("cache-warming")!))
  throw new Error("--cache-warming must be one of: off, streaming, idle");
 if (!path.isAbsolute(args.out)) throw new Error("--out must be an absolute directory");
 if (args.round1History < 1 || args.historyPerRound < 1)
  throw new Error("history counts must be >= 1");
 if (args.live && (args.cacheWarming !== "off" || args.backgroundPrep))
  throw new Error(
   "--cache-warming/--background-prep are offline cost-accounting fixtures; refused in live mode",
  );
 if (!args.live) {
  console.error(
   "Offline lifecycle mode: scripted local transport, real AgentSession/tools/storage.\n" +
   "No provider traffic; no claims about live model decision quality.\n",
  );
 } else {
  const missing = [
   ["--models", args.models],
   ["--budget-requests", args.budgetRequests],
   ["--budget-input-tokens", args.budgetInputTokens],
   ["--budget-output-tokens", args.budgetOutputTokens],
  ]
   .filter(([, value]) => !value)
   .map(([name]) => name);
  if (missing.length)
   throw new Error(
    "Live mode requires a fresh explicit budget and model: missing " + missing.join(", "),
   );
  if (args.budgetRequests < 1 || args.budgetInputTokens < 1 || args.budgetOutputTokens < 1)
   throw new Error("Live budget values must be >= 1");
  if (!Number.isSafeInteger(args.mainMaxTokens) || args.mainMaxTokens < 1)
   throw new Error("--main-max-tokens must be a positive integer");
  if (!Number.isSafeInteger(args.contextWindow) || (flag("context-window") !== undefined && args.contextWindow < 1))
   throw new Error("--context-window must be a positive integer when set");
  if (args.summaryModel && args.summaryModel.split("/")[0] !== args.models.split("/")[0])
   throw new Error("Main and summary models must use the same selected provider");
 }
 return args;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
 console.log(`Usage: bun run task-eval [options]
 
 Default: offline scripted transport, all four arms, five rounds.
   --arms=all|${ARMS.join(",")}
   --repeats=1..8                  Compaction rounds per applicable arm
   --out=/absolute/directory       Reports (default: ./task-eval-reports/TIMESTAMP)
   --json                         Print the JSON report
   --cache-warming=off|streaming|idle
                                  Offline fixture: host prompt-cache warmer
                                  (12s TTL, synthetic economics; idle adds
                                  bounded waits, streaming adds one real long
                                  tool run per arm)
   --background-prep              Offline fixture: speculative background
                                  preparation on (per-arm apply gate; never
                                  changes which arms stage compactions)
 
 Live mode requires fresh explicit authorization and all four options:
   --live --models=provider/model --budget-requests=N
   --budget-input-tokens=N --budget-output-tokens=N
   --summary-model=provider/model  Optional route on the selected provider
   --main-max-tokens=N             Main response cap (default 4096)
   --context-window=N              Explicit context fixture, no larger than native
   --accept-codex-soft-cap         Explicit UNBOUNDED output; not a hard cap
 
 Offline results are lifecycle evidence, not live model quality or savings.
 Input is estimated; reservations and reported usage are separate.
 Live mode requires a local Linux Docker daemon and the task-eval runtime image.
 Tools see only the image, synthetic project and owned HOME, with no host network. Launch with a clean env.`);
 process.exit(0);
}

const args = parseArgs();
fs.mkdirSync(args.out, { recursive: true });
host.initTheme(undefined, false);
/** Captured before redirecting HOME; live launches can supply a frozen private HOME. */
const credentialSourceDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const liveRequestClass = new AsyncLocalStorage<"main" | "summary">();

// ── Report shape ────────────────────────────────────────────────────────────

interface UsageClass {
 requests: number;
 input: number;
 output: number;
 cacheRead: number;
 cacheWrite: number;
}

interface ArmReport {
 arm: ArmId;
 mode: "offline-lifecycle" | "live-semantic";
 ok: boolean;
 error?: string;
 oracles: OracleResult[];
 usage: Record<string, unknown>;
 toolInteractions: Record<string, number>;
 retrieval: Observed["retrieval"];
 compactions: Observed["compactions"];
 memory: string;
 context: Record<string, unknown>;
 latencyMs: number;
 policy: Observed["policy"];
 preparation?: unknown;
 compactionTrace?: CompactionTraceEntry[];
 damageReports: number;
 labels: string[];
}
/** The host shares its global Theme via a registered symbol; the runner
 * initializes it once so extension UI contexts can spread a real value. */
const sharedTheme = (): Theme => {
 const value = (globalThis as unknown as Record<symbol, unknown>)[
  Symbol.for("@earendil-works/pi-coding-agent:theme")
 ];
 assert(value, "host theme not initialized; initTheme must run first");
 return value as Theme;
};


/** Minimal headless ExtensionUIContext: makes hasUI true and auto-approves
 * memory saves. Mirrors the host's internal no-op context; only confirm() lies. */
const autoConfirmUI = (): ExtensionUIContext =>
 ({
  select: async () => undefined,
  confirm: async () => true,
  input: async () => undefined,
  notify: () => { },
  onTerminalInput: () => () => { },
  setStatus: () => { },
  setWorkingMessage: () => { },
  setWorkingVisible: () => { },
  setWorkingIndicator: () => { },
  setHiddenThinkingLabel: () => { },
  setWidget: () => { },
  setFooter: () => { },
  setHeader: () => { },
  setTitle: () => { },
  custom: async () => {
   throw new Error("custom UI unavailable in task-eval");
  },
  pasteToEditor: () => { },
  setEditorText: () => { },
  getEditorText: () => "",
  editor: async () => undefined,
  addAutocompleteProvider: () => { },
  setEditorComponent: () => { },
  getEditorComponent: () => undefined,
  theme: sharedTheme(),
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: () => ({ success: false, error: "UI not available" }),
  getToolsExpanded: () => false,
  setToolsExpanded: () => { },
 }) as ExtensionUIContext;
async function runTest(cwd: string, sandbox?: EvalSandbox): Promise<{ code: number; stdout: string }> {
 const run = sandbox
  ? await sandbox.run(["node", "test/run.test.js"], { timeoutMs: 60_000 })
  : spawnSync("node", ["test/run.test.js"], { cwd, encoding: "utf8", timeout: 60_000 });
 return { code: run.status ?? -1, stdout: (run.stdout ?? "") + (run.stderr ?? "") };
}

async function snapshotFiles(cwd: string, keys: string[], sandbox?: EvalSandbox): Promise<Record<string, string>> {
 const files: Record<string, string> = {};
 for (const rel of keys) {
  const target = path.join(cwd, rel);
  if (sandbox) {
   const exists = await sandbox.run(["/bin/sh", "-c", 'test -e "$1" || test -L "$1"', "sh", rel]);
   if (exists.status === 0) files[rel] = (await sandbox.operations.read.readFile(target)).toString("utf8");
   else if (exists.status !== 1) throw new Error("Cannot inspect fixture path: " + rel);
  } else if (fs.existsSync(target)) files[rel] = fs.readFileSync(target, "utf8");
 }
 return files;
}

const historyFiller = (i: number) =>
 `Observation ${i}: ${FACTS.constraint}; ${FACTS.failure} unresolved.\n` +
 "Synthetic observation, unchanged contract and reviewed behavior.\n".repeat(180);

const EMPTY_USAGE: Usage = {
 input: 0,
 output: 0,
 cacheRead: 0,
 cacheWrite: 0,
 totalTokens: 0,
 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// ── Offline scripted transport ──────────────────────────────────────────────

interface TransportState {
 frames: Frame[];
 currentPhase: string;
 requestSizes: Array<{ phase: string; chars: number; usageClass: "main" | "summary" }>;
 usageByClass: { main: UsageClass; summary: UsageClass; warm: UsageClass };
 capture: Capture;
 /** >0 while a scripted prompt or an explicit apply compaction is in flight;
  * summary-class requests outside those windows are background work. */
 foregroundDepth: number;
 /** Full per-request ledger: every attempted request, including background
  * preparation and cache warmups, counted exactly once each. */
 requestLedger: RequestRecord[];
 warmRecords: WarmRecord[];
 lastMainText: string | null;
 lastMainPhase: string | null;
 /** Offline compaction-request tracer hook for summary-class requests. */
 traceSummaryRequest?: (inputTokens: number) => void;
}

/** Causal record correlating compaction requests with summary provider calls. */
interface CompactionTraceEntry {
 seq: number;
 at: number;
 kind:
 | "before_compact"
 | "compact"
 | "compact_failed"
 | "summary_request"
 | "before_reload"
 | "after_reload";
 phase: string;
 inFlightCompactions: number;
 startedCompactions: number;
 reason?: string | null;
 runId?: string | null;
 fromExtension?: boolean | null;
 completesBeforeSeq?: number | null;
 requestInputTokens?: number;
}

interface RequestRecord {
 phase: string;
 usageClass: "main" | "summary" | "warm";
 chars: number;
 input: number;
 output: number;
 /** Scripted frames still queued when the request arrived. */
 inScript: boolean;
 /** Common serialized prefix with the previous main request (chars). */
 commonPrefixWithPrevious: number | null;
 previousMainChars: number | null;
 previousMainPhase: string | null;
 errored?: boolean;
}

interface WarmRecord {
 phase: string;
 chars: number;
 maxTokens: number;
 matchesWarmedRequest: boolean;
 commonPrefixChars: number;
}

/** Chunked common-prefix length: native slice compares keep multi-megabyte
 * histories cheap while staying exact at character granularity. */
function commonPrefixChars(a: string, b: string): number {
 const chunk = 4096;
 const min = Math.min(a.length, b.length);
 let offset = 0;
 while (offset < min) {
  const end = Math.min(offset + chunk, min);
  if (a.slice(offset, end) !== b.slice(offset, end)) {
   for (let i = offset; i < end; i++)
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
   return end;
  }
  offset = end;
 }
 return min;
}

function offlineStream(
 state: TransportState,
 model: Parameters<ExtensionAPI["setModel"]>[0],
 context: TranscriptContext,
 options?: SimpleStreamOptions,
) {
 const output = createAssistantMessageEventStream();
 queueMicrotask(async () => {
  const message: AssistantMessage = {
   role: "assistant",
   api: "task-eval-offline-api",
   provider: "task-eval-offline",
   model: model.id,
   content: [],
   stopReason: "pending",
   timestamp: Date.now(),
   usage: structuredClone(EMPTY_USAGE),
  };
  // Host cache-warmer replays: same delivered context, one-token output cap,
  // no retries. They are real SDK requests and are counted as their own class.
  const isWarm = options?.maxTokens === 1 && options?.maxRetries === 0;
  try {
   options?.signal?.throwIfAborted();
   await options?.onPayload?.(
    { messages: context.messages },
    model as Model<Api>,
   );
   const input = text(context.messages);
   const usageClass: "main" | "summary" | "warm" = isWarm
    ? "warm"
    : model.id === "summary"
     ? "summary"
     : "main";
   const record: RequestRecord = {
    phase: state.currentPhase,
    usageClass,
    chars: input.length,
    input: 0,
    output: 0,
    inScript: state.frames.length > 0 || state.foregroundDepth > 0,
    commonPrefixWithPrevious: null,
    previousMainChars: null,
    previousMainPhase: null,
   };
   state.requestLedger.push(record);
   const bucket = state.usageByClass[usageClass];
   bucket.requests++;
   record.input = Math.ceil(input.length / 4);
   bucket.input += record.input;
   if (usageClass === "summary") state.traceSummaryRequest?.(record.input);
   if (usageClass !== "summary") {
    record.commonPrefixWithPrevious =
     state.lastMainText === null ? null : commonPrefixChars(state.lastMainText, input);
    record.previousMainChars = state.lastMainText?.length ?? null;
    record.previousMainPhase = state.lastMainPhase;
   }
   if (usageClass === "warm") {
    const previous = state.lastMainText;
    const common = record.commonPrefixWithPrevious ?? 0;
    state.warmRecords.push({
     phase: state.currentPhase,
     chars: input.length,
     maxTokens: options?.maxTokens ?? 0,
     matchesWarmedRequest: previous !== null && common === input.length && previous.length === input.length,
     commonPrefixChars: common,
    });
    // The warm request's only output is the one-token cap.
    record.output = 1;
    bucket.output += 1;
    state.usageByClass.warm.cacheRead += record.input;
   }
   let content: AssistantMessage["content"];
   if (usageClass === "warm") {
    content = answer("cache warm replay");
   } else if (usageClass === "summary") {
    state.capture.summaryRequests++;
    assert(input.includes(FACTS.constraint), "Summarizer never received the constraint");
    assert(input.includes(FACTS.failure), "Summarizer never received the unresolved failure");
    if (state.capture.probes.length === 0)
     assert(
      !input.includes(FACTS.archiveFact),
      "Compaction re-expanded an unrequested artifact body",
     );
    content = answer(scriptedSummary(input, state.capture));
   } else {
    assertPairedBatch(context);
    state.capture.mainRequests++;
    const next = state.frames.shift();
    assert(next, "Unexpected provider continuation in " + state.currentPhase);
    content = next(context);
   }
   if (usageClass !== "warm") {
    if (usageClass === "main") {
     state.lastMainText = input;
     state.lastMainPhase = state.currentPhase;
    }
    state.requestSizes.push({
     phase: state.currentPhase,
     chars: input.length,
     usageClass,
    });
   }
   if (usageClass !== "warm") {
    message.usage.output = Math.ceil(JSON.stringify(content).length / 4);
    record.output = message.usage.output;
    bucket.output += message.usage.output;
   } else {
    message.usage.output = 1;
   }
   message.usage.input = record.input;
   message.usage.totalTokens = message.usage.input + message.usage.output;
   if (isWarm) {
    // Warm replays read the prompt cache they maintain; synthetic accounting
    // only, mirroring how the host labels cache_warm usage entries.
    message.usage.cacheRead = record.input;
   }
   output.push({ type: "start", partial: message });
   for (const [index, block] of content.entries()) {
    if (block.type === "text") {
     message.content.push({ type: "text", text: "" });
     output.push({ type: "text_start", contentIndex: index, partial: message });
     message.content[index] = block;
     output.push({
      type: "text_delta",
      contentIndex: index,
      delta: block.text,
      partial: message,
     });
     output.push({
      type: "text_end",
      contentIndex: index,
      content: block.text,
      partial: message,
     });
    } else if (block.type === "toolCall") {
     message.content.push({ ...block, arguments: {} });
     output.push({ type: "toolcall_start", contentIndex: index, partial: message });
     message.content[index] = block;
     output.push({
      type: "toolcall_delta",
      contentIndex: index,
      delta: JSON.stringify(block.arguments),
      partial: message,
     });
     output.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
    }
   }
   message.stopReason = message.content.some((block) => block.type === "toolCall")
    ? "toolUse"
    : "stop";
   output.push({ type: "done", reason: message.stopReason, message });
  } catch (error) {
   // Attempted requests that fail are still delivered work: keep them in the
   // ledger and the request counts, marked errored.
   const last = state.requestLedger.at(-1);
   if (last) last.errored = true;
   message.stopReason = options?.signal?.aborted ? "aborted" : "error";
   message.errorMessage = error instanceof Error ? error.stack : String(error);
   output.push({ type: "error", reason: message.stopReason, error: message });
  } finally {
   output.end();
  }
 });
 return output;
}

// ── Live budget guard ───────────────────────────────────────────────────────


function hostAllowListFor(model: Model<Api>): string[] {
 if (model.baseUrl) return [new URL(model.baseUrl).origin];
 switch (model.provider) {
  case "anthropic":
   return ["https://api.anthropic.com"];
  case "openai":
   return ["https://api.openai.com"];
  case "openai-codex":
   return ["https://chatgpt.com", "https://api.openai.com"];
  default:
   return [];
 }
}

// ── One arm ─────────────────────────────────────────────────────────────────



function fileLine(files: Record<string, string>, rel: string, key: string): string {
 const match = new RegExp(`^${key}=(.*)$`, "m").exec(files[rel] ?? "");
 return match?.[1]?.trim() ?? "";
}

function recordLiveProbe(
 capture: Capture,
 probe: string,
 afterCompaction: number,
 delivered: string,
 files: Record<string, string>,
 archiveRetrieved: boolean,
 lastRecallOutput: string,
): void {
 const presence = contextPresence(delivered);
 const paths = continuationPaths(probe);
 const archiveAnswer = fileLine(files, paths.archive, "ARCHIVE");
 const memoryRef = fileLine(files, paths.memory, "MEMORY_REF");
 // Strict evidence: the actual smart_recall tool result must contain the
 // saved fact with the matching ref, and the continuation artifact must
 // carry that exact ref. Presence in delivered context proves nothing.
 const evidence = recallEvidence(lastRecallOutput, capture.memorySavedRef);
 const artifactRef = memoryRef && memoryRef !== "NONE" ? memoryRef : null;
 const record: ProbeRecord = {
  probe,
  afterCompaction,
  deliveredChars: delivered.length,
  contextHas: presence,
  currentDecision: decisionFromCode(fileLine(files, paths.storeChoice, "CURRENT_DECISION")),
  unknownAnswer: fileLine(files, paths.answers, FACTS.unknownKey) || "MISSING",
  premiseAnswer: fileLine(files, paths.answers, FACTS.premiseKey) || "MISSING",
  archiveAnswer: archiveAnswer || "MISSING",
  archiveSource: presence.archiveFact
   ? "context"
   : archiveAnswer === FACTS.archiveValue
    ? archiveRetrieved ? "retrieval" : "none"
    : "none",
  archiveRetrievalUsed:
   !presence.archiveFact &&
   archiveAnswer === FACTS.archiveValue &&
   archiveRetrieved,
  memoryRef: artifactRef,
  memoryRecallHit: evidence.hit && artifactRef === evidence.ref,
 };
 capture.probes.push(record);
}

async function runArm(arm: ArmId, liveGuardParam?: BudgetedFetch): Promise<ArmReport> {
 const startedAt = Date.now();
 const capture = createCapture();
 const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "task-eval-" + arm + "-"));
 const cwd = path.join(scratch, "project");
 const agentDir = path.join(scratch, ".pi", "agent");
 const previous = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_OFFLINE: process.env.PI_OFFLINE,
 };

 const originalFetch = globalThis.fetch;
 const originalWebSocket = globalThis.WebSocket;
 let attemptedFetches = 0;
 // First blocked request: target and caller, so an offline failure names its source.
 let firstBlockedFetch = "";
 let liveGuard: BudgetedFetch | undefined;
 let session: AgentSession | undefined;
 let sandbox: EvalSandbox | undefined;
 let preparedLive: ReturnType<typeof prepareLiveProvider> | undefined;
 const state: TransportState = {
  frames: [],
  currentPhase: "startup",
  requestSizes: [],
  usageByClass: {
   main: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
   summary: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
   warm: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  capture,
  foregroundDepth: 0,
  requestLedger: [],
  warmRecords: [],
  lastMainText: null,
  lastMainPhase: null,
 };
 const sessionFiles = new Set<string>();
 const events: string[] = [];
 const toolRuns: Record<string, number> = {};
 const liveProbeContexts = new Map<string, string>();
 const pendingToolInputs = new Map<string, unknown>();
 const liveRetrieval = { search: 0, read: 0, archive: false };
 const extensionErrors: unknown[] = [];
 let lastRecallOutput = "";
 const usageAtCompactions: Array<{ round: number; tokensBefore: number | null }> = [];

 try {
  process.env.HOME = scratch;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (!args.live) {
   // Pi's grep tool downloads ripgrep from GitHub when `rg` is missing; an
   // offline arm must neither download nor silently degrade to grep errors.
   process.env.PI_OFFLINE = "1";
   const rg = spawnSync("rg", ["--version"], { stdio: "pipe" });
   if (rg.error || rg.status !== 0) {
    throw new Error("ripgrep (rg) is required on PATH for the offline task-eval; Pi tool downloads are disabled (PI_OFFLINE=1).");
   }
  }
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const settings = armSmartCompactSettings(arm, { backgroundPrep: args.backgroundPrep });
  if (args.live) settings.summaryModel = args.summaryModel || args.models;
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
   smartCompact: settings,
  }));
  resetConfigCache();
  writeProjectFiles(cwd);
  if (args.live) {
   assert(liveGuardParam, "Live mode requires the whole-run budget guard");
   liveGuard = liveGuardParam;
   globalThis.fetch = liveGuard.fetch;
   globalThis.WebSocket = class {
    constructor() {
     throw new Error("WebSocket transport is disabled in live task-eval");
    }
   } as unknown as typeof WebSocket;
   sandbox = createEvalSandbox({ root: cwd, dockerConfigHome: previous.HOME });
   const isolation = await sandbox.validate();
   fs.writeFileSync(path.join(args.out, "isolation-" + arm + ".json"), JSON.stringify(isolation, null, 2));
   preparedLive = prepareLiveProvider(credentialSourceDir, agentDir, [args.models, args.summaryModel || args.models]);
  } else {
   globalThis.fetch = Object.assign(
    async (input: unknown) => {
     attemptedFetches++;
     if (!firstBlockedFetch) {
      const target = input instanceof Request ? input.url : String(input);
      firstBlockedFetch = target + "\n" + (new Error().stack ?? "").split("\n").slice(2, 8).join("\n");
     }
     throw new Error("Network disabled by offline task-eval");
    },
    { preconnect() { } },
   ) as typeof fetch;
  }

  // Compaction-request tracer: registered FIRST so its session_before_compact
  // handler runs before Smart Compact's. A summary-class provider request made
  // while a compaction request is in flight (between session_before_compact
  // and session_compact/failed) can only be fresh on-demand hook work; one
  // made with no compaction in flight originates from background preparation
  // (observe at turn_end/agent_settled). Offline only.
  const compactionTrace: CompactionTraceEntry[] = [];
  let traceSeq = 0;
  let startedCompactions = 0;
  let inFlightCompactions = 0;
  let lastBeforeCompactSeq: number | null = null;
  const trace = (entry: Omit<CompactionTraceEntry, "seq" | "at">): void => {
   compactionTrace.push({ ...entry, seq: ++traceSeq, at: Date.now() });
  };
  const compactionProbe = (pi: ExtensionAPI): void => {
   const reasonOf = (event: unknown): string | null => {
    const reason = (event as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : null;
   };
   pi.on("session_before_compact", (event) => {
    startedCompactions++;
    inFlightCompactions++;
    lastBeforeCompactSeq = traceSeq + 1;
    trace({
     kind: "before_compact",
     phase: state.currentPhase,
     inFlightCompactions,
     startedCompactions,
     reason: reasonOf(event),
    });
   });
   pi.on("session_compact", (event) => {
    inFlightCompactions = Math.max(0, inFlightCompactions - 1);
    const runId = (event as { compactionEntry?: { details?: { runId?: unknown } } })
     .compactionEntry?.details?.runId;
    trace({
     kind: "compact",
     phase: state.currentPhase,
     inFlightCompactions,
     startedCompactions,
     runId: typeof runId === "string" ? runId : null,
     fromExtension: (event as { fromExtension?: boolean }).fromExtension ?? null,
     completesBeforeSeq: lastBeforeCompactSeq,
    });
   });
   pi.on("session_compact_failed", () => {
    inFlightCompactions = Math.max(0, inFlightCompactions - 1);
    trace({
     kind: "compact_failed",
     phase: state.currentPhase,
     inFlightCompactions,
     startedCompactions,
     completesBeforeSeq: lastBeforeCompactSeq,
    });
   });
  };
  state.traceSummaryRequest = (inputTokens: number): void => {
   trace({
    kind: "summary_request",
    phase: state.currentPhase,
    inFlightCompactions,
    startedCompactions,
    requestInputTokens: inputTokens,
   });
  };
  const extensionFactories: Array<unknown> = [];
  if (!args.live) extensionFactories.push(compactionProbe);
  extensionFactories.push(smartCompact);
  const buildLoader = async (factories: Array<unknown>) => {
   const loader = new host.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: host.SettingsManager.inMemory({
     compaction: { enabled: false, reserveTokens: 8_192, keepRecentTokens: 6_000 },
     retry: { enabled: false },
     cacheWarming: args.cacheWarming,
    }),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt:
     "Task evaluation session over synthetic files. Use the selected tools. Follow the file contract exactly.",
    extensionFactories: factories as never,
   });
   await loader.reload();
   assert.deepEqual(
    loader.getExtensions().errors,
    [],
    "Smart Compact extension failed to load",
   );
   return loader;
  };

  // Warm-fixture economics: a 12 s prompt-cache TTL (matching the earlier
  // isolated Toolkit wire proof) and synthetic per-million-token rates sized
  // so the host warmer's own expected-savings decision fires at eval context
  // sizes (idle: ≥ ~12k prompt tokens). Decision-coverage fixtures, never
  // price claims.
  const WARM_FIXTURE_TTL_SECONDS = 12;
  const WARM_FIXTURE_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 30 };
  const WARM_FIXTURE_DELAY_MS = 2_000; // getCacheWarmingDelayMs(12s) = 2s

  const open = async (sessionFile?: string): Promise<AgentSession> => {
   const runtime: ModelRuntime = await host.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: preparedLive?.modelsPath ?? null,
    ...(preparedLive ? { credentials: preparedLive.credentials } : {}),
    modelsStorePath: path.join(agentDir, "models-cache.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
   });
   let model: Model<Api> | undefined;
   if (args.live) {
    model = liveModelFor(runtime);
    for (const allowed of hostAllowListFor(model)) liveGuard?.allowedOrigins.add(allowed);
    const stream = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = (target, context, options) => {
     if (liveRequestClass.getStore() === "summary") return stream(target, context, options);
     assert.equal(target.provider + "/" + target.id, args.models, "Main route escaped the selected model");
     state.lastMainText = JSON.stringify(context);
     if (state.currentPhase.startsWith("probe-") && !liveProbeContexts.has(state.currentPhase))
      liveProbeContexts.set(state.currentPhase, state.lastMainText);
     return stream(target, context, { ...options, maxTokens: args.mainMaxTokens });
    };
   } else {
    runtime.registerProvider("task-eval-offline", {
     api: "task-eval-offline-api",
     apiKey: "synthetic-not-a-secret",
     baseUrl: "https://offline.invalid",
     streamSimple: offlineStream.bind(null, state) as never,
     models: (["reader", "summary"] as const).map((id) => ({
      id,
      name: "Task Eval Offline " + id,
      reasoning: false,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 4_096,
      cost: { ...WARM_FIXTURE_COST },
      promptCache: { short: WARM_FIXTURE_TTL_SECONDS },
     })),
    });
    model = runtime.getModel("task-eval-offline", "reader");
   }
   assert(model, "Selected model unavailable in the runtime");
   // The ONLY transport seam: EESV stages still resolve through the real registry.
   setLlmClient({
    complete: (target, body, options) => {
     if (!args.live) return runtime.completeSimple(target, body, options);
     assert.equal(target.provider + "/" + target.id, args.summaryModel || args.models, "Summary route escaped the selected model");
     return liveRequestClass.run("summary", () => runtime.completeSimple(target, body, options));
    },
   });
   const manager = sessionFile
    ? host.SessionManager.open(sessionFile)
    : host.SessionManager.create(cwd, path.join(scratch, "sessions"));
   const created = await host.createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    settingsManager: host.SettingsManager.inMemory({
     compaction: { enabled: false, reserveTokens: 8_192, keepRecentTokens: 6_000 },
     retry: { enabled: false },
     cacheWarming: args.cacheWarming,
    }),
    resourceLoader: await buildLoader(extensionFactories),
    sessionManager: manager,
    thinkingLevel: "off",
    customTools: sandbox ? [
     host.defineTool(host.createReadToolDefinition(cwd, { operations: sandbox.operations.read })),
     host.defineTool(host.createWriteToolDefinition(cwd, { operations: sandbox.operations.write })),
     host.defineTool(host.createBashToolDefinition(cwd, { operations: sandbox.operations.bash })),
     sandbox.grepTool,
    ] : undefined,
    tools: [
     "read",
     "grep",
     "write",
     "bash",
     "smart_context",
     "smart_compact",
     "smart_recall",
     "smart_save_memory",
    ],
   });
   const active: AgentSession = created.session;
   const sessionFileOf = active.sessionFile;
   if (sessionFileOf) sessionFiles.add(sessionFileOf);
   await active.bindExtensions({
    uiContext: autoConfirmUI(),
    onError: (error: unknown) => extensionErrors.push(error),
    commandContextActions: {
     waitForIdle: () => active.waitForIdle(),
     navigateTree: (target, options) => active.navigateTree(target, options),
     newSession: async () => ({ cancelled: true }),
     fork: async () => ({ cancelled: true }),
     switchSession: async () => ({ cancelled: true }),
     reload: () => active.reload(),
    },
   });
   active.subscribe((event) => {
    events.push(event.type);
    if (event.type === "tool_execution_start") pendingToolInputs.set(event.toolCallId, event.args);
    if (event.type === "tool_execution_end") {
     const name = event.toolName;
     toolRuns[name] = (toolRuns[name] ?? 0) + 1;
     if (args.live) {
      const output = captureLiveToolResult(capture, name, event.result, event.isError);
      if (name === "smart_recall") lastRecallOutput = output;
      const input = pendingToolInputs.get(event.toolCallId);
      if (name === "smart_context" && !event.isError && input && typeof input === "object" && "action" in input) {
       if (input.action === "search") liveRetrieval.search++;
       if (input.action === "read") liveRetrieval.read++;
       liveRetrieval.archive ||= output.includes(FACTS.archiveValue);
      }
     } else if (name === "smart_recall") {
      // The host supplies this tool result; use the same text boundary as live.
      lastRecallOutput = captureLiveToolResult(createCapture(), name, event.result, event.isError);
     }
     pendingToolInputs.delete(event.toolCallId);
    }
    if (
     event.type === "message_end" &&
     event.message.role === "assistant" &&
     event.message.stopReason === "error"
    )
     extensionErrors.push(event.message.errorMessage);
   });
   // The paired protocol runs the same approved memory task in every arm.
   // The product gates memory tools on a non-empty local graph; the graph is
   // only populated by compaction indexing, which would silently skip the
   // memory task in the no-compaction arms. The host's public tool
   // activation API turns the tools on explicitly here; once the first save
   // lands, the graph is non-empty and the product heuristic keeps them on.
   const activeTools = active.getActiveToolNames();
   if (!activeTools.includes("smart_save_memory"))
    active.setActiveToolsByName([...activeTools, "smart_save_memory", "smart_recall"]);
   return active;
  };

  async function bounded<T>(task: Promise<T>): Promise<T> {
   let timeout: ReturnType<typeof setTimeout> | undefined;
   try {
    return await Promise.race([
     task,
     new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
       () => {
        void session?.abort();
        reject(new Error("Task eval timed out in " + state.currentPhase));
       },
       args.live ? 300_000 : 60_000,
      );
     }),
    ]);
   } finally {
    if (timeout) clearTimeout(timeout);
   }
  }

  async function prompt(label: string, script: Frame[], input: string): Promise<void> {
   assert(session);
   assert.equal(state.frames.length, 0);
   state.currentPhase = label;
   state.frames = [...script];
   state.foregroundDepth++;
   try {
    await bounded(session.prompt(input));
   } finally {
    state.foregroundDepth--;
   }
   assert.equal(state.frames.length, 0, "Script did not complete: " + label + "; errors: " + JSON.stringify(extensionErrors));
   assert.deepEqual(extensionErrors, [], "Extension errors during " + label);
   assert(!session.isStreaming);
  }

  /** Real-time gap so the host warmer's idle timer fires between prompts. */
  const warmIdleWait = async (): Promise<void> => {
   const { promise, resolve } = Promise.withResolvers<void>();
   setTimeout(resolve, WARM_FIXTURE_DELAY_MS + 700);
   await promise;
  };

  const F = args.live;
  const liveProbePrompt = (k: string) =>
   `Write these files in the requested format. Every KEY=value field must occupy its own line, with no surrounding prose.\n` +
   `${continuationPaths(k).storeChoice}: CURRENT_DECISION=${DECISION_CODES.new} if the current storage decision is the in-memory store, ` +
   `${DECISION_CODES.old} if only the older file-store decision is known, otherwise ${DECISION_CODES.unknown}.\n` +
   `${continuationPaths(k).answers}: two lines: ${FACTS.unknownKey}=<the configured deploy region, or UNKNOWN if nothing in the session or archived evidence establishes one>, then on a separate line ` +
   `${FACTS.premiseKey}=CONFIRMED only if records show an earlier cache bug in src/cache.js was fixed, otherwise PREMISE_FALSE.\n` +
   `${continuationPaths(k).archive}: ARCHIVE=<the value of ${FACTS.archiveFact} from your context or smart_context search/read, or UNKNOWN>.\n` +
   `${continuationPaths(k).memory}: MEMORY_REF=<the Ref line from smart_recall for the saved storage decision, or NONE>.`;

  session = await open();
  const compacts = arm === "eesv" || arm === "hybrid";
  // The explicitly approved memory task runs at the same point in EVERY arm.
  const memoryAvailable = true;

  await prompt(
   "evidence",
   F ? [] : evidenceFrames(capture),
   F
    ? `Read notes/source.txt fully, read AGENTS.md, and grep notes/grep.txt for "evidence" with a high limit. ` +
    `Then run exactly: printf '${FACTS.failure}\\n' >&2; exit 7. Keep that failure visible. ` +
    `Requirement: ${FACTS.constraint}; never create ${FACTS.forbiddenPath}.`
    : `Inspect the evidence in notes/. Requirement: ${FACTS.constraint}. Preserve unresolved failures; never create ${FACTS.forbiddenPath}.`,
  );
  // Streaming-warm fixture: one real long tool run per arm is the host
  // warmer's designed trigger ("cost-aware prompt-cache warming during long
  // tool runs"). Offline only; matched across arms.
  if (!F && args.cacheWarming === "streaming") {
   await prompt(
    "warm-stream",
    longToolRunFrames(
     `sleep ${((WARM_FIXTURE_DELAY_MS + 1_000) / 1_000).toFixed(1)} && echo cache-warm-stream-fixture`,
    ),
    "Run one deliberately long tool step now.",
   );
  }
  if (!F && args.cacheWarming === "idle") await warmIdleWait();
  await prompt("decision-old", F ? [] : [historyAck], decisionOldPrompt);
  await prompt("decision-new", F ? [] : [historyAck], decisionNewPrompt);
  await prompt(
   "implement",
   F ? [] : implementFrames(capture),
   "Implement the current storage decision in src/store.js, run node test/run.test.js, and write side-effect.txt with " +
   FACTS.sideEffect +
   " followed by exactly one newline. Keep assertAuthenticated in src/server.js. Do not create " +
   FACTS.forbiddenPath +
   ".",
  );

  if (!F && args.cacheWarming === "idle") await warmIdleWait();


  await prompt(
   "memory-save",
   F ? [] : memorySaveFrames(capture),
   `Save this current storage decision with smart_save_memory, kind=decision, related_paths=["src/store.js"], ` +
   `content=${FACTS.memoryFact}: ${FACTS.newDecision} in-memory store. ${FACTS.memoryRationale}`,
  );
  assert(
   session.getActiveToolNames().includes("smart_save_memory"),
   "Memory tools must stay active for the paired memory task",
  );

  if (compacts) {
   for (let k = 1; k <= args.repeats; k++) {
    const count = k === 1 ? args.round1History : args.historyPerRound;
    const base = args.round1History + (k - 2) * args.historyPerRound;
    for (let i = 0; i < count; i++)
     await prompt("history-" + k + "-" + i, F ? [] : [historyAck], historyFiller(Math.max(0, base) + i));
    const before = session.getContextUsage();
    await prompt("stage-" + k, F ? [] : smartCompactFrames(capture), "Call smart_compact now.");
    assert(
     capture.stagedRuns.length >= k,
     "smart_compact never staged at round " +
     k +
     " (context below the staging target); increase --round1-history/--history-per-round",
    );
    state.foregroundDepth++;
    let applied: CompactionResult;
    try {
     applied = await bounded(session.compact());
    } finally {
     state.foregroundDepth--;
    }
    const appliedRun = (applied.details as { runId?: string } | undefined)?.runId;
    assert.equal(
     appliedRun,
     capture.stagedRuns.at(-1),
     "Native host did not apply the staged Smart Compact plan",
    );
    capture.appliedRuns.push(appliedRun ?? "");
    if (!F && args.cacheWarming === "idle") await warmIdleWait();
    const receipt = readMetricsLog(200).find((entry) => entry.runId === appliedRun);
    assert(receipt?.status === "success", "No success receipt for applied run " + appliedRun);
    // Post-apply usage is not yet re-estimated until the next request;
    // probe deliveredChars carries the post-compaction size instead.
    usageAtCompactions.push({ round: k, tokensBefore: before?.tokens ?? null });
    if (k === 2 || k === args.repeats) {
     await prompt(
      "probe-" + k,
      F ? [] : probeFrames(capture, String(k), k, memoryAvailable),
      F ? liveProbePrompt(String(k)) : genericProbePrompt,
     );
     if (F)
      recordLiveProbe(
       capture,
       String(k),
       k,
       liveProbeContexts.get("probe-" + k) ?? "",
       await snapshotFiles(cwd, Object.values(continuationPaths(String(k))), sandbox),
       liveRetrieval.archive,
       lastRecallOutput,
      );
    }
   }
  } else {
   const total = args.round1History + (args.repeats - 1) * args.historyPerRound;
   const midPoint = args.round1History + args.historyPerRound;
   for (let i = 0; i < total; i++) {
    await prompt("history-" + i, F ? [] : [historyAck], historyFiller(i));
    if (i + 1 === midPoint || i + 1 === total) {
     const label = i + 1 === midPoint ? "2" : "end";
     await prompt(
      "probe-" + label,
      F ? [] : probeFrames(capture, label, 0, memoryAvailable),
      F ? liveProbePrompt(label) : genericProbePrompt,
     );
     if (F)
      recordLiveProbe(
       capture,
       label,
       0,
       liveProbeContexts.get("probe-" + label) ?? "",
       await snapshotFiles(cwd, Object.values(continuationPaths(label)), sandbox),
       liveRetrieval.archive,
       lastRecallOutput,
      );
    }
   }
  }

  const sessionFile = session.sessionFile;
  assert(sessionFile);
  session.dispose();
  session = await open(sessionFile);
  await prompt(
   "reopen",
   F ? [] : reopenFrames(),
   "Confirm the project constraint is still enforced from your context or smart_context, then run node test/run.test.js and report the result.",
  );
  if (!F && args.cacheWarming === "idle") await warmIdleWait();
  if (!F) {
   // Supported shutdown lifecycle: reload() emits session_shutdown (reason
   // "reload") to the live extension runner and awaits its handlers, so
   // background preparation is cancelled and its discard receipt drained —
   // unlike a bare dispose(), which skips the event entirely.
   trace({ kind: "before_reload", phase: state.currentPhase, inFlightCompactions, startedCompactions });
   await bounded(session.reload());
   trace({ kind: "after_reload", phase: state.currentPhase, inFlightCompactions, startedCompactions });
   const settle = Promise.withResolvers<void>();
   setTimeout(settle.resolve, 300);
   await settle.promise;
  }

  const probeKeys = capture.probes.flatMap((p) => Object.values(continuationPaths(p.probe)));
  // Real module execution: load the written store and exercise it directly.
  const storeArgs = [
   "-e",
   'const m = require("./src/store.js");\n' +
   'if (typeof m.InMemoryStore !== "function") process.exit(3);\n' +
   'const s = new m.InMemoryStore(); s.write("k", "v");\n' +
   'process.exit(s.read("k") === "v" ? 0 : 4);',
  ];
  const storeExec = sandbox
   ? await sandbox.run(["node", ...storeArgs], { timeoutMs: 30_000 })
   : spawnSync("node", storeArgs, { cwd, encoding: "utf8", timeout: 30_000 });
  const storeModuleExec = {
   exportsInMemory: storeExec.status === 0 || storeExec.status === 4,
   roundtripOk: storeExec.status === 0,
  };
  const files = await snapshotFiles(cwd, [
   "src/store.js",
   "src/server.js",
   "side-effect.txt",
   FACTS.forbiddenPath,
   ...probeKeys,
  ], sandbox);
  const config = loadConfig();
  const observed: Observed = {
   arm,
   repeats: args.repeats,
   files,
   forbiddenFileExists: Object.hasOwn(files, FACTS.forbiddenPath),
   testRun: await runTest(cwd, sandbox),
   midTaskTestRun: null,
   storeModuleExec,
   retrieval: {
    smartContextSearch: F ? liveRetrieval.search : 0,
    smartContextRead: F ? liveRetrieval.read : toolRuns["smart_context"] ?? 0,
    smartRecall: toolRuns["smart_recall"] ?? 0,
   },
   compactions: {
    staged: capture.stagedRuns.length,
    applied: capture.appliedRuns.length,
    receipts: readMetricsLog(200)
     .filter((entry) => capture.appliedRuns.includes(entry.runId ?? ""))
     .map((entry) => ({
      runId: entry.runId ?? "",
      status: entry.status,
      preparation: (entry as { preparation?: string }).preparation,
      preparationDiscardReason: (entry as { preparationDiscardReason?: string })
       .preparationDiscardReason,
     })),
   },
   memoryToolAvailable: memoryAvailable,
   capture,
   policy: {
    minAutoTrimSavingChars: MIN_AUTO_TRIM_SAVING_CHARS,
    autoTrimCooldownTurns: AUTO_TRIM_COOLDOWN_TURNS,
    pendingTtlMs: config.pendingTtlMs,
    settledCooldownMs: SETTLED_TRIGGER_COOLDOWN_MS,
    keepRecentTokens:
     ((config.profiles as Record<string, { keepRecentTokens?: number }> | undefined)?.aggressive
      ?.keepRecentTokens as number | undefined) ?? 0,
   },
  };
  const oracles = applyOracles(observed);
  const damage = readJsonlTail<DamageTelemetryEntry>(damageReportsFile(), 10_000);
  const telemetry = buildPrivacySafeTelemetry(readMetricsLog(10_000), damage, {
   version: VERSION,
   minCanaryRuns: 5,
  });
  const preparation = (telemetry as { preparation?: unknown }).preparation;
  if (!F) assert.equal(attemptedFetches, 0, "Offline mode attempted network access (" + attemptedFetches + "): " + firstBlockedFetch);

  // Per-run receipts attribute summary-class transport requests to their
  // origin: foreground staging vs background preparation (used/discarded).
  const metricsAll = readMetricsLog(10_000);
  const preparationReceipts = metricsAll
   .filter((entry) => entry.preparation === "background")
   .map((entry) => ({
    runId: entry.runId ?? "",
    status: entry.status ?? "",
    reason: entry.preparationDiscardReason ?? null,
    calls: entry.totalCalls,
    input: entry.totalInput,
    output: entry.totalOutput,
    cacheHit: entry.totalCacheHit,
    cacheWrite: entry.totalCacheWrite ?? 0,
   }));
  const preparationFromReceipts = preparationReceipts.reduce(
   (sum, entry) => ({
    calls: sum.calls + entry.calls,
    input: sum.input + entry.input,
    output: sum.output + entry.output,
   }),
   { calls: 0, input: 0, output: 0 },
  );
  // Host-labelled warm usage entries are the receipt side of the warm class.
  interface SessionUsageEntry {
   type?: string;
   kind?: string;
   usage?: { input?: number; output?: number; cacheRead?: number };
  }
  const warmUsageEntries = [...sessionFiles].flatMap((file) => {
   // Full scan, not a tail read: usage entries are appended mid-file at warm
   // time and session files can dwarf any byte-based tail cap.
   const parsed: SessionUsageEntry[] = [];
   for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"cache_warm"')) continue;
    try {
     parsed.push(JSON.parse(line) as SessionUsageEntry);
    } catch {
     // Skip malformed/partial trailing lines.
    }
   }
   return parsed.filter((entry) => entry.type === "usage" && entry.kind === "cache_warm");
  });
  const mainRecords = state.requestLedger.filter((r) => r.usageClass === "main");
  const prefixPairs = mainRecords.slice(1).map((record, index) => ({
   fromPhase: mainRecords[index].phase,
   toPhase: record.phase,
   previousChars: record.previousMainChars ?? 0,
   commonPrefixChars: record.commonPrefixWithPrevious ?? 0,
  }));
  const prefixCharsTotal = prefixPairs.reduce((sum, pair) => sum + pair.commonPrefixChars, 0);
  const previousCharsTotal = prefixPairs.reduce((sum, pair) => sum + pair.previousChars, 0);

  return {
   arm,
   mode: F ? "live-semantic" : "offline-lifecycle",
   ok: oracles.every((o) => o.pass) && extensionErrors.length === 0,
   oracles,
   usage: F ? {}
    : {
     main: state.usageByClass.main,
     summary: state.usageByClass.summary,
     warm: state.usageByClass.warm,
     mainRequests: capture.mainRequests,
     summaryRequests: capture.summaryRequests,
     requestSizes: state.requestSizes,
     requestLedger: state.requestLedger,
     totals: {
      requests:
       state.usageByClass.main.requests +
       state.usageByClass.summary.requests +
       state.usageByClass.warm.requests,
      input:
       state.usageByClass.main.input +
       state.usageByClass.summary.input +
       state.usageByClass.warm.input,
      output:
       state.usageByClass.main.output +
       state.usageByClass.summary.output +
       state.usageByClass.warm.output,
      equation: "requests = main + summary + warm; summary = foreground staging + background preparation (receipts attribute it)",
     },
     preparation: {
      receipts: preparationReceipts,
      /** Every recorded run (any status), for reconciling the transport
       * ledger against run-level accounting. */
      allRuns: metricsAll.map((entry) => ({
       runId: entry.runId ?? "",
       status: entry.status ?? "",
       runType: entry.runType ?? "",
       preparation: entry.preparation ?? null,
       reason: entry.preparationDiscardReason ?? null,
       calls: entry.totalCalls,
       input: entry.totalInput,
       output: entry.totalOutput,
      })),
      fromReceipts: preparationFromReceipts,
      /** Summary-class requests that arrived outside any scripted window are
       * background work by construction; receipts are the authoritative split. */
      idleSummaryRequests: state.requestLedger.filter(
       (r) => r.usageClass === "summary" && !r.inScript,
      ).length,
      reconciliationDelta:
       state.usageByClass.summary.requests - preparationFromReceipts.calls,
      note:
       "reconciliationDelta = summary transport requests − receipt-attributed background calls; the remainder is foreground staging (stage-* phases). A ready candidate whose session is disposed without a shutdown event leaves no discard receipt; its cost stays in the transport ledger.",
     },
     warmEvidence: {
      records: state.warmRecords,
      hostUsageEntries: warmUsageEntries.length,
      hostUsageTokens: warmUsageEntries.reduce(
       (sum, entry) => sum + (entry.usage?.input ?? 0),
       0,
      ),
      allMatchWarmedRequest:
       state.warmRecords.length > 0 &&
       state.warmRecords.every((r) => r.matchesWarmedRequest && r.maxTokens === 1),
      fixture: {
       mode: args.cacheWarming,
       promptCacheTtlSeconds: 12,
       delayMs: 2_000,
       economics: "synthetic per-token rates (decision coverage only, not prices)",
      },
     },
     cachePrefix: {
      mainRequestPairs: prefixPairs.length,
      prefixCharsTotal,
      previousCharsTotal,
      prefixReuseRatio:
       previousCharsTotal === 0
        ? null
        : Number((prefixCharsTotal / previousCharsTotal).toFixed(4)),
      /** Real rewrites (compaction/trim boundaries): >256 chars changed.
       * Smaller deltas are counter digit jitter inside a stable prefix. */
      brokenPrefixPairs: prefixPairs.filter(
       (pair) => pair.previousChars - pair.commonPrefixChars > 256,
      ),
      minorJitterPairs: prefixPairs.filter(
       (pair) =>
        pair.commonPrefixChars < pair.previousChars &&
        pair.previousChars - pair.commonPrefixChars <= 256,
      ).length,
      warmMatches: state.warmRecords.filter((r) => r.matchesWarmedRequest).length,
     },
     compactionTrace,
     note: "Synthetic accounting drives host scheduling only; this is not billed usage. Warm/preparation fixtures are decision-coverage evidence, not savings claims. compactionTrace summary_request entries with inFlightCompactions>0 are fresh on-demand hook work inside a compaction request; inFlightCompactions===0 means the call originated outside any compaction request (background preparation).",
    },
   toolInteractions: toolRuns,
   retrieval: observed.retrieval,
   compactions: observed.compactions,
   memory: memoryAvailable
    ? `saved ref ${capture.memorySavedRef ?? "none"}; recall hit at ${capture.probes.filter((p) => p.memoryRecallHit).length}/${capture.probes.length} probes`
    : "unavailable: local project graph stays empty without compaction (policy consequence, not a failure)",
   context: {
    eventCounts: events.reduce<Record<string, number>>((counts, type) => {
     counts[type] = (counts[type] ?? 0) + 1;
     return counts;
    }, {}),
    deliveredCharsAtProbes: capture.probes.map((p) => ({ probe: p.probe, chars: p.deliveredChars })),
    usageAtCompactions,
    reopenContextUsage: session.getContextUsage(),
    grepPreviewHadFacts: capture.grepPreviewHadFacts,
    artifactRef: capture.artifactRef,
   },
   latencyMs: Date.now() - startedAt,
   policy: observed.policy,
   preparation,
   ...(F ? {} : { compactionTrace }),
   damageReports: damage.length,
   labels: F
    ? [
     "live-semantic",
     "real provider traffic on the selected model only",
     "budget-guarded",
     "independent behavioral oracles",
    ]
    : [
     "offline-lifecycle",
     "scripted local transport",
     "no quality claims about model decisions",
     "independent behavioral oracles",
     ...(args.backgroundPrep
      ? ["background-preparation fixture: speculative preparation on, per-arm apply gate; never changes which arms stage"]
      : []),
     ...(args.cacheWarming !== "off"
      ? [`cache-warming fixture (${args.cacheWarming}): 12s TTL, synthetic economics, real SDK warm replays; not savings proof`]
      : []),
    ],
  };
 } catch (error) {
  return {
   arm,
   mode: args.live ? "live-semantic" : "offline-lifecycle",
   ok: false,
   error: error instanceof Error ? error.message : String(error),
   oracles: [],
   usage: {},
   toolInteractions: toolRuns,
   retrieval: { smartContextSearch: liveRetrieval.search, smartContextRead: liveRetrieval.read, smartRecall: toolRuns["smart_recall"] ?? 0 },
   compactions: {
    staged: capture.stagedRuns.length, applied: capture.appliedRuns.length,
    receipts: readMetricsLog(200).filter((entry) => capture.appliedRuns.includes(entry.runId ?? ""))
     .map((entry) => ({ runId: entry.runId ?? "", status: entry.status })),
   },
   memory: `arm failed; saved ref ${capture.memorySavedRef ?? "none"}`,
   context: { phase: state.currentPhase, probes: capture.probes, usageAtCompactions },
   latencyMs: Date.now() - startedAt,
   policy: {
    minAutoTrimSavingChars: MIN_AUTO_TRIM_SAVING_CHARS,
    autoTrimCooldownTurns: AUTO_TRIM_COOLDOWN_TURNS,
    pendingTtlMs: 0,
    settledCooldownMs: SETTLED_TRIGGER_COOLDOWN_MS,
    keepRecentTokens: 0,
   },
   damageReports: 0,
   labels: ["arm-failed"],
  };
 } finally {
  try {
   try { session?.dispose(); } finally { sandbox?.dispose(); }
  } finally {
   resetLlmClient();
   globalThis.fetch = originalFetch;
   globalThis.WebSocket = originalWebSocket;
   for (const [key, value] of Object.entries(previous))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
   resetConfigCache();
   // Compact receipts live on in the report dir; scratch is discarded.
   fs.rmSync(scratch, { recursive: true, force: true });
  }
 }
}

// ── Live model resolution and guards ────────────────────────────────────────



function liveModelFor(runtime: ModelRuntime): Model<Api> {
 const label = args.models;
 const slash = label.indexOf("/");
 if (slash <= 0) throw new Error("--models must be provider/model");
 const provider = label.slice(0, slash);
 const modelId = label.slice(slash + 1);
 const model = runtime.getModel(provider, modelId);
 if (!model) throw new Error("Unavailable model: " + label);
 if (isChatGptCodex(model) && !args.acceptCodexSoftCap)
  throw new Error(
   `${label} is the ChatGPT/Codex route: providers reject wire output caps, so no hard output bound exists. ` +
   "Refusing by default. To run it as an explicitly unbounded live mode with a request budget, pass " +
   "--accept-codex-soft-cap; the report will label the cap as a soft visible-output watchdog, never hard.",
  );
 if (args.mainMaxTokens > model.maxTokens) throw new Error("Main output fixture exceeds the selected model limit");
 if (args.contextWindow > model.contextWindow) throw new Error("Context fixture exceeds the selected model window");
 return { ...model, maxTokens: args.mainMaxTokens, contextWindow: args.contextWindow || model.contextWindow };
}


// ── Orchestration ───────────────────────────────────────────────────────────

const reports: ArmReport[] = [];
let liveGuard: BudgetedFetch | undefined;
if (args.live) {
 liveGuard = createBudgetedFetch({
  realFetch: globalThis.fetch,
  budget: {
   requests: args.budgetRequests,
   inputTokens: args.budgetInputTokens,
   outputTokens: args.budgetOutputTokens,
  },
  getRequestClass: () => liveRequestClass.getStore() ?? "main",
  writeLedger: (ledger, records) => {
   fs.writeFileSync(path.join(args.out, "live-ledger.json"), JSON.stringify({ ...ledger, records }, null, 2));
  },
  unboundedOutput: args.acceptCodexSoftCap,
 });
}
for (const arm of args.arms) {
 console.error(`Running arm ${arm} (${args.live ? "live" : "offline"})…`);
 const firstRecord = liveGuard?.records.length ?? 0;
 const report = await runArm(arm, liveGuard);
 if (liveGuard) {
  await liveGuard.settle();
  report.usage = liveUsageReport(liveGuard, firstRecord);
 }
 reports.push(report);
}

const summary = {
 version: VERSION,
 mode: args.live ? "live-semantic" : "offline-lifecycle",
 repeats: args.repeats,
 historySizes: { round1: args.round1History, perRound: args.historyPerRound },
 fixtures: {
  liveModel: args.live ? args.models : null,
  summaryModel: args.live ? args.summaryModel || args.models : null,
  mainMaxTokens: args.live ? args.mainMaxTokens : null,
  contextWindow: args.live ? args.contextWindow || "native" : 200_000,
  cacheWarming: args.cacheWarming,
  backgroundPrep: args.backgroundPrep,
 },
 generatedAt: new Date().toISOString(),
 labels: args.live
  ? [
   "Live semantic evaluation on the selected provider; oracles are independent of model prose.",
   "No USD conversion: subscription unknown.",
   "Repeated test/bash calls are tool interactions, not damage.",
  ]
  : [
   "Offline lifecycle checks with a scripted local transport.",
   "No claims about live model decision quality; usage numbers are synthetic scheduling inputs.",
   "Repeated test/bash calls are tool interactions, not damage.",
   ...(args.backgroundPrep
    ? ["Background-preparation fixture on: totals include speculative (possibly unused) preparation calls, attributed per-run by receipts."]
    : []),
   ...(args.cacheWarming !== "off"
    ? [`Cache-warming fixture (${args.cacheWarming}) on: warm requests are real host-warmer SDK replays under synthetic economics; counted separately, no savings claim.`]
    : []),
  ],
 arms: reports,
};

fs.writeFileSync(path.join(args.out, "task-eval-report.json"), JSON.stringify(summary, null, 2));
for (const report of reports)
 if (!args.live && report.compactionTrace)
  fs.writeFileSync(
   path.join(args.out, "compaction-trace-" + report.arm + ".json"),
   JSON.stringify({ arm: report.arm, generatedAt: summary.generatedAt, trace: report.compactionTrace }, null, 2),
  );

if (args.json) console.log(JSON.stringify(summary, null, 2));
if (!args.json) {
 console.log(`# Task Eval — ${summary.mode} (repeats=${args.repeats})\n`);
 console.log(
  "| Arm | OK | Oracles | Reqs main/summary | Warm | Prep used/disc | Tot reqs | Tot in-tok | Prefix reuse | Compactions | Retr search/read+recall | Tool runs | Latency |",
 );
 console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
 for (const report of reports) {
  const passed = report.oracles.filter((o) => o.pass).length;
  const usage = report.usage as {
   main?: UsageClass;
   summary?: UsageClass;
   warm?: UsageClass;
   totals?: { requests: number; input: number };
   preparation?: { receipts?: Array<{ status: string }> };
   cachePrefix?: { prefixReuseRatio: number | null };
  };
  const prepReceipts = usage.preparation?.receipts ?? [];
  const prepUsed = prepReceipts.filter((r) => r.status === "success").length;
  const prepDiscarded = prepReceipts.filter((r) => r.status === "discarded").length;
  console.log(
   `| ${report.arm} | ${report.ok ? "PASS" : "FAIL"} | ${passed}/${report.oracles.length} | ` +
   `${usage.main?.requests ?? 0}/${usage.summary?.requests ?? 0} | ${usage.warm?.requests ?? 0} | ` +
   `${prepUsed}/${prepDiscarded} | ${usage.totals?.requests ?? 0} | ${usage.totals?.input ?? "unknown"} | ` +
   `${usage.cachePrefix?.prefixReuseRatio ?? "—"} | ${report.compactions.applied} | ` +
   `${report.retrieval.smartContextSearch}/${report.retrieval.smartContextRead + report.retrieval.smartRecall} | ` +
   `${Object.values(report.toolInteractions).reduce((a, b) => a + b, 0)} | ${report.latencyMs}ms |`,
  );
 }
 for (const report of reports) {
  console.log(`\n## ${report.arm}${report.error ? " — ERROR: " + report.error : ""}`);
  for (const oracle of report.oracles.filter((o) => !o.pass))
   console.log(`- FAIL ${oracle.id} (${oracle.checkClass}): ${oracle.detail}`);
 }
 console.log(`\nLabels: ${summary.labels.join(" ")}`);
 console.log(`Report: ${path.join(args.out, "task-eval-report.json")}`);
}

if (reports.some((report) => !report.ok)) process.exitCode = 1;
