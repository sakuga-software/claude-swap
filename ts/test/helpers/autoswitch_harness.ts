import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import {
  type AutoSwitchEngineOptions,
  type AutoSwitchEvent,
  AutoSwitchEngine,
  NoSwitchEvent,
  STATE_FILENAME,
  type TickOutcome,
} from "../../src/autoswitch.js";
import { Platform } from "../../src/models.js";
import { type AutoSwitchSettings, autoSwitchSettings } from "../../src/settings.js";
import { isoformat } from "../../src/support/py.js";
import { ClaudeAccountSwitcher } from "../../src/switcher.js";
import { UsageEntry } from "../../src/usage_store.js";
import { testHome } from "./home.js";

/** A usage value as the tests write it: a usage dict, a sentinel string, or null. */
export type UsageValue = Record<string, unknown> | string | null;

/** Python `FakeClock`: call it for the time, read or set `.now`, or `.advance(s)`. */
export interface FakeClock {
  (): number;
  now: number;
  advance(seconds: number): void;
}

export function fakeClock(now = 1_000_000.0): FakeClock {
  const clock = (() => clock.now) as FakeClock;
  clock.now = now;
  clock.advance = (seconds: number) => {
    clock.now += seconds;
  };
  return clock;
}

/** An absolute epoch as the ISO-Z text of a window `resets_at`. */
export function isoAt(epoch: number): string {
  return isoformat(new Date(epoch * 1000)).replace("+00:00", "Z");
}

/** Python `_usage`: a 5h window at `pct` (with an optional reset) and a 7d window at 0. */
export function usage(pct: number, resetsAt: string | null = null): Record<string, unknown> {
  const window: Record<string, unknown> = { pct };
  if (resetsAt) window.resets_at = resetsAt;
  return { five_hour: window, seven_day: { pct: 0.0 } };
}

/** Python `_entry_for`: the store entry that a live fetch gives. */
export function entryFor(value: UsageValue | undefined, now: number): UsageEntry {
  if (typeof value === "string") return new UsageEntry({ sentinel: value });
  if (value) return new UsageEntry({ lastGood: value, fetchedAt: now, ageS: 0.0 });
  return new UsageEntry();
}

/**
 * Python `EngineHarness`: a seeded switcher on the Linux file backend, an engine on a
 * fake clock, and the captured events.
 *
 * `home` defaults to `testHome()`. With a different `home`, HOME and XDG_DATA_HOME
 * point there only during the construction, as in the Python harness. On such a
 * harness, do not call `makeLive()` or other code that resolves paths later.
 */
export class EngineHarness {
  readonly home: string;
  switcher: ClaudeAccountSwitcher;
  settings: AutoSwitchSettings;
  events: AutoSwitchEvent[] = [];
  clock: FakeClock = fakeClock();
  engine: AutoSwitchEngine;

  constructor(home: string | null = null, settings: Partial<AutoSwitchSettings> = {}) {
    this.home = home ?? testHome();
    const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
    process.env.HOME = this.home;
    process.env.XDG_DATA_HOME = path.join(this.home, ".local", "share");
    try {
      this.switcher = new ClaudeAccountSwitcher();
      this.switcher.platform = Platform.LINUX;
      this.switcher.setupDirectories();
      this.switcher.initSequenceFile();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    this.settings = autoSwitchSettings(settings);
    this.switcher.usageStore.clock = this.clock;
    this.engine = this.makeEngine();
  }

  makeEngine(options: AutoSwitchEngineOptions = {}): AutoSwitchEngine {
    return new AutoSwitchEngine(this.switcher, this.settings, (e) => this.events.push(e), {
      clock: this.clock,
      ...options,
    });
  }

  seed(num: number, email: string, { expiresAt = null }: { expiresAt?: number | null } = {}): void {
    const oauthBlob: Record<string, unknown> = { accessToken: `sk-${num}`, refreshToken: `rt-${num}` };
    if (expiresAt !== null) oauthBlob.expiresAt = expiresAt;
    this.switcher.writeAccountCredentials(String(num), email, JSON.stringify({ claudeAiOauth: oauthBlob }));
    this.switcher.writeAccountConfig(
      String(num),
      email,
      JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: `uuid-${num}` } }),
    );
    const data = this.switcher.getSequenceData()!;
    data.accounts ??= {};
    data.sequence ??= [];
    data.accounts[String(num)] = {
      email,
      uuid: `uuid-${num}`,
      organizationUuid: "",
      organizationName: "",
      added: "2024-01-01T00:00:00Z",
    };
    if (!data.sequence.includes(num)) {
      data.sequence.push(num);
      data.sequence.sort((a, b) => a - b);
    }
    if (data.activeAccountNumber == null) data.activeAccountNumber = num;
    this.switcher.writeJson(this.switcher.sequenceFile, data);
  }

  makeLive(email: string, num: number): void {
    fs.writeFileSync(
      path.join(this.home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-live", refreshToken: "rt-live" } }),
    );
    fs.writeFileSync(
      path.join(this.home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: `uuid-${num}` } }),
    );
  }

  async tickWithUsage(values: Record<string, UsageValue>): Promise<TickOutcome> {
    const entries: Record<string, UsageEntry> = {};
    for (const [num, value] of Object.entries(values)) entries[num] = entryFor(value, this.clock.now);
    return this.tickWithEntries(entries);
  }

  /** Python `patch.object(switcher, "usage_entries_by_account", return_value=entries)` around one tick. */
  async tickWithEntries(entries: Record<string, UsageEntry>): Promise<TickOutcome> {
    const spy = vi.spyOn(this.switcher, "usageEntriesByAccount").mockResolvedValue(entries);
    try {
      return await this.engine.tick();
    } finally {
      spy.mockRestore();
    }
  }

  activeNumber(): number | null {
    return (this.switcher.getSequenceData()?.activeAccountNumber as number | null | undefined) ?? null;
  }

  kinds(): string[] {
    return this.events.map((e) => e.kind);
  }

  reasons(): string[] {
    return this.events.filter((e): e is NoSwitchEvent => e instanceof NoSwitchEvent).map((e) => e.reason);
  }

  state(): Record<string, unknown> {
    const file = path.join(this.switcher.backupDir, STATE_FILENAME);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  }
}

/** Python `harness` fixture: accounts 1, 2, 3 seeded, and account 1 logged in. */
export function makeHarness(settings: Partial<AutoSwitchSettings> = {}): EngineHarness {
  const h = new EngineHarness(null, settings);
  h.seed(1, "a@example.com");
  h.seed(2, "b@example.com");
  h.seed(3, "c@example.com");
  h.makeLive("a@example.com", 1);
  return h;
}
