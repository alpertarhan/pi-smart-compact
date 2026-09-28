import { describe, expect, it } from "bun:test";
import { createSettledAutoTrigger } from "../src/app/settled-auto-trigger.ts";
import { DEFAULT_CONFIG, MIN_TOKEN_THRESHOLD, SETTLED_TRIGGER_COOLDOWN_MS } from "../src/constants.ts";
import type { CompactConfig } from "../src/types.ts";

function config(overrides: Partial<CompactConfig> = {}): CompactConfig {
  return {
    ...DEFAULT_CONFIG,
    autoTriggerStrategy: "settled",
    minContextPercent: 80,
    ...overrides,
  } as CompactConfig;
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    sessionManager: { getSessionId: () => "settled-session" },
    model: { provider: "openai", id: "test", contextWindow: 100_000 },
    getContextUsage: () => ({ tokens: 85_000, contextWindow: 100_000, percent: 85 }),
    isIdle: () => true,
    hasPendingMessages: () => false,
    compact: () => {},
    ...overrides,
  } as any;
}

describe("settled auto-trigger host handoff", () => {
  it("does not request compaction when pressure or lifecycle guards fail", async () => {
    const cases: Array<{ name: string; cfg?: Partial<CompactConfig>; ctx?: Record<string, unknown> }> = [
      { name: "disabled", cfg: { autoTrigger: false } },
      { name: "native hook strategy", cfg: { autoTriggerStrategy: "native-hook" } },
      { name: "unknown usage", ctx: { getContextUsage: () => ({ tokens: null, contextWindow: 100_000, percent: null }) } },
      { name: "below absolute floor", ctx: { getContextUsage: () => ({ tokens: MIN_TOKEN_THRESHOLD - 1, contextWindow: 100_000, percent: 4 }) } },
      { name: "below relative floor", ctx: { getContextUsage: () => ({ tokens: 79_000, contextWindow: 100_000, percent: 79 }) } },
      { name: "busy", ctx: { isIdle: () => false } },
      { name: "queued", ctx: { hasPendingMessages: () => true } },
      { name: "unresolved session", ctx: { sessionManager: { getSessionId: () => undefined } } },
    ];

    for (const candidate of cases) {
      let requests = 0;
      const trigger = createSettledAutoTrigger();
      await trigger.request(context({ ...candidate.ctx, compact: () => { requests++; } }), config(candidate.cfg));
      expect(requests, candidate.name).toBe(0);
    }
  });

  it("measures the start percent against maxContextTokens when it is below the model window", async () => {
    const requests: unknown[] = [];
    const ctx = context({
      model: { provider: "openai", id: "large", contextWindow: 1_000_000 },
      getContextUsage: () => ({ tokens: 180_000, contextWindow: 1_000_000, percent: 18 }),
      compact: (options: unknown) => requests.push(options),
    });
    // 18% of the model window stays below the 60% gate without a cap.
    await createSettledAutoTrigger().request(ctx, config({ minContextPercent: 60 }));
    expect(requests).toHaveLength(0);
    // 180k of a 200k cap is 90% ≥ 60%.
    void createSettledAutoTrigger().request(ctx, config({ minContextPercent: 60, maxContextTokens: 200_000 }));
    expect(requests).toHaveLength(1);
    // 180k of a 400k cap is 45% < 60%.
    await createSettledAutoTrigger().request(ctx, config({ minContextPercent: 60, maxContextTokens: 400_000 }));
    expect(requests).toHaveLength(1);
  });

  it("deduplicates concurrent requests and cools down only after success", async () => {
    let now = 1_000;
    const callbacks: Array<{ onComplete?: (result: unknown) => void; onError?: (error: Error) => void }> = [];
    const ctx = context({ compact: (options: any) => callbacks.push(options) });
    const trigger = createSettledAutoTrigger({ now: () => now });

    const first = trigger.request(ctx, config());
    const duplicate = trigger.request(ctx, config());
    expect(callbacks).toHaveLength(1);
    callbacks[0].onComplete?.({});
    await Promise.all([first, duplicate]);

    await trigger.request(ctx, config());
    expect(callbacks).toHaveLength(1);

    now += SETTLED_TRIGGER_COOLDOWN_MS;
    const afterCooldown = trigger.request(ctx, config());
    expect(callbacks).toHaveLength(2);
    callbacks[1].onComplete?.({});
    await afterCooldown;
  });

  it("releases a failed request for the next settled event", async () => {
    const callbacks: Array<{ onComplete?: (result: unknown) => void; onError?: (error: Error) => void }> = [];
    const ctx = context({ compact: (options: any) => callbacks.push(options) });
    const trigger = createSettledAutoTrigger();

    const failed = trigger.request(ctx, config());
    callbacks[0].onError?.(new Error("host rejected compaction"));
    await failed;

    const retry = trigger.request(ctx, config());
    expect(callbacks).toHaveLength(2);
    callbacks[1].onComplete?.({});
    await retry;
  });

  it("releases the session after a bounded wait when the host never calls back", async () => {
    const callbacks: unknown[] = [];
    const ctx = context({ compact: (options: unknown) => callbacks.push(options) });
    const trigger = createSettledAutoTrigger({ watchdogMs: 10 });

    await trigger.request(ctx, config());
    expect(callbacks).toHaveLength(1);
    // No cooldown was recorded, so the next settled event may request again.
    void trigger.request(ctx, config());
    expect(callbacks).toHaveLength(2);
  });

  it("uses confirmed host compaction as cooldown and clears session state on shutdown", async () => {
    const callbacks: Array<{ onComplete?: (result: unknown) => void }> = [];
    const ctx = context({ compact: (options: any) => callbacks.push(options) });
    const trigger = createSettledAutoTrigger();

    trigger.noteCompaction("settled-session");
    await trigger.request(ctx, config());
    expect(callbacks).toHaveLength(0);

    trigger.clear("settled-session");
    const request = trigger.request(ctx, config());
    expect(callbacks).toHaveLength(1);
    callbacks[0].onComplete?.({});
    await request;
  });
});
