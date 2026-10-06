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
import { inspectContext } from "../src/app/context-operations.ts";
import { registerSmartContextTool } from "../src/app/register-smart-context-tool.ts";

it("delivers the checkpoint prefix plus one research report to the next real Pi request below pressure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psc-research-rewind-"));
  let session: AgentSession | undefined;
  try {
    const authPath = path.join(root, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "SYNTHETIC-NO-REQUEST" } }));
    const runtime = await ModelRuntime.create({ authPath, modelsPath: path.join(root, "models.json"),
      modelsStorePath: path.join(root, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
    const model = { ...runtime.getModel("anthropic", "claude-opus-5-5")!, baseUrl: "http://127.0.0.1:1", contextWindow: 200_000 };
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const manager = SessionManager.inMemory(root);
    const errors: unknown[] = [];
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        registerSmartContextTool(pi, { config: () => ({ ...DEFAULT_CONFIG, autoTrigger: false, contextHygieneEnabled: false }) });
        pi.registerTool({ name: "search_graph", label: "Offline research", description: "Read-only offline fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "DISPOSABLE_RESEARCH_PAYLOAD" }], details: undefined }) });
      }],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
      settingsManager: settings, resourceLoader: loader, sessionManager: manager, thinkingLevel: "off" }));
    await session.bindExtensions({ onError: error => errors.push(error) });
    const report = "src/auth.ts:12 needs <=. Preserve the async API. Next: implement and test.";
    const calls: Array<Pick<ToolCall, "name" | "arguments">> = [
      { name: "smart_context", arguments: { action: "checkpoint", label: "Investigate auth" } },
      { name: "search_graph", arguments: {} },
      { name: "smart_context", arguments: { action: "rewind", report } },
    ];
    const requests: Message[][] = [];
    session.agent.streamFunction = (_model, context) => {
      const call = calls[requests.length];
      requests.push(structuredClone(context.messages));
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: call ? [{ type: "toolCall", id: "offline-" + requests.length, ...call }] : [{ type: "text", text: "Continue from the research findings." }],
        stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 500, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 505,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    };
    await session.prompt("Research auth expiry, then resume the original task with concise findings. Do not edit files yet.");
    expect(requests).toHaveLength(4);
    const checkpointPrefix = requests[1]; // checkpoint committed; research has not run
    expect(JSON.stringify(requests[2])).toContain("DISPOSABLE_RESEARCH_PAYLOAD");
    expect(requests[3].slice(0, checkpointPrefix.length)).toEqual(checkpointPrefix);
    expect(requests[3]).toHaveLength(checkpointPrefix.length + 1);
    expect(JSON.stringify(requests[3])).not.toContain("DISPOSABLE_RESEARCH_PAYLOAD");
    expect(JSON.stringify(requests[3]).split(report)).toHaveLength(2);
    expect(inspectContext(manager.getBranch(), manager.getSessionId()).checkpoint).toBeNull();
    expect(JSON.stringify(manager.getBranch())).toContain("DISPOSABLE_RESEARCH_PAYLOAD");
    expect(errors).toEqual([]);
  } finally {
    session?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
