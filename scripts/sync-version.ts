#!/usr/bin/env bun
/**
 * Sync the version literal embedded in `src/constants.ts` with the canonical
 * value in `package.json`.
 *
 * The version used to live in three different places (constants.ts, package.json,
 * README), which drifted out of sync between releases. We now make package.json
 * the single source of truth and let this script regenerate the constants
 * literal at prebuild time. Running it from `prepublishOnly` (and once at
 * `prebuild`) guarantees the bundle never carries a stale version.
 *
 * The script is intentionally idempotent and surgical: it only rewrites the
 * exact `export const VERSION = "...";` line. Manual edits to that line will
 * be silently corrected on the next build; everywhere else, hand-edit freely.
 *
 * The pure transform/validation logic lives in `sync-version-lib.ts` so it
 * can be unit-tested without touching the filesystem.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidSemver, rewriteVersionLiteral } from "./sync-version-lib.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pkgPath = resolve(root, "package.json");
const constantsPath = resolve(root, "src/constants.ts");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
const version = pkg.version;
if (typeof version !== "string" || !version) {
  console.error("sync-version: package.json#version is missing or not a string");
  process.exit(1);
}

if (!isValidSemver(version)) {
  console.error("sync-version: refusing to embed non-semver version literal: " + JSON.stringify(version));
  process.exit(1);
}

const src = readFileSync(constantsPath, "utf-8");
const { found, changed, result } = rewriteVersionLiteral(src, version);

if (!found) {
  console.error("sync-version: could not locate the `export const VERSION = \"...\";` line in src/constants.ts");
  process.exit(1);
}

if (changed) {
  writeFileSync(constantsPath, result);
  console.log(`sync-version: updated src/constants.ts to ${version}`);
} else {
  console.log(`sync-version: already in sync at ${version}`);
}
