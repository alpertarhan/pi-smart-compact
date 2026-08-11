/**
 * Streaming session log parser.
 *
 * Reads JSONL incrementally with bounded memory, yields between filesystem
 * chunks, preserves UTF-8 boundaries, and scans beyond the old 50 MiB cap so
 * active branch IDs near the end of a large log remain recoverable.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveCompactionMessages, hasTruncatedMessages } from "../src/utils/session-log.ts";
import type { SessionMessageEntry } from "../src/types.ts";

let prevHome: string | undefined;
let tmp: string;

function makeSessionsDir(sessionId: string): string {
  const dir = path.join(tmp, ".pi", "agent", "sessions", "cwd-hash");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "2026-01-01T00-00-00_" + sessionId + ".jsonl");
}

function writeLog(sessionId: string, entries: Array<{ id: string; role: string; content: unknown }>): void {
  const fp = makeSessionsDir(sessionId);
  const lines = entries.map(e => JSON.stringify({
    type: "message",
    id: e.id,
    message: { role: e.role, content: e.content },
  })).join("\n");
  fs.writeFileSync(fp, lines + "\n");
}

beforeEach(() => {
  prevHome = process.env.HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "psc-sl-"));
  process.env.HOME = tmp;
});

afterEach(() => {
  process.env.HOME = prevHome;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function entryWith(id: string, content: string): SessionMessageEntry {
  return { id, type: "message", message: { role: "user", content } } as SessionMessageEntry;
}

describe("resolveCompactionMessages with streaming parser", () => {
  it("recovers messages from a small log", async () => { writeLog("sess-1", [
    { id: "e-0", role: "user", content: "hello" },
    { id: "e-1", role: "assistant", content: "world" },
  ]);
  const recovered = await resolveCompactionMessages("sess-1", [
    entryWith("e-0", "hello"),
    entryWith("e-1", "world"),
  ])
  expect(recovered).not.toBeNull();
  expect(recovered!).toHaveLength(2);
  expect(recovered![0].message.content).toBe("hello"); });

  it("handles a log that spans many 64KB chunks without losing lines", async () => { // Construct ~200 entries, each ~2KB → ~400KB total → many chunk crossings.
  const entries: Array<{ id: string; role: string; content: unknown }> = [];
  for (let i = 0; i < 200; i++) {
    entries.push({ id: "msg-" + i, role: "user", content: "x".repeat(2000) + " #" + i });
  }
  writeLog("sess-large", entries);
  const branchEntries: SessionMessageEntry[] = entries.map(e =>
    entryWith(e.id, String(e.content)),
  );
  const recovered = await resolveCompactionMessages("sess-large", branchEntries)
  expect(recovered).not.toBeNull();
  expect(recovered!).toHaveLength(200);
  // Spot-check a chunk-crossing entry to make sure no line got dropped.
  expect((recovered![100].message.content as string)).toContain("#100");
  expect((recovered![199].message.content as string)).toContain("#199"); });

  it("recovers branch IDs written after the former 50 MiB boundary", async () => {
    const file = makeSessionsDir("sess-over-cap");
    const padding = JSON.stringify({
      type: "message",
      id: "padding",
      message: { role: "user", content: "x".repeat(65_400) },
    }) + "\n";
    const fd = fs.openSync(file, "w");
    try {
      for (let index = 0; index < 810; index++) fs.writeSync(fd, padding);
      fs.writeSync(fd, JSON.stringify({
        type: "message",
        id: "target-after-cap",
        message: { role: "assistant", content: "original tail evidence" },
      }) + "\n");
    } finally {
      fs.closeSync(fd);
    }
    const recovered = await resolveCompactionMessages(
      "sess-over-cap",
      [entryWith("target-after-cap", "truncated…✂999")],
    );
    expect(recovered?.[0].message.content).toBe("original tail evidence");
  });

  it("returns null when the log is missing (callers fall back to branch)", async () => { const recovered = await resolveCompactionMessages("never-existed", [entryWith("e-0", "x")])
  expect(recovered).toBeNull(); });

  it("falls back to branch content for messages still flagged truncated in the log", async () => { writeLog("sess-trunc", [
    { id: "e-0", role: "user", content: "untruncated" },
    // TRUNCATE_RE anchors `…✂N` at end-of-string. Put the marker last.
    { id: "e-1", role: "assistant", content: "head ... tail …✂5000" },
  ]);
  const recovered = await resolveCompactionMessages("sess-trunc", [
    entryWith("e-0", "untruncated"),
    entryWith("e-1", "branch fallback"),
  ])
  expect(recovered).not.toBeNull();
  // e-1 in the log is still truncated → fall back to branch entry.
  expect(recovered![1].message.content).toBe("branch fallback"); });
});

describe("hasTruncatedMessages", () => {
  it("detects the …✂N marker", async () => { expect(hasTruncatedMessages([{ role: "user", content: "ok" } as any])).toBe(false);
  expect(hasTruncatedMessages([{ role: "user", content: "head…✂100" } as any])).toBe(true); });
});
