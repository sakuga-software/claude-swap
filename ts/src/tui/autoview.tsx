/**
 * The live auto-switch screen: the real engine, shown on screen.
 *
 * The screen runs `AutoSwitchEngine` in this process and renders its events.
 * It opens in dry-run: to open a view must never start a switch. To go live
 * is an explicit action with a confirmation. The state file of the engine
 * (shared cooldown, quarantine list, state lock) makes it safe to run next
 * to an external `cswap auto`.
 *
 * While the screen is open, the snapshot poller of the app reads the store
 * only: the engine is the only fetcher.
 */

import { Box, Text as InkText } from "ink";
import type { ReactNode } from "react";
import {
  AutoSwitchEngine,
  type AutoSwitchEvent,
  type AutoSwitchEngineOptions,
  type EngineSwitcher,
  pctLabel,
} from "../autoswitch.js";
import type { AccountsSnapshot } from "../models.js";
import { bindingPct } from "../poll_policy.js";
import { type AutoSwitchSettings, SETTING_SPECS, loadSettings, parseModelNames } from "../settings.js";
import { pyFixed, rjust } from "../support/pyformat.js";
import * as data from "./data.js";
import { ConfirmModal } from "./modals.js";
import { LAYOUT, Palette } from "./theme.js";
import { type RenderContext, Screen, type ScreenHost, Styled, Text, accountsPanelText, binding } from "./widgets.js";

/** The part of `AutoSwitchEngine` that the screen uses. */
export interface AutoEngine {
  readonly dryRun: boolean;
  settings: AutoSwitchSettings;
  runLoop(options?: { signal?: AbortSignal }): Promise<number>;
  stop(): void;
  wake(): void;
  applyThreshold(threshold: number): void;
}

export type AutoEngineClass = new (
  switcher: EngineSwitcher,
  settings: AutoSwitchSettings,
  onEvent: (event: AutoSwitchEvent) => void,
  options?: AutoSwitchEngineOptions,
) => AutoEngine;

/** Seams that the tests replace. */
export const internals = {
  AutoSwitchEngine: AutoSwitchEngine as AutoEngineClass,
};

/** The most lines that the event log keeps. */
const LOG_MAX_LINES = 1000;

const EVENT_ROLES: Readonly<Record<string, "accent" | "sevWarn" | "sevCrit">> = {
  switch: "accent",
  error: "sevWarn",
  "account-quarantined": "sevWarn",
  "all-exhausted": "sevCrit",
};
const QUIET_KINDS = new Set(["poll", "no-switch", "sleep", "account-unquarantined"]);

/** The log line of one engine event, with the styles of the human renderer of the CLI. */
export function eventText(event: AutoSwitchEvent, { palette = Palette.DARK }: { palette?: Palette } = {}): Text {
  const role = Object.hasOwn(EVENT_ROLES, event.kind) ? EVENT_ROLES[event.kind] : undefined;
  const style = role !== undefined ? palette[role] : QUIET_KINDS.has(event.kind) ? palette.muted : palette.foreground;
  const text = new Text();
  text.append(`${data.clockStamp()}  `, palette.muted);
  text.append(event.human(), style);
  return text;
}

/** The part of the app that the auto screen uses. `app.tsx` implements it. */
export interface AutoHost extends ScreenHost {
  readonly switcher: data.TuiSwitcher;
  thresholdPct: number | null;
  readonly palette: Palette;
  setStoreOnly(value: boolean): void;
  requestRefresh(options?: { full?: boolean }): void;
  runWorker(group: string, fn: () => Promise<unknown>): Promise<unknown>;
  pushScreen<R>(screen: Screen<R>, callback?: (result: R | undefined) => void): void;
}

export class AutoScreen extends Screen<never> {
  readonly kind = "auto";
  declare app: AutoHost;
  override bindings = [
    binding("l", "toggle_live", "Go live / dry-run"),
    binding("t", "adjust_threshold", "Threshold"),
    binding("left", "threshold_step(-1)", "-1%"),
    binding("right", "threshold_step(1)", "+1%"),
    binding("enter", "adjust_done", "Done"),
    binding("escape,q", "back", "Back"),
  ];
  engine: AutoEngine | null = null;
  abort: AbortController | null = null;
  settings!: AutoSwitchSettings;
  /**
   * The threshold adjustment (t, then the arrows) is for this session only.
   * It never goes to settings.json. `configuredThreshold` is the file value
   * that the screen restores at exit. `entryThreshold` is the value at the
   * start of the adjust mode: only a net change wakes the engine.
   */
  adjusting = false;
  configuredThreshold: number | null = null;
  entryThreshold: number | null = null;
  log: Text[] = [];

  override onMount(): void {
    this.app.setStoreOnly(true);
    this.settings = loadSettings(this.app.switcher.backupDir);
    // The bar tick reads app.thresholdPct, which the app loads one time at startup: use the new file value.
    this.configuredThreshold = this.settings.threshold;
    this.app.thresholdPct = this.settings.threshold;
    this.startEngine(true);
  }

  override onUnmount(): void {
    this.stopEngine();
    // A session threshold must not outlive its engine: free the poll planner and restore the bar tick.
    this.app.switcher.clearPollPolicyInputs();
    if (this.configuredThreshold !== null) this.app.thresholdPct = this.configuredThreshold;
    this.app.setStoreOnly(false);
  }

  actionBack(): void {
    if (this.adjusting) {
      this.endAdjust();
      return;
    }
    this.app.popScreen();
  }

  override checkAction(action: string): boolean {
    // The arrows and Enter stay hidden and inert until the adjust mode is armed.
    return !((action === "threshold_step" || action === "adjust_done") && !this.adjusting);
  }

  actionAdjustThreshold(): void {
    if (this.adjusting) {
      this.endAdjust();
      return;
    }
    this.adjusting = true;
    this.entryThreshold = this.settings.threshold;
    this.app.changed();
  }

  actionAdjustDone(): void {
    if (this.adjusting) this.endAdjust();
  }

  actionThresholdStep(delta: number): void {
    if (!this.adjusting) return;
    const spec = SETTING_SPECS["autoswitch.threshold"]!;
    const value = Math.min(spec.hi!, Math.max(spec.lo!, this.settings.threshold + delta));
    this.setThreshold(value);
  }

  endAdjust(): void {
    this.adjusting = false;
    this.app.changed();
    if (this.settings.threshold === this.entryThreshold) return;
    // Show a decision at the new value now.
    this.engine?.wake();
    this.write(new Text(`— threshold set to ${pctLabel(this.settings.threshold)}% for this session —`, this.app.palette.muted));
  }

  setThreshold(value: number): void {
    if (value === this.settings.threshold) return;
    this.settings = Object.freeze({ ...this.settings, threshold: value });
    this.engine?.applyThreshold(value);
    this.app.thresholdPct = value;
    this.app.changed();
  }

  /** The text of the summary line. */
  summaryText(palette: Palette = this.app.palette): Text {
    const text = new Text();
    text.append("auto-switch · ");
    text.append(`threshold ${pctLabel(this.settings.threshold)}%`, this.adjusting ? palette.accent : "");
    if (this.settings.threshold !== this.configuredThreshold) text.append(" (session)", palette.muted);
    text.append(` · poll every ${pyFixed(this.settings.intervalSeconds, 0)}s`);
    if (this.adjusting) text.append("   ← → adjust · enter done", palette.muted);
    return text;
  }

  write(line: Text): void {
    this.log.push(line);
    if (this.log.length > LOG_MAX_LINES) this.log.splice(0, this.log.length - LOG_MAX_LINES);
    this.app.changed();
  }

  startEngine(dryRun: boolean): void {
    const engine = new internals.AutoSwitchEngine(
      this.app.switcher as unknown as EngineSwitcher,
      this.settings,
      (event) => this.onEngineEvent(event),
      { dryRun },
    );
    const abort = new AbortController();
    this.engine = engine;
    this.abort = abort;
    const mode = dryRun ? "DRY-RUN (watching only)" : "LIVE (will switch accounts)";
    this.write(new Text(`— engine started: ${mode} —`, this.app.palette.muted));
    void this.app.runWorker("engine", () => engine.runLoop({ signal: abort.signal }));
  }

  stopEngine(): void {
    this.abort?.abort();
    this.engine?.stop();
  }

  onEngineEvent(event: AutoSwitchEvent): void {
    // The screen can be gone when the last tick of a stopped engine ends.
    if (!this.attached) return;
    this.write(eventText(event, { palette: this.app.palette }));
    if (event.kind === "switch") this.app.requestRefresh();
  }

  actionToggleLive(): void {
    if (this.engine === null) return;
    if (this.engine.dryRun) {
      this.app.pushScreen(
        new ConfirmModal(
          "Go live? claude-swap will switch your active account automatically when the threshold is reached.\n\n" +
            "(Same behavior as running `cswap auto` in a terminal.)",
          "Go live",
          "Go live",
        ),
        (confirmed) => {
          if (confirmed) this.restartEngine(false);
        },
      );
    } else {
      this.restartEngine(true);
    }
  }

  restartEngine(dryRun: boolean): void {
    this.stopEngine();
    this.startEngine(dryRun);
  }

  get live(): boolean {
    return this.engine !== null && !this.engine.dryRun;
  }

  /** The switch targets, ranked by headroom (best first). */
  candidatesText(snap: AccountsSnapshot, activeNumber: string | null, palette: Palette = this.app.palette): Text {
    // The engine uses the same window set (with autoswitch.model), so the ranking agrees with its pick.
    const models = this.settings ? parseModelNames(this.settings.model) : [];
    const ranked: Array<[number, string]> = [];
    const lines = new Map<string, Text>();
    for (const acc of snap.accounts) {
      if (acc.number === activeNumber || !acc.switchable) continue;
      const pct = bindingPct(acc.usage.lastGood, models);
      const entry = new Text();
      entry.append(`\n  ${rjust(acc.number, 2)}  `, palette.foreground);
      entry.append(acc.email, palette.foreground);
      if (acc.usage.sentinel !== null) {
        entry.append(`  ${data.sentinelLabel(acc.usage.sentinel)}`, palette.muted);
        ranked.push([998.0, acc.number]);
      } else if (pct === null) {
        entry.append("  usage unknown", palette.muted);
        ranked.push([999.0, acc.number]);
      } else {
        entry.append(`  ${rjust(pyFixed(pct, 0), 3)}% used`, palette.severity(pct));
        ranked.push([pct, acc.number]);
      }
      lines.set(acc.number, entry);
    }
    const text = new Text();
    text.append("Next best", palette.muted);
    if (!ranked.length) {
      text.append("\n  no other switchable accounts", palette.muted);
      return text;
    }
    ranked.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    for (const [, number] of ranked) text.append(lines.get(number)!);
    return text;
  }

  render({ columns, theme, palette, now }: RenderContext): ReactNode {
    const snap = this.app.snapshot;
    const panelWidth = columns - 2 * LAYOUT.autoActivePanel.paddingX - 2;
    const live = this.live;
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box flexShrink={0} paddingTop={LAYOUT.autoActivePanel.paddingTop} paddingX={LAYOUT.autoActivePanel.paddingX}>
          <Styled
            text={accountsPanelText(snap, panelWidth, { showMinis: false, threshold: this.app.thresholdPct ?? null, now, palette })}
          />
        </Box>
        <Box flexDirection="column" flexShrink={0} paddingY={LAYOUT.autoTop.paddingY} paddingX={LAYOUT.autoTop.paddingX}>
          <Box flexDirection="row" marginBottom={1}>
            <Box flexShrink={0} backgroundColor={live ? theme.primary : theme.panel}>
              <InkText bold color={live ? theme.background : theme.warning}>
                {live ? " LIVE " : " DRY-RUN "}
              </InkText>
            </Box>
            <Box paddingLeft={2} flexGrow={1}>
              <Styled text={this.summaryText(palette)} color={theme.secondary} truncate />
            </Box>
          </Box>
          {snap !== null ? <Styled text={this.candidatesText(snap, snap.activeNumber, palette)} /> : null}
        </Box>
        <Box
          flexDirection="column"
          flexGrow={1}
          justifyContent="flex-end"
          overflowY="hidden"
          paddingX={1}
          borderStyle="single"
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor={theme.panel}
        >
          {this.log.map((line, i) => (
            <Box key={i} flexShrink={0}>
              <Styled text={line} />
            </Box>
          ))}
        </Box>
      </Box>
    );
  }
}
