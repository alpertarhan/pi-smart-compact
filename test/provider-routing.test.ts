import { describe, expect, it } from "bun:test";
import { prepareRun } from "../src/app/steps/prepare.ts";
import { createServices } from "../src/infra/services.ts";
import { resolveStageAuth } from "../src/app/stage-auth.ts";
import { DEFAULT_CONFIG } from "../src/constants.ts";

describe("stage-aware provider routing", () => {
  it("resolves auth once per distinct route and keeps equivalent models deduplicated", async () => {
    const requested: string[] = [];
    const summary = { provider: "openai", id: "summary", contextWindow: 200_000 } as any;
    const equivalentSegmenter = { ...summary };
    const verifier = { provider: "anthropic", id: "verifier", contextWindow: 200_000 } as any;
    const controller = new AbortController();
    const config = {
      ...DEFAULT_CONFIG,
      profiles: { ...DEFAULT_CONFIG.profiles, balanced: { ...DEFAULT_CONFIG.profiles.balanced, summaryBudgetTokens: 1_234 } },
    };
    const prepared = await prepareRun({
      ctx: {
        cwd: process.cwd(),
        modelRegistry: { getApiKeyAndHeaders: async (model: any) => {
          requested.push(model.provider + "/" + model.id);
          return { ok: true, apiKey: model.provider + "-key" };
        } },
        ui: { notify: () => {} },
      },
      config,
      summaryModel: summary,
      segModel: equivalentSegmenter,
      verifyModel: verifier,
      modelLabel: "openai/summary",
      mode: "balanced",
      requestedMode: "balanced",
      profile: "balanced",
      services: createServices(),
      timeoutMs: 0,
      cancellation: { controller, signal: controller.signal, timedOut: false, timeoutId: null },
      notify: () => {},
      flags: { autoTriggered: false },
    } as any);

    expect(requested).toEqual([]);
    expect(prepared?.config).toBe(config);
    expect(prepared?.profileCfg.summaryBudgetTokens).toBe(1_234);
    expect(prepared?.summaryAuth).toBeUndefined();
    expect((await resolveStageAuth(prepared!, "summary")).apiKey).toBe("openai-key");
    expect((await resolveStageAuth(prepared!, "explore")).apiKey).toBe("openai-key");
    expect((await resolveStageAuth(prepared!, "verify")).apiKey).toBe("anthropic-key");
    expect(requested).toEqual(["openai/summary", "anthropic/verifier"]);
  });

  it("does not fail a run for an unused optional route with missing auth", async () => {
    const controller = new AbortController();
    const summary = { provider: "openai", id: "summary", contextWindow: 200_000 } as any;
    const verifier = { provider: "missing", id: "verifier", contextWindow: 200_000 } as any;
    const prepared = await prepareRun({
      ctx: {
        cwd: process.cwd(),
        modelRegistry: { getApiKeyAndHeaders: async (model: any) => model.provider === "openai"
          ? { ok: true, apiKey: "summary-key" }
          : { ok: false, error: "missing" } },
        ui: { notify: () => {} },
      },
      summaryModel: summary, segModel: summary, verifyModel: verifier,
      modelLabel: "openai/summary", mode: "fast", requestedMode: "fast", profile: "balanced",
      services: createServices(), timeoutMs: 0,
      cancellation: { controller, signal: controller.signal, timedOut: false, timeoutId: null },
      notify: () => {}, flags: { autoTriggered: false },
    } as any);
    expect(prepared).not.toBeNull();
    await expect(resolveStageAuth(prepared!, "verify")).rejects.toThrow("Authentication unavailable");
  });
});
