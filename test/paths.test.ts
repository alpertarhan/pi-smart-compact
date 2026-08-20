/// <reference types="bun" />

import { describe, it, expect, afterEach } from "bun:test";
import os from "node:os";
import path from "node:path";
import { piAgentDir, home } from "../src/infra/paths.ts";

// paths.ts reads HOME at call time (module doc), so mutating env here is safe.
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
afterEach(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = REAL_USERPROFILE;
});

describe("home resolution fallback", () => {
  it("falls back to os.homedir() when environment homes are unavailable", () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    expect(home()).toBe(os.homedir());
    expect(piAgentDir()).toBe(path.join(os.homedir(), ".pi", "agent"));
  });

  it("uses USERPROFILE when HOME is blank", () => {
    process.env.HOME = " ";
    process.env.USERPROFILE = "C:\\Users\\example";
    expect(home()).toBe("C:\\Users\\example");
  });

  it("prefers HOME when set (test overrides keep working)", () => {
    process.env.HOME = "/tmp/sc-path-test-home";
    expect(piAgentDir()).toBe(
      path.join("/tmp/sc-path-test-home", ".pi", "agent"),
    );
  });
});
