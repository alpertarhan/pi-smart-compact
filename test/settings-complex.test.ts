import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ExtensionCommandContext,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import {
  complexConfigPaths,
  complexSettingsCategories,
  modelSettingsItems,
} from "../src/ui/settings-complex.ts";
import {
  createSettingsController,
  createSettingsRoot,
} from "../src/ui/settings-overlay.ts";
import {
  readGlobalConfigValue,
  resetConfigCache,
  writeGlobalConfigValue,
} from "../src/utils/config.ts";

const originalHome = process.env.HOME;
let home = "";
let renders = 0;

beforeAll(() => initTheme("dark", false));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-complex-"));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  renders = 0;
  resetConfigCache();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  resetConfigCache();
});

function context(models: Array<{ provider: string; id: string; name: string }> = []) {
  return {
    modelRegistry: {
      getAvailable: () =>
        models.map((model) => ({
          ...model,
          api: "test",
          baseUrl: "",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 10_000,
        })),
    },
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext;
}

async function settleActive(component: unknown): Promise<void> {
  let active = component as {
    submenuComponent?: unknown;
    settled?: () => Promise<void>;
  };
  while (active?.submenuComponent) {
    active = active.submenuComponent as typeof active;
  }
  await active?.settled?.();
}

describe("complex settings coverage", () => {
  it("covers every remaining top-level and nested profile setting", () => {
    expect(complexConfigPaths()).toEqual([
      "summaryModel",
      "segmentationModel",
      "verificationModel",
      "minContextPercent",
      "autoTriggerTimeoutMs",
      "maxLlmCalls",
      "maxLlmInputTokens",
      "codexMaxCallMs",
      "maxLatencyMs",
      "backupDir",
      "pinPaths",
      "profiles.light.summaryBudgetTokens",
      "profiles.light.keepRecentTokens",
      "profiles.light.minChunkTokens",
      "profiles.light.maxChunkTokens",
      "profiles.light.singlePassMaxTokens",
      "profiles.light.batchMaxTokens",
      "profiles.balanced.summaryBudgetTokens",
      "profiles.balanced.keepRecentTokens",
      "profiles.balanced.minChunkTokens",
      "profiles.balanced.maxChunkTokens",
      "profiles.balanced.singlePassMaxTokens",
      "profiles.balanced.batchMaxTokens",
      "profiles.aggressive.summaryBudgetTokens",
      "profiles.aggressive.keepRecentTokens",
      "profiles.aggressive.minChunkTokens",
      "profiles.aggressive.maxChunkTokens",
      "profiles.aggressive.singlePassMaxTokens",
      "profiles.aggressive.batchMaxTokens",
    ]);
    expect(
      complexSettingsCategories(context(), () => {}).map((item) => item.id),
    ).toEqual(["models", "limits", "paths", "profiles"]);
  });
});

describe("model settings", () => {
  it("filters available models and persists provider/model IDs", async () => {
    const ctx = context([
      { provider: "zeta", id: "writer", name: "Writer" },
      { provider: "alpha", id: "reasoner", name: "Reasoner" },
    ]);
    const item = modelSettingsItems(ctx, () => renders++)[0];
    const selector = item.submenu?.("default", () => {});
    selector?.handleInput?.("alpha/reasoner");
    expect(selector?.render(100).join("\n")).toContain("Reasoner");
    expect(selector?.render(100).join("\n")).not.toContain("Writer");
    expect(selector?.render(35).join("\n")).toContain("alpha/reasoner");
    selector?.handleInput?.("\r");
    await settleActive(selector);

    expect(readGlobalConfigValue("summaryModel")).toBe("alpha/reasoner");
    expect(item.currentValue).toBe("alpha/reasoner");
    expect(renders).toBeGreaterThan(0);
  });

  it("refreshes the configured model each time the editor opens", async () => {
    const ctx = context([
      { provider: "alpha", id: "reasoner", name: "Reasoner" },
    ]);
    const item = modelSettingsItems(ctx, () => {})[0];
    await writeGlobalConfigValue("summaryModel", "alpha/reasoner");
    const selector = item.submenu?.("default", () => {});

    expect(item.currentValue).toBe("alpha/reasoner");
    expect(selector?.render(35).join("\n")).toContain("alpha/reasoner");
  });

  it("propagates host focus to the active nested search input", () => {
    const ctx = context([
      { provider: "alpha", id: "reasoner", name: "Reasoner" },
    ]);
    const policy = {
      snapshot: () => ({
        agentToolAccess: "inherit",
        agentToolEnabled: true,
        autoTrigger: true,
        showStatus: true,
      }),
      branchOverrides: () => ({}),
    } as any;
    const root = createSettingsRoot(policy, ctx, () => {});
    const controller = createSettingsController(root, root, () => {});
    controller.focused = true;
    for (let index = 0; index < 5; index++) controller.handleInput?.("\x1b[B");
    controller.handleInput?.("\r");
    controller.handleInput?.("\r");

    expect(controller.render(80).join("\n")).toContain(CURSOR_MARKER);
  });

  it("keeps an unavailable configured model visible and resettable", async () => {
    await writeGlobalConfigValue("summaryModel", "offline/missing");
    const item = modelSettingsItems(context(), () => {})[0];
    const selector = item.submenu?.("offline/missing", () => {});
    expect(selector?.render(100).join("\n")).toContain(
      "Configured model is currently unavailable",
    );
    selector?.handleInput?.("\x1b[A");
    selector?.handleInput?.("\r");
    await settleActive(selector);
    expect(readGlobalConfigValue("summaryModel")).toBeUndefined();
  });
});

describe("validated input settings", () => {
  it("rejects invalid numeric input without writing and accepts decimals where valid", async () => {
    const limits = complexSettingsCategories(context(), () => renders++).find(
      (item) => item.id === "limits",
    )!;
    const list = limits.submenu?.("6 settings", () => {});
    list?.handleInput?.("\r");
    list?.handleInput?.("101");
    list?.handleInput?.("\r");
    expect(list?.render(100).join("\n")).toContain("0–100");
    expect(readGlobalConfigValue("minContextPercent")).toBeUndefined();

    list?.handleInput?.("\x15");
    list?.handleInput?.("75.5");
    list?.handleInput?.("\r");
    await settleActive(list);
    expect(readGlobalConfigValue("minContextPercent")).toBe(75.5);
  });

  it("requires an absolute backup directory and deduplicates pinned paths", async () => {
    const paths = complexSettingsCategories(context(), () => {}).find(
      (item) => item.id === "paths",
    )!;
    const list = paths.submenu?.("2 settings", () => {});
    list?.handleInput?.("\r");
    list?.handleInput?.("relative/backups");
    list?.handleInput?.("\r");
    expect(list?.render(100).join("\n")).toContain("absolute path");
    expect(readGlobalConfigValue("backupDir")).toBeUndefined();
    list?.handleInput?.("\x1b");

    list?.handleInput?.("\x1b[B");
    list?.handleInput?.("\r");
    list?.handleInput?.("src/a.ts, src/a.ts, docs/b.md");
    list?.handleInput?.("\r");
    await settleActive(list);
    expect(readGlobalConfigValue("pinPaths")).toEqual([
      "src/a.ts",
      "docs/b.md",
    ]);
  });

  it("surfaces cross-field profile invariants and persists a valid budget", async () => {
    const profiles = complexSettingsCategories(context(), () => {}).find(
      (item) => item.id === "profiles",
    )!;
    const profileList = profiles.submenu?.("3 profiles", () => {});
    profileList?.handleInput?.("\r");
    for (let index = 0; index < 3; index++) profileList?.handleInput?.("\x1b[B");
    profileList?.handleInput?.("\r");
    profileList?.handleInput?.("40000");
    profileList?.handleInput?.("\r");
    await settleActive(profileList);
    expect(profileList?.render(100).join("\n")).toContain(
      "Invalid smartCompact setting",
    );
    expect(
      readGlobalConfigValue("profiles.light.maxChunkTokens"),
    ).toBeUndefined();

    profileList?.handleInput?.("\x15");
    profileList?.handleInput?.("20000");
    profileList?.handleInput?.("\r");
    await settleActive(profileList);
    expect(readGlobalConfigValue("profiles.light.maxChunkTokens")).toBe(
      20_000,
    );
  });
});
