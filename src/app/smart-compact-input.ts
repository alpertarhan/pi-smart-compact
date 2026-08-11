import type { CompactionMode, CompressionProfile } from "../types.ts";
import { BUDGET_LIMITS } from "../constants.ts";
import { modeFromLegacyProfile } from "./mode-policy.ts";

export interface SmartCompactInput {
  modelArg?: string;
  mode?: CompactionMode;
  verbose: boolean;
  dryRun: boolean;
  action?: "metrics" | "dashboard" | "restore" | "loops";
  focus?: string;
  note?: string;
  maxLlmCalls?: number;
  maxLlmInputTokens?: number;
  timeoutMs?: number;
}

export type SmartCompactInputResult =
  | { ok: true; value: SmartCompactInput }
  | { ok: false; error: string };

interface Token {
  value: string;
  end: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let value = "";
  let quote: "'" | "\"" | null = null;
  let started = false;
  for (let index = 0; index <= input.length; index++) {
    const char = input[index];
    if (index === input.length || (!quote && /\s/.test(char))) {
      if (started) tokens.push({ value, end: index });
      value = "";
      started = false;
      continue;
    }
    started = true;
    if (char === "\\" && index + 1 < input.length) {
      value += input[++index];
      continue;
    }
    if (char === "'" || char === "\"") {
      if (!quote) quote = char;
      else if (quote === char) quote = null;
      else value += char;
      continue;
    }
    value += char;
  }
  return tokens;
}

function validateBudgets(
  maxCalls: unknown,
  maxInputTokens: unknown,
  maxLatencyMs: unknown,
): SmartCompactInputResult | Pick<SmartCompactInput, "maxLlmCalls" | "maxLlmInputTokens" | "timeoutMs"> {
  const maxLlmCalls = maxCalls == null || maxCalls === "" ? undefined : Number(maxCalls);
  if (maxLlmCalls !== undefined && (!Number.isInteger(maxLlmCalls) || maxLlmCalls < BUDGET_LIMITS.CALLS.min || maxLlmCalls > BUDGET_LIMITS.CALLS.max)) {
    return { ok: false, error: "--max-calls must be an integer from " + BUDGET_LIMITS.CALLS.min + " to " + BUDGET_LIMITS.CALLS.max };
  }
  const maxLlmInputTokens = maxInputTokens == null || maxInputTokens === "" ? undefined : Number(maxInputTokens);
  if (maxLlmInputTokens !== undefined && (!Number.isInteger(maxLlmInputTokens) || maxLlmInputTokens < BUDGET_LIMITS.INPUT_TOKENS.min || maxLlmInputTokens > BUDGET_LIMITS.INPUT_TOKENS.max)) {
    return { ok: false, error: "--max-input-tokens must be an integer from " + BUDGET_LIMITS.INPUT_TOKENS.min + " to " + BUDGET_LIMITS.INPUT_TOKENS.max };
  }
  const timeoutMs = maxLatencyMs == null || maxLatencyMs === "" ? undefined : Number(maxLatencyMs);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < BUDGET_LIMITS.LATENCY_MS.min || timeoutMs > BUDGET_LIMITS.LATENCY_MS.max)) {
    return { ok: false, error: "--max-latency must be " + BUDGET_LIMITS.LATENCY_MS.min + "–" + BUDGET_LIMITS.LATENCY_MS.max + " ms" };
  }
  return { maxLlmCalls, maxLlmInputTokens, timeoutMs };
}

const ACTIONS: Record<string, SmartCompactInput["action"]> = {
  metrics: "metrics",
  dashboard: "dashboard",
  restore: "restore",
  loops: "loops",
};

const MODES: Record<string, CompactionMode | "light"> = {
  auto: "auto",
  fast: "fast",
  balanced: "balanced",
  thorough: "thorough",
  aggressive: "fast",
  slow: "thorough",
  light: "light",
};

export function parseSmartCompactCommand(
  args: string,
  isModelToken: (token: string) => boolean,
): SmartCompactInputResult {
  const tokens = tokenize(args);
  const positional: string[] = [];
  let explicitNote: string | undefined;
  let focus: string | undefined;
  let maxCalls: string | undefined;
  let maxInputTokens: string | undefined;
  let maxLatency: string | undefined;

  for (const [index, token] of tokens.entries()) {
    if (token.value === "--") {
      explicitNote = args.slice(token.end).trim() || undefined;
      break;
    }
    if (token.value.startsWith("--note=")) {
      explicitNote = token.value.slice(7).trim() || undefined;
      continue;
    }
    if (token.value.startsWith("--focus=")) {
      focus = token.value.slice(8).trim() || undefined;
      continue;
    }
    if (token.value.startsWith("--max-calls=")) {
      maxCalls = token.value.slice(12);
      continue;
    }
    if (token.value.startsWith("--max-input-tokens=")) {
      maxInputTokens = token.value.slice(19);
      continue;
    }
    if (token.value.startsWith("--max-latency=")) {
      maxLatency = token.value.slice(14);
      continue;
    }
    if (token.value.startsWith("--")) return { ok: false, error: "Unknown option: " + token.value };
    positional.push(token.value);
    if (index === tokens.length - 1) break;
  }

  const budgets = validateBudgets(maxCalls, maxInputTokens, maxLatency);
  if ("ok" in budgets) return budgets;

  let modelArg: string | undefined;
  let mode: CompactionMode | undefined;
  let verbose = false;
  let dryRun = false;
  let action: SmartCompactInput["action"];
  let cursor = 0;
  while (cursor < positional.length) {
    const token = positional[cursor];
    const lower = token.toLowerCase();
    if (lower === "verbose" || lower === "debug") verbose = true;
    else if (lower === "dry-run") dryRun = true;
    else if (!action && ACTIONS[lower]) action = ACTIONS[lower];
    else if (!modelArg && isModelToken(token)) modelArg = token;
    else if (!mode && MODES[lower]) {
      const parsed = MODES[lower];
      mode = parsed === "light" ? modeFromLegacyProfile("light") : parsed;
    } else break;
    cursor++;
  }

  const note = explicitNote ?? (positional.slice(cursor).join(" ").trim() || undefined);
  return {
    ok: true,
    value: { modelArg, mode, verbose, dryRun, action, focus, note, ...budgets },
  };
}

export function parseSmartCompactTool(params: Record<string, unknown>): SmartCompactInputResult {
  let mode: CompactionMode | undefined;
  if (params.mode != null) {
    const raw = String(params.mode).toLowerCase();
    const parsed = MODES[raw];
    if (!parsed || parsed === "light") return { ok: false, error: "mode must be auto, fast, balanced, or thorough" };
    mode = parsed;
  }
  if (params.profile != null) {
    const profile = String(params.profile) as CompressionProfile;
    if (!(["light", "balanced", "aggressive"] as string[]).includes(profile)) {
      return { ok: false, error: "profile must be light, balanced, or aggressive" };
    }
    mode ??= modeFromLegacyProfile(profile);
  }
  const budgets = validateBudgets(params.max_calls, params.max_input_tokens, params.max_latency_ms);
  if ("ok" in budgets) return budgets;
  return {
    ok: true,
    value: {
      mode,
      verbose: params.verbose === true,
      dryRun: params.dry_run === true,
      action: params.dashboard === true ? "dashboard" : params.report === true ? "metrics" : undefined,
      focus: typeof params.focus === "string" ? params.focus.trim() || undefined : undefined,
      ...budgets,
    },
  };
}
