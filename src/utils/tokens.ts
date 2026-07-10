/**
 * Token estimation with provider-specific ratios and EMA calibration.
 */

import { CHARS_PER_TOKEN, TUNING } from "../constants.ts";
import type { ProviderCapabilities } from "../types.ts";

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
 * Per-(provider,model) calibration factors smoothed by EMA.
 *
 * Two reasons this used to be a module-level singleton and now isn't:
 *
 *   1. **Cross-session bleed.** Two pi sessions sharing the Node process
 *      (a sub-agent spawning the parent's extension) would otherwise mix
 *      each other's calibration drift. Per-services scoping confines drift
 *      to the run that observed it.
 *   2. **Per-model accuracy.** A single provider can ship multiple models
 *      with wildly different tokenizers (e.g. Anthropic's claude-3-haiku
 *      vs claude-sonnet-4: same provider, ~15% ratio gap). Keying on
 *      `provider/model` keeps each model's factor honest. Callers that
 *      only have a provider string still work — they share the
 *      `provider/*` bucket.
 *
 * The legacy module-level Map remains as a fallback when no services
 * container is provided (direct callers, tests, REPL). Tests can call
 * `__resetTokenCalibrationForTests` to clear it.
 */
export class TokenCalibrationStore {
  private readonly factors = new Map<string, number>();

  clear(): void { this.factors.clear(); }

  get(provider?: string, model?: string): number {
    if (!provider) return 1.0;
    const exact = this.factors.get(calibrationKey(provider, model));
    if (exact !== undefined) return exact;
    // Fall back to the provider-wide bucket so a fresh model still benefits
    // from sibling calibration until it builds up its own samples.
    return this.factors.get(calibrationKey(provider)) ?? 1.0;
  }

  calibrate(estimated: number, actual: number, provider?: string, model?: string): void {
    if (actual <= 0 || estimated <= 0 || !provider) return;
    const key = calibrationKey(provider, model);
    const prev = this.factors.get(key) ?? 1.0;
    const sample = actual / estimated;
    // EMA smoothing: 70% previous, 30% new sample. Clamp the ratio to a
    // sane range so a one-off outlier response (e.g. a truncated reply)
    // can't permanently skew estimates.
    const clamped = Math.max(TUNING.CALIBRATION_CLAMP_MIN, Math.min(TUNING.CALIBRATION_CLAMP_MAX, sample));
    this.factors.set(key, prev * TUNING.EMA_PREV + clamped * TUNING.EMA_SAMPLE);
  }
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

export function estimateTokens(text: string, provider?: string, model?: string, calibration = _fallbackCalibration): number {
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
  const factor = calibration.get(provider, model);
  return Math.ceil((text.length / baseRatio) * jsonPenalty * langPenalty * factor);
}

export function calibrateFromResponse(estimated: number, actual: number, provider?: string, model?: string, calibration = _fallbackCalibration): void {
  calibration.calibrate(estimated, actual, provider, model);
}
