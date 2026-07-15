/**
 * Tool classification by argument shape, with normalized names used only to
 * safely break ties that arguments cannot resolve (read/search/list/delete and
 * ambiguous `text` payloads). The broad `classifyTool(args)` API remains
 * name-agnostic for compatibility.
 *
 * Bash-style tools that take a free-text `command` remain opaque to file-path
 * tracking by construction. Pure: no I/O, no async, no globals.
 */

type Args = Record<string, unknown>;

/**
 * Argument keys that carry a file path. `path` is near-universal; the others
 * cover common casing/word variants seen across Pi tools and MCP servers.
 */
const PATH_KEYS = [
  "path", "file_path", "filePath", "filename", "file",
  "target_file", "file_uri", "absolute_path",
] as const;

/**
 * Argument keys that carry the bytes being written. Deliberately the strict,
 * unambiguously-"content" set only — since `modifiedFiles` is treated as
 * ground truth downstream, we prefer a false-negative (miss a write) over a
 * false-positive (pollute the modified list with a read). Vague keys like
 * `data`/`text` that can also mean options/labels are intentionally excluded.
 */
const PAYLOAD_KEYS = [
  "content", "newText", "oldText", "new_str", "old_str",
  "new_string", "old_string", "edits", "patch", "replacement",
] as const;

/** Argument keys that carry a shell command to execute. */
const COMMAND_KEYS = ["command", "cmd", "script"] as const;

function hasPresent(args: Args, keys: readonly string[]): boolean {
  // `!= null` so an empty-string payload (write empty file) still counts as
  // "present" — presence of the arg is the signal, not its value.
  return keys.some(k => args[k] != null);
}

/**
 * Extract a non-empty file-path argument from a tool call, covering common key
 * names. Returns undefined when no usable path is present.
 */
export function extractToolPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Args;
  for (const k of PATH_KEYS) {
    const v = a[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export type ToolClass = "mutates" | "accesses" | "executes" | "other";
export type ToolOperation = "read" | "search" | "list" | "mutate" | "delete" | "execute" | "unknown";

/** Normalize provider wrappers and spelling differences without merging namespaces. */
export function normalizeToolName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name
    .replace(/^functions[.:/_-]+/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function nameHas(name: string, hints: readonly string[]): boolean {
  const words = name.split("_");
  return hints.some(hint => words.includes(hint));
}

/**
 * Fine-grained EESV operation taxonomy. Argument shape is authoritative;
 * normalized names only disambiguate otherwise-safe path/text and access calls.
 */
export function classifyToolOperation(args: unknown, toolName?: string): ToolOperation {
  const a = args && typeof args === "object" ? args as Args : {};
  const name = normalizeToolName(toolName);
  const hasPath = extractToolPath(a) !== undefined;

  if (hasPath && hasPresent(a, PAYLOAD_KEYS)) return "mutate";
  if (hasPresent(a, COMMAND_KEYS)) return "execute";
  if (hasPath && hasPresent(a, ["text"]) && nameHas(name, ["write", "edit", "patch", "replace", "append", "create", "update", "insert"])) return "mutate";
  if (hasPath && nameHas(name, ["delete", "remove", "unlink"])) return "delete";
  if (hasPresent(a, ["pattern", "query", "glob"]) || nameHas(name, ["grep", "search", "find", "glob", "rg"])) return "search";
  if (nameHas(name, ["list", "ls", "tree"])) return "list";
  if (hasPath || nameHas(name, ["read"])) return "read";
  return "unknown";
}

/**
 * Broad compatibility classifier retained for existing name-agnostic callers.
 */
export function classifyTool(args: unknown): ToolClass {
  if (!args || typeof args !== "object") return "other";
  const a = args as Args;
  const hasPath = extractToolPath(a) !== undefined;
  if (hasPath && hasPresent(a, PAYLOAD_KEYS)) return "mutates";
  if (hasPresent(a, COMMAND_KEYS)) return "executes";
  if (hasPath) return "accesses";
  return "other";
}
