/**
 * Asynchronous deferred backup pruning.
 *
 * Two contracts to verify:
 *
 *   1. Prepare path: `prepareConversationBackup` performs no I/O, so cancelled
 *      or failed compactions cannot create retention artifacts.
 *
 *   2. Commit path: the confirmed lifecycle writes atomically, then deferred
 *      pruning removes files over the count or age cap.
 *
 * The tests use a per-test HOME swap so they don't touch the user's real
 * backups directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { commitPreparedConversationBackup, prepareConversationBackup } from "../src/utils/backups.ts";
import { resetConfigCache } from "../src/utils/helpers.ts";
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

describe("conversation backup lifecycle", () => {
  it("prepares synchronously without writing, then commits asynchronously", async () => {
    fs.mkdirSync(backupDir, { recursive: true });
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(backupDir, "stale-" + i + ".md"), "# Smart Compact Backup\n# Session: old\n\nx");
    }
    const t0 = Date.now();
    const prepared = prepareConversationBackup("hello", "sess-test");
    const elapsed = Date.now() - t0;
    expect(prepared).not.toBeNull();
    expect(elapsed).toBeLessThan(100);
    expect(fs.existsSync(prepared!.path)).toBe(false);
    expect(await commitPreparedConversationBackup(prepared!)).toBe(prepared!.path);
    expect(fs.existsSync(prepared!.path)).toBe(true);
  });

  it("keeps untrusted session ids inside the backup directory", () => {
    const prepared = prepareConversationBackup("hello", "../../outside/session");
    expect(path.dirname(prepared!.path)).toBe(backupDir);
    expect(path.basename(prepared!.path)).not.toContain("..");
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
    const prepared = prepareConversationBackup("trigger prune", "trigger");
    expect(prepared).not.toBeNull();
    await commitPreparedConversationBackup(prepared!);
    await flushDeferred();
    // After the deferred prune runs we should be at the cap (or close to it).
    const remainingOwned = fs.readdirSync(backupDir)
      .filter(name => fs.readFileSync(path.join(backupDir, name), "utf8").startsWith("# Smart Compact Backup\n")).length;
    expect(remainingOwned).toBeLessThanOrEqual(BACKUP_MAX_FILES);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("do not delete");
  });
});
