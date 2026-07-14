import { describe, expect, it } from "bun:test";

const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts: Record<string, string>;
};

const hostPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

describe("Pi host dependency boundary", () => {
  it("keeps host-provided packages as wildcard peers only", () => {
    for (const name of hostPackages) {
      expect(packageJson.peerDependencies?.[name]).toBe("*");
      expect(packageJson.dependencies?.[name]).toBeUndefined();
      expect(packageJson.devDependencies?.[name]).toBeUndefined();
    }
  });

  it("keeps host packages external to the published bundle", () => {
    expect(packageJson.scripts.build).toContain("--external '@earendil-works/*'");
    expect(packageJson.scripts.build).toContain("--external 'typebox'");
  });
});
