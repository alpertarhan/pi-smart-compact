import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	createBashToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createEvalSandbox, type EvalSandbox } from "../scripts/task-eval-sandbox.ts";

const IMAGE = "pi-smart-compact-task-eval:runtime-1";
const inspected = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], { encoding: "utf8", timeout: 15_000 });
// Portable: runs only where the Docker daemon answers and the agreed image is built.
const imageId = inspected.status === 0 ? inspected.stdout.trim() : "";
const CRED = "SYNTHETIC-CREDENTIAL-SENTINEL";
const ENV_KEYS = ["HOME", "LANG", "LC_ALL", "NO_COLOR", "PATH", "TERM", "TMPDIR"];

type ToolResult = { content: Array<{ type: string; text?: string }> };
const call = (tool: { execute: (...a: never[]) => Promise<unknown> }, params: object) =>
	(tool.execute as (...a: unknown[]) => Promise<ToolResult>)("t", params, undefined, undefined, undefined).then(
		(r) => r.content.map((c) => c.text ?? "").join(""),
		(error: Error) => `error:${error.message}`,
	);

/** Every file below `dir` (not following symlinks) with its bytes, for before/after comparison. */
const snapshot = (dir: string): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
		const full = path.join(entry.parentPath, entry.name);
		const key = path.relative(dir, full);
		if (entry.isSymbolicLink()) out[key] = `-> ${fs.readlinkSync(full)}`;
		else if (entry.isFile()) out[key] = fs.readFileSync(full).toString("hex");
		else if (entry.isDirectory()) out[key] = "<dir>";
		else out[key] = "<special>";
	}
	return out;
};

const waitFor = async (file: string, ms: number) => {
	for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(50)) if (fs.existsSync(file)) return true;
	return false;
};

describe.skipIf(!imageId)("task-eval docker sandbox", () => {
	const scratches: string[] = [];
	const sandboxes: EvalSandbox[] = [];
	afterEach(() => {
		for (const s of sandboxes.splice(0)) s.dispose();
		for (const s of scratches.splice(0)) fs.rmSync(s, { recursive: true, force: true });
	});

	// Mirrors the live layout: fixture at <scratch>/project, private agent dir as a sibling.
	const setup = () => {
		const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-test-")));
		scratches.push(scratch);
		const root = path.join(scratch, "project");
		const credDir = path.join(scratch, ".pi", "agent");
		const cred = path.join(credDir, "auth.json");
		fs.mkdirSync(root);
		fs.mkdirSync(credDir, { recursive: true });
		fs.writeFileSync(cred, CRED, { mode: 0o600 });
		fs.symlinkSync(cred, path.join(root, "auth-link.json"));
		fs.symlinkSync("../.pi/agent/auth.json", path.join(root, "auth-rel-link.json"));
		fs.symlinkSync(credDir, path.join(root, "agent-dir-link"));
		const sandbox = createEvalSandbox({ root });
		sandboxes.push(sandbox);
		return { scratch, root, cred, sandbox };
	};


	it("runs Pi read/write/bash/grep in the fixture and confines every escape attempt", async () => {
		const { scratch, root, cred, sandbox } = setup();
		await sandbox.validate();
		const read = createReadToolDefinition(root, { operations: sandbox.operations.read });
		const write = createWriteToolDefinition(root, { operations: sandbox.operations.write });
		const bash = createBashToolDefinition(root, { operations: sandbox.operations.bash });
		const credStore = path.join(scratch, ".pi");
		const before = snapshot(credStore);
		const siblings = fs.readdirSync(scratch).sort();

		await call(write, { path: "src/a.js", content: "module.exports = 41 + 1;\n" });
		expect(fs.readFileSync(path.join(root, "src/a.js"), "utf8")).toBe("module.exports = 41 + 1;\n");
		// Runs as the host user, so fixture files stay host-owned and removable.
		expect(fs.statSync(path.join(root, "src/a.js")).uid).toBe(process.getuid?.() ?? -1);
		expect(await call(read, { path: path.join(root, "src/a.js") })).toContain("module.exports = 41 + 1;");
		expect(await call(bash, { command: "node -e 'console.log(require(\"./src/a.js\"))' && printf ok > src/b.txt" })).toBe("42\n");
		expect(fs.readFileSync(path.join(root, "src/b.txt"), "utf8")).toBe("ok");
		expect(await call(sandbox.grepTool, { pattern: "41" })).toBe("src/a.js:1:module.exports = 41 + 1;");

		const attempts = await Promise.all([
			call(read, { path: "auth-link.json" }),
			call(read, { path: "auth-rel-link.json" }),
			call(read, { path: "agent-dir-link/auth.json" }),
			call(read, { path: cred }),
			call(read, { path: "../.pi/agent/auth.json" }),
			call(bash, {
				command: `cat auth-link.json auth-rel-link.json agent-dir-link/auth.json ${cred} ../.pi/agent/auth.json; ls -aR .. ${os.homedir()}; true`,
			}),
			call(bash, { command: `grep -rsI --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev ${CRED.slice(0, 9)} / 2>/dev/null; true` }),
			call(bash, { command: `echo x > ../escape.txt; echo x > agent-dir-link/escape.txt; echo x > auth-link.json; echo x > ${cred}; true` }),
			call(sandbox.grepTool, { pattern: "SENTINEL", path: ".." }),
			call(sandbox.grepTool, { pattern: "SENTINEL", path: path.dirname(cred) }),
			call(sandbox.grepTool, { pattern: "SENTINEL", path: "auth-link.json" }),
			call(sandbox.grepTool, { pattern: "SENTINEL", path: "agent-dir-link" }),
			call(sandbox.grepTool, { pattern: "SENTINEL" }),
			call(write, { path: "../.pi/agent/auth.json", content: "overwritten" }),
			call(write, { path: cred, content: "overwritten" }),
			call(write, { path: "auth-link.json", content: "overwritten" }),
			call(write, { path: "auth-rel-link.json", content: "overwritten" }),
			call(write, { path: "agent-dir-link/new.json", content: "overwritten" }),
			call(write, { path: "../escape.txt", content: "overwritten" }),
			// Parallel normal calls still work alongside the denied ones.
			call(read, { path: "src/b.txt" }),
		]);
		for (const output of attempts) expect(output).not.toContain(CRED);
		expect(attempts.at(-1)).toContain("ok");
		expect(snapshot(credStore)).toEqual(before);
		expect(fs.readdirSync(scratch).sort()).toEqual(siblings);
		expect(fs.readFileSync(cred, "utf8")).toBe(CRED);
	}, 180_000);

	it("reads binary bytes exactly and bounds a stalled FIFO read", async () => {
		const { root, sandbox } = setup();
		const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256));
		fs.writeFileSync(path.join(root, "blob.bin"), bytes);
		expect(Buffer.compare(await sandbox.operations.read.readFile(path.join(root, "blob.bin")), bytes)).toBe(0);

		const fifo = path.join(root, "stalled.fifo");
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		const started = Date.now();
		const outcome = await sandbox.operations.read.readFile(fifo).then(
			(b) => `resolved:${b.length}`,
			() => "rejected",
		);
		// No writer ever opens the FIFO: the read must settle (not hang), yield no data, and not wedge the queue.
		expect(outcome === "rejected" || outcome === "resolved:0").toBe(true);
		expect(Date.now() - started).toBeLessThan(90_000);
		expect((await sandbox.run(["cat", "blob.bin"])).status).toBe(0);
	}, 120_000);

	it("gives subprocesses only the fixed environment, never the host's", async () => {
		const { root, sandbox } = setup();
		const bash = createBashToolDefinition(root, { operations: sandbox.operations.bash });
		const probe = `TASK_EVAL_SANDBOX_TEST_${process.pid}`;
		process.env[probe] = CRED;
		try {
			const direct = (await sandbox.run(["env"])).stdout;
			expect(direct.trim().split("\n").map((line) => line.split("=")[0]).sort()).toEqual(ENV_KEYS);
			expect(direct).not.toContain(CRED);
			// Through Pi's bash tool (which hands its host env to operations.exec); bash itself adds PWD/SHLVL/_.
			const viaPi = await call(bash, { command: "env" });
			const piKeys = viaPi.trim().split("\n").map((line) => line.split("=")[0]);
			expect(piKeys.filter((key) => !["PWD", "SHLVL", "_"].includes(key)).sort()).toEqual(ENV_KEYS);
			expect(viaPi).not.toContain(CRED);
		} finally {
			delete process.env[probe];
		}
	}, 60_000);

	it("cannot read other processes' environments via /proc", async () => {
		const { sandbox } = setup();
		const other = setup();
		const host = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)", CRED], {
			env: { TASK_EVAL_PRIVATE_SENTINEL: CRED },
			stdout: "ignore",
			stderr: "ignore",
		});
		// A concurrent call in a second sandbox holds the sentinel in its own environment and argv.
		const stop = new AbortController();
		const peer = other.sandbox
			.run(["bash", "-c", `touch ready; export TASK_EVAL_PRIVATE_SENTINEL=${CRED}; exec bash -c 'sleep 30; :' ${CRED}`], {
				timeoutMs: 60_000,
				signal: stop.signal,
			})
			.catch(() => undefined);
		try {
			expect(await waitFor(path.join(other.root, "ready"), 30_000)).toBe(true);
			const scan = await sandbox.run([
				"bash",
				"-c",
				"export SCAN_SELF_MARK=visible; for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do cat \"$f\"; echo; done 2>/dev/null | tr '\\0' '\\n'",
			]);
			// Positive control: the scan does read environments it is allowed to see (its own).
			expect(scan.stdout).toContain("SCAN_SELF_MARK=visible");
			expect(scan.stdout).not.toContain(CRED);
		} finally {
			host.kill();
			stop.abort();
			await Promise.all([host.exited, peer]);
		}
	}, 120_000);

	it("stops background side effects when a call ends, times out, or the sandbox is disposed", async () => {
		const { root, sandbox } = setup();
		const bash = createBashToolDefinition(root, { operations: sandbox.operations.bash });

		// Detached (setsid) job outlives a leader that exits immediately.
		const detached = await sandbox.run(["bash", "-c", "setsid bash -c 'sleep 2; echo late > detached.txt' >/dev/null 2>&1 < /dev/null & echo started"]);
		expect(detached.status).toBe(0);
		expect(detached.stdout).toBe("started\n");

		// Pi bash timeout with a background writer.
		await expect(bash.execute("timeout", { command: "(sleep 2; echo late > timeout.txt) & sleep 60", timeout: 1 },
			undefined, undefined, undefined as never)).rejects.toThrow();

		// Raw run timeout.
		const raw = await sandbox.run(["bash", "-c", "(sleep 2; echo late > raw-timeout.txt) & sleep 60"], { timeoutMs: 1_000 });
		expect(raw.timedOut).toBe(true);

		const home = (await sandbox.run(["bash", "-c", "printf %s \"$HOME\""])).stdout;
		expect(fs.existsSync(home)).toBe(true);
		// Dispose while a call is still running.
		const inFlight = sandbox
			.run(["bash", "-c", "touch disposing; (sleep 2; echo late > dispose.txt) & sleep 60"], { timeoutMs: 60_000 })
			.catch(() => undefined);
		expect(await waitFor(path.join(root, "disposing"), 30_000)).toBe(true);
		sandbox.dispose();
		await inFlight;
		expect(fs.existsSync(home)).toBe(false);

		// Real delay on purpose: the writers sleep inside containers on the platform clock, so only
		// wall time past their deadline proves the delayed writes can no longer happen.
		await sleep(4_000);
		for (const name of ["detached.txt", "timeout.txt", "raw-timeout.txt", "dispose.txt"])
			expect(fs.existsSync(path.join(root, name))).toBe(false);
	}, 180_000);
});
