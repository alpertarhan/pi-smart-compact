import { VerificationGateError } from "../phases/verify.ts";
import { YieldGateError } from "../domain/yield-gate.ts";
import { classifyTelemetryFailure } from "../domain/telemetry.ts";
import type { TelemetryFailureKind } from "../types.ts";

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
    default: return "For local stack diagnostics, restart Pi with DEBUG=smart-compact and reproduce.";
  }
}

/** Never echo provider errors: their bodies may contain prompts, credentials, or paths. */
export function formatGenerationFailureForUi(error: unknown): string {
  const kind = classifyTelemetryFailure(error);
  return kind + ". " + failureAction(kind);
}

/** One content-free UI line; raw diagnostics require explicit local opt-in. */
export function formatCompactErrorForUi(error: unknown): string {
  if (error instanceof VerificationGateError) {
    const kinds = error.gapKinds.slice(0, 4).join(", ") || "unknown";
    return "Verification stopped apply at the " + error.stage + " gate: " + error.score + "/100, " + error.gapCount +
      (error.gapCount === 1 ? " unresolved gap [" : " unresolved gaps [") + kinds + "]. Conversation unchanged. " +
      "Review /smart-compact metrics; do not bypass verification. For local evidence, restart Pi with DEBUG=smart-compact.";
  }
  if (error instanceof YieldGateError) {
    const reason = error.reason === "target-miss" ? "target missed" : "saving below 10%";
    return "Yield check stopped apply: estimated " + error.estimatedAfterTokens.toLocaleString() +
      "t after vs " + error.targetAfterTokens.toLocaleString() + "t target (" + reason +
      "). Conversation unchanged. Try /smart-compact balanced for a larger target; safety checks still apply.";
  }
  return "Smart compact failed [" + classifyTelemetryFailure(error) + "]. Conversation unchanged. " +
    failureAction(classifyTelemetryFailure(error));
}
