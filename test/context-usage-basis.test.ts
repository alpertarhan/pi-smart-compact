import { describe, expect, it } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { TokenCalibrationStore, type ReaderIdentity } from "../src/utils/tokens.ts";
import { contextUsage, createUsagePricing, estimateReaderMessageTokens } from "../src/app/context-usage.ts";
import { usageRefusesApplication, readerSignature, revalidatePending, fingerprintContext } from "../src/app/pending-slot.ts";
import { readerUsage } from "../src/app/context-usage.ts";
import { contextPressure } from "../src/app/background-preparation.ts";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";

const CLAUDE: ReaderIdentity = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", input: ["text", "image"] };
const CODEX = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses" } as const;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const usageOf = (output: number, reasoning: number, framing = 10) => ({
  input: 10, output, reasoning, cacheRead: 0, cacheWrite: 0, totalTokens: output + 10 + framing, cost: ZERO_COST,
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

/** Minimal typed Model for the active-reader slot. */
function makeModel(identity: { provider: string; api: string; id: string }) {
  return {
    provider: identity.provider, id: identity.id, api: identity.api, name: identity.id,
    input: ["text", "image"], reasoning: true, contextWindow: 400_000, maxTokens: 32_000,
    baseUrl: "https://fixture.invalid", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  } as never;
}

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
      reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(5_000, 100, 8_000) }),
      say("follow up"),
    ]);
    const pricing = createUsagePricing(CLAUDE, new TokenCalibrationStore());
    const usage = contextUsage(makeCtx(sm, { tokens: 5_000, prompt: "" }), pricing)!;
    // Reserve = producer prompt beyond its own message estimate; body = reader-domain messages.
    expect(usage.basis).toBe("reprojected");
    expect(usage.staleProducer).toBe(true);
    expect(usage.producerEvidence).toMatchObject({ model: CODEX.id, measuredTokens: 13_010 });
    // tokens = reader body + producer residual exactly — never floored at the old
    // total, never normalized by it. Residual = framing the producer carried
    // beyond its REPLAY-priced messages (thinking priced at its live turn).
    expect(usage.tokens!).toBeGreaterThan(7_900);
    expect(usage.tokens!).toBeLessThan(8_400);
    expect(usage.tokens!).not.toBe(13_010);
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
      reply({ provider: CLAUDE.provider, api: CLAUDE.api, model: CLAUDE.id }, { usage: usageOf(3_000, 100, 2_000) }),
      say("q2 " + "w".repeat(40_000)),
      reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(10, 0) }),
    ]);
    const usage = contextUsage(makeCtx(mixed, { tokens: 10, prompt: "" }), pricing)!;
    expect(usage.basis).toBe("reprojected");
    expect(usage.tokens!).toBeGreaterThan(1_800); // same-reader reserve honored
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
    const anchor = reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(500, 10, 900) });
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
      reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(5_000, 100, 8_000) }),
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

  it("labels an unpriced stale measurement so apply gates refuse it", () => {
    // ctx.model is the ACTIVE reader; the anchor came from a different model and
    // no run pricing exists (attention/pressure/pending paths): the old figure
    // must never pass as a current-reader measurement.
    const sm = session([
      say("question"),
      reply({ provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5-5" }, { usage: usageOf(5_000, 100, 8_000) }),
      say("follow up"),
    ]);
    const ctx = { ...makeCtx(sm, { tokens: 13_010, prompt: "" }), model: makeModel({ provider: CODEX.provider, api: CODEX.api as string, id: CODEX.id }) };
    const usage = contextUsage(ctx)!;
    expect(usage.tokens).toBe(13_010); // display keeps the number
    expect(usage.basis).toBe("unavailable");
    expect(usage.staleProducer).toBe(true);
    expect(usageRefusesApplication(usage)).toBe(true);
    // Same-model active reader without pricing stays on today's behavior.
    const same = contextUsage({ ...makeCtx(sm, { tokens: 13_010, prompt: "" }), model: makeModel({ provider: CLAUDE.provider as string, api: CLAUDE.api as string, id: CLAUDE.id }) })!;
    expect(same.basis).toBeUndefined();
    expect(usageRefusesApplication(same)).toBe(false);
  });

  it("bounds possibly-retained thinking per message, not only in the aggregate", () => {
    const glm: ReaderIdentity = { provider: "zai-anthropic", id: "glm-4.6", api: "anthropic-messages" };
    const sm = session([
      say("question"),
      reply({ provider: glm.provider, api: glm.api, model: glm.id }, { usage: usageOf(1_000, 900, 500) }),
      say("next"),
      reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(400, 0, 700) }),
    ]);
    const pricing = createUsagePricing(glm, new TokenCalibrationStore());
    const usage = contextUsage(makeCtx(sm, { tokens: 1_510, prompt: "" }), pricing)!;
    // The SAME per-message weights the window walk uses must carry the upper
    // bound; otherwise total-sum would invent uncompactable fixed framing.
    const weights = estimateReaderMessageTokens(pricing.estimate, contextMessageEntries(sm.getBranch()));
    const sum = weights.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThanOrEqual(1_000); // glm thinking message priced at its full measured output
    expect(usage.basis).toBe("reprojected");
    expect(usage.tokens! - sum).toBeLessThan(1_300); // reserve stays bounded (codex framing), not thinking-sized
  });

  it("treats a versionless Claude alias as unknown retention, not table-backed", () => {
    const alias: ReaderIdentity = { provider: "fixture", id: "claude-opus-latest", api: "anthropic-messages" };
    const anchor = reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(500, 10, 900) });
    const bounded = session([
      say("question"),
      reply({ provider: alias.provider, api: alias.api, model: alias.id }, { usage: usageOf(1_000, 900) }),
      say("next"),
      anchor,
    ]);
    const pricing = createUsagePricing(alias, new TokenCalibrationStore());
    const usage = contextUsage(makeCtx(bounded, { tokens: 1_510, prompt: "" }), pricing)!;
    expect(usage.basis).toBe("reprojected"); // clean metadata bounds retained thinking
    expect(usage.tokens!).toBeGreaterThan(900);
    const unboundable = contextUsage(
      makeCtx(session([
        say("question"),
        reply({ provider: alias.provider, api: alias.api, model: alias.id }, {
          usage: undefined,
          content: [{ type: "thinking", thinking: "opaque retained reasoning" }, { type: "text", text: "done" }],
        }),
        anchor,
      ]), { tokens: 1_000, prompt: "" }),
      pricing,
    )!;
    expect(unboundable.basis).toBe("uncertain");
    expect(usageRefusesApplication(unboundable)).toBe(true);
  });

  it("prices an edited producer prefix on retained content, not invalid metadata", () => {
    const sm = session([
      say("question"),
      reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(5_000, 100, 8_000) }),
      say("follow up"),
    ]);
    // Edit the anchor's covered prefix: replay proxies no longer apply to it.
    sm.appendContextEdit(sm.getBranch().at(-1)!.id, { content: "edited" });
    const pricing = createUsagePricing(CLAUDE, new TokenCalibrationStore());
    const usage = contextUsage(makeCtx(sm, { tokens: 13_010, prompt: "" }), pricing)!;
    expect(usage.basis === "reprojected" || usage.basis === "anchored").toBe(true);
    // The reserve stays in a sane band: full framing, never the edited thinking.
    expect(usage.tokens!).toBeLessThan(13_010);
    expect(usage.tokens!).toBeGreaterThan(100);
  });

  it("reprices upward when the reader domain prices above the old measurement", () => {
    const calibration = new TokenCalibrationStore();
    // Reader prices 3x its default estimate: its body must exceed the old total.
    calibration.calibrate(100, 300, CLAUDE.provider, CLAUDE.id);
    const pricing = createUsagePricing(CLAUDE, calibration);
    const sm = session([
      say("question " + "w".repeat(60_000)),
      reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(400, 0, 31_000) }),
      say("follow up " + "w".repeat(60_000)),
    ]);
    const usage = contextUsage(makeCtx(sm, { tokens: 31_410, prompt: "" }), pricing)!;
    expect(usage.basis).toBe("reprojected");
    expect(usage.tokens!).toBeGreaterThan(60_000); // upward reprice, no old-total ceiling either
    const fresh = createUsagePricing(CLAUDE, new TokenCalibrationStore());
    expect(fresh.factors()).not.toBe(pricing.factors()); // snapshot fingerprints differ
  });

  it("applies a fully priced stale candidate before the reader's first reply", () => {
    const producer: ReaderIdentity = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages" };
    const reader = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", input: ["text" ] as const, contextWindow: 65_536, maxTokens: 8_192 };
    const sm = session([
      say("Project status: " + "a".repeat(200_000)),
      reply({ provider: producer.provider, api: producer.api, model: producer.id }, {
        usage: usageOf(100_000, 99_990, 60_000), stopReason: "stop",
        content: [{ type: "thinking", thinking: "brief", thinkingSignature: "opaque" }, { type: "text", text: "Done" }],
      }),
      say("Continue the task"),
    ]);
    const ctx = { ...makeCtx(sm, { tokens: 160_010, prompt: "System" }), model: makeModel({ provider: reader.provider, api: reader.api as string, id: reader.id }) };
    const pricing = createUsagePricing(reader, new TokenCalibrationStore());
    const priced = contextUsage(ctx, pricing)!;
    expect(priced.basis).toBe("reprojected");
    const weights = estimateReaderMessageTokens(pricing.estimate, contextMessageEntries(sm.getBranch()));
    const after = (priced.tokens! - weights.reduce((a, b) => a + b, 0)) + weights.at(-1)! + pricing.estimate.text("## Goal\nContinue the task\n");
    const pending = {
      sessionId: sm.getSessionId(), originBranchHeadId: sm.getLeafId(), firstKeptEntryId: sm.getLeafId(),
      readerSignature: readerSignature(ctx as never), contextSnapshot: fingerprintContext(contextMessageEntries(sm.getBranch())),
      summary: "## Goal\nContinue the task\n", tokensBefore: priced.tokens!,
      usagePricing: pricing, // carried by the real constructors (persist.ts / native-compaction.ts)
      details: { estimatedAfterTokens: after, retainedTailTokens: weights.at(-1), targetAfterTokens: Math.floor(priced.tokens! / 2) },
    };
    // Sufficient data applies through the real final gate; no waiting for a first reply.
    expect(revalidatePending(pending as never, ctx as never)).not.toBeNull();
    // A legacy pending without carried pricing still fails closed on proven stale.
    expect(revalidatePending({ ...pending, usagePricing: undefined } as never, ctx as never)).toBeNull();
  });

  it("labels a proven-stale basis even when repricing throws", () => {
    const sm = session([
      say("question"),
      reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(5_000, 100, 8_000) }),
      say("follow up"),
    ]);
    const pricing = createUsagePricing(CLAUDE, new TokenCalibrationStore());
    const ctx = { ...makeCtx(sm, { tokens: 13_010, prompt: "" }), getSystemPrompt: () => { throw new Error("boom"); } };
    const usage = contextUsage(ctx, pricing)!;
    expect(usage.basis).toBe("unavailable");
    expect(usage.staleProducer).toBe(true);
    expect(usageRefusesApplication(usage)).toBe(true);
  });

  it("treats partial legacy metadata with matching fields as the same reader", () => {
    // api/model missing on the anchor: known fields match the active reader, so
    // this is NOT proven stale — today's fast path applies, no refusal label.
    const sm = session([
      say("question"),
      reply({ provider: "anthropic" }, { usage: usageOf(5_000, 100, 8_000) }),
      say("follow up"),
    ]);
    const pricing = createUsagePricing(CLAUDE, new TokenCalibrationStore());
    const ctx = { ...makeCtx(sm, { tokens: 13_010, prompt: "" }), model: makeModel({ provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5-5" }) };
    const usage = contextUsage(ctx, pricing)!;
    expect(usage.tokens).toBe(13_010);
    expect(usage.basis).toBeUndefined();
    expect(usage.staleProducer).toBeUndefined();
  });

  it("reprices pressure gates through the current reader", () => {
    const sm = session([
      say("question"),
      reply({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: usageOf(5_000, 100, 8_000) }),
      say("follow up"),
    ]);
    const ctx = { ...makeCtx(sm, { tokens: 13_010, prompt: "" }), model: makeModel({ provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5-5" }) };
    const repriced = readerUsage(ctx)!;
    expect(repriced.basis).toBe("reprojected");
    expect(repriced.tokens!).not.toBe(13_010);
    const pressure = contextPressure(ctx, { minContextPercent: 0, prepareContextPercent: 40, maxContextTokens: 1_000_000 });
    expect(pressure.tokens).toBe(repriced.tokens); // gate sees the reader domain, not the raw old count
  });

  it("includes the input capability in the pending reader signature", () => {
    const base = { provider: "anthropic", id: "m", api: "anthropic-messages", baseUrl: "u", contextWindow: 1, maxTokens: 2, input: ["text", "image"] };
    const model = (input?: string[]) => ({ ...base, ...(input ? { input } : {}) });
    expect(readerSignature({ model: model(["text", "image"]) } as never)).toBeDefined();
    expect(readerSignature({ model: model(["text"]) } as never)).not.toBe(readerSignature({ model: model(["text", "image"]) } as never));
    expect(readerSignature({ model: model(undefined) } as never)).not.toBe(readerSignature({ model: model(["text"]) } as never));
  });
});
