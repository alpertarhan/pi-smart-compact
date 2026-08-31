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
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_NUMERIC_LIMITS,
  PROFILE_NUMERIC_BOUNDS,
  PROFILES,
} from "../constants.ts";
import type { CompactConfig, CompressionProfile } from "../types.ts";
import {
  type GlobalConfigPath,
  type GlobalConfigValue,
  loadConfig,
  readGlobalConfigValue,
  writeGlobalConfigValue,
} from "../utils/config.ts";

export type GlobalConfigWriter = (
  path: GlobalConfigPath,
  value: GlobalConfigValue,
) => Promise<CompactConfig>;

interface InputSetting {
  id: GlobalConfigPath;
  label: string;
  description: string;
  placeholder: string;
  parse(input: string): GlobalConfigValue;
  format(value: GlobalConfigValue): string;
}

const MODEL_SETTINGS = [
  {
    id: "summaryModel",
    label: "Summary model",
    description: "Model used for synthesis and verification fallback.",
  },
  {
    id: "segmentationModel",
    label: "Segmentation model",
    description: "Optional model used for transcript exploration.",
  },
  {
    id: "verificationModel",
    label: "Verification model",
    description: "Optional model used for repair after verification.",
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

const LIMIT_SETTINGS: readonly InputSetting[] = [
  {
    id: "minContextPercent",
    label: "Minimum context percent",
    description: "Auto compaction starts at or above this context usage.",
    placeholder: "0–100; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.minContextPercent),
    format: scalarFormat,
  },
  {
    id: "autoTriggerTimeoutMs",
    label: "Auto-trigger timeout",
    description: "Maximum host auto-compaction time in milliseconds.",
    placeholder: "1000–300000; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.autoTriggerTimeoutMs),
    format: scalarFormat,
  },
  {
    id: "maxLlmCalls",
    label: "Maximum LLM calls",
    description: "Zero uses the selected mode's call cap.",
    placeholder: "0–100; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.maxLlmCalls),
    format: scalarFormat,
  },
  {
    id: "maxLlmInputTokens",
    label: "Maximum LLM input tokens",
    description: "Zero uses the selected mode's token cap.",
    placeholder: "0–1000000; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.maxLlmInputTokens),
    format: scalarFormat,
  },
  {
    id: "codexMaxCallMs",
    label: "Codex call watchdog",
    description: "Zero derives the per-call watchdog automatically.",
    placeholder: "0 or 5000–300000; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.codexMaxCallMs),
    format: scalarFormat,
  },
  {
    id: "maxLatencyMs",
    label: "Pipeline latency limit",
    description: "Zero disables the overall pipeline deadline.",
    placeholder: "0 or 5000–600000; blank uses default",
    parse: numberParser(CONFIG_NUMERIC_LIMITS.maxLatencyMs),
    format: scalarFormat,
  },
];

const PATH_SETTINGS: readonly InputSetting[] = [
  {
    id: "backupDir",
    label: "Backup directory",
    description: "Directory for recovery Markdown files.",
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
  },
  {
    id: "pinPaths",
    label: "Pinned paths",
    description: "Comma-separated file paths that summaries must preserve.",
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
  },
];

const PROFILE_FIELDS = [
  ["summaryBudgetTokens", "Summary budget"],
  ["keepRecentTokens", "Recent raw tail"],
  ["minChunkTokens", "Minimum chunk"],
  ["maxChunkTokens", "Maximum chunk"],
  ["singlePassMaxTokens", "Single-pass limit"],
  ["batchMaxTokens", "Batch limit"],
] as const;

function profileSettings(profile: CompressionProfile): InputSetting[] {
  return PROFILE_FIELDS.map(([key, label]) => {
    const [min, max] = PROFILE_NUMERIC_BOUNDS[key];
    return {
      id: `profiles.${profile}.${key}` as GlobalConfigPath,
      label,
      description: `${profile} profile token budget; related chunk bounds must remain consistent.`,
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
    this.addChild(new Text(`Hint: ${setting.placeholder}`, 0, 0));
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
    this.addChild(new Text("Search provider/model", 0, 0));
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
      if (!selected) return;
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

function inputSettingsList(
  settings: readonly InputSetting[],
  requestRender: () => void,
  done: () => void,
  writeConfig: GlobalConfigWriter,
): SettingsList {
  const config = loadConfig();
  const items: SettingItem[] = settings.map((setting) => {
    const override = readGlobalConfigValue(setting.id);
    const item: SettingItem = {
      id: setting.id,
      label: setting.label,
      description: `${setting.description} Effective global value: ${setting.format(effectiveValue(config, setting.id))}.`,
      currentValue: setting.format(override),
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
          item.currentValue = setting.format(value);
          item.description = `${setting.description} Effective global value: ${setting.format(effectiveValue(effective, setting.id))}.`;
        },
        close,
      );
    };
    return item;
  });
  return new SettingsList(
    items,
    9,
    getSettingsListTheme(),
    () => {},
    done,
  );
}

export function modelSettingsItems(
  ctx: ExtensionCommandContext,
  requestRender: () => void,
  writeConfig: GlobalConfigWriter = writeGlobalConfigValue,
): SettingItem[] {
  const config = loadConfig();
  return MODEL_SETTINGS.map((setting) => {
    const override = readGlobalConfigValue(setting.id);
    const current = typeof override === "string" ? override : "default";
    const item: SettingItem = {
      id: setting.id,
      label: setting.label,
      description: `${setting.description} Effective global value: ${String(config[setting.id])}.`,
      currentValue: current,
    };
    item.submenu = (_value, close) => {
      const persisted = readGlobalConfigValue(setting.id);
      const selectedValue =
        typeof persisted === "string" ? persisted : "default";
      const effective = loadConfig();
      item.currentValue = selectedValue;
      item.description = `${setting.description} Effective global value: ${String(effective[setting.id])}.`;
      const available: ModelChoice[] = ctx.modelRegistry
        .getAvailable()
        .map((model) => ({
          value: `${model.provider}/${model.id} — ${model.name}`,
          settingValue: `${model.provider}/${model.id}`,
          label: `${model.provider}/${model.id}`,
          description: model.name,
        }))
        .sort((left, right) => left.value.localeCompare(right.value));
      const choices: ModelChoice[] = [
        {
          value: "default — use active session model",
          settingValue: "default",
          label: "default",
          description: "Remove the global model override",
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
          item.description = `${setting.description} Effective global value: ${String(effective[setting.id])}.`;
        },
        close,
      );
    };
    return item;
  });
}

export function complexSettingsCategories(
  ctx: ExtensionCommandContext,
  requestRender: () => void,
  writeConfig: GlobalConfigWriter = writeGlobalConfigValue,
): SettingItem[] {
  return [
    {
      id: "models",
      label: "Global models",
      description: "Stage-specific model routing",
      currentValue: "3 settings",
      submenu: (_value, done) =>
        new SettingsList(
          modelSettingsItems(ctx, requestRender, writeConfig),
          7,
          getSettingsListTheme(),
          () => {},
          done,
        ),
    },
    {
      id: "limits",
      label: "Global limits & performance",
      description: "Context threshold, call budgets, and timeouts",
      currentValue: "6 settings",
      submenu: (_value, done) =>
        inputSettingsList(
          LIMIT_SETTINGS,
          requestRender,
          done,
          writeConfig,
        ),
    },
    {
      id: "paths",
      label: "Global paths",
      description: "Backup directory and pinned summary paths",
      currentValue: "2 settings",
      submenu: (_value, done) =>
        inputSettingsList(
          PATH_SETTINGS,
          requestRender,
          done,
          writeConfig,
        ),
    },
    {
      id: "profiles",
      label: "Global profile budgets",
      description: "Advanced token-budget tuning for each profile",
      currentValue: "3 profiles",
      submenu: (_value, done) => {
        const profiles: SettingItem[] = PROFILE_NAMES.map((profile) => ({
          id: profile,
          label: profile,
          description: `Six token-budget settings for the ${profile} profile.`,
          currentValue: "6 settings",
          submenu: (_current, close) =>
            inputSettingsList(
              profileSettings(profile),
              requestRender,
              close,
              writeConfig,
            ),
        }));
        return new SettingsList(
          profiles,
          7,
          getSettingsListTheme(),
          () => {},
          done,
        );
      },
    },
  ];
}

export function complexConfigPaths(): GlobalConfigPath[] {
  return [
    ...MODEL_SETTINGS.map((setting) => setting.id),
    ...LIMIT_SETTINGS.map((setting) => setting.id),
    ...PATH_SETTINGS.map((setting) => setting.id),
    ...PROFILE_NAMES.flatMap((profile) =>
      profileSettings(profile).map((setting) => setting.id),
    ),
  ];
}
