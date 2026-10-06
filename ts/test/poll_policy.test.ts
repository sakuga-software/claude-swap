import { describe, expect, it } from "vitest";
import type { UsageDict } from "../src/oauth.js";
import * as pollPolicy from "../src/poll_policy.js";
import type { PlanAfterFetchOptions } from "../src/poll_policy.js";
import { isoformat } from "../src/support/py.js";

const NOW = 1_000_000.0;
const HALF = (): number => 0.5;

function usage(pct: number, resetsAt?: string): UsageDict {
  const window: { pct: number; resets_at?: string } = { pct };
  if (resetsAt) window.resets_at = resetsAt;
  return { five_hour: window, seven_day: { pct: 0.0 } };
}

function plan(overrides: Partial<PlanAfterFetchOptions> = {}): [number, number] {
  return pollPolicy.planAfterFetch({
    prevIntervalS: null,
    prevUsage: null,
    newUsage: usage(10),
    isActive: false,
    threshold: 90.0,
    models: [],
    recent429: false,
    now: NOW,
    rng: HALF,
    ...overrides,
  });
}

describe("TestIntervalAdaptation", () => {
  it("test_first_fetch_uses_defaults", () => {
    const [, active] = plan({ isActive: true });
    const [, candidate] = plan({ isActive: false });
    expect(active).toBe(pollPolicy.MIN_INTERVAL_S);
    expect(candidate).toBe(pollPolicy.CANDIDATE_DEFAULT_INTERVAL_S);
  });

  it("test_unmoved_decays_toward_the_ceiling", () => {
    const [, interval] = plan({ prevIntervalS: 300.0, prevUsage: usage(10) });
    expect(interval).toBe(450.0);
    const [, capped] = plan({ prevIntervalS: 500.0, prevUsage: usage(10) });
    expect(capped).toBe(pollPolicy.CANDIDATE_MAX_INTERVAL_S);
    const [, activeCapped] = plan({ prevIntervalS: 250.0, prevUsage: usage(10), isActive: true });
    expect(activeCapped).toBe(pollPolicy.ACTIVE_MAX_INTERVAL_S);
  });

  it("test_movement_halves_floored_at_min", () => {
    const [, interval] = plan({ prevIntervalS: 600.0, prevUsage: usage(10), newUsage: usage(15) });
    expect(interval).toBe(300.0);
    const [, floored] = plan({ prevIntervalS: 200.0, prevUsage: usage(10), newUsage: usage(15) });
    expect(floored).toBe(pollPolicy.MIN_INTERVAL_S);
  });

  it("test_sub_delta_wiggle_is_not_movement", () => {
    const [, interval] = plan({ prevIntervalS: 300.0, prevUsage: usage(10), newUsage: usage(10.5) });
    expect(interval).toBe(450.0);
  });

  it("test_unknown_pct_uses_the_default", () => {
    const [, interval] = plan({ prevIntervalS: 600.0, newUsage: null });
    expect(interval).toBe(pollPolicy.CANDIDATE_DEFAULT_INTERVAL_S);
  });
});

describe("TestUrgentMode", () => {
  function urgentKwargs(overrides: Partial<PlanAfterFetchOptions> = {}): Partial<PlanAfterFetchOptions> {
    return {
      prevIntervalS: pollPolicy.MIN_INTERVAL_S,
      prevUsage: usage(78),
      newUsage: usage(82),
      isActive: true,
      threshold: 90.0,
      ...overrides,
    };
  }

  it("test_active_moving_in_band_goes_urgent", () => {
    const [, interval] = plan(urgentKwargs());
    expect(interval).toBe(pollPolicy.URGENT_INTERVAL_S);
  });

  it("test_candidate_never_goes_urgent", () => {
    const [, interval] = plan(urgentKwargs({ isActive: false }));
    expect(interval).toBe(pollPolicy.MIN_INTERVAL_S);
  });

  it("test_no_movement_no_urgency", () => {
    const [, interval] = plan(urgentKwargs({ newUsage: usage(78) }));
    expect(interval).toBeGreaterThan(pollPolicy.URGENT_INTERVAL_S);
  });

  it("test_below_the_band_no_urgency", () => {
    const [, interval] = plan(urgentKwargs({ prevUsage: usage(40), newUsage: usage(50) }));
    expect(interval).toBe(pollPolicy.MIN_INTERVAL_S);
  });

  it("test_recent_429_suppresses_urgency", () => {
    const [, interval] = plan(urgentKwargs({ recent429: true }));
    expect(interval).toBe(pollPolicy.POST_429_MIN_INTERVAL_S);
  });

  it("test_urgent_then_unmoved_snaps_back_to_the_floor", () => {
    const [, interval] = plan(urgentKwargs({ prevIntervalS: pollPolicy.URGENT_INTERVAL_S, newUsage: usage(78) }));
    expect(interval).toBe(pollPolicy.MIN_INTERVAL_S);
  });
});

describe("TestPost429Floor", () => {
  it("test_recent_429_floors_the_cadence", () => {
    const [, interval] = plan({ recent429: true, prevUsage: usage(10) });
    expect(interval).toBeGreaterThanOrEqual(pollPolicy.POST_429_MIN_INTERVAL_S);
  });

  it("test_slower_learned_cadence_survives_the_floor", () => {
    const [, interval] = plan({ recent429: true, prevIntervalS: 590.0, prevUsage: usage(10) });
    expect(interval).toBeCloseTo(590.0 * pollPolicy.POST_429_BACKOFF_MULT);
    expect(interval).toBeGreaterThan(pollPolicy.POST_429_MIN_INTERVAL_S);
  });
});

describe("TestPost429Aimd", () => {
  it("test_recent_429_multiplicatively_increases_from_prev", () => {
    const [, interval] = plan({
      recent429: true,
      prevIntervalS: pollPolicy.POST_429_MIN_INTERVAL_S,
      prevUsage: usage(10),
    });
    expect(interval).toBeGreaterThan(pollPolicy.POST_429_MIN_INTERVAL_S);
    expect(interval).toBeCloseTo(pollPolicy.POST_429_MIN_INTERVAL_S * pollPolicy.POST_429_BACKOFF_MULT);
  });

  it("test_recent_429_ceiling_exceeds_normal_candidate_max", () => {
    expect(pollPolicy.POST_429_MAX_INTERVAL_S).toBeGreaterThan(pollPolicy.CANDIDATE_MAX_INTERVAL_S);
    const [, interval] = plan({
      recent429: true,
      prevIntervalS: pollPolicy.POST_429_MAX_INTERVAL_S,
      prevUsage: usage(10),
    });
    expect(interval).toBe(pollPolicy.POST_429_MAX_INTERVAL_S);
  });

  it("test_no_429_uses_normal_ceiling", () => {
    const [, interval] = plan({ recent429: false, prevIntervalS: 590.0, prevUsage: usage(10) });
    expect(interval).toBe(pollPolicy.CANDIDATE_MAX_INTERVAL_S);
  });

  function convergeTrajectory(recent429: boolean, rounds = 12): number[] {
    let prev: number | null = null;
    const traj: number[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const [, interval] = plan({ recent429, prevIntervalS: prev, prevUsage: usage(10), newUsage: usage(10) });
      traj.push(interval);
      prev = interval;
    }
    return traj;
  }

  it("test_sustained_429_grows_the_interval_to_the_wide_ceiling", () => {
    const traj = convergeTrajectory(true);
    expect(traj.at(-1)).toBe(pollPolicy.POST_429_MAX_INTERVAL_S);
    expect(traj).toEqual([...traj].sort((a, b) => a - b));
    expect(Math.max(...traj)).toBe(pollPolicy.POST_429_MAX_INTERVAL_S);
    for (let i = 0; i + 1 < traj.length; i += 1) {
      const a = traj[i]!;
      const b = traj[i + 1]!;
      if (b < pollPolicy.POST_429_MAX_INTERVAL_S) expect(b).toBeCloseTo(a * pollPolicy.POST_429_BACKOFF_MULT);
    }
  });

  it("test_without_recency_the_interval_is_capped_at_the_narrow_ceiling", () => {
    const traj = convergeTrajectory(false);
    expect(Math.max(...traj)).toBe(pollPolicy.CANDIDATE_MAX_INTERVAL_S);
    expect(pollPolicy.CANDIDATE_MAX_INTERVAL_S).toBeLessThan(pollPolicy.POST_429_MAX_INTERVAL_S);
  });
});

describe("TestResetCapping", () => {
  function iso(ts: number): string {
    return isoformat(new Date(ts * 1000)).replace("+00:00", "Z");
  }

  it("test_poll_never_scheduled_past_a_future_reset", () => {
    const resetTs = NOW + 90.0;
    const [nextPoll, interval] = plan({ newUsage: usage(40, iso(resetTs)) });
    expect(nextPoll).toBeCloseTo(resetTs + pollPolicy.RESET_SLACK_S);
    expect(interval).toBe(pollPolicy.CANDIDATE_DEFAULT_INTERVAL_S);
  });

  it("test_at_limit_keeps_bounded_polling_before_distant_reset", () => {
    const resetTs = NOW + 7_200.0;
    const [nextPoll, interval] = plan({ newUsage: usage(100, iso(resetTs)) });
    expect(interval).toBe(pollPolicy.EXHAUSTED_INTERVAL_S);
    expect(nextPoll).toBeCloseTo(NOW + interval);
    expect(nextPoll).toBeLessThan(resetTs);
  });

  it("test_at_limit_poll_is_pulled_to_an_imminent_reset", () => {
    const resetTs = NOW + 90.0;
    const [nextPoll, interval] = plan({ newUsage: usage(100, iso(resetTs)) });
    expect(interval).toBe(pollPolicy.EXHAUSTED_INTERVAL_S);
    expect(nextPoll).toBeCloseTo(resetTs + pollPolicy.RESET_SLACK_S);
  });

  it.each([NOW - 90.0, NOW])("test_at_limit_ignores_non_future_reset", (resetTs) => {
    const [nextPoll, interval] = plan({ newUsage: usage(100, iso(resetTs)) });
    expect(interval).toBe(pollPolicy.EXHAUSTED_INTERVAL_S);
    expect(nextPoll).toBeCloseTo(NOW + interval);
  });

  it("test_active_at_limit_uses_same_bounded_recovery_probe", () => {
    const resetTs = NOW + 7_200.0;
    const [nextPoll, interval] = plan({ newUsage: usage(100, iso(resetTs)), isActive: true });
    expect(interval).toBe(pollPolicy.EXHAUSTED_INTERVAL_S);
    expect(nextPoll).toBeCloseTo(NOW + interval);
  });
});

describe("TestJitter", () => {
  it("test_jitter_bounds", () => {
    pollPolicy.internals.JITTER_FRAC = 0.1;
    const [early] = plan({ rng: () => 0.0 });
    const [late] = plan({ rng: () => 1.0 });
    const interval = pollPolicy.CANDIDATE_DEFAULT_INTERVAL_S;
    expect(early).toBeCloseTo(NOW + interval * 0.9);
    expect(late).toBeCloseTo(NOW + interval * 1.1);
  });
});

describe("TestBudgetInvariants", () => {
  it("test_sustained_floor_stays_under_the_hourly_cap", () => {
    expect(pollPolicy.MIN_INTERVAL_S).toBeGreaterThanOrEqual(180.0);
    expect(pollPolicy.SERVE_TTL_S).toBeGreaterThanOrEqual(180.0);
  });

  it("test_edge_backoff_probes_slower_than_capacity_frees", () => {
    expect(pollPolicy.EDGE_BACKOFF_S).toBeGreaterThanOrEqual(300.0);
  });

  it("test_post_429_floor_covers_the_saturation_horizon", () => {
    expect(pollPolicy.RECENT_429_WINDOW_S).toBeGreaterThanOrEqual(3600.0);
    expect(pollPolicy.POST_429_MIN_INTERVAL_S).toBeGreaterThanOrEqual(pollPolicy.MIN_INTERVAL_S);
  });

  it("test_urgent_episode_alone_fits_inside_the_window_cap", () => {
    const polls = pollPolicy.ESCALATION_MARGIN_PCT / pollPolicy.MOVEMENT_DELTA_PCT;
    expect(polls).toBeLessThan(27);
  });
});
