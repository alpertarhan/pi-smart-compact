import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireRunLock, createSessionRunLock, releaseRunLock } from "../src/app/session-run-lock.ts";

function withLeaseDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psc-run-lock-"));
  try { run(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe("SessionRunLock", () => {
  it("serializes one session and enforces capacity across lock instances", () => withLeaseDir(dir => {
    const first = createSessionRunLock(2, { leaseDir: dir });
    const second = createSessionRunLock(2, { leaseDir: dir });
    expect(first.acquire("a")).toBe(true);
    expect(second.acquire("a")).toBe(false);
    expect(second.acquire("b")).toBe(true);
    expect(first.size() + second.size()).toBe(2);
    expect(first.acquire("c")).toBe(false);
    first.release("a");
    expect(first.acquire("c")).toBe(true);
    first.value = false;
    second.value = false;
    expect(fs.readdirSync(dir)).toEqual([]);
  }));

  it("fails closed when the lease directory cannot be created", () => {
    const lock = createSessionRunLock(2, { leaseDir: "/dev/null/not-a-directory" });
    expect(lock.acquire("a")).toBe(false);
    expect(lock.size()).toBe(0);
  });

  it("keeps the legacy Cell seam working for isolated tests", () => {
    const cell = { value: false };
    expect(acquireRunLock(cell, "a")).toBe(true);
    expect(acquireRunLock(cell, "b")).toBe(false);
    releaseRunLock(cell, "a");
    expect(cell.value).toBe(false);
  });
});
