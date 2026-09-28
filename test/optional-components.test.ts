import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OPTIONAL_COMPONENTS } from "../src/constants.ts";
import { componentInstalled, installCommand, installRoot } from "../src/infra/optional-components.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psc-optional-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A packed layout: <root>/node_modules/pi-smart-compact/dist/index.js. */
function piInstall(root: string): string {
  const pkg = path.join(root, "node_modules", "pi-smart-compact");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "pi-smart-compact" }));
  return pathToFileURL(path.join(pkg, "dist", "index.js")).href;
}

describe("optional components", () => {
  it("targets Pi's install root for an npm install and the package itself for a path install", () => {
    const root = path.join(dir, "pi-npm");
    expect(installRoot(piInstall(root))).toBe(root);
    const checkout = path.join(dir, "checkout");
    fs.mkdirSync(path.join(checkout, "src", "infra"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "pi-smart-compact" }));
    expect(installRoot(pathToFileURL(path.join(checkout, "src", "infra", "optional-components.ts")).href)).toBe(checkout);
  });

  it("hands over one command with the pinned versions and Pi's peer flag", () => {
    const root = path.join(dir, "pi-npm");
    expect(installCommand(["mnemopi", "bun"], piInstall(root))).toBe(
      "npm install @oh-my-pi/pi-mnemopi@" + OPTIONAL_COMPONENTS.mnemopi.version + " bun@" + OPTIONAL_COMPONENTS.bun.version
      + " --prefix " + root + " --legacy-peer-deps",
    );
  });

  it("sees a component only once its manifest sits in the install root, whatever its exports say", () => {
    const root = path.join(dir, "pi-npm");
    const entry = piInstall(root);
    expect(componentInstalled("mnemopi", entry)).toBe(false);
    const manifest = path.join(root, "node_modules", "@oh-my-pi", "pi-mnemopi", "package.json");
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    // Only an "import" condition: require.resolve() would refuse this package.
    fs.writeFileSync(manifest, JSON.stringify({ name: "@oh-my-pi/pi-mnemopi", exports: { ".": { import: "./src/index.ts" } } }));
    expect(componentInstalled("mnemopi", entry)).toBe(true);
    expect(componentInstalled("bun", entry)).toBe(false);
  });
});
