import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ExtensionCommandContext, initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, type TUI } from "@earendil-works/pi-tui";
import type {
  AnchorQuery,
  AnchorRecallQuery,
  AnchorRecord,
  NavigationPanelActions,
} from "../src/app/navigation-types.ts";
import type { SmartCompactPolicy } from "../src/app/smart-compact-policy.ts";
import { createHomeList, type HomeAction, type HomeOptions, showSmartCompactHome } from "../src/ui/home-overlay.ts";
import type { DeferredTrim } from "../src/app/register-smart-context-tool.ts";
import { createNavigationPanel, type DeferredNavigation } from "../src/ui/navigation-overlay.ts";
import { INACTIVE_PREFIX, type SmartSettingsList } from "../src/ui/settings-list.ts";
import { GlobalSettingsCoordinator, settingsCategoryItems } from "../src/ui/settings-overlay.ts";
import { readGlobalConfigValue, resetConfigCache, writeGlobalConfigValue } from "../src/utils/config.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const NEWLINE = "\n"; // Ctrl+J, Pi's portable newline key
const SHIFT_ENTER = "\x1b[13;2~";

beforeAll(() => initTheme("dark", false));

const originalHome = process.env.HOME;
let home = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "navigation-overlay-"));
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

function anchor(index: number): AnchorRecord {
  return {
    id: "entry-" + index,
    data: { name: "anchor-" + index, targetId: "target-" + index, summary: "summary " + index },
    onBranch: true,
    timestamp: "2026-09-27T10:00:00.000Z",
  };
}

function harness(overrides: { mutationBlocked?: string; pivot?: boolean } = {}, count = 3, failCreates = 0) {
  const anchors = Array.from({ length: count }, (_, index) => anchor(index));
  const calls = {
    list: [] as AnchorQuery[],
    recall: [] as AnchorRecallQuery[],
    create: [] as string[][],
    pivot: [] as Array<[string, string, string | undefined]>,
    guide: 0,
  };
  const actions: NavigationPanelActions = {
    availability: () => ({ enabled: true, recall: true, pivot: true, guidance: true, ...overrides }),
    list: (query = {}) => {
      calls.list.push(query);
      const matching = anchors.filter((item) => !query.keyword || item.data.name.includes(query.keyword));
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 30;
      const page = matching.slice(offset, offset + limit);
      return { anchors: page, total: matching.length, nextOffset: offset + limit < matching.length ? offset + limit : null };
    },
    recall: (query = {}) => {
      calls.recall.push(query);
      return Promise.withResolvers<never>().promise; // stays pending until aborted
    },
    create: async (name, summary) => {
      calls.create.push([name, summary]);
      return calls.create.length > failCreates ? { ok: true, message: "Anchor saved." } : { ok: false, message: "Session is busy." };
    },
    pivot: async (target, carryover, message) => {
      calls.pivot.push([target, carryover, message]);
      return { ok: true, message: "Returned." };
    },
    guide: async () => {
      calls.guide++;
      return "guide text";
    },
  };
  let closed = false;
  let after: DeferredNavigation | undefined;
  const panel = createNavigationPanel(actions, {
    close: (deferred) => {
      closed = true;
      after = deferred;
    },
    requestRender: () => { },
    notify: () => { },
    theme: { fg: (_color, text) => text, bold: (text) => text },
    tui: { terminal: { rows: 40, columns: 80 }, requestRender: () => { } } as unknown as TUI,
    keybindings: getKeybindings() as KeybindingsManager, // app-level keys (external editor) stay unmatched
  });
  const handleInput = panel.handleInput?.bind(panel);
  if (!handleInput) throw new Error("Navigation panel has no keyboard input handler");
  const interactive = Object.assign(panel, { handleInput });
  const type = (text: string) => {
    for (const char of text) interactive.handleInput(char);
  };
  return { panel: interactive, calls, type, closed: () => closed, after: () => after };
}

/** Root → Anchors → first anchor → Return to this anchor. */
function openPivot(h: Pick<ReturnType<typeof harness>, "panel">) {
  h.panel.handleInput(ENTER); // Anchors in this session
  h.panel.handleInput(DOWN); // past Filter
  h.panel.handleInput(ENTER); // inspect anchor-0
  h.panel.handleInput(ENTER); // Return to this anchor
}

describe("session navigation panel", () => {
  it("requires carryover, defaults the confirmation to going back, and pivots only after closing", async () => {
    const h = harness();
    openPivot(h);
    h.panel.handleInput(ENTER); // empty carryover is refused
    h.type("keep the parser fix");
    h.panel.handleInput(NEWLINE);
    h.panel.handleInput(SHIFT_ENTER);
    h.type("then wire the flags");
    h.panel.handleInput(ENTER);
    h.type("continue");
    h.panel.handleInput(NEWLINE);
    h.type("with tests");
    h.panel.handleInput(ENTER);
    h.panel.handleInput(ENTER); // default row goes back to the message step
    expect(h.closed()).toBe(false);
    h.panel.handleInput(ENTER); // message kept → confirmation again
    h.panel.handleInput(DOWN);
    h.panel.handleInput(ENTER);
    expect(h.closed()).toBe(true);
    expect(h.calls.pivot).toEqual([]);
    await h.after()!();
    expect(h.calls.pivot).toEqual([["entry-0", "keep the parser fix\n\nthen wire the flags", "continue\nwith tests"]]);
  });

  it("keeps typed carryover when stepping back from the message", async () => {
    const h = harness();
    openPivot(h);
    h.type("first");
    h.panel.handleInput(NEWLINE);
    h.panel.handleInput(NEWLINE);
    h.type("second");
    h.panel.handleInput(ENTER);
    h.panel.handleInput(ESC); // back to carryover
    h.panel.handleInput(ENTER); // resubmit what was typed
    h.panel.handleInput(ENTER); // no message
    h.panel.handleInput(DOWN);
    h.panel.handleInput(ENTER);
    await h.after()!();
    expect(h.calls.pivot).toEqual([["entry-0", "first\n\nsecond", undefined]]);
  });

  it("sends no message when the optional step is left empty", async () => {
    const h = harness();
    openPivot(h);
    h.type("carry");
    h.panel.handleInput(ENTER);
    h.panel.handleInput(ENTER);
    h.panel.handleInput(DOWN);
    h.panel.handleInput(ENTER);
    await h.after()!();
    expect(h.calls.pivot).toEqual([["entry-0", "carry", undefined]]);
  });

  it("backs out of every step with Esc and closes without any mutation", () => {
    const h = harness();
    openPivot(h);
    h.type("carry");
    h.panel.handleInput(ENTER);
    for (let step = 0; step < 5; step++) h.panel.handleInput(ESC); // message, carryover, detail, anchors, root
    expect(h.closed()).toBe(true);
    expect(h.after()).toBeUndefined();
    expect(h.calls.pivot).toEqual([]);
    expect(h.calls.create).toEqual([]);
  });

  it("keeps create and pivot unreachable while mutation is blocked", () => {
    const h = harness({ mutationBlocked: "Agent is running." });
    expect(h.panel.render(80).join("\n")).toContain(INACTIVE_PREFIX);
    h.panel.handleInput(DOWN);
    h.panel.handleInput(ENTER); // Mark this point: blocked
    h.type("name");
    h.panel.handleInput(ENTER);
    expect(h.calls.create).toEqual([]);
    h.panel.handleInput(ESC);
    expect(h.closed()).toBe(true);

    const p = harness({ pivot: false });
    openPivot(p);
    p.type("carry");
    p.panel.handleInput(ENTER);
    p.panel.handleInput(DOWN);
    p.panel.handleInput(ENTER);
    expect(p.closed()).toBe(false);
  });

  it("creates a named anchor only after both name and summary are given, keeping the summary after a failed save", async () => {
    const h = harness({}, 3, 1);
    h.panel.handleInput(DOWN);
    h.panel.handleInput(ENTER); // Mark this point
    h.panel.handleInput(ENTER); // empty name refused
    h.type("before-refactor");
    h.panel.handleInput(ENTER);
    h.panel.handleInput(ENTER); // empty summary refused
    expect(h.calls.create).toEqual([]);
    h.type("parser works");
    h.panel.handleInput(NEWLINE);
    h.panel.handleInput(NEWLINE);
    h.type("next: flags");
    h.panel.handleInput(ENTER);
    await Promise.resolve();
    h.panel.handleInput(ENTER); // first save failed; the same text is still there
    await Promise.resolve();
    const saved = ["before-refactor", "parser works\n\nnext: flags"];
    expect(h.calls.create).toEqual([saved, saved]);
    h.panel.handleInput(ESC); // back on the root list
    expect(h.closed()).toBe(true);
  });

  it("pages and filters anchors through list queries", () => {
    const h = harness({}, 10);
    h.panel.handleInput(ENTER);
    for (let row = 0; row < 9; row++) h.panel.handleInput(DOWN); // Filter + 8 anchors → Next page
    h.panel.handleInput(ENTER);
    expect(h.calls.list.at(-1)).toMatchObject({ offset: 8 });
    h.panel.handleInput(ENTER); // Filter on the new page
    h.type("anchor-9");
    h.panel.handleInput(ENTER);
    expect(h.calls.list.at(-1)).toMatchObject({ keyword: "anchor-9", offset: 0 });
  });

  it("searches this project by default, all projects only when chosen, and aborts on Esc", () => {
    const h = harness();
    h.panel.handleInput(DOWN);
    h.panel.handleInput(DOWN);
    h.panel.handleInput(ENTER); // Search other sessions
    h.panel.handleInput(DOWN);
    h.panel.handleInput(DOWN);
    h.panel.handleInput(ENTER); // Search
    expect(h.calls.recall.at(-1)?.scope).toBe("cwd");
    h.panel.handleInput(ESC);
    expect(h.calls.recall.at(-1)?.signal?.aborted).toBe(true);

    h.panel.handleInput(DOWN); // back on Search; wraps to Where
    h.panel.handleInput(ENTER); // Where → All projects
    h.panel.handleInput(DOWN);
    h.panel.handleInput(DOWN);
    h.panel.handleInput(ENTER);
    expect(h.calls.recall.at(-1)?.scope).toBe("all");
  });

  it("reads the guide only when opened", async () => {
    const h = harness();
    expect(h.calls.guide).toBe(0);
    for (let row = 0; row < 3; row++) h.panel.handleInput(DOWN);
    h.panel.handleInput(ENTER);
    await Promise.resolve();
    expect(h.calls.guide).toBe(1);
  });
});

describe("navigation settings", () => {
  const ctx = { ui: { notify: () => { } } } as unknown as ExtensionCommandContext;
  const policy = {
    snapshot: () => ({ agentToolAccess: "inherit", agentToolEnabled: true, autoTrigger: true, showStatus: true }),
    branchOverrides: () => ({}),
  } as unknown as SmartCompactPolicy;

  it("keeps explicit sub-feature values while the master switch makes them inactive", async () => {
    await writeGlobalConfigValue("contextPivotEnabled", false);
    const coordinator = new GlobalSettingsCoordinator();
    const category = settingsCategoryItems(policy, ctx, () => { }, coordinator).find((item) => item.id === "navigation")!;
    const list = category.submenu!("", () => { }) as SmartSettingsList;
    const pivotRow = () => list.render(120).find((line) => line.includes("Return to an anchor"))!;
    expect(pivotRow()).not.toContain(INACTIVE_PREFIX);

    list.selectItem("contextNavigationEnabled");
    list.handleInput(ENTER); // default → enabled
    list.handleInput(ENTER); // enabled → disabled
    await coordinator.settled();
    expect(readGlobalConfigValue("contextNavigationEnabled")).toBe(false);
    expect(pivotRow()).toContain(INACTIVE_PREFIX);
    expect(readGlobalConfigValue("contextPivotEnabled")).toBe(false);

    list.handleInput(ENTER); // disabled → default (on)
    await coordinator.settled();
    expect(pivotRow()).not.toContain(INACTIVE_PREFIX);
    expect(readGlobalConfigValue("contextPivotEnabled")).toBe(false);
  });

  it("stores tool loading as its config value", async () => {
    const coordinator = new GlobalSettingsCoordinator();
    const applied: string[] = [];
    const category = settingsCategoryItems(policy, ctx, () => { }, coordinator, (id) => {
      applied.push(id);
    }).find((item) => item.id === "navigation")!;
    const list = category.submenu!("", () => { }) as SmartSettingsList;
    list.selectItem("toolLoading");
    list.handleInput(ENTER);
    list.handleInput(ENTER);
    await coordinator.settled();
    expect(readGlobalConfigValue("toolLoading")).toBe("eager");
    expect(applied).toEqual(["toolLoading", "toolLoading"]);
  });
});

describe("home navigation entry", () => {
  function home(enabled: boolean, row = 0) {
    const finished: Array<HomeAction | undefined> = [];
    const actions = harnessActions(enabled);
    const list = createHomeList({
      ctx: { ui: { notify: () => { } }, modelRegistry: { getAvailable: () => [] } } as unknown as ExtensionCommandContext,
      policy: {
        snapshot: () => ({ agentToolAccess: "inherit", agentToolEnabled: true, autoTrigger: true, showStatus: true }),
        branchOverrides: () => ({}),
      } as unknown as SmartCompactPolicy,
      coordinator: new GlobalSettingsCoordinator(),
      onApplied: () => { },
      applyPatch: async () => { throw new Error("unused"); },
      compactNow: () => ({ value: "ok" }),
      readiness: () => Promise.withResolvers<never>().promise,
      effectiveState: async () => "",
      navigation: actions,
    }, (action) => finished.push(action), () => { });
    list.selectItem("history");
    list.handleInput(ENTER);
    for (let index = 0; index < row; index++) list.handleInput(DOWN);
    list.handleInput(ENTER); // row 0: Session navigation, row 1: Hand off to a new session
    return finished;
  }

  function harnessActions(enabled: boolean): NavigationPanelActions {
    return {
      availability: () => ({ enabled, recall: true, pivot: true, guidance: true }),
      list: () => ({ anchors: [], total: 0, nextOffset: null }),
      recall: async () => ({ anchors: [], total: 0, nextOffset: null }),
      create: async () => ({ ok: true, message: "" }),
      pivot: async () => ({ ok: true, message: "" }),
      guide: async () => "",
    };
  }

  it("opens navigation from History & recovery only while it is enabled", () => {
    expect(home(true)).toEqual(["navigation"]);
    expect(home(false)).toEqual([]);
  });

  it("offers the handoff from History & recovery", () => {
    expect(home(true, 1)).toEqual(["handoff"]);
  });

  it("shows a held automatic trim on the cleanup row and still queues it on select", () => {
    const finished: Array<HomeAction | undefined> = [];
    const build = (deferred: DeferredTrim | null) => createHomeList({
      ctx: { ui: { notify: () => { } }, modelRegistry: { getAvailable: () => [] } } as unknown as ExtensionCommandContext,
      policy: {
        snapshot: () => ({ agentToolAccess: "inherit", agentToolEnabled: true, autoTrigger: true, showStatus: true }),
        branchOverrides: () => ({}),
      } as unknown as SmartCompactPolicy,
      coordinator: new GlobalSettingsCoordinator(),
      onApplied: () => { },
      applyPatch: async () => { throw new Error("unused"); },
      compactNow: () => ({ value: "ok" }),
      readiness: () => Promise.withResolvers<never>().promise,
      effectiveState: async () => "",
      deferredTrim: () => deferred,
    }, (action) => finished.push(action), () => { });
    const held = build({ savedTokens: 12_400, tailTokens: 90_000, breakEvenRequests: 40.2 });
    held.selectItem("trim");
    const text = (list: ReturnType<typeof createHomeList>) => list.render(400).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    expect(text(held)).toContain("held for a cold cache");
    expect(text(held)).toContain("Saves ~12k tokens, but it pays back its cache rewrite only after 41 requests (limit 24), so it waits for a cold prompt cache. Choose to apply it at the next completed turn instead.");
    held.handleInput(ENTER);
    expect(finished).toEqual(["trim"]);
    const unpriced = build({ savedTokens: 900, tailTokens: 5_000, breakEvenRequests: null });
    unpriced.selectItem("trim");
    expect(text(unpriced)).toContain("Saves ~900 tokens, but the model's cache price is unknown, so it waits for a cold prompt cache.");
    expect(text(build(null))).toContain("no model call");
  });
});

describe("home settings", () => {
  function options(overrides: Partial<HomeOptions> = {}): HomeOptions {
    return {
      ctx: { ui: { notify: () => { } }, modelRegistry: { getAvailable: () => [] } } as unknown as ExtensionCommandContext,
      policy: {
        snapshot: () => ({ agentToolAccess: "inherit", agentToolEnabled: true, autoTrigger: true, showStatus: true }),
        branchOverrides: () => ({}),
      } as unknown as SmartCompactPolicy,
      coordinator: new GlobalSettingsCoordinator(),
      onApplied: () => { },
      applyPatch: async () => { throw new Error("unused"); },
      compactNow: () => ({ value: "ok" }),
      readiness: () => Promise.withResolvers<never>().promise,
      effectiveState: async () => "",
      ...overrides,
    };
  }
  /** The innermost open list: keys typed at Home reach it. */
  function leaf(list: SmartSettingsList): SmartSettingsList & { settled?: () => Promise<void> } {
    // submenuComponent is a private pi-tui field; read it untyped.
    let active = list as unknown as Record<string, unknown>;
    while (active.submenuComponent) active = active.submenuComponent as Record<string, unknown>;
    return active as unknown as SmartSettingsList & { settled?: () => Promise<void> };
  }
  const text = (list: SmartSettingsList) => list.render(400).join("\n").replace(/\u001b\[[0-9;]*m/g, "");

  it("applies input settings edited through Settings live", async () => {
    await writeGlobalConfigValue("memoryBackend", "hindsight");
    const applied: string[] = [];
    const edit = async (path: string[], value: string) => {
      const home = createHomeList(options({ onApplied: (id) => { applied.push(id); } }), () => { }, () => { });
      home.selectItem("settings");
      home.handleInput(ENTER);
      for (const id of path) {
        leaf(home).selectItem(id);
        home.handleInput(ENTER);
      }
      home.handleInput(value);
      home.handleInput(ENTER);
      await leaf(home).settled?.();
    };
    await edit(["advanced", "compaction", "minContextPercent"], "75");
    await edit(["memory", "hindsight", "hindsightTimeoutMs"], "5000");
    expect(readGlobalConfigValue("minContextPercent")).toBe(75);
    expect(readGlobalConfigValue("hindsightTimeoutMs")).toBe(5000);
    expect(applied).toEqual(["minContextPercent", "hindsightTimeoutMs"]);
  });

  it("opens the branch-only settings from How it runs › This branch", () => {
    const home = createHomeList(options(), () => { }, () => { });
    home.selectItem("settings");
    home.handleInput(ENTER);
    leaf(home).selectItem("behavior");
    home.handleInput(ENTER);
    leaf(home).selectItem("session");
    home.handleInput(ENTER);
    expect(text(home)).toContain("Agent can compact");
    expect(text(home)).toContain("Footer status");
  });

  it("shows a failed readiness check instead of checking forever", async () => {
    let renders = 0;
    const home = createHomeList(options({
      readiness: async () => { throw new Error("config unreadable\nstack line"); },
    }), () => { }, () => renders++);
    await Bun.sleep(0);
    home.selectItem("setup");
    expect(text(home)).toContain("unavailable");
    expect(text(home)).not.toContain("checking");
    expect(text(home)).toContain("Readiness could not be read: config unreadable.");
    expect(renders).toBeGreaterThan(0);
  });

  it("labels background preparation like Settings in the Home header", async () => {
    await writeGlobalConfigValue("autoTriggerStrategy", "background");
    let header = "";
    const base = options();
    await showSmartCompactHome({
      ...base,
      ctx: {
        ...base.ctx,
        ui: {
          notify: () => { },
          custom: async (factory: (...args: unknown[]) => Component) => {
            const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
            header = factory({ requestRender: () => { } }, theme, {}, () => { }).render(200).join("\n");
            return undefined;
          },
        },
      } as unknown as ExtensionCommandContext,
    });
    expect(header).toContain("Automatic: prepare in background");
  });
});
