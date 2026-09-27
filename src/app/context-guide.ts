import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../utils/config.ts";

/** Not a discovered Pi skill: no metadata/body enters prompts until requested. */
export async function readContextGuide(): Promise<string> {
 const config = loadConfig();
 if (!config.contextNavigationEnabled || !config.contextGuidanceEnabled) throw new Error("Context guidance is disabled in Pi Continuity settings.");
 // Same source-versus-packed asset lookup used by the visual renderer.
 for (const relative of ["../assets/skills/context-management/SKILL.md", "../../assets/skills/context-management/SKILL.md"]) {
  const file = new URL(relative, import.meta.url);
  if (!existsSync(file)) continue;
  const text = await readFile(file, "utf8");
  const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 4) : -1;
  return end < 0 ? text : text.slice(end + 5).trim();
 }
 throw new Error("Context guidance is unavailable; rebuild or reinstall Pi Continuity.");
}
