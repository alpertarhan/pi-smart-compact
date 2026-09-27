import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  bunVersionSupported,
  describeMemoryBackendReadiness,
  localGraphOpsAllowed,
  resolveBunExecutable,
} from "../src/app/memory-backend.ts";
import { DEFAULT_CONFIG } from "../src/constants.ts";

const PLATFORM_PACKAGE =
  process.platform === "win32"
    ? { pkg: "bun-windows-" + (process.arch === "arm64" ? "aarch64" : "x64"), exe: "bun.exe" }
    : process.platform === "darwin"
      ? { pkg: process.arch === "arm64" ? "bun-darwin-aarch64" : "bun-darwin-x64", exe: "bun" }
      : process.platform === "linux"
        ? {
          pkg: "bun-linux-" + (process.arch === "arm64" ? "aarch64" : "x64"),
          exe: "bun",
        }
        : null;

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "psc-memory-backend-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeBunPackage(bin: { entry: string; size: number }): void {
  const root = path.join(dir, "node_modules", "bun");
  mkdirSync(path.join(root, "bin"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "bun",
    version: "1.4.2",
    bin: { bun: bin.entry },
  }));
  const target = path.join(root, bin.entry);
  writeFileSync(target, "#!/bin/sh\necho bun\n" + "#".repeat(Math.max(0, bin.size)));
  chmodSync(target, 0o755);
}

function writePlatformPackage(): void {
  if (!PLATFORM_PACKAGE) return;
  const pkgRoot = path.join(dir, "node_modules", "@oven", PLATFORM_PACKAGE.pkg);
  mkdirSync(path.join(pkgRoot, "bin"), { recursive: true });
  writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({
    name: "@oven/" + PLATFORM_PACKAGE.pkg,
    version: "1.4.2",
  }));
  const target = path.join(pkgRoot, "bin", PLATFORM_PACKAGE.exe);
  writeFileSync(target, "#!/bin/sh\necho bun\n" + "#".repeat(8_192));
  chmodSync(target, 0o755);
}

function probeUrl(): string {
  return pathToFileURL(path.join(dir, "probe.ts")).href;
}

describe("resolveBunExecutable", () => {
  it("resolves the package-owned bun from bin metadata and the real installed layout", () => {
    writeBunPackage({ entry: "bin/bun.exe", size: 8_192 });
    const resolved = resolveBunExecutable(probeUrl());
    expect(resolved?.source).toBe("package");
    expect(realpathSync(resolved!.executable)).toBe(
      realpathSync(path.join(dir, "node_modules", "bun", "bin", "bun.exe")),
    );
  });

  it("rejects the postinstall placeholder and falls back to the platform package", () => {
    writeBunPackage({ entry: "bin/bun.exe", size: 300 });
    writePlatformPackage();
    const resolved = resolveBunExecutable(probeUrl());
    if (PLATFORM_PACKAGE) {
      expect(resolved?.source).toBe("platform-package");
      expect(realpathSync(resolved!.executable)).toBe(
        realpathSync(path.join(dir, "node_modules", "@oven", PLATFORM_PACKAGE.pkg, "bin", PLATFORM_PACKAGE.exe)),
      );
    } else {
      expect(resolved).toBeNull();
    }
  });

  it("refuses bin entries that escape the package and finds nothing without packages", () => {
    writeBunPackage({ entry: "../outside", size: 8_192 });
    expect(resolveBunExecutable(probeUrl())).toBeNull();
    rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
    expect(resolveBunExecutable(probeUrl())).toBeNull();
  });
});

describe("exclusive backend policy", () => {
  it("allows local graph operations only for the selected local backend", () => {
    expect(localGraphOpsAllowed({ memoryBackend: "local", contextGraphEnabled: true })).toBe(true);
    expect(localGraphOpsAllowed({ memoryBackend: "local", contextGraphEnabled: false })).toBe(false);
    expect(localGraphOpsAllowed({ memoryBackend: "hindsight", contextGraphEnabled: true })).toBe(false);
    expect(localGraphOpsAllowed({ memoryBackend: "mnemopi", contextGraphEnabled: true })).toBe(false);
  });

});

describe("bunVersionSupported", () => {
  it("accepts 1.3.14 and newer, rejects older or malformed versions", () => {
    expect(bunVersionSupported("1.3.14")).toBe(true);
    expect(bunVersionSupported("1.4.2")).toBe(true);
    expect(bunVersionSupported("2.0.0")).toBe(true);
    expect(bunVersionSupported("1.3.13")).toBe(false);
    expect(bunVersionSupported("1.2.99")).toBe(false);
    expect(bunVersionSupported("not-a-version")).toBe(false);
  });
});

describe("describeMemoryBackendReadiness", () => {
  it("reports local readiness from the graph flag without probing other backends", async () => {
    const enabled = await describeMemoryBackendReadiness(
      { ...DEFAULT_CONFIG, memoryBackend: "local", contextGraphEnabled: true },
      {},
    );
    expect(enabled).toMatchObject({ backend: "local", ready: true, localOpsAllowed: true });
    const disabled = await describeMemoryBackendReadiness(
      { ...DEFAULT_CONFIG, memoryBackend: "local", contextGraphEnabled: false },
      {},
    );
    expect(disabled).toMatchObject({ backend: "local", ready: false, localOpsAllowed: false });
  });

  it("checks only the named Hindsight environment variable and never claims server verification", async () => {
    const base = {
      memoryBackend: "hindsight" as const,
      contextGraphEnabled: true,
      hindsightBaseUrl: "https://h.example.com",
      hindsightBankId: "bank",
      hindsightApiKeyEnv: "KEY_ENV",
      hindsightTimeoutMs: 12_000,
    };
    const ready = await describeMemoryBackendReadiness(base, { KEY_ENV: "secret" });
    expect(ready).toMatchObject({ backend: "hindsight", ready: true, localOpsAllowed: false });
    expect(JSON.stringify(ready)).not.toContain("secret");
    const missing = await describeMemoryBackendReadiness(base, {});
    expect(missing.ready).toBe(false);
  });

});
