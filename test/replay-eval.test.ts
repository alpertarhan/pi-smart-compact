import { afterAll, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { loadSession, policiesFor, replaySession, type ModelInfo } from "../scripts/replay-eval-lib.ts";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";

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
    // Unknown lifetime: the recorded reads show a cache, so the unchanged prefix is reused, never expired.
    expect(result.policies.find(policy => policy.policy === "none")!.cached).toBeGreaterThan(0);
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

/**
 * Calibration fixture: usage is generated from the documented provider cache semantics over the
 * session's own projected prompt plus a fixed system/tool payload. Anthropic writes report the
 * 5-minute tier (cacheWrite1h 0) and expire after a 6-minute gap; openai-codex has no catalog
 * lifetime, keeps its prefix across a 20-minute gap, misses the whole prompt after a context edit
 * and never bills cache writes.
 */
function calibrationFixture() {
  const SYSTEM = 20_000;
  const prices = { anthropic: { input: 5, cacheRead: 0.5, cacheWrite: 6.25 }, "openai-codex": { input: 2, cacheRead: 0.2, cacheWrite: 0 } };
  const entries: Record<string, unknown>[] = [];
  let at = T0;
  let seq = 0;
  let previous: { provider: string; prompt: number; at: number } | undefined;
  let edited = false;
  const add = (entry: Record<string, unknown>) => entries.push({ id: `c${++seq}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(at).toISOString(), ...entry });
  const message = (message: Record<string, unknown>) => add({ type: "message", message: { ...message, timestamp: at } });
  const request = (provider: "anthropic" | "openai-codex", minutes: number) => {
    at += minutes * 60_000;
    const prompt = SYSTEM + contextMessageEntries(entries).reduce((sum, entry) => sum + estimateTokens(entry.message as never), 0);
    const hit = previous?.provider === provider && !edited && (provider !== "anthropic" || at - previous.at <= 300_000);
    const reused = hit ? previous!.prompt : 0;
    const [input, cacheWrite] = provider === "anthropic" ? [0, prompt - reused] : [prompt - reused, 0];
    const rate = prices[provider];
    const total = (rate.input * input + rate.cacheRead * reused + rate.cacheWrite * cacheWrite) / 1_000_000;
    message({
      role: "assistant", content: [{ type: "text", text: `Step ${seq}.` }], stopReason: "stop", api: provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses",
      provider, model: provider === "anthropic" ? "claude-cal" : "codex-cal",
      usage: { input, cacheRead: reused, cacheWrite, ...(provider === "anthropic" ? { cacheWrite1h: 0 } : {}), output: 0, totalTokens: prompt,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } },
    });
    previous = { provider, prompt, at };
    edited = false;
  };
  const toolTurn = (n: number) => {
    message({ role: "user", content: [{ type: "text", text: `Inspect part ${n}.` }] });
    message({ role: "toolResult", toolCallId: `t${n}`, toolName: "read", isError: false, content: [{ type: "text", text: `part ${n} line\n`.repeat(900) }] });
  };
  for (let n = 1; n <= 4; n++) { toolTurn(n); request("anthropic", 1); }
  toolTurn(5); request("anthropic", 6); // past the 5-minute tier: expired
  toolTurn(6); request("anthropic", 1);
  for (let n = 7; n <= 9; n++) { toolTurn(n); request("openai-codex", 1); } // route switch: separate cache
  toolTurn(10); request("openai-codex", 20); // no catalog lifetime: still cached
  add({ type: "context_edit", targetId: entries.find(entry => (entry.message as { toolCallId?: string })?.toolCallId === "t8")!.id, replacement: { content: "[archived]" } });
  edited = true;
  toolTurn(11); request("openai-codex", 1); // codex: whole prompt after an edit
  toolTurn(12); request("openai-codex", 1);
  const header = { type: "session", version: 3, id: "0f1e2d3c-replay-calibration", timestamp: new Date(T0).toISOString(), cwd: root };
  return [header, ...entries].map(line => JSON.stringify(line)).join("\n") + "\n";
}

it("prices with base rates when a long-context tier omits rate fields", () => {
  const session = loadSession(fixture(false, 6).text)!;
  // Catalogs are data at runtime; a tier may omit rate fields the base cost defines.
  const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75,
    tiers: [{ inputTokensAbove: 10_000, input: 6, output: 30 }] } as ModelInfo["cost"];
  const catalog = () => ({ contextWindow: 200_000, cost });
  const result = replaySession(session, catalog, { policies: policiesFor([24]), rebuildMin: 16_384 });
  for (const policy of result.policies) {
    expect(policy.cost).not.toBeNull();
    expect(Number.isFinite(policy.cost)).toBe(true);
    expect(policy.cost!).toBeGreaterThan(0);
  }
});

/**
 * Recorded-trim fixture: usage is generated from the projected prompt of the branch as recorded
 * (the automatic trim's context_edit applied) plus a fixed system/tool payload. The trim is recorded
 * between requests, so from then on the untrimmed projection is larger than what was measured.
 */
function trimmedFixture() {
  const SYSTEM = 5_000;
  const recorded: Record<string, unknown>[] = [];
  const kept: Record<string, unknown>[] = [];
  const strippedProjected: number[] = [];
  let at = T0;
  let seq = 0;
  let edited = false;
  let previous = 0;
  const link = (rows: Record<string, unknown>[], entry: Record<string, unknown>) =>
    rows.push({ id: `q${++seq}`, parentId: rows.at(-1)?.id ?? null, timestamp: new Date(at).toISOString(), ...entry });
  const copyKept = () => kept.push({ ...recorded.at(-1)!, parentId: kept.at(-1)?.id ?? null });
  const project = (rows: Record<string, unknown>[]) =>
    contextMessageEntries(rows as never).reduce((sum, entry) => sum + estimateTokens(entry.message as never), 0);
  const request = (content: unknown[], stopReason = "stop") => {
    at += 60_000;
    const prompt = SYSTEM + project(recorded);
    const stripped = project(kept);
    const reused = edited ? 0 : previous;
    const total = (0.5 * reused + 6.25 * (prompt - reused)) / 1_000_000;
    const usage = { input: 0, cacheRead: reused, cacheWrite: prompt - reused, cacheWrite1h: 0, output: 0, totalTokens: prompt,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } };
    link(recorded, { type: "message", message: { role: "assistant", content, stopReason, ...MODEL, usage, timestamp: at } });
    copyKept();
    previous = prompt;
    edited = false;
    strippedProjected.push(stripped);
  };
  const toolTurn = (body: string) => {
    at += 60_000;
    link(recorded, { type: "message", message: { role: "user", content: [{ type: "text", text: "Inspect." }], timestamp: at } });
    copyKept();
    request([{ type: "toolCall", id: `call-${seq}`, name: "read", arguments: {} }], "toolUse");
    link(recorded, { type: "message", message: { role: "toolResult", toolCallId: `call-${seq - 1}`, toolName: "read", isError: false,
      content: [{ type: "text", text: body }], timestamp: at } });
    copyKept();
    const resultId = recorded.at(-1)!.id as string;
    request([{ type: "text", text: "Read the body." }]);
    return resultId;
  };
  const trimmedId = toolTurn("RECORDED_TRIM_BODY_SECRET line\n".repeat(2_000));
  toolTurn("small body line\n".repeat(50));
  at += 60_000;
  link(recorded, { type: "custom", customType: "smart-compact-context",
    data: { version: 1, action: "trim", cause: "break-even", references: [trimmedId] } });
  link(recorded, { type: "context_edit", targetId: trimmedId, replacement: { content: "[archived]" } });
  edited = true;
  for (let turn = 1; turn <= 2; turn++) {
    at += 60_000;
    link(recorded, { type: "message", message: { role: "user", content: [{ type: "text", text: `Follow-up ${turn}.` }], timestamp: at } });
    copyKept();
    request([{ type: "text", text: `Follow-up ${turn} done.` }]);
  }
  const header = { type: "session", version: 3, id: "0f1e2d3c-replay-recorded-trim", timestamp: new Date(T0).toISOString(), cwd: root };
  return { text: [header, ...recorded].map(line => JSON.stringify(line)).join("\n") + "\n", SYSTEM, strippedProjected };
}

it("keeps the unseen payload positive after a recorded automatic trim", () => {
  const { text, SYSTEM, strippedProjected } = trimmedFixture();
  const catalog = () => ({ contextWindow: 1_000_000, promptCache: { short: 300, long: 3_600 }, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } });
  const result = replaySession(loadSession(text)!, catalog, { policies: [{ name: "none", kind: "none" }], rebuildMin: 1_000 });
  expect(result.strippedTrims).toBe(1);
  const none = result.policies[0];
  expect(none.requests).toBe(strippedProjected.length);
  // Every request, including those after the recorded trim, still carries the policy-independent payload.
  expect(none.prompt).toBe(strippedProjected.reduce((sum, value) => sum + value, 0) + strippedProjected.length * SYSTEM);
});

/** 1 h write then short-tier writes on the same Anthropic route; a 10-minute gap follows. */
function hourTierFixture() {
  const SYSTEM = 5_000;
  const entries: Record<string, unknown>[] = [];
  let at = T0;
  let seq = 0;
  let previous = 0;
  let prevAt = at;
  let horizonMs = 0;
  const add = (entry: Record<string, unknown>) => entries.push({ id: `h${++seq}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(at).toISOString(), ...entry });
  const project = () => contextMessageEntries(entries as never).reduce((sum, entry) => sum + estimateTokens(entry.message as never), 0);
  const request = (gapMinutes: number, hourTier: boolean) => {
    at += gapMinutes * 60_000;
    const prompt = SYSTEM + project();
    const reused = at - prevAt <= horizonMs ? previous : 0;
    const written = prompt - reused;
    add({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `Step ${seq}.` }], stopReason: "stop", ...MODEL,
      usage: { input: 0, cacheRead: reused, cacheWrite: written, cacheWrite1h: hourTier ? written : 0, output: 0, totalTokens: prompt,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: (0.5 * reused + 6.25 * written) / 1_000_000 } }, timestamp: at } });
    horizonMs = Math.max(horizonMs, hourTier ? 3_600_000 : 300_000);
    prevAt = at;
    previous = prompt;
  };
  const user = (text: string) => add({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: at } });
  user("Start.");
  request(1, true); // 1 h write
  user("Continue.");
  request(1, false); // short-tier writes keep the prefix
  user("Continue.");
  request(1, false);
  user("After the gap.");
  request(10, false); // 10 min later: the 1 h prefix is still cached
  const header = { type: "session", version: 3, id: "0f1e2d3c-replay-hour-tier", timestamp: new Date(T0).toISOString(), cwd: root };
  return [header, ...entries].map(line => JSON.stringify(line)).join("\n") + "\n";
}

it("keeps a 1h prefix cached across later short-tier writes", () => {
  const catalog = () => ({ contextWindow: 200_000, promptCache: { short: 300, long: 3_600 }, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } });
  const result = replaySession(loadSession(hourTierFixture())!, catalog, { policies: [{ name: "none", kind: "none" }], rebuildMin: 1_000 });
  const none = result.policies[0];
  expect(result.baseline.misses).toBe(0);
  expect(none.rebuilds).toBe(0);
  expect(none.cached).toBeGreaterThan(0);
});

/**
 * Pressure-gate fixture: the visible context stays under the 0.8 gate while the recorded prompt
 * (unseen payload included) crosses it, so only a gate that counts the unseen payload can fire.
 */
function pressureFixture() {
  const SYSTEM = 10_000;
  const WINDOW = 30_000;
  const entries: Record<string, unknown>[] = [];
  let at = T0;
  let seq = 0;
  let previous = 0;
  const add = (entry: Record<string, unknown>) => entries.push({ id: `p${++seq}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(at).toISOString(), ...entry });
  const project = () => contextMessageEntries(entries as never).reduce((sum, entry) => sum + estimateTokens(entry.message as never), 0);
  const request = (content: unknown[], stopReason = "stop") => {
    at += 60_000;
    const prompt = SYSTEM + project();
    const reused = previous;
    const written = prompt - reused;
    add({ type: "message", message: { role: "assistant", content, stopReason, ...MODEL,
      usage: { input: 0, cacheRead: reused, cacheWrite: written, cacheWrite1h: 0, output: 0, totalTokens: prompt,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: (0.5 * reused + 6.25 * written) / 1_000_000 } }, timestamp: at } });
    previous = prompt;
  };
  const user = (text: string) => add({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: at } });
  user("Refactor the parser.");
  request([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], "toolUse");
  add({ type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false,
    content: [{ type: "text", text: "export const PRESSURE_BODY_SECRET = 1;\n".repeat(1_600) }], timestamp: at } });
  request([{ type: "text", text: "Read the parser." }]);
  for (let turn = 3; turn <= 6; turn++) {
    user(`Step ${turn}.`);
    request([{ type: "text", text: `Step ${turn} done.` }]);
  }
  const header = { type: "session", version: 3, id: "0f1e2d3c-replay-pressure", timestamp: new Date(T0).toISOString(), cwd: root };
  return { text: [header, ...entries].map(line => JSON.stringify(line)).join("\n") + "\n", SYSTEM, WINDOW, projected: project() };
}

it("fires the pressure gate once the unseen payload pushes the prompt over the ratio", () => {
  const { text, SYSTEM, WINDOW, projected } = pressureFixture();
  // The visible context alone never reaches the gate; the recorded prompt crosses it.
  expect(projected).toBeLessThan(0.8 * WINDOW);
  expect(projected + SYSTEM).toBeGreaterThanOrEqual(0.8 * WINDOW);
  const catalog = () => ({ contextWindow: WINDOW, promptCache: { short: 300, long: 3_600 }, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } });
  const result = replaySession(loadSession(text)!, catalog, {
    policies: [{ name: "none", kind: "none" }, { name: "pressure", kind: "pressure" }], rebuildMin: 1_000,
  });
  const pressure = result.policies.find(policy => policy.policy === "pressure")!;
  expect(pressure.trims.pressure).toBe(1);
  expect(pressure.events[0]).toMatchObject({ cause: "pressure" });
  expect(result.policies[0].trims.pressure).toBe(0);
});

it("reproduces recorded cache misses and cost for Anthropic 5-minute and openai-codex whole-prompt caches", () => {
  const catalog = (provider: string) => provider === "anthropic"
    ? { contextWindow: 1_000_000, promptCache: { short: 300, long: 3_600 }, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }
    // Catalog lists a write price the provider never bills; no promptCache metadata.
    : { contextWindow: 1_000_000, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } };
  const result = replaySession(loadSession(calibrationFixture())!, catalog, { policies: policiesFor([24]), rebuildMin: 1_000 });
  const { baseline } = result;
  const none = result.policies.find(policy => policy.policy === "none")!;
  // Observed misses: expiry after 6 minutes, route switch, codex edit.
  expect(baseline.misses).toBe(3);
  expect(none.rebuilds).toBe(baseline.misses);
  expect(none.prompt).toBe(baseline.input + baseline.cacheRead + baseline.cacheWrite);
  expect(none.cached / baseline.cacheRead).toBeCloseTo(1, 2);
  expect(none.cost! / baseline.recordedCost).toBeCloseTo(1, 2);
});
