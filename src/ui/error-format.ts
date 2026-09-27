import { VerificationGateError } from "../phases/verify.ts";
import { YieldGateError } from "../domain/yield-gate.ts";
import { classifyTelemetryFailure } from "../domain/telemetry.ts";
import type { TelemetryFailureKind } from "../types.ts";
import { SecretScrubber } from "../domain/scrub.ts";
import { ModelCapacityError } from "../domain/model-capacity.ts";

const DETAIL_MAX_CHARS = 160;
const detailScrubber = new SecretScrubber(true, false);

/**
 * Literal, scrubbed diagnostic: "<status> <ErrorType>: <first message line>",
 * at most 160 chars. Response bodies beyond the first line are never included.
 */
export function providerErrorDetail(error: unknown): string {
 const value = (error && typeof error === "object" ? error : {}) as {
  name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown;
 };
 const status = Number(value.status ?? value.statusCode);
 const name = typeof value.name === "string" && value.name !== "Error" ? value.name : "";
 const message = typeof value.message === "string"
  ? value.message
  : typeof error === "string" ? error : "";
 const firstLine = message.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
 const head = [Number.isFinite(status) ? String(status) : "", name].filter(Boolean).join(" ");
 const raw = (head && firstLine ? head + ": " + firstLine : head || firstLine).replace(/\s+/g, " ");
 const scrubbed = detailScrubber.scrubText(raw).value.trim();
 return scrubbed.length > DETAIL_MAX_CHARS ? scrubbed.slice(0, DETAIL_MAX_CHARS - 1) + "…" : scrubbed;
}

function withDetail(error: unknown): string {
 const detail = providerErrorDetail(error);
 return detail ? " (" + detail + ")" : "";
}

function failureAction(kind: TelemetryFailureKind): string {
 switch (kind) {
  case "authentication": return "Check the selected model's credentials or use /login.";
  case "rate-limit": return "Wait for the provider quota to recover before retrying.";
  case "timeout": return "Try Fast or review the latency budget in /smart-compact settings.";
  case "budget": return "Review call/token limits in /smart-compact settings.";
  case "output-limit": return "Review the model output limit and reasoning level.";
  case "provider":
  case "validation": return "Check model availability and /smart-compact metrics; select another route manually if needed.";
  case "cancelled": return "Retry when ready.";
  default: return "This looks like an internal error; /smart-compact metrics lists recent issues with details.";
 }
}

/** Failure kind, the scrubbed literal first error line, and an action. */
export function formatGenerationFailureForUi(error: unknown): string {
 if (error instanceof ModelCapacityError) return "Model capacity" + withDetail(error) + ". Request not sent. Choose a larger stage model or a smaller compaction plan.";
 const kind = classifyTelemetryFailure(error);
 return kind + withDetail(error) + ". " + failureAction(kind);
}

/** One UI line: kind, scrubbed literal first error line, effect, action. */
export function formatCompactErrorForUi(error: unknown): string {
 if (error instanceof ModelCapacityError) return formatGenerationFailureForUi(error) + " Conversation unchanged.";
 // Engine-chain outcomes are already literal and content-free.
 if (error instanceof Error && error.name === "EngineChainError") return error.message;
 if (error instanceof VerificationGateError) {
  const kinds = error.gapKinds.slice(0, 4).join(", ") || "unknown";
  return "Verification stopped apply at the " + error.stage + " gate: " + error.score + "/100, " + error.gapCount +
   (error.gapCount === 1 ? " unresolved gap [" : " unresolved gaps [") + kinds + "]. Conversation unchanged. " +
   "Review /smart-compact metrics; do not bypass verification.";
 }
 if (error instanceof YieldGateError) {
  const reason = error.reason === "target-miss" ? "target missed" : "saving below 10%";
  return "Yield check stopped apply: estimated " + error.estimatedAfterTokens.toLocaleString() +
   "t after vs " + error.targetAfterTokens.toLocaleString() + "t target (" + reason +
   "). Conversation unchanged. Try /smart-compact balanced for a larger target; safety checks still apply.";
 }
 const kind = classifyTelemetryFailure(error);
 return "Smart compact failed [" + kind + "]" + withDetail(error) + ". Conversation unchanged. " +
  failureAction(kind);
}
