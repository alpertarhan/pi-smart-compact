import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getNpmPackFilename } from "./release-audit-lib.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = mkdtempSync(join(tmpdir(), "pi-smart-compact-release-"));
const home = join(workspace, "home");
mkdirSync(home, { recursive: true });

function run(command: string[], cwd = workspace, env: Record<string, string> = {}): string {
  try {
    return execFileSync(command[0], command.slice(1), {
      cwd,
      env: { ...process.env, HOME: home, BUN_INSTALL_CACHE_DIR: join(workspace, "bun-cache"), ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    throw new Error(command.join(" ") + " exited " + (failure.status ?? "unknown") + "\n" + (failure.stdout ?? "") + (failure.stderr ?? ""));
  }
}

// The installed package must not depend on a globally installed Bun: the
// smokes below run with a PATH that offers none, so the packed host can only
// run the Mnemopi worker on its own package-owned optional dependency.
function bunFreePath(): string {
  const kept = (process.env.PATH ?? "").split(delimiter)
    .filter(entry => entry !== "" && !existsSync(join(entry, "bun")) && !existsSync(join(entry, "bunx")));
  const PATH = kept.join(delimiter);
  const bunGone = spawnSync("bun", ["--version"], { env: { ...process.env, PATH }, encoding: "utf8" });
  const nodeKept = spawnSync("node", ["-p", "process.version"], { env: { ...process.env, PATH }, encoding: "utf8" });
  if (!((bunGone.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") || nodeKept.error) {
    throw new Error("cannot build a Bun-free PATH that still resolves node for the package-owned runtime proof");
  }
  return PATH;
}

// Platform package name mirroring the packed host's own mapping.
function bunPlatformPackage(): string {
  switch (process.platform) {
    case "darwin":
      return process.arch === "arm64" ? "bun-darwin-aarch64" : "bun-darwin-x64";
    case "linux":
      return "bun-linux-" + (process.arch === "arm64" ? "aarch64" : "x64")
        + (existsSync("/etc/alpine-release") ? "-musl" : "");
    default:
      throw new Error("release audit has no package-owned Bun mapping for " + process.platform);
  }
}


try {
  const sourceManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name: string; version: string; type?: string; peerDependencies: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  if (sourceManifest.type !== "module") {
    throw new Error("package.json must declare type=module for the ESM artifact");
  }
  const constants = readFileSync(join(root, "src/constants.ts"), "utf8");
  if (!constants.includes(`export const VERSION = "${sourceManifest.version}";`)) {
    throw new Error("package.json and src/constants.ts versions differ");
  }
  const packageMajor = Number(sourceManifest.version.split(".")[0]);
  if (!Number.isSafeInteger(packageMajor) || packageMajor < 0) {
    throw new Error("package.json version has no numeric major");
  }
  const supportedMajor = `Latest \`${packageMajor}.x\``;
  const securityPolicy = readFileSync(join(root, "SECURITY.md"), "utf8");
  if (!securityPolicy.includes(supportedMajor)) {
    throw new Error("SECURITY.md must advertise supported major as " + supportedMajor);
  }
  for (const peer of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    const required = peer === "typebox" ? "*" : ">=0.87.1";
    if (sourceManifest.peerDependencies[peer] !== required) throw new Error(peer + " must remain a host peer with range " + required);
  }

  const packResult: unknown = JSON.parse(run([
    "npm", "pack", "--json", "--ignore-scripts", "--pack-destination", workspace,
  ], root));
  const filename = getNpmPackFilename(packResult);
  if (!filename) throw new Error("npm pack --json returned no filename");
  const tarball = join(workspace, filename);
  const files = run(["tar", "-tzf", tarball]).trim().split("\n");
  const required = [
    "package/package.json", "package/dist/index.js", "package/dist/index.d.ts",
    "package/dist/rtk.js", "package/dist/rtk.d.ts", "package/dist/mnemopi-worker.js",
    "package/README.md", "package/CHANGELOG.md",
    "package/LICENSE", "package/SECURITY.md", "package/SUPPORT.md", "package/ARCHITECTURE.md",
    "package/docs/MIGRATING_TO_V8.md", "package/docs/RELEASE.md",
    "package/assets/DejaVuSansMono.ttf", "package/assets/DejaVu-LICENSE.txt", "package/assets/README.md",
  ];
  for (const file of required) if (!files.includes(file)) throw new Error("packed artifact missing " + file);
  // The installed package ships only the runtime: extension, RTK companion
  // and Mnemopi worker. Evaluation/report CLIs stay source-checkout tools, so
  // any other bundled JavaScript (e.g. a second runtime copy) is a regression.
  const runtimeJs = ["package/dist/index.js", "package/dist/mnemopi-worker.js", "package/dist/rtk.js"];
  const packedJs = files.filter(file => file.startsWith("package/dist/") && file.endsWith(".js")).sort();
  if (packedJs.join("\n") !== runtimeJs.join("\n")) {
    throw new Error("packed dist JavaScript must be exactly " + runtimeJs.join(", ") + "; got " + packedJs.join(", "));
  }
  const forbidden = files.filter(file =>
    file.startsWith("package/src/") || file.startsWith("package/test/") || file.includes("node_modules")
    || /(?:^|\/)(?:\.env|auth\.json|context-graph\.sqlite|.*\.jsonl)$/.test(file),
  );
  if (forbidden.length) throw new Error("forbidden packed files: " + forbidden.join(", "));

  const packedManifest = JSON.parse(run(["tar", "-xOf", tarball, "package/package.json"])) as typeof sourceManifest;
  if (packedManifest.name !== sourceManifest.name || packedManifest.version !== sourceManifest.version) {
    throw new Error("packed manifest identity differs from source");
  }
  if (packedManifest.type !== "module") {
    throw new Error("packed manifest lost type=module");
  }

  const peerPaths: Record<string, string> = {};
  for (const peer of Object.keys(sourceManifest.peerDependencies)) {
    // Bun >=1.4 refuses file: folder deps whose serialized path escapes the
    // workspace, so expose each peer as an in-workspace symlink (issue #52).
    const link = join(workspace, "vendor", peer);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(root, "node_modules", peer), link, "dir");
    peerPaths[peer] = "file:" + join("vendor", peer);
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

  // The packed manifest owns its Bun runtime: the optional dependency must
  // be pinned and actually install. The frozen install ignores scripts, so
  // the wrapper's bin stays the postinstall placeholder and only the
  // platform package ships a runnable binary — exactly the fallback the
  // packed host's resolver uses.
  const bunPin = packedManifest.optionalDependencies?.["bun"];
  if (!bunPin) throw new Error("packed manifest must pin optionalDependencies.bun for the package-owned runtime");
  const packageBunPath = [
    join(workspace, "node_modules", "bun", "bin", "bun.exe"),
    join(workspace, "node_modules", "@oven", bunPlatformPackage(), "bin", "bun"),
  ].find(file => {
    try {
      const stat = statSync(file);
      return stat.isFile() && stat.size > 4_096;
    } catch {
      return false;
    }
  });
  if (!packageBunPath) {
    throw new Error("frozen install provided no runnable package-owned Bun binary (wrapper or " + bunPlatformPackage() + ")");
  }
  const packageBunVersion = run([packageBunPath, "--version"]).trim();
  if (packageBunVersion !== bunPin) {
    throw new Error("package-owned Bun " + packageBunVersion + " differs from pinned " + bunPin);
  }

  writeFileSync(join(workspace, "smoke.ts"), `
import extension from "pi-smart-compact";
import companion from "pi-smart-compact/rtk";
companion({ on() {} } as never);
const tools = new Map<string, unknown>();
// Stock hosts expose every registered tool as active; the fakes below do the same.
extension({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool), registerCommand() {}, on() {}, getActiveTools: () => [...tools.keys()], setActiveTools() {} } as never);
for (const name of ["smart_compact", "smart_context", "smart_recall", "smart_save_memory"]) {
  if (!tools.has(name)) throw new Error("missing tool " + name);
}
console.log("installed extension smoke passed");
`);
  run(["bun", "run", "smoke.ts"]);

  // Pi executes extensions under Node, even though this repository builds and
  // tests with Bun. Exercise a real SQLite write/read from an independently
  // extracted artifact WITHOUT optional renderer links; default text operation
  // must remain loadable. Bun's file-peer layout can create nested placeholders.
  const nodeWorkspace = join(workspace, "node-smoke");
  mkdirSync(join(nodeWorkspace, "node_modules", "@earendil-works"), { recursive: true });
  run(["tar", "-xzf", tarball, "-C", nodeWorkspace]);
  for (const peer of Object.keys(sourceManifest.peerDependencies)) {
    const target = join(root, "node_modules", peer);
    const link = join(nodeWorkspace, "node_modules", peer);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, "dir");
  }
  writeFileSync(join(nodeWorkspace, "smoke-node.mjs"), String.raw`
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import extension from "./package/dist/index.js";
import companion from "./package/dist/rtk.js";
companion({ on() {} });
const tools = new Map();
extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {}, getActiveTools: () => [...tools.keys()], setActiveTools() {} });
const strayBun = spawnSync("bun", ["--version"], { encoding: "utf8" });
if (!(strayBun.error && strayBun.error.code === "ENOENT")) {
  throw new Error("local-backend smoke must run without any Bun on PATH");
}
const ctx = {
  cwd: process.cwd(),
  hasUI: true,
  ui: { confirm: async () => true },
  sessionManager: {
    getSessionId: () => "node-runtime-smoke",
    getSessionFile: () => process.cwd() + "/node-runtime-smoke.jsonl",
    getBranch: () => [{ id: "branch-head" }],
  },
};
const signal = new AbortController().signal;
const saved = await tools.get("smart_save_memory").execute("save", {
  kind: "procedure", title: "Node smoke", content: "Node SQLite packed-artifact smoke",
}, signal, undefined, ctx);
const recalled = await tools.get("smart_recall").execute("recall", {
  query: "Node SQLite packed-artifact smoke",
}, signal, undefined, ctx);
if (!recalled.content[0].text.includes("Node SQLite packed-artifact smoke")) {
  throw new Error("Node SQLite context graph smoke failed");
}
if (recalled.details.results[0]?.id !== saved.details.memory.id) throw new Error("Node recall lost the saved fact identity");
const ref = /^Ref: (\S+)$/m.exec(recalled.content[0].text)?.[1];
const resolved = await tools.get("smart_save_memory").execute("resolve", {
  status: "resolved", ref,
}, signal, undefined, ctx);
if (resolved.details.closed !== 1) throw new Error("Node ref-based resolve did not close the recalled fact");
const after = await tools.get("smart_recall").execute("recall-closed", {
  query: "Node SQLite packed-artifact smoke",
}, signal, undefined, ctx);
if (after.details.results.length !== 0) throw new Error("Node resolved fact remains recallable");
if (existsSync(path.join(process.env.HOME, ".pi", "agent", "smart-compact-memory"))) {
  throw new Error("local backend started a Mnemopi store; the unselected engine must never run");
}
console.log("installed Node SQLite smoke passed (no Bun on PATH)");
`);
  run(["node", "smoke-node.mjs"], nodeWorkspace, { PATH: bunFreePath() });

  // Source-checkout evaluator (not packed): all four offline arms under the
  // audit's isolated HOME, no daily configuration or provider traffic.
  const taskEvalOut = join(workspace, "task-eval");
  run(["bun", "run", join(root, "scripts", "task-eval.ts"), "--out=" + taskEvalOut]);
  const taskEval = JSON.parse(readFileSync(join(taskEvalOut, "task-eval-report.json"), "utf8")) as {
    mode: string; arms: Array<{ arm: string; ok: boolean }>;
  };
  const pairedArms = ["no-compaction", "recoverable-hygiene", "eesv", "hybrid"];
  if (taskEval.mode !== "offline-lifecycle" || taskEval.arms.length !== pairedArms.length
    || pairedArms.some(arm => !taskEval.arms.some(result => result.arm === arm && result.ok))) {
    throw new Error("Packaged paired task evaluation failed: " + JSON.stringify(taskEval.arms));
  }

  // Optional Mnemopi engine. Stock Pi executes this extension under Node, so
  // the Bun-only engine must stay out of the host import path: the packed host
  // spawns dist/mnemopi-worker.js — resolved relative to the installed
  // dist/index.js — as a real Bun subprocess that owns an isolated SQLite
  // store under HOME. The engine ships as a pinned optional dependency.
  const mnemopiPin = packedManifest.optionalDependencies?.["@oh-my-pi/pi-mnemopi"];
  if (!mnemopiPin) {
    throw new Error("packed manifest must pin optionalDependencies.@oh-my-pi/pi-mnemopi");
  }
  const mnemopiWorkspace = join(workspace, "node-mnemopi");
  mkdirSync(join(mnemopiWorkspace, "node_modules"), { recursive: true });
  run(["tar", "-xzf", tarball, "-C", mnemopiWorkspace]);
  for (const peer of Object.keys(sourceManifest.peerDependencies)) {
    const link = join(mnemopiWorkspace, "node_modules", peer);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(root, "node_modules", peer), link, "dir");
  }
  symlinkSync(
    join(root, "node_modules", "@oh-my-pi"),
    join(mnemopiWorkspace, "node_modules", "@oh-my-pi"),
    "dir",
  );
  const engine = JSON.parse(readFileSync(
    join(mnemopiWorkspace, "node_modules", "@oh-my-pi", "pi-mnemopi", "package.json"), "utf8",
  )) as { version?: string };
  if (engine.version !== mnemopiPin) {
    throw new Error("installed Mnemopi engine " + engine.version + " differs from pinned " + mnemopiPin);
  }
  // A HOME no other audit stage touches: the local-backend smoke and the
  // packaged evaluator share `home`, so a pristine tree here proves the
  // selected Mnemopi backend alone decides what ever appears under ~/.pi.
  const mnemopiHome = join(workspace, "home-mnemopi");
  mkdirSync(join(mnemopiHome, ".pi", "agent"), { recursive: true });
  const settingsPath = join(mnemopiHome, ".pi", "agent", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    smartCompact: { memoryBackend: "mnemopi", contextGraphEnabled: false },
  }));
  const memoryRoot = join(mnemopiHome, ".pi", "agent", "smart-compact-memory", "mnemopi");
  writeFileSync(join(mnemopiWorkspace, "smoke-mnemopi.mjs"), `
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
// The packed artifact is an extracted tarball, so this smoke resolves the
// consumer surface the way a real install would: from ./package/dist.
import extension from "./package/dist/index.js";
if (process.versions.bun !== undefined || typeof Bun !== "undefined") {
  throw new Error("Mnemopi smoke must execute under stock Node");
}
// PATH offers no Bun here, so the worker below can only run on the
// package-owned optional dependency — never on a globally installed Bun.
const strayBun = spawnSync("bun", ["--version"], { encoding: "utf8" });
if (!(strayBun.error && strayBun.error.code === "ENOENT")) {
  throw new Error("system Bun is reachable on PATH; the package-owned runtime proof is void");
}
const packageBun = ${JSON.stringify(packageBunPath)};
const pinnedBun = ${JSON.stringify(bunPin)};
if (!existsSync(packageBun) || statSync(packageBun).size <= 4096) {
  throw new Error("package-owned Bun binary is missing or a placeholder: " + packageBun);
}
const ownedBun = spawnSync(packageBun, ["--version"], { encoding: "utf8" });
if (ownedBun.status !== 0 || ownedBun.stdout.trim() !== pinnedBun) {
  throw new Error("package-owned Bun is not " + pinnedBun + ": " + (ownedBun.stdout || ownedBun.stderr || String(ownedBun.error)));
}
const memoryRoot = ${JSON.stringify(memoryRoot)};
const storeDir = path.relative(process.env.HOME, memoryRoot);
const storePrefix = storeDir + path.sep;
// The invariant under test is backend exclusivity inside the Pi data tree:
// only the Mnemopi store may appear there. Bun's own transpiler cache under
// ~/Library/Caches is runtime behavior of any Bun, lives in this throwaway
// HOME, and is not store or engine state.
const inPiTree = (entry) => entry === ".pi" || entry.startsWith(".pi" + path.sep);
const inStore = (entry) => entry === storeDir || entry.startsWith(storePrefix) || storeDir.startsWith(entry + path.sep);
const homeSnapshot = () => readdirSync(process.env.HOME, { recursive: true }).sort();
let modelRequests = 0;
const tripwire = createServer((request, response) => {
  modelRequests++;
  response.writeHead(503).end("unexpected model request");
});
const { promise: listening, resolve: started } = Promise.withResolvers();
tripwire.listen(0, "127.0.0.1", started);
await listening;
const base = "http://127.0.0.1:" + tripwire.address().port + "/";
process.env.MNEMOPI_EMBEDDINGS_VIA_API = "true";
process.env.MNEMOPI_EMBEDDING_MODEL = "text-embedding-3-small";
process.env.MNEMOPI_EMBEDDING_API_URL = base;
process.env.MNEMOPI_EMBEDDING_API_KEY = "synthetic-unused-key";
process.env.MNEMOPI_LLM_ENABLED = "true";
process.env.MNEMOPI_LLM_BASE_URL = base;
process.env.MNEMOPI_LLM_API_KEY = "synthetic-unused-key";
process.env.MNEMOPI_LLM_MODEL = "synthetic-unused-model";
const tools = new Map();
extension({ registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, on() {}, getActiveTools: () => [...tools.keys()], setActiveTools() {} });
const FACT = "Violet quartz boundaries guard the packed-artifact mnemopi smoke";
let confirmation = "";
const ctx = {
  cwd: process.cwd(),
  hasUI: true,
  ui: { confirm: async (_title, message) => { confirmation = message; return true; } },
  sessionManager: {
    getSessionId: () => "node-mnemopi-smoke",
    getSessionFile: () => process.cwd() + "/node-mnemopi-smoke.jsonl",
    getBranch: () => [{ id: "branch-head" }],
  },
};
const signal = new AbortController().signal;
const saveTool = tools.get("smart_save_memory");
const recallTool = tools.get("smart_recall");
const homeBefore = new Set(homeSnapshot());
const saved = await saveTool.execute("save", {
  kind: "decision", title: "Node mnemopi smoke", content: FACT,
}, signal, undefined, ctx);
if (saved.details.mnemopi.state !== "saved" || saved.details.mnemopi.existing) {
  throw new Error("Mnemopi save failed under Node: " + saved.content[0].text);
}
const dbPath = saved.details.mnemopi.dbPath;
if (!dbPath.startsWith(memoryRoot)) {
  throw new Error("Mnemopi database escaped the isolated HOME store: " + dbPath);
}
if (!confirmation.includes(dbPath)) {
  throw new Error("host confirmation did not name the Mnemopi database");
}
if (readFileSync(dbPath).subarray(0, 15).toString() !== "SQLite format 3") {
  throw new Error("Mnemopi store is not a real SQLite database: " + dbPath);
}
if ((statSync(dbPath).mode & 0o777) !== 0o600) {
  throw new Error("Mnemopi store is not private (0600): " + dbPath);
}
const recalled = await recallTool.execute("recall", { query: "violet quartz" }, signal, undefined, ctx);
const facts = recalled.details.mnemopi.facts;
if (facts.length !== 1 || facts[0].id !== saved.details.mnemopi.id || !facts[0].content.includes(FACT)) {
  throw new Error("Mnemopi recall failed under Node: " + recalled.content[0].text);
}
const resolved = await saveTool.execute("resolve", {
  status: "resolved", ref: saved.details.ref,
}, signal, undefined, ctx);
if (resolved.details.mnemopi.closed !== true) {
  throw new Error("Mnemopi resolve failed under Node: " + resolved.content[0].text);
}
const afterResolve = await recallTool.execute("recall", { query: "violet quartz" }, signal, undefined, ctx);
if (afterResolve.details.mnemopi.facts.length !== 0) {
  throw new Error("resolved Mnemopi fact is still recallable under Node");
}
const strayFiles = homeSnapshot().filter(entry => !homeBefore.has(entry) && inPiTree(entry) && !inStore(entry));
if (strayFiles.length) {
  throw new Error("Mnemopi run wrote outside its store; the unselected local engine/graph must not start: " + strayFiles.join(", "));
}
if (existsSync(path.join(process.env.HOME, ".pi", "agent", ".cache", "smart-compact", "context-graph.sqlite"))) {
  throw new Error("local context graph started while mnemopi is the selected backend");
}
const { promise: tripwireClosed, resolve: tripwireStopped } = Promise.withResolvers();
tripwire.close(tripwireStopped);
await tripwireClosed;
if (modelRequests !== 0) {
  throw new Error("Mnemopi made " + modelRequests + " model/network request(s); the engine must stay offline");
}
if (existsSync(path.join(process.env.HOME, ".omp", "cache", "fastembed-runtime"))) {
  throw new Error("Mnemopi downloaded an embedding runtime into HOME");
}
console.log("installed Node Mnemopi smoke passed on package-owned Bun " + pinnedBun + " with no Bun on PATH: " + dbPath);
`);
  run(["node", "smoke-mnemopi.mjs"], mnemopiWorkspace, { PATH: bunFreePath(), HOME: mnemopiHome });

  // Negative path: with the optional engine unresolvable the worker dies on
  // import, so the host must fail closed BEFORE sending any memory request —
  // FAILED, never UNKNOWN — and no store may appear. The frozen workspace's
  // bun install legitimately provides the packed optional dependency as an
  // ancestor node_modules, so this runs from a separate temp tree that offers
  // the peers but no engine anywhere the worker could resolve.
  const missingWorkspace = mkdtempSync(join(tmpdir(), "pi-smart-compact-mnemopi-missing-"));
  try {
    mkdirSync(join(missingWorkspace, "node_modules"), { recursive: true });
    run(["tar", "-xzf", tarball, "-C", missingWorkspace]);
    for (const peer of Object.keys(sourceManifest.peerDependencies)) {
      const link = join(missingWorkspace, "node_modules", peer);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(root, "node_modules", peer), link, "dir");
    }
    writeFileSync(join(missingWorkspace, "smoke-mnemopi-missing.mjs"), `
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import extension from "./package/dist/index.js";
const tools = new Map();
extension({ registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, on() {}, getActiveTools: () => [...tools.keys()], setActiveTools() {} });
const storeRoot = ${JSON.stringify(memoryRoot)};
const before = readdirSync(storeRoot, { recursive: true }).sort();
const ctx = {
  cwd: process.cwd(),
  hasUI: true,
  ui: { confirm: async () => true },
  sessionManager: {
    getSessionId: () => "node-mnemopi-missing",
    getSessionFile: () => process.cwd() + "/node-mnemopi-missing.jsonl",
    getBranch: () => [{ id: "branch-head" }],
  },
};
const outcome = await tools.get("smart_save_memory").execute("save", {
  kind: "decision", title: "Missing engine", content: "Violet quartz missing-engine fact",
}, new AbortController().signal, undefined, ctx);
const mnemopi = outcome.details.mnemopi;
if (mnemopi.state !== "failed") {
  throw new Error("missing engine must fail closed, got " + mnemopi.state + ": " + outcome.content[0].text);
}
assert.deepEqual(readdirSync(storeRoot, { recursive: true }).sort(), before, "missing engine created memory files or locks");
console.log("missing engine fails closed without memory filesystem changes");
`);
    const missingCwd = join(missingWorkspace, "missing-cwd");
    mkdirSync(missingCwd, { recursive: true });
    run(["node", join(missingWorkspace, "smoke-mnemopi-missing.mjs")], missingCwd, { HOME: mnemopiHome });

    // Missing runtime, not engine: no package-owned Bun anywhere in this
    // tree and no Bun on PATH, so the spawn itself must fail closed with
    // the explicit package-owned-dependency error and touch nothing.
    writeFileSync(join(missingWorkspace, "smoke-mnemopi-no-bun.mjs"), `
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import extension from "./package/dist/index.js";
const strayBun = spawnSync("bun", ["--version"], { encoding: "utf8" });
if (!(strayBun.error && strayBun.error.code === "ENOENT")) {
  throw new Error("missing-Bun negative must run without any Bun on PATH");
}
const tools = new Map();
extension({ registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, on() {}, getActiveTools: () => [...tools.keys()], setActiveTools() {} });
const storeRoot = ${JSON.stringify(memoryRoot)};
const before = readdirSync(storeRoot, { recursive: true }).sort();
const ctx = {
  cwd: process.cwd(),
  hasUI: true,
  ui: { confirm: async () => true },
  sessionManager: {
    getSessionId: () => "node-mnemopi-no-bun",
    getSessionFile: () => process.cwd() + "/node-mnemopi-no-bun.jsonl",
    getBranch: () => [{ id: "branch-head" }],
  },
};
const outcome = await tools.get("smart_save_memory").execute("save", {
  kind: "decision", title: "Missing Bun", content: "Violet quartz missing-bun fact",
}, new AbortController().signal, undefined, ctx);
const mnemopi = outcome.details.mnemopi;
const evidence = outcome.content[0].text + " " + JSON.stringify(mnemopi);
if (mnemopi.state !== "failed" || !/package-owned Bun dependency/.test(evidence)) {
  throw new Error("missing Bun must fail closed naming the package-owned dependency, got " + mnemopi.state + ": " + outcome.content[0].text);
}
if (readdirSync(storeRoot, { recursive: true }).sort().join("\\n") !== before.join("\\n")) {
  throw new Error("missing-Bun failure created memory files or locks");
}
console.log("missing package-owned Bun fails closed with the explicit dependency error");
`);
    run(["node", join(missingWorkspace, "smoke-mnemopi-no-bun.mjs")], missingCwd, { PATH: bunFreePath(), HOME: mnemopiHome });
  } finally {
    rmSync(missingWorkspace, { recursive: true, force: true });
  }
  rmSync(settingsPath);
  run(["bun", "run", join(root, "scripts", "provider-eval.ts"), "--min-samples=5"]);
  run(["bun", "run", join(root, "scripts", "telemetry-report.ts"), "--min-canary-runs=5"]);

  console.log("Release artifact audit passed: " + sourceManifest.name + "@" + sourceManifest.version +
    " (" + files.length + " packed files, runtime-only dist; frozen install, source eval CLIs, Node Mnemopi worker on package-owned Bun " +
    bunPin + " with no Bun on PATH, missing-engine and missing-Bun negatives verified)");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
