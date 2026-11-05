import { describe, it, expect } from "bun:test";
import {
  classifyTool, classifyToolOperation, extractShellFileOperations, extractToolPath, fileOperationPaths, isReadOnlyShellCommand, isRemovableResearchCall, isArchivableToolResult, isReadOnlyResearchTool, normalizeToolName,
  toolCallSubject, exitOneIsExpectedNoMatch,
} from "../src/domain/tool-semantics.ts";

describe("classifyTool", () => {
  it("classifies path + content payload as mutates (name-agnostic)", () => {
    // Unknown names on purpose: classification is by argument shape, not name.
    expect(classifyTool({ path: "a.ts", content: "x" })).toBe("mutates");
    expect(classifyTool({ file_path: "a.ts", content: "x" })).toBe("mutates");
    expect(classifyTool({ filePath: "a.ts", newText: "b", oldText: "a" })).toBe("mutates");
    expect(classifyTool({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] })).toBe("mutates");
    expect(classifyTool({ path: "a.ts", patch: "@@ diff @@" })).toBe("mutates");
    expect(classifyTool({ path: "a.ts", replacement: "y" })).toBe("mutates");
    expect(classifyTool({ target_file: "a.ts", old_str: "x", new_str: "y" })).toBe("mutates");
    expect(classifyTool({ file_uri: "file:///a.ts", old_string: "x", new_string: "y" })).toBe("mutates");
    expect(classifyTool({ path: "a.ts", content: "" })).toBe("mutates"); // empty-file write still mutates
  });

  it("classifies command args as executes (name-agnostic)", () => {
    expect(classifyTool({ command: "npm test" })).toBe("executes");
    expect(classifyTool({ cmd: "ls" })).toBe("executes");
    expect(classifyTool({ script: "build.sh" })).toBe("executes");
  });

  it("classifies path-only as accesses (read/grep/find/ls)", () => {
    expect(classifyTool({ path: "a.ts" })).toBe("accesses");
    expect(classifyTool({ path: "a.ts", pattern: "foo" })).toBe("accesses"); // grep: pattern is NOT a payload
    expect(classifyTool({ file_path: "a.ts", limit: 10 })).toBe("accesses");
  });

  it("classifies non-file / non-command tools as other", () => {
    expect(classifyTool({})).toBe("other");
    expect(classifyTool({ questions: [] })).toBe("other"); // ask_user
    expect(classifyTool({ name: "foo", id: 1 })).toBe("other"); // process-like
  });

  it("guards against non-object / nullish args", () => {
    expect(classifyTool(undefined)).toBe("other");
    expect(classifyTool(null)).toBe("other");
    expect(classifyTool("string")).toBe("other");
  });

  it("treats path + payload as mutates even when a command key is also present", () => {
    // A write tool that happens to log a command is still a write.
    expect(classifyTool({ path: "a.ts", content: "x", command: "echo done" })).toBe("mutates");
  });
});

describe("classifyToolOperation", () => {
  it("classifies the fine EESV operation taxonomy", () => {
    expect(classifyToolOperation({ path: "a.ts" }, "functions.read")).toBe("read");
    expect(classifyToolOperation({ path: "a.ts", pattern: "foo" }, "grep")).toBe("search");
    expect(classifyToolOperation({ path: "src" }, "list_files")).toBe("list");
    expect(classifyToolOperation({ absolute_path: "a.ts", old_string: "x", new_string: "y" }, "mcp__edit_file")).toBe("mutate");
    expect(classifyToolOperation({ path: "a.ts" }, "delete_file")).toBe("delete");
    expect(classifyToolOperation({ command: "bun test" }, "bash")).toBe("execute");
    expect(classifyToolOperation({}, "ask_user")).toBe("unknown");
  });

  it("uses a mutation tool name only as a safe path + text tie-breaker", () => {
    expect(classifyToolOperation({ path: "a.ts", text: "x" }, "read_text_file")).toBe("read");
    expect(classifyToolOperation({ target_file: "a.ts", text: "x" }, "mcp__write_file")).toBe("mutate");
    expect(classifyTool({ path: "a.ts", text: "x" })).toBe("accesses");
  });

  it("normalizes provider wrappers and separators", () => {
    expect(normalizeToolName("functions.readFile")).toBe("read_file");
  });
});

describe("extractToolPath", () => {
  it("returns the path across common key names", () => {
    expect(extractToolPath({ path: "a.ts" })).toBe("a.ts");
    expect(extractToolPath({ file_path: "a.ts" })).toBe("a.ts");
    expect(extractToolPath({ filePath: "a.ts" })).toBe("a.ts");
    expect(extractToolPath({ filename: "a.ts" })).toBe("a.ts");
    expect(extractToolPath({ file: "a.ts" })).toBe("a.ts");
    expect(extractToolPath({ target_file: "a.ts" })).toBe("a.ts");
    expect(extractToolPath({ file_uri: "file:///a.ts" })).toBe("file:///a.ts");
    expect(extractToolPath({ absolute_path: "/a.ts" })).toBe("/a.ts");
  });

  it("returns undefined when no usable path is present", () => {
    expect(extractToolPath({})).toBeUndefined();
    expect(extractToolPath({ path: "" })).toBeUndefined(); // empty path is not usable
    expect(extractToolPath({ path: 42 })).toBeUndefined(); // non-string ignored
    expect(extractToolPath(undefined)).toBeUndefined();
    expect(extractToolPath(null)).toBeUndefined();
  });
});

describe("isArchivableToolResult", () => {
  it.each([
    "fetch_content", "lens_diagnostics", "effective_config", "ast_grep_search",
    "search_graph", "trace_path", "get_code_snippet", "get_file_outline", "query_graph", "get_architecture",
    "search_code", "get_graph_schema", "index_status", "check_index_coverage", "detect_changes", "compare_graphs", "list_projects",
  ])("recognizes known read-only research tool %s without merging namespaces", name => {
    expect(isReadOnlyResearchTool(name, {})).toBe(true);
    expect(isReadOnlyResearchTool("functions." + name, {})).toBe(true);
    expect(isArchivableToolResult(name, {})).toBe(true);
    expect(isReadOnlyResearchTool("untrusted_server__" + name, {})).toBe(false);
  });

  it("keeps mutating tools, unknown operations and graph reads of instruction sources", () => {
    for (const name of ["index_repository", "delete_project", "ingest_traces", "manage_adr", "ast_grep_replace", "process", "ask_user", "smart_save_memory"]) {
      expect(isReadOnlyResearchTool(name, {})).toBe(false);
    }
    expect(isReadOnlyResearchTool("get_code_snippet", { qualified_name: "repo.AGENTS.Rules" })).toBe(false);
    expect(isReadOnlyResearchTool("get_code_snippet", { qualified_name: "repo.assets.skills.workflow.SKILL" })).toBe(false);
    expect(isReadOnlyResearchTool("get_file_outline", { file_path: "AGENTS.md" })).toBe(false);
  });

  it("admits shell output and smart_context reads without widening read-only research", () => {
    expect(isArchivableToolResult("functions.bash", { command: "bun test" })).toBe(true);
    expect(isReadOnlyResearchTool("bash", { command: "bun test" })).toBe(false);
    expect(isArchivableToolResult("read", { path: "src/a.ts" })).toBe(true);
    expect(isArchivableToolResult("smart_context", { action: "read", id: "x" })).toBe(true);
    for (const action of ["status", "search", "plan", "trim", "rewind"]) {
      expect(isArchivableToolResult("smart_context", { action })).toBe(false);
      expect(isReadOnlyResearchTool("smart_context", { action })).toBe(true);
    }
    expect(isArchivableToolResult("write", { path: "a", content: "x" })).toBe(false);
    expect(isArchivableToolResult("custom_tool", {})).toBe(false);
    expect(isArchivableToolResult("read", { path: "/repo/AGENTS.md" })).toBe(false);
  });

  it("admits process output and list, never actions that change processes", () => {
    for (const action of ["output", "list"]) {
      expect(isArchivableToolResult("process", { action, id: "proc_1" })).toBe(true);
      expect(isArchivableToolResult("functions.process", { action })).toBe(true);
      // Rewind removal and early offload keep their own allowlist.
      expect(isReadOnlyResearchTool("process", { action })).toBe(false);
    }
    for (const action of ["start", "stop", "write", "update", "clear", undefined]) {
      expect(isArchivableToolResult("process", { action })).toBe(false);
    }
    expect(isArchivableToolResult("other__process", { action: "output" })).toBe(false);
  });
});

describe("toolCallSubject", () => {
  it("names the path, first command line, or search pattern", () => {
    expect(toolCallSubject("read_symbol", { path: "src/a.ts", symbol: "run" })).toBe("path: src/a.ts");
    expect(toolCallSubject("bash", { command: "\n  bun test\nbun run build" })).toBe("$   bun test");
    expect(toolCallSubject("grep", { pattern: "TODO", path: "src" })).toBe("pattern: TODO");
    expect(toolCallSubject("ls", { path: "src" })).toBe("path: src");
    expect(toolCallSubject("smart_context", { action: "read", id: "x" })).toBeUndefined();
    expect(toolCallSubject("read", {})).toBeUndefined();
  });
});

describe("fileOperationPaths", () => {
  it("separates read targets from written, edited and deleted targets", () => {
    expect(fileOperationPaths("read", { path: "./src/a.ts" })).toEqual({ reads: ["src/a.ts"], writes: [] });
    expect(fileOperationPaths("grep", { pattern: "x", path: "src/" })).toEqual({ reads: ["src/"], writes: [] });
    expect(fileOperationPaths("grep", { pattern: "x" })).toEqual({ reads: [], writes: [] });
    expect(fileOperationPaths("write", { path: "src/a.ts", content: "" })).toEqual({ reads: [], writes: ["src/a.ts"] });
    expect(fileOperationPaths("edit", { path: "src/x/../a.ts", oldText: "a", newText: "b" })).toEqual({ reads: [], writes: ["src/a.ts"] });
    expect(fileOperationPaths("delete_file", { path: "src/a.ts" })).toEqual({ reads: [], writes: ["src/a.ts"] });
    expect(fileOperationPaths("bash", { command: "sed -i '' 's/a/b/' src/a.ts && echo x > out.txt; rm -f old.ts" }))
      .toEqual({ reads: [], writes: ["src/a.ts", "out.txt", "old.ts"] });
    expect(fileOperationPaths("bash", { command: "cat src/a.ts" })).toEqual({ reads: [], writes: [] });
  });

  it("ignores unknown tools and non-object arguments", () => {
    expect(fileOperationPaths("mystery", { path: "src/a.ts" })).toEqual({ reads: [], writes: [] });
    expect(fileOperationPaths("read", null)).toEqual({ reads: [], writes: [] });
    expect(fileOperationPaths("read", { path: "AGENTS.md" })).toEqual({ reads: [], writes: [] });
  });
});

describe("extractShellFileOperations sed in place", () => {
  it("never records the sed script as the edited file", () => {
    // The real 15:34 compaction recorded "s/\\u2192/→/g" as a modified file:
    // with a non-literal target ($F) the script was the only operand left.
    expect(extractShellFileOperations({ command: "sed -i 's/\\\\u2192/→/g' $F" })).toEqual({ modified: [], deleted: [] });
  });

  it("records the literal file when the script is the first operand", () => {
    expect(extractShellFileOperations({ command: "sed -i 's/a/b/g' src/a.ts" })).toEqual({ modified: ["src/a.ts"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i '' 's/a/b/' src/a.ts" })).toEqual({ modified: ["src/a.ts"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i.bak 's/a/b/' src/a.ts" })).toEqual({ modified: ["src/a.ts"], deleted: [] });
  });

  it("treats -e/--expression and -f/--file values as scripts, not files", () => {
    expect(extractShellFileOperations({ command: "sed -i -e 's/a/b/' -e 's/c/d/' src/a.ts src/b.ts" }))
      .toEqual({ modified: ["src/a.ts", "src/b.ts"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed --in-place --expression='s/a/b/' src/a.ts" }))
      .toEqual({ modified: ["src/a.ts"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i -f fixes.sed src/a.ts" }))
      .toEqual({ modified: ["src/a.ts"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed --file=fixes.sed --in-place src/a.ts" }))
      .toEqual({ modified: ["src/a.ts"], deleted: [] });
  });

  it("records every edited file when the script leaves earlier ones unrecorded", () => {
    // The old last-operand rule recorded only src/b.ts here.
    expect(extractShellFileOperations({ command: "sed -i 's/a/b/' src/a.ts src/b.ts" }))
      .toEqual({ modified: ["src/a.ts", "src/b.ts"], deleted: [] });
  });

  it("records the literal file when the script itself is not a literal path", () => {
    // Scripts freely contain $, [], (), + — the script slot must still be
    // consumed, or the real file is mistaken for the script.
    expect(extractShellFileOperations({ command: "sed -i 's/foo(/bar(/' src/a.ts" }))
      .toEqual({ modified: ["src/a.ts"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i '/^$/d' src/a.ts" }))
      .toEqual({ modified: ["src/a.ts"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i 's/[0-9]+/N/g' src/a.ts" }))
      .toEqual({ modified: ["src/a.ts"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i 's/a/b/;s/c/d/' src/a.ts" }))
      .toEqual({ modified: ["src/a.ts"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i -es/a/b/ src/a.ts" }))
      .toEqual({ modified: ["src/a.ts"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i '' '/^$/d' src/a.ts" }))
      .toEqual({ modified: ["src/a.ts"], deleted: [] });
  });

  it("records bundled -ni flags and BSD's separate dotted suffix", () => {
    expect(extractShellFileOperations({ command: "sed -ni 's/a/b/' f" })).toEqual({ modified: ["f"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -in 's/a/b/' f" })).toEqual({ modified: ["f"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i .bak 's/a/b/' f" })).toEqual({ modified: ["f"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i .bak -e 's/a/b/' f" })).toEqual({ modified: ["f"], deleted: [] });
  });

  it("never treats attached -e/-f scripts as in-place flags", () => {
    // Attached script forms contain dots/slashes and must stay read-only.
    expect(extractShellFileOperations({ command: "sed -ffixes.sed input" })).toEqual({ modified: [], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -fsedscript input" })).toEqual({ modified: [], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -es/a/b/ f" })).toEqual({ modified: [], deleted: [] });
  });

  it("handles the ambiguous bare -i suffix form without fabricating files", () => {
    // `sed -i bak ...` is BSD's separate suffix or GNU's script — undecided,
    // so the bare suffix-shaped word is skipped and the script keeps its slot.
    expect(extractShellFileOperations({ command: "sed -i bak 's/a/b/' file" }))
      .toEqual({ modified: ["file"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i bak 's/a/b/' $F" }))
      .toEqual({ modified: [], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i bak -e 's/a/b/' file" }))
      .toEqual({ modified: ["file"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i bak 's/a/b/'" }))
      .toEqual({ modified: [], deleted: [] });
    // GNU slashless scripts keep main's behavior: the file is recorded.
    expect(extractShellFileOperations({ command: "sed -i '3d' file" }))
      .toEqual({ modified: ["file"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i d file" }))
      .toEqual({ modified: ["file"], deleted: [] });
    // Unambiguous multi-file form is unchanged.
    expect(extractShellFileOperations({ command: "sed -i 's/a/b/' src/a.ts src/b.ts" }))
      .toEqual({ modified: ["src/a.ts", "src/b.ts"], deleted: [] });
    // Bundled attached suffixes edit the file.
    expect(extractShellFileOperations({ command: "sed -Ei.bak 's/a/b/' f" }))
      .toEqual({ modified: ["f"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -ni.bak 's/a/b/' f" }))
      .toEqual({ modified: ["f"], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -Ei~ 's/a/b/' f" }))
      .toEqual({ modified: ["f"], deleted: [] });
  });

  it("records nothing for read-only sed or in-place sed without a literal file", () => {
    expect(extractShellFileOperations({ command: "sed -n '40,75p' src/x.ts" })).toEqual({ modified: [], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i 's/a/b/' *.ts" })).toEqual({ modified: [], deleted: [] });
    expect(extractShellFileOperations({ command: "sed -i 's/a/b/'" })).toEqual({ modified: [], deleted: [] });
  });
});

describe("extractShellFileOperations heredocs", () => {
  it("reads a heredoc body as data, so arrow functions in it are not redirects", () => {
    const command = "cat > /tmp/x.test.ts <<\"EOF\"\nconst t = msgs.map(m => m.text);\nconst k = gaps.filter(g => g.kind === \"x\");\nEOF\nbun test /tmp/x.test.ts";
    expect(extractShellFileOperations({ command })).toEqual({ modified: ["/tmp/x.test.ts"], deleted: [] });
  });

  it("keeps commands after the terminator, honours <<- tab stripping and several heredocs", () => {
    const command = "python3 - <<-'PY' && cat <<A\n\tprint(1 > 0)\n\tPY\nx => y\nA\nrm old.txt";
    expect(extractShellFileOperations({ command })).toEqual({ modified: [], deleted: ["old.txt"] });
  });

  it("keeps a redirect written on the heredoc line itself", () => {
    expect(extractShellFileOperations({ command: "cat <<EOF > notes.md\na => b\nEOF" }).modified).toEqual(["notes.md"]);
  });
});

describe("exitOneIsExpectedNoMatch", () => {
  it.each([
    ["unknown directly before the terminal", "./deploy --quiet && grep -q missing file"],
    ["unknown behind a harmless cd", "./deploy --quiet && cd . && grep -q missing file"],
    ["harmless unknown chain both sides", "cd . && ./deploy --quiet && grep -q missing file"],
    ["env executes the unknown", "env ./deploy --quiet && grep -q missing file"],
    ["assignment runs a substitution", "X=$(./deploy --quiet) && grep -q missing file"],
    ["pipefail producer owns the exit", "set -o pipefail; ./deploy --quiet | grep -q ready"],
    ["unknown pipeline producer before a matching grep", "./deploy --quiet | grep -q ready"],
    ["failable export predecessor", "export -f nonexistent_function && grep -q missing file"],
    ["failable local predecessor", "local X=1 && grep -q missing file"],
    ["redirect hides a failed cd predecessor", "cd /does-not-exist 2>/dev/null && grep -q missing file"],
    ["input redirect fails in the shell before grep", "grep -q needle <missing-file"],
    ["redirect on the terminal pipeline", "ls /tmp/dir 2>/dev/null | grep 2026-11-05"],
  ])("rejects %s", (_label, command) => {
    expect(exitOneIsExpectedNoMatch(command)).toBe(false);
  });

  it.each([
    ["terminal count grep after an edit", "F=docs/status.md; sed -i 's/a/b/' \"$F\"; grep -c 'x' \"$F\""],
    ["ls piped into grep", "ls /tmp/dir | grep 2026-11-05"],
    ["git-diff producer piped into grep", "git diff main... --stat | tail -1 | grep -i hindsight"],
    ["git diff name-only piped into grep", "git diff main... --name-only | grep -i hindsight"],
    ["git diff --exit-code", "git diff --exit-code main -- src/"],
    ["test condition", "test -f /tmp/lock"],
    ["loop body before the terminal grep", "for i in 1 2 3; do bun test test/x.test.ts 2>&1 | grep -E \"pass|fail\" | tr '\\n' ' '; echo; done; git diff main... --name-only | grep -i hindsight"],
  ])("accepts %s", (_label, command) => {
    expect(exitOneIsExpectedNoMatch(command)).toBe(true);
  });

  it("accepts a cd predecessor only with a counting terminal that printed zero", () => {
    const command = 'cd /repo/data && grep -c "needle" sessions.jsonl';
    expect(exitOneIsExpectedNoMatch(command)).toBe(false); // no evidence
    expect(exitOneIsExpectedNoMatch(command, { terminalCountZero: false })).toBe(false);
    expect(exitOneIsExpectedNoMatch(command, { terminalCountZero: true })).toBe(true); // grep ran, counted 0
  });

  it.each([
    ["backgrounded search then node", "grep -q pat f & node build.js"],
    ["glued background ampersand", "grep -q pat f& node build.js"],
    ["cd failing at exit 1 (not a directory)", "cd /f-not-dir && grep -q missing file"],
    ["cd failing at exit 1 (too many arguments)", "cd a b && grep -q missing file"],
  ])("rejects %s", (_label, command) => {
    expect(exitOneIsExpectedNoMatch(command)).toBe(false);
  });
});

describe("isReadOnlyShellCommand", () => {
  it.each([
    "rg -n \"foo|bar\" src --type ts | head -20 | cut -c1-140",
    "cd /repo; wc -l src/a.ts src/b.ts | sort -n | tail -5",
    "sed -n 40,75p src/x.ts; sed -n '$p' notes.md",
    "git -C repo --no-pager diff --stat && git log --oneline -5",
    "find src -name '*.ts' -type f | wc -l",
    "rg -c foo src 2>/dev/null || echo none",
    "ls src/app | tr '\\n' ' '",
    "echo \"price is 5$\"",
  ])("accepts %s", command => {
    expect(isReadOnlyShellCommand(command)).toBe(true);
  });

  it.each([
    ["sed scripts that write, run or read", "sed -n '1p;w out.txt' a.txt"],
    ["sed substitution with w flag", "sed -n 's/a/b/w out' a.txt"],
    ["sed in place", "sed -i '' 1d a.txt"],
    ["rg preprocessors", "rg --pre=sh foo src"],
    ["git config overrides", "git -c core.pager=sh log"],
    ["git external diff", "git diff --ext-diff"],
    ["git diff output files", "git diff --output=out.patch"],
    ["git writes", "git branch new-name"],
    ["find actions", "find . -name x -execdir rm {} +"],
    ["find file printers", "find . -fprintf out.txt '%p'"],
    ["command substitution", "cat $(echo a.txt)"],
    ["backticks", "cat `ls`"],
    ["process substitution", "diff <(ls a) <(ls b)"],
    ["variables", "cat \"$FILE\""],
    ["unquoted globs", "wc -l src/*.ts"],
    ["unbalanced quotes", "echo 'oops"],
    ["file redirects", "rg foo > out.txt"],
    ["pipes into a shell", "cat script.sh | sh"],
    ["a second unsafe line", "rg foo\nrm -rf build"],
    ["heredocs", "cat <<EOF\nhello\nEOF"],
    ["interpreters", "python3 -c 'print(1)'"],
    ["background jobs", "rg foo src &"],
    ["paths as commands", "./rg foo"],
    ["assignments", "LC_ALL=C sort a.txt"],
    ["sort output files", "sort -o out.txt a.txt"],
    ["uniq output operands", "uniq in.txt out.txt"],
  ])("rejects %s", (_label, command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });

  it("keeps instruction reads and non-shell tools on their existing rules", () => {
    expect(isRemovableResearchCall("bash", { command: "rg -n foo src" })).toBe(true);
    expect(isRemovableResearchCall("bash", { command: "cat AGENTS.md" })).toBe(false);
    expect(isRemovableResearchCall("bash", { command: "sed -n 1,40p .pi/skills/x/SKILL.md" })).toBe(false);
    expect(isRemovableResearchCall("read", { path: "src/a.ts" })).toBe(true);
    expect(isRemovableResearchCall("edit", { path: "src/a.ts" })).toBe(false);
  });
});
