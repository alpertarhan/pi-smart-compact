import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import smartCompactExtension from "../src/index.ts";
import { resetConfigCache } from "../src/utils/config.ts";

const originalHome = process.env.HOME;
let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-tool-rows-"));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({
      smartCompact: {
        contextGraphEnabled: true,
        toolLoading: "lazy",
        memoryBackend: "local",
        contextNavigationEnabled: true,
        contextRecallEnabled: true,
        contextPivotEnabled: true,
        contextAnchorStatusEnabled: false,
      },
    }),
  );
  resetConfigCache();
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
  resetConfigCache();
});

const ALL_TOOLS = [
  "read",
  "smart_tools",
  "smart_recall",
  "smart_save_memory",
  "smart_context",
  "smart_navigation",
  "smart_compact",
];

function registeredTools() {
  const tools = new Map<string, any>();
  const active = new Set<string>(ALL_TOOLS);
  smartCompactExtension({
    registerCommand: () => { },
    registerTool: (definition: any) => tools.set(definition.name, definition),
    on: () => { },
    getActiveTools: () => [...active],
    setActiveTools: () => { },
  } as any);
  return tools;
}

/** Fake theme that wraps text in visible color tags so tests can assert the
 * SEMANTIC color consulted, not the color alone. */
const theme: any = {
  fg: (color: string, text: string) => `<${color}>${text}</>`,
  bold: (text: string) => `<b>${text}</b>`,
};
const altTheme: any = {
  fg: (color: string, text: string) => `[${color}]{${text}}`,
  bold: (text: string) => `[b]{${text}}`,
};

function renderResult(
  tool: any,
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded?: boolean; args?: unknown; isError?: boolean } = {},
): string[] {
  const context: any = {
    args: options.args ?? {},
    toolCallId: "test-call",
    isError: options.isError ?? false,
    argsComplete: true,
    expanded: options.expanded ?? false,
    isPartial: false,
  };
  const component = tool.renderResult(
    result,
    { expanded: options.expanded ?? false, isPartial: false },
    theme,
    context,
  );
  return component.render(120);
}

function renderCall(tool: any, args: unknown, useTheme = theme): string[] {
  return tool.renderCall(args, useTheme, { args } as any).render(120);
}

const text = (value: string) => [{ type: "text", text: value }];

describe("tool row rendering through real execution", () => {
  function executeContext(approved = true) {
    return {
      cwd: process.cwd(),
      hasUI: true,
      getContextUsage: () => undefined,
      ui: {
        confirm: async () => approved,
        setStatus: () => { },
      },
      sessionManager: {
        getSessionId: () => "session-a",
        getBranch: () => [{ id: "branch-root" }, { id: "branch-head" }],
      },
    };
  }

  it("a refused resolve (local ref while Hindsight selected) renders the refusal, never green (real execute)", async () => {
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ smartCompact: { memoryBackend: "hindsight", toolLoading: "lazy" } }),
    );
    resetConfigCache();
    const tools = registeredTools();
    const save = tools.get("smart_save_memory");
    const ref = "local:cg-0123456789abcdef01234567@0123456789abcdef01234567";
    const outcome = await save.execute(
      "call-1",
      { status: "resolved", ref },
      undefined,
      undefined,
      executeContext(),
    );
    expect(outcome.content[0].text).toContain("not changed");
    expect(outcome.details).toEqual({ ref });
    const rendered = renderResult(save, outcome).join("\n");
    expect(rendered).toContain("not changed");
    expect(rendered).not.toContain("<success>");
    const flatten = (value: string) => value.replace(/\s+/g, " ");
    const expanded = renderResult(save, outcome, { expanded: true }).join("\n");
    expect(flatten(expanded)).toContain(flatten(outcome.content[0].text));
    expect(expanded).not.toContain("<success>");
  });

  it("empty plan and unknown usage render without fabricated numbers (real execute)", async () => {
    const tools = registeredTools();
    const contextTool = tools.get("smart_context");
    const plan = await contextTool.execute("call-2", { action: "plan" }, undefined, undefined, executeContext());
    const planRendered = renderResult(contextTool, plan).join("\n");
    expect(planRendered).toContain("context unknown");
    expect(planRendered).not.toContain("undefined");
    expect(planRendered).not.toContain("NaN");
    expect(planRendered).not.toContain("batch: ready");
    const status = await contextTool.execute("call-3", { action: "status" }, undefined, undefined, executeContext());
    const statusRendered = renderResult(contextTool, status).join("\n");
    expect(statusRendered).toContain("context unknown");
    expect(statusRendered).not.toContain("0%");
    expect(statusRendered).not.toContain("undefined");
    expect(statusRendered).not.toContain("NaN");
  });

  it("a confirmed remote delete renders green; already-absent renders skipped (real details shapes)", () => {
    const tools = registeredTools();
    const save = tools.get("smart_save_memory");
    const deleted = renderResult(save, {
      content: text("Hindsight: deleted document psc-cg-fake (1 memory unit)."),
      details: {
        ref: "hindsight:cg-fake@d",
        remote: { state: "deleted", documentId: "psc-cg-fake", memoryUnitsDeleted: 1 },
      },
    }).join("\n");
    expect(deleted).toContain("<success>done</>");
    expect(deleted).toContain("deleted remotely");
  });
});

describe("tool row rendering (all six tools, native hooks)", () => {
  it("call rows: partial args never print 'undefined'; hostile control args are sanitized", () => {
    const tools = registeredTools();
    for (const name of ["smart_tools", "smart_context", "smart_navigation"]) {
      const call = renderCall(tools.get(name), {}).join("\n");
      expect(call).not.toContain("undefined");
      expect(call).toContain("smart_");
    }
    // Hostile enum/string fields: ESC[2J and C1 CSI never survive; visible
    // text stays readable.
    const hostile = renderCall(tools.get("smart_context"), {
      action: "\u001b[2Jstatus\u009b",
      label: "\u0007label\u001b[31m",
    }).join("\n");
    expect(hostile).not.toMatch(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/);
    expect(hostile).not.toContain("\u001b");
    expect(hostile).toContain("status");
    const hostileNav = renderCall(tools.get("smart_navigation"), {
      action: "\u001b[2Jview",
      keyword: "x\u009by",
    }).join("\n");
    expect(hostileNav).not.toContain("\u001b");
    expect(hostileNav).toContain("view");
  });

  it("error rows keep ALL text parts when expanded, first part when collapsed", () => {
    const tools = registeredTools();
    const save = tools.get("smart_save_memory");
    const errored = {
      content: [
        { type: "text", text: "first failure detail" },
        { type: "text", text: "second failure detail with ref tail" },
      ],
    };
    const collapsed = renderResult(save, errored, { isError: true }).join("\n");
    expect(collapsed).toContain("first failure detail");
    expect(collapsed).not.toContain("second failure detail");
    const expanded = renderResult(save, errored, { isError: true, expanded: true }).join("\n");
    expect(expanded).toContain("first failure detail");
    expect(expanded).toContain("second failure detail with ref tail");
    for (const name of ["smart_recall", "smart_context", "smart_navigation", "smart_compact", "smart_tools"]) {
      const row = renderResult(tools.get(name), errored, { isError: true, expanded: true }).join("\n");
      expect(row).toContain("second failure detail with ref tail");
      expect(row).not.toContain("undefined");
      expect(row).not.toContain("NaN");
    }
  });

  it("registers render hooks on all six Smart Compact tools", () => {
    const tools = registeredTools();
    for (const name of [
      "smart_recall",
      "smart_save_memory",
      "smart_context",
      "smart_navigation",
      "smart_compact",
      "smart_tools",
    ]) {
      expect(tools.has(name)).toBe(true);
      expect(typeof tools.get(name).renderCall).toBe("function");
      expect(typeof tools.get(name).renderResult).toBe("function");
    }
  });

  it("save rows: completed is searchable, accepted is pending with ref, unknown keeps op id, failures stay visible", () => {
    const tools = registeredTools();
    const save = tools.get("smart_save_memory");

    const completed = renderResult(save, {
      content: text("Hindsight: completed"),
      details: {
        ref: "hindsight:cg-x@digest",
        remote: { state: "completed", title: "Use bounded queues", documentId: "psc-cg-x", operationId: "op-1", target: "server/bank" },
      },
    }).join("\n");
    expect(completed).toContain("<success>done</>");
    expect(completed).toContain("saved & searchable");
    expect(completed).toContain("Use bounded queues");
    // Refs are collapsed-hidden (UUID noise) with a native expansion hint.
    expect(completed).not.toContain("hindsight:cg-x@digest");
    expect(completed).toContain("expand");
    const completedExpanded = renderResult(
      save,
      {
        content: text("Hindsight: completed — document psc-cg-x is indexed and searchable.\nTitle: Use bounded queues\nRef: hindsight:cg-x@digest"),
        details: {
          ref: "hindsight:cg-x@digest",
          remote: { state: "completed", title: "Use bounded queues", documentId: "psc-cg-x", operationId: "op-1", target: "server/bank" },
        },
      },
      { expanded: true },
    ).join("\n");
    expect(completedExpanded).toContain("hindsight:cg-x@digest");
    expect(completedExpanded).toContain("indexed and searchable");

    const accepted = renderResult(save, {
      content: text("Hindsight: accepted"),
      details: {
        ref: "hindsight:cg-y@digest",
        remote: { state: "accepted", title: "Release flow", documentId: "psc-cg-y", operationId: "op-2", target: "server/bank" },
      },
    }).join("\n");
    expect(accepted).toContain("<warning>pending</>");
    expect(accepted).toContain("not yet searchable");
    expect(accepted).not.toContain("hindsight:cg-y@digest");
    expect(accepted).not.toContain("<success>");

    const unknown = renderResult(save, {
      content: text("Hindsight: outcome unknown"),
      details: {
        ref: "hindsight:cg-z@digest",
        remote: { state: "unknown", reason: "transport", documentId: "psc-cg-z", operationId: "op-3", target: "server/bank" },
      },
    }).join("\n");
    expect(unknown).toContain("outcome unknown");
    expect(unknown).toContain("op-3");
    expect(unknown).not.toContain("<success>");

    const failed = renderResult(save, {
      content: text("Hindsight: FAILED"),
      details: { remote: { state: "failed", reason: "unauthorized" } },
    }).join("\n");
    expect(failed).toContain("<error>failed</>");
    expect(failed).toContain("unauthorized");

    const declined = renderResult(save, {
      content: text("Project memory not changed"),
      details: { approved: false },
    }).join("\n");
    expect(declined).toContain("<warning>cancelled</>");
    expect(declined).toContain("did not approve");
    expect(declined).not.toContain("<success>");
  });

  it("save resolve outcomes: only positive evidence is green; ref-only refusals never are", () => {
    const tools = registeredTools();
    const save = tools.get("smart_save_memory");

    const localClosed = renderResult(save, {
      content: text("Resolved local project memory [decision] X."),
      details: { ref: "local:cg-a@d", closed: 1 },
    }).join("\n");
    expect(localClosed).toContain("<success>done</>");

    const localMiss = renderResult(save, {
      content: text("No active local project memory matches ref local:cg-a@d; nothing changed."),
      details: { ref: "local:cg-a@d", closed: 0 },
    }).join("\n");
    expect(localMiss).toContain("<dim>skipped</>");
    expect(localMiss).toContain("no active match");
    expect(localMiss).not.toContain("<success>");

    const mnemopiClosed = renderResult(save, {
      content: text("Mnemopi: resolved the saved fact."),
      details: { mnemopi: { state: "resolved", closed: true }, ref: "mnemopi:cg-b@d" },
    }).join("\n");
    expect(mnemopiClosed).toContain("<success>done</>");

    const mnemopiMiss = renderResult(save, {
      content: text("Mnemopi: no matching active fact; nothing changed."),
      details: { mnemopi: { state: "resolved", closed: false }, ref: "mnemopi:cg-b@d" },
    }).join("\n");
    expect(mnemopiMiss).toContain("no matching active fact");
    expect(mnemopiMiss).not.toContain("<success>");

    const deleted = renderResult(save, {
      content: text("Hindsight: deleted the document."),
      details: { ref: "hindsight:cg-c@d", remote: { state: "deleted", documentId: "psc-cg-c" } },
    }).join("\n");
    expect(deleted).toContain("<success>done</>");

    const absent = renderResult(save, {
      content: text("Hindsight: document already absent."),
      details: { ref: "hindsight:cg-c@d", remote: { state: "not-found", documentId: "psc-cg-c" } },
    }).join("\n");
    expect(absent).toContain("<dim>skipped</>");
    expect(absent).toContain("already absent");
    expect(absent).not.toContain("<success>");

    // Ref-only details (inactive backend / wrong digest / missing fact) are
    // refusals: the actual result text renders, never a green resolved.
    const refusal = renderResult(save, {
      content: text("Project memory not changed: this ref belongs to a different local graph. Use the original agent profile; nothing was closed."),
      details: { ref: "local:cg-z@wrong" },
    }, { expanded: true }).join("\n").replace(/\s+/g, " ");
    expect(refusal).toContain("nothing was closed");
    expect(refusal).toContain("not changed");
    expect(refusal).not.toContain("<success>");
  });

  it("save call row never shows the fact content", () => {
    const tools = registeredTools();
    const save = tools.get("smart_save_memory");
    const call = renderCall(save, {
      kind: "decision",
      title: "Public title",
      content: "SECRET-FACT-CONTENT",
    }).join("\n");
    expect(call).toContain("Public title");
    expect(call).not.toContain("SECRET-FACT-CONTENT");
  });

  it("recall rows: counts, prior-save buckets from the existing refresh, and failures", () => {
    const tools = registeredTools();
    const recall = tools.get("smart_recall");

    const ok = renderResult(recall, {
      content: text("results"),
      details: {
        remote: {
          state: "ok",
          facts: [{ id: "m1", documentId: "psc-cg-m1", type: "decision" }],
          receipts: [
            { documentId: "d1", operationId: "o1", state: "completed" },
            { documentId: "d2", operationId: "o2", state: "accepted" },
            { documentId: "d3", operationId: "o3", state: "unknown" },
            { documentId: "d4", operationId: "o4", state: "failed" },
          ],
        },
      },
    }).join("\n");
    expect(ok).toContain("1 remote fact(s)");
    expect(ok).toContain("prior saves:</> 1 completed, 1 pending, 1 failed, 1 unknown");

    const failed = renderResult(recall, {
      content: text("failed"),
      details: { remote: { state: "failed", reason: "server unreachable" } },
    }).join("\n");
    expect(failed).toContain("<error>failed</>");
    expect(failed).toContain("server unreachable");

    const local = renderResult(recall, {
      content: text("results"),
      details: { results: [{ kind: "decision", title: "Queue bounds" }] },
    }).join("\n");
    expect(local).toContain("1 local match(es)");
    expect(local).toContain("[decision] Queue bounds");
  });

  it("context rows: readable status/plan, queued edits never render as applied", () => {
    const tools = registeredTools();
    const context = tools.get("smart_context");

    const status = renderResult(context, {
      content: text("{}"),
      details: {
        display: {
          kind: "status",
          pressurePercent: 72,
          cleanupEnabled: true,
          cleanupBatchReady: false,
          cleanupBatchReason: "cooldown",
          cleanupBlockedReason: null,
          checkpoint: "research",
          pending: null,
          archivedOutputs: 4,
          nextOffset: null,
        },
      },
    }).join("\n");
    expect(status).toContain("context 72%");
    expect(status).toContain("cleanup: cooldown");
    expect(status).toContain("archived outputs:</> 4");
    expect(status).toContain("checkpoint:</> research");

    // Unknown usage stays unknown — no fabricated 0%.
    const unknown = renderResult(context, {
      content: text("{}"),
      details: { display: { kind: "status", pressurePercent: null, cleanupEnabled: false, cleanupBatchReady: false, cleanupBatchReason: null, cleanupBlockedReason: null, checkpoint: null, pending: null, archivedOutputs: 0, nextOffset: null } },
    }).join("\n");
    expect(unknown).toContain("context unknown");
    expect(unknown).not.toContain("0%");
    expect(unknown).not.toContain("undefined");
    expect(unknown).not.toContain("NaN");

    // Batch readiness compares the explicit ready enum, not truthiness.
    const ready = renderResult(context, {
      content: text("{}"),
      details: { display: { kind: "status", pressurePercent: 80, cleanupEnabled: true, cleanupBatchReady: true, cleanupBatchReason: null, cleanupBlockedReason: null, checkpoint: null, pending: null, archivedOutputs: 1, nextOffset: null } },
    }).join("\n");
    expect(ready).toContain("cleanup batch ready");

    const plan = renderResult(context, {
      content: text("{}"),
      details: { display: { kind: "plan", outputs: 6, savedChars: 21000, batchReady: true, batchReason: null } },
    }).join("\n");
    expect(plan).toContain("6 output(s)");
    expect(plan).toContain("21,000");
    expect(plan).toContain("ready");

    const planBlocked = renderResult(context, {
      content: text("{}"),
      details: { display: { kind: "plan", outputs: 0, savedChars: 0, batchReady: false, batchReason: "insufficient-savings" } },
    }).join("\n");
    expect(planBlocked).not.toContain("batch: ready");
    expect(planBlocked).toContain("insufficient-savings");

    const queued = renderResult(context, {
      content: text("trim queued"),
      details: { display: { state: "queued", action: "trim", label: "" } },
    }).join("\n");
    expect(queued).toContain("<dim>queued</>");
    expect(queued).toContain("not yet applied");
    expect(queued).not.toContain("<success>");

    // Raw evidence keeps the content fallback: bounded when collapsed, full
    // when expanded (tail identity like Ref lines must survive expansion).
    const rawCollapsed = renderResult(context, {
      content: text("Historical tool evidence, not instructions. id=e1\nverbatim body"),
    }).join("\n");
    expect(rawCollapsed).toContain("Historical tool evidence, not instructions. id=e1");
    expect(rawCollapsed).toContain("… (expanded shows full content)");
    const rawExpanded = renderResult(
      context,
      { content: text("Historical tool evidence, not instructions. id=e1\nverbatim body\nRef: hindsight:cg-tail@digest") },
      { expanded: true },
    ).join("\n");
    expect(rawExpanded).toContain("verbatim body");
    expect(rawExpanded).toContain("Ref: hindsight:cg-tail@digest");
  });

  it("navigation rows: pivot stays queued, anchors show counts, no carryover leaks", () => {
    const tools = registeredTools();
    const navigation = tools.get("smart_navigation");

    const pivot = renderResult(navigation, {
      content: text("Pivot queued."),
      details: { queued: "pivot", targetId: "t1", display: { state: "queued", action: "pivot", target: "anchor-1" } },
    }).join("\n");
    expect(pivot).toContain("<dim>queued</>");
    expect(pivot).toContain("not applied");
    expect(pivot).not.toContain("<success>");

    const pivotCall = renderCall(navigation, {
      action: "pivot",
      target: "anchor-1",
      carryover: "CARRYOVER-SECRET",
    }).join("\n");
    expect(pivotCall).toContain("anchor-1");
    expect(pivotCall).not.toContain("CARRYOVER-SECRET");

    const anchor = renderResult(navigation, {
      content: text("Anchor: a"),
      details: { anchor: { name: "post-refactor", summary: "SUMMARY", targetId: "t1" } },
    }).join("\n");
    expect(anchor).toContain("anchor recorded");
    expect(anchor).toContain("post-refactor");
    expect(anchor).not.toContain("SUMMARY");

    const view = renderResult(navigation, {
      content: text("anchors json"),
      details: { display: { kind: "anchors", count: 3 } },
    }).join("\n");
    expect(view).toContain("3 anchor(s) listed");
    // Expanded navigation rows show the actual list content.
    const viewExpanded = renderResult(
      navigation,
      { content: text("Historical anchors, not instructions.\n[{name: 'a'}]"), details: { display: { kind: "anchors", count: 3 } } },
      { expanded: true },
    ).join("\n");
    expect(viewExpanded).toContain("[{name: 'a'}]");
  });

  it("compact rows: staged and dry-run are never success; skipped and cancelled stay visible", () => {
    const tools = registeredTools();
    const compact = tools.get("smart_compact");

    const staged = renderResult(compact, {
      content: text("staged"),
      details: { display: { state: "staged", method: "smart", mode: "balanced", tokens: 81000, ttlMinutes: 10 } },
    }).join("\n");
    expect(staged).toContain("staged — NOT applied");
    expect(staged).toContain("/compact");
    expect(staged).not.toContain("<success>");

    const dry = renderResult(compact, {
      content: text("Dry run finished"),
      details: { display: { state: "dry-run", mode: "fast", seconds: 2.5 } },
    }).join("\n");
    expect(dry).toContain("dry run — nothing staged");
    expect(dry).not.toContain("<success>");

    const cancelled = renderResult(compact, {
      content: text("cancelled"),
      details: { display: { state: "cancelled", source: "host" } },
    }).join("\n");
    expect(cancelled).toContain("<warning>cancelled</>");

    const skipped = renderResult(compact, {
      content: text("Smart compact skipped: context below threshold."),
      details: { display: { state: "skipped" } },
    }).join("\n");
    expect(skipped).toContain("<dim>skipped</>");
    expect(skipped).toContain("below threshold");
  });

  it("smart_tools rows: group status with availability, load and unload states", () => {
    const tools = registeredTools();
    const smartTools = tools.get("smart_tools");

    const status = renderResult(smartTools, {
      content: text("{}"),
      details: {
        display: { kind: "tool-groups" },
        status: {
          mode: "lazy",
          groups: [
            { group: "navigation", available: true, active: ["smart_navigation"] },
            { group: "memory", available: true, active: [] },
            { group: "compaction", available: false, active: [] },
          ],
        },
      },
    }).join("\n");
    expect(status).toContain("mode:");
    expect(status).toContain("lazy");
    expect(status).toContain("navigation");
    expect(status).toContain("1 active");
    expect(status).toContain("available");
    expect(status).toContain("disabled");

    const loaded = renderResult(smartTools, {
      content: text("Loaded"),
      details: { display: { state: "loaded", group: "memory", tools: ["smart_recall", "smart_save_memory"] } },
    }).join("\n");
    expect(loaded).toContain("<success>done</>");
    expect(loaded).toContain("smart_recall");
  });

  it("degrades safely: missing details, errors, control characters, theme change, widths", () => {
    const tools = registeredTools();
    const recall = tools.get("smart_recall");
    const save = tools.get("smart_save_memory");

    // Missing details → visible raw fallback, not a fabricated success;
    // expanded preserves the FULL content including the tail.
    const fallback = renderResult(recall, { content: text("plain content line") }).join("\n");
    expect(fallback).toContain("plain content line");
    expect(fallback).not.toContain("<success>");
    const fallbackExpanded = renderResult(
      recall,
      { content: text("first line\nsecond line\nRef: local:cg-tail@d") },
      { expanded: true },
    ).join("\n");
    expect(fallbackExpanded).toContain("second line");
    expect(fallbackExpanded).toContain("Ref: local:cg-tail@d");

    // Thrown/errored results render as errors.
    const errored = renderResult(save, { content: text("boom detail") }, { isError: true }).join("\n");
    expect(errored).toContain("<error>");
    expect(errored).toContain("boom detail");

    // Control characters — including ANSI escapes and C1 controls — never
    // reach the terminal.
    const dirty = renderResult(recall, {
      content: text("x"),
      details: { remote: { state: "failed", reason: "bad \u001b[31mred\u001b[0m \u009b reason" } },
    }).join("\n");
    expect(dirty).not.toMatch(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/);
    expect(dirty).not.toContain("\u001b");
    expect(dirty).toContain("bad");
    expect(dirty).toContain("red");

    // Theme is consulted; a different theme still renders.
    const alt = save.renderCall(
      { kind: "decision", title: "T" },
      altTheme,
      { args: { kind: "decision" } } as any,
    ).render(120).join("\n");
    expect(alt).toContain("[toolTitle]{smart_save_memory }");
    expect(alt).toContain("[accent]");

    // Width safety across narrow, standard and wide terminals for every hook.
    const resultsByTool: Array<[string, any, { content: Array<{ type: string; text: string }>; details: unknown }]> = [
      ["smart_recall", recall, { content: text("r"), details: { results: [{ kind: "decision", title: "καλημέρα unicode ✓ " + "x".repeat(200) }] } }],
      ["smart_save_memory", save, { content: text("s"), details: { memory: { kind: "decision", title: "ünïcode ✓ " + "y".repeat(200) }, ref: "local:cg-a@" + "d".repeat(40) } }],
    ];
    for (const [, tool, result] of resultsByTool) {
      for (const width of [30, 80, 200]) {
        const component = tool.renderResult(result, { expanded: false, isPartial: false }, theme, { args: {}, isError: false, argsComplete: true, expanded: false } as any);
        for (const line of component.render(width)) {
          expect(line.length).toBeLessThanOrEqual(width * 3);
        }
      }
    }
  });
});
