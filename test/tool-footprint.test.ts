import { describe, expect, it } from "bun:test";
import { createContextToolExposure } from "../src/app/lazy-tools.ts";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import type { CompactConfig } from "../src/types.ts";

const base = ["read", "foreign_tool", "smart_tools"];
const details = ["smart_navigation", "smart_context", "smart_recall", "smart_save_memory", "smart_compact"];

function harness(options: { initial?: string[]; settings?: Partial<CompactConfig> } = {}) {
  const settings: CompactConfig = { ...DEFAULT_CONFIG, toolLoading: "lazy", ...options.settings };
  let active = [...(options.initial ?? [...base, ...details])];
  let fail = false;
  const blocked = new Set<string>();
  const exposure = createContextToolExposure({
    getActiveTools: () => [...active],
    setActiveTools(names) {
      if (fail) throw new Error("Host rejected tool update");
      active = names.filter(name => !blocked.has(name));
    },
  }, { config: () => settings, compactionAccess: () => settings.agentToolAccess });
  exposure.apply();
  return {
    exposure,
    settings,
    blocked,
    active: () => [...active].sort(),
    select: (names: string[]) => { active = [...names]; },
    fail: (value: boolean) => { fail = value; },
  };
}

function selected(...names: string[]): string[] { return [...base, ...names].sort(); }

describe("context tool exposure", () => {
  it("defaults to stable eager declarations across loads and boundaries", () => {
    expect(DEFAULT_CONFIG.toolLoading).toBe("eager");
    const h = harness({ settings: { toolLoading: DEFAULT_CONFIG.toolLoading } });
    const before = h.active();
    expect(before).toEqual(selected(...details));
    h.exposure.load("navigation");
    h.exposure.load("history");
    h.exposure.atBoundary();
    h.exposure.apply();
    expect(h.active()).toEqual(before);
    h.select(base);
    h.exposure.apply();
    expect(h.active()).toEqual(selected()); // explicit /tools removal still wins
  });

  it("limits lazy requests to their groups and releases requests at branch boundaries", () => {
    const h = harness();
    expect(h.active()).toEqual(selected());
    h.exposure.load("navigation");
    h.exposure.load("history");
    expect(h.active()).toEqual(selected("smart_navigation", "smart_context"));
    h.exposure.unload("navigation");
    expect(h.active()).toEqual(selected("smart_context"));
    h.exposure.atBoundary();
    h.exposure.apply();
    expect(h.active()).toEqual(selected());
  });

  it("disables all owned tools without disabling human capabilities or losing requests", () => {
    const h = harness();
    h.exposure.load("navigation");
    h.settings.toolLoading = "off";
    h.exposure.apply();
    expect(h.active()).toEqual(["foreign_tool", "read"]);
    expect(() => h.exposure.load("history")).toThrow();
    expect(h.settings.contextNavigationEnabled).toBe(true);
    h.settings.toolLoading = "lazy";
    h.exposure.apply();
    expect(h.active()).toEqual(selected("smart_navigation"));
  });

  it("reports history reachable through the loader, but not when hidden by the user or off", () => {
    const h = harness();
    expect(h.active()).toEqual(selected());
    expect(h.exposure.reachable("history")).toBe(true);
    h.select(["read", "foreign_tool"]);
    h.exposure.apply();
    expect(h.exposure.reachable("history")).toBe(false);
    h.select(base);
    h.exposure.apply();
    expect(h.exposure.reachable("history")).toBe(true);
    h.exposure.load("history");
    h.select(base);
    h.exposure.apply();
    expect(h.exposure.reachable("history")).toBe(false);
    h.settings.toolLoading = "off";
    h.exposure.apply();
    expect(h.exposure.reachable("history")).toBe(false);
  });

  it("applies capability and branch permissions even in eager mode", () => {
    const h = harness({
      settings: {
        toolLoading: "eager", contextNavigationEnabled: false,
        contextGraphEnabled: false, memoryBackend: "local", agentToolAccess: "disabled",
      }
    });
    expect(h.active()).toEqual(selected("smart_context"));
    expect(() => h.exposure.load("compaction")).toThrow();
    expect(() => h.exposure.load("memory")).toThrow();
    h.settings.memoryBackend = "hindsight";
    h.settings.contextNavigationEnabled = true;
    h.exposure.apply();
    expect(h.active()).toEqual(selected("smart_context", "smart_navigation", "smart_recall", "smart_save_memory"));
  });

  it("never expands an initial host allowlist or defeats a later host refusal", () => {
    const restricted = harness({ initial: [...base] });
    expect(() => restricted.exposure.load("navigation")).toThrow();
    expect(restricted.active()).toEqual(selected());
    const h = harness();
    h.blocked.add("smart_navigation");
    expect(() => h.exposure.load("navigation")).toThrow();
    expect(h.active()).toEqual(selected());
  });

  it("preserves explicit removals across loads and explicit additions across boundaries", () => {
    const h = harness();
    h.exposure.load("navigation");
    h.select(base);
    h.exposure.apply();
    expect(() => h.exposure.load("navigation")).toThrow();
    expect(h.active()).toEqual(selected());
    h.select([...base, "smart_navigation"]);
    h.exposure.apply();
    h.exposure.atBoundary();
    h.exposure.apply();
    expect(h.active()).toEqual(selected("smart_navigation"));
    h.settings.contextNavigationEnabled = false;
    h.exposure.apply();
    expect(h.active()).toEqual(selected());
    h.settings.contextNavigationEnabled = true;
    h.exposure.apply();
    expect(h.active()).toEqual(selected("smart_navigation"));
  });

  it("does not retain a failed load for a later settings refresh", () => {
    const h = harness();
    h.fail(true);
    expect(() => h.exposure.load("navigation")).toThrow();
    h.fail(false);
    h.exposure.apply();
    expect(h.active()).toEqual(selected());
  });

  it("does not erase an explicit selection when unloading fails", () => {
    const h = harness();
    h.select([...base, "smart_navigation"]);
    h.exposure.apply();
    h.fail(true);
    expect(() => h.exposure.unload("navigation")).toThrow();
    h.fail(false);
    h.exposure.atBoundary();
    h.exposure.apply();
    expect(h.active()).toEqual(selected("smart_navigation"));
  });
});
