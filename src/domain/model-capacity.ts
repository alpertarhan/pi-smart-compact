import type { Api, Model } from "@earendil-works/pi-ai";
import type { LLMCallMetric } from "../types.ts";

type CapacityModel = Pick<Model<Api>, "provider" | "id" | "contextWindow" | "maxTokens">;

// Stock pi-ai 0.87 reserves this headroom before building provider requests.
// Without it, a nominally fitting request can be silently reduced to one output token.
const SDK_CONTEXT_HEADROOM = 4096;

export function clampCompletionMaxTokens(
  model: CapacityModel,
  requested: number | undefined,
): number | undefined {
  if (requested === undefined) return undefined;
  const modelLimit = Number.isFinite(model.maxTokens) && model.maxTokens > 0
    ? model.maxTokens
    : requested;
  return Math.max(1, Math.min(requested, modelLimit));
}

/** Local estimate, not a provider tokenizer guarantee. Applied again to each built request. */
export function modelRequestCapacityReason(
  model: CapacityModel,
  estimatedInputTokens: number,
  requestedOutputTokens: number | undefined,
): string | undefined {
  const window = model.contextWindow;
  if (!Number.isFinite(window) || window <= 0) {
    return `${model.provider}/${model.id}: context limit unavailable. Refresh the model catalog or choose a model with a known limit.`;
  }
  if (window <= SDK_CONTEXT_HEADROOM) {
    return `${model.provider}/${model.id}: the ${window.toLocaleString()}-token context window cannot accommodate ${SDK_CONTEXT_HEADROOM.toLocaleString()} tokens of SDK headroom. Choose a model with a larger context window.`;
  }
  const input = Math.ceil(Math.max(0, estimatedInputTokens));
  const output = clampCompletionMaxTokens(model, requestedOutputTokens)
    ?? (Number.isFinite(model.maxTokens) ? Math.max(0, model.maxTokens) : 0);
  if (input + output + SDK_CONTEXT_HEADROOM <= window) return undefined;
  return `${model.provider}/${model.id}: estimated request needs ${input.toLocaleString()} input + ${output.toLocaleString()} output + ${SDK_CONTEXT_HEADROOM.toLocaleString()} SDK headroom tokens; context limit ${window.toLocaleString()}. Choose a larger stage model or a smaller compaction plan.`;
}

export class ModelCapacityError extends Error {
  constructor(readonly phase: LLMCallMetric["phase"], reason: string) {
    super(reason);
    this.name = "ModelCapacityError";
  }
}
