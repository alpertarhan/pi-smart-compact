import { describe, expect, it } from "bun:test";
import { registerAnchorCache } from "../src/app/anchor-cache.ts";
import { replayNativeState, type NativeState } from "../src/infra/native-protocol.ts";

type Handler = (event: { type: string; payload: unknown }, ctx: unknown) => unknown;
type Flags = { contextNavigationEnabled: boolean; contextAnchorCacheEnabled: boolean };

function hook(flags: Flags = { contextNavigationEnabled: true, contextAnchorCacheEnabled: true }) {
  let handler: Handler | undefined;
  registerAnchorCache({ on: (event: string, fn: Handler) => void (event === "before_provider_request" && (handler = fn)) } as never, {
    config: () => flags,
  });
  return {
    flags,
    run: (payload: unknown, branch: unknown[]) =>
      handler!({ type: "before_provider_request", payload }, { sessionManager: { getBranch: () => branch } }),
  };
}

interface Control {
  type: "ephemeral";
  ttl?: string;
}

interface Block {
  type: string;
  text?: string;
  tool_use_id?: string;
  cache_control?: Control;
  [key: string]: unknown;
}

interface Payload {
  model: string;
  system: Block[];
  tools: Block[];
  messages: Array<{ role: string; content: Block[] }>;
}

const marker = (ttl?: "1h"): Control => ({ type: "ephemeral" as const, ...(ttl ? { ttl } : {}) });

/** pi-ai shaped Anthropic payload: per round an assistant tool_use turn and a user tool_result turn; rolling marker on the last block. */
function payload(rounds: string[][], opts: { systemMarkers?: number; ttl?: "1h"; shared?: boolean } = {}): Payload {
  const shared = marker(opts.ttl);
  const control = () => (opts.shared ? shared : marker(opts.ttl));
  const messages: Payload["messages"] = [{ role: "user", content: [{ type: "text", text: "task" }] }];
  for (const ids of rounds) {
    messages.push({ role: "assistant", content: ids.map((id) => ({ type: "tool_use", id, name: "tool", input: {} })) });
    messages.push({ role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "result" })) });
  }
  messages.at(-1)!.content.at(-1)!.cache_control = control();
  return {
    model: "claude",
    system: Array.from({ length: opts.systemMarkers ?? 1 }, (_, i) => ({ type: "text", text: `system ${i}`, cache_control: control() })),
    tools: [{ type: "custom", name: "tool", input_schema: {}, cache_control: control() }],
    messages,
  };
}

const toolAnchor = (toolCallId: string, toolName = "smart_navigation") => ({
  type: "message",
  message: { role: "toolResult", toolName, toolCallId, content: [], details: { anchor: { name: toolCallId, summary: "s", targetId: "" } } },
});

/** Marker layout in render order; message markers named by tool_use_id or text. */
function layout(value: Payload): string[] {
  const out: string[] = [];
  for (const block of value.system) if (block.cache_control) out.push("system");
  for (const block of value.tools) if (block.cache_control) out.push("tools");
  for (const message of value.messages) {
    for (const block of message.content) if (block.cache_control) out.push(block.tool_use_id ?? block.text ?? block.type);
  }
  return out;
}

function ttls(value: Payload): Array<string | undefined> {
  const all = [...value.system, ...value.tools, ...value.messages.flatMap((m) => m.content)];
  return all.flatMap((b) => (b.cache_control ? [b.cache_control.ttl] : []));
}

describe("anchor cache layout", () => {
  it("steady state: the newest anchor holds a marker and the rolling tail stays", () => {
    const value = payload([["w1"], ["M"], ["w2"], ["N"], ["w3"]]);
    expect(hook().run(value, [toolAnchor("M"), toolAnchor("N")])).toBe(value);
    expect(layout(value)).toEqual(["system", "tools", "N", "w3"]);
  });

  it("transition: the previous anchor bridges the freshly written span", () => {
    const value = payload([["w1"], ["M"], ["w2"], ["N"]]);
    hook().run(value, [toolAnchor("M"), toolAnchor("N")]);
    expect(layout(value)).toEqual(["system", "tools", "M", "N"]);
  });

  it("transition with parallel results: the bridge displaces the foreign rolling marker", () => {
    const value = payload([["w1"], ["M"], ["w2"], ["N", "w3"]]);
    hook().run(value, [toolAnchor("M"), toolAnchor("N")]);
    expect(layout(value)).toEqual(["system", "tools", "M", "N"]);
  });

  it("the bridge never evicts system or tools markers", () => {
    const value = payload([["M"], ["w1"], ["N"]], { systemMarkers: 2 });
    hook().run(value, [toolAnchor("M"), toolAnchor("N")]);
    expect(layout(value)).toEqual(["system", "system", "tools", "N"]);
  });

  it("anchors from the same fresh round are not bridge targets", () => {
    const value = payload([["A"], ["w1"], ["M", "N"]]);
    hook().run(value, [toolAnchor("A"), toolAnchor("M"), toolAnchor("N")]);
    expect(layout(value)).toEqual(["system", "tools", "A", "N"]);
  });

  it("drops historical message markers before the anchor and caps at four", () => {
    const value = payload([["w1"], ["N"], ["w2"], ["w3"]], { systemMarkers: 2 });
    value.messages[2].content[0].cache_control = marker();
    value.messages[6].content[0].cache_control = marker();
    hook().run(value, [toolAnchor("N")]);
    // w1 precedes the anchor; over the cap, foreign message markers yield before system/tools.
    expect(layout(value)).toEqual(["system", "system", "tools", "N"]);
  });

  it("1h retention: anchor and bridge read 1h, rolling markers after the anchor restart at 5m without mutating shared controls", () => {
    const transition = payload([["M"], ["w1"], ["N"]], { ttl: "1h", shared: true });
    hook().run(transition, [toolAnchor("M"), toolAnchor("N")]);
    expect(layout(transition)).toEqual(["system", "tools", "M", "N"]);
    expect(ttls(transition)).toEqual(["1h", "1h", "1h", "1h"]);

    const steady = payload([["N"], ["w1"]], { ttl: "1h", shared: true });
    const shared = steady.system[0].cache_control!;
    hook().run(steady, [toolAnchor("N")]);
    expect(ttls(steady)).toEqual(["1h", "1h", "1h", "5m"]);
    expect(shared.ttl).toBe("1h");
  });

  it("default retention adds no explicit TTL", () => {
    const value = payload([["N"], ["w1"]]);
    hook().run(value, [toolAnchor("N")]);
    expect(ttls(value)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("finds anchors created on another model by their pi-ai-normalized tool_use_id", () => {
    const rawId = "call_Z9yX8wV7uT6sR5qP4oN3mL2k|fc_0123456789abcdef0123456789abcdef0123456789abcdef01";
    const wireId = "call_Z9yX8wV7uT6sR5qP4oN3mL2k_fc_0123456789abcdef0123456789abcde";
    const steady = payload([["w1"], [wireId], ["w2"]]);
    hook().run(steady, [toolAnchor(rawId)]);
    expect(layout(steady)).toEqual(["system", "tools", wireId, "w2"]);

    const transition = payload([[wireId], ["w1"], ["N"]]);
    hook().run(transition, [toolAnchor(rawId), toolAnchor("N")]);
    expect(layout(transition)).toEqual(["system", "tools", wireId, "N"]);
  });

  it("reads anchors recorded by the old `context` tool as session data", () => {
    const value = payload([["w1"], ["old"], ["w2"]]);
    hook().run(value, [toolAnchor("old", "context")]);
    expect(layout(value)).toEqual(["system", "tools", "old", "w2"]);
  });

  it("ignores tool results without anchor details", () => {
    const value = payload([["w1"], ["plain"], ["w2"]]);
    const before = JSON.stringify(value);
    expect(hook().run(value, [{ type: "message", message: { role: "toolResult", toolName: "smart_navigation", toolCallId: "plain", details: {} } }])).toBeUndefined();
    expect(JSON.stringify(value)).toBe(before);
  });

  it("places the marker on a human anchor custom message", () => {
    const value = payload([["w1"], ["w2"]]);
    const text = "Anchor: parser-done\nParser refactor finished.";
    value.messages.splice(3, 0, { role: "user", content: [{ type: "text", text }] });
    const entry = {
      type: "custom_message",
      customType: "smart-context-anchor",
      content: text,
      display: true,
      details: { anchor: { name: "parser-done", summary: "Parser refactor finished.", targetId: "" } },
    };
    hook().run(value, [entry]);
    expect(layout(value)).toEqual(["system", "tools", text, "w2"]);
  });
});

describe("anchor cache gates", () => {
  it("leaves the payload byte-identical when either setting is off, and follows live toggles", () => {
    const h = hook({ contextNavigationEnabled: true, contextAnchorCacheEnabled: false });
    const branch = [toolAnchor("M"), toolAnchor("N")];
    const off = payload([["w1"], ["M"], ["w2"], ["N"], ["w3"]]);
    const before = JSON.stringify(off);
    expect(h.run(off, branch)).toBeUndefined();
    expect(JSON.stringify(off)).toBe(before);

    h.flags.contextAnchorCacheEnabled = true;
    const on = payload([["w1"], ["M"], ["w2"], ["N"], ["w3"]]);
    h.run(on, branch);
    expect(layout(on)).toEqual(["system", "tools", "N", "w3"]);

    h.flags.contextNavigationEnabled = false;
    const navOff = payload([["w1"], ["M"], ["w2"], ["N"], ["w3"]]);
    expect(h.run(navOff, branch)).toBeUndefined();
    expect(JSON.stringify(navOff)).toBe(before);
  });

  it("leaves non-Anthropic payloads untouched", () => {
    const openai = {
      messages: [
        { role: "system", content: "sys" },
        { role: "tool", tool_call_id: "N", content: [{ type: "tool_result", tool_use_id: "N", content: "r" }] },
        { role: "user", content: [{ type: "text", text: "x", cache_control: marker() }] },
      ],
      tools: [{ type: "function", function: { name: "tool" } }],
    };
    const before = JSON.stringify(openai);
    expect(hook().run(openai, [toolAnchor("N")])).toBeUndefined();
    expect(JSON.stringify(openai)).toBe(before);
  });

  it("adds nothing without an existing rolling message marker (retention none)", () => {
    const value = payload([["w1"], ["N"], ["w2"]]);
    delete value.messages.at(-1)!.content.at(-1)!.cache_control;
    const before = JSON.stringify(value);
    expect(hook().run(value, [toolAnchor("N")])).toBeUndefined();
    expect(JSON.stringify(value)).toBe(before);
  });

  it("skips all rewriting when the anchor is outside the projected history", () => {
    // Mixed TTLs and five markers would be rewritten if the hook touched this payload.
    const value = payload([["w1"], ["w2"]], { ttl: "1h", systemMarkers: 3 });
    value.messages[2].content[0].cache_control = marker();
    const before = JSON.stringify(value);
    expect(hook().run(value, [toolAnchor("compacted-away"), { type: "message", message: { role: "user", content: "hi" } }])).toBeUndefined();
    expect(JSON.stringify(value)).toBe(before);
  });
});

describe("anchor cache with native compaction replay", () => {
  const summary = "Earlier work.";
  const wrapped = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n" + summary + "\n</summary>";
  const state: NativeState = {
    version: 1,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude",
    items: [{ type: "compaction", content: "BLOCK", signature: "signed-state" }],
  };
  const compacted = (rounds: string[][]) => {
    const value = payload(rounds);
    value.messages[0].content = [{ type: "text", text: wrapped }];
    return value;
  };

  it("replays byte-exactly when the anchor was summarized away", () => {
    const pristine = compacted([["w1"], ["w2"]]);
    const hooked = compacted([["w1"], ["w2"]]);
    expect(hook().run(hooked, [toolAnchor("before-compaction"), { type: "compaction", summary }])).toBeUndefined();
    expect(JSON.stringify(replayNativeState("anthropic-messages", hooked, state, summary))).toBe(
      JSON.stringify(replayNativeState("anthropic-messages", pristine, state, summary)),
    );
  });

  it("keeps the anchor marker and the signed state intact through replay", () => {
    const value = compacted([["N"], ["w1"]]);
    const hooked = hook().run(value, [{ type: "compaction", summary }, toolAnchor("N")]);
    const replayed = replayNativeState("anthropic-messages", hooked, state, summary) as unknown as Payload;
    expect(replayed.messages[0].content).toEqual(state.items as unknown as Block[]);
    expect(layout(replayed)).toEqual(["system", "tools", "N", "w1"]);
  });
});
