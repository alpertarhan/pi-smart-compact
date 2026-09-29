/**
 * Task-level profiles derived from existing global settings. Nothing new is
 * stored: a profile is recognised from its flags and applied as one atomic
 * patch of those flags. `undefined` in a patch means "reset to the built-in
 * default". Any other flag combination is "custom" and is never overwritten
 * implicitly.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompactConfig } from "../types.ts";
import { DEFAULT_CONFIG } from "../constants.ts";
import type { GlobalConfigPath, GlobalConfigValue } from "../utils/config.ts";
import { isNativeApi } from "../infra/native-protocol.ts";
import { canReadVisual } from "../app/visual-archive.ts";

export type ConfigPatch = Partial<Record<GlobalConfigPath, GlobalConfigValue>>;

export interface ProfileOption<Id extends string> {
  id: Id;
  label: string;
  /** What the user gets and what it costs, without promising more than the code does. */
  summary: string;
  patch: ConfigPatch;
}

export interface DerivedProfile<Id extends string> {
  /** The matching profile, or "custom" when the flags match none. */
  id: Id | "custom";
  /** Short name that fits a narrow value column. */
  label: string;
  /** One plain sentence on what the current flags do; set for defaults and custom states. */
  detail?: string;
}

function derive<Id extends string>(
  options: readonly ProfileOption<Id>[],
  matches: (option: ProfileOption<Id>) => boolean,
  custom: string,
): DerivedProfile<Id> {
  const found = options.find(matches);
  return found ? { id: found.id, label: found.label } : { id: "custom", label: custom };
}

// ── Behavior ──────────────────────────────────────────────────────────────

export type BehaviorProfileId = "manual" | "agent" | "cleanup" | "automatic";

export const BEHAVIOR_PROFILES: readonly ProfileOption<BehaviorProfileId>[] = [
  {
    id: "manual",
    label: "Manual only",
    summary: "Runs only when you start it (Compact now or /smart-compact). Nothing runs by itself.",
    patch: { autoTrigger: false, contextHygieneEnabled: false, agentToolAccess: "disabled" },
  },
  {
    id: "agent",
    label: "Manual + agent",
    summary: "You or the agent (smart_compact tool) can start it. Nothing runs by itself.",
    patch: { autoTrigger: false, contextHygieneEnabled: false, agentToolAccess: "enabled" },
  },
  {
    id: "cleanup",
    label: "Cleanup only",
    summary: "Archives safe old output using Cleanup timing (pressure-only by default). No model call, but history edits can rebuild the cache; never compacts by itself.",
    patch: { autoTrigger: false, contextHygieneEnabled: true, agentToolAccess: "disabled" },
  },
  {
    id: "automatic",
    label: "Fully automatic",
    summary: "Cleanup, plus compaction started by Smart Compact once the agent is idle and context reaches Start at % (with a cooldown). Works even if Pi's own auto-compaction is off.",
    patch: { autoTrigger: true, autoTriggerStrategy: "settled", contextHygieneEnabled: true, agentToolAccess: "disabled" },
  },
];

type BehaviorFlags = Pick<CompactConfig, "autoTrigger" | "autoTriggerStrategy" | "contextHygieneEnabled" | "contextPressureOnly" | "agentToolAccess">;

const STRATEGY_WORDS: Record<CompactConfig["autoTriggerStrategy"], string> = {
  "native-hook": "with Pi",
  settled: "when idle",
  background: "in background",
};

const AGENT_WORDS: Record<CompactConfig["agentToolAccess"], string> = {
  inherit: "follows Pi",
  enabled: "allowed",
  disabled: "not allowed",
};

export function deriveBehaviorProfile(config: BehaviorFlags): DerivedProfile<BehaviorProfileId> {
  // The built-in defaults match no profile; name them instead of "Custom".
  if (config.autoTrigger === DEFAULT_CONFIG.autoTrigger &&
      config.autoTriggerStrategy === DEFAULT_CONFIG.autoTriggerStrategy &&
      config.contextHygieneEnabled === DEFAULT_CONFIG.contextHygieneEnabled &&
      config.contextPressureOnly === DEFAULT_CONFIG.contextPressureOnly &&
      config.agentToolAccess === DEFAULT_CONFIG.agentToolAccess) {
    return {
      id: "custom",
      label: "Pressure-first (default)",
      detail: "Batched cleanup under early pressure, then idle compaction at the apply gate; agent access follows Pi.",
    };
  }
  // Presets that leave the trigger off do not pin its timing.
  const found = derive(
    BEHAVIOR_PROFILES,
    ({ patch }) => Object.entries(patch).every(([key, value]) => config[key as keyof BehaviorFlags] === value),
    "Custom",
  );
  if (found.id !== "custom") return found;
  return {
    ...found,
    detail: "Automatic " + (config.autoTrigger ? STRATEGY_WORDS[config.autoTriggerStrategy] : "off") +
      " · cleanup " + (config.contextHygieneEnabled ? "on" : "off") +
      " · agent " + AGENT_WORDS[config.agentToolAccess] + ".",
  };
}

// ── Output ────────────────────────────────────────────────────────────────

export type OutputProfileId = "verified" | "visual" | "native";

export const OUTPUT_PROFILES: readonly ProfileOption<OutputProfileId>[] = [
  {
    id: "verified",
    label: "Verified text",
    summary:
      "Text summary, checked against the conversation before it replaces history. Model calls depend on Mode; Fast may use none.",
    patch: { compactionEngines: undefined, visualArchiveEnabled: undefined },
  },
  {
    id: "visual",
    label: "Text + images",
    summary:
      "Verified text plus image snapshots of old output, only when the chat model passes the image-cost check (calibrated for Claude Sonnet 5 today). Otherwise text only.",
    patch: { compactionEngines: undefined, visualArchiveEnabled: true },
  },
  {
    id: "native",
    label: "Provider (experimental)",
    summary:
      "Your provider compacts on its side. Unchecked, tied to that provider and model, and may lose details. Falls back to verified text if it fails or the model is not supported.",
    patch: { compactionEngines: ["native", "eesv"], visualArchiveEnabled: undefined },
  },
];

type OutputFlags = Pick<CompactConfig, "compactionEngines" | "visualArchiveEnabled">;

const ENGINE_WORDS: Record<CompactConfig["compactionEngines"][number], string> = {
  eesv: "smart summary",
  native: "provider",
};

export function deriveOutputProfile(config: OutputFlags): DerivedProfile<OutputProfileId> {
  const engines = config.compactionEngines.join(",");
  const label = (id: OutputProfileId) => OUTPUT_PROFILES.find((option) => option.id === id)!.label;
  if (engines === "eesv") {
    return config.visualArchiveEnabled
      ? { id: "visual", label: label("visual") }
      : { id: "verified", label: label("verified") };
  }
  if (engines === "native,eesv" && !config.visualArchiveEnabled) {
    return { id: "native", label: label("native") };
  }
  return {
    id: "custom",
    label: "Custom",
    detail: "Tries " + config.compactionEngines.map((engine) => ENGINE_WORDS[engine]).join(", then ") +
      (config.visualArchiveEnabled ? ", with image snapshots" : "") + ".",
  };
}

/**
 * Why an output profile has no effect for the current chat model, or undefined
 * when it can apply. Visual and native depend on the model that reads the
 * compacted context, not on the summary route.
 */
export function outputProfileLimit(
  id: OutputProfileId,
  chatModel: Pick<Model<Api>, "provider" | "id" | "api" | "input"> | undefined,
): string | undefined {
  if (id === "verified") return undefined;
  if (!chatModel) return "no chat model selected";
  if (id === "native") {
    return isNativeApi(chatModel.api) ? undefined : chatModel.id + " has no provider compaction; uses verified text";
  }
  if (!canReadVisual(chatModel)) return chatModel.id + " cannot read images; uses text only";
  const calibrated = chatModel.provider === "anthropic" && chatModel.api === "anthropic-messages" &&
    chatModel.id === "claude-sonnet-5";
  return calibrated ? undefined : "image cost unknown for " + chatModel.id + "; uses text only";
}

// ── Models ────────────────────────────────────────────────────────────────

export type ModelProfileId = "chat" | "summary";

type ModelFlags = Pick<CompactConfig, "summaryModel" | "segmentationModel" | "verificationModel">;

/**
 * chat: every stage uses the chat model. summary: one chosen model for the
 * summary; segmentation and verification inherit it. Anything else is a
 * per-stage override.
 */
export function deriveModelProfile(config: ModelFlags): DerivedProfile<ModelProfileId> {
  if (config.segmentationModel !== null || config.verificationModel !== null) {
    return { id: "custom", label: "Custom per step", detail: "Topic split or check & repair uses its own model." };
  }
  return config.summaryModel === null
    ? { id: "chat", label: "Chat model" }
    : { id: "summary", label: config.summaryModel };
}

export function modelProfilePatch(id: ModelProfileId, summaryModel?: string): ConfigPatch {
  if (id === "summary" && !summaryModel) throw new Error("A summary model is required");
  return {
    summaryModel: id === "summary" ? summaryModel : undefined,
    segmentationModel: undefined,
    verificationModel: undefined,
  };
}
