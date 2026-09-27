/** Local, synthetic RTK contract pilot. Requires an explicit binary; never installs hooks or calls an LLM.
 * bun run scripts/rtk-pilot.ts /absolute/path/to/rtk
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import rtkCompanion from "../src/rtk.ts";

const binary = process.argv[2];
if (!binary?.startsWith("/")) throw new Error("Supply an absolute RTK binary path; no global installation is performed.");
const workspace = mkdtempSync(join(tmpdir(), "smart-context-rtk-"));
const home = join(workspace, "home");
const cwd = join(workspace, "fixture");
const bin = join(workspace, "bin");
for (const directory of [home, cwd, bin, join(cwd, "src")]) mkdirSync(directory, { recursive: true });
symlinkSync(binary, join(bin, "rtk"));
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  RTK_TEE_DIR: join(home, "tee"), CLAUDE_CONFIG_DIR: join(home, "claude"), RTK_RECALL: "1", RTK_TEE: "1",
  PATH: [bin, join(cwd, "node_modules", ".bin"), resolve("node_modules/.bin"), process.env.PATH].join(":"), NO_COLOR: "1", FORCE_COLOR: "0",
  CARGO_TERM_COLOR: "never", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const oldDisabled = process.env.RTK_DISABLED;

function run(command: string, args: string[], timeout = 30_000) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, killed: result.signal !== null };
}
function setup(command: string, args: string[], timeout = 30_000) {
  const result = run(command, args, timeout);
  assert.equal(result.code, 0, "Fixture setup failed: " + result.stderr);
}

try {
  delete process.env.RTK_DISABLED;
  const version = run(binary, ["--version"]);
  assert.equal(version.code, 0);
  writeFileSync(join(cwd, "Cargo.toml"), '[package]\nname="hygiene_fixture"\nversion="0.1.0"\nedition="2021"\n');
  writeFileSync(join(cwd, "src/lib.rs"), '#[test] fn evidence_failure() {\n'
    + 'let mut count = std::fs::read_to_string("executions.txt").unwrap_or_default(); count.push_str("once\\n"); std::fs::write("executions.txt", count).unwrap();\n'
    + 'println!("{}", "ordinary progress\\n".repeat(80)); panic!("EVIDENCE_FAILURE_041");\n}\n');
  writeFileSync(join(cwd, "tsconfig.json"), '{"compilerOptions":{"strict":true,"noEmit":true},"include":["diagnostics.ts"]}');
  writeFileSync(join(cwd, "diagnostics.ts"), Array.from({ length: 20 }, (_, index) => `const value${index}: number = "wrong";`).join("\n"));
  writeFileSync(join(cwd, ".gitignore"), "target/\nexecutions.txt\nCargo.lock\nnode_modules/\nstack-executions.txt\nbun.lock\n");
  writeFileSync(join(cwd, "stack.test.js"), '// Runner is runtime-selected: bun:test exists only under bun test, vitest only under vitest.\n'
    + 'const runner = globalThis.Bun ? await import("bun:test") : await import("vitest");\n'
    + 'import { appendFileSync } from "node:fs";\n'
    + 'runner.test("stack evidence failure", () => {\n'
    + '  appendFileSync("stack-executions.txt", `${process.env.VITEST ? "vitest" : "bun"}\\n`);\n'
    + '  for (let index = 0; index < 60; index += 1) console.log(`ordinary progress ${index} ${"x".repeat(64)}`);\n'
    + '  runner.expect("STACK_EVIDENCE_042").toBe("SENTINEL_MISMATCH");\n'
    + '});\n');
  setup("bun", ["add", "-d", "vitest"], 180_000);
  writeFileSync(join(cwd, "evidence.txt"), "old evidence\n".repeat(80));
  setup("git", ["init", "-q"]);
  setup("git", ["add", "."]);
  setup("git", ["-c", "user.email=offline@example.invalid", "-c", "user.name=Offline", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  writeFileSync(join(cwd, "evidence.txt"), "unchanged format\n".repeat(79) + "IMPORTANT_REPLACEMENT_041\n");

  let onToolCall: ((event: ToolCallEvent, ctx: any) => unknown) | undefined;
  rtkCompanion({
    on(name: string, handler: any) { if (name === "tool_call") onToolCall = handler; return () => {}; },
    exec: async (command: string, args: string[], options?: { timeout?: number }) => run(command, args, options?.timeout),
  });
  const ctx = { signal: new AbortController().signal, hasUI: false };
  const cases = [];
  for (const [command, required] of [["git status", "evidence.txt"], ["git diff", "IMPORTANT_REPLACEMENT_041"],
    ["cargo test", "EVIDENCE_FAILURE_041"], ["tsc --noEmit --pretty false", "TS2322"],
    ["bun test", "STACK_EVIDENCE_042"], ["vitest run", "STACK_EVIDENCE_042"]]) {
    const native = run("bash", ["-c", command], 120_000);
    const event: ToolCallEvent = { type: "tool_call", toolCallId: "pilot", toolName: "bash", input: { command } };
    await onToolCall!(event, ctx);
    const companionCommand = String(event.input.command);
    // Evaluate upstream candidates even when our companion declines them. Do not hide failed experiments.
    const candidate = run(binary, ["rewrite", command]);
    assert.ok([0, 3].includes(candidate.code) && candidate.stdout.trim().startsWith("rtk "));
    const filtered = run("bash", ["-c", candidate.stdout.trim()], 120_000);
    const raw = native.stdout + native.stderr;
    const text = filtered.stdout + filtered.stderr;
    const hash = /rtk recall ([a-f0-9]{12})/.exec(text)?.[1];
    const recalled = hash ? run(binary, ["recall", hash, "--full"]) : undefined;
    cases.push({ command, rewritten: candidate.stdout.trim(), companion: companionCommand === command ? "passthrough" : "rewrite",
      nativeExit: native.code, rtkExit: filtered.code,
      nativeChars: raw.length, rtkChars: text.length, reductionPercent: Math.round((1 - text.length / raw.length) * 1000) / 10,
      evidenceInPreview: text.includes(required), recoveryAdvertised: Boolean(hash),
      recovered: recalled ? recalled.code === 0 && (recalled.stdout + recalled.stderr).includes(required) : null,
      contract: native.code === filtered.code && raw.includes(required)
        && (text.includes(required) || Boolean(recalled?.code === 0 && recalled.stdout.includes(required))) });
  }
  const executions = readFileSync(join(cwd, "executions.txt"), "utf8").trim().split("\n").length;
  const stackRuns = readFileSync(join(cwd, "stack-executions.txt"), "utf8").trim().split("\n");
  const stackCounts = { bun: stackRuns.filter(line => line === "bun").length, vitest: stackRuns.filter(line => line === "vitest").length };
  const vitestVersion = run(join(cwd, "node_modules", ".bin", "vitest"), ["--version"]).stdout.trim();
  const report = { version: version.stdout.trim(), localOnly: true, unit: "characters, NOT provider tokens", cases,
    cargoExecutions: executions, expectedExecutions: 2, stackExecutions: stackCounts, expectedStackExecutions: { bun: 2, vitest: 2 },
    vitestVersion, passed: cases.every(item => item.companion === "passthrough" || item.contract) && executions === 2
      && stackCounts.bun === 2 && stackCounts.vitest === 2 };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  if (oldDisabled === undefined) delete process.env.RTK_DISABLED; else process.env.RTK_DISABLED = oldDisabled;
  rmSync(workspace, { recursive: true, force: true });
}
