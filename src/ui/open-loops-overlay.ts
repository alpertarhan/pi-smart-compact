import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { TRUNC } from "../constants.ts";
import type { LoopOverride, OpenLoop } from "../types.ts";
import { applyLoopOverrides, upsertLoopOverride } from "../utils/state.ts";

export async function showOpenLoopsUI(
  ctx: ExtensionCommandContext,
  sourceLoops: OpenLoop[],
  initialOverrides: LoopOverride[] = [],
): Promise<LoopOverride[] | null> {
  let overrides = [...initialOverrides];
  let changed = false;
  while (true) {
    const loops = applyLoopOverrides(sourceLoops, overrides);
    const labels = loops.map(
      (loop, index) =>
        index +
        1 +
        ". [" +
        loop.status +
        "/" +
        loop.priority +
        "] " +
        loop.summary.slice(0, TRUNC.TOPIC_LABEL),
    );
    const choice = await ctx.ui.select("Open loops", [...labels, "Done"]);
    if (!choice || choice === "Done") return changed ? overrides : null;
    const loop = loops[labels.indexOf(choice)];
    if (!loop) continue;
    const summaryKey = loop.summary.toLowerCase().replace(/\s+/g, " ").trim();
    const existing = overrides.find((item) => item.summaryKey === summaryKey);
    const action = await ctx.ui.select("Manage: " + loop.summary.slice(0, 60), [
      loop.status === "resolved" ? "Reopen" : "Resolve",
      existing?.pinned ? "Unpin" : "Pin",
      "Set priority",
      "Back",
    ]);
    if (!action || action === "Back") continue;
    if (action === "Resolve" || action === "Reopen") {
      overrides = upsertLoopOverride(overrides, loop, {
        status: action === "Resolve" ? "resolved" : "open",
      });
    } else if (action === "Pin" || action === "Unpin") {
      overrides = upsertLoopOverride(overrides, loop, {
        pinned: action === "Pin",
      });
    } else if (action === "Set priority") {
      const priority = await ctx.ui.select("Priority", [
        "critical",
        "high",
        "normal",
        "low",
      ]);
      if (!priority) continue;
      overrides = upsertLoopOverride(overrides, loop, {
        priority: priority as OpenLoop["priority"],
      });
    }
    changed = true;
  }
}
