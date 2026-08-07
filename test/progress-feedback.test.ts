import { describe, expect, it } from "bun:test";
import { clearCompactProgress, notifyAppliedCompaction, showProgressOverlay } from "../src/ui/overlays.ts";

function context() {
  const calls: string[] = [];
  let widgetFactory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  const ctx = {
    hasUI: true,
    ui: {
      setStatus: (_key: string, value: string | undefined) => calls.push("status:" + value),
      setWidget: (_key: string, value: typeof widgetFactory) => {
        widgetFactory = value;
        calls.push("widget:" + (value == null ? "clear" : "set"));
      },
      notify: (message: string) => calls.push("notify:" + message),
    },
  } as any;
  return { ctx, calls, widget: () => widgetFactory };
}

describe("semantic compact progress", () => {
  it("renders completed/current/future phases and marks optional Explore skipped", () => {
    const { ctx, calls, widget } = context();
    showProgressOverlay(ctx, { phase: 3, phaseName: "Synthesize", detail: "2/4 batches" });
    expect(calls).toEqual(["status:Smart Compact · Synthesize · 2/4 batches", "widget:set"]);
    const component = widget()!({}, { fg: (_color: string, text: string) => text });
    expect(component.render(120)).toEqual([
      "✓ Extract  – Explore  ● Synthesize  ○ Verify  ○ Apply",
    ]);
    clearCompactProgress(ctx);
    expect(calls.slice(-2)).toEqual(["status:undefined", "widget:clear"]);
    expect(calls.some(call => call.startsWith("notify:"))).toBeFalse();
  });

  it("renders Explore completed when the optional phase ran", () => {
    const { ctx, widget } = context();
    showProgressOverlay(ctx, { phase: 4, phaseName: "Verify", detail: "Checking", explorationRounds: 2 });
    const component = widget()!({}, { fg: (_color: string, text: string) => text });
    expect(component.render(120)[0]).toBe("✓ Extract  ✓ Explore  ✓ Synthesize  ● Verify  ○ Apply");
  });

  it("reports only applied estimates, never actual context", () => {
    const { ctx, calls } = context();
    notifyAppliedCompaction(ctx, {
      tokensBefore: 1_000, tokensSaved: 400, plannedAfterTokens: 550, estimatedAfterTokens: 600, estimatedYield: 0.4,
      qualityScore: 100,
    } as any, false);
    expect(calls.at(-1)).toContain("1,000t → planned ~550t / ~600t applied estimate");
    expect(calls.at(-1)).toContain("0 gaps");
    expect(calls.at(-1)).not.toContain("actual");
  });

  it("suppresses headless progress", () => {
    const { ctx, calls } = context();
    ctx.hasUI = false;
    showProgressOverlay(ctx, { phase: 1, phaseName: "Extract", detail: "Preparing" });
    expect(calls).toEqual([]);
  });
});
