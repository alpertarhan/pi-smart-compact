import {
  DynamicBorder,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  SelectList,
  Text,
  truncateToWidth,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { TRUNC } from "../constants.ts";
import type { BackupEntry } from "../utils/backups.ts";

/** Picker for `/smart-compact restore` — list backups, return the chosen path. */
export async function showRestorePicker(
  ctx: ExtensionCommandContext,
  backups: BackupEntry[],
): Promise<string | null> {
  const items: SelectItem[] = backups.map((backup) => ({
    value: backup.path,
    label:
      new Date(backup.date).toLocaleString() +
      "  ·  " +
      Math.max(1, Math.round(backup.sizeBytes / 1_024)) +
      "KB",
    description: backup.sessionId.slice(0, TRUNC.SESSION_ID_DISPLAY),
  }));
  return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(
      new DynamicBorder((value: string) => theme.fg("accent", value)),
    );
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold("  ↩ Smart Compact — Restore")),
        1,
        0,
      ),
    );
    container.addChild(
      new Text(
        theme.fg("dim", "  Pick a backup to view its pre-compaction content"),
        0,
        0,
      ),
    );
    container.addChild(new Text("", 0, 0));
    const select = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (value) => theme.fg("accent", value),
      selectedText: (value) => theme.fg("accent", value),
      description: (value) => theme.fg("muted", value),
      scrollInfo: (value) => theme.fg("dim", value),
      noMatch: (value) => theme.fg("warning", value),
    });
    select.onSelect = (item) => done(item.value);
    select.onCancel = () => done(null);
    container.addChild(select);
    container.addChild(new Text("", 0, 0));
    container.addChild(
      new Text(
        theme.fg("dim", "  ↑↓ navigate · enter view · esc cancel"),
        0,
        0,
      ),
    );
    container.addChild(
      new DynamicBorder((value: string) => theme.fg("accent", value)),
    );
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        select.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/** Scrollable viewer for a restored backup's content. */
export async function showBackupViewer(
  ctx: ExtensionCommandContext,
  content: string,
  file: string,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) => {
      const lines = content.split("\n");
      const pageSize = 40;
      let scroll = 0;
      const maxScroll = Math.max(0, lines.length - pageSize);
      return {
        render(width: number) {
          const output: string[] = [
            truncateToWidth(
              theme.fg("accent", theme.bold("  ↩ Restored backup")) +
                theme.fg(
                  "dim",
                  "  ·  " +
                    lines.length +
                    " lines · " +
                    Math.max(1, Math.round(content.length / 1_024)) +
                    "KB",
                ),
              width,
            ),
            truncateToWidth(theme.fg("dim", "  " + file), width),
            truncateToWidth(
              theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
              width,
            ),
          ];
          for (const line of lines.slice(scroll, scroll + pageSize)) {
            output.push(truncateToWidth(theme.fg("text", line), width));
          }
          if (lines.length > pageSize) {
            output.push(
              truncateToWidth(
                theme.fg(
                  "dim",
                  "  showing " +
                    (scroll + 1) +
                    "–" +
                    Math.min(lines.length, scroll + pageSize) +
                    " of " +
                    lines.length,
                ),
                width,
              ),
            );
          }
          output.push(
            "",
            truncateToWidth(
              theme.fg(
                "dim",
                "  ↑↓ scroll · pgup/pgdn · home/end · esc/q close",
              ),
              width,
            ),
          );
          return output;
        },
        invalidate() {},
        handleInput(data: string) {
          if (keybindings.matches(data, "tui.select.cancel") || data === "q") {
            done(undefined);
            return;
          }
          if (matchesKey(data, Key.home)) scroll = 0;
          else if (matchesKey(data, Key.end)) scroll = maxScroll;
          else if (keybindings.matches(data, "tui.select.pageUp"))
            scroll = Math.max(0, scroll - pageSize);
          else if (keybindings.matches(data, "tui.select.pageDown"))
            scroll = Math.min(maxScroll, scroll + pageSize);
          else if (keybindings.matches(data, "tui.select.up"))
            scroll = Math.max(0, scroll - 1);
          else if (keybindings.matches(data, "tui.select.down"))
            scroll = Math.min(maxScroll, scroll + 1);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { width: "85%", anchor: "center", maxHeight: "85%" },
    },
  );
}

/** Action menu after a backup is picked: view its content or restore it. */
export async function showRestoreAction(
  ctx: ExtensionCommandContext,
  backupPath: string,
): Promise<"view" | "restore" | null> {
  const items: SelectItem[] = [
    {
      value: "view",
      label: "View content",
      description: "Read the pre-compaction conversation",
    },
    {
      value: "restore",
      label: "Restore into a new session",
      description: "Fork from here + inject this backup as context",
    },
  ];
  return ctx.ui.custom<"view" | "restore" | null>(
    (tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(
        new DynamicBorder((value: string) => theme.fg("accent", value)),
      );
      container.addChild(
        new Text(theme.fg("accent", theme.bold("  ↩ Restore action")), 1, 0),
      );
      container.addChild(new Text(theme.fg("dim", "  " + backupPath), 0, 0));
      container.addChild(new Text("", 0, 0));
      const select = new SelectList(items, 2, {
        selectedPrefix: (value) => theme.fg("accent", value),
        selectedText: (value) => theme.fg("accent", value),
        description: (value) => theme.fg("muted", value),
        scrollInfo: (value) => theme.fg("dim", value),
        noMatch: (value) => theme.fg("warning", value),
      });
      select.onSelect = (item) => done(item.value as "view" | "restore");
      select.onCancel = () => done(null);
      container.addChild(select);
      container.addChild(new Text("", 0, 0));
      container.addChild(
        new Text(
          theme.fg("dim", "  ↑↓ navigate · enter select · esc cancel"),
          0,
          0,
        ),
      );
      container.addChild(
        new DynamicBorder((value: string) => theme.fg("accent", value)),
      );
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput(data: string) {
          select.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );
}
