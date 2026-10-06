import { expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { inspectContext, readContextReference } from "../src/app/context-operations.ts";
import { anchorFromEntry } from "../src/app/navigation-data.ts";
import { registerNavigation } from "../src/app/register-navigation.ts";
import { registerSmartContextTool } from "../src/app/register-smart-context-tool.ts";

it.each([true, false])("real Pi applies early anchor cleanup only after host consent (approved=%s)", async approved => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psc-anchor-consent-"));
  let session: AgentSession | undefined;
  try {
    const authPath = path.join(root, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "SYNTHETIC-NO-REQUEST" } }));
    const runtime = await ModelRuntime.create({ authPath, modelsPath: path.join(root, "models.json"),
      modelsStorePath: path.join(root, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
    const model = { ...runtime.getModel("anthropic", "claude-opus-5-5")!, baseUrl: "http://127.0.0.1:1", contextWindow: 200_000 };
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const manager = SessionManager.inMemory(root);
    const cfg = { ...DEFAULT_CONFIG, autoTrigger: false, contextHygieneEnabled: false };
    const errors: unknown[] = [];
    const payload = "RECOVERABLE_ANCHOR_RESEARCH\n".repeat(200);
    let outputs = 0;
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        const history = registerSmartContextTool(pi, { config: () => cfg });
        registerNavigation(pi, { config: () => cfg,
          onAnchor: (ctx, origin, callId, signal, confirmed) => history.requestAnchorTrim(ctx, origin, callId, signal, confirmed).notice });
        pi.registerTool({ name: "search_graph", label: "Offline research", description: "Read-only offline fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: outputs++ === 0 ? payload : "Recent protected evidence" }], details: undefined }) });
      }],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
      settingsManager: settings, resourceLoader: loader, sessionManager: manager, thinkingLevel: "off" }));
    let confirmations = 0;
    await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error),
      uiContext: { ...session.extensionRunner.getUIContext(), confirm: async (_title, body) => {
        confirmations++;
        expect(body).toContain("user-milestone");
        expect(body).toContain("Keep the async API");
        expect(inspectContext(manager.getBranch(), manager.getSessionId()).references.size).toBe(0);
        return approved;
      } } });
    const calls: Array<Pick<ToolCall, "name" | "arguments">> = [
      ...Array.from({ length: 5 }, () => ({ name: "search_graph", arguments: {} })),
      { name: "smart_navigation", arguments: { action: "anchor", name: "user-milestone", summary: "Keep the async API. Next: test expiry." } },
    ];
    const requests: Message[][] = [];
    session.agent.streamFunction = (_model, context) => {
      const call = calls[requests.length];
      requests.push(structuredClone(context.messages));
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: call ? [{ type: "toolCall", id: "offline-" + requests.length, ...call }] : [{ type: "text", text: "Continue the task." }],
        stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 500, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 505,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    };
    await session.prompt("Inspect the implementation, then mark a milestone and request safe cleanup.");
    expect(requests).toHaveLength(7);
    expect(confirmations).toBe(1);
    expect(JSON.stringify(requests[5])).toContain("RECOVERABLE_ANCHOR_RESEARCH");
    const after = JSON.stringify(requests[6]);
    const state = inspectContext(manager.getBranch(), manager.getSessionId());
    expect(manager.getBranch().some(entry => anchorFromEntry(entry))).toBe(approved);
    expect(state.references.size).toBe(approved ? 1 : 0);
    if (approved) {
      expect(after).toContain("[Archived search_graph output");
      expect(after).not.toContain(JSON.stringify(payload).slice(1, -1));
      expect(after).toContain("Keep the async API");
      expect(readContextReference(manager.getBranch(), manager.getSessionId(), [...state.references][0])).toBe(payload);
    } else {
      expect(after).toContain(JSON.stringify(payload).slice(1, -1));
      expect(after).toContain("not approved");
    }
    expect(cfg.contextPressureOnly).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    session?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
