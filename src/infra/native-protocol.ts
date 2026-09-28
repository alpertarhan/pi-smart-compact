/**
 * Provider wire formats for native compaction on stock Pi.
 *
 * Pi has no native-compaction API, so Smart Compact borrows one nested request:
 * `createCompactionFetch()` is passed as that request's `fetch`. It rewrites what Pi's
 * adapter built (auth, OAuth details, serialization) into the provider's compaction
 * request, sends it once, and answers Pi with a non-retryable 400 so nothing is retried.
 * `replayNativeState()` later swaps Pi's text summary in ordinary requests for the stored
 * provider state.
 *
 * The state is opaque (signed or encrypted): copy it verbatim; never edit, log or scrub it.
 */
import * as zlib from "node:zlib";

export const NATIVE_APIS = ["anthropic-messages", "openai-responses", "openai-codex-responses"] as const;
export type NativeApi = (typeof NATIVE_APIS)[number];

/** A JSON object as it appears in provider payloads. */
export type JsonObject = Record<string, unknown>;

/** Stored in the compaction entry's `details.native`. */
export interface NativeState {
 version: 1;
 api: NativeApi;
 provider: string;
 model: string;
 /** Provider items in replay order: one Anthropic compaction block, or an OpenAI window. */
 items: JsonObject[];
}

export interface NativeUsage {
 input: number;
 output: number;
 cacheRead: number;
 cacheWrite: number;
}

export interface NativeCompactionResult {
 state: NativeState;
 /** What other models read: Anthropic's summary, or for OpenAI routes a notice plus the retained user messages. */
 summary: string;
 usage: NativeUsage;
}

export interface CompactionFetchOptions {
 api: NativeApi;
 provider: string;
 model: string;
 /** Summarization guidance; only Anthropic accepts it. */
 instructions?: string;
 /** Transport for the one real request. Defaults to the global fetch. */
 fetch?: typeof fetch;
}

/** Required on Anthropic's compaction request and on every request that replays its block. */
export const ANTHROPIC_COMPACTION_BETA = "compact-2026-09-04";
// Codex keeps up to 64k tokens (about 4 characters each) of the newest user messages verbatim.
const CODEX_RETAINED_USER_CHARS = 256_000;
// Pi's wrapper around a compaction summary (`convertToLlm` in pi-coding-agent).
const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";
// Replayed state comes from session files: bound it before trusting it. A real window is one
// compaction item plus at most 256k chars of retained user messages, far below both limits.
const MAX_NATIVE_STATE_ITEMS = 1_024;
const MAX_NATIVE_STATE_CHARS = 4 * 1024 * 1024;

export function isNativeApi(api: string): api is NativeApi {
 return (NATIVE_APIS as readonly string[]).includes(api);
}

function isObject(value: unknown): value is JsonObject {
 return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNativeState(value: unknown): value is NativeState {
 if (!(
  isObject(value) &&
  value.version === 1 &&
  typeof value.api === "string" &&
  isNativeApi(value.api) &&
  typeof value.provider === "string" &&
  typeof value.model === "string" &&
  Array.isArray(value.items) &&
  value.items.length <= MAX_NATIVE_STATE_ITEMS &&
  value.items.every(isObject) &&
  JSON.stringify(value.items).length <= MAX_NATIVE_STATE_CHARS
 )) return false;
 let compactions = 0;
 for (const item of value.items) {
  if (item.type !== "compaction") {
   if (value.api === "anthropic-messages") return false;
   continue;
  }
  compactions++;
  if (value.api === "anthropic-messages") {
   if (typeof item.content !== "string" || !item.content.trim() ||
    typeof item.signature !== "string" || !item.signature.length) return false;
  } else if (typeof item.encrypted_content !== "string" || !item.encrypted_content.length) return false;
 }
 return value.api === "anthropic-messages" ? compactions === 1 : compactions > 0;
}

/**
 * A fetch for one nested Pi request. The first call becomes the compaction request; every
 * call answers Pi with a 400, so the nested stream ends as an error that callers ignore
 * once `result()` is defined. `result()` stays undefined when Pi never sent a request.
 */
export function createCompactionFetch(options: CompactionFetchOptions): {
 fetch: typeof fetch;
 result(): NativeCompactionResult | Error | undefined;
} {
 let outcome: NativeCompactionResult | Error | undefined;
 let used = false;
 const send = options.fetch ?? globalThis.fetch;
 const compactionFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  if (!used) {
   used = true;
   try {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    outcome = await compactOnce(options, send, request, init?.signal ?? undefined);
   } catch (error) {
    outcome = error instanceof Error ? error : new Error(String(error));
   }
  }
  return handledResponse();
 };
 return { fetch: compactionFetch as typeof fetch, result: () => outcome };
}

function handledResponse(): Response {
 const error = { type: "invalid_request_error", message: "Smart Compact sent this request as native compaction" };
 return new Response(JSON.stringify({ type: "error", error }), {
  status: 400,
  headers: { "content-type": "application/json" },
 });
}

async function compactOnce(
 options: CompactionFetchOptions,
 send: typeof fetch,
 request: Request,
 signal: AbortSignal | undefined,
): Promise<NativeCompactionResult> {
 const body = parseJsonObject(await readBody(request), "Pi's request body");
 const headers = new Headers(request.headers);
 headers.delete("content-length");
 headers.delete("content-encoding");
 const post = (url: string, payload: JsonObject) =>
  send(url, { method: "POST", headers, body: JSON.stringify(payload), signal });
 switch (options.api) {
  case "anthropic-messages":
   return compactAnthropic(options, post, request.url, headers, body);
  case "openai-responses":
   return compactOpenAI(options, post, request.url, headers, body);
  case "openai-codex-responses":
   return compactCodex(options, post, request.url, body);
 }
}

async function readBody(request: Request): Promise<string> {
 const bytes = new Uint8Array(await request.arrayBuffer());
 if (request.headers.get("content-encoding") !== "zstd") return new TextDecoder().decode(bytes);
 if (typeof zlib.zstdDecompressSync !== "function") {
  throw new Error("This runtime cannot read Pi's zstd-compressed request; update Node or Bun");
 }
 return new TextDecoder().decode(zlib.zstdDecompressSync(bytes));
}

type Post = (url: string, payload: JsonObject) => Promise<Response>;

async function compactAnthropic(
 options: CompactionFetchOptions,
 post: Post,
 url: string,
 headers: Headers,
 body: JsonObject,
): Promise<NativeCompactionResult> {
 // The SDK sends betas as a header; a replayed payload may carry more in its body.
 const betas = (headers.get("anthropic-beta") ?? "").split(",").map((beta) => beta.trim());
 if (Array.isArray(body.betas)) betas.push(...body.betas.filter((beta) => typeof beta === "string"));
 headers.set("anthropic-beta", [...new Set([...betas, ANTHROPIC_COMPACTION_BETA])].filter(Boolean).join(","));
 // Compaction rejects forced tool choice, stop sequences and structured output formats.
 const { betas: _betas, tool_choice: _toolChoice, stop_sequences: _stopSequences, ...request } = body;
 if (isObject(request.output_config)) {
  const { format: _format, ...outputConfig } = request.output_config;
  request.output_config = outputConfig;
 }
 // Keep the transport streamed like Pi's own turns; subscription billing support remains experimental.
 const compaction = { type: "summarize", ...(options.instructions ? { instructions: options.instructions } : {}) };
 const payload: JsonObject = { ...request, stream: true, compaction };
 // On-demand compaction cannot be combined with context management, including provider-override edits.
 delete payload.context_management;
 const response = await post(url, payload);
 const data = await readAnthropicMessage(response);
 const blocks = Array.isArray(data.content) ? data.content.filter(isObject) : [];
 const compactions = blocks.filter((block) => block.type === "compaction");
 const summary = compactions[0]?.content;
 if (data.stop_reason !== "compaction" || compactions.length !== 1 || typeof summary !== "string" || !summary.trim()) {
  throw new Error(
   `Anthropic compaction did not complete (stop_reason: ${String(data.stop_reason)}, compaction blocks: ${compactions.length})`,
  );
 }
 return { state: stateFor(options, compactions), summary, usage: anthropicUsage(data.usage) };
}

/**
 * The final message of a streamed response, or a JSON one. A streamed compaction block
 * arrives whole in `content_block_start`; its stop reason and usage come in `message_delta`.
 */
async function readAnthropicMessage(response: Response): Promise<JsonObject> {
 if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
  return readJsonResponse(response, "Anthropic compaction response");
 }
 if (!response.ok) throw httpError(response.status, await response.text());
 const content: JsonObject[] = [];
 let usage: JsonObject = {};
 let stopReason: unknown;
 for (const event of parseSse(await response.text())) {
  if (event.type === "error") throw new Error(`Anthropic compaction failed: ${eventError(event)}`);
  if (event.type === "message_start" && isObject(event.message) && isObject(event.message.usage)) {
   usage = event.message.usage;
  }
  if (event.type === "content_block_start" && isObject(event.content_block)) content.push(event.content_block);
  if (event.type === "message_delta") {
   if (isObject(event.delta)) stopReason = event.delta.stop_reason;
   if (isObject(event.usage)) usage = { ...usage, ...event.usage };
  }
 }
 return { content, stop_reason: stopReason, usage };
}

// Compaction usage is reported per iteration; the top-level counters stay zero.
// Without (or with an empty list of) iterations the top-level counters are the usage.
function anthropicUsage(usage: unknown): NativeUsage {
 const top = isObject(usage) ? usage : {};
 const listed = Array.isArray(top.iterations) ? top.iterations.filter(isObject) : [];
 const iterations = listed.length ? listed : [top];
 const sum = (key: string) => iterations.reduce((total, item) => total + numberAt(item, key), 0);
 return {
  input: sum("input_tokens"),
  output: sum("output_tokens"),
  cacheRead: sum("cache_read_input_tokens"),
  cacheWrite: sum("cache_creation_input_tokens"),
 };
}

async function compactOpenAI(
 options: CompactionFetchOptions,
 post: Post,
 url: string,
 headers: Headers,
 body: JsonObject,
): Promise<NativeCompactionResult> {
 const endpoint = /^(.*\/responses)(\?.*)?$/.exec(url);
 if (!endpoint) throw new Error("Unexpected OpenAI request URL; expected .../responses");
 headers.set("accept", "application/json");
 const request: JsonObject = { model: body.model, input: body.input };
 if (body.instructions !== undefined) request.instructions = body.instructions;
 if (body.prompt_cache_key !== undefined) request.prompt_cache_key = body.prompt_cache_key;
 const target = `${endpoint[1]}/compact${endpoint[2] ?? ""}`;
 const data = await readJsonResponse(await post(target, request), "OpenAI compaction response");
 const output = Array.isArray(data.output) ? data.output.filter(isObject) : [];
 if (!output.some((item) => item.type === "compaction")) {
  throw new Error("OpenAI compaction returned no compaction item");
 }
 return { state: stateFor(options, output), summary: windowSummary(options, output), usage: responsesUsage(data.usage) };
}

/**
 * Codex remote compaction v2: an ordinary turn request closed by a `compaction_trigger`,
 * answered with one encrypted item. Like Codex, the window keeps the newest user messages
 * verbatim, then that item.
 */
async function compactCodex(
 options: CompactionFetchOptions,
 post: Post,
 url: string,
 body: JsonObject,
): Promise<NativeCompactionResult> {
 const input = Array.isArray(body.input) ? body.input : [];
 const response = await post(url, { ...body, input: [...input, { type: "compaction_trigger" }] });
 if (!response.ok) throw httpError(response.status, await response.text());
 const items: JsonObject[] = [];
 let usage: NativeUsage | undefined;
 for (const event of parseSse(await response.text())) {
  if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
   throw new Error(`Codex compaction failed: ${eventError(event)}`);
  }
  if (event.type === "response.output_item.done" && isObject(event.item) && event.item.type === "compaction") {
   items.push(event.item);
  }
  if (event.type === "response.completed" || event.type === "response.done") {
   usage = responsesUsage(isObject(event.response) ? event.response.usage : undefined);
   break;
  }
 }
 if (!usage) throw new Error("Codex compaction stream ended before the response completed");
 if (items.length !== 1) throw new Error(`Codex compaction expected one compaction item, got ${items.length}`);
 const window = [...retainedUserMessages(input.filter(isObject)), items[0]];
 return { state: stateFor(options, window), summary: windowSummary(options, window), usage };
}

// ponytail: whole messages newest-first; the first one that no longer fits stops the walk, so it
// and every older message are dropped (Codex would keep a truncated copy of that one).
function retainedUserMessages(history: JsonObject[]): JsonObject[] {
 const retained: JsonObject[] = [];
 let budget = CODEX_RETAINED_USER_CHARS;
 for (let index = history.length - 1; index >= 0; index--) {
  const item = history[index];
  if (item.role !== "user" || (item.type !== undefined && item.type !== "message")) continue;
  const size = JSON.stringify(item.content ?? "").length;
  if (size > budget) break;
  budget -= size;
  retained.unshift(item);
 }
 return retained;
}

function responsesUsage(usage: unknown): NativeUsage {
 const top = isObject(usage) ? usage : {};
 const cached = isObject(top.input_tokens_details) ? numberAt(top.input_tokens_details, "cached_tokens") : 0;
 return {
  // OpenAI counts cached tokens inside input_tokens.
  input: Math.max(0, numberAt(top, "input_tokens") - cached),
  output: numberAt(top, "output_tokens"),
  cacheRead: cached,
  cacheWrite: 0,
 };
}

/** The readable stand-in for an opaque window: a notice plus the user messages it keeps verbatim. */
function windowSummary(options: CompactionFetchOptions, items: JsonObject[]): string {
 const texts = items.filter((item) => item.role === "user").map((item) => messageText(item.content));
 const retained = texts.filter((text) => text.trim());
 const note = `Earlier conversation was compacted into encrypted ${options.provider}/${options.model} state that other models cannot read.`;
 return retained.length > 0 ? `${note} User messages retained from it:\n\n${retained.join("\n\n")}` : note;
}

function messageText(content: unknown): string {
 if (typeof content === "string") return content;
 if (!Array.isArray(content)) return "";
 return content.flatMap((part) => (isObject(part) && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

function stateFor(options: CompactionFetchOptions, items: JsonObject[]): NativeState {
 const state: NativeState = { version: 1, api: options.api, provider: options.provider, model: options.model, items };
 if (!isNativeState(state)) throw new Error("Native compaction returned invalid signed or encrypted state");
 return state;
}

/**
 * Returns a copy of an ordinary provider payload whose compaction-summary message is replaced
 * by the stored state. Undefined when the summary is not the first conversation message, the
 * only place replay is valid; Pi's text summary then goes out unchanged.
 */
export function replayNativeState(
 api: NativeApi,
 payload: unknown,
 state: NativeState,
 summary: string,
): JsonObject | undefined {
 if (!isObject(payload) || state.api !== api || !summary.trim()) return undefined;
 const items = structuredClone(state.items);
 if (api === "anthropic-messages") {
  const messages = payload.messages;
  if (!Array.isArray(messages) || !isObject(messages[0]) || messages[0].role !== "user") return undefined;
  const rest = withoutSummary(messages[0], summary, "text");
  if (rest === undefined) return undefined;
  const betas = Array.isArray(payload.betas) ? payload.betas.filter((beta) => typeof beta === "string") : [];
  // The block leads as its own assistant message, out of reach of hooks that edit user turns.
  return {
   ...payload,
   betas: betas.includes(ANTHROPIC_COMPACTION_BETA) ? betas : [...betas, ANTHROPIC_COMPACTION_BETA],
   messages: [{ role: "assistant", content: items }, ...(rest ? [rest] : []), ...messages.slice(1)],
  };
 }
 const input = payload.input;
 if (!Array.isArray(input)) return undefined;
 const index = input.findIndex((item) => !isObject(item) || (item.role !== "system" && item.role !== "developer"));
 const first = input[index];
 if (!isObject(first) || first.role !== "user") return undefined;
 const rest = withoutSummary(first, summary, "input_text");
 if (rest === undefined) return undefined;
 return { ...payload, input: [...input.slice(0, index), ...items, ...(rest ? [rest] : []), ...input.slice(index + 1)] };
}

/** The message without Pi's summary text: null when nothing else is left, undefined when the summary is absent. */
function withoutSummary(message: JsonObject, summary: string, textType: string): JsonObject | null | undefined {
 const wrapped = SUMMARY_PREFIX + summary + SUMMARY_SUFFIX;
 // Preserve surrounding instructions and refuse replay if another extension removed or changed Pi's wrapper.
 const strip = (text: string) => (text.includes(wrapped) ? text.replace(wrapped, "") : undefined);
 if (typeof message.content === "string") {
  const text = strip(message.content);
  if (text === undefined) return undefined;
  return text.trim() ? { ...message, content: text } : null;
 }
 if (!Array.isArray(message.content)) return undefined;
 const content = [...message.content];
 const index = content.findIndex(
  (block) => isObject(block) && block.type === textType && typeof block.text === "string" && strip(block.text) !== undefined,
 );
 if (index < 0) return undefined;
 const block = content[index] as JsonObject;
 const text = strip(block.text as string) ?? "";
 if (text.trim()) content[index] = { ...block, text };
 else content.splice(index, 1);
 return content.length > 0 ? { ...message, content } : null;
}

function parseSse(text: string): JsonObject[] {
 const events: JsonObject[] = [];
 for (const line of text.split(/\r?\n/)) {
  if (!line.startsWith("data:")) continue;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") continue;
  try {
   const event: unknown = JSON.parse(data);
   if (isObject(event)) events.push(event);
  } catch {
   // A malformed line cannot hold the compaction item; completeness is checked afterwards.
  }
 }
 return events;
}

function eventError(event: JsonObject): string {
 const response = isObject(event.response) ? event.response : {};
 const error = isObject(event.error) ? event.error : isObject(response.error) ? response.error : event;
 const message = typeof error.message === "string" ? error.message : "";
 const code = typeof error.code === "string" ? error.code : "";
 const reason = isObject(response.incomplete_details) && typeof response.incomplete_details.reason === "string"
  ? response.incomplete_details.reason : "";
 return firstLine(message || code || reason || "response failed");
}

async function readJsonResponse(response: Response, what: string): Promise<JsonObject> {
 const text = await response.text();
 if (!response.ok) throw httpError(response.status, text);
 return parseJsonObject(text, what);
}

function parseJsonObject(text: string, what: string): JsonObject {
 let value: unknown;
 try {
  value = JSON.parse(text);
 } catch {
  throw new Error(`${what} is not JSON`);
 }
 if (!isObject(value)) throw new Error(`${what} is not a JSON object`);
 return value;
}

/** "<status> <type>: <message>", from the provider's error body when it has one. */
function httpError(status: number, text: string): Error {
 let detail = text.trim();
 try {
  const data: unknown = JSON.parse(text);
  const error = isObject(data) && isObject(data.error) ? data.error : isObject(data) ? data : {};
  const message = typeof error.message === "string" ? error.message : "";
  const type = typeof error.type === "string" ? error.type : typeof error.code === "string" ? error.code : "";
  if (message) detail = type ? `${type}: ${message}` : message;
 } catch {
  // Not JSON: the first line of the raw body is the best available detail.
 }
 return new Error(`${status} ${firstLine(detail)}`.trim());
}

function firstLine(text: string): string {
 return (text.split("\n")[0] ?? "").slice(0, 300);
}

function numberAt(object: JsonObject, key: string): number {
 const value = object[key];
 return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
