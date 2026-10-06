import { describe, expect, it } from "vitest";
import * as pace from "../src/pace.js";
import { isoformat } from "../src/support/py.js";

const NOW = 1_700_000_000.0;
const DAY = 86400.0;
const WEEK = pace.WEEKLY_PERIOD_S;

function iso(ts: number): string {
  return isoformat(new Date(ts * 1000));
}

function window(pct: number, resetsAtTs: number | null): Record<string, unknown> {
  const result: Record<string, unknown> = { pct };
  if (resetsAtTs !== null) result.resets_at = iso(resetsAtTs);
  return result;
}

describe("TestComputePaceElapsed", () => {
  it("test_one_day_into_the_week", () => {
    const result = pace.computePace(window(20.0, NOW + 6 * DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(result!.elapsedS).toBe(DAY);
    expect(result!.expectedPct).toBe((DAY / WEEK) * 100.0);
  });

  it("test_right_at_reset_boundary_is_suppressed", () => {
    expect(pace.computePace(window(5.0, NOW + WEEK), { fetchedAt: NOW })).toBeNull();
  });

  it("test_stale_resets_at_multiple_cycles_in_the_past_still_resolves", () => {
    const result = pace.computePace(window(20.0, NOW - 2 * WEEK - DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(result!.elapsedS).toBe(DAY);
  });

  it("test_missing_fields_return_none", () => {
    expect(pace.computePace(null, { fetchedAt: NOW })).toBeNull();
    expect(pace.computePace({ pct: 10.0 }, { fetchedAt: NOW })).toBeNull();
    expect(pace.computePace({ resets_at: iso(NOW + DAY) }, { fetchedAt: NOW })).toBeNull();
    expect(pace.computePace(window(10.0, NOW + DAY), { fetchedAt: null })).toBeNull();
    expect(pace.computePace({ pct: 10.0, resets_at: "not-a-date" }, { fetchedAt: NOW })).toBeNull();
  });
});

describe("TestSuppressionWindow", () => {
  it("test_just_inside_suppression_window_is_none", () => {
    const elapsed = pace.SUPPRESS_AFTER_RESET_S - 1.0;
    expect(pace.computePace(window(50.0, NOW + WEEK - elapsed), { fetchedAt: NOW })).toBeNull();
  });

  it("test_just_outside_suppression_window_is_not_none", () => {
    const elapsed = pace.SUPPRESS_AFTER_RESET_S;
    const result = pace.computePace(window(50.0, NOW + WEEK - elapsed), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(result!.elapsedS).toBe(elapsed);
  });
});

describe("TestAheadThreshold", () => {
  it("test_meaningfully_ahead_flags_true", () => {
    const result = pace.computePace(window(50.0, NOW + 6 * DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(result!.ahead).toBe(true);
  });

  it("test_within_threshold_flags_false_but_still_returns", () => {
    const result = pace.computePace(window(20.0, NOW + 6 * DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(result!.ahead).toBe(false);
  });

  it("test_behind_pace_flags_false", () => {
    const result = pace.computePace(window(5.0, NOW + 6 * DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(result!.ahead).toBe(false);
  });
});

describe("TestProjectedExhaustionTs", () => {
  it("test_linear_projection", () => {
    const result = pace.computePace(window(50.0, NOW + 6 * DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    const eta = pace.projectedExhaustionTs(result!, { fetchedAt: NOW });
    expect(eta).not.toBeNull();
    expect(eta).toBe(NOW + DAY);
  });

  it("test_already_at_or_over_100_returns_fetched_at", () => {
    const result = pace.computePace(window(120.0, NOW + 6 * DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(pace.projectedExhaustionTs(result!, { fetchedAt: NOW })).toBe(NOW);
  });

  it("test_zero_usage_has_no_projection", () => {
    const result = pace.computePace(window(0.0, NOW + 6 * DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(pace.projectedExhaustionTs(result!, { fetchedAt: NOW })).toBeNull();
  });
});

describe("TestWillLastToReset", () => {
  it("test_sustainable_rate_will_last", () => {
    const result = pace.computePace(window(10.0, NOW + 6 * DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(pace.willLastToReset(result!)).toBe(true);
  });

  it("test_unsustainable_rate_will_not_last", () => {
    const result = pace.computePace(window(50.0, NOW + 6 * DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(pace.willLastToReset(result!)).toBe(false);
  });

  it("test_zero_usage_will_last", () => {
    const result = pace.computePace(window(0.0, NOW + 6 * DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(pace.willLastToReset(result!)).toBe(true);
  });

  it("test_comfortably_sustainable_rate_will_last", () => {
    const result = pace.computePace(window(12.0, NOW + 6 * DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(pace.willLastToReset(result!)).toBe(true);
  });
});

describe("TestAheadVsWillLastRelationship", () => {
  it("test_will_last_flips_exactly_at_expected_pct", () => {
    for (const days of [1.0, 2.5, 4.0, 6.0]) {
      const resetsAt = NOW + (7.0 - days) * DAY;
      const expected = ((days * DAY) / WEEK) * 100.0;
      const over = pace.computePace(window(expected + 0.5, resetsAt), { fetchedAt: NOW });
      const under = pace.computePace(window(expected - 0.5, resetsAt), { fetchedAt: NOW });
      expect(over).not.toBeNull();
      expect(under).not.toBeNull();
      expect(pace.willLastToReset(over!)).toBe(false);
      expect(pace.willLastToReset(under!)).toBe(true);
    }
  });

  it("test_slightly_ahead_reads_wont_last_with_no_marker", () => {
    const result = pace.computePace(window(25.0, NOW + 6 * DAY), { fetchedAt: NOW });
    expect(result).not.toBeNull();
    expect(result!.ahead).toBe(false);
    expect(pace.willLastToReset(result!)).toBe(false);
  });
});
