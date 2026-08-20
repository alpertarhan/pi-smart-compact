import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CompactConfig } from "../types.ts";
import { loadConfig } from "../utils/config.ts";
import * as log from "../utils/logger.ts";

const SMART_COMPACT_TOOL_NAME = "smart_compact";
const SMART_COMPACT_POLICY_ENTRY = "smart-compact-policy";
const POLICY_VERSION = 2;
const STATUS_KEY = "smart-compact-policy";

type AgentToolAccess = CompactConfig["agentToolAccess"];

export interface SmartCompactPolicySnapshot {
  agentToolAccess: AgentToolAccess;
  /** Effective host state after allowlists and other tool controls are applied. */
  agentToolEnabled: boolean;
  autoTrigger: boolean;
}

interface DesiredSmartCompactPolicy {
  agentToolAccess: AgentToolAccess;
  autoTrigger: boolean;
}

interface PersistedSmartCompactPolicy extends DesiredSmartCompactPolicy {
  version: typeof POLICY_VERSION;
}

type SmartCompactPolicyUpdate =
  | { ok: true; policy: SmartCompactPolicySnapshot }
  | { ok: false; policy: SmartCompactPolicySnapshot; error: string };

export interface SmartCompactPolicy {
  snapshot(): SmartCompactPolicySnapshot;
  isAgentToolEnabled(): boolean;
  isAutoTriggerEnabled(): boolean;
  restore(ctx: ExtensionContext): void;
  update(
    patch: Partial<DesiredSmartCompactPolicy>,
    ctx: ExtensionContext,
  ): SmartCompactPolicyUpdate;
}

function persistedPolicy(value: unknown): DesiredSmartCompactPolicy | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version === POLICY_VERSION &&
    (candidate.agentToolAccess === "inherit" ||
      candidate.agentToolAccess === "enabled" ||
      candidate.agentToolAccess === "disabled") &&
    typeof candidate.autoTrigger === "boolean"
  ) {
    return {
      agentToolAccess: candidate.agentToolAccess,
      autoTrigger: candidate.autoTrigger,
    };
  }
  // Version 1 stored a boolean. Preserve an explicit user choice while moving
  // new/default sessions to host-owned `inherit` behavior.
  if (
    candidate.version === 1 &&
    typeof candidate.agentToolEnabled === "boolean" &&
    typeof candidate.autoTrigger === "boolean"
  ) {
    return {
      agentToolAccess: candidate.agentToolEnabled ? "enabled" : "disabled",
      autoTrigger: candidate.autoTrigger,
    };
  }
  return null;
}

function configDefaults(): DesiredSmartCompactPolicy {
  const config = loadConfig();
  return {
    agentToolAccess: config.agentToolAccess,
    autoTrigger: config.autoTrigger,
  };
}

function statusText(policy: SmartCompactPolicySnapshot): string | undefined {
  if (policy.agentToolEnabled && policy.autoTrigger) return undefined;
  if (!policy.agentToolEnabled && !policy.autoTrigger) {
    return "smart-compact: manual only";
  }
  if (!policy.agentToolEnabled) {
    return policy.agentToolAccess === "enabled"
      ? "smart-compact: agent unavailable · auto on"
      : "smart-compact: agent hidden · auto on";
  }
  return "smart-compact: auto off";
}

export function createSmartCompactPolicy(pi: ExtensionAPI): SmartCompactPolicy {
  let current = configDefaults();

  const effectiveToolState = (): boolean =>
    pi.getActiveTools().includes(SMART_COMPACT_TOOL_NAME);

  const snapshot = (): SmartCompactPolicySnapshot => ({
    ...current,
    agentToolEnabled: effectiveToolState(),
  });

  const apply = (ctx: ExtensionContext): SmartCompactPolicySnapshot => {
    const active = pi.getActiveTools();
    const hasTool = active.includes(SMART_COMPACT_TOOL_NAME);
    if (current.agentToolAccess === "enabled" && !hasTool) {
      pi.setActiveTools([...new Set([...active, SMART_COMPACT_TOOL_NAME])]);
    } else if (current.agentToolAccess === "disabled" && hasTool) {
      pi.setActiveTools(
        active.filter((name) => name !== SMART_COMPACT_TOOL_NAME),
      );
    }
    const effective = snapshot();
    ctx.ui.setStatus(STATUS_KEY, statusText(effective));
    return effective;
  };

  return {
    snapshot,
    isAgentToolEnabled: effectiveToolState,
    isAutoTriggerEnabled: () => current.autoTrigger,
    restore(ctx) {
      current = configDefaults();
      for (const entry of ctx.sessionManager.getBranch()) {
        if (
          entry.type === "custom" &&
          entry.customType === SMART_COMPACT_POLICY_ENTRY
        ) {
          const restored = persistedPolicy(entry.data);
          if (restored) current = restored;
        }
      }
      apply(ctx);
    },
    update(patch, ctx) {
      const previous = current;
      const previousActiveTools = pi.getActiveTools();
      current = { ...current, ...patch };
      try {
        const effective = apply(ctx);
        pi.appendEntry<PersistedSmartCompactPolicy>(
          SMART_COMPACT_POLICY_ENTRY,
          { version: POLICY_VERSION, ...current },
        );
        return { ok: true, policy: effective };
      } catch (error) {
        log.debugError("Smart Compact policy update failed", error);
        current = previous;
        try {
          pi.setActiveTools(previousActiveTools);
        } catch (rollbackError) {
          log.debugError("Smart Compact policy rollback failed", rollbackError);
        }
        const rolledBack = snapshot();
        ctx.ui.setStatus(STATUS_KEY, statusText(rolledBack));
        return {
          ok: false,
          policy: rolledBack,
          error:
            "Smart Compact settings could not be saved; the previous policy was restored.",
        };
      }
    },
  };
}
