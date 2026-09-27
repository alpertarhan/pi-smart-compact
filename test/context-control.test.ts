import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { SessionManager, buildSessionProjection, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { AUTO_TRIM_BREAK_EVEN_REQUESTS, DEFAULT_CONFIG, FIVE_MINUTES_MS, ONE_HOUR_MS, TRIM_MARKER_MAX_CHARS, TRIM_MARKER_MAX_LINES } from "../src/constants.ts";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";
import { makeTokenEstimator } from "../src/utils/tokens.ts";
import type { LlmMessage } from "../src/types.ts";
import { fingerprintContext } from "../src/app/pending-slot.ts";
import { registerSmartContextTool } from "../src/app/register-smart-context-tool.ts";
import {
  CONTEXT_CONTROL_TYPE, inspectContext, planContextTrim, planContextRewind, readContextReference,
  lastAnchorBoundary, MAX_CONTEXT_EDITS, buildTrimMarker,
} from "../src/app/context-operations.ts";
import { contextEvidence } from "../src/app/context-evidence.ts";
import { SecretScrubber } from "../src/domain/scrub.ts";
function assistant(content: AssistantMessage["content"] = [], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content, api: "openai-completions", provider: "test", model: "test", stopReason, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  };
}
let sequence = 0;
function toolBatch(manager: SessionManager, name: string, text: string, isError = false, args: ToolCall["arguments"] = {}) {
  const callId = "call-" + sequence++;
  const call = manager.appendMessage(assistant([{ type: "toolCall", id: callId, name, arguments: args }], "toolUse"));
  const result = manager.appendMessage({
    role: "toolResult", toolName: name, toolCallId: callId,
    content: [{ type: "text", text }], isError, timestamp: 1
  });
  return { call, result };
}
function manager() {
  const result = SessionManager.inMemory();
  result.appendMessage({ role: "user", content: "Keep user constraints exactly", timestamp: 1 });
  return result;
}
function apply(session: SessionManager, entries: SessionBoundaryDraft[]) {
  for (const entry of entries) {
    switch (entry.type) {
      case "context_edit": session.appendContextEdit(entry.targetId, entry.replacement); break;
      case "custom": session.appendCustomEntry(entry.customType, entry.data); break;
      case "custom_message": session.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details); break;
      default: throw new Error("Unexpected compaction; context control must not use it");
    }
  }
}
function checkpoint(session: SessionManager, id = "checkpoint-1") {
  session.appendCustomEntry(CONTEXT_CONTROL_TYPE, {
    version: 1, action: "checkpoint", checkpoint: {
      id, label: "Research", sessionId: session.getSessionId(), originId: session.getLeafId(),
      snapshot: fingerprintContext(contextMessageEntries(session.getBranch())),
    }
  });
  return id;
}
function tail(session: SessionManager, count = 4) {
  for (let i = 0; i < count; i++) session.appendMessage(assistant([{ type: "text", text: "Recent protected turn " + i }]));
}
function ids(session: SessionManager) { return buildSessionProjection(session.getBranch()).entries.filter(entry => entry.messages.length).map(entry => entry.sourceEntry.id); }
/** Independent expectation for a recorded archive: SHA-256 hex and length of the archived text. */
function archiveOf(id: string, text: string) { return { id, sha256: createHash("sha256").update(text).digest("hex"), chars: text.length }; }

function harness(options: { background?: boolean; canTrim?: boolean; session?: SessionManager; canMutate?: boolean; model?: object } = {}) {
  const session = options.session ?? manager();
  const handlers = new Map<string, any[]>();
  let tool: any;
  let active = true;
  let tokens = 140_000;
  let changed = 0;
  let clock = 1 + 60_000;
  const edits: string[] = [];
  let paused = false;
  let canMutate = options.canMutate !== false;
  const cfg = { ...DEFAULT_CONFIG, autoTrigger: true, autoTriggerStrategy: options.background ? "background" as const : "native-hook" as const, minContextPercent: 80 };
  const ctx = {
    sessionManager: session, cwd: process.cwd(), hasUI: false,
    model: { contextWindow: 200_000, ...options.model }, getContextUsage: () => ({ tokens }),
  } as unknown as ExtensionContext;
  const controller = registerSmartContextTool({
    registerTool: (definition: any) => { tool = definition; },
    getActiveTools: () => active ? ["smart_context"] : [],
    on: (name: string, fn: any) => handlers.set(name, [...handlers.get(name) ?? [], fn]),
  } as any, { config: () => cfg, isPaused: () => paused, canAutoTrim: () => options.canTrim !== false, canAgentMutate: () => canMutate, onContextChange: () => { changed++; }, onContextEdit: (_ctx, kind) => { edits.push(kind); }, now: () => clock });

  const execute = async (params: ToolCall["arguments"], signal?: AbortSignal) => {
    const callId = "control-" + sequence++;
    const message = assistant([{ type: "toolCall", name: "smart_context", id: callId, arguments: params }], "toolUse");
    const messageEntryId = session.appendMessage(message);
    const response = await tool.execute(callId, params, signal, undefined, ctx);
    const result: ToolResultMessage = {
      role: "toolResult", toolCallId: callId, toolName: "smart_context",
      content: response.content, details: response.details, isError: false, timestamp: 1
    };
    const resultId = session.appendMessage(result);
    return { response, message, messageEntryId, toolResults: [result], toolResultEntryIds: [resultId] };
  };
  const boundary = (batch: Awaited<ReturnType<typeof execute>>, overrides: Record<string, unknown> = {}, commit = true) => {
    const event = {
      type: "turn_end", outcome: "completed", turnIndex: 0, entries: [], continue: false,
      context: { pendingMessages: [], contextEntries: buildSessionProjection(session.getBranch()).entries },
      ...batch, ...overrides
    };
    const result = handlers.get("turn_end")![0](event, ctx);
    if (result?.entries && commit) apply(session, result.entries);
    return result;
  };
  return {
    session, ctx, handlers, execute, boundary, tool, controller, cfg, changes: () => changed, edits: () => edits, setPaused: (value: boolean) => { paused = value; },
    nextRequest: () => {
      for (const fn of handlers.get("context")!) fn({ type: "context", messages: [] }, ctx);
    },
    /** A provider request as Pi runs it: `context` (conversation only) then `context_with_system` (full transcript, sent as returned). */
    request: () => {
      const projected = buildSessionProjection(session.getBranch()).messages;
      for (const fn of handlers.get("context")!) fn({ type: "context", messages: structuredClone(projected) }, ctx);
      const system = { role: "system", content: "prompt", timestamp: 0 };
      const messages = [system, ...structuredClone(projected)];
      const result = handlers.get("context_with_system")![0]({ type: "context_with_system", messages }, ctx);
      // The leading system message must survive untouched, by identity.
      if (result?.messages) expect(result.messages[0]).toBe(system);
      return { messages, result };
    },
    /** An ordinary completed (or overridden) turn, not a smart_context request. */
    turn: (overrides: Record<string, unknown> = {}) => {
      const leaf = session.getLeafId()!;
      return boundary({ response: {}, message: assistant(), messageEntryId: leaf, toolResults: [], toolResultEntryIds: [] } as any, overrides);
    },
    setNow: (value: number) => { clock = value; },
    setCanMutate: (value: boolean) => { canMutate = value; },
    setActive: (value: boolean) => { active = value; }, setTokens: (value: number) => { tokens = value; }
  };
}

describe("recoverable context edits", () => {
  it("archives only old, successful read-only text without changing original metadata", () => {
    const session = manager();
    const old = toolBatch(session, "read", "evidence".repeat(2_000));
    const failed = toolBatch(session, "read", "failure".repeat(1_000), true);
    const write = toolBatch(session, "write", "side effects".repeat(1_000));
    const foreign = toolBatch(session, "read", "must stay hidden".repeat(1_000));
    session.appendContextEdit(foreign.result, { content: "Foreign redacted replacement".repeat(300) });
    const recent = toolBatch(session, "read", "recent".repeat(1_000));
    tail(session, 3);
    const original = structuredClone(session.getEntry(old.result));
    const plan = planContextTrim(session.getBranch());
    expect(plan.references).toEqual([old.result]);
    expect(plan.savedChars).toBeGreaterThan(10_000);
    apply(session, plan.entries);
    expect(session.getEntry(old.result)).toEqual(original);
    const context = buildSessionProjection(session.getBranch());
    expect(JSON.stringify(context.messages)).toContain("smart_context action=read id=" + old.result);
    for (const item of [failed, write, foreign, recent]) expect(ids(session)).toContain(item.result);
    expect(readContextReference(session.getBranch(), session.getSessionId(), old.result)).toBe("evidence".repeat(2_000));
    expect(() => readContextReference(session.getBranch(), session.getSessionId(), foreign.result)).toThrow("No archived reference");
    expect(planContextTrim(session.getBranch()).entries).toHaveLength(0);
  });

  it("digests archived output into a bounded, deterministic marker", () => {
    const lines = Array.from({ length: 20 }, (_, i) => i === 12 ? "  Error:\tcannot open\u0007  config  " : `line ${i}`);
    const input = { toolName: "bash", entryId: "e1", text: lines.join("\n"), call: { name: "bash", arguments: { command: "bun test\n--watch" } } };
    const marker = buildTrimMarker(input);
    expect(marker).toBe([
      `[Archived bash output, ${input.text.length} chars. Retrieve with smart_context action=read id=e1.]`,
      "$ bun test", "> line 0", "! Error: cannot open config",
    ].join("\n"));
    expect(buildTrimMarker(structuredClone(input))).toBe(marker);
    const long = buildTrimMarker({
      toolName: "read", entryId: "e2", call: { name: "read", arguments: { path: "src/" + "p".repeat(200) } },
      text: Array.from({ length: 20 }, (_, i) => `warning ${i} ` + "x".repeat(200)).join("\n"),
    });
    expect(long.length).toBeLessThanOrEqual(TRIM_MARKER_MAX_CHARS);
    expect(long.split("\n").length).toBeLessThanOrEqual(TRIM_MARKER_MAX_LINES);
    expect(long.split("\n")[1]).toStartWith("path: src/ppp");
    const many = buildTrimMarker({
      toolName: "bash", entryId: "e3", call: { name: "bash", arguments: { command: "make" } },
      text: ["start", ...Array.from({ length: 10 }, (_, i) => `FAILED case ${i}`)].join("\n"),
    }).split("\n");
    expect(many).toHaveLength(TRIM_MARKER_MAX_LINES);
    expect(many.slice(3)).toEqual(["! FAILED case 0", "! FAILED case 1", "! FAILED case 2"]);
  });

  it("archives old bash output but keeps the call, error results and mixed side-effect turns", () => {
    const session = manager();
    const output = "ok\n".repeat(2_000) + "warning: deprecated flag\n";
    const bash = toolBatch(session, "functions.bash", output, false, { command: "bun run build" });
    const failed = toolBatch(session, "bash", "boom\n".repeat(1_000), true, { command: "false" });
    session.appendMessage(assistant([
      { type: "toolCall", id: "mb", name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: "mw", name: "write", arguments: { path: "a", content: "x" } },
    ], "toolUse"));
    const mixed = [["mb", "bash"], ["mw", "write"]].map(([id, name]) => session.appendMessage({
      role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "listing\n".repeat(1_000) }], isError: false, timestamp: 1
    }));
    tail(session);
    const plan = planContextTrim(session.getBranch());
    expect(plan.references).toEqual([bash.result]);
    apply(session, plan.entries);
    const projected = buildSessionProjection(session.getBranch()).entries;
    const message = (id: string) => projected.find(entry => entry.sourceEntry.id === id)!.messages[0];
    const stored = (id: string) => { const entry = session.getEntry(id); if (entry?.type !== "message") throw new Error(id); return entry.message; };
    expect(message(bash.call)).toEqual(stored(bash.call));
    const archived = (message(bash.result) as ToolResultMessage).content[0] as { text: string };
    expect(archived.text.split("\n")).toEqual([
      `[Archived functions.bash output, ${output.length} chars. Retrieve with smart_context action=read id=${bash.result}.]`,
      "$ bun run build", "> ok", "! warning: deprecated flag",
    ]);
    for (const id of [failed.result, ...mixed]) expect(message(id)).toEqual(stored(id));
    expect(readContextReference(session.getBranch(), session.getSessionId(), bash.result)).toBe(output);
  });

  it("archives old smart_context read pages against the original id, never other actions", () => {
    const session = manager();
    const evidence = "SOURCE_EVIDENCE".repeat(1_000);
    const source = toolBatch(session, "read", evidence, false, { path: "src/a.ts" });
    tail(session);
    apply(session, planContextTrim(session.getBranch()).entries);
    const page = toolBatch(session, "smart_context", evidence, false, { action: "read", id: source.result });
    const status = toolBatch(session, "smart_context", "status ".repeat(1_000), false, { action: "status" });
    tail(session);
    const plan = planContextTrim(session.getBranch());
    expect(plan.references).toEqual([page.result]);
    const edit = plan.entries[0] as Extract<SessionBoundaryDraft, { type: "context_edit" }>;
    expect(String(edit.replacement!.content).split("\n")[0]).toBe(
      `[Archived smart_context read of id=${source.result}, ${evidence.length} chars. Retrieve with smart_context action=read id=${source.result}.]`);
    apply(session, plan.entries);
    expect(inspectContext(session.getBranch(), session.getSessionId()).references.has(page.result)).toBe(true);
    expect(readContextReference(session.getBranch(), session.getSessionId(), source.result)).toBe(evidence);
    expect(JSON.stringify(buildSessionProjection(session.getBranch()).messages)).toContain("status ".repeat(1_000));
    expect(ids(session)).toContain(status.result);
  });

  it("protects instruction sources through trim and rewind, including aliases and Windows paths", () => {
    const session = manager();
    const cp = checkpoint(session);
    const inputs: ToolCall["arguments"][] = [
      { path: "/repo/AGENTS.md" }, { filePath: "C:\\repo\\SKILL.md" },
      { file_path: "skills/test/reference.md" }, { absolute_path: ".github/copilot-instructions.md" },
    ];
    const protectedResults = inputs.map(args => toolBatch(session, "functions.read", "REQUIRED_INSTRUCTIONS".repeat(500), false, args));
    tail(session);
    expect(planContextTrim(session.getBranch()).references).toHaveLength(0);
    apply(session, planContextRewind(session.getBranch(), session.getSessionId(), cp, "Keep required instructions.").entries);
    for (const item of protectedResults) {
      expect(ids(session)).toContain(item.call);
      expect(ids(session)).toContain(item.result);
    }
    expect(() => planContextTrim(session.getBranch(), "wrong-branch")).toThrow("boundary");
  });

  it("rewinds research while preserving errors, mutations, commands, unknown tools and tool pairs", () => {
    const session = manager();
    const cp = checkpoint(session);
    const read = toolBatch(session, "read", "RESEARCH_DETAIL", false, { path: "src/a.ts" });
    const failure = toolBatch(session, "read", "ENOENT", true);
    const edit = toolBatch(session, "edit", "Changed src/a.ts", false, { path: "src/a.ts", newText: "new" });
    const bash = toolBatch(session, "bash", "Tests pass", false, { command: "bun test" });
    const unknown = toolBatch(session, "custom_mutating_search", "external side effect", false, { query: "x" });
    session.appendMessage(assistant([{ type: "text", text: "Temporary analysis" }]));
    const plan = planContextRewind(session.getBranch(), session.getSessionId(), cp, "Use option B. Keep constraint X. Next: implement.");
    apply(session, plan.entries);
    expect(ids(session)).not.toContain(read.call);
    expect(ids(session)).not.toContain(read.result);
    for (const pair of [failure, edit, bash, unknown]) {
      expect(ids(session)).toContain(pair.call);
      expect(ids(session)).toContain(pair.result);
    }
    const text = JSON.stringify(buildSessionProjection(session.getBranch()).messages);
    expect(text).toContain("Keep user constraints exactly");
    expect(text).toContain("Use option B");
    expect(text).toContain("NOT reverted");
    expect(text).not.toContain("Temporary analysis");
    expect(inspectContext(session.getBranch(), session.getSessionId()).checkpoint).toBeNull();
    expect(readContextReference(session.getBranch(), session.getSessionId(), read.result)).toBe("RESEARCH_DETAIL");
  });

  it("preserves every sibling when one call fails or mutates, including nested parallel tools", () => {
    const session = manager();
    const cp = checkpoint(session);
    const call = session.appendMessage(assistant([
      { type: "toolCall", id: "r", name: "read", arguments: {} },
      { type: "toolCall", id: "w", name: "write", arguments: {} },
    ], "toolUse"));
    for (const [id, name] of [["r", "read"], ["w", "write"]]) session.appendMessage({
      role: "toolResult", toolCallId: id, toolName: name,
      content: [{ type: "text", text: "result" }], isError: false, timestamp: 1
    });
    const nested = toolBatch(session, "multi_tool_use.parallel", "nested result", false, {
      tool_uses: [
        { recipient_name: "functions.read", parameters: { path: "a" } },
        { recipient_name: "functions.edit", parameters: { path: "b", newText: "value" } },
      ]
    });
    apply(session, planContextRewind(session.getBranch(), session.getSessionId(), cp, "Findings preserved.").entries);
    expect(ids(session)).toContain(call);
    expect(ids(session)).toContain(nested.call);
    expect(ids(session)).toContain(nested.result);
  });

  it("retains interrupted, incomplete, image-bearing, and failed sibling exchanges", () => {
    const session = manager();
    const cp = checkpoint(session);
    const interrupted = session.appendMessage(assistant([{ type: "text", text: "Stopped analysis" }], "aborted"));
    const incomplete = session.appendMessage(assistant([{ type: "toolCall", id: "unfinished", name: "read", arguments: {} }], "toolUse"));
    const mediaCall = session.appendMessage(assistant([{ type: "toolCall", id: "media", name: "read", arguments: {} }], "toolUse"));
    const mediaResult = session.appendMessage({
      role: "toolResult", toolCallId: "media", toolName: "read", isError: false,
      content: [{ type: "image", data: "eA==", mimeType: "image/png" }], timestamp: 1
    });
    const mixedCall = session.appendMessage(assistant([
      { type: "toolCall", id: "good-read", name: "read", arguments: {} },
      { type: "toolCall", id: "failed-read", name: "read", arguments: {} },
    ], "toolUse"));
    const mixedResults = [false, true].map((isError, index) => session.appendMessage({
      role: "toolResult", toolCallId: index ? "failed-read" : "good-read",
      toolName: "read", isError, content: [{ type: "text", text: index ? "Failure" : "Success" }], timestamp: 1
    }));
    apply(session, planContextRewind(session.getBranch(), session.getSessionId(), cp, "Retain these unresolved cases.").entries);
    for (const id of [interrupted, incomplete, mediaCall, mediaResult, mixedCall, ...mixedResults]) expect(ids(session)).toContain(id);
  });

  it("fails closed on malformed checkpoint metadata and replaces a valid checkpoint explicitly", () => {
    const session = manager();
    checkpoint(session, "old");
    checkpoint(session, "new");
    expect(inspectContext(session.getBranch(), session.getSessionId()).checkpoint?.id).toBe("new");
    session.appendCustomEntry(CONTEXT_CONTROL_TYPE, { version: 1, action: "checkpoint", checkpoint: { id: "bad" } });
    expect(inspectContext(session.getBranch(), session.getSessionId()).checkpoint).toBeNull();
    expect(() => planContextRewind(session.getBranch(), session.getSessionId(), "new", "report")).toThrow("metadata");
  });

  it.each(["user", "compaction", "branch-summary", "prefix-edit", "different-session"])("invalidates checkpoint on %s without deleting history", kind => {
    const session = manager();
    const prefixId = session.getLeafId()!;
    const cp = checkpoint(session);
    toolBatch(session, "read", "research");
    if (kind === "user") session.appendMessage({ role: "user", content: "New requirement", timestamp: 1 });
    if (kind === "compaction") session.appendCompaction("New summary", prefixId, 1000);
    if (kind === "branch-summary") session.branchWithSummary(session.getLeafId(), "Changed branch");
    if (kind === "prefix-edit") session.appendContextEdit(prefixId, { content: "Changed goal" });
    const sessionId = kind === "different-session" ? "other" : session.getSessionId();
    const before = session.getBranch();
    expect(() => planContextRewind(before, sessionId, cp, "report")).toThrow();
    expect(session.getBranch()).toEqual(before);
  });

  it("keeps a checkpoint valid when trimming only research after it", () => {
    const session = manager();
    const earlier = toolBatch(session, "read", "earlier".repeat(1_000));
    checkpoint(session);
    const cp = inspectContext(session.getBranch(), session.getSessionId()).checkpoint!;
    const later = toolBatch(session, "read", "later".repeat(2_000));
    tail(session);
    const plan = planContextTrim(session.getBranch(), cp.originId);
    expect(plan.references).toEqual([later.result]);
    apply(session, plan.entries);
    expect(inspectContext(session.getBranch(), session.getSessionId()).checkpoint?.id).toBe(cp.id);
    expect(JSON.stringify(buildSessionProjection(session.getBranch()).messages)).toContain("earlier".repeat(1_000));
    expect(ids(session)).toContain(earlier.result);
  });

  it("revokes raw recovery after a foreign edit and does not re-authorize it through rewind", () => {
    const session = manager();
    const cp = checkpoint(session);
    const read = toolBatch(session, "read", "SECRET_RAW".repeat(1_000));
    tail(session);
    apply(session, planContextTrim(session.getBranch()).entries);
    session.appendContextEdit(read.result, { content: "Must remain redacted" });
    expect(() => readContextReference(session.getBranch(), session.getSessionId(), read.result)).toThrow();
    apply(session, planContextRewind(session.getBranch(), session.getSessionId(), cp, "Use redacted findings only.").entries);
    expect(() => readContextReference(session.getBranch(), session.getSessionId(), read.result)).toThrow();
  });

  it("restores checkpoint/reference metadata on reload and scopes references to the branch", () => {
    const session = manager();
    const root = session.getLeafId()!;
    checkpoint(session);
    const read = toolBatch(session, "read", "recoverable".repeat(1_000));
    tail(session);
    apply(session, planContextTrim(session.getBranch()).entries);
    const reloaded = SessionManager.inMemory(process.cwd(), undefined, [session.getHeader()!, ...session.getBranch()]);
    expect(inspectContext(reloaded.getBranch(), reloaded.getSessionId()).checkpoint?.id).toBe("checkpoint-1");
    expect(readContextReference(reloaded.getBranch(), reloaded.getSessionId(), read.result)).toContain("recoverable");
    reloaded.appendCompaction("summary", read.call, 5000);
    expect(inspectContext(reloaded.getBranch(), reloaded.getSessionId()).checkpoint).toBeNull();
    expect(readContextReference(reloaded.getBranch(), reloaded.getSessionId(), read.result)).toContain("recoverable");
    reloaded.branch(root);
    expect(() => readContextReference(reloaded.getBranch(), reloaded.getSessionId(), read.result)).toThrow();
  });

  it("rejects oversized rewinds atomically", () => {
    const session = manager();
    const cp = checkpoint(session);
    tail(session, MAX_CONTEXT_EDITS + 1);
    const before = session.getBranch();
    expect(() => planContextRewind(before, session.getSessionId(), cp, "report")).toThrow("edit limit");
    expect(session.getBranch()).toEqual(before);
  });
});

/** Simulates a hand-edited session file: the same branch reloaded with one toolResult's text replaced. */
function tampered(session: SessionManager, id: string, text: string) {
  return SessionManager.inMemory(process.cwd(), undefined, [session.getHeader()!, ...session.getBranch().map(entry =>
    entry.id === id && entry.type === "message" && entry.message.role === "toolResult"
      ? { ...entry, message: { ...entry.message, content: [{ type: "text" as const, text }] } } : entry)]);
}

describe("archive integrity", () => {
  it("records a deterministic SHA-256 and length for every trimmed output", () => {
    const session = manager();
    const first = toolBatch(session, "read", "alpha evidence".repeat(400));
    const second = toolBatch(session, "read", "beta evidence".repeat(500));
    tail(session);
    const plan = planContextTrim(session.getBranch());
    const control = plan.entries.at(-1);
    expect(control?.type === "custom" ? control.data : undefined).toEqual({
      version: 1, action: "trim", references: [first.result, second.result],
      archives: [archiveOf(first.result, "alpha evidence".repeat(400)), archiveOf(second.result, "beta evidence".repeat(500))],
    });
    expect(JSON.stringify(planContextTrim(session.getBranch()).entries)).toBe(JSON.stringify(plan.entries));
  });

  it("refuses archived text that no longer matches its record, including in search", async () => {
    const session = manager();
    const original = "archived detail".repeat(400);
    const read = toolBatch(session, "read", original);
    tail(session);
    apply(session, planContextTrim(session.getBranch()).entries);
    expect(readContextReference(session.getBranch(), session.getSessionId(), read.result)).toBe(original);
    const edited = tampered(session, read.result, original + " injected");
    expect(() => readContextReference(edited.getBranch(), edited.getSessionId(), read.result))
      .toThrow(`Archived text for ${read.result} no longer matches the record made when it was archived (6000 chars then, 6009 chars now); the session file may have been edited. Nothing was changed.`);
    const evidence = contextEvidence(edited.getBranch(), edited.getSessionId(), new SecretScrubber());
    expect(evidence.list).toEqual([expect.objectContaining({ id: read.result, hashed: true })]);
    const result = await evidence.search("archived", 0, 5);
    expect(result.matches).toEqual([]);
    expect(result.unavailable).toEqual([read.result]);
  });

  it("reads legacy records without a hash exactly as before", () => {
    const session = manager();
    const read = toolBatch(session, "read", "legacy output".repeat(400));
    session.appendCustomEntry(CONTEXT_CONTROL_TYPE, { version: 1, action: "trim", references: [read.result] });
    const edited = tampered(session, read.result, "changed later");
    expect(readContextReference(edited.getBranch(), edited.getSessionId(), read.result)).toBe("changed later");
    expect(contextEvidence(edited.getBranch(), edited.getSessionId(), new SecretScrubber()).list)
      .toEqual([expect.objectContaining({ id: read.result, hashed: false })]);
  });

  it.each([
    ["short hash", { sha256: "abc", chars: 1 }],
    ["negative length", { sha256: "a".repeat(64), chars: -1 }],
    ["missing id", { id: undefined, sha256: "a".repeat(64), chars: 1 }],
  ])("treats a control entry with a malformed archive (%s) as corrupt", (_kind, archive) => {
    const session = manager();
    const read = toolBatch(session, "read", "guarded output".repeat(400));
    session.appendCustomEntry(CONTEXT_CONTROL_TYPE, { version: 1, action: "trim", references: [read.result], archives: [{ id: read.result, ...archive }] });
    expect(inspectContext(session.getBranch(), session.getSessionId()).references.has(read.result)).toBe(false);
    expect(() => readContextReference(session.getBranch(), session.getSessionId(), read.result)).toThrow("No archived reference");
  });

  it("rewinds past a mismatched archive but withholds it from recovery", () => {
    const session = manager();
    const cp = checkpoint(session);
    const changed = toolBatch(session, "read", "first finding".repeat(400));
    const intact = toolBatch(session, "read", "second finding".repeat(400));
    tail(session);
    apply(session, planContextTrim(session.getBranch()).entries);
    const edited = tampered(session, changed.result, "rewritten");
    const plan = planContextRewind(edited.getBranch(), edited.getSessionId(), cp, "Findings recorded.");
    const report = plan.entries.find(entry => entry.type === "custom_message");
    expect(report?.type === "custom_message" ? report.content : "").toContain(
      "Original outputs remain available via smart_context status/read. 1 archived outputs no longer match their records and are not offered for recovery.");
    const control = plan.entries.at(-1);
    expect(control?.type === "custom" ? control.data : undefined).toEqual({
      version: 1, action: "rewind", references: [intact.result], archives: [archiveOf(intact.result, "second finding".repeat(400))],
    });
    apply(edited, plan.entries);
    expect(ids(edited)).not.toContain(changed.result);
    expect(readContextReference(edited.getBranch(), edited.getSessionId(), intact.result)).toBe("second finding".repeat(400));
    // The rewind's own removal edit revokes the old authorization; only its references re-authorize.
    expect(() => readContextReference(edited.getBranch(), edited.getSessionId(), changed.result)).toThrow("No archived reference");
  });
});

describe("smart_context boundary lifecycle", () => {
  it("keeps reads/plans available but blocks manual and automatic context changes during a pivot", async () => {
    const h = harness({ background: true });
    toolBatch(h.session, "read", "old evidence".repeat(3000));
    tail(h.session);
    const batch = await h.execute({ action: "trim" });
    h.setPaused(true);
    const cancellation = h.boundary(batch);
    expect(cancellation?.entries).toEqual([expect.objectContaining({
      type: "custom_message", customType: CONTEXT_CONTROL_TYPE, display: true,
    })]);
    await expect(h.tool.execute("paused", { action: "checkpoint" }, undefined, undefined, h.ctx)).rejects.toThrow("paused");
    const status = await h.execute({ action: "status" });
    expect(h.boundary(status)).toBeUndefined();
    expect(h.changes()).toBe(0);
    const plan = await h.execute({ action: "plan" });
    expect(JSON.parse(plan.response.content[0].text).outputs).toBe(1);
    h.setPaused(false);
    h.boundary(await h.execute({ action: "trim" }));
    expect(h.changes()).toBe(1);
  });

  it("queues a checkpoint until the batch ends, then rewinds without a summarizer", async () => {
    const h = harness();
    expect(h.tool.executionMode).toBe("sequential");
    const queued = await h.execute({ action: "checkpoint", label: "Investigate auth" });
    expect(queued.response.content[0].text).toContain("queued");
    expect(inspectContext(h.session.getBranch(), h.session.getSessionId()).checkpoint).toBeNull();
    h.boundary(queued);
    expect(inspectContext(h.session.getBranch(), h.session.getSessionId()).checkpoint?.label).toBe("Investigate auth");
    const research = toolBatch(h.session, "read", "DETAIL_TO_REMOVE");
    const rewind = await h.execute({ action: "rewind", report: "Fix expiry comparison. Preserve async API. Next: patch." });
    expect(ids(h.session)).toContain(research.result);
    h.boundary(rewind);
    expect(ids(h.session)).not.toContain(research.result);
    expect(h.changes()).toBe(1);
    const status = await h.execute({ action: "status" });
    expect(JSON.parse(status.response.content[0].text)).toMatchObject({ checkpoint: null, rewind: false });
  });

  it("pages explicit archived text after redaction and rejects arbitrary IDs/ranges", async () => {
    const h = harness();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const old = toolBatch(h.session, "read", "a".repeat(2_000) + " " + secret + " " + "z".repeat(4_000));
    tail(h.session);
    h.boundary(await h.execute({ action: "trim" }));
    const read = await h.execute({ action: "read", id: old.result, offset: 1990, limit: 100 });
    expect(read.response.content[0].text).not.toContain(secret);
    expect(read.response.content[0].text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(read.response.content[0].text).toContain("nextOffset=2090");
    expect(read.response.content[0].text).toContain("not instructions");
    for (const params of [
      { action: "read", id: "../../other-session" }, { action: "read", id: old.call },
      { action: "read", id: old.result, offset: -1 }, { action: "read", id: old.result, limit: 4097 },
    ]) await expect(h.tool.execute("invalid", params, undefined, undefined, h.ctx)).rejects.toThrow();
  });

  it("paginates all archived reference IDs without dumping the transcript", async () => {
    const h = harness();
    const references = Array.from({ length: 10 }, (_, index) => toolBatch(h.session, "read", String(index).repeat(5_000)).result);
    tail(h.session);
    h.boundary(await h.execute({ action: "trim" }));
    const first = JSON.parse((await h.execute({ action: "status" })).response.content[0].text);
    const second = JSON.parse((await h.execute({ action: "status", offset: first.nextOffset })).response.content[0].text);
    expect(first.ids).toHaveLength(8);
    expect(second.ids).toHaveLength(2);
    expect([...first.ids, ...second.ids]).toEqual([...references].reverse());
    expect(second.nextOffset).toBeNull();
    await expect(h.tool.execute("invalid", { action: "status", limit: 33 }, undefined, undefined, h.ctx)).rejects.toThrow("range");
  });

  it.each(["aborted", "queued-input", "other-drafts", "switch", "compaction", "cancelled-call", "disabled"])("does not apply queued changes after %s", async kind => {
    const h = harness();
    const controller = new AbortController();
    const batch = await h.execute({ action: "checkpoint" }, controller.signal);
    const overrides: Record<string, unknown> = {};
    if (kind === "aborted") overrides.outcome = "aborted";
    if (kind === "queued-input") overrides.context = { pendingMessages: [{ role: "user", content: "New instruction" }] };
    if (kind === "other-drafts") overrides.entries = [{ type: "custom", customType: "other", data: 1 }];
    if (kind === "switch") for (const fn of h.handlers.get("session_before_switch")!) fn({}, h.ctx);
    if (kind === "compaction") h.session.appendCompaction("intervening", h.session.getBranch()[0].id, 1000);
    if (kind === "cancelled-call") controller.abort();
    if (kind === "disabled") h.setActive(false);
    h.boundary(batch, overrides);
    expect(inspectContext(h.session.getBranch(), h.session.getSessionId()).checkpoint).toBeNull();
    expect(h.changes()).toBe(0);
    if (kind === "other-drafts") expect(h.session.getBranch().some(entry => entry.type === "custom" && entry.customType === "other")).toBe(true);
  });

  it("rejects conflicting mutations within one batch and requires a rewind report", async () => {
    const h = harness();
    await h.execute({ action: "checkpoint" });
    await expect(h.tool.execute("second", { action: "trim" }, undefined, undefined, h.ctx)).rejects.toThrow("already queued");
    for (const fn of h.handlers.get("session_start")!) fn({}, h.ctx);
    checkpoint(h.session);
    await expect(h.tool.execute("empty", { action: "rewind", report: "  " }, undefined, undefined, h.ctx)).rejects.toThrow("non-empty");
  });

  it("previews without queuing changes, and batches independent hygiene across reloads", async () => {
    const h = harness();
    h.cfg.autoTrigger = false;
    h.cfg.contextHygieneEnabled = true;
    const first = toolBatch(h.session, "read", "evidence".repeat(3_000));
    tail(h.session);
    const before = structuredClone(h.session.getBranch());
    const preview = await h.tool.execute("preview", { action: "plan" }, undefined, undefined, h.ctx);
    expect(JSON.parse(preview.content[0].text)).toMatchObject({ outputs: 1, batch: "ready" });
    expect(h.session.getBranch()).toEqual(before);
    h.boundary(await h.execute({ action: "status" }));
    expect(readContextReference(h.session.getBranch(), h.session.getSessionId(), first.result)).toContain("evidence");
    const second = toolBatch(h.session, "read", "more evidence".repeat(2_000));
    tail(h.session);
    const reload = harness({ background: true, session: SessionManager.inMemory(process.cwd(), undefined, [h.session.getHeader()!, ...h.session.getBranch()]) });
    const plan = JSON.parse((await reload.execute({ action: "plan" })).response.content[0].text);
    expect(plan.batch).toBe("cooldown");
    reload.boundary(await reload.execute({ action: "status" }));
    expect(inspectContext(reload.session.getBranch(), reload.session.getSessionId()).references.has(second.result)).toBe(false);
    tail(reload.session, 3);
    reload.boundary(await reload.execute({ action: "status" }));
    expect(inspectContext(reload.session.getBranch(), reload.session.getSessionId()).references.has(second.result)).toBe(true);
    expect(reload.session.getBranch().filter(entry => entry.type === "custom_message")).toHaveLength(0);
  });

  it("gates automatic hygiene by the maxContextTokens-capped window", async () => {
    const h = harness();
    h.cfg.autoTrigger = false;
    h.cfg.contextHygieneEnabled = true;
    h.ctx.model = { contextWindow: 1_000_000 } as ExtensionContext["model"]; // 140k tokens: below the uncapped 1M start gate
    toolBatch(h.session, "read", "evidence".repeat(3_000));
    tail(h.session);
    h.boundary(await h.execute({ action: "status" }));
    expect(h.changes()).toBe(0);
    h.cfg.maxContextTokens = 200_000; // start gate 140k of the 200k cap
    h.boundary(await h.execute({ action: "status" }));
    expect(h.changes()).toBe(1);
  });

  it("defers small automatic batches but still honors an explicit trim", async () => {
    const h = harness({ background: true });
    const old = toolBatch(h.session, "read", "small evidence".repeat(500));
    tail(h.session);
    expect(planContextTrim(h.session.getBranch()).automatic).toBe("insufficient-savings");
    h.boundary(await h.execute({ action: "status" }));
    expect(h.changes()).toBe(0);
    h.boundary(await h.execute({ action: "trim" }));
    expect(h.changes()).toBe(1);
    expect(readContextReference(h.session.getBranch(), h.session.getSessionId(), old.result)).toContain("small evidence");
  });

  it("reports a trim as a committed context edit only once the host appended it", async () => {
    const h = harness();
    toolBatch(h.session, "read", "old evidence".repeat(3000));
    tail(h.session);
    // A later turn_end handler replaced the drafts: staged, never committed.
    h.boundary(await h.execute({ action: "trim" }), {}, false);
    expect(h.changes()).toBe(1);
    h.nextRequest();
    expect(h.edits()).toEqual([]);
    h.boundary(await h.execute({ action: "trim" }));
    expect(h.edits()).toEqual([]);
    h.nextRequest();
    h.nextRequest();
    expect(h.edits()).toEqual(["trim"]);
  });

  it.each([
    ["enabled", true], ["native-hook", false], ["below-threshold", false], ["hidden", true], ["busy", false],
  ] as const)("automatic hygiene is independent of agent exposure and respects %s", async (kind, shouldTrim) => {
    const h = harness({ background: kind !== "native-hook", canTrim: kind !== "busy" });
    const old = toolBatch(h.session, "read", "old research".repeat(2_000));
    tail(h.session);
    if (kind === "below-threshold") h.setTokens(100_000);
    if (kind === "hidden") h.setActive(false);
    // An ordinary completed turn, not a smart_context request.
    const result = { role: "toolResult" as const, toolCallId: "unrelated", toolName: "read", content: [], isError: false, timestamp: 1 };
    h.boundary({ response: {}, message: assistant(), messageEntryId: h.session.getLeafId()!, toolResults: [result], toolResultEntryIds: [] } as any);
    expect(inspectContext(h.session.getBranch(), h.session.getSessionId()).references.has(old.result)).toBe(shouldTrim);
    expect(h.changes()).toBe(shouldTrim ? 1 : 0);
    const control = h.session.getBranch().find(entry => entry.type === "custom" && entry.customType === CONTEXT_CONTROL_TYPE);
    expect(control?.type === "custom" ? control.data : undefined).toEqual(shouldTrim
      ? { version: 1, action: "trim", references: [old.result], archives: [archiveOf(old.result, "old research".repeat(2_000))], cause: "pressure" } : undefined);
  });
});

function anchorBatch(manager: SessionManager, name: string) {
  const call = manager.appendMessage(assistant([
    { type: "toolCall", id: "anchor-" + name, name: "context", arguments: { action: "anchor", name, summary: "Anchor " + name } },
  ], "toolUse"));
  const result = manager.appendMessage({
    role: "toolResult", toolCallId: "anchor-" + name, toolName: "context",
    content: [{ type: "text", text: `[Anchor: ${name}]\nsummary` }],
    details: { anchor: { name, targetId: call, summary: "Anchor " + name } }, isError: false, timestamp: 1,
  });
  return { call, result };
}

describe("toolkit anchor coexistence", () => {
  it("trims only research after the active Toolkit anchor and keeps the anchor pair raw", () => {
    const session = manager();
    const preAnchor = toolBatch(session, "read", "anchor-prefix-evidence".repeat(600));
    const anchor = anchorBatch(session, "research-done");
    const postAnchor = toolBatch(session, "read", "post-anchor-evidence".repeat(600));
    tail(session);
    expect(lastAnchorBoundary(session.getBranch())).toBe(anchor.result);
    const plan = planContextTrim(session.getBranch());
    expect(plan.references).toEqual([postAnchor.result]);
    apply(session, plan.entries);
    const delivered = JSON.stringify(buildSessionProjection(session.getBranch()).messages);
    expect(delivered).toContain("anchor-prefix-evidence");
    expect(delivered).toContain("[Anchor: research-done]");
    for (const id of [anchor.call, anchor.result]) expect(ids(session)).toContain(id);
    expect(readContextReference(session.getBranch(), session.getSessionId(), postAnchor.result)).toContain("post-anchor-evidence");
  });

  it("protects through the later of checkpoint and anchor boundaries", () => {
    const session = manager();
    toolBatch(session, "read", "before-checkpoint".repeat(600));
    checkpoint(session);
    const between = toolBatch(session, "read", "between-checkpoint-and-anchor".repeat(600));
    anchorBatch(session, "milestone");
    const late = toolBatch(session, "read", "after-anchor".repeat(600));
    tail(session);
    const originId = inspectContext(session.getBranch(), session.getSessionId()).checkpoint!.originId;
    const plan = planContextTrim(session.getBranch(), originId);
    expect(plan.references).toEqual([late.result]);
    expect(plan.references).not.toContain(between.result);
  });

  it("ignores context tool results that carry no anchor metadata", () => {
    const session = manager();
    const plain = toolBatch(session, "context", "view output".repeat(600), false, { action: "view" });
    const later = toolBatch(session, "read", "ordinary research".repeat(600));
    tail(session);
    expect(lastAnchorBoundary(session.getBranch())).toBeUndefined();
    expect(planContextTrim(session.getBranch()).references).toEqual([later.result]);
    expect(JSON.stringify(buildSessionProjection(session.getBranch()).messages)).toContain("view output");
  });

  it("keeps the anchor and its prefix when rewinding research across it", () => {
    const session = manager();
    checkpoint(session);
    const research = toolBatch(session, "read", "RESEARCH_DETAIL".repeat(600));
    const anchor = anchorBatch(session, "mid-research");
    const more = toolBatch(session, "read", "MORE_RESEARCH".repeat(600));
    const rewind = planContextRewind(session.getBranch(), session.getSessionId(), "checkpoint-1", "Report keeps findings.");
    apply(session, rewind.entries);
    for (const id of [anchor.call, anchor.result]) expect(ids(session)).toContain(id);
    expect(ids(session)).not.toContain(research.result);
    expect(ids(session)).not.toContain(more.result);
    expect(JSON.stringify(buildSessionProjection(session.getBranch()).messages)).toContain("[Anchor: mid-research]");
  });
});

describe("superseded outputs", () => {
  const edit = (session: SessionManager, path: string) => toolBatch(session, "edit", "ok", false, { path, oldText: "a", newText: "b" });
  const markerOf = (plan: ReturnType<typeof planContextTrim>, index: number) =>
    String((plan.entries[index] as Extract<SessionBoundaryDraft, { type: "context_edit" }>).replacement!.content);

  it("archives outputs of files edited or read again later first, with a marker note", () => {
    const session = manager();
    const reads = Array.from({ length: 40 }, (_, i) => toolBatch(session, "read", `file ${i + 1}\n` + "x".repeat(5_000), false, { path: `src/f${i + 1}.ts` }));
    toolBatch(session, "read", "short", false, { path: "src/f35.ts" });
    edit(session, "src/f37.ts");
    edit(session, "src/f38.ts");
    toolBatch(session, "write", "ok", false, { path: "src/f39.ts", content: "" });
    tail(session);
    toolBatch(session, "write", "ok", false, { path: "src/f40.ts", content: "" }); // inside the protected recent tail
    const plan = planContextTrim(session.getBranch());
    const chosen = [37, 38, 39, 40, 35, ...Array.from({ length: 27 }, (_, i) => i + 1)];
    expect(plan.references).toHaveLength(32);
    expect(plan.references).toEqual(chosen.map(n => reads[n - 1].result));
    expect(plan.superseded).toBe(5);
    expect(markerOf(plan, 0).split("\n")[1]).toBe("path: src/f37.ts (superseded: edited later)");
    expect(markerOf(plan, 4).split("\n")[1]).toBe("path: src/f35.ts (superseded: read again in full later)");
    expect(markerOf(plan, 5).split("\n")[1]).toBe("path: src/f1.ts");
    const markers = plan.references.map((_, index) => markerOf(plan, index).length);
    expect(plan.savedChars).toBe(chosen.reduce((sum, n, index) => sum + `file ${n}\n`.length + 5_000 - markers[index], 0));
    expect(JSON.stringify(planContextTrim(session.getBranch()))).toBe(JSON.stringify(plan));
  });

  it("never matches relative against absolute paths", () => {
    const session = manager();
    const [a, b, c] = ["a", "b", "c"].map(name => toolBatch(session, "read", name.repeat(5_000), false, { path: `src/${name}.ts` }));
    edit(session, `${process.cwd()}/src/a.ts`);
    edit(session, "src/c.ts");
    tail(session);
    const plan = planContextTrim(session.getBranch());
    expect(plan.references).toEqual([c.result, a.result, b.result]);
    expect(markerOf(plan, 1)).not.toContain("superseded");
  });

  it("counts only a later full plain read as reading again", () => {
    const session = manager();
    const batch = (name: string, args: ToolCall["arguments"], size = 5_000) => toolBatch(session, name, "o".repeat(size), false, args);
    const control = batch("read", { path: "src/z.ts" });
    const dir = batch("grep", { pattern: "x", path: "src/dir" });
    const symbol = batch("read_symbol", { path: "src/s.ts", symbol: "A" });
    const grepped = batch("grep", { pattern: "x", path: "src/g.ts" });
    const ranged = batch("read", { path: "src/o.ts" });
    batch("ls", { path: "src/dir" }, 10);
    batch("read_symbol", { path: "src/s.ts", symbol: "B" }, 10);
    batch("read", { path: "src/g.ts" }, 10);
    batch("read", { path: "src/o.ts", offset: 10 }, 10);
    tail(session);
    const plan = planContextTrim(session.getBranch());
    expect(plan.references).toEqual([grepped.result, control.result, dir.result, symbol.result, ranged.result]);
    expect(plan.superseded).toBe(1);
    expect(markerOf(plan, 0).split("\n")[1]).toBe("pattern: x (superseded: read again in full later)");
  });

  it("keeps superseded outputs in the anchor prefix and the recent tail", () => {
    const session = manager();
    const prefix = toolBatch(session, "read", "p".repeat(5_000), false, { path: "src/p.ts" });
    anchorBatch(session, "milestone");
    const post = toolBatch(session, "read", "q".repeat(5_000), false, { path: "src/q.ts" });
    const recent = toolBatch(session, "read", "r".repeat(5_000), false, { path: "src/r.ts" });
    edit(session, "src/r.ts");
    edit(session, "src/p.ts");
    session.appendMessage(assistant([{ type: "text", text: "done" }]));
    const plan = planContextTrim(session.getBranch());
    expect(plan.references).toEqual([post.result]);
    expect(plan.references).not.toContain(prefix.result);
    expect(plan.references).not.toContain(recent.result);
  });
});

describe("agent mutation policy", () => {
  it("blocks agent-requested mutations while status, plan and read stay available", async () => {
    const h = harness({ canMutate: false });
    toolBatch(h.session, "read", "old evidence".repeat(3_000));
    tail(h.session);
    await expect(h.tool.execute("blocked-trim", { action: "trim" }, undefined, undefined, h.ctx)).rejects.toThrow("disabled by policy");
    await expect(h.tool.execute("blocked-checkpoint", { action: "checkpoint", label: "no" }, undefined, undefined, h.ctx)).rejects.toThrow("disabled by policy");
    const status = await h.execute({ action: "status" });
    expect(JSON.parse(status.response.content[0].text).archivedOutputs).toBe(0);
    const plan = await h.tool.execute("plan-allowed", { action: "plan" }, undefined, undefined, h.ctx);
    expect(JSON.parse(plan.content[0].text).outputs).toBe(1);
    expect(h.boundary(status)).toBeUndefined();
    expect(h.changes()).toBe(0);
  });

  it("cancels a queued mutation when the policy disables mutations mid-batch", async () => {
    const h = harness();
    toolBatch(h.session, "read", "queued evidence".repeat(3_000));
    tail(h.session);
    const batch = await h.execute({ action: "trim" });
    h.setCanMutate(false);
    const cancellation = h.boundary(batch);
    expect(cancellation?.entries).toEqual([expect.objectContaining({
      type: "custom_message", customType: CONTEXT_CONTROL_TYPE, display: true,
    })]);
    expect(h.changes()).toBe(0);
    expect(inspectContext(h.session.getBranch(), h.session.getSessionId()).references.size).toBe(0);
  });

  it("still runs deterministic automatic hygiene with agent mutations disabled", async () => {
    const h = harness({ background: true, canMutate: false });
    const old = toolBatch(h.session, "read", "old research".repeat(2_000));
    tail(h.session);
    const result = { role: "toolResult" as const, toolCallId: "unrelated", toolName: "read", content: [], isError: false, timestamp: 1 };
    h.boundary({ response: {}, message: assistant(), messageEntryId: h.session.getLeafId()!, toolResults: [result], toolResultEntryIds: [] } as any);
    expect(inspectContext(h.session.getBranch(), h.session.getSessionId()).references.has(old.result)).toBe(true);
    expect(h.changes()).toBe(1);
  });

  it("reports honestly when an explicit trim finds nothing eligible", async () => {
    const h = harness();
    toolBatch(h.session, "read", "anchor-prefix-only".repeat(3_000));
    anchorBatch(h.session, "early-milestone");
    tail(h.session);
    const batch = await h.execute({ action: "trim" });
    const notice = h.boundary(batch);
    expect(notice?.entries).toEqual([expect.objectContaining({
      type: "custom_message", customType: CONTEXT_CONTROL_TYPE, display: true,
    })]);
    expect(h.changes()).toBe(0);
  });
});

describe("manual trim controller", () => {
  it("queues a manual trim that applies at the next natural boundary without a tool call", async () => {
    const h = harness();
    const target = toolBatch(h.session, "read", "manual trim target".repeat(600));
    tail(h.session);
    const before = structuredClone(h.session.getBranch());
    const result = h.controller.requestManualTrim(h.ctx);
    expect(result.state).toBe("queued");
    expect(result.notice).toContain("not yet trimmed");
    expect(h.session.getBranch()).toEqual(before);
    const ordinary = { role: "toolResult" as const, toolCallId: "unrelated", toolName: "read", content: [], isError: false, timestamp: 1 };
    h.boundary({ response: {}, message: assistant(), messageEntryId: h.session.getLeafId()!, toolResults: [ordinary], toolResultEntryIds: [] } as any);
    expect(inspectContext(h.session.getBranch(), h.session.getSessionId()).references.has(target.result)).toBe(true);
    expect(h.changes()).toBe(1);
    expect(readContextReference(h.session.getBranch(), h.session.getSessionId(), target.result)).toContain("manual trim target");
  });

  it("applies a manual trim even with agent mutations disabled", async () => {
    const h = harness({ canMutate: false });
    const target = toolBatch(h.session, "read", "policy-proof target".repeat(600));
    tail(h.session);
    expect(h.controller.requestManualTrim(h.ctx).state).toBe("queued");
    const ordinary = { role: "toolResult" as const, toolCallId: "unrelated", toolName: "read", content: [], isError: false, timestamp: 1 };
    h.boundary({ response: {}, message: assistant(), messageEntryId: h.session.getLeafId()!, toolResults: [ordinary], toolResultEntryIds: [] } as any);
    expect(inspectContext(h.session.getBranch(), h.session.getSessionId()).references.has(target.result)).toBe(true);
    expect(h.changes()).toBe(1);
  });

  it("survives the user's own next prompt between queue and boundary", async () => {
    const h = harness();
    const target = toolBatch(h.session, "read", "natural trigger research".repeat(600));
    tail(h.session);
    expect(h.controller.requestManualTrim(h.ctx).state).toBe("queued");
    h.session.appendMessage({ role: "user", content: "Please continue with cleanup", timestamp: 1 });
    const ordinary = { role: "toolResult" as const, toolCallId: "unrelated", toolName: "read", content: [], isError: false, timestamp: 1 };
    h.boundary({ response: {}, message: assistant(), messageEntryId: h.session.getLeafId()!, toolResults: [ordinary], toolResultEntryIds: [] } as any);
    expect(inspectContext(h.session.getBranch(), h.session.getSessionId()).references.has(target.result)).toBe(true);
  });

  it("reports paused, busy and no-eligible states honestly", async () => {
    const h = harness();
    toolBatch(h.session, "read", "queue conflict evidence".repeat(600));
    tail(h.session);
    h.setPaused(true);
    expect(h.controller.requestManualTrim(h.ctx).state).toBe("paused");
    h.setPaused(false);
    await h.execute({ action: "trim" });
    expect(h.controller.requestManualTrim(h.ctx).state).toBe("busy");
    for (const fn of h.handlers.get("session_start")!) fn({}, h.ctx);
    const empty = harness();
    toolBatch(empty.session, "read", "anchor-prefix-only".repeat(600));
    anchorBatch(empty.session, "gate");
    tail(empty.session);
    expect(empty.controller.requestManualTrim(empty.ctx)).toEqual({
      state: "no-eligible", notice: "No eligible archived output to trim.",
    });
  });
});

type PricedModel = { provider: string; id: string; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } };
const ANTHROPIC: PricedModel = { provider: "anthropic", id: "claude-test", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
const OPENAI: PricedModel = { provider: "openai", id: "gpt-test", cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } };

/** Independent expectation: the host's own projection after committing the plan, measured with the same estimator. */
function expectedTrim(session: SessionManager, model: PricedModel) {
  const branch = session.getBranch();
  const plan = planContextTrim(branch);
  const edited = SessionManager.inMemory(process.cwd(), undefined, [session.getHeader()!, ...branch]);
  apply(edited, plan.entries);
  const estimator = makeTokenEstimator(model.provider, model.id);
  const tokens = (entry: { message: unknown }) => estimator.message(entry.message as LlmMessage);
  const before = contextMessageEntries(branch);
  const after = contextMessageEntries(edited.getBranch());
  const targets = new Set(plan.references);
  const tailTokens = after.slice(after.findIndex(entry => targets.has(entry.id))).reduce((sum, entry) => sum + tokens(entry), 0);
  const savedTokens = plan.references.reduce((sum, id) =>
    sum + tokens(before.find(entry => entry.id === id)!) - tokens(after.find(entry => entry.id === id)!), 0);
  const r = model.cost.cacheRead / model.cost.input;
  const w = model.cost.cacheWrite > 0 ? model.cost.cacheWrite / model.cost.input : 1;
  const projected = buildSessionProjection(edited.getBranch()).entries;
  const marker = (id: string) => projected.find(entry => entry.sourceEntry.id === id)!.messages[0];
  return { plan, savedTokens, tailTokens, breakEvenRequests: ((w - r) * tailTokens) / (r * savedTokens), marker };
}

/** An old read-only batch, optionally followed by a large non-trimmable tail, then protected recent turns. */
function deferredFixture(model: PricedModel | undefined, largeTail: boolean) {
  const h = harness({ background: true, model });
  h.setTokens(100_000); // below the 140k start gate
  const old = toolBatch(h.session, "read", "old research".repeat(2_000));
  if (largeTail) h.session.appendMessage({ role: "user", content: "Keep this spec in view. ".repeat(4_000), timestamp: 1 });
  tail(h.session);
  return { h, old };
}
function controlOf(entries: SessionBoundaryDraft[] | undefined) {
  const control = entries?.find(entry => entry.type === "custom");
  return control?.type === "custom" ? control.data : undefined;
}

describe("automatic trim timing", () => {
  it("marks a warm-cache trim, applies it on the first cold request and commits it at the next completed turn", async () => {
    const { h, old } = deferredFixture(ANTHROPIC, true);
    const expected = expectedTrim(h.session, ANTHROPIC);
    expect(h.turn()).toBeUndefined();
    expect(h.session.getBranch().some(entry => entry.type === "context_edit")).toBe(false);
    const deferred = h.controller.deferredTrim(h.session.getSessionId())!;
    expect(deferred).toMatchObject({ savedTokens: expected.savedTokens, tailTokens: expected.tailTokens });
    expect(deferred.breakEvenRequests).toBeCloseTo(expected.breakEvenRequests, 9);
    expect(deferred.breakEvenRequests!).toBeGreaterThan(AUTO_TRIM_BREAK_EVEN_REQUESTS);
    const status = JSON.parse((await h.tool.execute("s", { action: "status" }, undefined, undefined, h.ctx)).content[0].text);
    expect(status.deferredTrim).toEqual(deferred);

    expect(h.request().result).toBeUndefined(); // 1 minute after the last response: cache warm
    h.setNow(1 + FIVE_MINUTES_MS + 1);
    const cold = h.request();
    const sent = cold.result!.messages;
    expect(sent).toHaveLength(cold.messages.length);
    const target = cold.messages.findIndex(message => message.role === "toolResult" && JSON.stringify(message.content).includes("old research"));
    expect(sent[target]).toEqual(expected.marker(old.result));
    sent.forEach((message: unknown, index: number) => { if (index !== target) expect(message).toBe(cold.messages[index]); });
    // Inside the tool loop the cache is warm again, but the prefix must not flip back.
    h.session.appendMessage({ ...assistant([{ type: "text", text: "loop" }]), timestamp: 1 + FIVE_MINUTES_MS + 2 });
    expect(h.request().result!.messages[target]).toEqual(expected.marker(old.result));

    expect(h.edits()).toEqual([]);
    const committed = h.turn();
    expect(committed!.entries.filter((entry: SessionBoundaryDraft) => entry.type === "context_edit")).toEqual(
      expected.plan.entries.filter(entry => entry.type === "context_edit"));
    expect(controlOf(committed!.entries)).toEqual({ version: 1, action: "trim", references: [old.result], archives: [archiveOf(old.result, "old research".repeat(2_000))], cause: "cold" });
    expect(h.edits()).toEqual([]);
    h.nextRequest();
    expect(h.edits()).toEqual(["trim"]);
    expect(h.controller.deferredTrim(h.session.getSessionId())).toBeNull();
  });

  it("commits immediately when the tail is small enough to pay back within the horizon", () => {
    const { h, old } = deferredFixture(ANTHROPIC, false);
    expect(expectedTrim(h.session, ANTHROPIC).breakEvenRequests).toBeLessThanOrEqual(AUTO_TRIM_BREAK_EVEN_REQUESTS);
    expect(controlOf(h.turn()?.entries)).toEqual({ version: 1, action: "trim", references: [old.result], archives: [archiveOf(old.result, "old research".repeat(2_000))], cause: "break-even" });
    expect(h.controller.deferredTrim(h.session.getSessionId())).toBeNull();
  });

  it("never commits a break-even trim when the model price is unknown", () => {
    const { h } = deferredFixture(undefined, false);
    expect(h.turn()).toBeUndefined();
    expect(h.controller.deferredTrim(h.session.getSessionId())?.breakEvenRequests).toBeNull();
  });

  it.each(["compaction", "context_edit"] as const)("drops a mark once a newer %s rewrote the context", kind => {
    const { h, old } = deferredFixture(ANTHROPIC, true);
    h.turn();
    if (kind === "compaction") h.session.appendCompaction("intervening", h.session.getBranch()[0].id, 1000);
    else h.session.appendContextEdit(old.result, { content: "foreign edit" });
    h.setNow(1 + FIVE_MINUTES_MS + 1);
    expect(h.request().result).toBeUndefined();
    expect(h.turn()).toBeUndefined();
    expect(h.session.getBranch().filter(entry => entry.type === "custom" && entry.customType === CONTEXT_CONTROL_TYPE)).toEqual([]);
    expect(h.controller.deferredTrim(h.session.getSessionId())).toBeNull();
  });

  it("keeps nothing from an aborted turn and re-applies on the next cold request", () => {
    const { h, old } = deferredFixture(ANTHROPIC, true);
    const expected = expectedTrim(h.session, ANTHROPIC);
    h.turn();
    h.setNow(1 + FIVE_MINUTES_MS + 1);
    expect(h.request().result).toBeDefined();
    expect(h.turn({ outcome: "aborted" })).toBeUndefined();
    expect(h.session.getBranch().some(entry => entry.type === "context_edit")).toBe(false);
    const again = h.request();
    expect(again.result!.messages.find((message: { role: string }) => message.role === "toolResult")).toEqual(expected.marker(old.result));
    expect(controlOf(h.turn()?.entries)).toMatchObject({ cause: "cold" });
  });

  it("keeps a cold-applied trim in force across a contested boundary until one can commit it", () => {
    const { h, old } = deferredFixture(ANTHROPIC, true);
    const expected = expectedTrim(h.session, ANTHROPIC);
    h.turn();
    h.setNow(1 + FIVE_MINUTES_MS + 1);
    expect(h.request().result).toBeDefined();
    // Queued user input owns this boundary: nothing commits, but the next
    // request must not flip the prefix back to the untrimmed version.
    expect(h.turn({ context: { pendingMessages: [{ role: "user", content: "queued" }], contextEntries: [] } })).toBeUndefined();
    expect(h.session.getBranch().some(entry => entry.type === "context_edit")).toBe(false);
    h.session.appendMessage({ ...assistant([{ type: "text", text: "after the queued input" }]), timestamp: 1 + FIVE_MINUTES_MS + 2 });
    expect(h.request().result!.messages.find((message: { role: string }) => message.role === "toolResult")).toEqual(expected.marker(old.result));
    expect(controlOf(h.turn()?.entries)).toEqual({ version: 1, action: "trim", references: [old.result], archives: [archiveOf(old.result, "old research".repeat(2_000))], cause: "cold" });
  });

  it("prices OpenAI-style caches without a write surcharge and honors 1h retention", () => {
    const { h } = deferredFixture(OPENAI, true);
    const oneHour = assistant([{ type: "text", text: "cached for an hour" }]);
    oneHour.usage = { ...oneHour.usage, cacheWrite: 5_000, cacheWrite1h: 5_000 };
    h.session.appendMessage(oneHour);
    const expected = expectedTrim(h.session, OPENAI);
    expect(h.turn()).toBeUndefined();
    expect(h.controller.deferredTrim(h.session.getSessionId())!.breakEvenRequests).toBeCloseTo(expected.breakEvenRequests, 9);
    h.setNow(1 + FIVE_MINUTES_MS + 1);
    expect(h.request().result).toBeUndefined();
    h.setNow(1 + ONE_HOUR_MS + 1);
    expect(h.request().result).toBeDefined();
  });
});
