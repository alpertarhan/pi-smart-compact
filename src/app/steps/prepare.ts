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
import { getProviderCaps } from "../../utils/tokens.ts";
import { loadConfig } from "../../utils/helpers.ts";
import * as log from "../../utils/logger.ts";

export async function prepareRun(rc: RcBase): Promise<PreparedRc | null> {
  const config = loadConfig();
  const profileCfg = { ...PROFILES[rc.profile], ...(config.profiles?.[rc.profile] ?? {}) };
  const providerCaps = getProviderCaps(rc.summaryModel.provider);

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
        "Smart compact auto-trigger exceeded " + rc.timeoutMs + "ms; Pi will use native compact for this run",
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
    summaryAuth: { apiKey: string; headers?: Record<string, string> };
    segAuth: { apiKey: string; headers?: Record<string, string> };
  };
  out.config = config;
  out.profileCfg = profileCfg;
  out.providerCaps = providerCaps;
  out.summaryAuth = { apiKey: auth.apiKey, headers: auth.headers };
  out.segAuth = { apiKey: segAuth.apiKey!, headers: segAuth.headers };
  return advance<RcBase, PreparedRc>(out, "_prepared");
}
