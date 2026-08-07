/**
 * Token estimation with provider-specific ratios and EMA calibration.
 */

import { CHARS_PER_TOKEN, TUNING } from "../constants.ts";
import type { LlmMessage, ProviderCapabilities } from "../types.ts";

const PROVIDER_MAP: Record<string, ProviderCapabilities> = {
  // ── Anthropic family ──
  "zai-anthropic": {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 3.5, concurrencyLimit: 3,
    cacheStrategy: "anthropic", timeoutMultiplier: 1.2, singlePassTokenMultiplier: 1.0, multimodal: "metadata-only",
  },
  "kimi-coding": {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 3.5, concurrencyLimit: 2,
    cacheStrategy: "anthropic", timeoutMultiplier: 1.5, singlePassTokenMultiplier: 0.95, multimodal: "metadata-only",
  },
  "anthropic": {
    maxOutputTokens: 8192, supportsTools: true, jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 3.5, concurrencyLimit: 3,
    cacheStrategy: "anthropic", timeoutMultiplier: 1.2, singlePassTokenMultiplier: 1.0, multimodal: "native",
  },
  // ── OpenAI family ──
  "openai": {
    maxOutputTokens: 16384, supportsTools: true, jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 4.0, concurrencyLimit: 5,
    cacheStrategy: "openai", timeoutMultiplier: 1.0, singlePassTokenMultiplier: 1.15, multimodal: "native",
  },
  // ── Google family ──
  "google": {
    maxOutputTokens: 8192, supportsTools: true, jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 3.8, concurrencyLimit: 3,
    cacheStrategy: "openai", timeoutMultiplier: 1.15, singlePassTokenMultiplier: 1.1, multimodal: "native",
  },
  // ── DeepSeek family ──
  "deepseek": {
    maxOutputTokens: 8192, supportsTools: true, jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.6, concurrencyLimit: 2,
    cacheStrategy: "none", timeoutMultiplier: 1.5, singlePassTokenMultiplier: 0.85, multimodal: "metadata-only",
  },
  // ── MiniMax family ──
  "minimax": {
    maxOutputTokens: 4096, supportsTools: "probe", jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.8, concurrencyLimit: 2,
    cacheStrategy: "anthropic", timeoutMultiplier: 1.6, singlePassTokenMultiplier: 0.8, multimodal: "metadata-only",
  },
  // ── Xiaomi family ──
  "xiaomi-token-plan": {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.3, concurrencyLimit: 2,
    cacheStrategy: "openai", timeoutMultiplier: 1.35, singlePassTokenMultiplier: 0.9, multimodal: "metadata-only",
  },
  "xiaomi-mimo": {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.3, concurrencyLimit: 2,
    cacheStrategy: "anthropic", timeoutMultiplier: 1.35, singlePassTokenMultiplier: 0.9, multimodal: "metadata-only",
  },
  // ── CrofAI family ──
  "crofai": {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.8, concurrencyLimit: 3,
    cacheStrategy: "none", timeoutMultiplier: 1.2, singlePassTokenMultiplier: 0.95, multimodal: "metadata-only",
  },
  // ── Mistral family ──
  "mistral": {
    maxOutputTokens: 8192, supportsTools: true, jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 3.5, concurrencyLimit: 3,
    cacheStrategy: "openai", timeoutMultiplier: 1.2, singlePassTokenMultiplier: 1.0, multimodal: "metadata-only",
  },
  // ── xAI / Grok family ──
  "xai": {
    maxOutputTokens: 8192, supportsTools: true, jsonReliability: "medium",
    instructionFollowing: "high", tokenRatioEstimate: 3.8, concurrencyLimit: 3,
    cacheStrategy: "openai", timeoutMultiplier: 1.2, singlePassTokenMultiplier: 1.0, multimodal: "native",
  },
};

/** Provider alias map for fuzzy matching */
const PROVIDER_ALIASES: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /anthropic/i, provider: "anthropic" },
  { pattern: /kimi/i, provider: "kimi-coding" },
  { pattern: /zai/i, provider: "zai-anthropic" },
  { pattern: /openai/i, provider: "openai" },
  { pattern: /gpt/i, provider: "openai" },
  { pattern: /google|gemini/i, provider: "google" },
  { pattern: /deepseek/i, provider: "deepseek" },
  { pattern: /minimax/i, provider: "minimax" },
  { pattern: /xiaomi-mimo/i, provider: "xiaomi-mimo" },
  { pattern: /xiaomi/i, provider: "xiaomi-token-plan" },
  { pattern: /crofai/i, provider: "crofai" },
  { pattern: /mistral/i, provider: "mistral" },
  { pattern: /xai|grok/i, provider: "xai" },
];

const DEFAULT_CAPS: ProviderCapabilities = {
  maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "medium",
  instructionFollowing: "medium", tokenRatioEstimate: 3.8, concurrencyLimit: 2,
  cacheStrategy: "none", timeoutMultiplier: 1.35, singlePassTokenMultiplier: 0.9, multimodal: "metadata-only",
};

export function getProviderCaps(provider: string): ProviderCapabilities {
  // Exact match first
  if (PROVIDER_MAP[provider]) return PROVIDER_MAP[provider];
  // Fuzzy match via aliases
  for (const { pattern, provider: key } of PROVIDER_ALIASES) {
    if (pattern.test(provider)) return PROVIDER_MAP[key] ?? DEFAULT_CAPS;
  }
  return DEFAULT_CAPS;
}

/**
 * Bounded per-(provider,model) calibration factors smoothed by EMA.
 * Provider/model tokenization is process-wide knowledge rather than session
 * content, so production runs share one store while tests can inject isolated
 * stores. LRU bounding prevents dynamic route names from growing it forever.
 */
export class TokenCalibrationStore {
  private readonly factors = new Map<string, number>();

  constructor(private readonly maxEntries = 128) {}

  clear(): void { this.factors.clear(); }

  get(provider?: string, model?: string): number {
    if (!provider) return 1.0;
    const exactKey = calibrationKey(provider, model);
    const exact = this.factors.get(exactKey);
    if (exact !== undefined) {
      this.factors.delete(exactKey);
      this.factors.set(exactKey, exact);
      return exact;
    }
    // Fall back to the provider-wide bucket so a fresh model still benefits
    // from sibling calibration until it builds up its own samples.
    const providerKey = calibrationKey(provider);
    const fallback = this.factors.get(providerKey);
    if (fallback !== undefined) {
      this.factors.delete(providerKey);
      this.factors.set(providerKey, fallback);
    }
    return fallback ?? 1.0;
  }

  calibrate(estimated: number, actual: number, provider?: string, model?: string): void {
    if (actual <= 0 || estimated <= 0 || !provider) return;
    const key = calibrationKey(provider, model);
    const prev = this.factors.get(key) ?? 1.0;
    // `estimated` already includes the previous factor. Convert the observed
    // actual/estimated correction back into an absolute target factor before
    // EMA smoothing; otherwise repeated calibration converges to sqrt(target).
    const target = prev * actual / estimated;
    const clamped = Math.max(TUNING.CALIBRATION_CLAMP_MIN, Math.min(TUNING.CALIBRATION_CLAMP_MAX, target));
    this.factors.delete(key);
    this.factors.set(key, prev * TUNING.EMA_PREV + clamped * TUNING.EMA_SAMPLE);
    while (this.factors.size > Math.max(1, this.maxEntries)) {
      const oldest = this.factors.keys().next().value;
      if (oldest === undefined) break;
      this.factors.delete(oldest);
    }
  }

  size(): number { return this.factors.size; }
}

const _fallbackCalibration = new TokenCalibrationStore();

function calibrationKey(provider: string, model?: string): string {
  return model ? provider + "/" + model : provider + "/*";
}

/** @internal Test-only reset; do not call from production code. */
export function __resetTokenCalibrationForTests(): void {
  _fallbackCalibration.clear();
}

/** JSON-density tuning knobs (named, not inline magic numbers). */
const JSON_PENALTY = 0.85;
const JSON_DENSITY_THRESHOLD = 0.05;
/** Cap the density scan so a multi-MB conversation serialization can't pause the pipeline. */
const JSON_DENSITY_SCAN_CAP = 8192;

function estimateTokensAtFactor(text: string, provider: string | undefined, factor: number): number {
  const baseRatio = provider ? getProviderCaps(provider).tokenRatioEstimate : CHARS_PER_TOKEN;
  // JSON content has denser tokenization. The leading-brace check covers
  // per-message JSON tool results; the density fallback catches concatenations
  // that don't start with JSON. Capped so a multi-MB serialization can't pause.
  const startsJson = text.startsWith("[") || text.startsWith("{");
  let jsonPenalty = 1.0;
  if (startsJson) {
    jsonPenalty = JSON_PENALTY;
  } else if (text.length > 0) {
    const sample = text.length > JSON_DENSITY_SCAN_CAP ? text.slice(0, JSON_DENSITY_SCAN_CAP) : text;
    let structural = 0;
    for (let i = 0; i < sample.length; i++) {
      const c = sample.charCodeAt(i);
      // 34 "  91 [  93 ]  123 {  125 }
      if (c === 34 || c === 91 || c === 93 || c === 123 || c === 125) structural++;
    }
    if (structural / sample.length > JSON_DENSITY_THRESHOLD) jsonPenalty = JSON_PENALTY;
  }
  // Turkish/CE characters tokenize differently (multi-byte in some tokenizers).
  // Scan the same capped sample as the JSON-density check — an uncapped regex
  // over a multi-MB conversation serialization walks the whole string.
  const langSample = text.length > JSON_DENSITY_SCAN_CAP ? text.slice(0, JSON_DENSITY_SCAN_CAP) : text;
  const langPenalty = /[çğıöşüÇĞİÖŞÜ]/.test(langSample) ? 0.9 : 1.0;
  return Math.ceil((text.length / baseRatio) * jsonPenalty * langPenalty * factor);
}

export function estimateTokens(text: string, provider?: string, model?: string, calibration = _fallbackCalibration): number {
  return estimateTokensAtFactor(text, provider, calibration.get(provider, model));
}

export function calibrateFromResponse(estimated: number, actual: number, provider?: string, model?: string, calibration = _fallbackCalibration): void {
  calibration.calibrate(estimated, actual, provider, model);
}

export interface TokenEstimator {
  text(text: string): number;
  message(message: Pick<LlmMessage, "role" | "content" | "toolCallId" | "toolName" | "isError">): number;
  messages(messages: ReadonlyArray<Pick<LlmMessage, "role" | "content" | "toolCallId" | "toolName" | "isError">>): number;
}

/**
 * Bind provider/model calibration once per run. Message estimates use the
 * actual structured content, including tool-call arguments that text-only
 * extraction intentionally omits.
 */
export function makeTokenEstimator(
  provider?: string,
  model?: string,
  calibration: TokenCalibrationStore = _fallbackCalibration,
): TokenEstimator {
  const factor = calibration.get(provider, model);
  const text = (value: string) => estimateTokensAtFactor(value, provider, factor);
  const serializable = (message: Pick<LlmMessage, "role" | "content" | "toolCallId" | "toolName" | "isError">) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.isError ? { isError: true } : {}),
  });
  return {
    text,
    message: message => text(JSON.stringify(serializable(message))),
    messages: messages => text(JSON.stringify(messages.map(serializable))),
  };
}
