/** Offline real-Pi-dispatch compatibility checks against an explicit local pi-lens path.
 * NODE_PATH="$PWD/node_modules" bun scripts/context-compat-pilot.ts /path/to/pi-lens
 * No model/API calls, global installs or settings writes. pi-lens stays optional.
 *
 * Anchor-prefix risk under study: Continuity trim must not rewrite delivered content
 * inside the active smart_navigation anchor's cached prefix (the provider cache
 * breakpoint Continuity's anchor cache places on the newest anchor). Measured as the
 * byte-common-prefix of two consecutive provider payloads, in both load orders with
 * pi-lens's read guard.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import smartCompact from "../src/index.ts";
import { resetConfigCache } from "../src/utils/config.ts";

const lensPath = process.argv[2];
if (!lensPath || !path.isAbsolute(lensPath)) throw new Error("Supply an absolute local pi-lens path; this script never installs it.");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-compat-"));
const oldEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_CACHE_RETENTION: process.env.PI_CACHE_RETENTION };
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = path.join(scratch, ".pi", "agent");
process.env.PI_CACHE_RETENTION = "long";
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({
  smartCompact: { toolLoading: "eager", autoTrigger: false, contextHygieneEnabled: true, artifactOffloadEnabled: true, minContextPercent: 80, contextGraphEnabled: false },
}));
resetConfigCache();

/** Stable per-message serialization for byte-prefix comparisons; marker metadata
 * (cache_control) is breakpoint placement, not delivered content, so it is excluded. */
function serializeMessage(message: unknown): string {
  return JSON.stringify(message, (key, value) => key === "cache_control" ? undefined : value);
}

function serializePayloadMessages(messages: unknown[]): string {
  return messages.map(serializeMessage).join("\n");
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index++;
  return index;
}

/** Byte offset (in the serialized form) where the anchor's tool_result block ends. */
function anchorBlockEnd(payload: { messages: Array<Record<string, unknown>> }, anchorToolCallId: string): number {
  let offset = 0;
  for (const message of payload.messages) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const isAnchorMessage = blocks.some((block: Record<string, unknown>) =>
      block.type === "tool_result" && block.tool_use_id === anchorToolCallId);
    offset += serializeMessage(message).length + 1;
    if (isAnchorMessage) return offset;
  }
  throw new Error("Anchor tool_result block missing from provider payload.");
}

/** Anthropic-shape payload from real projected context messages, plus a tailed cache marker. */
function anthropicPayload(contextMessages: Array<Record<string, unknown>>): { system: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> } {
  const messages: Array<Record<string, unknown>> = contextMessages.map(message => {
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content
        : (Array.isArray(message.content) ? message.content : []).map((block: Record<string, unknown>) =>
          typeof block === "string" ? block : String(block.text ?? "")).join("\n");
      return { role: "user", content: [{ type: "text", text }] };
    }
    if (message.role === "assistant") {
      const content = (Array.isArray(message.content) ? message.content : []).map((block: Record<string, unknown>) =>
        block.type === "toolCall"
          ? { type: "tool_use", id: block.id, name: block.name, input: block.arguments }
          : { type: "text", text: String(block.text ?? "") });
      return { role: "assistant", content };
    }
    if (message.role === "toolResult") {
      const text = typeof message.content === "string" ? message.content
        : (Array.isArray(message.content) ? message.content : []).map((block: Record<string, unknown>) =>
          typeof block === "string" ? block : String(block.text ?? "")).join("\n");
      return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: [{ type: "text", text }] }] };
    }
    return { role: "user", content: [{ type: "text", text: JSON.stringify(message.content ?? "") }] };
  });
  messages.push({ role: "user", content: [{ type: "text", text: "tail", cache_control: { type: "ephemeral", ttl: "1h" } }] });
  return { system: [{ type: "text", text: "offline system" }], messages };
}

try {
  // This checkout's Pi host; neither package's handlers/transform functions are mocked.
  const hostEntry = Bun.resolveSync("@earendil-works/pi-coding-agent", import.meta.dir);
  const host = await import(hostEntry);
  const { loadExtensionFromFactory } = await import(path.join(path.dirname(hostEntry), "core/extensions/loader.js"));
  const { handleToolResult } = await import(path.join(lensPath, "dist/clients/runtime-tool-result.js"));
  const { ReadGuard } = await import(path.join(lensPath, "dist/clients/read-guard.js"));
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const results = [];
  for (const reversed of [false, true]) {
    const cwd = path.join(scratch, reversed ? "lens-first" : "smart-first");
    fs.mkdirSync(cwd);
    const preAnchorFile = path.join(cwd, "source.ts");
    const preAnchorBody = Array.from({ length: 1500 }, (_, i) => i === 750 ? "const UNSEEN_MIDDLE_EDIT_SITE = true;" : `// evidence line ${i}`).join("\n");
    fs.writeFileSync(preAnchorFile, preAnchorBody);
    const postAnchorFile = path.join(cwd, "source2.ts");
    const postAnchorBody = Array.from({ length: 1500 }, (_, i) => i === 750 ? "const UNSEEN_POST_ANCHOR_SITE = true;" : `// later evidence line ${i}`).join("\n");
    fs.writeFileSync(postAnchorFile, postAnchorBody);
    const oldTime = new Date(Date.now() - 3_600_000);
    fs.utimesSync(preAnchorFile, oldTime, oldTime);
    const session = host.SessionManager.create(cwd, path.join(cwd, "sessions"));
    session.appendMessage({ role: "user", content: "Preserve authentication and error evidence", timestamp: 1 });
    const events = host.createEventBus();
    const runtime = host.createExtensionRuntime();
    const guard = new ReadGuard("compat-" + reversed);
    assert.equal(guard.checkEdit(preAnchorFile, [751, 751]).action, "block");
    const lens = (pi: any) => pi.on("tool_result", (event: any) => handleToolResult({
      event, getFlag: (name: string) => name === "no-lsp", dbg() {},
      runtime: { projectRoot: cwd, turnIndex: 1, sessionGeneration: 1, peekWriteIndex: () => 0, takeToolCallAttribution: () => undefined },
      cacheManager: {}, readGuard: guard, agentBehaviorRecord: () => [], formatBehaviorWarnings: () => "", sessionId: session.getSessionId(),
    }));
    const factories = reversed ? [lens, smartCompact] : [smartCompact, lens];
    const extensions = [];
    for (const [index, factory] of factories.entries()) extensions.push(await loadExtensionFromFactory(factory, cwd, events, runtime, "compat-" + index));
    const runner = new host.ExtensionRunner(extensions, runtime, cwd, session, { getAvailable: () => [] });
    const model = { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-5", contextWindow: 200_000, maxTokens: 8192 };
    const activeTools = ["smart_tools", "smart_navigation", "smart_context", "smart_compact", "read", "grep", "bash"];
    const errors: unknown[] = [];
    runner.onError((error: unknown) => errors.push(error));
    runner.bindCore({
      getActiveTools: () => activeTools, getAllTools: () => [], setActiveTools() {}, refreshTools() {},
      appendEntry: (type: string, data: any) => session.appendCustomEntry(type, data),
      getCommands: () => [], sendMessage() {}, sendUserMessage() {}, setSessionName() {}, getSessionName: () => "compat", setLabel() {},
      setModel: async () => true, getThinkingLevel: () => "off", setThinkingLevel() {},
    }, { getModel: () => model, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true,
      getSignal: () => undefined, abort() {}, hasPendingMessages: () => false, shutdown() {},
      getContextUsage: () => ({ tokens: 140_000, contextWindow: 200_000, percent: 70 }),
      compact() { throw new Error("Unexpected automatic compaction"); }, getSystemPrompt: () => "" });
    const ctx = runner.createContext();
    await runner.emit({ type: "session_start", reason: "startup" });
    let sequence = 0;
    async function call(name: string, input: any, text?: string, isError = false) {
      const id = "call-" + sequence++;
      const message = { role: "assistant", content: [{ type: "toolCall", name, id, arguments: input }],
        provider: model.provider, model: model.id, api: model.api, usage, timestamp: 1, stopReason: "toolUse" };
      const messageEntryId = session.appendMessage(message);
      const response = text === undefined ? await runner.getToolDefinition(name).execute(id, input, undefined, undefined, ctx)
        : { content: [{ type: "text", text }], details: undefined };
      const change = await runner.emitToolResult({ type: "tool_result", toolName: name, toolCallId: id, input, isError, ...response });
      const result = { role: "toolResult", toolName: name, toolCallId: id, content: change?.content ?? response.content,
        details: change?.details ?? response.details, isError, timestamp: 1 };
      const resultId = session.appendMessage(result);
      return { message, messageEntryId, result, resultId };
    }
    function applyEntries(manager: any, entries: any[]) {
      for (const entry of entries) {
        if (entry.type === "context_edit") manager.appendContextEdit(entry.targetId, entry.replacement);
        else if (entry.type === "custom") manager.appendCustomEntry(entry.customType, entry.data);
        else if (entry.type === "custom_message") manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display);
        else throw new Error("Unexpected draft: " + entry.type);
      }
    }
    async function boundary(batch: Awaited<ReturnType<typeof call>>) {
      const result = await runner.emitBoundary({ type: "turn_end", outcome: "completed", turnIndex: sequence,
        message: batch.message, messageEntryId: batch.messageEntryId, toolResults: [batch.result], toolResultEntryIds: [batch.resultId] },
      (entries: any[]) => {
        const preview = host.SessionManager.inMemory(cwd, undefined, [session.getHeader(), ...session.getBranch()]);
        applyEntries(preview, entries);
        const projection = host.buildSessionProjection(preview.getBranch());
        return { contextEntries: projection.entries, contextMessages: projection.messages,
          llmMessages: host.convertToLlm(projection.messages), pendingMessages: [], canContinue: false };
      });
      assert(result.valid);
      applyEntries(session, result.entries);
      return result.entries;
    }
    const instructions = "instruction intro\n".repeat(600) + "NEVER_DELETE_AUTH";
    const failure = "failure log\n".repeat(600) + "UNRESOLVED_FAILURE";
    await call("read", { path: path.join(cwd, "AGENTS.md") }, instructions);
    await call("bash", { command: "offline-test" }, failure, true);
    const preAnchorRead = await call("read", { path: preAnchorFile }, preAnchorBody);
    assert.equal(preAnchorRead.result.content[0].text, preAnchorBody);
    assert.equal(guard.checkEdit(preAnchorFile, [751, 751]).action, "allow"); // The middle really was delivered.
    const archived = await call("grep", { path: cwd, pattern: "evidence" }, "grep\n".repeat(5000));
    assert(archived.result.details.smartCompactArtifact);
    const otherSource = path.join(cwd, "second-source");
    const repeated = await call("grep", { filePath: otherSource, pattern: "evidence" }, "grep\n".repeat(5000));
    assert.equal(repeated.result.details.smartCompactArtifact.hash, archived.result.details.smartCompactArtifact.hash);
    for (const source of [cwd, otherSource]) {
      const found = await call("smart_context", { action: "search", query: source });
      const matches = JSON.parse(found.result.content[0].text.split("\n").slice(1).join("\n")).matches;
      assert(matches.some((match: any) => match.source === source));
    }
    const anchor = await call("smart_navigation", { action: "anchor", name: "research-done", summary: "Preserve authentication and unresolved error" });
    const betweenAnchorsRead = await call("read", { path: postAnchorFile }, postAnchorBody);
    const secondAnchor = await call("smart_navigation", { action: "anchor", name: "second-milestone", summary: "Bridge transition anchor" });
    async function providerPayload() {
      const contextMessages = await runner.emitContext(session.buildSessionContext().messages);
      const processed = await runner.emitBeforeProviderRequest(anthropicPayload(contextMessages as Array<Record<string, unknown>>));
      return processed as { messages: Array<Record<string, unknown>> };
    }
    const transition = await providerPayload(); // First request after the newest anchor: bridge window.
    const markerState = (payload: { messages: Array<Record<string, unknown>> }, toolCallId: string) =>
      payload.messages.some((message: any) => (Array.isArray(message.content) ? message.content : [])
        .some((block: any) => block.type === "tool_result" && block.tool_use_id === toolCallId && block.cache_control));
    const transitionBridgeMarked = markerState(transition, anchor.result.toolCallId);
    assert(markerState(transition, secondAnchor.result.toolCallId), "Continuity anchor cache did not mark the newest anchor");
    const postAnchorRead = await call("read", { path: path.join(cwd, "source3.ts") }, Array.from({ length: 1500 }, (_, i) =>
      i === 750 ? "const UNSEEN_LATEST_RESEARCH_SITE = true;" : `// latest evidence line ${i}`).join("\n"));
    for (let i = 0; i < 4; i++) session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Recent protected turn" }],
      provider: model.provider, model: model.id, api: model.api, usage, timestamp: 1, stopReason: "stop" });
    const before = await providerPayload();
    const firstAnchorEnd = anchorBlockEnd(before, anchor.result.toolCallId);
    const secondAnchorEnd = anchorBlockEnd(before, secondAnchor.result.toolCallId);
    const trimmed = await boundary(await call("smart_context", { action: "trim" }));
    const edits = trimmed.filter((entry: any) => entry.type === "context_edit");
    assert(edits.some((entry: any) => entry.targetId === postAnchorRead.resultId), "Research after the newest anchor was not trimmed");
    for (const protectedRead of [preAnchorRead, betweenAnchorsRead]) {
      assert(!edits.some((entry: any) => entry.targetId === protectedRead.resultId),
        "Trim rewrote content inside an active anchor's cached prefix");
    }
    const after = await providerPayload();
    const prefix = commonPrefixLength(serializePayloadMessages(before.messages), serializePayloadMessages(after.messages));
    assert(prefix >= secondAnchorEnd, `Trim invalidated the anchor cache prefix: common ${prefix} bytes < newest anchor end ${secondAnchorEnd}`);
    const afterTrimContext = JSON.stringify(await runner.emitContext(session.buildSessionContext().messages));
    assert(afterTrimContext.includes("NEVER_DELETE_AUTH") && afterTrimContext.includes("UNRESOLVED_FAILURE"));
    assert(afterTrimContext.includes("UNSEEN_MIDDLE_EDIT_SITE") && afterTrimContext.includes("UNSEEN_POST_ANCHOR_SITE"),
      "Evidence inside the protected anchor prefixes must stay delivered");
    assert(!afterTrimContext.includes("UNSEEN_LATEST_RESEARCH_SITE"), "Post-anchor evidence should be archived, not delivered");
    assert(markerState(after, secondAnchor.result.toolCallId)); // Anchor cache still marks the newest anchor after trim.
    const recovered = await call("smart_context", { action: "read", id: postAnchorRead.resultId, line: 751, limit: 1 });
    assert(recovered.result.content[0].text.includes("UNSEEN_LATEST_RESEARCH_SITE"));
    // A foreign (non-Smart-Compact) edit of an archived output revokes raw recovery.
    session.appendContextEdit(postAnchorRead.resultId, { content: "[foreign rewrite]" });
    await assert.rejects(runner.getToolDefinition("smart_context").execute("revoked", { action: "read", id: postAnchorRead.resultId }, undefined, undefined, ctx), /unavailable|No archived/i);
    const reloaded = host.SessionManager.open(session.getSessionFile());
    assert(JSON.stringify(reloaded.buildSessionContext().messages).includes("NEVER_DELETE_AUTH"));
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    runtime.invalidate();
    guard.forgetPath(preAnchorFile);
    assert.deepEqual(errors, [], "Native runner swallowed an extension failure");
    results.push({ order: reversed ? "lens-smart" : "smart-lens", protectedEvidence: true,
      accurateReadCoverage: true, sharedSourceDiscovery: true, firstAnchorPrefixBytes: firstAnchorEnd,
      newestAnchorPrefixBytes: secondAnchorEnd, anchorPrefixCommonBytes: prefix,
      transitionBridgeMarked, postAnchorTrimRecovered: true, revokedByForeignEdit: true,
      persistedReload: true });
  }
  console.log(JSON.stringify({ offline: true, boundary: "real extension loader/dispatcher, SessionManager and Lens guard; no model loop", results }, null, 2));
} finally {
  for (const [key, value] of Object.entries(oldEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  resetConfigCache();
  fs.rmSync(scratch, { recursive: true, force: true });
}
