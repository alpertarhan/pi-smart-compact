import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import {
  Container,
  type Focusable,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type SettingItem,
  Text,
} from "@earendil-works/pi-tui";
import {
  CONFIG_NUMERIC_LIMITS,
  PROFILE_NUMERIC_BOUNDS,
  PROFILES,
} from "../constants.ts";
import type { CompactConfig, CompressionProfile, EffectiveCompactionMode } from "../types.ts";
import {
  type GlobalConfigPath,
  type GlobalConfigValue,
  isValidMnemopiDataDir,
  loadConfig,
  readGlobalConfigValue,
  writeGlobalConfigValue,
} from "../utils/config.ts";
import { CHANGED_MARK, SmartSettingsList } from "./settings-list.ts";
import type { ModelFeasibility } from "../app/model-feasibility.ts";
import { MODE_POLICIES } from "../app/mode-policy.ts";
import {
  isValidHindsightBankId,
  normalizeHindsightBaseUrl,
} from "../infra/hindsight-client.ts";

export type GlobalConfigWriter = (
  path: GlobalConfigPath,
  value: GlobalConfigValue,
) => Promise<CompactConfig>;

export interface InputSetting {
  id: GlobalConfigPath;
  label: string;
  description: string;
  placeholder: string;
  parse(input: string): GlobalConfigValue;
  format(value: GlobalConfigValue): string;
}

export const MODEL_SETTINGS = [
  {
    id: "summaryModel",
    label: "Summary model",
    description: "Writes the summary. Default: the chat model.",
  },
  {
    id: "segmentationModel",
    label: "Topic split model",
    description: "Splits long conversations into topics before summarizing. Default: the summary model.",
  },
  {
    id: "verificationModel",
    label: "Check & repair model",
    description: "Fixes gaps the checker finds in a summary. Default: the summary model.",
  },
] as const satisfies ReadonlyArray<{
  id: GlobalConfigPath;
  label: string;
  description: string;
}>;

const PROFILE_NAMES = Object.keys(PROFILES) as CompressionProfile[];

function numberParser(options: {
  min: number;
  max: number;
  integer?: boolean;
  zeroOrRange?: boolean;
}): (input: string) => number | undefined {
  return (input) => {
    const trimmed = input.trim();
    if (!trimmed) return undefined;
    const value = Number(trimmed);
    const inRange = value >= options.min && value <= options.max;
    if (
      !Number.isFinite(value) ||
      (options.integer !== false && !Number.isSafeInteger(value)) ||
      (!inRange && !(options.zeroOrRange && value === 0))
    ) {
      const allowed = options.zeroOrRange
        ? `0 or ${options.min}–${options.max}`
        : `${options.min}–${options.max}`;
      throw new Error(`Enter ${options.integer === false ? "a number" : "an integer"} in ${allowed}.`);
    }
    return value;
  };
}

function scalarFormat(value: GlobalConfigValue): string {
  return value === undefined ? "default" : String(value);
}

export const MIN_CONTEXT_SETTING: InputSetting = {
  id: "minContextPercent",
  label: "Start at context %",
  description: "When idle / Prepare in background: compacts once context use reaches this %. Before Pi's compaction: Smart Compact replaces Pi's summary only above this %; Pi decides when.",
  placeholder: "0–100; blank uses default",
  parse: numberParser(CONFIG_NUMERIC_LIMITS.minContextPercent),
  format: scalarFormat,
};

const parsePreparePercent = numberParser(CONFIG_NUMERIC_LIMITS.prepareContextPercent);

export const PREPARE_CONTEXT_SETTING: InputSetting = {
  id: "prepareContextPercent",
  label: "Prepare at context %",
  description:
    "Prepare in background only: starts the summary at this %; it is applied at Start at context %, so this must be lower. Auto starts 8k–32k tokens earlier.",
  placeholder: "0–100 below Start at; auto or blank = Auto",
  parse: (input) => (input.trim().toLowerCase() === "auto" ? undefined : parsePreparePercent(input)),
  format: (value) => (value === undefined || value === null ? "Auto" : String(value)),
};

export const LIMIT_SETTINGS: readonly InputSetting[] = [
  {
    id: "maxLlmCalls",
    label: "Max model calls per run",
    description: "Stops a compaction run after this many model calls. 0 uses the mode's limit.",
    placeholder: "0–100; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.maxLlmCalls),
    format: scalarFormat,
  },
  {
    id: "maxLlmInputTokens",
    label: "Max input tokens per run",
    description: "Stops a run once model input reaches this many tokens. 0 uses the mode's limit.",
    placeholder: "0–1000000; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.maxLlmInputTokens),
    format: scalarFormat,
  },
  {
    id: "maxLatencyMs",
    label: "Run time limit (ms)",
    description: "Stops a whole compaction run after this long; the conversation stays unchanged. 0 = no limit.",
    placeholder: "0 or 5000–7200000; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.maxLatencyMs),
    format: scalarFormat,
  },
  {
    id: "autoTriggerTimeoutMs",
    label: "Automatic run time limit (ms)",
    description: "Stops an automatic compaction after this long and lets Pi's own compaction run instead.",
    placeholder: "1000–300000; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.autoTriggerTimeoutMs),
    format: scalarFormat,
  },
  {
    id: "codexMaxCallMs",
    label: "Stuck-call timeout (ms)",
    description: "Cancels a single model call that stops responding (mainly ChatGPT/Codex). 0 picks a value automatically.",
    placeholder: "0 or 5000–3600000; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.codexMaxCallMs),
    format: scalarFormat,
  },
  {
    id: "pendingTtlMs",
    label: "Prepared summary lifetime (ms)",
    description: "A prepared summary not applied within this time is discarded.",
    placeholder: "1000–3600000; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.pendingTtlMs),
    format: scalarFormat,
  },
];

function nullableTextParser(
  pattern: (value: string) => boolean,
  message: string,
): (input: string) => string | undefined {
  return (input) => {
    const value = input.trim();
    if (!value) return undefined;
    if (!pattern(value)) throw new Error(message);
    return value;
  };
}

export const HINDSIGHT_SETTINGS: readonly InputSetting[] = [
  {
    id: "hindsightBaseUrl",
    label: "Server URL",
    description: "Hindsight server that receives confirmed saves. HTTPS (plain http only for localhost).",
    placeholder: "https://hindsight.example.com; blank clears",
    parse: nullableTextParser((value) => {
      try {
        normalizeHindsightBaseUrl(value);
        return true;
      } catch {
        return false;
      }
    }, "Enter an https URL without credentials, query, or fragment (http only for loopback)."),
    format: scalarFormat,
  },
  {
    id: "hindsightBankId",
    label: "Memory bank",
    description: "Bank that stores this project's memories. Required; never guessed.",
    placeholder: "letters, digits, . _ -; blank clears",
    parse: nullableTextParser(
      isValidHindsightBankId,
      "Bank ids use 1–128 letters, digits, '.', '_' or '-'.",
    ),
    format: scalarFormat,
  },
  {
    id: "hindsightApiKeyEnv",
    label: "API key variable",
    description: "Name of the environment variable that holds the key. Never enter the key itself.",
    placeholder: "HINDSIGHT_API_TOKEN; blank clears",
    parse: nullableTextParser(
      (value) => /^[A-Z_][A-Z0-9_]{0,127}$/.test(value),
      "Enter an environment variable name such as HINDSIGHT_API_TOKEN.",
    ),
    format: scalarFormat,
  },
  {
    id: "hindsightTimeoutMs",
    label: "Request timeout (ms)",
    description: "Gives up on one Hindsight request after this long.",
    placeholder: "1000–60000; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.hindsightTimeoutMs),
    format: scalarFormat,
  },
  {
    id: "hindsightRecallMaxTokens",
    label: "Recall size (tokens)",
    description: "How much the server may return per recall. Output is also capped locally.",
    placeholder: "128–4096; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.hindsightRecallMaxTokens),
    format: scalarFormat,
  },
];

export const MNEMOPI_DATA_DIR_SETTING: InputSetting = {
  id: "mnemopiDataDir",
  label: "Mnemopi data folder",
  description:
    "Where Mnemopi keeps its SQLite files, kept apart per project. Default: a folder owned by Smart Compact in Pi's agent directory.",
  placeholder: "Absolute or ~/ path; blank uses default",
  parse(input) {
    const value = input.trim();
    if (!value) return undefined;
    if (!isValidMnemopiDataDir(value)) {
      throw new Error("Enter an absolute path or a ~/ path; relative paths are not allowed.");
    }
    return value;
  },
  format: (value) => (value === undefined || value === null ? "Default" : String(value)),
};

export const BACKUP_DIR_SETTING: InputSetting = {
    id: "backupDir",
    label: "Backup folder",
    description: "Where conversation backups are written before a compaction is applied.",
    placeholder: "Absolute path; blank uses default",
    parse(input) {
      const value = input.trim();
      if (!value) return undefined;
      if (value.includes("\0") || /[\r\n]/.test(value)) {
        throw new Error("Backup directory must be a single valid path.");
      }
      if (!path.isAbsolute(value)) {
        throw new Error("Backup directory must be an absolute path.");
      }
      return value;
    },
    format: scalarFormat,
};

export const PIN_PATHS_SETTING: InputSetting = {
    id: "pinPaths",
    label: "Always-kept files",
    description: "Comma-separated file paths every summary must keep.",
    placeholder: "src/api.ts, docs/design.md; blank clears",
    parse(input) {
      const trimmed = input.trim();
      if (!trimmed) return undefined;
      const paths = trimmed
        .split(/[,\n]/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (paths.some((value) => value.includes("\0"))) {
        throw new Error("Pinned paths cannot contain NUL characters.");
      }
      return [...new Set(paths)];
    },
    format(value: GlobalConfigValue) {
      return value === undefined
        ? "default"
        : Array.isArray(value)
          ? value.join(", ") || "none"
          : String(value);
    },
};

const PROFILE_FIELDS = [
  ["summaryBudgetTokens", "Summary size"],
  ["keepRecentTokens", "Recent turns kept"],
  ["minChunkTokens", "Min chunk size"],
  ["maxChunkTokens", "Max chunk size"],
  ["singlePassMaxTokens", "One-pass limit"],
  ["batchMaxTokens", "Batch limit"],
] as const;

/** Each run mode reads the budgets stored under its own profile key. */
const MODE_BUDGETS = (Object.keys(MODE_POLICIES) as EffectiveCompactionMode[]).map((mode) => ({
  mode,
  profile: MODE_POLICIES[mode].profile,
  label: mode[0].toUpperCase() + mode.slice(1),
}));

export function profileSettings(profile: CompressionProfile): InputSetting[] {
  const modeLabel = MODE_BUDGETS.find((budget) => budget.profile === profile)!.label;
  return PROFILE_FIELDS.map(([key, label]) => {
    const [min, max] = PROFILE_NUMERIC_BOUNDS[key];
    return {
      id: `profiles.${profile}.${key}` as GlobalConfigPath,
      label,
      description: `Tokens used when a run is ${modeLabel}, including when Auto picks it. Related chunk sizes must stay consistent.`,
      placeholder: `${min}–${max}; blank uses built-in`,
      parse: numberParser({ min, max }),
      format: scalarFormat,
    };
  });
}

function effectiveValue(
  config: CompactConfig,
  id: GlobalConfigPath,
): GlobalConfigValue {
  const parts = id.split(".");
  if (parts[0] !== "profiles") {
    return config[id as keyof CompactConfig] as GlobalConfigValue;
  }
  const [, profile, key] = parts as [
    "profiles",
    CompressionProfile,
    keyof CompactConfig["profiles"][CompressionProfile],
  ];
  return config.profiles[profile][key];
}

class InputSettingEditor extends Container implements Focusable {
  private readonly input = new Input();
  private readonly status = new Text("", 0, 0);
  private saving = false;
  private pending: Promise<void> = Promise.resolve();

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  constructor(
    setting: InputSetting,
    initial: string,
    private readonly requestRender: () => void,
    private readonly save: (value: GlobalConfigValue) => Promise<void>,
    private readonly done: () => void,
  ) {
    super();
    this.addChild(new Text(setting.label, 0, 0));
    this.addChild(new Text(setting.description, 0, 0));
    this.addChild(new Text(`Allowed: ${setting.placeholder}`, 0, 0));
    this.addChild(new Text("", 0, 0));
    this.input.setValue(initial);
    this.input.handleInput("\x1b[F");
    this.input.onSubmit = (value) => {
      if (this.saving) return;
      let parsed: GlobalConfigValue;
      try {
        parsed = setting.parse(value);
      } catch (error) {
        this.status.setText(error instanceof Error ? error.message : String(error));
        this.requestRender();
        return;
      }
      this.saving = true;
      this.status.setText("Saving…");
      this.requestRender();
      this.pending = this.save(parsed)
        .then(() => this.done())
        .catch((error) => {
          this.saving = false;
          this.status.setText(
            error instanceof Error ? error.message : String(error),
          );
          this.requestRender();
        });
    };
    this.input.onEscape = () => {
      if (!this.saving) this.done();
    };
    this.addChild(this.input);
    this.addChild(new Text("", 0, 0));
    this.addChild(this.status);
    this.addChild(new Text("Enter save · Esc cancel", 0, 0));
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
    this.requestRender();
  }

  settled(): Promise<void> {
    return this.pending;
  }
}

interface ModelChoice extends SelectItem {
  settingValue: string;
  /** Visible but not selectable, with the reason. */
  blocked?: string;
}

class ModelSettingEditor extends Container implements Focusable {
  private readonly search = new Input();
  private readonly list: SelectList;
  private readonly status = new Text("", 0, 0);
  private saving = false;
  private pending: Promise<void> = Promise.resolve();

  get focused(): boolean {
    return this.search.focused;
  }

  set focused(value: boolean) {
    this.search.focused = value;
  }

  constructor(
    models: ModelChoice[],
    selectedValue: string,
    private readonly requestRender: () => void,
    save: (value: string) => Promise<void>,
    done: () => void,
  ) {
    super();
    this.addChild(new Text("Type to search models", 0, 0));
    this.addChild(this.search);
    this.addChild(new Text("", 0, 0));
    this.list = new SelectList(models, 10, {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    });
    const selectedIndex = models.findIndex(
      (item) => item.settingValue === selectedValue,
    );
    this.list.setSelectedIndex(Math.max(0, selectedIndex));
    this.list.onSelect = (item) => {
      if (this.saving) return;
      this.saving = true;
      this.status.setText("Saving…");
      this.requestRender();
      const selected = models.find((candidate) => candidate.value === item.value);
      if (!selected || selected.blocked) {
        this.saving = false;
        this.status.setText(selected?.blocked ? selected.label + " cannot be used: " + selected.blocked : "");
        this.requestRender();
        return;
      }
      this.pending = save(selected.settingValue)
        .then(done)
        .catch((error) => {
          this.saving = false;
          this.status.setText(
            error instanceof Error ? error.message : String(error),
          );
          this.requestRender();
        });
    };
    this.list.onCancel = () => {
      if (!this.saving) done();
    };
    this.addChild(this.list);
    this.addChild(this.status);
    this.addChild(new Text("Type to filter · Enter select · Esc cancel", 0, 0));
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.escape)
    ) {
      this.list.handleInput(data);
    } else {
      this.search.handleInput(data);
      this.list.setFilter(this.search.getValue());
    }
    this.requestRender();
  }

  settled(): Promise<void> {
    return this.pending;
  }
}

/** Row label with the "changed from default" bullet, matching category rows. */
export function inputLabel(setting: InputSetting): string {
  return setting.label + (readGlobalConfigValue(setting.id) !== undefined ? CHANGED_MARK : "");
}

/** Format the stored override the way the input row displays it. */
export function inputDisplay(setting: InputSetting): string {
  return setting.format(readGlobalConfigValue(setting.id));
}

export function inputEffectiveDescription(setting: InputSetting, config: CompactConfig): string {
  return `${setting.description} Now: ${setting.format(effectiveValue(config, setting.id))}.`;
}

/** One row that opens an inline editor for a validated text/number setting. */
export function inputSettingItem(
  setting: InputSetting,
  requestRender: () => void,
  writeConfig: GlobalConfigWriter,
  onWritten: (config: CompactConfig) => void = () => {},
): SettingItem {
  const item: SettingItem = {
    id: setting.id,
    label: inputLabel(setting),
    description: inputEffectiveDescription(setting, loadConfig()),
    currentValue: inputDisplay(setting),
  };
  item.submenu = (_current, close) => {
    const persisted = readGlobalConfigValue(setting.id);
    return new InputSettingEditor(
      setting,
      persisted === undefined
        ? ""
        : Array.isArray(persisted)
          ? persisted.join(", ")
          : String(persisted),
      requestRender,
      async (value) => {
        const effective = await writeConfig(setting.id, value);
        item.label = inputLabel(setting);
        item.currentValue = setting.format(value);
        item.description = inputEffectiveDescription(setting, effective);
        onWritten(effective);
      },
      close,
    );
  };
  return item;
}

export function inputSettingsList(
  settings: readonly InputSetting[],
  requestRender: () => void,
  done: () => void,
  writeConfig: GlobalConfigWriter,
): SmartSettingsList {
  const items = settings.map((setting) => inputSettingItem(setting, requestRender, writeConfig));
  const byId = new Map(settings.map((setting) => [setting.id as string, setting]));
  return new SmartSettingsList(items, 9, () => {}, done, (id) => {
    const setting = byId.get(id);
    const item = items.find((candidate) => candidate.id === id);
    if (!setting || !item) return;
    void writeConfig(setting.id, undefined).then((config) => {
      item.label = inputLabel(setting);
      item.currentValue = setting.format(undefined);
      item.description = inputEffectiveDescription(setting, config);
      requestRender();
    });
  });
}

/** Rows for the three run modes, each opening the six budgets its profile stores. */
export function profileBudgetsList(
  requestRender: () => void,
  done: () => void,
  writeConfig: GlobalConfigWriter,
): SmartSettingsList {
  const modes: SettingItem[] = MODE_BUDGETS.map(({ mode, profile, label }) => ({
    id: mode,
    label,
    description: `Token budgets used when a run is ${label}, including when Auto picks ${label}.`,
    currentValue: countChangedPaths(profileSettings(profile).map((setting) => setting.id)),
    submenu: (_current, close) =>
      inputSettingsList(profileSettings(profile), requestRender, close, writeConfig),
  }));
  return new SmartSettingsList(modes, 7, () => {}, done);
}

/** "N changed" or "defaults" for a set of stored paths. */
export function countChangedPaths(ids: readonly GlobalConfigPath[]): string {
  const changed = ids.filter((id) => readGlobalConfigValue(id) !== undefined).length;
  return changed ? `${changed} changed` : "defaults";
}

export function profileConfigPaths(): GlobalConfigPath[] {
  return PROFILE_NAMES.flatMap((profile) => profileSettings(profile).map((setting) => setting.id));
}

const STAGE_BY_SETTING = {
  summaryModel: "summary",
  segmentationModel: "segmentation",
  verificationModel: "verification",
} as const;

export function modelSettingsItems(
  ctx: ExtensionCommandContext,
  requestRender: () => void,
  writeConfig: GlobalConfigWriter = writeGlobalConfigValue,
  feasibility?: ModelFeasibility,
): SettingItem[] {
  const config = loadConfig();
  return MODEL_SETTINGS.map((setting) => {
    const override = readGlobalConfigValue(setting.id);
    const current = typeof override === "string" ? override : "default";
    const fallback = setting.id === "summaryModel" ? "chat model" : "summary model";
    const describe = (effective: CompactConfig) =>
      `${setting.description} Now: ${effective[setting.id] ?? fallback}.`;
    const item: SettingItem = {
      id: setting.id,
      label: setting.label,
      description: describe(config),
      currentValue: current,
    };
    item.submenu = (_value, close) => {
      const persisted = readGlobalConfigValue(setting.id);
      const selectedValue =
        typeof persisted === "string" ? persisted : "default";
      const effective = loadConfig();
      item.currentValue = selectedValue;
      item.description = describe(effective);
      const available: ModelChoice[] = ctx.modelRegistry
        .getAvailable()
        .map((model) => {
          const check = feasibility?.(model, STAGE_BY_SETTING[setting.id]);
          const blocked = check && !check.selectable ? check.reason ?? "not eligible" : undefined;
          return {
            value: `${model.provider}/${model.id} — ${model.name}`,
            settingValue: `${model.provider}/${model.id}`,
            label: `${model.provider}/${model.id}`,
            description: blocked ? "unavailable: " + blocked : model.name,
            ...(blocked ? { blocked } : {}),
          };
        })
        .sort((left, right) => left.value.localeCompare(right.value));
      const choices: ModelChoice[] = [
        {
          value: `default — use the ${fallback}`,
          settingValue: "default",
          label: "default",
          description: `Use the ${fallback}`,
        },
        ...available,
      ];
      if (
        selectedValue !== "default" &&
        !choices.some((candidate) => candidate.settingValue === selectedValue)
      ) {
        choices.splice(1, 0, {
          value: selectedValue,
          settingValue: selectedValue,
          label: selectedValue,
          description: "Configured model is currently unavailable",
        });
      }
      return new ModelSettingEditor(
        choices,
        selectedValue,
        requestRender,
        async (selected) => {
          const effective = await writeConfig(
            setting.id,
            selected === "default" ? undefined : selected,
          );
          item.currentValue = selected;
          item.description = describe(effective);
        },
        close,
      );
    };
    return item;
  });
}

/** Row that opens the model picker for one model setting. */
export function modelSettingItem(
  id: (typeof MODEL_SETTINGS)[number]["id"],
  ctx: ExtensionCommandContext,
  requestRender: () => void,
  writeConfig: GlobalConfigWriter,
  feasibility?: ModelFeasibility,
): SettingItem {
  return modelSettingsItems(ctx, requestRender, writeConfig, feasibility).find((item) => item.id === id)!;
}

export function complexConfigPaths(): GlobalConfigPath[] {
  return [
    ...MODEL_SETTINGS.map((setting) => setting.id),
    MIN_CONTEXT_SETTING.id,
    ...LIMIT_SETTINGS.map((setting) => setting.id),
    BACKUP_DIR_SETTING.id,
    PIN_PATHS_SETTING.id,
    ...HINDSIGHT_SETTINGS.map((setting) => setting.id),
    ...PROFILE_NAMES.flatMap((profile) =>
      profileSettings(profile).map((setting) => setting.id),
    ),
  ];
}
