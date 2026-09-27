/**
 * Exclusive memory-backend policy and readonly readiness.
 *
 * Exactly one backend is selected (`memoryBackend`). Confirmed save, recall
 * and ref-resolve only ever operate the selected backend's store; every other
 * store is preserved untouched and inactive, and compaction-state graph
 * indexing is likewise local-backend-only. Helpers here are shared by the
 * context tools, the persist step, the effective-state report and the Mnemopi
 * worker path so the invariant cannot drift between call sites.
 */
import { execFile } from "node:child_process";
import { existsSync, accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CompactConfig, MemoryBackend } from "../types.ts";
import type { MemoryRef } from "../infra/memory-ref.ts";
import { resolveHindsightTarget } from "./hindsight-memory.ts";

/** Local context-graph operations run only for an exclusively selected local backend. */
export function localGraphOpsAllowed(
 config: Pick<CompactConfig, "memoryBackend" | "contextGraphEnabled">,
): boolean {
 return config.memoryBackend === "local" && config.contextGraphEnabled;
}

export interface MemoryBackendReadiness {
 backend: MemoryBackend;
 /** Selected backend only: its prerequisites are satisfiable without side effects. */
 ready: boolean;
 /**
  * Human-readable evidence naming exactly what was checked. Model,
  * credential and store checks are never claimed: presence-level checks
  * only, and only for the selected backend.
  */
 reason: string;
 /** Local context-graph read/write is permitted for this selection. */
 localOpsAllowed: boolean;
}

/**
 * Readonly readiness for the selected backend only. Never contacts a server,
 * never reads a key beyond the named environment variable's presence, never
 * creates or opens a store, and never probes an unselected backend (Mnemopi
 * stays unprobed unless it is the selection). Server installation is never
 * performed or implied: an existing URL, explicit bank and env key are
 * required configuration.
 */
export async function describeMemoryBackendReadiness(
 config: Pick<
  CompactConfig,
  | "memoryBackend"
  | "contextGraphEnabled"
  | "hindsightBaseUrl"
  | "hindsightBankId"
  | "hindsightApiKeyEnv"
  | "hindsightTimeoutMs"
 >,
 env: Record<string, string | undefined> = process.env,
): Promise<MemoryBackendReadiness> {
 const localOpsAllowed = localGraphOpsAllowed(config);
 switch (config.memoryBackend) {
  case "local":
   return {
    backend: "local",
    ready: localOpsAllowed,
    reason: localOpsAllowed
     ? "local graph enabled; no server required; store file and session scope are checked at use"
     : "unavailable: contextGraphEnabled=false while local is the selected backend; no other store is used",
    localOpsAllowed,
   };
  case "hindsight": {
   const target = resolveHindsightTarget(config, env);
   const ok = "ok" in target && target.ok;
   return {
    backend: "hindsight",
    ready: ok,
    reason: ok
     ? "configuration complete (server URL, explicit bank, named key environment variable present); server reachability, authentication and server-side models NOT verified"
     : "unavailable — check the existing Hindsight URL, explicit bank and configured key environment variable; no local fallback exists and none is started",
    localOpsAllowed,
   };
  }
  case "mnemopi":
   return {
    backend: "mnemopi",
    ready: false,
    reason: await describeMnemopiRuntime(),
    localOpsAllowed,
   };
 }
}

/**
 * Refuse a ref that lives in an unselected store instead of operating it:
 * the caller must switch the memory backend to the ref's own backend. Returns
 * null when the ref matches the selected backend.
 */
export function inactiveBackendRefusal(
 config: Pick<CompactConfig, "memoryBackend">,
 ref: MemoryRef,
): string | null {
 if (config.memoryBackend === ref.backend) return null;
 const store =
  ref.backend === "local"
   ? "the local context graph"
   : ref.backend === "mnemopi"
    ? "the Mnemopi store"
    : "the Hindsight server";
 return (
  "Project memory not changed: ref " +
  ref.backend + ":" + ref.id + "@" + ref.target +
  " lives in " + store +
  ", but the selected memory backend is " + config.memoryBackend +
  ". Switch Memory store to " + ref.backend +
  " to act on it; " + store + " was not contacted and nothing changed anywhere."
 );
}

export interface BunExecutable {
 /** Absolute executable path, or "bun" so execFile's PATH search resolves it. */
 executable: string;
 source: "package" | "platform-package" | "path";
}

/** bun's postinstall placeholder in bin/ is a 450-byte script; real binaries are megabytes. */
const BUN_PLACEHOLDER_MAX_BYTES = 4_096;
const MIN_BUN_VERSION = { major: 1, minor: 3, patch: 14 };

function isExecutableFile(file: string): boolean {
 try {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size <= BUN_PLACEHOLDER_MAX_BYTES) return false;
  accessSync(file, fsConstants.X_OK);
  return true;
 } catch {
  return false;
 }
}

/** Platform package names mirroring bun's own install mapping (no baseline aliases). */
function bunPlatformPackages(): Array<{ pkg: string; exe: string }> {
 // The executable lives at bin/bun (bin/bun.exe on Windows) inside each @oven package.
 const exe = process.platform === "win32" ? "bin/bun.exe" : "bin/bun";
 switch (process.platform) {
  case "darwin":
   return [{ pkg: process.arch === "arm64" ? "bun-darwin-aarch64" : "bun-darwin-x64", exe }];
  case "android":
   return [
    { pkg: process.arch === "arm64" ? "bun-linux-aarch64-android" : "bun-linux-x64-android", exe },
   ];
  case "freebsd":
   return [{ pkg: process.arch === "arm64" ? "bun-freebsd-aarch64" : "bun-freebsd-x64", exe }];
  case "linux": {
   const arch = process.arch === "arm64" ? "aarch64" : "x64";
   const musl = existsSync("/etc/alpine-release");
   const glibc = { pkg: "bun-linux-" + arch, exe };
   const muslPkg = { pkg: "bun-linux-" + arch + "-musl", exe };
   return musl ? [muslPkg, glibc] : [glibc, muslPkg];
  }
  default:
   return [];
 }
}

/**
 * Resolve the executable for the Bun-only Mnemopi worker: the package-owned
 * bun optional dependency first (metadata + actual installed layout, with the
 * platform @oven package as fallback), then a supported PATH Bun. Read-only
 * filesystem checks only: no shell, no download, no self-install, no network.
 */
export function resolveBunExecutable(parentUrl: string = import.meta.url): BunExecutable | null {
 const require = createRequire(parentUrl);
 try {
  const manifestFile = require.resolve("bun/package.json");
  const manifest: unknown = JSON.parse(readFileSync(manifestFile, "utf8"));
  const bin = manifest && typeof manifest === "object" && "bin" in manifest
   ? (manifest as { bin: unknown }).bin
   : null;
  const entry = typeof bin === "object" && bin !== null
   ? (bin as Record<string, unknown>)["bun"]
   : typeof bin === "string"
    ? bin
    : null;
  // Anything else (missing/invalid bin entry, escape outside the package,
  // or the postinstall placeholder) falls through to the platform package.
  if (
   typeof entry === "string" && !path.isAbsolute(entry)
  ) {
   const pkgDir = path.dirname(manifestFile);
   const candidate = path.resolve(pkgDir, entry);
   if (!path.relative(pkgDir, candidate).startsWith("..") && isExecutableFile(candidate)) {
    return { executable: candidate, source: "package" };
   }
  }
 } catch {
  /* No package-owned bun resolvable from here. */
 }
 for (const { pkg, exe } of bunPlatformPackages()) {
  try {
   const candidate = require.resolve("@oven/" + pkg + "/" + exe);
   if (isExecutableFile(candidate)) return { executable: candidate, source: "platform-package" };
  } catch {
   /* Platform optional package not installed. */
  }
 }
 return null;
}

export function bunVersionSupported(version: string): boolean {
 const parsed = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
 if (!parsed) return false;
 const [major, minor, patch] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
 return major > MIN_BUN_VERSION.major ||
  (major === MIN_BUN_VERSION.major &&
   (minor > MIN_BUN_VERSION.minor ||
    (minor === MIN_BUN_VERSION.minor && patch >= MIN_BUN_VERSION.patch)));
}

function runBunVersion(
 executable: string,
 env: NodeJS.ProcessEnv | undefined,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
 const { promise, resolve } = Promise.withResolvers<
  { ok: true; version: string } | { ok: false; error: string }
 >();
 execFile(executable, ["--version"], {
  timeout: 1_000, maxBuffer: 1_024, encoding: "utf8", env,
 }, (error, stdout) => {
  if (error) {
   resolve({
    ok: false,
    error: error.message.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160) || "no output",
   });
   return;
  }
  const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(stdout.trim());
  resolve(version ? { ok: true, version: stdout.trim() } : { ok: false, error: "version check failed" });
 });
 return promise;
}

/**
 * Presence/version evidence for the Mnemopi runtime: the optional
 * @oh-my-pi/pi-mnemopi package, the worker file, and a usable Bun executable
 * (package-owned first, PATH fallback). The engine is never loaded and no
 * database is opened or created.
 */
export async function describeMnemopiRuntime(): Promise<string> {
 const require = createRequire(import.meta.url);
 try {
  require.resolve("@oh-my-pi/pi-mnemopi");
 } catch {
  return "unavailable: optional @oh-my-pi/pi-mnemopi package is not locally resolvable";
 }
 const worker = new URL(
  import.meta.url.endsWith(".ts") ? "./mnemopi-worker.ts" : "./mnemopi-worker.js",
  import.meta.url,
 );
 if (!existsSync(worker)) return "unavailable: Mnemopi worker is missing; rebuild or reinstall the package";

 const owned = resolveBunExecutable();
 if (owned) {
  const probed = await runBunVersion(owned.executable, undefined);
  if (!probed.ok) {
   return "unavailable: the package-owned Bun binary did not run (" + probed.error + ")";
  }
  return bunVersionSupported(probed.version)
   ? "Bun " + probed.version + " (" +
   (owned.source === "package" ? "package-owned dependency" : "platform package") +
   ") and Mnemopi package found; worker/database operation not verified"
   : "unavailable: Bun >=1.3.14 is required (found " + probed.version + ")";
 }
 const probed = await runBunVersion("bun", { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot });
 if (!probed.ok) {
  return "unavailable: no package-owned Bun dependency is installed and none was found on PATH (" +
   probed.error + ")";
 }
 return bunVersionSupported(probed.version)
  ? "Bun " + probed.version + " from PATH and Mnemopi package found; worker/database operation not verified"
  : "unavailable: Bun >=1.3.14 is required (found " + probed.version + " on PATH)";
}
