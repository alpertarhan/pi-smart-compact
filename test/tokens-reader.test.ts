import { describe, expect, it } from "bun:test";
import { TokenCalibrationStore, estimateTokens, makeReaderTokenEstimator, makeTokenEstimator } from "../src/utils/tokens.ts";
import { estimateReaderMessageTokens } from "../src/app/steps/window.ts";

const ANTHROPIC = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages" } as const;
const CODEX = { provider: "openai-codex", id: "gpt-code", api: "openai-codex-responses" } as const;
const COMPLETIONS = { provider: "deepseek", id: "ds-test", api: "openai-completions" } as const;

function assistant(partial: Record<string, unknown>) {
  return {
    role: "assistant",
    stopReason: "endTurn",
    content: [{ type: "text", text: "done" }],
    usage: { input: 10, output: 1000, reasoning: 900 },
    ...partial,
  } as any;
}

function pngBase64(width: number, height: number): string {
  const buf = Buffer.alloc(64); // >= 48 bytes so the base64 form passes the minimum-size guard
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}

function jpegBase64(width: number, height: number): string {
  // SOI + SOF0 (length 17, precision 8) with big-endian frame dimensions.
  const buf = Buffer.alloc(64);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]).copy(buf, 0);
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf.toString("base64");
}

// Documented Claude 3-family rule: long edge resizes to 1568px, then 28px patches.
const patch = (width: number, height: number) => {
  const scale = Math.min(1, 1568 / Math.max(width, height));
  const w = Math.max(1, Math.ceil(width * scale));
  const h = Math.max(1, Math.ceil(height * scale));
  return Math.ceil(w / 28) * Math.ceil(h / 28);
};

describe("reader token estimator replay proxies", () => {
  it("uses exact usage.output for same-model anthropic-messages replay", () => {
    const reader = makeReaderTokenEstimator(ANTHROPIC, new TokenCalibrationStore());
    const message = assistant({ provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5-5" });
    expect(reader.message(message)).toBe(1000);
  });

  it("aggregates through the same reader pricing as single messages", () => {
    const reader = makeReaderTokenEstimator(ANTHROPIC, new TokenCalibrationStore());
    const message = assistant({ provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5-5" });
    expect(reader.messages([message])).toBe(reader.message(message));
    expect(reader.messages([message])).toBe(1000);
  });

  it("subtracts discarded prior-turn reasoning on responses APIs, but not in the live turn", () => {
    const reader = makeReaderTokenEstimator(CODEX, new TokenCalibrationStore());
    const message = assistant({ provider: "openai-codex", api: "openai-codex-responses", model: "gpt-code" });
    expect(reader.message(message)).toBe(100);
    expect(reader.message(message, { currentTurn: true })).toBe(1000);
  });

  it("prices completions thinking replay by the stored marker signature", () => {
    const reader = makeReaderTokenEstimator(COMPLETIONS, new TokenCalibrationStore());
    const identity = { provider: "deepseek", api: "openai-completions", model: "ds-test" };
    const marker = assistant({ ...identity, content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "reasoning" }] });
    const opaque = assistant({ ...identity, content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "rs_abc" }] });
    expect(reader.message(marker)).toBe(1000);
    expect(reader.message(opaque)).toBe(100);
  });

  it("falls back to character pricing when metadata is unusable", () => {
    const reader = makeReaderTokenEstimator(ANTHROPIC, new TokenCalibrationStore());
    const identity = { provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5-5" };
    expect(reader.message(assistant({ ...identity, usage: undefined }))).toBeGreaterThan(0);
    // A projection rewrite invalidates the measurement even with clean metadata.
    const edited = assistant(identity);
    expect(reader.message(edited, { contextEdited: true })).toBe(reader.message(assistant({ ...identity, usage: undefined })));
  });

  it("skips errored/aborted assistant messages like the SDK converter does", () => {
    const reader = makeReaderTokenEstimator(ANTHROPIC, new TokenCalibrationStore());
    const identity = { provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5-5" };
    const aborted = assistant({ ...identity, content: [{ type: "text", text: "x".repeat(50_000) }], stopReason: "aborted" });
    expect(reader.message(aborted)).toBe(0);
    expect(reader.message(assistant({ ...identity, stopReason: "error" }))).toBe(0);
    // Unknown compatibility endpoints keep the conservative estimate.
    const unknown = makeReaderTokenEstimator({ provider: "other", id: "other-model" }, new TokenCalibrationStore());
    expect(unknown.message(aborted)).toBeGreaterThan(0);
  });

  it("applies per-model Anthropic thinking preservation, not blanket usage.output", () => {
    const keepLastTurn = { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" } as const;
    const reader = makeReaderTokenEstimator(keepLastTurn, new TokenCalibrationStore());
    const identity = { provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-4-5" };
    const message = assistant({
      ...identity,
      content: [{ type: "thinking", thinking: "reasoning summary", thinkingSignature: "sig" }, { type: "text", text: "done" }],
    });
    // Prior turn on a keep-last-turn model: only the measured non-reasoning
    // subset is retained (the API strips older thinking and does not bill it).
    expect(reader.message(message)).toBe(100);
    // The live tool loop keeps its thinking blocks.
    expect(reader.message(message, { currentTurn: true })).toBe(1000);
    // Documented keep-all models bill the full replayed output.
    const keepAll = makeReaderTokenEstimator({ provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" }, new TokenCalibrationStore());
    expect(keepAll.message(assistant({ ...identity, model: "claude-opus-4-5" }))).toBe(1000);
    // Haiku through 4.5 keeps the last turn only.
    const haiku = makeReaderTokenEstimator({ provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" }, new TokenCalibrationStore());
    expect(haiku.message(assistant({ ...identity, model: "claude-haiku-4-5" }))).toBe(100);
    // Preservation is a MODEL property: a genuine Claude behind a custom
    // provider alias keeps its documented semantics; a non-Claude model on the
    // same wire API is unknown and keeps the measured-subset rule.
    const alias = makeReaderTokenEstimator({ provider: "fixture", id: "claude-opus-5-5", api: "anthropic-messages" }, new TokenCalibrationStore());
    expect(alias.message(assistant({ provider: "fixture", api: "anthropic-messages", model: "claude-opus-5-5" }))).toBe(1000);
    // Unknown retention policy (other vendors on this wire, or a versionless
    // Claude alias): the measured output bounds possibly-retained thinking from
    // above — never assume the server discarded the reasoning.
    for (const id of ["glm-4.6", "claude-opus-latest"]) {
      const unknown = makeReaderTokenEstimator({ provider: "zai-anthropic", id, api: "anthropic-messages" }, new TokenCalibrationStore());
      expect(unknown.message(assistant({ provider: "zai-anthropic", api: "anthropic-messages", model: id }))).toBe(1000);
    }
  });

  it("prices unsigned prior thinking as retained text on keep-last-turn models", () => {
    // The native converter turns unsigned thinking into plain text, which the
    // server-side prior-turn strip does not remove: it must stay priced, and it
    // breaks the output-reasoning measured-subset proxy.
    const reader = makeReaderTokenEstimator({ provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" }, new TokenCalibrationStore());
    const identity = { provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-4-5" };
    const unsigned = assistant({ ...identity, content: [{ type: "thinking", thinking: "r".repeat(3600) }, { type: "text", text: "x".repeat(400) }] });
    expect(reader.message(unsigned)).toBeGreaterThanOrEqual(900);
    // Mixed signed and unsigned: only the signed part is stripped; the unsigned
    // text and everything else stays priced.
    const mixed = assistant({ ...identity, content: [
      { type: "thinking", thinking: "r".repeat(3600), thinkingSignature: "signed" },
      { type: "thinking", thinking: "u".repeat(3600) },
      { type: "text", text: "x".repeat(400) },
    ], usage: undefined });
    expect(reader.message(mixed)).toBeGreaterThan(900);
    expect(reader.message(mixed)).toBeLessThan(2200);
  });

  it("never treats dirty reasoning metadata as an exact discard", () => {
    const reader = makeReaderTokenEstimator(CODEX, new TokenCalibrationStore());
    const identity = { provider: "openai-codex", api: "openai-codex-responses", model: "gpt-code" };
    const base = { ...identity, content: [{ type: "text", text: "answer with plenty of retained visible content ".repeat(4) }] };
    // reasoning > output is not a measured subset: price retained content, not 0.
    const dirty = reader.message(assistant({ ...base, usage: { input: 10, output: 1000, reasoning: 2000 } }));
    expect(dirty).toBeGreaterThan(20);
    // Old sessions without usage.reasoning cannot assume output covered zero reasoning.
    const missing = reader.message(assistant({ ...base, usage: { input: 10, output: 1000 } }));
    expect(missing).toBe(dirty);
    // A valid subset still prices the exact measured remainder.
    expect(reader.message(assistant({ ...base }))).toBe(100);
    // Live Responses thinking with a valid signature but missing metadata keeps
    // its visible replayed summary priced (lower bound), never dropped to 0.
    const signed = assistant({ ...base, usage: undefined, content: [{ type: "thinking", thinking: "visible reasoning summary ".repeat(20), thinkingSignature: "rs_" + "x".repeat(40) }, { type: "text", text: "done" }] });
    expect(reader.message(signed, { currentTurn: true })).toBeGreaterThan(50);
    // The same item in a PRIOR turn is discarded on replay: only retained
    // text and tool arguments are priced, not the ignored reasoning summary.
    expect(reader.message(signed, { currentTurn: false })).toBeLessThan(300);
    expect(reader.message(signed)).toBeLessThan(300); // default is prior-turn
  });

  it("drops cross-model thinking on known APIs and keeps it as text on unknown APIs", () => {
    const thinking = [{ type: "thinking", thinking: "reasoning prose ".repeat(50), thinkingSignature: "A".repeat(200) }];
    const message = assistant({ provider: "other", api: "other-api", model: "other-model", content: thinking });
    const known = makeReaderTokenEstimator(ANTHROPIC, new TokenCalibrationStore()).message(message);
    const unknown = makeReaderTokenEstimator({ provider: "other", id: "other-model" }, new TokenCalibrationStore()).message(message);
    expect(known).toBeLessThan(100);
    expect(unknown).toBeGreaterThan(known + 150);
  });
});

describe("reader token estimator image pricing", () => {
  // Expected values are the CURRENT documented table (platform.claude.com vision
  // docs): two tiers — high resolution (Claude 4.7 and later: 2576px, 4784 visual
  // tokens) and standard (1568px, 1568 tokens) — after the aspect-preserving
  // resize that must fit BOTH limits.
  const HIGH = "claude-opus-5-5";
  const STANDARD = "claude-sonnet-4-6";
  const cost = (model: string, width: number, height: number): number => {
    const reader = makeReaderTokenEstimator({ provider: "anthropic", id: model, api: "anthropic-messages" }, new TokenCalibrationStore());
    return reader.message({ role: "user", content: [{ type: "image", data: pngBase64(width, height) }] } as any);
  };
  const expectTokens = (model: string, width: number, height: number, tokens: number) => {
    const value = cost(model, width, height);
    expect(value).toBeGreaterThanOrEqual(tokens);
    expect(value).toBeLessThan(tokens + 100); // patch component exact, wrapper is small
  };

  it("matches the documented cost table on both tiers", () => {
    expectTokens(STANDARD, 200, 200, 64);
    expectTokens(HIGH, 200, 200, 64);
    expectTokens(STANDARD, 1000, 1000, 1296);
    expectTokens(HIGH, 1000, 1000, 1296);
    expectTokens(STANDARD, 1092, 1092, 1521);
    expectTokens(HIGH, 1092, 1092, 1521);
    // 1920x1080: standard resizes to 1456x819; high-resolution keeps the original.
    expectTokens(STANDARD, 1920, 1080, 1560);
    expectTokens(HIGH, 1920, 1080, 2691);
    // 3840x2160: standard resizes to 1456x819; high-resolution to 2576x1449 (at its cap).
    expectTokens(STANDARD, 3840, 2160, 1560);
    expectTokens(HIGH, 3840, 2160, 4784);
  });

  it("prices the current Opus 5.5 fixture at its unresized patch count", () => {
    // 2000x1093 is below the high-resolution limits: 72*40 = 2880, no resize.
    expectTokens(HIGH, 2000, 1093, 2880);
    // The same image on a standard-tier model must be downscaled to fit the
    // 1568-token budget (smaller than the high-resolution cost).
    expect(cost(STANDARD, 2000, 1093)).toBeLessThan(1568 + 100);
    expect(cost(STANDARD, 2000, 1093)).toBeLessThan(cost(HIGH, 2000, 1093));
  });

  it("resizes by the visual-token budget, not just the edge limit", () => {
    // A4 scan from the docs: 1075x1520 fits both edge limits on standard, but
    // 39*55 = 2145 tokens exceeds 1568, so it resizes to 924x1307 (33*47 = 1551).
    expectTokens(STANDARD, 1075, 1520, 1551);
    // High-resolution tier has budget for it: no resize, 2145 tokens.
    expectTokens(HIGH, 1075, 1520, 2145);
  });

  it("bounds oversized images by each tier's visual-token cap", () => {
    // The resize maximizes the long edge under BOTH limits; for 4:3 sources the
    // resulting patch count lands just under the token budget.
    expectTokens(HIGH, 8000, 6000, 4740); // 2212x1659 -> 79*60
    expect(cost(HIGH, 8000, 6000)).toBeLessThan(4784 + 100);
    expectTokens(STANDARD, 8000, 6000, 1564); // 1270x952 -> 46*34
    expect(cost(STANDARD, 8000, 6000)).toBeLessThan(1568 + 100);
  });

  it("selects the tier from the model version, with verified boundaries", () => {
    // 4.7 is the documented high-resolution boundary; 4.6 and 3.7 stay standard.
    expectTokens("claude-opus-4-7", 3840, 2160, 4784);
    expectTokens("claude-opus-4-8", 3840, 2160, 4784);
    expectTokens("claude-opus-4-6", 3840, 2160, 1560);
    expectTokens("claude-3-7-sonnet", 3840, 2160, 1560);
    expectTokens("claude-haiku-4-5", 3840, 2160, 1560);
    // Unparseable current-name Claude prices as high tier (never under-count).
    expectTokens("claude-mythos-preview", 3840, 2160, 4784);
  });

  it("prices images in any message role", () => {
    const reader = makeReaderTokenEstimator({ provider: "anthropic", id: HIGH, api: "anthropic-messages" }, new TokenCalibrationStore());
    const image = { type: "image", data: pngBase64(2000, 1093) };
    for (const role of ["toolResult", "user", "assistant"] as const) {
      const value = reader.message({ role, content: [image] } as any);
      expect(value).toBeGreaterThanOrEqual(2880);
      expect(value).toBeLessThan(2880 + 100);
    }
  });

  it("reads JPEG frame dimensions and strips data-URI prefixes", () => {
    const reader = makeReaderTokenEstimator({ provider: "anthropic", id: HIGH, api: "anthropic-messages" }, new TokenCalibrationStore());
    const jpeg = reader.message({ role: "user", content: [{ type: "image", data: jpegBase64(448, 672) }] } as any);
    expect(jpeg).toBeGreaterThanOrEqual(16 * 24); // 384: under every limit, no resize
    expect(jpeg).toBeLessThan(16 * 24 + 100);
    const prefixed = reader.message({ role: "user", content: [{ type: "image", data: "data:image/png;base64," + pngBase64(1000, 1000) }] } as any);
    expect(prefixed).toBeGreaterThanOrEqual(1296);
    expect(prefixed).toBeLessThan(1296 + 100);
  });

  it("falls back to the flat cost for unreadable headers, other APIs, and unverified models", () => {
    const anthropicReader = makeReaderTokenEstimator({ provider: "anthropic", id: HIGH, api: "anthropic-messages" }, new TokenCalibrationStore());
    const flat = anthropicReader.message({ role: "user", content: [{ type: "image", data: "not-base64-at-all!!" }] } as any);
    expect(flat).toBeGreaterThanOrEqual(1200);
    expect(flat).toBeLessThan(1300);
    const otherReader = makeReaderTokenEstimator(CODEX, new TokenCalibrationStore());
    const other = otherReader.message({ role: "user", content: [{ type: "image", data: pngBase64(2000, 1093) }] } as any);
    expect(other).toBeGreaterThanOrEqual(1200);
    expect(other).toBeLessThan(1300);
    // Same wire API, but the two-tier rule is only verified for patch-grid Claude:
    // pre-3 Claude and Anthropic-compatible endpoints from other vendors take the flat estimate.
    for (const id of ["claude-2-1", "claude-instant", "glm-4.6"]) {
      const reader = makeReaderTokenEstimator({ provider: "zai-anthropic", id, api: "anthropic-messages" }, new TokenCalibrationStore());
      const value = reader.message({ role: "user", content: [{ type: "image", data: pngBase64(2000, 1093) }] } as any);
      expect(value).toBeGreaterThanOrEqual(1200);
      expect(value).toBeLessThan(1300);
    }
  });

  it("parses dated and major-only Claude versions correctly", () => {
    // Dated snapshots keep their table version: 4.5 stays keep-all and standard-tier vision.
    expectTokens("claude-opus-4-5-20251101", 3840, 2160, 1560); // standard tier (keep-all thinking)
    expectTokens("claude-haiku-4-5-20251001", 3840, 2160, 1560); // standard tier (keep-last thinking)
    // Major-only names read as X.0: claude-opus-4 is 4.0 — standard tier, NOT keep-all.
    expectTokens("claude-opus-4", 3840, 2160, 1560);
    expectTokens("claude-4-0", 3840, 2160, 1560);
    // Versionless aliases stay unknown: high image tier (never under-count) and
    // unknown thinking retention (upper-bounded elsewhere), never table rules.
    expectTokens("claude-opus-latest", 3840, 2160, 4784);
  });

  it("downgrades images to the SDK placeholder for explicit text-only readers", () => {
    const textOnly = makeReaderTokenEstimator({ provider: "anthropic", id: HIGH, api: "anthropic-messages", input: ["text"] }, new TokenCalibrationStore());
    // A 4K image costs the placeholder text, not 4784 patches: the native
    // converter replaces user and toolResult images before the wire.
    const userImage = textOnly.message({ role: "user", content: [{ type: "text", text: "look:" }, { type: "image", data: pngBase64(3840, 2160) }] } as any);
    expect(userImage).toBeLessThan(60);
    const toolImage = textOnly.message({ role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "image", data: pngBase64(3840, 2160) }] } as any);
    expect(toolImage).toBeLessThan(60);
    // Adjacent images coalesce into one placeholder per run.
    const adjacent = textOnly.message({ role: "user", content: [{ type: "image", data: pngBase64(1000, 1000) }, { type: "image", data: pngBase64(2000, 2000) }] } as any);
    expect(adjacent).toBeLessThan(60);
    // The vision-enabled counterpart pays the patch price; absent capability
    // information stays on the vision estimate (uncertain, not an assumption).
    const vision = makeReaderTokenEstimator({ provider: "anthropic", id: HIGH, api: "anthropic-messages", input: ["text", "image"] }, new TokenCalibrationStore());
    expect(vision.message({ role: "user", content: [{ type: "image", data: pngBase64(3840, 2160) }] } as any)).toBeGreaterThanOrEqual(4784);
    const unknown = makeReaderTokenEstimator({ provider: "anthropic", id: HIGH, api: "anthropic-messages" }, new TokenCalibrationStore());
    expect(unknown.message({ role: "user", content: [{ type: "image", data: pngBase64(3840, 2160) }] } as any)).toBeGreaterThanOrEqual(4784);
  });

  it("prices wire-format image sources as well as session-format data", () => {
    const reader = makeReaderTokenEstimator({ provider: "anthropic", id: HIGH, api: "anthropic-messages" }, new TokenCalibrationStore());
    const wire = reader.message({ role: "user", content: [{ type: "image", source: { data: pngBase64(1000, 1000) } }] } as any);
    expect(wire).toBeGreaterThanOrEqual(1296);
    expect(wire).toBeLessThan(1296 + 100);
  });
});

describe("token density and binary-safe counting", () => {
  it("increases the estimate for structurally dense text, never decreases it", () => {
    const plain = "word ".repeat(2000);
    const dense = JSON.stringify({ toolCallId: "call", entries: Array.from({ length: 400 }, (_, i) => ({ id: i, path: `src/file${i}.ts` })) });
    expect(dense.length).toBeGreaterThan(1000);
    const cal = new TokenCalibrationStore();
    expect(estimateTokens(dense, "openai", undefined, cal)).toBeGreaterThan(Math.ceil(dense.length / 4));
    expect(estimateTokens(plain, "openai", undefined, cal)).toBe(Math.ceil(plain.length / 4));
  });

  it("never counts opaque signatures or base64 payloads as text", () => {
    const estimator = makeTokenEstimator("anthropic", "claude-test", new TokenCalibrationStore());
    const clean = { role: "assistant", content: [{ type: "text", text: "answer" }] } as any;
    const signed = { role: "assistant", content: [{ type: "text", text: "answer", textSignature: "A".repeat(5000) }] } as any;
    expect(estimator.message(signed)).toBe(estimator.message(clean));
    const withImage = { role: "user", content: [{ type: "image", data: "A".repeat(200_000) }] } as any;
    expect(estimator.message(withImage)).toBeLessThan(1500);
  });
});

describe("reader window estimates (estimateReaderMessageTokens)", () => {
  const cal = new TokenCalibrationStore();
  const sameModel = assistant({ provider: "openai-codex", api: "openai-codex-responses", model: "gpt-code", content: [{ type: "text", text: "x".repeat(80_000) }] });

  it("carries per-entry edit and live-turn context into the proxy", () => {
    const reader = makeReaderTokenEstimator(CODEX, cal);
    const msgs = [
      { type: "message" as const, id: "1", message: sameModel },
      { type: "message" as const, id: "2", message: sameModel, contextEdited: true },
      { type: "message" as const, id: "3", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "message" as const, id: "4", message: sameModel },
    ];
    const tokens = estimateReaderMessageTokens(reader, msgs as any);
    expect(tokens[0]).toBe(100); // prior turn: output - reasoning
    expect(tokens[1]).toBeGreaterThan(80_000 / 4); // edited: char fallback, no proxy
    expect(tokens[3]).toBe(1000); // live turn: full measured output
  });

  it("prices replay turns by the last WIRE user item, including custom messages", () => {
    const reader = makeReaderTokenEstimator(CODEX, cal);
    // human -> assistant(reasoning) -> custom user item -> assistant(reasoning):
    // the custom item is a real wire turn boundary, so the first assistant's
    // reasoning is prior-turn for the API even though it followed a human.
    const msgs = [
      { type: "message" as const, id: "1", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "message" as const, id: "2", message: sameModel },
      { type: "message" as const, id: "3", message: { role: "user", content: [{ type: "text", text: "summary injection" }] }, customType: "smart-compact-context" },
      { type: "message" as const, id: "4", message: sameModel },
    ];
    const tokens = estimateReaderMessageTokens(reader, msgs as any);
    expect(tokens[1]).toBe(100); // prior turn: output - reasoning
    expect(tokens[3]).toBe(1000); // live turn after the custom user item
  });

  it("treats a compaction-summary user item as the live-turn boundary", () => {
    const reader = makeReaderTokenEstimator(CODEX, cal);
    const msgs = [
      { type: "message" as const, id: "1", message: { role: "user", content: [{ type: "text", text: "## Summary" }] }, customType: "summary" },
      { type: "message" as const, id: "2", message: sameModel },
    ];
    const tokens = estimateReaderMessageTokens(reader, msgs as any);
    expect(tokens[1]).toBe(1000); // the assistant lives in the summary's turn
  });
});
