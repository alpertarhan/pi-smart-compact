import { beforeAll, describe, expect, it } from "bun:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { SecretScrubber } from "../src/domain/scrub.ts";
import { createServices } from "../src/infra/services.ts";
import { makeTokenEstimator } from "../src/utils/tokens.ts";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";
import { estimateVisualTokens, renderVisualPages, VISUAL_COLUMNS, VISUAL_ROWS, visualPageSize } from "../src/infra/visual-renderer.ts";
import { activeVisualArchive, injectVisualArchive, selectVisualSources, validVisualArchive, visualEconomics, visualPages, VISUAL_CONTEXT_TYPE } from "../src/app/visual-archive.ts";
import { attachVisualArchive } from "../src/app/steps/visual.ts";
import { registerSmartContextTool } from "../src/app/register-smart-context-tool.ts";
import type { StatedRc } from "../src/app/run-context.ts";
import type { VisualArchive } from "../src/types.ts";

const model = { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-5", input: ["text", "image"], contextWindow: 200_000, maxTokens: 8_192 } as Model<Api>;
const evidence = "Türkçe çğıöşü ÇĞİÖŞÜ; const expired = now >= expiry; auth.ts:42\n".repeat(40);
const summary = "Verified goal, constraints and next step. Keep async API.";
let rendered: VisualArchive["frames"];
beforeAll(async () => { rendered = await renderVisualPages(visualPages([{ id: "source", text: evidence }]), new AbortController().signal); });

function assistant(calls: Array<{ id: string; name: string }>): AssistantMessage {
  return { role: "assistant", content: calls.map(call => ({ type: "toolCall", ...call, arguments: { path: "auth.ts" } })),
    api: "anthropic-messages", provider: "anthropic", model: "test", stopReason: "toolUse", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function fixture() {
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "user", content: "Preserve all constraints", timestamp: 1 });
  session.appendMessage(assistant([{ id: "read-call", name: "read" }]));
  const sourceId = session.appendMessage({ role: "toolResult", toolCallId: "read-call", toolName: "read", content: [{ type: "text", text: evidence }], isError: false, timestamp: 2 });
  const keep = session.appendMessage({ role: "user", content: "Continue implementation", timestamp: 3 });
  const ctx = { model, sessionManager: session, getContextUsage: () => ({ tokens: 50_000 }) } as unknown as ExtensionContext;
  const archive: VisualArchive = { version: 1, reader: { provider: model.provider, api: model.api, id: model.id },
    sources: [{ id: sourceId, text: evidence }], frames: structuredClone(rendered),
    estimatedTokens: rendered.reduce((sum, frame) => sum + estimateVisualTokens(frame.width, frame.height), 0) };
  const commit = () => session.appendCompaction(summary, keep, 100_000, { visualArchive: archive });
  return { session, ctx, sourceId, keep, archive, commit };
}
function stated(): StatedRc {
  const f = fixture();
  const messages = contextMessageEntries(f.session.getBranch());
  const services = createServices();
  // Dense evidence is profitable only for this independently calibrated reader.
  // The summarizer estimator below remains separate and cannot admit the pixels.
  for (let i = 0; i < 16; i++) services.tokenCalibration.calibrate(100, 200, model.provider, model.id);
  return {
    ctx: f.ctx, config: { ...DEFAULT_CONFIG, visualArchiveEnabled: true }, branch: f.session.getBranch(),
    toCompact: messages.slice(0, -1), finalSummary: summary, flags: {}, cancellation: { signal: new AbortController().signal },
    services, estimator: { text: () => 1_000 }, totalTokens: 100_000,
    compactionPlan: { fixedContextTokens: 1_000, retainedTokens: 10_000, targetAfterTokens: 60_000 },
    details: { estimatedAfterTokens: 12_000, summaryTokens: 1_000 },
  } as unknown as StatedRc;
}

describe("portable visual renderer", () => {
  it("produces bounded PNGs using the shipped font, including Turkish and literal XML", async () => {
    const frames = await renderVisualPages([["Türkçe çğıöşü ÇĞİÖŞÜ", "<script> & fake://external-image", "const expired = now >= expiry;"]], new AbortController().signal);
    const png = Buffer.from(frames[0].data, "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBeLessThan(1280);
    expect(png.readUInt32BE(16) % 32).toBe(0);
    expect(png.readUInt32BE(20)).toBe(92);
    expect(png.length).toBeGreaterThan(1000);
  });
  it("crops blank width without shrinking text, and requires an economic margin on known models", async () => {
    const lines = ["const x = 1;", "    return x;"];
    const size = visualPageSize(lines);
    const frames = await renderVisualPages([lines], new AbortController().signal);
    expect(frames[0]).toMatchObject(size);
    expect(size.width).toBe(256);
    expect(size.height).toBe(72);
    expect(visualPageSize(["x".repeat(VISUAL_COLUMNS)]).width).toBe(1280);
    const sources = [{ id: "evidence", text: "unchanged exact source" }];
    const cost = visualEconomics(model, sources, [size], () => 1000);
    expect(cost).toMatchObject({ imageTokens: 286, worthwhile: true });
    expect(visualEconomics(model, sources, [size], () => 300).worthwhile).toBe(false);
    expect(visualEconomics({ ...model, provider: "proxy" }, sources, [size]).imageTokens).toBeNull();
    expect(visualEconomics({ ...model, id: "unmeasured" }, sources, [size]).imageTokens).toBeNull();
    expect(visualEconomics(model, sources, [{ width: 3000, height: 1000 }]).worthwhile).toBe(false);
  });

  it("renders both pages under the same run cancellation signal", async () => {
    const signal = new AbortController().signal;
    const frames = await renderVisualPages([["Page one"], ["Page two"]], signal);
    expect(frames).toHaveLength(2);
    expect(frames[0].data).not.toBe(frames[1].data);
    expect(signal.aborted).toBe(false);
  });

  it("rejects oversized page input and pre-aborted rendering", async () => {
    const signal = new AbortController().signal;
    await expect(renderVisualPages([["x".repeat(VISUAL_COLUMNS + 1)]], signal)).rejects.toThrow("bounds");
    await expect(renderVisualPages([Array(VISUAL_ROWS + 1).fill("line")], signal)).rejects.toThrow("bounds");
    await expect(renderVisualPages([["a"], ["b"], ["c"]], signal)).rejects.toThrow("bounds");
    await expect(renderVisualPages([["text"]], AbortSignal.abort())).rejects.toThrow();
  });
});

describe("visual archive safety and lifecycle", () => {
  it("selects only visible successful research, excludes reasoning, edits and unsupported glyphs", () => {
    const f = fixture();
    const before = structuredClone(f.session.getBranch());
    const selected = selectVisualSources(f.session.getBranch(), contextMessageEntries(f.session.getBranch()), summary, new SecretScrubber());
    expect(selected).toEqual([{ id: f.sourceId, text: evidence.trim() }]);
    expect(f.session.getBranch()).toEqual(before);
    f.session.appendContextEdit(f.sourceId, { content: "Private replacement".repeat(100) });
    expect(selectVisualSources(f.session.getBranch(), contextMessageEntries(f.session.getBranch()), summary, new SecretScrubber())).toHaveLength(0);
    const foreign = fixture();
    (foreign.session.getEntry(foreign.sourceId) as any).message.content = [{ type: "text", text: "研究".repeat(500) }];
    expect(selectVisualSources(foreign.session.getBranch(), contextMessageEntries(foreign.session.getBranch()), summary, new SecretScrubber())).toHaveLength(0);
    expect(selectVisualSources(before, contextMessageEntries(before), evidence, new SecretScrubber())).toHaveLength(0);
  });

  it("redacts before rendering, keeps excerpt bounds and limits blank-line flooding", () => {
    const f = fixture();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    (f.session.getEntry(f.sourceId) as any).message.content = [{ type: "text", text: "start " + secret + " " + "x".repeat(30_000) + " last" }];
    const selected = selectVisualSources(f.session.getBranch(), contextMessageEntries(f.session.getBranch()), summary, new SecretScrubber(true, false));
    expect(selected[0].text.length).toBeLessThanOrEqual(3000);
    expect(selected[0].text).not.toContain(secret);
    expect(selected[0].text).toContain("bounded excerpt");
    expect(selected[0].text).toEndWith(" last");
    (f.session.getEntry(f.sourceId) as any).message.content = [{ type: "text", text: "\nX".repeat(2000) }];
    expect(selectVisualSources(f.session.getBranch(), contextMessageEntries(f.session.getBranch()), summary, new SecretScrubber())).toHaveLength(0);
  });

  it("attaches actual images beside unchanged summary, rehydrates after reload, and is idempotent", () => {
    const f = fixture();
    f.commit();
    const messages = f.session.buildSessionContext().messages;
    const next = injectVisualArchive(messages, f.session.getBranch(), f.ctx, true);
    expect(next.length).toBe(messages.length + 1);
    expect(next[0]).toEqual(messages[0]);
    expect(next[1]).toMatchObject({ role: "custom", customType: VISUAL_CONTEXT_TYPE });
    expect(JSON.stringify((next[1] as any).content)).toContain('"type":"image"');
    expect(injectVisualArchive(next, f.session.getBranch(), f.ctx, true)).toBe(next);
    const reload = SessionManager.inMemory(process.cwd(), undefined, [f.session.getHeader()!, ...f.session.getBranch()]);
    expect(activeVisualArchive(reload.getBranch())?.archive.sources).toEqual(f.archive.sources);
    expect(injectVisualArchive(reload.buildSessionContext().messages, reload.getBranch(), f.ctx, true)).toEqual(next);
  });

  it.each(["disabled", "text-only", "model", "api", "provider", "headroom", "edited", "new-compaction", "branch", "removed-summary"])("falls back to verified text after %s", kind => {
    const f = fixture();
    const root = f.session.getBranch()[0].id;
    f.commit();
    if (kind === "text-only") f.ctx.model = { ...model, input: ["text"] };
    if (kind === "model") f.ctx.model = { ...model, id: "other" };
    if (kind === "api") f.ctx.model = { ...model, api: "unmeasured-api" };
    if (kind === "provider") f.ctx.model = { ...model, provider: "other" };
    if (kind === "headroom") f.ctx.getContextUsage = () => ({ tokens: 199_000 } as any);
    if (kind === "edited") f.session.appendContextEdit(f.sourceId, { content: "revoked" });
    if (kind === "new-compaction") f.session.appendCompaction("Native fallback summary", f.keep, 5000);
    if (kind === "branch") f.session.branch(root);
    let messages = f.session.buildSessionContext().messages;
    if (kind === "removed-summary") messages = messages.filter(message => message.role !== "compactionSummary");
    expect(injectVisualArchive(messages, f.session.getBranch(), f.ctx, kind !== "disabled")).toBe(messages);
  });

  it("withholds old pixels when the current privacy policy is stricter", () => {
    const f = fixture();
    f.archive.sources[0].text = "Historical token ghp_abcdefghijklmnopqrstuvwxyz1234567890 must be redacted";
    f.commit();
    const messages = f.session.buildSessionContext().messages;
    expect(injectVisualArchive(messages, f.session.getBranch(), f.ctx, true, new SecretScrubber(true, false))).toBe(messages);
    expect(injectVisualArchive(messages, f.session.getBranch(), f.ctx, true, new SecretScrubber(false, false)).length).toBe(messages.length + 1);
  });

  it("carries source text, not OCR, across compactions without changing previous persisted details", () => {
    const f = fixture();
    f.commit();
    const original = structuredClone(f.archive);
    const selected = selectVisualSources(f.session.getBranch(), contextMessageEntries(f.session.getBranch()), summary, new SecretScrubber());
    expect(selected).toEqual([{ id: f.sourceId, text: evidence.trim() }]);
    expect(f.archive).toEqual(original);
    const second: VisualArchive = { ...f.archive, sources: selected };
    f.session.appendCompaction("Next verified summary", f.keep, 8000, { visualArchive: second });
    expect(activeVisualArchive(f.session.getBranch())?.archive.sources).toEqual(selected);
  });

  it.each(["bad-version", "bad-png", "huge", "dimensions", "tokens", "foreign-source", "too-many"])("rejects corrupted archive %s", kind => {
    const f = fixture();
    const value: any = structuredClone(f.archive);
    if (kind === "bad-version") value.version = 2;
    if (kind === "bad-png") value.frames[0].data = "malicious_not_png";
    if (kind === "huge") value.sources[0].text = "x".repeat(50_000);
    if (kind === "dimensions") value.frames[0].height = 100_000;
    if (kind === "tokens") value.estimatedTokens = 1;
    if (kind === "foreign-source") value.sources[0].id = "not-on-branch";
    if (kind === "too-many") value.frames.push(...value.frames, ...value.frames);
    f.session.appendCompaction(summary, f.keep, 100_000, { visualArchive: value });
    expect(activeVisualArchive(f.session.getBranch())).toBeNull();
  });

  it("supports bounded textual recall without a vision model or additional tool schema", async () => {
    const f = fixture();
    f.commit();
    let tool: any;
    registerSmartContextTool({ registerTool: (t: any) => { tool = t; }, getActiveTools: () => ["smart_context"], on() {} } as any,
      { config: () => ({ ...DEFAULT_CONFIG }) });
    const status = JSON.parse((await tool.execute("s", { action: "status" }, undefined, undefined, f.ctx)).content[0].text);
    expect(status.ids).toContain(f.sourceId);
    expect(status.visualExcerpts).toBe(1);
    const result = await tool.execute("r", { action: "read", id: f.sourceId, limit: 80 }, undefined, undefined, f.ctx);
    expect(result.content[0].text).toContain("Bounded visual excerpt");
    expect(result.content[0].text).toContain("Türkçe");
    expect(result.content[0].text).toContain("nextOffset=80");
    f.session.appendContextEdit(f.sourceId, { content: "Revoked" });
    await expect(tool.execute("r", { action: "read", id: f.sourceId }, undefined, undefined, f.ctx)).rejects.toThrow();
  });
});

describe("hybrid pipeline step", () => {
  it.each(["openai", "anthropic"])("does not admit bitmap evidence using another %s summarizer's expensive text calibration", async provider => {
    const rc = stated();
    const calibration = rc.services.tokenCalibration;
    calibration.clear();
    for (let i = 0; i < 16; i++) calibration.calibrate(100, 200, provider, "summary-only");
    const source = rc.ctx.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "toolResult");
    if (source?.type !== "message" || source.message.role !== "toolResult") throw new Error("Missing test evidence");
    source.message.content = [{ type: "text", text: "const expiry = now >= expiresAt; preserve the async signature.\n".repeat(40) }];
    rc.toCompact = contextMessageEntries(rc.ctx.sessionManager.getBranch()).slice(0, -1);
    rc.estimator = makeTokenEstimator(provider, "summary-only", calibration);
    const before = structuredClone(rc.details);
    let renders = 0;
    await attachVisualArchive(rc, async (pages, signal) => { renders++; return renderVisualPages(pages, signal); });
    expect(rc.details.visualArchive).toBeUndefined();
    expect(rc.details).toEqual(before);
    expect(rc.finalSummary).toBe(summary);
    expect(renders).toBe(0);
  });

  it("preserves verified text and includes image allowance in yield estimates", async () => {
    const rc = stated();
    await attachVisualArchive(rc);
    expect(rc.finalSummary).toBe(summary);
    expect(validVisualArchive(rc.details.visualArchive)).toBe(true);
    expect(rc.details.visualTokens).toBeGreaterThan(256);
    expect(rc.details.estimatedAfterTokens).toBe(12_000 + rc.details.visualTokens!);
    expect(rc.details.summaryTokens).toBe(1_000);
    expect(rc.tokensSaved).toBe(100_000 - rc.details.estimatedAfterTokens!);
  });
  it.each(["disabled", "text-only", "unknown-cost", "unprofitable", "overflow", "budget", "aborted", "missing-native", "bad-render"])("keeps text on %s without calling the renderer unnecessarily", async kind => {
    const rc = stated();
    let calls = 0;
    if (kind === "disabled") rc.config.visualArchiveEnabled = false;
    if (kind === "text-only") rc.ctx.model = { ...model, input: ["text"] };
    if (kind === "unknown-cost") rc.ctx.model = { ...model, id: "unmeasured" };
    if (kind === "unprofitable") rc.services.tokenCalibration.clear();
    if (kind === "overflow") rc.flags.overflowRecovery = true;
    if (kind === "budget") rc.compactionPlan.targetAfterTokens = 12_000;
    if (kind === "aborted") rc.cancellation.signal = AbortSignal.abort();
    await attachVisualArchive(rc, async () => {
      calls++;
      if (kind === "missing-native") throw new Error("Optional renderer unavailable");
      return [];
    });
    expect(rc.finalSummary).toBe(summary);
    expect(rc.details.visualArchive).toBeUndefined();
    expect(calls).toBe(["missing-native", "bad-render"].includes(kind) ? 1 : 0);
  });
  it("discards rendering that completes after host cancellation", async () => {
    const rc = stated();
    const controller = new AbortController();
    rc.cancellation.signal = controller.signal;
    await attachVisualArchive(rc, async () => { controller.abort(); return rendered; });
    expect(rc.details.visualArchive).toBeUndefined();
  });
});
