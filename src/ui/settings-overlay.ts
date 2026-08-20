import {
  getSettingsListTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";
import type {
  SmartCompactPolicy,
  SmartCompactPolicySnapshot,
} from "../app/smart-compact-policy.ts";

const INHERIT = "host default";
const ENABLED = "enabled";
const DISABLED = "disabled";

function accessValue(policy: SmartCompactPolicySnapshot): string {
  return policy.agentToolAccess === "inherit"
    ? INHERIT
    : policy.agentToolAccess;
}

function parseAccessValue(
  value: string,
): SmartCompactPolicySnapshot["agentToolAccess"] {
  return value === INHERIT
    ? "inherit"
    : (value as SmartCompactPolicySnapshot["agentToolAccess"]);
}

function previousValue(id: string, policy: SmartCompactPolicySnapshot): string {
  if (id === "agentToolAccess") return accessValue(policy);
  return policy.autoTrigger ? ENABLED : DISABLED;
}

function settingsItems(policy: SmartCompactPolicySnapshot): SettingItem[] {
  return [
    {
      id: "agentToolAccess",
      label: "Agent access",
      description:
        "Inherit Pi's tool selection, or explicitly enable/disable smart_compact",
      currentValue: accessValue(policy),
      values: [INHERIT, ENABLED, DISABLED],
    },
    {
      id: "autoTrigger",
      label: "Automatic compaction",
      description: "Run Smart Compact from Pi's automatic compaction lifecycle",
      currentValue: policy.autoTrigger ? ENABLED : DISABLED,
      values: [ENABLED, DISABLED],
    },
  ];
}

/** Session/branch-scoped policy editor. Manual `/smart-compact` always remains available. */
export async function showSmartCompactSettings(
  ctx: ExtensionCommandContext,
  policy: SmartCompactPolicy,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Smart Compact Settings")), 0, 0),
    );
    container.addChild(
      new Text(
        theme.fg("dim", "Changes apply now and follow this session branch."),
        0,
        0,
      ),
    );
    container.addChild(
      new Text(
        theme.fg("dim", "Manual /smart-compact stays available in every mode."),
        0,
        0,
      ),
    );
    container.addChild(new Text("", 0, 0));

    const list = new SettingsList(
      settingsItems(policy.snapshot()),
      6,
      getSettingsListTheme(),
      (id, value) => {
        const previous = policy.snapshot();
        const result =
          id === "agentToolAccess"
            ? policy.update({ agentToolAccess: parseAccessValue(value) }, ctx)
            : policy.update({ autoTrigger: value === ENABLED }, ctx);
        if (!result.ok) {
          list.updateValue(id, previousValue(id, previous));
          ctx.ui.notify(result.error, "error");
        }
      },
      () => done(undefined),
    );
    container.addChild(list);
    container.addChild(new Text("", 0, 0));
    container.addChild(
      new Text(theme.fg("dim", "↑↓ navigate · enter change · esc close"), 0, 0),
    );

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}
