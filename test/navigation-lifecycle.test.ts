import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { anchorFromEntry } from "../src/app/navigation-data.ts";
import { registerNavigation } from "../src/app/register-navigation.ts";

it("keeps a human anchor and its summary when native Pi returns to it, even with agent tools off", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "human-anchor-"));
  let session: AgentSession | undefined;
  try {
    const authPath = path.join(root, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "SYNTHETIC-NO-REQUEST" } }));
    const runtime = await ModelRuntime.create({ authPath, modelsPath: path.join(root, "models.json"), modelsStorePath: path.join(root, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
    // Any accidental summarizer request fails locally, never at a provider.
    const model = { ...runtime.getModel("anthropic", "claude-opus-5-5")!, baseUrl: "http://127.0.0.1:1" };
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const manager = SessionManager.inMemory(root);
    manager.appendMessage({ role: "user", content: "Completed work before the anchor.", timestamp: 1 });
    let anchorId: string | undefined;
    let failure: unknown;
    const errors: unknown[] = [];
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        const navigation = registerNavigation(pi, { config: () => ({ ...DEFAULT_CONFIG, toolLoading: "off" }) });
        pi.registerCommand("exercise-human-anchor", {
          handler: async (_args, ctx) => {
            try {
              const panel = navigation.panel(ctx);
              await panel.create("reviewed", "ANCHOR_FACT_913\nNext validate flags.");
              anchorId = manager.getEntries().find(entry => anchorFromEntry(entry)?.name === "reviewed")?.id;
              pi.sendMessage({ customType: "later-fixture", content: "LATER_FACT_824", display: false }, { triggerTurn: false });
              const result = await panel.pivot("reviewed", "Keep LATER_FACT_824.");
              expect(result.ok).toBe(true);
            } catch (error) { failure = error; }
          }
        });
      }],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, sessionManager: manager, thinkingLevel: "off" }));
    const active = session;
    await active.bindExtensions({
      onError: error => errors.push(error), commandContextActions: {
        waitForIdle: () => active.waitForIdle(),
        navigateTree: (target, options) => active.navigateTree(target, options),
        newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }), reload: () => active.reload(),
      }
    });
    await active.prompt("/exercise-human-anchor");
    if (failure) throw failure;
    expect(errors).toEqual([]);
    const branch = manager.getBranch();
    const kept = branch.find(entry => entry.id === anchorId);
    expect(kept?.type).toBe("custom_message");
    expect(kept && anchorFromEntry(kept)?.summary).toBe("ANCHOR_FACT_913\nNext validate flags.");
    expect(branch.find(entry => entry.type === "branch_summary")?.summary).toContain("LATER_FACT_824");
  } finally { session?.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
