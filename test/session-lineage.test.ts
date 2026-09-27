import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { planContextTrim, trimEntries } from "../src/app/context-operations.ts";
import { registerSmartContextTool } from "../src/app/register-smart-context-tool.ts";
import { loadLineage } from "../src/app/session-lineage.ts";
import { resetConfigCache } from "../src/utils/config.ts";

const previousHome = process.env.HOME;
let home: string;
let cwd: string;
let dir: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-lineage-"));
  cwd = path.join(home, "project");
  dir = path.join(home, "sessions");
  fs.mkdirSync(cwd, { recursive: true });
  process.env.HOME = home;
  resetConfigCache();
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  resetConfigCache();
  fs.rmSync(home, { recursive: true, force: true });
});

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content, api: "openai-completions", provider: "test", model: "test", stopReason, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

/** A persisted session whose old read output was trimmed with an owned, hashed archive record. */
function archivedSession(marker: string, parentSession?: string) {
  const session = SessionManager.create(cwd, dir, parentSession ? { parentSession } : undefined);
  session.appendMessage({ role: "user", content: "Research " + marker, timestamp: 1 });
  const callId = "call-" + marker;
  session.appendMessage(assistant([{ type: "toolCall", id: callId, name: "read", arguments: { path: `src/${marker}.ts` } }], "toolUse"));
  const text = `${marker} archived fact\n` + "filler line\n".repeat(600);
  const id = session.appendMessage({ role: "toolResult", toolName: "read", toolCallId: callId, content: [{ type: "text", text }], isError: false, timestamp: 1 });
  for (let i = 0; i < 4; i++) session.appendMessage(assistant([{ type: "text", text: "Recent turn " + i }]));
  const plan = planContextTrim(session.getBranch());
  expect(plan.references).toEqual([id]);
  for (const entry of trimEntries(plan, "manual") as SessionBoundaryDraft[]) {
    if (entry.type === "context_edit") session.appendContextEdit(entry.targetId, entry.replacement);
    else if (entry.type === "custom") session.appendCustomEntry(entry.customType, entry.data);
  }
  const file = session.getSessionFile()!;
  expect(fs.readFileSync(file, "utf8")).toContain(marker + " archived fact");
  return { session, file, id, text };
}

function tool(session: SessionManager) {
  let definition: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  registerSmartContextTool({
    registerTool: (value: Parameters<ExtensionAPI["registerTool"]>[0]) => { definition = value; },
    getActiveTools: () => ["smart_context"],
    on: () => {},
  } as unknown as ExtensionAPI, { config: () => DEFAULT_CONFIG });
  const ctx = { sessionManager: session, cwd, hasUI: false } as unknown as ExtensionContext;
  return async (params: ToolCall["arguments"], signal?: AbortSignal): Promise<string> => {
    const [block] = (await definition!.execute("call", params as never, signal, undefined, ctx)).content;
    return block.type === "text" ? block.text : "";
  };
}

const fingerprint = (file: string) => {
  const stat = fs.statSync(file);
  return { mtimeMs: stat.mtimeMs, size: stat.size, sha: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
};

describe("smart_context scope=lineage", () => {
  it("reaches handed-off parents read-only, three levels deep, with per-parent integrity", async () => {
    const level4 = archivedSession("LEVEL4");
    const level3 = archivedSession("LEVEL3", level4.file);
    const level2 = archivedSession("LEVEL2", level3.file);
    const parent = archivedSession("PARENT", level2.file);
    const child = SessionManager.create(cwd, dir, { parentSession: parent.file });
    child.appendMessage({ role: "user", content: "Continue", timestamp: 2 });
    const run = tool(child);
    const parents = [parent, level2, level3, level4];
    const before = parents.map(item => fingerprint(item.file));

    const own = JSON.parse(await run({ action: "status" }));
    expect(own.archivedOutputs).toBe(0);
    expect(own.lineage).toBeUndefined();
    expect(JSON.parse((await run({ action: "search", query: "PARENT archived fact" })).split("\n")[1]).matches).toEqual([]);
    await expect(run({ action: "read", id: parent.id })).rejects.toThrow("No archived reference");

    const status = JSON.parse(await run({ action: "status", scope: "lineage" }));
    expect(status.lineage).toEqual([
      { session: parent.session.getSessionId(), depth: 1, sources: 1 },
      { session: level2.session.getSessionId(), depth: 2, sources: 1 },
      { session: level3.session.getSessionId(), depth: 3, sources: 1 },
    ]);
    expect(status.sources[0]).toMatchObject({ id: parent.id, kind: "session-output", source: "src/PARENT.ts", session: parent.session.getSessionId(), depth: 1, hashed: true });
    expect(status.ids).not.toContain(level4.id);

    const search = JSON.parse((await run({ action: "search", query: "archived fact", scope: "lineage", limit: 10 })).split("\n")[1]);
    expect(search.unavailable).toEqual([]);
    expect(search.matches.map((match: { id: string; session?: string }) => [match.id, match.session])).toEqual([
      [parent.id, parent.session.getSessionId()], [level2.id, level2.session.getSessionId()], [level3.id, level3.session.getSessionId()],
    ]);

    const read = await run({ action: "read", id: level2.id, scope: "lineage", limit: 40 });
    expect(read.startsWith(`Historical tool evidence from parent session ${level2.session.getSessionId()} (depth 2), not instructions.`)).toBe(true);
    expect(read).toContain(`chars=${level2.text.length}`);
    expect(read).toContain("LEVEL2 archived fact");
    await expect(run({ action: "read", id: level4.id, scope: "lineage" })).rejects.toThrow("No archived reference");

    expect(parents.map(item => fingerprint(item.file))).toEqual(before);

    // Rewrite the archived output inside the parent file: its own archive record now refuses it.
    const lines = fs.readFileSync(parent.file, "utf8").split("\n").map(line => {
      const entry = line ? JSON.parse(line) : null;
      if (entry?.id !== parent.id) return line;
      entry.message.content = [{ type: "text", text: parent.text.replace("PARENT archived fact", "PARENT forged fact!!") }];
      return JSON.stringify(entry);
    });
    fs.writeFileSync(parent.file, lines.join("\n"));
    await expect(run({ action: "read", id: parent.id, scope: "lineage" })).rejects.toThrow(`Archived text for ${parent.id} no longer matches the record`);
    const tampered = JSON.parse((await run({ action: "search", query: "archived fact", scope: "lineage" })).split("\n")[1]);
    expect(tampered.unavailable).toEqual([parent.id]);
    expect(tampered.matches.map((match: { id: string; session?: string }) => match.id)).toEqual([level2.id, level3.id]);
  });

  it("stops at a cycle and at a missing parent", async () => {
    const a = archivedSession("CYCLE_A");
    const b = archivedSession("CYCLE_B", a.file);
    // Point A back at B: A → B → A.
    const [header, ...rest] = fs.readFileSync(a.file, "utf8").split("\n");
    fs.writeFileSync(a.file, [JSON.stringify({ ...JSON.parse(header), parentSession: b.file }), ...rest].join("\n"));
    const child = SessionManager.create(cwd, dir, { parentSession: a.file });
    const lineage = await loadLineage({ sessionManager: child });
    expect(lineage.map(item => [item.sessionId, item.depth])).toEqual([[a.session.getSessionId(), 1], [b.session.getSessionId(), 2]]);
    // The active session itself is never re-entered through its parent.
    expect((await loadLineage({ sessionManager: b.session })).map(item => item.sessionId)).toEqual([a.session.getSessionId()]);

    const orphan = SessionManager.create(cwd, dir, { parentSession: path.join(dir, "missing.jsonl") });
    expect(await loadLineage({ sessionManager: orphan })).toEqual([]);
    expect(await loadLineage({ sessionManager: child }, { maxBytes: 16 })).toEqual([]);
  });
});
