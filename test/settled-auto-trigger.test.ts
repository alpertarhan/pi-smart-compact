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

  it("deduplicates concurrent requests and cools down after success", async () => {
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

  it.each(["settled", "background"] as const)("throttles failed %s attempts, including throws and missing callbacks", async autoTriggerStrategy => {
    for (const failure of ["callback", "throw", "watchdog"] as const) {
      let now = 1_000;
      const callbacks: Array<{ onComplete?: (result: unknown) => void; onError?: (error: Error) => void }> = [];
      const ctx = context({ compact: (options: any) => {
        callbacks.push(options);
        if (callbacks.length > 1) { options.onComplete?.({}); return; }
        // Cooldown starts after the failed work, not before its provider latency.
        now += 30_000;
        if (failure === "throw") throw new Error("host rejected compaction");
        if (failure === "callback") options.onError?.(new Error("host rejected compaction"));
      } });
      const trigger = createSettledAutoTrigger({ now: () => now, watchdogMs: 10 });
      const cfg = config({ autoTriggerStrategy });

      await trigger.request(ctx, cfg);
      expect(callbacks, failure).toHaveLength(1);
      await trigger.request(ctx, cfg);
      expect(callbacks, failure).toHaveLength(1);

      now += SETTLED_TRIGGER_COOLDOWN_MS - 1;
      await trigger.request(ctx, cfg);
      expect(callbacks, failure).toHaveLength(1);
      // A late host callback must not extend an already-finished attempt's cooldown.
      callbacks[0].onComplete?.({});
      now++;
      await trigger.request(ctx, cfg);
      expect(callbacks, failure).toHaveLength(2);
    }
  });

  it("reports a pending host honestly and never suggests manual retry while the host is busy (A11)", async () => {
    const notices: Array<{ message: string; severity: string }> = [];
    let completed = false;
    let compacting = false;
    let resolveHost!: () => void;
    const hostFinished = new Promise<void>((resolve) => { resolveHost = resolve; });
    let requests = 0;
    const trigger = createSettledAutoTrigger({ watchdogMs: 10 });
    const ctx = context({
      sessionManager: { getSessionId: () => "settled-busy-host" },
      hasUI: true,
      ui: { notify: (message: string, severity: string) => notices.push({ message, severity }) },
      isIdle: () => !compacting,
      compact: (options: any) => {
        requests++;
        compacting = true;
        setTimeout(() => {
          completed = true;
          compacting = false;
          trigger.noteCompaction("settled-session");
          options.onComplete({});
          resolveHost();
        }, 40);
      },
    });
    const cfg = config();

    await trigger.request(ctx, cfg);

    // The watchdog fired while the host was still compacting: the notice
    // must describe pending work, not a missing result, and must not send
    // the user to a manual retry that would collide with the busy host.
    expect(completed).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).not.toMatch(/did not report/);
    expect(notices[0].message).not.toContain("Run /smart-compact manually");
    expect(notices[0].message).toMatch(/still busy/i);

    // Cooldown applies: no duplicate request while the host finishes.
    await trigger.request(ctx, cfg);
    expect(requests).toBe(1);

    await hostFinished;
    expect(completed).toBe(true);
    expect(requests).toBe(1);
  });

  it("still suggests manual retry after a silent watchdog on an idle host (A11)", async () => {
    const notices: Array<{ message: string; severity: string }> = [];
    const trigger = createSettledAutoTrigger({ watchdogMs: 10 });
    const ctx = context({
      sessionManager: { getSessionId: () => "settled-idle-host" },
      hasUI: true,
      ui: { notify: (message: string, severity: string) => notices.push({ message, severity }) },
      compact: () => { /* host never calls back and is not busy */ },
    });
    await trigger.request(ctx, config());
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toMatch(/did not report/);
    expect(notices[0].message).toContain("Run /smart-compact manually");
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
