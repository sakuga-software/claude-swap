import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AllExhaustedEvent,
  IDLE_HOLD_MAX_S,
  NO_RESET_FALLBACK_S,
  NoSwitchEvent,
  PollEvent,
  RESET_SLACK_S,
  SwitchEvent,
  TickOutcome,
} from "../src/autoswitch.js";
import { USAGE_FOREIGN_CREDENTIAL, USAGE_TOKEN_EXPIRED } from "../src/json_output.js";
import { Platform } from "../src/models.js";
import * as oauth from "../src/oauth.js";
import * as pollPolicy from "../src/poll_policy.js";
import type { AutoSwitchSettings } from "../src/settings.js";
import { internals as switcherInternals } from "../src/switcher/internals.js";
import {
  RETRY_AFTER_FLOOR_CAP_S,
  RETRY_AFTER_MARGIN_S,
  TRUST_MAX_AGE_S,
  UsageEntry,
  failureBackoffS,
} from "../src/usage_store.js";
import { EngineHarness, isoAt, makeHarness, usage } from "./helpers/autoswitch_harness.js";
import { testHome } from "./helpers/home.js";

type Usage = Record<string, unknown>;

const R_SOON = "2024-01-05T00:00:00Z";
const R_LATER = "2024-01-08T00:00:00Z";
const R_LATEST = "2024-01-10T00:00:00Z";

function usage7(pct5: number, pct7: number, reset7: string | null = null): Usage {
  const seven: Usage = { pct: pct7 };
  if (reset7) seven.resets_at = reset7;
  return { five_hour: { pct: pct5 }, seven_day: seven };
}

function noSwitchReasons(h: EngineHarness): string[] {
  return h.reasons();
}

function firstSwitch(h: EngineHarness): SwitchEvent {
  const event = h.events.find((e) => e instanceof SwitchEvent);
  if (!event) throw new Error("no switch event");
  return event as SwitchEvent;
}

function hasAllExhausted(h: EngineHarness): boolean {
  return h.events.some((e) => e instanceof AllExhaustedEvent);
}

function credentialsPath(h: EngineHarness): string {
  return path.join(h.home, ".claude", ".credentials.json");
}

describe("TestEngineHarnessIsolation", () => {
  it.each([Platform.LINUX, Platform.WSL, Platform.MACOS, Platform.WINDOWS])(
    "test_two_harnesses_on_one_temp_home_get_distinct_stores[%s]",
    (platform) => {
      vi.spyOn(Platform, "detect").mockReturnValue(platform);
      const h1 = new EngineHarness(path.join(testHome(), "h1"));
      const h2 = new EngineHarness(path.join(testHome(), "h2"));
      expect(h1.switcher.backupDir).not.toBe(h2.switcher.backupDir);

      h1.seed(1, "a@example.com");
      h2.seed(1, "z@example.com");
      expect(h1.switcher.getSequenceData()!.accounts!["1"]!.email).toBe("a@example.com");
      expect(h2.switcher.getSequenceData()!.accounts!["1"]!.email).toBe("z@example.com");
    },
  );

  it("test_two_harnesses_with_xdg_data_home_set_get_distinct_stores", () => {
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.LINUX);
    vi.stubEnv("XDG_DATA_HOME", path.join(testHome(), "shared-xdg"));
    try {
      const h1 = new EngineHarness(path.join(testHome(), "h1"));
      const h2 = new EngineHarness(path.join(testHome(), "h2"));
      expect(h1.switcher.backupDir).not.toBe(h2.switcher.backupDir);

      h1.seed(1, "a@example.com");
      h2.seed(1, "z@example.com");
      expect(h1.switcher.getSequenceData()!.accounts!["1"]!.email).toBe("a@example.com");
      expect(h2.switcher.getSequenceData()!.accounts!["1"]!.email).toBe("z@example.com");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("TestDecisionTable", () => {
  it("test_below_threshold_is_no_action", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({ "1": usage(50), "2": usage(10), "3": usage(10) });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
    expect(noSwitchReasons(h)).toEqual(["below-threshold"]);
  });

  it("test_over_threshold_switches_to_max_headroom", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(40), "3": usage(20) });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(3);
    const sw = firstSwitch(h);
    expect(sw.trigger).toBe("proactive");
    expect(sw.toRef).toEqual({ number: 3, email: "c@example.com" });
    expect(h.state().lastSwitchTo).toBe("3");
  });

  it("test_no_active_account", async () => {
    const h = new EngineHarness();
    expect(await h.engine.tick()).toBe(TickOutcome.NO_ACTION);
    expect(noSwitchReasons(h)).toEqual(["no-active-account"]);
  });

  it("test_hysteresis_margin_blocks_marginal_candidates", async () => {
    // Failing the margin is not exhaustion: the next tick must keep the normal cadence.
    const h = makeHarness();
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(86), "3": usage(88) });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(h.activeNumber()).toBe(1);
    expect(hasAllExhausted(h)).toBe(false);
    expect(noSwitchReasons(h)).toEqual(["no-qualifying-candidate"]);
    expect(h.engine.sleepUntilTs).toBeNull();
    const delay = await h.engine.nextDelay(outcome);
    expect(delay).toBeLessThanOrEqual(1.1 * h.settings.intervalSeconds);
  });

  it("test_issue_115_strictly_better_candidate_switches", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": { five_hour: { pct: 99.0 }, seven_day: { pct: 24.0 } },
      "2": { five_hour: { pct: 3.0 }, seven_day: { pct: 89.0 } },
      "3": { five_hour: { pct: 95.0 }, seven_day: { pct: 10.0 } },
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(firstSwitch(h).trigger).toBe("proactive");
    expect(h.activeNumber()).toBe(2);
  });

  it("test_proactive_never_lands_at_or_over_threshold", async () => {
    const h = new EngineHarness(null, { threshold: 80.0, hysteresisPct: 5.0 });
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.makeLive("a@example.com", 1);
    const outcome = await h.tickWithUsage({ "1": usage(90), "2": usage(85) });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(h.activeNumber()).toBe(1);
    expect(noSwitchReasons(h)).toEqual(["no-qualifying-candidate"]);
  });

  it("test_stable_landing_does_not_switch_back", async () => {
    const h = new EngineHarness(null, { cooldownSeconds: 0.0 });
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.makeLive("a@example.com", 1);
    const values = {
      "1": { five_hour: { pct: 99.0 }, seven_day: { pct: 24.0 } },
      "2": { five_hour: { pct: 3.0 }, seven_day: { pct: 89.0 } },
    };
    expect(await h.tickWithUsage(values)).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    h.clock.advance(60);
    expect(await h.tickWithUsage(values)).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(2);
    expect(noSwitchReasons(h)).toEqual(["below-threshold"]);
  });

  it("test_mixed_unknown_and_exhausted_is_not_all_exhausted", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage(95),
      "2": usage(100, "2026-07-03T12:00:00Z"),
      "3": null,
    });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(hasAllExhausted(h)).toBe(false);
    expect(noSwitchReasons(h)).toEqual(["no-qualifying-candidate"]);
    expect(h.engine.sleepUntilTs).toBeNull();
    const delay = await h.engine.nextDelay(outcome);
    expect(delay).toBeLessThanOrEqual(1.1 * h.settings.intervalSeconds);
  });

  it("test_stale_beyond_trust_blocks_all_exhausted", async () => {
    const h = makeHarness();
    const now = h.clock.now;
    const reset = "2026-07-05T12:00:00Z";
    const outcome = await h.tickWithEntries({
      "1": new UsageEntry({ lastGood: usage(95), fetchedAt: now, ageS: 0.0 }),
      "2": new UsageEntry({
        lastGood: usage(100, reset),
        fetchedAt: now - 400,
        ageS: 400.0,
        consecutiveFailures: 1,
        trustExtended: true,
      }),
      "3": new UsageEntry({ lastGood: usage(10), fetchedAt: now - 400, ageS: 400.0 }),
    });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(hasAllExhausted(h)).toBe(false);
    expect(noSwitchReasons(h)).toEqual(["no-qualifying-candidate"]);
  });

  it("test_trusted_stale_exhausted_set_still_fires_all_exhausted", async () => {
    const h = makeHarness();
    const now = h.clock.now;
    const reset = "2026-07-05T12:00:00Z";
    const staleExhausted = new UsageEntry({
      lastGood: usage(100, reset),
      fetchedAt: now - 400,
      ageS: 400.0,
      consecutiveFailures: 1,
      trustExtended: true,
    });
    const outcome = await h.tickWithEntries({
      "1": new UsageEntry({ lastGood: usage(95), fetchedAt: now, ageS: 0.0 }),
      "2": staleExhausted,
      "3": staleExhausted,
    });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    const exhausted = h.events.find((e) => e instanceof AllExhaustedEvent) as AllExhaustedEvent;
    expect(exhausted.earliestResetAt).toBe(reset);
  });

  it("test_cooldown_suppresses_proactive", async () => {
    const h = makeHarness();
    h.engine.mutateState((s) => {
      s.lastSwitchAt = h.clock() - 10;
    });
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(10), "3": usage(10) });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(noSwitchReasons(h)).toEqual(["cooldown"]);
  });

  it("test_at_limit_bypasses_cooldown", async () => {
    const h = makeHarness();
    h.engine.mutateState((s) => {
      s.lastSwitchAt = h.clock() - 10;
    });
    const outcome = await h.tickWithUsage({ "1": usage(100), "2": usage(10), "3": usage(50) });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(firstSwitch(h).trigger).toBe("at-limit");
    expect(h.activeNumber()).toBe(2);
  });

  it("test_cooldown_expires", async () => {
    const h = makeHarness();
    h.engine.mutateState((s) => {
      s.lastSwitchAt = h.clock();
    });
    h.clock.advance(400);
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(10), "3": usage(50) });
    expect(outcome).toBe(TickOutcome.SWITCHED);
  });

  it("test_unknown_active_usage_waits_then_fails_over", async () => {
    const h = makeHarness();
    const values = { "1": null, "2": usage(10), "3": usage(50) };
    expect(await h.tickWithUsage(values)).toBe(TickOutcome.NO_ACTION);
    expect(await h.tickWithUsage(values)).toBe(TickOutcome.NO_ACTION);
    expect(await h.tickWithUsage(values)).toBe(TickOutcome.SWITCHED);
    expect(firstSwitch(h).trigger).toBe("failover");
    expect(h.activeNumber()).toBe(2);
  });

  it("test_known_active_usage_resets_unhealthy_counter", async () => {
    const h = makeHarness();
    const unknown = { "1": null, "2": usage(10), "3": usage(10) };
    const healthy = { "1": usage(50), "2": usage(10), "3": usage(10) };
    await h.tickWithUsage(unknown);
    await h.tickWithUsage(unknown);
    await h.tickWithUsage(healthy);
    expect(await h.tickWithUsage(unknown)).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
  });

  it("test_all_candidates_unknown_is_no_comparison", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": null, "3": null });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(noSwitchReasons(h)).toEqual(["no-comparison"]);
  });

  it("test_tie_resolves_to_earliest_slot", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(30), "3": usage(30) });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
  });

  it("test_candidate_not_better_than_active_is_skipped", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({ "1": usage(91), "2": usage(95), "3": usage(99) });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(h.activeNumber()).toBe(1);
  });

  it("test_at_limit_escapes_hysteresis_bar", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({ "1": usage(100), "2": usage(85), "3": usage(97) });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(firstSwitch(h).trigger).toBe("at-limit");
    expect(h.activeNumber()).toBe(2);
  });

  it("test_at_limit_never_targets_another_at_limit_account", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({ "1": usage(100), "2": usage(100), "3": usage(100) });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(h.activeNumber()).toBe(1);
  });

  it("test_failover_ignores_hysteresis_bar", async () => {
    const h = makeHarness();
    const values = { "1": null, "2": usage(85), "3": usage(100) };
    await h.tickWithUsage(values);
    await h.tickWithUsage(values);
    const outcome = await h.tickWithUsage(values);
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(firstSwitch(h).trigger).toBe("failover");
    expect(h.activeNumber()).toBe(2);
  });

  it("test_unmanaged_live_login_is_never_touched", async () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.makeLive("stranger@example.com", 9);
    const liveBefore = fs.readFileSync(credentialsPath(h), "utf8");
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(10) });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(noSwitchReasons(h)).toEqual(["unmanaged-active-account"]);
    expect(fs.readFileSync(credentialsPath(h), "utf8")).toBe(liveBefore);
  });

  it("test_all_exhausted_carries_earliest_reset", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage(100, "2026-07-03T12:00:00Z"),
      "2": usage(100, "2026-07-03T10:30:00Z"),
      "3": usage(100, "2026-07-03T11:00:00Z"),
    });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    const event = h.events.find((e) => e instanceof AllExhaustedEvent) as AllExhaustedEvent;
    expect(event.earliestResetAt).toBe("2026-07-03T10:30:00Z");
    expect(h.engine.sleepUntilTs).not.toBeNull();
  });

  it.each([-60.0, 0.0])("test_all_exhausted_ignores_non_future_reset[%s]", async (offset) => {
    const h = makeHarness();
    const reset = isoAt(h.clock.now + offset);
    const outcome = await h.tickWithUsage({
      "1": usage(100, reset),
      "2": usage(100, reset),
      "3": usage(100, reset),
    });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    const event = h.events.find((e) => e instanceof AllExhaustedEvent) as AllExhaustedEvent;
    expect(event.earliestResetAt).toBeNull();
    expect(h.engine.sleepUntilTs).toBeNull();
    expect(await h.engine.nextDelay(outcome)).toBe(NO_RESET_FALLBACK_S);
  });
});

describe("TestIdleHold", () => {
  const HELD = { "1": USAGE_TOKEN_EXPIRED, "2": usage(10), "3": usage(20) };

  it("test_token_expired_holds_instead_of_failover", async () => {
    const h = makeHarness();
    for (let i = 0; i < 6; i++) {
      expect(await h.tickWithUsage(HELD)).toBe(TickOutcome.NO_ACTION);
      h.clock.advance(60);
    }
    expect(h.activeNumber()).toBe(1);
    expect(h.events.some((e) => e instanceof SwitchEvent)).toBe(false);
    expect(new Set(noSwitchReasons(h))).toEqual(new Set(["active-idle"]));
    expect(h.engine.unhealthyTicks).toBe(0);
  });

  it("test_idle_hold_slows_cadence", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage(HELD);
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(await h.engine.nextDelay(outcome)).toBeGreaterThanOrEqual(NO_RESET_FALLBACK_S);
  });

  it("test_idle_hold_cap_escalates_to_failover", async () => {
    const h = makeHarness();
    expect(await h.tickWithUsage(HELD)).toBe(TickOutcome.NO_ACTION);
    h.clock.advance(IDLE_HOLD_MAX_S + 1);
    expect(await h.tickWithUsage(HELD)).toBe(TickOutcome.NO_ACTION);
    expect(await h.tickWithUsage(HELD)).toBe(TickOutcome.NO_ACTION);
    expect(await h.tickWithUsage(HELD)).toBe(TickOutcome.SWITCHED);
    expect(firstSwitch(h).trigger).toBe("failover");
  });

  it("test_recovery_resets_the_hold_clock", async () => {
    const h = makeHarness();
    const healthy = { "1": usage(50), "2": usage(10), "3": usage(20) };
    await h.tickWithUsage(HELD);
    h.clock.advance(IDLE_HOLD_MAX_S - 60);
    await h.tickWithUsage(healthy);
    h.clock.advance(120);
    expect(await h.tickWithUsage(HELD)).toBe(TickOutcome.NO_ACTION);
    expect(h.engine.unhealthyTicks).toBe(0);
    expect(h.activeNumber()).toBe(1);
  });

  it("test_plain_fetch_failure_still_counts_unhealthy", async () => {
    const h = makeHarness();
    await h.tickWithUsage(HELD);
    const unknown = { "1": null, "2": usage(10), "3": usage(20) };
    expect(await h.tickWithUsage(unknown)).toBe(TickOutcome.NO_ACTION);
    expect(h.engine.unhealthyTicks).toBe(1);
    expect(h.engine.idleHoldSince).toBeNull();
  });

  it("test_foreign_credential_sentinel_fails_over_instead_of_holding", async () => {
    // The failover switch stashes the foreign credential and restores the slot backup.
    const h = makeHarness();
    const foreign = { "1": USAGE_FOREIGN_CREDENTIAL, "2": usage(10), "3": usage(20) };
    expect(await h.tickWithUsage(foreign)).toBe(TickOutcome.NO_ACTION);
    expect(await h.tickWithUsage(foreign)).toBe(TickOutcome.NO_ACTION);
    expect(await h.tickWithUsage(foreign)).toBe(TickOutcome.SWITCHED);
    expect(firstSwitch(h).trigger).toBe("failover");
    expect(h.engine.idleHoldSince).toBeNull();
  });
});

describe("TestAdaptiveScheduler", () => {
  const savedStagger = switcherInternals.FETCH_STAGGER_S;

  beforeEach(() => {
    switcherInternals.FETCH_STAGGER_S = 0;
  });

  afterEach(() => {
    switcherInternals.FETCH_STAGGER_S = savedStagger;
  });

  function schedulerHarness(accounts = 3, settings: Partial<AutoSwitchSettings> = {}): EngineHarness {
    const h = new EngineHarness(null, settings);
    const emails = ["a@example.com", "b@example.com", "c@example.com"];
    for (let num = 1; num <= accounts; num++) h.seed(num, emails[num - 1]!);
    h.makeLive("a@example.com", 1);
    vi.spyOn(h.switcher, "liveSessionPids").mockReturnValue([]);
    return h;
  }

  function countingFetch(
    counts: Record<string, number>,
    usageByNum: Record<string, Usage | undefined>,
    errorsByNum: Record<string, string> = {},
  ) {
    return async (num: string): Promise<oauth.UsageOutcome> => {
      counts[num] = (counts[num] ?? 0) + 1;
      const error = errorsByNum[num];
      if (error) return oauth.usageOutcome(null, { error });
      const value = usageByNum[num];
      return oauth.usageOutcome(value ? ({ ...value } as oauth.UsageDict) : null);
    };
  }

  async function tick(
    h: EngineHarness,
    counts: Record<string, number>,
    usageByNum: Record<string, Usage | undefined>,
    errorsByNum: Record<string, string> = {},
  ): Promise<TickOutcome> {
    const spy = vi
      .spyOn(switcherInternals, "tryFetchUsageForAccount")
      .mockImplementation(countingFetch(counts, usageByNum, errorsByNum));
    try {
      return await h.engine.tick();
    } finally {
      spy.mockRestore();
    }
  }

  it("test_baseline_fetches_active_plus_one_candidate", async () => {
    const h = schedulerHarness();
    const values = { "1": usage(50), "2": usage(10), "3": usage(20) };
    const counts: Record<string, number> = {};
    await tick(h, counts, values);
    expect(counts).toEqual({ "1": 1, "2": 1 });
    h.clock.advance(60);
    await tick(h, counts, values);
    expect(counts).toEqual({ "1": 1, "2": 1, "3": 1 });
    h.clock.advance(60);
    await tick(h, counts, values);
    expect(counts).toEqual({ "1": 1, "2": 1, "3": 1 });
    h.clock.advance(60);
    await tick(h, counts, values);
    expect(counts).toEqual({ "1": 2, "2": 1, "3": 1 });
  });

  it("test_near_threshold_escalates_to_full_refresh", async () => {
    const h = schedulerHarness();
    const counts: Record<string, number> = {};
    const outcome = await tick(h, counts, { "1": usage(80), "2": usage(10), "3": usage(20) });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(counts).toEqual({ "1": 1, "2": 1, "3": 1 });
  });

  it("test_active_unknown_escalates_before_failover", async () => {
    const h = schedulerHarness(3, { unhealthyTicks: 1 });
    const counts: Record<string, number> = {};
    const outcome = await tick(h, counts, { "2": usage(10), "3": usage(50) }, { "1": "timeout" });
    expect(counts).toEqual({ "1": 1, "2": 1, "3": 1 });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
  });

  it("test_active_cadence_floor_and_decay", async () => {
    const h = schedulerHarness(2);
    const values = { "1": usage(10), "2": usage(20) };
    const counts: Record<string, number> = {};
    await tick(h, counts, values);
    expect(counts["1"]).toBe(1);
    for (let i = 0; i < 2; i++) {
      h.clock.advance(60);
      await tick(h, counts, values);
    }
    expect(counts["1"]).toBe(1);
    h.clock.advance(60);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(2);
    h.clock.advance(240);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(2);
    h.clock.advance(60);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(3);
  });

  it("test_urgent_cadence_when_burning_near_the_band", async () => {
    const h = schedulerHarness(2);
    const values: Record<string, Usage> = { "1": usage(70), "2": usage(10) };
    const counts: Record<string, number> = {};
    await tick(h, counts, values);
    values["1"] = usage(80);
    h.clock.advance(180);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(2);
    values["1"] = usage(84);
    h.clock.advance(60);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(3);
  });

  it("test_in_band_without_movement_keeps_the_floor", async () => {
    const h = schedulerHarness(2);
    const values = { "1": usage(80), "2": usage(10) };
    const counts: Record<string, number> = {};
    await tick(h, counts, values);
    for (let i = 0; i < 2; i++) {
      h.clock.advance(60);
      await tick(h, counts, values);
    }
    expect(counts["1"]).toBe(1);
    h.clock.advance(60);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(2);
  });

  it("test_urgent_band_follows_the_threshold", async () => {
    const h = schedulerHarness(2, { threshold: 50 });
    const values: Record<string, Usage> = { "1": usage(30), "2": usage(10) };
    const counts: Record<string, number> = {};
    await tick(h, counts, values);
    values["1"] = usage(40);
    h.clock.advance(180);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(2);
    values["1"] = usage(44);
    h.clock.advance(60);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(3);
  });

  it("test_stale_candidate_plan_never_gates_the_active", async () => {
    // A plan from the time the slot was a candidate can be 600s out. The ACTIVE_MAX_INTERVAL_S age cap overrides it.
    const h = schedulerHarness(2);
    const values = { "1": usage(50), "2": usage(20) };
    const counts: Record<string, number> = {};
    await tick(h, counts, values);
    h.switcher.usageStore.setPollPlan({ "1": [h.clock.now + 600.0, 600.0] }, { "1": ["a@example.com", ""] });
    h.clock.advance(240);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(1);
    h.clock.advance(120);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(2);
  });

  it("test_exhausted_active_is_rechecked_before_its_reset", async () => {
    const h = schedulerHarness(1);
    const resetIso = isoAt(h.clock.now + 7200.0);
    const values = { "1": usage(100, resetIso) };
    const counts: Record<string, number> = {};
    await tick(h, counts, values);
    expect(counts["1"]).toBe(1);
    for (let i = 0; i < 3; i++) {
      h.clock.advance(400);
      await tick(h, counts, values);
    }
    expect(counts["1"]).toBe(2);
  });

  it("test_engine_repairs_legacy_reset_parked_active_plan", async () => {
    const h = schedulerHarness(1);
    const resetTs = h.clock.now + 86_400.0;
    const values = { "1": usage(100, isoAt(resetTs)) };
    const counts: Record<string, number> = {};
    await tick(h, counts, values);
    h.switcher.usageStore.setPollPlan({ "1": [resetTs, 300.0] }, { "1": ["a@example.com", ""] });

    h.clock.advance(400);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(2);
    const entry = h.switcher.usageStore.entries({ "1": ["a@example.com", ""] })["1"]!;
    expect(entry.nextPollAt).not.toBeNull();
    expect(entry.nextPollAt!).toBeLessThan(resetTs);
  });

  it("test_band_jump_is_seen_at_most_one_poll_late", async () => {
    const h = schedulerHarness(2);
    const values: Record<string, Usage> = { "1": usage(40), "2": usage(20) };
    const counts: Record<string, number> = {};
    await tick(h, counts, values);
    values["1"] = usage(80);
    h.clock.advance(60);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(1);
    h.clock.advance(120);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(2);
    expect(counts["2"]).toBe(1);
    h.clock.advance(60);
    await tick(h, counts, values);
    expect(counts["1"]).toBe(3);
    expect(counts["2"]).toBe(2);
  });

  it("test_active_in_backoff_keeps_trusted_headroom", async () => {
    // The staleness of a rate-limited active row is deliberate: its headroom stays known.
    const h = schedulerHarness();
    const values = { "1": usage(50), "2": usage(10), "3": usage(20) };
    const counts: Record<string, number> = {};
    await tick(h, counts, values);
    h.clock.advance(60);
    await tick(h, counts, values);
    h.switcher.usageStore.record(
      { "1": { error: "http-429", retryAfterS: 600.0 } },
      { "1": ["a@example.com", ""] },
    );
    h.clock.advance(400);
    for (const key of Object.keys(counts)) delete counts[key];
    const outcome = await tick(h, counts, values);
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.engine.unhealthyTicks).toBe(0);
    expect("1" in counts).toBe(false);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("test_a_non_429_ask_is_bounded_at_its_own_trust_ceiling", () => {
    // A non-429 row reads unknown after TRUST_MAX_AGE_S, so a non-429 ask must not park it longer.
    for (const ask of [601.0, 3600.0]) {
      expect(failureBackoffS(1, ask, { rateLimited: false })).toBe(ask);
    }

    for (const ask of [3601.0, 4500.0, 7200.0, 10_000.0, 20_000.0, 86_400.0, Infinity]) {
      expect(failureBackoffS(1, ask, { rateLimited: false })).toBe(TRUST_MAX_AGE_S);
    }

    expect(failureBackoffS(1, Number("1e400"), { rateLimited: false })).toBe(TRUST_MAX_AGE_S);

    expect(failureBackoffS(1, 3600.0, { rateLimited: true })).toBe(4500.0);
    expect(failureBackoffS(1, Infinity, { rateLimited: true })).toBe(4500.0);
  });

  it("test_shortening_a_429_wait_cannot_move_when_the_row_goes_unknown", () => {
    // A 429 refreshes neither lastGood nor fetchedAt, so the backoff cadence cannot move the instant the row goes unknown.
    function decisionAt(home: string, stride: number, checkpoint: number): boolean {
      const h = new EngineHarness(home);
      h.seed(1, "a@example.com");
      const store = h.switcher.usageStore;
      const ids = { "1": ["a@example.com", ""] as const };
      const t0 = h.clock.now;
      store.record({ "1": { usage: usage(50, isoAt(t0 + 1800)) as oauth.UsageDict } }, ids);
      let elapsed = 0.0;
      while (elapsed < checkpoint) {
        store.record({ "1": { error: "http-429", retryAfterS: 3600.0 } }, ids);
        const step = Math.min(stride, checkpoint - elapsed);
        h.clock.advance(step);
        elapsed += step;
      }
      expect(h.clock.now - t0).toBe(checkpoint);
      return store.entries(ids)["1"]!.decisionValue() === null;
    }

    for (const [checkpoint, expectUnknown] of [
      [1799.0, false],
      [1801.0, true],
    ] as const) {
      const hammered = decisionAt(path.join(testHome(), `short${checkpoint}`), 37.0, checkpoint);
      const honored = decisionAt(path.join(testHome(), `long${checkpoint}`), 1801.0, checkpoint);
      expect(hammered).toBe(expectUnknown);
      expect(honored).toBe(expectUnknown);
    }
  });

  it("test_a_re_block_chain_spends_one_request_per_block", () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    const store = h.switcher.usageStore;
    const ids = { "1": ["a@example.com", ""] as const };
    const t0 = h.clock.now;

    store.record({ "1": { usage: usage(50) as oauth.UsageDict } }, ids);

    let polls = 0;
    for (let i = 0; i < 4; i++) {
      polls += 1;
      store.record({ "1": { error: "http-429", retryAfterS: 3600.0 } }, ids);
      h.clock.now = store.entries(ids)["1"]!.backoffUntil ?? 0.0;
    }

    const elapsed = h.clock.now - t0;
    expect(polls).toBe(4);
    expect(elapsed).toBeGreaterThanOrEqual(4 * 3600.0);
  });

  it("test_the_margin_is_not_traded_away_for_a_dead_scoped_window", () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    const st = h.switcher.usageStore;
    const t0 = h.clock.now;
    const ident = { "1": ["a@example.com", ""] as const };
    st.record(
      {
        "1": {
          usage: {
            five_hour: { pct: 50.0, resets_at: isoAt(t0 + 14400) },
            seven_day: { pct: 10.0, resets_at: isoAt(t0 + 400000) },
            scoped: [{ name: "Fable", pct: 60.0, resets_at: isoAt(t0 + 1800) }],
          } as oauth.UsageDict,
        },
      },
      ident,
    );
    st.record({ "1": { error: "http-429", retryAfterS: 3600.0 } }, ident);
    const waited = st.entries(ident, ["Fable"])["1"]!.backoffUntil! - t0;
    expect(waited).toBe(4500.0);
  });

  it("test_an_expired_trust_does_not_turn_one_block_into_a_request_storm", () => {
    const blockS = 3600.0;
    const h = new EngineHarness(null, { model: "Fable" });
    h.seed(1, "a@example.com");
    const st = h.switcher.usageStore;
    const t0 = h.clock.now;
    const ident = { "1": ["a@example.com", ""] as const };
    st.record(
      {
        "1": {
          usage: {
            five_hour: { pct: 50.0, resets_at: isoAt(t0 + 1800) },
            seven_day: { pct: 10.0, resets_at: isoAt(t0 + 400000) },
          } as oauth.UsageDict,
        },
      },
      ident,
    );

    let requests = 0;
    while (h.clock.now - t0 < blockS && requests < 40) {
      requests += 1;
      // Retry-After counts down to a fixed deadline, as measured on the real endpoint.
      const remaining = blockS - (h.clock.now - t0);
      st.record({ "1": { error: "http-429", retryAfterS: remaining } }, ident);
      h.clock.now = st.entries(ident, ["Fable"])["1"]!.backoffUntil!;
    }

    const landed = h.clock.now - t0;
    expect(requests).toBeLessThanOrEqual(2);
    expect(landed).toBeGreaterThanOrEqual(blockS + RETRY_AFTER_MARGIN_S);

    // The loop above asks 3600s, where the margin sum lands exactly on the cap. A 4000s ask tests the park bound.
    expect(failureBackoffS(1, 4000.0, { rateLimited: true })).toBe(RETRY_AFTER_FLOOR_CAP_S);
  });

  it("test_the_trim_never_lands_inside_the_re_block_band", () => {
    // This literal is the measured re-block band. It must not come from RETRY_AFTER_MARGIN_S.
    const MEASURED_BAND_S = 900.0;

    const h = new EngineHarness(null, { model: "Fable" });
    h.seed(1, "a@example.com");
    const st = h.switcher.usageStore;
    const t0 = h.clock.now;
    const ident = { "1": ["a@example.com", ""] as const };
    st.record(
      {
        "1": {
          usage: {
            five_hour: { pct: 50.0, resets_at: isoAt(t0 + 7200) },
            seven_day: { pct: 10.0, resets_at: isoAt(t0 + 30 * 86400) },
            scoped: [{ name: "Fable", pct: 60.0, resets_at: isoAt(t0 + 4000) }],
          } as oauth.UsageDict,
        },
      },
      ident,
    );
    st.record({ "1": { error: "http-429", retryAfterS: 3600.0 } }, ident);
    const waited = st.entries(ident, ["Fable"])["1"]!.backoffUntil! - t0;
    expect(waited).toBeGreaterThanOrEqual(3600.0 + MEASURED_BAND_S);
  });

  it("test_a_re_block_chain_does_not_shorten_its_own_waits", () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    const st = h.switcher.usageStore;
    const t0 = h.clock.now;
    const ident = { "1": ["a@example.com", ""] as const };
    st.record(
      {
        "1": {
          usage: {
            five_hour: { pct: 50.0, resets_at: isoAt(t0 + 16000) },
            seven_day: { pct: 0.0 },
          } as oauth.UsageDict,
        },
      },
      ident,
    );

    for (let block = 0; block < 4; block++) {
      st.record({ "1": { error: "http-429", retryAfterS: 3600.0 } }, ident);
      const waited = st.entries(ident)["1"]!.backoffUntil! - h.clock.now;
      expect(waited).toBe(4500.0);
      h.clock.advance(waited);
    }
  });

  it("test_a_non_429_recorded_through_record_does_not_take_the_margin", () => {
    // The ask sits between TRUST_MAX_AGE_S and RETRY_AFTER_FLOOR_CAP_S, where the 429 and non-429 arms disagree.
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    const st = h.switcher.usageStore;
    const ident = { "1": ["a@example.com", ""] as const };

    st.record({ "1": { usage: usage(50) as oauth.UsageDict } }, ident);
    h.clock.advance(120.0);
    const premise = st.entries(ident)["1"]!;
    expect(premise.decisionValue()).not.toBeNull();
    const t1 = h.clock.now;

    const ask = (TRUST_MAX_AGE_S + RETRY_AFTER_FLOOR_CAP_S) / 2;
    st.record({ "1": { error: "http-503", retryAfterS: ask } }, ident);
    const entry = st.entries(ident)["1"]!;
    expect(entry.backoffUntil! - t1).toBe(TRUST_MAX_AGE_S);
  });

  it("test_all_exhausted_escalation_preserves_wider_plan", async () => {
    const h = schedulerHarness();
    const values = { "1": usage(100), "2": usage(100), "3": usage(100) };
    const counts: Record<string, number> = {};
    expect(await tick(h, counts, values)).toBe(TickOutcome.BLOCKED);
    expect(counts).toEqual({ "1": 1, "2": 1, "3": 1 });

    // A wider plan from repeated 429s. The all-exhausted escalation must keep it.
    h.switcher.usageStore.setPollPlan({ "2": [h.clock.now + 1800.0, 1800.0] }, { "2": ["b@example.com", ""] });
    h.clock.advance(NO_RESET_FALLBACK_S);
    expect(await tick(h, counts, values)).toBe(TickOutcome.BLOCKED);
    expect(counts["2"]).toBe(1);
  });

  it("test_exhausted_candidate_keeps_a_bounded_poll_plan", async () => {
    const h = schedulerHarness();
    const resetIso = "2026-07-05T12:00:00Z";
    const values = { "1": usage(50), "2": usage(100, resetIso), "3": usage(20) };
    const counts: Record<string, number> = {};
    for (let i = 0; i < 3; i++) {
      await tick(h, counts, values);
      h.clock.advance(60);
    }
    expect(counts["2"]).toBe(1);
    const entry = h.switcher.usageStore.entries({ "2": ["b@example.com", ""] })["2"]!;
    expect(entry.pollIntervalS).toBe(pollPolicy.EXHAUSTED_INTERVAL_S);
    expect(entry.nextPollAt).not.toBeNull();
    expect(entry.nextPollAt!).toBeLessThanOrEqual(
      entry.fetchedAt! + pollPolicy.EXHAUSTED_INTERVAL_S * (1 + pollPolicy.internals.JITTER_FRAC),
    );
  });

  it("test_poll_never_scheduled_past_a_window_reset", async () => {
    // The stored 40% is obsolete at the rollover, so the reset clamps the next poll.
    const h = schedulerHarness(2);
    const resetTs = h.clock.now + 90.0;
    const values = { "1": usage(50), "2": usage(40, isoAt(resetTs)) };
    const counts: Record<string, number> = {};
    await tick(h, counts, values);
    const entry = h.switcher.usageStore.entries({ "2": ["b@example.com", ""] })["2"]!;
    expect(entry.nextPollAt).toBeCloseTo(resetTs + RESET_SLACK_S, 6);
    expect(entry.pollIntervalS).toBe(pollPolicy.CANDIDATE_DEFAULT_INTERVAL_S);
  });

  it("test_movement_adapts_poll_interval", async () => {
    const h = schedulerHarness(2);
    const values: Record<string, Usage> = { "1": usage(50), "2": usage(10) };
    const counts: Record<string, number> = {};

    const interval = (): number | null =>
      h.switcher.usageStore.entries({ "2": ["b@example.com", ""] })["2"]!.pollIntervalS;

    await tick(h, counts, values);
    expect(interval()).toBe(pollPolicy.CANDIDATE_DEFAULT_INTERVAL_S);
    h.clock.advance(180);
    await tick(h, counts, values);
    expect(counts["2"]).toBe(1);
    h.clock.advance(120);
    await tick(h, counts, values);
    expect(counts["2"]).toBe(2);
    expect(interval()).toBe(450.0);
    h.clock.advance(450);
    values["2"] = usage(20);
    await tick(h, counts, values);
    expect(counts["2"]).toBe(3);
    expect(interval()).toBe(225.0);
  });

  it("test_idle_hold_skips_candidate_polling", async () => {
    const h = schedulerHarness();
    fs.writeFileSync(
      credentialsPath(h),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-live", refreshToken: "rt-live", expiresAt: 1000 } }),
    );
    // A backup that is not expired gets restored without a refresh, so it must be expired too.
    h.seed(1, "a@example.com", { expiresAt: 1000 });
    const values = { "2": usage(10), "3": usage(20) };
    const counts: Record<string, number> = {};
    const refresh = vi
      .spyOn(oauth.internals, "tryRefreshOauthCredentials")
      .mockResolvedValue(oauth.refreshOutcome(null, "network"));
    try {
      expect(await tick(h, counts, values)).toBe(TickOutcome.NO_ACTION);
      h.clock.advance(10);
      for (const key of Object.keys(counts)) delete counts[key];
      expect(await tick(h, counts, values)).toBe(TickOutcome.NO_ACTION);
    } finally {
      refresh.mockRestore();
    }
    expect(counts).toEqual({});
    expect(noSwitchReasons(h).at(-1)).toBe("active-idle");
  });

  it("test_poll_event_carries_fetch_errors", async () => {
    const h = schedulerHarness(2, { unhealthyTicks: 3 });
    const counts: Record<string, number> = {};
    await tick(h, counts, { "2": usage(10) }, { "1": "http-429" });
    const poll = h.events.find((e) => e instanceof PollEvent) as PollEvent;
    expect(poll.fetchErrors["1"]).toBe("http-429");
    expect(poll.human()).toContain("http-429");
    expect(poll.toJson().fetchErrors).toEqual({ "1": "http-429" });
  });

  it("test_quarantined_candidate_never_consumes_the_poll_slot", async () => {
    const h = schedulerHarness();
    h.engine.quarantine("2", "b@example.com", "invalid_grant");
    const values = { "1": usage(50), "2": usage(10), "3": usage(20) };
    const counts: Record<string, number> = {};
    for (let i = 0; i < 3; i++) {
      await tick(h, counts, values);
      h.clock.advance(60);
    }
    expect("2" in counts).toBe(false);
    expect(counts["3"]).toBeGreaterThanOrEqual(1);
  });

  it("test_expired_active_enters_idle_hold_even_during_backoff", async () => {
    // The backoff of the active row must not hide the expired sentinel, or unhealthy ticks cause a false failover.
    const h = schedulerHarness();
    fs.writeFileSync(
      credentialsPath(h),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-live", refreshToken: "rt-live", expiresAt: 1000 } }),
    );
    h.switcher.usageStore.record(
      { "1": { error: "http-429", retryAfterS: 600.0 } },
      { "1": ["a@example.com", ""] },
    );
    const counts: Record<string, number> = {};
    const outcome = await tick(h, counts, { "2": usage(10), "3": usage(20) });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.engine.unhealthyTicks).toBe(0);
    expect(noSwitchReasons(h)).toEqual(["active-idle"]);
  });

  it("test_consume_first_hold_never_escalates_below_threshold", async () => {
    const h = schedulerHarness(3, { strategy: "consume-first" });
    const values = {
      "1": usage7(50, 20, R_SOON),
      "2": usage7(10, 10, R_LATER),
      "3": usage7(10, 10, R_LATEST),
    };
    const counts: Record<string, number> = {};
    const fetchSets: Set<string>[] = [];
    const realCollect = h.switcher.usageEntriesByAccount.bind(h.switcher);
    vi.spyOn(h.switcher, "usageEntriesByAccount").mockImplementation((fetch, options) => {
      fetchSets.push(new Set(fetch ?? []));
      return realCollect(fetch, options);
    });

    for (let i = 0; i < 4; i++) {
      expect(await tick(h, counts, values)).toBe(TickOutcome.NO_ACTION);
      h.clock.advance(60);
    }
    expect(counts).toEqual({ "1": 2, "2": 1, "3": 1 });
    expect(fetchSets.map((set) => [...set].sort().join(","))).not.toContain("1,2,3");
  });

  it("test_consume_first_stale_target_holds_then_switches", async () => {
    // If phase 2 cannot freshen the target, the freshness gate holds. After the backoff, the switch lands.
    const h = schedulerHarness(3, { strategy: "consume-first" });
    const counts: Record<string, number> = {};
    const viewA = {
      "1": usage7(50, 20, R_SOON),
      "2": usage7(10, 10, R_LATER),
      "3": usage7(10, 10, R_LATEST),
    };
    await tick(h, counts, viewA);
    h.clock.advance(60);
    await tick(h, counts, viewA);
    expect(counts).toEqual({ "1": 1, "2": 1, "3": 1 });
    h.switcher.usageStore.record(
      { "2": { error: "http-429", retryAfterS: 600.0 } },
      { "2": ["b@example.com", ""] },
    );
    h.clock.advance(181);
    h.events.length = 0;
    const viewB = {
      "1": usage7(50, 20, R_LATEST),
      "2": usage7(10, 10, R_LATER),
      "3": usage7(10, 10, R_LATEST),
    };
    let outcome = await tick(h, counts, viewB);
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
    expect(noSwitchReasons(h)).toContain("stale-usage");
    expect(counts["2"]).toBe(1);
    h.events.length = 0;
    h.clock.advance(700);
    outcome = await tick(h, counts, viewB);
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    expect(firstSwitch(h).trigger).toBe("consume-first");
  });
});
