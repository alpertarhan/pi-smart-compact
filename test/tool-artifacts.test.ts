import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SessionManager, convertToLlm, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { toolArtifactsDir } from "../src/infra/paths.ts";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";
import { resolveCompactionMessages } from "../src/utils/session-log.ts";
import { SecretScrubber } from "../src/domain/scrub.ts";
import { registerSmartContextTool } from "../src/app/register-smart-context-tool.ts";
import { contextEvidence, evidencePage } from "../src/app/context-evidence.ts";
import { planContextRewind, planContextTrim, CONTEXT_CONTROL_TYPE } from "../src/app/context-operations.ts";
import { fingerprintContext } from "../src/app/pending-slot.ts";
import { registerArtifactOffload, ARTIFACT_DETAILS_KEY, ARTIFACT_SESSION_BYTES, ARTIFACT_MAX_BYTES, artifactId } from "../src/app/tool-artifacts.ts";

const previousHome = process.env.HOME;
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "smart-compact-artifacts-")); process.env.HOME = home; });
afterEach(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; fs.rmSync(home, { recursive: true, force: true }); });

const payload = () => "first line\n" + "ordinary evidence\n".repeat(600) + "RARE_MIDDLE_MARKER\n" + "more evidence\n".repeat(600) + "last line";
const assistant = (callId: string, toolName: string, input: Record<string, any> = {}): AssistantMessage => ({
  role: "assistant", content: [{ type: "toolCall", id: callId, name: toolName, arguments: input }], stopReason: "toolUse",
  api: "openai-responses", provider: "test", model: "test", timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
function apply(session: SessionManager, entries: SessionBoundaryDraft[]) {
  for (const entry of entries) {
    if (entry.type === "context_edit") session.appendContextEdit(entry.targetId, entry.replacement);
    if (entry.type === "custom") session.appendCustomEntry(entry.customType, entry.data);
    if (entry.type === "custom_message") session.appendCustomMessageEntry(entry.customType, entry.content, entry.display);
  }
}
function harness() {
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "user", content: "Inspect auth", timestamp: 1 });
  const cfg = { ...DEFAULT_CONFIG, artifactOffloadEnabled: true };
  let active = true;
  const handlers = new Map<string, any[]>();
  let tool: any;
  const pi = {
    getActiveTools: () => active ? ["smart_context"] : [], registerTool: (value: any) => { tool = value; },
    on: (name: string, fn: any) => handlers.set(name, [...handlers.get(name) ?? [], fn])
  } as any;
  const ctx = { sessionManager: session, signal: new AbortController().signal } as unknown as ExtensionContext;
  registerArtifactOffload(pi, () => cfg, () => active);
  registerSmartContextTool(pi, { config: () => cfg });
  let sequence = 0;
  const capture = async (text = payload(), overrides: Record<string, unknown> = {}) => {
    const event: any = {
      type: "tool_result", toolName: "grep", toolCallId: "c" + sequence++, input: { path: "src/auth.ts" },
      isError: false, content: [{ type: "text", text }], details: { preserved: "native details" }, ...overrides
    };
    session.appendMessage(assistant(event.toolCallId, event.toolName, event.input));
    const result = await handlers.get("tool_result")![0](event, ctx);
    const entryId = session.appendMessage({
      role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName,
      content: result?.content ?? event.content, details: result?.details ?? event.details, isError: event.isError, timestamp: 1
    } as ToolResultMessage);
    return { result, event, entryId, artifact: result?.details[ARTIFACT_DETAILS_KEY] };
  };
  const run = (params: Record<string, unknown>) => tool.execute("reader", params, undefined, undefined, ctx);
  return { session, cfg, ctx, handlers, capture, run, setActive: (value: boolean) => { active = value; } };
}

function storedFile(artifact: { owner: string; hash: string }) { return path.join(toolArtifactsDir(), artifact.owner, artifact.hash + ".txt"); }
const responseJson = (response: any) => JSON.parse(response.content[0].text.split("\n").slice(1).join("\n"));

describe("automatic tool artifacts", () => {
  it.each(["read", "functions.read", "read_symbol", "read_enclosing", "get_code_snippet", "functions.get_code_snippet"])("keeps %s delivery intact for read-before-edit guards", async toolName => {
    const h = harness();
    const captured = await h.capture(payload(), { toolName, details: { truncation: { truncated: false, outputLines: 1203 } } });
    expect(captured.result).toBeUndefined();
    expect(captured.event.details.truncation.outputLines).toBe(1203);
    expect(JSON.stringify(convertToLlm(h.session.buildSessionContext().messages))).toContain("RARE_MIDDLE_MARKER");
    expect(fs.existsSync(toolArtifactsDir())).toBe(false);
  });

  it("persists a verified private file before replacing model-facing text, without changing tool semantics", async () => {
    const h = harness();
    const { result, event, artifact } = await h.capture();
    expect(artifact).toBeDefined();
    expect(fs.readFileSync(storedFile(artifact), "utf8")).toBe(payload());
    expect(fs.statSync(storedFile(artifact)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(storedFile(artifact))).mode & 0o777).toBe(0o700);
    expect(result.isError).toBeUndefined();
    expect(result.details.preserved).toBe("native details");
    expect(result.content[0].text.length).toBeLessThan(payload().length / 4);
    expect(result.content[0].text).toContain("first line");
    expect(result.content[0].text).toContain("last line");
    expect(result.content[0].text).not.toContain("RARE_MIDDLE_MARKER");
    expect(event.content[0].text).toBe(payload());
    const context = JSON.stringify(convertToLlm(h.session.buildSessionContext().messages));
    expect(context).not.toContain("RARE_MIDDLE_MARKER");
    expect(context).toContain(artifactId(artifact));
    const status = JSON.parse((await h.run({ action: "status" })).content[0].text);
    expect(status.sources[0]).toMatchObject({ id: artifactId(artifact), kind: "tool-artifact", source: "src/auth.ts" });
  });

  it.each(["disabled", "hidden", "small", "huge", "error", "image", "bash", "write", "unknown", "instructions", "skill", "mixed-details", "aborted"])("leaves %s results untouched", async kind => {
    const h = harness();
    let text = payload();
    const overrides: Record<string, unknown> = {};
    if (kind === "disabled") h.cfg.artifactOffloadEnabled = false;
    if (kind === "hidden") h.setActive(false);
    if (kind === "small") text = "Short useful output";
    if (kind === "huge") text = "x".repeat(ARTIFACT_MAX_BYTES + 1);
    if (kind === "error") overrides.isError = true;
    if (kind === "image") overrides.content = [{ type: "image", mimeType: "image/png", data: "eA==" }];
    if (["bash", "write", "unknown"].includes(kind)) overrides.toolName = kind;
    if (kind === "instructions") overrides.input = { path: "/tmp/AGENTS.md" };
    if (kind === "skill") overrides.input = { path: "skills/build/references.md" };
    if (kind === "mixed-details") overrides.details = ["non-object details"];
    if (kind === "aborted") h.ctx.signal = AbortSignal.abort();
    expect((await h.capture(text, overrides)).result).toBeUndefined();
  });

  it("redacts before persistence and re-applies stricter policy before search/read paging", async () => {
    const h = harness();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const text = "before " + secret + " after\n" + payload();
    const redacted = await h.capture(text);
    expect(fs.readFileSync(storedFile(redacted.artifact), "utf8")).not.toContain(secret);
    h.cfg.scrubSecrets = false;
    const raw = await h.capture(text);
    expect(fs.readFileSync(storedFile(raw.artifact), "utf8")).toContain(secret);
    h.cfg.scrubSecrets = true;
    const read = await h.run({ action: "read", id: artifactId(raw.artifact), offset: 0, limit: 200 });
    expect(read.content[0].text).not.toContain(secret);
    expect(read.content[0].text).toContain("REDACTED");
    const search = responseJson(await h.run({ action: "search", query: secret }));
    expect(search.matches).toHaveLength(0);
  });

  it("deduplicates concurrent identical payloads without overwriting references", async () => {
    const h = harness();
    const captures = await Promise.all(Array.from({ length: 4 }, () => h.capture()));
    expect(captures.every(item => Boolean(item.artifact))).toBe(true);
    expect(new Set(captures.map(item => item.artifact.hash)).size).toBe(1);
    expect(fs.readdirSync(path.dirname(storedFile(captures[0].artifact))).filter(name => name.endsWith(".txt"))).toHaveLength(1);
  });

  it("keeps every source searchable when payload bytes are shared, without repeating the same source", async () => {
    const h = harness();
    const first = await h.capture(payload(), { input: { path: "src/first.ts" } });
    const second = await h.capture(payload(), { input: { path: "src/second.ts" } });
    await h.capture(payload(), { input: { path: "src/first.ts" } });
    const id = artifactId(first.artifact);
    expect(artifactId(second.artifact)).toBe(id);
    const status = JSON.parse((await h.run({ action: "status" })).content[0].text);
    expect(status.sources.map((source: any) => source.source).sort()).toEqual(["src/first.ts", "src/second.ts"]);
    for (const source of ["src/first.ts", "src/second.ts"]) {
      const found = responseJson(await h.run({ action: "search", query: source }));
      expect(found.matches).toHaveLength(1);
      expect(found.matches[0]).toMatchObject({ id, source, matched: "source" });
    }
    for (const reference of [id, first.entryId, second.entryId]) {
      const read = await h.run({ action: "read", id: reference, line: 602, limit: 1 });
      expect(read.content[0].text).toContain("RARE_MIDDLE_MARKER");
    }
    expect(fs.readdirSync(path.dirname(storedFile(first.artifact))).filter(name => name.endsWith(".txt"))).toHaveLength(1);
  });

  it("revokes only edited provenance and retains other shared sources across compaction and fork", async () => {
    const h = harness();
    const first = await h.capture(payload(), { input: { path: "src/first.ts" } });
    const second = await h.capture(payload(), { input: { path: "src/second.ts" } });
    const id = artifactId(first.artifact);
    const keep = h.session.appendMessage({ role: "user", content: "Continue", timestamp: 2 });
    h.session.appendCompaction("Keep archived references", keep, 30_000);
    h.session.appendContextEdit(first.entryId, { content: "Revoked by another owner" });
    expect(responseJson(await h.run({ action: "search", query: "src/first.ts" })).matches).toHaveLength(0);
    expect(responseJson(await h.run({ action: "search", query: "src/second.ts" })).matches).toHaveLength(1);
    await expect(h.run({ action: "read", id: first.entryId })).rejects.toThrow();
    expect((await h.run({ action: "read", id, line: 602, limit: 1 })).content[0].text).toContain("RARE_MIDDLE_MARKER");
    const fork = SessionManager.inMemory(process.cwd(), undefined, [{ ...h.session.getHeader()!, id: "fork" }, ...h.session.getBranch()]);
    const reloaded = () => contextEvidence(fork.getBranch(), fork.getSessionId(), new SecretScrubber());
    expect(reloaded().list.map(source => source.source)).toEqual(["src/second.ts"]);
    expect(await reloaded().read(second.entryId)).toBe(payload());
    fork.branch(first.entryId); // The second source and the later revocation are no longer in ancestry.
    expect(reloaded().list.map(source => source.source)).toEqual(["src/first.ts"]);
    await expect(reloaded().read(second.entryId)).rejects.toThrow();
  });

  it("re-scrubs every shared source label before listing and searching", async () => {
    const h = harness();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    h.cfg.scrubSecrets = false;
    await h.capture(payload(), { input: { path: `src/${secret}.ts` } });
    await h.capture(payload(), { input: { path: "src/public.ts" } });
    h.cfg.scrubSecrets = true;
    const status = (await h.run({ action: "status" })).content[0].text;
    expect(JSON.parse(status).sources).toHaveLength(2);
    expect(status).not.toContain(secret);
    expect(status).toContain("REDACTED");
    expect(responseJson(await h.run({ action: "search", query: secret })).matches).toHaveLength(0);
    expect(responseJson(await h.run({ action: "search", query: "src/public.ts" })).matches).toHaveLength(1);
  });

  it("keeps shared-source listings and searches paged instead of injecting an unbounded alias list", async () => {
    const h = harness();
    for (let index = 0; index < 35; index++) await h.capture(payload(), { input: { path: `src/source-${index}.ts` } });
    const status = JSON.parse((await h.run({ action: "status", limit: 2 })).content[0].text);
    expect(status.archivedOutputs).toBe(35);
    expect(status.sources.map((source: any) => source.source)).toEqual(["src/source-34.ts", "src/source-33.ts"]);
    expect(status.nextOffset).toBe(2);
    const first = responseJson(await h.run({ action: "search", query: "absent" }));
    expect(first).toMatchObject({ scanned: 32, nextOffset: 32, matches: [] });
    const second = responseJson(await h.run({ action: "search", query: "src/source-0.ts", offset: first.nextOffset }));
    expect(second.scanned).toBe(3);
    expect(second.nextOffset).toBeNull();
    expect(second.matches[0].source).toBe("src/source-0.ts");
  });

  it.each(["storage-file", "directory-symlink", "quota", "switch"])("keeps original output after %s interrupts capture", async kind => {
    const h = harness();
    if (kind === "storage-file") {
      fs.mkdirSync(path.dirname(toolArtifactsDir()), { recursive: true });
      fs.writeFileSync(toolArtifactsDir(), "not a directory");
    }
    if (kind === "directory-symlink") {
      fs.mkdirSync(path.dirname(toolArtifactsDir()), { recursive: true });
      const outside = path.join(home, "outside"); fs.mkdirSync(outside);
      fs.symlinkSync(outside, toolArtifactsDir());
    }
    if (kind === "quota") {
      const owner = createHash("sha256").update(h.session.getSessionId()).digest("hex");
      const directory = path.join(toolArtifactsDir(), owner); fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, "a".repeat(64) + ".txt"); fs.writeFileSync(file, ""); fs.truncateSync(file, ARTIFACT_SESSION_BYTES);
    }
    const promise = h.capture();
    if (kind === "switch") for (const fn of h.handlers.get("session_before_switch")!) fn({}, h.ctx);
    const capture = await promise;
    expect(capture.result).toBeUndefined();
    expect(capture.event.content[0].text).toBe(payload());
  });

  it.each(["missing", "changed", "file-symlink", "foreign-edit", "later-transform"])("refuses missing/revoked artifact after %s", async kind => {
    const h = harness();
    const captured = await h.capture();
    const id = artifactId(captured.artifact);
    const file = storedFile(captured.artifact);
    if (kind === "missing") fs.unlinkSync(file);
    if (kind === "changed") fs.writeFileSync(file, "tampered bytes");
    if (kind === "file-symlink") {
      fs.unlinkSync(file); const other = path.join(home, "other.txt"); fs.writeFileSync(other, payload()); fs.symlinkSync(other, file);
    }
    if (kind === "foreign-edit") h.session.appendContextEdit(captured.entryId, { content: "Redacted by another owner" });
    if (kind === "later-transform") (h.session.getEntry(captured.entryId) as any).message.content = [{ type: "text", text: "Other tool-result handler redaction" }];
    await expect(h.run({ action: "read", id })).rejects.toThrow();
    const search = responseJson(await h.run({ action: "search", query: "RARE_MIDDLE_MARKER" }));
    expect(search.matches).toHaveLength(0);
  });

  it("preserves source reachability through reload, compaction, fork and owned rewind without expanding compaction input", async () => {
    const h = harness();
    const root = h.session.getLeafId()!;
    h.session.appendCustomEntry(CONTEXT_CONTROL_TYPE, {
      version: 1, action: "checkpoint", checkpoint: {
        id: "cp", label: "research", sessionId: h.session.getSessionId(), originId: root,
        snapshot: fingerprintContext(contextMessageEntries(h.session.getBranch())),
      }
    });
    const captured = await h.capture();
    const id = artifactId(captured.artifact);
    const logDir = path.join(home, ".pi", "agent", "sessions", "artifact-test");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, h.session.getSessionId() + ".jsonl"),
      [h.session.getHeader(), ...h.session.getBranch()].map(entry => JSON.stringify(entry)).join("\n"));
    const recover = await resolveCompactionMessages(h.session.getSessionId(), contextMessageEntries(h.session.getBranch()));
    expect(recover).not.toBeNull();
    expect(recover?.some(item => item.entryId === captured.entryId)).toBe(true);
    expect(JSON.stringify(recover)).not.toContain("RARE_MIDDLE_MARKER");
    apply(h.session, planContextRewind(h.session.getBranch(), h.session.getSessionId(), "cp", "Use the archived auth evidence.").entries);
    expect((await h.run({ action: "read", id, offset: 10500, limit: 1000 })).content[0].text).toContain("RARE_MIDDLE_MARKER");
    const keep = h.session.appendMessage({ role: "user", content: "Continue", timestamp: 2 });
    h.session.appendCompaction("Goal and archived reference preserved", keep, 30_000);
    const fork = SessionManager.inMemory(process.cwd(), undefined, [{ ...h.session.getHeader()!, id: "forked" }, ...h.session.getBranch()]);
    const evidence = contextEvidence(fork.getBranch(), fork.getSessionId(), new SecretScrubber());
    expect(await evidence.read(id)).toBe(payload());
    expect(JSON.stringify(contextMessageEntries(fork.getBranch()))).not.toContain("RARE_MIDDLE_MARKER");
    fork.branch(root);
    await expect(contextEvidence(fork.getBranch(), fork.getSessionId(), new SecretScrubber()).read(id)).rejects.toThrow();
  });
});

describe("bounded artifact and session evidence search", () => {
  it("finds a middle match and reads only the requested lines without an extra LLM", async () => {
    const h = harness();
    const captured = await h.capture();
    const found = responseJson(await h.run({ action: "search", query: "RARE_MIDDLE_MARKER" }));
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({ id: artifactId(captured.artifact), source: "src/auth.ts", line: 602 });
    expect(found.matches[0].excerpt.length).toBeLessThanOrEqual(320);
    const bySource = responseJson(await h.run({ action: "search", query: "src/auth.ts" }));
    expect(bySource.matches[0]).toMatchObject({ id: artifactId(captured.artifact), matched: "source", line: 1 });
    const read = await h.run({ action: "read", id: found.matches[0].id, line: found.matches[0].line, limit: 1 });
    expect(read.content[0].text.split("\n").slice(1).join("\n")).toBe("RARE_MIDDLE_MARKER\n");
    await expect(h.run({ action: "search", query: "   " })).rejects.toThrow();
    await expect(h.run({ action: "search", query: "x", limit: 11 })).rejects.toThrow();
    await expect(h.run({ action: "read", id: found.matches[0].id, line: 0 })).rejects.toThrow();
    await expect(h.run({ action: "read", id: "../outside" })).rejects.toThrow();
  });

  it("also searches existing native-history references with source labels and pagination", async () => {
    const h = harness();
    h.cfg.artifactOffloadEnabled = false;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await h.capture(payload(), { input: { path: `src/file-${i}.ts` } })).entryId);
    for (let i = 0; i < 4; i++) h.session.appendMessage({ ...assistant("unused", "read"), content: [{ type: "text", text: "recent" }], stopReason: "stop" });
    apply(h.session, planContextTrim(h.session.getBranch()).entries);
    const first = responseJson(await h.run({ action: "search", query: "RARE_MIDDLE_MARKER", limit: 1 }));
    expect(first.matches[0]).toMatchObject({ id: ids[2], source: "src/file-2.ts" });
    expect(first.nextOffset).toBe(1);
    const second = responseJson(await h.run({ action: "search", query: "RARE_MIDDLE_MARKER", offset: first.nextOffset, limit: 2 }));
    expect(second.matches.map((match: any) => match.id)).toEqual([ids[1], ids[0]]);
    expect(second.nextOffset).toBeNull();
  });

  it.each(["path", "file_path", "filePath", "filename", "file", "target_file", "file_uri", "absolute_path"])("finds archived output by the supported %s path alias", async key => {
    const h = harness();
    h.cfg.artifactOffloadEnabled = false;
    const source = key === "file_uri" ? "file:///repo/src/aliased.ts" : "/repo/src/aliased.ts";
    const captured = await h.capture(payload(), { toolName: "read", input: { [key]: source } });
    for (let i = 0; i < 4; i++) h.session.appendMessage({ ...assistant("unused", "read"), content: [{ type: "text", text: "recent" }], stopReason: "stop" });
    apply(h.session, planContextTrim(h.session.getBranch()).entries);
    const status = JSON.parse((await h.run({ action: "status" })).content[0].text);
    expect(status.sources[0]).toMatchObject({ id: captured.entryId, source });
    const found = responseJson(await h.run({ action: "search", query: "aliased.ts" }));
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({ id: captured.entryId, source, matched: "source" });
    const read = await h.run({ action: "read", id: found.matches[0].id, line: 602, limit: 1 });
    expect(read.content[0].text).toContain("RARE_MIDDLE_MARKER");
  });

  it("bounds searching by source count and text volume, with resumable cursors", async () => {
    const h = harness();
    h.cfg.artifactOffloadEnabled = false;
    const ids: string[] = [];
    for (let index = 0; index < 35; index++) ids.push((await h.capture("no match " + index)).entryId);
    h.session.appendCustomEntry(CONTEXT_CONTROL_TYPE, { version: 1, action: "trim", references: ids });
    const first = responseJson(await h.run({ action: "search", query: "absent" }));
    expect(first.scanned).toBe(32);
    expect(first.nextOffset).toBe(32);
    const second = responseJson(await h.run({ action: "search", query: "absent", offset: first.nextOffset }));
    expect(second.scanned).toBe(3);
    expect(second.nextOffset).toBeNull();
    const huge = await h.capture("z".repeat(4 * 1024 * 1024 + 1));
    h.session.appendCustomEntry(CONTEXT_CONTROL_TYPE, { version: 1, action: "trim", references: [huge.entryId] });
    const bounded = responseJson(await h.run({ action: "search", query: "absent" }));
    expect(bounded.unavailable).toContain(huge.entryId);
    expect(bounded.scanned).toBe(0);
    expect(bounded.nextOffset).toBe(1);
  });

  it("always caps line reads, including a single giant line and EOF", () => {
    const text = "x".repeat(10_000) + "\nlast\n";
    const page = evidencePage(text, 0, 1, 1);
    expect(page.text.length).toBe(4096);
    expect(page.nextOffset).toBe(4096);
    expect(evidencePage(text, 0, 2, 2).text).toBe("last\n");
    expect(evidencePage(text, 0, 2, 100_000)).toEqual({ text: "", nextOffset: null });
    expect(() => evidencePage(text, 1, 1, 1)).toThrow();
  });
});
