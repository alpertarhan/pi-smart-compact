import { describe, it, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { CompactConfig } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { resolveModels } from "../src/index.ts";

// Minimal mock: resolveModels only touches modelRegistry.find,
// modelRegistry.getAvailable and ctx.model, so we cast a stub.
function mkCtx(opts: { models: Model<Api>[]; session?: Model<Api> }): ExtensionContext {
  const models = opts.models;
  return {
    model: opts.session,
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) =>
        models.find(m => m.provider === provider && m.id === id),
    },
  } as unknown as ExtensionContext;
}

function mkModel(provider: string, id: string): Model<Api> {
  return { provider, id, contextWindow: 200000 } as unknown as Model<Api>;
}

function cfg(over: Partial<CompactConfig> = {}): CompactConfig {
  return { ...DEFAULT_CONFIG, ...over } as CompactConfig;
}

const OPENAI = mkModel("openai", "gpt-5");
const ANTHROPIC = mkModel("anthropic", "claude-sonnet");

describe("resolveModels precedence", () => {
  it("explicit selection (TUI) wins over config.summaryModel", () => {
    const ctx = mkCtx({ models: [OPENAI, ANTHROPIC], session: OPENAI });
    const config = cfg({ summaryModel: "anthropic/claude-sonnet" });
    // User picked OPENAI in the TUI -> explicit=true
    const { sumModel } = resolveModels(ctx, OPENAI, config, true);
    expect(sumModel).toBe(OPENAI);
  });

  it("non-explicit falls back to config.summaryModel (auto-trigger path)", () => {
    const ctx = mkCtx({ models: [OPENAI, ANTHROPIC], session: OPENAI });
    const config = cfg({ summaryModel: "anthropic/claude-sonnet" });
    const { sumModel } = resolveModels(ctx, OPENAI, config, false);
    expect(sumModel).toBe(ANTHROPIC);
  });

  it("default (no arg) behaves like non-explicit", () => {
    const ctx = mkCtx({ models: [OPENAI, ANTHROPIC], session: OPENAI });
    const config = cfg({ summaryModel: "anthropic/claude-sonnet" });
    const { sumModel } = resolveModels(ctx, OPENAI, config);
    expect(sumModel).toBe(ANTHROPIC);
  });

  it("without config.summaryModel, primary is used regardless of explicit", () => {
    const ctx = mkCtx({ models: [OPENAI, ANTHROPIC], session: OPENAI });
    const config = cfg({ summaryModel: null });
    expect(resolveModels(ctx, ANTHROPIC, config, true).sumModel).toBe(ANTHROPIC);
    expect(resolveModels(ctx, ANTHROPIC, config, false).sumModel).toBe(ANTHROPIC);
  });

  it("config.segmentationModel still overrides segModel (TUI exposes only summary)", () => {
    const ctx = mkCtx({ models: [OPENAI, ANTHROPIC], session: OPENAI });
    const config = cfg({ segmentationModel: "anthropic/claude-sonnet" });
    const { segModel, sumModel } = resolveModels(ctx, OPENAI, config, true);
    expect(sumModel).toBe(OPENAI); // explicit won
    expect(segModel).toBe(ANTHROPIC); // segmentation config still applied
  });
});
