// Cache-economy plumbing: D1 request-start estimate, F configurable limits, G inspect memo.
import { describe, expect, it } from "bun:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";
import { fingerprintContext } from "../src/app/pending-slot.ts";
import {
  AUTO_TRIM_BREAK_EVEN_REQUESTS,
  DEFAULT_CONFIG,
} from "../src/constants.ts";
import { validateSmartCompactConfig } from "../src/utils/helpers.ts";
import {
  CONTEXT_CONTROL_TYPE,
  clearInspectContextMemo,
  inspectContext,
  planContextTrim,
  _inspectContextMemoSizeForTests,
} from "../src/app/context-operations.ts";
import { cachedPrefix, formatDeferredTrim } from "../src/app/register-smart-context-tool.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistant(ts: number, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test",
    model: "m",
    stopReason: "stop",
    timestamp: ts,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
    ...overrides,
  };
}

function user(ts: number, text = "hi"): { role: "user"; content: string; timestamp: number } {
  return { role: "user", content: text, timestamp: ts };
}

function toolResult(ts: number): { role: "toolResult"; toolCallId: string; toolName: string; content: { type: "text"; text: string }[]; isError: boolean; timestamp: number } {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "grep",
    content: [{ type: "text", text: "output" }],
    isError: false,
    timestamp: ts,
  };
}

type PrefixModel = Parameters<typeof cachedPrefix>[1];

function messageEntry(id: string, message: unknown): SessionEntry {
  return { id, type: "message", message } as unknown as SessionEntry;
}

function prefixModel(promptCache?: { short?: number; long?: number }): PrefixModel {
  return {
    provider: "test",
    id: "m",
    contextWindow: 200_000,
    maxTokens: 8_192,
    ...(promptCache ? { promptCache } : {}),
  } as unknown as PrefixModel;
}

describe("cachedPrefix request-start estimate (D1)", () => {
  it("returns null without model or cache metadata", () => {
    expect(cachedPrefix([], undefined)).toBeNull();
    expect(cachedPrefix([], prefixModel())).toBeNull();
    expect(cachedPrefix([messageEntry("e1", user(1)), messageEntry("e2", assistant(2))], prefixModel())).toBeNull();
  });

  it("returns null for an empty branch", () => {
    expect(cachedPrefix([], prefixModel({ short: 300 }))).toBeNull();
  });

  it("estimates request start from the preceding user turn, not the response end", () => {
    // Generation took 60s; the 5m TTL starts at the request (~user timestamp).
    // Using the response end would overstate the remaining lifetime by 60s.
    const prefix = cachedPrefix(
      [messageEntry("e1", user(1_000)), messageEntry("e2", assistant(61_000))],
      prefixModel({ short: 300 }),
    );
    expect(prefix).not.toBeNull();
    expect(prefix!.since).toBe(1_000);
    expect(prefix!.lifetimeMs).toBe(300_000);
  });

  it("uses the toolResult boundary in a tool loop", () => {
    const prefix = cachedPrefix(
      [
        messageEntry("e1", user(1_000)),
        messageEntry("e2", assistant(2_000, { stopReason: "toolUse" })),
        messageEntry("e3", toolResult(3_000)),
        messageEntry("e4", assistant(93_000)),
      ],
      prefixModel({ short: 300 }),
    );
    expect(prefix!.since).toBe(3_000);
  });

  it("falls back to the assistant timestamp without a predecessor", () => {
    const prefix = cachedPrefix([messageEntry("e1", assistant(5_000))], prefixModel({ short: 300 }));
    expect(prefix!.since).toBe(5_000);
  });

  it("uses the earlier assistant turn for consecutive assistant entries", () => {
    const prefix = cachedPrefix(
      [messageEntry("e1", assistant(1_000)), messageEntry("e2", assistant(42_000))],
      prefixModel({ short: 300 }),
    );
    expect(prefix!.since).toBe(1_000);
  });

  it("ignores non-message predecessors after a compaction boundary", () => {
    const compaction = { id: "c1", type: "compaction", timestamp: 2_000 };
    const prefix = cachedPrefix(
      [messageEntry("e1", user(1_000)), compaction as unknown as SessionEntry, messageEntry("e3", assistant(62_000))],
      prefixModel({ short: 300 }),
    );
    expect(prefix!.since).toBe(62_000);
  });

  it("ignores a predecessor timestamp that postdates the response", () => {
    const prefix = cachedPrefix(
      [messageEntry("e1", user(99_000)), messageEntry("e2", assistant(5_000))],
      prefixModel({ short: 300 }),
    );
    expect(prefix!.since).toBe(5_000);
  });

  it("stops the walk at a same-route boundary and keeps the newest same-route prefix", () => {
    const prefix = cachedPrefix(
      [
        messageEntry("e1", user(1_000)),
        messageEntry("e2", assistant(2_000, { provider: "other", model: "other" })),
        messageEntry("e3", assistant(62_000)),
      ],
      prefixModel({ short: 300 }),
    );
    // The foreign assistant breaks the walk: only the newest same-route
    // assistant exists, so its predecessor (a foreign message) still serves
    // as the request-start proxy for it.
    expect(prefix!.since).toBe(2_000);
  });

  it("extends the lifetime with a reported 1h write", () => {
    const message = assistant(61_000, {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 4_000, cacheWrite1h: 4_000, totalTokens: 0, cost: ZERO_COST },
    });
    const prefix = cachedPrefix(
      [messageEntry("e1", user(1_000)), messageEntry("e2", message)],
      prefixModel({ short: 300 }),
    );
    expect(prefix!.lifetimeMs).toBe(3_600_000);
  });
});

describe("inspectContext memo (G)", () => {
  function checkpointSession(): SessionManager {
    const sm = SessionManager.inMemory();
    sm.appendMessage({ role: "user", content: "Research base", timestamp: 1 });
    const snapshot = fingerprintContext(contextMessageEntries(sm.getBranch()));
    sm.appendCustomEntry(CONTEXT_CONTROL_TYPE, {
      version: 1,
      action: "checkpoint",
      checkpoint: {
        id: "cp-1",
        label: "Detour",
        sessionId: sm.getSessionId(),
        originId: sm.getBranch()[0]!.id,
        snapshot,
      },
    });
    return sm;
  }

  it("returns the identical result object for an unchanged branch", () => {
    clearInspectContextMemo();
    const sm = checkpointSession();
    const first = inspectContext(sm.getBranch(), sm.getSessionId());
    const second = inspectContext(sm.getBranch(), sm.getSessionId());
    expect(second.checkpoint).toBe(first.checkpoint);
    expect(second.references).toBe(first.references);
  });

  it("recomputes when the branch grows", () => {
    clearInspectContextMemo();
    const sm = checkpointSession();
    expect(inspectContext(sm.getBranch(), sm.getSessionId()).checkpoint).not.toBeNull();
    sm.appendMessage({ role: "user", content: "New instructions", timestamp: 2 });
    const state = inspectContext(sm.getBranch(), sm.getSessionId());
    expect(state.checkpoint).toBeNull();
    expect(state.invalidReason).toContain("New user instructions");
  });

  it("recomputes when a different branch shares the same length", () => {
    clearInspectContextMemo();
    const withTrim = SessionManager.inMemory();
    withTrim.appendMessage({ role: "user", content: "a", timestamp: 1 });
    withTrim.appendCustomEntry(CONTEXT_CONTROL_TYPE, {
      version: 1,
      action: "trim",
      references: ["entry-x"],
      archives: [{ id: "entry-x", sha256: "a".repeat(64), chars: 5_000 }],
    });
    const withoutTrim = SessionManager.inMemory();
    withoutTrim.appendMessage({ role: "user", content: "a", timestamp: 1 });
    withoutTrim.appendMessage({ role: "user", content: "b", timestamp: 2 });
    expect(withTrim.getBranch().length).toBe(withoutTrim.getBranch().length);
    const trimmed = inspectContext(withTrim.getBranch(), withTrim.getSessionId());
    const plain = inspectContext(withoutTrim.getBranch(), withoutTrim.getSessionId());
    expect(trimmed.references.has("entry-x")).toBe(true);
    expect(plain.references.has("entry-x")).toBe(false);
  });

  it("keeps sessions isolated and bounded", () => {
    clearInspectContextMemo();
    const sessions: SessionManager[] = [];
    for (let i = 0; i < 12; i++) {
      const sm = checkpointSession();
      sessions.push(sm);
      inspectContext(sm.getBranch(), sm.getSessionId());
    }
    expect(_inspectContextMemoSizeForTests()).toBeLessThanOrEqual(8);
    // The most recent sessions stay memoized.
    const last = sessions.at(-1)!;
    const again = inspectContext(last.getBranch(), last.getSessionId());
    expect(again.checkpoint?.id).toBe("cp-1");
  });

  it("clear hook resets the memo", () => {
    const sm = checkpointSession();
    inspectContext(sm.getBranch(), sm.getSessionId());
    clearInspectContextMemo();
    expect(_inspectContextMemoSizeForTests()).toBe(0);
  });
});

describe("auto-trim economy config (F)", () => {
  it("defaults mirror the documented constants", () => {
    expect(DEFAULT_CONFIG.autoTrimBreakEvenRequests).toBe(AUTO_TRIM_BREAK_EVEN_REQUESTS);
    expect(DEFAULT_CONFIG.autoTrimMinSavingChars).toBe(16_384);
  });

  it("accepts in-range values including zero minimum savings", () => {
    const sc: Record<string, unknown> = { autoTrimBreakEvenRequests: 10, autoTrimMinSavingChars: 0 };
    validateSmartCompactConfig(sc);
    expect(sc.autoTrimBreakEvenRequests).toBe(10);
    expect(sc.autoTrimMinSavingChars).toBe(0);
  });

  it("discards out-of-range values", () => {
    const sc: Record<string, unknown> = { autoTrimBreakEvenRequests: 0, autoTrimMinSavingChars: -5 };
    validateSmartCompactConfig(sc);
    expect("autoTrimBreakEvenRequests" in sc).toBe(false);
    expect("autoTrimMinSavingChars" in sc).toBe(false);
    const high: Record<string, unknown> = { autoTrimBreakEvenRequests: 1_001, autoTrimMinSavingChars: 10_000_001 };
    validateSmartCompactConfig(high);
    expect("autoTrimBreakEvenRequests" in high).toBe(false);
    expect("autoTrimMinSavingChars" in high).toBe(false);
    const nonNumber: Record<string, unknown> = { autoTrimBreakEvenRequests: "many", autoTrimMinSavingChars: true };
    validateSmartCompactConfig(nonNumber);
    expect("autoTrimBreakEvenRequests" in nonNumber).toBe(false);
    expect("autoTrimMinSavingChars" in nonNumber).toBe(false);
  });
});

describe("planContextTrim configurable savings floor", () => {
  function researchSession(batches: number): SessionManager {
    const sm = SessionManager.inMemory();
    sm.appendMessage({ role: "user", content: "Find the parseConfig call sites", timestamp: 1 });
    for (let i = 0; i < batches; i++) {
      const callId = `call-${i}`;
      sm.appendMessage(assistant(10 + i, {
        content: [{ type: "toolCall", id: callId, name: "grep", arguments: { pattern: `parseConfig-${i}` } }],
        stopReason: "toolUse",
      }));
      sm.appendMessage({
        role: "toolResult",
        toolCallId: callId,
        toolName: "grep",
        content: [{ type: "text", text: `match ${i}\n` + "x".repeat(5_000) }],
        isError: false,
        timestamp: 10 + i,
      });
    }
    return sm;
  }

  it("defers a small batch under the default floor", () => {
    const sm = researchSession(5);
    const plan = planContextTrim(sm.getBranch());
    expect(plan.automatic).toBe("insufficient-savings");
  });

  it("readies the same batch with a lowered floor", () => {
    const sm = researchSession(5);
    const plan = planContextTrim(sm.getBranch(), undefined, { minSavingChars: 1_000 });
    expect(plan.automatic).toBe("ready");
    expect(plan.savedChars).toBeGreaterThan(1_000);
  });

  it("keeps deferring when the custom floor still exceeds savings", () => {
    const sm = researchSession(5);
    const plan = planContextTrim(sm.getBranch(), undefined, { minSavingChars: 999_999 });
    expect(plan.automatic).toBe("insufficient-savings");
  });
});

describe("formatDeferredTrim configurable limit", () => {
  const deferred = { savedTokens: 50_000, tailTokens: 10_000, breakEvenRequests: 30 };

  it("uses the default limit", () => {
    expect(formatDeferredTrim(deferred)).toContain("limit 24");
  });

  it("honors a custom limit", () => {
    expect(formatDeferredTrim(deferred, 50)).toContain("limit 50");
    expect(formatDeferredTrim(deferred, 50)).toContain("after 30 requests");
  });

  it("explains an unknown price without a limit claim", () => {
    const text = formatDeferredTrim({ savedTokens: 1_000, tailTokens: 100, breakEvenRequests: null });
    expect(text).toContain("cache price is unknown");
    expect(text).not.toContain("limit");
  });
});
