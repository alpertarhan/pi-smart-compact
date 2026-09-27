import { describe, expect, it } from "bun:test";
import { VerificationGateError } from "../src/phases/verify.ts";
import {
  formatCompactErrorForUi,
  providerErrorDetail,
} from "../src/ui/error-format.ts";

describe("bounded Smart Compact error UX", () => {
  it("redacts credentials and omits provider response bodies", () => {
    const key = "sk-ant-api03-" + "a".repeat(40);
    const error = Object.assign(new Error("invalid x-api-key " + key + "\n{\"prompt\":\"SECRET_BODY\"}"), {
      status: 401,
      name: "AuthenticationError",
    });
    const text = formatCompactErrorForUi(error);
    expect(text).not.toContain(key);
    expect(text).not.toContain("SECRET_BODY");
  });

  it("preserves a provider error code while bounding the diagnostic", () => {
    const error = Object.assign(new Error("NATIVE_UNSUPPORTED: " + "z".repeat(400)), { status: 400 });
    const detail = providerErrorDetail(error);
    expect(detail).toContain("NATIVE_UNSUPPORTED");
    expect(detail.length).toBeLessThanOrEqual(160);
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

    expect(text).not.toContain("SECRET_EVIDENCE");
    expect(text).not.toContain("private/path.ts");
    expect(text).not.toContain("\n");
  });

  it("bounds unknown error details and omits stack lines", () => {
    const text = formatCompactErrorForUi(new Error("first line\n" + "trace ".repeat(200)));

    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThan(400);
    expect(text).not.toContain("trace");
  });
});
