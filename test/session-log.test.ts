/**
 * Session log reader tests — Pi jsonl filename format and entry-id recovery.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveCompactionMessages } from "../src/utils/session-log.ts";
import type { SessionMessageEntry } from "../src/types.ts";

describe("resolveCompactionMessages — Pi jsonl filename format", () => {
  const ORIGINAL_HOME = process.env.HOME;
  const TMP_HOME = fs.mkdtempSync(path.join("/tmp", "pi-smart-compact-test-"));

  beforeAll(() => {
    process.env.HOME = TMP_HOME;
    // Create Pi session directory structure with timestamp_sessionId.jsonl
    const sessionsDir = path.join(TMP_HOME, ".pi", "agent", "sessions", "hash123");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const logLines = [
      JSON.stringify({ id: "entry-0", type: "message", message: { role: "user", content: "hello" } }),
      JSON.stringify({ id: "entry-1", type: "message", message: { role: "assistant", content: "hi" } }),
      JSON.stringify({ id: "entry-2", type: "message", message: { role: "toolResult", toolCallId: "tc1", content: "large original content here" } }),
    ].join("\n");
    fs.writeFileSync(path.join(sessionsDir, "2026-05-19T12-00-00_test-session-abc.jsonl"), logLines);
  });

  afterAll(() => {
    process.env.HOME = ORIGINAL_HOME;
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  });

  it("finds timestamp_sessionId.jsonl format and recovers by entry id", async () => { const entries: SessionMessageEntry[] = [
    { type: "message", id: "entry-0", message: { role: "user", content: "hello" } },
    { type: "message", id: "entry-1", message: { role: "assistant", content: "hi" } },
    {
      type: "message",
      id: "entry-2",
      message: { role: "toolResult", toolCallId: "tc1", content: "truncated…✂999" },
    },
  ];
  const result = await resolveCompactionMessages("test-session-abc", entries)
  expect(result).not.toBeNull();
  expect(result!.length).toBe(3);
  // entry-2 should be restored from log (original content, not truncated)
  expect(result![2].entryId).toBe("entry-2");
  expect(result![2].message.content).toBe("large original content here");
  // entry-0 and entry-1 should also be recovered from log
  expect(result![0].message.content).toBe("hello");
  expect(result![1].message.content).toBe("hi"); });

  it("falls back to branch entry when log id is missing", async () => { const entries: SessionMessageEntry[] = [
    {
      type: "message",
      id: "entry-2",
      message: { role: "toolResult", toolCallId: "tc1", content: "truncated…✂999" },
    },
    {
      type: "message",
      id: "entry-NEW",
      message: { role: "user", content: "new message" },
    },
  ];
  const result = await resolveCompactionMessages("test-session-abc", entries)
  expect(result).not.toBeNull();
  expect(result!.length).toBe(2);
  // entry-2 recovered from log
  expect(result![0].entryId).toBe("entry-2");
  expect(result![0].message.content).toBe("large original content here");
  // entry-NEW not in log → fallback to branch without losing its identity
  expect(result![1].entryId).toBe("entry-NEW");
  expect(result![1].message.content).toBe("new message"); });

  it("returns null when log file does not exist", async () => { const entries: SessionMessageEntry[] = [
    { type: "message", id: "x", message: { role: "user", content: "x" } },
  ];
  const result = await resolveCompactionMessages("nonexistent-session", entries)
  expect(result).toBeNull(); });
});
