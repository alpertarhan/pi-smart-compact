// Summary pseudo-anchor (C): after a Smart Compact compaction commits, the
// summary becomes a synthetic anchor — a recall surface and pivot target for
// the post-compaction branch. In-session lists keep only the newest two
// synthetic anchors visible (older ones stay as data); cross-session lineage
// recall shows all of them, which is the handoff value.
import { describe, expect, it } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ANCHOR_CUSTOM_TYPE, anchorFromEntry, getAnchors, listAnchors } from "../src/app/navigation-data.ts";
import { buildSummaryAnchor } from "../src/app/summary-anchor.ts";

/** Apply the built entry through the writable session manager, like index.ts does via sendMessage. */
function appendSummaryAnchor(sm: SessionManager, details: { summary: string }): void {
  const entry = buildSummaryAnchor(sm, details);
  if (!entry) return;
  sm.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
}

function seeded(): SessionManager {
  const sm = SessionManager.inMemory();
  sm.appendMessage({ role: "user", content: "Work on the parser", timestamp: 1 });
  return sm;
}

describe("buildSummaryAnchor", () => {
  it("writes a synthetic anchor at the current leaf", () => {
    const sm = seeded();
    const leafBefore = sm.getLeafId();
    expect(leafBefore).toBeTruthy();
    appendSummaryAnchor(sm, { summary: "Parser work done.\n- details follow" });
    const record = getAnchors(sm).at(-1)!;
    expect(record.data.synthetic).toBe(true);
    expect(record.data.name.startsWith("compaction:")).toBe(true);
    expect(record.data.summary).toContain("Parser work done.");
    expect(record.data.targetId).toBe(leafBefore!);
    expect(record.onBranch).toBe(true);
    expect(anchorFromEntry(sm.getEntries().at(-1)!)?.synthetic).toBe(true);
  });

  it("keeps the summary in details only, so the model context does not carry it twice", () => {
    const sm = seeded();
    const entry = buildSummaryAnchor(sm, { summary: "Parser work done.\n- details follow" })!;
    expect(entry.content).toContain(entry.details.anchor.name);
    expect(entry.content).not.toContain("details follow");
    expect(entry.details.anchor.summary).toContain("details follow");
  });

  it("keeps names within 120 printable characters", () => {
    const sm = seeded();
    appendSummaryAnchor(sm, { summary: "L".repeat(300) });
    const record = getAnchors(sm).at(-1)!;
    expect(record.data.name.length).toBeLessThanOrEqual(120);
    expect(record.data.name).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it("caps the stored summary at the anchor summary limit", () => {
    const sm = seeded();
    appendSummaryAnchor(sm, { summary: "S".repeat(20_000) });
    const record = getAnchors(sm).at(-1)!;
    expect(record.data.summary.length).toBeLessThanOrEqual(12_000);
  });

  it("suffixes a duplicate name instead of dropping or overwriting the anchor", () => {
    const sm = seeded();
    appendSummaryAnchor(sm, { summary: "Same summary." });
    const before = getAnchors(sm).length;
    expect(() => appendSummaryAnchor(sm, { summary: "Same summary." })).not.toThrow();
    expect(getAnchors(sm).length).toBe(before + 1);
    expect(getAnchors(sm).at(-1)!.data.name).toBe("compaction: Same summary. \u00b7 2");
  });

  it("does nothing without completed history", () => {
    const sm = SessionManager.inMemory();
    expect(() => appendSummaryAnchor(sm, { summary: "Orphan." })).not.toThrow();
    expect(getAnchors(sm)).toHaveLength(0);
  });
});

describe("synthetic anchor visibility budget", () => {
  it("keeps only the newest two synthetic anchors in lists; user anchors always show", () => {
    const sm = seeded();
    sm.appendCustomMessageEntry(ANCHOR_CUSTOM_TYPE, "Anchor: user-a\n\nuser anchor", true,
      { anchor: { name: "user-a", summary: "user anchor", targetId: sm.getLeafId()! } });
    appendSummaryAnchor(sm, { summary: "First compaction." });
    appendSummaryAnchor(sm, { summary: "Second compaction." });
    appendSummaryAnchor(sm, { summary: "Third compaction." });
    const names = listAnchors(sm).anchors.map(record => record.data.name);
    expect(names).toContain("user-a");
    expect(names).toContain("compaction: Third compaction.");
    expect(names).toContain("compaction: Second compaction.");
    expect(names).not.toContain("compaction: First compaction.");
  });

  it("keeps older synthetic anchors as data even when hidden from lists", () => {
    const sm = seeded();
    for (const summary of ["One.", "Two.", "Three."]) appendSummaryAnchor(sm, { summary });
    const synthetic = getAnchors(sm).filter(record => record.data.synthetic);
    expect(synthetic).toHaveLength(3);
  });
});
