import { describe, it, expect } from "bun:test";
import { classifyTool, extractToolPath } from "../src/domain/tool-semantics.ts";

describe("classifyTool", () => {
  it("classifies path + content payload as mutates (name-agnostic)", () => {
    // Unknown names on purpose: classification is by argument shape, not name.
    expect(classifyTool({ path: "a.ts", content: "x" })).toBe("mutates");
    expect(classifyTool({ file_path: "a.ts", content: "x" })).toBe("mutates");
    expect(classifyTool({ filePath: "a.ts", newText: "b", oldText: "a" })).toBe("mutates");
    expect(classifyTool({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] })).toBe("mutates");
    expect(classifyTool({ path: "a.ts", patch: "@@ diff @@" })).toBe("mutates");
    expect(classifyTool({ path: "a.ts", replacement: "y" })).toBe("mutates");
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

describe("extractToolPath", () => {
  it("returns the path across common key names", () => {
    expect(extractToolPath({ path: "a.ts" })).toBe("a.ts");
    expect(extractToolPath({ file_path: "a.ts" })).toBe("a.ts");
    expect(extractToolPath({ filePath: "a.ts" })).toBe("a.ts");
    expect(extractToolPath({ filename: "a.ts" })).toBe("a.ts");
    expect(extractToolPath({ file: "a.ts" })).toBe("a.ts");
  });

  it("returns undefined when no usable path is present", () => {
    expect(extractToolPath({})).toBeUndefined();
    expect(extractToolPath({ path: "" })).toBeUndefined(); // empty path is not usable
    expect(extractToolPath({ path: 42 })).toBeUndefined(); // non-string ignored
    expect(extractToolPath(undefined)).toBeUndefined();
    expect(extractToolPath(null)).toBeUndefined();
  });
});
