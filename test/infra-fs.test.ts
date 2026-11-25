/**
 * Atomic FS primitives.
 *
 * Goal: lock down the contract that other modules rely on — atomic temp-then-
 * rename writes never leave half-baked files, and the advisory lock prevents
 * the metrics append log from being interleaved when two pi sessions race.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  atomicWriteFile, atomicWriteFileSync, appendLineLockedAsync, readJsonSync, writeJsonSync,
  ensureDir, acquireLockSync, reclaimStaleLock,
} from "../src/infra/fs.ts";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "psc-infra-fs-"));
});

describe("atomicWriteFileSync", () => {
  it("writes the file and leaves no .tmp.* sibling on success", () => {
    const target = path.join(tmp, "ok.json");
    atomicWriteFileSync(target, "hello");
    expect(fs.readFileSync(target, "utf8")).toBe("hello");
    const orphans = fs.readdirSync(tmp).filter(name => name.includes(".tmp."));
    expect(orphans).toEqual([]);
  });

  it("creates private files under umask 000 without re-permissioning existing directories", async () => {
    const dir = path.join(tmp, "private");
    const target = path.join(dir, "state.json");
    fs.mkdirSync(dir, { mode: 0o777 });
    fs.writeFileSync(target, "old", { mode: 0o666 });
    fs.chmodSync(dir, 0o777);
    fs.chmodSync(target, 0o666);
    const previousUmask = process.umask(0);
    try {
      atomicWriteFileSync(target, "sync");
      // The directory pre-existed (user-owned); only files we create are forced private.
      expect(fs.statSync(dir).mode & 0o777).toBe(0o777);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);

      const created = path.join(tmp, "fresh", "async.json");
      await atomicWriteFile(created, "async");
      expect(fs.statSync(created).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(created)).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("preserves the previous file when the writer never gets to rename", () => {
    const target = path.join(tmp, "preserved.txt");
    fs.writeFileSync(target, "original");
    // Simulate a failure by passing an unwritable directory after temp creation.
    try {
      atomicWriteFileSync(path.join(tmp, "deep", "nested", "no-perms", "/dev/null/cannot-write"), "x");
    } catch { /* expected */ }
    expect(fs.readFileSync(target, "utf8")).toBe("original");
  });
});

describe("appendLineLockedAsync", () => {
  it("appends without corruption when fired sequentially", async () => {
    const target = path.join(tmp, "log.jsonl");
    for (let i = 0; i < 5; i++) await appendLineLockedAsync(target, JSON.stringify({ i }));
    const lines = fs.readFileSync(target, "utf8").trim().split("\n");
    expect(lines.map(l => JSON.parse(l).i)).toEqual([0, 1, 2, 3, 4]);
  });


  it("returns a release function after acquiring a lock", async () => {
    const target = path.join(tmp, "log2.jsonl");
    const release = acquireLockSync(target);
    try {
      // We don't really await contention here — this is a smoke test that the
      // helper returns a callable release fn even under contention.
      expect(typeof release).toBe("function");
    } finally {
      release();
    }
    await appendLineLockedAsync(target, "{\"ok\":1}");
    expect(fs.readFileSync(target, "utf8")).toContain("\"ok\":1");
  });

  it("never steals a live lock based only on elapsed time", () => {
    const target = path.join(tmp, "aged-lock.jsonl");
    const release = acquireLockSync(target);
    const lockDir = target + ".lock";
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, old, old);
    try {
      expect(() => acquireLockSync(target)).toThrow("Lock busy");
    } finally {
      release();
    }
  });

  it("does not let an old release callback remove a successor's lock", () => {
    const target = path.join(tmp, "owned-lock.jsonl");
    const releaseFirst = acquireLockSync(target);
    releaseFirst();
    const releaseSecond = acquireLockSync(target);
    try {
      releaseFirst();
      expect(() => acquireLockSync(target)).toThrow("Lock busy");
    } finally {
      releaseSecond();
    }
  });

  it("cleans a partial owner file when lock initialization fails", () => {
    const target = path.join(tmp, "partial-owner.jsonl");
    const originalWrite = fs.writeFileSync;
    const mutableFs = fs as { writeFileSync: typeof fs.writeFileSync };
    mutableFs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file).endsWith(path.join(".lock", "owner"))) {
        originalWrite(file, "partial");
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return Reflect.apply(originalWrite, fs, [file, ...args]);
    }) as typeof fs.writeFileSync;
    try {
      expect(() => acquireLockSync(target)).toThrow("Failed to acquire lock");
      expect(fs.existsSync(target + ".lock")).toBe(false);
    } finally {
      mutableFs.writeFileSync = originalWrite;
    }
  });

  it("fails closed instead of appending through a non-directory parent", async () => {
    expect(appendLineLockedAsync(path.join("/dev/null", "log.jsonl"), "unsafe")).rejects.toThrow();
  });

  it("reclaims a lock left by a dead owner instead of blocking forever", async () => {
    const target = path.join(tmp, "stale.jsonl");
    fs.mkdirSync(target + ".lock");
    fs.writeFileSync(path.join(target + ".lock", "owner"), "999999:deadbeef");
    await appendLineLockedAsync(target, "{\"ok\":1}");
    expect(fs.readFileSync(target, "utf8")).toContain("\"ok\":1");
    expect(fs.existsSync(target + ".lock")).toBe(false);
  });

  it("does not reclaim a fresh lock with a live owner", () => {
    const lockDir = path.join(tmp, "live.jsonl.lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "owner"), process.pid + ":token");
    expect(reclaimStaleLock(lockDir)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(true);
  });
  it("serializes concurrent asynchronous appends into complete JSONL records", async () => {
    const target = path.join(tmp, "async-log.jsonl");
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      appendLineLockedAsync(target, JSON.stringify({ index }))));
    const records = fs.readFileSync(target, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records.map(record => record.index).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

});

  it("keeps post-trim records from concurrent processes", async () => {
    const target = path.join(tmp, "racing.jsonl");
    const go = path.join(tmp, "go");
    const cap = 8 * 1024;
    const modulePath = path.resolve(import.meta.dir, "../src/infra/fs.ts");
    const workers = Array.from({ length: 8 }, (_, worker) => {
      const script = [
        `import fs from "node:fs";`,
        `import { appendLineLockedAsync } from ${JSON.stringify(modulePath)};`,
        `const target=${JSON.stringify(target)}, go=${JSON.stringify(go)}, cap=${cap};`,
        `for (let i=0;i<40;i++) await appendLineLockedAsync(target, JSON.stringify({worker:${worker},i,pad:"x".repeat(180)}), cap);`,
        `console.log("ready");`,
        `while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
        `await appendLineLockedAsync(target, JSON.stringify({sentinel:${worker}}), cap);`,
      ].join("\n");
      return Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    });

    await Promise.all(workers.map(async worker => {
      const firstChunk = await worker.stdout.getReader().read();
      expect(new TextDecoder().decode(firstChunk.value)).toContain("ready");
    }));
    fs.writeFileSync(go, "go");
    const statuses = await Promise.all(workers.map(worker => worker.exited));
    expect(statuses).toEqual(new Array(workers.length).fill(0));

    const raw = fs.readFileSync(target, "utf8");
    const records = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(cap);
    expect(records.filter(record => "sentinel" in record).map(record => record.sentinel).sort())
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

describe("appendLineLockedAsync retention", () => {
  it("keeps the newest complete records under the byte cap and trims to half", async () => {
    const target = path.join(tmp, "bounded.jsonl");
    const cap = 1024;
    for (let i = 0; i < 60; i++) {
      await appendLineLockedAsync(target, JSON.stringify({ i, value: "x".repeat(40) }), cap);
    }
    const raw = fs.readFileSync(target, "utf8");
    const records = raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(cap);
    expect(records.at(-1)?.i).toBe(59);
    expect(records[0]?.i).toBeGreaterThan(0);
  });
});

describe("readJsonSync / writeJsonSync", () => {
  it("round-trips JSON via atomic write", () => {
    const target = path.join(tmp, "x.json");
    writeJsonSync(target, { a: 1, b: [2, 3] });
    expect(readJsonSync<{ a: number; b: number[] }>(target)).toEqual({ a: 1, b: [2, 3] });
  });

  it("returns null when the file is missing", () => {
    expect(readJsonSync(path.join(tmp, "nope.json"))).toBeNull();
  });

  it("returns null and logs (does not throw) when JSON is corrupt", () => {
    const target = path.join(tmp, "bad.json");
    fs.writeFileSync(target, "{not-json}");
    expect(readJsonSync(target)).toBeNull();
  });
});

describe("ensureDir", () => {
  it("creates nested directories idempotently", () => {
    const target = path.join(tmp, "a", "b", "c");
    ensureDir(target);
    ensureDir(target);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });
});
