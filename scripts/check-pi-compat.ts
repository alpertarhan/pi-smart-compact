import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const version = process.argv[2] ?? "latest";
const piPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

if (!/^(?:latest|next|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(version)) {
  throw new Error("Expected a Pi version or tag, for example: latest, next, 0.80.6");
}

const root = resolve(import.meta.dir, "..");
const workspace = mkdtempSync(join(tmpdir(), "pi-smart-compact-compat-"));
const excluded = new Set([".git", ".pi-subagents", "dist", "node_modules"]);

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: workspace, env: Bun.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(command.join(" ") + " exited with " + exitCode);
}

try {
  cpSync(root, workspace, {
    recursive: true,
    filter: source => source === root || !excluded.has(basename(source)),
  });

  const manifestPath = join(workspace, "package.json");
  const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
    peerDependencies: Record<string, string>;
  };
  const originalManifest = JSON.stringify(manifest, null, 2) + "\n";

  // Pin only the isolated install. Restore the wildcard peer manifest before
  // validation so package-boundary tests still exercise the published shape.
  for (const name of piPackages) manifest.peerDependencies[name] = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  try { unlinkSync(join(workspace, "bun.lock")); } catch { /* absent lock is fine */ }

  console.log("Checking Pi compatibility against " + version + " in " + workspace);
  // A few repository-identity tests intentionally call `git rev-parse`.
  // Initialize metadata in the isolated copy without carrying source history.
  await run(["git", "init", "-q"]);
  await run(["bun", "install", "--ignore-scripts"]);
  writeFileSync(manifestPath, originalManifest);

  for (const name of piPackages) {
    const installed = await Bun.file(join(workspace, "node_modules", name, "package.json")).json() as { version: string };
    if (/^\d/.test(version) && installed.version !== version) {
      throw new Error("Requested " + name + "@" + version + " but installed " + installed.version);
    }
    console.log("  " + name + "@" + installed.version);
  }

  await run(["bun", "run", "typecheck"]);
  await run(["bun", "test"]);
  await run(["bun", "run", "build"]);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
