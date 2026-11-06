/**
 * Token estimation with provider-specific ratios and EMA calibration.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { CHARS_PER_TOKEN, REASONING_OUTPUT_HEADROOM_TOKENS, TUNING } from "../constants.ts";
import type { LlmMessage, ProviderCacheCaps, ProviderCapabilities } from "../types.ts";
import { lruGet, lruSet } from "./lru.ts";

const PROVIDER_MAP: Record<string, ProviderCapabilities> = {
  // ── Anthropic family ──
  // Explicit per-message breakpoints, 5m/1h TTLs; 1h writes cost 2x base
  // input, reads 0.1x (newer models lower). TTL is measured from request start.
  "zai-anthropic": {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 3.5, concurrencyLimit: 3,
    cacheStrategy: "anthropic", timeoutMultiplier: 1.2, singlePassTokenMultiplier: 1.0, multimodal: "metadata-only",
    // No documented marker contract for this Anthropic-compatible route;
    // implicit keeps anchor-cache rewriting active until verified.
    cacheControl: { level: "implicit", ttlOptionsMs: [], writeMultiplier: 1, readMultiplier: 0.2, routingKey: null },
  },
  // Moonshot documents a top-level cache_control field for the
  // Anthropic-compatible endpoint and that message-level markers are ignored.
  "kimi-coding": {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 3.5, concurrencyLimit: 2,
    cacheStrategy: "anthropic", timeoutMultiplier: 1.5, singlePassTokenMultiplier: 0.95, multimodal: "metadata-only",
    cacheControl: { level: "explicit-toplevel", ttlOptionsMs: [300_000, 3_600_000], writeMultiplier: 2, readMultiplier: 0.1, routingKey: null },
  },
  "anthropic": {
    maxOutputTokens: 8192, supportsTools: true, jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 3.5, concurrencyLimit: 3,
    cacheStrategy: "anthropic", timeoutMultiplier: 1.2, singlePassTokenMultiplier: 1.0, multimodal: "native",
    cacheControl: { level: "explicit-message", ttlOptionsMs: [300_000, 3_600_000], writeMultiplier: 2, readMultiplier: 0.1, routingKey: null },
  },
  // ── OpenAI family ──
  // Implicit caching by default; GPT-5.6+ adds explicit breakpoints on newer
  // request shapes. prompt_cache_key improves routing stickiness.
  "openai": {
    maxOutputTokens: 16384, supportsTools: true, jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 4.0, concurrencyLimit: 5,
    cacheStrategy: "openai", timeoutMultiplier: 1.0, singlePassTokenMultiplier: 1.15, multimodal: "native",
    cacheControl: { level: "implicit", ttlOptionsMs: [], writeMultiplier: 1, readMultiplier: 0.25, routingKey: { location: "body", name: "prompt_cache_key" } },
  },
  // ── Google family ──
  // Implicit caching is default on 2.5+; explicit cachedContents is a separate
  // server resource, not a wire-level TTL control.
  "google": {
    maxOutputTokens: 8192, supportsTools: true, jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 3.8, concurrencyLimit: 3,
    cacheStrategy: "openai", timeoutMultiplier: 1.15, singlePassTokenMultiplier: 1.1, multimodal: "native",
    cacheControl: { level: "implicit", ttlOptionsMs: [], writeMultiplier: 1, readMultiplier: 0.25, routingKey: null },
  },
  // ── DeepSeek family ──
  // Automatic disk caching; best-effort hits, entries cleared after hours to
  // days. No developer control surface documented.
  "deepseek": {
    maxOutputTokens: 8192, supportsTools: true, jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.6, concurrencyLimit: 2,
    cacheStrategy: "none", timeoutMultiplier: 1.5, singlePassTokenMultiplier: 0.85, multimodal: "metadata-only",
    cacheControl: { level: "implicit", ttlOptionsMs: [], writeMultiplier: 1, readMultiplier: 0.1, routingKey: null },
  },
  // ── MiniMax family ──
  // Passive caching (M3); explicit cache_control exists only on M2.x via the
  // Anthropic-compatible API. Hit price is ~0.2x input.
  "minimax": {
    // 4096 cut the 6000-token balanced summary budget; M2.7/M3 allow 131k+.
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.8, concurrencyLimit: 2,
    cacheStrategy: "anthropic", timeoutMultiplier: 1.6, singlePassTokenMultiplier: 0.8, multimodal: "metadata-only",
    cacheControl: { level: "implicit", ttlOptionsMs: [], writeMultiplier: 1, readMultiplier: 0.2, routingKey: null },
  },
  // ── Xiaomi family ──
  "xiaomi-token-plan": {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.3, concurrencyLimit: 2,
    cacheStrategy: "openai", timeoutMultiplier: 1.35, singlePassTokenMultiplier: 0.9, multimodal: "metadata-only",
    cacheControl: { level: "implicit", ttlOptionsMs: [], writeMultiplier: 1, readMultiplier: 1, routingKey: null },
  },
  "xiaomi-mimo": {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.3, concurrencyLimit: 2,
    cacheStrategy: "anthropic", timeoutMultiplier: 1.35, singlePassTokenMultiplier: 0.9, multimodal: "metadata-only",
    cacheControl: { level: "implicit", ttlOptionsMs: [], writeMultiplier: 1, readMultiplier: 1, routingKey: null },
  },
  // ── CrofAI family ──
  "crofai": {
    maxOutputTokens: 8192, supportsTools: "probe", jsonReliability: "medium",
    instructionFollowing: "medium", tokenRatioEstimate: 3.8, concurrencyLimit: 3,
    cacheStrategy: "none", timeoutMultiplier: 1.2, singlePassTokenMultiplier: 0.95, multimodal: "metadata-only",
    cacheControl: { level: "implicit", ttlOptionsMs: [], writeMultiplier: 1, readMultiplier: 1, routingKey: null },
  },
  // ── Mistral family ──
  "mistral": {
    maxOutputTokens: 8192, supportsTools: true, jsonReliability: "high",
    instructionFollowing: "high", tokenRatioEstimate: 3.5, concurrencyLimit: 3,
    cacheStrategy: "openai", timeoutMultiplier: 1.2, singlePassTokenMultiplier: 1.0, multimodal: "metadata-only",
    cacheControl: { level: "implicit", ttlOptionsMs: [], writeMultiplier: 1, readMultiplier: 1, routingKey: null },
  },
  // ── xAI / Grok family ──
  // Automatic caching (~0.25x read); x-grok-conv-id improves engine routing.
  "xai": {
    maxOutputTokens: 8192, supportsTools: true, jsonReliability: "medium",
    instructionFollowing: "high", tokenRatioEstimate: 3.8, concurrencyLimit: 3,
    cacheStrategy: "openai", timeoutMultiplier: 1.2, singlePassTokenMultiplier: 1.0, multimodal: "native",
    cacheControl: { level: "implicit", ttlOptionsMs: [], writeMultiplier: 1, readMultiplier: 0.25, routingKey: { location: "header", name: "x-grok-conv-id" } },
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
  // Unknown provider: assume implicit caching but claim no discount, premium
  // or control surface until documentation says otherwise.
  cacheControl: { level: "implicit", ttlOptionsMs: [], writeMultiplier: 1, readMultiplier: 1, routingKey: null },
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

/** Wire output cap for a visible target; the provider table is a floor when the model advertises more. */
export function outputCeiling(model: Model<Api>, visibleTokens: number): number {
  const limit = Math.max(getProviderCaps(model.provider).maxOutputTokens, model.maxTokens || 0);
  return Math.min(visibleTokens + (model.reasoning ? REASONING_OUTPUT_HEADROOM_TOKENS : 0), limit);
}

/** Documented prompt-cache control surface for a provider; conservative defaults for unknowns. */
export function getProviderCacheCaps(provider: string | undefined): ProviderCacheCaps {
  return (provider ? getProviderCaps(provider) : DEFAULT_CAPS).cacheControl;
}

/** Finite context usage percentage; invalid/unknown window metadata is 0%. */
export function safeContextPercent(totalTokens: number | null | undefined, contextWindow: number | null | undefined): number {
  if (!Number.isFinite(totalTokens) || !Number.isFinite(contextWindow)) return 0;
  if ((totalTokens ?? 0) <= 0 || (contextWindow ?? 0) <= 0) return 0;
  return (totalTokens as number) / (contextWindow as number) * 100;
}

/**
 * Window for automatic trigger/preparation percentages: maxContextTokens when
 * set (>0) and below a valid model window, else the model window unchanged.
 * Hard headroom checks must keep using model.contextWindow.
 */
export function effectiveContextWindow(
  model: { contextWindow: number } | undefined,
  config: { maxContextTokens?: number },
): number | undefined {
  const window = model?.contextWindow;
  const cap = config.maxContextTokens;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return window;
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0 && cap < window ? cap : window;
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
    const exact = lruGet(this.factors, exactKey);
    if (exact !== undefined) return exact;
    // Fall back to the provider-wide bucket so a fresh model still benefits
    // from sibling calibration until it builds up its own samples.
    return lruGet(this.factors, calibrationKey(provider)) ?? 1.0;
  }

  calibrate(estimated: number, actual: number, provider?: string, model?: string): void {
    if (actual <= 0 || estimated <= 0 || !provider) return;
    const key = calibrationKey(provider, model);
    const prev = lruGet(this.factors, key) ?? 1.0;
    // `estimated` already includes the previous factor. Convert the observed
    // actual/estimated correction back into an absolute target factor before
    // EMA smoothing; otherwise repeated calibration converges to sqrt(target).
    const target = prev * actual / estimated;
    const clamped = Math.max(TUNING.CALIBRATION_CLAMP_MIN, Math.min(TUNING.CALIBRATION_CLAMP_MAX, target));
    lruSet(this.factors, key, prev * TUNING.EMA_PREV + clamped * TUNING.EMA_SAMPLE, Math.max(1, this.maxEntries));
  }

  size(): number { return this.factors.size; }
}

const _fallbackCalibration = new TokenCalibrationStore();

function calibrationKey(provider: string, model?: string): string {
  return model ? provider + "/" + model : provider + "/*";
}

/** JSON-density tuning knobs (named, not inline magic numbers). */
const JSON_PENALTY = 0.85;
const JSON_DENSITY_THRESHOLD = 0.05;
/** Cap the density scan so a multi-MB conversation serialization can't pause the pipeline. */
const JSON_DENSITY_SCAN_CAP = 8192;

function estimateTokensAtFactor(text: string, provider: string | undefined, factor: number): number {
  const baseRatio = provider ? getProviderCaps(provider).tokenRatioEstimate : CHARS_PER_TOKEN;
  // Structurally dense text (JSON tool arguments/results, serialized code)
  // tokenizes to more tokens per character. The scan is capped so a multi-MB
  // serialization can't pause the pipeline. Prose inside a JSON message wrapper
  // must stay unaffected: density is measured on content, not the wrapper, so
  // there is deliberately no leading-brace shortcut — every serialized message
  // starts with '{'.
  let jsonPenalty = 1.0;
  if (text.length > 0) {
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
  // Denser content means MORE tokens per character, so the density penalties
  // shrink the chars/token ratio — they must not reduce the token count.
  return Math.ceil((text.length / (baseRatio * jsonPenalty * langPenalty)) * factor);
}

export function estimateTokens(text: string, provider?: string, model?: string, calibration = _fallbackCalibration): number {
  return estimateTokensAtFactor(text, provider, calibration.get(provider, model));
}

export function calibrateFromResponse(estimated: number, actual: number, provider?: string, model?: string, calibration = _fallbackCalibration): void {
  calibration.calibrate(estimated, actual, provider, model);
}

export interface TokenEstimator {
  text(text: string): number;
  message(message: Pick<LlmMessage, "role" | "content" | "toolCallId" | "toolName" | "isError">, options?: MessageEstimateOptions): number;
  messages(messages: ReadonlyArray<Pick<LlmMessage, "role" | "content" | "toolCallId" | "toolName" | "isError">>): number;
}

/** Binary payloads the model does not read as text: never counted as serialized chars. */
const SIGNATURE_KEYS = ["thinkingSignature", "textSignature", "thoughtSignature"];
/** Conservative flat image cost when no dimension rule is verified for the API. */
const IMAGE_BLOCK_TOKENS = 1_200;
/**
 * Claude vision (documented, platform.claude.com vision docs): visual tokens are
 * ⌈w/28⌉·⌈h/28⌉ patches after an aspect-preserving provider resize that must fit
 * BOTH the tier's edge limit and its visual-token budget. Two verified tiers:
 * - High resolution ("Claude 4.7 and later", incl. Opus 5.5): 2576px, 4784 tokens.
 * - Standard (all other patch-grid Claude): 1568px, 1568 tokens.
 * Pre-3 Claude and non-Claude models on Anthropic-compatible endpoints have
 * different, unverified rules and take the flat estimate instead.
 */
const CLAUDE_IMAGE_PATCH_PX = 28;
interface ClaudeImageTier { maxEdge: number; maxVisualTokens: number }

const CLAUDE_IMAGE_TIERS = {
  standard: { maxEdge: 1_568, maxVisualTokens: 1_568 },
  high: { maxEdge: 2_576, maxVisualTokens: 4_784 },
} as const;

/** Claude model version: [major, minor], date suffixes stripped, major-only reads as X.0. Null when unparseable. */
function parseClaudeVersion(model: string): [number, number] | null {
  const undated = model.toLowerCase().replace(/\d{8}/g, ""); // dated snapshots (20251101) are not minors
  const version = /(\d+)(?:[.-](\d+))?/.exec(undated);
  if (!version) return null;
  return [Number(version[1]), Number(version[2] ?? 0)];
}

/** "Claude 4.7 and later" is the documented high-resolution membership. */
function claudeImageTier(model: string | undefined): ClaudeImageTier | null {
  if (!model?.toLowerCase().startsWith("claude")) return null;
  if (/^claude-(?:2|instant)/i.test(model)) return null; // pre-patch-grid billing
  const version = parseClaudeVersion(model);
  if (!version) return CLAUDE_IMAGE_TIERS.high; // unknown current name: price high, never under-count
  const [major, minor] = version;
  return major > 4 || (major === 4 && minor >= 7) ? CLAUDE_IMAGE_TIERS.high : CLAUDE_IMAGE_TIERS.standard;
}

/** Round half to even (banker's rounding), matching the documented reference implementation. */
function roundTiesToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

function fitsClaudeImageLimits(width: number, height: number, tier: ClaudeImageTier): boolean {
  return (
    Math.ceil(width / CLAUDE_IMAGE_PATCH_PX) * CLAUDE_IMAGE_PATCH_PX <= tier.maxEdge &&
    Math.ceil(height / CLAUDE_IMAGE_PATCH_PX) * CLAUDE_IMAGE_PATCH_PX <= tier.maxEdge &&
    Math.ceil(width / CLAUDE_IMAGE_PATCH_PX) * Math.ceil(height / CLAUDE_IMAGE_PATCH_PX) <= tier.maxVisualTokens
  );
}

/**
 * The provider's resize rule: largest aspect-preserving size whose patch grid
 * fits both tier limits (binary search along the long edge, short edge rounded
 * half-to-even — the documented reference algorithm).
 */
function claudeResizedSize(width: number, height: number, tier: ClaudeImageTier): { width: number; height: number } {
  if (fitsClaudeImageLimits(width, height, tier)) return { width, height };
  const rotated = height > width;
  const [long0, short0] = rotated ? [height, width] : [width, height];
  const aspect = long0 / short0;
  let lo = 1; // fits
  let hi = long0; // does not fit
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fitsClaudeImageLimits(mid, roundTiesToEven(mid / aspect), tier)) lo = mid;
    else hi = mid;
  }
  const long = lo;
  const short = roundTiesToEven(long / aspect);
  return rotated ? { width: short, height: long } : { width: long, height: short };
}
/** openai-completions thinking replay is keyed by these marker signatures (pi-ai converter). */
const COMPLETIONS_REASONING_MARKERS = new Set(["reasoning", "reasoning_content", "reasoning_text"]);

/** Bounded image header scan: PNG IHDR / JPEG SOF only, never a full multi-MB decode. */
const IMAGE_HEADER_BASE64_CAP = 262_144;

function parseImageDimensions(source: unknown): { width: number; height: number } | null {
  const data = typeof source === "string" ? source : undefined;
  if (!data || data.length < 64) return null;
  let buf: Buffer;
  try {
    const b64 = data.replace(/^data:[^,]+,/, "");
    buf = Buffer.from(b64.length > IMAGE_HEADER_BASE64_CAP ? b64.slice(0, IMAGE_HEADER_BASE64_CAP) : b64, "base64");
  } catch {
    return null;
  }
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf.subarray(1, 4).toString() === "PNG") {
      const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
      if (width > 0 && height > 0 && width <= 30_000 && height <= 30_000) return { width, height };
      return null;
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) return null;
        const marker = buf[offset + 1]!;
        const length = buf.readUInt16BE(offset + 2);
        // SOF0..SOF15 except DHT/JPG/DAC carry the frame dimensions.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = buf.readUInt16BE(offset + 5), width = buf.readUInt16BE(offset + 7);
          if (width > 0 && height > 0 && width <= 30_000 && height <= 30_000) return { width, height };
          return null;
        }
        offset += 2 + length;
      }
    }
  } catch {
    // Malformed headers fall back to the flat estimate.
  }
  return null;
}

/**
 * Visual-token estimate for one image block: the documented patch rule only
 * where the reader's API AND model family are verified (current Claude);
 * otherwise a bounded flat estimate. The flat rate is an estimate with real
 * uncertainty, not a guaranteed upper bound — an unverified model may bill a
 * large image above it.
 */
function imageBlockTokens(image: { data?: unknown; source?: { data?: unknown } | string }, api: string | undefined, model: string | undefined): number {
  const raw = typeof image.data === "string" ? image.data : typeof image.source === "object" && image.source && typeof image.source.data === "string" ? image.source.data : undefined;
  const dims = parseImageDimensions(raw);
  const tier = api === "anthropic-messages" ? claudeImageTier(model) : null;
  if (!tier || !dims) {
    return IMAGE_BLOCK_TOKENS;
  }
  // Both tier limits bind (edge AND visual-token budget), so a huge source
  // never prices as unbounded patches.
  const size = claudeResizedSize(dims.width, dims.height, tier);
  return Math.ceil(size.width / CLAUDE_IMAGE_PATCH_PX) * Math.ceil(size.height / CLAUDE_IMAGE_PATCH_PX);
}

type SerializableMessage = Pick<LlmMessage, "role" | "content" | "toolCallId" | "toolName" | "isError">;

function serializableMessage(message: SerializableMessage) {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

/** Drop opaque signatures and collapse images so binary payloads never count as text. */
function countableMessage(message: SerializableMessage) {
  if (!Array.isArray(message.content)) return { base: serializableMessage(message), images: [] as Array<{ data?: unknown; source?: { data?: unknown } | string }> };
  const images: Array<{ data?: unknown; source?: { data?: unknown } | string }> = [];
  let changed = false;
  const content = message.content.map(block => {
    if (!block || typeof block !== "object") return block;
    if ((block as { type?: unknown }).type === "image") {
      images.push(block as { type: string; data?: unknown; source?: { data?: unknown } | string });
      changed = true;
      return { type: "image" };
    }
    if (!SIGNATURE_KEYS.some(key => (block as Record<string, unknown>)[key] !== undefined)) return block;
    changed = true;
    const clone: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(block)) {
      if (value !== undefined && !SIGNATURE_KEYS.includes(key)) clone[key] = value;
    }
    return clone;
  });
  // Byte-identical serialization for messages without images or signatures.
  return changed ? { base: { ...serializableMessage(message), content }, images } : { base: serializableMessage(message), images };
}

/** Per-message estimation context: replay proxies are only valid for unchanged content. */
export interface MessageEstimateOptions {
  /** The projection rewrote this message's content; generation metadata no longer describes it. */
  contextEdited?: boolean;
  /** This assistant message is part of the turn still in progress (after the last human turn). */
  currentTurn?: boolean;
}

/** The active reader model whose wire replay is being estimated. */
export interface ReaderIdentity {
  provider: string;
  id: string;
  api?: string;
  /** Explicit input modalities (e.g. ["text"]); absent means unknown, never an assumption. */
  input?: readonly string[];
}

/**
 * Bind provider/model calibration once per run. Message estimates use the
 * actual structured content, including tool-call arguments that text-only
 * extraction intentionally omits. Base64 image data and opaque provider
 * signatures (Anthropic thinking/text signatures, OpenAI encrypted reasoning
 * stored in thinkingSignature) are dropped before serialization; each image
 * block is priced at a flat conservative cost.
 */
export function makeTokenEstimator(
  provider?: string,
  model?: string,
  calibration: TokenCalibrationStore = _fallbackCalibration,
): TokenEstimator {
  const factor = calibration.get(provider, model);
  const text = (value: string) => estimateTokensAtFactor(value, provider, factor);
  return {
    text,
    message: message => {
      const { base, images } = countableMessage(message);
      return text(JSON.stringify(base)) + images.length * IMAGE_BLOCK_TOKENS;
    },
    messages: messages => {
      const counted = messages.map(countableMessage);
      return text(JSON.stringify(counted.map(item => item.base)))
        + counted.reduce((sum, item) => sum + item.images.length, 0) * IMAGE_BLOCK_TOKENS;
    },
  };
}

/**
 * Documented thinking-block preservation on the Anthropic Messages API: keep-all
 * models retain prior turns' thinking (billed as input); earlier Opus/Sonnet and
 * Haiku through 4.5 keep only the last turn's blocks and the API strips older
 * ones. Preservation is a MODEL property, so a genuine Claude served behind a
 * custom provider alias keeps the same behavior; non-Claude models on the same
 * wire API are unknown and keep the measured-subset rule (never inferred from
 * the API alone).
 */
function keepsAllPriorThinking(model: string | undefined): boolean {
  if (!model) return false;
  const id = model.toLowerCase();
  if (id.startsWith("claude-mythos-preview")) return true;
  const family = /opus|sonnet|haiku|fable|mythos/.exec(id)?.[0];
  const version = parseClaudeVersion(id);
  if (!family || !version) return false;
  const [major, minor] = version;
  if (major >= 5) return true; // every 5-family model listed keeps all prior turns
  switch (family) {
    case "opus": return major === 4 && minor >= 5;
    case "sonnet": return major === 4 && minor >= 6;
    default: return false; // haiku through 4.5, fable/mythos only exist at 5+
  }
}

/**
 * Whether a table-backed thinking-retention policy is VERIFIED for this reader:
 * the documented Responses/Completions families, or Claude models whose version
 * the docs cover. An unknown alias (claude-opus-latest, other vendors on the
 * anthropic-messages wire) has no verified policy — the estimator bounds
 * possibly-retained thinking from above instead of assuming discard.
 */
export function thinkingRetentionKnown(reader: { id: string; api?: string }): boolean {
  if (reader.api === "openai-responses" || reader.api === "openai-codex-responses" || reader.api === "openai-completions") return true;
  return reader.api === "anthropic-messages" && reader.id.toLowerCase().startsWith("claude") && parseClaudeVersion(reader.id) !== null;
}

type AssistantMetadata = {
  provider?: string;
  api?: string;
  model?: string;
  stopReason?: string;
  usage?: { output?: unknown; reasoning?: unknown };
};

function replayProxyTokens(
  message: SerializableMessage & AssistantMetadata,
  reader: ReaderIdentity,
  options: MessageEstimateOptions | undefined,
): number | null {
  if (message.role !== "assistant" || options?.contextEdited) return null;
  // Pi's replay compatibility is full provider+api+model identity.
  if (message.provider !== reader.provider || message.api !== reader.api || message.model !== reader.id) return null;
  if (message.stopReason === "aborted" || message.stopReason === "error") return null;
  const output = message.usage?.output;
  if (typeof output !== "number" || !Number.isFinite(output) || output <= 0) return null;
  const reasoning = message.usage?.reasoning;
  // usage.reasoning is a SUBSET of output. A dirty or absent value cannot stand
  // in for a measured discard amount — the caller falls back to retained content.
  const measuredSubset = typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning >= 0 && reasoning <= output;
  if (reader.api === "anthropic-messages") {
    // Keep-all models (and the live tool loop) replay and bill every thinking
    // block: usage.output measured exactly that content at generation time.
    if (options?.currentTurn || keepsAllPriorThinking(reader.id)) return Math.round(output);
    // Unknown retention policy: output-reasoning is only a non-reasoning LOWER
    // bound — the server may keep the thinking. Price the measured UPPER bound
    // (everything output could be retained); missing metadata stays unboundable.
    if (!thinkingRetentionKnown({ id: reader.id, api: reader.api })) {
      return measuredSubset ? Math.round(output) : null;
    }
    // Keep-last-turn models strip prior SIGNED thinking on replay: with every
    // block signed or redacted, output-reasoning is the exact measured remainder.
    // Unsigned thinking converts to plain text before the wire and survives the
    // server-side strip, so its presence breaks the subset and falls back.
    const unsignedThinking = (Array.isArray(message.content) ? message.content : []).some(block =>
      block && typeof block === "object" && (block as { type?: string }).type === "thinking"
      && !(block as { thinkingSignature?: unknown }).thinkingSignature && !(block as { redacted?: unknown }).redacted);
    return measuredSubset && !unsignedThinking ? Math.round(output - reasoning) : null;
  }
  if (reader.api === "openai-responses" || reader.api === "openai-codex-responses") {
    // Prior-turn reasoning items are discarded on replay; text and tool
    // arguments always come back. Inside the live turn the API requires the
    // reasoning items, so nothing is subtracted there.
    if (options?.currentTurn) return Math.round(output);
    return measuredSubset ? Math.round(output - reasoning) : null;
  }
  if (reader.api === "openai-completions") {
    // Pi replays thinking text through a reasoning field only when the stored
    // signature is one of the known marker names; other thinking is dropped.
    const marker = (Array.isArray(message.content) ? message.content : []).some(block =>
      block && typeof block === "object" && (block as { type?: string }).type === "thinking"
      && COMPLETIONS_REASONING_MARKERS.has(String((block as { thinkingSignature?: unknown }).thinkingSignature ?? "")));
    if (marker) return Math.round(output);
    return measuredSubset ? Math.round(output - reasoning) : null;
  }
  return null;
}

/**
 * Reader-domain estimator: prices what the ACTIVE model's wire actually carries,
 * following pi-ai's transformMessages semantics exactly:
 * - Errored/aborted assistant messages are skipped entirely by the SDK before
 *   conversion, so they cost 0 on known APIs (unknown APIs stay conservative).
 * - Same-model, unchanged assistant messages with clean generation metadata use
 *   measured usage as the replay proxy, per API and (for Anthropic) per-model
 *   thinking-preservation rules; dirty subset metadata never becomes an exact
 *   discard — retained visible content is priced instead.
 * - Cross-model thinking blocks are dropped before wire conversion on known
 *   APIs; same-model thinking without metadata keeps its visible text as a
 *   lower bound (encrypted signature payloads are never priced as text).
 * - Images follow the documented two-tier patch rule where API and Claude model
 *   tier are known. When the reader's explicit input capabilities exclude
 *   images, the SDK replaces user/toolResult images with a coalesced text
 *   placeholder — priced as that text. Missing capability info keeps the
 *   vision estimate (uncertain, never an assumption).
 */
export function makeReaderTokenEstimator(
  reader: ReaderIdentity,
  calibration: TokenCalibrationStore = _fallbackCalibration,
): TokenEstimator {
  // Capture the calibration factor once: a mid-run calibration update (e.g. a
  // summary response calibrating this same bucket) must not reprice an in-flight basis.
  const readerFactor = calibration.get(reader.provider, reader.id);
  const text = (value: string) => estimateTokensAtFactor(value, reader.provider, readerFactor);
  const knownApi = reader.api === "anthropic-messages" || reader.api === "openai-responses"
   || reader.api === "openai-codex-responses" || reader.api === "openai-completions";
  const supportsImages = reader.input === undefined || reader.input.includes("image");
  /** Per-block replay rule for thinking content: "keep" prices the visible text, "drop" prices nothing. */
  const charEstimate = (message: SerializableMessage, thinkingRule: (block: { thinkingSignature?: unknown; redacted?: unknown }) => "keep" | "drop"): number => {
    if (!Array.isArray(message.content)) return text(JSON.stringify(serializableMessage(message)));
    let imageTokens = 0;
    const content = message.content.map(block => {
      if (!block || typeof block !== "object") return block;
      const type = (block as { type?: unknown }).type;
      if (type === "image") {
        imageTokens += imageBlockTokens(block as { data?: unknown; source?: { data?: unknown } | string }, reader.api, reader.id);
        return { type: "image" };
      }
      if (type === "thinking" && thinkingRule(block as { thinkingSignature?: unknown; redacted?: unknown }) === "drop") return { type: "thinking" };
      if (!SIGNATURE_KEYS.some(key => (block as Record<string, unknown>)[key] !== undefined)) return block;
      const clone: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(block)) {
        if (value !== undefined && !SIGNATURE_KEYS.includes(key)) clone[key] = value;
      }
      return clone;
    });
    return text(JSON.stringify({ ...serializableMessage(message), content })) + imageTokens;
  };
  /** The SDK's image downgrade for text-only readers: each run of adjacent images becomes one placeholder. */
  const withImagePlaceholders = (message: SerializableMessage): SerializableMessage => {
    if (supportsImages || !Array.isArray(message.content)) return message;
    if (message.role !== "user" && message.role !== "toolResult") return message;
    const placeholder = message.role === "user"
     ? "(image omitted: model does not support images)"
     : "(tool image omitted: model does not support images)";
    const content: unknown[] = [];
    let previousWasPlaceholder = false;
    for (const block of message.content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
        if (!previousWasPlaceholder) content.push({ type: "text", text: placeholder });
        previousWasPlaceholder = true;
        continue;
      }
      content.push(block);
      previousWasPlaceholder = block && typeof block === "object" && (block as { type?: unknown }).type === "text"
       && (block as { text?: unknown }).text === placeholder;
    }
    return { ...message, content } as SerializableMessage;
  };
  type ThinkingRule = (block: { thinkingSignature?: unknown; redacted?: unknown }) => "keep" | "drop";
  const keepAll: ThinkingRule = () => "keep";
  const dropAll: ThinkingRule = () => "drop";
  const estimate = (message: SerializableMessage & AssistantMetadata, options: MessageEstimateOptions | undefined): number => {
    if (message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error")) {
      // transformMessages drops errored/aborted assistant messages on every
      // known API; an unknown compatibility endpoint keeps the conservative
      // character estimate.
      return knownApi ? 0 : charEstimate(message, keepAll);
    }
    const proxy = replayProxyTokens(message, reader, options);
    if (proxy !== null) return proxy;
    const sameModel = message.provider === reader.provider && message.api === reader.api && message.model === reader.id;
    const completionsMarker = reader.api === "openai-completions"
     && (Array.isArray(message.content) ? message.content : []).some(block =>
       block && typeof block === "object" && (block as { type?: string }).type === "thinking"
       && COMPLETIONS_REASONING_MARKERS.has(String((block as { thinkingSignature?: unknown }).thinkingSignature ?? "")));
    // Per-block replay semantics, mirroring the converters:
    // - Cross-model thinking is dropped before wire conversion on known APIs.
    // - Keep-last-turn Anthropic models strip prior SIGNED thinking server-side,
    //   but the converter turns UNSIGNED thinking into plain text, which the
    //   strip does not remove — keep exactly those blocks priced.
    // - Responses discards prior-turn reasoning items (retained text/toolargs
    //   only); the live turn replays signed reasoning, priced by its visible
    //   summary as a lower bound (encrypted content is never priced as text).
    // - Completions replay thinking only through a known marker signature.
    let thinkingRule: ThinkingRule = keepAll;
    if (knownApi && message.role === "assistant") {
      if (!sameModel) thinkingRule = dropAll;
      else if (reader.api === "anthropic-messages" && !keepsAllPriorThinking(reader.id) && !options?.currentTurn) {
        thinkingRule = block => block.thinkingSignature || block.redacted ? "drop" : "keep";
      } else if ((reader.api === "openai-responses" || reader.api === "openai-codex-responses") && !options?.currentTurn) {
        thinkingRule = dropAll;
      } else if (reader.api === "openai-completions" && !completionsMarker) {
        thinkingRule = dropAll;
      }
    }
    return charEstimate(withImagePlaceholders(message), thinkingRule);
  };
  return {
    text,
    message: (message, options) => estimate(message as SerializableMessage & AssistantMetadata, options),
    messages: messages => messages.reduce((sum, message) => sum + estimate(message as SerializableMessage & AssistantMetadata, undefined), 0),
  };
}
