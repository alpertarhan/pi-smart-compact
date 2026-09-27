import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  ANCHOR_CUSTOM_TYPE,
  anchorFromEntry,
  anchorFromMessage,
  getEditorInjectionFor,
  listAnchors,
  recallAnchors,
  resolveAnchorTarget,
} from "../src/app/navigation-data.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function anchorCall(id: string, name: string, toolName = "smart_navigation"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "toolCall", id, name: toolName, arguments: { action: "anchor", name, summary: "s" } }],
    api: "anthropic-messages", provider: "anthropic", model: "test", stopReason: "toolUse", timestamp: 1, usage,
  };
}

/** Anchor the way the tool records it: targetId is the leaf at execute() time, i.e. the toolCall. */
function addAnchor(sm: SessionManager, name: string, summary: string, opts: { toolName?: string; argName?: string; resultCallId?: string } = {}) {
  const callId = `call-${name}`;
  const call = sm.appendMessage(anchorCall(callId, opts.argName ?? name, opts.toolName));
  const result = sm.appendMessage({
    role: "toolResult", toolCallId: opts.resultCallId ?? callId, toolName: opts.toolName ?? "smart_navigation",
    content: [{ type: "text", text: summary }], isError: false, timestamp: 2,
    details: { anchor: { name, targetId: call, summary } },
  });
  return { call, result };
}

describe("anchor recognition", () => {
  it("accepts owned, legacy and human anchors only", () => {
    const anchor = { name: "n", targetId: "t", summary: "s" };
    expect(anchorFromMessage({ role: "toolResult", toolName: "smart_navigation", details: { anchor } })).toEqual(anchor);
    expect(anchorFromMessage({ role: "toolResult", toolName: "context", details: { anchor: { name: "n", summary: "s" } } }))
      .toEqual({ name: "n", targetId: "", summary: "s" });
    expect(anchorFromMessage({ role: "custom", customType: ANCHOR_CUSTOM_TYPE, details: { anchor } })).toEqual(anchor);
    expect(anchorFromEntry({ type: "custom_message", customType: ANCHOR_CUSTOM_TYPE, details: { anchor } })).toEqual(anchor);

    expect(anchorFromMessage({ role: "toolResult", toolName: "read", details: { anchor } })).toBeNull();
    expect(anchorFromMessage({ role: "custom", customType: "other", details: { anchor } })).toBeNull();
    expect(anchorFromMessage({ role: "assistant", details: { anchor } })).toBeNull();
    expect(anchorFromMessage({ role: "toolResult", toolName: "context", details: { anchor: { name: "", summary: "s" } } })).toBeNull();
    expect(anchorFromMessage({ role: "toolResult", toolName: "context", details: { anchor: { name: "n" } } })).toBeNull();
    expect(anchorFromEntry({ type: "custom", customType: ANCHOR_CUSTOM_TYPE, data: { anchor } })).toBeNull();
  });
});

describe("resolveAnchorTarget", () => {
  it("lands on the entry that carries the anchor summary", () => {
    const sm = SessionManager.inMemory();
    const start = sm.appendMessage({ role: "user", content: "start", timestamp: 1 });
    const owned = addAnchor(sm, "alpha", "alpha summary");
    const legacy = addAnchor(sm, "beta", "beta summary", { toolName: "context" });
    const before = sm.getLeafId()!;
    const human = sm.appendCustomMessageEntry(ANCHOR_CUSTOM_TYPE, "[Anchor: gamma]", true, { anchor: { name: "gamma", targetId: before, summary: "g" } });
    sm.appendLabelChange(start, "kickoff");

    expect(resolveAnchorTarget(sm, "alpha")).toBe(owned.result);
    expect(resolveAnchorTarget(sm, owned.call)).toBe(owned.result);
    expect(resolveAnchorTarget(sm, owned.result)).toBe(owned.result);
    expect(resolveAnchorTarget(sm, "beta")).toBe(legacy.result);
    expect(resolveAnchorTarget(sm, legacy.call)).toBe(legacy.result);
    expect(resolveAnchorTarget(sm, "gamma")).toBe(human);
    expect(resolveAnchorTarget(sm, "kickoff")).toBe(start);
    expect(resolveAnchorTarget(sm, "missing")).toBeNull();
  });

  it("does not guess when anchor data does not verify", () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage({ role: "user", content: "start", timestamp: 1 });
    const renamed = addAnchor(sm, "delta", "d", { argName: "other" });
    const mismatched = addAnchor(sm, "eps", "e", { resultCallId: "call-unknown" });
    sm.appendMessage({
      role: "toolResult", toolCallId: "x", toolName: "smart_navigation", content: [], isError: false, timestamp: 3,
      details: { anchor: { name: "ghost", targetId: "deadbeef", summary: "gone" } },
    });

    expect(resolveAnchorTarget(sm, "delta")).toBe(renamed.call);
    expect(resolveAnchorTarget(sm, renamed.call)).toBe(renamed.call);
    expect(resolveAnchorTarget(sm, "eps")).toBe(mismatched.call);
    expect(resolveAnchorTarget(sm, "ghost")).toBeNull();
  });
});

describe("listAnchors", () => {
  it("lists active branch newest-first before off-branch, with keyword and paging", () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage({ role: "user", content: "u0", timestamp: 1 });
    const w = addAnchor(sm, "w", "first");
    sm.appendMessage({ role: "user", content: "u1", timestamp: 1 });
    const x = addAnchor(sm, "x", "abandoned idea");
    sm.branch(w.result);
    sm.appendMessage({ role: "user", content: "u2", timestamp: 1 });
    const z = addAnchor(sm, "z", "latest");

    const all = listAnchors(sm);
    expect(all.anchors.map(a => [a.id, a.onBranch])).toEqual([[z.result, true], [w.result, true], [x.result, false]]);
    expect(all).toMatchObject({ total: 3, nextOffset: null });

    const second = listAnchors(sm, { limit: 1, offset: 1 });
    expect(second.anchors.map(a => a.id)).toEqual([w.result]);
    expect(second).toMatchObject({ total: 3, nextOffset: 2 });

    expect(listAnchors(sm, { keyword: "ABANDONED" }).anchors.map(a => a.id)).toEqual([x.result]);
    expect(listAnchors(sm, { offset: 5 })).toEqual({ anchors: [], total: 3, nextOffset: null });
  });

  it("does not mark an abandoned human anchor active merely because its parent remains", () => {
    const sm = SessionManager.inMemory();
    const parent = sm.appendMessage({ role: "user", content: "shared history", timestamp: 1 });
    const human = sm.appendCustomMessageEntry(ANCHOR_CUSTOM_TYPE, "anchor summary", true, { anchor: { name: "abandoned", targetId: parent, summary: "only on the old branch" } });
    expect(listAnchors(sm).anchors[0]).toMatchObject({ id: human, onBranch: true });
    sm.branch(parent);
    expect(listAnchors(sm).anchors[0]).toMatchObject({ id: human, onBranch: false });
  });
});

describe("getEditorInjectionFor", () => {
  it("returns the text Pi auto-fills for user and custom message targets only", () => {
    const sm = SessionManager.inMemory();
    const user = sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "there" }], timestamp: 1 });
    const anchor = addAnchor(sm, "a", "sum");
    const custom = sm.appendCustomMessageEntry(ANCHOR_CUSTOM_TYPE, "[Anchor: h]\nbody", true, { anchor: { name: "h", targetId: anchor.result, summary: "body" } });
    expect(getEditorInjectionFor(sm, user)).toBe("hello there");
    expect(getEditorInjectionFor(sm, custom)).toBe("[Anchor: h]\nbody");
    expect(getEditorInjectionFor(sm, anchor.result)).toBe("");
    expect(getEditorInjectionFor(sm, "nope")).toBe("");
  });
});

describe("recallAnchors", () => {
  const user = path.basename(os.homedir());
  const project = `/Users/${user}/work/nav-proj`;
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function sessionsRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nav-recall-"));
    temps.push(dir);
    return dir;
  }

  /** Persist a real session with anchors stamped at the given times; returns the file. */
  function writeSession(root: string, subdir: string, cwd: string, anchors: Array<[name: string, summary: string, at: string]>, mtime: number): string {
    const dir = path.join(root, subdir);
    fs.mkdirSync(dir, { recursive: true });
    const sm = SessionManager.inMemory(cwd);
    sm.appendMessage({ role: "user", content: "start", timestamp: 1 });
    const times = new Map<string, string>();
    for (const [name, summary, at] of anchors) times.set(addAnchor(sm, name, summary).result, at);
    const lines = [sm.getHeader(), ...sm.getEntries().map(e => ({ ...e, timestamp: times.get(e.id) ?? e.timestamp }))];
    const file = path.join(dir, `${sm.getSessionId()}.jsonl`);
    fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    fs.utimesSync(file, mtime, mtime);
    return file;
  }

  it("matches the project home-portably across session directories, newest first", async () => {
    const root = sessionsRoot();
    writeSession(root, "--old-encoding--", `/home/${user}/work/nav-proj`, [["moved", "synced from linux", "2026-01-02T00:00:00.000Z"]], 100);
    writeSession(root, "--Users-work-nav-proj--", project, [["local-a", "first local", "2026-01-01T00:00:00.000Z"], ["local-b", "second local", "2026-01-03T00:00:00.000Z"]], 200);
    writeSession(root, "--other--", `/Users/${user}/work/other`, [["other", "other project", "2026-01-04T00:00:00.000Z"]], 300);
    writeSession(root, "--foreign--", "/home/someone-else-entirely/work/nav-proj", [["foreign", "other account", "2026-01-05T00:00:00.000Z"]], 400);

    const scoped = await recallAnchors({ sessionsDir: root, cwd: project });
    expect(scoped.anchors.map(a => a.data.name)).toEqual(["local-b", "moved", "local-a"]);
    expect(scoped.anchors[1]).toMatchObject({ cwd: `/home/${user}/work/nav-proj`, onBranch: false });
    expect(scoped.anchors[1]!.sessionFile).toContain("--old-encoding--");

    const all = await recallAnchors({ sessionsDir: root, cwd: project, scope: "all" });
    expect(all.anchors.map(a => a.data.name)).toEqual(["foreign", "other", "local-b", "moved", "local-a"]);

    const paged = await recallAnchors({ sessionsDir: root, cwd: project, scope: "all", limit: 2, offset: 2 });
    expect(paged.anchors.map(a => a.data.name)).toEqual(["local-b", "moved"]);
    expect(paged).toMatchObject({ total: 5, nextOffset: 4 });

    const keyword = await recallAnchors({ sessionsDir: root, cwd: project, keyword: "LINUX" });
    expect(keyword.anchors.map(a => a.data.name)).toEqual(["moved"]);
  });

  it("sees anchors appended since the previous recall", async () => {
    const root = sessionsRoot();
    const file = writeSession(root, "--p--", project, [["first", "one", "2026-01-01T00:00:00.000Z"]], 100);
    expect((await recallAnchors({ sessionsDir: root, cwd: project })).total).toBe(1);

    const reopened = SessionManager.open(file, path.dirname(file));
    addAnchor(reopened, "second", "two");
    const after = await recallAnchors({ sessionsDir: root, cwd: project });
    expect(after.anchors.map(a => a.data.name)).toEqual(["second", "first"]);
  });

  it("isolates malformed sessions and never assigns them a project", async () => {
    const root = sessionsRoot();
    writeSession(root, "--p--", project, [["good", "valid", "2026-01-01T00:00:00.000Z"]], 100);
    const junk = path.join(root, "--junk--");
    fs.mkdirSync(path.join(junk, "dir.jsonl"), { recursive: true });
    const orphan = JSON.stringify({
      type: "message", id: "abc", parentId: null, timestamp: "2026-02-01T00:00:00.000Z",
      message: { role: "toolResult", toolName: "smart_navigation", toolCallId: "c", content: [], isError: false, timestamp: 1, details: { anchor: { name: "orphan", summary: "no header" } } }
    });
    fs.writeFileSync(path.join(junk, "bad-header.jsonl"), `not json\n${orphan}\n`);
    fs.writeFileSync(path.join(junk, "truncated.jsonl"), `{"type":"session","cwd":"${project}`);
    fs.writeFileSync(path.join(junk, "garbage-lines.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "g", timestamp: "2026-01-01T00:00:00.000Z", cwd: project }),
      `{"type":"message","toolName":"smart_navigation","anchor"`,
      JSON.stringify({ type: "message", id: "bad", parentId: null, timestamp: "x", message: { role: "toolResult", toolName: "smart_navigation", details: { anchor: { name: 7, summary: "s" } } } }),
      JSON.stringify({ type: "message", id: "kept", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", message: { role: "toolResult", toolName: "context", toolCallId: "c", content: [], isError: false, timestamp: 1, details: { anchor: { name: "survivor", summary: "legacy" } } } }),
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(root, "stray.jsonl"), `${orphan}\n`);

    expect((await recallAnchors({ sessionsDir: root, cwd: project })).anchors.map(a => a.data.name)).toEqual(["survivor", "good"]);
    expect((await recallAnchors({ sessionsDir: root, cwd: project, scope: "all" })).anchors.map(a => a.data.name)).toEqual(["survivor", "good"]);
    expect(await recallAnchors({ sessionsDir: path.join(root, "missing"), cwd: project })).toEqual({ anchors: [], total: 0, nextOffset: null });
  });

  it("cancels without poisoning later recalls", async () => {
    const root = sessionsRoot();
    writeSession(root, "--p--", project, [["target", "found", "2026-01-01T00:00:00.000Z"]], 100);

    const aborted = new AbortController();
    aborted.abort();
    await expect(recallAnchors({ sessionsDir: root, cwd: project, signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });

    const midway = new AbortController();
    const pending = recallAnchors({ sessionsDir: root, cwd: project, signal: midway.signal });
    midway.abort(); // after the synchronous entry check, while the scan is in flight
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    expect((await recallAnchors({ sessionsDir: root, cwd: project })).anchors.map(a => a.data.name)).toEqual(["target"]);
  });
});
