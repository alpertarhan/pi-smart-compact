/** Full AgentSession pilot with scripted model transport and real tools/storage.
 * bun scripts/session-pilot.ts
 * Loads only Pi Continuity against this checkout's Pi host, with eager tool loading so
 * smart_navigation anchors/pivots are callable without a smart_tools load step.
 * No provider traffic, installed settings changes, or claims about model decision quality.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, Message, SimpleStreamOptions, ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import smartCompact from "../src/index.ts";
import { resetLlmClient, setLlmClient } from "../src/infra/llm-client.ts";
import { resetConfigCache } from "../src/utils/config.ts";
import { readMetricsLog } from "../src/utils/cache.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "smart-session-pilot-"));
const cwd = path.join(scratch, "project");
const agentDir = path.join(scratch, ".pi", "agent");
const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = agentDir;
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
 smartCompact: {
  toolLoading: "eager", autoTrigger: false, contextHygieneEnabled: true, artifactOffloadEnabled: true,
  minContextPercent: 0, mode: "fast", backupEnabled: false, contextGraphEnabled: false,
  requireApproval: false, zeroCallEnabled: false, summaryModel: "offline-pilot/summary",
  profiles: { aggressive: { keepRecentTokens: 6000, summaryBudgetTokens: 2000, singlePassMaxTokens: 100_000 } }
 },
}));
resetConfigCache();
const originalFetch = globalThis.fetch;
let attemptedFetches = 0;
globalThis.fetch = Object.assign(async () => { attemptedFetches++; throw new Error("Network disabled by offline session pilot"); }, { preconnect() { } });

const constraint = "NEVER_DROP_AUTH_CHECKS";
const failure = "PILOT_FAILURE_041";
const fileFact = "FILE_MIDDLE_REQUIRED";
const grepFact = "GREP_MIDDLE_REQUIRED";
const researchFact = "DISCARDED_RESEARCH_FINDING";
const archiveOnlyFact = "ARCHIVE_BODY_NOT_REQUESTED";
const detourFact = "PIVOT_DETOUR_ABANDONED";
const pivotCarryover = `PIVOT_CARRYOVER: detour abandoned; keep ${constraint}.`;
const report: Record<string, unknown> = { offline: true, scriptedModel: true, scope: "AgentSession.prompt/tools/compaction/persistent reopen; not autonomous model quality or provider billing" };
let session: AgentSession | undefined;
let frames: Array<(context: TranscriptContext) => AssistantMessage["content"]> = [];
let currentPhase = "startup";
let mainRequests = 0;
let summaryRequests = 0;
let serial = 0;
const extensionErrors: unknown[] = [];
const events: string[] = [];
const requestSizes: Array<{ phase: string; chars: number }> = [];
const text = (messages: readonly Message[]) => JSON.stringify(messages.map(message => ({ role: message.role, content: message.content })));
const tool = (context: TranscriptContext, name: string) => {
 const result = context.messages.findLast(message => message.role === "toolResult" && message.toolName === name);
 assert(result?.role === "toolResult", `No ${name} result in ${currentPhase}`);
 return result;
};
const toolText = (context: TranscriptContext, name: string) => tool(context, name).content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
const jsonResult = (context: TranscriptContext, name = "smart_context") => {
 try { return JSON.parse(toolText(context, name).replace(/^Historical[^\n]*\n/, "")); }
 catch (cause) { throw new Error(`Invalid ${name} JSON in ${currentPhase}`, { cause }); }
};
const call = (name: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id: "pilot-" + serial++, name, arguments: args });
const answer = (value = "Offline step complete."): AssistantMessage["content"] => [{ type: "text", text: value }];
let artifactRef = "";
let fileRef = "";
let researchRef = "";

function assertPairs(context: TranscriptContext) {
 const calls = new Set<string>();
 const results = new Set<string>();
 for (const message of context.messages) {
  if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
  if (message.role === "toolResult") {
   assert(calls.has(message.toolCallId), "Orphan result sent to provider: " + message.toolCallId);
   assert(!results.has(message.toolCallId), "Duplicate result sent to provider: " + message.toolCallId);
   results.add(message.toolCallId);
  }
 }
 assert.deepEqual([...calls].sort(), [...results].sort(), "Incomplete tool batch sent to provider");
}

const summary = () => `## Goal
Validate session continuity with minimal noise.
## Constraints & Preferences
- ${constraint}; do not remove authentication checks.
## Progress
### Done
- [x] Read the evidence, archived old output and recovered the required middle lines.
- [x] Context-only rewind retained the written side-effect.txt file.
### In Progress
- [ ] Resume after compaction and retrieve archived evidence.
### Blocked
- ${failure} is unresolved.
## Key Decisions
- Use recoverable references rather than rereading the current source files.
## Files Modified
- side-effect.txt
## Files Deleted
- None.
## Files Read
- source.txt
- research.txt
- AGENTS.md
## Next Steps
1. Retrieve ${artifactRef} and verify the unresolved failure.
## Critical Context
- ${constraint}
- ${failure}
- ${researchFact} was preserved in the research handoff.
## Topics Covered
- [critical] Context preservation and recovery.
`;

try {
 const host = await import("@earendil-works/pi-coding-agent");
 const stream = (model: Parameters<ExtensionAPI["setModel"]>[0], context: TranscriptContext, options?: SimpleStreamOptions) => {
  const output = createAssistantMessageEventStream();
  queueMicrotask(async () => {
   const message: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], stopReason: "pending", timestamp: Date.now(),
    usage: {
     input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
     cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
   };
   try {
    options?.signal?.throwIfAborted();
    await options?.onPayload?.({ messages: context.messages }, model);
    const input = text(context.messages);
    let content: AssistantMessage["content"];
    if (model.id === "summary") {
     summaryRequests++;
     assert(input.includes(constraint), "Summarizer never received the required constraint");
     assert(input.includes(failure), "Summarizer never received the unresolved failure");
     assert(!input.includes(archiveOnlyFact), "Compaction silently re-expanded an unrequested artifact body");
     content = answer(summary());
    } else {
     assertPairs(context);
     mainRequests++;
     requestSizes.push({ phase: currentPhase, chars: input.length });
     const next = frames.shift();
     assert(next, `Unexpected provider continuation in ${currentPhase}`);
     content = next(context);
    }
    // Synthetic accounting drives host scheduling only; this is not billed usage.
    message.usage.input = Math.ceil(input.length / 4);
    message.usage.output = Math.ceil(JSON.stringify(content).length / 4);
    message.usage.totalTokens = message.usage.input + message.usage.output;
    output.push({ type: "start", partial: message });
    for (const [index, block] of content.entries()) {
     if (block.type === "text") {
      message.content.push({ type: "text", text: "" });
      output.push({ type: "text_start", contentIndex: index, partial: message });
      message.content[index] = block;
      output.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: message });
      output.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
     } else if (block.type === "toolCall") {
      message.content.push({ ...block, arguments: {} });
      output.push({ type: "toolcall_start", contentIndex: index, partial: message });
      message.content[index] = block;
      output.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(block.arguments), partial: message });
      output.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
     }
    }
    message.stopReason = message.content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
    output.push({ type: "done", reason: message.stopReason, message });
   } catch (error) {
    message.stopReason = options?.signal?.aborted ? "aborted" : "error";
    message.errorMessage = error instanceof Error ? error.stack : String(error);
    output.push({ type: "error", reason: message.stopReason, error: message });
   } finally { output.end(); }
  });
  return output;
 };
 async function open(source?: string | SessionManager) {
  const runtime: ModelRuntime = await host.ModelRuntime.create({
   authPath: path.join(agentDir, "auth.json"),
   modelsPath: null, modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false
  });
  runtime.registerProvider("offline-pilot", {
   api: "offline-pilot-api", apiKey: "synthetic-not-a-secret", baseUrl: "https://offline.invalid",
   streamSimple: stream, models: ["reader", "summary"].map(id => ({
    id, name: "Offline " + id, reasoning: false, input: ["text"],
    contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
   }))
  });
  const model = runtime.getModel("offline-pilot", "reader");
  assert(model);
  // The ONLY EESV replacement is its external model transport. The whole EESV
  // pipeline still runs and resolves the offline route through the real registry.
  setLlmClient({ complete: (target, body, options) => runtime.completeSimple(target, body, options) });
  const settings = host.SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 8192, keepRecentTokens: 6000 }, retry: { enabled: false } });
  const loader = new host.DefaultResourceLoader({
   cwd, agentDir, settingsManager: settings,
   noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
   systemPrompt: "Offline integration pilot. Use the selected tools. All files are synthetic.", extensionFactories: [smartCompact]
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = typeof source === "string" ? host.SessionManager.open(source)
   : source ?? host.SessionManager.create(cwd, path.join(scratch, "sessions"));
  const created = await host.createAgentSession({
   cwd, agentDir, model, modelRuntime: runtime, settingsManager: settings,
   resourceLoader: loader, sessionManager: manager, thinkingLevel: "off",
   tools: ["read", "grep", "write", "bash", "smart_tools", "smart_navigation", "smart_context", "smart_compact"]
  });
  const active: AgentSession = created.session;
  await active.bindExtensions({
   onError: (error: unknown) => extensionErrors.push(error),
   commandContextActions: {
    waitForIdle: () => active.waitForIdle(), navigateTree: (target, options) => active.navigateTree(target, options),
    newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }),
    switchSession: async () => ({ cancelled: true }), reload: () => active.reload()
   }
  });
  active.subscribe(event => {
   events.push(event.type);
   if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
    extensionErrors.push(event.message.errorMessage);
   }
  });
  return active;
 }
 async function bounded<T>(task: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
   return await Promise.race([task, new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
     void session?.abort();
     reject(new Error(`Offline pilot timed out in ${currentPhase}`));
    }, 30_000);
   })]);
  } finally { if (timeout) clearTimeout(timeout); }
 }
 async function prompt(label: string, script: typeof frames, input = label) {
  assert(session);
  assert.equal(frames.length, 0);
  currentPhase = label;
  frames = [...script];
  await bounded(session.prompt(input));
  assert.equal(frames.length, 0, `Script did not complete: ${label}; ${JSON.stringify(extensionErrors)}`);
  assert.deepEqual(extensionErrors, []);
  assert(!session.isStreaming);
 }
 fs.writeFileSync(path.join(cwd, "source.txt"), Array.from({ length: 1500 }, (_, i) => i === 750 ? fileFact : `evidence: ordinary source row ${i}`).join("\n"));
 fs.writeFileSync(path.join(cwd, "grep.txt"), Array.from({ length: 1000 }, (_, i) => `evidence: ${i === 500 ? grepFact : i === 700 ? archiveOnlyFact : "ordinary grep row " + i}`).join("\n"));
 fs.writeFileSync(path.join(cwd, "research.txt"), "discardable research\n".repeat(300) + researchFact);
 fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Project constraint: " + constraint + "\n" + "ordinary policy\n".repeat(500));
 session = await open();
 fs.writeFileSync(path.join(cwd, "detour.txt"), "detour row\n".repeat(50) + detourFact);
 // Real Continuity pivot: anchor, take a detour, pivot back with carryover. Pi
 // applies it after the batch settles through the /smart-compact apply command.
 await prompt("pivot-with-carryover", [
  () => [call("smart_navigation", { action: "anchor", name: "pilot-start", summary: `Pilot start. ${constraint}.` })],
  context => { assert(toolText(context, "smart_navigation").includes("Anchor: pilot-start")); return [call("read", { path: "detour.txt" })]; },
  context => {
   assert(toolText(context, "read").includes(detourFact));
   return [call("smart_navigation", { action: "pivot", target: "pilot-start", carryover: pivotCarryover })];
  },
 ]);
 const callsBeforePivot = { main: mainRequests, summary: summaryRequests };
 const pivotSummary = () => session!.sessionManager.getBranch().find(entry => entry.type === "branch_summary" && entry.summary.includes(pivotCarryover));
 const pivotDeadline = Date.now() + 10_000;
 while (!pivotSummary() || session.isStreaming) {
  assert(Date.now() < pivotDeadline, "Queued pivot was not applied after the batch settled");
  await Bun.sleep(10);
 }
 assert.deepEqual({ main: mainRequests, summary: summaryRequests }, callsBeforePivot, "Pivot apply made a model call");
 assert.deepEqual(extensionErrors, []);
 await prompt("after-pivot", [context => {
  const delivered = text(context.messages);
  assert(delivered.includes(pivotCarryover), "Pivot carryover was not delivered to the next request");
  assert(delivered.includes("Anchor: pilot-start"), "Pivot target anchor left the delivered context");
  assert(!delivered.includes(detourFact), "Abandoned detour is still delivered after the pivot");
  return answer();
 }]);
 report.pivot = { anchorViaSmartNavigation: true, appliedAfterSettle: true, carryoverDelivered: true, detourDropped: true, noModelCallsDuringApply: true };
 console.log("PASS pivot-with-carryover");
 let beforeTrim = 0;
 let afterTrim = 0;
 const summariesBeforeHygiene = summaryRequests;
 await prompt("hygiene-and-retrieval", [
  () => [call("read", { path: "AGENTS.md" })],
  context => { assert(toolText(context, "read").includes(constraint)); return [call("bash", { command: `printf '${failure}\\n' >&2; exit 7` })]; },
  context => {
   assert(tool(context, "bash").isError);
   return [call("grep", { path: "grep.txt", pattern: "evidence", limit: 1000 })];
  },
  context => {
   const preview = toolText(context, "grep");
   assert(!preview.includes(grepFact) && !preview.includes(archiveOnlyFact));
   artifactRef = /artifact-[a-f0-9]{64}/.exec(preview)?.[0] ?? "";
   assert(artifactRef);
   // The Continuity anchor pins everything up to here; only later research is trimmable.
   return [call("smart_navigation", { action: "anchor", name: "evidence-collected", summary: `${constraint}; ${failure} unresolved.` })];
  },
  () => [call("read", { path: "source.txt" })],
  context => { assert(toolText(context, "read").includes(fileFact)); beforeTrim = text(context.messages).length; return [call("smart_context", { action: "status" })]; },
  () => [call("smart_context", { action: "status" })],
  () => [call("smart_context", { action: "status" })],
  () => [call("smart_context", { action: "status" })],
  context => {
   const projected = text(context.messages);
   afterTrim = projected.length;
   assert(projected.includes(constraint) && projected.includes(failure) && projected.includes(artifactRef));
   assert(!projected.includes(fileFact), "Post-anchor file was not automatically trimmed at the completed boundary");
   assert(afterTrim < beforeTrim, "Hygiene did not reduce delivered context");
   return [call("smart_context", { action: "search", query: fileFact })];
  },
  context => { const match = jsonResult(context).matches[0]; assert(match); fileRef = match.id; return [call("smart_context", { action: "read", id: fileRef, line: match.line, limit: 1 })]; },
  context => { assert(toolText(context, "smart_context").includes(fileFact)); return [call("smart_context", { action: "search", query: grepFact, id: artifactRef })]; },
  context => { const match = jsonResult(context).matches[0]; assert(match); return [call("smart_context", { action: "read", id: match.id, line: match.line, limit: 1 })]; },
  context => { assert(toolText(context, "smart_context").includes(grepFact)); return answer(); },
 ], `Inspect synthetic evidence. Requirement: ${constraint}. Preserve unresolved failures.`);
 assert.equal(summaryRequests, summariesBeforeHygiene, "Deterministic local hygiene started a model call");
 report.hygiene = {
  beforeTrimChars: beforeTrim, afterTrimChars: afterTrim, savedChars: beforeTrim - afterTrim,
  automaticBoundaryTrim: true, artifactSearchAndRead: true, instructionAndFailurePreserved: true,
  localOnlyNoModelCalls: true, agentToolAccessDisabledInSettings: true
 };
 console.log("PASS hygiene-and-retrieval");

 await prompt("checkpoint-rewind", [
  () => [call("smart_context", { action: "checkpoint", label: "bounded-research" })],
  () => [call("smart_context", { action: "status" })],
  context => { assert(jsonResult(context).checkpoint); return [call("read", { path: "research.txt" })]; },
  context => { assert(toolText(context, "read").includes(researchFact)); return [call("write", { path: "side-effect.txt", content: "SIDE_EFFECT_PRESERVED\n" }), call("bash", { command: `printf '${failure}\\n' >&2; exit 7` })]; },
  context => { assert(tool(context, "bash").isError); return [call("smart_context", { action: "rewind", report: `Finding: ${researchFact}. Keep ${constraint}; ${failure} is unresolved. side-effect.txt was written and must remain.` })]; },
  context => {
   assert(text(context.messages).includes("Research handoff"));
   assert(text(context.messages).includes(failure));
   assert(!context.messages.some(message => message.role === "toolResult" && message.toolName === "read" && JSON.stringify(message.content).includes(researchFact)));
   assert.equal(fs.readFileSync(path.join(cwd, "side-effect.txt"), "utf8"), "SIDE_EFFECT_PRESERVED\n");
   return [call("smart_context", { action: "search", query: researchFact })];
  },
  context => { const match = jsonResult(context).matches[0]; assert(match); researchRef = match.id; return [call("smart_context", { action: "read", id: researchRef, line: match.line, limit: 1 })]; },
  context => { assert(toolText(context, "smart_context").includes(researchFact)); return answer(); },
 ]);
 report.rewind = { checkpointAtRealBoundary: true, rawResearchRemoved: true, evidenceRetrievable: true, fileAndFailurePreserved: true };
 console.log("PASS checkpoint-rewind");

 // Paired independent continuation oracles: the same research is run with and
 // without a rewind. Each arm answers from what is actually delivered to the
 // scripted continuation request; oracle 1 checks report-derived continuity,
 // oracle 2 checks retrieval continuity, using different facts. Sizes and the
 // common prefix with the previous request are measured, not inferred.
 const oracleFactA = "ORACLE_REPORT_FACT_A";
 const oracleFactB = "ORACLE_RETRIEVAL_FACT_B";
 fs.writeFileSync(path.join(cwd, "oracle-research.txt"),
  `oracle raw evidence\n`.repeat(400) + `${oracleFactA}\n` + `oracle filler\n`.repeat(100) + `${oracleFactB}\n`);
 const deliveredChars: number[] = [];
 let previousDelivered = "";
 let commonPrefixAfterRewind = 0;
 const commonPrefix = (left: string, right: string) => {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index++;
  return index;
 };
 const rewindAnswers = ["Continuing from the handoff: the report decision stands.",
  "Retrieved the archived evidence and confirmed the second fact."];
 const controlAnswers = ["Continuing from the delivered research.", "Confirmed the second fact in the delivered research."];
 type OracleFrame = (context: TranscriptContext) => AssistantMessage["content"];
 const oracleFrames = (rewind: boolean): OracleFrame[] => [
  () => [call("smart_context", { action: "checkpoint", label: "oracle-checkpoint" })],
  () => [call("read", { path: "oracle-research.txt" })],
  context => {
   const delivered = text(context.messages);
   assert(delivered.includes(oracleFactA) && delivered.includes(oracleFactB), "Oracle research was not delivered before the rewind");
   deliveredChars.push(delivered.length);
   previousDelivered = delivered;
   return rewind
    ? [call("smart_context", { action: "rewind", report: `Decision: ${oracleFactA} adopted. ${constraint} retained; ${failure} unresolved. Next: continue.` })]
    : [call("smart_context", { action: "status" })];
  },
  // Oracle 1 — answer from what is actually delivered after the branch point.
  context => {
   const delivered = text(context.messages);
   deliveredChars.push(delivered.length);
   commonPrefixAfterRewind = commonPrefix(previousDelivered, delivered);
   assert(delivered.includes(constraint) && delivered.includes(failure));
   if (rewind) {
    assert(delivered.includes("Research handoff") && delivered.includes(oracleFactA), "Rewind report lost the carried decision");
    assert(!delivered.includes(oracleFactB), "Raw research should be archived after the rewind");
   } else {
    assert(delivered.includes(oracleFactA) && delivered.includes(oracleFactB));
   }
   return [...answer(rewind ? rewindAnswers[0] : controlAnswers[0]), call("smart_context", { action: "search", query: oracleFactB })];
  },
  // Oracle 2 — retrieval continuity after rewind; the control arm keeps raw evidence inline.
  ...(rewind ? [
   (context: TranscriptContext) => {
    const match = jsonResult(context).matches[0];
    assert(match, "Archived oracle evidence is not retrievable after rewind");
    return [call("smart_context", { action: "read", id: match.id, line: match.line, limit: 1 })];
   },
   (context: TranscriptContext) => {
    assert(toolText(context, "smart_context").includes(oracleFactB));
    return answer(rewindAnswers[1]);
   },
  ] : [
   (context: TranscriptContext) => {
    assert(text(context.messages).includes(oracleFactB), "Control arm lost the delivered raw research");
    return answer(controlAnswers[1]);
   },
  ]),
 ];
 const mainSessionFile = session!.sessionFile;
 await prompt("rewind-continuation-oracles", oracleFrames(true), `Research the oracle evidence. ${constraint}. ${failure} unresolved.`);
 const rewindDelivered = [...deliveredChars];
 const rewindCommonPrefix = commonPrefixAfterRewind;
 deliveredChars.length = 0;
 session!.dispose();
 const controlManager = host.SessionManager.create(cwd, path.join(scratch, "sessions-control"));
 session = await open(controlManager);
 await prompt("control-continuation-oracles", oracleFrames(false), `Research the oracle evidence. ${constraint}. ${failure} unresolved.`);
 const controlDelivered = [...deliveredChars];
 session!.dispose();
 session = await open(mainSessionFile);
 report.continuationOracles = {
  rewindDeliveredChars: rewindDelivered, controlDeliveredChars: controlDelivered,
  rewindReductionChars: rewindDelivered[0] - rewindDelivered[1],
  commonPrefixAfterRewindChars: rewindCommonPrefix,
  rewindDivergesAfterStablePrefix: rewindCommonPrefix < rewindDelivered[0],
  bothOraclesAnswered: true, controlKeepsRawResearch: true
 };
 console.log("PASS rewind-continuation-oracles");

 // Real SDK idle-command path: an extension command queues the manual trim with
 // no model call; the next natural prompt's completed boundary applies it.
 fs.writeFileSync(path.join(cwd, "manual.txt"), "manual cleanup evidence\n".repeat(600) + "MANUAL_TRIM_TARGET\n");
 await prompt("manual-trim-research", [
  () => [call("read", { path: "manual.txt" })],
  () => [call("smart_context", { action: "status" })],
  () => [call("smart_context", { action: "status" })],
  () => [call("smart_context", { action: "status" })],
  () => [call("smart_context", { action: "status" })],
  () => answer("Manual-cleanup research collected."),
 ], `Collect manual-cleanup research. ${constraint}.`);
 const callsBeforeCommand = { main: mainRequests, summary: summaryRequests };
 await bounded(session!.prompt("/smart-compact trim"));
 assert.equal(mainRequests, callsBeforeCommand.main, "Idle command dispatch made a model call");
 assert.equal(summaryRequests, callsBeforeCommand.summary, "Idle command dispatch made a summary call");
 await prompt("manual-trim-boundary", [
  context => {
   assert(text(context.messages).includes("MANUAL_TRIM_TARGET"), "First request after queueing must not be trimmed yet");
   return [call("smart_context", { action: "status" })];
  },
  context => {
   assert(!text(context.messages).includes("MANUAL_TRIM_TARGET"), "Manual trim did not apply at the natural boundary");
   return [call("smart_context", { action: "search", query: "MANUAL_TRIM_TARGET" })];
  },
  context => {
   const match = jsonResult(context).matches[0];
   assert(match, "Manually trimmed evidence is not retrievable");
   return [call("smart_context", { action: "read", id: match.id, line: match.line, limit: 1 })];
  },
  context => {
   assert(toolText(context, "smart_context").includes("MANUAL_TRIM_TARGET"));
   return answer("Manual trim applied at the boundary and recovered on demand.");
  },
 ], `Continue after manual cleanup. ${constraint}.`);
 report.manualTrim = {
  idleCommandQueued: true, commandMadeNoModelCalls: true,
  firstRequestNotYetTrimmed: true, appliedAtNaturalBoundary: true, evidenceRetrievable: true
 };
 console.log("PASS manual-trim-idle-command");
 // User observations cannot be artifact-offloaded. Enough history makes a real
 // EESV plan meaningful; generated usage remains a deterministic scheduling input.
 for (let i = 0; i < 32; i++) {
  await prompt("history-" + i, [() => answer("Observation recorded.")],
   `Observation ${i}: ${constraint}; ${failure} unresolved.\n` + "Synthetic observation, unchanged contract and reviewed behavior.\n".repeat(180));
  if (i === 15) {
   const usage = session.getContextUsage();
   const before = summaryRequests;
   await prompt("below-target-compaction", [() => [call("smart_compact", { mode: "fast" })], context => {
    assert(toolText(context, "smart_compact").includes("No summary was staged"));
    assert.equal(summaryRequests, before);
    return answer();
   }]);
   report.earlyCompaction = { usage, refusedWithoutSummaryCall: true };
  }
 }
 report.preparationInputUsage = session.getContextUsage();
 let stagedRun = "";
 await prompt("stage-compaction", [() => [call("smart_compact", { mode: "fast" })], context => {
  assert(toolText(context, "smart_compact").includes("staged, not applied"), toolText(context, "smart_compact"));
  const details = tool(context, "smart_compact").details;
  assert(details && typeof details === "object" && "runId" in details && typeof details.runId === "string");
  stagedRun = details.runId;
  return answer();
 }]);
 const summariesBeforeApply = summaryRequests;
 currentPhase = "native-apply";
 const applied = await bounded(session.compact());
 assert.equal((applied.details as { runId?: string })?.runId, stagedRun, "Native host did not apply the staged Smart Compact plan");
 assert.equal(summaryRequests, summariesBeforeApply, "Staged apply unexpectedly generated another summary");
 assert(readMetricsLog().some(entry => entry.runId === stagedRun && entry.status === "success"));
 const sessionFile = session.sessionFile;
 assert(sessionFile);
 session.dispose();
 session = await open(sessionFile);
 await prompt("reopen-and-continue", [context => {
  const projected = text(context.messages);
  assert(projected.includes(constraint) && projected.includes(failure));
  assert(projected.includes("summary") || projected.includes("Summary"));
  return [call("smart_context", { action: "search", query: grepFact, id: artifactRef })];
 }, context => {
  const match = jsonResult(context).matches[0]; assert(match);
  return [call("smart_context", { action: "read", id: match.id, line: match.line, limit: 1 })];
 }, context => { assert(toolText(context, "smart_context").includes(grepFact)); return answer("Reopened context continues with verified evidence."); }]);
 assert.equal(fs.readFileSync(path.join(cwd, "side-effect.txt"), "utf8"), "SIDE_EFFECT_PRESERVED\n");
 report.compaction = {
  stagedRun, correlatedHostApply: true, noSecondSummaryAtApply: true, freshSessionAndModelRuntime: true,
  persistedConstraintsAndFailure: true, artifactRetrievedAfterReopen: true,
  unrequestedArtifactBodyExcludedFromSummary: true, syntheticSummaryCalls: summaryRequests
 };
 console.log("PASS compaction-and-reopen");
 assert.equal(attemptedFetches, 0);
 assert.deepEqual(extensionErrors, []);
 report.execution = {
  mainRequests, summaryRequests, attemptedFetches, requests: requestSizes,
  toolExecutions: events.filter(type => type === "tool_execution_end").length,
  settled: events.filter(type => type === "agent_settled").length, paidRequests: 0
 };
 console.log(JSON.stringify(report, null, 2));
} finally {
 session?.dispose();
 resetLlmClient();
 globalThis.fetch = originalFetch;
 for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
 resetConfigCache();
 fs.rmSync(scratch, { recursive: true, force: true });
}
