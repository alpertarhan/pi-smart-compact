/**
 * Hand off to a new session from Home: note → preview → confirm. Nothing
 * opens until the last step; the session opens after the overlay has closed.
 */
import {
  ExtensionEditorComponent,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, SettingItem, TUI } from "@earendil-works/pi-tui";
import { handoffHeader, type PreparedHandoff } from "../app/session-handoff.ts";
import { errorDetail } from "../utils/issues.ts";
import { TextPanel } from "./home-overlay.ts";
import { Framed, type Screen, ScreenStack, TextArea } from "./navigation-overlay.ts";
import { SmartSettingsList } from "./settings-list.ts";

export interface HandoffPanelEnv {
  /** Receives the confirmed handoff; undefined when the user backed out. */
  close: (prepared?: PreparedHandoff) => void;
  requestRender: () => void;
  theme: Pick<Theme, "fg" | "bold">;
  tui: TUI;
  keybindings: KeybindingsManager;
}

/** `prepare` starts at the note field; `preview` shows a ready seed read-only (dry-run). */
export type HandoffPanelSource =
  | { prepare: (note: string | undefined) => Promise<PreparedHandoff | null> }
  | { preview: PreparedHandoff };

const NOTHING = "Nothing to hand off yet. Write a note, or mark this point first (Home › History & recovery › Session navigation).";

/** Build the panel. Exported for tests; `showHandoffPanel` is the UI entry. */
export function createHandoffPanel(source: HandoffPanelSource, env: HandoffPanelEnv): Component & Focusable {
  const { theme } = env;
  let confirmed: PreparedHandoff | undefined;
  const stack = new ScreenStack(
    () => [theme.fg("accent", theme.bold("Hand off to a new session")), ""],
    () => env.close(confirmed),
    env.requestRender,
  );

  const preview = (prepared: PreparedHandoff, readOnly: boolean): Screen => {
    const items: SettingItem[] = [
      readOnly
        ? { id: "back", label: "Close", currentValue: "", description: "Preview only; nothing opens. Run without dry-run to open the session." }
        : { id: "back", label: "Go back", currentValue: "", description: "Nothing has changed. Edit the note." },
      { id: "full", label: "Read the full seed", currentValue: "", description: "Scrollable view of the whole seed." },
      ...(readOnly ? [] : [{
        id: "open",
        label: "Open the new session",
        currentValue: "",
        description: "Closes Home and opens the new session now. This session is not modified.",
      }]),
    ];
    let screen: Screen;
    const list = new SmartSettingsList(items, 9, () => { }, () => stack.pop(screen), () => { }, new Set(), (id) => {
      if (id === "back") stack.pop(screen);
      else if (id === "full") {
        const full: Screen = new TextPanel(() => prepared.handoff.content.split("\n"), () => stack.pop(full));
        stack.push(full);
      } else if (id === "open") {
        confirmed = prepared;
        stack.closeAll();
      }
      return true;
    });
    screen = new Framed(() => [handoffHeader(prepared)], list);
    return screen;
  };

  if ("preview" in source) {
    stack.push(preview(source.preview, true));
    return stack;
  }

  const note: TextArea = new TextArea(
    (prefill, onSubmit) => new ExtensionEditorComponent(
      env.tui, env.keybindings, "Add a note for the next session", prefill, onSubmit, () => stack.pop(note),
      { description: "Optional. Enter continues; leave empty to skip. Esc goes back." },
    ),
    (value, field) => {
      field.setStatus(theme.fg("dim", "Collecting the seed…"), true);
      source.prepare(value.trim() || undefined).then((prepared) => {
        if (!prepared) return field.setStatus(theme.fg("warning", NOTHING));
        field.setStatus("");
        stack.push(preview(prepared, false));
      }, (error: unknown) => {
        field.setStatus(theme.fg("error", "Handoff failed: " + errorDetail(error)));
      }).finally(env.requestRender);
    },
  );
  stack.push(note);
  return stack;
}

/** Open the handoff panel; resolves with the confirmed handoff, which the caller opens after the overlay closed. */
export async function showHandoffPanel(ctx: ExtensionCommandContext, source: HandoffPanelSource): Promise<PreparedHandoff | undefined> {
  return ctx.ui.custom<PreparedHandoff | undefined>((tui, theme, keybindings, done) =>
    createHandoffPanel(source, { close: done, requestRender: () => tui.requestRender(), theme, tui, keybindings }));
}
