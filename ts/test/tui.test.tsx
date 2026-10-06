/**
 * Tests for the Ink TUI: the data service units, and app tests that drive the
 * real app with ink-testing-library against a `FakeSwitcher`. The fake
 * implements only the structured surface that the TUI uses: no scraping, no
 * real credentials, no network.
 */

import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AutoSwitchEvent, NoSwitchEvent, SwitchEvent } from "../src/autoswitch.js";
import { ClaudeSwitchError } from "../src/exceptions.js";
import { USAGE_API_KEY, USAGE_TOKEN_EXPIRED } from "../src/json_output.js";
import { type AccountSnapshot, type AccountsSnapshot, accountSnapshot } from "../src/models.js";
import type { AutoSwitchSettings } from "../src/settings.js";
import { ClaudeAccountSwitcher } from "../src/switcher.js";
import { SENTINEL_NOTES } from "../src/switcher/display.js";
import { internals as switcherInternals } from "../src/switcher/internals.js";
import { CswapApp, CswapView, type StartPage } from "../src/tui/app.js";
import { AutoScreen, eventText, internals as autoviewInternals } from "../src/tui/autoview.js";
import { DashboardScreen, SwitchScreen, WatchScreen } from "../src/tui/dashboard.js";
import * as tuiData from "../src/tui/data.js";
import { AddTokenModal, ConfirmModal } from "../src/tui/modals.js";
import { ACCENT_LIGHT, CSWAP_LIGHT, Palette } from "../src/tui/theme.js";
import { accountCardText, miniAccountText, usageRows } from "../src/tui/widgets.js";
import type { UsageDict } from "../src/oauth.js";
import { UsageEntry } from "../src/usage_store.js";
import * as cli from "../src/cli.js";
import { SystemExit } from "../src/support/exit.js";
import { captureOutput } from "./helpers/capture.js";
import { mockClaudeConfig } from "./helpers/fixtures.js";
import { testHome } from "./helpers/home.js";

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function nowS(): number {
  return Date.now() / 1000;
}

interface EntryOptions {
  sentinel?: string | null;
  ageS?: number;
  scoped?: Array<[string, number]> | null;
  spend?: Record<string, unknown> | null;
}

/** A `pct5` or `pct7` of null leaves out that window (an annual plan has no 7d window). */
function makeEntry(pct5: number | null = 25.0, pct7: number | null = 10.0, { sentinel = null, ageS = 5.0, scoped = null, spend = null }: EntryOptions = {}): UsageEntry {
  if (sentinel !== null) return new UsageEntry({ sentinel });
  const lastGood: Record<string, unknown> = {};
  if (pct5 !== null) lastGood.five_hour = { pct: pct5, resets_at: isoIn(7200) };
  if (pct7 !== null) lastGood.seven_day = { pct: pct7, resets_at: isoIn(86400 * 3) };
  if (scoped !== null) lastGood.scoped = scoped.map(([name, pct]) => ({ name, pct, resets_at: isoIn(86400 * 2) }));
  if (spend !== null) lastGood.spend = spend;
  return new UsageEntry({ lastGood: lastGood as UsageDict, fetchedAt: nowS() - ageS, ageS });
}

interface AccountOptions {
  active?: boolean;
  switchable?: boolean;
  kind?: "oauth" | "api_key";
  entry?: UsageEntry | null;
  email?: string | null;
  alias?: string;
  disabled?: boolean;
}

function makeAccount(
  number: number | string,
  { active = false, switchable = true, kind = "oauth", entry = null, email = null, alias = "", disabled = false }: AccountOptions = {},
): AccountSnapshot {
  return accountSnapshot({
    number: String(number),
    email: email || `user${number}@example.com`,
    orgName: "",
    orgUuid: "",
    isActive: active,
    kind,
    switchable,
    usage: entry ?? makeEntry(),
    alias,
    disabled,
  });
}

function makeUsageAt(fetchedAt: number | null, pct = 25.0, { sentinel = null }: { sentinel?: string | null } = {}): UsageEntry {
  return new UsageEntry({
    sentinel,
    lastGood: { five_hour: { pct, resets_at: isoIn(7200) } },
    fetchedAt,
    ageS: fetchedAt !== null ? nowS() - fetchedAt : null,
  });
}

/** The equivalent of a `threading.Event` for async code. */
class TestEvent {
  private flag = false;
  private waiters: Array<() => void> = [];

  set(): void {
    this.flag = true;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  isSet(): boolean {
    return this.flag;
  }

  wait(timeoutMs: number): Promise<boolean> {
    if (this.flag) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.flag), timeoutMs);
      timer.unref?.();
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

/** A stand-in for ClaudeAccountSwitcher with the structured surface only. */
class FakeSwitcher implements tuiData.TuiSwitcher {
  accounts: AccountSnapshot[];
  backupDir: string;
  active: string | null;
  calls: unknown[][] = [];
  fetchSets: Array<ReadonlySet<string> | null> = [];
  pollInputsOverride: [number, readonly string[]] | null | undefined = undefined;

  constructor(accounts: AccountSnapshot[], backupDir: string) {
    this.accounts = [...accounts];
    this.backupDir = backupDir;
    this.active = accounts.find((a) => a.isActive)?.number ?? null;
  }

  async accountsSnapshot(fetch: ReadonlySet<string> | null = null): Promise<AccountsSnapshot> {
    this.fetchSets.push(fetch);
    return { activeNumber: this.active, accounts: [...this.accounts], takenAt: nowS() };
  }

  currentAccountNumber(): string | null {
    return this.active;
  }

  async switchTo(identifier: string, _jsonOutput = false, _force = false): Promise<Record<string, unknown>> {
    this.calls.push(["switch_to", String(identifier)]);
    const old = this.active;
    this.active = String(identifier);
    this.accounts = this.accounts.map((a) => accountSnapshot({ ...a, isActive: a.number === this.active }));
    return {
      switched: true,
      from: { number: old ? Number(old) : null, email: "" },
      to: { number: Number(identifier), email: `user${identifier}@example.com` },
      reason: "requested",
    };
  }

  async switch(strategy: string | null = null, _jsonOutput = false): Promise<Record<string, unknown>> {
    this.calls.push(["switch", strategy]);
    return { switched: false, from: null, to: null, reason: "no-better-target" };
  }

  removeAccount(identifier: string, assumeYes = false): void {
    this.calls.push(["remove", String(identifier), assumeYes]);
    this.accounts = this.accounts.filter((a) => a.number !== String(identifier));
    process.stdout.write(`Removed account ${identifier}\n`);
  }

  setAccountDisabled(identifier: string, disabled: boolean): void {
    this.calls.push(["set_disabled", String(identifier), disabled]);
    this.accounts = this.accounts.map((a) => (a.number === String(identifier) ? accountSnapshot({ ...a, disabled }) : a));
    process.stdout.write(`${disabled ? "Disabled" : "Enabled"} Account-${identifier}\n`);
  }

  async addAccount(slot: number | null = null, assumeYes = false): Promise<void> {
    this.calls.push(["add", slot, assumeYes]);
    process.stdout.write("Added Account 9: fresh@example.com\n");
  }

  addAccountFromToken(token: string, email: string | null = null, slot: number | null = null, assumeYes = false): void {
    this.calls.push(["add_token", token, email, slot, assumeYes]);
    process.stdout.write(`Added Account ${slot || 9}\n`);
  }

  setPollPolicyInputs(threshold: number, models: readonly string[]): void {
    this.pollInputsOverride = [threshold, models];
  }

  clearPollPolicyInputs(): void {
    this.pollInputsOverride = null;
  }
}

/** A fake switcher whose normal and store snapshot lanes each wait on their own gate. */
class BlockingSnapshotSwitcher extends FakeSwitcher {
  normalStarted = new TestEvent();
  normalRelease = new TestEvent();
  normalDone = new TestEvent();
  storeStarted = new TestEvent();
  storeRelease = new TestEvent();
  storeDone = new TestEvent();
  blockStore = false;

  constructor(
    readonly normalAccount: AccountSnapshot,
    readonly storeAccount: AccountSnapshot,
    backupDir: string,
  ) {
    super([normalAccount], backupDir);
  }

  override async accountsSnapshot(fetch: ReadonlySet<string> | null = null): Promise<AccountsSnapshot> {
    this.fetchSets.push(fetch);
    let account: AccountSnapshot;
    if (fetch === null) {
      this.normalStarted.set();
      await this.normalRelease.wait(2000);
      this.normalDone.set();
      account = this.normalAccount;
    } else {
      this.storeStarted.set();
      if (this.blockStore) await this.storeRelease.wait(2000);
      this.storeDone.set();
      account = this.storeAccount;
    }
    return { activeNumber: account.number, accounts: [account], takenAt: nowS() };
  }
}

/** The `tmp_path` of the Python tests: the backup directory of the fake switcher. */
function tmpPath(): string {
  const dir = path.join(testHome(), "tmp_path");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeApp(fake: tuiData.TuiSwitcher, options: { start?: StartPage; detected?: string | null } = {}): CswapApp {
  return new CswapApp(fake, options);
}

const KEYS: Record<string, string> = {
  enter: "\r",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  tab: "\t",
};

interface Pilot {
  readonly app: CswapApp;
  press(...keys: string[]): Promise<void>;
  type(text: string): Promise<void>;
  pause(): Promise<void>;
  frame(): string;
}

/** Render the app like Textual's `run_test(size=...)`. */
async function runTest(app: CswapApp, size = { columns: 100, rows: 32 }): Promise<Pilot> {
  const ink = render(<CswapView app={app} size={size} />);
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
  await pause();
  return {
    app,
    pause,
    async press(...keys: string[]) {
      for (const key of keys) {
        ink.stdin.write(KEYS[key] ?? key);
        await pause();
      }
    },
    async type(text: string) {
      ink.stdin.write(text);
      await pause();
    },
    frame: () => stripVTControlCharacters(ink.lastFrame() ?? ""),
  };
}

/** Let the background tasks end and their updates render. The engine runs until its screen stops it. */
async function settle(pilot: Pilot): Promise<void> {
  await pilot.app.waitForWorkers();
  await pilot.pause();
  await pilot.pause();
}

async function waitEvent(event: TestEvent, timeoutMs = 1000): Promise<void> {
  expect(await event.wait(timeoutMs)).toBe(true);
}

function dashboard(app: CswapApp): DashboardScreen {
  expect(app.screen).toBeInstanceOf(DashboardScreen);
  return app.screen as unknown as DashboardScreen;
}

function menuIds(app: CswapApp): string[] {
  return dashboard(app).menuEntries.map(([, id]) => id);
}

function menuLabels(app: CswapApp): string[] {
  return dashboard(app).menuEntries.map(([label]) => label);
}

/** Drive the dashboard menu: put the cursor on the entry with this id, then press Enter. */
async function menuSelect(pilot: Pilot, actionId: string): Promise<void> {
  const screen = dashboard(pilot.app);
  screen.menuIndex = screen.menuEntries.findIndex(([, id]) => id === actionId);
  expect(screen.menuIndex).toBeGreaterThanOrEqual(0);
  pilot.app.changed();
  await pilot.pause();
  await pilot.press("enter");
  await pilot.pause();
}

/** The part of the frame after the first line that contains `marker`. */
function after(frame: string, marker: string): string {
  const at = frame.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  return frame.slice(at + marker.length);
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

afterEach(() => {
  cleanup();
});

describe("TestFormatting", () => {
  it("test_format_duration", () => {
    expect(tuiData.formatDuration(42)).toBe("42s");
    expect(tuiData.formatDuration(180)).toBe("3m");
    expect(tuiData.formatDuration(7980)).toBe("2h 13m");
    expect(tuiData.formatDuration(3600 * 26)).toBe("1d 2h");
  });

  it("test_format_age_fresh_is_silent", () => {
    // An age inside the serve TTL is the poll cadence at work, not staleness.
    expect(tuiData.formatAge(3.0)).toBeNull();
    expect(tuiData.formatAge(120)).toBeNull();
    expect(tuiData.formatAge(null)).toBeNull();
    expect(tuiData.formatAge(400)).toBe("· 6m ago");
  });

  it("test_sentinel_labels_match_cswap_list", () => {
    expect(tuiData.sentinelLabel(USAGE_TOKEN_EXPIRED)).toBe("token expired — refresh deferred this pass; retries automatically");
    for (const [sentinel, note] of Object.entries(SENTINEL_NOTES)) {
      expect(tuiData.sentinelLabel(sentinel)).toBe(note);
    }
    expect(tuiData.sentinelLabel("unknown state")).toBe("unknown state");
  });

  it("test_sentinel_card_shows_last_seen_like_cswap_list", () => {
    const entry = new UsageEntry({
      sentinel: USAGE_TOKEN_EXPIRED,
      lastGood: { five_hour: { pct: 53.0 } },
      fetchedAt: nowS() - 720,
      ageS: 720.0,
    });
    const card = accountCardText(makeAccount(1, { active: true, entry }), 80).plain;
    expect(card).toContain("token expired — refresh deferred this pass; retries automatically");
    expect(card).toContain("last seen 53% used");

    const noHistory = accountCardText(makeAccount(1, { entry: new UsageEntry({ sentinel: USAGE_TOKEN_EXPIRED }) }), 80).plain;
    expect(noHistory).not.toContain("last seen");

    const apiKey = accountCardText(
      makeAccount(1, { kind: "api_key", entry: new UsageEntry({ ...entry, sentinel: USAGE_API_KEY }) }),
      80,
    ).plain;
    expect(apiKey).not.toContain("last seen");
  });

  it("test_account_card_uses_light_palette_when_passed", () => {
    const acc = makeAccount(1, { active: true, entry: makeEntry(95.0) });
    const text = accountCardText(acc, 100, { palette: Palette.fromTheme(CSWAP_LIGHT) });
    const styles = new Set(text.spans.map((span) => span.style));
    expect([...styles].some((s) => s.includes(ACCENT_LIGHT))).toBe(true);
  });

  it("test_window_helpers", () => {
    const entry = makeEntry(47.0);
    expect(tuiData.windowPct(entry.lastGood, "five_hour")).toBe(47.0);
    expect(tuiData.windowPct(null, "five_hour")).toBeNull();
    const text = tuiData.windowResetText(entry.lastGood, "five_hour", nowS());
    expect(text !== null && text.startsWith("resets ")).toBe(true);
    expect(tuiData.windowResetText(null, "five_hour", nowS())).toBeNull();
  });

  it("test_reset_clock", () => {
    // A reset on the same day shows HH:MM. A reset days later shows its date too.
    const now = nowS();
    const entry = makeEntry();
    const clock5 = tuiData.resetClock(entry.lastGood!.five_hour, now);
    expect(clock5 !== null && count(clock5, ":") === 1).toBe(true);
    const clock7 = tuiData.resetClock(entry.lastGood!.seven_day, now);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    expect(clock7 !== null && months.some((m) => clock7.includes(m))).toBe(true);
  });

  it("test_reset_clock_unknown_or_elapsed_is_none", () => {
    const now = nowS();
    expect(tuiData.resetClock(null, now)).toBeNull();
    expect(tuiData.resetClock({ pct: 5.0 }, now)).toBeNull();
    expect(tuiData.resetClock({ resets_at: "garbage" }, now)).toBeNull();
    const elapsed = { resets_at: isoIn(-60) };
    expect(tuiData.resetClock(elapsed, now)).toBeNull();
    expect(tuiData.resetText(elapsed, now)).toBe("resets now");
  });
});

describe("TestSnapshotSource", () => {
  function source(accounts: AccountSnapshot[] | null = null): [FakeSwitcher, tuiData.SnapshotSource] {
    const fake = new FakeSwitcher(accounts ?? [makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
    return [fake, new tuiData.SnapshotSource(fake)];
  }

  it("test_every_pass_is_store_governed", async () => {
    // The usage store paces the network, so the explicit refresh of the user is a normal pass too.
    const [fake, src] = source();
    await src.take();
    await src.take();
    await src.take({ full: true });
    expect(fake.fetchSets).toEqual([null, null, null]);
  });

  it("test_store_only_never_fetches", async () => {
    const [fake, src] = source();
    await src.take({ storeOnly: true });
    expect(fake.fetchSets).toEqual([new Set()]);
  });

  it("test_expired_sentinel_retained_until_fetched_at_advances", async () => {
    const expired = makeAccount(1, { active: true, entry: makeUsageAt(100.0, 25.0, { sentinel: USAGE_TOKEN_EXPIRED }) });
    const freshSameStamp = makeAccount(1, { active: true, entry: makeUsageAt(100.0) });
    const freshNewStamp = makeAccount(1, { active: true, entry: makeUsageAt(101.0) });
    const [fake, src] = source([expired]);

    expect((await src.take()).accounts[0]!.usage.sentinel).toBe(USAGE_TOKEN_EXPIRED);
    fake.accounts = [freshSameStamp];
    expect((await src.take({ storeOnly: true })).accounts[0]!.usage.sentinel).toBe(USAGE_TOKEN_EXPIRED);
    fake.accounts = [freshNewStamp];
    expect((await src.take({ storeOnly: true })).accounts[0]!.usage.sentinel).toBeNull();
  });

  it("test_expired_sentinel_clears_on_superseding_sentinel", async () => {
    const expired = makeAccount(1, { active: true, entry: makeUsageAt(100.0, 25.0, { sentinel: USAGE_TOKEN_EXPIRED }) });
    const apiKey = makeAccount(1, { active: true, kind: "api_key", entry: makeUsageAt(null, 25.0, { sentinel: USAGE_API_KEY }) });
    const [fake, src] = source([expired]);

    await src.take();
    fake.accounts = [apiKey];
    expect((await src.take({ storeOnly: true })).accounts[0]!.usage.sentinel).toBe(USAGE_API_KEY);
  });

  it("test_expired_sentinel_clears_on_identity_replacement", async () => {
    const expired = makeAccount(1, {
      active: true,
      email: "old@example.com",
      entry: makeUsageAt(100.0, 25.0, { sentinel: USAGE_TOKEN_EXPIRED }),
    });
    const replacement = makeAccount(1, { active: true, email: "new@example.com", entry: makeUsageAt(100.0) });
    const [fake, src] = source([expired]);

    await src.take();
    fake.accounts = [replacement];
    expect((await src.take({ storeOnly: true })).accounts[0]!.usage.sentinel).toBeNull();
  });

  it("test_late_worker_fetched_at_regression_is_rejected", async () => {
    const newer = makeAccount(1, { active: true, entry: makeUsageAt(200.0, 80.0) });
    const older = makeAccount(1, { active: true, entry: makeUsageAt(100.0, 10.0) });
    const [fake, src] = source([newer]);

    await src.take();
    fake.accounts = [older];
    const usage = (await src.take({ storeOnly: true })).accounts[0]!.usage;
    expect(usage.fetchedAt).toBe(200.0);
    expect(usage.lastGood!.five_hour!.pct).toBe(80.0);
  });

  it("test_late_expired_sentinel_cannot_replace_newer_usage", async () => {
    const newer = makeAccount(1, { active: true, entry: makeUsageAt(200.0, 80.0) });
    const older = makeAccount(1, { active: true, entry: makeUsageAt(100.0, 10.0, { sentinel: USAGE_TOKEN_EXPIRED }) });
    const [fake, src] = source([newer]);

    await src.take();
    fake.accounts = [older];
    const usage = (await src.take({ storeOnly: true })).accounts[0]!.usage;
    expect(usage.sentinel).toBeNull();
    expect(usage.fetchedAt).toBe(200.0);
    expect(usage.lastGood!.five_hour!.pct).toBe(80.0);
  });
});

describe("TestUsageRows", () => {
  it("test_absent_window_produces_no_row", () => {
    const entry = makeEntry(47.0, null);
    expect(usageRows(entry.lastGood, nowS()).map(([label]) => label)).toEqual(["5h"]);
  });

  it("test_scoped_models_and_over_limit_marker", () => {
    const entry = makeEntry(25.0, 10.0, {
      scoped: [
        ["Fable", 100.0],
        ["Opus", 12.0],
      ],
    });
    const rows = usageRows(entry.lastGood, nowS());
    expect(rows.map(([label]) => label)).toEqual(["5h", "7d", "Fable", "Opus"]);
    const fable = rows.find((row) => row[0] === "Fable")!;
    expect(fable[2]).toContain("(!)");
    // The marker stays last in the variant with the clock too.
    expect(fable[3].endsWith("(!)") && fable[3].includes(" · ")).toBe(true);
  });

  it("test_spend_row_first_with_amounts", () => {
    const entry = makeEntry(25.0, 10.0, { spend: { used: 12.5, limit: 50.0, pct: 25.0, currency: "USD" } });
    const rows = usageRows(entry.lastGood, nowS());
    expect(rows[0]![0]).toBe("$$");
    expect(rows[0]![2]).toContain("$12.50 / $50.00");
  });

  it("test_suffix_full_extends_countdown_with_clock", () => {
    const row5 = usageRows(makeEntry(47.0).lastGood, nowS())[0]!;
    expect(row5[2].startsWith("resets ")).toBe(true);
    expect(row5[3].startsWith(`${row5[2]} · `)).toBe(true);
  });

  it("test_spend_clock_sits_with_reset_not_after_amounts", () => {
    const entry = makeEntry(25.0, 10.0, {
      spend: { used: 12.5, limit: 50.0, pct: 25.0, currency: "USD", resets_at: isoIn(7200) },
    });
    const spend = usageRows(entry.lastGood, nowS())[0]!;
    expect(spend[0]).toBe("$$");
    expect(spend[3]).toContain(" · ");
    expect(spend[3].indexOf(" · ")).toBeLessThan(spend[3].indexOf("$12.50"));
  });

  it("test_no_data_no_rows", () => {
    expect(usageRows(null, nowS())).toEqual([]);
    expect(usageRows({}, nowS())).toEqual([]);
  });

  it("test_seven_day_ahead_of_pace_marker", () => {
    // One day of the week elapsed and 50% used: far ahead of the ~14% expected.
    const now = nowS();
    const lastGood = { seven_day: { pct: 50.0, resets_at: isoIn(86400 * 6) } };
    const row = usageRows(lastGood, now, now)[0]!;
    expect(row[2]).toContain("(ahead of pace)");
    expect(row[3]).toContain("(ahead of pace)");
  });

  it("test_five_hour_never_shows_pace_marker", () => {
    const now = nowS();
    const lastGood = { five_hour: { pct: 90.0, resets_at: isoIn(3600 * 4) } };
    expect(usageRows(lastGood, now, now)[0]![2]).not.toContain("pace");
  });

  it("test_scoped_ahead_of_pace_marker", () => {
    const now = nowS();
    const lastGood = { scoped: [{ name: "Fable", pct: 50.0, resets_at: isoIn(86400 * 6) }] };
    expect(usageRows(lastGood, now, now)[0]![2]).toContain("(ahead of pace)");
  });

  it("test_maxed_scoped_marker_wins_over_pace", () => {
    const now = nowS();
    const lastGood = { scoped: [{ name: "Fable", pct: 100.0, resets_at: isoIn(86400 * 6) }] };
    const row = usageRows(lastGood, now, now)[0]!;
    expect(row[2]).toContain("(!)");
    expect(row[2]).not.toContain("ahead of pace");
  });

  it("test_no_pace_marker_without_fetched_at", () => {
    const lastGood = { seven_day: { pct: 50.0, resets_at: isoIn(86400 * 6) } };
    expect(usageRows(lastGood, nowS())[0]![2]).not.toContain("pace");
  });

  it("test_card_shows_clock_only_where_it_fits", () => {
    // A wide card shows every clock. A mid width keeps the 5h and 7d clocks, but the longer
    // spend row falls back to its countdown. A narrow card shows the countdowns only.
    const entry = makeEntry(25.0, 10.0, {
      spend: { used: 12.5, limit: 50.0, pct: 25.0, currency: "USD", resets_at: isoIn(7200) },
    });
    const acc = makeAccount(1, { active: true, entry });

    expect(count(accountCardText(acc, 100).plain, " · ")).toBe(3);

    const midLines = accountCardText(acc, 78).plain.split("\n");
    const spendLine = midLines.find((line) => line.includes("$12.50"))!;
    expect(spendLine).not.toContain(" · ");
    for (const line of midLines) {
      if (line.includes("resets") && !line.includes("$12.50")) expect(line).toContain(" · ");
    }

    expect(accountCardText(acc, 40).plain).not.toContain(" · ");
  });
});

describe("TestMiniAccountText", () => {
  it("test_seven_day_ahead_of_pace_marker", () => {
    const now = nowS();
    const entry = new UsageEntry({ lastGood: { seven_day: { pct: 50.0, resets_at: isoIn(86400 * 6) } }, fetchedAt: now, ageS: 0.0 });
    expect(miniAccountText(makeAccount(1, { entry }), now).plain).toContain("(ahead)");
  });

  it("test_five_hour_never_shows_pace_marker", () => {
    const now = nowS();
    const entry = new UsageEntry({ lastGood: { five_hour: { pct: 90.0, resets_at: isoIn(3600 * 4) } }, fetchedAt: now, ageS: 0.0 });
    expect(miniAccountText(makeAccount(1, { entry }), now).plain).not.toContain("pace");
  });

  it("test_no_pace_marker_without_fetched_at", () => {
    const now = nowS();
    const entry = new UsageEntry({ lastGood: { seven_day: { pct: 50.0, resets_at: isoIn(86400 * 6) } }, fetchedAt: null, ageS: null });
    expect(miniAccountText(makeAccount(1, { entry }), now).plain).not.toContain("pace");
  });
});

describe("TestRunAction", () => {
  it("test_captures_output_and_payload", async () => {
    const result = await tuiData.runAction(() => {
      process.stdout.write("hello\n");
      return { switched: true };
    });
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ switched: true });
    expect(result.output).toContain("hello");
  });

  it("test_switch_error_is_captured_not_raised", async () => {
    const result = await tuiData.runAction(() => {
      throw new ClaudeSwitchError("boom");
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("boom");
  });

  it("test_unexpected_input_becomes_eoferror", async () => {
    const result = await tuiData.runAction(() => {
      switcherInternals.input("should not block");
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("interactive input");
  });

  it("test_first_line_strips_ansi", async () => {
    const result = await tuiData.runAction(() => {
      process.stdout.write("\x1b[1mBold headline\x1b[0m\n");
    });
    expect(result.firstLine).toBe("Bold headline");
  });
});

describe("TestDashboard", () => {
  it("test_panel_shows_active_full_and_others_mini", async () => {
    const fake = new FakeSwitcher(
      [makeAccount(1, { active: true, entry: makeEntry(47.0, 63.0) }), makeAccount(2, { entry: makeEntry(92.0, 71.0) })],
      tmpPath(),
    );
    const pilot = await runTest(makeApp(fake));
    await settle(pilot);
    const panel = pilot.frame();
    expect(panel).toContain("user1@example.com");
    expect(panel).toContain("● active");
    // The active card is the full one.
    expect(panel).toContain("resets");
    expect(panel).toContain("user2@example.com");
    expect(panel).toContain("92%");
    // The mini line has no bars: the bar glyphs are only in the active card.
    expect(after(panel, "user2@example.com")).not.toContain("━");
  });

  it("test_disabled_marker_on_active_card_and_mini", async () => {
    // A disabled account stays visible, with a marker: on the full card when it is active, on the mini line if not.
    const fake = new FakeSwitcher([makeAccount(1, { active: true, disabled: true }), makeAccount(2, { disabled: true })], tmpPath());
    const pilot = await runTest(makeApp(fake));
    await settle(pilot);
    const panel = pilot.frame();
    expect(panel).toContain("● active");
    expect(count(panel, "(disabled)")).toBe(2);
  });

  it("test_active_card_skips_absent_window_and_shows_scoped", async () => {
    const fake = new FakeSwitcher(
      [makeAccount(1, { active: true, entry: makeEntry(47.0, null, { scoped: [["Fable", 62.0]] }) })],
      tmpPath(),
    );
    const pilot = await runTest(makeApp(fake));
    await settle(pilot);
    const panel = pilot.frame();
    expect(panel).toContain("5h");
    // An annual plan: no invented row.
    expect(panel).not.toContain("7d");
    expect(panel).not.toContain("usage unknown");
    expect(panel).toContain("Fable");
    expect(panel).toContain("62%");
  });

  it("test_mini_line_skips_absent_window", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2, { entry: makeEntry(92.0, null) })], tmpPath());
    const pilot = await runTest(makeApp(fake));
    await settle(pilot);
    const miniPart = after(pilot.frame(), "user2@example.com");
    expect(miniPart).toContain("5h 92%");
    expect(miniPart).not.toContain("7d");
  });

  it("test_menu_is_default_navigation_and_nests", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true })], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app);
    await settle(pilot);
    expect(menuIds(app)).toEqual(["switch", "watch", "auto", "add-menu", "disable-menu", "remove-menu", "theme-menu", "quit"]);
    // Go into Add (index 3), then back out with escape.
    await pilot.press("down", "down", "down", "enter");
    await pilot.pause();
    expect(menuIds(app)).toEqual(["add-login", "add-token", "back"]);
    expect(pilot.frame()).toContain("menu › add account");
    await pilot.press("escape");
    await pilot.pause();
    expect(menuIds(app)[0]).toBe("switch");
  });

  it("test_remove_menu_shows_alias_before_email", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true, alias: "dev" }), makeAccount(2, { email: "plain@example.com" })], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app);
    await settle(pilot);
    await menuSelect(pilot, "remove-menu");
    const labels = menuLabels(app);
    expect(labels.some((label) => label.includes("dev (user1@example.com)"))).toBe(true);
    expect(labels.some((label) => label.includes("plain@example.com"))).toBe(true);
    expect(labels.some((label) => label.includes("(plain@example.com)"))).toBe(false);
    expect(pilot.frame()).toContain("dev (user1@example.com)");
  });

  it("test_remove_menu_label_renders_bracket_tag_literally", async () => {
    // An org name of "red" makes the tag "[red]", a valid Rich markup tag. The menu must show it as text.
    const fake = new FakeSwitcher([accountSnapshot({ ...makeAccount(1, { active: true }), orgName: "red" })], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app);
    await settle(pilot);
    await menuSelect(pilot, "remove-menu");
    expect(menuLabels(app).some((label) => label.includes("[red]"))).toBe(true);
    expect(after(pilot.frame(), "remove account")).toContain("[red]");
  });

  it("test_back_menu_entry_pops_submenu", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true })], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app);
    await settle(pilot);
    await menuSelect(pilot, "add-menu");
    await menuSelect(pilot, "back");
    expect(menuIds(app)[0]).toBe("switch");
  });

  it("test_vim_keys_move_menu_cursor", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true })], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app);
    await settle(pilot);
    expect(dashboard(app).menuIndex).toBe(0);
    await pilot.press("j");
    expect(dashboard(app).menuIndex).toBe(1);
    await pilot.press("k");
    expect(dashboard(app).menuIndex).toBe(0);
  });

  it("test_s_opens_switch_screen_and_enter_switches", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app);
    await settle(pilot);
    await pilot.press("s");
    await pilot.pause();
    expect(app.screen).toBeInstanceOf(SwitchScreen);
    const screen = app.screen as unknown as SwitchScreen;
    expect(screen.accounts.map((acc) => acc.number)).toEqual(["1", "2"]);
    // The cursor starts on the active account.
    expect(screen.index).toBe(0);
    expect(pilot.frame()).toContain("switch to which account?");
    await pilot.press("down", "enter");
    await settle(pilot);
    expect(fake.calls).toContainEqual(["switch_to", "2"]);
    expect(app.screen).toBeInstanceOf(DashboardScreen);
    expect(app.snapshot!.activeNumber).toBe("2");
  });

  it("test_switch_screen_escape_backs_out", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app);
    await settle(pilot);
    // The first menu entry: Switch account…
    await pilot.press("enter");
    await pilot.pause();
    expect(app.screen).toBeInstanceOf(SwitchScreen);
    await pilot.press("escape");
    await pilot.pause();
    expect(app.screen).toBeInstanceOf(DashboardScreen);
    expect(fake.calls.some((call) => call[0] === "switch_to")).toBe(false);
  });

  it("test_remove_via_menu_confirms_then_removes", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app);
    await settle(pilot);
    await menuSelect(pilot, "remove-menu");
    await menuSelect(pilot, "remove:2");
    expect(app.screen).toBeInstanceOf(ConfirmModal);
    expect(pilot.frame()).toContain("Remove account 2 (user2@example.com)?");
    await pilot.press("y");
    await settle(pilot);
    expect(fake.calls).toContainEqual(["remove", "2", true]);
  });

  it("test_remove_via_menu_cancel_is_safe", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app);
    await settle(pilot);
    await menuSelect(pilot, "remove-menu");
    await menuSelect(pilot, "remove:1");
    await pilot.press("n");
    await settle(pilot);
    expect(fake.calls.some((call) => call[0] === "remove")).toBe(false);
  });

  it("test_disable_via_menu_toggles_without_confirm", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app);
    await settle(pilot);
    await menuSelect(pilot, "disable-menu");
    // No modal: the action runs at once.
    await menuSelect(pilot, "disable:2");
    await settle(pilot);
    expect(fake.calls).toContainEqual(["set_disabled", "2", true]);
    // The submenu goes back to the root after the toggle.
    expect(menuIds(app)[0]).toBe("switch");
  });

  it("test_disable_menu_row_reflects_state_and_re_enables", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2, { disabled: true })], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app);
    await settle(pilot);
    await menuSelect(pilot, "disable-menu");
    const labels = menuLabels(app);
    // The disabled account offers to enable, the active one to disable.
    expect(labels.some((label) => label.includes("(disabled)") && label.includes("enable"))).toBe(true);
    expect(labels.some((label) => label.includes("disable") && !label.includes("(disabled)"))).toBe(true);
    await menuSelect(pilot, "disable:2");
    await settle(pilot);
    expect(fake.calls).toContainEqual(["set_disabled", "2", false]);
  });

  it("test_modal_arrow_keys_choose_button", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app);
    await settle(pilot);
    await menuSelect(pilot, "remove-menu");
    await menuSelect(pilot, "remove:2");
    // The focus starts on the confirm button. → moves to Cancel, and Enter presses it.
    await pilot.press("right", "enter");
    await settle(pilot);
    expect(fake.calls.some((call) => call[0] === "remove")).toBe(false);
    // Open it again (the menu cursor is still on account 2), ← goes back to confirm, press it.
    await pilot.press("enter");
    await pilot.pause();
    await pilot.press("right", "left", "enter");
    await settle(pilot);
    expect(fake.calls).toContainEqual(["remove", "2", true]);
  });

  it("test_full_refresh_binding", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true })], tmpPath());
    const pilot = await runTest(makeApp(fake));
    await settle(pilot);
    await pilot.press("f");
    await settle(pilot);
    // A full pass on demand.
    expect(fake.fetchSets[fake.fetchSets.length - 1]).toBeNull();
  });

  it("test_add_token_via_menu_passes_assume_yes", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true })], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await settle(pilot);
    await menuSelect(pilot, "add-menu");
    await menuSelect(pilot, "add-token");
    expect(app.screen).toBeInstanceOf(AddTokenModal);
    await pilot.type("sk-ant-oat01-test");
    await pilot.press("tab", "tab");
    await pilot.type("5");
    // Tab to the Add button and press it.
    await pilot.press("tab", "enter");
    await settle(pilot);
    expect(fake.calls).toContainEqual(["add_token", "sk-ant-oat01-test", null, 5, true]);
  });

  it("test_add_token_occupied_slot_asks_first", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await settle(pilot);
    await menuSelect(pilot, "add-menu");
    await menuSelect(pilot, "add-token");
    await pilot.type("sk-ant-oat01-test");
    await pilot.press("tab", "tab");
    await pilot.type("2");
    await pilot.press("tab", "enter");
    await pilot.pause();
    // The overwrite confirmation.
    expect(app.screen).toBeInstanceOf(ConfirmModal);
    await pilot.press("n");
    await settle(pilot);
    expect(fake.calls.some((call) => call[0] === "add_token")).toBe(false);
  });

  it("test_empty_state_hint_in_panel", async () => {
    const fake = new FakeSwitcher([], tmpPath());
    const pilot = await runTest(makeApp(fake));
    await settle(pilot);
    expect(pilot.frame()).toContain("No managed accounts yet");
  });

  it("test_palette_is_disabled", () => {
    expect(CswapApp.ENABLE_COMMAND_PALETTE).toBe(false);
  });
});

describe("TestWatchScreen", () => {
  function fakeSwitcher(): FakeSwitcher {
    return new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
  }

  function watch(app: CswapApp): WatchScreen {
    expect(app.screen).toBeInstanceOf(WatchScreen);
    return app.screen as unknown as WatchScreen;
  }

  it("test_w_opens_monitor_without_cursor", async () => {
    const fake = fakeSwitcher();
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await settle(pilot);
    await pilot.press("w");
    await pilot.pause();
    const screen = watch(app);
    // Full cards.
    expect(screen.accounts.length).toBe(2);
    expect(count(pilot.frame(), "5h ")).toBe(2);
    // The monitor mode: no cursor at all.
    expect(screen.index).toBeNull();
    // Enter does nothing while the screen only watches.
    await pilot.press("enter");
    await settle(pilot);
    expect(fake.calls.some((call) => call[0] === "switch_to")).toBe(false);
  });

  it("test_s_arms_selection_switch_stays_watching", async () => {
    const fake = fakeSwitcher();
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await settle(pilot);
    await pilot.press("w");
    await pilot.pause();
    await pilot.press("s");
    await pilot.pause();
    // The cursor is armed, on the active account.
    expect(watch(app).index).toBe(0);
    await pilot.press("down", "enter");
    await settle(pilot);
    expect(fake.calls).toContainEqual(["switch_to", "2"]);
    // The screen stays on the monitor.
    expect(watch(app).index).toBeNull();
    expect(app.snapshot!.activeNumber).toBe("2");
  });

  it("test_escape_disarms_then_leaves", async () => {
    const fake = fakeSwitcher();
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await settle(pilot);
    await pilot.press("w");
    await pilot.pause();
    await pilot.press("s");
    await pilot.pause();
    // Disarm the selection only.
    await pilot.press("escape");
    await pilot.pause();
    expect(watch(app).index).toBeNull();
    // Now leave.
    await pilot.press("escape");
    await pilot.pause();
    expect(app.screen).toBeInstanceOf(DashboardScreen);
    expect(fake.calls.some((call) => call[0] === "switch_to")).toBe(false);
  });

  it("test_menu_watch_entry_opens_it", async () => {
    const app = makeApp(fakeSwitcher());
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await settle(pilot);
    await menuSelect(pilot, "watch");
    expect(app.screen).toBeInstanceOf(WatchScreen);
  });

  it("test_app_start_watch_stacks_over_dashboard", async () => {
    const app = makeApp(fakeSwitcher(), { start: "watch" });
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await settle(pilot);
    expect(app.screen).toBeInstanceOf(WatchScreen);
    expect(pilot.frame()).toContain("watching all accounts");
    await pilot.press("escape");
    await pilot.pause();
    expect(app.screen).toBeInstanceOf(DashboardScreen);
  });

  it("test_blocked_normal_allows_store_only_repaint_without_stale_overpaint", async () => {
    const normal = makeAccount(1, { active: true, entry: makeUsageAt(100.0, 10.0) });
    const store = makeAccount(1, { active: true, entry: makeUsageAt(200.0, 80.0) });
    const fake = new BlockingSnapshotSwitcher(normal, store, tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });

    await waitEvent(fake.normalStarted);
    app.tick();
    await waitEvent(fake.storeDone);
    await pilot.pause();
    expect(app.snapshot!.accounts[0]!.usage.lastGood!.five_hour!.pct).toBe(80.0);

    fake.normalRelease.set();
    await waitEvent(fake.normalDone);
    await pilot.pause();
    expect(app.snapshot!.accounts[0]!.usage.lastGood!.five_hour!.pct).toBe(80.0);
    expect(fake.fetchSets).toEqual([null, new Set()]);
  });

  it("test_late_normal_can_advance_usage_after_store_repaint", async () => {
    const normal = makeAccount(1, { active: true, entry: makeUsageAt(200.0, 80.0) });
    const store = makeAccount(1, { active: true, entry: makeUsageAt(100.0, 10.0) });
    const fake = new BlockingSnapshotSwitcher(normal, store, tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });

    await waitEvent(fake.normalStarted);
    app.tick();
    await waitEvent(fake.storeDone);
    await pilot.pause();
    expect(app.snapshot!.accounts[0]!.usage.lastGood!.five_hour!.pct).toBe(10.0);

    fake.normalRelease.set();
    await waitEvent(fake.normalDone);
    await pilot.pause();
    expect(app.snapshot!.accounts[0]!.usage.lastGood!.five_hour!.pct).toBe(80.0);
  });

  it("test_repeated_ticks_keep_store_lane_single_flight", async () => {
    const normal = makeAccount(1, { active: true, entry: makeUsageAt(100.0, 10.0) });
    const store = makeAccount(1, { active: true, entry: makeUsageAt(200.0, 80.0) });
    const fake = new BlockingSnapshotSwitcher(normal, store, tmpPath());
    fake.blockStore = true;
    const app = makeApp(fake);
    await runTest(app, { columns: 100, rows: 40 });

    await waitEvent(fake.normalStarted);
    app.tick();
    await waitEvent(fake.storeStarted);
    app.tick();
    app.tick();
    expect(fake.fetchSets).toEqual([null, new Set()]);
    fake.storeRelease.set();
    fake.normalRelease.set();
    await waitEvent(fake.storeDone);
    await waitEvent(fake.normalDone);
  });

  it("test_store_only_mode_launches_only_store_lane", async () => {
    const fake = fakeSwitcher();
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await settle(pilot);
    fake.fetchSets.length = 0;
    app.setStoreOnly(true);
    await settle(pilot);
    expect(fake.fetchSets).toEqual([new Set()]);
  });

  it("test_watch_title_shows_snapshot_age_and_long_refresh", async () => {
    const app = makeApp(fakeSwitcher());
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await settle(pilot);
    await pilot.press("w");
    await pilot.pause();
    const screen = watch(app);
    // A fresh snapshot stays quiet: the age note is an alarm for staleness.
    expect(screen.titleText()).not.toContain("snapshot");
    app.snapshot = { ...app.snapshot!, takenAt: nowS() - CswapApp.SNAPSHOT_AGE_NOTE_S - 1.0 };
    app.updateRefreshStatus();
    await pilot.pause();
    expect(screen.titleText()).toContain("snapshot 1m ago");
    expect(pilot.frame()).toContain("watching all accounts · snapshot 1m ago");
    app.normalRefreshing = true;
    app.normalStartedAt = nowS() - CswapApp.POLL_INTERVAL_S - 1.0;
    app.updateRefreshStatus();
    await pilot.pause();
    expect(screen.titleText()).toContain("refreshing");
    expect(pilot.frame()).toContain("refreshing");
  });
});

/** A stand-in for AutoSwitchEngine: it records its construction and runs until `stop()`. */
class FakeEngine {
  static instances: FakeEngine[] = [];
  settings: AutoSwitchSettings;
  onEvent: (event: AutoSwitchEvent) => void;
  dryRun: boolean;
  stopped = false;
  appliedThresholds: number[] = [];
  wakes = 0;
  private stopEvent = new TestEvent();

  constructor(_switcher: unknown, settings: AutoSwitchSettings, onEvent: (event: AutoSwitchEvent) => void, { dryRun = false }: { dryRun?: boolean } = {}) {
    this.settings = settings;
    this.onEvent = onEvent;
    this.dryRun = dryRun;
    FakeEngine.instances.push(this);
  }

  async runLoop(_options: { signal?: AbortSignal } = {}): Promise<number> {
    this.onEvent(new NoSwitchEvent({ reason: "cooldown" }));
    await this.stopEvent.wait(30_000);
    return 0;
  }

  stop(): void {
    this.stopped = true;
    this.stopEvent.set();
  }

  applyThreshold(threshold: number): void {
    this.settings = { ...this.settings, threshold };
    this.appliedThresholds.push(threshold);
  }

  wake(): void {
    this.wakes += 1;
  }
}

describe("TestAutoScreen", () => {
  const savedEngine = autoviewInternals.AutoSwitchEngine;

  beforeEach(() => {
    FakeEngine.instances = [];
    autoviewInternals.AutoSwitchEngine = FakeEngine;
  });

  afterEach(() => {
    autoviewInternals.AutoSwitchEngine = savedEngine;
  });

  async function open(pilot: Pilot): Promise<void> {
    await settle(pilot);
    await pilot.press("g");
    await pilot.pause();
  }

  function auto(app: CswapApp): AutoScreen {
    expect(app.screen).toBeInstanceOf(AutoScreen);
    return app.screen as unknown as AutoScreen;
  }

  it("test_opens_in_dry_run_and_store_only", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await open(pilot);
    const screen = auto(app);
    expect(FakeEngine.instances.length).toBe(1);
    expect(FakeEngine.instances[0]!.dryRun).toBe(true);
    expect(app.storeOnly).toBe(true);
    await settle(pilot);
    // The engine event reached the log.
    expect(screen.log.some((line) => line.plain.includes("no switch: cooldown"))).toBe(true);
    const frame = pilot.frame();
    expect(frame).toContain("DRY-RUN");
    expect(frame).toContain("no switch: cooldown");
  });

  it("test_go_live_requires_confirmation", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await open(pilot);
    await pilot.press("l");
    await pilot.pause();
    expect(app.screen).toBeInstanceOf(ConfirmModal);
    await pilot.press("y");
    await settle(pilot);
    expect(FakeEngine.instances.length).toBe(2);
    expect(FakeEngine.instances[0]!.stopped).toBe(true);
    expect(FakeEngine.instances[1]!.dryRun).toBe(false);
    expect(pilot.frame()).toContain(" LIVE ");
  });

  it("test_back_stops_engine_and_restores_fetching", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await open(pilot);
    await pilot.press("escape");
    await settle(pilot);
    expect(app.screen).toBeInstanceOf(DashboardScreen);
    expect(FakeEngine.instances[0]!.stopped).toBe(true);
    expect(app.storeOnly).toBe(false);
  });

  it("test_threshold_adjust_is_session_only", async () => {
    const dir = tmpPath();
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], dir);
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await open(pilot);
    const screen = auto(app);
    // The mount uses the file value.
    expect(app.thresholdPct).toBe(90.0);
    // Inert outside the adjust mode.
    await pilot.press("right");
    await pilot.pause();
    expect(screen.settings.threshold).toBe(90.0);
    await pilot.press("t", "right", "right", "right");
    await pilot.pause();
    expect(screen.settings.threshold).toBe(93.0);
    expect(app.thresholdPct).toBe(93.0);
    const engine = FakeEngine.instances[0]!;
    expect(engine.appliedThresholds).toEqual([91.0, 92.0, 93.0]);
    expect(screen.summaryText().plain).toContain("threshold 93% (session)");
    expect(pilot.frame()).toContain("threshold 93% (session)");
    await pilot.press("enter");
    await pilot.pause();
    // One forced tick at the end of the adjust mode.
    expect(engine.wakes).toBe(1);
    // The override is in memory only: nothing was written.
    expect(fs.existsSync(path.join(dir, "settings.json"))).toBe(false);
    // A dry/live restart builds the engine from the adjusted copy.
    await pilot.press("l");
    await pilot.pause();
    await pilot.press("y");
    await settle(pilot);
    expect(FakeEngine.instances[1]!.settings.threshold).toBe(93.0);
    await pilot.press("escape");
    await settle(pilot);
    // To leave the screen restores the tick and frees the poll planner.
    expect(app.thresholdPct).toBe(90.0);
    expect(fake.pollInputsOverride).toBeNull();
  });

  it("test_threshold_adjust_escape_exits_mode_not_screen", async () => {
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], tmpPath());
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await open(pilot);
    await pilot.press("t");
    await pilot.pause();
    await pilot.press("escape");
    await pilot.pause();
    expect(app.screen).toBeInstanceOf(AutoScreen);
    // No net change: no forced tick.
    expect(FakeEngine.instances[0]!.wakes).toBe(0);
    await pilot.press("escape");
    await settle(pilot);
    expect(app.screen).toBeInstanceOf(DashboardScreen);
  });

  it("test_threshold_clamps_and_keeps_meaningful_decimals", async () => {
    const dir = tmpPath();
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ schemaVersion: 1, autoswitch: { threshold: 99.0 } }));
    const fake = new FakeSwitcher([makeAccount(1, { active: true }), makeAccount(2)], dir);
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await open(pilot);
    const screen = auto(app);
    await pilot.press("t", "right", "right");
    await pilot.pause();
    // The upper bound of the spec.
    expect(screen.settings.threshold).toBe(99.9);
    // Never a false "100%".
    expect(screen.summaryText().plain).toContain("threshold 99.9% (session)");
    screen.actionThresholdStep(-60.0);
    await pilot.pause();
    // The lower bound of the spec.
    expect(screen.settings.threshold).toBe(50.0);
  });

  it("test_candidates_ranked_by_headroom", async () => {
    const fake = new FakeSwitcher(
      [
        makeAccount(1, { active: true, entry: makeEntry(91.0, 20.0) }),
        makeAccount(2, { entry: makeEntry(80.0, 10.0) }),
        makeAccount(3, { entry: makeEntry(15.0, 5.0) }),
      ],
      tmpPath(),
    );
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await open(pilot);
    await settle(pilot);
    const snap = app.snapshot!;
    const plain = auto(app).candidatesText(snap, snap.activeNumber).plain;
    expect(plain.indexOf("user3@example.com")).toBeLessThan(plain.indexOf("user2@example.com"));
    const frame = after(pilot.frame(), "Next best");
    expect(frame.indexOf("user3@example.com")).toBeLessThan(frame.indexOf("user2@example.com"));
  });

  it("test_candidates_ranking_honors_configured_model", async () => {
    // The "Next best" ranking uses the window set of the engine: with autoswitch.model set,
    // an account bound by Fable ranks by its Fable pct, not by its roomy 5h.
    const dir = tmpPath();
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ schemaVersion: 1, autoswitch: { model: "Fable" } }));
    const fake = new FakeSwitcher(
      [
        makeAccount(1, { active: true, entry: makeEntry(91.0, 20.0) }),
        makeAccount(2, { entry: makeEntry(10.0, 5.0, { scoped: [["Fable", 95.0]] }) }),
        makeAccount(3, { entry: makeEntry(50.0, 5.0, { scoped: [["Fable", 20.0]] }) }),
      ],
      dir,
    );
    const app = makeApp(fake);
    const pilot = await runTest(app, { columns: 100, rows: 40 });
    await open(pilot);
    await settle(pilot);
    const snap = app.snapshot!;
    const plain = auto(app).candidatesText(snap, snap.activeNumber).plain;
    // On 5h only, #2 (10% used) ranks first. Fable 95% binds it below #3 (50% binding).
    expect(plain.indexOf("user3@example.com")).toBeLessThan(plain.indexOf("user2@example.com"));
  });
});

describe("TestEventText", () => {
  it("test_switch_event_styling_and_content", () => {
    const event = new SwitchEvent({
      trigger: "proactive",
      fromRef: { number: 1, email: "a@x.com" },
      toRef: { number: 2, email: "b@x.com" },
    });
    expect(eventText(event).plain).toContain(event.human());
  });

  it("test_event_text_uses_light_accent_for_switch", () => {
    const event = new SwitchEvent({
      trigger: "proactive",
      fromRef: { number: 1, email: "a@x.com" },
      toRef: { number: 2, email: "b@x.com" },
    });
    const text = eventText(event, { palette: Palette.fromTheme(CSWAP_LIGHT) });
    expect(text.spans.some((span) => span.style.includes(ACCENT_LIGHT))).toBe(true);
  });
});

describe("TestAccountsSnapshot", () => {
  it("test_one_pass_snapshot", async () => {
    mockClaudeConfig();
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.initSequenceFile();
    const data = switcher.getSequenceData()! as unknown as Record<string, unknown>;
    data.sequence = [1, 2];
    data.accounts = {
      "1": { email: "test@example.com", uuid: "test-uuid-1234" },
      "2": { email: "other@example.com", uuid: "uuid-2" },
    };
    switcher.writeJson(switcher.sequenceFile, data);

    // Store only: no network.
    const snap = await switcher.accountsSnapshot(new Set());
    expect(snap.activeNumber).toBe("1");
    expect(snap.accounts.map((acc) => acc.number)).toEqual(["1", "2"]);
    const active = snap.accounts[0]!;
    expect(active.isActive).toBe(true);
    expect(active.email).toBe("test@example.com");
    expect(snap.accounts.every((acc) => acc.kind === "oauth")).toBe(true);
    // No stored credential backups: no account is switchable, and the usage has a sentinel, not a fetch.
    expect(snap.accounts.every((acc) => !acc.switchable)).toBe(true);
    expect(snap.accounts.every((acc) => acc.usage.sentinel !== null)).toBe(true);
    expect(typeof snap.takenAt).toBe("number");
  });
});

describe("TestBareInvocation", () => {
  async function runCli(argv: string[]): Promise<number | undefined> {
    try {
      await cli.main(argv);
    } catch (error) {
      if (error instanceof SystemExit) return error.code;
      throw error;
    }
    return undefined;
  }

  it("test_bare_tty_launches_tui", async () => {
    mockClaudeConfig();
    const launched: { switcher?: unknown } = {};
    vi.spyOn(cli.internals, "stdoutIsatty").mockReturnValue(true);
    vi.spyOn(cli.internals, "stdinIsatty").mockReturnValue(true);
    vi.spyOn(cli.internals, "loadTui").mockResolvedValue(async (switcher) => {
      launched.switcher = switcher;
      return 0;
    });
    expect(await runCli([])).toBe(0);
    expect(launched.switcher).toBeDefined();
  });

  it("test_bare_non_tty_keeps_usage_error", async () => {
    mockClaudeConfig();
    vi.spyOn(cli.internals, "stdoutIsatty").mockReturnValue(false);
    vi.spyOn(cli.internals, "stdinIsatty").mockReturnValue(false);
    const out = captureOutput();
    expect(await runCli([])).toBe(2);
    expect(out.readouterr().err).toContain("usage:");
  });

  it("test_cswap_watch_opens_tui_on_watch_page", async () => {
    mockClaudeConfig();
    const launched: { start?: string } = {};
    vi.spyOn(cli.internals, "loadTui").mockResolvedValue(async (_switcher, start = "dashboard") => {
      launched.start = start;
      return 0;
    });
    expect(await runCli(["watch"])).toBe(0);
    expect(launched.start).toBe("watch");
  });
});

describe("TestThemeWiring", () => {
  function writeSettings(dir: string, theme: string): void {
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ ui: { theme } }));
  }

  it("test_mount_selects_light_theme_from_settings", async () => {
    const dir = tmpPath();
    writeSettings(dir, "light");
    const app = makeApp(new FakeSwitcher([makeAccount("1", { active: true })], dir));
    const pilot = await runTest(app, { columns: 80, rows: 24 });
    await settle(pilot);
    expect(app.theme).toBe("cswap-light");
  });

  it("test_auto_setting_uses_detected_light", async () => {
    const dir = tmpPath();
    writeSettings(dir, "auto");
    const app = makeApp(new FakeSwitcher([makeAccount("1", { active: true })], dir), { detected: "light" });
    const pilot = await runTest(app, { columns: 80, rows: 24 });
    await settle(pilot);
    expect(app.theme).toBe("cswap-light");
  });

  it("test_auto_setting_no_detection_falls_back_to_dark", async () => {
    const dir = tmpPath();
    writeSettings(dir, "auto");
    const app = makeApp(new FakeSwitcher([makeAccount("1", { active: true })], dir), { detected: null });
    const pilot = await runTest(app, { columns: 80, rows: 24 });
    await settle(pilot);
    expect(app.theme).toBe("cswap-dark");
  });

  it("test_toggle_cycles_dark_light_auto", async () => {
    const dir = tmpPath();
    writeSettings(dir, "dark");
    const app = makeApp(new FakeSwitcher([makeAccount("1", { active: true })], dir), { detected: "light" });
    const pilot = await runTest(app, { columns: 80, rows: 24 });
    await settle(pilot);
    // The setting is dark.
    expect(app.theme).toBe("cswap-dark");
    app.actionToggleTheme();
    await pilot.pause();
    expect(app.theme).toBe("cswap-light");
    // auto, with light detected.
    app.actionToggleTheme();
    await pilot.pause();
    expect(app.theme).toBe("cswap-light");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).ui.theme).toBe("auto");
    app.actionToggleTheme();
    await pilot.pause();
    expect(app.theme).toBe("cswap-dark");
  });

  it("test_theme_menu_marks_current_and_applies", async () => {
    const app = makeApp(new FakeSwitcher([makeAccount("1", { active: true })], tmpPath()));
    const pilot = await runTest(app);
    await settle(pilot);
    // The default.
    expect(app.themeName).toBe("auto");
    await menuSelect(pilot, "theme-menu");
    const labels = menuLabels(app);
    expect(labels.some((label) => label.includes("dark"))).toBe(true);
    expect(labels.some((label) => label.includes("light"))).toBe(true);
    // The current theme has a mark.
    expect(labels.find((label) => label.includes("auto"))).toContain("●");
    await menuSelect(pilot, "theme:light");
    expect(app.themeName).toBe("light");
    expect(app.theme).toBe("cswap-light");
  });
});
