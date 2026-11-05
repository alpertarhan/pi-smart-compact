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
/** Current Claude vision: visual tokens are ⌈w/28⌉·⌈h/28⌉ patches after model-specific resizing. */
const ANTHROPIC_IMAGE_PATCH_PX = 28;
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

/** Visual-token cost of one image block for a reader API (verified rules only). */
function imageBlockTokens(image: { data?: unknown; source?: { data?: unknown } | string }, api: string | undefined): number {
  if (api !== "anthropic-messages") return IMAGE_BLOCK_TOKENS;
  const raw = typeof image.data === "string" ? image.data : typeof image.source === "object" && image.source && typeof image.source.data === "string" ? image.source.data : undefined;
  const dims = parseImageDimensions(raw);
  if (!dims) return IMAGE_BLOCK_TOKENS;
  return Math.ceil(dims.width / ANTHROPIC_IMAGE_PATCH_PX) * Math.ceil(dims.height / ANTHROPIC_IMAGE_PATCH_PX);
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
  const priorTurnDiscarded = typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning > 0 ? reasoning : 0;
  if (reader.api === "anthropic-messages") {
    // Signed thinking (visible + encrypted) is replayed and billed; usage.output
    // measured exactly that content at generation time. reasoning ⊂ output.
    return Math.round(output);
  }
  if (reader.api === "openai-responses" || reader.api === "openai-codex-responses") {
    // Prior-turn reasoning items are discarded on replay; text and tool
    // arguments always come back. Inside the live turn the API requires the
    // reasoning items, so nothing is subtracted there.
    if (options?.currentTurn) return Math.round(output);
    return Math.max(0, Math.round(output - priorTurnDiscarded));
  }
  if (reader.api === "openai-completions") {
    // Pi replays thinking text through a reasoning field only when the stored
    // signature is one of the known marker names; other thinking is dropped.
    const marker = (Array.isArray(message.content) ? message.content : []).some(block =>
      block && typeof block === "object" && (block as { type?: string }).type === "thinking"
      && COMPLETIONS_REASONING_MARKERS.has(String((block as { thinkingSignature?: unknown }).thinkingSignature ?? "")));
    return marker ? Math.round(output) : Math.max(0, Math.round(output - priorTurnDiscarded));
  }
  return null;
}

/**
 * Reader-domain estimator: prices what the ACTIVE model's wire actually carries.
 * - Same-model, unchanged assistant messages with clean generation metadata use
 *   the measured usage.output as the replay proxy (per-API reasoning rules).
 * - Thinking blocks that Pi drops before wire conversion cost 0 on known APIs;
 *   same-model thinking without metadata keeps its visible text as a lower bound.
 * - Opaque signatures never count as text; images follow the API's verified rule
 *   for every role (Claude patch tokens — current 3-family models; flat elsewhere),
 *   with a bounded header parse only.
 */
export function makeReaderTokenEstimator(
  reader: ReaderIdentity,
  calibration: TokenCalibrationStore = _fallbackCalibration,
): TokenEstimator {
  const text = (value: string) => estimateTokensAtFactor(value, reader.provider, calibration.get(reader.provider, reader.id));
  const charEstimate = (message: SerializableMessage, dropThinking: boolean): number => {
    if (!Array.isArray(message.content)) return text(JSON.stringify(serializableMessage(message)));
    let imageTokens = 0;
    const content = message.content.map(block => {
      if (!block || typeof block !== "object") return block;
      const type = (block as { type?: unknown }).type;
      if (type === "image") {
        imageTokens += imageBlockTokens(block as { data?: unknown; source?: { data?: unknown } | string }, reader.api);
        return { type: "image" };
      }
      if (type === "thinking" && dropThinking) return { type: "thinking" };
      if (!SIGNATURE_KEYS.some(key => (block as Record<string, unknown>)[key] !== undefined)) return block;
      const clone: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(block)) {
        if (value !== undefined && !SIGNATURE_KEYS.includes(key)) clone[key] = value;
      }
      return clone;
    });
    return text(JSON.stringify({ ...serializableMessage(message), content })) + imageTokens;
  };
  const estimate = (message: SerializableMessage & AssistantMetadata, options: MessageEstimateOptions | undefined): number => {
    const proxy = replayProxyTokens(message, reader, options);
    if (proxy !== null) return proxy;
    const knownApi = reader.api === "anthropic-messages" || reader.api === "openai-responses"
      || reader.api === "openai-codex-responses" || reader.api === "openai-completions";
    const sameModel = message.provider === reader.provider && message.api === reader.api && message.model === reader.id;
    const responsesApi = reader.api === "openai-responses" || reader.api === "openai-codex-responses";
    // Cross-model assistant thinking is dropped before wire conversion on known
    // APIs, and Responses discards same-model reasoning without metadata; other
    // thinking keeps its visible text as a conservative lower bound.
    const dropThinking = knownApi && message.role === "assistant" && (!sameModel || responsesApi);
    return charEstimate(message, dropThinking);
  };
  return {
    text,
    message: (message, options) => estimate(message as SerializableMessage & AssistantMetadata, options),
    messages: messages => messages.reduce((sum, message) => sum + estimate(message as SerializableMessage & AssistantMetadata, undefined), 0),
  };
}
