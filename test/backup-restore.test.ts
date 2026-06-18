import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listBackups, readBackupContent, resetConfigCache, buildRestoreMessage } from "../src/utils/helpers.ts";

let prevHome: string | undefined;
let tmp: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-restore-"));
  process.env.HOME = tmp;
  resetConfigCache();
});
afterEach(() => {
  process.env.HOME = prevHome;
  resetConfigCache();
});

function writeBackup(name: string, date: string, session: string, body: string): string {
  const dir = path.join(tmp, ".pi", "agent", "compact-backups");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, "# Smart Compact Backup\n# Date: " + date + "\n# Session: " + session + "\n\n" + body);
  return fp;
}

describe("listBackups", () => {
  it("returns [] when the backup dir does not exist", () => {
    expect(listBackups()).toEqual([]);
  });

  it("lists backups newest-first with parsed metadata", () => {
    writeBackup("s1-old.md", "2026-06-01T00:00:00.000Z", "s1", "old content");
    writeBackup("s1-new.md", "2026-06-02T00:00:00.000Z", "s1", "new content");
    const list = listBackups();
    expect(list.length).toBe(2);
    expect(list[0].date).toBe("2026-06-02T00:00:00.000Z");
    expect(list[1].date).toBe("2026-06-01T00:00:00.000Z");
    expect(list[0].sessionId).toBe("s1");
    expect(list[0].sizeBytes).toBeGreaterThan(0);
    expect(list[0].path).toContain("s1-new.md");
  });

  it("ignores non-markdown files", () => {
    writeBackup("s1-x.md", "2026-06-01T00:00:00.000Z", "s1", "x");
    fs.writeFileSync(path.join(tmp, ".pi", "agent", "compact-backups", "notes.txt"), "junk");
    expect(listBackups().length).toBe(1);
  });

  it("falls back to filename when the header lacks a session", () => {
    const dir = path.join(tmp, ".pi", "agent", "compact-backups");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "orphan.md"), "# Smart Compact Backup\nno proper header here\n\nbody");
    const list = listBackups();
    expect(list.length).toBe(1);
    expect(list[0].sessionId).toBe("orphan.md");
  });
});

describe("readBackupContent", () => {
  it("strips the backup header and returns the conversation body", () => {
    const fp = writeBackup("s1.md", "2026-06-01T00:00:00.000Z", "s1", "## Goal\nDo the thing.\n\nMore body.");
    expect(readBackupContent(fp)).toBe("## Goal\nDo the thing.\n\nMore body.");
  });

  it("returns null for a missing file", () => {
    expect(readBackupContent(path.join(tmp, "nope.md"))).toBeNull();
  });

  it("returns null for an empty body", () => {
    const fp = writeBackup("empty.md", "2026-06-01T00:00:00.000Z", "s1", "");
    expect(readBackupContent(fp)).toBeNull();
  });
});

describe("buildRestoreMessage", () => {
  it("wraps content with a restore header and tags the source", () => {
    const m = buildRestoreMessage("## Goal\nDo thing.", "/path/bk.md");
    expect(m.customType).toBe("smart-compact-restore");
    expect(m.display).toBe(true);
    expect(m.content).toContain("Restored pre-compaction context");
    expect(m.content).toContain("## Goal\nDo thing.");
    expect(m.details.source).toBe("/path/bk.md");
    expect(typeof m.details.restoredAt).toBe("number");
  });

  it("preserves the original content verbatim (no truncation)", () => {
    const body = "line1\nline2\nline3";
    expect(buildRestoreMessage(body, "x").content).toContain(body);
  });
});
