import { describe, expect, it } from "bun:test";
import { isValidMnemopiDataDir, validateSmartCompactConfig } from "../src/utils/config.ts";

/** Boundary cases for the Mnemopi data directory; the planner resolves the actual path. */
describe("mnemopiDataDir validation", () => {
  it("normalizes blanks to null (default directory) and trims kept paths", () => {
    for (const blank of ["", "   ", "\t "]) {
      const sc: Record<string, unknown> = { mnemopiDataDir: blank };
      validateSmartCompactConfig(sc);
      expect(sc.mnemopiDataDir).toBeNull();
    }
    const sc: Record<string, unknown> = { mnemopiDataDir: "  ~/mnemopi-data  " };
    validateSmartCompactConfig(sc);
    expect(sc.mnemopiDataDir).toBe("~/mnemopi-data");
  });

  it("keeps absolute and ~/ paths, never resolving against the current directory", () => {
    for (const ok of ["/var/data/mnemopi", "~/data/mnemopi", "/data dir/with spaces"]) {
      expect(isValidMnemopiDataDir(ok)).toBe(true);
    }
    for (const bad of [
      "data/mnemopi", "./data", "../data", "~", "~/", "~other/data", "mnemopi",
      "/data/\u0000x", "/data/line\nbreak", "/data/\u007f", "~/tab\there",
    ]) {
      expect(isValidMnemopiDataDir(bad)).toBe(false);
      const sc: Record<string, unknown> = { mnemopiDataDir: bad };
      validateSmartCompactConfig(sc);
      expect("mnemopiDataDir" in sc).toBe(false);
    }
  });

  it("discards non-string values and accepts the mnemopi backend", () => {
    const sc: Record<string, unknown> = { mnemopiDataDir: 42, memoryBackend: "mnemopi" };
    validateSmartCompactConfig(sc);
    expect("mnemopiDataDir" in sc).toBe(false);
    expect(sc.memoryBackend).toBe("mnemopi");
    const nulls: Record<string, unknown> = { mnemopiDataDir: null };
    validateSmartCompactConfig(nulls);
    expect(nulls.mnemopiDataDir).toBeNull();
  });
});
