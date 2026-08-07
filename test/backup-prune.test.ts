/**
 * Asynchronous deferred backup pruning.
 *
 * Two contracts to verify:
 *
 *   1. Hot path: `backupConversation` returns synchronously and does NOT
 *      block on directory scan / unlink. The previous implementation could
 *      stall for 20-50ms when the backup directory held >100 files.
 *
 *   2. Eventual: after the deferred macrotask runs the prune happens and
 *      files over the count cap (or age cap) are removed.
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

function flushDeferred(): Promise<void> {
  // The prune is scheduled with setTimeout(0) (a macrotask — microtasks
  // would still block the triggering turn); one longer timeout hop
  // deterministically runs after it.
  return new Promise(resolve => setTimeout(resolve, 10));
}

describe("backupConversation hot path", () => {
  it("returns synchronously even when the directory is full", () => {
    // Pre-fill the directory with 100 stale backup files. The original
    // implementation would unlink all of them on the synchronous call path.
    fs.mkdirSync(backupDir, { recursive: true });
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(backupDir, "stale-" + i + ".md"), "# Smart Compact Backup\n# Session: old\n\nx");
    }
    const t0 = Date.now();
    const fp = backupConversation("hello", "sess-test");
    const elapsed = Date.now() - t0;
    expect(fp).not.toBeNull();
    // The synchronous portion does one atomic write; anything past ~50ms
    // means we ran the prune inline. Generous bound to avoid CI flake.
    expect(elapsed).toBeLessThan(100);
  });

  it("keeps untrusted session ids inside the backup directory", () => {
    const fp = backupConversation("hello", "../../outside/session");
    expect(path.dirname(fp!)).toBe(backupDir);
    expect(path.basename(fp!)).not.toContain("..");
  });
});

describe("deferred prune", () => {
  it("trims owned backups without deleting unrelated markdown", async () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const unrelated = path.join(backupDir, "user-notes.md");
    fs.writeFileSync(unrelated, "do not delete");
    // Pre-populate with BACKUP_MAX_FILES + 5 backups so the trim has work to do.
    const total = BACKUP_MAX_FILES + 5;
    const now = Date.now();
    for (let i = 0; i < total; i++) {
      const fp = path.join(backupDir, "f-" + i + ".md");
      fs.writeFileSync(fp, "# Smart Compact Backup\n# Session: old\n\nx");
      // Stagger mtimes so the prune has a deterministic newest→oldest order.
      const t = (now - (total - i) * 1000) / 1000;
      fs.utimesSync(fp, t, t);
    }
    // Trigger a real backup → schedules the deferred prune.
    backupConversation("trigger prune", "trigger");
    await flushDeferred();
    // After the deferred prune runs we should be at the cap (or close to it).
    const remainingOwned = fs.readdirSync(backupDir)
      .filter(name => fs.readFileSync(path.join(backupDir, name), "utf8").startsWith("# Smart Compact Backup\n")).length;
    expect(remainingOwned).toBeLessThanOrEqual(BACKUP_MAX_FILES);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("do not delete");
  });
});
