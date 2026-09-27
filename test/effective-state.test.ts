import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeReadiness } from "../src/app/effective-state.ts";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import type { CompactConfig } from "../src/types.ts";

function ctx(contextWindow: number): ExtensionContext {
  const model = { provider: "openai", id: "reader", api: "openai-responses", contextWindow, maxTokens: 8_192 };
  return {
    model,
    sessionManager: { getSessionId: () => "effective-state-session" },
    modelRegistry: { getAvailable: () => [model], find: () => model },
    getContextUsage: () => ({ tokens: 100_000, contextWindow, percent: 100_000 / contextWindow * 100 }),
  } as unknown as ExtensionContext; // only the fields describeReadiness reads
}

const largeWindowWarning = (warnings: string[]) => warnings.filter(line => line.includes("maxContextTokens"));

describe("describeReadiness large-window warning", () => {
  it("warns only for windows above 400k while maxContextTokens does not cap them", async () => {
    const config = (overrides: Partial<CompactConfig> = {}): CompactConfig => ({ ...DEFAULT_CONFIG, ...overrides });
    const off = await describeReadiness(ctx(1_000_000), config());
    expect(largeWindowWarning(off.warnings)).toEqual([
      "Model window 1,000,000 tokens; maxContextTokens is off, so automatic compaction waits for 60% of the full window. Set maxContextTokens to trigger earlier.",
    ]);
    // A cap at or above the window does not change the trigger, so the warning stays.
    expect(largeWindowWarning((await describeReadiness(ctx(1_000_000), config({ maxContextTokens: 1_000_000 }))).warnings)).toHaveLength(1);
    expect(largeWindowWarning((await describeReadiness(ctx(1_000_000), config({ maxContextTokens: 200_000 }))).warnings)).toEqual([]);
    expect(largeWindowWarning((await describeReadiness(ctx(400_000), config())).warnings)).toEqual([]);
    expect(largeWindowWarning((await describeReadiness(ctx(1_000_000), config({ autoTrigger: false }))).warnings)).toEqual([]);
  });
});
