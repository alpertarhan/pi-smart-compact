import { expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { registerContextAttention } from "../src/app/context-attention.ts";

it("does not deliver a parked high-pressure note after real Pi compaction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psc-attention-lifecycle-"));
  let session: AgentSession | undefined;
  try {
    const authPath = path.join(root, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "SYNTHETIC-NO-REQUEST" } }));
    const runtime = await ModelRuntime.create({ authPath, modelsPath: path.join(root, "models.json"),
      modelsStorePath: path.join(root, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
    // Scripted main responses and a supplied summary; accidental network fails locally.
    const model = { ...runtime.getModel("anthropic", "claude-opus-5-5")!, baseUrl: "http://127.0.0.1:1", contextWindow: 200_000 };
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 0 }, retry: { enabled: false }, cacheWarming: "off" });
    const manager = SessionManager.inMemory(root);
    const errors: unknown[] = [];
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.registerTool({ name: "smart_context", label: "Offline context", description: "Offline fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => { throw new Error("No tool call expected"); } });
        registerContextAttention(pi, {
          config: () => ({ ...DEFAULT_CONFIG, autoTrigger: true, autoTriggerStrategy: "settled", maxContextTokens: 0 }),
          canAgentAct: () => true, canCleanup: () => true, reachable: () => false,
        });
        pi.on("session_before_compact", event => ({ compaction: {
          summary: "Completed the offline fixture; continue verification.",
          firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
        } }));
      }],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
      settingsManager: settings, resourceLoader: loader, sessionManager: manager, thinkingLevel: "off" }));
    await session.bindExtensions({ onError: error => errors.push(error) });
    const requests: Message[][] = [];
    session.agent.streamFunction = (_model, context) => {
      requests.push(structuredClone(context.messages));
      const input = requests.length === 2 || requests.length === 3 ? 150_000 : 500;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "Completed offline work." }], stopReason: "stop", timestamp: Date.now(),
        usage: { input, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: input + 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    };
    await session.prompt("Begin offline work.");
    await session.prompt("Finish this unit.");
    // message_end can still observe the previous response's measured usage.
    await session.prompt("One more completed turn at high pressure.");
    expect(session.getContextUsage()!.tokens).toBeGreaterThanOrEqual(150_000);
    await session.compact();
    expect(manager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
    expect(session.getContextUsage()?.tokens ?? 0).toBeLessThan(140_000);
    await session.prompt("Continue after compaction.");
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[3])).not.toContain("Context attention:");
    expect(errors).toEqual([]);
  } finally {
    session?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
