import { describe, it, expect } from "bun:test";
import { validateSmartCompactConfig } from "../src/utils/helpers.ts";

describe("validateSmartCompactConfig", () => {
  it("deletes invalid profile", () => {
    const sc = { profile: "super" };
    validateSmartCompactConfig(sc);
    expect("profile" in sc).toBe(false);
  });

  it("keeps valid profile", () => {
    const sc = { profile: "light" };
    validateSmartCompactConfig(sc);
    expect(sc.profile).toBe("light");
  });

  it("deletes invalid autoTrigger (string)", () => {
    const sc = { autoTrigger: "true" };
    validateSmartCompactConfig(sc);
    expect("autoTrigger" in sc).toBe(false);
  });

  it("deletes invalid autoTriggerTimeoutMs (string)", () => {
    const sc = { autoTriggerTimeoutMs: "45000" };
    validateSmartCompactConfig(sc);
    expect("autoTriggerTimeoutMs" in sc).toBe(false);
  });

  it("deletes invalid autoTriggerTimeoutMs (negative)", () => {
    const sc = { autoTriggerTimeoutMs: -1000 };
    validateSmartCompactConfig(sc);
    expect("autoTriggerTimeoutMs" in sc).toBe(false);
  });

  it("deletes invalid autoTriggerTimeoutMs (too large)", () => {
    const sc = { autoTriggerTimeoutMs: 600000 };
    validateSmartCompactConfig(sc);
    expect("autoTriggerTimeoutMs" in sc).toBe(false);
  });

  it("deletes invalid autoTriggerTimeoutMs (too small)", () => {
    const sc = { autoTriggerTimeoutMs: 500 };
    validateSmartCompactConfig(sc);
    expect("autoTriggerTimeoutMs" in sc).toBe(false);
  });

  it("keeps valid autoTriggerTimeoutMs", () => {
    const sc = { autoTriggerTimeoutMs: 45000 };
    validateSmartCompactConfig(sc);
    expect(sc.autoTriggerTimeoutMs).toBe(45000);
  });

  it("keeps boundary values (1000 and 300000)", () => {
    const sc1 = { autoTriggerTimeoutMs: 1000 };
    validateSmartCompactConfig(sc1);
    expect(sc1.autoTriggerTimeoutMs).toBe(1000);

    const sc2 = { autoTriggerTimeoutMs: 300000 };
    validateSmartCompactConfig(sc2);
    expect(sc2.autoTriggerTimeoutMs).toBe(300000);
  });
});
