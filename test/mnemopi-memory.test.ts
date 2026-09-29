import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import smartCompactExtension from "../src/index.ts";
import { contextGraphFile } from "../src/infra/paths.ts";
import { mnemopiTarget, runMnemopi } from "../src/app/mnemopi-memory.ts";
import { resolveBunExecutable } from "../src/app/memory-backend.ts";
import { deriveProjectIdFromCwd } from "../src/utils/fingerprint.ts";
import { resetConfigCache } from "../src/utils/config.ts";

const originalHome = process.env.HOME;
let home = "";
type MemoryTool = ToolDefinition<TSchema, {
  approved?: boolean;
  ref?: string;
  mnemopi: { state: string; dbPath: string; id: string; memoryId?: string; existing?: boolean; closed?: boolean; facts: Array<{ id: string; memoryId: string }> };
}>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-mnemopi-"));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
  resetConfigCache();
});

function setup() {
  const agentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    smartCompact: { toolLoading: "eager", memoryBackend: "mnemopi", contextGraphEnabled: false },
  }));
  resetConfigCache();
  const tools = new Map<string, MemoryTool>();
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  let active: string[] = ["read"];
  // This in-process host double implements only the extension APIs exercised here.
  const api = {
    registerCommand: () => { },
    registerTool: (definition: ToolDefinition) => {
      active.push(definition.name);
      // Registration erases the details generic; these two tools return memory outcomes.
      if (["smart_recall", "smart_save_memory"].includes(definition.name)) tools.set(definition.name, definition as MemoryTool);
    },
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI;
  smartCompactExtension(api);
  const confirmations: string[] = [];
  let approve = true;
  const ctx = {
    cwd: path.join(home, "project-a"),
    hasUI: true,
    getContextUsage: () => undefined,
    ui: {
      confirm: async (_title: string, message: string) => {
        confirmations.push(message);
        return approve;
      },
      setStatus: () => { },
    },
    sessionManager: {
      getSessionId: () => "session-a",
      getBranch: () => [{ id: "root" }],
    },
  };
  // Nested tool execution is unexpected in these tests; the stub fails loudly.
  const hostContext = Object.assign(ctx as unknown as ExtensionContext, {
    tools: [],
    executeTool: async () => {
      throw new Error("unexpected nested executeTool in mnemopi memory tests");
    },
  });
  // Other host context fields are unreachable in the memory tool path.
  for (const handler of handlers.get("session_start") ?? []) handler({}, hostContext);
  const run = async (name: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    if (!active.includes(name)) throw new Error(name + " is unavailable to the model");
    const result = await tools.get(name)!.execute("id", params, signal, () => { }, hostContext);
    return { ...result, content: result.content.filter((item) => item.type === "text") };
  };
  return {
    ctx,
    confirmations,
    approve(value: boolean) { approve = value; },
    save: (params: Record<string, unknown>, signal?: AbortSignal) =>
      run("smart_save_memory", { kind: "decision", ...params }, signal),
    recall: (params: Record<string, unknown>) => run("smart_recall", params),
  };
}

const FACT = "Use violet quartz project boundaries for every durable memory";
const memoryDir = () => path.join(home, ".pi", "agent", "smart-compact-memory", "mnemopi");

describe("Mnemopi confirmed project memory", () => {
  it("does not create a memory store without host consent, including cancellation during confirmation", async () => {
    const harness = setup();
    harness.ctx.hasUI = false;
    expect((await harness.save({ content: FACT })).content[0].text).toContain("interactive host confirmation");
    harness.ctx.hasUI = true;
    harness.approve(false);
    expect((await harness.save({ content: FACT })).details.approved).toBe(false);
    const controller = new AbortController();
    harness.ctx.ui.confirm = async () => { controller.abort(); return true; };
    await harness.save({ content: FACT }, controller.signal);
    expect(fs.existsSync(memoryDir())).toBe(false);
    expect(fs.existsSync(contextGraphFile())).toBe(false);
  });

  it("stores the confirmed scrubbed fact once, across sessions and normalized duplicate inputs", async () => {
    const harness = setup();
    const secret = "sk-" + "a1b2c3d4e5".repeat(4);
    const saved = await harness.save({ title: "Project boundary", content: FACT + " token=" + secret });
    expect(saved.details.mnemopi.state).toBe("saved");
    expect(harness.confirmations[0]).toContain(saved.details.mnemopi.dbPath);
    expect(harness.confirmations[0]).not.toContain(secret);
    harness.ctx.sessionManager.getSessionId = () => "session-b";
    const duplicate = await harness.save({ content: FACT.toUpperCase() + "  token=" + secret });
    expect(duplicate.details.mnemopi.id).toBe(saved.details.mnemopi.id);
    expect(duplicate.details.mnemopi.existing).toBe(true);
    const recalled = await harness.recall({ query: "violet quartz" });
    expect(recalled.details.mnemopi.facts.map((fact) => fact.id)).toEqual([saved.details.mnemopi.id]);
    expect(recalled.content[0].text).not.toContain(secret);
    expect(recalled.content[0].text).toContain("untrusted");
    expect(fs.statSync(saved.details.mnemopi.dbPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(contextGraphFile())).toBe(false);
    expect(fs.existsSync(path.join(home, ".hermes"))).toBe(false);
  });

  it("isolates projects and kinds, and resolves only the exact approved fact", async () => {
    const harness = setup();
    const decision = await harness.save({ content: FACT });
    const warning = await harness.save({ kind: "warning", content: FACT });
    harness.ctx.cwd = path.join(home, "project-b");
    expect((await harness.recall({ query: "violet quartz" })).details.mnemopi.facts).toEqual([]);
    const other = await harness.save({ content: FACT });
    expect(other.details.mnemopi.dbPath).not.toBe(decision.details.mnemopi.dbPath);
    harness.ctx.cwd = path.join(home, "project-a");
    const resolved = await harness.save({ status: "resolved", ref: decision.details.ref });
    expect(resolved.details.mnemopi.closed).toBe(true);
    const again = await harness.save({ status: "resolved", ref: decision.details.ref });
    expect(again.content[0].text).toContain("No active Mnemopi fact matches ref");
    expect(again.details.mnemopi.closed).toBeUndefined();
    expect((await harness.recall({ query: "violet quartz", kinds: ["decision"] })).details.mnemopi.facts).toEqual([]);
    expect((await harness.recall({ query: "violet quartz", kinds: ["warning"] })).details.mnemopi.facts.map((fact) => fact.id)).toEqual([warning.details.mnemopi.id]);
    harness.ctx.cwd = path.join(home, "project-b");
    expect((await harness.recall({ query: "violet quartz" })).details.mnemopi.facts.map((fact) => fact.id)).toEqual([other.details.mnemopi.id]);
    expect((await harness.recall({ query: "violet quartz", scope: "session" })).details.mnemopi.state).toBe("skipped");
  // Ten worker spawns; a CI runner exceeded bun's 5 s default once (run 36352834061).
  }, 30_000);

  it("serializes concurrent normalized duplicate saves from separate workers", async () => {
    const harness = setup();
    const outcomes = await Promise.all([
      harness.save({ content: FACT }),
      harness.save({ content: FACT.toUpperCase() }),
    ]);
    expect(outcomes.map((result) => result.details.mnemopi.state)).toEqual(["saved", "saved"]);
    expect(outcomes[0].details.mnemopi.id).toBe(outcomes[1].details.mnemopi.id);
    const recalled = await harness.recall({ query: "violet quartz" });
    expect(recalled.details.mnemopi.facts.map((fact) => fact.id)).toEqual([outcomes[0].details.mnemopi.id]);
  });

  it("ignores inherited remote embedding and LLM configuration", async () => {
    let requests = 0;
    const tripwire = Bun.serve({
      hostname: "127.0.0.1", port: 0, fetch() {
        requests++;
        return new Response("Unexpected model request", { status: 503 });
      }
    });
    const overrides: Record<string, string> = {
      MNEMOPI_NO_EMBEDDINGS: "",
      MNEMOPI_EMBEDDINGS_VIA_API: "true",
      MNEMOPI_EMBEDDING_MODEL: "text-embedding-3-small",
      MNEMOPI_EMBEDDING_API_URL: tripwire.url.href,
      MNEMOPI_EMBEDDING_API_KEY: "synthetic-unused-key",
      MNEMOPI_LLM_ENABLED: "true",
      MNEMOPI_LLM_BASE_URL: tripwire.url.href,
      MNEMOPI_LLM_API_KEY: "synthetic-unused-key",
      MNEMOPI_LLM_MODEL: "synthetic-unused-model",
    };
    const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, overrides);
      const harness = setup();
      const saved = await harness.save({ content: FACT });
      expect(saved.details.mnemopi.state).toBe("saved");
      const recalled = await harness.recall({ query: "violet quartz" });
      expect(recalled.details.mnemopi.facts.map((fact) => fact.id)).toEqual([saved.details.mnemopi.id]);
      expect(requests).toBe(0);
      expect(fs.existsSync(path.join(home, ".omp", "cache", "fastembed-runtime"))).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      tripwire.stop(true);
    }
  });

  it("does not silently save to the local graph when no Bun runtime can start", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = home;
    try {
      // bunExecutable: null forces the PATH fallback, which cannot resolve.
      const outcome = await runMnemopi({
        dbPath: path.join(memoryDir(), "project-x", "memory.sqlite"),
        projectId: "project-x",
        operation: "save",
        memoryId: "cg-" + "1".repeat(24),
        kind: "decision",
        title: "No runtime",
        content: FACT,
        relatedPaths: [],
      }, undefined, { bunExecutable: null });
      expect(outcome.state).toBe("failed");
      expect(fs.existsSync(memoryDir())).toBe(false);
      expect(fs.existsSync(contextGraphFile())).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it.skipIf(!resolveBunExecutable())("runs the worker via the package-owned Bun dependency even without PATH", async () => {
    const owned = resolveBunExecutable();
    const harness = setup();
    const originalPath = process.env.PATH;
    process.env.PATH = home;
    try {
      const saved = await harness.save({ content: FACT });
      expect(owned?.source).toBe("package");
      expect(saved.details.mnemopi.state).toBe("saved");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("surfaces a busy database lock cause without stealing or removing it", async () => {
    const harness = setup();
    const dbPath = mnemopiTarget(
      { mnemopiDataDir: null },
      deriveProjectIdFromCwd(path.join(home, "project-a"))!,
    ).dbPath;
    // Hold the cross-process lock exactly like another live session.
    fs.mkdirSync(dbPath + ".lock", { recursive: true });
    fs.writeFileSync(path.join(dbPath + ".lock", "owner"), "999999:held-by-test");

    const result = await harness.save({ content: FACT });
    expect(result.details.mnemopi.state).toBe("failed");
    const text = result.content[0].text;
    expect(text).toContain(dbPath + ".lock");
    expect(fs.existsSync(dbPath + ".lock")).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("returns target-bound refs on saves and recalls and refuses retargeting", async () => {
    const harness = setup();
    const saved = await harness.save({ content: FACT });
    const recalled = await harness.recall({ query: "violet quartz" });
    expect(saved.details.mnemopi.memoryId).toBe(recalled.details.mnemopi.facts[0].memoryId);
    expect(recalled.content[0].text).toContain("Ref: " + saved.details.ref);

    // A ref bound to a different data root refuses instead of retargeting.
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({
        smartCompact: { memoryBackend: "mnemopi", contextGraphEnabled: false, mnemopiDataDir: path.join(home, "other-root") },
      }),
    );
    resetConfigCache();
    const other = await harness.save({ content: FACT });
    expect(other.details.ref).not.toBe(saved.details.ref);
    for (const ref of [saved.details.ref, String(other.details.ref).split("@")[0]]) {
      await harness.save({ status: "resolved", ref });
      const survivor = await harness.recall({ query: "violet quartz" });
      expect(survivor.details.mnemopi.facts.map(fact => fact.id)).toEqual([other.details.mnemopi.id]);
    }
    const resolved = await harness.save({ status: "resolved", ref: other.details.ref });
    expect(resolved.details.mnemopi.closed).toBe(true);
    expect((await harness.recall({ query: "violet quartz" })).details.mnemopi.facts).toEqual([]);
    const original = await setup().recall({ query: "violet quartz" });
    expect(original.details.mnemopi.facts.map(fact => fact.id)).toEqual([saved.details.mnemopi.id]);
  });
});
