import { afterEach, describe, expect, it } from "bun:test";
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
});
