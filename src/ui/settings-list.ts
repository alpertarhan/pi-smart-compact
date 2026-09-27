/**
 * SettingsList with a per-row reset key and dimmed inactive rows.
 *
 * `r` resets the selected row to its default only when this list itself has
 * focus; while a submenu or inline editor is open the key is passed through,
 * so typing "r" into a number/text field never resets anything.
 */
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
 getKeybindings,
 type SettingItem,
 SettingsList,
 type SettingsListTheme,
 truncateToWidth,
 visibleWidth,
 wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Shown in the value column so inactive rows do not widen the label column. */
export const INACTIVE_PREFIX = "inactive · ";
export const CHANGED_MARK = " •";

interface SettingsListInternals {
 submenuComponent: unknown;
 selectedIndex: number;
 items: SettingItem[];
}

/**
 * Read SettingsList's private selection/submenu state, or null when the
 * installed pi-tui no longer has that shape (then reset is simply disabled).
 */
function internalsOf(list: SettingsList): SettingsListInternals | null {
 // SAFETY: pi-tui's SettingsList keeps `items`, `selectedIndex` and
 // `submenuComponent` as private instance fields (settings-list.d.ts). The
 // runtime checks below verify that shape before any field is used, and
 // test/settings-tui.test.ts fails if a pi-tui update renames them.
 const raw = list as unknown as Record<string, unknown>;
 if (!Array.isArray(raw.items) || typeof raw.selectedIndex !== "number" || !("submenuComponent" in raw)) {
  return null;
 }
 return {
  items: raw.items as SettingItem[],
  selectedIndex: raw.selectedIndex,
  submenuComponent: raw.submenuComponent,
 };
}

function smartTheme(): SettingsListTheme {
 const base = getSettingsListTheme();
 return {
  ...base,
  value: (text, selected) =>
   text.startsWith(INACTIVE_PREFIX) ? base.hint(text) : base.value(text, selected),
 };
}

export class SmartSettingsList extends SettingsList {
 constructor(
  items: SettingItem[],
  maxVisible: number,
  onChange: (id: string, value: string) => void,
  onCancel: () => void,
  private readonly onReset: (id: string) => void = () => { },
  /** Ids of rows that currently have no effect; kept live by the owner. */
  private readonly inactive: ReadonlySet<string> = new Set(),
  /**
   * Called on Enter/Space before the default action; return true to consume
   * it (action rows, rows that are blocked with a visible reason).
   */
  private readonly onActivate?: (id: string) => boolean,
 ) {
  super(items, maxVisible, smartTheme(), onChange, onCancel);
 }

 /** Keep values readable on narrow screens; display shortening never reaches storage. */
 override render(width: number): string[] {
  const internals = internalsOf(this);
  if (!internals || internals.submenuComponent || !internals.items.length) return super.render(width);
  const labelWidth = Math.min(36, Math.max(8, Math.floor(width * 0.55)),
   Math.max(...internals.items.map((item) => visibleWidth(item.label))));
  const valueWidth = Math.max(0, width - labelWidth - 6);
  const saved = internals.items.map(({ label, currentValue, description }) => ({ label, currentValue, description }));
  try {
   internals.items.forEach((item, index) => {
    const original = saved[index]!;
    const shown = (this.inactive.has(item.id) ? INACTIVE_PREFIX : "") + original.currentValue;
    item.label = truncateToWidth(original.label, labelWidth, "…");
    item.currentValue = truncateToWidth(shown, valueWidth, "…");
    if (index === internals.selectedIndex) {
     item.description = [
      item.label !== original.label ? original.label : "",
      visibleWidth(shown) > valueWidth ? "Current: " + shown : "",
      original.description ?? "",
     ].filter(Boolean).join("\n");
    }
   });
   const lines = super.render(width);
   // The native list appends its keyboard hint after the selected-row help.
   lines.splice(-1, 1, ...wrapTextWithAnsi(getSettingsListTheme().hint("  ↑↓ choose · Enter select · Esc back"), Math.max(1, width)));
   return lines;
  } finally {
   internals.items.forEach((item, index) => Object.assign(item, saved[index]));
  }
 }

 /** Id of the highlighted row, or undefined when the list is empty. */
 selectedId(): string | undefined {
  const internals = internalsOf(this);
  return internals?.items[internals.selectedIndex]?.id;
 }

 override handleInput(data: string): void {
  const internals = internalsOf(this);
  if (this.onActivate && internals && !internals.submenuComponent &&
   (getKeybindings().matches(data, "tui.select.confirm") || data === " ")) {
   const id = this.selectedId();
   if (id && this.onActivate(id)) return;
  }
  if ((data === "r" || data === "R") && internals && !internals.submenuComponent) {
   const id = this.selectedId();
   if (id) this.onReset(id);
   return;
  }
  super.handleInput(data);
 }
}
