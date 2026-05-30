/**
 * Coverage for the file-path needle generator that drives bugfix-loop
 * attribution in `extractOpenLoops`.
 *
 * The contract:
 *
 *   - Empty / pathless input → no needles.
 *   - Generic basenames (`index.ts` etc.) are NOT emitted as standalone
 *     needles — they require a containing directory in the error message
 *     to match. Otherwise every `index.ts` in the tree would attach to
 *     every `TypeError in index.ts:42` mention.
 *   - Bare basenames shorter than `MIN_BARE_BASENAME_LEN` are dropped.
 *   - The remaining needles are progressively-longer suffix slices, all
 *     lowercased so caller can use `.toLowerCase().includes(needle)`.
 */
import { describe, it, expect } from "bun:test";
import {
  buildPathNeedles,
  GENERIC_BASENAMES,
  MIN_BARE_BASENAME_LEN,
} from "../src/utils/file-needles.ts";

describe("buildPathNeedles — degenerate inputs", () => {
  it("returns empty for empty string", () => {
    expect(buildPathNeedles("")).toEqual([]);
  });

  it("returns empty for slashes-only path", () => {
    expect(buildPathNeedles("///")).toEqual([]);
  });
});

describe("buildPathNeedles — specific path", () => {
  it("produces a basename + all suffix slices for a normal path", () => {
    const needles = buildPathNeedles("src/app/steps/persist.ts");
    expect(needles).toEqual([
      "persist.ts",
      "steps/persist.ts",
      "app/steps/persist.ts",
      "src/app/steps/persist.ts",
    ]);
  });

  it("lowercases every emitted needle", () => {
    const needles = buildPathNeedles("Src/Foo/Bar.TS");
    expect(needles.every(n => n === n.toLowerCase())).toBe(true);
  });
});

describe("buildPathNeedles — generic basename gate", () => {
  it("drops bare 'index.ts' but keeps suffix slices", () => {
    const needles = buildPathNeedles("src/app/index.ts");
    expect(needles).not.toContain("index.ts");
    expect(needles).toContain("app/index.ts");
    expect(needles).toContain("src/app/index.ts");
  });

  it("covers every entry in GENERIC_BASENAMES", () => {
    for (const generic of GENERIC_BASENAMES) {
      const needles = buildPathNeedles("a/b/" + generic);
      expect(needles).not.toContain(generic);
      expect(needles[0]).toBe("b/" + generic);
    }
  });

  it("returns empty needles when path is just a generic basename", () => {
    // No containing directory means nothing else to fall back on.
    expect(buildPathNeedles("index.ts")).toEqual([]);
  });
});

describe("buildPathNeedles — short basename gate", () => {
  it("drops bare basenames shorter than MIN_BARE_BASENAME_LEN", () => {
    // "x.ts" has length 4 < 5
    const needles = buildPathNeedles("foo/x.ts");
    expect(needles).not.toContain("x.ts");
    expect(needles).toContain("foo/x.ts");
  });

  it("keeps bare basenames at exactly MIN_BARE_BASENAME_LEN", () => {
    // "ab.ts" has length 5 (exactly the threshold)
    const needles = buildPathNeedles("foo/ab.ts");
    expect(needles[0]).toBe("ab.ts");
    expect(needles).toContain("foo/ab.ts");
  });

  it("keeps long, non-generic basenames", () => {
    const needles = buildPathNeedles("src/utils/file-needles.ts");
    expect(needles).toContain("file-needles.ts");
  });
});

describe("MIN_BARE_BASENAME_LEN", () => {
  it("is a small positive integer", () => {
    expect(MIN_BARE_BASENAME_LEN).toBeGreaterThan(0);
    expect(MIN_BARE_BASENAME_LEN).toBeLessThan(20);
    expect(Number.isInteger(MIN_BARE_BASENAME_LEN)).toBe(true);
  });
});

describe("GENERIC_BASENAMES contents", () => {
  it("contains the common index/main/lib basenames we care about", () => {
    for (const expected of ["index.ts", "index.js", "types.ts", "main.ts", "lib.rs", "__init__.py"]) {
      expect(GENERIC_BASENAMES.has(expected)).toBe(true);
    }
  });

  it("does NOT contain reasonably specific filenames", () => {
    // sanity check that the gate is precision-targeted, not overly broad
    for (const specific of ["session-log.ts", "extraction.ts", "pending-slot.ts"]) {
      expect(GENERIC_BASENAMES.has(specific)).toBe(false);
    }
  });
});
