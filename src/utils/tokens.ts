/**
 * Token estimation with provider-specific ratios and EMA calibration.
 */

import { CHARS_PER_TOKEN } from "../constants.ts";
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
