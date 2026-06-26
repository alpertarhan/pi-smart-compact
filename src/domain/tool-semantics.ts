/**
 * Name-agnostic tool classification by argument shape.
 *
 * Extraction used to classify tools by NAME — `hasToolHint(name, ["write",
 * "edit", ...])` and `tc.name === "bash"`. That is a proxy: a tool is a write
 * tool because its ARGUMENTS carry a content payload, not because its name
 * happens to contain "write". Name matching is also churn-fragile —
 * `read` → `hypa_read` → whatever-next silently drops off the list, and every
 * new tool demands a code change.
 *
 * We classify by what the tool CARRIES, which is invariant under renaming:
 *
 *   mutates   — a path-like arg AND a content payload (write/edit/append/...)
 *   executes  — a command/shell arg (bash/hypa_shell/...)
 *   accesses  — a path-like arg with no payload (read/grep/find/ls)
 *   other     — none of the above (ask_user, process, ...)
 *
 * The argument-name conventions (path/content/command) are far more stable
 * across tools and providers than tool names, so this auto-adapts to tools
 * this code has never seen (hypa_*, MCP tools, custom extensions) without a
 * single name in a list.
 *
 * Ceiling (documented, not hidden): a DELETE cannot be told from a READ by
 * arguments alone — both carry only a path. Callers that need deletion must
 * resolve it from the result text. Bash-style tools that take a free-text
 * `command` are opaque to file-path tracking by construction.
 *
 * Pure: no I/O, no async, no globals — lives in the domain layer alongside
 * `summary-schema.ts`.
 */

type Args = Record<string, unknown>;

/**
 * Argument keys that carry a file path. `path` is near-universal; the others
 * cover common casing/word variants seen across Pi tools and MCP servers.
 */
const PATH_KEYS = ["path", "file_path", "filePath", "filename", "file"] as const;

/**
 * Argument keys that carry the bytes being written. Deliberately the strict,
 * unambiguously-"content" set only — since `modifiedFiles` is treated as
 * ground truth downstream, we prefer a false-negative (miss a write) over a
 * false-positive (pollute the modified list with a read). Vague keys like
 * `data`/`text` that can also mean options/labels are intentionally excluded.
 */
const PAYLOAD_KEYS = ["content", "newText", "oldText", "edits", "patch", "replacement"] as const;

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

/**
 * Classify a tool by its argument shape, independent of its name.
 *
 * Order matters: a path + payload wins as `mutates` even if a command key is
 * also present (a write tool that logs a command is still a write). A bare
 * command with no path is `executes`. A bare path is `accesses`.
 */
export function classifyTool(args: unknown): ToolClass {
  if (!args || typeof args !== "object") return "other";
  const a = args as Args;
  const hasPath = extractToolPath(a) !== undefined;
  const hasPayload = hasPresent(a, PAYLOAD_KEYS);
  const hasCommand = hasPresent(a, COMMAND_KEYS);
  if (hasPath && hasPayload) return "mutates";
  if (hasCommand) return "executes";
  if (hasPath) return "accesses";
  return "other";
}
