/**
 * Long-session storage durability: artifact spill must survive 20+ days,
 * real session reload, and forks through the public consumer, fail closed on
 * missing/corrupt bytes, respect per-session caps without losing earlier
 * evidence, and stay distinct from age-pruned conversation backups.
 *
 * Time advance is deterministic: files are aged with utimes, never slept on.
 * Sessions are real SDK disk sessions (create/open/forkFrom), and retrieval
 * goes through the registered smart_context tool, not internal helpers.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { defaultBackupDir, toolArtifactsDir } from "../src/infra/paths.ts";
import {
 ARTIFACT_DETAILS_KEY, ARTIFACT_SESSION_FILES, artifactId, parseToolArtifact, registerArtifactOffload,
} from "../src/app/tool-artifacts.ts";
import { inspectArtifactStorage } from "../src/app/artifact-storage.ts";
import { registerSmartContextTool } from "../src/app/register-smart-context-tool.ts";
import { commitPreparedConversationBackup, prepareConversationBackup } from "../src/utils/backups.ts";

const previousHome = process.env.HOME;
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-long-session-")); process.env.HOME = home; });
afterEach(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; fs.rmSync(home, { recursive: true, force: true }); });

const payload = () => "first line\n" + "ordinary evidence\n".repeat(600) + "RARE_MIDDLE_MARKER\n" + "more evidence\n".repeat(600) + "last line";
const TWENTY_DAYS_AND_AN_HOUR_S = 20 * 24 * 3600 + 3600;

const assistant = (callId: string, toolName: string, input: Record<string, any> = {}): AssistantMessage => ({
 role: "assistant", content: [{ type: "toolCall", id: callId, name: toolName, arguments: input }], stopReason: "toolUse",
 api: "openai-responses", provider: "test", model: "test", timestamp: 1,
 usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

/** Deterministic clock advance for storage: age a file's timestamps into the past. */
function ageFile(file: string, secondsAgo = TWENTY_DAYS_AND_AN_HOUR_S): void {
 const t = (Date.now() - secondsAgo * 1000) / 1000;
 fs.utimesSync(file, t, t);
}

function diskHarness() {
 const cwd = path.join(home, "proj");
 fs.mkdirSync(cwd, { recursive: true });
 const logDir = path.join(home, ".pi", "agent", "sessions", "--proj--");
 fs.mkdirSync(logDir, { recursive: true });
 const session = SessionManager.create(cwd, logDir);
 session.appendMessage({ role: "user", content: "Inspect auth", timestamp: 1 });
 const cfg = { ...DEFAULT_CONFIG, artifactOffloadEnabled: true };
 const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>>();
 let tool: { execute: (callId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: ExtensionContext) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> };
 // Partial host double: pi's ExtensionAPI is wide; only registration surface is exercised here.
 const pi = {
  getActiveTools: () => ["smart_context"], registerTool: (value: never) => { tool = value; },
  on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => handlers.set(name, [...handlers.get(name) ?? [], fn])
 } as unknown as ExtensionAPI;
 registerArtifactOffload(pi, () => cfg, () => true);
 registerSmartContextTool(pi, { config: () => cfg });
 let sequence = 0;
 const ctx = { sessionManager: session, signal: new AbortController().signal } as unknown as ExtensionContext;
 const capture = async (text = payload(), overrides: Record<string, unknown> = {}) => {
  const event = {
   type: "tool_result", toolName: "grep", toolCallId: "c" + sequence++, input: { path: "src/auth.ts" },
   isError: false, content: [{ type: "text", text }], details: {}, ...overrides
  };
  session.appendMessage(assistant(event.toolCallId, event.toolName, event.input));
  const result = await handlers.get("tool_result")![0](event, ctx) as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } | undefined;
  session.appendMessage({
   role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName,
   content: result?.content ?? event.content, details: result?.details ?? event.details, isError: event.isError, timestamp: 1
  } as ToolResultMessage);
  return { result, event, artifact: result?.details[ARTIFACT_DETAILS_KEY] };
 };
 const run = (params: Record<string, unknown>, manager = session) =>
  tool.execute("reader", params, undefined, undefined, { ...ctx, sessionManager: manager } as ExtensionContext);
 return { session, cfg, capture, run, cwd, logDir };
}

function capturedArtifact(value: unknown) {
 const artifact = parseToolArtifact(value);
 if (!artifact) throw new Error("Expected an offloaded artifact from the registered handler");
 return artifact;
}

function storedFile(artifact: { owner: string; hash: string }) { return path.join(toolArtifactsDir(), artifact.owner, artifact.hash + ".txt"); }
const responseJson = (response: { content: Array<{ type: string; text: string }> }) => JSON.parse(response.content[0].text.split("\n").slice(1).join("\n"));

describe("20+ day artifact storage durability", () => {
 it("keeps aged artifacts retrievable through real SDK reload and fork via the public consumer", async () => {
  const h = diskHarness();
  const captured = await h.capture();
  const id = artifactId(capturedArtifact(captured.artifact));
  const file = storedFile(capturedArtifact(captured.artifact));
  const sessionFile = h.session.getSessionId() && h.session.getSessionFile()!;
  // The reference itself is durable: it lives in the native session log.
  expect(fs.readFileSync(sessionFile, "utf8")).toContain("smartCompactArtifact");
  // Deterministic time advance: artifact bytes and session log are now >20 days old.
  ageFile(file);
  ageFile(sessionFile);
  const reloaded = SessionManager.open(sessionFile, h.logDir, h.cwd);
  expect(reloaded.getSessionId()).toBe(h.session.getSessionId());
  const read = await h.run({ action: "read", id, offset: 10500, limit: 1000 }, reloaded);
  expect(read.content[0].text).toContain("RARE_MIDDLE_MARKER");
  const search = responseJson(await h.run({ action: "search", query: "RARE_MIDDLE_MARKER" }, reloaded));
  expect(search.matches).toHaveLength(1);
  expect(search.matches[0].id).toBe(id);
  const forkDir = path.join(home, ".pi", "agent", "sessions", "--proj2--");
  const fork = SessionManager.forkFrom(sessionFile, path.join(home, "proj2"), forkDir);
  const forkRead = await h.run({ action: "read", id, line: 602, limit: 1 }, fork);
  expect(forkRead.content[0].text).toContain("RARE_MIDDLE_MARKER");
  // Forking references bytes; it never copies them.
  expect(fs.readdirSync(path.dirname(file))).toHaveLength(1);
  // The storage inventory proves the same lineage through both anchors.
  const report = await inspectArtifactStorage();
  const owner = report.owners.find(item => item.owner === capturedArtifact(captured.artifact).owner);
  expect(owner?.status).toBe("live");
  expect(owner?.reasons).toContain("session-file");
  expect(owner?.reasons).toContain("artifact-reference");
 });

 it.each([["missing", "unlink"], ["tampered", "overwrite"]])("fails closed on %s artifact bytes after 20 days", async (kind, mode) => {
  const h = diskHarness();
  const captured = await h.capture();
  const id = artifactId(capturedArtifact(captured.artifact));
  const file = storedFile(capturedArtifact(captured.artifact));
  ageFile(file);
  ageFile(h.session.getSessionFile()!);
  const reloaded = SessionManager.open(h.session.getSessionFile()!, h.logDir, h.cwd);
  if (mode === "unlink") fs.unlinkSync(file);
  else fs.writeFileSync(file, "tampered bytes with the same intent");
  await expect(h.run({ action: "read", id }, reloaded)).rejects.toThrow("Artifact unavailable or changed");
  const search = responseJson(await h.run({ action: "search", query: "RARE_MIDDLE_MARKER" }, reloaded));
  expect(search.matches).toHaveLength(0);
  expect(search.unavailable).toContain(id);
 });

 it("stops offloading at the per-session file cap while keeping earlier evidence and the original output", async () => {
  const h = diskHarness();
  const first = await h.capture();
  const dir = path.dirname(storedFile(capturedArtifact(first.artifact)));
  const hexTxtCount = () => fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.txt$/.test(name)).length;
  for (let index = hexTxtCount(); index < ARTIFACT_SESSION_FILES; index++) {
   fs.writeFileSync(path.join(dir, index.toString(16).padStart(64, "0") + ".txt"), "filler");
  }
  const freshPayload = "fresh payload\n" + "uncommon second marker\n".repeat(1500);
  const refused = await h.capture(freshPayload);
  expect(refused.result).toBeUndefined();
  expect(refused.event.content[0].text).toBe(freshPayload);
  expect(hexTxtCount()).toBe(ARTIFACT_SESSION_FILES);
  const read = await h.run({ action: "read", id: artifactId(capturedArtifact(first.artifact)), line: 602, limit: 1 });
  expect(read.content[0].text).toContain("RARE_MIDDLE_MARKER");
 });

 it("prunes aged conversation backups while >20-day artifact spill stays fully retrievable", async () => {
  const h = diskHarness();
  const captured = await h.capture();
  const file = storedFile(capturedArtifact(captured.artifact));
  const oldPrepared = prepareConversationBackup("older backup", h.session.getSessionId());
  expect(oldPrepared).not.toBeNull();
  await commitPreparedConversationBackup(oldPrepared!);
  const backupDir = defaultBackupDir();
  const oldBackup = fs.readdirSync(backupDir).map(name => path.join(backupDir, name))[0];
  // Backups carry a 14-day retention window; artifacts deliberately carry none.
  ageFile(oldBackup, 15 * 24 * 3600);
  ageFile(file);
  const trigger = prepareConversationBackup("trigger prune", h.session.getSessionId());
  await commitPreparedConversationBackup(trigger!);
  // Product prune is a real setTimeout(0) macrotask; fake timers cannot advance
  // the loop's macrotask queue alongside these fs ops, so hop the loop once.
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 20);
  await promise;
  expect(fs.existsSync(oldBackup)).toBe(false);
  expect(fs.existsSync(file)).toBe(true);
  const reloaded = SessionManager.open(h.session.getSessionFile()!, h.logDir, h.cwd);
  const read = await h.run({ action: "read", id: artifactId(capturedArtifact(captured.artifact)), line: 602, limit: 1 }, reloaded);
  expect(read.content[0].text).toContain("RARE_MIDDLE_MARKER");
 });
});
