// pi-lens-ignore: ts(2307)
import { describe, it, expect, afterEach } from "bun:test";
import os from "node:os";
import path from "node:path";
import { piAgentDir, home } from "../src/infra/paths.ts";

// paths.ts reads HOME at call time (module doc), so mutating env here is safe.
const REAL_HOME = process.env.HOME;
afterEach(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});

describe("home resolution fallback", () => {
  it("falls back to os.homedir() when HOME is unset (Windows / GUI launches)", () => {
    delete process.env.HOME;
    expect(home()).toBe(os.homedir());
    expect(piAgentDir()).toBe(path.join(os.homedir(), ".pi", "agent"));
  });

  it("prefers HOME when set (test overrides keep working)", () => {
    process.env.HOME = "/tmp/sc-path-test-home";
    expect(piAgentDir()).toBe(
      path.join("/tmp/sc-path-test-home", ".pi", "agent"),
    );
  });
});
