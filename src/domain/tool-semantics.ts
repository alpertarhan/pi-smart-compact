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
import { normalize } from "node:path";

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

/** The shell command of a tool-call argument record, if any. */
export function shellCommandArgument(args: unknown): string | undefined {
  const record = args && typeof args === "object" ? (args as Args) : null;
  return record
    ? COMMAND_KEYS.map((key) => record[key]).find((value): value is string => typeof value === "string")
    : undefined;
}

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

/** Explicit instruction/skill sources stay inline even when their read is recoverable. */
export function isInstructionSource(args: Args): boolean {
  // Graph snippets may address instruction files by qualified symbol rather than path.
  if (typeof args.qualified_name === "string"
    && /(?:^|[./])(?:AGENTS|CLAUDE|GEMINI|SKILL|copilot-instructions|skills?)(?:[./]|$)/i.test(args.qualified_name)) return true;
  return PATH_KEYS.some(key => {
    const source = typeof args[key] === "string" ? args[key].replaceAll("\\", "/") : "";
    return /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI|SKILL|copilot-instructions)\.md$/i.test(source)
      || /(?:^|\/)skills?\//i.test(source);
  });
}

// ponytail: conservative allowlist; retain unknown tools until their side effects are understood.
const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls", "symbol_search", "module_report", "project_report", "read_symbol", "read_enclosing",
  "search_web", "read_url_content", "find_text_in_url_content", "summarize_url_content", "get_search_content", "fetch_content",
  "lens_diagnostics", "effective_config", "ast_grep_search",
  "search_graph", "trace_path", "get_code_snippet", "get_file_outline", "query_graph", "get_architecture",
  "search_code", "get_graph_schema", "index_status", "check_index_coverage", "detect_changes", "compare_graphs", "list_projects",
]);
export function isReadOnlyResearchTool(toolName: string, input: Args): boolean {
  if (isInstructionSource(input)) return false;
  const name = normalizeToolName(toolName);
  if (name === "smart_context") return ["status", "plan", "search", "read", "trim", "rewind"].includes(String(input.action));
  return READ_ONLY_TOOLS.has(name);
}

/** Shell runs have side effects; only their old text output is archivable, never the call. */
export function isShellTool(toolName: string): boolean {
  return normalizeToolName(toolName) === "bash";
}

/** `process` `output` and `list` only observe; `start`, `stop`, `write`, `update` and `clear` change processes. */
export function isProcessReadTool(toolName: string, input: Args): boolean {
  return normalizeToolName(toolName) === "process" && (input.action === "output" || input.action === "list");
}

/**
 * Results a context trim may replace with a digest once old: read-only research,
 * `smart_context read` pages (ephemeral copies of archived text), shell output and
 * `process` output/list.
 */
export function isArchivableToolResult(toolName: string, input: Args): boolean {
  if (isInstructionSource(input)) return false;
  const name = normalizeToolName(toolName);
  if (name === "smart_context") return input.action === "read";
  return isShellTool(name) || isProcessReadTool(name, input) || isReadOnlyResearchTool(toolName, input);
}

const SUBJECT_KEYS = ["pattern", "query", "symbol", "url"] as const;

/** The call's subject for a trim digest: file path, first command line, or search pattern. */
export function toolCallSubject(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Args;
  const name = normalizeToolName(toolName);
  if (name === "smart_context") return undefined;
  if (name === "bash") {
    const command = COMMAND_KEYS.map(key => a[key]).find((value): value is string => typeof value === "string" && value.trim() !== "");
    const line = command?.split("\n").find(item => item.trim() !== "");
    return line ? "$ " + line : undefined;
  }
  const path = extractToolPath(a);
  if (["read", "read_symbol", "read_enclosing"].includes(name)) return path ? "path: " + path : undefined;
  const key = SUBJECT_KEYS.find(item => typeof a[item] === "string" && a[item] !== "");
  return key ? `${key}: ${a[key]}` : path ? "path: " + path : undefined;
}

export interface ShellFileOperations {
  modified: string[];
  deleted: string[];
}

interface ShellToken {
  /** `heredoc` carries the delimiter; its body is skipped, never tokenized as shell. */
  kind: "word" | "separator" | "redirect" | "heredoc";
  value: string;
}

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
}

/** Index just past the terminator line of each pending heredoc, in order; the command end if one is missing. */
function skipHeredocBodies(command: string, start: number, heredocs: PendingHeredoc[]): number {
  let cursor = start;
  for (const { delimiter, stripTabs } of heredocs) {
    while (cursor < command.length) {
      const end = command.indexOf("\n", cursor);
      const line = command.slice(cursor, end < 0 ? command.length : end);
      cursor = end < 0 ? command.length : end + 1;
      if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
    }
  }
  return cursor;
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const heredocs: PendingHeredoc[] = [];
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
      if (char === "\n") {
        tokens.push({ kind: "separator", value: char });
        // Heredoc bodies are data (scripts, test files), not shell: `x => y` there is no redirect.
        if (heredocs.length) index = skipHeredocBodies(command, index + 1, heredocs.splice(0)) - 1;
      }
      continue;
    }
    if (char === "<" && command[index + 1] === "<" && command[index + 2] !== "<") {
      flush();
      let cursor = index + 2;
      const stripTabs = command[cursor] === "-";
      if (stripTabs) cursor++;
      while (command[cursor] === " " || command[cursor] === "\t") cursor++;
      let delimiter = "";
      let delimiterQuote: string | null = null;
      for (; cursor < command.length; cursor++) {
        const next = command[cursor];
        if (delimiterQuote) {
          if (next === delimiterQuote) delimiterQuote = null;
          else delimiter += next;
        } else if (next === "'" || next === "\"") {
          delimiterQuote = next;
        } else if (/[\s;&|<>()]/.test(next)) {
          break;
        } else if (next !== "\\") {
          delimiter += next;
        }
      }
      tokens.push({ kind: "heredoc", value: delimiter });
      if (delimiter) heredocs.push({ delimiter, stripTabs });
      index = cursor - 1;
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
  if (!command) return { modified, deleted };
  if (command === "sed") {
    // In-place sed: identify the script operand so it is never recorded as
    // the edited file. The script is the first operand unless
    // -e/--expression or -f/--file supplies it; every other literal operand
    // is an edited file. Backup suffixes (-i.bak, BSD's -i '') are options or
    // an empty word, so they never reach the operand walk.
    // In-place gate: bare/attached -i ("-i", "-i.bak", BSD's separate suffix
    // word), or a bundle of sed's value-less flags with i followed only by
    // more such flags or a suffix separator ("-ni", "-Ei.bak", "-Ei~").
    // Attached scripts ("-ffixes.sed", "-es/a/b/") never match.
    if (words.slice(commandIndex + 1).some(word => /^-i/.test(word) || /^-[nErszu]*i(?:[nErszu]*$|[^A-Za-z])/.test(word) || word.startsWith("--in-place"))) {
      // BSD's ambiguous bare suffix (`sed -i bak 's/a/b/' f`: suffix or GNU
      // script — the dialect cannot be decided). Original last-target
      // behavior: record the last raw operand when it is a literal path, and
      // never when it is not (`$F`) or script-like (`s/…/…/`, `/addr/…`).
      const args = words.slice(commandIndex + 1);
      const bareIndex = args.indexOf("-i");
      const ambiguous = args[bareIndex + 1];
      // A script already supplied before the bare -i (first bare operand, or
      // any -e/-f/--expression/--file form) means the word after -i is the
      // GNU input file, not a BSD suffix — the normal walk records it.
      // The GNU final-input inference applies only when the word after the
      // bare -i is the LAST operand: with a script already supplied and
      // nothing following, BSD's suffix reading would have to edit stdin.
      const scriptBefore =
        bareIndex !== -1 &&
        args.slice(0, bareIndex).some(
          (word) =>
            !word.startsWith("-") ||
            word.startsWith("-e") ||
            word.startsWith("-f") ||
            word.startsWith("--expression") ||
            word.startsWith("--file"),
        );
      const finalTarget = scriptBefore && bareIndex === args.length - 2;
      if (
        !scriptBefore &&
        bareIndex !== -1 &&
        ambiguous !== undefined &&
        !ambiguous.startsWith("-") &&
        !ambiguous.startsWith(".") &&
        !ambiguous.includes("/")
      ) {
        const rest = args.slice(bareIndex + 2);
        const lastRaw = rest[rest.length - 1];
        // Address scripts (/^$/d) usually carry regex metachars the literal
        // filter already rejects; only the s|y prefix is excluded explicitly.
        // A no-target command may leave a path-looking last word — harmless:
        // trackFileOps only records successful executions, and genuine
        // literal absolute targets (/tmp/a.ts) stay valid files.
        if (
          lastRaw !== undefined &&
          literalShellPath(lastRaw) === lastRaw &&
          !/^(?:s|y)\//.test(lastRaw)
        ) {
          modified.push(lastRaw);
        }
        return { modified, deleted };
      }
      if (scriptBefore && !finalTarget) {
        // Script supplied AND operands follow (-i .bak file, -i bak file):
        // valid BSD suffix+input; the dialect is ambiguous, so keep main's
        // conservative last-target rule and never fabricate the suffix.
        const rest = args.slice(bareIndex + 1);
        const lastRaw = rest[rest.length - 1];
        if (
          lastRaw !== undefined &&
          literalShellPath(lastRaw) === lastRaw &&
          !/^(?:s|y)\//.test(lastRaw)
        ) {
          modified.push(lastRaw);
        }
        return { modified, deleted };
      }
      let scriptSeen = false;
      let options = true;
      for (let index = commandIndex + 1; index < words.length; index++) {
        const word = words[index];
        if (options && word === "--") {
          options = false;
          continue;
        }
        // shortcut: after a bare -i with no script yet supplied, a dotted
        // word is BSD's separate suffix (sed -i .bak 's/a/b/' f); it is
        // skipped, never the script or a file. With the script already
        // supplied before the -i, a final dotted word is the GNU input file
        // (.env, ./src/a.ts): BSD's suffix reading would have to edit stdin.
        // (The empty BSD suffix `sed -i '' s/…/ f` never appears as a word:
        // the tokenizer drops empty quotes.)
        if (
          options &&
          !finalTarget &&
          word === "-i" &&
          words[index + 1] !== undefined &&
          !words[index + 1].startsWith("-") &&
          words[index + 1].startsWith(".")
        ) {
          index++;
          continue;
        }
        if (options && (word === "-e" || word === "--expression" || word === "-f" || word === "--file")) {
          index++; // the option's value is a script (or script file), never an edited file
          scriptSeen = true;
          continue;
        }
        if (
          options &&
          (word.startsWith("--expression=") ||
            word.startsWith("--file=") ||
            /^-[ef]./.test(word)) // attached -es/a/b/ or -fscript.sed
        ) {
          scriptSeen = true;
          continue;
        }
        if (options && word.startsWith("-")) continue;
        // The script decision runs on the RAW word, before literalShellPath:
        // scripts freely contain $, [], (), * … and must still consume the
        // script slot, or the real file would be mistaken for the script.
        if (!scriptSeen) {
          scriptSeen = true; // first bare operand is the script
          continue;
        }
        const target = literalShellPath(word);
        if (target) modified.push(target);
      }
    }
    return { modified, deleted };
  }
  const operands = shellOperands(words, commandIndex + 1);
  if (!operands.length) return { modified, deleted };
  if (command === "rm" || command === "unlink") {
    deleted.push(...operands);
  } else if (command === "touch" || command === "tee") {
    modified.push(...operands);
  } else if (command === "cp" || command === "install") {
    modified.push(operands[operands.length - 1]);
  } else if (command === "mv") {
    deleted.push(...operands.slice(0, -1));
    modified.push(operands[operands.length - 1]);
  }
  return { modified, deleted };
}

/** Extract only explicit literal file targets from common mutating shell forms. */
// Commands whose plain use only reads. Anything else (interpreters, xargs, tee, awk, wrappers) stays unknown.
const READ_ONLY_SHELL_COMMANDS = new Set([
  "rg", "grep", "egrep", "fgrep", "cat", "head", "tail", "wc", "nl", "ls", "pwd", "cd", "echo", "printf", "true",
  "cut", "tr", "column", "jq", "diff", "cmp", "comm", "stat", "file", "du", "basename", "dirname", "realpath",
  "readlink", "which", "shasum", "sha256sum", "md5", "sort", "uniq", "find", "git", "sed",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "grep", "blame", "ls-files", "rev-parse"]);
// find actions that run, delete or write; `-fprint*` covers -fprint, -fprint0 and -fprintf.
const FIND_UNSAFE_RE = /^-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls)$/;
// sed is accepted only as a line-range printer: `w`, `e`, `r` and `s///w` can write, run or read.
const SED_PRINT_SCRIPT_RE = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/;
const INSTRUCTION_TEXT_RE = /(?:AGENTS|CLAUDE|GEMINI|SKILL|copilot-instructions)\.md|(?:^|[\s/'"])skills?\//i;

/** Unquoted globs, any expansion or substitution, or unbalanced quotes make a command's effect unknowable here. */
function hasShellExpansion(command: string): boolean {
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "`" || (char === "$" && /[\w{(@*#?!$-]/.test(command[index + 1] ?? ""))) return true;
    if (quote === "\"") {
      if (char === "\"") quote = null;
      continue;
    }
    if (char === "'" || char === "\"") quote = char;
    else if (char === "*" || char === "?" || char === "[") return true;
    else if ((char === "<" || char === ">") && command[index + 1] === "(") return true;
  }
  return quote !== null;
}

function readOnlySedArgs(args: string[]): boolean {
  let quiet = false;
  const scripts: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-n" || arg === "--quiet" || arg === "--silent") quiet = true;
    else if (arg === "-e") scripts.push(args[++index] ?? "");
    else if (arg === "-E" || arg === "-r") continue;
    else if (arg.startsWith("-")) return false;
    else if (!scripts.length) scripts.push(arg);
  }
  return quiet && scripts.length > 0 && scripts.every(script => SED_PRINT_SCRIPT_RE.test(script));
}

function readOnlyGitArgs(args: string[]): boolean {
  let index = 0;
  while (args[index] === "-C" || args[index] === "--no-pager") index += args[index] === "-C" ? 2 : 1;
  // `-c` can set core.pager or diff.external, so any other global option is unknown.
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(args[index] ?? "")) return false;
  return args.slice(index + 1).every(arg => !/^(?:--ext-diff|--textconv|--output|-O|--open-files-in-pager)/.test(arg));
}

function readOnlyShellSegment(words: string[]): boolean {
  if (!words.length) return true;
  const [head, ...args] = words;
  // Bare names only: `./rg` or `/tmp/cat` could be anything; `X=1 cmd` and `&` change how it runs.
  if (head.includes("/") || head.includes("=") || !READ_ONLY_SHELL_COMMANDS.has(head) || args.includes("&")) return false;
  switch (head) {
    case "find": return !args.some(arg => FIND_UNSAFE_RE.test(arg));
    case "rg": return !args.some(arg => arg.startsWith("--pre"));
    case "sort": return !args.some(arg => /^-[A-Za-z]*o/.test(arg) || arg.startsWith("--output"));
    case "uniq": return args.filter(arg => !arg.startsWith("-")).length < 2; // a second operand is an output file
    case "sed": return readOnlySedArgs(args);
    case "git": return readOnlyGitArgs(args);
    default: return true;
  }
}

/**
 * True only when every pipeline segment and line provably just reads: an allowlisted command, no
 * expansion, substitution, glob or heredoc, and redirects only to /dev/null or a file descriptor.
 * Fails closed; used to let a research rewind remove read-only shell exchanges.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  if (!command.trim() || hasShellExpansion(command)) return false;
  const tokens = tokenizeShell(command);
  let words: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === "heredoc") return false;
    if (token.kind === "redirect") {
      const target = tokens[index + 1];
      if (target?.kind !== "word" || !(target.value === "/dev/null" || /^&[\d-]$/.test(target.value))) return false;
      index++;
    } else if (token.kind === "separator") {
      if (!readOnlyShellSegment(words)) return false;
      words = [];
    } else {
      words.push(token.value);
    }
  }
  return readOnlyShellSegment(words);
}

/** Search/condition commands whose exit 1 is expected control flow, not failure. */
const NO_MATCH_EXIT_ONE_COMMANDS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "test", "[",
]);
/** Statements that may sit directly before the terminal in an && chain:
 * pwd/true execute nothing and cannot exit 1; cd can (Not a directory,
 * too many arguments) and is only trusted with positive terminal-execution
 * evidence (a counting grep that actually printed its zero count). Wrappers
 * (env/export/local) execute or fail on their own and never qualify. */
const HARMLESS_AND_PREFIX = new Set(["cd", "pwd", "true"]);

function isEnvAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** The command name of a pipeline's final unit (bare names only, like the read-only set). */
function terminalPipelineCommand(words: Array<{ kind: "word" | "pipe"; value: string }>): string | undefined {
  let last = words.length - 1;
  while (last >= 0 && words[last].kind !== "word") last--;
  let start = last;
  while (start > 0 && words[start - 1].kind === "word") start--;
  const name = words[start]?.value ?? "";
  // Bare names only: ./grep or /bin/grep could be anything.
  return name && !name.includes("/") && !isEnvAssignment(name) ? name : undefined;
}

/** The first command word of a statement (after any env assignments). */
function statementCommand(words: string[]): string | undefined {
  const first = words.find((word) => !isEnvAssignment(word));
  return first && !first.includes("/") ? first : undefined;
}

/**
 * True when the command itself proves that exit 1 is expected, non-fatal
 * control flow: the terminal pipeline ends in a no-match search or condition
 * (grep/rg family, test/[, git diff --exit-code/--quiet, diff -q), reached
 * without a short-circuit that could hide an earlier failure (an &&-joined
 * predecessor must be cd/pwd/assignment class; ; and || attribution is safe:
 * a ;-list exits with the last statement, and A || B exits 1 only when B ran).
 * Unknown commands, scripts and mutations never qualify — quiet stdout alone
 * proves nothing.
 */
export function exitOneIsExpectedNoMatch(
  command: string,
  evidence?: { terminalCountZero: boolean },
): boolean {
  // Command/process substitution can execute a failing command inside a
  // prefix (X=$(./deploy --quiet)); attribution is unknowable.
  if (/(?:\$\(|`|<\()/.test(command)) return false;
  const tokens = tokenizeShell(command);
  // A & backgrounds the previous command or is glued to it (f&); the
  // tokenizer keeps both as words. Whatever ran last is then not what the
  // words suggest — reject. A leading &<digits> is a redirect's fd target.
  if (
    tokens.some(
      (token) => token.kind === "word" && token.value.includes("&") && !/^&\d+$/.test(token.value),
    )
  )
    return false;
  interface Statement {
    sepBefore: ";" | "&&" | "||" | null;
    words: Array<{ kind: "word" | "pipe"; value: string }>;
    redirected: boolean;
  }
  const statements: Statement[] = [{ sepBefore: null, words: [], redirected: false }];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === "heredoc") continue;
    if (token.kind === "redirect") {
      statements[statements.length - 1].redirected = true;
      if (tokens[index + 1]?.kind === "word") index++; // the target is not a command
      continue;
    }
    if (token.kind === "separator") {
      if (token.value === "|") {
        statements[statements.length - 1].words.push({ kind: "pipe", value: "|" });
      } else {
        statements.push({
          sepBefore: token.value === "&&" || token.value === "||" ? token.value : ";",
          words: [],
          redirected: false,
        });
      }
      continue;
    }
    statements[statements.length - 1].words.push({ kind: "word", value: token.value });
  }
  // Trailing separators (e.g. a command ending in "&&") leave an empty terminal.
  while (statements.length && !statements[statements.length - 1].words.length) statements.pop();
  const terminal = statements[statements.length - 1];
  if (!terminal) return false;
  // An input redirect can fail in the shell before the terminal command runs
  // (grep ... <missing-file exits 1 from the shell); a tokenizer-level "<"
  // inside a word is the same shape.
  const terminalWords = terminal.words.map((item) => item.value);
  if (terminal.redirected || terminalWords.some((word) => word.startsWith("<"))) return false;
  // Under host-configured pipefail, any producer of the terminal pipeline can
  // own its exit; every producer must be a proven read-only command.
  const units: string[][] = [[]];
  for (const item of terminal.words) {
    if (item.kind === "pipe") units.push([]);
    else units[units.length - 1].push(item.value);
  }
  if (units.slice(0, -1).some((unit) => !readOnlyShellSegment(unit))) return false;
  const name = terminalPipelineCommand(terminal.words);
  const wordValues = terminalWords;
  // Positive evidence that the terminal counting search actually ran and
  // counted zero: only then may a failing-able cd prefix be trusted.
  const countingTerminal =
    name !== undefined &&
    ["grep", "egrep", "fgrep", "rg"].includes(name) &&
    wordValues.some((word) => word === "-c" || word === "--count" || /^-[^-]+c/.test(word));
  const benign =
    name !== undefined &&
    (NO_MATCH_EXIT_ONE_COMMANDS.has(name) ||
      (name === "git" &&
        wordValues[1] === "diff" &&
        wordValues.some((w) => w === "--exit-code" || w === "--quiet")) ||
      (name === "diff" && wordValues.some((w) => w === "-q" || w === "--brief" || w === "--exit-code")));
  if (!benign) return false;
  // The terminal's no-match exit proves nothing about earlier statements: a
  // ;-list discards their status and || even proves the left side failed.
  // Every pipe unit of every earlier statement must be provably read-only, a
  // condition, or a plain assignment — unknown/mutating segments fail closed.
  const unitPasses = (unit: string[]): boolean => {
    if (unit.length && unit.every((word) => isEnvAssignment(word))) return true;
    if (readOnlyShellSegment(unit)) return true;
    const unitName = unit.find((word) => !isEnvAssignment(word));
    return (
      unitName !== undefined &&
      !unitName.includes("/") &&
      (NO_MATCH_EXIT_ONE_COMMANDS.has(unitName) ||
        (unitName === "git" && unit[1] === "diff" && unit.some((w) => w === "--exit-code" || w === "--quiet")) ||
        (unitName === "diff" && unit.some((w) => w === "-q" || w === "--brief" || w === "--exit-code")))
    );
  };
  for (let index = 0; index < statements.length - 1; index++) {
    // A redirect can silence a read error (cat missing 2>/dev/null); a
    // hidden earlier failure stays a real failure regardless of boundaries.
    if (statements[index].redirected) return false;
    const units: string[][] = [[]];
    for (const item of statements[index].words) {
      if (item.kind === "pipe") units.push([]);
      else units[units.length - 1].push(item.value);
    }
    if (units.some((unit) => unit.length > 0 && !unitPasses(unit))) return false;
  }
  // `set` anywhere changes exit semantics (pipefail makes an earlier pipeline
  // producer own the exit; errexit aborts before the terminal) — reject.
  if (
    statements.some((statement) =>
      statementCommand(statement.words.filter((item) => item.kind === "word").map((item) => item.value)) === "set")
  )
    return false;
  // Attribution: walk back through the && chain into the terminal (the edge
  // INTO the next statement is the next statement's sepBefore). A ;-joined
  // boundary discards earlier exits, and || means the right side ran; only &&
  // can leave the exit owned by an unknown earlier command.
  for (let index = statements.length - 2; index >= 0; index--) {
    if (statements[index + 1].sepBefore !== "&&") break;
    const priorWords = statements[index].words
      .filter((item) => item.kind === "word")
      .map((item) => item.value);
    if (priorWords.some((word) => word.startsWith("<"))) return false;
    const prior = statementCommand(priorWords);
    const assignmentsOnly = priorWords.every((word) => isEnvAssignment(word));
    // A no-match predecessor is itself exit-1-benign: searches and conditions
    // exit 1 only for no-match/false (real errors exit 2), so a short-circuit
    // there still leaves exit 1 expected (main's rg/grep-chain behavior).
    // cd additionally requires the counting-terminal zero-count evidence.
    const harmless =
      prior !== undefined &&
      (HARMLESS_AND_PREFIX.has(prior) || NO_MATCH_EXIT_ONE_COMMANDS.has(prior)) &&
      (prior !== "cd" || (countingTerminal && Boolean(evidence?.terminalCountZero)));
    if (!assignmentsOnly && !harmless) return false;
  }
  return true;
}

/** Calls a research rewind may remove: read-only research tools, plus shell commands that provably only read. */
export function isRemovableResearchCall(toolName: string, input: Args): boolean {
  if (isReadOnlyResearchTool(toolName, input)) return true;
  if (!isShellTool(toolName)) return false;
  const command = COMMAND_KEYS.map(key => input[key]).find((value): value is string => typeof value === "string");
  // Instruction reads stay in context whichever tool made them.
  return command !== undefined && !INSTRUCTION_TEXT_RE.test(command) && isReadOnlyShellCommand(command);
}

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
    if (token.kind === "heredoc") continue;
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

/**
 * File paths a call reads (read-only tools carrying a path) or writes/deletes (mutating
 * tools by `classifyToolOperation`, plus literal shell targets). `path.normalize` only:
 * relative and absolute forms never match, so an unknown relation stays unsuperseded.
 */
export function fileOperationPaths(name: string, args: unknown): { reads: string[]; writes: string[] } {
  const input = args && typeof args === "object" ? args as Args : {};
  const path = extractToolPath(input);
  const writes: string[] = [];
  if (isShellTool(name)) {
    const shell = extractShellFileOperations(input);
    writes.push(...shell.modified, ...shell.deleted);
  } else if (path && ["mutate", "delete"].includes(classifyToolOperation(input, name))) {
    writes.push(path);
  }
  return {
    reads: path && !writes.length && isReadOnlyResearchTool(name, input) ? [normalize(path)] : [],
    writes: Array.from(new Set(writes.map(item => normalize(item)))),
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
type StableJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | StableJsonValue[]
  | { [key: string]: StableJsonValue };

function stableValue(value: unknown): StableJsonValue {
  if (Array.isArray(value)) return value.map(stableValue);
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined;
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
