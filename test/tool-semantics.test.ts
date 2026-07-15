import { describe, it, expect } from "bun:test";
import { classifyTool, classifyToolOperation, extractToolPath, normalizeToolName } from "../src/domain/tool-semantics.ts";

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
