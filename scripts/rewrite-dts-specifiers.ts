/**
 * tsc emits declarations with the source's ".ts" import specifiers, which
 * standard module resolution rejects; rewrite the relative ones to ".js".
 * A Bun script rather than `sed -i`, whose flags differ between GNU and BSD
 * and which Bun's shell on Windows does not have.
 */
import path from "node:path";
import { Glob } from "bun";

const dir = process.argv[2] ?? "dist";
// Either quote style: tsc keeps the source's quotes in declaration specifiers.
const SPECIFIER = /((?:from |import\(|import )(["']))(\.[^"']*)\.ts\2/g;
const LEFT_OVER = /["']\.\.?\/[^"']*\.ts["']/;
let files = 0;
for await (const file of new Glob("**/*.d.ts").scan(dir)) {
  files++;
  const target = path.join(dir, file);
  const text = await Bun.file(target).text();
  const next = text.replace(SPECIFIER, "$1$3.js$2");
  if (LEFT_OVER.test(next)) throw new Error("Unrewritten .ts specifier in " + target);
  if (next !== text) await Bun.write(target, next);
}
// A moved tsc output layout must fail the build, not ship .ts specifiers.
if (!files) throw new Error("No declaration files under " + dir);
