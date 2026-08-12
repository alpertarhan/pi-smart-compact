import { describe, expect, it } from "bun:test";
import { VerificationGateError } from "../src/phases/verify.ts";
import { YieldGateError } from "../src/domain/yield-gate.ts";
import { formatCompactErrorForUi } from "../src/ui/error-format.ts";

describe("bounded Smart Compact error UX", () => {
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
      "Conversation unchanged. Set DEBUG=smart-compact for stack diagnostics.",
    );
  });

  it("collapses and caps unknown multiline errors while retaining opt-in debug guidance", () => {
    const text = formatCompactErrorForUi(new Error("first line\n" + "trace ".repeat(200)));

    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThan(340);
    expect(text).toEndWith("Conversation unchanged. Set DEBUG=smart-compact for stack diagnostics.");
  });
});
