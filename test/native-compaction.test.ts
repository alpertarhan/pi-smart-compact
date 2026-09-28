import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSmartCompact } from "../src/app/run-smart-compact.ts";
import {
 attemptNativeCompaction,
 CLAUDE_OAUTH_ADAPTER_HINT,
 createNativeReplayHook,
 nativeCompactionCut,
 resetNativeSkipWarningsForTests,
 shouldWarnNativeSkip,
 setNativeToolSource,
 setNativeTransportForTests,
} from "../src/app/native-compaction.ts";
import { createPendingSlot, revalidatePending } from "../src/app/pending-slot.ts";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import type { CompactConfig, PendingCompaction } from "../src/types.ts";
import { validateSmartCompactConfig } from "../src/utils/config.ts";
import { readMetricsLog } from "../src/utils/cache.ts";
import { formatCompactErrorForUi } from "../src/ui/error-format.ts";
import { notifyNativeText } from "../src/ui/overlays.ts";
import { recentIssues, resetIssuesForTests } from "../src/utils/issues.ts";
import type { NativeState } from "../src/infra/native-protocol.ts";
import { BudgetGuard } from "../src/infra/services.ts";
import { SecretScrubber } from "../src/domain/scrub.ts";
import { commitAppliedCompaction } from "../src/app/steps/persist.ts";
import { resetConfigCache } from "../src/utils/config.ts";

const originalHome = process.env.HOME;
const READ_TOOL = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } } as any;
beforeEach(() => {
 process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "psc-native-"));
 setNativeToolSource(() => [READ_TOOL]);
});
/** Fake provider for the next makeCtx: Pi's adapter (streamSimple) plus the network. */
let provider: ReturnType<typeof fakeProvider> | null = null;
function useProvider(fake: ReturnType<typeof fakeProvider>): ReturnType<typeof fakeProvider> {
 provider = fake;
 setNativeTransportForTests(fake.transport as typeof fetch);
 return fake;
}

afterEach(() => {
 provider = null;
 setNativeTransportForTests(undefined);
 setNativeToolSource(() => []);
 resetNativeSkipWarningsForTests();
 resetIssuesForTests();
 fs.rmSync(process.env.HOME!, { recursive: true, force: true });
 process.env.HOME = originalHome;
});

const MODEL = {
 provider: "anthropic",
 id: "claude-test",
 api: "anthropic-messages",
 baseUrl: "https://api.anthropic.test",
 contextWindow: 200_000,
 maxTokens: 8_192,
} as any;
const OPENAI = { ...MODEL, provider: "openai", id: "gpt-test", api: "openai-responses", baseUrl: "https://api.openai.test/v1" };
const CODEX = { ...MODEL, provider: "openai-codex", id: "gpt-codex-test", api: "openai-codex-responses", baseUrl: "https://chatgpt.test/backend-api" };
const SUMMARY = "Readable provider summary of the earlier conversation.";
const piSummary = (summary: string) =>
 "The conversation history before this point was compacted into the following summary:\n\n<summary>\n" + summary + "\n</summary>";

const filler = (label: string) => label + " " + "lorem ipsum dolor sit amet ".repeat(400);

function userEntry(id: string, parent: string | null, text: string) {
 return {
  type: "message",
  id,
  parentId: parent,
  timestamp: new Date(0).toISOString(),
  message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
 };
}

function assistantEntry(id: string, parent: string, text: string, toolCall = false) {
 return {
  type: "message",
  id,
  parentId: parent,
  timestamp: new Date(0).toISOString(),
  message: {
   role: "assistant",
   content: [
    { type: "text", text },
    ...(toolCall ? [{ type: "toolCall", id: "call-" + id, name: "read", arguments: {} }] : []),
   ],
   api: MODEL.api,
   provider: MODEL.provider,
   model: MODEL.id,
   usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
   stopReason: toolCall ? "toolUse" : "stop",
   timestamp: 0,
  },
 };
}

function toolResultEntry(id: string, parent: string, callOf: string) {
 return {
  type: "message",
  id,
  parentId: parent,
  timestamp: new Date(0).toISOString(),
  message: {
   role: "toolResult",
   toolCallId: "call-" + callOf,
   toolName: "read",
   content: [{ type: "text", text: filler("tool output") }],
   isError: false,
   timestamp: 0,
  },
 };
}

/** Ten complete user/assistant turns with large bodies. */
function conversation(turns = 10, prefix: any[] = []) {
 const branch: any[] = [...prefix];
 let parent: string | null = branch.at(-1)?.id ?? null;
 for (let turn = 0; turn < turns; turn++) {
  const u = userEntry("u" + turn, parent, filler("question " + turn));
  const a = assistantEntry("a" + turn, u.id, filler("answer " + turn));
  branch.push(u, a);
  parent = a.id;
 }
 return branch;
}

function makeCtx(branch: any[], options: { model?: any; confirm?: boolean; hasUI?: boolean; oauth?: boolean } = {}) {
 const notices: Array<{ message: string; type?: string }> = [];
 const compactCalls: any[] = [];
 const model = options.model ?? MODEL;
 const ctx: any = {
  cwd: process.env.HOME,
  hasUI: options.hasUI ?? true,
  model,
  ui: {
   notify: (message: string, type?: string) => notices.push({ message, type }),
   setStatus: () => { },
   setWidget: () => { },
   confirm: async () => options.confirm ?? true,
   custom: async () => undefined,
  },
  sessionManager: {
   getSessionId: () => "native-session",
   getBranch: () => branch,
   getEntries: () => branch,
  },
  modelRegistry: {
   getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-test": "1" } }),
   isUsingOAuth: () => options.oauth ?? false,
   streamSimple: (...args: [any, any, any]) => {
    if (!provider) throw new Error("no fake provider installed");
    return provider.streamSimple(...args);
   },
  },
  getSystemPrompt: () => "You are Pi.",
  getContextUsage: () => ({ tokens: 60_000, percent: 30, contextWindow: model.contextWindow }),
  compact: (callbacks: any) => compactCalls.push(callbacks),
 };
 return { ctx, notices, compactCalls };
}

/** Make EESV fail deterministically: its extraction re-reads the branch after windowing. */
function failEesvAfterWindow(harness: ReturnType<typeof makeCtx>): void {
 let reads = 0;
 const branch = harness.ctx.sessionManager.getBranch();
 harness.ctx.sessionManager.getBranch = () => {
  reads += 1;
  if (reads > 1) throw new Error("simulated EESV extraction failure");
  return branch;
 };
}

function config(overrides: Partial<CompactConfig> = {}): CompactConfig {
 return {
  ...(DEFAULT_CONFIG as unknown as CompactConfig),
  requireApproval: false,
  backupEnabled: false,
  contextGraphEnabled: false,
  visualArchiveEnabled: false,
  ...overrides,
 };
}

function textOf(content: unknown): string {
 if (typeof content === "string") return content;
 return (content as any[]).filter((block) => typeof block?.text === "string").map((block) => block.text).join("\n");
}

/** The ordinary request Pi's adapter would send for this route (what the wrapper receives). */
function ordinaryRequest(model: any, context: any): { url: string; init: RequestInit } {
 const messages = context.messages as any[];
 if (model.api === "anthropic-messages") {
  return {
   url: model.baseUrl + "/v1/messages",
   init: {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key", "anthropic-version": "2023-06-01", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
    body: JSON.stringify({
     model: model.id,
     max_tokens: 8192,
     stream: true,
     system: [{ type: "text", text: context.systemPrompt }],
     messages: messages.map((message) => ({ role: message.role, content: [{ type: "text", text: textOf(message.content) }] })),
     tools: context.tools.map((tool: any) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
    }),
   },
  };
 }
 return {
  url: model.baseUrl + (model.api === "openai-codex-responses" ? "/codex/responses" : "/responses"),
  init: {
   method: "POST",
   headers: { "content-type": "application/json", authorization: "Bearer test-token" },
   body: JSON.stringify({
    model: model.id,
    stream: true,
    instructions: context.systemPrompt,
    input: messages.map((message) =>
     message.role === "user"
      ? { role: "user", content: [{ type: "input_text", text: textOf(message.content) }] }
      : { type: "message", role: "assistant", content: [{ type: "output_text", text: textOf(message.content) }] },
    ),
    tools: context.tools.map((tool: any) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters })),
   }),
  },
 };
}

function compactionResponse(api: string, behaviour: string): Response {
 if (behaviour === "throw" || behaviour === "extra-usage") {
  const message = behaviour === "throw" ? "provider rejected compaction" : "You're out of extra usage";
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status: 400 });
 }
 const opaque = behaviour === "too-big" ? "x".repeat(2_000_000) : "opaque-state";
 if (api === "anthropic-messages") {
  return Response.json({
   content: [{ type: "compaction", content: behaviour === "too-big" ? opaque : SUMMARY, signature: "signed-state" }],
   stop_reason: "compaction",
   usage: { input_tokens: 0, output_tokens: 0, iterations: [{ input_tokens: 50_000, output_tokens: 900 }] },
  });
 }
 const usage = { input_tokens: 50_000, output_tokens: 900, input_tokens_details: { cached_tokens: 0 } };
 if (api === "openai-responses") {
  return Response.json({
   output: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "keep this request" }] },
    { type: "compaction", encrypted_content: opaque },
   ],
   usage,
  });
 }
 const events = [
  { type: "response.output_item.done", item: { type: "compaction", encrypted_content: opaque } },
  { type: behaviour === "incomplete" ? "response.incomplete" : "response.completed", response: { usage } },
 ];
 return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
  headers: { "content-type": "text/event-stream" },
 });
}

/**
 * Pi's adapter calls `options.fetch` once with the ordinary request, gets the wrapper's
 * 400 and ends the stream as an error; the transport is the provider behind the wrapper.
 */
function fakeProvider(
 behaviour: "ok" | "throw" | "too-big" | "no-request" | "extra-usage" | "incomplete" = "ok",
 onStream?: () => void,
) {
 const streamCalls: Array<{ model: any; context: any; options: any }> = [];
 const wire: Array<{ url: string; body: any; headers: Headers }> = [];
 const streamSimple = (model: any, context: any, options: any) => {
  streamCalls.push({ model, context, options });
  return {
   result: async () => {
    onStream?.();
    if (behaviour === "no-request") {
     return { role: "assistant", stopReason: "error", errorMessage: "No API key found for anthropic.\nUse /login", content: [] };
    }
    const { url, init } = ordinaryRequest(model, context);
    // Like pi-ai's providers: the caller's payload hook runs before the one request.
    let body = JSON.parse(String(init.body));
    try {
     body = (await options.onPayload?.(body, model)) ?? body;
    } catch (error) {
     return { role: "assistant", stopReason: "error", errorMessage: (error as Error).message, content: [] };
    }
    const response: Response = await options.fetch(url, { ...init, body: JSON.stringify(body) });
    return { role: "assistant", stopReason: "error", errorMessage: response.status + " " + (await response.text()), content: [] };
   },
  };
 };
 const transport = async (url: string, init: RequestInit) => {
  wire.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
  const api = url.includes("/codex/") ? "openai-codex-responses" : url.includes("/compact") ? "openai-responses" : "anthropic-messages";
  return compactionResponse(api, behaviour);
 };
 return { streamSimple, transport, streamCalls, wire };
}

async function run(
 branch: any[],
 engines: Array<"eesv" | "native">,
 options: { ctx?: any; skipCompact?: boolean; autoTriggered?: boolean; dryRun?: boolean; force?: boolean; extraConfig?: Partial<CompactConfig> } = {},
) {
 const harness = options.ctx ?? makeCtx(branch);
 const pendingRef = createPendingSlot({ ttlMs: 60_000 });
 const outcome = await runSmartCompact({
  ctx: harness.ctx,
  config: config({ compactionEngines: engines, ...options.extraConfig }),
  summaryModel: { ...MODEL, provider: "summarizer", id: "summary-route" },
  segModel: { ...MODEL, provider: "summarizer", id: "summary-route" },
  mode: "fast",
  pendingRef,
  isRunning: { value: false },
  force: options.force ?? true,
  skipCompact: options.skipCompact ?? true,
  autoTriggered: options.autoTriggered,
  dryRun: options.dryRun,
 });
 return { outcome, harness, pendingRef };
}

describe("native compaction cut boundary", () => {
 const entries = (branch: any[]) =>
  branch.map((entry) => ({ type: "message" as const, id: entry.id, message: entry.message }));

 it("keeps a user message after a completed assistant reply", () => {
  const msgs = entries(conversation(4));
  // keepFrom points at an assistant: move back to the previous user turn start.
  expect(nativeCompactionCut(msgs, 5)).toBe(4);
  expect(nativeCompactionCut(msgs, 6)).toBe(6);
 });

 it("never cuts after a tool call or inside a tool pair", () => {
  const branch = conversation(2);
  const u = userEntry("u9", "a1", "run a tool");
  const call = assistantEntry("a9", "u9", "calling", true);
  const result = toolResultEntry("t9", "a9", "a9");
  const final = assistantEntry("b9", "t9", "done");
  const next = userEntry("u10", "b9", "thanks");
  const msgs = entries([...branch, u, call, result, final, next]);
  // Index of "t9" (tool result) and "b9" are not user messages; "u10" follows a completed reply.
  expect(nativeCompactionCut(msgs, msgs.length - 1)).toBe(msgs.length - 1);
  expect(nativeCompactionCut(msgs, msgs.length - 2)).toBe(4);
 });

 it("refuses when no clean boundary exists", () => {
  const u = userEntry("u0", null, "hi");
  const call = assistantEntry("a0", "u0", "calling", true);
  const result = toolResultEntry("t0", "a0", "a0");
  expect(nativeCompactionCut(entries([u, call, result]), 2)).toBeNull();
 });
});

describe("native compaction engine", () => {
 it("skips native on an unsupported api and records the reason", async () => {
  const fake = useProvider(fakeProvider());
  const branch = conversation();
  const harness = makeCtx(branch, { model: { ...MODEL, api: "google-generative-ai" } });
  await expect(run(branch, ["native"], { ctx: harness })).rejects.toThrow(
   "native skipped (native compaction is not supported for api google-generative-ai)",
  );
  expect(fake.streamCalls).toHaveLength(0);
 });

 it("warns about a native skip once per session and route, but always on failure", async () => {
  useProvider(fakeProvider());
  const branch = conversation();
  const kimi = { ...MODEL, provider: "moonshot", id: "kimi-k2", api: "openai-completions" };
  const harness = makeCtx(branch, { model: kimi });
  const skipNotices = () =>
   harness.notices.filter((notice) => notice.message.startsWith("Native compaction skipped")).length;
  await run(branch, ["native", "eesv"], { ctx: harness });
  await run(branch, ["native", "eesv"], { ctx: harness });
  expect(skipNotices()).toBe(1);

  useProvider(fakeProvider("throw"));
  const failing = makeCtx(branch);
  await run(branch, ["native", "eesv"], { ctx: failing });
  await run(branch, ["native", "eesv"], { ctx: failing });
  expect(failing.notices.filter((notice) => notice.message.startsWith("Native compaction failed")).length).toBe(2);
 });

 it("classifies the run like EESV metrics: a tool run stays a tool run even when auto-triggered", async () => {
  useProvider(fakeProvider());
  const { outcome } = await run(conversation(), ["native"], { autoTriggered: true });
  expect(outcome.kind).toBe("staged");
  const snapshot = (outcome as { pending: PendingCompaction }).pending.metricsSnapshot!;
  expect(snapshot.runType).toBe("tool");
  expect(snapshot.avgLatency).toBe(snapshot.durationMs!);
 });

 it("stages Anthropic state in details.native through one nested Pi request", async () => {
  const fake = useProvider(fakeProvider());
  const branch = conversation();
  const { outcome, harness } = await run(branch, ["native", "eesv"], { extraConfig: { telemetryChannel: "canary" } });
  expect(outcome.kind).toBe("staged");
  const pending = (outcome as { pending: PendingCompaction }).pending;
  expect("native" in pending).toBe(false);
  expect(pending.details.native).toEqual({
   version: 1,
   api: "anthropic-messages",
   provider: MODEL.provider,
   model: MODEL.id,
   items: [{ type: "compaction", content: SUMMARY, signature: "signed-state" }],
  });
  expect(pending.summary).toBe(SUMMARY);
  expect(pending.details.method).toBe("native");
  expect(pending.details.model).toBe("anthropic/claude-test");
  expect(pending.details.verified).toBe(false);
  expect(pending.details.engineAttempts).toEqual([{ engine: "native", outcome: "applied" }]);
  expect(pending.metricsSnapshot).toMatchObject({
   method: "native", totalCalls: 1, totalInput: 50_000, totalOutput: 900,
   releaseChannel: "canary",
   providerRoutes: [expect.objectContaining({
    stage: "synthesize", provider: MODEL.provider, model: MODEL.id, calls: 1, successes: 1,
    inputTokens: 50_000, outputTokens: 900, usageBasis: "reported", billing: "api",
   })],
  });
  // Current session model, not the summarizer route; Pi's adapter owns auth.
  expect(fake.streamCalls).toHaveLength(1);
  const call = fake.streamCalls[0];
  expect(call.model.id).toBe("claude-test");
  expect(call.options).toMatchObject({ sessionId: "native-session", transport: "sse", maxRetries: 0 });
  expect(call.options.signal).toBeInstanceOf(AbortSignal);
  expect(call.context.systemPrompt).toBe("You are Pi.");
  expect(call.context.tools).toEqual([READ_TOOL]);
  // Exactly one real request: Pi's ordinary request rewritten into a compaction request.
  expect(fake.wire).toHaveLength(1);
  expect(fake.wire[0].url).toBe("https://api.anthropic.test/v1/messages");
  expect(fake.wire[0].body.compaction).toEqual({ type: "summarize" });
  expect(fake.wire[0].body.tools).toHaveLength(1);
  expect(fake.wire[0].headers.get("x-api-key")).toBe("test-key");
  // Prefix ends with a completed assistant reply; kept tail starts at a user message.
  const sent = call.context.messages;
  expect(sent.at(-1).role).toBe("assistant");
  const firstKept = branch.find((entry) => entry.id === pending.firstKeptEntryId);
  expect(firstKept.message.role).toBe("user");
  expect(sent.length).toBe(branch.findIndex((entry) => entry.id === pending.firstKeptEntryId));
  expect(harness.compactCalls).toHaveLength(0);
 });

 it("stages OpenAI Responses and Codex windows with the retained user messages as text", async () => {
  for (const model of [OPENAI, CODEX]) {
   const fake = useProvider(fakeProvider());
   const branch = conversation();
   const harness = makeCtx(branch, { model });
   const { outcome } = await run(branch, ["native"], { ctx: harness });
   const pending = (outcome as { pending: PendingCompaction }).pending;
   const state = pending.details.native!;
   expect(state).toMatchObject({ version: 1, api: model.api, provider: model.provider, model: model.id });
   expect(state.items.at(-1)).toEqual({ type: "compaction", encrypted_content: "opaque-state" });
   expect(pending.summary).toContain("encrypted " + model.provider + "/" + model.id + " state");
   expect(pending.details.nativeApi).toBe(model.api);
   expect(fake.wire).toHaveLength(1);
   if (model === OPENAI) expect(fake.wire[0].url).toBe("https://api.openai.test/v1/responses/compact");
   else expect(fake.wire[0].body.input.at(-1)).toEqual({ type: "compaction_trigger" });
   expect(fake.wire[0].headers.get("authorization")).toBe("Bearer test-token");
  }
 });

 it("reports Pi's own error literally when no request was sent", async () => {
  const fake = useProvider(fakeProvider("no-request"));
  const failure = await run(conversation(), ["native"]).catch((error) => error);
  expect(failure.message).toBe(
   "No compaction engine succeeded: native failed (No API key found for anthropic.). Conversation unchanged.",
  );
  expect(fake.wire).toHaveLength(0);
 });

 it("requests apply through Pi for manual runs", async () => {
  useProvider(fakeProvider());
  const branch = conversation();
  const { outcome, harness, pendingRef } = await run(branch, ["native"], { skipCompact: false });
  expect(outcome.kind).toBe("apply-requested");
  expect(harness.compactCalls).toHaveLength(1);
  expect(pendingRef.isPresent("native-session")).toBe(true);
  harness.compactCalls[0].onError(new Error("host refused"));
  expect(pendingRef.isPresent("native-session")).toBe(false);
  expect(harness.notices.at(-1)!.message).toContain("Native compaction (anthropic/claude-test) was not applied: host refused");
 });

 it("keeps a newer run's staged candidate when an older apply fails", async () => {
  useProvider(fakeProvider());
  const { harness, pendingRef } = await run(conversation(), ["native"], { skipCompact: false });
  const older = pendingRef.peek("native-session")!;
  pendingRef.set({ ...older, runId: "run-newer", details: { ...older.details, runId: "run-newer" } });
  harness.compactCalls[0].onError(new Error("host refused"));
  expect(pendingRef.peek("native-session")?.runId).toBe("run-newer");
 });

 it("evicts only the oldest skip warning at capacity", () => {
  for (let index = 0; index < 500; index++) expect(shouldWarnNativeSkip("s" + index, "route")).toBe(true);
  expect(shouldWarnNativeSkip("s-new", "route")).toBe(true);
  expect(shouldWarnNativeSkip("s1", "route")).toBe(false);
  expect(shouldWarnNativeSkip("s0", "route")).toBe(true);
 });

 it("asks for approval naming the native engine and cancels when declined", async () => {
  useProvider(fakeProvider());
  const branch = conversation();
  const harness = makeCtx(branch, { confirm: false });
  const { outcome } = await run(branch, ["native"], {
   ctx: harness,
   skipCompact: false,
   extraConfig: { requireApproval: true },
  });
  expect(outcome).toEqual({ kind: "cancelled", source: "user" });
  expect(harness.compactCalls).toHaveLength(0);
  // The provider call happened; a declined run is recorded like a declined EESV run.
  expect(readMetricsLog().map((entry) => [entry.sessionId, entry.method, entry.status, entry.totalCalls]))
   .toEqual([["native-session", "native", "cancelled", 1]]);
 });

 it("does not apply an incomplete Codex response even after a compaction item and usage arrive", async () => {
  const fake = useProvider(fakeProvider("incomplete"));
  const branch = conversation();
  const before = structuredClone(branch);
  const harness = makeCtx(branch, { model: CODEX });
  const failure = await run(branch, ["native"], { ctx: harness, skipCompact: false }).catch((error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(harness.compactCalls).toHaveLength(0);
  expect(branch).toEqual(before);
  expect(fake.wire).toHaveLength(1);
 });

 it("fails without applying when the provider rejects, sending exactly one request", async () => {
  const fake = useProvider(fakeProvider("throw"));
  const failure = await run(conversation(), ["native"]).catch((error) => error);
  expect(failure.message).toBe(
   "No compaction engine succeeded: native failed (400 invalid_request_error: provider rejected compaction). Conversation unchanged.",
  );
  expect(formatCompactErrorForUi(failure)).toBe(failure.message);
  expect(fake.wire).toHaveLength(1);
 });

 it("adds the Toolkit adapter hint to an Anthropic OAuth 'extra usage' rejection only", async () => {
  useProvider(fakeProvider("extra-usage"));
  const branch = conversation();
  const oauth = await run(branch, ["native"], { ctx: makeCtx(branch, { oauth: true }) }).catch((error) => error);
  expect(oauth.message).toContain(
   "native failed (400 invalid_request_error: You're out of extra usage " + CLAUDE_OAUTH_ADAPTER_HINT + ")",
  );
  useProvider(fakeProvider("extra-usage"));
  const apiKey = await run(branch, ["native"], { ctx: makeCtx(branch, { oauth: false }) }).catch((error) => error);
  expect(apiKey.message).not.toContain("pi-toolkit");
 });

 it("rejects results that are not smaller than the prefix", async () => {
  useProvider(fakeProvider("too-big"));
  await expect(run(conversation(), ["native"])).rejects.toThrow(/is not smaller than the compacted prefix/);
 });

 it("falls back to EESV after a native failure and reports both outcomes", async () => {
  useProvider(fakeProvider("throw"));
  const branch = conversation();
  const harness = makeCtx(branch);
  const { outcome } = await run(branch, ["native", "eesv"], { ctx: harness });
  expect(outcome.kind).toBe("staged");
  const pending = (outcome as { pending: PendingCompaction }).pending;
  expect(pending.details.native).toBeUndefined();
  expect(pending.details.method).not.toBe("native");
  const reason = "400 invalid_request_error: provider rejected compaction";
  expect(pending.details.engineAttempts).toEqual([
   { engine: "native", outcome: "failed", reason },
   { engine: "eesv", outcome: "applied" },
  ]);
  expect(harness.notices.some((notice) => notice.message === "Native compaction failed: " + reason)).toBe(true);
 });

 it("falls back to native after EESV fails when ordered eesv → native", async () => {
  const fake = useProvider(fakeProvider());
  const branch = conversation();
  const harness = makeCtx(branch);
  failEesvAfterWindow(harness);
  const { outcome } = await run(branch, ["eesv", "native"], { ctx: harness });
  expect(outcome.kind).toBe("staged");
  const pending = (outcome as { pending: PendingCompaction }).pending;
  expect(pending.details.engineAttempts?.[0]).toEqual({ engine: "eesv", outcome: "failed", reason: "simulated EESV extraction failure" });
  expect(harness.notices.some((notice) => notice.message.startsWith("EESV did not apply ("))).toBe(true);
  expect(pending.details.engineAttempts?.at(-1)).toEqual({ engine: "native", outcome: "applied" });
  expect(fake.wire).toHaveLength(1);
 });

 it("reports every outcome and applies nothing when all engines fail", async () => {
  useProvider(fakeProvider("throw"));
  const branch = conversation();
  const harness = makeCtx(branch);
  failEesvAfterWindow(harness);
  const failure = await run(branch, ["eesv", "native"], { ctx: harness }).catch((error) => error);
  expect(failure.message).toMatch(/^No compaction engine succeeded: EESV failed \(simulated EESV extraction failure\); native failed \(400 invalid_request_error: provider rejected compaction\)\. Conversation unchanged\.$/);
  expect(harness.compactCalls).toHaveLength(0);
 });

 const priorCompaction = (native?: NativeState) => ({
  type: "compaction",
  id: "c0",
  parentId: null,
  timestamp: new Date(0).toISOString(),
  summary: "PRIOR NATIVE SUMMARY",
  firstKeptEntryId: "u0",
  tokensBefore: 100_000,
  ...(native ? { details: { method: "native", native } } : {}),
 });
 const PRIOR_STATE: NativeState = {
  version: 1, api: "anthropic-messages", provider: MODEL.provider, model: MODEL.id,
  items: [{ type: "compaction", content: "PRIOR BLOCK", signature: "signed-state" }],
 };

 it("builds on a prior native compaction of the same route", async () => {
  const fake = useProvider(fakeProvider());
  const branch = conversation(10, [priorCompaction(PRIOR_STATE)]);
  branch[1].parentId = "c0";
  await run(branch, ["native"]);
  const sent = fake.wire[0].body.messages;
  expect(sent[0]).toEqual({ role: "assistant", content: PRIOR_STATE.items });
  expect(JSON.stringify(sent)).not.toContain("PRIOR NATIVE SUMMARY");
 });

 it("lets a provider override normalize the final payload after the prior block is replayed", async () => {
  const fake = useProvider(fakeProvider());
  const branch = conversation(10, [priorCompaction(PRIOR_STATE)]);
  branch[1].parentId = "c0";
  const harness = makeCtx(branch, { oauth: true });
  const stock = harness.ctx.modelRegistry.streamSimple;
  // A registered provider override (e.g. a subscription adapter) chains the caller's hook first.
  harness.ctx.modelRegistry.streamSimple = (model: any, context: any, options: any) => stock(model, context, {
   ...options,
   onPayload: async (payload: any, requestModel: any) => {
    const next = (await options.onPayload?.(payload, requestModel)) ?? payload;
    return { ...next, billing: "first:" + next.messages[0].role };
   },
  });
  await run(branch, ["native"], { ctx: harness });
  expect(fake.wire).toHaveLength(1);
  expect(fake.wire[0].body.billing).toBe("first:assistant");
  expect(fake.wire[0].body.messages[0]).toEqual({ role: "assistant", content: PRIOR_STATE.items });
  expect(fake.wire[0].body.compaction).toMatchObject({ type: "summarize" });
 });

 it("sends nothing when the prior native state cannot be replayed into Pi's request", async () => {
  const fake = useProvider(fakeProvider());
  const branch = conversation(10, [priorCompaction(PRIOR_STATE)]);
  branch[1].parentId = "c0";
  const harness = makeCtx(branch);
  const stock = harness.ctx.modelRegistry.streamSimple;
  // The request no longer carries the prior summary the native block stands in for.
  harness.ctx.modelRegistry.streamSimple = (model: any, context: any, options: any) =>
   stock(model, { ...context, messages: context.messages.slice(1) }, options);
  const failure = await run(branch, ["native"], { ctx: harness }).catch((error) => error);
  expect(failure.message).toContain("Prior native compaction state could not be replayed; no request was sent");
  expect(fake.wire).toHaveLength(0);
 });

 it("sends the prior summary as text when it has no native state for this route", async () => {
  for (const prior of [priorCompaction(), priorCompaction({ ...PRIOR_STATE, model: "other-model" })]) {
   const fake = useProvider(fakeProvider());
   const branch = conversation(10, [prior]);
   branch[1].parentId = "c0";
   await run(branch, ["native"]);
   const sent = JSON.stringify(fake.wire[0].body.messages);
   expect(sent).toContain("PRIOR NATIVE SUMMARY");
   expect(sent).not.toContain("PRIOR BLOCK");
  }
 });

 it("invalidates a staged native candidate when the route changes", async () => {
  useProvider(fakeProvider());
  const branch = conversation();
  const { outcome, harness } = await run(branch, ["native"]);
  const pending = (outcome as { pending: PendingCompaction }).pending;
  expect(revalidatePending(pending, harness.ctx)).not.toBeNull();
  const switched = { ...harness.ctx, model: OPENAI };
  expect(revalidatePending(pending, switched)).toBeNull();
 });

 it("dry-run calls native once and stages nothing", async () => {
  const fake = useProvider(fakeProvider());
  const { outcome, pendingRef } = await run(conversation(), ["native"], { dryRun: true });
  expect(outcome.kind).toBe("dry-run");
  expect(pendingRef.isPresent("native-session")).toBe(false);
  expect(fake.wire).toHaveLength(1);
  expect(readMetricsLog().map((entry) => [entry.sessionId, entry.method, entry.status, entry.totalCalls]))
   .toEqual([["native-session", "native", "dry-run", 1]]);
 });
});

describe("native replay hook (before_provider_request)", () => {
 const STATE: NativeState = {
  version: 1, api: "anthropic-messages", provider: MODEL.provider, model: MODEL.id,
  items: [{ type: "compaction", content: "BLOCK", signature: "signed-state" }],
 };
 const compaction = (id: string, native?: NativeState) => ({
  type: "compaction", id, summary: "S-" + id, firstKeptEntryId: "u1", tokensBefore: 1,
  details: native ? { method: "native", native } : { method: "eesv" },
 });
 const anthropicPayload = (summary: string) => ({
  model: MODEL.id,
  messages: [
   { role: "user", content: [{ type: "text", text: piSummary(summary) }] },
   { role: "user", content: [{ type: "text", text: "next" }] },
  ],
 });
 function replayCtx(entries: any[], model: any = MODEL) {
  const notices: Array<{ message: string; type?: string }> = [];
  let branchReads = 0;
  const ctx = {
   model,
   hasUI: true,
   ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
   sessionManager: {
    getSessionId: () => "replay-session",
    getEntries: () => entries,
    getBranch: () => { branchReads += 1; return entries; },
   },
  };
  return { ctx, notices, branchReads: () => branchReads };
 }

 it("replays the latest native state on the same route", () => {
  const hook = createNativeReplayHook();
  const { ctx } = replayCtx([compaction("c1", STATE)]);
  hook.refresh(ctx);
  const payload = anthropicPayload("S-c1");
  const replayed = hook.handle(payload, ctx) as any;
  expect(replayed.messages[0]).toEqual({ role: "assistant", content: STATE.items });
  expect(JSON.stringify(replayed)).not.toContain("S-c1");
  expect(replayed.betas).toContain("compact-2026-09-04");
  expect(payload.messages[0].role).toBe("user"); // original untouched
 });

 it("does nothing on a model mismatch", () => {
  const hook = createNativeReplayHook();
  const { ctx } = replayCtx([compaction("c1", STATE)], { ...MODEL, id: "claude-other" });
  hook.refresh(ctx);
  expect(hook.handle(anthropicPayload("S-c1"), ctx)).toBeUndefined();
 });

 it("does no work at all when the session has no native state", () => {
  const hook = createNativeReplayHook();
  const probe = replayCtx([compaction("c1")]);
  hook.refresh(probe.ctx);
  expect(hook.handle(anthropicPayload("S-c1"), probe.ctx)).toBeUndefined();
  expect(probe.branchReads()).toBe(0);
 });

 it("does nothing when the latest compaction on the branch is EESV", () => {
  const hook = createNativeReplayHook();
  const { ctx, notices } = replayCtx([compaction("c1", STATE), compaction("c2")]);
  hook.refresh(ctx);
  expect(hook.handle(anthropicPayload("S-c2"), ctx)).toBeUndefined();
  expect(notices).toEqual([]);
 });

 it("warns once per entry on OpenAI routes when replay is impossible; Anthropic is record-only", () => {
  const openai: NativeState = { version: 1, api: "openai-responses", provider: OPENAI.provider, model: OPENAI.id, items: [{ type: "compaction", encrypted_content: "e" }] };
  const hook = createNativeReplayHook();
  const oa = replayCtx([compaction("c1", openai)], OPENAI);
  hook.refresh(oa.ctx);
  const unrelated = { model: OPENAI.id, input: [{ role: "user", content: [{ type: "input_text", text: "no summary here" }] }] };
  expect(hook.handle(unrelated, oa.ctx)).toBeUndefined();
  expect(hook.handle(unrelated, oa.ctx)).toBeUndefined();
  expect(oa.notices).toHaveLength(1);
  expect(oa.notices[0].type).toBe("warning");
  expect(oa.notices[0].message).toContain("gpt-test sees only the retained user messages");

  const an = replayCtx([compaction("c9", STATE)]);
  hook.refresh(an.ctx);
  expect(hook.handle({ messages: [{ role: "user", content: "no summary" }] }, an.ctx)).toBeUndefined();
  expect(an.notices).toEqual([]);
  expect(recentIssues().some((issue) => issue.key === "native.replay:c9")).toBe(true);
 });

 it("replays OpenAI windows in place of the summary message", () => {
  const openai: NativeState = { version: 1, api: "openai-responses", provider: OPENAI.provider, model: OPENAI.id, items: [{ type: "compaction", encrypted_content: "e" }] };
  const hook = createNativeReplayHook();
  const { ctx } = replayCtx([compaction("c1", openai)], OPENAI);
  hook.refresh(ctx);
  const replayed = hook.handle({
   model: OPENAI.id,
   input: [
    { role: "developer", content: "sys" },
    { role: "user", content: [{ type: "input_text", text: piSummary("S-c1") }] },
    { role: "user", content: [{ type: "input_text", text: "next" }] },
   ],
  }, ctx) as any;
  expect(replayed.input.map((item: any) => item.type ?? item.role)).toEqual(["developer", "compaction", "user"]);
 });
});

describe("compactionEngines config", () => {
 it("accepts ordered unique non-empty lists and drops everything else", () => {
  for (const valid of [["eesv"], ["native"], ["native", "eesv"], ["eesv", "native"]]) {
   const sc: Record<string, unknown> = { compactionEngines: valid };
   validateSmartCompactConfig(sc);
   expect(sc.compactionEngines).toEqual(valid);
  }
  for (const invalid of [[], ["eesv", "eesv"], ["native", "other"], "native", null]) {
   const sc: Record<string, unknown> = { compactionEngines: invalid };
   validateSmartCompactConfig(sc);
   expect("compactionEngines" in sc).toBe(false);
  }
  expect(DEFAULT_CONFIG.compactionEngines).toEqual(["eesv"]);
 });
});

describe("native wording", () => {
 it("describes the native cut in the manual override warning, without EESV verification claims", async () => {
  useProvider(fakeProvider());
  const branch = conversation();
  const harness = makeCtx(branch);
  await run(branch, ["native", "eesv"], {
   ctx: harness,
   extraConfig: { minContextPercent: 90 },
  });
  const warning = harness.notices.find((notice) => notice.message.startsWith("Manual compaction override"))!;
  expect(warning.message).toContain("with native compaction (anthropic/claude-test)");
  expect(warning.message).toContain("native state is not EESV-verified");
  expect(warning.message).not.toContain("fail-closed");

  const eesv = makeCtx(branch);
  await run(branch, ["eesv", "native"], { ctx: eesv, extraConfig: { minContextPercent: 90 } });
  const eesvWarning = eesv.notices.find((notice) => notice.message.startsWith("Manual compaction override"))!;
  expect(eesvWarning.message).toContain("verification remains fail-closed");
  expect(eesvWarning.message).not.toContain("native");
 });

 it("uses the native cut's token split, not the EESV plan", async () => {
  useProvider(fakeProvider());
  const branch = conversation();
  const harness = makeCtx(branch);
  const { outcome } = await run(branch, ["native"], { ctx: harness, extraConfig: { minContextPercent: 90 } });
  const pending = (outcome as { pending: PendingCompaction }).pending;
  const warning = harness.notices.find((notice) => notice.message.startsWith("Manual compaction override"))!;
  const kept = pending.details.retainedTailTokens!;
  expect(warning.message).toContain("preserving " + kept.toLocaleString() + "t");
 });

 it("tells OpenAI users the summary is readable only by the same model", () => {
  const base = {
   method: "native",
   model: "openai-codex/gpt-5.4",
   tokensBefore: 100_000,
   estimatedAfterTokens: 20_000,
   tokensSaved: 80_000,
  } as any;
  for (const api of ["openai-codex-responses", "openai-responses"]) {
   expect(notifyNativeText({ ...base, nativeApi: api })).toEndWith(
    "Other models see only the retained user messages; switch back to openai-codex/gpt-5.4 to use the summary.",
   );
  }
  const anthropic = notifyNativeText({ ...base, model: "anthropic/claude-test", nativeApi: "anthropic-messages" });
  expect(anthropic).not.toContain("Other models");
  expect(anthropic).toEndWith("not EESV-verified");
 });

 it("records the native api on applied details", async () => {
  useProvider(fakeProvider());
  const { outcome } = await run(conversation(), ["native"]);
  expect((outcome as { pending: PendingCompaction }).pending.details.nativeApi).toBe("anthropic-messages");
 });
});

describe("late run notices", () => {
 it("drops run notices after the user switched sessions", async () => {
  const branch = conversation();
  const harness = makeCtx(branch);
  let sessionId = "native-session";
  harness.ctx.sessionManager.getSessionId = () => sessionId;
  useProvider(fakeProvider("throw", () => {
   sessionId = "next-session"; // user switched while the provider call ran
  }));
  await run(branch, ["native"], { ctx: harness }).catch(() => undefined);
  expect(harness.notices.filter((notice) => notice.message.startsWith("Native compaction failed"))).toEqual([]);
 });
});

describe("native attempt accounting", () => {
 const estimator = { message: (message: unknown) => Math.ceil(JSON.stringify(message).length / 4) };
 /** A windowed run context around the fake Pi, with Pi's measured context set explicitly. */
 function windowed(branch: any[], budget: BudgetGuard, extraTokens = 0) {
  const harness = makeCtx(branch);
  const msgs = branch.map((entry) => ({ type: "message", id: entry.id, message: entry.message }));
  const totalEstimate = msgs.reduce((sum, entry) => sum + estimator.message(entry.message), 0);
  const rc = {
   ctx: harness.ctx, msgs, branch, keepFrom: msgs.length - 4, estimator,
   services: { budget, scrubber: new SecretScrubber() },
   cancellation: { signal: new AbortController().signal },
   sessionId: "native-session", totalTokens: totalEstimate + extraTokens, runId: "run-direct",
   profile: "aggressive", mode: "fast", readerSignature: "sig", config: config(),
   pipelineStart: Date.now(), flags: { skipCompact: true }, contextPercent: 30, notify: () => { },
  } as any;
  return { rc, totalEstimate };
 }

 it("refuses without sending when the provider-call budget is exhausted", async () => {
  const fake = useProvider(fakeProvider());
  const budget = new BudgetGuard(1);
  budget.reserveCall();
  const result = await attemptNativeCompaction(windowed(conversation(), budget).rc, []);
  expect(result).toMatchObject({ outcome: "failed", reason: expect.stringContaining("provider-call budget exhausted") });
  expect(fake.streamCalls).toHaveLength(0);
  expect(fake.wire).toHaveLength(0);
 });

 it("reconciles the budget to the provider's reported usage", async () => {
  useProvider(fakeProvider());
  const budget = new BudgetGuard(3, 0, undefined, 100_000, 20_000);
  const result = await attemptNativeCompaction(windowed(conversation(), budget).rc, []);
  expect(result.outcome).toBe("staged");
  expect(budget.callCount()).toBe(1);
  expect(budget.inputTokenCount()).toBe(50_000);
  expect(budget.outputTokenCount()).toBe(900);
  expect(budget.remainingOutputTokens()).toBe(20_000 - 900);
 });

 it("estimates the after-context as fixed context + retained tail + native state", async () => {
  useProvider(fakeProvider());
  const fixed = 10_000;
  const { rc, totalEstimate } = windowed(conversation(), new BudgetGuard(), fixed);
  const result = await attemptNativeCompaction(rc, []);
  if (result.outcome !== "staged") throw new Error(result.reason);
  const details = result.pending.details;
  const kept = details.retainedTailTokens! + details.summaryTokens!;
  expect(details.estimatedAfterTokens).toBe(fixed + kept);
  // The proportional scale spreads fixed context over messages and understates the rest.
  expect(details.estimatedAfterTokens!).toBeGreaterThan(Math.round(kept * (totalEstimate + fixed) / totalEstimate));
 });

 it("stages the EESV conversation backup and writes it once the compaction is committed", async () => {
  const backupDir = path.join(process.env.HOME!, "backups");
  fs.mkdirSync(path.join(process.env.HOME!, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME!, ".pi", "agent", "settings.json"), JSON.stringify({ smartCompact: { backupEnabled: true, backupDir } }));
  resetConfigCache();
  try {
   useProvider(fakeProvider());
   const { outcome } = await run(conversation(), ["native"], { extraConfig: { backupEnabled: true } });
   const pending = (outcome as { pending: PendingCompaction }).pending;
   expect(pending.details.backupPath).toStartWith(backupDir);
   expect(fs.existsSync(pending.details.backupPath!)).toBe(false);
   expect(await commitAppliedCompaction(pending)).toEqual([]);
   const backup = fs.readFileSync(pending.details.backupPath!, "utf8");
   expect(backup).toStartWith("# Smart Compact Backup\n");
   expect(backup).toContain("question 0");
   // Only the compacted prefix: the kept tail is still in the conversation.
   expect(backup).not.toContain("question 9");
  } finally {
   resetConfigCache();
  }
 });
});
