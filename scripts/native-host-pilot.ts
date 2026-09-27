/**
 * Native-compaction pilot on stock Pi: this Continuity checkout and an explicitly
 * supplied standalone Claude OAuth adapter, driven through real AgentSessions.
 *
 *   node scripts/native-host-pilot.ts                      # offline: scripted provider fake
 *   PSC_NATIVE_LIVE=1 node scripts/native-host-pilot.ts    # real requests, ledger-capped
 *
 * PSC_NATIVE_ROUTES picks routes (default: all offline; the two subscription routes live). Live
 * mode copies the needed OAuth credentials from ~/.pi/agent/auth.json into a private temporary
 * HOME that is deleted afterwards, refuses to run when a token is close to expiry (a refresh would
 * rotate the real refresh token), and counts every provider request in the ledger against the
 * approved budget.
 *
 * Other switches: PSC_PILOT_SHORT=1 (six requests per route: no re-compaction or model switch),
 * PSC_CLAUDE_OAUTH_EXTENSION=<adapter>/extensions/index.ts (required for the
 * Anthropic OAuth route), PSC_PILOT_DUMP=<file> (last turn and compaction request, redacted).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const LIVE = process.env.PSC_NATIVE_LIVE === "1";
// Six requests per route: compaction, reload, replay and recall; no re-compaction or model switch.
const SHORT = process.env.PSC_PILOT_SHORT === "1";
const smartCompactPath = join(import.meta.dirname, "..", "src", "index.ts");
const oauthExtension = process.env.PSC_CLAUDE_OAUTH_EXTENSION;
const externalExtensions = oauthExtension ? [resolve(oauthExtension)] : [];
const realAuthPath = join(homedir(), ".pi/agent/auth.json");

function parseJson<T>(text: string, what: string): T {
 try {
  return JSON.parse(text) as T;
 } catch (error) {
  throw new Error(`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
 }
}

// ---------------------------------------------------------------------------
// Provider traffic: capture, ledger and the offline fake. Installed before the host loads.
// ---------------------------------------------------------------------------

interface Captured {
 route: string;
 /** `other`: non-model calls such as the Claude OAuth adapter's quota preflight. */
 kind: "compact" | "turn" | "other";
 url: string;
 body: Record<string, unknown>;
 headers: Headers;
 status: number;
}
interface Ledger {
 requests: number;
 inputTokens: number;
 outputTokens: number;
 log: string[];
}

// Budget approved for the stock-Pi live run; the earlier modified-host run has its own ledger.
const LEDGER_PATH = "/tmp/pi-native-live-ledger-stock.json";
const BUDGET = { requests: 24, inputTokens: 300_000, outputTokens: 16_000 };
const ledger: Ledger = existsSync(LEDGER_PATH)
 ? parseJson<Ledger>(readFileSync(LEDGER_PATH, "utf8"), LEDGER_PATH)
 : { requests: 0, inputTokens: 0, outputTokens: 0, log: [] };
const captured: Captured[] = [];
const realFetch = globalThis.fetch;
let currentRoute = "";
let fakeCompactions = 0;

function decodeBody(body: unknown): { text: string; json: Record<string, unknown> } {
 if (body === undefined || body === null) return { text: "", json: {} };
 const text = body instanceof Uint8Array ? Buffer.from(zstdDecompressSync(body)).toString("utf8") : String(body);
 return { text, json: parseJson<Record<string, unknown>>(text, "Provider request body") };
}

function isCompactRequest(url: string, body: Record<string, unknown>): boolean {
 if (/\/responses\/compact(\?|$)/.test(url)) return true;
 const input = body.input;
 const last = Array.isArray(input) ? (input.at(-1) as { type?: string } | undefined) : undefined;
 return body.compaction !== undefined || last?.type === "compaction_trigger";
}

function recordUsage(response: Response): void {
 void response
  .clone()
  .text()
  .then((text) => {
   const max = (key: string) =>
    Math.max(0, ...[...text.matchAll(new RegExp(`"${key}":(\\d+)`, "g"))].map((found) => Number(found[1])));
   ledger.inputTokens += max("input_tokens") + max("cache_read_input_tokens") + max("cache_creation_input_tokens");
   ledger.outputTokens += max("output_tokens");
   writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  });
}

async function interceptingFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
 const url = input instanceof Request ? input.url : String(input);
 // Only the provider routes may be reached; anything else (telemetry, token refresh) is refused.
 if (!/^https:\/\/(api\.anthropic\.com|chatgpt\.com|api\.openai\.com)\//.test(url)) {
  throw new Error(`Pilot blocked a request to ${/^[a-z]+:\/\/[^/?#]*/i.exec(url)?.[0] ?? "a non-provider URL"}`);
 }
 const { text, json } = decodeBody(init?.body);
 const model = /\/v1\/messages(\?|$)|\/responses(\/compact)?(\?|$)/.test(url);
 const kind = !model ? "other" : isCompactRequest(url, json) ? "compact" : "turn";
 const record: Captured = { route: currentRoute, kind, url, body: json, headers: new Headers(init?.headers), status: 0 };
 captured.push(record);
 if (!LIVE) {
  const response = kind === "other"
   ? new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
   : fakeResponse(url, kind, json, text);
  record.status = response.status;
  return response;
 }
 const estimate = Math.ceil(text.length / 4);
 if (
  ledger.requests + 1 > BUDGET.requests ||
  ledger.inputTokens + estimate > BUDGET.inputTokens ||
  ledger.outputTokens >= BUDGET.outputTokens
 ) {
  throw new Error(`Live budget would be exceeded by this ${kind} request (~${estimate} input tokens)`);
 }
 ledger.requests += 1;
 ledger.log.push(`${new Date().toISOString()} ${currentRoute} ${kind} ~${estimate}`);
 writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
 const response = await realFetch(input, init);
 record.status = response.status;
 recordUsage(response);
 return response;
}
globalThis.fetch = interceptingFetch as typeof fetch;
if (LIVE) {
 // The ledger only sees fetch; a WebSocket transport would bypass it.
 // SAFETY: the stub only has to throw on construction; nothing reaches any other WebSocket member.
 globalThis.WebSocket = class {
  constructor() {
   throw new Error("WebSocket transport is disabled in the live pilot");
  }
 } as unknown as typeof WebSocket;
}

function sse(events: Array<{ type: string } & Record<string, unknown>>, named: boolean): Response {
 const text = events.map((event) => `${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
 return new Response(text.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Scripted provider. A prompt naming `notes-N.txt` gets a `read` call for that file; anything else
 * gets a text reply that echoes the native state the request carried, so replay is visible.
 */
function fakeResponse(url: string, kind: "compact" | "turn", body: Record<string, unknown>, text: string): Response {
 const seen = /native-state-\d+/.exec(text)?.[0] ?? "none";
 const lastPrompt = lastUserText(body);
 const file = /notes-\d+\.txt/.exec(lastPrompt ?? "")?.[0];
 const reply = `ack (state: ${seen})`;
 // Realistic usage matters: the planner scales its estimates to the reported input tokens.
 const input_tokens = Math.ceil(text.length / 4);
 if (url.includes("anthropic.com")) {
  if (kind === "compact") {
   fakeCompactions += 1;
   const block = {
    type: "compaction",
    content: `Summary: the codeword is BLUE-HERON-47 (previous state: ${seen}).`,
    signature: `native-state-${fakeCompactions}`,
   };
   const usage = { input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", input_tokens: 4000, output_tokens: 120 }] };
   const message = { id: "msg_c", type: "message", role: "assistant", model: body.model, content: [block], stop_reason: "compaction", usage };
   return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json" } });
  }
  const start = { id: "msg_t", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens, output_tokens: 1 } };
  const block = file
   ? [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${captured.length}`, name: "read", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: file }) } },
   ]
   : [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } },
   ];
  return sse(
   [
    { type: "message_start", message: start },
    ...block,
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: file ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
   ],
   true,
  );
 }
 const completed = (usage: Record<string, number>) => ({ type: "response.completed", response: { id: "resp", status: "completed", usage } });
 if (kind === "compact" && url.includes("/responses/compact")) {
  fakeCompactions += 1;
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : [];
  const output = [
   ...input.filter((item) => item.role === "user"),
   { type: "compaction", id: `cmp_${fakeCompactions}`, encrypted_content: `native-state-${fakeCompactions}` },
  ];
  const window = { id: "resp_c", object: "response.compaction", created_at: 1, output, usage: { input_tokens: 4000, output_tokens: 90 } };
  return new Response(JSON.stringify(window), { status: 200, headers: { "content-type": "application/json" } });
 }
 if (kind === "compact") {
  fakeCompactions += 1;
  const item = { type: "compaction", id: `cmp_${fakeCompactions}`, encrypted_content: `native-state-${fakeCompactions}` };
  return sse([{ type: "response.output_item.done", item }, completed({ input_tokens: 4000, output_tokens: 90 })], false);
 }
 if (file) {
  const call = { type: "function_call", id: "fc_1", call_id: `call_${captured.length}`, name: "read", arguments: JSON.stringify({ path: file }), status: "completed" };
  return sse(
   [
    { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: call.arguments },
    { type: "response.output_item.done", output_index: 0, item: call },
    completed({ input_tokens, output_tokens: 5, total_tokens: input_tokens + 5 }),
   ],
   false,
  );
 }
 const part = { type: "output_text", text: "", annotations: [] };
 const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ ...part, text: reply }] };
 const at = { item_id: "msg_1", output_index: 0, content_index: 0 };
 return sse(
  [
   { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
   { type: "response.content_part.added", ...at, part },
   { type: "response.output_text.delta", ...at, delta: reply },
   { type: "response.output_item.done", output_index: 0, item },
   completed({ input_tokens, output_tokens: 5, total_tokens: input_tokens + 5 }),
  ],
  false,
 );
}

/** The user's prompt when it is the newest input, or undefined once a tool result follows it. */
function lastUserText(body: Record<string, unknown>): string | undefined {
 const items = (body.messages ?? body.input) as Array<Record<string, unknown>> | undefined;
 const last = items?.at(-1);
 if (!last || last.role !== "user") return undefined;
 const content = last.content;
 if (typeof content === "string") return content;
 if (!Array.isArray(content)) return undefined;
 const parts = content as Array<Record<string, unknown>>;
 if (parts.some((part) => part.type === "tool_result")) return undefined;
 return parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface Route {
 name: string;
 provider: "anthropic" | "openai-codex" | "openai";
 modelId: string;
 /** Same provider, different model: native state must fall back to readable text there. */
 otherModelId: string;
}
interface NativeState {
 api: string;
 provider: string;
 model: string;
 items: Array<Record<string, unknown>>;
}

const allRoutes: Route[] = [
 { name: "anthropic-oauth", provider: "anthropic", modelId: "claude-sonnet-4-6", otherModelId: "claude-haiku-4-5" },
 { name: "codex-oauth", provider: "openai-codex", modelId: "gpt-5.6-luna", otherModelId: "gpt-6-luna" },
 { name: "openai-api-key", provider: "openai", modelId: "gpt-5.6-luna", otherModelId: "gpt-6-luna" },
];
// PSC_NATIVE_ROUTES=codex-oauth runs a subset. No OpenAI API key is available, so live runs skip that route.
const selected = process.env.PSC_NATIVE_ROUTES?.split(",") ?? (LIVE ? ["anthropic-oauth", "codex-oauth"] : undefined);
const routes = allRoutes.filter((route) => !selected || selected.includes(route.name));
if (routes.some(route => route.provider === "anthropic") && !oauthExtension) {
 throw new Error("Set PSC_CLAUDE_OAUTH_EXTENSION to the standalone adapter extension; Toolkit auto-context must not be loaded.");
}
const home = mkdtempSync(join(tmpdir(), "psc-native-pilot-"));
process.env.HOME = home;
if (!LIVE) process.env.PI_OFFLINE = "1";
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true, mode: 0o700 });

function writeCredentials(): void {
 const credentials: Record<string, unknown> = {};
 if (LIVE) {
  const stored = parseJson<Record<string, { expires?: number }>>(readFileSync(realAuthPath, "utf8"), realAuthPath);
  for (const { provider } of routes) {
   const credential = stored[provider];
   if (!credential) throw new Error(`No ${provider} credential in ${realAuthPath}`);
   if ((credential.expires ?? 0) - Date.now() < 30 * 60_000) {
    throw new Error(`${provider} token expires within 30 minutes; refresh it in Pi first`);
   }
   credentials[provider] = credential;
  }
 } else {
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_offline" } }));
  const oauth = { type: "oauth", refresh: "offline", expires: Date.now() + 3_600_000 };
  credentials.anthropic = { ...oauth, access: "sk-ant-oat01-offline" };
  credentials["openai-codex"] = { ...oauth, access: `h.${claims.toString("base64url")}.s`, accountId: "acc_offline" };
  credentials.openai = { type: "api_key", key: "sk-offline" };
 }
 writeFileSync(join(agentDir, "auth.json"), JSON.stringify(credentials), { mode: 0o600 });
 writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({
   transport: "sse",
   retry: { enabled: false, provider: { maxRetries: 0 } },
   // Pi finds nothing to compact below its own retained tail, even when an extension supplies the cut.
   compaction: { enabled: false, keepRecentTokens: 1000 },
   smartCompact: {
    compactionEngines: ["native"],
    autoTrigger: false,
    requireApproval: false,
    contextGraphEnabled: false,
    backupEnabled: false,
    // A 2k-token minimum tail and a 1.25k summary allowance keep the pilot small; the planner
    // rules are unchanged.
    profiles: { aggressive: { keepRecentTokens: 1000, summaryBudgetTokens: 1000 } },
   },
  }),
 );
}

const host = await import("@earendil-works/pi-coding-agent");
const { getModel } = await import("@earendil-works/pi-ai/compat");
// The CLI initializes the theme in every mode; extension status renderers rely on it.
host.initTheme(undefined, false);

function modelFor(provider: Route["provider"], id: string): Model<Api> {
 const model = getModel(provider as never, id as never) as Model<Api> | undefined;
 if (!model) throw new Error(`Unknown model ${provider}/${id}`);
 return model;
}

async function openSession(route: Route, sessionFile?: string): Promise<AgentSession> {
 const cwd = join(home, route.name);
 mkdirSync(cwd, { recursive: true });
 const settingsManager = host.SettingsManager.create(cwd, agentDir);
 const sessionManager = sessionFile
  ? host.SessionManager.open(sessionFile)
  : host.SessionManager.create(cwd, join(agentDir, "sessions"));
 const modelRuntime = await host.ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
  allowModelNetwork: false,
  refreshOnCreate: false,
 });
 const resourceLoader = new host.DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  additionalExtensionPaths: [smartCompactPath, ...externalExtensions],
 });
 await resourceLoader.reload();
 assert.deepEqual(resourceLoader.getExtensions().errors, []);
 const { session } = await host.createAgentSession({
  cwd,
  agentDir,
  model: modelFor(route.provider, route.modelId),
  thinkingLevel: "off",
  settingsManager,
  sessionManager,
  modelRuntime,
  resourceLoader,
  tools: ["read"],
 });
 await session.bindExtensions({
  uiContext: capturingUi(),
  onError: (error) => problems.push(`extension: ${JSON.stringify(error)}`),
  commandContextActions: {
   waitForIdle: () => session.waitForIdle(),
   navigateTree: (target, options) => session.navigateTree(target, options),
   newSession: async () => ({ cancelled: true }),
   fork: async () => ({ cancelled: true }),
   switchSession: async () => ({ cancelled: true }),
   reload: () => session.reload(),
  },
 });
 session.subscribe((event) => {
  if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
   problems.push(`provider: ${event.message.errorMessage}`);
  }
 });
 return session;
}

/** Extension and provider errors, reported with the route that failed. */
const problems: string[] = [];
/** Notifications extensions showed the user. */
const notes: string[] = [];

type UiContext = NonNullable<Parameters<AgentSession["bindExtensions"]>[0]["uiContext"]>;

/** A headless TUI stand-in: records notifications, declines dialogs, renders text unstyled. */
function capturingUi(): UiContext {
 const none = () => undefined;
 const dismissed = async () => undefined;
 const ui = {
  select: dismissed,
  confirm: async () => false,
  input: dismissed,
  editor: dismissed,
  custom: dismissed,
  notify: (message: string, level?: string) => notes.push(`${level ?? "info"}: ${message}`),
  onTerminalInput: () => none,
  setStatus: none,
  setWorkingMessage: none,
  setWorkingVisible: none,
  setWorkingIndicator: none,
  setHiddenThinkingLabel: none,
  setWidget: none,
  setFooter: none,
  setHeader: none,
  setTitle: none,
  pasteToEditor: none,
  setEditorText: none,
  getEditorText: () => "",
  addAutocompleteProvider: none,
  setEditorComponent: none,
  getEditorComponent: none,
  theme: new Proxy({}, { get: () => (...parts: unknown[]) => parts.at(-1) }),
  getAllThemes: () => [],
  getTheme: none,
  setTheme: () => ({ success: false, error: "headless" }),
  getToolsExpanded: () => false,
  setToolsExpanded: none,
 };
 // SAFETY: members mirror the host's no-op UI; the theme only styles text, so returning it unstyled is valid.
 return ui as unknown as UiContext;
}

/**
 * `/smart-compact` requests native state inside the command, then applies it through
 * `ctx.compact()`, which finishes after the command returns. No compaction start means it failed.
 */
async function smartCompact(session: AgentSession): Promise<void> {
 let started = false;
 let settle: (error?: Error) => void = () => { };
 const done = new Promise<void>((resolveDone, reject) => {
  settle = (error) => (error ? reject(error) : resolveDone());
 });
 const unsubscribe = session.subscribe((event) => {
  if (event.type === "compaction_start") started = true;
  if (event.type !== "compaction_end") return;
  settle(event.errorMessage || event.aborted ? new Error(`compaction failed: ${event.errorMessage ?? "aborted"}`) : undefined);
 });
 const timer = setTimeout(() => settle(new Error("compaction did not finish within 180 s")), 180_000);
 try {
  // An explicit mode runs without the interactive picker.
  await session.prompt("/smart-compact fast");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  if (!started) throw new Error(`compaction was not applied: ${notes.at(-1) ?? "no notification"}`);
  await done;
 } finally {
  clearTimeout(timer);
  unsubscribe();
 }
}

function latestNative(session: AgentSession): NativeState | undefined {
 const entry = session.sessionManager.getEntries().findLast((candidate) => candidate.type === "compaction");
 return (entry as { details?: { native?: NativeState } } | undefined)?.details?.native;
}

function lastReply(session: AgentSession): string {
 const message = session.messages.findLast((candidate) => candidate.role === "assistant");
 if (message?.role !== "assistant") return "";
 return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function requestsSince(start: number, kind: Captured["kind"]): Captured[] {
 return captured.slice(start).filter((request) => request.kind === kind);
}

/** The replayed state must lead the request, byte-for-byte as stored. */
function assertReplayed(route: Route, request: Captured | undefined, native: NativeState): void {
 assert.ok(request, "no turn request after compaction");
 if (route.provider === "anthropic") {
  const messages = request.body.messages as Array<{ role: string; content: unknown }>;
  assert.deepEqual(messages[0], { role: "assistant", content: native.items });
  assert.match(request.headers.get("anthropic-beta") ?? "", /compact-2026-09-04/);
 } else {
  // The window replaces the summary after any developer prompt.
  const input = request.body.input as Array<Record<string, unknown>>;
  const start = input.findIndex((item) => item.role !== "system" && item.role !== "developer");
  assert.deepEqual(input.slice(start, start + native.items.length), native.items);
 }
}

/**
 * ~6k-token synthetic files: tool output carries the bulk, as in real coding sessions. Codex keeps
 * user messages verbatim, so only non-user content can shrink.
 */
function writeNotes(cwd: string): void {
 mkdirSync(cwd, { recursive: true });
 for (const n of [1, 2, 3]) {
  const lines = Array.from(
   { length: 250 },
   (_, index) => `Item ${n}.${index + 1}: the deployment checklist entry was reviewed and needs no change.`,
  );
  // A neutral project fact: models may decline to repeat anything that reads like a secret.
  if (n === 1) lines.unshift("Project note: this quarter's release train is named BLUE-HERON-47.");
  writeFileSync(join(cwd, `notes-${n}.txt`), `${lines.join("\n")}\n`);
 }
}

async function runRoute(route: Route): Promise<Record<string, unknown>> {
 currentRoute = route.name;
 const start = captured.length;
 writeNotes(join(home, route.name));
 const session = await openSession(route);
 await session.prompt('Use the read tool to read notes-1.txt, then reply with just "ok".');
 await session.prompt('Use the read tool to read notes-2.txt, then reply with just "ok".');

 await smartCompact(session);
 const first = latestNative(session);
 assert.ok(first, "compaction entry has no native state");
 assert.deepEqual([first.provider, first.model], [route.provider, route.modelId]);
 const [compactRequest] = requestsSince(start, "compact");
 if (process.env.PSC_PILOT_DUMP) {
  const shape = (request: Captured | undefined) => ({
   url: request?.url,
   headers: Object.fromEntries(
    [...(request?.headers.entries() ?? [])].map(([key, value]) => [
     key,
     /authorization|api-key|cookie/i.test(key) ? "<redacted>" : value,
    ]),
   ),
   body: Object.fromEntries(
    Object.entries(request?.body ?? {}).map(([key, value]) => [
     key,
     key === "system"
      ? (value as Array<{ text?: string }>).map((block) => (block.text ?? "").slice(0, 90))
      : key === "messages" || key === "tools"
       ? `[${(value as unknown[]).length}]`
       : value,
    ]),
   ),
  });
  const lastTurn = captured.slice(start).filter((request) => request.kind === "turn").at(-1);
  writeFileSync(process.env.PSC_PILOT_DUMP, JSON.stringify({ turn: shape(lastTurn), compact: shape(compactRequest) }, null, 2));
 }
 assert.ok(compactRequest && requestsSince(start, "compact").length === 1, "expected one compaction request");
 if (route.provider === "anthropic") assert.deepEqual(compactRequest.body.compaction, { type: "summarize" });
 const sessionFile = session.sessionFile;
 assert.ok(sessionFile, "session is not persisted");
 session.dispose();

 // Reopened from JSONL, the stored state replays verbatim on the next turn.
 const reopened = await openSession(route, sessionFile);
 const beforeRecall = captured.length;
 await reopened.prompt(
  SHORT
   ? "Without using any tool, reply with only the name of this quarter's release train from notes-1.txt."
   : "Use the read tool to read notes-3.txt. Then, without reading notes-1.txt again, reply with only the name of this quarter's release train from notes-1.txt.",
 );
 assertReplayed(route, requestsSince(beforeRecall, "turn")[0], first);
 const recall = lastReply(reopened);
 assert.match(recall, LIVE ? /BLUE-HERON-47/ : /native-state-/);

 let second: NativeState | undefined;
 if (!SHORT) {
  // Compacting again summarizes from the previous native state.
  const beforeSecond = captured.length;
  await smartCompact(reopened);
  second = latestNative(reopened);
  const [secondRequest] = requestsSince(beforeSecond, "compact");
  assert.ok(second && secondRequest, "second compaction did not produce native state");
  assert.ok(JSON.stringify(secondRequest.body).includes(JSON.stringify(first.items.at(-1))), "second compaction lost the first state");

  // Another model on the same provider gets the readable text, never the opaque state (offline only:
  // no live budget). Anthropic's text is the summary; Codex's is a notice plus the retained user messages.
  if (!LIVE) {
   await reopened.setModel(modelFor(route.provider, route.otherModelId));
   const beforeSwitch = captured.length;
   await reopened.prompt("Reply with just ok.");
   const switched = requestsSince(beforeSwitch, "turn")[0];
   const sent = (switched?.body.messages ?? switched?.body.input) as Array<Record<string, unknown>>;
   const opaque = sent.some(
    (item) =>
     item.type === "compaction" ||
     (Array.isArray(item.content) && item.content.some((block: { type?: string }) => block.type === "compaction")),
   );
   assert.ok(!opaque, "opaque state reached another model");
   assert.doesNotMatch(switched?.headers.get("anthropic-beta") ?? "", /compact-2026-09-04/);
   const readable = route.provider === "anthropic" ? "BLUE-HERON-47" : "compacted into encrypted";
   assert.ok(JSON.stringify(sent).includes(readable), "readable fallback missing on another model");
  }
 }
 reopened.dispose();
 // Claude subscription requests need the billing header; the replayed turn's header must describe its final messages.
 const billing = (request: Captured | undefined) =>
  ((request?.body.system as Array<{ text?: string }> | undefined) ?? []).find((block) =>
   block.text?.startsWith("x-anthropic-billing-header:"),
  )?.text;
 return {
  route: route.name,
  ...(route.provider === "anthropic"
   ? { billingHeader: { compaction: Boolean(billing(compactRequest)), replayedTurn: Boolean(billing(requestsSince(beforeRecall, "turn")[0])) } }
   : {}),
  notes: notes.splice(0),
  model: `${route.provider}/${route.modelId}`,
  requests: captured.slice(start).map((request) => `${request.kind}:${request.status}`),
  recall,
  nativeItems: [first.items.length, second?.items.length],
 };
}

const results: Array<Record<string, unknown>> = [];
let failed = false;
try {
 writeCredentials();
 for (const route of routes) {
  try {
   results.push(await runRoute(route));
  } catch (error) {
   failed = true;
   const statuses = captured.filter((request) => request.route === route.name).map((r) => `${r.kind}:${r.status}`);
   const message = error instanceof Error ? error.message : String(error);
   results.push({ route: route.name, error: message, notes: notes.splice(0), problems: problems.splice(0), requests: statuses });
  }
 }
} finally {
 globalThis.fetch = realFetch;
 rmSync(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ mode: LIVE ? "live" : "offline", results, ledger: LIVE ? ledger : undefined }, null, 2));
process.exitCode = failed ? 1 : 0;
