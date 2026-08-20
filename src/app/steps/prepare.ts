/**
 * Step 1: prepare a run — load config, provider caps, budgets, and
 * cancellation. Provider credentials are intentionally resolved later by
 * `resolveStageAuth()` immediately before each stage's first network call.
 *
 * Stage transition: `RcBase` → `PreparedRc`.
 */

import type { RcBase, PreparedRc, ResolvedAuth } from "../run-context.ts";
import { advance } from "../run-context.ts";
import { effectiveBudget, MODE_POLICIES } from "../mode-policy.ts";
import { DEFAULT_CONFIG } from "../../constants.ts";
import { getProviderCaps } from "../../utils/tokens.ts";
import { loadConfig } from "../../utils/config.ts";
import { preparePreflightProfile } from "../preflight.ts";
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
  const callBudget =
    rc.maxLlmCalls ?? effectiveBudget(config.maxLlmCalls, policy.maxLlmCalls);
  const inputBudget =
    rc.maxLlmInputTokens ??
    effectiveBudget(config.maxLlmInputTokens, policy.maxInputTokens);
  rc.services.budget = new BudgetGuard(
    callBudget,
    rc.timeoutMs,
    rc.services.clock,
    inputBudget,
    policy.maxOutputTokens,
  );

  if (rc.timeoutMs > 0) {
    rc.cancellation.timeoutId = setTimeout(() => {
      rc.cancellation.timedOut = true;
      rc.cancellation.controller.abort();
      rc.notify(
        "Smart compact exceeded " +
          rc.timeoutMs +
          "ms; Pi will use native compact for this run",
        "warning",
      );
    }, rc.timeoutMs);
  }

  log.debug("prepareRun: profile=" + rc.profile + " model=" + rc.modelLabel);

  // Mutate in place + advance stage. The cast is the explicit boundary that
  // tells TypeScript these fields are now safely populated.
  const out = rc as RcBase & {
    _prepared: true;
    config: typeof config;
    profileCfg: typeof profileCfg;
    providerCaps: typeof providerCaps;
    estimator: typeof estimator;
    adapted: boolean;
    summaryAuth?: ResolvedAuth;
    segAuth?: ResolvedAuth;
    verifyAuth?: ResolvedAuth;
  };
  out.config = config;
  out.profileCfg = profileCfg;
  out.providerCaps = providerCaps;
  out.estimator = estimator;
  out.adapted = adapted;
  return advance<RcBase, PreparedRc>(out, "_prepared");
}
