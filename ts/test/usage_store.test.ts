import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { relevantWindows, type UsageDict } from "../src/oauth.js";
import * as pollPolicy from "../src/poll_policy.js";
import * as usageStore from "../src/usage_store.js";
import {
  BACKOFF_BASE_S,
  BACKOFF_CAP_S,
  CLAIM_TTL_S,
  RATE_LIMIT_TRUST_MAX_AGE_S,
  SERVE_TTL_S,
  STALE_OK_S,
  TRUST_MAX_AGE_S,
  type FetchRecord,
  type Identity,
  UsageEntry,
  UsageStore,
  dueCandidate,
  withSentinel,
} from "../src/usage_store.js";
import { testHome } from "./helpers/home.js";

const IDENT: Record<string, Identity> = { "1": ["a@x.com", ""], "2": ["b@x.com", "org-2"] };
const USAGE: UsageDict = { five_hour: { pct: 25.0 }, seven_day: { pct: 10.0 } };

class FakeClock {
  now: number;
  constructor(start = 1_000_000.0) {
    this.now = start;
  }
  call = (): number => this.now;
  advance(seconds: number): void {
    this.now += seconds;
  }
}

let clock: FakeClock;
let store: UsageStore;
let tmpPath: string;

beforeEach(() => {
  tmpPath = path.join(testHome(), "tmp");
  clock = new FakeClock();
  store = new UsageStore(path.join(tmpPath, "cache"), clock.call);
});

/** `pytest.approx`: relative tolerance 1e-6, or the given absolute tolerance. */
function expectApprox(actual: number | null | undefined, expected: number, abs?: number): void {
  expect(actual).not.toBeNull();
  expect(actual).not.toBeUndefined();
  const tolerance = abs ?? Math.max(1e-6 * Math.abs(expected), 1e-12);
  expect(Math.abs((actual as number) - expected), `${actual} != ${expected} ± ${tolerance}`).toBeLessThanOrEqual(tolerance);
}

function iso(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

function writeStore(text: string): void {
  fs.mkdirSync(path.dirname(store.path), { recursive: true });
  fs.writeFileSync(store.path, text, "utf8");
}

function rec(init: FetchRecord): FetchRecord {
  return init;
}

const keys = (value: Record<string, unknown>): Set<string> => new Set(Object.keys(value));

describe("TestSchema", () => {
  it("test_empty_when_missing", () => {
    const entries = store.entries(IDENT);
    expect(entries["1"]).toEqual(new UsageEntry());
    expect(entries["1"]!.decisionValue()).toBeNull();
  });

  it("test_versionless_legacy_snapshot_ignored", () => {
    writeStore(JSON.stringify({ timestamp: 123, data: { "1": USAGE } }));
    expect(store.entries(IDENT)["1"]!.lastGood).toBeNull();
  });

  it("test_corrupt_file_ignored", () => {
    writeStore("{not json");
    expect(store.entries(IDENT)["1"]).toEqual(new UsageEntry());
  });

  it("test_round_trip", () => {
    store.record({ "1": rec({ usage: USAGE }) }, IDENT);
    const raw = JSON.parse(fs.readFileSync(store.path, "utf8"));
    expect(raw.schemaVersion).toBe(2);
    const row = raw.accounts["1"];
    expect(row.email).toBe("a@x.com");
    expect(row.lastGood).toEqual(USAGE);
    expect(row.fetchedAt).toBe(clock.now);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.lastGood).toEqual(USAGE);
    expect(entry.ageS).toBe(0.0);
    expect(entry.decisionValue()).toEqual(USAGE);
  });
});

describe("TestStaleOnError", () => {
  it("test_failure_preserves_last_good", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    clock.advance(60);
    store.record({ "1": { error: "http-429" } }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.lastGood).toEqual(USAGE);
    expect(entry.ageS).toBe(60.0);
    expect(entry.lastError).toBe("http-429");
    expect(entry.consecutiveFailures).toBe(1);
    expect(entry.decisionValue()).toEqual(USAGE);
  });

  it("test_too_stale_is_unknown_for_decisions", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    clock.advance(STALE_OK_S + 1);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.decisionValue()).toBeNull();
    expect(entry.lastGood).toEqual(USAGE);
    expect(entry.ageS).toBe(STALE_OK_S + 1);
  });

  it("test_success_clears_failure_state", () => {
    store.record({ "1": { error: "timeout" } }, IDENT);
    clock.advance(5);
    store.record({ "1": { usage: USAGE } }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.consecutiveFailures).toBe(0);
    expect(entry.lastError).toBeNull();
    expect(entry.backoffUntil).toBeNull();
    expect(entry.decisionValue()).toEqual(USAGE);
  });

  it("test_success_with_no_windows", () => {
    store.record({ "1": { usage: null } }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.lastError).toBeNull();
    expect(entry.fetchedAt).not.toBeNull();
    expect(entry.decisionValue()).toBeNull();
  });
});

describe("TestExtendedTrust", () => {
  it("test_in_backoff_past_stale_ok_is_still_trusted", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    clock.advance(STALE_OK_S);
    store.record({ "1": { error: "http-429", retryAfterS: 480.0 } }, IDENT);
    clock.advance(60);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.ageS!).toBeGreaterThan(STALE_OK_S);
    expect(entry.inBackoff(clock.now)).toBe(true);
    expect(entry.trustExtended).toBe(true);
    expect(entry.decisionValue()).toEqual(USAGE);
  });

  it("test_failure_state_after_backoff_expiry_is_still_trusted", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    clock.advance(60);
    store.record({ "1": { error: "timeout" } }, IDENT);
    clock.advance(BACKOFF_BASE_S + STALE_OK_S);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.inBackoff(clock.now)).toBe(false);
    expect(entry.decisionValue()).toEqual(USAGE);
  });

  it("test_within_poll_plan_past_stale_ok_is_trusted", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    store.setPollPlan({ "1": [clock.now + 600.0, 600.0] }, IDENT);
    clock.advance(400);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.consecutiveFailures).toBe(0);
    expect(entry.decisionValue()).toEqual(USAGE);
    clock.advance(250);
    expect(store.entries(IDENT)["1"]!.decisionValue()).toBeNull();
  });

  it("test_trust_ceiling_wins_over_non_429_failure_state", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    store.record({ "1": { error: "timeout" } }, IDENT);
    clock.advance(TRUST_MAX_AGE_S + 1);
    store.record({ "1": { error: "timeout" } }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.consecutiveFailures).toBe(2);
    expect(entry.decisionValue()).toBeNull();
  });

  function usageResettingAt(secondsAhead: number): UsageDict {
    const at = iso(clock.now + secondsAhead);
    return { five_hour: { pct: 25.0, resets_at: at }, seven_day: { pct: 10.0, resets_at: at } };
  }

  it("test_429_staleness_trusted_until_window_reset", () => {
    const resetAhead = (TRUST_MAX_AGE_S + RATE_LIMIT_TRUST_MAX_AGE_S) / 2;
    const usage = usageResettingAt(resetAhead);
    store.record({ "1": { usage } }, IDENT);
    store.record({ "1": { error: "http-429" } }, IDENT);
    clock.advance(TRUST_MAX_AGE_S + 1);
    store.record({ "1": { error: "http-429" } }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.trustExtended).toBe(true);
    expect(entry.decisionValue()).toEqual(usage);
  });

  it("test_429_staleness_expires_at_window_reset", () => {
    const usage = usageResettingAt(600.0);
    store.record({ "1": { usage } }, IDENT);
    store.record({ "1": { error: "http-429" } }, IDENT);
    clock.advance(601.0);
    store.record({ "1": { error: "http-429" } }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.decisionValue()).toBeNull();
    expect(entry.lastGood).toEqual(usage);
  });

  it("test_429_staleness_without_reset_info_falls_back_to_ceiling", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    store.record({ "1": { error: "http-429" } }, IDENT);
    clock.advance(TRUST_MAX_AGE_S + 1);
    store.record({ "1": { error: "http-429" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.decisionValue()).toEqual(USAGE);
    clock.advance(RATE_LIMIT_TRUST_MAX_AGE_S);
    store.record({ "1": { error: "http-429" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.decisionValue()).toBeNull();
  });
});

describe("TestRateLimitTrustBounds", () => {
  function usageFor(fiveHAhead: number | null, sevenDAhead: number | null): UsageDict {
    const five: { pct: number; resets_at?: string } = { pct: 25.0 };
    if (fiveHAhead !== null) five.resets_at = iso(clock.now + fiveHAhead);
    const seven: { pct: number; resets_at?: string } = { pct: 10.0 };
    if (sevenDAhead !== null) seven.resets_at = iso(clock.now + sevenDAhead);
    return { five_hour: five, seven_day: seven };
  }

  it("test_far_future_reset_is_clamped_to_the_ceiling", () => {
    const far = 10 * 365 * 24 * 3600.0;
    const usage = usageFor(far, far);
    store.record({ "1": { usage } }, IDENT);
    store.record({ "1": { error: "http-429" } }, IDENT);
    clock.advance(RATE_LIMIT_TRUST_MAX_AGE_S + 1);
    store.record({ "1": { error: "http-429" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.decisionValue()).toBeNull();
  });

  it("test_trust_keys_on_earliest_future_reset", () => {
    const usage = usageFor(600.0, 100 * 3600.0);
    store.record({ "1": { usage } }, IDENT);
    store.record({ "1": { error: "http-429" } }, IDENT);
    clock.advance(601.0);
    store.record({ "1": { error: "http-429" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.decisionValue()).toBeNull();
  });

  it("test_partial_metadata_still_bounded_by_ceiling", () => {
    const usage = usageFor(null, 100 * 3600.0);
    store.record({ "1": { usage } }, IDENT);
    store.record({ "1": { error: "http-429" } }, IDENT);
    clock.advance(RATE_LIMIT_TRUST_MAX_AGE_S + 1);
    store.record({ "1": { error: "http-429" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.decisionValue()).toBeNull();
  });

  it("test_ceiling_wins_when_reset_is_beyond_it", () => {
    const usage = usageFor(RATE_LIMIT_TRUST_MAX_AGE_S * 3, RATE_LIMIT_TRUST_MAX_AGE_S * 3);
    store.record({ "1": { usage } }, IDENT);
    store.record({ "1": { error: "http-429" } }, IDENT);
    clock.advance(RATE_LIMIT_TRUST_MAX_AGE_S - 60);
    store.record({ "1": { error: "http-429" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.decisionValue()).toEqual(usage);
    clock.advance(120);
    store.record({ "1": { error: "http-429" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.decisionValue()).toBeNull();
  });
});

describe("TestBackoff", () => {
  const backoff = usageStore.failureBackoffS;

  it("test_exponential_backoff", () => {
    const expected = [30.0, 60.0, 120.0, 240.0, 480.0, 600.0, 600.0];
    expected.forEach((want, i) => {
      store.record({ "1": { error: "http-500" } }, IDENT);
      const entry = store.entries(IDENT)["1"]!;
      expect(entry.consecutiveFailures).toBe(i + 1);
      expectApprox(entry.backoffUntil, clock.now + want);
      clock.advance(want + 1);
    });
  });

  it("test_backoff_cap", () => {
    expect(backoff(50, null)).toBe(BACKOFF_CAP_S);
  });

  it("test_huge_failure_count_does_not_overflow", () => {
    expect(backoff(1025, null)).toBe(BACKOFF_CAP_S);
    expect(backoff(10_000, 90.0)).toBe(BACKOFF_CAP_S);
  });

  it("test_record_failure_on_saturated_counter_does_not_raise", () => {
    writeStore(
      JSON.stringify({
        schemaVersion: 2,
        accounts: { "1": { email: "a@x.com", consecutiveFailures: 1024, lastError: "refresh-failed" } },
      }),
    );
    store.record({ "1": { error: "refresh-failed" } }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.consecutiveFailures).toBe(1025);
    expectApprox(entry.backoffUntil, clock.now + BACKOFF_CAP_S);
  });

  it("test_retry_after_is_the_floor", () => {
    store.record({ "1": { error: "http-429", retryAfterS: 90.0 } }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expectApprox(entry.backoffUntil, clock.now + 90.0);
    expect(entry.inBackoff(clock.now + 89)).toBe(true);
    expect(entry.inBackoff(clock.now + 91)).toBe(false);
  });

  it("test_own_curve_may_exceed_retry_after", () => {
    expectApprox(backoff(5, 10.0), 480.0);
    expect(BACKOFF_BASE_S * 2 ** 4).toBe(480.0);
  });

  it("test_edge_429_backoff_floors_at_edge_backoff", () => {
    const expected = [300.0, 300.0, 300.0, 300.0, 480.0, 600.0, 600.0];
    expected.forEach((want, i) => {
      store.record({ "1": { error: "http-429", retryAfterS: 0.0 } }, IDENT);
      const entry = store.entries(IDENT)["1"]!;
      expect(entry.consecutiveFailures).toBe(i + 1);
      expectApprox(entry.backoffUntil, clock.now + want);
      clock.advance(want + 1);
    });
  });

  it("test_a_non_429_retry_after_zero_does_not_take_the_saturated_edge", () => {
    store.record({ "1": { error: "http-503", retryAfterS: 0.0 } }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expectApprox(entry.backoffUntil, clock.now + 30.0);
  });

  it("test_retry_after_floor_is_capped", () => {
    expectApprox(backoff(1, 50000.0), usageStore.RETRY_AFTER_FLOOR_CAP_S);
  });

  it("test_hour_scale_retry_after_honored", () => {
    expectApprox(backoff(1, 3600.0), 4500.0);
    expect(usageStore.RETRY_AFTER_FLOOR_CAP_S).toBeGreaterThanOrEqual(4500.0);
  });

  it("test_hour_scale_margin_clears_the_measured_re_block_band", () => {
    expect(backoff(1, 3600.0) - 3600.0).toBeGreaterThanOrEqual(900.0);
  });

  it("test_a_short_accurate_block_is_not_inflated", () => {
    expect(backoff(1, 300.0)).toBe(300.0);
    expect(backoff(1, 3600.0) - 3600.0).toBe(900.0);
    const cap = usageStore.BACKOFF_CAP_S;
    expect(backoff(1, cap)).toBe(cap);
    expect(backoff(1, cap + 1.0)).toBe(cap + 1.0 + 900.0);
  });

  it("test_margin_survives_a_mid_block_observation", () => {
    for (const remaining of [3600.0, 1800.0, 900.0]) {
      const overshoot = backoff(1, remaining) - remaining;
      expect(overshoot, `Retry-After ${remaining}s lands ${overshoot}s past the deadline`).toBeGreaterThanOrEqual(900.0);
    }
  });

  it("test_a_429_wait_is_the_deadline_plus_the_margin", () => {
    for (const ask of [3601.0, 3600.0, 4000.0]) {
      const wait = backoff(1, ask, { rateLimited: true });
      const expected = Math.min(ask + usageStore.RETRY_AFTER_MARGIN_S, usageStore.RETRY_AFTER_FLOOR_CAP_S);
      expect(wait, `ask ${ask} -> wait ${wait}, expected ${expected}`).toBe(expected);
    }
  });

  it("test_the_cap_sits_inside_the_trust_it_relies_on", () => {
    expect(usageStore.RETRY_AFTER_FLOOR_CAP_S).toBe(3600.0 + usageStore.RETRY_AFTER_MARGIN_S);
    expect(usageStore.RETRY_AFTER_FLOOR_CAP_S).toBeLessThanOrEqual(usageStore.RATE_LIMIT_TRUST_MAX_AGE_S);
    for (const ask of [3600.0, 4500.0, 50_000.0, 86_400.0, Infinity]) {
      const wait = backoff(1, ask, { rateLimited: true });
      expect(wait, `ask ${ask} produced a ${wait}s wait, past the trust ceiling`).toBeLessThanOrEqual(
        usageStore.RATE_LIMIT_TRUST_MAX_AGE_S,
      );
    }
  });

  it("test_each_arm_is_bounded_by_the_ceiling_its_own_trust_uses", () => {
    for (const ask of [3601.0, 4500.0, 7200.0, 86_400.0, Infinity]) {
      const wait = backoff(1, ask, { rateLimited: false });
      expect(wait, `non-429 ask ${ask} produced a ${wait}s park`).toBeLessThanOrEqual(usageStore.TRUST_MAX_AGE_S);
    }
    for (const ask of [4500.0, 7200.0, 50_000.0, 86_400.0, Infinity]) {
      const wait = backoff(1, ask, { rateLimited: true });
      expect(wait, `429 ask ${ask} produced a ${wait}s park`).toBeLessThanOrEqual(usageStore.RATE_LIMIT_TRUST_MAX_AGE_S);
    }
  });

  it("test_a_soon_resetting_window_can_end_trust_before_the_429_wait_releases", () => {
    const usage: UsageDict = {
      five_hour: { pct: 25.0, resets_at: iso(clock.now + 1800.0) },
      seven_day: { pct: 10.0, resets_at: iso(clock.now + 100 * 3600.0) },
    };
    expect(relevantWindows(usage, [])).not.toEqual([]);

    store.record({ "1": { usage } }, IDENT);
    store.record({ "1": { error: "http-429", retryAfterS: 3600.0 } }, IDENT);
    const wait = backoff(1, 3600.0, { rateLimited: true });
    expectApprox(wait, 4500.0);

    clock.advance(1799.0);
    let entry = store.entries(IDENT)["1"]!;
    expect(entry.inBackoff(clock.now)).toBe(true);
    expect(entry.decisionValue()).toEqual(usage);

    clock.advance(2.0);
    entry = store.entries(IDENT)["1"]!;
    expect(entry.inBackoff(clock.now)).toBe(true);
    expect(entry.decisionValue()).toBeNull();

    clock.advance(wait - 1801.0);
    entry = store.entries(IDENT)["1"]!;
    expect(entry.inBackoff(clock.now)).toBe(false);
    expect(entry.decisionValue()).toBeNull();
  });

  it("test_consecutive_blocks_go_blind_because_fetchedAt_only_moves_on_success", () => {
    const far = 10 ** 9;
    const lastGood: UsageDict = {
      five_hour: { pct: 25.0, resets_at: iso(far) },
      seven_day: { pct: 10.0, resets_at: iso(far) },
    };
    expect(relevantWindows(lastGood, [])).not.toEqual([]);
    expect(usageStore.earliestReset(lastGood)).not.toBeNull();

    store.record({ "1": { usage: lastGood } }, IDENT);
    const fetchedAt = store.entries(IDENT)["1"]!.fetchedAt;

    const blindPerBlock: number[] = [];
    let wait = 0;
    for (let i = 0; i < 3; i += 1) {
      store.record({ "1": { error: "http-429", retryAfterS: 3600.0 } }, IDENT);
      const entry = store.entries(IDENT)["1"]!;
      expect(entry.fetchedAt, "a failed record() moved fetchedAt").toBe(fetchedAt);
      expect(entry.backoffUntil).not.toBeNull();
      const blockEnd = entry.backoffUntil!;
      wait = blockEnd - clock.now;

      let blind = 0.0;
      while (clock.now < blockEnd) {
        if (store.entries(IDENT)["1"]!.decisionValue() === null) {
          blind = blockEnd - clock.now;
          break;
        }
        clock.advance(60.0);
      }
      blindPerBlock.push(blind);
      clock.advance(Math.max(blockEnd - clock.now, 0.0));
    }

    expectApprox(wait, 4500.0);
    expect(blindPerBlock[0], "the first block is supposed to sit inside its trust").toBe(0.0);
    expect(blindPerBlock[1]!, "a second consecutive block must show the gap").toBeGreaterThan(0.0);
    expectApprox(blindPerBlock[2], wait);
  });

  it("test_the_margin_never_lifts_the_floor_cap", () => {
    const huge = 86_400.0;
    const wait = backoff(1, huge, { rateLimited: true });
    expect(wait).toBeLessThanOrEqual(usageStore.RETRY_AFTER_FLOOR_CAP_S);
  });

  it("test_short_asks_stay_on_our_own_curve", () => {
    expect(backoff(1, 90.0)).toBe(90.0);
    expect(backoff(10_000, 90.0)).toBe(BACKOFF_CAP_S);
  });

  it("test_measured_burst_block_honored_exactly", () => {
    expectApprox(backoff(1, 300.0), 300.0);
  });

  it("test_park_bound_blind_window_equals_age_at_failure", () => {
    const IDENT_1: Record<string, Identity> = { "1": ["a@example.com", ""] };

    const blindWindow = (ageAtFail: number, ask: number, error = "http-500"): number => {
      const clk = new FakeClock();
      const st = new UsageStore(path.join(tmpPath, `cache-${error}-${ageAtFail}-${ask}`), clk.call);
      st.record({ "1": { usage: { five_hour: { pct: 1.0 } } } }, IDENT_1);
      clk.advance(ageAtFail);
      st.record({ "1": { error, retryAfterS: ask } }, IDENT_1);
      const parkEnd = st.entries(IDENT_1)["1"]!.backoffUntil;
      expect(parkEnd).not.toBeNull();
      let blindStart: number | null = null;
      let t = clk.now;
      while (t < parkEnd!) {
        clk.now = t;
        const entry = st.entries(IDENT_1)["1"]!;
        if (entry.inBackoff(clk.now) && entry.decisionValue() === null) {
          blindStart = t;
          break;
        }
        t += 1.0;
      }
      clk.now = parkEnd!;
      return blindStart === null ? 0.0 : parkEnd! - blindStart;
    };

    const cases: Array<[number, number, number]> = [
      [0.0, 5000.0, 0.0],
      [1.0, 5000.0, 1.0],
      [120.0, 5000.0, 120.0],
      [300.0, 5000.0, 300.0],
      [1800.0, 5000.0, 1800.0],
      [3599.0, 5000.0, 3599.0],
      [300.0, 4000.0, 300.0],
      [300.0, 3600.0, 300.0],
      [300.0, 600.0, 0.0],
    ];
    for (const [ageAtFail, ask, expected] of cases) {
      expectApprox(blindWindow(ageAtFail, ask), expected, 2.0);
    }

    const rateLimitedCases: Array<[number, number, number]> = [
      [0.0, 5000.0, 0.0],
      [2701.0, 5000.0, 1.0],
      [3600.0, 5000.0, 900.0],
      [5000.0, 5000.0, 2300.0],
    ];
    for (const [ageAtFail, ask, expected] of rateLimitedCases) {
      expectApprox(blindWindow(ageAtFail, ask, "http-429"), expected, 2.0);
    }
  });
});

describe("TestIdentityGuard", () => {
  it("test_slot_reuse_hides_old_usage", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    const rebound: Record<string, Identity> = { "1": ["new@x.com", ""] };
    expect(store.entries(rebound)["1"]).toEqual(new UsageEntry());
  });

  it("test_same_email_different_org_is_a_different_account", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    const rebound: Record<string, Identity> = { "1": ["a@x.com", "org-9"] };
    expect(store.entries(rebound)["1"]).toEqual(new UsageEntry());
  });

  it("test_write_replaces_mismatched_row", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    const rebound: Record<string, Identity> = { "1": ["new@x.com", ""] };
    store.record({ "1": { error: "timeout" } }, rebound);
    const entry = store.entries(rebound)["1"]!;
    expect(entry.lastGood).toBeNull();
    expect(entry.consecutiveFailures).toBe(1);
  });

  it("test_untouched_slots_survive_subset_writes", () => {
    store.record({ "1": { usage: USAGE }, "2": { usage: USAGE } }, IDENT);
    store.record({ "1": { error: "timeout" } }, { "1": IDENT["1"]! });
    expect(store.entries(IDENT)["2"]!.lastGood).toEqual(USAGE);
  });
});

describe("TestClaims", () => {
  it("test_claim_marks_in_flight", () => {
    const claims = store.claim(["1"], IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(keys(claims)).toEqual(new Set(["1"]));
    expect(entry.claimed(clock.now)).toBe(true);
    clock.advance(CLAIM_TTL_S + 1);
    expect(store.entries(IDENT)["1"]!.claimed(clock.now)).toBe(false);
  });

  it("test_legacy_last_attempt_claim_is_honored_during_schema_overlap", () => {
    store.claim(["1"], IDENT);
    const raw = JSON.parse(fs.readFileSync(store.path, "utf8"));
    const row = raw.accounts["1"];
    delete row.claimId;
    delete row.claimUntil;
    fs.writeFileSync(store.path, JSON.stringify(raw));

    expect(store.entries(IDENT)["1"]!.claimed(clock.now)).toBe(true);
    expect(store.reserve(["1"], IDENT, { respectPlans: true })).toEqual({});
    clock.advance(11);
    expect(keys(store.reserve(["1"], IDENT, { respectPlans: true }))).toEqual(new Set(["1"]));
  });

  it("test_claim_does_not_touch_measurement", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    clock.advance(100);
    store.claim(["1"], IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.lastGood).toEqual(USAGE);
    expect(entry.ageS).toBe(100.0);
  });

  it("test_live_claim_outlasts_urgent_poll_interval", () => {
    const claims = store.reserve(["1"], IDENT, { respectPlans: true });
    expect(keys(claims)).toEqual(new Set(["1"]));
    clock.advance(61);
    expect(store.reserve(["1"], IDENT, { respectPlans: false })).toEqual({});
  });

  it("test_record_releases_long_claim_immediately", () => {
    const claims = store.reserve(["1"], IDENT, { respectPlans: true });
    expect(store.entries(IDENT)["1"]!.claimed(clock.now)).toBe(true);
    expect(store.record({ "1": { usage: USAGE } }, IDENT, claims)).toEqual(new Set(["1"]));
    expect(store.entries(IDENT)["1"]!.claimed(clock.now)).toBe(false);
  });

  it("test_failure_releases_claim", () => {
    const claims = store.reserve(["1"], IDENT, { respectPlans: true });
    expect(store.record({ "1": { error: "timeout" } }, IDENT, claims)).toEqual(new Set(["1"]));
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.claimed(clock.now)).toBe(false);
    expect(entry.lastError).toBe("timeout");
  });

  it("test_sentinel_releases_claim_without_persisting_state", () => {
    const claims = store.reserve(["1"], IDENT, { respectPlans: true });
    const claimedAt = store.entries(IDENT)["1"]!.lastAttemptAt;
    clock.advance(1);
    expect(store.record({ "1": { sentinel: "token expired" } }, IDENT, claims)).toEqual(new Set(["1"]));
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.claimed(clock.now)).toBe(false);
    expect(entry.lastAttemptAt).toBe(claimedAt);
    expect(entry.sentinel).toBeNull();
    expect(entry.lastGood).toBeNull();
  });

  it("test_expired_writer_cannot_clear_or_overwrite_new_lease", () => {
    const first = store.reserve(["1"], IDENT, { respectPlans: true });
    clock.advance(CLAIM_TTL_S + 1);
    const second = store.reserve(["1"], IDENT, { respectPlans: true });
    expect(first["1"]).not.toBe(second["1"]);

    expect(store.record({ "1": { error: "timeout" } }, IDENT, first)).toEqual(new Set());
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.claimed(clock.now)).toBe(true);
    expect(entry.lastError).toBeNull();

    expect(store.record({ "1": { usage: USAGE } }, IDENT, second)).toEqual(new Set(["1"]));
    expect(store.entries(IDENT)["1"]!.lastGood).toEqual(USAGE);
  });

  it("test_stale_writer_cannot_replace_a_rebound_identity", () => {
    const staleClaim = store.reserve(["1"], IDENT, { respectPlans: true });
    const rebound: Record<string, Identity> = { "1": ["new@x.com", "org-new"] };
    expect(keys(store.reserve(["1"], rebound, { respectPlans: true }))).toEqual(new Set(["1"]));

    expect(store.record({ "1": { usage: USAGE } }, IDENT, staleClaim)).toEqual(new Set());
    const entry = store.entries(rebound)["1"]!;
    expect(entry.claimed(clock.now)).toBe(true);
    expect(entry.lastGood).toBeNull();
  });

  it("test_partial_records_can_reuse_their_explicit_claims", () => {
    const claims = store.reserve(["1", "2"], IDENT, { respectPlans: true });
    expect(store.record({ "1": { usage: USAGE } }, IDENT, claims)).toEqual(new Set(["1"]));
    expect(store.entries(IDENT)["2"]!.claimed(store.clock())).toBe(true);

    expect(store.record({ "2": { usage: USAGE } }, IDENT, claims)).toEqual(new Set(["2"]));
    const entries = store.entries(IDENT);
    expect(entries["1"]!.lastGood).toEqual(USAGE);
    expect(entries["2"]!.lastGood).toEqual(USAGE);
  });

  it("test_mixed_record_accepts_only_the_current_claim", () => {
    const first = store.reserve(["1", "2"], IDENT, { respectPlans: true });
    clock.advance(CLAIM_TTL_S + 1);
    const second = store.reserve(["1"], IDENT, { respectPlans: true });
    expect(first["1"]).not.toBe(second["1"]);

    const outcomes: Record<string, FetchRecord> = { "1": { error: "timeout" }, "2": { usage: USAGE } };
    expect(store.record(outcomes, IDENT, first)).toEqual(new Set(["2"]));
    const entries = store.entries(IDENT);
    expect(entries["1"]!.lastError).toBeNull();
    expect(entries["1"]!.claimed(clock.now)).toBe(true);
    expect(entries["2"]!.lastGood).toEqual(USAGE);
  });

  it("test_unfenced_record_cannot_overwrite_a_live_claim", () => {
    const claims = store.reserve(["1"], IDENT, { respectPlans: true });
    expect(store.record({ "1": { error: "timeout" } }, IDENT)).toEqual(new Set());
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.claimed(clock.now)).toBe(true);
    expect(entry.lastError).toBeNull();
    expect(store.record({ "1": { usage: USAGE } }, IDENT, claims)).toEqual(new Set(["1"]));
  });

  it("test_unfenced_record_accepts_after_a_claim_expires", () => {
    store.reserve(["1"], IDENT, { respectPlans: true });
    clock.advance(CLAIM_TTL_S + 1);
    expect(store.record({ "1": { usage: USAGE } }, IDENT)).toEqual(new Set(["1"]));
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.lastGood).toEqual(USAGE);
    expect(entry.claimed(clock.now)).toBe(false);
  });

  it("test_credential_refresh_revokes_an_old_fetch_claim", () => {
    const claims = store.reserve(["1"], IDENT, { respectPlans: true });
    store.clearDeadToken(["1"], IDENT);
    expect(store.record({ "1": { error: "invalid_grant" } }, IDENT, claims)).toEqual(new Set());
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.claimed(clock.now)).toBe(false);
    expect(entry.tokenDead()).toBe(false);
    expect(keys(store.reserve(["1"], IDENT, { respectPlans: true }))).toEqual(new Set(["1"]));
  });

  it("test_success_commits_its_new_plan_without_a_duplicate_window", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    store.setPollPlan({ "1": [clock.now + 60.0, 60.0] }, IDENT);
    clock.advance(61);
    const claims = store.reserve(["1"], IDENT, { respectPlans: false });
    expect(keys(claims)).toEqual(new Set(["1"]));

    const nextPoll = clock.now + 300.0;
    store.record({ "1": { usage: USAGE } }, IDENT, claims, { "1": [nextPoll, 300.0] });
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.nextPollAt).toBe(nextPoll);
    expect(entry.pollIntervalS).toBe(300.0);
    expect(store.reserve(["1"], IDENT, { respectPlans: false })).toEqual({});
  });
});

describe("TestSentinels", () => {
  it("test_sentinel_record_is_a_store_noop", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    store.record({ "1": { sentinel: "token expired" } }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.sentinel).toBeNull();
    expect(entry.lastGood).toEqual(USAGE);
  });

  it("test_refused_credential_stamp_rides_a_sentinel", () => {
    store.record({ "1": { sentinel: "token expired", rejectedFp: "sha256-at:abc" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.rejectedFingerprint).toBe("sha256-at:abc");
    store.record({ "1": { sentinel: "token expired" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.rejectedFingerprint).toBe("sha256-at:abc");
    store.record({ "1": { usage: USAGE } }, IDENT);
    expect(store.entries(IDENT)["1"]!.rejectedFingerprint).toBeNull();
  });

  it("test_overlay_wins_decisions_but_not_display", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    const entry = withSentinel(store.entries(IDENT)["1"]!, "token expired");
    expect(entry.decisionValue()).toBe("token expired");
    expect(entry.lastGood).toEqual(USAGE);
  });

  it("test_with_sentinel_none_is_identity", () => {
    const entry = new UsageEntry({ lastGood: USAGE });
    expect(withSentinel(entry, null)).toBe(entry);
  });
});

describe("TestFreshness", () => {
  it("test_fresh_within_serve_ttl", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.fresh(clock.now)).toBe(true);
    expect(entry.fresh(clock.now + SERVE_TTL_S)).toBe(true);
    expect(entry.fresh(clock.now + SERVE_TTL_S + 1)).toBe(false);
  });
});

describe("TestPollPlan", () => {
  it("test_set_and_read_poll_plan", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    store.setPollPlan({ "1": [clock.now + 120.0, 120.0] }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.nextPollAt).toBe(clock.now + 120.0);
    expect(entry.pollIntervalS).toBe(120.0);
    expect(entry.lastGood).toEqual(USAGE);
  });

  it("test_poll_plan_clear", () => {
    store.setPollPlan({ "1": [clock.now + 120.0, 120.0] }, IDENT);
    store.setPollPlan({ "1": [null, null] }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.nextPollAt).toBeNull();
    expect(entry.pollIntervalS).toBeNull();
  });
});

describe("TestDueCandidate", () => {
  const NOW = 1_000_000.0;

  it("test_missing_entry_is_most_due", () => {
    const entries = { "3": new UsageEntry({ fetchedAt: NOW - 60, ageS: 60.0 }) };
    expect(dueCandidate(["2", "3"], entries, NOW)).toBe("2");
  });

  it("test_never_fetched_beats_fetched", () => {
    const entries = {
      "2": new UsageEntry({ fetchedAt: NOW - 999, ageS: 999.0 }),
      "3": new UsageEntry(),
    };
    expect(dueCandidate(["2", "3"], entries, NOW)).toBe("3");
  });

  it("test_stalest_fetched_wins", () => {
    const entries = {
      "2": new UsageEntry({ fetchedAt: NOW - 60, ageS: 60.0 }),
      "3": new UsageEntry({ fetchedAt: NOW - 300, ageS: 300.0 }),
    };
    expect(dueCandidate(["2", "3"], entries, NOW)).toBe("3");
  });

  it("test_sentinel_accounts_skipped", () => {
    const entries = { "2": new UsageEntry({ sentinel: "api-key" }) };
    expect(dueCandidate(["2"], entries, NOW)).toBeNull();
  });

  it("test_backoff_skipped_until_it_expires", () => {
    const entries = { "2": new UsageEntry({ backoffUntil: NOW + 10 }) };
    expect(dueCandidate(["2"], entries, NOW)).toBeNull();
    expect(dueCandidate(["2"], entries, NOW + 11)).toBe("2");
  });

  it("test_future_next_poll_at_skipped", () => {
    const entries = {
      "2": new UsageEntry({ fetchedAt: NOW - 300, nextPollAt: NOW + 60 }),
      "3": new UsageEntry({ fetchedAt: NOW - 60 }),
    };
    expect(dueCandidate(["2", "3"], entries, NOW)).toBe("3");
  });

  it("test_reset_parked_exhausted_plan_is_due_for_repair", () => {
    const exhausted: UsageDict = { seven_day: { pct: 100.0 } };
    const entries = {
      "2": new UsageEntry({ lastGood: exhausted, fetchedAt: NOW - 400, ageS: 400.0, nextPollAt: NOW + 86_400, pollIntervalS: 300.0 }),
    };
    expect(dueCandidate(["2"], entries, NOW)).toBe("2");
  });

  it("test_bounded_exhausted_plan_is_not_due_early", () => {
    const exhausted: UsageDict = { seven_day: { pct: 100.0 } };
    const entries = {
      "2": new UsageEntry({ lastGood: exhausted, fetchedAt: NOW - 400, ageS: 400.0, nextPollAt: NOW + 600, pollIntervalS: 600.0 }),
    };
    expect(dueCandidate(["2"], entries, NOW)).toBeNull();
  });

  it("test_parked_plan_is_repaired_after_scoped_model_is_deselected", () => {
    const entries = {
      "2": new UsageEntry({
        lastGood: {
          five_hour: { pct: 10.0 },
          seven_day: { pct: 10.0 },
          scoped: [{ name: "Fable", pct: 100.0 }],
        },
        fetchedAt: NOW - 400,
        ageS: 400.0,
        nextPollAt: NOW + 86_400,
        pollIntervalS: 300.0,
      }),
    };
    expect(dueCandidate(["2"], entries, NOW)).toBe("2");
  });

  it("test_none_when_no_candidates", () => {
    expect(dueCandidate([], {}, NOW)).toBeNull();
  });
});

describe("TestDeadTokenQuarantine", () => {
  it("test_invalid_grant_advances_strikes", () => {
    store.record({ "1": { error: "invalid_grant" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.authDeadStrikes).toBe(1);
    store.record({ "1": { error: "invalid_grant" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.authDeadStrikes).toBe(2);
  });

  it("test_transient_error_does_not_advance_or_reset", () => {
    store.record({ "1": { error: "invalid_grant" } }, IDENT);
    store.record({ "1": { error: "http-429" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.authDeadStrikes).toBe(1);
  });

  it("test_success_resets_strikes", () => {
    store.record({ "1": { error: "invalid_grant" } }, IDENT);
    store.record({ "1": { error: "invalid_grant" } }, IDENT);
    store.record({ "1": { usage: USAGE } }, IDENT);
    expect(store.entries(IDENT)["1"]!.authDeadStrikes).toBe(0);
  });

  it("test_token_dead_at_threshold", () => {
    expect(store.entries(IDENT)["1"]!.tokenDead()).toBe(false);
    store.record({ "1": { error: "invalid_grant" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.tokenDead()).toBe(true);
  });

  it("test_transient_error_alone_never_marks_dead", () => {
    for (let i = 0; i < 5; i += 1) store.record({ "1": { error: "http-429" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.tokenDead()).toBe(false);
  });

  it("test_due_candidate_skips_dead_token", () => {
    store.record({ "1": { error: "invalid_grant" } }, IDENT);
    store.record({ "1": { error: "invalid_grant" } }, IDENT);
    clock.advance(10_000);
    const entries = store.entries(IDENT);
    expect(entries["1"]!.tokenDead()).toBe(true);
    expect(dueCandidate(["1"], entries, clock.now)).toBeNull();
  });

  it("test_clear_dead_token_lifts_quarantine", () => {
    store.record({ "1": { error: "invalid_grant" } }, IDENT);
    store.record({ "1": { error: "invalid_grant" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.tokenDead()).toBe(true);
    store.clearDeadToken(["1"], IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.authDeadStrikes).toBe(0);
    expect(entry.tokenDead()).toBe(false);
    expect(entry.lastError).toBeNull();
    expect(entry.backoffUntil).toBeNull();
  });
});

describe("TestReserve", () => {
  function stale(num = "1"): void {
    store.record({ [num]: { usage: USAGE } }, IDENT);
    clock.advance(SERVE_TTL_S + CLAIM_TTL_S + 1);
  }

  it("test_reserve_wins_and_stamps", () => {
    expect(keys(store.reserve(["1"], IDENT, { respectPlans: true }))).toEqual(new Set(["1"]));
    expect(store.reserve(["1"], IDENT, { respectPlans: true })).toEqual({});
    expect(store.reserve(["1"], IDENT, { respectPlans: false })).toEqual({});
  });

  it("test_fresh_entry_not_won", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    clock.advance(CLAIM_TTL_S + 1);
    expect(store.reserve(["1"], IDENT, { respectPlans: true })).toEqual({});
  });

  it("test_respect_plans_waits_for_next_poll", () => {
    stale();
    store.setPollPlan({ "1": [clock.now + 300.0, 300.0] }, IDENT);
    expect(store.reserve(["1"], IDENT, { respectPlans: true })).toEqual({});
    clock.advance(301);
    expect(keys(store.reserve(["1"], IDENT, { respectPlans: true }))).toEqual(new Set(["1"]));
  });

  it("test_overslept_repair_rechecks_current_plan_under_lock", () => {
    stale();
    store.setPollPlan({ "1": [clock.now + 86_400.0, 300.0] }, IDENT);
    const claims = store.reserve(["1"], IDENT, { respectPlans: true, repairOverslept: true });
    expect(keys(claims)).toEqual(new Set(["1"]));

    expect(store.record({ "1": { usage: USAGE } }, IDENT, claims, { "1": [clock.now + 300.0, 300.0] })).toEqual(
      new Set(["1"]),
    );
    clock.advance(SERVE_TTL_S + 1);
    store.setPollPlan({ "1": [clock.now + 300.0, 300.0] }, IDENT);
    expect(store.reserve(["1"], IDENT, { respectPlans: false, repairOverslept: true })).toEqual({});
  });

  it("test_scheduler_beats_the_ttl_when_due", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    store.setPollPlan({ "1": [clock.now + 60.0, 60.0] }, IDENT);
    clock.advance(61);
    expect(store.reserve(["1"], IDENT, { respectPlans: true })).toEqual({});
    expect(keys(store.reserve(["1"], IDENT, { respectPlans: false }))).toEqual(new Set(["1"]));
  });

  it("test_scheduler_may_fetch_a_not_due_stale_entry", () => {
    stale();
    store.setPollPlan({ "1": [clock.now + 600.0, 600.0] }, IDENT);
    expect(keys(store.reserve(["1"], IDENT, { respectPlans: false }))).toEqual(new Set(["1"]));
  });

  it("test_backoff_blocks_both_modes", () => {
    store.record({ "1": { error: "timeout" } }, IDENT);
    clock.advance(BACKOFF_BASE_S - 1);
    expect(store.reserve(["1"], IDENT, { respectPlans: true })).toEqual({});
    expect(store.reserve(["1"], IDENT, { respectPlans: false })).toEqual({});
  });

  it("test_dead_token_never_won", () => {
    store.record({ "1": { error: "invalid_grant" } }, IDENT);
    clock.advance(TRUST_MAX_AGE_S);
    expect(store.reserve(["1"], IDENT, { respectPlans: true })).toEqual({});
    expect(store.reserve(["1"], IDENT, { respectPlans: false })).toEqual({});
  });

  it("test_unknown_row_and_identity_mismatch_win", () => {
    expect(keys(store.reserve(["1"], IDENT, { respectPlans: true }))).toEqual(new Set(["1"]));
    store.record({ "2": { usage: USAGE } }, IDENT);
    const other: Record<string, Identity> = { "2": ["new@x.com", "org-9"] };
    expect(keys(store.reserve(["2"], other, { respectPlans: true }))).toEqual(new Set(["2"]));
  });
});

describe("TestLast429Marker", () => {
  it("test_last_429_survives_recovery", () => {
    store.record({ "1": { error: "http-429", retryAfterS: 0.0 } }, IDENT);
    const t429 = clock.now;
    clock.advance(400);
    store.record({ "1": { usage: USAGE } }, IDENT);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.consecutiveFailures).toBe(0);
    expectApprox(entry.last429At, t429);
  });

  it("test_non_429_failures_leave_the_marker_alone", () => {
    store.record({ "1": { error: "timeout" } }, IDENT);
    expect(store.entries(IDENT)["1"]!.last429At).toBeNull();
  });
});

describe("TestRecent429AcrossHonoredBlock", () => {
  const recent429 = (entry: UsageEntry, now: number): boolean => entry.recent429(now);

  it("test_recent_429_true_at_first_success_after_hour_block", () => {
    store.record({ "1": { error: "http-429", retryAfterS: 3600.0 } }, IDENT);
    const before = store.entries(IDENT)["1"]!;
    clock.advance(before.backoffUntil! - clock.now);
    expect(recent429(before, clock.now)).toBe(true);
  });

  it("test_recent_429_false_once_window_truly_elapsed", () => {
    store.record({ "1": { error: "http-429", retryAfterS: 3600.0 } }, IDENT);
    const before = store.entries(IDENT)["1"]!;
    clock.advance(before.backoffUntil! - clock.now + usageStore.RECENT_429_WINDOW_S + 1);
    expect(recent429(before, clock.now)).toBe(false);
  });

  it("test_short_retry_after_recency_still_expires_normally", () => {
    store.record({ "1": { error: "http-429", retryAfterS: 0.0 } }, IDENT);
    const before = store.entries(IDENT)["1"]!;
    clock.advance(before.backoffUntil! - clock.now);
    expect(recent429(before, clock.now)).toBe(true);
    clock.advance(usageStore.RECENT_429_WINDOW_S);
    expect(recent429(before, clock.now)).toBe(false);
  });

  it("test_unrelated_timeout_does_not_re_arm_recency", () => {
    store.record({ "1": { error: "http-429", retryAfterS: 0.0 } }, IDENT);
    clock.advance(400);
    store.record({ "1": { usage: USAGE } }, IDENT);
    clock.advance(usageStore.RECENT_429_WINDOW_S + 5000);
    expect(recent429(store.entries(IDENT)["1"]!, clock.now)).toBe(false);
    store.record({ "1": { error: "timeout" } }, IDENT);
    const before = store.entries(IDENT)["1"]!;
    expect(before.lastError).toBe("timeout");
    expect(before.last429At).not.toBeNull();
    clock.advance(before.backoffUntil! - clock.now);
    expect(recent429(before, clock.now)).toBe(false);
  });
});

describe("TestHourScale429FloorEngagesThroughStore", () => {
  function planAfterFirstSuccess(legacyRecency: boolean): [boolean, number] {
    store.record({ "1": { error: "http-429", retryAfterS: 3600.0 } }, IDENT);
    const before = store.entries(IDENT)["1"]!;
    clock.advance(before.backoffUntil! - clock.now);
    store.record({ "1": { usage: USAGE } }, IDENT);
    const after = store.entries(IDENT)["1"]!;
    const recent = legacyRecency
      ? before.last429At !== null && clock.now - before.last429At < pollPolicy.RECENT_429_WINDOW_S
      : before.recent429(clock.now);
    const [, interval] = pollPolicy.planAfterFetch({
      prevIntervalS: before.pollIntervalS,
      prevUsage: before.lastGood,
      newUsage: after.lastGood,
      isActive: false,
      threshold: 90.0,
      models: [],
      recent429: recent,
      now: clock.now,
      rng: () => 0.5,
    });
    return [recent, interval];
  }

  it("test_floor_engages_at_first_post_block_success", () => {
    const [recent, interval] = planAfterFirstSuccess(false);
    expect(recent).toBe(true);
    expect(interval).toBeGreaterThanOrEqual(pollPolicy.POST_429_MIN_INTERVAL_S);
  });

  it("test_legacy_recency_would_drop_the_floor", () => {
    const [recent, interval] = planAfterFirstSuccess(true);
    expect(recent).toBe(false);
    expect(interval).toBeLessThan(pollPolicy.POST_429_MIN_INTERVAL_S);
  });

  it("test_repeated_429_episodes_converge_to_the_wide_ceiling", () => {
    const intervals: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      store.record({ "1": { error: "http-429", retryAfterS: 60.0 } }, IDENT);
      const before = store.entries(IDENT)["1"]!;
      clock.advance(before.backoffUntil! - clock.now);
      store.record({ "1": { usage: USAGE } }, IDENT);
      const after = store.entries(IDENT)["1"]!;
      const [nxt, interval] = pollPolicy.planAfterFetch({
        prevIntervalS: before.pollIntervalS,
        prevUsage: before.lastGood,
        newUsage: after.lastGood,
        isActive: false,
        threshold: 90.0,
        models: [],
        recent429: before.recent429(clock.now),
        now: clock.now,
        rng: () => 0.5,
      });
      store.setPollPlan({ "1": [nxt, interval] }, IDENT);
      intervals.push(interval);
      clock.advance(10);
    }

    expect(intervals).toEqual([...intervals].sort((a, b) => a - b));
    expect(intervals.at(-1)).toBe(pollPolicy.POST_429_MAX_INTERVAL_S);
    expect(intervals[0]!).toBeLessThan(intervals[2]!);
    expect(intervals[2]!).toBeLessThan(pollPolicy.POST_429_MAX_INTERVAL_S);
  });
});

describe("TestClaimTrustBridge", () => {
  it("test_in_flight_claim_keeps_decision_trust", () => {
    store.record({ "1": { usage: USAGE } }, IDENT);
    store.setPollPlan({ "1": [clock.now + 400.0, 400.0] }, IDENT);
    clock.advance(401);
    expect(keys(store.reserve(["1"], IDENT, { respectPlans: true }))).toEqual(new Set(["1"]));
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.trustExtended).toBe(true);
    expect(entry.decisionValue()).toEqual(USAGE);
    clock.advance(CLAIM_TTL_S);
    expect(store.entries(IDENT)["1"]!.decisionValue()).toBeNull();
  });
});

describe("TestFingerprintBoundStrikes", () => {
  const ident: Record<string, Identity> = { "1": ["a@example.com", ""] };

  function makeStore(): UsageStore {
    return new UsageStore(path.join(tmpPath, "usage.json"));
  }

  function recordInvalidGrant(st: UsageStore, num = "1", fp: string | null = "fp-dead"): void {
    const identities: Record<string, Identity> = { [num]: ["a@example.com", ""] };
    const claims = st.reserve([num], identities, { respectPlans: false });
    st.record({ [num]: { error: "invalid_grant", struckFp: fp } }, identities, claims);
  }

  it("test_strike_stamps_fingerprint", () => {
    const st = makeStore();
    recordInvalidGrant(st, "1", "fp-A");
    const entry = st.entries(ident, [])["1"]!;
    expect(entry.authDeadStrikes).toBe(1);
    expect(entry.tokenDead(undefined, "fp-A")).toBe(true);
  });

  it("test_strike_unbinds_on_fingerprint_mismatch", () => {
    const st = makeStore();
    recordInvalidGrant(st, "1", "fp-A");
    const entry = st.entries(ident, [])["1"]!;
    expect(entry.tokenDead(undefined, "fp-B")).toBe(false);
  });

  it("test_strike_without_fp_binds_unconditionally", () => {
    const st = makeStore();
    recordInvalidGrant(st, "1", null);
    const entry = st.entries(ident, [])["1"]!;
    expect(entry.tokenDead(undefined, "fp-anything")).toBe(true);
  });
});

describe("TestStruckFingerprintHygiene", () => {
  const ident: Record<string, Identity> = { "1": ["a@b.c", ""] };

  it("test_legacy_strike_overwrites_stale_fingerprint", () => {
    store.record({ "1": { error: "invalid_grant", struckFp: "sha256:old" } }, ident);
    store.clearDeadToken(["1"], ident);
    store.record({ "1": { error: "invalid_grant" } }, ident);
    const entry = store.entries(ident)["1"]!;
    expect(entry.struckFingerprint).toBeNull();
    expect(entry.tokenDead(undefined, "sha256:new")).toBe(true);
  });

  it("test_a_legacy_restrike_overwrites_a_live_stale_fingerprint", () => {
    store.record({ "1": { error: "invalid_grant", struckFp: "sha256:old" } }, ident);
    expect(store.entries(ident)["1"]!.struckFingerprint).toBe("sha256:old");
    store.record({ "1": { error: "invalid_grant" } }, ident);
    const entry = store.entries(ident)["1"]!;
    expect(entry.struckFingerprint, "a legacy strike must bind unconditionally").toBeNull();
    expect(entry.tokenDead(undefined, "sha256:new")).toBe(true);
  });

  it("test_clear_dead_token_drops_fingerprint", () => {
    store.record({ "1": { error: "invalid_grant", struckFp: "sha256:old" } }, ident);
    store.clearDeadToken(["1"], ident);
    expect(store.entries(ident)["1"]!.struckFingerprint).toBeNull();
  });
});

describe("TestAdopt", () => {
  it("test_reading_is_backdated_by_its_age", () => {
    expect(store.adopt({ "1": [USAGE, 40.0] }, IDENT)).toEqual(new Set(["1"]));
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.lastGood).toEqual(USAGE);
    expect(entry.fetchedAt).toBe(clock.now - 40.0);
    expect(entry.ageS).toBe(40.0);
  });

  it("test_never_downgrades_a_newer_local_reading", () => {
    const local: UsageDict = { five_hour: { pct: 60.0 } };
    store.record({ "1": { usage: local } }, IDENT);
    clock.advance(10);
    expect(store.adopt({ "1": [USAGE, 30.0] }, IDENT)).toEqual(new Set());
    expect(store.entries(IDENT)["1"]!.lastGood).toEqual(local);
  });

  it("test_fetch_state_is_left_alone", () => {
    store.record({ "1": { error: "http-429", retryAfterS: 0.0 } }, IDENT);
    const before = store.entries(IDENT)["1"]!;
    store.adopt({ "1": [USAGE, 0.0] }, IDENT);
    const after = store.entries(IDENT)["1"]!;
    expect(after.lastGood).toEqual(USAGE);
    expect(after.consecutiveFailures).toBe(1);
    expect(before.consecutiveFailures).toBe(1);
    expect(after.lastError).toBe("http-429");
    expect(after.backoffUntil).toBe(before.backoffUntil);
    expect(after.last429At).toBe(before.last429At);
  });

  it("test_hold_keeps_every_mode_off_until_it_lapses", () => {
    store.adopt({ "1": [USAGE, 0.0] }, IDENT, 600.0);
    clock.advance(SERVE_TTL_S + 1);
    expect(store.reserve(["1"], IDENT, { respectPlans: true })).toEqual({});
    expect(store.reserve(["1"], IDENT, { respectPlans: false })).toEqual({});
    expect(store.reserve(["1"], IDENT, { respectPlans: false, repairOverslept: true })).toEqual({});
    clock.advance(600.0);
    expect(keys(store.reserve(["1"], IDENT, { respectPlans: true }))).toEqual(new Set(["1"]));
  });

  it("test_held_reading_stays_decision_trusted", () => {
    store.adopt({ "1": [USAGE, 0.0] }, IDENT, 900.0);
    clock.advance(STALE_OK_S + 1);
    const entry = store.entries(IDENT)["1"]!;
    expect(entry.held(clock.now)).toBe(true);
    expect(entry.decisionValue()).toEqual(USAGE);
    clock.advance(900.0);
    expect(store.entries(IDENT)["1"]!.decisionValue()).toBeNull();
  });

  it("test_hold_never_outlives_the_trust_ceiling", () => {
    store.adopt({ "1": [USAGE, 3000.0] }, IDENT, 3600.0);
    const entry = store.entries(IDENT)["1"]!;
    expectApprox(entry.heldUntil, entry.fetchedAt! + TRUST_MAX_AGE_S);
    clock.advance(TRUST_MAX_AGE_S - 3000.0);
    expect(keys(store.reserve(["1"], IDENT, { respectPlans: true }))).toEqual(new Set(["1"]));
  });

  it("test_latest_hold_wins", () => {
    store.adopt({ "1": [USAGE, 0.0] }, IDENT, 900.0);
    store.adopt({ "1": [USAGE, 0.0] }, IDENT, 60.0);
    expect(store.entries(IDENT)["1"]!.heldUntil).toBe(clock.now + 60.0);
  });

  function usageResettingIn(fiveHourS: number, scopedS: number | null = null): UsageDict {
    const usage: UsageDict = {
      five_hour: { pct: 25.0, resets_at: iso(clock.now + fiveHourS) },
      seven_day: { pct: 10.0, resets_at: iso(clock.now + 86_400.0) },
    };
    if (scopedS !== null) usage.scoped = [{ name: "Fable", pct: 5.0, resets_at: iso(clock.now + scopedS) }];
    return usage;
  }

  it("test_hold_stops_at_the_readings_earliest_reset", () => {
    const usage = usageResettingIn(300.0);
    store.adopt({ "1": [usage, 0.0] }, IDENT, 900.0);
    expectApprox(store.entries(IDENT)["1"]!.heldUntil, clock.now + 300.0);
    clock.advance(300.0);
    expect(keys(store.reserve(["1"], IDENT, { respectPlans: true }))).toEqual(new Set(["1"]));
  });

  it("test_a_scoped_windows_reset_caps_the_hold_too", () => {
    const usage = usageResettingIn(3000.0, 120.0);
    store.adopt({ "1": [usage, 0.0] }, IDENT, 900.0);
    expectApprox(store.entries(IDENT)["1"]!.heldUntil, clock.now + 120.0);
  });

  it("test_the_cap_comes_from_the_reading_kept", () => {
    store.record({ "1": { usage: usageResettingIn(120.0) } }, IDENT);
    const imported = usageResettingIn(3000.0);
    expect(store.adopt({ "1": [imported, 30.0] }, IDENT, 900.0)).toEqual(new Set());
    expectApprox(store.entries(IDENT)["1"]!.heldUntil, clock.now + 120.0);
  });

  it("test_a_reading_from_before_a_reset_is_not_held", () => {
    const usage = usageResettingIn(-60.0);
    expect(store.adopt({ "1": [usage, 600.0] }, IDENT, 900.0)).toEqual(new Set(["1"]));
    expect(store.entries(IDENT)["1"]!.heldUntil).toBeNull();
  });

  it("test_zero_hold_lifts_an_existing_hold", () => {
    store.adopt({ "1": [USAGE, 0.0] }, IDENT, 900.0);
    store.adopt({ "1": [USAGE, 0.0] }, IDENT, 0.0);
    expect(store.entries(IDENT)["1"]!.heldUntil).toBeNull();
    clock.advance(SERVE_TTL_S + 1);
    expect(keys(store.reserve(["1"], IDENT, { respectPlans: true }))).toEqual(new Set(["1"]));
  });

  it("test_no_hold_leaves_an_existing_hold_alone", () => {
    store.adopt({ "1": [USAGE, 0.0] }, IDENT, 900.0);
    store.adopt({ "1": [USAGE, 0.0] }, IDENT);
    expect(store.entries(IDENT)["1"]!.heldUntil).toBe(clock.now + 900.0);
  });

  it("test_due_candidate_skips_a_held_slot", () => {
    store.adopt({ "1": [USAGE, 0.0], "2": [USAGE, 0.0] }, IDENT, 600.0);
    const plan = [clock.now + 60.0, 60.0] as const;
    store.setPollPlan({ "1": plan, "2": plan }, IDENT);
    clock.advance(61);
    expect(dueCandidate(["1", "2"], store.entries(IDENT), clock.now)).toBeNull();
  });

  it("test_a_claimed_fetch_still_records", () => {
    const claims = store.reserve(["1"], IDENT, { respectPlans: true });
    store.adopt({ "1": [USAGE, 5.0] }, IDENT, 600.0);
    const local: UsageDict = { five_hour: { pct: 61.0 } };
    expect(store.record({ "1": { usage: local } }, IDENT, claims)).toEqual(new Set(["1"]));
    expect(store.entries(IDENT)["1"]!.lastGood).toEqual(local);
  });

  it("test_row_of_another_account_is_replaced", () => {
    store.record({ "2": { usage: USAGE } }, { "2": ["old@x.com", ""] });
    store.adopt({ "2": [USAGE, 0.0] }, IDENT);
    const row = JSON.parse(fs.readFileSync(store.path, "utf8")).accounts["2"];
    expect([row.email, row.organizationUuid]).toEqual(IDENT["2"]);
  });
});
