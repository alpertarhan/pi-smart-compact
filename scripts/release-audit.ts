import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = mkdtempSync(join(tmpdir(), "pi-smart-compact-release-"));
const home = join(workspace, "home");
mkdirSync(home, { recursive: true });

function run(command: string[], cwd = workspace): string {
  try {
    return execFileSync(command[0], command.slice(1), {
      cwd,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    throw new Error(command.join(" ") + " exited " + (failure.status ?? "unknown") + "\n" + (failure.stdout ?? "") + (failure.stderr ?? ""));
  }
}

try {
  const sourceManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name: string; version: string; peerDependencies: Record<string, string>;
  };
  const constants = readFileSync(join(root, "src/constants.ts"), "utf8");
  if (!constants.includes(`export const VERSION = "${sourceManifest.version}";`)) {
    throw new Error("package.json and src/constants.ts versions differ");
  }
  for (const peer of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    if (sourceManifest.peerDependencies[peer] !== "*") throw new Error(peer + " must remain a wildcard peer");
  }

  const packed = JSON.parse(run([
    "npm", "pack", "--json", "--ignore-scripts", "--pack-destination", workspace,
  ], root)) as Array<{ filename: string }>;
  const tarball = join(workspace, packed[0]?.filename ?? "");
  const files = run(["tar", "-tzf", tarball]).trim().split("\n");
  const required = [
    "package/package.json", "package/dist/index.js", "package/dist/index.d.ts",
    "package/dist/provider-eval.js", "package/dist/provider-scenario-eval.js",
    "package/dist/telemetry-report.js", "package/README.md", "package/CHANGELOG.md",
    "package/LICENSE", "package/docs/MIGRATING_TO_V8.md", "package/docs/RELEASE.md",
  ];
  for (const file of required) if (!files.includes(file)) throw new Error("packed artifact missing " + file);
  const forbidden = files.filter(file =>
    file.startsWith("package/src/") || file.startsWith("package/test/") || file.includes("node_modules")
    || /(?:^|\/)(?:\.env|auth\.json|context-graph\.sqlite|.*\.jsonl)$/.test(file),
  );
  if (forbidden.length) throw new Error("forbidden packed files: " + forbidden.join(", "));

  const packedManifest = JSON.parse(run(["tar", "-xOf", tarball, "package/package.json"])) as typeof sourceManifest;
  if (packedManifest.name !== sourceManifest.name || packedManifest.version !== sourceManifest.version) {
    throw new Error("packed manifest identity differs from source");
  }

  const peerPaths: Record<string, string> = {};
  for (const peer of Object.keys(sourceManifest.peerDependencies)) {
    peerPaths[peer] = "file:" + join(root, "node_modules", peer);
  }
  writeFileSync(join(workspace, "package.json"), JSON.stringify({
    name: "pi-smart-compact-frozen-smoke",
    private: true,
    dependencies: {
      "pi-smart-compact": "file:" + tarball,
      ...peerPaths,
    },
  }, null, 2) + "\n");
  run(["bun", "install", "--ignore-scripts"]);
  run(["bun", "install", "--frozen-lockfile", "--ignore-scripts"]);

  writeFileSync(join(workspace, "smoke.ts"), `
import extension from "pi-smart-compact";
const tools = new Map<string, unknown>();
extension({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool), registerCommand() {}, on() {} } as never);
for (const name of ["smart_compact", "smart_recall", "smart_save_memory"]) {
  if (!tools.has(name)) throw new Error("missing tool " + name);
}
console.log("installed extension smoke passed");
`);
  run(["bun", "run", "smoke.ts"]);
  run(["bun", "node_modules/pi-smart-compact/dist/provider-eval.js", "--min-samples=5"]);
  run(["bun", "node_modules/pi-smart-compact/dist/telemetry-report.js", "--min-canary-runs=5"]);

  console.log("Release artifact audit passed: " + sourceManifest.name + "@" + sourceManifest.version +
    " (" + files.length + " packed files; frozen install and CLIs verified)");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
