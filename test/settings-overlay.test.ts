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
import type {
  DesiredSmartCompactPolicy,
  SmartCompactPolicy,
} from "../src/app/smart-compact-policy.ts";
import {
  createSettingsRoot,
  GlobalSettingsCoordinator,
  globalChoiceSettingsItems,
  sessionSettingsItems,
  settingsCategoryItems,
  updateSessionSetting,
  updateGlobalChoiceSetting,
} from "../src/ui/settings-overlay.ts";
import {
  type GlobalConfigValue,
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
    restore: () => {},
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
  ui: { notify: () => {} },
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
  it("keeps all existing branch controls in the Current branch category", () => {
    const { policy } = policyHarness();
    expect(sessionSettingsItems(policy).map((item) => item.id)).toEqual([
      "agentToolAccess",
      "autoTrigger",
      "showStatus",
    ]);

    const categories = settingsCategoryItems(policy, ctx);
    expect(categories.map((item) => item.id)).toEqual([
      "session",
      "behavior",
      "reasoning",
      "safety",
      "advanced",
      "models",
      "limits",
      "paths",
      "profiles",
    ]);
    expect(categories[0].submenu).toBeFunction();
  });

  it("opens the branch submenu and Escape returns to parent then closes", () => {
    const { policy } = policyHarness();
    let closed = false;
    const root = createSettingsRoot(policy, ctx, () => {
      closed = true;
    });

    root.handleInput("\r");
    expect(root.render(100).join("\n")).toContain("Agent access");
    root.handleInput("\x1b");
    expect(root.render(100).join("\n")).toContain("Current branch");
    expect(closed).toBe(false);
    root.handleInput("\x1b");
    expect(closed).toBe(true);
  });

  it("refreshes the effective description after a successful update", () => {
    const { policy } = policyHarness();
    const category = settingsCategoryItems(policy, ctx)[0];
    const submenu = category.submenu?.("3 settings", () => {});

    submenu?.handleInput?.("\x1b[B");
    submenu?.handleInput?.("\r");
    submenu?.handleInput?.("\r");
    expect(submenu?.render(100).join("\n")).toContain(
      "Effective value: disabled",
    );
  });

  it("restores the displayed value and notifies when persistence fails", () => {
    const test = policyHarness();
    const notifications: string[] = [];
    test.policy.update = () => ({
      ok: false,
      policy: test.policy.snapshot(),
      error: "read-only session",
    });
    const failingCtx = {
      ui: { notify: (message: string) => notifications.push(message) },
    } as unknown as ExtensionCommandContext;
    const category = settingsCategoryItems(test.policy, failingCtx)[0];
    const submenu = category.submenu?.("3 settings", () => {});

    submenu?.handleInput?.("\r");
    expect(submenu?.render(100).join("\n")).toContain("global");
    expect(notifications).toEqual(["read-only session"]);
  });

  it("routes explicit values and global reset exhaustively", () => {
    const { policy, updates, resets } = policyHarness();
    updateSessionSetting(policy, ctx, "agentToolAccess", "disabled");
    updateSessionSetting(policy, ctx, "autoTrigger", "disabled");
    updateSessionSetting(policy, ctx, "showStatus", "enabled");
    updateSessionSetting(policy, ctx, "autoTrigger", "global");

    expect(updates).toEqual([
      { agentToolAccess: "disabled" },
      { autoTrigger: false },
      { showStatus: true },
    ]);
    expect(resets).toEqual(["autoTrigger"]);
    expect(() =>
      updateSessionSetting(policy, ctx, "unknown", "enabled"),
    ).toThrow("Unknown session setting");
  });
});

describe("global boolean and enum settings", () => {
  const groups = ["behavior", "reasoning", "safety", "advanced"] as const;

  it("exposes every boolean and enum CompactConfig field", () => {
    const ids = groups.flatMap((group) =>
      globalChoiceSettingsItems(group, loadConfig()).map((item) => item.id),
    );
    expect(ids).toEqual([
      "mode",
      "profile",
      "agentToolAccess",
      "autoTrigger",
      "showStatus",
      "autoTriggerStrategy",
      "summaryThinkingLevel",
      "segmentationThinkingLevel",
      "backupEnabled",
      "requireApproval",
      "scrubSecrets",
      "scrubPii",
      "contextGraphEnabled",
      "focusWeighting",
      "zeroCallEnabled",
      "telemetryChannel",
      "adaptiveDamageFeedback",
      "onlineDamageMonitor",
    ]);
  });

  it("persists one typed value for every simple global setting", async () => {
    const expected = new Map<string, GlobalConfigValue>();
    for (const group of groups) {
      const items = globalChoiceSettingsItems(group, loadConfig());
      for (const item of items) {
        const display = item.values?.[1];
        expect(display).toBeDefined();
        await updateGlobalChoiceSetting(group, item.id, display!);
        const value =
          display === "enabled"
            ? true
            : display === "disabled"
              ? false
              : display === "provider default"
                ? null
                : display;
        expected.set(item.id, value);
      }
    }

    for (const [id, value] of expected) {
      expect(readGlobalConfigValue(id as any)).toEqual(value);
    }
  });

  it("resets to the built-in default and rejects cross-category routing", async () => {
    await updateGlobalChoiceSetting("behavior", "mode", "thorough");
    await updateGlobalChoiceSetting("behavior", "mode", "default");
    expect(readGlobalConfigValue("mode")).toBeUndefined();
    await expect(
      updateGlobalChoiceSetting("safety", "mode", "fast"),
    ).rejects.toThrow("Unknown global choice setting: mode");
  });

  it("displays the migrated legacy agent-tool setting", () => {
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ smartCompact: { agentToolEnabled: false } }),
    );
    resetConfigCache();
    const item = globalChoiceSettingsItems("behavior", loadConfig()).find(
      (candidate) => candidate.id === "agentToolAccess",
    );
    expect(item?.currentValue).toBe("disabled");
  });

  it("refreshes dependent effective descriptions after a profile change", async () => {
    const coordinator = new GlobalSettingsCoordinator();
    const behavior = settingsCategoryItems(
      policyHarness().policy,
      ctx,
      () => {},
      coordinator,
    ).find((item) => item.id === "behavior")!;
    const list = behavior.submenu?.("6 settings", () => {});

    list?.handleInput?.("\x1b[B");
    list?.handleInput?.("\r");
    await coordinator.settled();
    list?.handleInput?.("\x1b[A");

    expect(list?.render(100).join("\n")).toContain(
      "Effective global value: thorough",
    );
  });

  it("restores dependent descriptions after queued success then failure", async () => {
    let calls = 0;
    const coordinator = new GlobalSettingsCoordinator(
      async (group, id, display) => {
        calls++;
        if (calls === 2) throw new Error("second write failed");
        return updateGlobalChoiceSetting(group, id, display);
      },
    );
    const behavior = settingsCategoryItems(
      policyHarness().policy,
      ctx,
      () => {},
      coordinator,
    ).find((item) => item.id === "behavior")!;
    const list = behavior.submenu?.("6 settings", () => {});

    list?.handleInput?.("\x1b[B");
    list?.handleInput?.("\r");
    list?.handleInput?.("\r");
    await coordinator.settled();
    list?.handleInput?.("\x1b[A");

    const rendered = list?.render(100).join("\n");
    expect(rendered).toContain("Effective global value: thorough");
    expect(readGlobalConfigValue("profile")).toBe("light");
  });

  it("keeps the newest cross-setting config after a queued failure", async () => {
    let calls = 0;
    const coordinator = new GlobalSettingsCoordinator(
      async (group, id, display) => {
        calls++;
        if (calls === 3) throw new Error("third write failed");
        return updateGlobalChoiceSetting(group, id, display);
      },
    );
    const behavior = settingsCategoryItems(
      policyHarness().policy,
      ctx,
      () => {},
      coordinator,
    ).find((item) => item.id === "behavior")!;
    const list = behavior.submenu?.("6 settings", () => {});

    list?.handleInput?.("\x1b[B");
    list?.handleInput?.("\r");
    list?.handleInput?.("\x1b[A");
    list?.handleInput?.("\r");
    list?.handleInput?.("\x1b[B");
    list?.handleInput?.("\r");
    await coordinator.settled();
    list?.handleInput?.("\x1b[A");

    expect(list?.render(100).join("\n")).toContain(
      "Effective global value: auto",
    );
    expect(readGlobalConfigValue("mode")).toBe("auto");
    expect(readGlobalConfigValue("profile")).toBe("light");
  });

  it("shares optimistic state and save ordering across submenu reopen", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let secondStarted!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const secondStart = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const calls: string[] = [];
    const coordinator = new GlobalSettingsCoordinator(
      async (group, id, display) => {
        calls.push(display);
        if (calls.length === 1) await first;
        else {
          secondStarted();
          await second;
        }
        return updateGlobalChoiceSetting(group, id, display);
      },
    );
    const categories = settingsCategoryItems(
      policyHarness().policy,
      ctx,
      () => {},
      coordinator,
    );
    const behavior = categories.find((item) => item.id === "behavior")!;
    const firstList = behavior.submenu?.("6 settings", () => {});
    firstList?.handleInput?.("\r");
    firstList?.handleInput?.("\x1b");

    const reopened = behavior.submenu?.("6 settings", () => {});
    expect(reopened?.render(100).join("\n")).toContain("auto");
    reopened?.handleInput?.("\r");
    expect(calls).toEqual([]);

    await Promise.resolve();
    expect(calls).toEqual(["auto"]);
    releaseFirst();
    await secondStart;
    expect(calls).toEqual(["auto", "fast"]);
    releaseSecond();
    await coordinator.settled();

    const finalList = behavior.submenu?.("6 settings", () => {});
    expect(finalList?.render(100).join("\n")).toContain("fast");
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
    const behavior = settingsCategoryItems(
      policyHarness().policy,
      failingCtx,
      () => renders++,
      coordinator,
    ).find((item) => item.id === "behavior")!;
    const list = behavior.submenu?.("6 settings", () => {});

    list?.handleInput?.("\r");
    await coordinator.settled();
    expect(list?.render(100).join("\n")).toContain("default");
    expect(notifications).toEqual(["settings are read-only"]);
    expect(renders).toBe(1);
  });

  it("refreshes the rollback baseline after an intervening external change", async () => {
    await writeGlobalConfigValue("mode", "fast");
    let fail = false;
    const coordinator = new GlobalSettingsCoordinator(
      async (group, id, display) => {
        if (fail) throw new Error("write failed");
        return updateGlobalChoiceSetting(group, id, display);
      },
    );
    const behavior = settingsCategoryItems(
      policyHarness().policy,
      ctx,
      () => {},
      coordinator,
    ).find((item) => item.id === "behavior")!;
    const first = behavior.submenu?.("6 settings", () => {});
    first?.handleInput?.("\r");
    await coordinator.settled();
    first?.handleInput?.("\x1b");

    await writeGlobalConfigValue("mode", "thorough");
    const reopened = behavior.submenu?.("6 settings", () => {});
    expect(reopened?.render(100).join("\n")).toContain("thorough");
    fail = true;
    reopened?.handleInput?.("\r");
    await coordinator.settled();
    expect(reopened?.render(100).join("\n")).toContain("thorough");
  });
});
