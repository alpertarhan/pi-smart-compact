import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROFILES } from "../src/constants.ts";
import {
  loadConfig,
  resetConfigCache,
  writeGlobalConfigValue,
} from "../src/utils/config.ts";

const originalHome = process.env.HOME;
let home = "";
let settings = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "smart-compact-config-"));
  process.env.HOME = home;
  const agentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  settings = path.join(agentDir, "settings.json");
  resetConfigCache();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  resetConfigCache();
});

function writeSettings(value: unknown): void {
  fs.writeFileSync(settings, JSON.stringify(value));
  resetConfigCache();
}

describe("loadConfig", () => {
  it("falls back safely when the settings root is not an object", () => {
    writeSettings(["unexpected"]);
    const config = loadConfig();
    expect(config.mode).toBe("auto");
    expect(config.profiles.balanced).toEqual(PROFILES.balanced);
  });

  it("falls back safely when smartCompact is not an object", () => {
    writeSettings({ smartCompact: ["unexpected"] });
    const config = loadConfig();
    expect(config.mode).toBe("auto");
    expect(config.autoTrigger).toBe(true);
  });

  it("does not fall through to the legacy key when the canonical key is null", () => {
    writeSettings({
      smartCompact: null,
      semanticCompact: { autoTrigger: false },
    });
    expect(loadConfig().autoTrigger).toBe(true);
  });

  it("deep-merges partial profile overrides with built-in values", () => {
    writeSettings({
      smartCompact: {
        profiles: { balanced: { summaryBudgetTokens: 7_000 } },
      },
    });
    const config = loadConfig();
    expect(config.profiles.balanced).toEqual({
      ...PROFILES.balanced,
      summaryBudgetTokens: 7_000,
    });
    expect(config.profiles.light).toEqual(PROFILES.light);
  });

  it("discards an override whose merged chunk bounds are inconsistent", () => {
    writeSettings({
      smartCompact: {
        profiles: { balanced: { maxChunkTokens: 30_000 } },
      },
    });
    const config = loadConfig();
    expect(config.profiles.balanced).toEqual(PROFILES.balanced);
  });

  it("isolates cached and default nested values from caller mutation", () => {
    writeSettings({});
    const first = loadConfig();
    first.profiles.balanced.summaryBudgetTokens = 999;
    first.pinPaths.push("mutated");

    const cached = loadConfig();
    expect(cached.profiles.balanced.summaryBudgetTokens).toBe(
      PROFILES.balanced.summaryBudgetTokens,
    );
    expect(cached.pinPaths).toEqual([]);

    resetConfigCache();
    const reloaded = loadConfig();
    expect(reloaded.profiles.balanced).toEqual(PROFILES.balanced);
    expect(reloaded.pinPaths).toEqual([]);
  });
});

describe("writeGlobalConfigValue", () => {
  it("preserves unrelated root and smartCompact keys", async () => {
    writeSettings({
      theme: "dark",
      anotherExtension: { enabled: true },
      smartCompact: {
        autoTrigger: "invalid-but-unrelated",
        futureOption: "preserve-me",
        profiles: {
          balanced: { futureBudget: 123 },
          futureProfile: { futureBudget: 456 },
        },
      },
    });

    const effective = await writeGlobalConfigValue("mode", "thorough");
    expect(effective.mode).toBe("thorough");
    expect(JSON.parse(fs.readFileSync(settings, "utf8"))).toEqual({
      theme: "dark",
      anotherExtension: { enabled: true },
      smartCompact: {
        autoTrigger: "invalid-but-unrelated",
        futureOption: "preserve-me",
        profiles: {
          balanced: { futureBudget: 123 },
          futureProfile: { futureBudget: 456 },
        },
        mode: "thorough",
      },
    });
  });

  it("writes and removes a nested profile override", async () => {
    await writeGlobalConfigValue(
      "profiles.balanced.summaryBudgetTokens",
      7_000,
    );
    expect(loadConfig().profiles.balanced.summaryBudgetTokens).toBe(7_000);

    await writeGlobalConfigValue(
      "profiles.balanced.summaryBudgetTokens",
      undefined,
    );
    const root = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(root.smartCompact.profiles).toBeUndefined();
    expect(loadConfig().profiles.balanced.summaryBudgetTokens).toBe(
      PROFILES.balanced.summaryBudgetTokens,
    );
  });

  it("rejects invalid values without changing the file", async () => {
    writeSettings({ smartCompact: { mode: "balanced" } });
    const before = fs.readFileSync(settings, "utf8");
    await expect(writeGlobalConfigValue("mode", "invalid")).rejects.toThrow(
      "Invalid smartCompact setting: mode",
    );
    expect(fs.readFileSync(settings, "utf8")).toBe(before);
  });

  it("rejects unknown runtime paths before property lookup", async () => {
    writeSettings({ smartCompact: {} });
    await expect(
      writeGlobalConfigValue(
        "profiles.__proto__.summaryBudgetTokens" as any,
        7_000,
      ),
    ).rejects.toThrow("Unknown smartCompact setting path");
    expect(({} as Record<string, unknown>).summaryBudgetTokens).toBeUndefined();
  });

  it("removes the deprecated alias when resetting agent tool access", async () => {
    writeSettings({ smartCompact: { agentToolEnabled: false } });
    await writeGlobalConfigValue("agentToolAccess", undefined);
    const root = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(root.smartCompact.agentToolAccess).toBeUndefined();
    expect(root.smartCompact.agentToolEnabled).toBeUndefined();
    expect(loadConfig().agentToolAccess).toBe("inherit");
  });

  it("rejects malformed JSON without replacing it", async () => {
    fs.writeFileSync(settings, "{ definitely-not-json");
    resetConfigCache();
    const before = fs.readFileSync(settings, "utf8");
    await expect(writeGlobalConfigValue("mode", "fast")).rejects.toThrow();
    expect(fs.readFileSync(settings, "utf8")).toBe(before);
  });

  it("leaves the original intact when the settings lock cannot be acquired", async () => {
    writeSettings({ smartCompact: { mode: "balanced" } });
    const before = fs.readFileSync(settings, "utf8");
    fs.mkdirSync(settings + ".lock");
    try {
      await expect(writeGlobalConfigValue("mode", "fast")).rejects.toThrow(
        "Timed out acquiring lock",
      );
      expect(fs.readFileSync(settings, "utf8")).toBe(before);
    } finally {
      fs.rmSync(settings + ".lock", { recursive: true, force: true });
    }
  });

  it("invalidates the load cache after a successful write", async () => {
    writeSettings({ smartCompact: { autoTrigger: true } });
    expect(loadConfig().autoTrigger).toBe(true);
    await writeGlobalConfigValue("autoTrigger", false);
    expect(loadConfig().autoTrigger).toBe(false);
  });

  it("serializes competing process updates without losing either field", async () => {
    writeSettings({ theme: "dark", smartCompact: {} });
    const moduleUrl = pathToFileURL(
      path.resolve(import.meta.dir, "../src/utils/config.ts"),
    ).href;
    const worker = (setting: string, value: unknown) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `const { writeGlobalConfigValue } = await import(${JSON.stringify(moduleUrl)}); await writeGlobalConfigValue(${JSON.stringify(setting)}, ${JSON.stringify(value)});`,
        ],
        {
          env: { ...process.env, HOME: home },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    const first = worker("mode", "fast");
    const second = worker("autoTrigger", false);
    const [firstExit, secondExit] = await Promise.all([
      first.exited,
      second.exited,
    ]);
    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);
    expect(JSON.parse(fs.readFileSync(settings, "utf8"))).toEqual({
      theme: "dark",
      smartCompact: { mode: "fast", autoTrigger: false },
    });
  });
});
