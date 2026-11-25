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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psc-test-home-"));
process.env.HOME = sandbox;
const tmp = path.join(sandbox, "tmp");
fs.mkdirSync(tmp, { recursive: true });
process.env.TMPDIR = tmp;

process.on("exit", () => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
});
