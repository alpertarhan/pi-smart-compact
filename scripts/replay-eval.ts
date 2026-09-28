/**
 * Replay recorded Pi sessions read-only and estimate prompt tokens and catalog-priced cost per
 * request under alternative automatic-trim policies (none, pressure, timed-<N>).
 *
 *   bun run replay-eval --sessions=<dir|file[,file…]> [--out=/abs/dir] [--json]
 *     [--break-even=8,16,24,48] [--rebuild-min=16384] [--limit=N]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AUTO_TRIM_BREAK_EVEN_REQUESTS, REBUILD_MIN_TOKENS } from "../src/constants.ts";
import {
  formatReport, loadSession, policiesFor, PRESSURE_RATIO, replaySession, totals, type Catalog, type ModelInfo, type SessionResult,
} from "./replay-eval-lib.ts";

const HELP = `Usage: bun run replay-eval --sessions=<dir|file[,file…]> [options]

Evidence class: replay estimates over recorded sessions. Prompt tokens come from the
local estimator and cost from catalog prices; the recorded baseline is the only measured
figure. It cannot show real savings, provider cache behavior or billing.

  --sessions=PATHS       Session .jsonl files or directories (searched recursively), comma-separated
  --break-even=N,…       timed-<N> policies (default: 8,16,${AUTO_TRIM_BREAK_EVEN_REQUESTS},48)
  --rebuild-min=N        Rebuild threshold floor in tokens (default: ${REBUILD_MIN_TOKENS})
  --limit=N              Replay at most N session files (sorted by path)
  --since=DAYS           Only session files modified in the last DAYS days
  --progress             Print one line per file to stderr (index, requests, elapsed)
  --json                 Also write <out>/replay-eval.json (session ids and numbers only)
  --out=/absolute/dir    JSON output directory (default: ./replay-eval-reports/TIMESTAMP)

Input files are read once and never written; a file that changes while it is read (a live
session) is skipped and counted; subscription (OAuth) requests are never priced.`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const flag = (name: string) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
function integers(name: string, raw: string, min: number): number[] {
  const values = raw.split(",").map(Number);
  if (!values.length || values.some(value => !Number.isSafeInteger(value) || value < min)) throw new Error(`--${name} needs integers >= ${min}`);
  return values;
}

const inputs = (flag("sessions") ?? "").split(",").filter(Boolean).map(item => path.resolve(item));
if (!inputs.length) throw new Error("--sessions is required; see --help");
const breakEven = [...new Set(integers("break-even", flag("break-even") ?? `8,16,${AUTO_TRIM_BREAK_EVEN_REQUESTS},48`, 1))];
const [rebuildMin] = integers("rebuild-min", flag("rebuild-min") ?? String(REBUILD_MIN_TOKENS), 0);
const limit = flag("limit") === undefined ? Infinity : integers("limit", flag("limit")!, 1)[0];
const since = flag("since") === undefined ? undefined : Date.now() - integers("since", flag("since")!, 1)[0] * 86_400_000;
const progress = argv.includes("--progress");
const json = argv.includes("--json");
const out = flag("out") ?? path.resolve("replay-eval-reports", new Date().toISOString().replace(/[:.]/g, "-"));
if (!path.isAbsolute(out)) throw new Error("--out must be an absolute directory");
const roots = inputs.map(input => fs.statSync(input).isDirectory() ? input : path.dirname(input));
if (json && roots.some(root => !path.relative(root, out).startsWith(".."))) throw new Error("--out must not be inside a sessions directory");

function sessionFiles(input: string): string[] {
  if (!fs.statSync(input).isDirectory()) return [input];
  return fs.readdirSync(input, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map(entry => path.join(entry.parentPath, entry.name));
}
const files = [...new Set(inputs.flatMap(sessionFiles))].sort()
  .filter(file => since === undefined || fs.statSync(file).mtimeMs >= since)
  .slice(0, limit);

// Offline catalog: synthetic auth and model stores in a private temp dir, no network.
const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "replay-eval-"));
const policies = policiesFor(breakEven);
const sessions: SessionResult[] = [];
let skipped = 0;
let changed = 0;
try {
  const authPath = path.join(catalogRoot, "auth.json");
  fs.writeFileSync(authPath, "{}");
  const runtime = await ModelRuntime.create({
    authPath, modelsPath: path.join(catalogRoot, "models.json"), modelsStorePath: path.join(catalogRoot, "models-cache.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const models = new Map<string, ModelInfo | undefined>();
  const catalog: Catalog = (provider, id) => {
    const key = `${provider}/${id}`;
    if (!models.has(key)) {
      const model = runtime.getModel(provider, id);
      models.set(key, model && { cost: model.cost, contextWindow: model.contextWindow });
    }
    return models.get(key);
  };
  files.forEach((file, index) => {
    const started = performance.now();
    const before = fs.statSync(file);
    const text = fs.readFileSync(file, "utf8");
    const after = fs.statSync(file);
    // A session being written right now cannot be evidence; skip it rather than discarding the run.
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) { changed++; return; }
    const session = loadSession(text);
    if (!session) { skipped++; return; }
    const result = replaySession(session, catalog, { policies, rebuildMin });
    sessions.push(result);
    if (progress) console.error(`[${index + 1}/${files.length}] ${path.basename(file)} ${result.policies[0]?.requests ?? 0} requests ${Math.round(performance.now() - started)} ms`);
  });
} finally {
  fs.rmSync(catalogRoot, { recursive: true, force: true });
}

console.log(formatReport(sessions, policies));
console.log(`\n${sessions.length} session(s) replayed, ${skipped} skipped without a valid header, ${changed} skipped because they changed while being read; break-even ${breakEven.join(",")}; rebuild-min ${rebuildMin}.`);
if (json) {
  fs.mkdirSync(out, { recursive: true });
  const report = {
    evidence: "replay estimates over recorded sessions; not real savings, provider cache behavior or billing",
    parameters: { breakEven, rebuildMin, pressureRatio: PRESSURE_RATIO },
    skipped, changed, sessions, totals: totals(sessions, policies),
  };
  const target = path.join(out, "replay-eval.json");
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n");
  console.log(`JSON: ${target}`);
}
