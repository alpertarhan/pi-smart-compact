/**
 * Opt-in components (Mnemopi engine, Bun runtime, image renderer) are optional
 * peer dependencies: Pi installs this extension with `--legacy-peer-deps`, so
 * nothing here is downloaded unless the user asks. These helpers say whether a
 * component is present beside the extension and give the exact command that
 * puts it there. Read-only filesystem checks; no shell, no network.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPTIONAL_COMPONENTS } from "../constants.ts";

export type OptionalComponent = keyof typeof OPTIONAL_COMPONENTS;

/** This package's directory: the nearest ancestor of the module holding a package.json (dist/ or src/ layout). */
export function packageDir(parentUrl: string = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(parentUrl));
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("No package.json above " + fileURLToPath(parentUrl));
    dir = parent;
  }
}

/**
 * Where `npm install --prefix` must put a component so Node resolves it from
 * this package: Pi's install root for npm installs (the package sits in its
 * node_modules), the package itself for git or path installs.
 */
export function installRoot(parentUrl: string = import.meta.url): string {
  const pkg = packageDir(parentUrl);
  const parent = path.dirname(pkg);
  return path.basename(parent) === "node_modules" ? path.dirname(parent) : pkg;
}

/** Present when its manifest is on the module's lookup paths; exports conditions never matter. */
export function componentInstalled(component: OptionalComponent, parentUrl: string = import.meta.url): boolean {
  const { name } = OPTIONAL_COMPONENTS[component];
  const lookup = createRequire(parentUrl).resolve.paths(name) ?? [];
  return lookup.some((dir) => existsSync(path.join(dir, ...name.split("/"), "package.json")));
}

/** The copy-pasteable install command for the given components, with Pi's own peer flag. */
export function installCommand(components: readonly OptionalComponent[], parentUrl: string = import.meta.url): string {
  const specs = components.map((component) => OPTIONAL_COMPONENTS[component].name + "@" + OPTIONAL_COMPONENTS[component].version);
  return "npm install " + specs.join(" ") + " --prefix " + installRoot(parentUrl) + " --legacy-peer-deps";
}
