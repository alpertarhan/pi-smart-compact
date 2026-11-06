import { describe, expect, it } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { TokenCalibrationStore, type ReaderIdentity } from "../src/utils/tokens.ts";
import { contextUsage, createUsagePricing } from "../src/app/context-usage.ts";
import { readerSignature } from "../src/app/pending-slot.ts";

const CLAUDE: ReaderIdentity = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", input: ["text", "image"] };
const CODEX = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses" } as const;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const usageOf = (output: number, reasoning: number) => ({
  input: 10, output, reasoning, cacheRead: 0, cacheWrite: 0, totalTokens: output + 10, cost: ZERO_COST,
});

/** Typed fixture builder: SessionManager owns entry ids, timestamps, and parent links. */
function session(steps: Array<(sm: SessionManager) => void>): SessionManager {
  const sm = SessionManager.inMemory();
  for (const step of steps) step(sm);
  return sm;
}

const say = (text: string) => (sm: SessionManager) =>
  sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

const reply = (identity: Record<string, unknown>, changes: Partial<AssistantMessage> = {}) => (sm: SessionManager) =>
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "answer " + "x".repeat(200) }],
    stopReason: "endTurn",
    usage: usageOf(120, 90),
    timestamp: 2,
    ...identity,
    ...changes,
  } as AssistantMessage);

function makeCtx(sm: SessionManager, opts: { tokens: number; prompt?: string } = { tokens: 0 }) {
  return {
    getContextUsage: () => ({ tokens: opts.tokens, contextWindow: 400_000, percent: opts.tokens / 400_000 * 100 }),
    sessionManager: sm,
    getSystemPrompt: opts.prompt === undefined ? undefined : () => opts.prompt as string,
  };
}

describe("contextUsage stale-producer repricing", () => {
  it("reprices in the reader domain without any old-total floor", () => {
    const sm = session([
      say("question one two three four five"),
      reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(5_000, 100) }),
      say("follow up"),
    ]);
    const pricing = createUsagePricing(CLAUDE, new TokenCalibrationStore());
    const usage = contextUsage(makeCtx(sm, { tokens: 5_000, prompt: "" }), pricing)!;
    // Reserve = producer prompt beyond its own message estimate; body = reader-domain messages.
    expect(usage.basis).toBe("reprojected");
    expect(usage.staleProducer).toBe(true);
    expect(usage.producerEvidence).toMatchObject({ model: CODEX.id, measuredTokens: 5_010 });
    // tokens = reader body + producer residual exactly — never floored at the old
    // total, never normalized by it (small fixture: both land near the residual).
    expect(usage.tokens!).toBeGreaterThan(4_900);
    expect(usage.tokens!).toBeLessThan(5_200);
    expect(usage.tokens!).not.toBe(5_000);
  });

  it("keeps same-reader and legacy paths on today's behavior", () => {
    const pricing = createUsagePricing(CLAUDE, new TokenCalibrationStore());
    const sameModel = session([
      say("question"),
      reply({ provider: CLAUDE.provider, api: CLAUDE.api, model: CLAUDE.id }),
    ]);
    const usage = contextUsage(makeCtx(sameModel, { tokens: 12_345, prompt: "" }), pricing)!;
    expect(usage.tokens).toBe(12_345);
    expect(usage.basis).toBeUndefined(); // fast path: untouched passthrough
    // Legacy anchor without identity metadata cannot prove staleness.
    const legacy = session([say("old session"), reply({})]);
    const legacyUsage = contextUsage(makeCtx(legacy, { tokens: 9_999, prompt: "" }), pricing)!;
    expect(legacyUsage.tokens).toBe(9_999);
    expect(legacyUsage.basis).toBeUndefined();
  });

  it("does not treat a clamped residual as proven zero framing", () => {
    const pricing = createUsagePricing(CLAUDE, new TokenCalibrationStore());
    // Producer message estimate exceeds its own measured total: residual clamps 0.
    const mixed = session([
      say("q1 " + "w".repeat(4_000)),
      // Earlier SAME-READER measurement with a positive residual.
      reply({ provider: CLAUDE.provider, api: CLAUDE.api, model: CLAUDE.id }, { usage: usageOf(3_000, 100) }),
      say("q2 " + "w".repeat(40_000)),
      reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(10, 0) }),
    ]);
    const usage = contextUsage(makeCtx(mixed, { tokens: 10, prompt: "" }), pricing)!;
    expect(usage.basis).toBe("reprojected");
    expect(usage.tokens!).toBeGreaterThan(2_000); // same-reader reserve honored
    // No same-reader anchor and no system prompt: partial evidence refuses to assert certainty.
    const noReserve = contextUsage(
      makeCtx(session([
        say("q " + "w".repeat(60_000)),
        reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(5, 0) }),
      ]), { tokens: 5, prompt: undefined }),
      pricing,
    )!;
    expect(noReserve.basis).toBe("uncertain");
  });

  it("bounds possibly-retained thinking for unknown-retention readers", () => {
    const glm: ReaderIdentity = { provider: "zai-anthropic", id: "glm-4.6", api: "anthropic-messages" };
    const anchor = reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(500, 10) });
    // Stale anchor from another model; the branch also carries the READER's own
    // prior-turn thinking, whose retention rules are unverified for this vendor.
    const bounded = session([
      say("question"),
      reply({ provider: glm.provider, api: glm.api, model: glm.id }, { usage: usageOf(1_000, 900) }),
      say("next"),
      anchor,
    ]);
    const pricing = createUsagePricing(glm, new TokenCalibrationStore());
    const usage = contextUsage(makeCtx(bounded, { tokens: 1_000, prompt: "" }), pricing)!;
    // The measured reasoning bounds the possibly-retained thinking from above.
    expect(usage.basis).toBe("reprojected");
    expect(usage.tokens!).toBeGreaterThan(900);
    // A thinking message without valid metadata is unboundable: insufficient confidence.
    const unboundable = contextUsage(
      makeCtx(session([
        say("question"),
        reply({ provider: glm.provider, api: glm.api, model: glm.id }, {
          usage: undefined,
          content: [{ type: "thinking", thinking: "opaque retained reasoning" }, { type: "text", text: "done" }],
        }),
        anchor,
      ]), { tokens: 1_000, prompt: "" }),
      pricing,
    )!;
    expect(unboundable.basis).toBe("uncertain");
  });

  it("freezes pricing factors for the pricing's lifetime and keys the memo by inputs", () => {
    const calibration = new TokenCalibrationStore();
    const pricing = createUsagePricing(CLAUDE, calibration);
    const base = session([
      say("question one two three four five"),
      reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(5_000, 100) }),
      say("follow up"),
    ]);
    const ctx = makeCtx(base, { tokens: 5_000, prompt: "" });
    const before = contextUsage(ctx, pricing)!;
    // A mid-run calibration update of the reader bucket must not reprice this pricing.
    calibration.calibrate(1000, 400, CLAUDE.provider, CLAUDE.id);
    const after = contextUsage(ctx, pricing)!;
    expect(after.tokens).toBe(before.tokens);
    // A fresh pricing built after the calibration update recomputes (different fingerprint).
    const fresh = contextUsage(ctx, createUsagePricing(CLAUDE, calibration))!;
    expect(fresh.basis).toBe("reprojected");
    // A reader input flip must invalidate the memo: with an image on the wire, a
    // text-only reader prices the placeholder, a vision reader the patch tokens.
    const png = Buffer.alloc(64);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
    png.writeUInt32BE(13, 8); png.write("IHDR", 12, "ascii"); png.writeUInt32BE(3840, 16); png.writeUInt32BE(2160, 20);
    base.appendMessage({ role: "user", content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }], timestamp: 3 });
    const imageCtx = makeCtx(base, { tokens: 5_000, prompt: "" });
    const vision = contextUsage(imageCtx, createUsagePricing(CLAUDE, calibration))!;
    const textOnly = contextUsage(imageCtx, createUsagePricing({ ...CLAUDE, input: ["text"] }, calibration))!;
    expect(vision.basis).toBe("reprojected");
    expect(vision.tokens! - textOnly.tokens!).toBeGreaterThan(4_000); // 4784 patches vs ~placeholder text
  });

  it("includes the input capability in the pending reader signature", () => {
    const base = { provider: "anthropic", id: "m", api: "anthropic-messages", baseUrl: "u", contextWindow: 1, maxTokens: 2, input: ["text", "image"] };
    const model = (input?: string[]) => ({ ...base, ...(input ? { input } : {}) });
    expect(readerSignature({ model: model(["text", "image"]) } as never)).toBeDefined();
    expect(readerSignature({ model: model(["text"]) } as never)).not.toBe(readerSignature({ model: model(["text", "image"]) } as never));
    expect(readerSignature({ model: model(undefined) } as never)).not.toBe(readerSignature({ model: model(["text"]) } as never));
  });
});
