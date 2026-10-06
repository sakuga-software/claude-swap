/**
 * Cadence policy for the `/api/oauth/usage` endpoint. All the numbers are in this module.
 *
 * The endpoint allows about 28-30 requests in a trailing window of about 60 minutes,
 * per identity and UA class. Capacity comes back only when old requests leave that hour.
 * The budget target is an average of at most 1 request each 3 minutes.
 * The Python module holds the measurements and their history.
 */
import { accountHeadroom, relevantWindows, type UsageDict } from "./oauth.js";
import { fromisoformat } from "./support/py.js";

/** An entry younger than this comes from the store without a fetch. */
export const SERVE_TTL_S = 180.0;

/** Movement can halve an interval down to this value, never below. */
export const MIN_INTERVAL_S = 180.0;

/** The active account moves inside the escalation band. The episode is bounded by construction. */
export const URGENT_INTERVAL_S = 60.0;

export const ACTIVE_MAX_INTERVAL_S = 300.0;
export const CANDIDATE_DEFAULT_INTERVAL_S = 300.0;
export const CANDIDATE_MAX_INTERVAL_S = 600.0;

/**
 * An exhausted account keeps a slow poll, because a quota grant can make it usable
 * before its reported reset.
 */
export const EXHAUSTED_INTERVAL_S = 600.0;

/** A binding pct change of at least this value between polls is movement. */
export const MOVEMENT_DELTA_PCT = 1.0;

/** Probe interval after a 429 with `Retry-After: 0` (the edge of a saturated window). */
export const EDGE_BACKOFF_S = 300.0;
/** Cadence floor while a 429 occurred on the token in the last `RECENT_429_WINDOW_S`. */
export const POST_429_MIN_INTERVAL_S = 360.0;
export const RECENT_429_WINDOW_S = 3600.0;

/**
 * AIMD on a budget that other machines share: while 429s recur, each successful poll
 * multiplies the interval toward `POST_429_MAX_INTERVAL_S`.
 */
export const POST_429_BACKOFF_MULT = 1.5;
export const POST_429_MAX_INTERVAL_S = 1800.0;

/** The engine refreshes all candidates when the active account is inside this margin of the threshold. */
export const ESCALATION_MARGIN_PCT = 15.0;

/** A poll is never later than a known window reset plus this slack. */
export const RESET_SLACK_S = 60.0;

export const internals = {
  /** ±fraction on each scheduled interval, so that independent processes do not fetch together. */
  JITTER_FRAC: 0.1,
};

/** Utilization of the binding (worst) relevant window, or null. */
export function bindingPct(usage: UsageDict | null | undefined, models: readonly string[] = []): number | null {
  const headroom = accountHeadroom(usage, models);
  return headroom === null ? null : 100.0 - headroom;
}

/** Epoch when the last of the relevant windows at 100% or more resets. */
export function limitingResetTs(usage: UsageDict | null | undefined, models: readonly string[] = []): number | null {
  let latest: number | null = null;
  for (const [, pct, resetsAt] of relevantWindows(usage, models)) {
    if (pct < 100.0) continue;
    const ts = parseResetTs(resetsAt);
    if (ts !== null && (latest === null || ts > latest)) latest = ts;
  }
  return latest;
}

/** Epoch of the next relevant-window reset after `now`, for all utilizations. */
export function earliestFutureResetTs(
  usage: UsageDict | null | undefined,
  now: number,
  models: readonly string[] = [],
): number | null {
  let earliest: number | null = null;
  for (const [, , resetsAt] of relevantWindows(usage, models)) {
    const ts = parseResetTs(resetsAt);
    if (ts !== null && ts > now && (earliest === null || ts < earliest)) earliest = ts;
  }
  return earliest;
}

export function parseResetTs(resetsAt: string | null | undefined): number | null {
  if (!resetsAt) return null;
  try {
    return fromisoformat(String(resetsAt)).getTime() / 1000;
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}

export interface PlanAfterFetchOptions {
  prevIntervalS: number | null;
  prevUsage: UsageDict | null;
  newUsage: UsageDict | null;
  isActive: boolean;
  threshold: number;
  models: readonly string[];
  recent429: boolean;
  now: number;
  rng?: () => number;
}

/**
 * `[nextPollAt, intervalS]` for an account after a successful fetch.
 *
 * - Movement halves the interval, with `MIN_INTERVAL_S` as the floor. The active account
 *   that moves inside the escalation band goes to `URGENT_INTERVAL_S`.
 * - No movement multiplies the interval by 1.5 toward the ceiling of the account.
 *   Unknown utilization uses the default.
 * - A recent 429 grows the interval (AIMD), with `POST_429_MIN_INTERVAL_S` as the floor,
 *   and stops urgent mode.
 * - An exhausted account polls at `EXHAUSTED_INTERVAL_S` or slower.
 *
 * The scheduled time gets `JITTER_FRAC` noise and is never later than the next window reset
 * plus `RESET_SLACK_S`.
 */
export function planAfterFetch({
  prevIntervalS,
  prevUsage,
  newUsage,
  isActive,
  threshold,
  models,
  recent429,
  now,
  rng = Math.random,
}: PlanAfterFetchOptions): [number, number] {
  const fallback = isActive ? MIN_INTERVAL_S : CANDIDATE_DEFAULT_INTERVAL_S;
  const ceiling = isActive ? ACTIVE_MAX_INTERVAL_S : CANDIDATE_MAX_INTERVAL_S;
  const base = prevIntervalS || fallback;
  const prevPct = bindingPct(prevUsage, models);
  const newPct = bindingPct(newUsage, models);
  let moving: boolean;
  let interval: number;
  if (prevPct === null || newPct === null) {
    moving = false;
    interval = fallback;
  } else if (Math.abs(newPct - prevPct) >= MOVEMENT_DELTA_PCT) {
    moving = true;
    interval = Math.max(MIN_INTERVAL_S, base / 2);
  } else {
    // The floor makes the sub-floor urgent base (60 s) go back to the normal cadence at once.
    moving = false;
    interval = Math.min(ceiling, Math.max(MIN_INTERVAL_S, base * 1.5));
  }
  if (isActive && moving && !recent429 && newPct !== null && newPct >= threshold - ESCALATION_MARGIN_PCT) {
    interval = URGENT_INTERVAL_S;
  }
  if (recent429) {
    const increased = Math.max(base * POST_429_BACKOFF_MULT, POST_429_MIN_INTERVAL_S);
    interval = Math.min(POST_429_MAX_INTERVAL_S, Math.max(interval, increased));
  }

  const headroom = accountHeadroom(newUsage, models);
  const exhausted = headroom !== null && headroom <= 0;
  if (exhausted) interval = Math.max(interval, EXHAUSTED_INTERVAL_S);

  let nextPoll = now + interval * (1.0 + internals.JITTER_FRAC * (2.0 * rng() - 1.0));
  if (exhausted) {
    const resetTs = limitingResetTs(newUsage, models);
    if (resetTs !== null && resetTs > now) nextPoll = Math.min(nextPoll, resetTs + RESET_SLACK_S);
  } else {
    const resetTs = earliestFutureResetTs(newUsage, now, models);
    if (resetTs !== null) nextPoll = Math.min(nextPoll, resetTs + RESET_SLACK_S);
  }
  return [nextPoll, interval];
}
