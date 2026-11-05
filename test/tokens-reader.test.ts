import { describe, expect, it } from "bun:test";
import { TokenCalibrationStore, estimateTokens, makeReaderTokenEstimator, makeTokenEstimator } from "../src/utils/tokens.ts";
import { estimateReaderMessageTokens } from "../src/app/steps/window.ts";

const ANTHROPIC = { provider: "anthropic", id: "claude-test", api: "anthropic-messages" } as const;
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
    const message = assistant({ provider: "anthropic", api: "anthropic-messages", model: "claude-test" });
    expect(reader.message(message)).toBe(1000);
  });

  it("aggregates through the same reader pricing as single messages", () => {
    const reader = makeReaderTokenEstimator(ANTHROPIC, new TokenCalibrationStore());
    const message = assistant({ provider: "anthropic", api: "anthropic-messages", model: "claude-test" });
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
    const identity = { provider: "anthropic", api: "anthropic-messages", model: "claude-test" };
    expect(reader.message(assistant({ ...identity, usage: undefined }))).toBeGreaterThan(0);
    expect(reader.message(assistant({ ...identity, stopReason: "aborted" }))).toBeGreaterThan(0);
    // A projection rewrite invalidates the measurement even with clean metadata.
    const edited = assistant(identity);
    expect(reader.message(edited, { contextEdited: true })).toBe(reader.message(assistant({ ...identity, usage: undefined })));
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
  it("prices Claude patch tokens for images in any role", () => {
    const reader = makeReaderTokenEstimator(ANTHROPIC, new TokenCalibrationStore());
    const image = { type: "image", data: pngBase64(2000, 1093) };
    for (const role of ["toolResult", "user", "assistant"] as const) {
      const cost = reader.message({ role, content: [image] } as any);
      expect(cost).toBeGreaterThanOrEqual(patch(2000, 1093));
      expect(cost).toBeLessThan(patch(2000, 1093) + 100);
    }
  });

  it("reads JPEG frame dimensions and strips data-URI prefixes", () => {
    const reader = makeReaderTokenEstimator(ANTHROPIC, new TokenCalibrationStore());
    const jpeg = reader.message({ role: "user", content: [{ type: "image", data: jpegBase64(448, 672) }] } as any);
    expect(jpeg).toBeGreaterThanOrEqual(patch(448, 672));
    expect(jpeg).toBeLessThan(patch(448, 672) + 100);
    const prefixed = reader.message({ role: "user", content: [{ type: "image", data: "data:image/png;base64," + pngBase64(448, 672) }] } as any);
    expect(prefixed).toBeGreaterThanOrEqual(patch(448, 672));
  });

  it("falls back to the flat cost for unreadable headers and non-Anthropic APIs", () => {
    const anthropicReader = makeReaderTokenEstimator(ANTHROPIC, new TokenCalibrationStore());
    const flat = anthropicReader.message({ role: "user", content: [{ type: "image", data: "not-base64-at-all!!" }] } as any);
    expect(flat).toBeGreaterThanOrEqual(1200);
    expect(flat).toBeLessThan(1300);
    const otherReader = makeReaderTokenEstimator(CODEX, new TokenCalibrationStore());
    const other = otherReader.message({ role: "user", content: [{ type: "image", data: pngBase64(2000, 1093) }] } as any);
    expect(other).toBeGreaterThanOrEqual(1200);
    expect(other).toBeLessThan(1300);
  });

  it("prices wire-format image sources as well as session-format data", () => {
    const reader = makeReaderTokenEstimator(ANTHROPIC, new TokenCalibrationStore());
    const wire = reader.message({ role: "user", content: [{ type: "image", source: { data: pngBase64(1000, 1000) } }] } as any);
    expect(wire).toBeGreaterThanOrEqual(patch(1000, 1000));
    expect(wire).toBeLessThan(patch(1000, 1000) + 100);
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
