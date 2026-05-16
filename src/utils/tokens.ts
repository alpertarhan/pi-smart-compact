/**
 * Token estimation with provider-specific ratios and EMA calibration.
 */

import { CHARS_PER_TOKEN } from "../constants.ts";
import type { ProviderCapabilities } from "../types.ts";

const PROVIDER_MAP: Record<string, ProviderCapabilities> = {
  "zai-anthropic": {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 3.5, concurrencyLimit: 3,
    cacheStrategy: "anthropic",
  },
  "minimax": {
    maxOutputTokens: 4096, supportsTools: "probe", jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.8, concurrencyLimit: 2,
    cacheStrategy: "anthropic",
  },
  "xiaomi-token-plan": {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.3, concurrencyLimit: 2,
    cacheStrategy: "openai",
  },
  "openai": {
    maxOutputTokens: 16384, supportsTools: true, jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 4.0, concurrencyLimit: 5,
    cacheStrategy: "openai",
  },
};

export function getProviderCaps(provider: string): ProviderCapabilities {
  return PROVIDER_MAP[provider] ?? {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.8, concurrencyLimit: 2,
    cacheStrategy: "none",
  };
}

// Per-provider calibration to avoid cross-session bleed.
const _calibrationFactors = new Map<string, number>();

function getCalibrationFactor(provider?: string): number {
  if (!provider) return 1.0;
  return _calibrationFactors.get(provider) ?? 1.0;
}

export function estimateTokens(text: string, provider?: string): number {
  const baseRatio = provider ? getProviderCaps(provider).tokenRatioEstimate : CHARS_PER_TOKEN;
  // JSON content has denser tokenization (brackets, quotes, escapes)
  const jsonPenalty = text.startsWith("[") || text.startsWith("{") ? 0.85 : 1.0;
  // Turkish/CE characters tokenize differently (multi-byte in some tokenizers)
  const langPenalty = /[çğıöşüÇĞİÖŞÜ]/.test(text) ? 0.9 : 1.0;
  const calibration = getCalibrationFactor(provider);
  return Math.ceil((text.length / baseRatio) * jsonPenalty * langPenalty * calibration);
}

export function calibrateFromResponse(estimated: number, actual: number, provider?: string): void {
  if (actual > 0 && estimated > 0 && provider) {
    const prev = _calibrationFactors.get(provider) ?? 1.0;
    const sample = actual / estimated;
    _calibrationFactors.set(provider, prev * 0.7 + sample * 0.3); // EMA smoothing
  }
}
