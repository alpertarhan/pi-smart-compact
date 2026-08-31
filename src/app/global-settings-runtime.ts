import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextToolAvailability } from "./register-context-tools.ts";
import type { SmartCompactPolicy } from "./smart-compact-policy.ts";
import type { GlobalConfigPath } from "../utils/config.ts";

const POLICY_PATHS = new Set<GlobalConfigPath>([
  "agentToolAccess",
  "autoTrigger",
  "showStatus",
]);

/** Apply the small subset of global settings that own live host state. */
export function applyGlobalSettingRuntime(
  path: GlobalConfigPath,
  ctx: ExtensionContext,
  policy: SmartCompactPolicy,
  contextTools: ContextToolAvailability,
): void {
  if (POLICY_PATHS.has(path)) policy.restore(ctx);
  if (path === "contextGraphEnabled") contextTools.apply();
}
