import { fromisoformat } from "./support/py.js";

/** Weekly windows reset on a fixed 7-day cycle. */
export const WEEKLY_PERIOD_S = 7 * 86400.0;

/** Right after a reset, almost any usage reads as "ahead". The marker stays off for this time. */
export const SUPPRESS_AFTER_RESET_S = 24 * 3600.0;

/** Minimum gap in percentage points between actual and expected usage before the marker shows. */
export const AHEAD_THRESHOLD_PCT = 15.0;

/** The pace of one weekly window at the time of its snapshot. */
export interface PaceResult {
  /** The usage in percent that an "on schedule" account has at this time. */
  expectedPct: number;
  actualPct: number;
  /** The time since the start of the current cycle, in seconds. */
  elapsedS: number;
  periodS: number;
  /** True if `actualPct - expectedPct` is at or above the threshold. */
  ahead: boolean;
}

export interface ComputePaceOptions {
  fetchedAt: number | null | undefined;
  periodS?: number;
  suppressAfterResetS?: number;
  aheadThresholdPct?: number;
}

function resetsAtTs(resetsAt: unknown): number | null {
  if (typeof resetsAt !== "string") return null;
  try {
    return fromisoformat(resetsAt).getTime() / 1000;
  } catch {
    return null;
  }
}

function pythonNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  return null;
}

function floorMod(a: number, n: number): number {
  const r = a % n;
  return r !== 0 && r < 0 !== n < 0 ? r + n : r;
}

/**
 * The pace of one weekly usage window, or null if the pace is not computable or not meaningful.
 *
 * `window` is a raw window object (`{"pct": ..., "resets_at": ...}`). `resets_at` is the next reset.
 * The function moves `resets_at` by whole periods to find the start of the cycle that contains `fetchedAt`.
 * It returns null if the window is missing or not usable, or if the cycle started less than `suppressAfterResetS` ago.
 */
export function computePace(
  window: unknown,
  {
    fetchedAt,
    periodS = WEEKLY_PERIOD_S,
    suppressAfterResetS = SUPPRESS_AFTER_RESET_S,
    aheadThresholdPct = AHEAD_THRESHOLD_PCT,
  }: ComputePaceOptions,
): PaceResult | null {
  if (typeof window !== "object" || window === null || Array.isArray(window) || fetchedAt == null) return null;
  const fields = window as Record<string, unknown>;
  const pct = pythonNumber(fields.pct);
  if (pct === null) return null;
  const nextReset = resetsAtTs(fields.resets_at);
  if (nextReset === null) return null;

  const remaining = floorMod(nextReset - fetchedAt, periodS);
  const elapsed = remaining === 0 ? 0.0 : periodS - remaining;

  if (elapsed < suppressAfterResetS) return null;

  const expectedPct = Math.min(100.0, (elapsed / periodS) * 100.0);
  return {
    expectedPct,
    actualPct: pct,
    elapsedS: elapsed,
    periodS,
    ahead: pct - expectedPct >= aheadThresholdPct,
  };
}

/**
 * The POSIX timestamp at which a linear projection of the usage reaches 100%.
 * Only the JSON output uses it, because real usage is not linear.
 * Returns null if there is no measurable rate.
 */
export function projectedExhaustionTs(pace: PaceResult, { fetchedAt }: { fetchedAt: number }): number | null {
  if (pace.elapsedS <= 0 || pace.actualPct <= 0) return null;
  const ratePctPerS = pace.actualPct / pace.elapsedS;
  if (ratePctPerS <= 0) return null;
  const remainingPct = 100.0 - pace.actualPct;
  if (remainingPct <= 0) return fetchedAt;
  return fetchedAt + remainingPct / ratePctPerS;
}

/**
 * Whether the usage stays at or below 100% until the reset, at the current rate.
 * Only the JSON output uses it. It is false as soon as the usage is above the expected usage, with no threshold.
 * Returns null if there is no measurable rate.
 */
export function willLastToReset(pace: PaceResult): boolean | null {
  if (pace.actualPct <= 0) return true;
  if (pace.elapsedS <= 0) return null;
  const ratePctPerS = pace.actualPct / pace.elapsedS;
  if (ratePctPerS <= 0) return null;
  const projectedTotalPct = pace.actualPct + ratePctPerS * (pace.periodS - pace.elapsedS);
  return projectedTotalPct <= 100.0;
}
