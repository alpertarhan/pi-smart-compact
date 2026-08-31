import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import smartCompactExtension from "../src/index.ts";
import { createSmartCompactPolicy } from "../src/app/smart-compact-policy.ts";
import { resetConfigCache } from "../src/utils/config.ts";

const originalHome = process.env.HOME;
let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "smart-compact-policy-"));
  process.env.HOME = home;
  const agentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      smartCompact: { agentToolAccess: "inherit", autoTrigger: true },
    }),
  );
  resetConfigCache();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  resetConfigCache();
});

function harness(
  branch: any[] = [],
  options: {
    allowSmartCompact?: boolean;
    appendError?: boolean;
    addSiblingBeforeAppendError?: boolean;
  } = {},
) {
  let active = ["read", "smart_compact", "smart_recall"];
  const writes: Array<{ customType: string; data: unknown }> = [];
  const statuses: Array<string | undefined> = [];
  const pi = {
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active =
        options.allowSmartCompact === false
          ? names.filter((name) => name !== "smart_compact")
          : [...names];
    },
    appendEntry: (customType: string, data: unknown) => {
      if (options.appendError) {
        if (options.addSiblingBeforeAppendError) active.push("sibling_tool");
        throw new Error("session is read-only");
      }
      writes.push({ customType, data });
    },
  };
  const ctx = {
    sessionManager: { getBranch: () => branch },
    ui: {
      setStatus: (_key: string, value: string | undefined) =>
        statuses.push(value),
    },
  };
  const policy = createSmartCompactPolicy(pi as any);
  return {
    policy,
    ctx: ctx as any,
    active: () => active,
    replaceActive: (names: string[]) => {
      active = [...names];
    },
    writes,
    statuses,
  };
}

describe("smart compact runtime policy", () => {
  it("hides only smart_compact and persists a sparse branch override", () => {
    const test = harness();
    test.policy.restore(test.ctx);
    const result = test.policy.update(
      { agentToolAccess: "disabled" },
      test.ctx,
    );
    expect(result.ok).toBe(true);

    expect(test.active()).toEqual(["read", "smart_recall"]);
    expect(test.writes).toEqual([
      {
        customType: "smart-compact-policy",
        data: {
          version: 3,
          overrides: { agentToolAccess: "disabled" },
        },
      },
    ]);
    expect(test.statuses.at(-1)).toBe("smart-compact: agent hidden · auto on");
  });

  it("restores the last valid branch entry and re-enables without duplicates", () => {
    const branch = [
      {
        type: "custom",
        customType: "smart-compact-policy",
        data: { version: 1, agentToolEnabled: false, autoTrigger: false },
      },
      {
        type: "custom",
        customType: "smart-compact-policy",
        data: { version: 2, agentToolAccess: "enabled", autoTrigger: false },
      },
    ];
    const test = harness(branch);
    test.policy.restore(test.ctx);
    test.policy.update({ agentToolAccess: "enabled" }, test.ctx);

    expect(test.policy.snapshot()).toEqual({
      agentToolAccess: "enabled",
      agentToolEnabled: true,
      autoTrigger: false,
      showStatus: true,
    });
    expect(
      test.active().filter((name) => name === "smart_compact"),
    ).toHaveLength(1);
    expect(test.statuses.at(-1)).toBe("smart-compact: auto off");
  });

  it("applies sparse overrides over changing global defaults", () => {
    const branch = [
      {
        type: "custom",
        customType: "smart-compact-policy",
        data: { version: 3, overrides: { autoTrigger: false } },
      },
    ];
    const test = harness(branch);
    test.policy.restore(test.ctx);
    expect(test.policy.snapshot().agentToolAccess).toBe("inherit");

    fs.writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({
        smartCompact: { agentToolAccess: "disabled", autoTrigger: true },
      }),
    );
    resetConfigCache();
    test.policy.restore(test.ctx);

    expect(test.policy.snapshot()).toEqual({
      agentToolAccess: "disabled",
      agentToolEnabled: false,
      autoTrigger: false,
      showStatus: true,
    });
    expect(test.policy.branchOverrides()).toEqual({ autoTrigger: false });
  });

  it("resets one override to the current global default", () => {
    const test = harness();
    test.policy.restore(test.ctx);
    test.policy.update(
      { agentToolAccess: "disabled", autoTrigger: false },
      test.ctx,
    );
    const result = test.policy.reset("autoTrigger", test.ctx);

    expect(result.ok).toBe(true);
    expect(result.policy.autoTrigger).toBe(true);
    expect(test.policy.branchOverrides()).toEqual({
      agentToolAccess: "disabled",
    });
    expect(test.writes.at(-1)).toEqual({
      customType: "smart-compact-policy",
      data: {
        version: 3,
        overrides: { agentToolAccess: "disabled" },
      },
    });
  });

  it("disables both automatic lifecycle paths while manual registration remains", async () => {
    const handlers = new Map<
      string,
      Array<(event: any, ctx: any) => unknown>
    >();
    const commands = new Map<string, unknown>();
    let active = ["read", "smart_compact"];
    const branch = [
      {
        type: "custom",
        customType: "smart-compact-policy",
        data: { version: 1, agentToolEnabled: false, autoTrigger: false },
      },
    ];
    smartCompactExtension({
      registerCommand: (name: string, command: unknown) =>
        commands.set(name, command),
      registerTool: () => {},
      on: (name: string, handler: (event: any, ctx: any) => unknown) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => {
        active = [...names];
      },
      appendEntry: () => {},
    } as any);
    let compactRequests = 0;
    const ctx = {
      sessionManager: {
        getBranch: () => branch,
        getSessionId: () => "policy-session",
      },
      ui: { setStatus: () => {}, notify: () => {} },
      compact: () => {
        compactRequests++;
      },
    };

    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    await handlers.get("agent_settled")![0]({}, ctx);
    const nativeResult = await handlers.get("session_before_compact")![0](
      {
        reason: "manual",
        signal: new AbortController().signal,
      },
      ctx,
    );

    expect(active).toEqual(["read"]);
    expect(compactRequests).toBe(0);
    expect(nativeResult).toBeUndefined();
    expect(commands.has("smart-compact")).toBe(true);
  });

  it("uses permanent manual-only defaults when the branch has no override", () => {
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({
        smartCompact: { agentToolAccess: "disabled", autoTrigger: false },
      }),
    );
    resetConfigCache();
    const test = harness();
    test.policy.restore(test.ctx);

    expect(test.policy.snapshot()).toEqual({
      agentToolAccess: "disabled",
      agentToolEnabled: false,
      autoTrigger: false,
      showStatus: true,
    });
    expect(test.active()).toEqual(["read", "smart_recall"]);
    expect(test.statuses.at(-1)).toBe("smart-compact: manual only");
  });

  it("clears the footer status when showStatus is disabled", () => {
    const test = harness([
      {
        type: "custom",
        customType: "smart-compact-policy",
        data: {
          version: 2,
          agentToolAccess: "disabled",
          autoTrigger: false,
          showStatus: false,
        },
      },
    ]);
    test.policy.restore(test.ctx);

    expect(test.policy.snapshot()).toEqual({
      agentToolAccess: "disabled",
      agentToolEnabled: false,
      autoTrigger: false,
      showStatus: false,
    });
    expect(test.statuses.at(-1)).toBeUndefined();
  });

  it("keeps the last valid branch state when a trailing entry is invalid", () => {
    const test = harness([
      {
        type: "custom",
        customType: "smart-compact-policy",
        data: { version: 3, overrides: { autoTrigger: false } },
      },
      {
        type: "custom",
        customType: "smart-compact-policy",
        data: { version: 1, agentToolEnabled: "no", autoTrigger: false },
      },
    ]);
    test.policy.restore(test.ctx);

    expect(test.policy.snapshot()).toEqual({
      agentToolAccess: "inherit",
      agentToolEnabled: true,
      autoTrigger: false,
      showStatus: true,
    });
    expect(test.statuses.at(-1)).toBe("smart-compact: auto off");
  });

  it("does not override a host tool deactivation while access is inherited", () => {
    const test = harness();
    test.policy.restore(test.ctx);
    test.replaceActive(["read", "smart_recall"]);
    test.policy.restore(test.ctx);

    expect(test.active()).toEqual(["read", "smart_recall"]);
    expect(test.policy.snapshot()).toEqual({
      agentToolAccess: "inherit",
      agentToolEnabled: false,
      autoTrigger: true,
      showStatus: true,
    });
  });

  it("reports the effective state when the host rejects explicit enablement", () => {
    const test = harness([], { allowSmartCompact: false });
    test.replaceActive(["read", "smart_recall"]);
    test.policy.restore(test.ctx);
    const result = test.policy.update({ agentToolAccess: "enabled" }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.policy.agentToolEnabled).toBe(false);
    expect(test.statuses.at(-1)).toBe(
      "smart-compact: agent unavailable · auto on",
    );
  });

  it("rolls runtime state back when session persistence fails", () => {
    const test = harness([], {
      appendError: true,
      addSiblingBeforeAppendError: true,
    });
    test.policy.restore(test.ctx);
    const result = test.policy.update(
      { agentToolAccess: "disabled", autoTrigger: false },
      test.ctx,
    );

    expect(result.ok).toBe(false);
    expect(test.active()).toEqual([
      "read",
      "smart_recall",
      "sibling_tool",
      "smart_compact",
    ]);
    expect(test.policy.snapshot()).toEqual({
      agentToolAccess: "inherit",
      agentToolEnabled: true,
      autoTrigger: true,
      showStatus: true,
    });
    expect(test.writes).toEqual([]);
  });
});
