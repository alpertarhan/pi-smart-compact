import fs from "node:fs";
import {
  CONFIG_NUMERIC_LIMITS,
  CONFIG_KEY,
  CONFIG_KEY_ALT,
  DEFAULT_CONFIG,
  PROFILE_NUMERIC_BOUNDS,
  PROFILES,
} from "../constants.ts";
import { acquireLock, atomicWriteFile } from "../infra/fs.ts";
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
  "showStatus",
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
type TopLevelConfigKey = Exclude<keyof CompactConfig, "profiles">;
type ProfileNumericKey = (typeof PROFILE_NUMERIC_KEYS)[number];
export type GlobalConfigPath =
  | TopLevelConfigKey
  | `profiles.${CompressionProfile}.${ProfileNumericKey}`;
export type GlobalConfigValue =
  | CompactConfig[TopLevelConfigKey]
  | ProfileConfig[ProfileNumericKey]
  | undefined;

export function readGlobalConfigValue(
  configPath: GlobalConfigPath,
): GlobalConfigValue {
  assertGlobalConfigPath(configPath);
  try {
    const section = configuredSection(readSettingsRoot(settingsFile()));
    validateSmartCompactConfig(section);
    return cloneGlobalConfigValue(configPathValue(section, configPath));
  } catch {
    return undefined;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneProfiles(
  profiles: Record<CompressionProfile, ProfileConfig>,
): Record<CompressionProfile, ProfileConfig> {
  return Object.fromEntries(
    VALID_PROFILES.map((name) => [name, { ...profiles[name] }]),
  ) as Record<CompressionProfile, ProfileConfig>;
}

function cloneConfig(config: CompactConfig): CompactConfig {
  return {
    ...config,
    profiles: cloneProfiles(config.profiles),
    pinPaths: [...config.pinPaths],
  };
}

function defaultConfig(): CompactConfig {
  return cloneConfig({
    ...DEFAULT_CONFIG,
    backupDir: defaultBackupDir(),
  } as CompactConfig);
}

function cloneGlobalConfigValue(value: GlobalConfigValue): GlobalConfigValue {
  return Array.isArray(value) ? [...value] : value;
}

function readSettingsRoot(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("settings.json must contain valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("settings.json root must be an object");
  }
  return parsed;
}

function configuredSection(root: Record<string, unknown>): Record<string, unknown> {
  const selected = Object.hasOwn(root, CONFIG_KEY)
    ? root[CONFIG_KEY]
    : (root[CONFIG_KEY_ALT] ?? {});
  if (!isRecord(selected)) {
    throw new Error("smartCompact must be an object");
  }
  return structuredClone(selected);
}

function deleteEmptyProfileContainers(
  section: Record<string, unknown>,
  profile: CompressionProfile,
): void {
  if (!isRecord(section.profiles)) return;
  if (isRecord(section.profiles[profile])) {
    const values = section.profiles[profile] as Record<string, unknown>;
    if (Object.keys(values).length === 0) delete section.profiles[profile];
  }
  if (Object.keys(section.profiles).length === 0) delete section.profiles;
}

function setConfigPath(
  section: Record<string, unknown>,
  configPath: GlobalConfigPath,
  value: GlobalConfigValue,
): void {
  const parts = configPath.split(".");
  if (parts[0] !== "profiles") {
    if (value === undefined) delete section[configPath];
    else section[configPath] = value;
    return;
  }

  const [, profile, key] = parts as [
    "profiles",
    CompressionProfile,
    ProfileNumericKey,
  ];
  if (!isRecord(section.profiles)) section.profiles = {};
  const profiles = section.profiles as Record<string, unknown>;
  if (!isRecord(profiles[profile])) profiles[profile] = {};
  const values = profiles[profile] as Record<string, unknown>;
  if (value === undefined) delete values[key];
  else values[key] = value;
  deleteEmptyProfileContainers(section, profile);
}

function assertGlobalConfigPath(configPath: string): asserts configPath is GlobalConfigPath {
  if (configPath !== "profiles" && Object.hasOwn(DEFAULT_CONFIG, configPath)) {
    return;
  }
  const parts = configPath.split(".");
  if (
    parts.length === 3 &&
    parts[0] === "profiles" &&
    (VALID_PROFILES as readonly string[]).includes(parts[1]) &&
    (PROFILE_NUMERIC_KEYS as readonly string[]).includes(parts[2])
  ) {
    return;
  }
  throw new Error(`Unknown smartCompact setting path: ${configPath}`);
}

function configPathValue(
  section: Record<string, unknown>,
  configPath: GlobalConfigPath,
): GlobalConfigValue {
  const parts = configPath.split(".");
  if (parts[0] !== "profiles") {
    return section[configPath] as GlobalConfigValue;
  }
  const [, profile, key] = parts;
  if (!isRecord(section.profiles)) return undefined;
  const values = section.profiles[profile];
  return isRecord(values) ? (values[key] as GlobalConfigValue) : undefined;
}

function sameJsonValue(
  left: GlobalConfigValue,
  right: GlobalConfigValue,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
    !isRecord(sc.profiles)
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
    if (!isRecord(value)) {
      discard(
        profiles,
        profileName,
        "smart-compact config: profile '" +
          profileName +
          "' must be an object.",
      );
      continue;
    }
    const profileCfg = value;
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

function validNumericLimit(
  key: keyof typeof CONFIG_NUMERIC_LIMITS,
  value: number,
): boolean {
  const limit = CONFIG_NUMERIC_LIMITS[key];
  return (
    Number.isFinite(value) &&
    (!limit.integer || Number.isSafeInteger(value)) &&
    ((value >= limit.min && value <= limit.max) ||
      ("zeroOrRange" in limit && limit.zeroOrRange && value === 0))
  );
}

const NUMERIC_RULES: readonly NumericRule[] = [
  {
    key: "autoTriggerTimeoutMs",
    valid: (value) => validNumericLimit("autoTriggerTimeoutMs", value),
    message: (value) =>
      "smart-compact config: autoTriggerTimeoutMs must be 1000–300000, got " +
      value +
      ". Using default " +
      DEFAULT_CONFIG.autoTriggerTimeoutMs +
      "ms.",
  },
  {
    key: "maxLlmCalls",
    valid: (value) => validNumericLimit("maxLlmCalls", value),
    message: () =>
      "smart-compact config: maxLlmCalls must be 0–100; 0 uses the selected mode cap.",
  },
  {
    key: "maxLlmInputTokens",
    valid: (value) => validNumericLimit("maxLlmInputTokens", value),
    message: () =>
      "smart-compact config: maxLlmInputTokens must be 0–1000000; 0 uses the mode cap.",
  },
  {
    key: "codexMaxCallMs",
    valid: (value) => validNumericLimit("codexMaxCallMs", value),
    message: () =>
      "smart-compact config: codexMaxCallMs must be 0 or 5000–300000; 0 derives a cap from maxTokens.",
  },
  {
    key: "maxLatencyMs",
    valid: (value) => validNumericLimit("maxLatencyMs", value),
    message: () =>
      "smart-compact config: maxLatencyMs must be 0 or 5000–600000; 0 means unlimited.",
  },
  {
    key: "minContextPercent",
    valid: (value) => validNumericLimit("minContextPercent", value),
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

/**
 * Persist one extension-owned global setting without replacing other Pi or
 * extension settings. Passing undefined removes the override so the built-in
 * default becomes effective again.
 */
export async function writeGlobalConfigValue(
  configPath: GlobalConfigPath,
  value: GlobalConfigValue,
): Promise<CompactConfig> {
  assertGlobalConfigPath(configPath);
  const file = settingsFile();
  const release = await acquireLock(file);
  try {
    const root = readSettingsRoot(file);
    const section = configuredSection(root);
    setConfigPath(section, configPath, cloneGlobalConfigValue(value));
    if (value === undefined && configPath === "agentToolAccess") {
      delete section.agentToolEnabled;
    }
    const validated = structuredClone(section);
    validateSmartCompactConfig(validated);

    if (!sameJsonValue(configPathValue(validated, configPath), value)) {
      throw new Error(`Invalid smartCompact setting: ${configPath}`);
    }

    root[CONFIG_KEY] = section;
    await atomicWriteFile(file, JSON.stringify(root, null, 2) + "\n");
    resetConfigCache();
    return loadConfig();
  } finally {
    release();
  }
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
      return cloneConfig(cachedConfig);
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    const raw = isRecord(parsed) ? parsed : {};
    if (raw !== parsed) {
      log.warn("smart-compact config: settings.json root must be an object.");
    }
    const configured = Object.hasOwn(raw, CONFIG_KEY)
      ? raw[CONFIG_KEY]
      : (raw[CONFIG_KEY_ALT] ?? {});
    const sc = isRecord(configured) ? configured : {};
    if (sc !== configured) {
      log.warn("smart-compact config: smartCompact must be an object.");
    }
    validateSmartCompactConfig(sc);
    const merged = { ...defaultConfig(), ...sc } as CompactConfig;
    if (!("mode" in sc) && "profile" in sc) {
      merged.mode =
        sc.profile === "light"
          ? "thorough"
          : (sc.profile as CompactConfig["mode"]);
    }
    if (sc.profiles) {
      const overrides = sc.profiles as Record<
        CompressionProfile,
        Partial<ProfileConfig>
      >;
      merged.profiles = Object.fromEntries(
        VALID_PROFILES.map((name) => [
          name,
          { ...PROFILES[name], ...overrides[name] },
        ]),
      ) as Record<CompressionProfile, ProfileConfig>;
    }
    if (!merged.backupDir) merged.backupDir = defaultBackupDir();
    cachedConfig = merged;
    cachedMtime = stat.mtimeMs;
    cachedPath = file;
    return cloneConfig(cachedConfig);
  } catch (error) {
    log.debug(
      "loadConfig: settings.json not found or unreadable, using defaults",
      error,
    );
    cachedConfig = defaultConfig();
    cachedPath = null;
    return cloneConfig(cachedConfig);
  }
}
