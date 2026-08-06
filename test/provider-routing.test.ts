import { describe, expect, it } from "bun:test";
import { prepareRun } from "../src/app/steps/prepare.ts";
import { createServices } from "../src/infra/services.ts";

describe("stage-aware provider routing", () => {
  it("resolves auth once per distinct route and keeps equivalent models deduplicated", async () => {
    const requested: string[] = [];
    const summary = { provider: "openai", id: "summary", contextWindow: 200_000 } as any;
    const equivalentSegmenter = { ...summary };
    const verifier = { provider: "anthropic", id: "verifier", contextWindow: 200_000 } as any;
    const controller = new AbortController();
    const prepared = await prepareRun({
      ctx: {
        cwd: process.cwd(),
        modelRegistry: { getApiKeyAndHeaders: async (model: any) => {
          requested.push(model.provider + "/" + model.id);
          return { ok: true, apiKey: model.provider + "-key" };
        } },
        ui: { notify: () => {} },
      },
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

    expect(requested).toEqual(["openai/summary", "anthropic/verifier"]);
    expect(prepared?.summaryAuth.apiKey).toBe("openai-key");
    expect(prepared?.segAuth.apiKey).toBe("openai-key");
    expect(prepared?.verifyAuth.apiKey).toBe("anthropic-key");
  });
});
