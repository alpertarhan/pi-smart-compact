/**
 * Step 1: prepare a run — load config, resolve auth, wire cancellation.
 *
 * Stage transition: `RcBase` → `PreparedRc`.
 *
 * Returns `null` when authentication fails so the orchestrator can bail
 * before any side effects. The null return is the explicit guard that lets
 * TypeScript prove later steps never see a half-initialised context.
 */

import type { RcBase, PreparedRc } from "../run-context.ts";
import { advance } from "../run-context.ts";
import { PROFILES } from "../../constants.ts";
import { getProviderCaps, makeTokenEstimator } from "../../utils/tokens.ts";
import { loadConfig } from "../../utils/helpers.ts";
import * as log from "../../utils/logger.ts";
import { SecretScrubber } from "../../domain/scrub.ts";
import { BudgetGuard } from "../../infra/services.ts";
import { deriveProjectIdFromCwd } from "../../utils/fingerprint.ts";
import { readRecentDamageScores } from "../../utils/damage.ts";

export async function prepareRun(rc: RcBase): Promise<PreparedRc | null> {
  const config = loadConfig();
  let profileCfg = { ...PROFILES[rc.profile], ...(config.profiles?.[rc.profile] ?? {}) };
  let adapted = false;
  if (config.adaptiveDamageFeedback) {
    const scores = readRecentDamageScores(deriveProjectIdFromCwd(rc.ctx.cwd), 5);
    const recent = scores.slice(-3).sort((a, b) => a - b);
    const median = recent.length ? recent[Math.floor(recent.length / 2)] : 0;
    if (median >= 25) {
      const multiplier = median >= 50 ? 1.5 : 1.25;
      profileCfg = {
        ...profileCfg,
        keepRecentTokens: Math.round(profileCfg.keepRecentTokens * multiplier),
        summaryBudgetTokens: Math.round(profileCfg.summaryBudgetTokens * (median >= 50 ? 1.3 : 1.2)),
      };
      adapted = true;
      rc.notify("Adaptive damage policy: median " + median + "/100 — preserving more recent context", "warning");
    }
  }
  const providerCaps = getProviderCaps(rc.summaryModel.provider);
  rc.services.thinkingLevels = {
    summaryThinkingLevel: config.summaryThinkingLevel,
    segmentationThinkingLevel: config.segmentationThinkingLevel,
  };
  rc.services.scrubber = new SecretScrubber(config.scrubSecrets, config.scrubPii);
  if (config.maxLatencyMs > 0) {
    rc.timeoutMs = rc.timeoutMs > 0 ? Math.min(rc.timeoutMs, config.maxLatencyMs) : config.maxLatencyMs;
  }
  rc.services.budget = new BudgetGuard(rc.maxLlmCalls ?? config.maxLlmCalls, rc.timeoutMs, rc.services.clock);
  const estimator = makeTokenEstimator(rc.summaryModel.provider, rc.summaryModel.id, rc.services.tokenCalibration);

  const auth = await rc.ctx.modelRegistry.getApiKeyAndHeaders(rc.summaryModel);
  // Avoid a second auth call when segModel === summaryModel; some providers
  // throttle credential fetches and we have no reason to pay that cost twice.
  const segAuth = rc.segModel !== rc.summaryModel
    ? await rc.ctx.modelRegistry.getApiKeyAndHeaders(rc.segModel)
    : auth;

  if ((!auth.ok || !auth.apiKey) || (!segAuth.ok || !segAuth.apiKey)) {
    if (!rc.flags.autoTriggered) rc.ctx.ui.notify("Auth failed", "error");
    return null;
  }

  if (rc.timeoutMs > 0) {
    rc.cancellation.timeoutId = setTimeout(() => {
      rc.cancellation.timedOut = true;
      rc.cancellation.controller.abort();
      rc.notify(
        "Smart compact exceeded " + rc.timeoutMs + "ms; Pi will use native compact for this run",
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
    summaryAuth: { apiKey: string; headers?: Record<string, string> };
    segAuth: { apiKey: string; headers?: Record<string, string> };
  };
  out.config = config;
  out.profileCfg = profileCfg;
  out.providerCaps = providerCaps;
  out.estimator = estimator;
  out.adapted = adapted;
  out.summaryAuth = { apiKey: auth.apiKey, headers: auth.headers };
  out.segAuth = { apiKey: segAuth.apiKey!, headers: segAuth.headers };
  return advance<RcBase, PreparedRc>(out, "_prepared");
}
