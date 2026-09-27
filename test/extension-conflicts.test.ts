import { describe, expect, it } from "bun:test";
import type { SlashCommandInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import { conflictNotice, detectExtensionConflicts } from "../src/app/extension-conflicts.ts";

function source(path: string, pkg = "auto") {
  return { path, source: pkg, scope: "user" as const, origin: pkg === "auto" ? ("top-level" as const) : ("package" as const) };
}

function command(name: string, path: string, pkg?: string, kind: SlashCommandInfo["source"] = "extension"): SlashCommandInfo {
  return { name, source: kind, sourceInfo: source(path, pkg) };
}

function tool(name: string, path: string, pkg?: string): ToolInfo {
  return { name, description: "", parameters: {} as ToolInfo["parameters"], sourceInfo: source(path, pkg) };
}

const OWN = "/home/u/.pi/agent/git/github.com/u/pi-smart-compact/src/index.ts";
const ownRegistry = {
  commands: [command("smart-compact", OWN)],
  tools: ["smart_compact", "smart_context", "smart_recall", "smart_navigation", "smart_tools"].map((name) => tool(name, OWN)),
};

describe("detectExtensionConflicts", () => {
  it("finds nothing in an empty registry or in Continuity's own entries", () => {
    expect(detectExtensionConflicts({ commands: [], tools: [] })).toEqual([]);
    expect(detectExtensionConflicts(ownRegistry)).toEqual([]);
    expect(detectExtensionConflicts({ commands: [], tools: [tool("read", "<builtin:read>", "builtin")] })).toEqual([]);
  });

  it.each([
    [{ commands: [command("oai", "/n/node_modules/pi-openai-toolkit/index.ts", "npm:pi-openai-toolkit@1.2.0")], tools: [] }, "pi-openai-toolkit", "compaction", "/oai command from pi-openai-toolkit"],
    [{ commands: [command("fold-handoff", "/x/ext/folding.ts")], tools: [] }, "context-fold", "compaction", "/fold-handoff command"],
    [{ commands: [command("anything", "/home/u/.pi/agent/extensions/context-fold.ts")], tools: [] }, "context-fold", "compaction", "/anything command from context-fold"],
    [{ commands: [command("fold", "/x/ext/folding.ts")], tools: [] }, "pi-fold", "context-editing", "/fold command"],
    [{ commands: [], tools: [tool("fold_view", "/x/git/github.com/u/pi-fold/index.ts", "git:github.com/u/pi-fold")] }, "pi-fold", "context-editing", "fold_view tool from pi-fold"],
    [{ commands: [command("prune", "/x/ext/p.ts")], tools: [] }, "pi-context-prune", "context-editing", "/prune command"],
    [{ commands: [], tools: [tool("trim", "/n/node_modules/pi-context-prune/dist/index.js")] }, "pi-context-prune", "context-editing", "trim tool from pi-context-prune"],
    [{ commands: [command("dcp", "/x/dcp/index.ts")], tools: [] }, "pi-dcp", "context-editing", "/dcp command from pi-dcp"],
    [{ commands: [], tools: [tool("discard", "/n/node_modules/@u/pi-dcp/index.ts")] }, "pi-dcp", "context-editing", "discard tool from pi-dcp"],
    [{ commands: [], tools: [tool("context", "/x/git/github.com/u/pi-toolkit/extensions/context.ts")] }, "pi-toolkit", "context-editing", "context tool from pi-toolkit"],
  ] as const)("detects signature %#", (registry, name, kind, evidence) => {
    expect(detectExtensionConflicts({ commands: [...registry.commands], tools: [...registry.tools] })).toEqual([{ name, kind, evidence }]);
  });

  it("matches whole segments and names only", () => {
    expect(detectExtensionConflicts({
      commands: [
        command("notes", "/n/node_modules/my-dcp-notes/index.ts", "npm:dcp-notes@1.0.0"),
        command("unfold", "/x/pi-folders/index.ts"),
        command("context", "/x/pi-toolkit-extras/index.ts"),
        command("prune", "/x/prompts/prune.md", undefined, "prompt"),
      ],
      tools: [
        tool("context", "/x/other-ext/index.ts"),
        tool("dump", "/x/pi-toolkit/extensions/dump.ts"),
        tool("pruner", "/x/pi-context-pruner/index.ts"),
      ],
    })).toEqual([]);
  });

  it("reports one entry per extension, sorted by name, and attributes /fold to context-fold when it is loaded", () => {
    const fold = "/n/node_modules/context-fold/index.ts";
    expect(detectExtensionConflicts({
      commands: [command("prune", "/x/p.ts"), command("fold", fold), command("fold-handoff", fold), ...ownRegistry.commands],
      tools: [tool("discard", "/x/pi-dcp/index.ts"), tool("discard_all", "/x/pi-dcp/index.ts"), ...ownRegistry.tools],
    })).toEqual([
      { name: "context-fold", kind: "compaction", evidence: "/fold command from context-fold" },
      { name: "pi-context-prune", kind: "context-editing", evidence: "/prune command" },
      { name: "pi-dcp", kind: "context-editing", evidence: "discard tool from pi-dcp" },
    ]);
    expect(detectExtensionConflicts({
      commands: [command("fold", "/x/a.ts"), command("fold-handoff", "/x/a.ts")],
      tools: [],
    })).toEqual([{ name: "context-fold", kind: "compaction", evidence: "/fold-handoff command" }]);
  });
});

describe("conflictNotice", () => {
  it("names every extension with its evidence and advises keeping one", () => {
    const text = conflictNotice([
      { name: "context-fold", kind: "compaction", evidence: "/fold-handoff command" },
      { name: "pi-dcp", kind: "context-editing", evidence: "discard tool from pi-dcp" },
    ]);
    expect(text).toStartWith("context-fold and pi-dcp also compact or edit this conversation (context-fold: /fold-handoff command; pi-dcp: discard tool from pi-dcp).");
    expect(text).toContain("Keep only one loaded");
    expect(conflictNotice([{ name: "pi-fold", kind: "context-editing", evidence: "/fold command" }]))
      .toStartWith("pi-fold also compacts or edits this conversation (pi-fold: /fold command).");
  });
});
