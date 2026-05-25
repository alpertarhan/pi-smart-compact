/**
 * Asynchronous deferred backup pruning.
 *
 * Two contracts to verify:
 *
 *   1. Hot path: `backupConversation` returns synchronously and does NOT
 *      block on directory scan / unlink. The previous implementation could
 *      stall for 20-50ms when the backup directory held >100 files.
 *
 *   2. Eventual: after enough microtask ticks the prune happens and files
 *      over the count cap (or age cap) are removed.
 *
 * The tests use a per-test HOME swap so they don't touch the user's real
 * backups directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { backupConversation, resetConfigCache } from "../src/utils/helpers.ts";
import { BACKUP_MAX_FILES } from "../src/constants.ts";

let prevHome: string | undefined;
let tmp: string;
let backupDir: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "psc-bk-"));
  process.env.HOME = tmp;
  resetConfigCache();
  backupDir = path.join(tmp, ".pi/agent/compact-backups");
});

afterEach(() => {
  process.env.HOME = prevHome;
  resetConfigCache();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function flushMicrotasks(): Promise<void> {
  // Two microtask hops cover the queued prune + its inner readdir loop.
  return new Promise(resolve => queueMicrotask(() => queueMicrotask(() => resolve())));
}

describe("backupConversation hot path", () => {
  it("returns synchronously even when the directory is full", () => {
    // Pre-fill the directory with 100 stale backup files. The original
    // implementation would unlink all of them on the synchronous call path.
    fs.mkdirSync(backupDir, { recursive: true });
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(backupDir, "stale-" + i + ".md"), "x");
    }
    const t0 = Date.now();
    const fp = backupConversation("hello", "sess-test");
    const elapsed = Date.now() - t0;
    expect(fp).not.toBeNull();
    // The synchronous portion does one atomic write; anything past ~50ms
    // means we ran the prune inline. Generous bound to avoid CI flake.
    expect(elapsed).toBeLessThan(100);
  });
});

describe("deferred prune", () => {
  it("trims files past the count cap after microtasks flush", async () => {
    fs.mkdirSync(backupDir, { recursive: true });
    // Pre-populate with BACKUP_MAX_FILES + 5 backups so the trim has work to do.
    const total = BACKUP_MAX_FILES + 5;
    const now = Date.now();
    for (let i = 0; i < total; i++) {
      const fp = path.join(backupDir, "f-" + i + ".md");
      fs.writeFileSync(fp, "x");
      // Stagger mtimes so the prune has a deterministic newest→oldest order.
      const t = (now - (total - i) * 1000) / 1000;
      fs.utimesSync(fp, t, t);
    }
    // Trigger a real backup → schedules a prune microtask.
    backupConversation("trigger prune", "trigger");
    await flushMicrotasks();
    // After the microtask runs we should be at the cap (or close to it).
    const remaining = fs.readdirSync(backupDir).filter(n => n.endsWith(".md")).length;
    expect(remaining).toBeLessThanOrEqual(BACKUP_MAX_FILES + 1); // +1 for the trigger backup
  });
});
