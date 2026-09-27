import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CompactConfig } from "../types.ts";
import { loadConfig } from "../utils/config.ts";
import { readContextGuide } from "./context-guide.ts";

const GROUPS = {
 navigation: ["smart_navigation"],
 history: ["smart_context"],
 memory: ["smart_recall", "smart_save_memory"],
 compaction: ["smart_compact"],
} as const;
export type ContextToolGroup = keyof typeof GROUPS;
const GROUP_NAMES = Object.keys(GROUPS) as ContextToolGroup[];
const LOADER = "smart_tools";
const OWN_TOOLS: readonly string[] = [LOADER, ...Object.values(GROUPS).flat()];

export interface ContextToolExposure {
 /** Reconcile settings without changing which lazy groups were requested. */
 apply(): void;
 /** Forget lazy requests before the branch policy calls apply(). */
 atBoundary(): void;
 load(group: ContextToolGroup): string[];
 /** Whether the agent can call the group now or load it through the visible loader. */
 reachable(group: ContextToolGroup): boolean;
 unload(group: ContextToolGroup): void;
 summary(): string;
 status(): { mode: CompactConfig["toolLoading"]; groups: Array<{ group: ContextToolGroup; available: boolean; active: string[] }> };
}

/** The sole owner of our tool visibility. Never scans memory or session files. */
export function createContextToolExposure(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">, options: {
 config?: () => CompactConfig;
 compactionAccess: () => CompactConfig["agentToolAccess"];
}): ContextToolExposure {
 const config = options.config ?? loadConfig;
 const loaded = new Set<ContextToolGroup>();
 let hidden = new Set<string>();
 let userHidden = new Set<string>();
 let userShown = new Set<string>();
 let previous: Set<string> | undefined;
 const permitted = (group: ContextToolGroup, settings: CompactConfig): boolean => {
  if (settings.toolLoading === "off") return false;
  if (group === "navigation") return settings.contextNavigationEnabled;
  if (group === "memory") return settings.contextGraphEnabled || settings.memoryBackend !== "local";
  if (group === "compaction") return options.compactionAccess() !== "disabled";
  return true;
 };
 const apply = (): void => {
  const settings = config();
  const active = new Set(pi.getActiveTools());
  const nextHidden = new Set(hidden);
  const nextUserHidden = new Set(userHidden);
  const nextUserShown = new Set(userShown);
  // A user changing /tools wins over subsequent refreshes and loader requests.
  if (previous) for (const name of OWN_TOOLS) {
   if (previous.has(name) && !active.has(name)) {
    nextUserHidden.add(name);
    nextUserShown.delete(name);
    nextHidden.delete(name);
   } else if (!previous.has(name) && active.has(name)) {
    nextUserShown.add(name);
    nextUserHidden.delete(name);
   }
  }
  const select = (name: string, wanted: boolean) => {
   if (!wanted && active.delete(name)) nextHidden.add(name);
   else if (wanted && !nextUserHidden.has(name) && nextHidden.delete(name)) active.add(name);
  };
  select(LOADER, settings.toolLoading !== "off");
  for (const group of GROUP_NAMES) {
   for (const name of GROUPS[group]) {
    select(name, permitted(group, settings) && (settings.toolLoading === "eager" || loaded.has(group) || nextUserShown.has(name)));
   }
  }
  const before = pi.getActiveTools();
  if (active.size !== before.length || before.some(name => !active.has(name))) pi.setActiveTools([...active]);
  // A host allowlist may refuse additions. Its actual result, not our wish, wins.
  previous = new Set(pi.getActiveTools());
  hidden = nextHidden;
  userHidden = nextUserHidden;
  userShown = nextUserShown;
 };
 const status = () => {
  const settings = config();
  const active = new Set(pi.getActiveTools());
  return {
   mode: settings.toolLoading,
   groups: GROUP_NAMES.map(group => ({ group, available: permitted(group, settings), active: GROUPS[group].filter(name => active.has(name)) })),
  };
 };
 return {
  apply,
  atBoundary() { loaded.clear(); },
  load(group) {
   if (!permitted(group, config())) throw new Error(`${group} tools are disabled in Pi Continuity settings or branch policy.`);
   const had = loaded.has(group);
   loaded.add(group);
   try {
    apply();
    const active = pi.getActiveTools();
    const names = GROUPS[group].filter(name => active.includes(name));
    if (!names.length) throw new Error(`${group} tools are excluded by Pi's tool selection. Ask the user to enable them with /tools.`);
    return names;
   } catch (error) { if (!had) loaded.delete(group); throw error; }
  },
  reachable(group) {
   const settings = config();
   if (!permitted(group, settings)) return false;
   const active = new Set(pi.getActiveTools());
   const names = GROUPS[group];
   if (names.some(name => active.has(name))) return true;
   return active.has(LOADER) && names.some(name => hidden.has(name) && !userHidden.has(name));
  },
  unload(group) {
   const had = loaded.delete(group);
   const shownBefore = userShown;
   userShown = new Set(userShown);
   // Commit an explicit unload only after the host accepts the visibility change.
   for (const name of GROUPS[group]) userShown.delete(name);
   try { apply(); } catch (error) {
    userShown = shownBefore;
    if (had) loaded.add(group);
    throw error;
   }
  },
  status,
  summary() {
   const value = status();
   const count = value.groups.reduce((total, group) => total + group.active.length, 0);
   return value.mode === "off" ? "Agent tools off" : `${value.mode === "lazy" ? "On demand" : "Eager"} · ${count} detail tools loaded`;
  },
 };
}

export function registerContextToolLoader(pi: ExtensionAPI, exposure: ContextToolExposure): void {
 pi.registerTool({
  name: LOADER,
  label: "Context Tools",
  description: "Load optional navigation, history, memory or compaction tools. Guide returns the context workflow only on request.",
  parameters: Type.Object({
   action: StringEnum(["load", "unload", "guide", "status"] as const),
   group: Type.Optional(StringEnum(GROUP_NAMES)),
  }),
  executionMode: "sequential",
  async execute(_id, params, signal) {
   if (signal?.aborted) throw new Error("Tool loading cancelled.");
   if (loadConfig().toolLoading === "off" || !pi.getActiveTools().includes(LOADER)) throw new Error("Context tools are disabled in Pi settings or /tools.");
   let text: string;
   if (params.action === "guide") text = await readContextGuide();
   else if (params.action === "status") text = JSON.stringify(exposure.status());
   else {
    if (!params.group) throw new Error(`${params.action} requires a group.`);
    if (params.action === "load") text = `Loaded: ${exposure.load(params.group).join(", ")}. Available on the next model turn; no feature instructions were injected.`;
    else {
     if (loadConfig().toolLoading === "eager") throw new Error("Eager mode keeps tools loaded. Select On demand or Off in /smart-compact settings before unloading a group.");
     exposure.unload(params.group);
     text = `Unloaded ${params.group}. No files or session history changed.`;
    }
   }
   return { content: [{ type: "text", text }], details: undefined };
  },
 });
}
