/**
 * Human session navigation: browse anchors, mark this point, search earlier
 * sessions, and return to an anchor after inspecting it.
 *
 * Every mutation (create, pivot) needs explicit input and an Enter on the
 * final step; Esc on any screen goes back one step and changes nothing. A
 * confirmed pivot runs after the panel has closed, so the session tree is
 * never navigated underneath an open overlay.
 */
import {
  ExtensionEditorComponent,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  Input,
  type SettingItem,
  Text,
  type TUI,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  AnchorRecallHit,
  AnchorRecallPage,
  AnchorRecord,
  NavigationPanelActions,
} from "../app/navigation-types.ts";
import { TextPanel } from "./home-overlay.ts";
import { SmartSettingsList } from "./settings-list.ts";

const PAGE_SIZE = 8;
// Summaries can be long; rows and confirmation show a readable excerpt.
const ROW_CHARS = 240;
const DETAIL_CHARS = 600;

/** Runs after the overlay has closed; showNavigationPanel awaits it. */
export type DeferredNavigation = () => Promise<void>;

export interface NavigationPanelEnv {
  close: (after?: DeferredNavigation) => void;
  requestRender: () => void;
  notify: (message: string, type: "info" | "error") => void;
  theme: Pick<Theme, "fg" | "bold">;
  /** Needed by Pi's multi-line editor used for summaries, carryover and messages. */
  tui: TUI;
  keybindings: KeybindingsManager;
}

type Screen = Component & {
  focused?: boolean;
  /** Called when the screen leaves the stack (Esc, replacement or close). */
  dispose?: () => void;
  /** Called when the screen is on top again after the one above it closed. */
  reveal?: () => void;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

function when(timestamp: string): string {
  return timestamp.slice(0, 16).replace("T", " ");
}

class ScreenStack implements Component, Focusable {
  private readonly screens: Screen[] = [];
  private active = false;

  constructor(
    private readonly header: () => string[],
    private readonly onEmpty: () => void,
    private readonly requestRender: () => void,
  ) { }

  get focused(): boolean {
    return this.active;
  }

  set focused(value: boolean) {
    this.active = value;
    this.syncFocus();
  }

  private syncFocus(): void {
    const top = this.screens.length - 1;
    this.screens.forEach((screen, index) => {
      if (typeof screen.focused === "boolean") screen.focused = this.active && index === top;
    });
  }

  has(screen: Screen): boolean {
    return this.screens.includes(screen);
  }

  push(screen: Screen): void {
    this.screens.push(screen);
    this.syncFocus();
    this.requestRender();
  }

  /** Close `screen` and everything opened from it. */
  pop(screen: Screen | undefined = this.screens.at(-1)): void {
    const index = screen ? this.screens.indexOf(screen) : -1;
    if (index < 0) return;
    for (const closed of this.screens.splice(index).reverse()) closed.dispose?.();
    this.syncFocus();
    if (!this.screens.length) this.onEmpty();
    else this.screens.at(-1)!.reveal?.();
    this.requestRender();
  }

  /** Swap an open screen in place (paging, finished loading). */
  replace(current: Screen, next: Screen): void {
    const index = this.screens.indexOf(current);
    if (index < 0) return;
    current.dispose?.();
    this.screens[index] = next;
    this.syncFocus();
    this.requestRender();
  }

  closeAll(): void {
    this.pop(this.screens[0]);
  }

  render(width: number): string[] {
    return [...this.header(), ...(this.screens.at(-1)?.render(width) ?? [])];
  }

  handleInput(data: string): void {
    this.screens.at(-1)?.handleInput?.(data);
    this.syncFocus();
    this.requestRender();
  }

  invalidate(): void {
    for (const screen of this.screens) screen.invalidate();
  }
}

/** Wrapped context lines above a list; input goes to the list. */
class Framed implements Component {
  constructor(private readonly lines: () => string[], private readonly body: SmartSettingsList) { }
  render(width: number): string[] {
    const text = this.lines().flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
    return [...text, "", ...this.body.render(width)];
  }
  handleInput(data: string): void {
    this.body.handleInput(data);
  }
  invalidate(): void {
    this.body.invalidate();
  }
}

/** One-line field for names and search words. Enter submits (the owner validates), Esc goes back unless saving. */
class Prompt extends Container implements Focusable {
  private readonly input: Input;
  private readonly status = new Text("", 0, 0);
  private busy = false;

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  constructor(
    lines: string[],
    hint: string,
    submit: (value: string, prompt: Prompt) => void,
    cancel: () => void,
    initial = "",
  ) {
    super();
    this.input = new Input();
    for (const line of lines) this.addChild(new Text(line, 0, 0));
    this.addChild(new Text("", 0, 0));
    this.input.setValue(initial);
    this.input.handleInput("\x1b[F");
    this.input.onSubmit = (value) => {
      if (!this.busy) submit(value, this);
    };
    this.input.onEscape = () => {
      if (!this.busy) cancel();
    };
    this.addChild(this.input);
    this.addChild(new Text("", 0, 0));
    this.addChild(this.status);
    this.addChild(new Text(hint, 0, 0));
  }

  setStatus(text: string, busy = false): void {
    this.status.setText(text);
    this.busy = busy;
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }
}

/**
 * Multi-line field: Pi's own extension editor (the one behind ctx.ui.editor),
 * so Enter submits, the newline key (Shift+Enter / Ctrl+J) adds lines, Esc
 * goes back and Ctrl+G opens the external editor, with Pi's own key hints.
 * Pi's editor clears itself on submit; the field reopens it with the
 * submitted text so going back or a failed save never loses what was typed.
 */
class TextArea implements Component, Focusable {
  private editor: ExtensionEditorComponent;
  private readonly status = new Text("", 0, 0);
  private busy = false;
  private active = false;

  constructor(
    private readonly open: (prefill: string, submit: (value: string) => void) => ExtensionEditorComponent,
    private readonly submit: (value: string, field: TextArea) => void,
  ) {
    this.editor = this.reopen("");
  }

  private reopen(prefill: string): ExtensionEditorComponent {
    const editor = this.open(prefill, (value) => {
      this.editor = this.reopen(value);
      this.submit(value, this);
    });
    editor.focused = this.active;
    return editor;
  }

  get focused(): boolean {
    return this.active;
  }

  set focused(value: boolean) {
    this.active = value;
    this.editor.focused = value;
  }

  setStatus(text: string, busy = false): void {
    this.status.setText(text);
    this.busy = busy;
  }

  render(width: number): string[] {
    return [...this.editor.render(width), ...this.status.render(width)];
  }

  handleInput(data: string): void {
    if (!this.busy) this.editor.handleInput(data);
  }

  invalidate(): void {
    this.editor.invalidate();
  }
}

/**
 * Build the panel. Exported for tests; `showNavigationPanel` is the UI entry.
 * `env.close` receives the confirmed pivot, which must run after the overlay closes.
 */
export function createNavigationPanel(actions: NavigationPanelActions, env: NavigationPanelEnv): Component & Focusable {
  const { theme } = env;
  const dim = (text: string) => theme.fg("dim", text);
  const bold = (text: string) => theme.bold(text);
  const warn = (text: string) => theme.fg("warning", text);
  const fail = (text: string) => theme.fg("error", text);
  let deferred: DeferredNavigation | undefined;
  const stack = new ScreenStack(
    () => [theme.fg("accent", bold("Session navigation")), ""],
    () => env.close(deferred),
    env.requestRender,
  );

  /** A list whose Esc closes the owning screen; `activate` returns true to consume Enter. */
  const menu = (
    items: SettingItem[],
    activate: (id: string) => boolean,
    cancel: () => void,
    inactive: ReadonlySet<string> = new Set(),
    onChange: (id: string, value: string) => void = () => { },
  ) => new SmartSettingsList(items, 9, onChange, cancel, () => { }, inactive, activate);

  const prompt = (
    lines: string[],
    submit: (value: string, prompt: Prompt) => void,
    initial = "",
  ): Prompt => {
    const screen: Prompt = new Prompt(lines, dim("Enter continue · Esc back"), submit, () => stack.pop(screen), initial);
    return screen;
  };

  const textArea = (title: string, description: string, submit: (value: string, field: TextArea) => void): TextArea => {
    const field: TextArea = new TextArea(
      (prefill, onSubmit) => new ExtensionEditorComponent(
        env.tui, env.keybindings, title, prefill, onSubmit, () => stack.pop(field), { description },
      ),
      submit,
    );
    return field;
  };

  const textScreen = (lines: () => string[]): Screen => {
    const screen: Screen = new TextPanel(lines, () => stack.pop(screen));
    return screen;
  };

  const pageRows = (offset: number, shown: number, total: number, nextOffset: number | null): SettingItem[] => {
    const range = `${offset + 1}–${offset + shown} of ${total}`;
    return [
      ...(offset > 0 ? [{ id: "prev", label: "Previous page", currentValue: range, description: "Show the previous " + PAGE_SIZE + "." }] : []),
      ...(nextOffset !== null ? [{ id: "next", label: "Next page", currentValue: range, description: "Show the next " + PAGE_SIZE + "." }] : []),
    ];
  };

  // ── Return to an anchor: inspect → carryover → optional message → confirm ──

  const confirmPivot = (anchor: AnchorRecord, carryover: string, message: string | undefined): Screen => {
    const items: SettingItem[] = [
      { id: "back", label: "Go back", currentValue: "", description: "Nothing has changed. Edit the message or carryover." },
      {
        id: "confirm",
        label: "Return to this anchor",
        currentValue: "",
        description: "Closes this panel and moves the conversation now.",
      },
    ];
    let screen: Screen;
    const list = menu(items, (id) => {
      if (id === "back") {
        stack.pop(screen);
        return true;
      }
      deferred = async () => {
        try {
          const result = await actions.pivot(anchor.id, carryover, message);
          env.notify(result.message, result.ok ? "info" : "error");
        } catch (error) {
          env.notify("Return to anchor failed: " + errorText(error), "error");
        }
      };
      stack.closeAll();
      return true;
    }, () => stack.pop(screen));
    screen = new Framed(() => [
      bold("Return to " + anchor.data.name + "?"),
      "",
      bold("Carry over"),
      clip(carryover, DETAIL_CHARS),
      "",
      bold("Then send"),
      message === undefined ? dim("Nothing; you write the next message.") : clip(message, DETAIL_CHARS),
      "",
      warn("Only the conversation moves. Files, running processes and anything else changed since this anchor stay as they are; nothing is rolled back."),
      dim("The conversation since then stays saved on its own branch."),
    ], list);
    return screen;
  };

  const startPivot = (anchor: AnchorRecord) => {
    stack.push(textArea(
      "What should carry over?",
      "Required. Facts, decisions and next steps to keep when the conversation returns to " + anchor.data.name + ".",
      (carryover, carry) => {
        if (!carryover) return carry.setStatus(warn("Write what to carry over first."));
        carry.setStatus("");
        stack.push(textArea(
          "Message after returning",
          "Optional. Sent as your next message once the conversation has moved. Leave empty to write it yourself.",
          (message) => stack.push(confirmPivot(anchor, carryover, message || undefined)),
        ));
      },
    ));
  };

  const anchorDetail = (anchor: AnchorRecord): Screen => {
    const availability = actions.availability();
    const blocked = !availability.pivot
      ? "Return to an anchor is off in Settings › Agent tools & navigation."
      : availability.mutationBlocked;
    const inactive = new Set(blocked ? ["pivot"] : []);
    const items: SettingItem[] = [{
      id: "pivot",
      label: "Return to this anchor",
      currentValue: !availability.pivot ? "off" : blocked ? "unavailable" : "",
      description: blocked ?? "Continue from this point on a new branch. You write what to carry over next; nothing changes until you confirm.",
    }];
    const clipped = clip(anchor.data.summary, DETAIL_CHARS);
    if (clipped !== anchor.data.summary) {
      items.push({ id: "full", label: "Read full summary", currentValue: "", description: "Scrollable view of the whole summary." });
    }
    let screen: Screen;
    const list = menu(items, (id) => {
      if (id === "pivot" && !blocked) startPivot(anchor);
      else if (id === "full") stack.push(textScreen(() => [bold(anchor.data.name), "", ...anchor.data.summary.split("\n")]));
      return true;
    }, () => stack.pop(screen), inactive);
    screen = new Framed(() => [
      bold(anchor.data.name),
      dim("Saved " + when(anchor.timestamp) + (anchor.onBranch ? ", on this branch" : ", on another branch")),
      "",
      clipped,
    ], list);
    return screen;
  };

  const anchorBrowser = (keyword: string, offset: number): Screen => {
    const page = actions.list({ ...(keyword ? { keyword } : {}), limit: PAGE_SIZE, offset });
    const items: SettingItem[] = [{
      id: "filter",
      label: "Filter",
      currentValue: keyword || "none",
      description: "Show only anchors whose name or summary contains these words.",
    }];
    page.anchors.forEach((anchor, index) => items.push({
      id: "anchor:" + index,
      label: anchor.data.name,
      currentValue: anchor.onBranch ? "this branch" : "other branch",
      description: clip(anchor.data.summary, ROW_CHARS),
    }));
    if (!page.anchors.length) {
      items.push({
        id: "empty",
        label: keyword ? "No matching anchors" : "No anchors yet",
        currentValue: "",
        description: keyword ? "Change or clear the filter." : "Use Mark this point to save one.",
      });
    }
    items.push(...pageRows(offset, page.anchors.length, page.total, page.nextOffset));
    const list: Screen = menu(items, (id) => {
      if (id === "filter") {
        stack.push(prompt([bold("Filter anchors"), dim("Words to match in names and summaries. Leave empty to show all.")], (value, filter) => {
          stack.pop(filter);
          stack.replace(list, anchorBrowser(value.trim(), 0));
        }, keyword));
      } else if (id === "prev") stack.replace(list, anchorBrowser(keyword, Math.max(0, offset - PAGE_SIZE)));
      else if (id === "next" && page.nextOffset !== null) stack.replace(list, anchorBrowser(keyword, page.nextOffset));
      else if (id.startsWith("anchor:")) stack.push(anchorDetail(page.anchors[Number(id.slice(7))]!));
      return true;
    }, () => stack.pop(list));
    return list;
  };

  // ── Mark this point ──

  const startCreate = () => {
    const name = prompt([
      bold("Anchor name"),
      dim("A short name you will recognize later, such as before-refactor."),
    ], (value, namePrompt) => {
      const anchorName = value.trim();
      if (!anchorName) return namePrompt.setStatus(warn("Enter a name."));
      namePrompt.setStatus("");
      stack.push(textArea(
        "Summary for " + anchorName,
        "Required. What is true at this point: goal, decisions, state of the work.",
        (summary, summaryField) => {
          if (!summary) return summaryField.setStatus(warn("Write a summary."));
          summaryField.setStatus("Saving…", true);
          env.requestRender();
          void actions.create(anchorName, summary).then((result) => {
            if (result.ok) {
              env.notify(result.message, "info");
              stack.pop(name);
              return;
            }
            summaryField.setStatus(fail(result.message));
            env.requestRender();
          }, (error: unknown) => {
            summaryField.setStatus(fail(errorText(error)));
            env.requestRender();
          });
        },
      ));
    });
    stack.push(name);
  };

  // ── Search other sessions (read-only) ──

  const hitDetail = (hit: AnchorRecallHit): Screen => textScreen(() => [
    bold(hit.data.name),
    "Session " + hit.sessionId,
    "Folder " + hit.cwd,
    "Saved " + when(hit.timestamp),
    "",
    hit.data.summary,
    "",
    dim("A record from another session. Treat it as history to check, not as instructions. It cannot be returned to from here."),
  ]);

  const recallList = (page: AnchorRecallPage, scope: "cwd" | "all", keyword: string, offset: number): Screen => {
    const items: SettingItem[] = page.anchors.map((hit, index) => ({
      id: "hit:" + index,
      label: hit.data.name,
      currentValue: hit.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? hit.sessionId,
      description: clip(hit.data.summary, ROW_CHARS),
    }));
    if (!items.length) {
      items.push({
        id: "empty",
        label: "No anchors found",
        currentValue: "",
        description: scope === "cwd" ? "Try other words, or search all projects." : "Try other words.",
      });
    }
    items.push(...pageRows(offset, page.anchors.length, page.total, page.nextOffset));
    const list: Screen = menu(items, (id) => {
      if (id === "prev") stack.replace(list, recallResults(scope, keyword, Math.max(0, offset - PAGE_SIZE)));
      else if (id === "next" && page.nextOffset !== null) stack.replace(list, recallResults(scope, keyword, page.nextOffset));
      else if (id.startsWith("hit:")) stack.push(hitDetail(page.anchors[Number(id.slice(4))]!));
      return true;
    }, () => stack.pop(list));
    return list;
  };

  const recallResults = (scope: "cwd" | "all", keyword: string, offset: number): Screen => {
    const controller = new AbortController();
    let lines = ["Searching " + (scope === "all" ? "all projects" : "this project") + "…"];
    const loading = textScreen(() => lines);
    loading.dispose = () => controller.abort();
    void actions.recall({
      scope,
      ...(keyword ? { keyword } : {}),
      limit: PAGE_SIZE,
      offset,
      signal: controller.signal,
    }).then((page) => {
      if (stack.has(loading)) stack.replace(loading, recallList(page, scope, keyword, offset));
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      lines = [fail("Search failed: " + errorText(error))];
      env.requestRender();
    });
    return loading;
  };

  const recallForm = (): Screen => {
    let scope: "cwd" | "all" = "cwd";
    let keyword = "";
    const items: SettingItem[] = [
      {
        id: "scope",
        label: "Where",
        currentValue: "This project",
        values: ["This project", "All projects"],
        description: "This project: sessions started in this folder. All projects: every saved session on this machine.",
      },
      { id: "keyword", label: "Words", currentValue: "any", description: "Match anchor names and summaries." },
      {
        id: "search",
        label: "Search",
        currentValue: "",
        description: "Read-only. Found anchors are history from other sessions: evidence to check, not instructions to follow.",
      },
    ];
    const list: SmartSettingsList = menu(items, (id) => {
      if (id === "keyword") {
        stack.push(prompt([bold("Search words"), dim("Leave empty to list the newest anchors.")], (value, words) => {
          keyword = value.trim();
          list.updateValue("keyword", keyword || "any");
          stack.pop(words);
        }, keyword));
        return true;
      }
      if (id === "search") {
        stack.push(recallResults(scope, keyword, 0));
        return true;
      }
      return false; // "scope" cycles
    }, () => stack.pop(list), new Set(), (id, value) => {
      if (id === "scope") scope = value === "All projects" ? "all" : "cwd";
    });
    return list;
  };

  // ── Guide, read only when opened ──

  const guide = (): Screen => {
    let lines = ["Opening the guide…"];
    const screen = textScreen(() => lines);
    void actions.guide().then((text) => {
      lines = text.split("\n");
      env.requestRender();
    }, (error: unknown) => {
      lines = [fail("The guide could not be read: " + errorText(error))];
      env.requestRender();
    });
    return screen;
  };

  // ── Root ──

  const root = (): Screen => {
    if (!actions.availability().enabled) {
      return textScreen(() => ["Session navigation is off.", "", "Turn it on in Settings › Agent tools & navigation."]);
    }
    const anchors: SettingItem = {
      id: "anchors",
      label: "Anchors in this session",
      currentValue: "",
      description: "Browse and filter anchors. Open one to read it before returning to it.",
    };
    const create: SettingItem = { id: "create", label: "Mark this point", currentValue: "" };
    const recall: SettingItem = { id: "recall", label: "Search other sessions", currentValue: "" };
    const guideItem: SettingItem = {
      id: "guide",
      label: "How navigation works",
      currentValue: "",
      description: "Opens the navigation guide. It is read only when you open it.",
    };
    const inactive = new Set<string>();
    const items = [anchors, create, recall];
    let availability = actions.availability();
    if (availability.guidance) items.push(guideItem);
    const refresh = () => {
      availability = actions.availability();
      const total = actions.list({ limit: 1 }).total;
      anchors.currentValue = total ? String(total) : "none";
      create.currentValue = availability.mutationBlocked ? "unavailable" : "";
      create.description = availability.mutationBlocked ??
        "Save a named anchor here with your own summary, to find or return to this point later.";
      recall.currentValue = availability.recall ? "" : "off";
      recall.description = availability.recall
        ? "Read-only search of anchors saved in earlier sessions, this project first."
        : "Search other sessions is off in Settings › Agent tools & navigation.";
      if (availability.mutationBlocked) inactive.add("create");
      else inactive.delete("create");
      if (availability.recall) inactive.delete("recall");
      else inactive.add("recall");
    };
    refresh();
    const list: Screen = menu(items, (id) => {
      if (id === "anchors") stack.push(anchorBrowser("", 0));
      else if (id === "create" && !availability.mutationBlocked) startCreate();
      else if (id === "recall" && availability.recall) stack.push(recallForm());
      else if (id === "guide") stack.push(guide());
      return true; // blocked rows keep their reason visible
    }, () => stack.pop(list), inactive);
    list.reveal = refresh;
    return list;
  };

  stack.push(root());
  return stack;
}

/** Open the session navigation panel; a confirmed pivot runs after it closes. */
export async function showNavigationPanel(ctx: ExtensionCommandContext, actions: NavigationPanelActions): Promise<void> {
  const after = await ctx.ui.custom<DeferredNavigation | undefined>((tui, theme, keybindings, done) =>
    createNavigationPanel(actions, {
      close: done,
      requestRender: () => tui.requestRender(),
      notify: (message, type) => ctx.ui.notify(message, type),
      theme,
      tui,
      keybindings,
    }));
  await after?.();
}
