import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initTheme, type KeybindingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { ANCHOR_CUSTOM_TYPE } from "../src/app/navigation-data.ts";
import { type PreparedHandoff, prepareHandoff } from "../src/app/session-handoff.ts";
import { createHandoffPanel, type HandoffPanelSource } from "../src/ui/handoff-overlay.ts";
import { resetConfigCache } from "../src/utils/config.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";

beforeAll(() => initTheme("dark", false));

const originalHome = process.env.HOME;
let home = "";
let cwd = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-overlay-"));
  cwd = path.join(home, "project");
  fs.mkdirSync(cwd, { recursive: true });
  process.env.HOME = home;
  resetConfigCache();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  resetConfigCache();
});

function session(anchored: boolean): SessionManager {
  const sm = SessionManager.inMemory(cwd);
  const userId = sm.appendMessage({ role: "user", content: "Completed work.", timestamp: 1 });
  if (anchored) {
    const summary = "ANCHOR_FACT_913";
    sm.appendCustomMessageEntry(ANCHOR_CUSTOM_TYPE, `Anchor: reviewed\n\n${summary}`, true, { anchor: { name: "reviewed", summary, targetId: userId } });
  }
  return sm;
}

function harness(source: HandoffPanelSource) {
  const closes: Array<PreparedHandoff | undefined> = [];
  const panel = createHandoffPanel(source, {
    close: (prepared) => closes.push(prepared),
    requestRender: () => { },
    theme: { fg: (_color, text) => text, bold: (text) => text },
    tui: { terminal: { rows: 40, columns: 80 }, requestRender: () => { } } as unknown as TUI,
    keybindings: getKeybindings() as KeybindingsManager,
  });
  const key = (data: string) => panel.handleInput!(data);
  const type = (text: string) => {
    for (const char of text) key(char);
  };
  const text = () => panel.render(100).join("\n");
  return { key, type, text, closes };
}

let pending: Promise<unknown> = Promise.resolve();
/** Await the real prepare (in-memory reads + injected recall); the panel reacts first. */
const settle = () => pending;

function prepareFrom(sm: SessionManager): HandoffPanelSource {
  return { prepare: (note) => (pending = prepareHandoff({ cwd, sessionManager: sm }, note, async () => "MEMORY_FACT_71")) };
}

describe("handoff panel", () => {
  it("previews the seed with Go back as default and resolves only on Open", async () => {
    const h = harness(prepareFrom(session(true)));
    expect(h.text()).toContain("Add a note for the next session");
    h.type("continue parser");
    h.key(ENTER);
    await settle();
    const header = h.text().match(/Seed: (\d+) chars · sources: ([^\n]+)/);
    expect(header?.[2]).toBe("note, anchor, recall");
    h.key(ENTER); // default row: Go back
    expect(h.closes).toEqual([]);
    expect(h.text()).toContain("Add a note for the next session");
    h.key(ENTER); // note kept → prepare again
    await settle();
    h.key(DOWN);
    h.key(DOWN);
    h.key(ENTER); // Open the new session
    expect(h.closes).toHaveLength(1);
    const prepared = h.closes[0]!;
    expect(prepared.handoff.content).toContain("## Note\ncontinue parser");
    expect(prepared.handoff.content.length).toBe(Number(header![1]));
  });

  it("Esc on the preview keeps the note; Esc on the field closes with no action", async () => {
    const h = harness(prepareFrom(session(true)));
    h.type("keep this note");
    h.key(ENTER);
    await settle();
    h.key(ESC);
    expect(h.text()).toContain("keep this note");
    expect(h.closes).toEqual([]);
    h.key(ESC);
    expect(h.closes).toEqual([undefined]);
  });

  it("stays on the field with an actionable notice when there is nothing to hand off", async () => {
    const h = harness(prepareFrom(session(false)));
    h.key(ENTER);
    await settle();
    expect(h.text()).toContain("Nothing to hand off yet. Write a note, or mark this point first");
    expect(h.text()).not.toContain("Seed:");
    h.type("pick up the parser");
    h.key(ENTER);
    await settle();
    expect(h.text()).toMatch(/Seed: \d+ chars · sources: note, recall/);
  });

  it("dry-run preview is read-only", async () => {
    const prepared = await prepareHandoff({ cwd, sessionManager: session(true) }, undefined, async () => "none");
    const h = harness({ preview: prepared! });
    expect(h.text()).toContain("Read the full seed");
    expect(h.text()).not.toContain("Open the new session");
    h.key(DOWN);
    h.key(ENTER);
    expect(h.text()).toContain("ANCHOR_FACT_913");
    h.key(ESC);
    h.key(ENTER); // Close
    expect(h.closes).toEqual([undefined]);
  });
});
