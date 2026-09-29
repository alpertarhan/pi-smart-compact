import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  GlobalSettingsCoordinator,
  invalidSettingsLine,
  settingsCategoryItems,
} from "../src/ui/settings-overlay.ts";
import { SmartSettingsList } from "../src/ui/settings-list.ts";
import {
  loadConfig,
  readGlobalConfigValue,
  resetConfigCache,
  writeGlobalConfigValue,
} from "../src/utils/config.ts";
import { recentIssues, resetIssuesForTests } from "../src/utils/issues.ts";

const originalHome = process.env.HOME;
let home = "";

beforeAll(() => initTheme("dark", false));
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-tui-"));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  resetConfigCache();
  resetIssuesForTests();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  process.env.HOME = originalHome;
  resetConfigCache();
  resetIssuesForTests();
});

const notices: string[] = [];
const ctx = {
  ui: { notify: (message: string) => notices.push(message) },
  modelRegistry: { getAvailable: () => [] },
} as unknown as ExtensionCommandContext;

function policy(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: () => ({ agentToolAccess: "inherit", agentToolEnabled: true, autoTrigger: true, showStatus: true }),
    branchOverrides: () => ({ ...overrides }),
    update: () => ({ ok: true, policy: { agentToolAccess: "inherit", agentToolEnabled: true, autoTrigger: true, showStatus: true } }),
    reset: (field: string) => {
      delete overrides[field];
      return { ok: true, policy: { agentToolAccess: "inherit", agentToolEnabled: true, autoTrigger: true, showStatus: true } };
    },
  } as any;
}

function open(categoryId: string, coordinator = new GlobalSettingsCoordinator(), branch = policy()) {
  const categories = settingsCategoryItems(branch, ctx, () => { }, coordinator);
  const category = categories.find((item) => item.id === categoryId)!;
  const list = category.submenu!("", () => { }) as SmartSettingsList;
  return { list, category, categories, coordinator };
}

describe("rendered display values", () => {
  it("never leak into stored values when a narrow row is cycled", async () => {
    await writeGlobalConfigValue("autoTrigger", false); // makes the timing row inactive
    const { list, coordinator } = open("compaction");
    list.render(44); // inactive/cut-off display text is render-only
    list.selectItem("autoTriggerStrategy");
    list.handleInput("\r");
    await coordinator.settled();
    expect(readGlobalConfigValue("autoTriggerStrategy")).toBe("native-hook"); // default → first explicit value
  });
});

describe("settings layout", () => {

  it("cycles engine presets without storing display labels", async () => {
    const { list, coordinator } = open("compaction");
    list.selectItem("compactionEngines");
    list.handleInput("\r");
    list.handleInput("\r");
    await coordinator.settled();
    expect(readGlobalConfigValue("compactionEngines")).toEqual(["native", "eesv"]);
  });
});


describe("prepare threshold row", () => {
  it("rejects an invalid prepare threshold without storing it", async () => {
    await writeGlobalConfigValue("autoTriggerStrategy", "background");
    await writeGlobalConfigValue("minContextPercent", 65);
    await expect(writeGlobalConfigValue("prepareContextPercent", 70)).rejects.toThrow();
    const { list } = open("compaction");
    list.selectItem("prepareContextPercent");
    list.handleInput("\r");
    for (const ch of "65") list.handleInput(ch);
    list.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readGlobalConfigValue("prepareContextPercent")).toBeUndefined();
  });

  it("refuses to lower the apply gate below an explicit prepare value", async () => {
    await writeGlobalConfigValue("minContextPercent", 90);
    await writeGlobalConfigValue("prepareContextPercent", 80);
    await expect(writeGlobalConfigValue("minContextPercent", 80)).rejects.toThrow();
    // Resetting the apply gate to its default (80) is refused for the same reason.
    await expect(writeGlobalConfigValue("minContextPercent", undefined)).rejects.toThrow();
    expect(readGlobalConfigValue("minContextPercent")).toBe(90);
    // A refused write never reaches disk, so it must not be reported as a settings.json problem.
    expect(recentIssues().filter((issue) => issue.key.startsWith("config."))).toEqual([]);
  });
});

describe("reset key", () => {
  it("resets the selected choice row to its default", async () => {
    await writeGlobalConfigValue("mode", "thorough");
    const { list, coordinator } = open("compaction");
    list.selectItem("mode");
    list.handleInput("r");
    await coordinator.settled();
    expect(readGlobalConfigValue("mode")).toBeUndefined();
  });

  it("resets an input row, and never resets while its inline editor is open", async () => {
    await writeGlobalConfigValue("minContextPercent", 70);
    const { list } = open("compaction");
    list.selectItem("minContextPercent");
    list.handleInput("\r"); // open inline editor
    list.handleInput("\x15");
    list.handleInput("r");
    list.handleInput("\r"); // "r" is not a number
    expect(list.render(160).join("\n")).toContain("0–100");
    expect(readGlobalConfigValue("minContextPercent")).toBe(70);
    list.handleInput("\x1b"); // close editor

    list.handleInput("r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readGlobalConfigValue("minContextPercent")).toBeUndefined();
  });

});

describe("root summary", () => {
  it("counts changed settings per category and branch overrides", async () => {
    await writeGlobalConfigValue("mode", "fast");
    await writeGlobalConfigValue("scrubPii", true);
    const categories = settingsCategoryItems(policy({ showStatus: false }), ctx);
    const value = (id: string) => categories.find((item) => item.id === id)!.currentValue;
    expect(value("compaction")).toBe("1 changed");
    expect(value("privacy")).toBe("1 changed");
    expect(value("session")).toBe("1 overridden");
  });

  it("summarizes ignored settings.json values from the issue history", () => {
    expect(invalidSettingsLine()).toBeNull();
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ smartCompact: { hindsightTimeoutMs: 5, mode: "aggressive" } }),
    );
    resetConfigCache();
    loadConfig();
    const line = invalidSettingsLine()!;
    expect(line).toContain("hindsightTimeoutMs");
    expect(line).toContain("mode");
  });
});
