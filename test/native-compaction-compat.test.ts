/** Offline capability probes against the REAL Pi adapters. No provider traffic or credentials.
 * These pin current blockers, not desired support. Revisit when a host upgrade makes them fail.
 */
import { describe, expect, it } from "bun:test";
import { normalizeContext, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertResponsesMessages, processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

const anthropic = anthropicProvider().getModels().find(model => model.id === "claude-sonnet-5")!;
const openai = openaiProvider().getModels().find(model => model.id === "gpt-5.4")!;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const block = { type: "compaction", content: "Keep the user's constraints", signature: "OFFLINE_SIGNATURE" };
const user: Message = { role: "user", content: "Continue", timestamp: 1 };
const sse = (events: Array<{ type: string; [key: string]: unknown }>) => new Response(events.map(event =>
  "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n").join(""),
  { headers: { "content-type": "text/event-stream" } });

const offlineFetch = (handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch =>
  Object.assign(handler, { preconnect() {} });

function signedMessage(): AssistantMessage {
  // Deliberately simulate an upstream block not representable by Pi's content union.
  return { role: "assistant", api: anthropic.api, provider: anthropic.provider, model: anthropic.id,
    content: [block], stopReason: "stop", usage, timestamp: 1 } as unknown as AssistantMessage;
}

describe("native compaction transport blockers (Pi 0.87.1)", () => {
  it("can request Anthropic compaction, but loses the signed block, stop reason and iteration usage", async () => {
    let request: any;
    const result = await anthropicStream(anthropic, normalizeContext({ messages: [user] }), {
      apiKey: "offline-placeholder", maxRetries: 0, timeoutMs: 1000,
      headers: { "anthropic-beta": "compact-2026-09-04" },
      onPayload: payload => ({ ...(payload as object), compaction: { type: "summarize" } }),
      fetch: offlineFetch(async (_url, init) => {
        request = JSON.parse(String(init?.body));
        return sse([
          { type: "message_start", message: { id: "msg_offline", type: "message", role: "assistant", model: anthropic.id,
            content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: block },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "compaction" }, usage: { input_tokens: 0, output_tokens: 0,
            iterations: [{ type: "compaction", input_tokens: 144, output_tokens: 276 }] } },
          { type: "message_stop" },
        ]);
      }),
    }).result();
    expect(request.compaction).toEqual({ type: "summarize" });
    expect(result.content).toEqual([]);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Unhandled stop reason: compaction");
    expect(result.usage.totalTokens).toBe(0); // Not a free call: usage.iterations was not parsed.
  });

  it("JSONL can retain opaque metadata, but Anthropic replay still drops its compaction block", async () => {
    const session = SessionManager.inMemory();
    session.appendMessage(signedMessage());
    session.appendMessage(user);
    const persisted = JSON.parse(JSON.stringify([session.getHeader(), ...session.getBranch()]));
    const reloaded = SessionManager.inMemory(process.cwd(), undefined, persisted);
    const messages = convertToLlm(reloaded.buildSessionContext().messages);
    expect(JSON.stringify(messages)).toContain("OFFLINE_SIGNATURE");
    let payload = "";
    const result = await anthropicStream(anthropic, normalizeContext({ messages }), {
      apiKey: "offline-placeholder", maxRetries: 0,
      onPayload: value => { payload = JSON.stringify(value); },
      fetch: offlineFetch(async () => sse([
        { type: "message_start", message: { id: "offline", model: anthropic.id, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ])),
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "OK" }]);
    expect(payload).toContain("Continue");
    expect(payload).not.toContain("OFFLINE_SIGNATURE");
  });

  it("OpenAI Responses ignores compaction output items and cannot replay them as assistant content", async () => {
    const item = { type: "compaction", id: "cmp_offline", encrypted_content: "OPAQUE_OFFLINE_CONTENT" };
    const output: AssistantMessage = { role: "assistant", api: openai.api, provider: openai.provider, model: openai.id,
      content: [], stopReason: "pending", timestamp: 1, usage: structuredClone(usage) };
    async function* events() {
      yield { type: "response.output_item.added", output_index: 0, item };
      yield { type: "response.output_item.done", output_index: 0, item };
      yield { type: "response.completed", response: { status: "completed", output: [item],
        usage: { input_tokens: 144, output_tokens: 276, total_tokens: 420 } } };
    }
    // Feed wire fixtures into the actual exported stream parser, not a replacement parser.
    await processResponsesStream(events() as Parameters<typeof processResponsesStream>[0], output, createAssistantMessageEventStream(), openai);
    expect(output.content).toHaveLength(0);
    expect(output.usage.totalTokens).toBe(420);
    const injected = { ...output, content: [item] } as unknown as AssistantMessage;
    const replay = convertResponsesMessages(openai, normalizeContext({ messages: [injected, user] }), new Set([openai.provider]));
    expect(JSON.stringify(replay)).toContain("Continue");
    expect(JSON.stringify(replay)).not.toContain("OPAQUE_OFFLINE_CONTENT");
  });
});
