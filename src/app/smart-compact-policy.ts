import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CompactConfig } from "../types.ts";
import { loadConfig } from "../utils/config.ts";
import { errorDetail, reportIssue } from "../utils/issues.ts";
import * as log from "../utils/logger.ts";

const SMART_COMPACT_TOOL_NAME = "smart_compact";
const SMART_COMPACT_POLICY_ENTRY = "smart-compact-policy";
const POLICY_VERSION = 3;
const STATUS_KEY = "smart-compact-policy";

type AgentToolAccess = CompactConfig["agentToolAccess"];

export interface SmartCompactPolicySnapshot {
  agentToolAccess: AgentToolAccess;
  /** Effective host state after allowlists and other tool controls are applied. */
  agentToolEnabled: boolean;
  autoTrigger: boolean;
  showStatus: boolean;
}

export interface DesiredSmartCompactPolicy {
  agentToolAccess: AgentToolAccess;
  autoTrigger: boolean;
  showStatus: boolean;
}

interface PersistedSmartCompactPolicy {
  version: typeof POLICY_VERSION;
  overrides: Partial<DesiredSmartCompactPolicy>;
}

export type SmartCompactPolicyField = keyof DesiredSmartCompactPolicy;

type SmartCompactPolicyUpdate =
  | { ok: true; policy: SmartCompactPolicySnapshot }
  | { ok: false; policy: SmartCompactPolicySnapshot; error: string };

export interface SmartCompactPolicy {
  snapshot(): SmartCompactPolicySnapshot;
  branchOverrides(): Readonly<Partial<DesiredSmartCompactPolicy>>;
  isAgentToolEnabled(): boolean;
  isAutoTriggerEnabled(): boolean;
  restore(ctx: ExtensionContext): void;
  update(
    patch: Partial<DesiredSmartCompactPolicy>,
    ctx: ExtensionContext,
  ): SmartCompactPolicyUpdate;
  reset(
    field: SmartCompactPolicyField,
    ctx: ExtensionContext,
  ): SmartCompactPolicyUpdate;
}

function persistedPolicy(value: unknown): Partial<DesiredSmartCompactPolicy> | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version === POLICY_VERSION &&
    typeof candidate.overrides === "object" &&
    candidate.overrides !== null &&
    !Array.isArray(candidate.overrides)
  ) {
    const values = candidate.overrides as Record<string, unknown>;
    const overrides: Partial<DesiredSmartCompactPolicy> = {};
    if (values.agentToolAccess !== undefined) {
      if (
        values.agentToolAccess !== "inherit" &&
        values.agentToolAccess !== "enabled" &&
        values.agentToolAccess !== "disabled"
      ) {
        return null;
      }
      overrides.agentToolAccess = values.agentToolAccess;
    }
    if (values.autoTrigger !== undefined) {
      if (typeof values.autoTrigger !== "boolean") return null;
      overrides.autoTrigger = values.autoTrigger;
    }
    if (values.showStatus !== undefined) {
      if (typeof values.showStatus !== "boolean") return null;
      overrides.showStatus = values.showStatus;
    }
    return overrides;
  }
  if (
    candidate.version === 2 &&
    (candidate.agentToolAccess === "inherit" ||
      candidate.agentToolAccess === "enabled" ||
      candidate.agentToolAccess === "disabled") &&
    typeof candidate.autoTrigger === "boolean"
  ) {
    const desired: DesiredSmartCompactPolicy = {
      agentToolAccess: candidate.agentToolAccess,
      autoTrigger: candidate.autoTrigger,
      showStatus: true,
    };
    if (typeof candidate.showStatus === "boolean") {
      desired.showStatus = candidate.showStatus;
    }
    return desired;
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
    showStatus: config.showStatus !== false,
  };
}

function statusText(policy: SmartCompactPolicySnapshot): string | undefined {
  if (!policy.agentToolEnabled && policy.agentToolAccess !== "disabled" && loadConfig().toolLoading === "lazy") {
    return "smart-compact: on-demand tools" + (policy.autoTrigger ? "" : " · auto off");
  }
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

export function createSmartCompactPolicy(pi: ExtensionAPI, syncTools: () => void): SmartCompactPolicy {
  let overrides: Partial<DesiredSmartCompactPolicy> = {};

  const desired = (): DesiredSmartCompactPolicy => ({
    ...configDefaults(),
    ...overrides,
  });

  const effectiveToolState = (): boolean =>
    pi.getActiveTools().includes(SMART_COMPACT_TOOL_NAME);

  const snapshot = (): SmartCompactPolicySnapshot => ({
    ...desired(),
    agentToolEnabled: effectiveToolState(),
  });

  const apply = (ctx: ExtensionContext): SmartCompactPolicySnapshot => {
    const current = desired();
    syncTools();
    const effective = snapshot();
    ctx.ui.setStatus(STATUS_KEY, current.showStatus ? statusText(effective) : undefined);
    return effective;
  };


  const persist = (
    next: Partial<DesiredSmartCompactPolicy>,
    ctx: ExtensionContext,
  ): SmartCompactPolicyUpdate => {
    const previous = overrides;
    overrides = next;
    try {
      const effective = apply(ctx);
      pi.appendEntry<PersistedSmartCompactPolicy>(
        SMART_COMPACT_POLICY_ENTRY,
        { version: POLICY_VERSION, overrides: { ...overrides } },
      );
      return { ok: true, policy: effective };
    } catch (error) {
      log.debugError("Smart Compact policy update failed", error);
      overrides = previous;
      try {
        syncTools();
      } catch (rollbackError) {
        reportIssue({
          key: "policy.rollback",
          severity: "error",
          message: "Rolling back a failed setting change also failed (" + errorDetail(rollbackError) + "). Tool visibility may not match the setting. Use /tools to check, then restart Pi.",
          error: rollbackError,
        }, ctx);
      }
      const rolledBack = snapshot();
      const previousDesired = desired();
      ctx.ui.setStatus(
        STATUS_KEY,
        previousDesired.showStatus ? statusText(rolledBack) : undefined,
      );
      return {
        ok: false,
        policy: rolledBack,
        error:
          "Smart Compact settings could not be saved; the previous policy was restored.",
      };
    }
  };

  return {
    snapshot,
    branchOverrides: () => ({ ...overrides }),
    isAgentToolEnabled: effectiveToolState,
    isAutoTriggerEnabled: () => desired().autoTrigger,
    restore(ctx) {
      overrides = {};
      for (const entry of ctx.sessionManager.getBranch()) {
        if (
          entry.type === "custom" &&
          entry.customType === SMART_COMPACT_POLICY_ENTRY
        ) {
          const restored = persistedPolicy(entry.data);
          if (restored) overrides = restored;
        }
      }
      apply(ctx);
    },
    update(patch, ctx) {
      return persist({ ...overrides, ...patch }, ctx);
    },
    reset(field, ctx) {
      const next = { ...overrides };
      delete next[field];
      return persist(next, ctx);
    },
  };
}
