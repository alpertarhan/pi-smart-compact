/**
 * Coverage for the cache-sizing knob exposed by `session-log.ts`.
 *
 * Production callers never see this helper — it exists so the `SMART_COMPACT_LOG_CACHE_MAX`
 * environment override can be exercised deterministically. The behaviour
 * we lock in:
 *
 *   - Empty/missing env → default (8)
 *   - Valid positive integer → that integer
 *   - Negative / zero / non-numeric → silently fall back to default
 *     (so a typo in `.env` can never disable the LRU and trigger an
 *     unbounded-cache regression)
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _getMaxEntriesForTests } from "../src/utils/session-log.ts";

const ENV_KEY = "SMART_COMPACT_LOG_CACHE_MAX";
const DEFAULT = 8;

let original: string | undefined;

beforeEach(() => { original = process.env[ENV_KEY]; });
afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

describe("getMaxEntries — defaults", () => {
  it("returns the default when the env var is unset", () => {
    delete process.env[ENV_KEY];
    expect(_getMaxEntriesForTests()).toBe(DEFAULT);
  });

  it("returns the default when the env var is empty", () => {
    process.env[ENV_KEY] = "";
    expect(_getMaxEntriesForTests()).toBe(DEFAULT);
  });
});

describe("getMaxEntries — valid overrides", () => {
  it("accepts a small positive integer", () => {
    process.env[ENV_KEY] = "1";
    expect(_getMaxEntriesForTests()).toBe(1);
  });

  it("accepts a large positive integer", () => {
    process.env[ENV_KEY] = "1024";
    expect(_getMaxEntriesForTests()).toBe(1024);
  });

  it("parses leading-digit strings (parseInt semantics)", () => {
    process.env[ENV_KEY] = "32abc";
    expect(_getMaxEntriesForTests()).toBe(32);
  });
});

describe("getMaxEntries — defensive fallbacks", () => {
  it("falls back to default on zero", () => {
    process.env[ENV_KEY] = "0";
    expect(_getMaxEntriesForTests()).toBe(DEFAULT);
  });

  it("falls back to default on negative values", () => {
    process.env[ENV_KEY] = "-5";
    expect(_getMaxEntriesForTests()).toBe(DEFAULT);
  });

  it("falls back to default on pure non-numeric input", () => {
    process.env[ENV_KEY] = "huge";
    expect(_getMaxEntriesForTests()).toBe(DEFAULT);
  });

  it("re-reads the env on every call (no module-load memoization)", () => {
    process.env[ENV_KEY] = "3";
    expect(_getMaxEntriesForTests()).toBe(3);
    process.env[ENV_KEY] = "7";
    expect(_getMaxEntriesForTests()).toBe(7);
    delete process.env[ENV_KEY];
    expect(_getMaxEntriesForTests()).toBe(DEFAULT);
  });
});
