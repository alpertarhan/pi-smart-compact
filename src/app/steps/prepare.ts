/**
 * Step 1: prepare a run — load config, provider caps, budgets, and
 * cancellation. Provider credentials are intentionally resolved later by
 * `resolveStageAuth()` immediately before each stage's first network call.
 *
 * Stage transition: `RcBase` → `PreparedRc`.
 */

import type { RcBase, PreparedRc, ResolvedAuth } from "../run-context.ts";
import { advance } from "../run-context.ts";
import { effectiveBudget, resolveCallBudget, resolveOutputBudget, MODE_POLICIES } from "../mode-policy.ts";
import { DEFAULT_CONFIG } from "../../constants.ts";
import { getProviderCaps, makeReaderTokenEstimator } from "../../utils/tokens.ts";
import { loadConfig } from "../../utils/config.ts";
import { preparePreflightProfile } from "../preflight.ts";
import { createUsagePricing } from "../context-usage.ts";
import { readerSignature } from "../pending-slot.ts";
import * as log from "../../utils/logger.ts";
import { SecretScrubber } from "../../domain/scrub.ts";
import { BudgetGuard } from "../../infra/services.ts";

export async function prepareRun(rc: RcBase): Promise<PreparedRc> {
 const config = rc.config ?? loadConfig();
 const { profileCfg, estimator, adapted, damageMedian } =
  preparePreflightProfile({
   cwd: rc.ctx.cwd,
   summaryModel: rc.summaryModel,
   mode: rc.mode,
   tokenCalibration: rc.services.tokenCalibration,
   config,
  });
 if (adapted) {
  rc.notify(
   "Adaptive damage policy: median " +
   damageMedian +
   "/100 — preserving more recent context",
   "info",
  );
 }
 const providerCaps = getProviderCaps(rc.summaryModel.provider);
 // Reader-domain pricing for everything the ACTIVE model replays: the window
 // walk, the native split, and the final-yield check. Summary requests keep
 // rc.estimator (the summarizer's own domain).
 const readerEstimator = rc.ctx.model
  ? makeReaderTokenEstimator(
    { provider: rc.ctx.model.provider, id: rc.ctx.model.id, api: rc.ctx.model.api, input: rc.ctx.model.input },
    rc.services.tokenCalibration,
   )
  : estimator;
 const usagePricing = createUsagePricing(
  rc.ctx.model
   ? { provider: rc.ctx.model.provider, id: rc.ctx.model.id, api: rc.ctx.model.api, input: rc.ctx.model.input }
   : { provider: rc.summaryModel.provider, id: rc.summaryModel.id, api: rc.summaryModel.api, input: rc.summaryModel.input },
  rc.services.tokenCalibration,
 );
 rc.services.thinkingLevels = {
  summaryThinkingLevel: config.summaryThinkingLevel,
  segmentationThinkingLevel: config.segmentationThinkingLevel,
 };
 rc.services.codexWatchdogMs =
  config.codexMaxCallMs ?? DEFAULT_CONFIG.codexMaxCallMs;
 rc.services.scrubber = new SecretScrubber(
  config.scrubSecrets,
  config.scrubPii,
 );
 if (config.maxLatencyMs > 0) {
  rc.timeoutMs =
   rc.timeoutMs > 0
    ? Math.min(rc.timeoutMs, config.maxLatencyMs)
    : config.maxLatencyMs;
 }
 const policy = MODE_POLICIES[rc.mode];
 const callBudget = resolveCallBudget(config.maxLlmCalls, rc.mode, rc.maxLlmCalls, rc.flags.autoTriggered && !rc.flags.skipCompact);
 const inputBudget = effectiveBudget(config.maxLlmInputTokens, policy.maxInputTokens, rc.maxLlmInputTokens);
 rc.services.budget = new BudgetGuard(
  callBudget,
  rc.timeoutMs,
  rc.services.clock,
  inputBudget,
  resolveOutputBudget(rc.mode, callBudget, [rc.summaryModel, rc.segModel, rc.verifyModel]),
 );

 if (rc.timeoutMs > 0) {
  rc.cancellation.timeoutId = setTimeout(() => {
   rc.cancellation.timedOut = true;
   rc.cancellation.controller.abort();
   rc.notify(
    "Smart compact exceeded " +
    rc.timeoutMs +
    "ms; stopped without applying a Smart Compact summary. Review the latency budget or retry when ready.",
    "warning",
   );
  }, rc.timeoutMs);
 }

 log.debug("prepareRun: profile=" + rc.profile + " model=" + rc.modelLabel);

 // Mutate in place + advance stage. The cast is the explicit boundary that
 // tells TypeScript these fields are now safely populated.
 const out = rc as RcBase & {
  _prepared: true;
  readerSignature?: string;
  config: typeof config;
  profileCfg: typeof profileCfg;
  providerCaps: typeof providerCaps;
  estimator: typeof estimator;
  readerEstimator: ReturnType<typeof makeReaderTokenEstimator>;
  usagePricing: ReturnType<typeof createUsagePricing>;
  adapted: boolean;
  summaryAuth?: ResolvedAuth;
  segAuth?: ResolvedAuth;
  verifyAuth?: ResolvedAuth;
 };
 out.readerSignature = readerSignature(rc.ctx);
 out.config = config;
 out.profileCfg = profileCfg;
 out.providerCaps = providerCaps;
 out.estimator = estimator;
 out.readerEstimator = readerEstimator;
 out.usagePricing = usagePricing;
 out.adapted = adapted;
 return advance<RcBase, PreparedRc>(out, "_prepared");
}
