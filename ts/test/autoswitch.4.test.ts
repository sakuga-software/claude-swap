import { describe, expect, it, vi } from "vitest";
import {
  AllExhaustedEvent,
  SPENT_HEADROOM_PCT,
  SwitchEvent,
  TickOutcome,
  bindingRecoveryTs,
} from "../src/autoswitch.js";
import * as oauth from "../src/oauth.js";
import { autoSwitchSettings } from "../src/settings.js";
import { UsageEntry } from "../src/usage_store.js";
import {
  EngineHarness,
  type UsageValue,
  entryFor,
  isoAt,
  makeHarness,
  usage,
} from "./helpers/autoswitch_harness.js";

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

const daysOutCache = new WeakMap<EngineHarness, Map<number, string>>();

/** A reset fixed at the first call for each (harness, hours), so it comes nearer as the clock advances. */
function daysOut(h: EngineHarness, hours: number): string {
  let cache = daysOutCache.get(h);
  if (!cache) {
    cache = new Map();
    daysOutCache.set(h, cache);
  }
  let value = cache.get(hours);
  if (value === undefined) {
    value = at(h, hours * 3600);
    cache.set(hours, value);
  }
  return value;
}

const OUTCOME_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(TickOutcome).map(([name, value]) => [value, name]),
);

function names(outcomes: readonly TickOutcome[]): string {
  return JSON.stringify(outcomes.map((o) => OUTCOME_NAMES[o]));
}

function twoAccounts(settings: Parameters<typeof makeHarness>[0] = {}): EngineHarness {
  const h = new EngineHarness(null, settings);
  h.seed(1, "a@example.com");
  h.seed(2, "b@example.com");
  h.makeLive("a@example.com", 1);
  return h;
}

function threeAccounts(settings: Parameters<typeof makeHarness>[0] = {}): EngineHarness {
  const h = new EngineHarness(null, settings);
  h.seed(1, "a@example.com");
  h.seed(2, "b@example.com");
  h.seed(3, "c@example.com");
  h.makeLive("a@example.com", 1);
  return h;
}

async function failoverToTwo(h: EngineHarness, peerReset: () => string): Promise<void> {
  let outcome: TickOutcome | null = null;
  for (let i = 0; i < 3; i++) {
    outcome = await h.tickWithUsage({ "1": null, "2": usage(4, peerReset()) });
    h.clock.advance(60.0);
  }
  expect(outcome).toBe(TickOutcome.SWITCHED);
  expect(h.activeNumber()).toBe(2);
}

describe("TestHorizonAxisDoesNotFlap", () => {
  it("test_a_fixed_reset_crosses_into_the_horizon_as_the_clock_advances", async () => {
    const harness = makeHarness();
    const outcome1 = await harness.tickWithUsage({
      "1": usage(95, daysOut(harness, 400)),
      "2": usage(94, daysOut(harness, 5)),
    });
    expect(outcome1, "premise: 5h is outside RECOVERY_HORIZON_S").not.toBe(TickOutcome.SWITCHED);
    harness.clock.advance(90 * 60.0);

    const outcome2 = await harness.tickWithUsage({
      "1": usage(95, daysOut(harness, 400)),
      "2": usage(94, daysOut(harness, 5)),
    });
    expect(outcome2, "the fixed reset is now 3.5h away, inside the horizon").toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(2);
  });

  it("test_one_point_of_headroom_does_not_move", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(95, daysOut(harness, 109)),
      "2": usage(94, daysOut(harness, 80)),
      "3": usage(99, daysOut(harness, 50)),
    });
    expect(harness.activeNumber(), "moved for one point of headroom").toBe(1);
    expect(outcome).not.toBe(TickOutcome.SWITCHED);
  });

  it("test_the_return_leg_is_blocked_too", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(96, daysOut(harness, 109)),
      "2": usage(95, daysOut(harness, 80)),
      "3": usage(99, daysOut(harness, 50)),
    });
    expect(harness.activeNumber()).toBe(1);
    expect(outcome).not.toBe(TickOutcome.SWITCHED);
  });

  it("test_a_pair_straddling_the_horizon_does_not_ping_pong", async () => {
    const harness = makeHarness();
    const rFar = daysOut(harness, 109);
    const rNear = daysOut(harness, 3.5);
    const seen: (number | null)[] = [];
    for (let i = 0; i < 6; i++) {
      await harness.tickWithUsage({ "1": usage(92, rFar), "2": usage(97, rNear) });
      seen.push(harness.activeNumber());
      harness.clock.advance(301.0);
    }
    expect(new Set(seen).size, `cross-axis oscillation: active trace ${JSON.stringify(seen)}`).toBe(1);
  });

  it("test_the_spent_fallback_needs_a_meaningfully_sooner_reset", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(97.5, daysOut(harness, 500.02)),
      "2": usage(96.0, daysOut(harness, 500.0)),
    });
    expect(harness.activeNumber(), "moved for a 72-second-sooner reset three weeks out").toBe(1);
    expect(outcome).not.toBe(TickOutcome.SWITCHED);
  });

  it("test_the_tier_byte_puts_a_returning_peer_ahead_of_a_distant_one", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(99, daysOut(harness, 300)),
      "2": usage(98.5, daysOut(harness, 1)),
      "3": usage(91, daysOut(harness, 400)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(2);
  });

  it("test_the_fallback_breaks_a_reset_tie_by_headroom", async () => {
    const harness = makeHarness();
    const same = daysOut(harness, 10);
    const outcome = await harness.tickWithUsage({
      "1": usage(97, daysOut(harness, 300)),
      "2": usage(97, same),
      "3": usage(96.95, same),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(3);
  });

  it("test_past_the_horizon_headroom_decides_before_the_reset", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(99, daysOut(harness, 20)),
      "2": usage(98, daysOut(harness, 10)),
      "3": usage(96, daysOut(harness, 20)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(3);
  });

  it("test_a_burn_walk_settles_instead_of_oscillating", async () => {
    const harness = makeHarness();
    const seen: number[] = [];
    const pct: Record<string, number> = { "1": 96.0, "2": 92.0 };
    for (let i = 0; i < 24; i++) {
      await harness.tickWithUsage({
        "1": usage(pct["1"]!, daysOut(harness, 20)),
        "2": usage(pct["2"]!, daysOut(harness, 80)),
      });
      const active = harness.activeNumber()!;
      seen.push(active);
      pct[String(active)] = Math.min(99.95, pct[String(active)]! + 0.25);
      harness.clock.advance(301.0);
    }
    const moves = seen.filter((n, i) => i === 0 || n !== seen[i - 1]);
    expect(moves.length, `move sequence ${JSON.stringify(moves)}`).toBeLessThanOrEqual(2);
    expect(seen.slice(-4), `active trace ${JSON.stringify(seen)}`).toEqual(Array(4).fill(seen.at(-1)));
  });

  it("test_the_no_return_filter_does_not_block_the_at_limit_escape", async () => {
    const harness = makeHarness();
    harness.engine.mutateState((st) => {
      st.lastSwitchFrom = "2";
    });
    const outcome = await harness.tickWithUsage({ "1": usage(100), "2": usage(0) });
    expect(outcome, "the at-limit escape was refused").toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(2);
  });

  it("test_a_burn_walk_never_returns_to_what_it_left", async () => {
    const harness = makeHarness();
    const pct: Record<string, number> = { "1": 92.0, "2": 92.0 };
    const seen: number[] = [];
    for (let i = 0; i < 60; i++) {
      await harness.tickWithUsage({
        "1": usage(pct["1"]!, daysOut(harness, 500)),
        "2": usage(pct["2"]!, daysOut(harness, 400)),
      });
      const active = harness.activeNumber()!;
      seen.push(active);
      pct[String(active)] = Math.min(99.95, pct[String(active)]! + 0.5);
      harness.clock.advance(301.0);
    }
    const moves = seen.filter((n, i) => i === 0 || n !== seen[i - 1]);
    expect(new Set(seen.slice(-8)).size, `move sequence ${JSON.stringify(moves)} does not settle`).toBe(1);
  });

  it("test_a_proactive_move_does_not_lock_out_the_next_one", async () => {
    const harness = makeHarness();
    expect(
      await harness.tickWithUsage({
        "1": usage(92, daysOut(harness, 500)),
        "2": usage(10, daysOut(harness, 400)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(2);
    harness.clock.advance(301.0);

    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 20; i++) {
      outcomes.push(
        await harness.tickWithUsage({
          "1": usage(0, daysOut(harness, 400)),
          "2": usage(97, daysOut(harness, 500)),
        }),
      );
      harness.clock.advance(1801.0);
    }
    expect(outcomes, `outcomes ${names(outcomes)}`).toContain(TickOutcome.SWITCHED);
  });

  it("test_an_ordinary_departure_does_not_stall_on_a_weekly_bound_peer", async () => {
    const h = twoAccounts({ strategy: "consume-first" });

    expect(
      await h.tickWithUsage({
        "1": usage7(30, 30, daysOut(h, 20)),
        "2": usage7(50, 50, daysOut(h, 10)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    h.clock.advance(301.0);

    const outcomes: TickOutcome[] = [];
    for (const activePct of [50, 80, 90, 95, 98, 99.5, 100]) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage7(30, 30, daysOut(h, 20)),
          "2": usage7(activePct, activePct, daysOut(h, 400)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes[0], `${names(outcomes)}: the first tick already switched`).not.toBe(TickOutcome.SWITCHED);
    expect(outcomes.slice(0, -1), `${names(outcomes)}: returned only at a hard 100%`).toContain(
      TickOutcome.SWITCHED,
    );
  });

  it("test_a_filtered_candidate_does_not_forge_an_all_exhausted_claim", async () => {
    const h = threeAccounts();
    expect(
      await h.tickWithUsage({
        "1": usage(92, daysOut(h, 500)),
        "2": usage(10, daysOut(h, 400)),
        "3": usage(100, daysOut(h, 300)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    h.clock.advance(301.0);

    h.events.length = 0;
    await h.tickWithUsage({
      "1": usage(0, daysOut(h, 400)),
      "2": usage(97, daysOut(h, 500)),
      "3": usage(100, daysOut(h, 300)),
    });
    expect(h.events.some((e) => e instanceof AllExhaustedEvent), `events ${JSON.stringify(h.kinds())}`).toBe(false);
  });

  it("test_the_bar_does_not_hide_the_account_from_the_census", async () => {
    const h = threeAccounts();
    expect(
      await h.tickWithUsage({
        "1": usage(92, daysOut(h, 500)),
        "2": usage(10, daysOut(h, 400)),
        "3": usage(100, daysOut(h, 300)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    h.clock.advance(301.0);

    h.events.length = 0;
    await h.tickWithUsage({
      "1": usage(85, daysOut(h, 400)),
      "2": usage(90, daysOut(h, 500)),
      "3": usage(100, daysOut(h, 300)),
    });
    expect(h.events.some((e) => e instanceof AllExhaustedEvent), `events ${JSON.stringify(h.kinds())}`).toBe(false);
  });

  it("test_the_bar_lifts_when_it_would_leave_nothing", async () => {
    const h = twoAccounts({ strategy: "consume-first" });
    expect(
      await h.tickWithUsage({
        "1": usage7(95, 95, daysOut(h, 500)),
        "2": usage7(5, 5, daysOut(h, 400)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    h.clock.advance(301.0);

    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 20; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage7(0, 0, daysOut(h, 10)),
          "2": usage7(30, 30, daysOut(h, 500)),
        }),
      );
      h.clock.advance(1801.0);
    }
    expect(outcomes, `20 ticks of ${names(outcomes)}`).toContain(TickOutcome.SWITCHED);
  });

  it("test_the_bar_never_applies_to_an_escape", () => {
    const harness = makeHarness();
    const state = { lastSwitchFrom: 1 };
    const headroom = { "1": 15.0, "2": 10.0, "3": 1.0 };
    // Python passes the truthy list ["1", "3"] as `recovered`.
    for (const trigger of ["at-limit", "failover"]) {
      for (const active of [10.0, null]) {
        expect(
          harness.engine.noReturnAccount(trigger, state, headroom, active, true, harness.settings),
          `trigger=${trigger} active_headroom=${active} barred the account we left`,
        ).toBeNull();
      }
    }
    expect(
      harness.engine.noReturnAccount("proactive", state, headroom, 10.0, true, harness.settings),
      "premise: these inputs are barred when the trigger allows it",
    ).toBe("1");
  });

  it.each([
    ["2", 2, "3"],
    ["2", 3, "1"],
    [2, 2, "3"],
    [2, 3, "1"],
    [null, 3, "3"],
  ] as const)(
    "test_the_bar_only_holds_while_the_engine_is_where_it_landed [%s-%s-%s]",
    async (landed, live, expected) => {
      const h = threeAccounts();
      const back: Record<string, string> = {
        "1": at(h, 1800.0),
        "2": at(h, 7200.0),
        "3": at(h, 3600.0),
      };

      expect(
        await h.tickWithUsage({
          "1": usage(92, back["1"]),
          "2": usage(10, back["2"]),
          "3": usage(92, back["3"]),
        }),
      ).toBe(TickOutcome.SWITCHED);
      expect(h.activeNumber()).toBe(2);
      const state = h.engine.readState();
      expect(state.lastSwitchFrom, "premise: an int `from`").toBe(1);
      expect(state.lastSwitchTo, "premise: a str `to`").toBe("2");
      h.engine.mutateState((st) => {
        if (landed === null) delete st.lastSwitchTo;
        else st.lastSwitchTo = landed;
      });
      if (live !== 2) h.makeLive("c@example.com", 3);
      expect(h.switcher.currentAccountNumber(), "premise: the live login").toBe(String(live));
      h.clock.advance(301.0);

      await h.tickWithUsage({
        "1": usage(99, back["1"]),
        "2": usage(99, back["2"]),
        "3": usage(99, back["3"]),
      });
      expect(
        h.switcher.currentAccountNumber(),
        `lastSwitchTo=${JSON.stringify(landed)} live=${live}: the bar applies only on the landing`,
      ).toBe(expected);
    },
  );

  it("test_the_bar_actually_removes_the_account_from_the_ranking", () => {
    const harness = makeHarness();
    const args = {
      trigger: "proactive",
      consumeFirst: false,
      oauthCandidates: ["1", "3"],
      usage: { "1": usage(40), "2": usage(96), "3": usage(99) },
      headroom: { "1": 60.0, "2": 4.0, "3": 1.0 },
      current: "2",
      activeHeadroom: 4.0,
      settings: autoSwitchSettings(),
      now: harness.clock.now,
    };
    const [unbarred] = harness.engine.rankCandidates({ ...args, noReturn: null });
    const [barred] = harness.engine.rankCandidates({ ...args, noReturn: "1" });

    expect([...unbarred], "premise: account 1 is the pick when nothing bars it").toEqual(["1"]);
    expect([...barred], "the bar did not remove account 1 from the ranking").toEqual([]);
  });

  it("test_the_bar_lifts_when_the_only_alternative_cannot_be_chosen", async () => {
    const h = threeAccounts();
    expect(
      await h.tickWithUsage({
        "1": usage(92, daysOut(h, 500)),
        "2": usage(10, daysOut(h, 400)),
        "3": usage(100, daysOut(h, 300)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    h.clock.advance(301.0);

    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 30; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(97, daysOut(h, 10)),
          "2": usage(98, daysOut(h, 500)),
          "3": usage(100, daysOut(h, 300)),
        }),
      );
      h.clock.advance(3601.0);
    }
    expect(outcomes, `30 ticks of ${names(outcomes.slice(0, 6))}…`).toContain(TickOutcome.SWITCHED);
  });

  it("test_the_bar_lifts_for_an_alternative_the_ranking_would_reject", async () => {
    const h = threeAccounts();
    expect(
      await h.tickWithUsage({
        "1": usage(92, daysOut(h, 500)),
        "2": usage(10, daysOut(h, 400)),
        "3": usage(99, daysOut(h, 300)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    h.clock.advance(301.0);

    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 30; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(96.5, daysOut(h, 10)),
          "2": usage(98, daysOut(h, 500)),
          "3": usage(99, daysOut(h, 300)),
        }),
      );
      h.clock.advance(3601.0);
    }
    expect(outcomes, `30 ticks of ${names(outcomes.slice(0, 6))}…`).toContain(TickOutcome.SWITCHED);
  });

  it("test_an_unreadable_barred_account_does_not_crash_the_tick", () => {
    const harness = makeHarness();
    const state = { lastSwitchFrom: 1 };
    const headroom = { "2": 10.0, "3": 40.0 };
    expect(
      harness.engine.noReturnAccount("proactive", state, headroom, 10.0, true, harness.settings),
      "an unreadable barred account must still bar",
    ).toBe("1");
  });

  it("test_the_bar_lifts_for_a_peer_returning_inside_the_horizon", async () => {
    const h = twoAccounts();
    expect(
      await h.tickWithUsage({
        "1": usage(92, daysOut(h, 500)),
        "2": usage(10, daysOut(h, 400)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    h.clock.advance(301.0);

    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 10; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(96, at(h, 3600)),
          "2": usage(97, daysOut(h, 200)),
        }),
      );
      h.clock.advance(1801.0);
    }
    expect(outcomes, names(outcomes)).toContain(TickOutcome.SWITCHED);
  });

  it("test_the_same_fleet_moves_with_the_bar_cleared", async () => {
    const h = threeAccounts();
    expect(
      await h.tickWithUsage({
        "1": usage(92, daysOut(h, 500)),
        "2": usage(10, daysOut(h, 400)),
        "3": usage(99, daysOut(h, 300)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    h.clock.advance(301.0);
    h.engine.mutateState((st) => {
      delete st.lastSwitchFrom;
    });

    expect(
      await h.tickWithUsage({
        "1": usage(96.5, daysOut(h, 10)),
        "2": usage(98, daysOut(h, 500)),
        "3": usage(99, daysOut(h, 300)),
      }),
      "the control blocked too",
    ).toBe(TickOutcome.SWITCHED);
  });

  it("test_the_bar_reaches_the_ranking_through_tick", async () => {
    const h = threeAccounts();
    expect(
      await h.tickWithUsage({
        "1": usage(92, daysOut(h, 500)),
        "2": usage(10, daysOut(h, 400)),
        "3": usage(50, daysOut(h, 300)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    h.clock.advance(301.0);
    expect(h.engine.readState().lastSwitchFrom, "premise: the move recorded what it left").not.toBeUndefined();
    expect(h.engine.readState().lastSwitchFrom).not.toBeNull();

    const second = {
      "1": usage(99, at(h, 1800)),
      "2": usage(99, at(h, 7200)),
      "3": usage(99, at(h, 3600)),
    };
    expect(await h.tickWithUsage(second)).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber(), "the bar never reached the ranking through tick()").toBe(3);

    h.makeLive("b@example.com", 2);
    h.clock.advance(301.0);
    h.engine.mutateState((st) => {
      delete st.lastSwitchFrom;
    });
    expect(await h.tickWithUsage(second)).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber(), "premise: unbarred, the account we left is the pick").toBe(1);
  });

  it("test_the_release_needs_the_barred_account_to_have_improved", async () => {
    const h = twoAccounts();
    expect(
      await h.tickWithUsage({
        "1": usage(96, daysOut(h, 500)),
        "2": usage(92, daysOut(h, 400)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    h.clock.advance(3612.0);

    const outcomes: TickOutcome[] = [];
    for (const activePct of [98.0, 98.2, 98.4, 99.0, 99.5]) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(96, daysOut(h, 500)),
          "2": usage(activePct, daysOut(h, 400)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes, `${names(outcomes)}: went back to an account exactly as we left it`).not.toContain(
      TickOutcome.SWITCHED,
    );
  });

  it("test_the_release_fires_on_this_same_fleet_once_the_peer_actually_improves", async () => {
    const h = twoAccounts();
    expect(
      await h.tickWithUsage({
        "1": usage(96, daysOut(h, 500)),
        "2": usage(92, daysOut(h, 400)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    h.clock.advance(3612.0);

    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 10; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(0, daysOut(h, 500)),
          "2": usage(98, daysOut(h, 400)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes, names(outcomes)).toContain(TickOutcome.SWITCHED);
  });

  it("test_a_departure_at_full_quota_is_immediately_eligible", async () => {
    const h = twoAccounts({ strategy: "consume-first", threshold: 90.0 });
    expect(
      await h.tickWithUsage({
        "1": usage7(0.0, 0.0, daysOut(h, 500)),
        "2": usage7(0.0, 0.0, daysOut(h, 100)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    expect(h.engine.readState().leftHeadroom, "premise: a full-quota departure").toBe(100.0);
    h.clock.advance(301.0);

    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 10; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage7(0.0, 0.0, daysOut(h, 500)),
          "2": usage7(90.0, 0.0, daysOut(h, 100)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes, names(outcomes)).toContain(TickOutcome.SWITCHED);
  });

  it("test_the_clamp_stays_load_bearing_when_dominance_does_not_fire", () => {
    const harness = makeHarness();
    const state = { lastSwitchFrom: "1", leftHeadroom: 98.0, leftRecoveryAt: null };
    const recovered = harness.engine.leftAccountRecovered(
      state,
      { "1": usage(0) },
      { "1": 100.0 },
      60.0,
      harness.settings,
      harness.clock(),
    );
    expect(recovered, "the clamp must release a near-full departure").toBe(true);
    expect(100.0 >= 98.0 + SPENT_HEADROOM_PCT, "premise: the unclamped threshold is unsatisfiable").toBe(false);
  });

  it("test_the_dominance_leg_does_not_silently_read_an_unreadable_active_as_no_dominance", () => {
    const harness = makeHarness();
    const state = { lastSwitchFrom: "2", leftHeadroom: 40.0, leftRecoveryAt: null };
    const u = { "2": usage(60.0) };
    const readable = harness.engine.leftAccountRecovered(
      state,
      u,
      { "2": 40.0 },
      2.0,
      harness.settings,
      harness.clock(),
      "1",
    );
    const unreadable = harness.engine.leftAccountRecovered(
      state,
      u,
      { "2": 40.0 },
      null,
      harness.settings,
      harness.clock(),
      "1",
    );
    expect(readable, "premise: a readable, dominant active releases").toBe(true);
    expect(unreadable, `readable=${readable} unreadable=${unreadable}`).toBe(true);
  });

  it("test_no_return_account_does_not_re_bar_an_already_recovered_peer_when_the_active_is_unreadable", () => {
    const harness = makeHarness();
    const state = { lastSwitchFrom: "2", leftHeadroom: 40.0, leftRecoveryAt: null };
    const headroom = { "2": 40.0 };
    for (const trigger of ["proactive", "consume-first"]) {
      const readable = harness.engine.noReturnAccount(trigger, state, headroom, 2.0, true, harness.settings);
      const unreadable = harness.engine.noReturnAccount(trigger, state, headroom, null, true, harness.settings);
      expect(readable, `premise: ${trigger} releases when readable`).toBeNull();
      expect(unreadable, `trigger=${trigger} re-barred a recovered peer`).toBeNull();
    }
  });

  it("test_the_all_spent_recovery_leg_carries_its_own_hysteresis", () => {
    const h = twoAccounts();
    const state = { lastSwitchFrom: "1", leftHeadroom: null, leftRecoveryAt: null };
    const u = {
      "1": usage(95.0, at(h, 3600.0)),
      "2": usage(98.0, at(h, 3660.0)),
    };
    const recovered = h.engine.leftAccountRecovered(state, u, { "1": 5.0 }, 2.0, h.settings, h.clock(), "2");
    expect(recovered, "a 60s-sooner reset is inside RECOVERY_HYSTERESIS_S").toBe(false);
  });

  it("test_the_dominance_fallback_does_not_fire_below_its_own_floor", () => {
    const harness = makeHarness();
    const state = { lastSwitchFrom: "2", leftHeadroom: 40.0, leftRecoveryAt: null };
    const recovered = harness.engine.leftAccountRecovered(
      state,
      { "2": usage(95.0) },
      { "2": 5.0 },
      null,
      harness.settings,
      harness.clock(),
      "1",
    );
    expect(recovered, "at 5 pts the peer is below the landing floor (10)").toBe(false);
  });

  it("test_no_return_accounts_unreadable_active_fallback_has_a_floor_too", () => {
    const harness = makeHarness();
    const noReturn = harness.engine.noReturnAccount(
      "proactive",
      { lastSwitchFrom: "2" },
      { "2": 5.0 },
      null,
      true,
      harness.settings,
    );
    expect(noReturn, "a peer below the landing floor must stay barred").toBe("2");
  });

  it("test_a_reset_that_crept_nearer_is_not_a_recovery", async () => {
    const h = twoAccounts();
    const depart = at(h, 500 * 3600);
    expect(
      await h.tickWithUsage({
        "1": usage(96, depart),
        "2": usage(92, daysOut(h, 400)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    h.clock.advance(3612.0);

    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 10; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(96, at(h, 500 * 3600 - 3612 - 60)),
          "2": usage(98, daysOut(h, 400)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes, `${names(outcomes)}: a reset one minute nearer released the bar`).not.toContain(
      TickOutcome.SWITCHED,
    );
  });

  it("test_an_unschedulable_account_that_gained_a_reset_has_recovered", async () => {
    const h = twoAccounts();
    expect(
      await h.tickWithUsage({
        "1": usage(96),
        "2": usage(92, daysOut(h, 400)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    expect(h.engine.readState().leftRecoveryAt ?? null, "premise: the departure reset was null").toBeNull();
    h.clock.advance(3612.0);

    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 10; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(96, at(h, 3600)),
          "2": usage(98, daysOut(h, 400)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes, names(outcomes)).toContain(TickOutcome.SWITCHED);
  });

  it("test_a_switch_that_recorded_no_snapshot_still_releases", async () => {
    const h = twoAccounts();
    h.engine.mutateState((st) => {
      st.lastSwitchFrom = "2";
    });
    h.engine.mutateState((st) => {
      delete st.leftHeadroom;
    });
    h.engine.mutateState((st) => {
      delete st.leftRecoveryAt;
    });
    expect("leftHeadroom" in h.engine.readState(), "premise: no departure snapshot").toBe(false);

    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 20; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(97, daysOut(h, 500)),
          "2": usage(0, daysOut(h, 400)),
        }),
      );
      h.clock.advance(1801.0);
    }
    expect(outcomes, `20 ticks of ${names(outcomes.slice(0, 6))}…`).toContain(TickOutcome.SWITCHED);
  });

  it("test_absence_of_a_snapshot_releases_even_a_poor_or_unreadable_peer", () => {
    const harness = makeHarness();
    const state = { lastSwitchFrom: "2" };
    expect(
      harness.engine.leftAccountRecovered(state, { "2": usage(96) }, { "2": 4.0 }, 2.0, harness.settings, harness.clock()),
      "a pre-upgrade record must release a poor peer",
    ).toBe(true);
    expect(
      harness.engine.leftAccountRecovered(state, { "2": null }, { "2": null }, 2.0, harness.settings, harness.clock()),
      "a pre-upgrade record must release an unreadable peer",
    ).toBe(true);
  });

  it("test_a_failover_departure_does_not_disarm_the_bar", async () => {
    const h = twoAccounts();
    const frozen1 = daysOut(h, 500);
    await failoverToTwo(h, () => daysOut(h, 400));
    const state = h.engine.readState();
    expect("leftHeadroom" in state, "premise: perform writes the keys even on failover").toBe(true);
    expect(state.leftHeadroom ?? null).toBeNull();
    expect(state.leftRecoveryAt ?? null).toBeNull();

    h.clock.advance(301.0);
    const outcomes: TickOutcome[] = [];
    for (const activePct of [98.0, 98.2, 98.4, 99.0, 99.5, 99.9]) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(96, frozen1),
          "2": usage(activePct, daysOut(h, 400)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes, `${names(outcomes)}: a failover departure released the bar`).not.toContain(
      TickOutcome.SWITCHED,
    );
  });

  it("test_a_failover_departure_still_unreadable_does_not_crash_or_release", async () => {
    const h = twoAccounts();
    await failoverToTwo(h, () => daysOut(h, 400));

    h.clock.advance(301.0);
    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 10; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": null,
          "2": usage(98, daysOut(h, 400)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes, `${names(outcomes)}: a null headroom must not raise`).not.toContain(TickOutcome.ERROR);
    expect(outcomes, `${names(outcomes)}: still unreadable is not a recovery`).not.toContain(TickOutcome.SWITCHED);
  });

  it("test_a_failover_departure_releases_once_the_peer_is_readable_again", async () => {
    const h = twoAccounts();
    await failoverToTwo(h, () => daysOut(h, 400));
    const state = h.engine.readState();
    expect(state.leftHeadroom ?? null, "premise: a failover snapshot").toBeNull();
    expect(state.leftRecoveryAt ?? null, "premise: a failover snapshot").toBeNull();

    h.clock.advance(301.0);
    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 10; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(0, daysOut(h, 10)),
          "2": usage(95, daysOut(h, 400)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes, names(outcomes)).toContain(TickOutcome.SWITCHED);
  });

  it("test_a_failover_departure_releases_a_healthy_but_not_near_full_peer", async () => {
    const h = twoAccounts();
    await failoverToTwo(h, () => daysOut(h, 400));
    const state = h.engine.readState();
    expect(state.leftHeadroom ?? null, "premise: a failover snapshot").toBeNull();
    expect(state.leftRecoveryAt ?? null, "premise: a failover snapshot").toBeNull();

    h.clock.advance(301.0);
    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 10; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(30, daysOut(h, 10)),
          "2": usage(98, daysOut(h, 400)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes, names(outcomes)).toContain(TickOutcome.SWITCHED);
  });

  it("test_a_failover_departure_releases_when_the_peer_resets_first_in_the_all_spent_regime", async () => {
    const h = twoAccounts();
    await failoverToTwo(h, () => at(h, 400 * 3600));
    const state = h.engine.readState();
    expect(state.leftHeadroom ?? null, "premise: a failover snapshot").toBeNull();
    expect(state.leftRecoveryAt ?? null, "premise: a failover snapshot").toBeNull();

    h.clock.advance(301.0);
    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 8; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(97.5, at(h, 300.0)),
          "2": usage(98.0, daysOut(h, 400)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes, names(outcomes)).toContain(TickOutcome.SWITCHED);
  });

  it("test_the_recovery_leg_requires_the_actives_reset_to_be_known_not_merely_absent", async () => {
    const cases: [string, (h: EngineHarness) => UsageValue, TickOutcome, number][] = [
      ["active reset UNREPORTED (no resets_at)", () => usage(98.0), TickOutcome.BLOCKED, 2],
      [
        "CONTROL active resets in 500h (finite, still later than peer)",
        (h) => usage(98.0, daysOut(h, 500)),
        TickOutcome.SWITCHED,
        1,
      ],
      [
        "CONTROL active resets in 10min (finite, sooner than peer)",
        (h) => usage(98.0, at(h, 600)),
        TickOutcome.BLOCKED,
        2,
      ],
    ];
    for (const [label, activeRow, expectedOutcome, expectedActive] of cases) {
      const h = twoAccounts();
      await failoverToTwo(h, () => at(h, 400 * 3600));

      h.clock.advance(301.0);
      const out = await h.tickWithUsage({
        "1": usage(97.5, at(h, 400 * 3600)),
        "2": activeRow(h),
      });
      expect(
        [OUTCOME_NAMES[out], h.activeNumber()],
        `${label}: want ${OUTCOME_NAMES[expectedOutcome]}/active=${expectedActive}`,
      ).toEqual([OUTCOME_NAMES[expectedOutcome], expectedActive]);
    }
  });

  it("test_the_isfinite_guard_must_not_hold_when_a_near_peer_is_available", async () => {
    const cases: [string, (h: EngineHarness) => UsageValue, (h: EngineHarness) => string, TickOutcome, number][] = [
      [
        "POS active reset 400h out, peer ~50min out",
        (h) => usage(98.0, at(h, 400 * 3600)),
        (h) => at(h, 3000.0),
        TickOutcome.SWITCHED,
        1,
      ],
      [
        "NEG active reset 400h out, peer only 60s sooner",
        (h) => usage(98.0, at(h, 400 * 3600)),
        (h) => at(h, 400 * 3600 - 60.0),
        TickOutcome.BLOCKED,
        2,
      ],
      ["DMG-a active NO resets_at, peer ~50min out", () => usage(98.0), (h) => at(h, 3000.0), TickOutcome.SWITCHED, 1],
      [
        "DMG-b active reset in PAST, peer ~50min out",
        (h) => usage(98.0, at(h, -3600.0)),
        (h) => at(h, 3000.0),
        TickOutcome.SWITCHED,
        1,
      ],
    ];
    for (const [label, activeRow, peerReset, expectedOutcome, expectedActive] of cases) {
      const h = twoAccounts();
      await failoverToTwo(h, () => at(h, 400 * 3600));

      h.clock.advance(301.0);
      const out = await h.tickWithUsage({
        "1": usage(96.0, peerReset(h)),
        "2": activeRow(h),
      });
      expect(
        [OUTCOME_NAMES[out], h.activeNumber()],
        `${label}: want ${OUTCOME_NAMES[expectedOutcome]}/active=${expectedActive}`,
      ).toEqual([OUTCOME_NAMES[expectedOutcome], expectedActive]);
    }
  });

  it("test_left_snapshot_uses_the_ranking_now_not_a_fresh_clock_read", async () => {
    const h = twoAccounts();
    const rankingNow = 1_000_000.0;
    const resetAt = isoAt(rankingNow + 100.0);
    const staleReread = rankingNow + 200.0;

    const clockValues = [rankingNow, rankingNow, staleReread, staleReread, staleReread, staleReread];
    const spy = vi.spyOn(h.engine, "clock").mockImplementation(() => {
      const value = clockValues.shift();
      if (value === undefined) throw new Error("StopIteration: the clock sequence is exhausted");
      return value;
    });
    let outcome: TickOutcome;
    try {
      outcome = await h.tickWithUsage({ "1": usage(95, resetAt), "2": usage(10) });
    } finally {
      spy.mockRestore();
    }
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.engine.readState().leftRecoveryAt, "the snapshot must use the ranking now").toBe(rankingNow + 100.0);
  });

  it("test_the_all_spent_stall_above_is_the_floor_not_the_fleet", async () => {
    const h = twoAccounts();
    await failoverToTwo(h, () => at(h, 400 * 3600));

    h.engine.mutateState((st) => {
      delete st.leftHeadroom;
    });
    h.engine.mutateState((st) => {
      delete st.leftRecoveryAt;
    });
    expect("leftHeadroom" in h.engine.readState()).toBe(false);

    h.clock.advance(301.0);
    const outcome = await h.tickWithUsage({
      "1": usage(97.5, at(h, 300.0)),
      "2": usage(98.0, daysOut(h, 400)),
    });
    expect(outcome, "the same fleet with no departure snapshot must switch").toBe(TickOutcome.SWITCHED);
  });

  it("test_a_failover_hold_still_escapes_at_limit", async () => {
    const h = twoAccounts();
    await failoverToTwo(h, () => daysOut(h, 400));
    const state = h.engine.readState();
    expect("leftHeadroom" in state, "premise: perform writes the keys even on failover").toBe(true);
    expect(state.leftHeadroom ?? null).toBeNull();
    expect(state.leftRecoveryAt ?? null).toBeNull();

    h.clock.advance(301.0);
    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(96, daysOut(h, 500)),
          "2": usage(98, daysOut(h, 400)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes, `${names(outcomes)}: premise: the failover hold blocks`).not.toContain(TickOutcome.SWITCHED);

    const outcome = await h.tickWithUsage({
      "1": usage(0, daysOut(h, 500)),
      "2": usage(100, daysOut(h, 400)),
    });
    expect(outcome, "the failover hold blocked an at-limit escape").toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(1);
  });

  it("test_the_release_fires_when_the_barred_account_recovered", async () => {
    const h = twoAccounts();
    expect(
      await h.tickWithUsage({
        "1": usage(96, daysOut(h, 500)),
        "2": usage(92, daysOut(h, 400)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    h.clock.advance(3612.0);

    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 10; i++) {
      outcomes.push(
        await h.tickWithUsage({
          "1": usage(0, daysOut(h, 500)),
          "2": usage(98, daysOut(h, 400)),
        }),
      );
      h.clock.advance(301.0);
    }
    expect(outcomes, names(outcomes)).toContain(TickOutcome.SWITCHED);
  });

  it("test_the_ratio_release_changes_where_the_engine_lands", async () => {
    const h = threeAccounts();
    expect(
      await h.tickWithUsage({
        "1": usage(92, daysOut(h, 500)),
        "2": usage(10, daysOut(h, 400)),
        "3": usage(70, daysOut(h, 300)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    h.clock.advance(301.0);

    expect(
      await h.tickWithUsage({
        "1": usage(20, daysOut(h, 500)),
        "2": usage(90, daysOut(h, 400)),
        "3": usage(70, daysOut(h, 300)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(1);
  });

  it("test_the_bar_is_recomputed_on_the_phase_two_snapshot", async () => {
    const h = threeAccounts({ strategy: "consume-first" });
    expect(
      await h.tickWithUsage({
        "1": usage7(20, 20, daysOut(h, 500)),
        "2": usage7(5, 5, daysOut(h, 10)),
        "3": usage7(5, 5, daysOut(h, 400)),
      }),
    ).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    h.clock.advance(301.0);

    const stale = {
      "1": usage7(80, 80, daysOut(h, 10)),
      "2": usage7(70, 70, daysOut(h, 500)),
      "3": usage7(60, 60, daysOut(h, 400)),
    };
    const fresh = {
      "1": usage7(10, 10, daysOut(h, 10)),
      "2": usage7(85, 85, daysOut(h, 500)),
      "3": usage7(60, 60, daysOut(h, 400)),
    };

    vi.spyOn(h.switcher, "usageEntriesByAccount").mockImplementation(async (fetch) => {
      const snap = (fetch?.size ?? 0) >= 3 ? fresh : stale;
      return Object.fromEntries(Object.entries(snap).map(([n, v]) => [n, entryFor(v, h.clock.now)]));
    });
    expect(await h.engine.tick()).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber(), "the bar answered from the stale snapshot").toBe(1);
  });

  it("test_the_fallback_never_outranks_a_real_qualifier", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(97, daysOut(harness, 500)),
      "2": usage(94, daysOut(harness, 400)),
      "3": usage(96.4, daysOut(harness, 100)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(2);
  });

  it("test_the_fallback_ranks_by_reset_not_by_headroom", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(98, daysOut(harness, 300)),
      "2": usage(98, daysOut(harness, 10)),
      "3": usage(96.9, daysOut(harness, 50)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(2);
  });

  it("test_a_materially_better_peer_still_wins", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(98, daysOut(harness, 109)),
      "2": usage(90, daysOut(harness, 80)),
      "3": usage(99, daysOut(harness, 50)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(2);
  });

  it("test_a_minutes_away_reset_is_unaffected", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(91, at(harness, 7200)),
      "2": usage(94, at(harness, 1800)),
      "3": usage(98, at(harness, 480)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(3);
  });
});

describe("TestTheReleasePredicateOneStateShapePerTest", () => {
  it("test_failover_peer_readable_dominant_and_changed_releases", () => {
    const harness = makeHarness();
    const state = { lastSwitchFrom: "2", leftHeadroom: null, leftRecoveryAt: null };
    expect(
      harness.engine.leftAccountRecovered(state, { "2": usage(85) }, { "2": 15.0 }, 2.0, harness.settings, harness.clock()),
      "a peer readable at 15 points (past the floor of 10) must release",
    ).toBe(true);
  });

  it("test_the_failover_floor_moves_with_the_users_threshold", () => {
    const hLow = twoAccounts({ threshold: 60.0 });
    const state = { lastSwitchFrom: "2", leftHeadroom: null, leftRecoveryAt: null };
    expect(
      hLow.engine.leftAccountRecovered(state, { "2": usage(65) }, { "2": 35.0 }, 2.0, hLow.settings, hLow.clock()),
      "threshold=60 -> floor=40; a peer at 35 points must hold",
    ).toBe(false);

    const hHigh = twoAccounts({ threshold: 71.0 });
    expect(
      hHigh.engine.leftAccountRecovered(state, { "2": usage(65) }, { "2": 35.0 }, 2.0, hHigh.settings, hHigh.clock()),
      "threshold=71 -> floor=29; the same peer must release",
    ).toBe(true);
  });

  it("test_failover_peer_frozen_active_burning_holds", async () => {
    const h = twoAccounts();
    await failoverToTwo(h, () => at(h, 400 * 3600));

    h.clock.advance(301.0);
    const outcome = await h.tickWithUsage({
      "1": usage(96, at(h, 500 * 3600)),
      "2": usage(98.2, at(h, 400 * 3600)),
    });
    expect(outcome, "burn of the active alone must not release a failover hold").not.toBe(TickOutcome.SWITCHED);
  });

  it("test_failover_peer_still_poor_holds", () => {
    const harness = makeHarness();
    const state = { lastSwitchFrom: "2", leftHeadroom: null, leftRecoveryAt: null };
    expect(
      harness.engine.leftAccountRecovered(state, { "2": usage(95) }, { "2": 5.0 }, 2.0, harness.settings, harness.clock()),
      "readable is not the same as recovered",
    ).toBe(false);
  });

  it("test_failover_peer_still_unreadable_holds", () => {
    const harness = makeHarness();
    const state = { lastSwitchFrom: "2", leftHeadroom: null, leftRecoveryAt: null };
    expect(
      harness.engine.leftAccountRecovered(state, { "2": null }, { "2": null }, 2.0, harness.settings, harness.clock()),
      "unknown is not evidence of recovery",
    ).toBe(false);
  });

  it("test_ordinary_departure_weekly_bound_peer_that_recovered_releases", () => {
    const harness = makeHarness();
    const state = {
      lastSwitchFrom: "2",
      leftHeadroom: 4.0,
      leftRecoveryAt: harness.clock.now + 3600.0,
    };
    expect(
      harness.engine.leftAccountRecovered(
        state,
        { "2": usage(96, at(harness, 60.0)) },
        { "2": 4.0 },
        8.0,
        harness.settings,
        harness.clock(),
      ),
      "a reset that moved meaningfully nearer is a recovery",
    ).toBe(true);
  });

  it("test_pre_upgrade_record_keys_absent_releases", () => {
    const harness = makeHarness();
    expect(
      harness.engine.leftAccountRecovered(
        { lastSwitchFrom: "2" },
        { "2": usage(96) },
        { "2": 4.0 },
        2.0,
        harness.settings,
        harness.clock(),
      ),
      "a record with no snapshot fields must release",
    ).toBe(true);
  });

  it("test_at_limit_escape_still_works", () => {
    const harness = makeHarness();
    const state = { lastSwitchFrom: "2" };
    const headroom = { "1": 0.0, "2": 100.0 };
    for (const active of [0.0, null]) {
      for (const recovered of [true, false]) {
        expect(
          harness.engine.noReturnAccount("at-limit", state, headroom, active, recovered, harness.settings),
          "at-limit must escape the bar",
        ).toBeNull();
      }
    }
  });
});

describe("TestAllSpentGoesToTheSoonestReset", () => {
  it("test_all_spent_moves_to_the_soonest_reset", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(99, at(harness, 109 * 3600)),
      "2": usage(99, at(harness, 80 * 3600)),
      "3": usage(99, at(harness, 50 * 3600)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber(), "parked on the account that returns last").toBe(3);
  });

  it("test_already_on_the_soonest_stays_put", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(99, at(harness, 50 * 3600)),
      "2": usage(99, at(harness, 80 * 3600)),
      "3": usage(99, at(harness, 109 * 3600)),
    });
    expect(outcome).not.toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(1);
  });

  it("test_real_headroom_still_beats_a_sooner_reset", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(98, at(harness, 109 * 3600)),
      "2": usage(90, at(harness, 80 * 3600)),
      "3": usage(99, at(harness, 50 * 3600)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(2);
  });

  it("test_a_spent_fleet_takes_the_soonest_reset_over_the_most_headroom", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(99.5, at(harness, 300 * 3600)),
      "2": usage(99.5, at(harness, 10 * 3600)),
      "3": usage(99.0, at(harness, 500 * 3600)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(2);
  });

  it("test_the_flap_guard_survives_in_the_spent_band", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(99, at(harness, 50 * 3600)),
      "2": usage(99, at(harness, 50 * 3600 - 60)),
      "3": usage(99, at(harness, 80 * 3600)),
    });
    expect(outcome).not.toBe(TickOutcome.SWITCHED);
  });
});

describe("TestEscapeBeforeTheLimitLands", () => {
  it("test_at_99_the_proactive_path_already_escapes", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(99, at(harness, 109 * 3600)),
      "2": usage(70, at(harness, 80 * 3600)),
      "3": usage(100, at(harness, 50 * 3600)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(2);
    const sw = harness.events.find((e): e is SwitchEvent => e instanceof SwitchEvent)!;
    expect(sw.trigger, "at-limit must stay bound to headroom <= 0").toBe("proactive");
  });

  it("test_at_99_with_only_spent_peers_it_holds", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(99, at(harness, 109 * 3600)),
      "2": usage(100, at(harness, 80 * 3600)),
      "3": usage(100, at(harness, 50 * 3600)),
    });
    expect(outcome).not.toBe(TickOutcome.SWITCHED);
  });

  it("test_below_the_brink_the_ordinary_rules_still_decide", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(50, at(harness, 109 * 3600)),
      "2": usage(45, at(harness, 80 * 3600)),
      "3": usage(40, at(harness, 50 * 3600)),
    });
    expect(outcome).not.toBe(TickOutcome.SWITCHED);
  });
});

describe("TestReviewFindings202", () => {
  it("test_a_short_interval_is_never_lengthened", async () => {
    const harness = makeHarness();
    const switcher = harness.engine.switcher;
    const num = switcher.currentAccountNumber()!;
    const real = switcher.usageEntriesByAccount.bind(switcher);
    vi.spyOn(switcher, "usageEntriesByAccount").mockImplementation(async (fetch, opts) => {
      const entries = { ...(await real(fetch, opts)) };
      entries[num] = new UsageEntry({ ...entries[num], nextPollAt: harness.clock() + 5.0 });
      return entries;
    });
    harness.engine.settings = Object.freeze({ ...harness.engine.settings, intervalSeconds: 15.0 });
    const delay = await harness.engine.nextDelay(TickOutcome.NO_ACTION);
    expect(delay, `a 15s interval slept ${delay.toFixed(1)}s`).toBeLessThanOrEqual(15.0 * 1.1);
  });

  it("test_recovery_reads_the_binding_windows_reset", () => {
    const harness = makeHarness();
    const now = harness.clock();
    const u = {
      five_hour: { pct: 40.0, resets_at: at(harness, 3600) },
      seven_day: { pct: 95.0 },
    };
    expect(bindingRecoveryTs(u, [], now)).toBe(Infinity);
  });

  it("test_at_limit_still_ranks_by_headroom_when_all_are_above", async () => {
    const harness = makeHarness();
    const outcome = await harness.tickWithUsage({
      "1": usage(100, at(harness, 60)),
      "2": usage(91, at(harness, 86400)),
      "3": usage(97, at(harness, 120)),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber(), "at-limit must take the most headroom").toBe(2);
    const sw = harness.events.find((e): e is SwitchEvent => e instanceof SwitchEvent)!;
    expect(sw.trigger).toBe("at-limit");
  });
});

describe("TestFreshenRoutesThroughGate", () => {
  async function freshenWithGateError(error: string): Promise<string> {
    const harness = new EngineHarness();
    harness.seed(2, "b@example.com", { expiresAt: 1 });
    vi.spyOn(harness.switcher, "consumeBackupGrant").mockResolvedValue(oauth.refreshOutcome(null, error));
    return harness.engine.freshenTarget("2", "b@example.com");
  }

  it("test_lock_contention_is_not_reported_as_network_trouble", async () => {
    expect(await freshenWithGateError("consume-busy")).toBe("consume-busy");
  });

  it("test_invalid_client_is_not_reported_as_network_trouble", async () => {
    expect(await freshenWithGateError("invalid_client")).toBe("invalid_client");
  });

  it("test_unreadable_stash_is_not_reported_as_network_trouble", async () => {
    expect(await freshenWithGateError("stash-unreadable")).toBe("stash-unreadable");
  });

  it("test_store_unmirrored_keeps_its_own_kind", async () => {
    expect(await freshenWithGateError("store-unmirrored")).toBe("store-unmirrored");
  });

  it("test_an_actionable_cause_is_not_hidden_by_a_self_clearing_one", async () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com", { expiresAt: 1 });
    h.seed(3, "c@example.com", { expiresAt: 1 });
    h.makeLive("a@example.com", 1);

    vi.spyOn(h.engine, "freshenTarget").mockImplementation(async (num) =>
      num === "2" ? "store-unmirrored" : "consume-busy",
    );
    await h.tickWithUsage({
      "1": usage7(95, 95, R_LATER),
      "2": usage7(10, 10, R_SOON),
      "3": usage7(10, 10, R_LATEST),
    });

    const messages = h.events
      .map((e) => (e as unknown as { message?: unknown }).message)
      .filter((m): m is string => typeof m === "string" && m !== "");
    expect(messages.length, `no error event; got kinds ${JSON.stringify(h.kinds())}`).toBeGreaterThan(0);
    const msg = messages.at(-1)!;
    expect(msg, "the self-clearing cause hid the one needing a human").toContain("CLAUDE_SECURESTORAGE_CONFIG_DIR");
  });

  it("test_a_real_transient_still_reads_transient", async () => {
    expect(await freshenWithGateError("transient")).toBe("transient");
  });

  it("test_freshen_calls_consume_gate", async () => {
    const harness = new EngineHarness();
    harness.seed(2, "b@example.com", { expiresAt: 1 });
    const eng = harness.engine;
    let gateArgs: [string, string, string] | null = null;
    const fresh = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-y", refreshToken: "rt-y", expiresAt: 9999999999000 },
    });
    vi.spyOn(harness.switcher, "consumeBackupGrant").mockImplementation(async (num, email, snapshot) => {
      gateArgs = [num, email, snapshot];
      return oauth.refreshOutcome(fresh, null);
    });
    let directCalled = false;
    vi.spyOn(oauth.internals, "tryRefreshOauthCredentials").mockImplementation(async () => {
      directCalled = true;
      return oauth.refreshOutcome(null, "transient");
    });
    const verdict = await eng.freshenTarget("2", "b@example.com");
    expect(verdict).toBe("ok");
    expect(gateArgs![0]).toBe("2");
    expect(directCalled, "freshen must not POST outside the gate").toBe(false);
  });
});
