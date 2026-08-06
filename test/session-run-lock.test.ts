import { describe, expect, it } from "bun:test";
import { acquireRunLock, createSessionRunLock, releaseRunLock } from "../src/app/session-run-lock.ts";

describe("SessionRunLock", () => {
  it("serializes one session without blocking another", () => {
    const lock = createSessionRunLock();
    expect(lock.acquire("a")).toBe(true);
    expect(lock.acquire("a")).toBe(false);
    expect(lock.acquire("b")).toBe(true);
    expect(lock.size()).toBe(2);
    expect(lock.acquire("c")).toBe(false);
    lock.release("a");
    expect(lock.acquire("a")).toBe(true);
  });

  it("keeps the legacy Cell seam working for isolated tests", () => {
    const cell = { value: false };
    expect(acquireRunLock(cell, "a")).toBe(true);
    expect(acquireRunLock(cell, "b")).toBe(false);
    releaseRunLock(cell, "a");
    expect(cell.value).toBe(false);
  });
});
