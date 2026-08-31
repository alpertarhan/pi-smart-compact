import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyGlobalSettingRuntime } from "../src/app/global-settings-runtime.ts";

describe("global settings runtime refresh", () => {
  it("hot-applies policy-owned tool, trigger, and status settings", () => {
    const restored: string[] = [];
    const contextApplies: string[] = [];
    const policy = {
      restore: () => restored.push("policy"),
    } as any;
    const contextTools = {
      apply: () => contextApplies.push("context"),
    };

    for (const path of [
      "agentToolAccess",
      "autoTrigger",
      "showStatus",
    ] as const) {
      applyGlobalSettingRuntime(
        path,
        {} as ExtensionContext,
        policy,
        contextTools,
      );
    }

    expect(restored).toEqual(["policy", "policy", "policy"]);
    expect(contextApplies).toEqual([]);
  });

  it("hot-applies context tool exposure only for contextGraphEnabled", () => {
    const restored: string[] = [];
    const contextApplies: string[] = [];
    const policy = {
      restore: () => restored.push("policy"),
    } as any;
    const contextTools = {
      apply: () => contextApplies.push("context"),
    };

    applyGlobalSettingRuntime(
      "contextGraphEnabled",
      {} as ExtensionContext,
      policy,
      contextTools,
    );
    applyGlobalSettingRuntime(
      "summaryModel",
      {} as ExtensionContext,
      policy,
      contextTools,
    );

    expect(contextApplies).toEqual(["context"]);
    expect(restored).toEqual([]);
  });
});
