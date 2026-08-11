import { describe, expect, it } from "bun:test";
import { parseSmartCompactCommand, parseSmartCompactTool } from "../src/app/smart-compact-input.ts";

const modelToken = (token: string) => token === "openai/gpt-5";

describe("smart compact input parsing", () => {
  it("consumes only leading control tokens and preserves mode-like note words", () => {
    const result = parseSmartCompactCommand(
      "openai/gpt-5 balanced --max-calls=4 focus on fast startup in src/auth.ts",
      modelToken,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        modelArg: "openai/gpt-5",
        mode: "balanced",
        verbose: false,
        dryRun: false,
        action: undefined,
        focus: undefined,
        note: "focus on fast startup in src/auth.ts",
        maxLlmCalls: 4,
        maxLlmInputTokens: undefined,
        timeoutMs: undefined,
      },
    });
  });

  it("preserves explicit notes after the double-dash boundary", () => {
    const result = parseSmartCompactCommand("--  keep  balanced and fast in src/auth.ts", modelToken);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBeUndefined();
      expect(result.value.note).toBe("keep  balanced and fast in src/auth.ts");
    }
  });

  it("does not reinterpret file paths as provider/model arguments", () => {
    const result = parseSmartCompactCommand("src/auth.ts must stay reversible", modelToken);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.modelArg).toBeUndefined();
      expect(result.value.note).toBe("src/auth.ts must stay reversible");
    }
  });

  it("rejects invalid tool mode and budgets instead of silently defaulting", () => {
    expect(parseSmartCompactTool({ mode: "turbo" })).toEqual({
      ok: false,
      error: "mode must be auto, fast, balanced, or thorough",
    });
    const budget = parseSmartCompactTool({ max_calls: 101 });
    expect(budget.ok).toBe(false);
    if (!budget.ok) expect(budget.error).toContain("--max-calls");
  });
});
