/** Task-oriented Home; settings and diagnostics stay one level below actions. */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  getKeybindings,
  Key,
  matchesKey,
  type SettingItem,
  Text,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { CompactConfig } from "../types.ts";
import { loadConfig } from "../utils/config.ts";
import type { SmartCompactPolicy } from "../app/smart-compact-policy.ts";
import { SmartSettingsList } from "./settings-list.ts";
import type { EffectiveReadiness } from "../app/effective-state.ts";
import { localGraphOpsAllowed } from "../app/memory-backend.ts";
import {
  createSettingsController,
  createSettingsRoot,
  type GlobalSettingApplied,
  GlobalSettingsCoordinator,
  invalidSettingsLine,
  settingsCategoryItems,
} from "./settings-overlay.ts";
import {
  BEHAVIOR_PROFILES,
  type ConfigPatch,
  deriveBehaviorProfile,
  deriveModelProfile,
  deriveOutputProfile,
  modelProfilePatch,
  OUTPUT_PROFILES,
  outputProfileLimit,
  type ProfileOption,
} from "./profiles.ts";
import type { ModelFeasibility } from "../app/model-feasibility.ts";
import type { NavigationPanelActions } from "../app/navigation-types.ts";
import { type DeferredTrim, formatDeferredTrim } from "../app/register-smart-context-tool.ts";

export type HomeAction =
  | "compact" | "trim" | "metrics" | "dashboard" | "restore" | "loops" | "forget" | "storage" | "navigation" | "handoff";


export interface HomeOptions {
  ctx: ExtensionCommandContext;
  policy: SmartCompactPolicy;
  coordinator: GlobalSettingsCoordinator;
  onApplied: GlobalSettingApplied;
  /** Writes a whole patch atomically and applies runtime state once. */
  applyPatch: (patch: ConfigPatch) => Promise<CompactConfig>;
  /** Value for the primary row, or the reason it cannot run. */
  compactNow: () => { value: string; blocked?: string };
  /** Local, read-only readiness (no provider, server, auth or DB contact). */
  readiness: () => Promise<EffectiveReadiness>;
  /** Full effective-state text shown below the readiness summary. */
  effectiveState: () => Promise<string>;
  feasibility?: ModelFeasibility;
  /** Session navigation; absent hides the row. The panel itself opens after Home closes. */
  navigation?: NavigationPanelActions;
  /** One line describing which Smart Compact tools the agent currently sees. */
  toolSummary?: () => string;
  /** Automatic trim held for a cold prompt cache; shown on the cleanup row. */
  deferredTrim?: () => DeferredTrim | null;
}

/** Why local project-memory operations are off for this configuration. */
export function localGraphOffReason(config: Pick<CompactConfig, "memoryBackend" | "contextGraphEnabled">): string {
  if (!config.contextGraphEnabled) return "Project memory is off.";
  const backend = config.memoryBackend === "hindsight" ? "Hindsight server" : "Mnemopi";
  return "Memory store is " + backend + ", so the local project graph is not used. Choose This machine under Memory store to manage local data.";
}

/** Scrollable read-only text; SettingsList renders submenus without a height. */
export class TextPanel implements Component {
  private top = 0;
  private page = 1;
  private maxTop = 0;
  constructor(private readonly lines: () => string[], private readonly close: () => void) { }
  render(width: number): string[] {
    const out = this.lines().flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)).map((part) => "  " + part));
    this.page = Math.max(4, Math.min(18, (process.stdout.rows ?? 30) - 14));
    this.maxTop = Math.max(0, out.length - this.page);
    this.top = Math.min(this.top, this.maxTop);
    return [...out.slice(this.top, this.top + this.page), "",
    this.maxTop ? "  ↑↓ / PgUp PgDn scroll · Esc back" : "  Enter / Esc back"];
  }
  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm")) return this.close();
    if (keys.matches(data, "tui.select.up")) this.top--;
    else if (keys.matches(data, "tui.select.down")) this.top++;
    else if (keys.matches(data, "tui.select.pageUp")) this.top -= this.page;
    else if (keys.matches(data, "tui.select.pageDown")) this.top += this.page;
    else if (matchesKey(data, Key.home)) this.top = 0;
    else if (matchesKey(data, Key.end)) this.top = this.maxTop;
    this.top = Math.max(0, Math.min(this.top, this.maxTop));
  }
  invalidate(): void { }
}

function scopeSuffix(policy: SmartCompactPolicy): string {
  const overrides = Object.keys(policy.branchOverrides()).length;
  return overrides ? " · this branch overrides " + overrides : "";
}

/** A radio list of profiles; Enter applies. `confirm` ids need a second Enter. */
function profileList<Id extends string>(
  options: readonly ProfileOption<Id>[],
  current: () => { id: Id | "custom"; label: string; detail?: string },
  limit: (id: Id) => string | undefined,
  confirm: ReadonlySet<Id>,
  apply: (patch: ConfigPatch) => Promise<unknown>,
  done: (label?: string) => void,
  notify: (message: string) => void,
  extra: SettingItem[] = [],
  onExtra: (id: string) => boolean = () => false,
): SmartSettingsList {
  let armed: Id | undefined;
  const now = current();
  const rows: SettingItem[] = [
    ...(now.id === "custom"
      ? [{ id: "now", label: "Current setup", currentValue: now.label, description: (now.detail ? now.detail + " " : "") + "Choosing a preset replaces these settings." }]
      : []),
    ...options.map((option) => {
      const reason = limit(option.id);
      return {
        id: option.id, label: option.label,
        currentValue: option.id === now.id ? "current" : reason ? "text only now" : "",
        description: option.summary + (reason ? " Now: " + reason + "." : ""),
      };
    }),
    ...extra,
  ];
  const list = new SmartSettingsList(rows, 9, () => { }, () => done(), () => { }, new Set(), (id) => {
    if (onExtra(id)) return true;
    const option = options.find((candidate) => candidate.id === id);
    if (!option) return true; // "Now" is informational
    if (confirm.has(option.id) && armed !== option.id && current().id !== option.id) {
      armed = option.id;
      list.updateValue(option.id, "Enter again to use");
      return true;
    }
    void apply(option.patch).then(
      () => done(current().label),
      (error: unknown) => notify(error instanceof Error ? error.message : String(error)),
    );
    return true;
  });
  list.selectItem(now.id === "custom" ? "now" : now.id);
  return list;
}

function modelPicker(
  ctx: ExtensionCommandContext,
  feasibility: ModelFeasibility | undefined,
  apply: (patch: ConfigPatch) => Promise<unknown>,
  done: (label?: string) => void,
  notify: (message: string) => void,
): SmartSettingsList {
  const models = ctx.modelRegistry.getAvailable()
    .slice()
    .sort((a, b) => (a.provider + "/" + a.id).localeCompare(b.provider + "/" + b.id));
  const byId = new Map(models.map((model) => [model.provider + "/" + model.id, model]));
  const verdict = (model: Model<Api>) => feasibility?.(model, "summary") ?? { selectable: true };
  const rows: SettingItem[] = models.map((model) => {
    const check = verdict(model);
    return {
      id: model.provider + "/" + model.id,
      label: model.provider + "/" + model.id,
      currentValue: check.selectable ? "" : "unavailable",
      description: check.selectable
        ? model.name + ". Segmentation and verification use it too."
        : "Cannot be used for the summary: " + (check.reason ?? "not eligible.").replace(/([^.])$/, "$1."),
    };
  });
  if (!rows.length) {
    rows.push({ id: "none", label: "No models", currentValue: "", description: "No model has credentials. Log in with /login or set a provider API key." });
  }
  return new SmartSettingsList(rows, 9, () => { }, () => done(), () => { }, new Set(), (id) => {
    const model = byId.get(id);
    if (!model || !verdict(model).selectable) return true; // visible but not selectable
    void apply(modelProfilePatch("summary", id)).then(
      () => done(deriveModelProfile(loadConfig()).label),
      (error: unknown) => notify(error instanceof Error ? error.message : String(error)),
    );
    return true;
  });
}

export function createHomeList(
  options: HomeOptions,
  finish: (action?: HomeAction) => void,
  requestRender: () => void,
): SmartSettingsList {
  const { ctx, policy } = options;
  const notify = (message: string) => ctx.ui.notify(message, "error");
  const apply = async (patch: ConfigPatch) => {
    const config = await options.applyPatch(patch);
    refresh(config);
    requestRender();
    return config;
  };
  const categories = settingsCategoryItems(
    policy, ctx, requestRender, options.coordinator, options.onApplied, undefined, options.feasibility,
  );
  const category = (id: string) => categories.find((item) => item.id === id)!;
  const memoryBackendLabel = (config: CompactConfig) =>
    ({ local: "This machine", hindsight: "Hindsight server", mnemopi: "Mnemopi" })[config.memoryBackend];

  const compact: SettingItem = { id: "compact", label: "Compact now", currentValue: "" };
  const trim: SettingItem = {
    id: "trim",
    label: "Clean up tool output",
    currentValue: "no model call",
    description: "Queue cleanup for the next completed turn. Older output stays retrievable; the next model request is still sent untrimmed.",
  };
  const setup: SettingItem = {
    id: "setup",
    label: "Status & help",
    currentValue: "checking",
    description: "Check what can run, resolve setup issues, or review recent results. Nothing is sent to a provider.",
  };
  const behavior: SettingItem = { id: "behavior", label: "How it runs", currentValue: "" };
  const output: SettingItem = { id: "output", label: "Summary format", currentValue: "" };
  const models: SettingItem = { id: "models", label: "Models", currentValue: "" };
  const memory: SettingItem = { ...category("memory"), label: "Memory", currentValue: "" };
  const tools = category("navigation");
  const toolsDescription = tools.description;
  const history: SettingItem = {
    id: "history",
    label: "History & recovery",
    currentValue: "",
    description: (options.navigation ? "Browse or return to anchors in this session, hand off to a new session, restore a backup" : "Hand off to a new session, restore a backup") +
      ", review unfinished tasks, or inspect saved tool output.",
  };
  const metrics: SettingItem = { id: "metrics", label: "Metrics", currentValue: "", description: "Report and dashboard, including the effective state." };
  const advanced: SettingItem = {
    id: "advanced",
    label: "Advanced settings",
    currentValue: "",
    description: "Every setting by category, and overrides for this branch only.",
  };

  const settings: SettingItem = {
    id: "settings", label: "Settings", currentValue: "",
    description: "Choose how it runs, summary format, models and optional memory. Changes save when applied; Esc goes back.",
  };
  const refresh = (config: CompactConfig = loadConfig()) => {
    const state = options.compactNow();
    const held = options.deferredTrim?.() ?? null;
    trim.currentValue = held ? "held for a cold cache" : "no model call";
    trim.description = held
      ? formatDeferredTrim(held) + " Choose to apply it at the next completed turn instead."
      : "Queue cleanup for the next completed turn. Older output stays retrievable; the next model request is still sent untrimmed.";
    compact.currentValue = state.blocked ? "unavailable" : "choose options";
    compact.description = state.blocked
      ? state.blocked
      : "Summarize older messages while keeping recent context. Choose an approach before starting.";
    const behaviorProfile = deriveBehaviorProfile(config);
    behavior.currentValue = behaviorProfile.label + scopeSuffix(policy);
    behavior.description = (behaviorProfile.detail ? behaviorProfile.detail + " " : "") +
      "Choose who starts cleanup and compaction. Changes apply to global defaults" +
      (scopeSuffix(policy) ? "; this branch has overrides (see This branch)." : ".");
    const out = deriveOutputProfile(config);
    const outLimit = out.id === "custom" ? undefined : outputProfileLimit(out.id, ctx.model);
    output.currentValue = out.label + (outLimit ? " (text only now)" : "");
    output.description = (out.detail ?? "Checked text, text with images, or experimental provider compaction.") + (outLimit ? " Now: " + outLimit + "." : "");
    const modelProfile = deriveModelProfile(config);
    models.currentValue = modelProfile.label;
    models.description = (modelProfile.detail ? modelProfile.detail + " " : "") +
      "Choose the summary model. Manual, agent and automatic runs use the same model settings.";
    memory.currentValue = config.contextGraphEnabled ? memoryBackendLabel(config) : "off";
    tools.description = toolsDescription + (options.toolSummary ? ". Now: " + options.toolSummary() : "");
    updateReadiness();
  };
  // Re-read after every refresh: settings changes can change blockers and capacity.
  let readinessRevision = 0;
  const setupDescription = setup.description;
  const updateReadiness = () => {
    const revision = ++readinessRevision;
    void options.readiness().then((readiness) => {
      if (revision !== readinessRevision) return;
      setup.currentValue = readinessValue(readiness);
      setup.description = readiness.blockers[0] ?? setupDescription;
      requestRender();
    }, () => { });
  };

  const readinessLines = (readiness: EffectiveReadiness): string[] => [
    readiness.canCompact
      ? "Compaction: local checks pass (provider acceptance and billing are not verified)."
      : "Compaction: blocked by a local check.",
    ...readiness.blockers.map((line) => "✗ " + line),
    ...readiness.warnings.map((line) => "! " + line),
    (readiness.memory.ready ? "Memory: local checks pass. " : "Memory: not ready. ") + readiness.memory.reason,
  ];
  const readinessValue = (readiness: EffectiveReadiness): string =>
    readiness.canCompact ? "local checks pass" : "needs attention";
  refresh();
  const readinessItem: SettingItem = {
    id: "readiness", label: "Readiness & details", currentValue: "",
    description: "Local checks, effective settings and setup guidance. No connection or billing check.",
  };
  readinessItem.submenu = (_value, done) => {
    let lines = ["Checking…"];
    void Promise.all([options.readiness(), options.effectiveState()]).then(([readiness, state]) => {
      setup.currentValue = readinessValue(readiness);
      lines = [...readinessLines(readiness), "", "Effective state", ...state.split("\n")];
      requestRender();
    }, (error: unknown) => {
      lines = ["Readiness could not be read: " + (error instanceof Error ? error.message : String(error))];
      requestRender();
    });
    return new TextPanel(() => ["Readiness & details", "", ...lines], () => done());
  };
  behavior.submenu = (_value, done) => {
    const branch = category("session");
    return profileList(
      BEHAVIOR_PROFILES,
      () => deriveBehaviorProfile(loadConfig()),
      () => undefined,
      new Set(),
      apply,
      (label) => {
        refresh();
        done(label === undefined ? undefined : behavior.currentValue);
      },
      notify,
      [{ ...branch, label: "This branch", currentValue: String(branch.currentValue) }],
      () => false,
    );
  };
  output.submenu = (_value, done) =>
    profileList(
      OUTPUT_PROFILES,
      () => deriveOutputProfile(loadConfig()),
      (id) => outputProfileLimit(id, ctx.model),
      new Set(["native"]),
      apply,
      (label) => {
        refresh();
        done(label === undefined ? undefined : output.currentValue);
      },
      notify,
    );
  models.submenu = (_value, done) => {
    const close = (label?: string) => {
      refresh();
      done(label === undefined ? undefined : models.currentValue);
    };
    const perStage = { ...category("models"), label: "Advanced model routing", currentValue: "" };
    const rows: SettingItem[] = [
      {
        id: "chat",
        label: "Chat model",
        currentValue: deriveModelProfile(loadConfig()).id === "chat" ? "current" : "",
        description: "Every stage uses the model you are chatting with.",
      },
      {
        id: "summary",
        label: "Choose summary model",
        currentValue: deriveModelProfile(loadConfig()).id === "summary" ? String(loadConfig().summaryModel) : "",
        description: "One model writes the summary; segmentation and verification inherit it.",
        // Picking returns to Settings; Esc goes back one level without writing.
        submenu: (_current, back) =>
          modelPicker(ctx, options.feasibility, apply, (label) => (label === undefined ? back() : close(label)), notify),
      },
      perStage,
    ];
    const list: SmartSettingsList = new SmartSettingsList(rows, 9, () => { }, () => close(), () => { }, new Set(), (id) => {
      if (id !== "chat") return false;
      void apply(modelProfilePatch("chat")).then(() => close(models.currentValue), (error: unknown) =>
        notify(error instanceof Error ? error.message : String(error)));
      return true;
    });
    return list;
  };
  const originalMemory = memory.submenu!;
  memory.submenu = (value, done) => originalMemory(value, () => {
    refresh();
    done();
  });
  history.submenu = (_value, done) => {
    const config = loadConfig();
    const localOps = localGraphOpsAllowed(config);
    const navigation = options.navigation?.availability();
    const rows: SettingItem[] = [
      ...(navigation ? [{
        id: "navigation",
        label: "Session navigation",
        currentValue: navigation.enabled ? "" : "off",
        description: navigation.enabled
          ? "Browse anchors, mark this point, search earlier sessions, or return to an anchor after reviewing it."
          : "Session navigation is off in Settings › Agent tools & navigation.",
      }] : []),
      {
        id: "handoff",
        label: "Hand off to a new session",
        currentValue: "",
        description: "Continue in a fresh session seeded with this session's anchor, ledger, always-kept files and memory. You add a note and review the seed first; nothing opens until you confirm.",
      },
      { id: "restore", label: "Restore a backup", currentValue: "", description: "Pick an earlier conversation state to restore." },
      { id: "loops", label: "Unfinished tasks", currentValue: "", description: "Review unresolved tasks kept across compactions." },
      {
        id: "storage",
        label: "Storage",
        currentValue: "",
        description: "Read-only inventory of saved tool output and retention. Nothing is deleted.",
      },
      {
        id: "forget",
        label: "Forget local project memory",
        currentValue: localOps ? "" : "unavailable",
        description: localOps
          ? "Choose what to delete and confirm; other stores and backups are not affected."
          : localGraphOffReason(config),
      },
    ];
    return new SmartSettingsList(rows, 9, () => { }, () => done(), () => { }, new Set(navigation?.enabled === false ? ["navigation"] : []), (id) => {
      if (id === "forget" && !localOps) return true;
      if (id === "navigation" && !navigation?.enabled) return true;
      finish(id as HomeAction);
      return true;
    });
  };
  metrics.submenu = (_value, done) =>
    new SmartSettingsList(
      [
        { id: "metrics", label: "Report", currentValue: "", description: "Effective state, recent issues and the metrics report as a message." },
        { id: "dashboard", label: "Dashboard", currentValue: "", description: "Interactive metrics dashboard." },
      ],
      9, () => { }, () => done(), () => { }, new Set(), (id) => {
        finish(id as HomeAction);
        return true;
      },
    );
  advanced.submenu = (_value, done) => {
    const root = createSettingsRoot(policy, ctx, () => {
      refresh();
      done();
    }, requestRender, options.coordinator, options.onApplied, undefined, options.feasibility);
    return root;
  };
  settings.submenu = (_value, done) => new SmartSettingsList(
    [behavior, output, models, memory, tools, advanced], 6, () => { },
    () => { refresh(); done(); },
  );
  setup.submenu = (_value, done) => new SmartSettingsList(
    [readinessItem, {
      id: "help", label: "Which action should I use?", currentValue: "",
      description: "Compaction, local cleanup and recovery in plain language.",
      submenu: (_current, back) => new TextPanel(() => [
        "Which action should I use?", "",
        "Compact now summarizes older messages to make room for continued work. You choose the approach and model before it starts.", "",
        "Clean up tool output makes old tool output shorter without a model call. Full output stays in local archives for retrieval. Cleanup is queued for the next completed turn, not applied immediately.", "",
        "Settings > How it runs controls manual, agent and automatic behavior. Automatic starts when Pi is idle; following Pi requires Pi to start compaction itself.", "",
        "History & recovery contains session navigation (anchors you can review and return to), backups, unfinished tasks and a read-only storage report. Memory is optional and separate from conversation backups.", "",
        "Esc goes back. A setting changes only when you apply it, not when you open a screen.",
      ], () => back()),
    }, metrics], 3, () => { }, () => done(),
  );

  return new SmartSettingsList(
    [compact, trim, settings, history, setup],
    5,
    () => { },
    () => finish(),
    () => { },
    new Set(),
    (id) => {
      if (id === "trim") {
        finish("trim");
        return true;
      }
      if (id !== "compact") return false;
      if (!options.compactNow().blocked) finish("compact");
      return true; // blocked: the reason stays visible below the list
    },
  );
}

/** Open the home screen; resolves with the chosen action, or undefined on Esc. */
export async function showSmartCompactHome(options: HomeOptions): Promise<HomeAction | undefined> {
  return options.ctx.ui.custom<HomeAction | undefined>((tui, theme, _keybindings, done) => {
    const list = createHomeList(options, done, () => tui.requestRender());
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("Smart Compact")), 0, 0));
    container.addChild({
      render(width: number) {
        const config = loadConfig();
        const policy = options.policy.snapshot();
        const automatic = !policy.autoTrigger ? "off"
          : config.autoTriggerStrategy === "native-hook" ? "follows Pi" : "when idle";
        const lines = [
          "Context: " + options.compactNow().value,
          "Automatic: " + automatic + " · Agent: " + (policy.agentToolEnabled ? "allowed" : "off"),
        ];
        return lines.flatMap(line => wrapTextWithAnsi(theme.fg("dim", line), Math.max(1, width)));
      },
      invalidate() { },
    });
    const invalid = invalidSettingsLine();
    if (invalid) container.addChild(new Text(theme.fg("warning", invalid), 0, 0));
    container.addChild(new Text("", 0, 0));
    container.addChild(list);
    return createSettingsController(list, container, () => tui.requestRender());
  });
}

