import { describe, it, expect } from "bun:test";
import { ensurePinnedPaths } from "../src/utils/state.ts";

const BASE = "## Goal\nDo the thing.\n\n## Files Modified\n- src/a.ts\n\n## Files Read\n- lib/b.ts\n";

describe("ensurePinnedPaths", () => {
  it("returns the summary unchanged when no paths are pinned", () => {
    expect(ensurePinnedPaths(BASE, [])).toBe(BASE);
  });

  it("is a no-op when every pinned path is already mentioned", () => {
    expect(ensurePinnedPaths(BASE, ["src/a.ts", "lib/b.ts"])).toBe(BASE);
  });

  it("is case-insensitive when checking presence", () => {
    // BASE already mentions src/a.ts; a differently-cased pin must not duplicate it.
    expect(ensurePinnedPaths(BASE, ["SRC/A.TS"])).toBe(BASE);
  });

  it("appends missing pinned paths to Files Read", () => {
    const out = ensurePinnedPaths(BASE, ["src/auth.ts", "config/secrets.env"]);
    expect(out.toLowerCase()).toContain("src/auth.ts");
    expect(out.toLowerCase()).toContain("config/secrets.env");
    // existing structure preserved
    expect(out).toContain("## Goal");
    expect(out).toContain("## Files Modified");
  });

  it("creates a Files Read section when absent", () => {
    const noRead = "## Goal\nDo the thing.\n\n## Files Modified\n- src/a.ts\n";
    const out = ensurePinnedPaths(noRead, ["pinned/x.ts"]);
    expect(out.toLowerCase()).toContain("pinned/x.ts");
    expect(out).toContain("## Files Read");
  });

  it("skips empty / whitespace-only pinned entries", () => {
    const out = ensurePinnedPaths(BASE, ["", "   ", "real/file.ts"]);
    expect(out.toLowerCase()).toContain("real/file.ts");
    // empty entries must not produce empty bullets
    expect(out.match(/^- $/m)).toBeNull();
    expect(out.match(/^- {2,}$/m)).toBeNull();
  });
});
