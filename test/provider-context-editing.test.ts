import { describe, expect, it } from "bun:test";
import { applyProviderContextEditing, CONTEXT_MANAGEMENT_BETA, type ProviderContextEditing } from "../src/app/provider-context-editing.ts";
import { DEFAULT_CONFIG } from "../src/constants.ts";

const MODEL = { api: "anthropic-messages", provider: "anthropic", id: "claude-test", contextWindow: 200_000 };
const ctx = { model: MODEL, getContextUsage: () => ({ tokens: 10_000 }) } as never;
const tools = ["bash", "read", "edit", "ask_user", "search_graph", "smart_context"].map(name => ({ name, input_schema: {} }));
const payload = (extra: Record<string, unknown> = {}) => ({ model: "claude-test", messages: [], tools, ...extra }) as Record<string, any>;
const config = (level: ProviderContextEditing) => ({ ...DEFAULT_CONFIG, providerContextEditing: level });

describe("provider context editing", () => {
  it("is off by default and leaves the request untouched", () => {
    const body = payload();
    applyProviderContextEditing(body, ctx, DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.providerContextEditing).toBe("off");
    expect(body).toEqual(payload());
  });

  it("clears only old shell and research results from the cleanup band, with its beta in the same request", () => {
    const body = payload({ betas: ["fine-grained-tool-streaming-2025-05-14"] });
    applyProviderContextEditing(body, ctx, config("tool-results"));
    const [edit] = body.context_management.edits;
    expect(body.context_management.edits).toHaveLength(1);
    expect(edit).toMatchObject({ type: "clear_tool_uses_20250919", keep: { type: "tool_uses", value: 8 } });
    expect(edit.trigger).toEqual({ type: "input_tokens", value: expect.any(Number) });
    expect(edit.exclude_tools).toEqual(["read", "edit", "ask_user", "smart_context"]);
    expect(body.betas).toEqual(["fine-grained-tool-streaming-2025-05-14", CONTEXT_MANAGEMENT_BETA]);
  });

  it("lists thinking clearing first, as the API requires", () => {
    const body = payload();
    applyProviderContextEditing(body, ctx, config("tool-results-and-thinking"));
    expect(body.context_management.edits.map((edit: { type: string }) => edit.type))
      .toEqual(["clear_thinking_20251015", "clear_tool_uses_20250919"]);
    expect(body.context_management.edits[0].keep).toEqual({ type: "thinking_turns", value: 4 });
  });

  it.each([
    ["a summarizer or side route", payload({ model: "other-model" }), ctx],
    ["another provider", payload(), { ...(ctx as object), model: { ...MODEL, provider: "minimax" } }],
    ["an existing context_management", payload({ context_management: { edits: [] } }), ctx],
  ])("leaves %s alone", (_label, body, context) => {
    const before = structuredClone(body);
    applyProviderContextEditing(body, context as never, config("tool-results-and-thinking"));
    expect(body).toEqual(before);
  });
});
