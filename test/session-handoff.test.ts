import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import smartCompactExtension from "../src/index.ts";
import { HANDOFF_MAX_CHARS } from "../src/constants.ts";
import { SecretScrubber } from "../src/domain/scrub.ts";
import { ANCHOR_CUSTOM_TYPE, listAnchors, resolveAnchorTarget } from "../src/app/navigation-data.ts";
import { buildHandoff, collectHandoffSources, type HandoffSources } from "../src/app/session-handoff.ts";
import type { CompactionState } from "../src/types.ts";
import { resetConfigCache } from "../src/utils/config.ts";
import { resetIssuesForTests } from "../src/utils/issues.ts";
import { deriveProjectIdFromCwd } from "../src/utils/fingerprint.ts";
import { saveCompactionState } from "../src/utils/state.ts";

const previousHome = process.env.HOME;
let home: string;
let cwd: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-handoff-"));
  cwd = path.join(home, "project");
  fs.mkdirSync(cwd, { recursive: true });
  process.env.HOME = home;
  resetConfigCache();
  // The command flushes the process-wide issue queue into ctx.ui.notify.
  resetIssuesForTests();
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  resetConfigCache();
  fs.rmSync(home, { recursive: true, force: true });
});

function state(goal: string, partial: Partial<CompactionState> = {}): CompactionState {
  return {
    goal, decisions: [], constraints: [], modifiedFiles: [], readFiles: [], deletedFiles: [],
    unresolvedErrors: [], resolvedErrors: [], openLoops: [], topics: [], nextActions: [],
    criticalContext: [], sessionType: "implementation", compactionVersion: "test", updatedAt: Date.now(),
    ...partial,
  };
}

function sources(partial: Partial<HandoffSources> = {}): HandoffSources {
  return {
    anchor: { name: "reviewed", summary: "ANCHOR_FACT_913\nNext validate flags." },
    ledger: "## Continuity Ledger\n- Goal: Ship the handoff",
    pinPaths: ["src/keep.ts"],
    recall: { query: "continue parser", text: "MEMORY_FACT_71" },
    lineage: { sessionId: "0123456789abcdef", branchHeadId: "head", cwd: "/work/project", when: "2026-09-28T00:00:00.000Z" },
    note: "continue parser",
    ...partial,
  };
}

const scrubber = () => new SecretScrubber(true, false);

function withAnchor(sm: SessionManager, summary = "ANCHOR_FACT_913\nNext validate flags."): string {
  const userId = sm.appendMessage({ role: "user", content: "Completed work before the anchor.", timestamp: 1 });
  sm.appendCustomMessageEntry(ANCHOR_CUSTOM_TYPE, `Anchor: reviewed\n\n${summary}`, true, { anchor: { name: "reviewed", summary, targetId: userId } });
  return userId;
}

describe("buildHandoff", () => {
  it("orders sections, omits absent ones and is deterministic", () => {
    const full = buildHandoff(sources(), scrubber());
    expect(full.content.startsWith("Handoff from session 0123456789abcdef (/work/project, 2026-09-28T00:00:00.000Z).")).toBe(true);
    const order = ["## Note", "## Last anchor: reviewed", "## Continuity Ledger", "## Always-kept files", "## Memory recall", "## Earlier evidence"]
      .map(heading => full.content.indexOf(heading));
    expect(order.every(index => index > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(full.content).toContain("Query: continue parser\n\nMEMORY_FACT_71");
    expect(full.name).toBe("handoff-01234567");
    expect(full.summary).toBe("ANCHOR_FACT_913\nNext validate flags.");
    expect(buildHandoff(sources(), scrubber())).toEqual(full);

    const sparse = buildHandoff(sources({ anchor: undefined, ledger: undefined, pinPaths: [], note: undefined }), scrubber());
    for (const heading of ["## Note", "## Last anchor", "## Continuity Ledger", "## Always-kept files"]) expect(sparse.content).not.toContain(heading);
    expect(sparse.content).toContain("## Memory recall");
    expect(sparse.content).not.toContain("[truncated]");
  });

  it("redacts secrets in the seed and the anchor summary", () => {
    const key = "sk-ant-" + "A1b2C3d4E5f6G7h8I9j0K1l2";
    const handoff = buildHandoff(sources({ anchor: { name: "reviewed", summary: `Deploy with ${key}` } }), scrubber());
    expect(handoff.content).not.toContain(key);
    expect(handoff.summary).not.toContain(key);
    expect(handoff.content).toContain("## Last anchor: reviewed\nDeploy with ");
  });

  it("cuts recall before the ledger and keeps the header", () => {
    const ledger = "## Continuity Ledger\n" + "- Goal: keep ledger line\n".repeat(400);
    const handoff = buildHandoff(sources({ ledger, recall: { query: "q", text: "recall line\n".repeat(900) } }), scrubber());
    expect(handoff.content.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    expect(handoff.content.startsWith("Handoff from session 0123456789abcdef")).toBe(true);
    expect(handoff.content).toContain(ledger.trim());
    expect(handoff.content).toContain("## Last anchor: reviewed\nANCHOR_FACT_913");
    expect(handoff.content).toMatch(/## Memory recall\n[\s\S]*recall line\n\[truncated\]\n\n## Earlier evidence/);
  });

  it("drops recall, then cuts the ledger, never the anchor", () => {
    const ledger = "## Continuity Ledger\n" + "- Goal: keep ledger line\n".repeat(700);
    const handoff = buildHandoff(sources({ ledger, recall: { query: "q", text: "recall line\n".repeat(400) } }), scrubber());
    expect(handoff.content.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    expect(handoff.content).not.toContain("## Memory recall");
    // Pinned paths stay in config for the new session, so they go before the ledger.
    expect(handoff.content).not.toContain("## Always-kept files");
    expect(handoff.content).toMatch(/- Goal: keep[^\n]*\n\[truncated\]\n\n## Earlier evidence/);
    expect(handoff.content).toContain("## Last anchor: reviewed\nANCHOR_FACT_913\nNext validate flags.");
    expect(handoff.content.endsWith("\n\n[truncated]")).toBe(true);
  });
});

describe("collectHandoffSources", () => {
  it("reads the branch anchor and the last Smart Compact ledger; the note drives recall", async () => {
    const sm = SessionManager.inMemory(cwd);
    const userId = withAnchor(sm);
    sm.appendCompaction("older", userId, 1_000, { compactionState: state("Older goal") });
    sm.appendCompaction("native only", userId, 1_000, { native: { opaque: true } });
    sm.appendCompaction("latest", userId, 1_000, { compactionState: state("Ship the handoff") });
    const queries: string[] = [];
    const recall = async (query: string) => { queries.push(query); return "RECALLED"; };

    const noted = await collectHandoffSources({ cwd, sessionManager: sm }, { pinPaths: ["a.ts"] }, { note: " continue parser ", recall });
    expect(noted.anchor).toEqual({ name: "reviewed", summary: "ANCHOR_FACT_913\nNext validate flags." });
    expect(noted.ledger).toBe("## Continuity Ledger\n- Goal: Ship the handoff");
    expect(noted.recall).toEqual({ query: "continue parser", text: "RECALLED" });
    expect(noted.note).toBe("continue parser");
    expect(noted.lineage.sessionId).toBe(sm.getSessionId());
    expect(noted.lineage.branchHeadId).toBe(sm.getLeafId()!);

    await collectHandoffSources({ cwd, sessionManager: sm }, { pinPaths: [] }, { recall });
    expect(queries).toEqual(["continue parser", "reviewed ANCHOR_FACT_913"]);
  });

  it("skips a branch record it cannot render instead of failing the command", async () => {
    const sm = SessionManager.inMemory(cwd);
    withAnchor(sm);
    // A hand-edited record: array fields present, item shapes wrong.
    sm.appendCompaction("edited", sm.getLeafId(), 1_000, { compactionState: state("Broken", { constraints: ["not an object" as never] }) });
    const collected = await collectHandoffSources({ cwd, sessionManager: sm }, { pinPaths: [] }, { recall: async () => "none" });
    expect(collected.anchor?.name).toBe("reviewed");
    expect(collected.ledger).toBeUndefined();
  });

  it("falls back to the on-disk scoped ledger and queries its goal", async () => {
    const sm = SessionManager.inMemory(cwd);
    const headId = sm.appendMessage({ role: "user", content: "work", timestamp: 1 });
    const projectId = deriveProjectIdFromCwd(cwd)!;
    expect(saveCompactionState(projectId, state("Disk goal", {
      scope: { schemaVersion: 2, projectId, sessionId: sm.getSessionId(), branchHeadId: headId },
    }))).toBe(true);
    const queries: string[] = [];

    const collected = await collectHandoffSources({ cwd, sessionManager: sm }, { pinPaths: [] }, {
      recall: async query => { queries.push(query); return "none"; },
    });
    expect(collected.anchor).toBeUndefined();
    expect(collected.ledger).toBe("## Continuity Ledger\n- Goal: Disk goal");
    expect(queries).toEqual(["Disk goal"]);
  });
});

describe("/smart-compact handoff", () => {
  function command() {
    let registered: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
    smartCompactExtension({
      registerCommand: (name: string, definition: NonNullable<typeof registered>) => { if (name === "smart-compact") registered = definition; },
      registerTool: () => {},
      on: () => {},
    } as unknown as ExtensionAPI); // Only registration hooks are reachable.
    return registered!;
  }

  function context(sm: SessionManager) {
    const notices: Array<{ message: string; level: string }> = [];
    const nextNotices: Array<{ message: string; level: string }> = [];
    const opened: Array<{ parentSession?: string; next: SessionManager }> = [];
    const ctx = {
      mode: "rpc", hasUI: true, cwd, sessionManager: sm,
      waitForIdle: async () => {},
      modelRegistry: { getAvailable: () => [] },
      ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
      newSession: async (options: Parameters<ExtensionCommandContext["newSession"]>[0] = {}) => {
        const next = SessionManager.inMemory(cwd);
        opened.push({ parentSession: options.parentSession, next });
        await options.setup?.(next);
        await options.withSession?.({ hasUI: true, sessionManager: next, ui: { notify: (message: string, level: string) => nextNotices.push({ message, level }) } } as unknown as Parameters<NonNullable<typeof options.withSession>>[0]);
        return { cancelled: false };
      },
    };
    // Fake host: only the members the handoff path reads.
    return { ctx: ctx as unknown as ExtensionCommandContext, notices, nextNotices, opened };
  }

  it("opens a new session seeded with a resolvable handoff anchor", async () => {
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ smartCompact: { contextGraphEnabled: false, pinPaths: ["src/keep.ts"] } }));
    resetConfigCache();
    const sm = SessionManager.create(cwd, path.join(home, "sessions"));
    withAnchor(sm);
    const { ctx, notices, nextNotices, opened } = context(sm);

    await command().handler("handoff -- continue parser", ctx);

    expect(notices).toEqual([]);
    expect(opened).toHaveLength(1);
    expect(opened[0].parentSession).toBe(sm.getSessionFile()!);
    const next = opened[0].next;
    const [first] = next.getBranch();
    expect(first.type).toBe("custom_message");
    if (first.type !== "custom_message") return;
    expect(first.customType).toBe(ANCHOR_CUSTOM_TYPE);
    const content = String(first.content);
    const name = "handoff-" + sm.getSessionId().slice(0, 8);
    expect(content).toStartWith(`Handoff from session ${sm.getSessionId()} (${cwd}, `);
    expect(content).toContain("## Note\ncontinue parser");
    expect(content).toContain("## Last anchor: reviewed\nANCHOR_FACT_913");
    expect(content).toContain("## Always-kept files\n- src/keep.ts");
    expect(content).toContain("Query: continue parser\n\nSmart Recall is disabled by contextGraphEnabled=false.");
    expect((first.details as { handoff?: unknown }).handoff).toEqual({
      fromSessionId: sm.getSessionId(), branchHeadId: sm.getLeafId(), sources: ["note", "anchor", "pinned files", "recall"],
    });
    expect(listAnchors(next).anchors.map(anchor => anchor.data.name)).toEqual([name]);
    expect(resolveAnchorTarget(next, name)).toBe(first.id);
    expect(next.getLabel(first.id)).toBe(name);
    expect(nextNotices).toEqual([{
      message: `Handoff opened a new session (${content.length} chars: note, anchor, pinned files, recall).`,
      level: "info",
    }]);
  });

  it("opens no session when nothing was recorded", async () => {
    const sm = SessionManager.inMemory(cwd);
    sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    const { ctx, notices, opened } = context(sm);

    await command().handler("handoff", ctx);

    expect(opened).toEqual([]);
    expect(notices).toEqual([{ message: "Nothing to hand off yet. Mark this point (Home › History & recovery › Session navigation) or add a note: /smart-compact handoff -- <note>", level: "warning" }]);
  });
});
