/**
 * The dashboard (account overview on top, a nested action menu below) and
 * the two account-list screens.
 *
 * - `s` or "Switch account" opens `SwitchScreen`: every account as a full card, Enter switches and goes back.
 * - `w`, "Watch accounts" or `cswap watch` opens `WatchScreen`: the same cards as a read-only monitor.
 *   `s` arms the selection, Enter switches and stays on the monitor, Esc disarms.
 * - "Remove account" opens a submenu with the accounts.
 */

import { Box, Text as InkText } from "ink";
import type { ReactNode } from "react";
import { type AccountSnapshot, type AccountsSnapshot, displayTag } from "../models.js";
import { LAYOUT } from "./theme.js";
import {
  ListRow,
  type RenderContext,
  Screen,
  type ScreenHost,
  Styled,
  accountCardText,
  accountsPanelText,
  binding,
} from "./widgets.js";

/** How long a just-refreshed row stays highlighted, in seconds. */
export const FLASH_S = 1.5;

/** `[label, actionId]` */
export type MenuEntry = readonly [label: string, actionId: string];
export type MenuEntries = MenuEntry[];

const BACK: MenuEntry = ["← back", "back"];

/** The part of the app that the dashboard screens use. `app.tsx` implements it. */
export interface DashboardHost extends ScreenHost {
  readonly themeName: string;
  readonly refreshStatus: string;
  readonly thresholdPct: number | null;
  pushScreen(screen: Screen<never>): void;
  readonly screen: Screen<never>;
  actionOpenWatch(): void;
  actionOpenAuto(): void;
  actionAddCurrent(): void;
  actionAddToken(): void;
  exit(code?: number): void;
  confirmRemove(number: string, email: string): void;
  applyTheme(name: string): void;
  notify(message: string, options?: { title?: string; severity?: string; timeout?: number }): void;
  doToggleDisabled(number: string): void;
  doSwitch(number: string): void;
}

function accountName(acc: AccountSnapshot): string {
  return acc.alias ? `${acc.alias} (${acc.email})` : acc.email;
}

/** The root menu. No "Refresh" entry: every view refreshes on its own, and `f` stays a hidden shortcut. */
export function rootEntries(): MenuEntries {
  return [
    ["Switch account…", "switch"],
    ["Watch accounts", "watch"],
    ["Auto-switch view", "auto"],
    ["Add account…", "add-menu"],
    ["Disable / enable account…", "disable-menu"],
    ["Remove account…", "remove-menu"],
    ["Theme…", "theme-menu"],
    ["Quit", "quit"],
  ];
}

export function addEntries(): MenuEntries {
  return [["From current Claude Code login", "add-login"], ["From a setup-token / API key…", "add-token"], BACK];
}

export function removeEntries(snap: AccountsSnapshot | null): MenuEntries {
  const entries: MenuEntries = (snap?.accounts ?? []).map((acc) => [
    `${acc.number}  ${accountName(acc)}  [${displayTag(acc)}]`,
    `remove:${acc.number}`,
  ]);
  entries.push(BACK);
  return entries;
}

/** One row for each account, with its state and the action that a selection does. */
export function disableEntries(snap: AccountsSnapshot | null): MenuEntries {
  const entries: MenuEntries = (snap?.accounts ?? []).map((acc) => {
    const action = acc.disabled ? "→ enable" : "→ disable";
    const state = acc.disabled ? "  (disabled)" : "";
    return [`${acc.number}  ${accountName(acc)}${state}   ${action}`, `disable:${acc.number}`];
  });
  entries.push(BACK);
  return entries;
}

/** dark, light and auto, with a mark on the current setting. */
export function themeEntries(current: string): MenuEntries {
  const entries: MenuEntries = (["dark", "light", "auto"] as const).map((name) => [
    `${name === current ? "●" : " "} ${name}`,
    `theme:${name}`,
  ]);
  entries.push(BACK);
  return entries;
}

export class DashboardScreen extends Screen<never> {
  readonly kind = "dashboard";
  declare app: DashboardHost;
  override bindings = [
    binding("s", "open_switch", "Switch accounts"),
    binding("w", "app.open_watch", "Watch"),
    binding("escape,left", "menu_back", "Back", { show: false }),
    binding("q", "app.quit", "Quit"),
    // Shortcuts for power users. The menu is the path that a user can discover.
    binding("g", "app.open_auto", "Auto view", { show: false }),
    binding("f", "app.refresh_full", "Refresh usage", { show: false }),
    binding("j", "cursor_down", "", { show: false }),
    binding("k", "cursor_up", "", { show: false }),
  ];
  /** The stack of `[title, entries]`. Depth 1 is the root menu. */
  menuStack: Array<[string, MenuEntries]> = [];
  menuIndex: number | null = 0;

  override onMount(): void {
    this.pushMenu("menu", rootEntries());
  }

  get menuEntries(): MenuEntries {
    return this.menuStack[this.menuStack.length - 1]?.[1] ?? [];
  }

  get crumb(): string {
    return this.menuStack.map(([title]) => title).join(" › ");
  }

  pushMenu(title: string, entries: MenuEntries): void {
    this.menuStack.push([title, entries]);
    this.menuIndex = entries.length ? 0 : null;
    this.app.changed();
  }

  popMenu(): void {
    if (this.menuStack.length > 1) {
      this.menuStack.pop();
      this.menuIndex = this.menuEntries.length ? 0 : null;
      this.app.changed();
    }
  }

  override onKey(name: string): boolean {
    if (name === "down") this.actionCursorDown();
    else if (name === "up") this.actionCursorUp();
    else if (name === "enter") {
      const entry = this.menuIndex === null ? undefined : this.menuEntries[this.menuIndex];
      if (entry) void this.dispatch(entry[1]);
    } else return false;
    return true;
  }

  async dispatch(actionId: string): Promise<void> {
    const app = this.app;
    const actions: Record<string, () => void> = {
      switch: () => this.actionOpenSwitch(),
      watch: () => app.actionOpenWatch(),
      auto: () => app.actionOpenAuto(),
      "add-login": () => app.actionAddCurrent(),
      "add-token": () => app.actionAddToken(),
      quit: () => app.exit(),
    };
    if (actionId === "back") {
      this.popMenu();
    } else if (actionId === "add-menu") {
      this.pushMenu("add account", addEntries());
    } else if (actionId === "remove-menu") {
      this.pushMenu("remove account", removeEntries(app.snapshot));
    } else if (actionId.startsWith("remove:")) {
      const number = actionId.slice("remove:".length);
      const email = app.snapshot?.accounts.find((a) => a.number === number)?.email ?? "?";
      app.confirmRemove(number, email);
    } else if (actionId === "theme-menu") {
      this.pushMenu("theme", themeEntries(app.themeName));
    } else if (actionId.startsWith("theme:")) {
      const name = actionId.slice("theme:".length);
      app.applyTheme(name);
      app.notify(`Theme: ${name}`);
      this.popMenu();
    } else if (actionId === "disable-menu") {
      this.pushMenu("disable / enable", disableEntries(app.snapshot));
    } else if (actionId.startsWith("disable:")) {
      app.doToggleDisabled(actionId.slice("disable:".length));
      this.popMenu();
    } else {
      actions[actionId]?.();
    }
  }

  actionOpenSwitch(): void {
    if (!(this.app.screen instanceof SwitchScreen)) this.app.pushScreen(new SwitchScreen());
  }

  actionMenuBack(): void {
    this.popMenu();
  }

  actionCursorDown(): void {
    const count = this.menuEntries.length;
    if (!count) return;
    this.menuIndex = this.menuIndex === null ? 0 : Math.min(count - 1, this.menuIndex + 1);
    this.app.changed();
  }

  actionCursorUp(): void {
    if (!this.menuEntries.length) return;
    this.menuIndex = this.menuIndex === null ? 0 : Math.max(0, this.menuIndex - 1);
    this.app.changed();
  }

  render({ columns, theme, palette, now }: RenderContext): ReactNode {
    const panelWidth = columns - 2 * LAYOUT.accountsPanel.paddingX - 2;
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box
          flexShrink={0}
          paddingY={LAYOUT.accountsPanel.paddingY}
          paddingX={LAYOUT.accountsPanel.paddingX}
          borderStyle="single"
          borderTop={false}
          borderLeft={false}
          borderRight={false}
          borderColor={theme.panel}
        >
          <Styled text={accountsPanelText(this.app.snapshot, panelWidth, { threshold: this.app.thresholdPct, now, palette })} />
        </Box>
        <Box flexShrink={0} marginTop={LAYOUT.menuTitle.marginTop} paddingX={LAYOUT.menuTitle.paddingX}>
          <InkText color={theme.secondary}>{this.crumb}</InkText>
        </Box>
        <Box
          flexDirection="column"
          flexGrow={1}
          overflowY="hidden"
          paddingTop={LAYOUT.list.paddingTop}
          paddingLeft={LAYOUT.list.paddingLeft}
          paddingRight={LAYOUT.list.paddingRight}
        >
          {this.menuEntries.map(([label, actionId], i) => (
            <ListRow key={`${actionId}-${i}`} highlighted={i === this.menuIndex} theme={theme}>
              <InkText color={actionId === "back" ? theme.secondary : theme.foreground} wrap="truncate-end">
                {label}
              </InkText>
            </ListRow>
          ))}
        </Box>
      </Box>
    );
  }
}

/** The scroll offset that keeps the row `index` (with these heights) inside a view of `available` lines. */
export function scrollToShow(heights: readonly number[], available: number, scrollY: number, index: number | null): number {
  const total = heights.reduce((a, b) => a + b, 0);
  let y = Math.max(0, Math.min(scrollY, total - available));
  if (index === null || index < 0 || index >= heights.length) return y;
  const top = heights.slice(0, index).reduce((a, b) => a + b, 0);
  const bottom = top + heights[index]!;
  if (top < y) y = top;
  else if (bottom > y + available) y = Math.max(0, bottom - available);
  return y;
}

/**
 * Shared code of the switch and watch screens: a live list of full account cards.
 * The subclass decides what the cursor does.
 */
export abstract class AccountListScreen extends Screen<never> {
  declare app: DashboardHost;
  numbers: string[] = [];
  accounts: readonly AccountSnapshot[] = [];
  stamps = new Map<string, number | null>();
  /** The cursor of the list, or null when the list has no cursor. */
  index: number | null = null;
  /** The numbers of the rows that flash after a new measurement. */
  flashing = new Set<string>();
  scrollY = 0;
  private flashTimers = new Set<NodeJS.Timeout>();

  abstract titleText(): string;

  override onMount(): void {
    this.onSnapshot(this.app.snapshot);
  }

  override onUnmount(): void {
    for (const timer of this.flashTimers) clearTimeout(timer);
    this.flashTimers.clear();
  }

  override onSnapshot(snap: AccountsSnapshot | null): void {
    if (snap === null) return;
    const numbers = snap.accounts.map((acc) => acc.number);
    if (numbers.join("\0") !== this.numbers.join("\0") || numbers.length !== this.numbers.length) {
      const firstBuild = this.numbers.length === 0;
      const previous = this.index;
      this.accounts = snap.accounts;
      this.numbers = numbers;
      this.index = numbers.length ? this.indexAfterBuild(snap, firstBuild, previous) : null;
    } else {
      this.accounts = snap.accounts;
    }
    this.flashUpdated(snap);
    this.app.changed();
  }

  /** Where the cursor goes after the list is built again. */
  indexAfterBuild(snap: AccountsSnapshot, firstBuild: boolean, previous: number | null): number | null {
    if (firstBuild) return this.activeIndex(snap);
    return Math.min(previous ?? 0, snap.accounts.length - 1);
  }

  activeIndex(snap: AccountsSnapshot): number {
    const i = snap.accounts.findIndex((acc) => acc.number === snap.activeNumber);
    return i < 0 ? 0 : i;
  }

  /** Highlight for a short time the rows whose stored measurement advanced. */
  flashUpdated(snap: AccountsSnapshot): void {
    const newStamps = new Map(snap.accounts.map((acc) => [acc.number, acc.usage.fetchedAt] as const));
    if (this.stamps.size) {
      for (const [number, ts] of newStamps) {
        if (ts === null || ts === this.stamps.get(number) || this.flashing.has(number)) continue;
        this.flashing.add(number);
        const timer = setTimeout(() => {
          this.flashTimers.delete(timer);
          this.flashing.delete(number);
          this.app.changed();
        }, FLASH_S * 1000);
        timer.unref?.();
        this.flashTimers.add(timer);
      }
    }
    this.stamps = newStamps;
  }

  actionCursorDown(): void {
    if (!this.accounts.length) return;
    this.index = this.index === null ? 0 : Math.min(this.accounts.length - 1, this.index + 1);
    this.app.changed();
  }

  actionCursorUp(): void {
    if (!this.accounts.length) return;
    this.index = this.index === null ? 0 : Math.max(0, this.index - 1);
    this.app.changed();
  }

  /** Enter on the list: the list posts a selection for the row under the cursor. */
  selectCursor(): void {
    if (this.index === null) return;
    const acc = this.accounts[this.index];
    if (acc) this.onSelected(acc.number);
  }

  abstract onSelected(number: string): void;

  static cardWidth(columns: number): number {
    return columns - LAYOUT.list.paddingLeft - LAYOUT.list.paddingRight - LAYOUT.listItem.markerWidth - 2 * LAYOUT.listItem.paddingX;
  }

  render({ columns, rows, theme, palette, now }: RenderContext): ReactNode {
    const width = AccountListScreen.cardWidth(columns);
    const cards = this.accounts.map((acc) => accountCardText(acc, width, { now, palette }));
    const heights = cards.map((card) => card.plain.split("\n").length + 1);
    const available = Math.max(1, rows - LAYOUT.listTitle.marginTop - 1 - LAYOUT.list.paddingTop - 1);
    this.scrollY = scrollToShow(heights, available, this.scrollY, this.index);
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box flexShrink={0} marginTop={LAYOUT.listTitle.marginTop} paddingX={LAYOUT.listTitle.paddingX}>
          <InkText color={theme.secondary} wrap="truncate-end">
            {this.titleText()}
          </InkText>
        </Box>
        <Box
          flexDirection="column"
          flexGrow={1}
          overflowY="hidden"
          contentOffsetY={this.scrollY}
          paddingTop={LAYOUT.list.paddingTop}
          paddingLeft={LAYOUT.list.paddingLeft}
          paddingRight={LAYOUT.list.paddingRight}
        >
          <Box flexDirection="column" flexShrink={0}>
            {cards.map((card, i) => (
              <ListRow
                key={this.accounts[i]!.number}
                highlighted={i === this.index}
                flash={this.flashing.has(this.accounts[i]!.number)}
                theme={theme}
                marginBottom={1}
              >
                <Styled text={card} />
              </ListRow>
            ))}
          </Box>
        </Box>
      </Box>
    );
  }
}

/** Every account as a full live card: the arrows pick, Enter switches. */
export class SwitchScreen extends AccountListScreen {
  readonly kind = "switch";
  override bindings = [
    binding("enter", "select_highlighted", "Switch"),
    binding("b", "app.switch_best", "Best pick"),
    binding("escape,q,s", "back", "Back"),
    binding("j", "cursor_down", "", { show: false }),
    binding("k", "cursor_up", "", { show: false }),
  ];

  titleText(): string {
    return "switch to which account?";
  }

  override onKey(name: string): boolean {
    if (name === "down") this.actionCursorDown();
    else if (name === "up") this.actionCursorUp();
    else return false;
    return true;
  }

  onSelected(number: string): void {
    this.app.doSwitch(number);
    this.app.popScreen();
  }

  actionSelectHighlighted(): void {
    this.selectCursor();
  }

  actionBack(): void {
    this.app.popScreen();
  }
}

/**
 * A live monitor of every account, read-only by default.
 * `s` arms the selection on the active account. Enter switches and stays here. Esc disarms first, then leaves.
 */
export class WatchScreen extends AccountListScreen {
  readonly kind = "watch";
  static readonly WATCH_TITLE = "watching all accounts";
  static readonly SELECT_TITLE = "switch to which account? · enter confirm · esc cancel";
  override bindings = [
    binding("s", "toggle_select", "Switch"),
    binding("enter", "select_highlighted", "Confirm"),
    binding("f", "app.refresh_full", "Refresh", { show: false }),
    binding("escape,q", "back", "Back"),
    binding("down,j", "nav_down", "", { show: false }),
    binding("up,k", "nav_up", "", { show: false }),
  ];
  selecting = false;

  titleText(): string {
    if (this.selecting) return WatchScreen.SELECT_TITLE;
    const status = this.app.refreshStatus;
    return status ? `${WatchScreen.WATCH_TITLE} · ${status}` : WatchScreen.WATCH_TITLE;
  }

  override checkAction(action: string): boolean {
    // Enter stays hidden and inert until the selection is armed.
    return !(action === "select_highlighted" && !this.selecting);
  }

  override indexAfterBuild(snap: AccountsSnapshot, firstBuild: boolean, previous: number | null): number | null {
    if (!this.selecting) return null;
    return super.indexAfterBuild(snap, firstBuild, previous);
  }

  setSelecting(on: boolean): void {
    this.selecting = on;
    if (on) {
      const snap = this.app.snapshot;
      if (snap !== null && snap.accounts.length) this.index = this.activeIndex(snap);
    } else {
      this.index = null;
    }
    this.app.changed();
  }

  actionToggleSelect(): void {
    this.setSelecting(!this.selecting);
  }

  onSelected(number: string): void {
    if (!this.selecting) return;
    this.app.doSwitch(number);
    this.setSelecting(false);
  }

  actionSelectHighlighted(): void {
    if (this.selecting) this.selectCursor();
  }

  actionBack(): void {
    if (this.selecting) this.setSelecting(false);
    else this.app.popScreen();
  }

  actionNavDown(): void {
    if (this.selecting) this.actionCursorDown();
    else {
      this.scrollY += 1;
      this.app.changed();
    }
  }

  actionNavUp(): void {
    if (this.selecting) this.actionCursorUp();
    else {
      this.scrollY = Math.max(0, this.scrollY - 1);
      this.app.changed();
    }
  }
}

