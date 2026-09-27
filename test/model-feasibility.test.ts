import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildSessionContext, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, PROFILES } from "../src/constants.ts";
import type { CompactConfig } from "../src/types.ts";
import { createModelFeasibilityResolver } from "../src/app/model-feasibility.ts";
import { deriveProjectId } from "../src/utils/fingerprint.ts";
import { extractStructured } from "../src/utils/extraction.ts";
import { buildCompactionState } from "../src/utils/state.ts";
import { legacyScopedCompactionStateFile, scopedCompactionStateFile } from "../src/infra/paths.ts";

const previousHome = process.env.HOME;
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-model-plan-"));
  process.env.HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function model(id: string, contextWindow: number): Model<Api> {
  return {
    id, name: id, provider: "capacity-fixture", api: "openai-completions",
    baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
    contextWindow, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function fixture(turns = 64) {
  const cwd = path.join(home, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const manager = SessionManager.create(cwd);
  const reader = model("reader", 250_000);
  const small = model("small", 32_768);
  const tiny = model("tiny", 1_024);
  const models = [reader, small, tiny];
  let sequence = 0;
  function appendTurns(count: number, repetitions = 80) {
    for (let index = 0; index < count; index++) {
      const text = (`Observation ${sequence++}: measured request and state changes; preserve the recorded evidence.\n`).repeat(repetitions);
      manager.appendMessage({ role: "user", content: text, timestamp: sequence });
      manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "Recorded the observation." }],
        api: reader.api, provider: reader.provider, model: reader.id, stopReason: "stop", timestamp: sequence,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
      });
    }
  }
  appendTurns(turns, turns < 10 ? 4 : 80);
  let authCalls = 0;
  // Only metadata and session reads are reachable; auth resolution is forbidden.
  const ctx = {
    cwd, model: reader, sessionManager: manager,
    getContextUsage: () => ({ tokens: Math.ceil(JSON.stringify(buildSessionContext(manager.getBranch()).messages).length / 4) + 1024, contextWindow: reader.contextWindow }),
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) => models.find(item => item.provider === provider && item.id === id),
      getApiKeyAndHeaders: async () => { authCalls++; throw new Error("Model selection must not resolve or refresh auth"); },
    },
  } as unknown as ExtensionContext;
  const profile = { ...PROFILES.balanced, keepRecentTokens: 1000, summaryBudgetTokens: 1024, minChunkTokens: 300, maxChunkTokens: 1800, batchMaxTokens: 4000, singlePassMaxTokens: 1000 };
  const config: CompactConfig = {
    ...DEFAULT_CONFIG, mode: "balanced", zeroCallEnabled: false, adaptiveDamageFeedback: false,
    contextGraphEnabled: false, summaryModel: null, segmentationModel: null, verificationModel: null,
    profiles: { ...DEFAULT_CONFIG.profiles, balanced: profile, aggressive: { ...profile, singlePassMaxTokens: 500_000 } },
  };
  return { ctx, cwd, manager, reader, small, tiny, config, appendTurns, authCalls: () => authCalls };
}

describe("planned-request model eligibility", () => {
  it("accepts a chunk-capable model smaller than the chat, but rejects requests that exceed its window", async () => {
    const f = fixture();
    expect(f.ctx.getContextUsage()!.tokens!).toBeGreaterThan(f.small.contextWindow);
    const eligible = await createModelFeasibilityResolver(f.ctx, f.config);
    expect(eligible(f.small, "summary").selectable).toBe(true);
    expect(eligible(f.tiny, "summary").selectable).toBe(false);
    expect(eligible(model("unknown-window", 0), "summary").selectable).toBe(false);
    expect(f.authCalls()).toBe(0);
  });

  it("changes eligibility with the selected mode without confusing a batch plan with a single-pass plan", async () => {
    const f = fixture();
    const eligible = await createModelFeasibilityResolver(f.ctx, f.config);
    expect(eligible(f.small, "summary", "balanced").selectable).toBe(true);
    expect(eligible(f.small, "summary", "fast").selectable).toBe(false);
    expect(eligible(f.small, "summary", "balanced").selectable).toBe(true);
    expect(f.authCalls()).toBe(0);
  });

  it("rechecks a grown branch when a fresh snapshot is requested", async () => {
    const f = fixture(4);
    const before = await createModelFeasibilityResolver(f.ctx, f.config, "fast");
    expect(before(f.small, "summary").selectable).toBe(true);
    f.appendTurns(64);
    const after = await createModelFeasibilityResolver(f.ctx, f.config, "fast");
    expect(after(f.small, "summary").selectable).toBe(false);
    expect(f.authCalls()).toBe(0);
  });

  it("includes known focus text in the single-pass request", async () => {
    const f = fixture(4);
    f.config.focusWeighting = true;
    const ordinary = await createModelFeasibilityResolver(f.ctx, f.config, "fast");
    const focused = await createModelFeasibilityResolver(f.ctx, f.config, "fast", { focus: "Preserve this detailed focus. ".repeat(8000) });
    expect(ordinary(f.small, "summary").selectable).toBe(true);
    expect(focused(f.small, "summary").selectable).toBe(false);
    expect(f.authCalls()).toBe(0);
  });

  it.each([0, 8])("does not migrate or delete a %d-day-old legacy continuity snapshot during selection", async (ageDays) => {
    const f = fixture();
    const sessionId = f.manager.getSessionId();
    const extraction = extractStructured([], PROFILES.balanced);
    const projectId = deriveProjectId(f.cwd, extraction, sessionId);
    const branchHeadId = f.manager.getBranch()[0].id;
    const state = buildCompactionState(extraction, [], null, [], []);
    state.scope = { schemaVersion: 2, projectId, sessionId, branchHeadId };
    state.updatedAt = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    const legacy = legacyScopedCompactionStateFile(projectId, sessionId);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    const bytes = JSON.stringify(state);
    fs.writeFileSync(legacy, bytes, { mode: 0o600 });
    const eligible = await createModelFeasibilityResolver(f.ctx, f.config);
    expect(eligible(f.small, "summary").selectable).toBe(true);
    expect(fs.lstatSync(legacy).isFile()).toBe(true);
    expect(fs.readFileSync(legacy, "utf8")).toBe(bytes);
    expect(fs.existsSync(scopedCompactionStateFile(projectId, sessionId, branchHeadId))).toBe(false);
    expect(f.authCalls()).toBe(0);
  });
});
