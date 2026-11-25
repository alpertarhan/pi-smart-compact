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
// sweeps the previous runs' sandboxes instead of its own. Anything fresher
// than an hour may belong to a concurrent run and is left alone.
const TMP_ROOT = os.tmpdir();
for (const name of fs.readdirSync(TMP_ROOT)) {
  if (!name.startsWith("psc-test-home-")) continue;
  const candidate = path.join(TMP_ROOT, name);
  try {
    if (Date.now() - fs.statSync(candidate).mtimeMs > 60 * 60 * 1000) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  } catch { /* racing another run's sweep */ }
}
const sandbox = fs.mkdtempSync(path.join(TMP_ROOT, "psc-test-home-"));
process.env.HOME = sandbox;
const tmp = path.join(sandbox, "tmp");
fs.mkdirSync(tmp, { recursive: true });
process.env.TMPDIR = tmp;
