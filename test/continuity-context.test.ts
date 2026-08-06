import { describe, expect, it } from "bun:test";
import { getPreviousCompactionContext } from "../src/utils/helpers.ts";
import { TRUNC } from "../src/constants.ts";

describe("previous compaction continuity context", () => {
  it("uses the newest compaction by timestamp even when active entries are reordered", () => {
    const context = getPreviousCompactionContext([
      { type: "compaction", timestamp: "2026-08-02T00:00:00Z", summary: "new summary", details: { method: "eesv", topics: ["new"] } },
      { type: "compaction", timestamp: "2026-08-01T00:00:00Z", summary: "old summary", details: { method: "eesv", topics: ["old"] } },
    ]);

    expect(context).toContain("new summary");
    expect(context).not.toContain("old summary");
  });

  it("bounds previous narrative while retaining its prefix", () => {
    const context = getPreviousCompactionContext([
      { type: "compaction", timestamp: "2026-08-01T00:00:00Z", summary: "x".repeat(TRUNC.PREVIOUS_SUMMARY * 2), details: { method: "eesv", topics: [] } },
    ]);

    expect(context).toContain("x".repeat(100));
    expect(context.length).toBeLessThan(TRUNC.PREVIOUS_SUMMARY + 300);
  });
});
