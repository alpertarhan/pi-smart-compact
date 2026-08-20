import fs from "node:fs";
import {
  CONFIG_KEY,
  CONFIG_KEY_ALT,
  DEFAULT_CONFIG,
  PROFILES,
} from "../constants.ts";
import { defaultBackupDir, settingsFile } from "../infra/paths.ts";
import type {
  CompactConfig,
  CompressionProfile,
  ProfileConfig,
} from "../types.ts";
import * as log from "./logger.ts";

const VALID_PROFILES = ["light", "balanced", "aggressive"] as const;
const VALID_MODES = ["auto", "fast", "balanced", "thorough"] as const;
const VALID_AUTO_TRIGGER_STRATEGIES = ["native-hook", "settled"] as const;
const VALID_AGENT_TOOL_ACCESS = ["inherit", "enabled", "disabled"] as const;
const VALID_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const BOOLEAN_KEYS = [
  "autoTrigger",
  "backupEnabled",
  "requireApproval",
  "scrubSecrets",
  "scrubPii",
  "focusWeighting",
  "zeroCallEnabled",
  "contextGraphEnabled",
  "adaptiveDamageFeedback",
  "onlineDamageMonitor",
] as const;
const NULLABLE_MODEL_KEYS = [
  "summaryModel",
  "segmentationModel",
  "verificationModel",
] as const;
const THINKING_KEYS = [
  "summaryThinkingLevel",
  "segmentationThinkingLevel",
] as const;
const PROFILE_NUMERIC_KEYS = [
  "summaryBudgetTokens",
  "keepRecentTokens",
  "minChunkTokens",
  "maxChunkTokens",
  "singlePassMaxTokens",
  "batchMaxTokens",
] as const;
const PROFILE_NUMERIC_BOUNDS: Record<
  (typeof PROFILE_NUMERIC_KEYS)[number],
  readonly [number, number]
> = {
  summaryBudgetTokens: [256, 100_000],
  keepRecentTokens: [1_000, 500_000],
  minChunkTokens: [100, 100_000],
  maxChunkTokens: [500, 200_000],
  singlePassMaxTokens: [1_000, 500_000],
  batchMaxTokens: [1_000, 500_000],
};

function discard(
  sc: Record<string, unknown>,
  key: string,
  message: string,
): void {
  log.warn(message);
  delete sc[key];
}

function validateBasicFields(sc: Record<string, unknown>): void {
  if (!("agentToolAccess" in sc) && typeof sc.agentToolEnabled === "boolean") {
    log.warn(
      "smart-compact config: agentToolEnabled is deprecated; use agentToolAccess.",
    );
    sc.agentToolAccess = sc.agentToolEnabled ? "enabled" : "disabled";
  }
  delete sc.agentToolEnabled;
  if (
    "agentToolAccess" in sc &&
    !VALID_AGENT_TOOL_ACCESS.includes(sc.agentToolAccess as never)
  ) {
    discard(
      sc,
      "agentToolAccess",
      "smart-compact config: agentToolAccess must be inherit|enabled|disabled.",
    );
  }
  if (sc.mode === "aggressive") {
    log.warn(
      "smart-compact config: mode 'aggressive' is deprecated; using 'fast'.",
    );
    sc.mode = "fast";
  }
  if ("mode" in sc && !VALID_MODES.includes(sc.mode as never)) {
    discard(
      sc,
      "mode",
      "smart-compact config: invalid mode '" +
        sc.mode +
        "', expected auto|fast|balanced|thorough. Using default 'auto'.",
    );
  }
  if (
    "telemetryChannel" in sc &&
    sc.telemetryChannel !== "stable" &&
    sc.telemetryChannel !== "canary"
  ) {
    discard(
      sc,
      "telemetryChannel",
      "smart-compact config: telemetryChannel must be stable|canary, got " +
        String(sc.telemetryChannel),
    );
  }
  if ("profile" in sc && !VALID_PROFILES.includes(sc.profile as never)) {
    discard(
      sc,
      "profile",
      "smart-compact config: invalid profile '" +
        sc.profile +
        "', expected light|balanced|aggressive. Using default 'balanced'.",
    );
  }
  if (
    "autoTriggerStrategy" in sc &&
    !VALID_AUTO_TRIGGER_STRATEGIES.includes(sc.autoTriggerStrategy as never)
  ) {
    discard(
      sc,
      "autoTriggerStrategy",
      "smart-compact config: autoTriggerStrategy must be native-hook|settled, got " +
        String(sc.autoTriggerStrategy) +
        ". Using default '" +
        DEFAULT_CONFIG.autoTriggerStrategy +
        "'.",
    );
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in sc && typeof sc[key] !== "boolean") {
      discard(
        sc,
        key,
        "smart-compact config: " +
          key +
          " must be boolean, got " +
          typeof sc[key],
      );
    }
  }
  for (const key of NULLABLE_MODEL_KEYS) {
    if (key in sc && sc[key] !== null && typeof sc[key] !== "string") {
      discard(
        sc,
        key,
        "smart-compact config: " +
          key +
          " must be string|null, got " +
          typeof sc[key],
      );
    }
  }
  for (const key of THINKING_KEYS) {
    const value = sc[key];
    if (
      key in sc &&
      value !== null &&
      !(
        typeof value === "string" &&
        VALID_THINKING_LEVELS.includes(value as never)
      )
    ) {
      discard(
        sc,
        key,
        "smart-compact config: " +
          key +
          " must be minimal|low|medium|high|xhigh|max|null.",
      );
    }
  }
}

function validateProfiles(sc: Record<string, unknown>): void {
  if (!("profiles" in sc)) return;
  if (
    typeof sc.profiles !== "object" ||
    sc.profiles === null ||
    Array.isArray(sc.profiles)
  ) {
    discard(
      sc,
      "profiles",
      "smart-compact config: profiles must be an object, got " +
        typeof sc.profiles,
    );
    return;
  }
  const profiles = sc.profiles as Record<string, unknown>;
  for (const [profileName, value] of Object.entries(profiles)) {
    if (!VALID_PROFILES.includes(profileName as never)) {
      discard(
        profiles,
        profileName,
        "smart-compact config: ignoring unknown profile override '" +
          profileName +
          "'.",
      );
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      discard(
        profiles,
        profileName,
        "smart-compact config: profile '" +
          profileName +
          "' must be an object.",
      );
      continue;
    }
    const profileCfg = value as Record<string, unknown>;
    for (const [key, raw] of Object.entries(profileCfg)) {
      if (!PROFILE_NUMERIC_KEYS.includes(key as never)) {
        discard(
          profileCfg,
          key,
          "smart-compact config: ignoring unknown profile key '" +
            profileName +
            "." +
            key +
            "'.",
        );
        continue;
      }
      const [min, max] =
        PROFILE_NUMERIC_BOUNDS[key as keyof typeof PROFILE_NUMERIC_BOUNDS];
      if (
        typeof raw !== "number" ||
        !Number.isSafeInteger(raw) ||
        raw < min ||
        raw > max
      ) {
        discard(
          profileCfg,
          key,
          "smart-compact config: profile '" +
            profileName +
            "." +
            key +
            "' must be an integer in " +
            min +
            "–" +
            max +
            ".",
        );
      }
    }
    const merged = {
      ...PROFILES[profileName as CompressionProfile],
      ...profileCfg,
    };
    if (
      merged.minChunkTokens > merged.maxChunkTokens ||
      merged.maxChunkTokens > merged.batchMaxTokens
    ) {
      discard(
        profiles,
        profileName,
        "smart-compact config: profile '" +
          profileName +
          "' requires minChunkTokens <= maxChunkTokens <= batchMaxTokens; ignoring the override.",
      );
    }
  }
}

interface NumericRule {
  key: string;
  valid: (value: number) => boolean;
  message: (value: unknown) => string;
}

const NUMERIC_RULES: readonly NumericRule[] = [
  {
    key: "autoTriggerTimeoutMs",
    valid: (value) =>
      Number.isFinite(value) && value >= 1_000 && value <= 300_000,
    message: (value) =>
      "smart-compact config: autoTriggerTimeoutMs must be 1000–300000, got " +
      value +
      ". Using default " +
      DEFAULT_CONFIG.autoTriggerTimeoutMs +
      "ms.",
  },
  {
    key: "maxLlmCalls",
    valid: (value) => Number.isInteger(value) && value >= 0 && value <= 100,
    message: () =>
      "smart-compact config: maxLlmCalls must be 0–100; 0 uses the selected mode cap.",
  },
  {
    key: "maxLlmInputTokens",
    valid: (value) =>
      Number.isInteger(value) && value >= 0 && value <= 1_000_000,
    message: () =>
      "smart-compact config: maxLlmInputTokens must be 0–1000000; 0 uses the mode cap.",
  },
  {
    key: "codexMaxCallMs",
    valid: (value) =>
      Number.isInteger(value) &&
      (value === 0 || (value >= 5_000 && value <= 300_000)),
    message: () =>
      "smart-compact config: codexMaxCallMs must be 0 or 5000–300000; 0 derives a cap from maxTokens.",
  },
  {
    key: "maxLatencyMs",
    valid: (value) =>
      Number.isFinite(value) &&
      (value === 0 || (value >= 5_000 && value <= 600_000)),
    message: () =>
      "smart-compact config: maxLatencyMs must be 0 or 5000–600000; 0 means unlimited.",
  },
  {
    key: "minContextPercent",
    valid: (value) => Number.isFinite(value) && value >= 0 && value <= 100,
    message: (value) =>
      "smart-compact config: minContextPercent must be 0–100, got " +
      value +
      ". Using default " +
      DEFAULT_CONFIG.minContextPercent +
      ".",
  },
];

function validateLimits(sc: Record<string, unknown>): void {
  for (const rule of NUMERIC_RULES) {
    if (!(rule.key in sc)) continue;
    const value = sc[rule.key];
    if (typeof value !== "number" || !rule.valid(value)) {
      discard(sc, rule.key, rule.message(value));
    }
  }
  if (
    "backupDir" in sc &&
    sc.backupDir !== undefined &&
    typeof sc.backupDir !== "string"
  ) {
    discard(
      sc,
      "backupDir",
      "smart-compact config: backupDir must be a string, got " +
        typeof sc.backupDir +
        ". Using default.",
    );
  }
  if (
    "pinPaths" in sc &&
    sc.pinPaths !== undefined &&
    (!Array.isArray(sc.pinPaths) ||
      !sc.pinPaths.every((value) => typeof value === "string"))
  ) {
    discard(
      sc,
      "pinPaths",
      "smart-compact config: pinPaths must be a string[], ignoring.",
    );
  }
}

/** Remove invalid user values so the defaults merge remains authoritative. */
export function validateSmartCompactConfig(sc: Record<string, unknown>): void {
  validateBasicFields(sc);
  validateProfiles(sc);
  validateLimits(sc);
}

let cachedConfig: CompactConfig | null = null;
let cachedMtime = 0;
let cachedPath: string | null = null;

/** Test helper — forces the next loadConfig() to re-read settings.json. */
export function resetConfigCache(): void {
  cachedConfig = null;
  cachedMtime = 0;
  cachedPath = null;
}

export function loadConfig(): CompactConfig {
  try {
    const file = settingsFile();
    const stat = fs.statSync(file);
    if (cachedConfig && cachedPath === file && stat.mtimeMs === cachedMtime)
      return cachedConfig;
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const sc = raw[CONFIG_KEY] ?? raw[CONFIG_KEY_ALT] ?? {};
    validateSmartCompactConfig(sc as Record<string, unknown>);
    const merged = { ...DEFAULT_CONFIG, ...sc } as CompactConfig;
    if (!("mode" in sc) && "profile" in sc) {
      merged.mode =
        sc.profile === "light"
          ? "thorough"
          : (sc.profile as CompactConfig["mode"]);
    }
    if (sc.profiles) {
      merged.profiles = { ...PROFILES, ...sc.profiles } as Record<
        CompressionProfile,
        ProfileConfig
      >;
    }
    if (!merged.backupDir) merged.backupDir = defaultBackupDir();
    cachedConfig = merged;
    cachedMtime = stat.mtimeMs;
    cachedPath = file;
    return cachedConfig;
  } catch (error) {
    log.debug(
      "loadConfig: settings.json not found or unreadable, using defaults",
      error,
    );
    cachedConfig = {
      ...DEFAULT_CONFIG,
      backupDir: defaultBackupDir(),
    } as CompactConfig;
    cachedPath = null;
    return cachedConfig;
  }
}
