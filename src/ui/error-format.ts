import { VerificationGateError } from "../phases/verify.ts";
import { YieldGateError } from "../domain/yield-gate.ts";

const MAX_ERROR_TEXT = 240;
const DEBUG_HINT = "Conversation unchanged. Set DEBUG=smart-compact for stack diagnostics.";

function compactText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_TEXT) || "Unknown error";
}

/** One bounded, content-free UI line; full diagnostics belong in local logs. */
export function formatCompactErrorForUi(error: unknown): string {
  if (error instanceof VerificationGateError) {
    const kinds = error.gapKinds.slice(0, 4).join(", ") || "unknown";
    return "Verification stopped apply: " + error.score + "/100, " + error.gapCount +
      " unresolved gap(s) [" + kinds + "]. " + DEBUG_HINT;
  }
  if (error instanceof YieldGateError) {
    const reason = error.reason === "target-miss" ? "target missed" : "saving below 10%";
    return "Yield check stopped apply: estimated " + error.estimatedAfterTokens.toLocaleString() +
      "t after vs " + error.targetAfterTokens.toLocaleString() + "t target (" + reason +
      "). " + DEBUG_HINT;
  }
  return "Smart compact failed: " + compactText(error) + ". " + DEBUG_HINT;
}
