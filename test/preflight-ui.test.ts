import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ManualPreflight } from "../src/app/preflight.ts";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import type { CompactionWindowPlan } from "../src/app/run-context.ts";
import { formatPreflightSummary, recommendPreflight, showCompactUI } from "../src/ui/overlays.ts";
import { resolveModels } from "../src/index.ts";

function preview(mode: ManualPreflight["mode"], viable: boolean, reason: ManualPreflight["reason"] = viable ? "viable" : "insufficient-projected-saving"): ManualPreflight {
  const plan: CompactionWindowPlan = {
    keepFrom: 2, compactTokens: 60_000, retainedTokens: 20_000,
    projectedAfterTokens: 26_000, projectedSavedTokens: 64_000, projectedYield: 0.71,
    fixedContextTokens: 0, retentionTargetTokens: 20_000, summaryBudgetTokens: 6_000,
    targetAfterTokens: 26_000, hardBoundaryAdjusted: false, viable, reason: reason === "not-enough-messages" ? "no-eligible-prefix" : reason,
    relaxedSoftBoundaries: ["recent-user-turn"],
  };
  return {
    mode, plan, reason, totalTokens: 90_000,
    profileCfg: { keepRecentTokens: 20_000, summaryBudgetTokens: 6_000, minChunkTokens: 500, maxChunkTokens: 8_000, singlePassMaxTokens: 30_000, batchMaxTokens: 24_000 },
    rawEstimatedMessageTokens: 100_000, estimatorScale: 0.8, adapted: false, damageMedian: 0,
    contextWindowTokens: 140_000, contextPercent: 64, toolPercent: 10, overflowedContext: false,
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const keybindings = {
  matches: (data: string, binding: string) => ({
    "tui.select.cancel": "esc", "tui.select.up": "up", "tui.select.down": "down", "tui.select.confirm": "enter",
  } as Record<string, string>)[binding] === data,
};

const config = { ...DEFAULT_CONFIG, profiles: DEFAULT_CONFIG.profiles };
const opts = { contextTokens: 90_000, contextPercent: 90, activeModelLabel: "openai/summary", defaultModelIndex: 0, config };

function context(custom: (component: any, doneValue: { value?: unknown }) => void, totalTokens = 90_000, models?: Array<{ provider: string; id: string; contextWindow: number }>) {
  const model = { provider: "openai", id: "summary", contextWindow: 100_000 };
  const available = models ?? [model];
  const branch = [
    { type: "message", id: "old-user", message: { role: "user", content: [{ type: "text", text: "x".repeat(300_000) }] } },
    { type: "message", id: "old-answer", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(100_000) }] } },
    { type: "message", id: "recent-user", message: { role: "user", content: [{ type: "text", text: "recent" }] } },
    { type: "message", id: "recent-answer", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ];
  return {
    cwd: "/tmp/pi-smart-compact-preflight-test",
    model,
    modelRegistry: {
      getAvailable: () => available,
      find: (provider: string, id: string) => available.find(item => item.provider === provider && item.id === id),
    },
    getContextUsage: () => ({ tokens: totalTokens, contextWindow: model.contextWindow, percent: totalTokens / 1_000 }),
    sessionManager: { buildContextEntries: () => branch, getBranch: () => branch },
    ui: {
      custom: async (factory: any) => {
        const result: { value?: unknown } = {};
        const component = factory({ requestRender: () => {} }, theme, keybindings, (value: unknown) => { result.value = value; });
        custom(component, result);
        return result.value;
      },
    },
  } as any;
}

describe("smart compact preflight UI", () => {
  it("recommends Balanced at normal pressure and explains a viable fallback", () => {
    const plans = new Map([
      ["thorough", preview("thorough", true)], ["balanced", preview("balanced", true)], ["fast", preview("fast", true)],
    ] as const);
    const normal = recommendPreflight(plans);
    expect(normal.mode).toBe("balanced");
    expect(normal.reason).toContain("~64% window pressure");
    expect(normal.reason).toContain("~71% projected saving");
    expect(normal.reason).toContain("~20,000t recent tail");

    plans.set("balanced", preview("balanced", false));
    const fallback = recommendPreflight(plans);
    expect(fallback.mode).toBe("fast");
    expect(fallback.reason).toContain("estimated saving is below 10%");
  });

  it("recommends Fast under severe pressure and mentions tool-heavy shape", () => {
    const plans = new Map(["thorough", "balanced", "fast"].map(mode => {
      const item = preview(mode as ManualPreflight["mode"], true);
      item.contextPercent = 96;
      item.toolPercent = 78;
      return [mode, item] as const;
    }));
    const recommendation = recommendPreflight(plans);
    expect(recommendation.mode).toBe("fast");
    expect(recommendation.reason).toContain("~96% window pressure");
    expect(recommendation.reason).toContain("tool-heavy shape (~78%");
  });

  it("prioritizes Thorough when damage feedback adapted retention", () => {
    const plans = new Map(["thorough", "balanced", "fast"].map(mode => {
      const item = preview(mode as ManualPreflight["mode"], true);
      item.adapted = true;
      item.damageMedian = 40;
      item.contextPercent = 96;
      return [mode, item] as const;
    }));
    const recommendation = recommendPreflight(plans);
    expect(recommendation.mode).toBe("thorough");
    expect(recommendation.reason).toContain("recent damage feedback");
  });

  it("keeps the decision brief and places planner disclosure behind Details", () => {
    const brief = formatPreflightSummary(preview("balanced", true), "openai/summary").join("\n");
    expect(brief).toContain("Plan  90K → ~26K · ~64K saved (71%)");
    expect(brief).toContain("Keep  ~20K recent · summary up to 6K");
    expect(brief).toContain("Complete tool pairs · ✓ zero-gap verification before apply");
    expect(brief).not.toContain("Estimator");

    const details = formatPreflightSummary(preview("balanced", true), "openai/summary", true).join("\n");
    expect(details).toContain("Estimator  ~100,000t messages · normalized ×0.80");
    expect(details).toContain("Boundary  no hard adjustment · soft summarized: older user turn");
    expect(details).toContain("Route  openai/summary");
  });

  it("discloses the verified-state reserve behind the projected result", () => {
    const item = preview("balanced", true);
    item.plan!.projectedAfterTokens = 27_500;
    item.plan!.projectedSavedTokens = 62_500;
    item.plan!.projectedYield = 62_500 / 90_000;
    expect(formatPreflightSummary(item, "openai/summary").join("\n"))
      .toContain("summary up to 6K + ~1.5K verified-state reserve");
  });

  it("renders the three-mode decision card, supports D, and never exceeds width", async () => {
    const result = await showCompactUI(context((component, done) => {
      const narrowLines = component.render(36);
      expect(narrowLines.every((line: string) => visibleWidth(line) <= 36)).toBeTrue();
      const card = component.render(100).join("\n");
      expect(card).toContain("Smart Compact");
      expect(card).toContain("Context  90K / 100K");
      expect(card).toContain("[M] Change");
      expect(card).toContain("Fast");
      expect(card).toContain("Balanced");
      expect(card).toContain("Thorough");
      expect(card).toContain("recommended");
      expect(card).toContain("quickest");
      expect(card).toContain("deepest");
      expect(card).not.toContain("Aggressive");
      expect(card).toContain("Complete tool pairs");
      component.handleInput("d");
      expect(component.render(80).join("\n")).toContain("Estimator");
      component.handleInput("enter");
      expect(done.value).toBeDefined();
    }), opts);
    expect(result?.mode).toBe("fast");
  });

  it("scans the active branch once for all three mode previews", async () => {
    const ctx = context(component => component.handleInput("esc"));
    const original = ctx.sessionManager.buildContextEntries;
    let scans = 0;
    ctx.sessionManager.buildContextEntries = () => {
      scans++;
      return original();
    };

    await showCompactUI(ctx, opts);

    expect(scans).toBe(1);
  });

  it("uses the configured summary route as the initial preflight model", async () => {
    const models = [
      { provider: "openai", id: "summary", contextWindow: 100_000 },
      { provider: "anthropic", id: "configured-summary", contextWindow: 200_000 },
    ];
    const configured = { ...config, summaryModel: "anthropic/configured-summary" };
    const ctx = context((component) => {
      expect(component.render(100).join("\n")).toContain("Summary model  anthropic/configured-summary");
      component.handleInput("enter");
    }, 90_000, models);
    const initial = resolveModels(ctx, ctx.model, configured).sumModel!;
    const defaultModelIndex = models.findIndex(model => model.provider === initial.provider && model.id === initial.id);
    const result = await showCompactUI(ctx, { ...opts, config: configured, defaultModelIndex });
    expect(result?.model.value).toBe("anthropic/configured-summary");
  });

  it("keeps the active model label and recalculates after M changes the summary route", async () => {
    let screens = 0;
    const models = [
      { provider: "openai", id: "summary", contextWindow: 100_000 },
      { provider: "anthropic", id: "advanced-summary", contextWindow: 200_000 },
    ];
    const result = await showCompactUI(context((component) => {
      screens++;
      if (screens === 1) component.handleInput("m");
      else if (screens === 2) {
        const picker = component.render(100).join("\n");
        expect(picker).toContain("Active context: openai/summary");
        component.handleInput("\x1b[B");
        component.handleInput("\r");
      } else {
        expect(component.render(100).join("\n")).toContain("Summary model  anthropic/advanced-summary");
        component.handleInput("esc");
      }
    }, 90_000, models), opts);
    expect(screens).toBe(3);
    expect(result).toBeNull();
  });

  it("explains blocked Enter for non-viable plans and lets Esc cancel", async () => {
    const result = await showCompactUI(context((component, done) => {
      expect(component.render(100).join("\n")).not.toContain("Choose another mode");
      component.handleInput("enter");
      expect(done.value).toBeUndefined();
      expect(component.render(100).join("\n")).toContain("Choose another mode");
      component.handleInput("esc");
    }, 1_000), { ...opts, contextTokens: 1_000, contextPercent: 1 });
    expect(result).toBeNull();
  });
});
