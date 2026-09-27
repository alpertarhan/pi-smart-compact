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
import type { SettingsList } from "@earendil-works/pi-tui";
import type {
  DesiredSmartCompactPolicy,
  SmartCompactPolicy,
} from "../src/app/smart-compact-policy.ts";
import {
  createSettingsRoot,
  GlobalSettingsCoordinator,
  settingsCategoryItems,
  updateGlobalChoiceSetting,
} from "../src/ui/settings-overlay.ts";
import {
  loadConfig,
  readGlobalConfigValue,
  resetConfigCache,
  writeGlobalConfigValue,
} from "../src/utils/config.ts";

function policyHarness() {
  let overrides: Partial<DesiredSmartCompactPolicy> = {};
  const updates: unknown[] = [];
  const resets: string[] = [];
  const policy: SmartCompactPolicy = {
    snapshot: () => ({
      agentToolAccess: overrides.agentToolAccess ?? "inherit",
      agentToolEnabled: true,
      autoTrigger: overrides.autoTrigger ?? true,
      showStatus: overrides.showStatus ?? true,
    }),
    branchOverrides: () => ({ ...overrides }),
    isAgentToolEnabled: () => true,
    isAutoTriggerEnabled: () => overrides.autoTrigger ?? true,
    restore: () => { },
    update: (patch) => {
      updates.push(patch);
      overrides = { ...overrides, ...patch };
      return { ok: true, policy: policy.snapshot() };
    },
    reset: (field) => {
      resets.push(field);
      delete overrides[field];
      return { ok: true, policy: policy.snapshot() };
    },
  };
  return { policy, updates, resets };
}

const ctx = {
  ui: { notify: () => { } },
} as unknown as ExtensionCommandContext;

beforeAll(() => initTheme("dark", false));

const originalHome = process.env.HOME;
let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-overlay-"));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  resetConfigCache();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  resetConfigCache();
});

describe("Smart Compact settings navigation", () => {
  it("opens the branch submenu and Escape returns to parent then closes", () => {
    const { policy } = policyHarness();
    let closed = false;
    const root = createSettingsRoot(policy, ctx, () => {
      closed = true;
    });

    root.selectItem("session");
    root.handleInput("\r");
    root.handleInput("\x1b");
    expect(closed).toBe(false);
    root.handleInput("\x1b");
    expect(closed).toBe(true);
  });

});


/** Open a global category list and select one row. */
function openRow(
  categoryId: string,
  rowId: string,
  coordinator = new GlobalSettingsCoordinator(),
  context = ctx,
  renders: () => void = () => { },
) {
  const category = settingsCategoryItems(policyHarness().policy, context, renders, coordinator).find(
    (item) => item.id === categoryId,
  )!;
  const open = () => {
    const list = category.submenu?.("", () => { }) as SettingsList;
    list.selectItem(rowId);
    return list;
  };
  return { list: open(), reopen: open, coordinator };
}


describe("global boolean and enum settings", () => {

  it("resets to the built-in default and rejects cross-category routing", async () => {
    await updateGlobalChoiceSetting("compaction", "mode", "Thorough");
    expect(readGlobalConfigValue("mode")).toBe("thorough");
    await updateGlobalChoiceSetting("compaction", "mode", "default · Auto (recommended)");
    expect(readGlobalConfigValue("mode")).toBeUndefined();
    await expect(
      updateGlobalChoiceSetting("privacy", "mode", "Fast"),
    ).rejects.toThrow("Unknown global choice setting: mode");
  });

  it("keeps a legacy-only profile effective until Mode is saved and never rewrites it", async () => {
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ smartCompact: { profile: "light" } }),
    );
    resetConfigCache();
    expect(loadConfig().mode).toBe("thorough");
    const { list, coordinator } = openRow("compaction", "mode");
    list.handleInput("\r");
    await coordinator.settled();
    expect(loadConfig().mode).toBe("auto");
    expect(readGlobalConfigValue("profile")).toBe("light");

    list.handleInput("r");
    await coordinator.settled();
    expect(readGlobalConfigValue("mode")).toBeUndefined();
    expect(loadConfig().mode).toBe("thorough");
    expect(readGlobalConfigValue("profile")).toBe("light");
  });

  it("keeps the last committed setting after a queued failure and resumes from that value", async () => {
    await writeGlobalConfigValue("autoTrigger", false);
    let calls = 0;
    const coordinator = new GlobalSettingsCoordinator(async (group, id, display) => {
      calls++;
      if (calls === 2) throw new Error("second write failed");
      return updateGlobalChoiceSetting(group, id, display);
    });
    const { list } = openRow("compaction", "autoTrigger", coordinator);
    list.handleInput("\r");
    list.handleInput("\r");
    await coordinator.settled();
    expect(readGlobalConfigValue("autoTrigger")).toBeUndefined();
    list.handleInput("\r");
    await coordinator.settled();
    expect(readGlobalConfigValue("autoTrigger")).toBe(true);
  });

  it("keeps the newest cross-setting config after a queued failure", async () => {
    await writeGlobalConfigValue("autoTrigger", false);
    let calls = 0;
    const coordinator = new GlobalSettingsCoordinator(async (group, id, display) => {
      calls++;
      if (calls === 3) throw new Error("third write failed");
      return updateGlobalChoiceSetting(group, id, display);
    });
    const { list } = openRow("compaction", "autoTrigger", coordinator);
    list.handleInput("\r");
    list.selectItem("mode");
    list.handleInput("\r");
    list.selectItem("autoTrigger");
    list.handleInput("\r");
    await coordinator.settled();
    expect(readGlobalConfigValue("mode")).toBe("auto");
    expect(readGlobalConfigValue("autoTrigger")).toBeUndefined();
    list.selectItem("mode");
    list.handleInput("\r");
    await coordinator.settled();
    expect(readGlobalConfigValue("mode")).toBe("fast");
  });

  it("shares optimistic state and save ordering across submenu reopen", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let secondStarted!: () => void;
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    const second = new Promise<void>((resolve) => (releaseSecond = resolve));
    const secondStart = new Promise<void>((resolve) => (secondStarted = resolve));
    const calls: string[] = [];
    const coordinator = new GlobalSettingsCoordinator(async (group, id, display) => {
      calls.push(display);
      if (calls.length === 1) await first;
      else {
        secondStarted();
        await second;
      }
      return updateGlobalChoiceSetting(group, id, display);
    });
    const { list, reopen } = openRow("compaction", "mode", coordinator);
    list.handleInput("\r");
    list.handleInput("\x1b");

    const reopened = reopen();
    expect(reopened.render(120).join("\n")).toContain("Auto (recommended)");
    reopened.handleInput("\r");
    expect(calls).toEqual([]);

    await Promise.resolve();
    expect(calls).toEqual(["Auto (recommended)"]);
    releaseFirst();
    await secondStart;
    expect(calls).toEqual(["Auto (recommended)", "Fast"]);
    releaseSecond();
    await coordinator.settled();
    expect(reopen().render(120).join("\n")).toContain("Fast");
  });

  it("rolls a failed async submenu update back and requests a rerender", async () => {
    const notifications: string[] = [];
    let renders = 0;
    const coordinator = new GlobalSettingsCoordinator(async () => {
      throw new Error("settings are read-only");
    });
    const failingCtx = {
      ui: { notify: (message: string) => notifications.push(message) },
    } as unknown as ExtensionCommandContext;
    const { list } = openRow("compaction", "mode", coordinator, failingCtx, () => renders++);
    const before = renders;
    list.handleInput("\r");
    await coordinator.settled();
    expect(list.render(120).join("\n")).toContain("default · Auto (recommended)");
    expect(notifications).toEqual(["settings are read-only"]);
    expect(renders).toBeGreaterThan(before);
  });

  it("refreshes the rollback baseline after an intervening external change", async () => {
    await writeGlobalConfigValue("mode", "fast");
    let fail = false;
    const coordinator = new GlobalSettingsCoordinator(async (group, id, display) => {
      if (fail) throw new Error("write failed");
      return updateGlobalChoiceSetting(group, id, display);
    });
    const { list, reopen } = openRow("compaction", "mode", coordinator);
    list.handleInput("\r");
    await coordinator.settled();
    list.handleInput("\x1b");

    await writeGlobalConfigValue("mode", "thorough");
    const reopened = reopen();
    expect(reopened.render(120).join("\n")).toContain("Thorough");
    fail = true;
    reopened.handleInput("\r");
    await coordinator.settled();
    expect(reopened.render(120).join("\n")).toContain("Thorough");
  });
});
