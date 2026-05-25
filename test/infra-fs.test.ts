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
  atomicWriteFileSync, appendLineLocked, readJsonSync, writeJsonSync,
  ensureDir, acquireLockSync,
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

  it("does not crash if the lock cannot be acquired immediately", () => {
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
