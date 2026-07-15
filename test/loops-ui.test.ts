import { describe, expect, it } from "bun:test";
import { showOpenLoopsUI } from "../src/ui/overlays.ts";
import { applyLoopOverrides } from "../src/utils/state.ts";
import type { OpenLoop } from "../src/types.ts";

const loop: OpenLoop = {
  id: "loop-1", type: "follow-up", priority: "normal", status: "open",
  summary: "Finish authentication tests", files: ["src/auth.ts"],
};

describe("showOpenLoopsUI", () => {
  it("persists a resolve action through a typed override", async () => {
    const answers = ["1. [open/normal] Finish authentication tests", "Resolve", "Done"];
    const ctx = { ui: { select: async () => answers.shift() } } as any;
    const overrides = await showOpenLoopsUI(ctx, [loop], []);
    expect(overrides).not.toBeNull();
    expect(applyLoopOverrides([loop], overrides!)[0].status).toBe("resolved");
  });

  it("supports pinning a loop", async () => {
    const answers = ["1. [open/normal] Finish authentication tests", "Pin", "Done"];
    const ctx = { ui: { select: async () => answers.shift() } } as any;
    const overrides = await showOpenLoopsUI(ctx, [loop], []);
    expect(overrides?.[0].pinned).toBe(true);
  });
});
