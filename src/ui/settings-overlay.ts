import {
  getSettingsListTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  SettingsList,
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
  complexSettingsCategories,
  type GlobalConfigWriter,
} from "./settings-complex.ts";
import type {
  SmartCompactPolicy,
  SmartCompactPolicyField,
  SmartCompactPolicySnapshot,
} from "../app/smart-compact-policy.ts";

function enabled(value: boolean): "enabled" | "disabled" {
  return value ? "enabled" : "disabled";
}

interface GlobalChoiceSetting {
  id: GlobalConfigPath;
  label: string;
  description: string;
  values: readonly GlobalConfigValue[];
}

type GlobalChoiceGroup =
  | "behavior"
  | "reasoning"
  | "safety"
  | "advanced";

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
  ) {}

  display(id: GlobalConfigPath): string {
    return (
      this.pending.get(id)?.display ??
      choiceDisplay(readGlobalConfigValue(id))
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
    onApplied: GlobalSettingApplied = () => {},
  ): void {
    if (this.pending.size === 0) this.confirmedConfig = loadConfig();
    if (!this.pending.has(id)) {
      this.confirmed.set(id, choiceDisplay(readGlobalConfigValue(id)));
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
            display: this.confirmed.get(id) ?? "default",
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
const THINKING_VALUES = [
  null,
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const GLOBAL_CHOICE_SETTINGS: Record<
  GlobalChoiceGroup,
  readonly GlobalChoiceSetting[]
> = {
  behavior: [
    {
      id: "mode",
      label: "Compaction mode",
      description: "Default compaction strategy.",
      values: ["auto", "fast", "balanced", "thorough"],
    },
    {
      id: "profile",
      label: "Compression profile",
      description: "Legacy detail-budget profile.",
      values: ["light", "balanced", "aggressive"],
    },
    {
      id: "agentToolAccess",
      label: "Agent tool access",
      description: "Global default for agent-visible smart_compact access.",
      values: ["inherit", "enabled", "disabled"],
    },
    {
      id: "autoTrigger",
      label: "Automatic compaction",
      description: "Global default for pressure-triggered compaction.",
      values: BOOLEAN_VALUES,
    },
    {
      id: "showStatus",
      label: "Footer status",
      description: "Global default for the Smart Compact footer indicator.",
      values: BOOLEAN_VALUES,
    },
    {
      id: "autoTriggerStrategy",
      label: "Trigger strategy",
      description: "Host-native hook or settled-turn triggering.",
      values: ["native-hook", "settled"],
    },
  ],
  reasoning: [
    {
      id: "summaryThinkingLevel",
      label: "Summary thinking",
      description: "Thinking level for synthesis and repair.",
      values: THINKING_VALUES,
    },
    {
      id: "segmentationThinkingLevel",
      label: "Segmentation thinking",
      description: "Thinking level for transcript segmentation.",
      values: THINKING_VALUES,
    },
  ],
  safety: [
    {
      id: "backupEnabled",
      label: "Backups",
      description: "Write a recovery backup before applying a compacted summary.",
      values: BOOLEAN_VALUES,
    },
    {
      id: "requireApproval",
      label: "Require approval",
      description: "Ask before applying manual compaction output.",
      values: BOOLEAN_VALUES,
    },
    {
      id: "scrubSecrets",
      label: "Scrub secrets",
      description: "Redact likely credentials before model calls and memory writes.",
      values: BOOLEAN_VALUES,
    },
    {
      id: "scrubPii",
      label: "Scrub PII",
      description: "Redact email, phone, and payment-card shaped data.",
      values: BOOLEAN_VALUES,
    },
    {
      id: "contextGraphEnabled",
      label: "Project memory",
      description: "Index project context and expose recall/save tools.",
      values: BOOLEAN_VALUES,
    },
  ],
  advanced: [
    {
      id: "focusWeighting",
      label: "Focus weighting",
      description: "Steer synthesis toward the current task focus.",
      values: BOOLEAN_VALUES,
    },
    {
      id: "zeroCallEnabled",
      label: "Zero-call fast path",
      description: "Allow deterministic compaction without an LLM call.",
      values: BOOLEAN_VALUES,
    },
    {
      id: "telemetryChannel",
      label: "Telemetry channel",
      description: "Tag local metrics as stable or canary.",
      values: ["stable", "canary"],
    },
    {
      id: "adaptiveDamageFeedback",
      label: "Adaptive damage feedback",
      description: "Increase preservation budgets using prior damage signals.",
      values: BOOLEAN_VALUES,
    },
    {
      id: "onlineDamageMonitor",
      label: "Online damage monitor",
      description: "Monitor confirmed compactions for preservation damage.",
      values: BOOLEAN_VALUES,
    },
  ],
};

const GLOBAL_CHOICE_CATEGORIES: ReadonlyArray<{
  group: GlobalChoiceGroup;
  label: string;
  description: string;
}> = [
  {
    group: "behavior",
    label: "Global behavior",
    description: "Mode, profile, automation, and agent defaults",
  },
  {
    group: "reasoning",
    label: "Global reasoning",
    description: "Thinking-level defaults",
  },
  {
    group: "safety",
    label: "Global safety & storage",
    description: "Backups, approval, scrubbing, and project memory",
  },
  {
    group: "advanced",
    label: "Global advanced",
    description: "Focus, fast path, telemetry, and damage monitoring",
  },
];

function choiceDisplay(value: GlobalConfigValue): string {
  if (value === undefined) return "default";
  if (value === null) return "provider default";
  if (typeof value === "boolean") return enabled(value);
  return String(value);
}

function choiceValue(
  setting: GlobalChoiceSetting,
  display: string,
): GlobalConfigValue {
  if (display === "default") return undefined;
  const value = setting.values.find(
    (candidate) => choiceDisplay(candidate) === display,
  );
  if (value === undefined) {
    throw new Error(`Invalid value for ${setting.id}: ${display}`);
  }
  return value;
}

function effectiveChoiceDescription(
  setting: GlobalChoiceSetting,
  config: CompactConfig,
): string {
  const effective = config[
    setting.id as keyof CompactConfig
  ] as GlobalConfigValue;
  return `${setting.description} Effective global value: ${choiceDisplay(effective)}.`;
}

export function globalChoiceSettingsItems(
  group: GlobalChoiceGroup,
  config: CompactConfig,
  coordinator?: GlobalSettingsCoordinator,
): SettingItem[] {
  return GLOBAL_CHOICE_SETTINGS[group].map((setting) => ({
    id: setting.id,
    label: setting.label,
    description: effectiveChoiceDescription(setting, config),
    currentValue:
      coordinator?.display(setting.id) ??
      choiceDisplay(readGlobalConfigValue(setting.id)),
    values: ["default", ...setting.values.map(choiceDisplay)],
  }));
}

export async function updateGlobalChoiceSetting(
  group: GlobalChoiceGroup,
  id: string,
  display: string,
): Promise<CompactConfig> {
  const setting = GLOBAL_CHOICE_SETTINGS[group].find(
    (candidate) => candidate.id === id,
  );
  if (!setting) throw new Error(`Unknown global choice setting: ${id}`);
  return writeGlobalConfigValue(setting.id, choiceValue(setting, display));
}

function effectiveDescription(
  field: SmartCompactPolicyField,
  policy: SmartCompactPolicySnapshot,
): string {
  return field === "agentToolAccess"
    ? `Effective tool state: ${enabled(policy.agentToolEnabled)}`
    : `Effective value: ${enabled(policy[field])}`;
}

export function sessionSettingsItems(
  policy: SmartCompactPolicy,
): SettingItem[] {
  const current = policy.snapshot();
  const overrides = policy.branchOverrides();
  return [
    {
      id: "agentToolAccess",
      label: "Agent access",
      description: effectiveDescription("agentToolAccess", current),
      currentValue: overrides.agentToolAccess ?? "global",
      values: ["global", "inherit", "enabled", "disabled"],
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
    case "agentToolAccess":
      if (value !== "inherit" && value !== "enabled" && value !== "disabled") {
        throw new Error(`Invalid agent access value: ${value}`);
      }
      return policy.update({ agentToolAccess: value }, ctx);
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
  return override;
}

function sessionSettingsList(
  policy: SmartCompactPolicy,
  ctx: ExtensionCommandContext,
  done: () => void,
): SettingsList {
  const items = sessionSettingsItems(policy);
  let list: SettingsList;
  list = new SettingsList(
    items,
    7,
    getSettingsListTheme(),
    (id, value) => {
      try {
        const result = updateSessionSetting(policy, ctx, id, value);
        const field = policyField(id);
        const item = items.find((candidate) => candidate.id === id);
        if (item) item.description = effectiveDescription(field, result.policy);
        if (!result.ok) {
          ctx.ui.notify(result.error, "error");
          list.updateValue(id, displayValue(field, policy));
        }
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
        list.updateValue(
          id,
          displayValue(policyField(id), policy),
        );
      }
    },
    done,
  );
  return list;
}

function globalChoiceSettingsList(
  group: GlobalChoiceGroup,
  ctx: ExtensionCommandContext,
  done: () => void,
  requestRender: () => void,
  coordinator: GlobalSettingsCoordinator,
  onApplied: GlobalSettingApplied,
): SettingsList {
  const settings = GLOBAL_CHOICE_SETTINGS[group];
  const items = globalChoiceSettingsItems(group, loadConfig(), coordinator);
  let list: SettingsList;

  list = new SettingsList(
    items,
    9,
    getSettingsListTheme(),
    (id, display) => {
      coordinator.submit(group, id as GlobalConfigPath, display, (message) =>
        ctx.ui.notify(message, "error"),
        onApplied,
      );
    },
    () => {
      unsubscribe();
      done();
    },
  );
  const unsubscribe = coordinator.subscribe(
    settings.map((setting) => setting.id),
    (id, state) => {
      list.updateValue(id, state.display);
      if (state.config) {
        for (const setting of settings) {
          const item = items.find((candidate) => candidate.id === setting.id);
          if (item) {
            item.description = effectiveChoiceDescription(setting, state.config);
          }
        }
      }
      requestRender();
    },
  );
  return list;
}

export function settingsCategoryItems(
  policy: SmartCompactPolicy,
  ctx: ExtensionCommandContext,
  requestRender: () => void = () => {},
  coordinator: GlobalSettingsCoordinator = new GlobalSettingsCoordinator(),
  onApplied: GlobalSettingApplied = () => {},
  writeConfig: GlobalConfigWriter = writeGlobalConfigValue,
): SettingItem[] {
  return [
    {
      id: "session",
      label: "Current branch",
      description: "Agent access, automatic compaction, and footer status",
      currentValue: "3 settings",
      submenu: (_current, done) => sessionSettingsList(policy, ctx, done),
    },
    ...GLOBAL_CHOICE_CATEGORIES.map(({ group, label, description }) => ({
      id: group,
      label,
      description,
      currentValue: `${GLOBAL_CHOICE_SETTINGS[group].length} settings`,
      submenu: (_current: string, done: () => void) =>
        globalChoiceSettingsList(
          group,
          ctx,
          done,
          requestRender,
          coordinator,
          onApplied,
        ),
    })),
    ...complexSettingsCategories(ctx, requestRender, writeConfig),
  ];
}

export function createSettingsRoot(
  policy: SmartCompactPolicy,
  ctx: ExtensionCommandContext,
  onCancel: () => void,
  requestRender: () => void = () => {},
  coordinator: GlobalSettingsCoordinator = new GlobalSettingsCoordinator(),
  onApplied: GlobalSettingApplied = () => {},
  writeConfig: GlobalConfigWriter = writeGlobalConfigValue,
): SettingsList {
  return new SettingsList(
    settingsCategoryItems(
      policy,
      ctx,
      requestRender,
      coordinator,
      onApplied,
      writeConfig,
    ),
    8,
    getSettingsListTheme(),
    () => {},
    onCancel,
  );
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
  root: SettingsList,
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

/** Open the unified Smart Compact settings panel. */
export async function showSmartCompactSettings(
  ctx: ExtensionCommandContext,
  policy: SmartCompactPolicy,
  coordinator: GlobalSettingsCoordinator = new GlobalSettingsCoordinator(),
  onApplied: GlobalSettingApplied = () => {},
): Promise<void> {
  const writeConfig: GlobalConfigWriter = async (path, value) => {
    const config = await writeGlobalConfigValue(path, value);
    await onApplied(path, config);
    return config;
  };
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
        theme.fg("dim", "Global defaults and branch-specific overrides."),
        0,
        0,
      ),
    );
    container.addChild(
      new Text(
        theme.fg("dim", "Manual /smart-compact stays available in every mode."),
        0,
        0,
      ),
    );
    container.addChild(new Text("", 0, 0));
    container.addChild(root);
    container.addChild(new Text("", 0, 0));
    container.addChild(
      new Text(
        theme.fg("dim", "↑↓ navigate · enter open/change · esc back/close"),
        0,
        0,
      ),
    );
    return createSettingsController(root, container, () => tui.requestRender());
  });
}
