import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import smartCompactExtension from "../src/index.ts";

const originalHome = process.env.HOME;
let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-context-tools-"));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function registeredTools(): Map<string, any> {
  const tools = new Map<string, any>();
  smartCompactExtension({
    registerCommand: () => {},
    registerTool: (definition: any) => tools.set(definition.name, definition),
    on: () => {},
  } as any);
  return tools;
}

function context() {
  return {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => "session-a",
      getBranch: () => [{ id: "branch-root" }, { id: "branch-head" }],
    },
  };
}

describe("context memory tools", () => {
  it("registers bounded recall and explicit save contracts", () => {
    const tools = registeredTools();
    const recall = tools.get("smart_recall");
    const save = tools.get("smart_save_memory");

    expect(recall).toBeDefined();
    expect(recall.parameters.properties.limit.maximum).toBe(10);
    expect(save).toBeDefined();
    expect(save.parameters.properties.content.maxLength).toBe(2_000);
    expect(save.parameters.properties.confirmed_by_user.type).toBe("boolean");
    expect(save.promptGuidelines.join(" ")).toContain("explicitly confirms");
  });

  it("saves scrubbed memory and recalls it from the current project", async () => {
    const tools = registeredTools();
    const ctx = context();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const saved = await tools.get("smart_save_memory").execute("save-1", {
      kind: "procedure",
      confirmed_by_user: true,
      title: "Release process",
      content: "Run frozen install before release; never persist " + token,
      related_paths: ["@package.json"],
    }, new AbortController().signal, () => {}, ctx);

    expect(saved.content[0].text).toContain("Saved project memory");
    expect(saved.details.redactions).toBe(1);
    expect(saved.details.memory.content).not.toContain(token);
    expect(saved.details.memory.relatedPaths).toEqual(["package.json"]);

    const recalled = await tools.get("smart_recall").execute("recall-1", {
      query: "frozen install release",
      limit: 5,
    }, new AbortController().signal, () => {}, ctx);
    expect(recalled.content[0].text).toContain("Release process");
    expect(recalled.content[0].text).toContain("same branch");
    expect(recalled.details.results[0].source).toBe("manual");

    const resolved = await tools.get("smart_save_memory").execute("save-resolve", {
      kind: "procedure",
      status: "resolved",
      confirmed_by_user: true,
      content: "Run frozen install before release; never persist " + token,
    }, new AbortController().signal, () => {}, ctx);
    expect(resolved.content[0].text).toContain("Resolved 1");
    const after = await tools.get("smart_recall").execute("recall-2", { query: "frozen install release" }, new AbortController().signal, () => {}, ctx);
    expect(after.content[0].text).toContain("No matching");
  });

  it("refuses unconfirmed memory", async () => {
    const save = registeredTools().get("smart_save_memory");
    const result = await save.execute("save-2", {
      kind: "context", confirmed_by_user: false, content: "an inferred guess",
    }, new AbortController().signal, () => {}, context());
    expect(result.content[0].text).toContain("confirmation is required");
  });
});
