import { describe, expect, it } from "bun:test";
import { TokenCalibrationStore } from "../src/utils/tokens.ts";
import { contextUsage, createUsagePricing } from "../src/app/context-usage.ts";
import { readerSignature } from "../src/app/pending-slot.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const CLAUDE = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", input: ["text", "image"] } as const;
const CODEX = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses" } as const;

let nextId = 0;
let lastId: string | undefined;
function link(entry: { id: string }) {
  const parentId = lastId;
  lastId = entry.id;
  return parentId;
}
function user(text: string) {
  const entry = { type: "message", id: "e" + nextId++, message: { role: "user", content: [{ type: "text", text }] } };
  return { ...entry, parentId: link(entry) };
}
function assistant(identity: Record<string, unknown>, changes: Record<string, unknown> = {}) {
  const entry = { type: "message", id: "e" + nextId++ };
  const parentId = link(entry);
  return {
    ...entry, parentId,
    message: {
      role: "assistant", stopReason: "endTurn",
      content: [{ type: "text", text: "answer " + "x".repeat(200) }],
      usage: { input: 10, output: 120, reasoning: 90, cacheRead: 0, cacheWrite: 0, totalTokens: 220 },
      ...identity, ...changes,
    },
  };
}

function makeCtx(branch: SessionEntry[], opts: { tokens: number; prompt?: string; model?: unknown } = { tokens: 0 }) {
  const byId = new Map(branch.map(entry => [entry.id, entry]));
  return {
    getContextUsage: () => ({ tokens: opts.tokens, contextWindow: 400_000, percent: opts.tokens / 400_000 * 100 }),
    sessionManager: {
      getBranch: () => branch,
      getLeafEntry: () => branch.at(-1),
      getEntry: (id: string) => byId.get(id),
    },
    getSystemPrompt: opts.prompt === undefined ? undefined : () => opts.prompt,
    model: opts.model,
  } as any;
}

const codexBranch = (anchorTokens: number) => [
  user("question one two three four five"),
  assistant({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: { input: 10, output: anchorTokens, reasoning: 100, cacheRead: 0, cacheWrite: 0, totalTokens: anchorTokens + 10 } }),
  user("follow up"),
];

describe("contextUsage stale-producer repricing", () => {
  it("reprices in the reader domain without any old-total floor", () => {
    const branch = codexBranch(5_000);
    const pricing = createUsagePricing(CLAUDE, new TokenCalibrationStore());
    const dbgCtx = makeCtx(branch, { tokens: 5_000, prompt: "" });
    const usage = contextUsage(dbgCtx, pricing)!;
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
    const sameModel = [
      user("question"),
      assistant({ provider: CLAUDE.provider, api: CLAUDE.api, model: CLAUDE.id }),
    ];
    const pricing = createUsagePricing(CLAUDE, new TokenCalibrationStore());
    const ctx = makeCtx(sameModel, { tokens: 12_345, prompt: "" });
    const usage = contextUsage(ctx, pricing)!;
    expect(usage.tokens).toBe(12_345);
    expect(usage.basis).toBeUndefined(); // fast path: untouched passthrough
    // Legacy anchor without identity metadata cannot prove staleness.
    const legacy = [
      user("old session"),
      assistant({}, { provider: undefined, api: undefined, model: undefined }),
    ];
    const legacyUsage = contextUsage(makeCtx(legacy, { tokens: 9_999, prompt: "" }), pricing)!;
    expect(legacyUsage.tokens).toBe(9_999);
    expect(legacyUsage.basis).toBeUndefined();
  });

  it("does not treat a clamped residual as proven zero framing", () => {
    // Producer message estimate exceeds its own measured total: residual clamps 0.
    const branch = [
      user("q1 " + "w".repeat(4_000)),
      // Earlier SAME-READER measurement with a positive residual.
      assistant({ provider: CLAUDE.provider, api: CLAUDE.api, model: CLAUDE.id }, { usage: { input: 5, output: 3_000, reasoning: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 3_005 } }),
      user("q2 " + "w".repeat(40_000)),
      assistant({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: { input: 10, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 20 } }),
    ];
    const pricing = createUsagePricing(CLAUDE, new TokenCalibrationStore());
    const usage = contextUsage(makeCtx(branch, { tokens: 10, prompt: "" }), pricing)!;
    expect(usage.basis).toBe("reprojected");
    expect(usage.tokens!).toBeGreaterThan(2_000); // same-reader reserve honored
    // No same-reader anchor and no system prompt: partial evidence refuses to assert certainty.
    const noReserve = contextUsage(
      makeCtx([
        user("q " + "w".repeat(60_000)),
        assistant({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } }),
      ], { tokens: 5, prompt: undefined }),
      pricing,
    )!;
    expect(noReserve.basis).toBe("uncertain");
  });

  it("bounds possibly-retained thinking for unknown-retention readers", () => {
    const glm = { provider: "zai-anthropic", id: "glm-4.6", api: "anthropic-messages" } as const;
    // Stale anchor from another model; the branch also carries the READER's own
    // prior-turn thinking, whose retention rules are unverified for this vendor.
    const anchor = () => assistant({ provider: CODEX.provider, api: CODEX.api, model: CODEX.id }, { usage: { input: 10, output: 500, reasoning: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 510 } });
    const branch = [
      user("question"),
      assistant({ provider: glm.provider, api: glm.api, model: glm.id }, { usage: { input: 10, output: 1_000, reasoning: 900, cacheRead: 0, cacheWrite: 0, totalTokens: 1_010 } }),
      user("next"),
      anchor(),
    ];
    const pricing = createUsagePricing(glm, new TokenCalibrationStore());
    const usage = contextUsage(makeCtx(branch, { tokens: 1_000, prompt: "" }), pricing)!;
    // The measured reasoning bounds the possibly-retained thinking from above.
    expect(usage.basis).toBe("reprojected");
    expect(usage.tokens!).toBeGreaterThan(900);
    // A thinking message without valid metadata is unboundable: insufficient confidence.
    const unboundable = contextUsage(
      makeCtx([
        user("question"),
        assistant({ provider: glm.provider, api: glm.api, model: glm.id }, {
          usage: undefined,
          content: [{ type: "thinking", thinking: "opaque retained reasoning" }, { type: "text", text: "done" }],
        }),
        anchor(),
      ], { tokens: 1_000, prompt: "" }),
      pricing,
    )!;
    expect(unboundable.basis).toBe("uncertain");
  });

  it("freezes pricing factors for the pricing's lifetime and keys the memo by inputs", () => {
    const branch = codexBranch(5_000);
    const calibration = new TokenCalibrationStore();
    const pricing = createUsagePricing(CLAUDE, calibration);
    const ctx = makeCtx(branch, { tokens: 5_000, prompt: "" });
    const before = contextUsage(ctx, pricing)!;
    // A mid-run calibration update of the reader bucket must not reprice this pricing.
    calibration.calibrate(1000, 400, CLAUDE.provider, CLAUDE.id);
    const after = contextUsage(ctx, pricing)!;
    expect(after.tokens).toBe(before.tokens);
    // A NEW pricing sees the updated factor (different fingerprint, recompute).
    // A fresh pricing built after the calibration update recomputes (different fingerprint).
    const fresh = contextUsage(ctx, createUsagePricing(CLAUDE, calibration))!;
    expect(fresh.basis).toBe("reprojected");
    // A reader input flip must invalidate the memo: with an image on the wire, a
    // text-only reader prices the placeholder, a vision reader the patch tokens.
    const png = Buffer.alloc(64);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
    png.writeUInt32BE(13, 8); png.write("IHDR", 12, "ascii"); png.writeUInt32BE(3840, 16); png.writeUInt32BE(2160, 20);
    const imgEntry = { type: "message", id: "e-img", message: { role: "user", content: [{ type: "image", data: png.toString("base64") }] } };
    branch.push({ ...imgEntry, parentId: link(imgEntry) } as any);
    const imageCtx = makeCtx(branch, { tokens: 5_000, prompt: "" });
    const vision = contextUsage(imageCtx, createUsagePricing(CLAUDE, calibration))!;
    const textOnly = contextUsage(imageCtx, createUsagePricing({ ...CLAUDE, input: ["text"] }, calibration))!;
    expect(vision.basis).toBe("reprojected");
    expect(vision.tokens! - textOnly.tokens!).toBeGreaterThan(4_000); // 4784 patches vs ~placeholder text
  });

  it("includes the input capability in the pending reader signature", () => {
    const base = { provider: "anthropic", id: "m", api: "anthropic-messages", baseUrl: "u", contextWindow: 1, maxTokens: 2, input: ["text", "image"] };
    const model = (input?: string[]) => ({ ...base, ...(input ? { input } : {}) });
    expect(readerSignature({ model: model(["text", "image"]) } as any)).toBeDefined();
    expect(readerSignature({ model: model(["text"]) } as any)).not.toBe(readerSignature({ model: model(["text", "image"]) } as any));
    expect(readerSignature({ model: model(undefined) } as any)).not.toBe(readerSignature({ model: model(["text"]) } as any));
  });
});
