/**
 * Live task-eval tools run in fresh, networkless Linux containers, never on the host.
 * Bind only the fixture and an owned HOME; image rootfs is read-only, capabilities
 * are dropped, and PID/memory/CPU limits apply. Resolve the local image to its ID
 * before running anything. No Docker socket, host credentials or environment enter
 * a container. Native macOS sandbox-exec is insufficient: raw KERN_PROCARGS2 can
 * read other same-UID process environments despite its sysctl policy.
 *
 * Commands are serialized and their entire containers are removed on exit, abort
 * or timeout (including detached children). File adapters preserve bytes and have
 * bounded time/output. validate() must pass before any provider request.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGrepToolDefinition, DEFAULT_MAX_BYTES, defineTool, truncateHead } from "@earendil-works/pi-coding-agent";

const IMAGE = "pi-smart-compact-task-eval:runtime-1";
const SHELL = "/bin/bash";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const GREP_DEFAULT_LIMIT = 100;
const FILE_OP_TIMEOUT_MS = 30_000;
const BASH_DEFAULT_TIMEOUT_S = 300;
const ENV_KEYS = Object.freeze(["HOME", "LANG", "LC_ALL", "NO_COLOR", "PATH", "TERM", "TMPDIR"]);
const POLICY = Object.freeze([
 "--rm", "--interactive", "--init", "--pull=never", "--network=none", "--read-only",
 "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=512m", "--cpus=1",
]);

export interface SandboxRunResult {
 readonly status: number | null;
 readonly signal: NodeJS.Signals | null;
 readonly timedOut: boolean;
 readonly stdout: string;
 readonly stderr: string;
}

export interface SandboxRunOptions {
 /** Must resolve inside the fixture. */
 readonly cwd?: string;
 readonly input?: string | Buffer;
 readonly timeoutMs?: number;
 readonly signal?: AbortSignal;
 readonly onData?: (data: Buffer) => void;
}

/** Structural matches of Pi 0.87 tool operations. */
export interface SandboxOperations {
 readonly bash: {
  exec(command: string, cwd: string, options: {
   onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv;
  }): Promise<{ exitCode: number | null }>;
 };
 readonly read: { readFile(absolutePath: string): Promise<Buffer>; access(absolutePath: string): Promise<void> };
 readonly write: { writeFile(absolutePath: string, content: string): Promise<void>; mkdir(dir: string): Promise<void> };
}

export interface SandboxReceipt {
 readonly ok: true;
 readonly backend: "docker";
 readonly platform: "linux";
 readonly imageId: string;
 readonly policySha256: string;
 readonly checks: readonly string[];
}

export interface EvalSandbox {
 readonly root: string;
 run(argv: readonly string[], options?: SandboxRunOptions): Promise<SandboxRunResult>;
 validate(): Promise<SandboxReceipt>;
 readonly operations: SandboxOperations;
 // biome-ignore lint/suspicious/noExplicitAny: Pi's erased tool-registry type.
 readonly grepTool: ToolDefinition<any, any, any>;
 /** Removes only this sandbox's containers and HOME, never its fixture. */
 dispose(): void;
}

export interface EvalSandboxOptions {
 readonly root: string;
 /** Used only to locate the local Docker context, never mounted or passed to tools. */
 readonly dockerConfigHome?: string;
}

function isInside(root: string, target: string): boolean {
 const rel = path.relative(root, target);
 return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function createEvalSandbox(options: EvalSandboxOptions): EvalSandbox {
 const docker = Bun.which("docker");
 if (!docker) throw new Error("task-eval sandbox: Docker CLI required");
 let host = process.env.DOCKER_HOST;
 if (!host) {
  const context = spawnSync(docker, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
   encoding: "utf8", timeout: 10_000,
   env: { PATH: process.env.PATH, HOME: options.dockerConfigHome ?? os.homedir() },
  });
  if (context.status !== 0) throw new Error("task-eval sandbox: cannot resolve local Docker context; set DOCKER_HOST");
  host = context.stdout.trim();
 }
 if (!host.startsWith("unix:///")) throw new Error("task-eval sandbox: a local Unix-socket Docker daemon is required");
 const root = fs.realpathSync(options.root);
 if (!fs.statSync(root).isDirectory()) throw new Error(`task-eval sandbox: not a directory: ${root}`);
 // Docker --mount uses commas as separators. Reject ambiguous paths, not broadened mounts.
 if (root.includes(",")) throw new Error("task-eval sandbox: fixture path cannot contain a comma");
 const owned = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-eval-sandbox-")));
 const home = path.join(owned, "home");
 fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
 const clientEnv = { PATH: process.env.PATH, HOME: home, LANG: "C" };
 const control = (args: readonly string[]) => spawnSync(docker, ["--host", host, ...args], {
  encoding: "utf8", env: clientEnv, timeout: 15_000, maxBuffer: 512 * 1024,
 });
 let imageId: string;
 try {
  const image = control(["image", "inspect", "--format", "{{.Id}} {{.Os}}", IMAGE]);
  if (image.status !== 0 || !/^sha256:[a-f0-9]{64} linux$/.test(image.stdout.trim()))
   throw new Error(`task-eval sandbox: build ${IMAGE} from scripts/task-eval.Dockerfile and start the local Linux daemon`);
  imageId = image.stdout.trim().split(" ")[0]!;
  if (home.includes(",")) throw new Error("task-eval sandbox: HOME path cannot contain a comma");
 } catch (error) {
  fs.rmSync(owned, { recursive: true, force: true });
  throw error;
 }
 const env = Object.freeze({
  HOME: home, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NO_COLOR: "1",
  PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "dumb", TMPDIR: path.join(home, "tmp"),
 });
 const user = `${process.getuid!()}:${process.getgid!()}`;
 const policySha256 = createHash("sha256").update(JSON.stringify({
  flags: POLICY, imageId, user, envKeys: ENV_KEYS, mounts: ["fixture", "owned-home"], entrypoint: "/usr/bin/env -i", lifecycle: "create/start/remove",
 })).digest("hex");
 const containers = new Set<string>();
 let disposed = false;
 let sequence = 0;
 const prefix = `task-eval-${process.pid}-${path.basename(owned).toLowerCase()}`;
 const remove = (name: string) => {
  if (!containers.has(name)) return;
  const result = control(["container", "rm", "--force", name]);
  if (result.status !== 0 && !result.stderr.includes(`No such container: ${name}`))
   throw new Error(`task-eval sandbox: could not remove owned container ${name}`);
  containers.delete(name);
 };
 const lexicalRoot = path.resolve(options.root);
 const fixturePath = (target: string, base = root): string => {
  const abs = path.resolve(base, target);
  for (const top of [root, lexicalRoot]) if (isInside(top, abs)) return path.relative(top, abs) || ".";
  throw new Error(`EACCES: path outside fixture: '${target}'`);
 };
 interface Captured {
  status: number | null; signal: NodeJS.Signals | null; timedOut: boolean; overflow: boolean;
  stdout: Buffer; stderr: Buffer;
 }
 const exec = (argv: readonly string[], opts: SandboxRunOptions): Promise<Captured> => {
  if (disposed) throw new Error("task-eval sandbox: disposed");
  if (!argv.length) throw new Error("task-eval sandbox: empty argv");
  const cwd = fs.realpathSync(path.resolve(root, opts.cwd ?? "."));
  if (!isInside(root, cwd)) throw new Error(`task-eval sandbox: cwd outside fixture: ${opts.cwd}`);
  if (opts.signal?.aborted) throw new Error("aborted");
  const name = `${prefix}-${++sequence}`;
  containers.add(name);
  // Create before attach/start: cancelling a pending `docker run` can race its
  // create request and leave an untracked, running container after removal.
  const created = control(["container", "create", ...POLICY, "--name", name, "--user", user,
   "--mount", `type=bind,src=${root},dst=${root}`,
   "--mount", `type=bind,src=${home},dst=${home}`,
   "--workdir", cwd, "--entrypoint", "/usr/bin/env", imageId, "-i",
   ...Object.entries(env).map(([key, value]) => `${key}=${value}`), ...argv,
  ]);
  if (created.status !== 0 || opts.signal?.aborted) {
   remove(name);
   throw new Error(opts.signal?.aborted ? "aborted" : `task-eval sandbox: container creation failed: ${created.stderr.slice(0, 300)}`);
  }
  const { promise, resolve, reject } = Promise.withResolvers<Captured>();
  const child = spawn(docker, ["--host", host, "container", "start", "--attach", "--interactive", name],
   { env: clientEnv, cwd: root, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let size = 0;
  let overflow = false;
  let timedOut = false;
  let cleanupError: unknown;
  const stop = () => {
   try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
   try { remove(name); } catch (error) { cleanupError = error; }
  };
  const collect = (sink: Buffer[]) => (chunk: Buffer) => {
   size += chunk.length;
   if (size <= MAX_OUTPUT_BYTES) {
    sink.push(chunk);
    opts.onData?.(chunk);
   } else if (!overflow) {
    overflow = true;
    stop();
   }
  };
  child.stdout.on("data", collect(out));
  child.stderr.on("data", collect(err));
  const timer = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs ?? BASH_DEFAULT_TIMEOUT_S * 1000);
  opts.signal?.addEventListener("abort", stop, { once: true });
  const finish = () => {
   clearTimeout(timer);
   opts.signal?.removeEventListener("abort", stop);
   try { remove(name); } catch (error) { cleanupError = error; }
  };
  child.on("error", (error) => { finish(); reject(error); });
  child.on("close", (status, signal) => {
   finish();
   if (cleanupError) return reject(cleanupError);
   if (opts.signal?.aborted) return reject(new Error("aborted"));
   resolve({ status, signal, timedOut, overflow, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
  });
  child.stdin.on("error", () => { });
  child.stdin.end(opts.input ?? "");
  return promise;
 };
 // Bound aggregate resources and preserve ordering for simultaneous model tool calls.
 let queue: Promise<unknown> = Promise.resolve();
 const serial = <T>(task: () => Promise<T>): Promise<T> => {
  const next = queue.then(task);
  queue = next.catch(() => { });
  return next;
 };
 const run = (argv: readonly string[], opts: SandboxRunOptions = {}): Promise<SandboxRunResult> =>
  serial(() => exec(argv, opts)).then((r) => ({
   status: r.status, signal: r.signal, timedOut: r.timedOut,
   stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"),
  }));
 const fileOp = async (argv: readonly string[], target: string, input?: string): Promise<Buffer> => {
  const r = await serial(() => exec(argv, { input, timeoutMs: FILE_OP_TIMEOUT_MS }));
  if (r.overflow) throw new Error(`EFBIG: '${target}' exceeds ${MAX_OUTPUT_BYTES} bytes`);
  if (r.timedOut) throw new Error(`ETIMEDOUT: '${target}'`);
  if (r.status !== 0) throw new Error(`EACCES: '${target}': ${r.stderr.toString("utf8").trim().slice(0, 500)}`);
  return r.stdout;
 };
 const operations: SandboxOperations = Object.freeze({
  bash: Object.freeze({
   // Pi's shell environment is deliberately not forwarded.
   exec: async (command: string, cwd: string, o: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number }) => {
    const seconds = o.timeout && o.timeout > 0 ? o.timeout : BASH_DEFAULT_TIMEOUT_S;
    const result = await serial(() => exec([SHELL, "-c", command], { cwd, onData: o.onData, signal: o.signal, timeoutMs: seconds * 1000 }));
    if (result.timedOut) throw new Error(`timeout:${seconds}`);
    if (result.overflow) throw new Error(`EFBIG: command output exceeds ${MAX_OUTPUT_BYTES} bytes`);
    return { exitCode: result.status };
   },
  }),
  read: Object.freeze({
   readFile: async (absolutePath: string) => fileOp(["/bin/cat", "--", fixturePath(absolutePath)], absolutePath),
   access: async (absolutePath: string) => {
    await fileOp(["/bin/dd", `if=${fixturePath(absolutePath)}`, "of=/dev/null", "bs=1", "count=1"], absolutePath);
   },
  }),
  write: Object.freeze({
   writeFile: async (absolutePath: string, content: string) => {
    await fileOp(["/bin/sh", "-c", 'cat > "$1"', "sh", fixturePath(absolutePath)], absolutePath, content);
   },
   mkdir: async (dir: string) => { await fileOp(["/bin/mkdir", "-p", "--", fixturePath(dir)], dir); },
  }),
 });
 const baseGrep = createGrepToolDefinition(root);
 const grepTool = defineTool({
  ...baseGrep,
  async execute(_toolCallId, input, signal, _onUpdate, ctx) {
   const limit = Math.max(1, input.limit ?? GREP_DEFAULT_LIMIT);
   const rel = fixturePath(input.path || ".", ctx?.cwd || root);
   const rgArgs = ["rg", "--line-number", "--no-heading", "--with-filename", "--color=never", "--hidden", "--max-columns", "500", "--max-columns-preview"];
   if (input.ignoreCase) rgArgs.push("--ignore-case");
   if (input.literal) rgArgs.push("--fixed-strings");
   if (input.glob) rgArgs.push("--glob", input.glob);
   if (input.context && input.context > 0) rgArgs.push("--context", String(input.context));
   rgArgs.push("--", input.pattern, rel);
   const result = await run(rgArgs, { signal, timeoutMs: 30_000 });
   if (result.status === 1) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
   if (result.status !== 0) throw new Error(result.stderr.trim() || `ripgrep exited with ${result.status ?? result.signal}`);
   const lines: string[] = [];
   const output = result.stdout.split("\n");
   let matches = 0;
   for (const line of output) {
    if (matches >= limit || line === "") break;
    if (/^.+?:\d+:/.test(line)) matches++;
    lines.push(rel === "." ? line.replace(/^\.\//, "") : line);
   }
   const matchLimitReached = output.filter((l) => /^.+?:\d+:/.test(l)).length > limit;
   const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: DEFAULT_MAX_BYTES });
   let text = truncation.content;
   if (matchLimitReached) text += `\n\n[${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern]`;
   if (truncation.truncated) text += `\n\n[${DEFAULT_MAX_BYTES / 1024}KB limit reached]`;
   return {
    content: [{ type: "text", text }],
    details: matchLimitReached || truncation.truncated ? {
     ...(matchLimitReached ? { matchLimitReached: limit } : {}), ...(truncation.truncated ? { truncation } : {}),
    } : undefined,
   };
  },
 });
 const validate = async (): Promise<SandboxReceipt> => {
  const checks: string[] = [];
  const pass = (id: string, ok: boolean, detail = "") => {
   if (!ok) throw new Error(`task-eval sandbox validation failed: ${id}${detail ? ` (${detail.slice(0, 300)})` : ""}`);
   checks.push(id);
  };
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-eval-sandbox-sentinel-")));
  const probe = `.sandbox-probe-${process.pid}-${Date.now()}`;
  const probeDir = path.join(root, probe);
  const secret = path.join(outside, ".env");
  const sentinel = `SENTINEL-${createHash("sha256").update(`${Math.random()}`).digest("hex").slice(0, 16)}`;
  const server = net.createServer((socket) => socket.end(sentinel));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("task-eval sandbox: local sentinel did not bind");
  const target = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
   cwd: outside, env: { TASK_EVAL_PRIVATE_SENTINEL: sentinel }, stdio: "ignore",
  });
  const targetExit = new Promise<void>((resolve) => target.once("exit", () => resolve()));
  try {
   await new Promise<void>((resolve, reject) => { target.once("spawn", resolve); target.once("error", reject); });
   fs.writeFileSync(secret, `TOKEN=${sentinel}\n`, { mode: 0o600 });
   fs.mkdirSync(probeDir);
   fs.symlinkSync(secret, path.join(probeDir, "link-file"));
   fs.symlinkSync(outside, path.join(probeDir, "link-dir"));
   const w = await run(["node", "-e", `require("fs").writeFileSync(${JSON.stringify(`${probe}/w.txt`)}, "ok")`]);
   pass("node-writes-fixture", w.status === 0 && fs.readFileSync(path.join(probeDir, "w.txt"), "utf8") === "ok", w.stderr);
   const b = await run([SHELL, "-c", `cd ${probe} && printf hi > b.txt && cat b.txt w.txt`]);
   pass("bash-reads-writes-fixture", b.status === 0 && b.stdout === "hiok", b.stderr);
   const bun = await run(["bun", "-e", `await Bun.write(${JSON.stringify(`${probe}/bun.txt`)}, "bun")`]);
   pass("bun-writes-fixture", bun.status === 0 && fs.readFileSync(path.join(probeDir, "bun.txt"), "utf8") === "bun", bun.stderr);
   const e = await run(["/usr/bin/env"]);
   const keys = e.stdout.trim().split("\n").map((l) => l.split("=")[0]);
   pass("env-exact", e.status === 0 && keys.sort().join() === ENV_KEYS.join() && !e.stdout.includes(sentinel), keys.join());
   const proc = await run(["node", "-e", `
        const fs=require("fs");let seen=0,leaked=false;
        for(const pid of fs.readdirSync("/proc").filter(p=>/^\\d+$/.test(p))){
          try{const data=fs.readFileSync("/proc/"+pid+"/environ");seen++;leaked ||= data.includes(${JSON.stringify(sentinel)});}catch{}
        }
        if(seen && !leaked && process.platform==="linux") console.log("host-sentinel-hidden");else process.exit(1);
      `]);
   pass("host-process-environment-hidden", proc.status === 0 && proc.stdout === "host-sentinel-hidden\n", proc.stderr);
   const denied = async (id: string, argv: string[]) => {
    const r = await run(argv, { timeoutMs: 10_000 });
    pass(id, !r.timedOut && r.status !== null && r.status !== 0 && !`${r.stdout}${r.stderr}`.includes(sentinel), `status ${r.status}`);
   };
   await denied("deny-read-outside", ["/bin/cat", secret]);
   await denied("deny-read-dotdot", ["/bin/cat", path.relative(root, secret)]);
   await denied("deny-read-symlink-file", ["/bin/cat", `${probe}/link-file`]);
   await denied("deny-read-symlink-dir", ["/bin/cat", `${probe}/link-dir/.env`]);
   await denied("deny-node-read-symlink", ["node", "-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(`${probe}/link-file`)}))`]);
   await denied("deny-write-outside", [SHELL, "-c", `echo x > ${JSON.stringify(path.join(outside, "w"))}`]);
   await denied("deny-write-symlink-dir", [SHELL, "-c", `echo x > ${probe}/link-dir/w`]);
   await denied("read-only-rootfs", [SHELL, "-c", "echo x > /task-eval-forbidden"]);
   await denied("deny-network-host-localhost", ["node", "-e", `const s=require("net").connect(${address.port},"127.0.0.1");s.on("data",()=>process.exit(0));s.on("error",()=>process.exit(3))`]);
   await denied("deny-bash-dev-tcp", [SHELL, "-c", `exec 3<>/dev/tcp/127.0.0.1/${address.port}`]);
   await operations.write.mkdir(path.join(probeDir, "op", "nested"));
   await operations.write.writeFile(path.join(probeDir, "op", "nested", "f.txt"), "op-ok");
   pass("write-op-fixture", (await operations.read.readFile(path.join(probeDir, "op", "nested", "f.txt"))).toString() === "op-ok");
   const opDenied = async (id: string, attempt: () => Promise<unknown>) => {
    const rejected = await attempt().then(() => false, () => true);
    pass(id, rejected);
   };
   await opDenied("read-op-deny-symlink", () => operations.read.readFile(path.join(probeDir, "link-file")));
   await opDenied("read-op-deny-absolute", () => operations.read.readFile(secret));
   await opDenied("access-op-deny-symlink", () => operations.read.access(path.join(probeDir, "link-file")));
   await opDenied("write-op-deny-symlink-file", () => operations.write.writeFile(path.join(probeDir, "link-file"), "x"));
   await opDenied("mkdir-op-deny-symlink-dir", () => operations.write.mkdir(path.join(probeDir, "link-dir", "made")));
   await opDenied("read-op-deny-system-path", () => operations.read.readFile("/etc/passwd"));
   pass("outside-unmodified", fs.readFileSync(secret, "utf8") === `TOKEN=${sentinel}\n` && fs.readdirSync(outside).join() === ".env");
   const grep = (params: Record<string, unknown>) => grepTool
    .execute("probe", params as never, undefined, undefined, undefined as never)
    .then((r) => r.content.map((c) => ("text" in c ? c.text : "")).join(), (error: Error) => `error:${error.message}`);
   const found = await grep({ pattern: "op-ok", path: probe });
   pass("grep-finds-fixture", found.includes("op/nested/f.txt:1:op-ok"), found);
   for (const [id, params] of [
    ["grep-deny-absolute", { pattern: "SENTINEL", path: outside }],
    ["grep-deny-symlink-dir", { pattern: "SENTINEL", path: `${probe}/link-dir` }],
    ["grep-deny-symlink-file", { pattern: "SENTINEL", path: `${probe}/link-file` }],
    ["grep-no-follow-in-tree", { pattern: "SENTINEL", path: probe }],
   ] as const) pass(id, !(await grep(params)).includes(sentinel));
   const [slow, , readBack, foundAgain] = await Promise.all([
    run([SHELL, "-c", `/bin/sleep 0.2 && printf done > ${probe}/slow.txt`]),
    operations.write.writeFile(path.join(probeDir, "par.txt"), "par"),
    operations.read.readFile(path.join(probeDir, "w.txt")).then(String),
    grep({ pattern: "op-ok", path: probe }),
   ]);
   pass("concurrent-calls-serialized", slow.status === 0 && fs.readFileSync(path.join(probeDir, "slow.txt"), "utf8") === "done" && readBack === "ok" && foundAgain.includes("op-ok"));
   const late = path.join(probeDir, "late.txt");
   const childCode = `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(late)},"escaped"),1000)`;
   const daemon = await run(["node", "-e", `const c=require("child_process").spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{detached:true,stdio:"ignore"});c.unref();console.log(c.pid)`]);
   await sleep(1200);
   pass("reap-detached-container-processes", daemon.status === 0 && Number(daemon.stdout.trim()) > 0 && !fs.existsSync(late));
  } finally {
   target.kill("SIGKILL");
   if (target.pid) await targetExit;
   server.close();
   fs.rmSync(probeDir, { recursive: true, force: true });
   fs.rmSync(outside, { recursive: true, force: true });
  }
  return Object.freeze({ ok: true, backend: "docker", platform: "linux", imageId, policySha256, checks: Object.freeze(checks) });
 };
 return Object.freeze({
  root, run, validate, operations, grepTool, dispose: () => {
   disposed = true;
   for (const name of containers) remove(name);
   fs.rmSync(owned, { recursive: true, force: true });
  }
 });
}
