import { describe, expect, it } from "bun:test";
import { VerificationGateError } from "../src/phases/verify.ts";
import { YieldGateError } from "../src/domain/yield-gate.ts";
import { formatCompactErrorForUi } from "../src/ui/error-format.ts";

describe("bounded Smart Compact error UX", () => {
  it("offers a credential action without echoing provider response bodies", () => {
    const error = Object.assign(new Error("SECRET_PROVIDER_PAYLOAD"), { status: 401 });
    const text = formatCompactErrorForUi(error);
    expect(text).toContain("authentication");
    expect(text).toContain("/login");
    expect(text).not.toContain("SECRET_PROVIDER_PAYLOAD");
    expect(text).not.toContain("DEBUG");
  });
  it("renders verification diagnostics without evidence text or stack lines", () => {
    const error = new VerificationGateError({
      ok: false,
      score: 42,
      gaps: [
        { kind: "missing-error", message: "SECRET_EVIDENCE\n" + "x".repeat(2_000) },
        { kind: "missing-file", path: "private/path.ts" },
      ],
    }, 18, "post-synthesis");

    const text = formatCompactErrorForUi(error);

    expect(text).toContain("42/100, 2 unresolved gaps");
    expect(text).toContain("post-synthesis gate");
    expect(text).toContain("missing-error, missing-file");
    expect(text).not.toContain("SECRET_EVIDENCE");
    expect(text).not.toContain("private/path.ts");
    expect(text).not.toContain("\n");
  });

  it("explains yield rejection in one content-free line", () => {
    const error = new YieldGateError("target-miss", {
      plannedAfterTokens: 40_000,
      plannedSavedTokens: 60_000,
      plannedYield: 0.6,
      summaryTokens: 12_000,
      estimatedAfterTokens: 42_000,
      estimatedSavedTokens: 58_000,
      estimatedYield: 0.58,
      retainedTailTokens: 30_000,
      summaryBudgetTokens: 10_000,
      targetAfterTokens: 40_000,
      relaxedSoftBoundaries: [],
      hardBoundaryAdjusted: false,
    });

    expect(formatCompactErrorForUi(error)).toBe(
      "Yield check stopped apply: estimated 42,000t after vs 40,000t target (target missed). " +
      "Conversation unchanged. Try /smart-compact balanced for a larger target; safety checks still apply.",
    );
  });

  it("does not expose unknown error text and explains how to collect opt-in diagnostics", () => {
    const text = formatCompactErrorForUi(new Error("first line\n" + "trace ".repeat(200)));

    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThan(340);
    expect(text).not.toContain("first line");
    expect(text).toContain("internal");
    expect(text).toContain("restart Pi with DEBUG=smart-compact");
  });
});
