import { describe, expect, it } from "bun:test";
import { createNativeContinuityBridge } from "../src/app/native-continuity-bridge.ts";

describe("NativeContinuityBridge", () => {
  it("delivers continuity once to the matching session", () => {
    const bridge = createNativeContinuityBridge();
    bridge.stage("a", "ledger A");
    bridge.stage("b", "ledger B");
    expect(bridge.take("a")).toBe("ledger A");
    expect(bridge.take("a")).toBeNull();
    expect(bridge.take("b")).toBe("ledger B");
  });

  it("expires entries and evicts oldest at the bound", () => {
    let now = 0;
    const bridge = createNativeContinuityBridge({ ttlMs: 10, maxEntries: 2, now: () => now });
    bridge.stage("a", "A");
    bridge.stage("b", "B");
    bridge.stage("c", "C");
    expect(bridge.take("a")).toBeNull();
    now = 11;
    expect(bridge.take("b")).toBeNull();
  });
});
