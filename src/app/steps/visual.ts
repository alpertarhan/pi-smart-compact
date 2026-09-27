/** Optional visual evidence is budgeted only after the text passes both verification gates. */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { VisualArchive } from "../../types.ts";
import { estimateVisualTokens, renderVisualPages, visualPageSize } from "../../infra/visual-renderer.ts";
import { verifyCompactionYield } from "../../domain/yield-gate.ts";
import { canReadVisual, selectVisualSources, validVisualArchive, visualEconomics, visualPages } from "../visual-archive.ts";
import type { StatedRc } from "../run-context.ts";
import { errorDetail, reportIssue } from "../../utils/issues.ts";
import { makeTokenEstimator } from "../../utils/tokens.ts";

export async function attachVisualArchive(rc: StatedRc, render = renderVisualPages): Promise<void> {
  const model = rc.ctx.model;
  if (!rc.config.visualArchiveEnabled || !canReadVisual(model) || !model || rc.flags.overflowRecovery
    || rc.cancellation.signal.aborted) return;
  try {
    let sources = selectVisualSources(rc.branch as SessionEntry[], rc.toCompact, rc.finalSummary, rc.services.scrubber);
    let pages = visualPages(sources);
    const textTokens = rc.estimator.text(rc.finalSummary);
    const before = rc.details.estimatedAfterTokens ?? rc.totalTokens;
    const allowance = Math.min(rc.compactionPlan.targetAfterTokens - before,
      model.contextWindow - Math.max(8_192, model.maxTokens ?? 0) - before) - 256;
    const estimate = () => pages.reduce((sum, lines) => {
      const size = visualPageSize(lines);
      return sum + estimateVisualTokens(size.width, size.height);
    }, 0);
    // Drop oldest whole excerpts, not random cells, until the verified target still fits.
    while (sources.length && estimate() > allowance) {
      sources = sources.slice(1);
      pages = visualPages(sources);
    }
    const reader = { provider: model.provider, id: model.id, api: model.api };
    // rc.estimator prices the summarizer; these excerpts would be sent to the reader.
    const readerEstimator = makeTokenEstimator(model.provider, model.id, rc.services.tokenCalibration);
    if (!sources.length || !visualEconomics(reader, sources, pages.map(visualPageSize), readerEstimator.text).worthwhile) return;
    const frames = await render(pages, AbortSignal.any([rc.cancellation.signal, AbortSignal.timeout(5_000)]));
    if (rc.cancellation.signal.aborted) return;
    const archive: VisualArchive = {
      version: 1, reader, sources, frames,
      estimatedTokens: frames.reduce((sum, frame) => sum + estimateVisualTokens(frame.width, frame.height), 0),
    };
    if (!validVisualArchive(archive) || frames.length !== pages.length
      || !visualEconomics(reader, sources, frames, readerEstimator.text).worthwhile) return;
    const visualTokens = archive.estimatedTokens + 256; // request-local reading guide allowance
    const yieldEstimate = verifyCompactionYield(rc.totalTokens, textTokens + visualTokens, rc.compactionPlan);
    rc.tokensSaved = yieldEstimate.estimatedSavedTokens;
    rc.details = { ...rc.details, ...yieldEstimate, summaryTokens: textTokens,
      tokensSaved: rc.tokensSaved, visualTokens, visualArchive: archive };
  } catch (error) {
    // Missing optional binaries/fonts, timeout, or an unprofitable budget never discard verified text.
    reportIssue({
      key: "visual.archive",
      message: "Visual archive unavailable (" + errorDetail(error) + "). The verified text compaction is used. Disable visualArchiveEnabled if this repeats.",
      error,
    }, rc.ctx);
  }
}
