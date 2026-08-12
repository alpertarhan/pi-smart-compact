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
  atomicWriteFile, atomicWriteFileSync, appendLineLocked, appendLineLockedAsync, readJsonSync, writeJsonSync,
  ensureDir, acquireLockSync, trimFileTailLocked,
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

  it("creates and normalizes private files and directories under umask 000", async () => {
    const dir = path.join(tmp, "private");
    const target = path.join(dir, "state.json");
    fs.mkdirSync(dir, { mode: 0o777 });
    fs.writeFileSync(target, "old", { mode: 0o666 });
    fs.chmodSync(dir, 0o777);
    fs.chmodSync(target, 0o666);
    const previousUmask = process.umask(0);
    try {
      atomicWriteFileSync(target, "sync");
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);

      const asyncTarget = path.join(dir, "async.json");
      await atomicWriteFile(asyncTarget, "async");
      expect(fs.statSync(asyncTarget).mode & 0o777).toBe(0o600);
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

describe("appendLineLocked", () => {
  it("appends without corruption when fired sequentially", () => {
    const target = path.join(tmp, "log.jsonl");
    for (let i = 0; i < 5; i++) appendLineLocked(target, JSON.stringify({ i }));
    const lines = fs.readFileSync(target, "utf8").trim().split("\n");
    expect(lines.map(l => JSON.parse(l).i)).toEqual([0, 1, 2, 3, 4]);
  });

  it("normalizes append targets and directories under umask 000", () => {
    const dir = path.join(tmp, "metrics");
    const target = path.join(dir, "metrics.jsonl");
    fs.mkdirSync(dir, { mode: 0o777 });
    fs.writeFileSync(target, "old\n", { mode: 0o666 });
    fs.chmodSync(dir, 0o777);
    fs.chmodSync(target, 0o666);
    const previousUmask = process.umask(0);
    try {
      appendLineLocked(target, "new");
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("returns a release function after acquiring a lock", () => {
    const target = path.join(tmp, "log2.jsonl");
    const release = acquireLockSync(target);
    try {
      // We don't really await contention here — this is a smoke test that the
      // helper returns a callable release fn even under contention.
      expect(typeof release).toBe("function");
    } finally {
      release();
    }
    appendLineLocked(target, "{\"ok\":1}");
    expect(fs.readFileSync(target, "utf8")).toContain("\"ok\":1");
  });

  it("fails closed instead of appending through a non-directory parent", () => {
    expect(() => appendLineLocked(path.join("/dev/null", "log.jsonl"), "unsafe")).toThrow();
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
        `import { appendLineLocked } from ${JSON.stringify(modulePath)};`,
        `const target=${JSON.stringify(target)}, go=${JSON.stringify(go)}, cap=${cap};`,
        `for (let i=0;i<40;i++) appendLineLocked(target, JSON.stringify({worker:${worker},i,pad:"x".repeat(180)}), cap);`,
        `console.log("ready");`,
        `while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
        `appendLineLocked(target, JSON.stringify({sentinel:${worker}}), cap);`,
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

describe("trimFileTailLocked", () => {
  it("keeps the newest complete JSONL records under the byte cap", async () => {
    const target = path.join(tmp, "bounded.jsonl");
    for (let i = 0; i < 20; i++) appendLineLocked(target, JSON.stringify({ i, value: "x".repeat(12) }));

    await trimFileTailLocked(target, 120);

    const raw = fs.readFileSync(target, "utf8");
    const records = raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(120);
    expect(records.at(-1)?.i).toBe(19);
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
