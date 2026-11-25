import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeRemediationHints, readRemediationHints, writeVerificationGapHints, readVerificationGapHints } from "../src/utils/damage.ts";
import { remediationHintsFile } from "../src/infra/paths.ts";

// Per-test HOME swap so remediation hint files never touch the user's real
// ~/.pi/agent/.cache (mirrors backup-prune.test.ts / fingerprint.test.ts).
let prevHome: string | undefined;
let tmp: string;
const PID = "proj-test-remediation";

beforeEach(() => {
  prevHome = process.env.HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-rem-"));
  process.env.HOME = tmp;
});
afterEach(() => {
  process.env.HOME = prevHome;
});

describe("remediation hints", () => {
  it("returns [] when no hints have been written", () => {
    expect(readRemediationHints(PID)).toEqual([]);
  });

  it("writeRemediationHints is a no-op for empty input (no file created)", () => {
    writeRemediationHints(PID, []);
    expect(readRemediationHints(PID)).toEqual([]);
  });

  it("round-trips a set of re-read files, deduped and trimmed", () => {
    writeRemediationHints(PID, ["src/a.ts", "src/a.ts", "  lib/b.ts  ", ""]);
    expect(readRemediationHints(PID)).toEqual(["src/a.ts", "lib/b.ts"]);
  });

  it("overwrites (does not accumulate) on a subsequent write", () => {
    writeRemediationHints(PID, ["src/a.ts", "lib/b.ts"]);
    writeRemediationHints(PID, ["src/c.ts"]);
    expect(readRemediationHints(PID)).toEqual(["src/c.ts"]);
  });

  it("keeps file hints and verification gap kinds side by side in one file", () => {
    writeRemediationHints(PID, ["src/a.ts"]);
    writeVerificationGapHints(PID, ["missing-file", "missing-file", "inconsistency"]);
    expect(readRemediationHints(PID)).toEqual(["src/a.ts"]);
    expect(readVerificationGapHints(PID)).toEqual(["missing-file", "inconsistency"]);
    writeRemediationHints(PID, ["src/b.ts"]);
    expect(readVerificationGapHints(PID)).toEqual(["missing-file", "inconsistency"]);
    expect(readVerificationGapHints("never-written")).toEqual([]);
  });

  it("keeps a separate freshness clock for file hints and gap kinds", () => {
    writeRemediationHints(PID, ["src/a.ts"]);
    const file = remediationHintsFile(PID);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.updatedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify(data));
    writeVerificationGapHints(PID, ["missing-file"]);
    expect(readRemediationHints(PID)).toEqual([]);
    expect(readVerificationGapHints(PID)).toEqual(["missing-file"]);
  });

  it("returns [] when the cache file is malformed", () => {
    fs.mkdirSync(path.join(tmp, ".pi", "agent", ".cache", "smart-compact"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".pi", "agent", ".cache", "smart-compact", "remediation-" + PID + ".json"),
      "{ not valid json",
    );
    expect(readRemediationHints(PID)).toEqual([]);
  });
});
