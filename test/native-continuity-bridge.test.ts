import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNativeContinuityBridge, type NativeContinuityScope } from "../src/app/native-continuity-bridge.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psc-native-continuity-"));
  dirs.push(dir);
  return dir;
};
const scope = (branchHeadId: string, sessionId = "session-a", projectId = "project-a"): NativeContinuityScope => ({
  projectId, sessionId, branchHeadId,
});

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("NativeContinuityBridge", () => {
  it("delivers continuity once across bridge instances", () => {
    const dir = tempDir();
    createNativeContinuityBridge({ dir }).stage(scope("head-a"), "ledger A");

    const reloaded = createNativeContinuityBridge({ dir });
    expect(reloaded.take(scope("head-a"))).toBe("ledger A");
    expect(reloaded.take(scope("head-a"))).toBeNull();
  });

  it("does not cross project, session, or divergent-branch boundaries", () => {
    const dir = tempDir();
    const bridge = createNativeContinuityBridge({ dir });
    bridge.stage(scope("head-a"), "A");

    expect(bridge.take(scope("head-b"))).toBeNull();
    expect(bridge.take(scope("head-a", "session-b"))).toBeNull();
    expect(bridge.take(scope("head-a", "session-a", "project-b"))).toBeNull();
    expect(bridge.take(scope("head-a"))).toBe("A");
  });

  it("expires entries and evicts the oldest at the bound", () => {
    let now = 0;
    const bridge = createNativeContinuityBridge({ dir: tempDir(), ttlMs: 10, maxEntries: 2, now: () => now });
    bridge.stage(scope("a"), "A");
    now = 1;
    bridge.stage(scope("b"), "B");
    now = 2;
    bridge.stage(scope("c"), "C");
    expect(bridge.take(scope("a"))).toBeNull();
    now = 12;
    expect(bridge.take(scope("b"))).toBeNull();
    expect(bridge.size()).toBe(1);
  });

  it("removes stale atomic-write temp files during retention sweeps", () => {
    const dir = tempDir();
    const orphan = path.join(dir, "entry.json.tmp.123.abcd1234");
    fs.writeFileSync(orphan, "partial");
    const stale = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(orphan, stale, stale);
    const bridge = createNativeContinuityBridge({ dir });
    expect(bridge.size()).toBe(0);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("reclaims a lock left by a dead owner", () => {
    const dir = tempDir();
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    fs.mkdirSync(path.join(dir, "bridge.lock"), { recursive: true });
    fs.writeFileSync(path.join(dir, "bridge.lock", "owner"), deadPid + ":deadbeef");
    const bridge = createNativeContinuityBridge({ dir });
    bridge.stage(scope("head-a"), "after crash");
    expect(bridge.take(scope("head-a"))).toBe("after crash");
    expect(fs.existsSync(path.join(dir, "bridge.lock"))).toBe(false);
  });

  it("reclaims an expired lock but refuses a fresh live one", () => {
    const dir = tempDir();
    const lockDir = path.join(dir, "bridge.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner"), process.pid + ":cafebabe");
    const bridge = createNativeContinuityBridge({ dir });
    bridge.stage(scope("head-a"), "blocked");
    expect(fs.readdirSync(dir).filter(name => name.endsWith(".json"))).toEqual([]);
    expect(fs.readFileSync(path.join(lockDir, "owner"), "utf8")).toBe(process.pid + ":cafebabe");

    const expired = (Date.now() - 2 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(lockDir, "owner"), expired, expired);
    bridge.stage(scope("head-a"), "after expiry");
    expect(bridge.take(scope("head-a"))).toBe("after expiry");
  });

  it("keeps the previous handoff when replacing it fails", () => {
    const dir = tempDir();
    const bridge = createNativeContinuityBridge({ dir });
    bridge.stage(scope("head-a"), "previous");
    const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("disk full"); });
    try { bridge.stage(scope("head-a"), "replacement"); }
    finally { rename.mockRestore(); }
    expect(bridge.take(scope("head-a"))).toBe("previous");
  });

  it("leaves a handoff whose recorded scope does not match in place", () => {
    const dir = tempDir();
    const bridge = createNativeContinuityBridge({ dir });
    bridge.stage(scope("head-a"), "A");
    bridge.stage(scope("head-b"), "B");
    const [fileA, fileB] = ["head-a", "head-b"].map(head => fs.readdirSync(dir)
      .map(name => path.join(dir, name))
      .find(file => file.endsWith(".json") && fs.readFileSync(file, "utf8").includes('"' + head + '"'))!);
    fs.copyFileSync(fileA, fileB);
    expect(bridge.take(scope("head-b"))).toBeNull();
    expect(fs.existsSync(fileB)).toBe(true);
    expect(bridge.take(scope("head-a"))).toBe("A");
  });
});
