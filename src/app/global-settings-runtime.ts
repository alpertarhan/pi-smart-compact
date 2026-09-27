import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextToolExposure } from "./lazy-tools.ts";
import type { SmartCompactPolicy } from "./smart-compact-policy.ts";
import type { GlobalConfigPath } from "../utils/config.ts";

const POLICY_PATHS = new Set<GlobalConfigPath>([
  "agentToolAccess",
  "autoTrigger",
  "showStatus",
  "toolLoading",
]);

/** Refresh each owner at most once after one atomic global-settings patch. */
export function applyGlobalSettingsRuntime(
  paths: readonly GlobalConfigPath[],
  ctx: ExtensionContext,
  policy: SmartCompactPolicy,
  contextTools: Pick<ContextToolExposure, "apply">,
): void {
  if (paths.some(path => POLICY_PATHS.has(path))) policy.restore(ctx);
  else contextTools.apply();
}
