import { describe, expect, it, vi } from "vitest";
import {
  AutoSwitchEngine,
  NoSwitchEvent,
  RECOVERY_HORIZON_S,
  SwitchEvent,
  type TickOutcome as TickOutcomeType,
  TickOutcome,
  recoveryIsUseful,
} from "../src/autoswitch.js";
import { USAGE_TOKEN_EXPIRED } from "../src/json_output.js";
import { autoSwitchSettings } from "../src/settings.js";
import type { UsageEntry } from "../src/usage_store.js";
import {
  EngineHarness,
  type UsageValue,
  entryFor,
  isoAt,
  makeHarness,
  usage,
} from "./helpers/autoswitch_harness.js";

// The fake clock starts at 1_000_000.0 (about 1970-01-12). R_PAST is before it.
const R_PAST = "1970-01-10T00:00:00Z";
const R_SOON = "2024-01-05T00:00:00Z";
const R_LATER = "2024-01-08T00:00:00Z";
const R_LATEST = "2024-01-10T00:00:00Z";

function usage7(pct5: number, pct7: number, reset7: string | null = null): Record<string, unknown> {
  const seven: Record<string, unknown> = { pct: pct7 };
  if (reset7) seven.resets_at = reset7;
  return { five_hour: { pct: pct5 }, seven_day: seven };
}

function at(h: EngineHarness, seconds: number): string {
  return isoAt(h.clock.now + seconds);
}

function firstSwitch(h: EngineHarness): SwitchEvent {
  return h.events.find((e) => e instanceof SwitchEvent) as SwitchEvent;
}

function fakeEngine(): AutoSwitchEngine {
  const e = Object.create(AutoSwitchEngine.prototype) as AutoSwitchEngine;
  Object.defineProperty(e, "models", { value: [] });
  return e;
}

describe("TestConsumeFirstStrategy", () => {
  function harness(): EngineHarness {
    const h = new EngineHarness(null, { strategy: "consume-first" });
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.seed(3, "c@example.com");
    h.makeLive("a@example.com", 1);
    return h;
  }

  it("test_below_threshold_switches_to_soonest_weekly_reset", async () => {
    const h = harness();
    const outcome = await h.tickWithUsage({
      "1": usage7(20, 20, R_LATER),
      "2": usage7(10, 10, R_SOON),
      "3": usage7(10, 10, R_LATEST),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    const sw = firstSwitch(h);
    expect(sw.trigger).toBe("consume-first");
    expect(sw.toRef).toEqual({ number: 2, email: "b@example.com" });
  });

  it("test_stays_when_active_already_resets_soonest", async () => {
    const h = harness();
    const outcome = await h.tickWithUsage({
      "1": usage7(20, 20, R_SOON),
      "2": usage7(10, 10, R_LATER),
      "3": usage7(10, 10, R_LATEST),
    });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
    expect(h.reasons()).toEqual(["already-consuming-soonest"]);
  });

  it("test_over_threshold_prefers_soonest_reset_over_max_headroom", async () => {
    const h = harness();
    const outcome = await h.tickWithUsage({
      "1": usage7(95, 20, R_LATER),
      "2": usage7(50, 40, R_SOON),
      "3": usage7(10, 10, R_LATEST),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
  });

  it("test_a_consume_first_target_must_still_be_healthy", async () => {
    // Two accounts on purpose: a third healthy peer wins the sort and hides the defect.
    const h = new EngineHarness(null, { strategy: "consume-first" });
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.makeLive("a@example.com", 1);

    const outcome = await h.tickWithUsage({
      "1": usage7(40, 40, R_LATEST),
      "2": usage7(96, 96, R_SOON),
    });
    expect(outcome, "consume-first moved onto an account at 96% utilization").not.toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(1);
  });

  it("test_respects_cooldown", async () => {
    const h = harness();
    await h.tickWithUsage({
      "1": usage7(20, 20, R_LATER),
      "2": usage7(10, 10, R_SOON),
      "3": usage7(10, 10, R_LATEST),
    });
    expect(h.activeNumber()).toBe(2);
    h.events.length = 0;
    const outcome = await h.tickWithUsage({
      "2": usage7(20, 20, R_LATER),
      "1": usage7(10, 10, R_LATEST),
      "3": usage7(10, 10, R_SOON),
    });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(2);
    expect(h.reasons()).toContain("cooldown");
  });

  it("test_locked_recheck_stops_concurrent_engine", async () => {
    const h = harness();
    const loser = h.makeEngine();
    await h.tickWithUsage({
      "1": usage7(20, 20, R_LATER),
      "2": usage7(10, 10, R_SOON),
      "3": usage7(10, 10, R_LATEST),
    });
    expect(h.activeNumber()).toBe(2);
    h.events.length = 0;

    const realRead = loser.readState.bind(loser);
    let calls = 0;
    vi.spyOn(loser, "readState").mockImplementation(() => {
      calls += 1;
      return calls === 1 ? {} : realRead();
    });
    const entries: Record<string, UsageEntry> = {};
    for (const [num, value] of Object.entries({
      "2": usage7(20, 20, R_LATER),
      "1": usage7(10, 10, R_LATEST),
      "3": usage7(10, 10, R_SOON),
    })) {
      entries[num] = entryFor(value, h.clock.now);
    }
    vi.spyOn(h.switcher, "usageEntriesByAccount").mockResolvedValue(entries);
    const outcome = await loser.tick();
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(2);
    expect(h.reasons()).toContain("cooldown");
  });

  it("test_reset_unknown_when_active_reset_missing", async () => {
    const h = harness();
    const outcome = await h.tickWithUsage({
      "1": usage7(20, 20),
      "2": usage7(10, 10, R_SOON),
      "3": usage7(10, 10, R_LATEST),
    });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
    expect(h.reasons()).toEqual(["reset-unknown"]);
  });

  it("test_unreadable_candidates_stay_no_comparison", async () => {
    const h = harness();
    const outcome = await h.tickWithUsage({
      "1": usage7(20, 20, R_LATER),
      "2": null,
      "3": null,
    });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(h.reasons()).toEqual(["no-comparison"]);
  });

  it("test_exhausted_candidates_hold_without_false_reset_claim", async () => {
    const h = harness();
    const outcome = await h.tickWithUsage({
      "1": usage7(20, 20, R_LATER),
      "2": usage7(100, 100, R_SOON),
      "3": usage7(100, 100, R_LATEST),
    });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
    const holds = h.events.filter((e): e is NoSwitchEvent => e instanceof NoSwitchEvent);
    expect(holds.map((e) => e.reason)).toEqual(["already-consuming-soonest"]);
    expect(holds[0]!.detail).toBe("no sooner-resetting account with room to spare");
  });

  it("test_single_account_below_threshold_is_no_action", async () => {
    const h = new EngineHarness(null, { strategy: "consume-first" });
    h.seed(1, "a@example.com");
    h.makeLive("a@example.com", 1);
    const outcome = await h.tickWithUsage({ "1": usage7(20, 20, R_SOON) });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.reasons()).toEqual(["below-threshold"]);
  });

  it("test_api_key_only_peers_below_threshold_is_no_action", async () => {
    const h = new EngineHarness(null, { strategy: "consume-first", includeApiKeyAccounts: true });
    h.seed(1, "a@example.com");
    h.seed(2, "key@token.local");
    h.makeLive("a@example.com", 1);
    const data = h.switcher.getSequenceData()!;
    (data.accounts!["2"] as Record<string, unknown>).kind = "api_key";
    h.switcher.writeJson(h.switcher.sequenceFile, data);
    const outcome = await h.tickWithUsage({
      "1": usage7(20, 20, R_SOON),
      "2": "api key",
    });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
    expect(h.reasons()).toEqual(["below-threshold"]);
  });

  it("test_skips_sooner_account_that_is_exhausted", async () => {
    const h = harness();
    const outcome = await h.tickWithUsage({
      "1": usage7(20, 20, R_LATEST),
      "2": usage7(100, 100, R_SOON),
      "3": usage7(10, 10, R_LATER),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(3);
  });

  it("test_best_strategy_unaffected_below_threshold", async () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.makeLive("a@example.com", 1);
    const outcome = await h.tickWithUsage({
      "1": usage7(20, 20, R_LATER),
      "2": usage7(10, 10, R_SOON),
    });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
    expect(h.reasons()).toEqual(["below-threshold"]);
  });

  it("test_candidate_with_past_reset_is_not_selected", async () => {
    // A reset in the past means the weekly window rolled over: it ranks as unknown, not as soonest.
    const h = harness();
    const outcome = await h.tickWithUsage({
      "1": usage7(20, 20, R_LATER),
      "2": usage7(10, 10, R_PAST),
      "3": usage7(10, 10, R_SOON),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(3);
    expect(firstSwitch(h).toRef).toEqual({ number: 3, email: "c@example.com" });
  });

  it("test_active_past_reset_holds_reset_unknown", async () => {
    const h = harness();
    const outcome = await h.tickWithUsage({
      "1": usage7(20, 20, R_PAST),
      "2": usage7(10, 10, R_SOON),
      "3": usage7(10, 10, R_LATER),
    });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
    expect(h.reasons()).toEqual(["reset-unknown"]);
  });

  /**
   * One tick where the stored-snapshot collections serve `stored` and the
   * all-candidates escalation serves `fresh`. The utilization stays far below the
   * escalation band, so the only all-candidates call is the consume-first phase-2 refetch.
   */
  async function twoPhaseTick(
    h: EngineHarness,
    stored: Record<string, UsageValue>,
    fresh: Record<string, UsageValue>,
  ): Promise<[TickOutcomeType, string[][]]> {
    const fetchSets: string[][] = [];
    vi.spyOn(h.switcher, "usageEntriesByAccount").mockImplementation(async (fetch) => {
      const requested = [...(fetch ?? [])].sort();
      fetchSets.push(requested);
      const view = requested.join(",") === "1,2,3" ? fresh : stored;
      const entries: Record<string, UsageEntry> = {};
      for (const [num, value] of Object.entries(view)) entries[num] = entryFor(value, h.clock.now);
      return entries;
    });
    try {
      return [await h.engine.tick(), fetchSets];
    } finally {
      vi.mocked(h.switcher.usageEntriesByAccount).mockRestore();
    }
  }

  const ALL = ["1", "2", "3"];
  const countAll = (sets: string[][]) => sets.filter((s) => s.join(",") === ALL.join(",")).length;

  it("test_two_phase_refetch_disqualifies_stale_pick", async () => {
    const h = harness();
    const stored = {
      "1": usage7(20, 20, R_LATER),
      "2": usage7(10, 10, R_SOON),
      "3": usage7(10, 10, R_LATEST),
    };
    const fresh = {
      "1": usage7(20, 20, R_LATER),
      "2": usage7(100, 100, R_SOON),
      "3": usage7(10, 10, R_LATEST),
    };
    const [outcome, fetchSets] = await twoPhaseTick(h, stored, fresh);
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
    expect(h.reasons()).toEqual(["already-consuming-soonest"]);
    expect(countAll(fetchSets)).toBe(1);
  });

  it("test_two_phase_refetch_confirms_switch", async () => {
    const h = harness();
    const view = {
      "1": usage7(20, 20, R_LATER),
      "2": usage7(10, 10, R_SOON),
      "3": usage7(10, 10, R_LATEST),
    };
    const [outcome, fetchSets] = await twoPhaseTick(h, view, view);
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    expect(countAll(fetchSets)).toBeGreaterThanOrEqual(1);
  });

  it("test_two_phase_refetch_reranks_to_fresh_best", async () => {
    const h = harness();
    const stored = {
      "1": usage7(20, 20, R_LATEST),
      "2": usage7(10, 10, R_SOON),
      "3": usage7(10, 10, R_LATER),
    };
    const fresh = {
      "1": usage7(20, 20, R_LATEST),
      "2": usage7(10, 10, R_LATER),
      "3": usage7(10, 10, R_SOON),
    };
    const [outcome] = await twoPhaseTick(h, stored, fresh);
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(3);
  });

  it("test_threshold_crossed_in_phase_two_holds_then_escapes_next_tick", async () => {
    // Phase 2 never re-classifies the trigger in the same tick. The next tick classifies at-limit.
    const h = harness();
    const stored = {
      "1": usage7(20, 20, R_LATER),
      "2": usage7(10, 10, R_SOON),
      "3": usage7(10, 10, R_LATEST),
    };
    const fresh = {
      "1": usage7(100, 20, R_LATER),
      "2": usage7(10, 10, R_LATEST),
      "3": usage7(10, 10, R_LATEST),
    };
    const [outcome, fetchSets] = await twoPhaseTick(h, stored, fresh);
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
    expect(h.events.some((e) => e instanceof SwitchEvent)).toBe(false);
    expect(countAll(fetchSets)).toBeGreaterThanOrEqual(1);
    expect(h.reasons()).toEqual(["already-consuming-soonest"]);
    h.events.length = 0;
    const next = await h.tickWithUsage(fresh);
    expect(next).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    expect(firstSwitch(h).trigger).toBe("at-limit");
  });
});

describe("TestConsumeFirstDepartureRecordsItsOwnTrigger", () => {
  const settings = autoSwitchSettings();
  const now = 1_000_000.0;
  // Peer 1 has 11 points, the active account 2 has 5 points.
  const fleetUsage = { "1": usage(89.0), "2": usage(95.0) };
  const headroom = { "1": 11.0 };

  it("test_the_null_snapshot_answers_differently_by_recorded_trigger", () => {
    const e = fakeEngine();
    const failoverState = {
      lastSwitchFrom: "1",
      leftHeadroom: null,
      leftRecoveryAt: null,
      leftTrigger: "failover",
    };
    const consumeFirstState = {
      lastSwitchFrom: "1",
      leftHeadroom: null,
      leftRecoveryAt: null,
      leftTrigger: "consume-first",
    };
    const failoverRecovered = e.leftAccountRecovered(failoverState, fleetUsage, headroom, 5.0, settings, now, "2");
    const ordinaryRecovered = e.leftAccountRecovered(consumeFirstState, fleetUsage, headroom, 5.0, settings, now, "2");
    expect(failoverRecovered, "the failover landing floor (h > 10) releases at 11 points").toBe(true);
    expect(ordinaryRecovered, "the consume-first dominance leg (h > 13) does not clear at 11 points").toBe(false);
  });

  it("test_pre_upgrade_null_snapshot_without_leftTrigger_still_infers_failover", () => {
    const e = fakeEngine();
    const legacyState = { lastSwitchFrom: "1", leftHeadroom: null, leftRecoveryAt: null };
    const recovered = e.leftAccountRecovered(legacyState, fleetUsage, headroom, 5.0, settings, now, "2");
    expect(recovered, "no leftTrigger: two nulls infer failover").toBe(true);
  });

  it("test_a_legacy_record_with_a_real_leftHeadroom_is_never_forced_through_the_failover_legs", () => {
    const e = fakeEngine();
    const legacyStateRealHeadroom = { lastSwitchFrom: "1", leftHeadroom: 10.0, leftRecoveryAt: null };
    const recovered = e.leftAccountRecovered(legacyStateRealHeadroom, fleetUsage, headroom, 5.0, settings, now, "2");
    expect(recovered, "a real leftHeadroom is an ordinary departure: both ordinary legs fail at h=11").toBe(false);
  });

  it("test_end_to_end_consume_first_departure_records_its_own_trigger", async () => {
    const h = new EngineHarness(null, { strategy: "consume-first" });
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.makeLive("a@example.com", 1);
    const out = await h.tickWithUsage({
      "1": usage7(20, 20, R_LATER),
      "2": usage7(10, 10, R_SOON),
    });
    expect(out).toBe(TickOutcome.SWITCHED);
    expect(h.engine.readState().leftTrigger).toBe("consume-first");
  });

  it("test_end_to_end_failover_departure_records_its_own_trigger", async () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.makeLive("a@example.com", 1);
    let out: TickOutcomeType | null = null;
    for (let i = 0; i < 3; i++) {
      out = await h.tickWithUsage({ "1": null, "2": usage(4) });
      h.clock.advance(60.0);
    }
    expect(out).toBe(TickOutcome.SWITCHED);
    expect(h.engine.readState().leftTrigger).toBe("failover");
  });
});

describe("TestEveryAccountAboveThreshold", () => {
  it("test_moves_to_the_soonest_recovering_account", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage(99, at(h, 3600 * 2)),
      "2": usage(100, at(h, 600)),
      "3": usage(95, at(h, 480)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(3);
  });

  it("test_soonest_wins_over_most_headroom", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage(99, at(h, 3600)),
      "2": usage(91, at(h, 3600 * 3)),
      "3": usage(97, at(h, 300)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(3);
  });

  it("test_a_single_healthy_peer_still_wins_normally", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage(99, at(h, 3600)),
      "2": usage(95, at(h, 60)),
      "3": usage(20, at(h, 3600 * 5)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(3);
  });

  it("test_below_threshold_is_untouched", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({ "1": usage(50), "2": usage(10), "3": usage(10) });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
  });

  it("test_all_at_limit_still_reports_exhausted", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage(100, at(h, 600)),
      "2": usage(100, at(h, 300)),
      "3": usage(100, at(h, 900)),
    });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(h.activeNumber()).toBe(1);
  });

  it("test_unknown_reset_sorts_last_not_first", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage(99, at(h, 3600)),
      "2": usage(95),
      "3": usage(97, at(h, 600)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(3);
  });

  it("test_does_not_flap_between_two_near_equal_accounts", async () => {
    const h = makeHarness();
    const a = at(h, 600);
    const b = at(h, 660);
    const first = await h.tickWithUsage({ "1": usage(99, a), "2": usage(98, b), "3": usage(100, a) });
    expect(first, "60s sooner is not worth a switch").toBe(TickOutcome.BLOCKED);
    expect(h.activeNumber()).toBe(1);
  });

  it("test_a_meaningfully_sooner_account_still_wins", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage(99, at(h, 3600)),
      "2": usage(98, at(h, 600)),
      "3": usage(100, at(h, 60)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
  });

  it("test_consume_first_gets_the_same_anti_flap_guard", async () => {
    const h = new EngineHarness(null, { strategy: "consume-first" });
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.seed(3, "c@example.com");
    h.makeLive("a@example.com", 1);
    const a = at(h, 600);
    const b = at(h, 660);
    const outcome = await h.tickWithUsage({ "1": usage(99, a), "2": usage(98, b), "3": usage(100, a) });
    expect(outcome, "consume-first skipped the recovery hysteresis").toBe(TickOutcome.BLOCKED);
    expect(h.activeNumber()).toBe(1);
  });

  it("test_at_limit_trigger_still_ignores_the_landing_rule", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage(100, at(h, 60)),
      "2": usage(30, at(h, 86400)),
      "3": usage(95, at(h, 120)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber(), "at-limit must still take the account with real headroom").toBe(2);
    expect(firstSwitch(h).trigger).toBe("at-limit");
  });
});

describe("TestRecoveryIsUsefulEitherClause", () => {
  it("test_the_active_alone_being_inside_the_horizon_is_enough", () => {
    const now = 1_000_000.0;
    const candRecoveryTs = now + RECOVERY_HORIZON_S + 3600.0;
    const activeRecoveryTs = now + 1800.0;
    expect(recoveryIsUseful(candRecoveryTs, activeRecoveryTs, 50.0, 50.0, now)).toBe(true);
  });

  it("test_the_control_neither_inside_falls_back_to_headroom", () => {
    const now = 1_000_000.0;
    const candRecoveryTs = now + RECOVERY_HORIZON_S + 3600.0;
    const activeRecoveryTs = now + RECOVERY_HORIZON_S + 7200.0;
    expect(recoveryIsUseful(candRecoveryTs, activeRecoveryTs, 50.0, 50.0, now)).toBe(false);
  });
});

describe("TestRecoveryHorizon", () => {
  it("test_a_minutes_away_reset_still_wins", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage(91, at(h, 7200)),
      "2": usage(94, at(h, 1800)),
      "3": usage(98, at(h, 480)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(3);
  });

  it("test_a_days_away_reset_does_not_buy_headroom", async () => {
    const h = makeHarness();
    await h.tickWithUsage({
      "1": usage(91, at(h, 109 * 3600)),
      "2": usage(94, at(h, 80 * 3600)),
      "3": usage(98, at(h, 50 * 3600)),
    });
    expect(h.activeNumber(), "traded 9 points of headroom for 2 on a distant reset").toBe(1);
  });

  it("test_an_unreadable_peer_does_not_veto_the_spent_check", async () => {
    const h = new EngineHarness();
    for (const [n, e] of [
      [1, "a@example.com"],
      [2, "b@example.com"],
      [3, "c@example.com"],
      [4, "d@example.com"],
    ] as const) {
      h.seed(n, e);
    }
    h.makeLive("a@example.com", 1);
    const outcome = await h.tickWithUsage({
      "1": usage(99, at(h, 109 * 3600)),
      "2": usage(99, at(h, 80 * 3600)),
      "3": usage(99, at(h, 50 * 3600)),
      "4": USAGE_TOKEN_EXPIRED,
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber(), "an unreadable peer vetoed the spent check").toBe(3);
  });

  it("test_an_unreadable_peer_does_not_forge_headroom_for_the_spent_check", async () => {
    const h = new EngineHarness();
    for (const [n, e] of [
      [1, "a@example.com"],
      [2, "b@example.com"],
      [3, "c@example.com"],
    ] as const) {
      h.seed(n, e);
    }
    h.makeLive("a@example.com", 1);
    const outcome = await h.tickWithUsage({
      "1": usage(97.5, at(h, 500 * 3600)),
      "2": usage(98.0, at(h, 490 * 3600)),
      "3": USAGE_TOKEN_EXPIRED,
    });
    expect(outcome, "an unreadable sibling forged as 100.0 turns off the all-spent escape").toBe(
      TickOutcome.SWITCHED,
    );
    expect(h.activeNumber()).toBe(2);
  });

  it("test_a_weekly_bound_active_does_not_refuse_a_peer_back_in_minutes", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage7(10, 96, at(h, 109 * 3600)),
      "2": usage(98, at(h, 480)),
      "3": usage(99, at(h, 90 * 3600)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber(), "refused a peer back in 8 minutes because the active was weekly-bound").toBe(2);
  });

  it("test_an_unknown_active_reset_keeps_the_headroom", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage(91),
      "2": usage(98, at(h, 80 * 3600)),
      "3": usage(99, at(h, 50 * 3600)),
    });
    expect(h.activeNumber(), "traded 9 points for 1 because the active reset was unknown").toBe(1);
    expect(outcome).not.toBe(TickOutcome.SWITCHED);
  });

  it("test_a_peer_with_real_headroom_still_wins_past_the_horizon", async () => {
    const h = makeHarness();
    const outcome = await h.tickWithUsage({
      "1": usage(97, at(h, 50 * 3600)),
      "2": usage(91, at(h, 109 * 3600)),
      "3": usage(98, at(h, 60 * 3600)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
  });
});

describe("TestTheHorizonDoesNotDiscardWhatItAlreadyKnows", () => {
  it("test_equal_headroom_past_the_horizon_takes_the_sooner_reset", async () => {
    const h = makeHarness();
    const out = await h.tickWithUsage({
      "1": usage(96, at(h, 300 * 3600)),
      "2": usage(92, at(h, 500 * 3600)),
      "3": usage(92, at(h, 5 * 3600)),
    });
    expect(out).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber(), "equal headroom, and the 5h reset lost to the 500h one on slot order").toBe(3);
  });

  it("test_a_peer_worth_having_is_not_filtered_out_of_the_worth_having_check", async () => {
    // Whether it takes account 2 or holds is the anti-flap margin's call. It must not take account 3.
    const h = makeHarness();
    const out = await h.tickWithUsage({
      "1": usage(97.0, at(h, 500 * 3600)),
      "2": usage(94.01, at(h, 400 * 3600)),
      "3": usage(99.9, at(h, 200 * 3600)),
    });
    expect(h.activeNumber(), "took the 0.10-point account over one holding 5.99").not.toBe(3);
    expect(out !== TickOutcome.SWITCHED || h.activeNumber() === 2).toBe(true);
  });

  it("test_an_unchoosable_peer_does_not_veto_the_reset_ranking", async () => {
    const h = makeHarness();
    const out = await h.tickWithUsage({
      "1": usage(97.0, at(h, 200 * 3600)),
      "2": usage(97.0, at(h, 10 * 3600)),
      "3": usage(96.95, at(h, 500 * 3600)),
    });
    expect(out).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber(), "a peer that cannot be chosen vetoed the ranking for everyone").toBe(2);
  });
});
