/**
 * Per-account usage table: the last good measurement and the fetch state of each account.
 *
 * The store keeps only measurements (`lastGood`) and fetch state (failures, backoff,
 * poll plan). A failure changes the fetch state and never changes `lastGood`.
 * Sentinel states ("api key", "token expired", ...) come from the collector on each
 * pass and are never written to disk.
 *
 * Lock protocol. The lock is never held across network I/O:
 * 1. Lock, read, claim the fetch set (stamp `claimUntil`), unlock.
 * 2. Fetch with no lock.
 * 3. Lock, read again, merge the outcomes, clear the claim, write, unlock.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FileLock } from "./locking.js";
import { relevantWindows, type UsageDict } from "./oauth.js";
import {
  EDGE_BACKOFF_S,
  EXHAUSTED_INTERVAL_S,
  RECENT_429_WINDOW_S,
  RESET_SLACK_S,
  SERVE_TTL_S,
  parseResetTs,
} from "./poll_policy.js";
import { atomicWriteJson } from "./settings.js";

export { RECENT_429_WINDOW_S, SERVE_TTL_S };

export const SCHEMA_VERSION = 2;

/** Last good data younger than this is trusted for switch decisions. */
export const STALE_OK_S = 300.0;
/** The life of a fetch lease. It covers a full batch of fetches, so another surface does not claim a request in flight. */
export const CLAIM_TTL_S = 90.0;
/** Claim life for rows that an older collector wrote without `claimUntil`. */
export const LEGACY_CLAIM_TTL_S = 10.0;

/** Deliberate staleness extends decision trust past `STALE_OK_S`, but never past this age. */
export const TRUST_MAX_AGE_S = 3600.0;

/**
 * Trust ceiling for data that is stale because of a usage-endpoint 429 and has no `resets_at`.
 * A 429 does not move the real windows, so the data stays a lower bound until the earliest reset.
 */
export const RATE_LIMIT_TRUST_MAX_AGE_S = 7200.0;

/** Failure backoff with no Retry-After: 30s * 2^(n-1), capped. */
export const BACKOFF_BASE_S = 30.0;
export const BACKOFF_CAP_S = 600.0;
/** Exponent clamp. The curve reaches `BACKOFF_CAP_S` at shift 5, so this value changes no result. */
export const BACKOFF_MAX_SHIFT = 32;

/**
 * Added to an hour-scale Retry-After. A retry on the deadline itself often gets a new
 * full-hour block. The Python module holds the measurements.
 */
export const RETRY_AFTER_MARGIN_S = 900.0;
/** Bounds Retry-After + margin for a 429: the measured 3600s block plus `RETRY_AFTER_MARGIN_S`. */
export const RETRY_AFTER_FLOOR_CAP_S = 4500.0;

/** One `invalid_grant` answer is definitive: the account goes into quarantine until a re-login. */
export const AUTH_DEAD_STRIKES = 1;

/** Fetch errors that prove that the stored credential cannot work again. Only these add a dead-token strike. */
export const PERMANENT_AUTH_ERRORS: ReadonlySet<string> = new Set(["invalid_grant", "no_refresh_token"]);

/** `[email, organizationUuid]`: the identity that a slot number maps to now. */
export type Identity = readonly [email: string, organizationUuid: string];
/** `[nextPollAt, pollIntervalS]`. */
export type PollPlan = readonly [nextPollAt: number | null, pollIntervalS: number | null];

type Row = Record<string, unknown>;

/** Seams that the tests replace. */
export const internals = {
  /** `time.time()`: the epoch in seconds, as a float. */
  now: (): number => Date.now() / 1000,
  /** `uuid.uuid4().hex`. */
  claimId: (): string => randomUUID().replaceAll("-", ""),
  /**
   * The jitter bound that `planOversleepsInterval` allows. Python imports this value
   * from `poll_policy` at load time, so the test override of the poll policy jitter does not apply here.
   */
  JITTER_FRAC: 0.1,
};

/**
 * The outcome of one fetch, as `UsageStore.record` gets it. Use one of three shapes:
 * - success: no `error` and no `sentinel` (`usage` can be null if the response had no window data);
 * - failure: `error`, with an optional `retryAfterS`;
 * - sentinel: `sentinel`. The store does not keep it, except `rejectedFp`.
 */
export interface FetchRecord {
  usage?: UsageDict | null;
  error?: string | null;
  retryAfterS?: number | null;
  sentinel?: string | null;
  /** Fingerprint of the credential whose refresh token got a permanent auth error. The strike binds to it. */
  struckFp?: string | null;
  /** Hash of the access token that a live session's read-only fetch was refused with. */
  rejectedFp?: string | null;
}

export interface UsageEntryInit {
  sentinel?: string | null;
  lastGood?: UsageDict | null;
  fetchedAt?: number | null;
  ageS?: number | null;
  lastAttemptAt?: number | null;
  consecutiveFailures?: number;
  lastError?: string | null;
  backoffUntil?: number | null;
  nextPollAt?: number | null;
  pollIntervalS?: number | null;
  last429At?: number | null;
  authDeadStrikes?: number;
  struckFingerprint?: string | null;
  rejectedFingerprint?: string | null;
  trustExtended?: boolean;
  claimUntil?: number | null;
  heldUntil?: number | null;
}

/**
 * Read model of the usage state of one account at collect time.
 *
 * `sentinel` is the live overlay of the collector. `ageS` (the age of `lastGood`) and
 * `trustExtended` come from the snapshot time. All other fields mirror the stored row.
 */
export class UsageEntry {
  readonly sentinel: string | null;
  readonly lastGood: UsageDict | null;
  readonly fetchedAt: number | null;
  readonly ageS: number | null;
  readonly lastAttemptAt: number | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  readonly backoffUntil: number | null;
  readonly nextPollAt: number | null;
  readonly pollIntervalS: number | null;
  /** The last 429 on this token. A later success does not clear it. */
  readonly last429At: number | null;
  readonly authDeadStrikes: number;
  /** The credential generation that the strikes condemn. Null on legacy rows: the strikes then bind always. */
  readonly struckFingerprint: string | null;
  readonly rejectedFingerprint: string | null;
  /** Data older than `STALE_OK_S` that stays trusted because the staleness is deliberate. */
  readonly trustExtended: boolean;
  readonly claimUntil: number | null;
  /** Until this time, a reading from another machine keeps every collector off this slot. */
  readonly heldUntil: number | null;

  constructor(init: UsageEntryInit = {}) {
    this.sentinel = init.sentinel ?? null;
    this.lastGood = init.lastGood ?? null;
    this.fetchedAt = init.fetchedAt ?? null;
    this.ageS = init.ageS ?? null;
    this.lastAttemptAt = init.lastAttemptAt ?? null;
    this.consecutiveFailures = init.consecutiveFailures ?? 0;
    this.lastError = init.lastError ?? null;
    this.backoffUntil = init.backoffUntil ?? null;
    this.nextPollAt = init.nextPollAt ?? null;
    this.pollIntervalS = init.pollIntervalS ?? null;
    this.last429At = init.last429At ?? null;
    this.authDeadStrikes = init.authDeadStrikes ?? 0;
    this.struckFingerprint = init.struckFingerprint ?? null;
    this.rejectedFingerprint = init.rejectedFingerprint ?? null;
    this.trustExtended = init.trustExtended ?? false;
    this.claimUntil = init.claimUntil ?? null;
    this.heldUntil = init.heldUntil ?? null;
    Object.freeze(this);
  }

  fresh(now: number, ttl: number = SERVE_TTL_S): boolean {
    return this.fetchedAt !== null && now - this.fetchedAt <= ttl;
  }

  inBackoff(now: number): boolean {
    return this.backoffUntil !== null && now < this.backoffUntil;
  }

  /** True while the hold of an adopted reading keeps the collectors off. */
  held(now: number): boolean {
    return this.heldUntil !== null && now < this.heldUntil;
  }

  /**
   * True if this token got a 429 recently enough to keep the post-429 cadence.
   *
   * The window starts when the 429 backoff lifts, not at the 429 itself. An hour-scale
   * block has no attempt before it lifts, so the first success after it must still see
   * a recent 429.
   */
  recent429(now: number): boolean {
    if (this.last429At === null) return false;
    let anchor = this.last429At;
    // Use the backoff only while the live backoff comes from a 429. A later timeout also writes backoffUntil.
    if (this.lastError === "http-429" && this.backoffUntil !== null && this.backoffUntil > anchor) {
      anchor = this.backoffUntil;
    }
    return now < anchor + RECENT_429_WINDOW_S;
  }

  /** True while the bounded fetch lease of another collector is live. */
  claimed(now: number): boolean {
    return liveClaim(this.claimUntil, this.lastAttemptAt, now);
  }

  /**
   * True if the refresh-token lineage of the stored credential is dead.
   *
   * The strikes condemn the credential generation that was sent, not the slot. If
   * `storedFp` differs from the struck fingerprint, the credential changed after the
   * verdict and the strike does not apply.
   */
  tokenDead(threshold: number = AUTH_DEAD_STRIKES, storedFp: string | null = null): boolean {
    if (this.authDeadStrikes < threshold) return false;
    if (storedFp !== null && this.struckFingerprint !== null && storedFp !== this.struckFingerprint) return false;
    return true;
  }

  /**
   * The value that switch decisions use: the sentinel, else `lastGood` while it is
   * trusted, else null (unknown). Display code reads `lastGood` and `ageS` directly.
   */
  decisionValue(): UsageDict | string | null {
    if (this.sentinel !== null) return this.sentinel;
    if (this.lastGood !== null && this.ageS !== null && (this.ageS <= STALE_OK_S || this.trustExtended)) {
      return this.lastGood;
    }
    return null;
  }
}

/** The one rule for claim liveness. `UsageEntry.claimed`, `entries()` and `rowEligible` must agree. */
function liveClaim(claimUntil: number | null, lastAttemptAt: number | null, now: number): boolean {
  if (claimUntil !== null) return now < claimUntil;
  return lastAttemptAt !== null && now - lastAttemptAt < LEGACY_CLAIM_TTL_S;
}

function planOversleepsIntervalRaw(nextPollAt: number | null, pollIntervalS: number | null, now: number): boolean {
  if (nextPollAt === null) return false;
  const interval = Math.max(pollIntervalS || EXHAUSTED_INTERVAL_S, EXHAUSTED_INTERVAL_S);
  const latestNormalPoll = now + interval * (1.0 + internals.JITTER_FRAC) + RESET_SLACK_S;
  return nextPollAt > latestNormalPoll;
}

/**
 * True if a row has an obsolete reset-parked plan: a deadline that the bounded planner
 * cannot produce from the stored interval.
 */
export function planOversleepsInterval(entry: UsageEntry, now: number): boolean {
  return planOversleepsIntervalRaw(entry.nextPollAt, entry.pollIntervalS, now);
}

/**
 * The due candidate with the oldest data, or null.
 *
 * Due means past its `nextPollAt`, not in failure backoff, not held, and not
 * quarantined. Sentinel accounts have nothing to fetch.
 */
export function dueCandidate(candidates: readonly string[], entries: Record<string, UsageEntry>, now: number): string | null {
  const due: Array<[number, number, string]> = [];
  for (const num of candidates) {
    const entry = Object.hasOwn(entries, num) ? entries[num] : undefined;
    if (entry === undefined) {
      due.push([0, 0.0, num]);
      continue;
    }
    if (entry.sentinel !== null) continue;
    if (entry.tokenDead()) continue;
    if (entry.inBackoff(now)) continue;
    if (entry.held(now)) continue;
    if (entry.nextPollAt !== null && now < entry.nextPollAt && !planOversleepsInterval(entry, now)) continue;
    if (entry.fetchedAt === null) due.push([0, 0.0, num]);
    else due.push([1, entry.fetchedAt, num]);
  }
  if (due.length === 0) return null;
  due.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  return due[0]![2];
}

/** Epoch of the earliest relevant window reset, or null. A window with no `resets_at` adds nothing. */
export function earliestReset(lastGood: unknown, models: readonly string[] = []): number | null {
  let earliest: number | null = null;
  for (const [, , resetsAt] of relevantWindows(lastGood as UsageDict | null, models)) {
    const ts = parseResetTs(resetsAt);
    if (ts !== null && (earliest === null || ts < earliest)) earliest = ts;
  }
  return earliest;
}

/**
 * True if `lastGood` that is stale because of a 429 is still trusted:
 * `now < min(earliest reset, fetchedAt + RATE_LIMIT_TRUST_MAX_AGE_S)`.
 */
function rateLimitedTrustOk(lastGood: UsageDict | null, ageS: number | null, now: number, models: readonly string[] = []): boolean {
  if (ageS === null) return false;
  const ceiling = now + (RATE_LIMIT_TRUST_MAX_AGE_S - ageS);
  const soonest = earliestReset(lastGood, models);
  return now < (soonest !== null ? Math.min(soonest, ceiling) : ceiling);
}

export interface FailureBackoffOptions {
  rateLimited?: boolean;
}

/**
 * Seconds to stay in backoff after a failed fetch.
 *
 * - No Retry-After: the exponential curve.
 * - Retry-After 0 on a 429: the saturated-budget edge, at least `EDGE_BACKOFF_S`.
 * - Retry-After above `BACKOFF_CAP_S` on a 429: the ask plus `RETRY_AFTER_MARGIN_S`.
 * - Every ask is capped by the trust ceiling of its own arm.
 */
export function failureBackoffS(
  consecutiveFailures: number,
  retryAfterS: number | null,
  { rateLimited = true }: FailureBackoffOptions = {},
): number {
  const shift = Math.min(Math.max(0, consecutiveFailures - 1), BACKOFF_MAX_SHIFT);
  const computed = Math.min(BACKOFF_BASE_S * 2 ** shift, BACKOFF_CAP_S);
  if (retryAfterS === null) return computed;
  if (retryAfterS === 0) {
    // The saturated-budget edge was measured on 429s only. A non-429 "retry now" uses the plain curve.
    if (!rateLimited) return computed;
    return Math.min(Math.max(computed, EDGE_BACKOFF_S), BACKOFF_CAP_S);
  }
  let asked = retryAfterS;
  // A short ask is accurate (measured), so the margin applies only above BACKOFF_CAP_S.
  if (retryAfterS > BACKOFF_CAP_S && rateLimited) asked = retryAfterS + RETRY_AFTER_MARGIN_S;
  // The park bound applies to every ask, also Retry-After "inf" and non-429 errors.
  asked = Math.min(asked, rateLimited ? RETRY_AFTER_FLOOR_CAP_S : TRUST_MAX_AGE_S);
  return Math.max(asked, computed);
}

/**
 * The `cache/usage.json` table. Every write is a read-modify-write under
 * `cache/.usage.lock`. Reads take no lock, because writes are atomic replaces.
 *
 * Each method takes the `identities` map of the caller (slot number to
 * `[email, organizationUuid]`) and touches only the rows of those slots. A row with a
 * different stored identity is invisible to reads and replaced on write.
 */
export class UsageStore {
  readonly path: string;
  private readonly lockPath: string;
  clock: () => number;

  constructor(cacheDir: string, clock: () => number = () => internals.now()) {
    this.path = path.join(cacheDir, "usage.json");
    this.lockPath = path.join(cacheDir, ".usage.lock");
    this.clock = clock;
  }

  private lock(): FileLock {
    return new FileLock(this.lockPath);
  }

  private readRows(): Record<string, Row> {
    let raw: unknown;
    try {
      const bytes = fs.readFileSync(this.path);
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return {};
    }
    if (!isRecord(raw) || raw.schemaVersion !== SCHEMA_VERSION) return {};
    const rows = raw.accounts;
    return isRecord(rows) ? (rows as Record<string, Row>) : {};
  }

  private writeRows(rows: Record<string, Row>): void {
    atomicWriteJson(this.path, { schemaVersion: SCHEMA_VERSION, accounts: rows });
  }

  private static matches(row: unknown, identity: Identity): row is Row {
    return isRecord(row) && row.email === identity[0] && (row.organizationUuid === undefined ? "" : row.organizationUuid) === identity[1];
  }

  private freshRow(identity: Identity): Row {
    return { email: identity[0], organizationUuid: identity[1] };
  }

  /**
   * Identity-guarded snapshot for the given slots. A missing row, or a row of a
   * different account, gives an empty entry.
   *
   * `models` are the configured scoped-window model names. They let the 429 trust
   * bound use per-model window resets too.
   */
  entries(identities: Record<string, Identity>, models: readonly string[] = []): Record<string, UsageEntry> {
    const now = this.clock();
    const rows = this.readRows();
    const out: Record<string, UsageEntry> = {};
    for (const [num, identity] of Object.entries(identities)) {
      const row = own(rows, num);
      if (!UsageStore.matches(row, identity)) {
        out[num] = new UsageEntry();
        continue;
      }
      const fetchedAt = numOrNone(row.fetchedAt);
      const lastGood = isRecord(row.lastGood) ? (row.lastGood as UsageDict) : null;
      const ageS = fetchedAt !== null ? now - fetchedAt : null;
      const consecutiveFailures = pyInt(row.consecutiveFailures);
      const nextPollAt = numOrNone(row.nextPollAt);
      const lastAttemptAt = numOrNone(row.lastAttemptAt);
      const claimUntil = numOrNone(row.claimUntil);
      const heldUntil = numOrNone(row.heldUntil);
      // A 429 does not move the real windows, so its data stays trusted until the earliest reset.
      // Any other failure is no evidence that the data still holds.
      const withinCeiling =
        row.lastError === "http-429"
          ? rateLimitedTrustOk(lastGood, ageS, now, models)
          : ageS !== null && ageS <= TRUST_MAX_AGE_S;
      const held = heldUntil !== null && now < heldUntil;
      // Strict < mirrors dueCandidate. A live claim keeps the trust while the result of another collector is in flight.
      const trustExtended =
        withinCeiling &&
        (consecutiveFailures > 0 || (nextPollAt !== null && now < nextPollAt) || liveClaim(claimUntil, lastAttemptAt, now) || held);
      out[num] = new UsageEntry({
        lastGood,
        fetchedAt,
        ageS,
        lastAttemptAt,
        consecutiveFailures,
        lastError: (row.lastError ?? null) as string | null,
        backoffUntil: numOrNone(row.backoffUntil),
        nextPollAt,
        pollIntervalS: numOrNone(row.pollIntervalS),
        last429At: numOrNone(row.last429At),
        authDeadStrikes: pyInt(row.authDeadStrikes),
        struckFingerprint: (row.struckFingerprint ?? null) as string | null,
        rejectedFingerprint: (row.rejectedFingerprint ?? null) as string | null,
        trustExtended,
        claimUntil,
        heldUntil,
      });
    }
    return out;
  }

  /** Read-modify-write the rows of `nums` under the lock. A row with a different identity is replaced first. */
  private mutate(identities: Record<string, Identity>, nums: Iterable<string>, mutator: (num: string, row: Row) => void): void {
    this.lock().withLock(() => {
      const rows = this.readRows();
      for (const num of nums) {
        const identity = identityOf(identities, num);
        let row = own(rows, num);
        if (!UsageStore.matches(row, identity)) {
          row = this.freshRow(identity);
          rows[num] = row;
        }
        mutator(num, row);
      }
      this.writeRows(rows);
    });
  }

  /** Lease the slots that the caller is about to fetch. Return their fencing ids. */
  claim(nums: Iterable<string>, identities: Record<string, Identity>): Record<string, string> {
    const list = [...nums];
    if (list.length === 0) return {};
    const now = this.clock();
    const claims: Record<string, string> = {};
    for (const num of list) claims[num] = internals.claimId();
    this.mutate(identities, list, (num, row) => {
      row.lastAttemptAt = now;
      row.claimId = claims[num];
      row.claimUntil = now + CLAIM_TTL_S;
    });
    return claims;
  }

  /**
   * Win the right to fetch: check the eligibility again and stamp a bounded lease in
   * one locked pass. Return slot to fencing id.
   *
   * Eligible means not quarantined, not in backoff, not held, not claimed, and then:
   * - `respectPlans` true (on-demand callers): stale and poll-due (or no plan).
   *   With `repairOverslept`, an obsolete reset-parked plan is also due.
   * - `respectPlans` false (the auto engine): poll-due or stale. With
   *   `repairOverslept`, a valid future plan is not due.
   */
  reserve(
    nums: Iterable<string>,
    identities: Record<string, Identity>,
    { respectPlans, repairOverslept = false }: { respectPlans: boolean; repairOverslept?: boolean },
  ): Record<string, string> {
    const list = [...nums];
    if (list.length === 0) return {};
    const now = this.clock();
    const won: Record<string, string> = {};
    this.lock().withLock(() => {
      const rows = this.readRows();
      for (const num of list) {
        const identity = identityOf(identities, num);
        let row = own(rows, num);
        if (!UsageStore.matches(row, identity)) {
          row = this.freshRow(identity);
          rows[num] = row;
        } else if (!rowEligible(row, now, respectPlans, repairOverslept)) {
          continue;
        }
        const claimId = internals.claimId();
        row.lastAttemptAt = now;
        row.claimId = claimId;
        row.claimUntil = now + CLAIM_TTL_S;
        won[num] = claimId;
      }
      if (Object.keys(won).length > 0) this.writeRows(rows);
    });
    return won;
  }

  /**
   * Merge the outcomes, fenced by the leases that produced them. Return the accepted slots.
   *
   * - A late writer whose lease or slot identity changed is ignored.
   * - A success resets the failure fields. A failure never changes `lastGood` or `fetchedAt`.
   * - A success plan commits in the same transaction as its measurement.
   * - A sentinel clears only the claim, and keeps its `rejectedFp`.
   * - An unfenced caller (no `claims`) yields to a live lease, never to an expired one.
   */
  record(
    outcomes: Record<string, FetchRecord>,
    identities: Record<string, Identity>,
    claims: Record<string, string> | null = null,
    plans: Record<string, PollPlan> | null = null,
  ): Set<string> {
    const accepted = new Set<string>();
    const nums = Object.keys(outcomes);
    if (nums.length === 0) return accepted;
    const now = this.clock();

    const apply = (num: string, row: Row): void => {
      accepted.add(num);
      const rec = outcomes[num]!;
      row.claimId = null;
      row.claimUntil = 0.0;
      if (rec.sentinel != null) {
        if (rec.rejectedFp != null) row.rejectedFingerprint = rec.rejectedFp;
        return;
      }
      row.lastAttemptAt = now;
      if (rec.error == null) {
        row.lastGood = rec.usage ?? null;
        row.fetchedAt = now;
        // Replace the old plan in the same transaction, so no collector can use a gap between record and replan.
        const plan = plans !== null ? own(plans, num) : undefined;
        if (plan != null) [row.nextPollAt, row.pollIntervalS] = plan;
        row.consecutiveFailures = 0;
        row.lastError = null;
        row.backoffUntil = null;
        row.rejectedFingerprint = null;
        row.authDeadStrikes = 0;
      } else {
        const failures = pyInt(row.consecutiveFailures) + 1;
        row.consecutiveFailures = failures;
        row.lastError = rec.error;
        if (rec.error === "http-429") row.last429At = now;
        row.backoffUntil = now + failureBackoffS(failures, rec.retryAfterS ?? null, { rateLimited: rec.error === "http-429" });
        // A transient error is no evidence either way, so it must not change the strike count.
        if (PERMANENT_AUTH_ERRORS.has(rec.error)) {
          row.authDeadStrikes = pyInt(row.authDeadStrikes) + 1;
          // Always overwrite: a legacy strike must not keep the fingerprint of an earlier strike.
          row.struckFingerprint = rec.struckFp ?? null;
        }
      }
    };

    this.lock().withLock(() => {
      const rows = this.readRows();
      for (const num of nums) {
        const identity = identityOf(identities, num);
        let row = own(rows, num);
        if (claims !== null) {
          const expected = own(claims, num);
          if (expected === undefined || !UsageStore.matches(row, identity) || row.claimId !== expected) continue;
        } else if (
          isRecord(row) &&
          row.claimId != null &&
          // Only a live lease stops an unfenced writer. The ticket of a crashed claimer must expire.
          now < (numOrNone(row.claimUntil) ?? 0.0)
        ) {
          continue;
        } else if (!UsageStore.matches(row, identity)) {
          row = this.freshRow(identity);
          rows[num] = row;
        }
        apply(num, row as Row);
      }
      if (accepted.size > 0) this.writeRows(rows);
    });
    return accepted;
  }

  /**
   * Merge measurements that another machine took for the same accounts.
   *
   * `readings` maps slot to `[usage, ageS]`. The age, not a timestamp, means that the
   * two clocks do not have to agree: `fetchedAt` becomes `now - ageS` on this clock.
   * A reading replaces `lastGood` only if it is newer. Fetch state stays as it is.
   *
   * `holdS` > 0 stamps `heldUntil`: no collector fetches the slot before then. The hold
   * never goes past the earliest window reset of the kept reading, or past
   * `TRUST_MAX_AGE_S` from that reading. `holdS` 0 lifts a hold. `null` keeps it.
   * Return the slots whose `lastGood` was replaced.
   */
  adopt(
    readings: Record<string, readonly [UsageDict, number]>,
    identities: Record<string, Identity>,
    holdS: number | null = null,
  ): Set<string> {
    const adopted = new Set<string>();
    const nums = Object.keys(readings);
    if (nums.length === 0) return adopted;
    const now = this.clock();

    const apply = (num: string, row: Row): void => {
      const [usage, ageS] = readings[num]!;
      const fetchedAt = now - Math.max(0.0, ageS);
      let stored = numOrNone(row.fetchedAt);
      if (stored === null || fetchedAt > stored) {
        row.lastGood = usage;
        row.fetchedAt = fetchedAt;
        stored = fetchedAt;
        adopted.add(num);
      }
      if (holdS === null) return;
      let heldUntil = Math.min(now + holdS, stored + TRUST_MAX_AGE_S);
      // Every scoped window counts: the store does not know which models this machine watches.
      const resetAt = earliestReset(row.lastGood, ["all"]);
      if (resetAt !== null) heldUntil = Math.min(heldUntil, resetAt);
      if (heldUntil > now) row.heldUntil = heldUntil;
      else delete row.heldUntil;
    };

    this.mutate(identities, nums, apply);
    return adopted;
  }

  /** Persist the `[nextPollAt, pollIntervalS]` plan of the scheduler for each slot. */
  setPollPlan(plans: Record<string, PollPlan>, identities: Record<string, Identity>): void {
    const nums = Object.keys(plans);
    if (nums.length === 0) return;
    this.mutate(identities, nums, (num, row) => {
      const [nextPollAt, interval] = plans[num]!;
      row.nextPollAt = nextPollAt;
      row.pollIntervalS = interval;
    });
  }

  /**
   * Lift the dead-token quarantine of slots whose credential a re-login or add changed.
   * The slots become fetch-eligible again, so the next pass can prove the new token.
   */
  clearDeadToken(nums: Iterable<string>, identities: Record<string, Identity>): void {
    const list = [...nums];
    if (list.length === 0) return;
    this.mutate(identities, list, (_num, row) => {
      row.claimId = null;
      row.claimUntil = 0.0;
      row.authDeadStrikes = 0;
      row.struckFingerprint = null;
      row.consecutiveFailures = 0;
      row.lastError = null;
      row.backoffUntil = null;
    });
  }
}

/** Fetch eligibility of a stored row, under the write lock. See `UsageStore.reserve` for the two modes. */
function rowEligible(row: Row, now: number, respectPlans: boolean, repairOverslept = false): boolean {
  if (pyInt(row.authDeadStrikes) >= AUTH_DEAD_STRIKES) return false;
  const backoffUntil = numOrNone(row.backoffUntil);
  if (backoffUntil !== null && now < backoffUntil) return false;
  const heldUntil = numOrNone(row.heldUntil);
  if (heldUntil !== null && now < heldUntil) return false;
  if (liveClaim(numOrNone(row.claimUntil), numOrNone(row.lastAttemptAt), now)) return false;
  const fetchedAt = numOrNone(row.fetchedAt);
  const stale = fetchedAt === null || now - fetchedAt > SERVE_TTL_S;
  const nextPollAt = numOrNone(row.nextPollAt);
  const pollDue = nextPollAt !== null && now >= nextPollAt;
  const overslept = repairOverslept && planOversleepsIntervalRaw(nextPollAt, numOrNone(row.pollIntervalS), now);
  if (respectPlans) return stale && (pollDue || nextPollAt === null || overslept);
  if (repairOverslept) return pollDue || (stale && (nextPollAt === null || overslept));
  return pollDue || stale;
}

/** Overlay a derived sentinel state on a stored entry. This changes only the read model. */
export function withSentinel(entry: UsageEntry, sentinel: string | null): UsageEntry {
  if (sentinel === null) return entry;
  return new UsageEntry({ ...entry, sentinel });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function identityOf(identities: Record<string, Identity>, num: string): Identity {
  const identity = own(identities, num);
  if (identity === undefined) throw new RangeError(`no identity for slot ${num}`);
  return identity;
}

/** Python `isinstance(value, (int, float))`, where a bool is an int. */
function numOrNone(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  return null;
}

/** Python `int(value or 0)`. */
function pyInt(value: unknown): number {
  if (!value) return 0;
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "boolean") return 1;
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  throw new RangeError(`invalid literal for int(): ${JSON.stringify(value)}`);
}
