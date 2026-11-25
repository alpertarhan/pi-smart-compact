/**
 * tsc emits declarations with the source's ".ts" import specifiers, which
 * standard module resolution rejects; rewrite the relative ones to ".js".
 * A Bun script rather than `sed -i`, whose flags differ between GNU and BSD
 * and which Bun's shell on Windows does not have.
 */
import path from "node:path";
import { Glob } from "bun";

const dir = process.argv[2] ?? "dist";
const SPECIFIER = /((?:from |import\()")(\.[^"]*)\.ts"/g;
for await (const file of new Glob("**/*.d.ts").scan(dir)) {
  const target = path.join(dir, file);
  const text = await Bun.file(target).text();
  const next = text.replace(SPECIFIER, '$1$2.js"');
  if (next !== text) await Bun.write(target, next);
}
