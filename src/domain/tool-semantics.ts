/**
 * Tool classification by argument shape, with normalized names used only to
 * safely break ties that arguments cannot resolve (read/search/list/delete and
 * ambiguous `text` payloads). The broad `classifyTool(args)` API remains
 * name-agnostic for compatibility.
 *
 * Shell command execution remains a distinct operation. A conservative parser
 * exposes only explicit literal mutation targets for extraction provenance.
 * Pure: no I/O, no async, no globals.
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

export interface ShellFileOperations {
  modified: string[];
  deleted: string[];
}

interface ShellToken {
  kind: "word" | "separator" | "redirect";
  value: string;
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = "";
  let quote: "'" | "\"" | null = null;
  const flush = () => {
    if (word) tokens.push({ kind: "word", value: word });
    word = "";
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === "\\" && quote !== "'" && index + 1 < command.length) {
      word += command[++index];
      continue;
    }
    if (char === "'" || char === "\"") {
      if (!quote) quote = char;
      else if (quote === char) quote = null;
      else word += char;
      continue;
    }
    if (quote) {
      word += char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      if (char === "\n") tokens.push({ kind: "separator", value: char });
      continue;
    }
    if (char === ">" || char === ";" || char === "|"
      || (char === "&" && command[index + 1] === "&")) {
      flush();
      if (char === ">") {
        const append = command[index + 1] === ">";
        if (append) index++;
        tokens.push({ kind: "redirect", value: append ? ">>" : ">" });
      } else {
        const paired = (char === "|" && command[index + 1] === "|")
          || (char === "&" && command[index + 1] === "&");
        if (paired) index++;
        tokens.push({ kind: "separator", value: paired ? char + char : char });
      }
      continue;
    }
    word += char;
  }
  flush();
  return tokens;
}

function literalShellPath(token: string | undefined): string | undefined {
  if (!token || token.startsWith("-") || token === "/dev/null") return undefined;
  if (/[\u0000$*?\[\]{}()<>|;&]/.test(token) || /^\d+$/.test(token)) return undefined;
  return token;
}

function shellOperands(words: string[], start: number): string[] {
  const operands: string[] = [];
  let options = true;
  for (let index = start; index < words.length; index++) {
    const word = words[index];
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options && word.startsWith("-")) continue;
    const target = literalShellPath(word);
    if (target) operands.push(target);
  }
  return operands;
}

function commandFileOperations(words: string[]): ShellFileOperations {
  const modified: string[] = [];
  const deleted: string[] = [];
  let commandIndex = 0;
  while (commandIndex < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[commandIndex])) commandIndex++;
  while (commandIndex < words.length) {
    const wrapper = words[commandIndex].split("/").pop()?.toLowerCase();
    if (wrapper !== "env" && wrapper !== "sudo" && wrapper !== "command" && wrapper !== "nohup") break;
    commandIndex++;
    while (commandIndex < words.length && words[commandIndex].startsWith("-")) commandIndex++;
  }
  const command = words[commandIndex]?.split("/").pop()?.toLowerCase();
  const operands = shellOperands(words, commandIndex + 1);
  if (!command || !operands.length) return { modified, deleted };
  if (command === "rm" || command === "unlink") {
    deleted.push(...operands);
  } else if (command === "touch" || command === "tee") {
    modified.push(...operands);
  } else if (command === "cp" || command === "install") {
    modified.push(operands[operands.length - 1]);
  } else if (command === "mv") {
    deleted.push(...operands.slice(0, -1));
    modified.push(operands[operands.length - 1]);
  } else if (command === "sed" && words.slice(commandIndex + 1).some(word => /^-i|^--in-place/.test(word))) {
    // The final operand is the edited file; earlier operands may be scripts or
    // platform-specific empty backup suffixes.
    modified.push(operands[operands.length - 1]);
  }
  return { modified, deleted };
}

/** Extract only explicit literal file targets from common mutating shell forms. */
export function extractShellFileOperations(args: unknown): ShellFileOperations {
  const record = args && typeof args === "object" ? args as Args : null;
  const command = record
    ? COMMAND_KEYS.map(key => record[key]).find((value): value is string => typeof value === "string")
    : undefined;
  if (!command) return { modified: [], deleted: [] };
  const tokens = tokenizeShell(command);
  const modified: string[] = [];
  const deleted: string[] = [];
  let words: string[] = [];
  const flushCommand = () => {
    const operations = commandFileOperations(words);
    modified.push(...operations.modified);
    deleted.push(...operations.deleted);
    words = [];
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === "separator") {
      flushCommand();
    } else if (token.kind === "redirect") {
      const target = tokens[index + 1]?.kind === "word" ? literalShellPath(tokens[index + 1].value) : undefined;
      if (target) modified.push(target);
      if (target) index++;
    } else {
      words.push(token.value);
    }
  }
  flushCommand();
  return {
    modified: Array.from(new Set(modified)),
    deleted: Array.from(new Set(deleted.filter(file => !modified.includes(file)))),
  };
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
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Args)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function commandIdentity(args: Args): string {
  const raw = COMMAND_KEYS.map(key => args[key]).find((value): value is string => typeof value === "string") ?? "";
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(token => token !== "--" && !/^--?(?:retry|force|runInBand|no-cache|verbose|silent)(?:=|$)/i.test(token))
    .join(" ");
}

/** Stable identity for deciding whether a later call is a retry of an earlier one. */
export function toolOperationSignature(toolName: string, args: Record<string, unknown>): string {
  const operation = classifyToolOperation(args, toolName);
  const name = normalizeToolName(toolName);
  if (operation === "execute") return operation + "\0" + name + "\0" + commandIdentity(args);
  const target = extractToolPath(args);
  if (target) return operation + "\0" + name + "\0" + target.replace(/\\/g, "/");
  if (operation === "search") {
    const query = ["pattern", "query", "glob"].map(key => args[key]).find((value): value is string => typeof value === "string") ?? "";
    return operation + "\0" + name + "\0" + query;
  }
  return operation + "\0" + name + "\0" + JSON.stringify(stableValue(args));
}

export function sameToolOperation(
  left: { name: string; arguments: Record<string, unknown> },
  right: { name: string; arguments: Record<string, unknown> },
): boolean {
  return toolOperationSignature(left.name, left.arguments) === toolOperationSignature(right.name, right.arguments);
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
