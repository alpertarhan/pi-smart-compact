/**
 * Test sandbox: point HOME (and TMPDIR) at one throwaway directory for the
 * whole run. Without this, tests that never set HOME themselves read and
 * write the developer's real ~/.pi/agent caches, so results depend on the
 * machine and every run litters both ~/.pi and /tmp. Per-test HOME overrides
 * keep working: they restore to this sandbox home afterwards.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// bun test hard-kills its process without firing exit handlers, so each run
// sweeps the previous runs' sandboxes instead of its own. A sandbox whose
// owner process is alive (a long `bun test --watch`) is left alone; others go
// once an hour old, since a run starting up has not written its owner yet.
const TMP_ROOT = os.tmpdir();
const PREFIX = "psc-test-home-";
const OWNER_FILE = "owner.pid";
const ownerAlive = (dir: string) => {
  try {
    const pid = Number(fs.readFileSync(path.join(dir, OWNER_FILE), "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return false; // kill(0) would probe our own group
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};
for (const name of fs.readdirSync(TMP_ROOT)) {
  if (!name.startsWith(PREFIX)) continue;
  const candidate = path.join(TMP_ROOT, name);
  try {
    if (!ownerAlive(candidate) && Date.now() - fs.statSync(candidate).mtimeMs > 60 * 60 * 1000) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  } catch { /* racing another run's sweep */ }
}
const sandbox = fs.mkdtempSync(path.join(TMP_ROOT, PREFIX));
fs.writeFileSync(path.join(sandbox, OWNER_FILE), String(process.pid));
process.env.HOME = sandbox;
const tmp = path.join(sandbox, "tmp");
fs.mkdirSync(tmp, { recursive: true });
process.env.TMPDIR = tmp;
