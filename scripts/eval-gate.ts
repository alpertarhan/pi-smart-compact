const suites = [
  "test/eval.test.ts",
  "test/eval-adversarial.test.ts",
  "test/damage.test.ts",
  "test/dashboard-insights.test.ts",
  "test/pipeline-integration.test.ts",
  "test/synthesize-fallback.test.ts",
  "test/continuity-context.test.ts",
  "test/context-graph.test.ts",
  "test/context-tools.test.ts",
  "test/compaction-commit-store.test.ts",
  "test/mode-policy.test.ts",
  "test/provider-evaluation.test.ts",
  "test/provider-routing.test.ts",
  "test/resolve-models.test.ts",
  "test/services.test.ts",
  "test/pending-slot.test.ts",
  "test/session-run-lock.test.ts",
  "test/synthesis-cache.test.ts",
  "test/native-continuity-bridge.test.ts",
  "test/state.test.ts",
  "test/state-step-continuity.test.ts",
  "test/summary-parse.test.ts",
  "test/telemetry.test.ts",
  "test/verify.test.ts",
  "test/tool-semantics.test.ts",
  "test/window-boundary.test.ts",
];

const child = Bun.spawn(["bun", "test", ...suites], {
  cwd: import.meta.dir + "/..",
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await child.exited;
if (exitCode !== 0) process.exit(exitCode);
console.log("EESV adversarial release gate passed (" + suites.length + " suites)");
