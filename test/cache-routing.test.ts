// Cache routing-key injection (I): a stable per-session body field improves
// engine routing stickiness where the provider documents one (OpenAI
// `prompt_cache_key`). Opt-in, provider-gated through the caps matrix, and
// never overrides a key the host already set.
import { describe, expect, it } from "bun:test";
import { applyCacheRoutingKey, type RoutingContext } from "../src/app/cache-routing.ts";

function openaiPayload(): Record<string, unknown> {
  return {
    model: "gpt-5.6",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  };
}

function responsesPayload(): Record<string, unknown> {
  return { model: "gpt-6", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] };
}

function anthropicPayload(): Record<string, unknown> {
  return {
    system: [{ type: "text", text: "sys" }],
    tools: [{ name: "tool", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
}

function ctx(sessionId: string, provider: string, id = "m"): RoutingContext {
  return {
    sessionManager: { getSessionId: () => sessionId },
    model: { provider, id },
  } as unknown as RoutingContext;
}

describe("applyCacheRoutingKey", () => {
  it("does nothing while disabled (default)", () => {
    const payload = openaiPayload();
    expect(applyCacheRoutingKey(payload, ctx("s1", "openai"), () => false)).toBeUndefined();
    expect(Object.hasOwn(payload, "prompt_cache_key")).toBe(false);
  });

  it("stamps a stable per-session key on OpenAI-shaped payloads", () => {
    const first = openaiPayload();
    const second = openaiPayload();
    applyCacheRoutingKey(first, ctx("s1", "openai", "gpt-5.6"), () => true);
    applyCacheRoutingKey(second, ctx("s1", "openai", "gpt-5.6"), () => true);
    expect(typeof first.prompt_cache_key).toBe("string");
    expect((first.prompt_cache_key as string).length).toBeGreaterThan(8);
    expect(first.prompt_cache_key).toBe(second.prompt_cache_key);
  });

  it("uses different keys for different sessions", () => {
    const a = openaiPayload();
    const b = openaiPayload();
    applyCacheRoutingKey(a, ctx("s1", "openai"), () => true);
    applyCacheRoutingKey(b, ctx("s2", "openai"), () => true);
    expect(a.prompt_cache_key).not.toBe(b.prompt_cache_key);
  });

  it("covers Responses-style input payloads", () => {
    const payload = responsesPayload();
    applyCacheRoutingKey(payload, ctx("s1", "openai"), () => true);
    expect(typeof payload.prompt_cache_key).toBe("string");
  });

  it("never overrides a key the host already set", () => {
    const payload = openaiPayload();
    payload.prompt_cache_key = "host-chosen-key";
    applyCacheRoutingKey(payload, ctx("s1", "openai"), () => true);
    expect(payload.prompt_cache_key).toBe("host-chosen-key");
  });

  it("leaves Anthropic-shaped payloads untouched even for openai sessions", () => {
    const payload = anthropicPayload();
    const before = JSON.stringify(payload);
    expect(applyCacheRoutingKey(payload, ctx("s1", "openai"), () => true)).toBeUndefined();
    expect(JSON.stringify(payload)).toBe(before);
  });

  it("leaves payloads for providers without a documented routing key untouched", () => {
    const payload = openaiPayload();
    applyCacheRoutingKey(payload, ctx("s1", "anthropic"), () => true);
    expect(Object.hasOwn(payload, "prompt_cache_key")).toBe(false);
  });

  it("does not claim header routing keys are injectable through the body", () => {
    const payload = openaiPayload();
    applyCacheRoutingKey(payload, ctx("s1", "xai"), () => true);
    expect(Object.hasOwn(payload, "prompt_cache_key")).toBe(false);
    expect(Object.hasOwn(payload, "x-grok-conv-id")).toBe(false);
  });

  it("ignores unresolved sessions: no stable key exists to pin", () => {
    const first = openaiPayload();
    const second = openaiPayload();
    applyCacheRoutingKey(first, ctx("unresolved:aaa", "openai"), () => true);
    applyCacheRoutingKey(second, ctx("unresolved:bbb", "openai"), () => true);
    expect(Object.hasOwn(first, "prompt_cache_key")).toBe(false);
    expect(Object.hasOwn(second, "prompt_cache_key")).toBe(false);
  });

  it("ignores non-object payloads", () => {
    expect(applyCacheRoutingKey("strings are not payloads", ctx("s1", "openai"), () => true)).toBeUndefined();
    expect(applyCacheRoutingKey(null, ctx("s1", "openai"), () => true)).toBeUndefined();
  });

  it("keeps the key stable when only the model id changes within a session", () => {
    const a = openaiPayload();
    const b = openaiPayload();
    applyCacheRoutingKey(a, ctx("s1", "openai", "gpt-5.6"), () => true);
    applyCacheRoutingKey(b, ctx("s1", "openai", "gpt-6"), () => true);
    expect(a.prompt_cache_key).toBe(b.prompt_cache_key);
  });
});
