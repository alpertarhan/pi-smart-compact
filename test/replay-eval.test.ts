import { afterAll, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSession, policiesFor, replaySession } from "../scripts/replay-eval-lib.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-eval-test-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse("2026-09-01T10:00:00Z");
const MODEL = { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5" };
const READ_PATH = "/repo/src/PARSER_PATH_SECRET.ts";

/** One old large read and a non-trimmable tail, then an idle gap beyond the longest advertised Claude tier (1h). */
function fixture(warmed = false, gapMinutes = 70) {
  const id = warmed ? "0f1e2d3c-replay-warmed" : "0f1e2d3c-replay-fixture";
  const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: new Date(T0).toISOString(), cwd: root }];
  const usages: { input: number; cacheRead: number; cacheWrite: number; output: number; total: number }[] = [];
  let parentId: string | null = null;
  let seq = 0;
  const add = (message: Record<string, unknown>, at: number) => {
    const id = `e${++seq}`;
    lines.push({ type: "message", id, parentId, timestamp: new Date(at).toISOString(), message: { ...message, timestamp: at } });
    parentId = id;
  };
  const assistant = (content: unknown[], at: number, stopReason = "stop") => {
    const n = usages.length;
    const usage = { input: 3 + n, cacheRead: 20_000 + 5_000 * n, cacheWrite: 1_500 + 100 * n, output: 150 + 10 * n };
    const total = (3 * usage.input + 0.3 * usage.cacheRead + 3.75 * usage.cacheWrite + 15 * usage.output) / 1_000_000;
    usages.push({ ...usage, total });
    add({
      role: "assistant", content, stopReason, ...MODEL,
      usage: { ...usage, totalTokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } },
    }, at);
  };
  const user = (text: string, at: number) => add({ role: "user", content: [{ type: "text", text }] }, at);
  const s = 1_000;
  user("Refactor the parser.", T0);
  assistant([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: READ_PATH } }], T0 + 10 * s, "toolUse");
  add({ role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false,
    content: [{ type: "text", text: "export const READ_BODY_SECRET = 1;\n".repeat(1_400) }] }, T0 + 11 * s);
  assistant([{ type: "text", text: "Read the parser." }], T0 + 20 * s);
  user("TAIL_BODY_SECRET notes that stay in context.\n".repeat(3_400), T0 + 30 * s);
  // Requests 3..7: 20 s apart; the trim becomes ready at the boundary after request 5.
  for (let turn = 3; turn <= 7; turn++) {
    assistant([{ type: "text", text: `Step ${turn} done.` }], T0 + turn * 20 * s);
    user(`Continue with step ${turn + 1}.`, T0 + turn * 20 * s + 5 * s);
  }
  // Request 8 follows the chosen gap; the last refresh at minute 16 keeps a 1h cache alive through minute 76.
  if (warmed) {
    for (let minute = 4; minute <= 16; minute += 4) {
      const at = T0 + 140 * s + minute * 60 * s;
      const entryId = `w${minute}`;
      lines.push({ type: "usage", id: entryId, parentId, timestamp: new Date(at).toISOString(), kind: "cache_warm", ...MODEL,
        usage: { input: 1, output: 1, cacheRead: 40_000, cacheWrite: 0, totalTokens: 40_002, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      parentId = entryId;
    }
  }
  assistant([{ type: "text", text: "Resumed after the break." }], T0 + 140 * s + gapMinutes * 60 * s);
  user("Finish up.", T0 + 150 * s + gapMinutes * 60 * s);
  assistant([{ type: "text", text: "Done." }], T0 + 160 * s + gapMinutes * 60 * s);
  return { text: lines.map(line => JSON.stringify(line)).join("\n") + "\n", usages };
}

it.each([
  { gap: 6, promptCache: { short: 1_800, long: 1_800 }, cold: 0 },
  { gap: 31, promptCache: { short: 1_800, long: 1_800 }, cold: 1 },
  { gap: 70, promptCache: undefined, cold: 0 },
])("uses model lifetimes for replay cold trims (gap=$gap, cold=$cold)", ({ gap, promptCache, cold }) => {
  const session = loadSession(fixture(false, gap).text)!;
  const catalog = () => ({ contextWindow: 200_000, promptCache, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } });
  const result = replaySession(session, catalog, { policies: policiesFor([24]), rebuildMin: 16_384 });
  expect(result.policies.find(policy => policy.policy === "timed-24")!.trims.cold).toBe(cold);
  if (!promptCache) {
    expect(result.policies.find(policy => policy.policy === "none")!.cached).toBe(0);
    expect(result.baseline.cacheRead).toBeGreaterThan(0); // measured data is never rewritten to match an estimate
  }
});

it("replays a recorded session read-only and times automatic trims per policy", () => {
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  const file = path.join(sessions, "fixture.jsonl");
  const { text, usages } = fixture();
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(sessions, "no-header.jsonl"), JSON.stringify({ type: "message", id: "x" }) + "\n");
  const past = new Date(T0);
  fs.utimesSync(file, past, past);
  const mtime = fs.statSync(file).mtimeMs;
  const out = path.join(root, "out");
  const home = path.join(root, "home");
  fs.mkdirSync(home);

  const run = Bun.spawnSync(["bun", "run", "scripts/replay-eval.ts", `--sessions=${sessions}`, `--out=${out}`, "--json", "--break-even=24,1000"], {
    cwd: path.join(import.meta.dir, ".."), env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toContain("1 session(s) replayed, 1 skipped");

  expect(fs.readFileSync(file, "utf8")).toBe(text);
  expect(fs.statSync(file).mtimeMs).toBe(mtime);

  const raw = fs.readFileSync(path.join(out, "replay-eval.json"), "utf8");
  for (const secret of ["READ_BODY_SECRET", "TAIL_BODY_SECRET", "PARSER_PATH_SECRET", "Refactor the parser", root]) {
    expect(raw).not.toContain(secret);
  }
  const report = JSON.parse(raw);
  expect(report.sessions).toHaveLength(1);
  const [session] = report.sessions;
  expect(session.id).toBe("0f1e2d3c-replay-fixture");
  const sum = (key: keyof typeof usages[number]) => usages.reduce((total, usage) => total + usage[key], 0);
  expect(session.baseline).toMatchObject({
    requests: usages.length, input: sum("input"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"),
    output: sum("output"), subscriptionRequests: 0, models: ["anthropic/claude-sonnet-4-5"],
  });
  expect(session.baseline.recordedCost).toBeCloseTo(sum("total"), 12);

  const policy = (name: string) => session.policies.find((row: { policy: string }) => row.policy === name);
  expect(policy("none").events).toEqual([]);
  expect(policy("pressure").events).toEqual([]);
  const timed = policy("timed-24").events;
  expect(timed.map(({ atRequest, cause }: { atRequest: number; cause: string }) => ({ atRequest, cause }))).toEqual([{ atRequest: 8, cause: "cold" }]);
  expect(timed[0].removedTokens).toBeGreaterThan(8_000);
  expect(policy("timed-1000").events.map(({ atRequest, cause }: { atRequest: number; cause: string }) => ({ atRequest, cause })))
    .toEqual([{ atRequest: 6, cause: "break-even" }]);

  // Deferring to the cold request avoids the warm rewrite: it never costs more than committing early.
  for (const name of ["none", "pressure", "timed-24", "timed-1000"]) expect(policy(name).requests).toBe(usages.length);
  expect(policy("timed-24").cost).toBeLessThan(policy("none").cost);
  expect(policy("timed-24").uncached).toBeLessThan(policy("timed-1000").uncached);
});

it("treats a cache_warm refresh inside the idle gap as keeping the prefix cached", () => {
  const sessions = path.join(root, "warm-sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, "cold.jsonl"), fixture().text);
  fs.writeFileSync(path.join(sessions, "warmed.jsonl"), fixture(true).text);
  const out = path.join(root, "warm-out");
  const home = path.join(root, "warm-home");
  fs.mkdirSync(home);
  const run = Bun.spawnSync(["bun", "run", "scripts/replay-eval.ts", `--sessions=${sessions}`, `--out=${out}`, "--json", "--break-even=24"], {
    cwd: path.join(import.meta.dir, ".."), env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  const report = JSON.parse(fs.readFileSync(path.join(out, "replay-eval.json"), "utf8"));
  const policy = (id: string, name: string) => report.sessions.find((row: { id: string }) => row.id === id)
    .policies.find((row: { policy: string }) => row.policy === name);
  const events = (id: string) => policy(id, "timed-24").events.map(({ atRequest, cause }: { atRequest: number; cause: string }) => ({ atRequest, cause }));
  expect(events("0f1e2d3c-replay-fixture")).toEqual([{ atRequest: 8, cause: "cold" }]);
  expect(events("0f1e2d3c-replay-warmed")).toEqual([]);
  // Request 8 reads the refreshed prefix instead of rebuilding it.
  expect(policy("0f1e2d3c-replay-warmed", "none").rebuilds).toBe(policy("0f1e2d3c-replay-fixture", "none").rebuilds - 1);
});

it("selects files by --since and reports per-file progress on stderr", () => {
  const sessions = path.join(root, "since-sessions");
  fs.mkdirSync(sessions);
  const old = path.join(sessions, "old.jsonl");
  fs.writeFileSync(old, fixture().text);
  fs.utimesSync(old, new Date(T0), new Date(T0));
  const recent = path.join(sessions, "recent.jsonl");
  fs.writeFileSync(recent, fixture(true).text);
  const home = path.join(root, "since-home");
  fs.mkdirSync(home);
  const run = (args: string[]) => Bun.spawnSync(["bun", "run", "scripts/replay-eval.ts", `--sessions=${sessions}`, `--out=${path.join(root, "since-out")}`, "--json", "--break-even=24", ...args], {
    cwd: path.join(import.meta.dir, ".."), env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
  });

  const since = run(["--since=1", "--progress"]);
  expect(since.exitCode).toBe(0);
  expect(since.stdout.toString()).toContain("1 session(s) replayed, 0 skipped without a valid header, 0 skipped because they changed");
  expect(since.stderr.toString()).toMatch(/^\[1\/1\] recent\.jsonl 9 requests \d+ ms\n$/);

  const all = run([]);
  expect(all.stderr.toString()).toBe("");
  expect(all.stdout.toString()).toContain("2 session(s) replayed, 0 skipped without a valid header, 0 skipped because they changed");
});
