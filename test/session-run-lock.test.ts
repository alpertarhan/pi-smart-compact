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

  it("keeps a live owner's lease through a long suspend, but not past a day", () => withLeaseDir(dir => {
    const owner = createSessionRunLock(2, { leaseDir: dir });
    const other = createSessionRunLock(2, { leaseDir: dir });
    expect(owner.acquire("a")).toBe(true);
    const lease = path.join(dir, fs.readdirSync(dir).find(name => name.startsWith("session-"))!);
    const ageLease = (hours: number) => {
      const at = Date.now() - hours * 60 * 60_000;
      fs.writeFileSync(lease, JSON.stringify({ ...JSON.parse(fs.readFileSync(lease, "utf8")), createdAt: at }));
      fs.utimesSync(lease, at / 1000, at / 1000);
    };
    ageLease(8); // a night asleep: the owner (this process) still answers to its PID
    expect(other.acquire("a")).toBe(false);
    ageLease(25); // past a day the PID more likely belongs to a process that reused it
    expect(other.acquire("a")).toBe(true);
    owner.value = false;
    other.value = false;
  }));

  it("reclaims at once a lease whose PID now belongs to another process", () => withLeaseDir(dir => {
    if (!fs.existsSync("/proc/self/stat")) return; // start times come from Linux /proc
    const owner = createSessionRunLock(2, { leaseDir: dir });
    const other = createSessionRunLock(2, { leaseDir: dir });
    expect(owner.acquire("a")).toBe(true);
    const lease = path.join(dir, fs.readdirSync(dir).find(name => name.startsWith("session-"))!);
    const at = Date.now() - 8 * 60 * 60_000;
    // Same PID (alive), another start time: a reboot or wrap handed the PID to a new process.
    fs.writeFileSync(lease, JSON.stringify({ ...JSON.parse(fs.readFileSync(lease, "utf8")), createdAt: at, start: "1" }));
    fs.utimesSync(lease, at / 1000, at / 1000);
    expect(other.acquire("a")).toBe(true);
    owner.value = false;
    other.value = false;
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
