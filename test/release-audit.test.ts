import { describe, expect, it } from "bun:test";
import { getNpmPackFilename } from "../scripts/release-audit-lib.ts";

describe("release audit npm pack compatibility", () => {
  it("accepts legacy array and npm 12 object output", () => {
    expect(getNpmPackFilename([{ filename: "legacy.tgz" }])).toBe("legacy.tgz");
    expect(getNpmPackFilename({ "pi-smart-compact": { filename: "npm12.tgz" } })).toBe("npm12.tgz");
  });

  it("rejects output without a filename", () => {
    expect(getNpmPackFilename({ "pi-smart-compact": {} })).toBeNull();
  });
});
