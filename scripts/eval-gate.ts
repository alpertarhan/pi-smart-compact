const suites = [
  "test/eval.test.ts",
  "test/eval-adversarial.test.ts",
  "test/summary-parse.test.ts",
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
