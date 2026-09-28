import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  type SettingItem,
  Text,
} from "@earendil-works/pi-tui";
import {
  loadConfig,
  readGlobalConfigValue,
  type GlobalConfigPath,
  type GlobalConfigValue,
  writeGlobalConfigValue,
} from "../utils/config.ts";
import type { CompactConfig } from "../types.ts";
import {
  BACKUP_DIR_SETTING,
  countChangedPaths,
  type GlobalConfigWriter,
  HINDSIGHT_SETTINGS,
  inputEffectiveDescription,
  inputLabel,
  type InputSetting,
  inputSettingItem,
  inputSettingsList,
  LIMIT_SETTINGS,
  MIN_CONTEXT_SETTING,
  MAX_CONTEXT_SETTING,
  PREPARE_CONTEXT_SETTING,
  MNEMOPI_DATA_DIR_SETTING,
  MODEL_SETTINGS,
  modelSettingItem,
  PIN_PATHS_SETTING,
  profileBudgetsList,
  profileConfigPaths,
} from "./settings-complex.ts";
import type { ModelFeasibility } from "../app/model-feasibility.ts";
import { CHANGED_MARK, SmartSettingsList } from "./settings-list.ts";
import { DEFAULT_CONFIG } from "../constants.ts";
import { notifyUser, recentIssues } from "../utils/issues.ts";
import type {
  SmartCompactPolicy,
  SmartCompactPolicyField,
  SmartCompactPolicySnapshot,
} from "../app/smart-compact-policy.ts";

function enabled(value: boolean): "enabled" | "disabled" {
  return value ? "enabled" : "disabled";
}

type GlobalSettingWriter = typeof updateGlobalChoiceSetting;
export type GlobalSettingApplied = (
  path: GlobalConfigPath,
  config: CompactConfig,
) => void | Promise<void>;

interface GlobalSettingState {
  display: string;
  config?: CompactConfig;
}

export class GlobalSettingsCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private readonly confirmed = new Map<string, string>();
  private confirmedConfig: CompactConfig | undefined;
  private readonly pending = new Map<
    string,
    { revision: number; display: string }
  >();
  private readonly listeners = new Map<
    string,
    Set<(state: GlobalSettingState) => void>
  >();

  constructor(
    private readonly writer: GlobalSettingWriter = updateGlobalChoiceSetting,
  ) { }

  display(id: GlobalConfigPath): string {
    return (
      this.pending.get(id)?.display ??
      displayFor(id, readGlobalConfigValue(id))
    );
  }

  subscribe(
    ids: readonly GlobalConfigPath[],
    listener: (id: GlobalConfigPath, state: GlobalSettingState) => void,
  ): () => void {
    const registrations: Array<[
      GlobalConfigPath,
      (state: GlobalSettingState) => void,
    ]> = [];
    for (const id of ids) {
      const callbacks = this.listeners.get(id) ?? new Set();
      const callback = (state: GlobalSettingState) => listener(id, state);
      callbacks.add(callback);
      this.listeners.set(id, callbacks);
      registrations.push([id, callback]);
    }
    return () => {
      for (const [id, callback] of registrations) {
        const callbacks = this.listeners.get(id);
        callbacks?.delete(callback);
        if (callbacks?.size === 0) this.listeners.delete(id);
      }
    };
  }

  submit(
    group: GlobalChoiceGroup,
    id: GlobalConfigPath,
    display: string,
    onError: (message: string) => void,
    onApplied: GlobalSettingApplied = () => { },
  ): void {
    if (this.pending.size === 0) this.confirmedConfig = loadConfig();
    if (!this.pending.has(id)) {
      this.confirmed.set(id, displayFor(id, readGlobalConfigValue(id)));
    }
    const revision = (this.pending.get(id)?.revision ?? 0) + 1;
    this.pending.set(id, { revision, display });
    this.queue = this.queue.then(async () => {
      try {
        const config = await this.writer(group, id, display);
        await onApplied(id, config);
        this.confirmed.set(id, display);
        this.confirmedConfig = config;
        if (this.pending.get(id)?.revision === revision) {
          this.pending.delete(id);
          this.emit(id, { display, config });
        }
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
        if (this.pending.get(id)?.revision === revision) {
          this.pending.delete(id);
          this.emit(id, {
            display: this.confirmed.get(id) ?? displayFor(id, undefined),
            config: this.confirmedConfig,
          });
        }
      }
    });
  }

  settled(): Promise<void> {
    return this.queue;
  }

  private emit(id: string, state: GlobalSettingState): void {
    for (const listener of this.listeners.get(id) ?? []) listener(state);
  }
}

const BOOLEAN_VALUES = [true, false] as const;
const ENGINE_PRESETS: ReadonlyArray<{ label: string; engines: Array<"eesv" | "native"> }> = [
  { label: "Smart summary", engines: ["eesv"] },
  { label: "Provider, then smart summary", engines: ["native", "eesv"] },
  { label: "Provider only", engines: ["native"] },
  { label: "Smart summary, then provider", engines: ["eesv", "native"] },
];
const THINKING_VALUES = [
  null,
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type SettingsCategoryId =
  | "compaction"
  | "models"
  | "memory"
  | "navigation"
  | "hygiene"
  | "privacy"
  | "session"
  | "advanced";
type GlobalChoiceGroup = Exclude<SettingsCategoryId, "session">;

interface GlobalChoiceSetting {
  id: GlobalConfigPath;
  label: string;
  description: string;
  values: readonly GlobalConfigValue[];
  /** Display names for stored string values; stored values never change. */
  labels?: Readonly<Record<string, string>>;
}

type Inactive = (config: CompactConfig) => string | undefined;

type Row =
  | { kind: "choice"; setting: GlobalChoiceSetting; inactive?: Inactive }
  | { kind: "input"; setting: InputSetting; inactive?: Inactive }
  | { kind: "model"; id: (typeof MODEL_SETTINGS)[number]["id"] }
  | {
    kind: "submenu";
    id: string;
    label: string;
    description: string;
    paths: () => GlobalConfigPath[];
    inactive?: Inactive;
    open: (env: CategoryEnv, done: () => void) => Component;
  };

interface CategoryEnv {
  ctx: ExtensionCommandContext;
  requestRender: () => void;
  coordinator: GlobalSettingsCoordinator;
  onApplied: GlobalSettingApplied;
  writeConfig: GlobalConfigWriter;
  /** Capacity snapshot for per-stage model pickers; absent = every model selectable. */
  feasibility?: ModelFeasibility;
}

const needsAutoTrigger: Inactive = (config) =>
  config.autoTrigger ? undefined : "turn on Automatic compaction first";
const needsBackgroundTiming: Inactive = (config) =>
  config.autoTrigger && config.autoTriggerStrategy === "background"
    ? undefined
    : "used only when Start when = Prepare in background";
const needsMnemopi: Inactive = (config) =>
  config.memoryBackend === "mnemopi" ? undefined : "used only when Memory store = Mnemopi";
const needsHindsight: Inactive = (config) =>
  config.memoryBackend === "hindsight" ? undefined : "used only when Memory store = Hindsight server";
const needsBackups: Inactive = (config) =>
  config.backupEnabled ? undefined : "turn on Backups first";
const needsNavigation: Inactive = (config) =>
  config.contextNavigationEnabled ? undefined : "turn on Session navigation first";

const CATEGORIES: ReadonlyArray<{
  id: GlobalChoiceGroup;
  label: string;
  description: string;
  rows: readonly Row[];
}> = [
    {
      id: "compaction",
      label: "Compaction",
      description: "When it starts, which engine, how much detail, and approval",
      rows: [
        {
          kind: "choice",
          setting: {
            id: "autoTrigger",
            label: "Automatic compaction",
            description: "Lets Smart Compact compact without being asked; Start when decides how. Compact now and /smart-compact always work.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          inactive: needsAutoTrigger,
          setting: {
            id: "autoTriggerStrategy",
            label: "Start when",
            description: "Before Pi's compaction: runs only when Pi's own auto-compaction fires, so Pi's compaction must be on. When idle / Prepare in background: Smart Compact starts by itself, even if Pi's auto-compaction is off.",
            values: ["native-hook", "settled", "background"],
            labels: { "native-hook": "Before Pi's compaction", settled: "When idle", background: "Prepare in background" },
          },
        },
        { kind: "input", setting: MIN_CONTEXT_SETTING, inactive: needsAutoTrigger },
        { kind: "input", setting: MAX_CONTEXT_SETTING, inactive: needsAutoTrigger },
        { kind: "input", setting: PREPARE_CONTEXT_SETTING, inactive: needsBackgroundTiming },
        {
          kind: "choice",
          setting: {
            id: "compactionEngines",
            label: "Engine",
            description: "Tried in order; the first that works is applied. Provider = your provider's own compaction (Anthropic/OpenAI only; not checked by Smart Compact).",
            values: ENGINE_PRESETS.map((preset) => preset.engines),
          },
        },
        {
          kind: "choice",
          setting: {
            id: "mode",
            label: "Mode",
            description: "Speed versus thoroughness of the smart summary. Auto picks Fast, Balanced, or Thorough per run. Each mode's token budgets: Advanced › Limits › Mode budgets.",
            values: ["auto", "fast", "balanced", "thorough"],
            // A raw stored legacy `mode: "aggressive"` loads and runs as Fast; show it that way.
            labels: { auto: "Auto (recommended)", fast: "Fast", balanced: "Balanced", thorough: "Thorough", aggressive: "Fast" },
          },
        },
        {
          kind: "choice",
          setting: {
            id: "requireApproval",
            label: "Ask before applying",
            description: "Shows a manual /smart-compact result for approval before it replaces the conversation.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          setting: {
            id: "agentToolAccess",
            label: "Agent can compact",
            description: "Lets the agent start compaction with the smart_compact tool. Follow Pi uses Pi's tool settings.",
            values: ["inherit", "enabled", "disabled"],
            labels: { inherit: "Follow Pi", enabled: "Allowed", disabled: "Not allowed" },
          },
        },
      ],
    },
    {
      id: "models",
      label: "Models & thinking",
      description: "Which models write, split, and check summaries, and how hard they think",
      rows: [
        { kind: "model", id: "summaryModel" },
        { kind: "model", id: "segmentationModel" },
        { kind: "model", id: "verificationModel" },
        {
          kind: "choice",
          setting: {
            id: "summaryThinkingLevel",
            label: "Summary thinking",
            description: "Reasoning effort for writing and repairing summaries. Higher is slower and costs more.",
            values: THINKING_VALUES,
          },
        },
        {
          kind: "choice",
          setting: {
            id: "segmentationThinkingLevel",
            label: "Topic split thinking",
            description: "Reasoning effort for splitting long conversations into topics.",
            values: THINKING_VALUES,
          },
        },
      ],
    },
    {
      id: "memory",
      label: "Memory",
      description: "Project memory across sessions: this machine, a Hindsight server, or Mnemopi",
      rows: [
        {
          kind: "choice",
          setting: {
            id: "contextGraphEnabled",
            label: "Project memory",
            description: "Remembers decisions and state across sessions of this project, on this machine.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          setting: {
            id: "memoryBackend",
            label: "Memory store",
            description:
              "This machine: local project memory. Hindsight server: uses only your existing server; nothing is stored or searched locally. Mnemopi: separate local SQLite store per project, text search only (no embeddings or model calls); needs the optional Mnemopi component and Bun 1.3.14+ (Readiness & details shows the install command).",
            values: ["local", "hindsight", "mnemopi"],
            labels: { local: "This machine", hindsight: "Hindsight server", mnemopi: "Mnemopi (local SQLite)" },
          },
        },
        {
          kind: "submenu",
          id: "hindsight",
          label: "› Hindsight server",
          description: "Server URL, memory bank, API key variable, timeout, and recall size.",
          paths: () => HINDSIGHT_SETTINGS.map((setting) => setting.id),
          inactive: needsHindsight,
          open: (env, done) =>
            inputSettingsList(HINDSIGHT_SETTINGS, env.requestRender, done, env.writeConfig,
              (message) => notifyUser(env.ctx, message, "error")),
        },
        { kind: "input", setting: MNEMOPI_DATA_DIR_SETTING, inactive: needsMnemopi },
      ],
    },
    {
      id: "navigation",
      label: "Agent tools & navigation",
      description: "Which tools the agent sees, and session anchors, search and returning to an anchor",
      rows: [
        {
          kind: "choice",
          setting: {
            id: "toolLoading",
            label: "Agent tools",
            description: "On demand: the agent sees a small loader and opens tools when needed. Always available: every permitted tool is active. Off: no context tools can run. Pi may retain previously loaded declarations in cached history. Permissions such as Agent can compact still apply.",
            values: ["lazy", "eager", "off"],
            labels: { lazy: "On demand", eager: "Always available", off: "Off" },
          },
        },
        {
          kind: "choice",
          setting: {
            id: "contextNavigationEnabled",
            label: "Session navigation",
            description: "Named anchors that mark points in this conversation, plus search and returning to them. Off stops everything below; recorded anchors and the settings below are kept.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          inactive: needsNavigation,
          setting: {
            id: "contextRecallEnabled",
            label: "Search other sessions",
            description: "Finds anchors saved in earlier sessions, this project by default. Results are read-only history, never instructions.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          inactive: needsNavigation,
          setting: {
            id: "contextPivotEnabled",
            label: "Return to an anchor",
            description: "Moves the conversation back to an anchor on a new branch, with a required note of what to carry over. Files and running processes are not rolled back.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          inactive: needsNavigation,
          setting: {
            id: "contextAnchorCacheEnabled",
            label: "Anchor prompt cache",
            description: "Anthropic models: keeps a prompt-cache marker on the newest anchor, so context before it is read from cache while later turns change.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          inactive: needsNavigation,
          setting: {
            id: "contextAnchorStatusEnabled",
            label: "Anchor status",
            description: "Shows the newest anchor on this branch in the footer. Display only; nothing is sent to the model.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          inactive: needsNavigation,
          setting: {
            id: "contextGuidanceEnabled",
            label: "Navigation guide",
            description: "Lets you or the agent open the navigation guide on request. It is never added to requests unless asked for.",
            values: BOOLEAN_VALUES,
          },
        },
      ],
    },
    {
      id: "hygiene",
      label: "Tool output cleanup",
      description: "Keeps the context small between compactions; local, no model calls",
      rows: [
        {
          kind: "choice",
          setting: {
            id: "contextHygieneEnabled",
            label: "Automatic cleanup",
            description: "Moves old tool output to local archives when it pays off, when the prompt cache is cold, or when context gets tight; recent turns and instructions stay.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          setting: {
            id: "artifactOffloadEnabled",
            label: "Offload huge outputs",
            description: "Stores very large tool outputs outside the context and keeps a searchable preview.",
            values: BOOLEAN_VALUES,
          },
        },
        { kind: "input", setting: PIN_PATHS_SETTING },
        {
          kind: "choice",
          setting: {
            id: "visualArchiveEnabled",
            label: "Image snapshots",
            description: "Experimental. Adds image snapshots of old output to summaries. Costs image tokens; needs a vision model and the optional @resvg/resvg-js component (Readiness & details shows the install command).",
            values: BOOLEAN_VALUES,
          },
        },
      ],
    },
    {
      id: "privacy",
      label: "Privacy & safety",
      description: "Redaction and backups",
      rows: [
        {
          kind: "choice",
          setting: {
            id: "scrubSecrets",
            label: "Scrub secrets",
            description: "Removes likely keys and tokens before anything is sent to a model or saved.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          setting: {
            id: "scrubPii",
            label: "Scrub personal data",
            description: "Removes emails, phone numbers, and card numbers before anything is sent or saved.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          setting: {
            id: "backupEnabled",
            label: "Backups",
            description: "Saves the full conversation before a compaction replaces it, so it can be restored.",
            values: BOOLEAN_VALUES,
          },
        },
        { kind: "input", setting: BACKUP_DIR_SETTING, inactive: needsBackups },
      ],
    },
    {
      id: "advanced",
      label: "Advanced",
      description: "Footer, tuning, telemetry tag, and limits",
      rows: [
        {
          kind: "choice",
          setting: {
            id: "showStatus",
            label: "Footer status",
            description: "Show a short footer note when compaction is manual-only or disabled.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          setting: {
            id: "focusWeighting",
            label: "Prioritize current task",
            description: "Gives the summary more room for what you are working on right now.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          setting: {
            id: "zeroCallEnabled",
            label: "Local summaries",
            description: "For simple conversations, builds the summary locally: faster and free, no model call.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          setting: {
            id: "adaptiveDamageFeedback",
            label: "Learn from lost details",
            description: "If earlier summaries dropped details you needed later, keeps more detail next time.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          setting: {
            id: "onlineDamageMonitor",
            label: "Watch for lost details",
            description: "After a compaction, notices when you ask about something the summary dropped and records it.",
            values: BOOLEAN_VALUES,
          },
        },
        {
          kind: "choice",
          setting: {
            id: "telemetryChannel",
            label: "Metrics tag",
            description: "Labels your local metrics Stable or Canary. Nothing is sent anywhere.",
            values: ["stable", "canary"],
            labels: { stable: "Stable", canary: "Canary" },
          },
        },
        {
          kind: "submenu",
          id: "limits",
          label: "› Limits",
          description: "Model call, token, and time limits, plus each mode's token budgets.",
          paths: () => [...LIMIT_SETTINGS.map((setting) => setting.id), ...profileConfigPaths()],
          open: (env, done) => {
            const items: SettingItem[] = LIMIT_SETTINGS.map((setting) =>
              inputSettingItem(setting, env.requestRender, env.writeConfig),
            );
            const profiles: SettingItem = {
              id: "profiles",
              label: "› Mode budgets",
              description: "Token budgets for each mode: Fast, Balanced, Thorough. Auto uses the budgets of the mode it picks.",
              currentValue: countChangedPaths(profileConfigPaths()),
              submenu: (_current, close) =>
                profileBudgetsList(env.requestRender, () => {
                  profiles.currentValue = countChangedPaths(profileConfigPaths());
                  close();
                }, env.writeConfig, (message) => notifyUser(env.ctx, message, "error")),
            };
            items.push(profiles);
            return new SmartSettingsList(items, 9, () => { }, done, (id) => {
              const setting = LIMIT_SETTINGS.find((candidate) => candidate.id === id);
              const item = items.find((candidate) => candidate.id === id);
              if (!setting || !item) return;
              void resetInput(env, setting, item);
            });
          },
        },
      ],
    },
  ];

const CHOICE_BY_ID = new Map<string, GlobalChoiceSetting>(
  CATEGORIES.flatMap((category) =>
    category.rows.flatMap((row) =>
      row.kind === "choice" ? [[row.setting.id as string, row.setting] as const] : [],
    ),
  ),
);

function valueDisplay(setting: GlobalChoiceSetting | undefined, value: GlobalConfigValue): string {
  if (Array.isArray(value)) {
    const key = value.join(",");
    return (
      ENGINE_PRESETS.find((preset) => preset.engines.join(",") === key)?.label ??
      value.join(" → ")
    );
  }
  if (value === null) return "provider default";
  if (typeof value === "boolean") return enabled(value);
  if (typeof value === "string" && setting?.labels?.[value]) return setting.labels[value];
  return String(value);
}

const DEFAULT_PREFIX = "default · ";

function defaultDisplay(setting: GlobalChoiceSetting | undefined): string {
  if (!setting) return "default";
  const builtIn = DEFAULT_CONFIG[setting.id as keyof typeof DEFAULT_CONFIG] as GlobalConfigValue;
  return builtIn === undefined ? "default" : DEFAULT_PREFIX + valueDisplay(setting, builtIn);
}

function displayFor(id: string, value: GlobalConfigValue): string {
  const setting = CHOICE_BY_ID.get(id);
  return value === undefined ? defaultDisplay(setting) : valueDisplay(setting, value);
}

function choiceValue(
  setting: GlobalChoiceSetting,
  display: string,
): GlobalConfigValue {
  if (display === "default" || display.startsWith(DEFAULT_PREFIX)) return undefined;
  const value = setting.values.find(
    (candidate) => valueDisplay(setting, candidate) === display,
  );
  if (value === undefined) {
    throw new Error(`Invalid value for ${setting.id}: ${display}`);
  }
  return value;
}

function choiceRows(group: GlobalChoiceGroup): GlobalChoiceSetting[] {
  const category = CATEGORIES.find((candidate) => candidate.id === group);
  return (category?.rows ?? []).flatMap((row) => (row.kind === "choice" ? [row.setting] : []));
}

function rowLabel(label: string, changed: boolean): string {
  return label + (changed ? CHANGED_MARK : "");
}

function rowDescription(description: string, inactiveReason: string | undefined): string {
  return inactiveReason ? `Inactive: ${inactiveReason}. ${description}` : description;
}

function effectiveChoiceDescription(
  setting: GlobalChoiceSetting,
  config: CompactConfig,
): string {
  const effective = config[setting.id as keyof CompactConfig] as GlobalConfigValue;
  // With no saved mode, only a legacy `profile` can move the loaded mode off its default.
  const legacy = setting.id === "mode" && effective !== DEFAULT_CONFIG.mode && readGlobalConfigValue("mode") === undefined;
  return `${setting.description} Now: ${valueDisplay(setting, effective)}${legacy ? " (from the legacy profile setting)" : ""}.`;
}

export function globalChoiceSettingsItems(
  group: GlobalChoiceGroup,
  config: CompactConfig,
  coordinator?: GlobalSettingsCoordinator,
): SettingItem[] {
  return choiceRows(group).map((setting) => ({
    id: setting.id,
    label: setting.label,
    description: effectiveChoiceDescription(setting, config),
    currentValue:
      coordinator?.display(setting.id) ?? displayFor(setting.id, readGlobalConfigValue(setting.id)),
    values: [defaultDisplay(setting), ...setting.values.map((value) => valueDisplay(setting, value))],
  }));
}

export async function updateGlobalChoiceSetting(
  group: GlobalChoiceGroup,
  id: string,
  display: string,
): Promise<CompactConfig> {
  const setting = choiceRows(group).find((candidate) => candidate.id === id);
  if (!setting) throw new Error(`Unknown global choice setting: ${id}`);
  return writeGlobalConfigValue(setting.id, choiceValue(setting, display));
}

async function resetInput(env: CategoryEnv, setting: InputSetting, item: SettingItem): Promise<CompactConfig | undefined> {
  try {
    const config = await env.writeConfig(setting.id, undefined);
    item.label = inputLabel(setting);
    item.currentValue = setting.format(undefined);
    item.description = inputEffectiveDescription(setting, config);
    env.requestRender();
    return config;
  } catch (error) {
    notifyUser(env.ctx, error instanceof Error ? error.message : String(error), "error");
    return undefined;
  }
}

function rowPaths(row: Row): GlobalConfigPath[] {
  switch (row.kind) {
    case "choice":
    case "input":
      return [row.setting.id];
    case "model":
      return [row.id];
    case "submenu":
      return row.paths();
  }
}

function categoryPaths(rows: readonly Row[]): GlobalConfigPath[] {
  return rows.flatMap(rowPaths);
}

function categoryList(
  group: GlobalChoiceGroup,
  env: CategoryEnv,
  done: () => void,
): SmartSettingsList {
  const category = CATEGORIES.find((candidate) => candidate.id === group)!;
  const rows = category.rows;
  const items: SettingItem[] = [];
  const inactiveIds = new Set<string>();
  let list: SmartSettingsList;

  const refresh = (config: CompactConfig): void => {
    rows.forEach((row, index) => {
      const item = items[index];
      const reason = "inactive" in row && row.inactive ? row.inactive(config) : undefined;
      if (reason) inactiveIds.add(item.id);
      else inactiveIds.delete(item.id);
      const changed = rowPaths(row).some((id) => readGlobalConfigValue(id) !== undefined);
      switch (row.kind) {
        case "choice":
          item.label = rowLabel(row.setting.label, changed);
          item.description = rowDescription(effectiveChoiceDescription(row.setting, config), reason);
          break;
        case "input":
          item.label = rowLabel(row.setting.label, changed);
          item.description = rowDescription(inputEffectiveDescription(row.setting, config), reason);
          break;
        case "model":
          item.label = rowLabel(MODEL_SETTINGS.find((setting) => setting.id === row.id)!.label, changed);
          break;
        case "submenu":
          item.label = row.label;
          item.description = rowDescription(row.description, reason);
          item.currentValue = countChangedPaths(row.paths());
          break;
      }
    });
    env.requestRender();
  };
  const writeAndRefresh: GlobalConfigWriter = async (id, value) => {
    const config = await env.writeConfig(id, value);
    refresh(config);
    return config;
  };
  const rowEnv: CategoryEnv = { ...env, writeConfig: writeAndRefresh };

  for (const row of rows) {
    switch (row.kind) {
      case "choice":
        items.push(globalChoiceSettingsItems(group, loadConfig(), env.coordinator).find(
          (item) => item.id === row.setting.id,
        )!);
        break;
      case "input":
        items.push(inputSettingItem(row.setting, env.requestRender, env.writeConfig, refresh));
        break;
      case "model":
        items.push(modelSettingItem(row.id, env.ctx, env.requestRender, writeAndRefresh, env.feasibility));
        break;
      case "submenu": {
        const item: SettingItem = {
          id: row.id,
          label: row.label,
          description: row.description,
          currentValue: countChangedPaths(row.paths()),
          submenu: (_current, close) =>
            row.open(rowEnv, () => {
              refresh(loadConfig());
              close();
            }),
        };
        items.push(item);
        break;
      }
    }
  }
  refresh(loadConfig());

  const choiceIds = rows.flatMap((row) => (row.kind === "choice" ? [row.setting.id] : []));
  list = new SmartSettingsList(
    items,
    9,
    (id, display) => {
      env.coordinator.submit(
        group,
        id as GlobalConfigPath,
        display,
        (message) => notifyUser(env.ctx, message, "error"),
        env.onApplied,
      );
    },
    () => {
      unsubscribe();
      done();
    },
    (id) => {
      const row = rows.find((candidate) => rowPaths(candidate)[0] === id && candidate.kind !== "submenu");
      if (!row) return;
      if (row.kind === "choice") {
        const display = defaultDisplay(row.setting);
        list.updateValue(id, display);
        env.coordinator.submit(
          group,
          row.setting.id,
          display,
          (message) => notifyUser(env.ctx, message, "error"),
          env.onApplied,
        );
      } else if (row.kind === "input") {
        const item = items.find((candidate) => candidate.id === id)!;
        void resetInput(env, row.setting, item).then((config) => config && refresh(config));
      } else if (row.kind === "model") {
        const item = items.find((candidate) => candidate.id === id)!;
        void writeAndRefresh(row.id, undefined).then(
          () => {
            item.currentValue = "default";
            env.requestRender();
          },
          (error) => notifyUser(env.ctx, error instanceof Error ? error.message : String(error), "error"),
        );
      }
    },
    inactiveIds,
  );
  const unsubscribe = env.coordinator.subscribe(choiceIds, (id, state) => {
    list.updateValue(id, state.display);
    refresh(state.config ?? loadConfig());
  });
  return list;
}

function effectiveDescription(
  field: SmartCompactPolicyField,
  policy: SmartCompactPolicySnapshot,
): string {
  const scope = "global = use the saved setting.";
  return field === "agentToolAccess"
    ? `${scope} Effective tool state: ${enabled(policy.agentToolEnabled)}`
    : `${scope} Effective value: ${enabled(policy[field])}`;
}

/** Branch agent access shows the same names as the saved setting. */
const AGENT_ACCESS_LABELS = CHOICE_BY_ID.get("agentToolAccess")!.labels!;

export function sessionSettingsItems(
  policy: SmartCompactPolicy,
): SettingItem[] {
  const current = policy.snapshot();
  const overrides = policy.branchOverrides();
  return [
    {
      id: "agentToolAccess",
      label: "Agent can compact",
      description: effectiveDescription("agentToolAccess", current),
      currentValue: overrides.agentToolAccess === undefined
        ? "global"
        : AGENT_ACCESS_LABELS[overrides.agentToolAccess],
      values: ["global", ...Object.values(AGENT_ACCESS_LABELS)],
    },
    {
      id: "autoTrigger",
      label: "Automatic compaction",
      description: effectiveDescription("autoTrigger", current),
      currentValue:
        overrides.autoTrigger === undefined
          ? "global"
          : enabled(overrides.autoTrigger),
      values: ["global", "enabled", "disabled"],
    },
    {
      id: "showStatus",
      label: "Footer status",
      description: effectiveDescription("showStatus", current),
      currentValue:
        overrides.showStatus === undefined
          ? "global"
          : enabled(overrides.showStatus),
      values: ["global", "enabled", "disabled"],
    },
  ];
}

function policyField(id: string): SmartCompactPolicyField {
  switch (id) {
    case "agentToolAccess":
    case "autoTrigger":
    case "showStatus":
      return id;
    default:
      throw new Error(`Unknown session setting: ${id}`);
  }
}

export function updateSessionSetting(
  policy: SmartCompactPolicy,
  ctx: ExtensionCommandContext,
  id: string,
  value: string,
) {
  const field = policyField(id);
  if (value === "global") return policy.reset(field, ctx);
  switch (field) {
    case "agentToolAccess": {
      const access = Object.entries(AGENT_ACCESS_LABELS).find(([, label]) => label === value)?.[0] ?? value;
      if (access !== "inherit" && access !== "enabled" && access !== "disabled") {
        throw new Error(`Invalid agent access value: ${value}`);
      }
      return policy.update({ agentToolAccess: access }, ctx);
    }
    case "autoTrigger":
      return policy.update({ autoTrigger: value === "enabled" }, ctx);
    case "showStatus":
      return policy.update({ showStatus: value === "enabled" }, ctx);
  }
}

function displayValue(
  field: SmartCompactPolicyField,
  policy: SmartCompactPolicy,
): string {
  const override = policy.branchOverrides()[field];
  if (override === undefined) return "global";
  if (typeof override === "boolean") return enabled(override);
  return AGENT_ACCESS_LABELS[override];
}

function sessionOverrideCount(policy: SmartCompactPolicy): string {
  const count = Object.values(policy.branchOverrides()).filter((value) => value !== undefined).length;
  return count ? `${count} overridden` : "follows global";
}

function sessionSettingsList(
  policy: SmartCompactPolicy,
  ctx: ExtensionCommandContext,
  done: () => void,
): SmartSettingsList {
  const items = sessionSettingsItems(policy);
  let list: SmartSettingsList;
  const apply = (id: string, value: string) => {
    try {
      const result = updateSessionSetting(policy, ctx, id, value);
      const field = policyField(id);
      const item = items.find((candidate) => candidate.id === id);
      if (item) item.description = effectiveDescription(field, result.policy);
      if (!result.ok) {
        notifyUser(ctx, result.error, "error");
        list.updateValue(id, displayValue(field, policy));
      }
    } catch (error) {
      notifyUser(ctx,
        error instanceof Error ? error.message : String(error),
        "error",
      );
      list.updateValue(id, displayValue(policyField(id), policy));
    }
  };
  list = new SmartSettingsList(items, 7, apply, done, (id) => {
    list.updateValue(id, "global");
    apply(id, "global");
  });
  return list;
}

export function settingsCategoryItems(
  policy: SmartCompactPolicy,
  ctx: ExtensionCommandContext,
  requestRender: () => void = () => { },
  coordinator: GlobalSettingsCoordinator = new GlobalSettingsCoordinator(),
  onApplied: GlobalSettingApplied = () => { },
  writeConfig: GlobalConfigWriter = writeGlobalConfigValue,
  feasibility?: ModelFeasibility,
): SettingItem[] {
  const env: CategoryEnv = { ctx, requestRender, coordinator, onApplied, writeConfig, ...(feasibility ? { feasibility } : {}) };
  const globalItem = (category: (typeof CATEGORIES)[number]): SettingItem => {
    const item: SettingItem = {
      id: category.id,
      label: category.label,
      description: category.description,
      currentValue: countChangedPaths(categoryPaths(category.rows)),
      submenu: (_current, done) =>
        categoryList(category.id, env, () => {
          item.currentValue = countChangedPaths(categoryPaths(category.rows));
          done();
        }),
    };
    return item;
  };
  const session: SettingItem = {
    id: "session",
    label: "This branch only",
    description: "Overrides kept with this conversation branch only; saved settings stay unchanged.",
    currentValue: sessionOverrideCount(policy),
    submenu: (_current, done) =>
      sessionSettingsList(policy, ctx, () => {
        session.currentValue = sessionOverrideCount(policy);
        done();
      }),
  };
  const global = CATEGORIES.map(globalItem);
  return [...global.slice(0, -1), session, global.at(-1)!];
}

export function createSettingsRoot(
  policy: SmartCompactPolicy,
  ctx: ExtensionCommandContext,
  onCancel: () => void,
  requestRender: () => void = () => { },
  coordinator: GlobalSettingsCoordinator = new GlobalSettingsCoordinator(),
  onApplied: GlobalSettingApplied = () => { },
  writeConfig: GlobalConfigWriter = writeGlobalConfigValue,
  feasibility?: ModelFeasibility,
): SmartSettingsList {
  return new SmartSettingsList(
    settingsCategoryItems(
      policy,
      ctx,
      requestRender,
      coordinator,
      onApplied,
      writeConfig,
      feasibility,
    ),
    8,
    () => { },
    onCancel,
  );
}

/** One-line summary of settings.json values that were ignored, or null. */
export function invalidSettingsLine(): string | null {
  const keys = recentIssues()
    .filter((issue) => issue.key.startsWith("config."))
    .map((issue) => issue.key.slice("config.".length));
  if (!keys.length) return null;
  return `⚠ ${keys.length} setting${keys.length === 1 ? "" : "s"} in settings.json ignored or converted: ${keys.join(", ")}. /smart-compact metrics has details.`;
}

interface NestedSettingsComponent extends Component {
  submenuComponent?: Component;
  focused?: boolean;
}

function deepestFocusable(component: Component): Focusable | undefined {
  let current: NestedSettingsComponent | undefined =
    component as NestedSettingsComponent;
  let focusable: Focusable | undefined;
  while (current) {
    if (typeof current.focused === "boolean") {
      focusable = current as Focusable;
    }
    current = current.submenuComponent as NestedSettingsComponent | undefined;
  }
  return focusable;
}

export function createSettingsController(
  root: SmartSettingsList,
  display: Component,
  requestRender: () => void,
): Component & Focusable {
  let focused = false;
  let target: Focusable | undefined;
  const syncFocus = () => {
    const next = focused ? deepestFocusable(root) : undefined;
    if (target !== next) {
      if (target) target.focused = false;
      target = next;
    }
    if (target) target.focused = focused;
  };
  return {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
      syncFocus();
    },
    render(width: number) {
      syncFocus();
      return display.render(width);
    },
    handleInput(data: string) {
      root.handleInput(data);
      syncFocus();
      requestRender();
    },
    invalidate: () => display.invalidate(),
  };
}

/** Persist one global path, then run the live-apply hook with the new config. */
export function appliedConfigWriter(onApplied: GlobalSettingApplied): GlobalConfigWriter {
  return async (path, value) => {
    const config = await writeGlobalConfigValue(path, value);
    await onApplied(path, config);
    return config;
  };
}

/** Open the unified Smart Compact settings panel. */
export async function showSmartCompactSettings(
  ctx: ExtensionCommandContext,
  policy: SmartCompactPolicy,
  coordinator: GlobalSettingsCoordinator = new GlobalSettingsCoordinator(),
  onApplied: GlobalSettingApplied = () => { },
): Promise<void> {
  const writeConfig = appliedConfigWriter(onApplied);
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const root = createSettingsRoot(
      policy,
      ctx,
      done,
      () => tui.requestRender(),
      coordinator,
      onApplied,
      writeConfig,
    );
    const container = new Container();
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Smart Compact Settings")), 0, 0),
    );
    container.addChild(
      new Text(
        theme.fg("dim", "Changes are saved for all projects; This branch only changes just this branch."),
        0,
        0,
      ),
    );
    container.addChild(
      new Text(
        theme.fg("dim", "/smart-compact always works. • = changed from default."),
        0,
        0,
      ),
    );
    const invalid = invalidSettingsLine();
    if (invalid) container.addChild(new Text(theme.fg("warning", invalid), 0, 0));
    container.addChild(new Text("", 0, 0));
    container.addChild(root);
    container.addChild(new Text("", 0, 0));
    container.addChild(
      new Text(
        theme.fg("dim", "↑↓ move · Enter change/open · r reset · Esc back"),
        0,
        0,
      ),
    );
    return createSettingsController(root, container, () => tui.requestRender());
  });
}
