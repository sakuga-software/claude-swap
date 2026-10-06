/**
 * The claude-swap TUI application.
 *
 * `CswapApp` owns the snapshot poll loop, the screen stack and every action
 * that changes accounts (switch, add, remove), so the dashboard and the auto
 * view use the same code paths. It has no React code: `CswapView` renders it
 * with Ink and sends it the key presses.
 */

import { Box, Text as InkText, type Key, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useSyncExternalStore } from "react";
import type { AccountsSnapshot } from "../models.js";
import * as printer from "../printer.js";
import { loadSettings, loadUiSettings, setSetting } from "../settings.js";
import { accountIdentity, sameIdentity } from "../snapshot_source.js";
import { AutoScreen } from "./autoview.js";
import { DashboardScreen, WatchScreen } from "./dashboard.js";
import { type ActionResult, SnapshotSource, type TuiSwitcher, formatDuration, runAction } from "./data.js";
import { AddTokenModal, ConfirmModal, ModalScreen, OutputModal, type TokenForm } from "./modals.js";
import { CSWAP_DARK, LAYOUT, Palette, THEMES, type Theme } from "./theme.js";
import { type Binding, Footer, type RenderContext, type Screen, actionMethodName, binding, keyName, resolveBinding } from "./widgets.js";

export type StartPage = "dashboard" | "watch";
export type Severity = "information" | "warning" | "error";

export interface Notification {
  readonly id: number;
  readonly message: string;
  readonly title: string;
  readonly severity: Severity;
}

export interface NotifyOptions {
  title?: string;
  severity?: string;
  /** Seconds. */
  timeout?: number;
}

interface Worker {
  readonly group: string;
  readonly promise: Promise<void>;
}

type AnyScreen = Screen<never>;

export class CswapApp {
  static readonly TITLE = "claude-swap";
  /** No command palette: the actions are in the nested menu of the dashboard, in their own context. */
  static readonly ENABLE_COMMAND_PALETTE = false;
  /** The cadence of the snapshot poll. */
  static readonly POLL_INTERVAL_S = 3.0;
  /**
   * The snapshot age stays hidden while the poll is healthy. Above this age it
   * shows as an alarm. 60 s also keeps `formatDuration` in whole minutes.
   */
  static readonly SNAPSHOT_AGE_NOTE_S = 60.0;
  readonly POLL_INTERVAL_S = CswapApp.POLL_INTERVAL_S;
  readonly SNAPSHOT_AGE_NOTE_S = CswapApp.SNAPSHOT_AGE_NOTE_S;

  readonly bindings: readonly Binding[] = [
    binding("ctrl+t", "toggle_theme", "Theme"),
    binding("ctrl+q,ctrl+c", "quit", "Quit", { show: false }),
  ];

  readonly switcher: TuiSwitcher;
  readonly start: StartPage;
  /** The terminal background that `run()` detected before the renderer started, or null. */
  readonly detected: string | null;
  readonly source: SnapshotSource;
  storeOnly = false;
  fullNext = false;
  normalRefreshing = false;
  storeRefreshing = false;
  normalStartedAt: number | null = null;
  refreshGeneration = 0;
  appliedGeneration = 0;
  lastRefreshError = "";
  refreshStatus = "";
  busy = false;
  /** The auto-switch threshold. The bars show it as a tick. Null if the settings cannot be read. */
  thresholdPct: number | null;
  themeName: string;
  returnCode: number | null = null;
  screens: AnyScreen[] = [];
  notifications: Notification[] = [];
  readonly workers = new Set<Worker>();
  /** The renderer sets this callback: it stops the Ink app. */
  onExit: (() => void) | null = null;

  private snapshotValue: AccountsSnapshot | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private timers: NodeJS.Timeout[] = [];
  private notificationTimers = new Set<NodeJS.Timeout>();
  private nextNotificationId = 1;
  private mounted = false;
  private disposed = false;

  constructor(switcher: TuiSwitcher, { start = "dashboard", detected = null }: { start?: StartPage; detected?: string | null } = {}) {
    this.switcher = switcher;
    this.start = start;
    this.detected = detected;
    this.source = new SnapshotSource(switcher);
    try {
      this.thresholdPct = loadSettings(switcher.backupDir).threshold;
    } catch {
      this.thresholdPct = null;
    }
    try {
      this.themeName = loadUiSettings(switcher.backupDir).theme;
    } catch {
      this.themeName = "auto";
    }
  }

  get snapshot(): AccountsSnapshot | null {
    return this.snapshotValue;
  }

  set snapshot(value: AccountsSnapshot | null) {
    this.snapshotValue = value;
    for (const screen of this.screens) screen.onSnapshot(value);
    this.changed();
  }

  /** The top of the screen stack. */
  get screen(): AnyScreen {
    return this.screens[this.screens.length - 1]!;
  }

  get theme(): string {
    return `cswap-${this.resolvedTheme()}`;
  }

  get currentTheme(): Theme {
    return THEMES[this.theme] ?? CSWAP_DARK;
  }

  get palette(): Palette {
    return Palette.fromTheme(this.currentTheme);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** Ask the renderer for a new frame. */
  changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    printer.setTheme(this.resolvedTheme());
    this.pushScreen(new DashboardScreen());
    // On top of the dashboard, so that Esc goes back to it and does not exit.
    if (this.start === "watch") this.pushScreen(new WatchScreen());
    this.timers.push(
      setInterval(() => this.tick(), CswapApp.POLL_INTERVAL_S * 1000),
      setInterval(() => this.updateRefreshStatus(), 1000),
    );
    this.tick();
  }

  /** Stop the timers and unmount every screen (the auto screen stops its engine). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const timer of this.notificationTimers) clearTimeout(timer);
    this.notificationTimers.clear();
    while (this.screens.length) this.unmountTop();
  }

  /**
   * Start one refresh lane that can run.
   *
   * The normal mode prefers the lane that fetches. If that lane is busy, the
   * tick can still show a store update of another process with the store-only
   * lane. In the auto mode the engine fetches, so the tick starts store-only snapshots only.
   */
  tick(): void {
    if (this.storeOnly) {
      this.startStoreRefresh();
    } else if (!this.normalRefreshing) {
      const full = this.fullNext;
      this.fullNext = false;
      this.startNormalRefresh(full);
    } else {
      this.startStoreRefresh();
    }
  }

  startNormalRefresh(full: boolean): void {
    if (this.normalRefreshing) return;
    this.normalRefreshing = true;
    this.normalStartedAt = Date.now() / 1000;
    const generation = this.nextRefreshGeneration();
    this.updateRefreshStatus();
    void this.runWorker("refresh-normal", () => this.refresh(generation, "normal", full, false));
  }

  startStoreRefresh(): void {
    if (this.storeRefreshing) return;
    this.storeRefreshing = true;
    const generation = this.nextRefreshGeneration();
    this.updateRefreshStatus();
    void this.runWorker("refresh-store", () => this.refresh(generation, "store", false, true));
  }

  nextRefreshGeneration(): number {
    this.refreshGeneration += 1;
    return this.refreshGeneration;
  }

  async refresh(generation: number, lane: "normal" | "store", full: boolean, storeOnly: boolean): Promise<void> {
    const snap = await this.source.take({ full, storeOnly });
    if (!this.disposed) this.applySnapshot(generation, lane, snap);
  }

  applySnapshot(generation: number, lane: "normal" | "store", snap: AccountsSnapshot): void {
    if (lane === "normal") {
      this.normalRefreshing = false;
      this.normalStartedAt = null;
    } else {
      this.storeRefreshing = false;
    }
    this.lastRefreshError = "";
    if (generation >= this.appliedGeneration) {
      this.appliedGeneration = generation;
      this.snapshot = snap;
    } else if (this.snapshot !== null) {
      // A store repaint that started later owns the account metadata. The older
      // worker can still bring a newer provider fetch: SnapshotSource already
      // refused the regressions, so take its usage rows and keep the metadata.
      const current = this.snapshot;
      const incoming = new Map(snap.accounts.map((acc) => [acc.number, acc]));
      const accounts = current.accounts.map((acc) => {
        const other = incoming.get(acc.number);
        if (other !== undefined && sameIdentity(accountIdentity(acc), accountIdentity(other))) {
          return Object.freeze({ ...acc, usage: other.usage });
        }
        return acc;
      });
      this.snapshot = Object.freeze({
        ...current,
        accounts: Object.freeze(accounts),
        takenAt: Math.max(current.takenAt, snap.takenAt),
      });
    }
    this.updateRefreshStatus();
  }

  updateRefreshStatus(): void {
    const parts: string[] = [];
    const now = Date.now() / 1000;
    if (this.snapshot !== null) {
      const age = Math.max(0.0, now - this.snapshot.takenAt);
      if (age >= CswapApp.SNAPSHOT_AGE_NOTE_S) parts.push(`snapshot ${formatDuration(age)} ago`);
    }
    if (this.normalRefreshing && this.normalStartedAt !== null) {
      const elapsed = now - this.normalStartedAt;
      if (elapsed >= CswapApp.POLL_INTERVAL_S) parts.push(`refreshing ${formatDuration(elapsed)}`);
    }
    const status = parts.join(" · ");
    if (status !== this.refreshStatus) {
      this.refreshStatus = status;
      this.changed();
    }
  }

  requestRefresh({ full = false }: { full?: boolean } = {}): void {
    if (full) this.fullNext = true;
    this.tick();
  }

  /** The auto screen: the engine fetches, and the poller only reads the store. */
  setStoreOnly(value: boolean): void {
    this.storeOnly = value;
    this.requestRefresh();
  }

  /** Run `fn` as a tracked background task. A failure goes to `onWorkerError`. */
  runWorker(group: string, fn: () => Promise<unknown>): Promise<void> {
    const promise = (async () => {
      try {
        await fn();
      } catch (e) {
        if (!this.disposed) this.onWorkerError(group, e);
      }
    })();
    const worker: Worker = { group, promise };
    this.workers.add(worker);
    void promise.finally(() => this.workers.delete(worker));
    return promise;
  }

  /** Wait until no background task (other than the engine) runs. */
  async waitForWorkers(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      const pending = [...this.workers].filter((w) => w.group !== "engine").map((w) => w.promise);
      if (!pending.length) return;
      await Promise.all(pending);
    }
  }

  onWorkerError(group: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    if (group === "refresh-normal" || group === "refresh-store") {
      if (group === "refresh-normal") {
        this.normalRefreshing = false;
        this.normalStartedAt = null;
      } else {
        this.storeRefreshing = false;
      }
      this.updateRefreshStatus();
      if (msg !== this.lastRefreshError) {
        this.lastRefreshError = msg;
        const lane = group === "refresh-store" ? "Store refresh" : "Refresh";
        this.notify(`${lane} failed: ${msg}`, { severity: "warning", timeout: 6 });
      }
    } else if (group === "action") {
      this.busy = false;
      this.notify(`Action failed: ${msg}`, { severity: "error" });
    } else if (group === "engine") {
      this.notify(`Auto-switch engine stopped: ${msg}`, { severity: "error" });
    }
  }

  startAction(label: string, fn: () => unknown, { showOutput = false }: { showOutput?: boolean } = {}): void {
    if (this.busy) {
      this.notify("Another action is still running", { severity: "warning" });
      return;
    }
    this.busy = true;
    this.changed();
    void this.runWorker("action", async () => {
      const result = await runAction(fn);
      if (!this.disposed) this.actionDone(label, result, showOutput);
    });
  }

  actionDone(label: string, result: ActionResult, showOutput: boolean): void {
    this.busy = false;
    this.requestRefresh();
    if (!result.ok) {
      this.pushScreen(new OutputModal(`${label} — failed`, result.output));
      return;
    }
    const payload = result.payload ?? {};
    if ("switched" in payload) {
      if (payload.switched) {
        const to = (payload.to ?? {}) as Record<string, unknown>;
        const target = (to.email as string) || `account ${to.number ?? "None"}`;
        this.notify(`Switched to ${target}`, { title: "Switch" });
      } else {
        const reason = String(payload.reason || "no switch performed");
        this.notify(reason, { title: "No switch", severity: "warning" });
      }
      return;
    }
    if (showOutput && result.output.trim()) this.pushScreen(new OutputModal(label, result.output));
    else if (result.firstLine) this.notify(result.firstLine);
  }

  doSwitch(number: string): void {
    this.startAction(`Switch to account ${number}`, () => this.switcher.switchTo(number, true));
  }

  actionSwitchBest(): void {
    this.startAction("Switch (best)", () => this.switcher.switch("best", true));
  }

  /** Hold the account out of the auto-rotation, or give it back. The live snapshot gives the direction. */
  doToggleDisabled(number: string): void {
    const acc = this.snapshot?.accounts.find((a) => a.number === number);
    if (acc === undefined) return;
    const target = !acc.disabled;
    const verb = target ? "Disable" : "Enable";
    this.startAction(`${verb} account ${number}`, () => this.switcher.setAccountDisabled(number, target));
  }

  confirmRemove(number: string, email: string): void {
    this.pushScreen(
      new ConfirmModal(
        `Remove account ${number} (${email})?\n\nIts stored credentials and config backup are deleted.`,
        "Remove account",
        "Remove",
      ),
      (confirmed) => {
        if (confirmed) this.startAction(`Remove account ${number}`, () => this.switcher.removeAccount(number, true));
      },
    );
  }

  actionAddCurrent(): void {
    this.pushScreen(
      new ConfirmModal(
        "Back up the current Claude Code login as a managed account?\n\n" +
          "If this account is already managed, its stored credentials are refreshed in place.",
        "Add account",
        "Add",
      ),
      (confirmed) => {
        if (confirmed) this.startAction("Add current login", () => this.switcher.addAccount(), { showOutput: true });
      },
    );
  }

  actionAddToken(): void {
    this.pushScreen(new AddTokenModal(), (form) => this.onTokenForm(form ?? null));
  }

  onTokenForm(form: TokenForm | null): void {
    if (form === null) return;
    const run = () =>
      this.startAction(
        "Add account from token",
        () => this.switcher.addAccountFromToken(form.token, form.email, form.slot, true),
        { showOutput: true },
      );
    const occupant = this.slotOccupant(form.slot);
    if (occupant !== null) {
      this.pushScreen(new ConfirmModal(`Slot ${form.slot} is occupied by ${occupant}. Overwrite?`, "Overwrite slot", "Overwrite"), (confirmed) => {
        if (confirmed) run();
      });
    } else {
      run();
    }
  }

  slotOccupant(slot: number | null): string | null {
    if (slot === null || this.snapshot === null) return null;
    return this.snapshot.accounts.find((acc) => acc.number === String(slot))?.email ?? null;
  }

  actionRefreshFull(): void {
    this.requestRefresh({ full: true });
    this.notify("Refreshing usage…", { timeout: 2 });
  }

  actionOpenAuto(): void {
    if (this.screen instanceof AutoScreen) return;
    this.pushScreen(new AutoScreen());
  }

  actionOpenWatch(): void {
    if (this.screen instanceof WatchScreen) return;
    this.pushScreen(new WatchScreen());
  }

  actionQuit(): void {
    this.exit();
  }

  /** `dark` or `light` for the current setting: auto uses the detection, then dark. */
  resolvedTheme(): string {
    if (this.themeName === "auto") return this.detected || "dark";
    return this.themeName;
  }

  /**
   * Change the live theme: the TUI, the captured printer output and the setting.
   * `auto` uses the detection of the start. The app never queries the terminal again.
   */
  applyTheme(name: string): void {
    this.themeName = name;
    printer.setTheme(this.resolvedTheme());
    try {
      setSetting(this.switcher.backupDir, "ui.theme", name);
    } catch (e) {
      // To save the setting is best effort. The UI must not crash.
      this.notify(`Could not save theme: ${e instanceof Error ? e.message : String(e)}`, { severity: "warning" });
    }
    for (const screen of this.screens) screen.onThemeChange();
    this.changed();
  }

  actionToggleTheme(): void {
    const order = ["dark", "light", "auto"];
    const next = order[(order.indexOf(this.themeName) + 1) % order.length]!;
    this.applyTheme(next);
    this.notify(`Theme: ${next}`);
  }

  pushScreen<R>(screen: Screen<R>, callback?: (result: R | undefined) => void): void {
    screen.app = this;
    screen.callback = callback ?? null;
    this.screens.push(screen as unknown as AnyScreen);
    screen.attached = true;
    screen.onMount();
    this.changed();
  }

  popScreen(): void {
    if (this.screens.length <= 1) return;
    this.unmountTop();
    this.changed();
  }

  private unmountTop(): void {
    const top = this.screens.pop();
    if (top === undefined) return;
    top.attached = false;
    top.onUnmount();
  }

  notify(message: string, { title = "", severity = "information", timeout = LAYOUT.notifyTimeoutS }: NotifyOptions = {}): void {
    const notification: Notification = { id: this.nextNotificationId++, message, title, severity: severity as Severity };
    this.notifications = [...this.notifications, notification];
    this.changed();
    const timer = setTimeout(() => {
      this.notificationTimers.delete(timer);
      this.notifications = this.notifications.filter((n) => n.id !== notification.id);
      this.changed();
    }, timeout * 1000);
    timer.unref?.();
    this.notificationTimers.add(timer);
  }

  exit(code?: number): void {
    this.returnCode = code ?? null;
    this.onExit?.();
  }

  async runAppAction(name: string, args: number[]): Promise<void> {
    const method = (this as unknown as Record<string, unknown>)[actionMethodName(name)];
    if (typeof method === "function") await (method as (...a: number[]) => unknown).apply(this, args);
  }

  /** Route one key press: the top screen first, then the app bindings. */
  async handleKey(input: string, key: Key): Promise<void> {
    const name = keyName(input, key);
    if (!name || this.screens.length === 0) return;
    if (await this.screen.handleKey(name, input)) return;
    const found = resolveBinding(this.bindings, name);
    if (found) await this.runAppAction(found.action, []);
  }

  /** The bindings that the footer shows: the top screen, then the app. */
  footerBindings(): Binding[] {
    const screen = this.screens[this.screens.length - 1];
    return [...(screen?.footerBindings() ?? []), ...this.bindings.filter((b) => b.show)];
  }
}

function isModal(screen: AnyScreen): boolean {
  return screen instanceof ModalScreen;
}

function Toasts({ notifications, theme }: { notifications: readonly Notification[]; theme: Theme }) {
  if (!notifications.length) return null;
  const colors: Record<Severity, string> = { information: theme.primary, warning: theme.warning, error: theme.error };
  return (
    <Box position="absolute" bottom={1} right={1} flexDirection="column" alignItems="flex-end">
      {notifications.slice(-4).map((n) => (
        <Box
          key={n.id}
          marginTop={1}
          width={Math.min(50, Math.max(n.message.length, n.title.length) + 4)}
          backgroundColor={theme.panel}
          borderStyle="bold"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderColor={colors[n.severity] ?? theme.primary}
          paddingX={1}
          flexDirection="column"
        >
          {n.title ? (
            <InkText bold color={colors[n.severity] ?? theme.primary}>
              {n.title}
            </InkText>
          ) : null}
          <InkText color={theme.foreground}>{n.message}</InkText>
        </Box>
      ))}
    </Box>
  );
}

export interface CswapViewProps {
  app: CswapApp;
  /** A fixed terminal size, for the tests. The default follows the terminal. */
  size?: { columns: number; rows: number };
}

/** The Ink root: it renders the screen stack of `app` and sends it the keys. */
export function CswapView({ app, size }: CswapViewProps) {
  const { exit } = useApp();
  const windowSize = useWindowSize();
  const columns = size?.columns ?? windowSize.columns;
  const rows = size?.rows ?? windowSize.rows;
  useSyncExternalStore(app.subscribe, app.getVersion);

  useEffect(() => {
    app.onExit = () => exit();
    app.mount();
    return () => {
      app.onExit = null;
      app.dispose();
    };
  }, [app, exit]);

  useInput((input, key) => {
    void app.handleKey(input, key);
  });

  if (app.screens.length === 0) return null;
  const theme = app.currentTheme;
  const ctx: RenderContext = { columns, rows, theme, palette: Palette.fromTheme(theme), now: Date.now() / 1000 };
  const base = [...app.screens].reverse().find((screen) => !isModal(screen));
  const top = app.screen;
  return (
    <Box flexDirection="column" width={columns} height={rows} backgroundColor={theme.background}>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {base?.render(ctx)}
      </Box>
      <Footer bindings={app.footerBindings()} theme={theme} />
      {isModal(top) ? (
        <Box position="absolute" top={0} left={0} width={columns} height={rows} justifyContent="center" alignItems="center">
          {top.render(ctx)}
        </Box>
      ) : null}
      <Toasts notifications={app.notifications} theme={theme} />
    </Box>
  );
}
