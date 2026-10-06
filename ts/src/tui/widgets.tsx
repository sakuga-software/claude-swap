/**
 * Shared render code: usage bars, account cards, the accounts panel, the
 * screen base class, key names and the small Ink building blocks.
 *
 * The bars are custom renderers because the design needs a severity color
 * ramp, an optional threshold tick and a dim style for old measurements.
 */

import { Box, Text as InkText, type Key } from "ink";
import type { ReactNode } from "react";
import { USAGE_API_KEY } from "../json_output.js";
import { type AccountSnapshot, type AccountsSnapshot, displayTag } from "../models.js";
import * as pace from "../pace.js";
import { Text, parseStyle } from "../support/rich_text.js";
import { ljust, pyFixed, pyGroupedFixed, pyLen, rjust } from "../support/pyformat.js";
import { ERROR_NOTES } from "../switcher/display.js";
import { STALE_OK_S } from "../usage_store.js";
import * as data from "./data.js";
import { LAYOUT, Palette, type Theme } from "./theme.js";

export { Text };

const BAR_FILLED = "━";
const BAR_HALF = "╸";
const BAR_EMPTY = "─";
const BAR_TICK = "┃";

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return Number(value);
}

export interface BarOptions {
  stale?: boolean;
  threshold?: number | null;
  palette?: Palette;
}

/** The bar glyphs only: a fill in the severity color, the track and an optional tick. */
export function barCells(
  pct: number | null,
  width: number,
  { stale = false, threshold = null, palette = Palette.DARK }: BarOptions = {},
): Text {
  const text = new Text();
  if (pct === null) {
    text.append(BAR_EMPTY.repeat(width), palette.track);
    return text;
  }
  const frac = Math.min(Math.max(pct, 0.0), 100.0) / 100.0;
  const cells = frac * width;
  const full = Math.trunc(cells);
  const half = cells - full >= 0.5 && full < width;
  let tickAt: number | null = null;
  if (threshold !== null) tickAt = Math.min(width - 1, Math.max(0, pyRound((threshold / 100.0) * width)));
  const color = palette.severity(pct);
  const fillStyle = stale ? `${color} dim` : color;
  for (let i = 0; i < width; i++) {
    if (tickAt !== null && i === tickAt) text.append(BAR_TICK, palette.sevWarn);
    else if (i < full) text.append(BAR_FILLED, fillStyle);
    else if (i === full && half) text.append(BAR_HALF, fillStyle);
    else text.append(BAR_EMPTY, palette.track);
  }
  return text;
}

/** Python `round()`: an exact tie rounds to the even integer. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff === 0.5) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(x);
}

/** One full bar line: `5h ━━━━╸────┃──  47%  resets 2h 13m · 20:39`. */
export function usageBar(
  label: string,
  pct: number | null,
  suffix: string | null,
  width: number,
  { stale = false, threshold = null, palette = Palette.DARK }: BarOptions = {},
): Text {
  const text = new Text();
  text.append(`${label} `, palette.muted);
  text.append(barCells(pct, width, { stale, threshold, palette }));
  if (pct === null) {
    text.append("  usage unknown", palette.muted);
  } else {
    const color = palette.severity(pct);
    text.append(` ${rjust(pyFixed(pct, 0), 3)}%`, stale ? `${color} dim` : color);
  }
  if (suffix) text.append(`  ${suffix}`, palette.muted);
  return text;
}

/** The countdown suffix of one window, and the same suffix with the local clock time. */
function resetParts(window: unknown, now: number): [string | null, string | null] {
  const reset = data.resetText(window, now);
  if (!reset) return [null, null];
  const clock = data.resetClock(window, now);
  return [reset, clock ? `${reset} · ${clock}` : reset];
}

function paceSuffix(window: unknown, fetchedAt: number | null): string {
  const result = pace.computePace(window, { fetchedAt });
  return result && result.ahead ? "(ahead of pace)" : "";
}

/** `[label, pct, suffix, suffixFull]` */
export type UsageRow = [label: string, pct: number, suffix: string, suffixFull: string];

function withMarker(suffix: string, marker: string): string {
  return suffix ? `${suffix}  ${marker}` : marker;
}

/**
 * The rows of an account card, with the semantics of the CLI `formatUsageLines`.
 *
 * `suffixFull` adds the local clock time to the countdown, for rows that have
 * the width. Only the windows of the account make a row. The order is spend,
 * 5h, 7d, then the scoped model windows. A scoped window at its limit gets
 * `(!)`. The 7d and scoped rows get "(ahead of pace)", the 5h row never.
 */
export function usageRows(lastGood: unknown, now: number, fetchedAt: number | null = null): UsageRow[] {
  if (!isDict(lastGood)) return [];
  const rows: UsageRow[] = [];
  const spend = lastGood.spend;
  if (isDict(spend) && Object.keys(spend).length > 0) {
    const amounts = `$${pyGroupedFixed(num(spend.used), 2)} / $${pyGroupedFixed(num(spend.limit), 2)}`;
    const [reset, resetFull] = resetParts(spend, now);
    rows.push(["$$", num(spend.pct), reset ? `${reset}  ${amounts}` : amounts, resetFull ? `${resetFull}  ${amounts}` : amounts]);
  }
  for (const [key, label] of [
    ["five_hour", "5h"],
    ["seven_day", "7d"],
  ] as const) {
    const window = lastGood[key];
    if (!isDict(window) || Object.keys(window).length === 0) continue;
    const [reset, resetFull] = resetParts(window, now);
    let suffix = reset ?? "";
    let suffixFull = resetFull ?? "";
    if (key === "seven_day") {
      const marker = paceSuffix(window, fetchedAt);
      if (marker) {
        suffix = withMarker(suffix, marker);
        suffixFull = withMarker(suffixFull, marker);
      }
    }
    rows.push([label, num(window.pct), suffix, suffixFull]);
  }
  const scoped = Array.isArray(lastGood.scoped) ? lastGood.scoped : [];
  for (const window of scoped as Dict[]) {
    const pct = num(window.pct);
    const [reset, resetFull] = resetParts(window, now);
    let suffix = reset ?? "";
    let suffixFull = resetFull ?? "";
    if (pct >= 100) {
      suffix = withMarker(suffix, "(!)");
      suffixFull = withMarker(suffixFull, "(!)");
    } else {
      const marker = paceSuffix(window, fetchedAt);
      if (marker) {
        suffix = withMarker(suffix, marker);
        suffixFull = withMarker(suffixFull, marker);
      }
    }
    rows.push([String(window.name), pct, suffix, suffixFull]);
  }
  return rows;
}

function isStale(acc: AccountSnapshot): boolean {
  return acc.usage.ageS !== null && acc.usage.ageS > STALE_OK_S;
}

function appendIdentity(text: Text, acc: AccountSnapshot, palette: Palette): void {
  if (acc.alias) {
    text.append(acc.alias, `bold ${palette.accent}`);
    text.append(` (${acc.email})`, palette.foreground);
  } else {
    text.append(acc.email, palette.foreground);
  }
  text.append(`  [${displayTag(acc)}]`, palette.muted);
}

export interface CardOptions {
  threshold?: number | null;
  now?: number;
  palette?: Palette;
}

/** The full account card: a header line and one bar row for each window. */
export function accountCardText(
  acc: AccountSnapshot,
  width: number,
  { threshold = null, now = Date.now() / 1000, palette = Palette.DARK }: CardOptions = {},
): Text {
  const text = new Text();
  text.append(`${rjust(acc.number, 2)}  `, `bold ${palette.foreground}`);
  appendIdentity(text, acc, palette);
  if (acc.isActive) text.append("   ● active", `bold ${palette.accent}`);
  if (acc.disabled) text.append("   (disabled)", palette.muted);
  const age = data.formatAge(acc.usage.ageS);
  if (age) text.append(`   ${age}`, palette.muted);

  const sentinel = acc.usage.sentinel;
  if (sentinel !== null) {
    text.append("\n    ");
    const apiKey = sentinel === USAGE_API_KEY;
    text.append(`${apiKey ? "·" : "⚠"} ${data.sentinelLabel(sentinel)}`, apiKey ? palette.muted : palette.sevWarn);
    // The same extra line as `cswap list`. An API-key account has no quota to have "seen".
    if (!apiKey) {
      const lastSeen = data.lastSeenNote(acc.usage);
      if (lastSeen !== null) {
        text.append("\n    ");
        text.append(`└ ${lastSeen}`, palette.muted);
      }
    }
    return text;
  }

  const rows = usageRows(acc.usage.lastGood, now, acc.usage.fetchedAt);
  if (rows.length === 0) {
    text.append("\n    ");
    text.append("usage unavailable", palette.muted);
    const lastError = acc.usage.lastError;
    if (lastError) {
      const note = Object.hasOwn(ERROR_NOTES, lastError) ? ERROR_NOTES[lastError]! : lastError;
      text.append(` · ${note}`, palette.muted);
    }
    return text;
  }

  const stale = isStale(acc);
  const labelWidth = Math.max(...rows.map(([label]) => pyLen(label)));
  const barWidth = Math.max(12, Math.min(30, width - 42 - labelWidth));
  // The part of a row before the suffix: indent, label, bar, " NNN%" and the gap.
  const rowOverhead = 4 + labelWidth + 1 + barWidth + 5 + 2;
  for (const [label, pct, rowSuffix, suffixFull] of rows) {
    // The clock is decided for each row: a long spend row must not cost the 5h and 7d rows their clocks.
    let suffix = rowSuffix;
    if (suffixFull !== suffix && rowOverhead + pyLen(suffixFull) <= width) suffix = suffixFull;
    text.append("\n    ");
    text.append(usageBar(ljust(label, labelWidth), pct, suffix || null, barWidth, { stale, threshold, palette }));
  }
  return text;
}

/**
 * One short line for an account that is not active:
 * `2  work@acme.dev [personal]   5h 92% · 7d 63%`.
 *
 * A window at its limit adds its reset countdown, and a scoped window at its
 * limit shows as `Fable (!)`. A sentinel state shows its label.
 */
export function miniAccountText(acc: AccountSnapshot, now: number, { palette = Palette.DARK }: { palette?: Palette } = {}): Text {
  const text = new Text();
  text.append(`${rjust(acc.number, 2)}  `, `bold ${palette.muted}`);
  appendIdentity(text, acc, palette);
  if (acc.disabled) text.append("  (disabled)", palette.muted);
  text.append("   ");

  const sentinel = acc.usage.sentinel;
  if (sentinel !== null) {
    text.append(data.sentinelLabel(sentinel), sentinel === USAGE_API_KEY ? palette.muted : palette.sevWarn);
    return text;
  }

  const lastGood: unknown = acc.usage.lastGood;
  const fetchedAt = acc.usage.fetchedAt;
  const stale = isStale(acc);
  let parts = 0;
  for (const [key, label] of [
    ["five_hour", "5h"],
    ["seven_day", "7d"],
  ] as const) {
    const window = isDict(lastGood) ? lastGood[key] : undefined;
    if (!isDict(window) || Object.keys(window).length === 0) continue;
    const pct = num(window.pct);
    if (parts) text.append(" · ", palette.track);
    const color = palette.severity(pct);
    text.append(`${label} `, palette.muted);
    text.append(`${pyFixed(pct, 0)}%`, stale ? `${color} dim` : color);
    if (pct >= 100) {
      const reset = data.resetText(window, now);
      if (reset) text.append(` (${reset})`, palette.muted);
    } else if (key === "seven_day") {
      const result = pace.computePace(window, { fetchedAt });
      if (result && result.ahead) text.append(" (ahead)", palette.sevWarn);
    }
    parts += 1;
  }
  const scoped = isDict(lastGood) && Array.isArray(lastGood.scoped) ? (lastGood.scoped as Dict[]) : [];
  for (const window of scoped) {
    if (num(window.pct) < 100) continue;
    if (parts) text.append(" · ", palette.track);
    text.append(`${String(window.name)} (!)`, palette.sevCrit);
    parts += 1;
  }
  if (!parts) text.append("usage unknown", palette.muted);
  return text;
}

export interface PanelOptions {
  showMinis?: boolean;
  threshold?: number | null;
  now?: number;
  palette?: Palette;
}

/**
 * The text of the accounts panel: the active account as a full card and the
 * other accounts as one-line minis, in slot order.
 */
export function accountsPanelText(
  snap: AccountsSnapshot | null,
  width: number,
  { showMinis = true, threshold = null, now = Date.now() / 1000, palette = Palette.DARK }: PanelOptions = {},
): Text {
  if (snap === null) return new Text("loading…", palette.muted);
  if (snap.accounts.length === 0) {
    return new Text(
      "No managed accounts yet.\n" +
        "Use the menu below: Add account — from your current Claude Code login, or from a setup-token / API key.",
      palette.muted,
    );
  }
  const blocks: Text[] = [];
  for (const acc of snap.accounts) {
    if (acc.isActive) blocks.push(accountCardText(acc, width, { threshold, now, palette }));
    else if (showMinis) blocks.push(miniAccountText(acc, now, { palette }));
  }
  if (blocks.length === 0) return new Text("no active managed login", palette.muted);
  const text = new Text();
  let previousMultiline = false;
  blocks.forEach((block, i) => {
    const multiline = block.plain.includes("\n");
    // A blank line around the expanded active card.
    if (i) text.append(multiline || previousMultiline ? "\n\n" : "\n");
    text.append(block);
    previousMultiline = multiline;
  });
  return text;
}

/** The Textual name of a key press: "enter", "escape", "down", "ctrl+t", "shift+tab", "s", ... */
export function keyName(input: string, key: Key): string {
  if (key.return) return "enter";
  if (key.escape) return "escape";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.tab) return key.shift ? "shift+tab" : "tab";
  if (key.backspace || key.delete) return "backspace";
  if (key.pageUp) return "pageup";
  if (key.pageDown) return "pagedown";
  if (key.ctrl && input) return `ctrl+${input.toLowerCase()}`;
  return input;
}

/** One key binding. `keys` is the comma-separated key list of a Textual `Binding`. */
export interface Binding {
  readonly keys: string;
  readonly action: string;
  readonly description?: string;
  readonly show?: boolean;
}

export function binding(keys: string, action: string, description = "", { show = true } = {}): Binding {
  return Object.freeze({ keys, action, description, show: show && description !== "" });
}

/** The binding for a key name, or undefined. */
export function resolveBinding(bindings: readonly Binding[], name: string): Binding | undefined {
  return bindings.find((b) => b.keys.split(",").includes(name));
}

/** Split `"threshold_step(-1)"` into its action name and arguments. */
export function parseAction(action: string): [name: string, args: number[]] {
  const match = /^([\w.]+)\((.*)\)$/.exec(action);
  if (!match) return [action, []];
  const args = match[2]!.trim() ? match[2]!.split(",").map((arg) => Number(arg.trim())) : [];
  return [match[1]!, args];
}

const KEY_LABELS: Record<string, string> = { escape: "esc", enter: "⏎", left: "←", right: "→", up: "↑", down: "↓" };

/** The key label that the footer shows for a binding: its first key. */
export function footerKeyLabel(keys: string): string {
  const first = keys.split(",")[0]!;
  if (first.startsWith("ctrl+")) return `^${first.slice(5)}`;
  return KEY_LABELS[first] ?? first;
}

/** The size, colors and time that a screen renders with. */
export interface RenderContext {
  readonly columns: number;
  readonly rows: number;
  readonly theme: Theme;
  readonly palette: Palette;
  readonly now: number;
}

/** The part of the app that a screen uses. `app.tsx` implements it. */
export interface ScreenHost {
  readonly snapshot: AccountsSnapshot | null;
  changed(): void;
  popScreen(): void;
  runAppAction(name: string, args: number[]): void | Promise<void>;
}

/**
 * The base of every screen and modal. A screen keeps its own state, and the
 * app renders the top of its screen stack with `render()`.
 */
export abstract class Screen<R = unknown> {
  abstract readonly kind: string;
  bindings: readonly Binding[] = [];
  app!: ScreenHost;
  attached = false;
  /** Called with the result of `dismiss()`. */
  callback: ((result: R | undefined) => void) | null = null;

  onMount(): void {}
  onUnmount(): void {}
  onSnapshot(_snap: AccountsSnapshot | null): void {}
  onThemeChange(): void {}

  /** False hides a binding from the footer and makes it inert. */
  checkAction(_action: string): boolean {
    return true;
  }

  /** Keys that no binding takes, for example the cursor keys of a list. Returns true if handled. */
  onKey(_name: string, _input: string): boolean {
    return false;
  }

  /** Run a binding action. An `app.` prefix runs the action on the app. */
  async runAction(action: string): Promise<void> {
    const [name, args] = parseAction(action);
    if (!this.checkAction(name)) return;
    if (name.startsWith("app.")) {
      await this.app.runAppAction(name.slice(4), args);
      return;
    }
    const method = (this as unknown as Record<string, unknown>)[actionMethodName(name)];
    if (typeof method === "function") await (method as (...a: number[]) => unknown).apply(this, args);
  }

  async handleKey(name: string, input: string): Promise<boolean> {
    if (this.onKeyFirst(name, input)) return true;
    const found = resolveBinding(this.bindings, name);
    if (found && this.checkAction(parseAction(found.action)[0])) {
      await this.runAction(found.action);
      return true;
    }
    return this.onKey(name, input);
  }

  /** Keys that a focused widget takes before the screen bindings (for example typing in an input). */
  onKeyFirst(_name: string, _input: string): boolean {
    return false;
  }

  /** The bindings that the footer shows. */
  footerBindings(): Binding[] {
    return this.bindings.filter((b) => b.show && this.checkAction(parseAction(b.action)[0]));
  }

  /** Pop this screen and give `result` to its callback. */
  dismiss(result?: R): void {
    const callback = this.callback;
    this.app.popScreen();
    callback?.(result);
  }

  abstract render(ctx: RenderContext): ReactNode;
}

/** `"toggle_select"` → `"actionToggleSelect"`. */
export function actionMethodName(name: string): string {
  return `action${name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}`;
}

function spanNodes(spans: readonly { text: string; style: string }[]): ReactNode[] {
  return spans.map((span, i) => {
    const style = parseStyle(span.style);
    return (
      <InkText key={i} color={style.color} bold={style.bold} dimColor={style.dim}>
        {span.text}
      </InkText>
    );
  });
}

/** Render a rich `Text`. `truncate` keeps each line on one row, with an ellipsis. */
export function Styled({ text, truncate = false, color }: { text: Text; truncate?: boolean; color?: string }) {
  if (!truncate) {
    return (
      <InkText color={color} wrap="wrap">
        {spanNodes(text.spans)}
      </InkText>
    );
  }
  return (
    <Box flexDirection="column">
      {text.lines().map((line, i) => (
        <InkText key={i} color={color} wrap="truncate-end">
          {line.length ? spanNodes(line) : " "}
        </InkText>
      ))}
    </Box>
  );
}

/** One row of a list: the thick left border shows the cursor, as in `cswap.tcss`. */
export function ListRow({
  highlighted,
  flash = false,
  theme,
  marginBottom = 0,
  children,
}: {
  highlighted: boolean;
  flash?: boolean;
  theme: Theme;
  marginBottom?: number;
  children: ReactNode;
}) {
  const background = highlighted ? theme.surface : flash ? theme.panel : undefined;
  return (
    <Box flexDirection="row" marginBottom={marginBottom} backgroundColor={background} flexShrink={0}>
      <Box width={LAYOUT.listItem.markerWidth} flexShrink={0}>
        <InkText color={theme.primary}>{highlighted ? "▌" : " "}</InkText>
      </Box>
      <Box paddingX={LAYOUT.listItem.paddingX} flexGrow={1} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}

/** The footer: the visible bindings of the screen and of the app. */
export function Footer({ bindings, theme }: { bindings: readonly Binding[]; theme: Theme }) {
  return (
    <Box flexDirection="row" flexShrink={0} backgroundColor={theme.panel} width="100%">
      {bindings.map((b, i) => (
        <InkText key={i} wrap="truncate-end">
          <InkText color={theme.variables["footer-key-foreground"] ?? theme.primary} bold>
            {` ${footerKeyLabel(b.keys)} `}
          </InkText>
          <InkText color={theme.foreground}>{`${b.description} `}</InkText>
        </InkText>
      ))}
    </Box>
  );
}
