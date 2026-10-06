/**
 * Serialization helpers for the `--json` output (schema v1).
 * Callers build payloads here. The CLI does the single `json.dumps`.
 */
import {
  formatReset,
  freshResetStrings,
  type ScopedWindow,
  type SpendWindow,
  type UsageDict,
  type UsageWindow,
} from "./oauth.js";
import * as pace from "./pace.js";
import { isoformat } from "./support/py.js";

/** Increase only for a change that breaks a payload shape. Scripts read this value. */
export const SCHEMA_VERSION = 1;

/** Sentinel entries that the usage collectors give in place of a usage dict. */
export const USAGE_NO_CREDENTIALS = "no credentials";
export const USAGE_TOKEN_EXPIRED = "token expired";
/** A managed API-key account has no subscription quota. */
export const USAGE_API_KEY = "api key";
/** The macOS Keychain of the active account is not readable and there is no plaintext fallback. */
export const USAGE_KEYCHAIN_UNAVAILABLE = "keychain unavailable";
/** The refresh-token lineage is dead. Only a new login can repair it. */
export const USAGE_RELOGIN_REQUIRED = "re-login needed";
/** The live credential belongs to a different account. A switch repairs the drift. */
export const USAGE_FOREIGN_CREDENTIAL = "foreign credential";

/** A collected usage entry: a usage dict, a sentinel string, or null when the fetch failed. */
export type UsageEntry = UsageDict | string | null | undefined;

type JsonObject = Record<string, unknown>;

function windowToJson(entry: UsageWindow): JsonObject {
  const out: JsonObject = { pct: entry.pct };
  if ("resets_at" in entry) out.resetsAt = entry.resets_at;
  const cell = freshResetStrings(entry);
  if (cell) [out.countdown, out.clock] = cell;
  return out;
}

function paceFields(entry: UsageWindow, fetchedAt: number | null | undefined): JsonObject {
  if (fetchedAt == null) return {};
  const result = pace.computePace(entry, { fetchedAt });
  if (result == null) return {};
  const out: JsonObject = {
    expectedPct: round1(result.expectedPct),
    aheadOfPace: result.ahead,
  };
  const eta = pace.projectedExhaustionTs(result, { fetchedAt });
  if (eta != null) out.projectedExhaustionAt = timestamp(eta);
  const willLast = pace.willLastToReset(result);
  if (willLast != null) out.willLastToReset = willLast;
  return out;
}

function weeklyWindowToJson(entry: UsageWindow, fetchedAt: number | null | undefined): JsonObject {
  return { ...windowToJson(entry), ...paceFields(entry, fetchedAt) };
}

function scopedWindowToJson(entry: ScopedWindow, fetchedAt: number | null | undefined): JsonObject {
  const out = weeklyWindowToJson(entry, fetchedAt);
  out.name = entry.name;
  return out;
}

/**
 * Convert the internal usage dict to its camelCase JSON projection.
 * A sub-key is present only if the source has it. If `fetchedAt` is given,
 * the weekly windows (`seven_day`, `scoped`) get pace fields. `five_hour` never gets them.
 */
export function usageToJson(usage: UsageDict, fetchedAt?: number | null): JsonObject {
  const out: JsonObject = {};
  if (usage.five_hour !== undefined) out.fiveHour = windowToJson(usage.five_hour);
  if (usage.seven_day !== undefined) out.sevenDay = weeklyWindowToJson(usage.seven_day, fetchedAt);
  if (usage.spend !== undefined) {
    const spend = usage.spend;
    const spendOut: JsonObject = {
      used: spend.used,
      limit: spend.limit,
      pct: spend.pct,
      currency: spend.currency,
    };
    if ("resets_at" in spend) spendOut.resetsAt = spend.resets_at;
    const cell = freshResetStrings(spend);
    if (cell) [spendOut.countdown, spendOut.clock] = cell;
    out.spend = spendOut;
  }
  if (usage.scoped !== undefined) out.scoped = usage.scoped.map((w) => scopedWindowToJson(w, fetchedAt));
  return out;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function windowFromJson(window: unknown, label: string): UsageWindow {
  if (!isObject(window)) throw new RangeError(`${label} must be an object`);
  const pct = window.pct;
  if (!isNumber(pct) || pct < 0) throw new RangeError(`${label}.pct must be a non-negative number`);
  const out: UsageWindow = { pct };
  const resetsAt = window.resetsAt;
  if (resetsAt != null) {
    if (typeof resetsAt !== "string") throw new RangeError(`${label}.resetsAt must be an ISO-8601 string`);
    try {
      [out.countdown, out.clock] = formatReset(resetsAt);
    } catch (e) {
      if (e instanceof RangeError || e instanceof TypeError) {
        throw new RangeError(`${label}.resetsAt is not an ISO-8601 time: '${resetsAt}'`);
      }
      throw e;
    }
    out.resets_at = resetsAt;
  }
  return out;
}

/**
 * Read a `usage` object from `list --json` back into the internal dict.
 * The derived fields (countdown, clock, pace) are not read. Countdown and clock come again from `resets_at`.
 * Throws `RangeError` (Python `ValueError`) on malformed data, so that an importer can refuse
 * a document before it writes a part of it.
 */
export function usageFromJson(usage: unknown): UsageDict {
  if (!isObject(usage)) throw new RangeError("usage must be an object");
  const out: UsageDict = {};
  if ("fiveHour" in usage) out.five_hour = windowFromJson(usage.fiveHour, "fiveHour");
  if ("sevenDay" in usage) out.seven_day = windowFromJson(usage.sevenDay, "sevenDay");
  if ("spend" in usage) {
    const spend = usage.spend;
    const window = windowFromJson(spend, "spend");
    const source = spend as JsonObject;
    for (const key of ["used", "limit"] as const) {
      if (!isNumber(source[key])) throw new RangeError(`spend.${key} must be a number`);
    }
    if (typeof source.currency !== "string") throw new RangeError("spend.currency must be a string");
    const outSpend: SpendWindow = {
      ...window,
      used: source.used as number,
      limit: source.limit as number,
      currency: source.currency,
    };
    out.spend = outSpend;
  }
  if ("scoped" in usage) {
    if (!Array.isArray(usage.scoped)) throw new RangeError("scoped must be a list");
    out.scoped = (usage.scoped as unknown[]).map((window, i) => {
      const label = `scoped[${i}]`;
      const entry = windowFromJson(window, label);
      const name = (window as JsonObject).name;
      if (typeof name !== "string" || !name) throw new RangeError(`${label}.name must be a non-empty string`);
      return { name, ...entry };
    });
  }
  if (Object.keys(out).length === 0) throw new RangeError("usage carries no windows");
  return out;
}

/**
 * Map a collected usage entry to `[usageStatus, usage | null]`.
 * `fetchedAt` goes to `usageToJson` for the weekly pace fields.
 */
export function usageFields(entry: UsageEntry, fetchedAt?: number | null): [string, JsonObject | null] {
  if (isObject(entry)) return ["ok", usageToJson(entry as UsageDict, fetchedAt)];
  if (entry === USAGE_TOKEN_EXPIRED) return ["token_expired", null];
  if (entry === USAGE_API_KEY) return ["api_key", null];
  if (entry === USAGE_KEYCHAIN_UNAVAILABLE) return ["keychain_unavailable", null];
  if (entry === USAGE_RELOGIN_REQUIRED) return ["relogin_required", null];
  if (entry === USAGE_FOREIGN_CREDENTIAL) return ["foreign_credential", null];
  if (typeof entry === "string") return ["no_credentials", null];
  return ["unavailable", null];
}

/** A minimal account reference, for the switch `from` and `to`. */
export function accountRef(number: number | null, email: string): { number: number | null; email: string } {
  return { number, email };
}

/**
 * `usageFetchedAt` and `usageAgeSeconds`: the age of the served `usage` measurement.
 * Only a row with a `usage` that is not null gets them.
 */
export function usageFreshnessFields(fetchedAt: number | null | undefined, ageS: number | null | undefined): JsonObject {
  if (fetchedAt == null) return {};
  const fields: JsonObject = { usageFetchedAt: timestamp(fetchedAt) };
  if (ageS != null) fields.usageAgeSeconds = round1(ageS);
  return fields;
}

function timestamp(epochS: number): string {
  return isoformat(new Date(epochS * 1000), { timespec: "seconds" }).replace("+00:00", "Z");
}

/** Python `round(x, 1)` rounds half to even. This rounds half up. The difference is not visible in practice. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * `usageError` and `usageRetryAt` for an `unavailable` row: the kind of the last fetch failure,
 * and the time of the next attempt while the store backs off. Other statuses get no fields.
 */
export function usageFailureFields(
  status: string,
  lastError: string | null | undefined,
  backoffUntil: number | null | undefined,
): JsonObject {
  if (status !== "unavailable" || !lastError) return {};
  const out: JsonObject = { usageError: lastError };
  if (backoffUntil != null) out.usageRetryAt = timestamp(backoffUntil);
  return out;
}

/** Display-grade last-good usage, separate from the decision-grade `usage`. */
export function lastGoodUsageFields(
  usage: UsageDict | null | undefined,
  fetchedAt: number | null | undefined,
  ageS: number | null | undefined,
): JsonObject {
  if (!isObject(usage) || fetchedAt == null) return {};
  const freshness = usageFreshnessFields(fetchedAt, ageS);
  const out: JsonObject = {
    lastGoodUsage: usageToJson(usage, fetchedAt),
    lastGoodFetchedAt: freshness.usageFetchedAt,
  };
  if ("usageAgeSeconds" in freshness) out.lastGoodAgeSeconds = freshness.usageAgeSeconds;
  return out;
}

export interface AccountRowOptions {
  usageFetchedAt?: number | null;
  usageAgeS?: number | null;
  lastGoodUsage?: UsageDict | null;
  lastError?: string | null;
  /** The live backoff only. The caller must not give a backoff that is in the past. */
  backoffUntil?: number | null;
  alias?: string;
  disabled?: boolean;
  loginExpiresAt?: string | null;
}

/** A full account row for `--list`. */
export function accountRow(
  number: number,
  email: string,
  orgName: string,
  orgUuid: string,
  active: boolean,
  usageEntry: UsageEntry,
  {
    usageFetchedAt = null,
    usageAgeS = null,
    lastGoodUsage = null,
    lastError = null,
    backoffUntil = null,
    alias = "",
    disabled = false,
    loginExpiresAt = null,
  }: AccountRowOptions = {},
): JsonObject {
  const [status, usage] = usageFields(usageEntry, usageFetchedAt);
  const row: JsonObject = {
    number,
    email,
    organizationName: orgName,
    organizationUuid: orgUuid,
    isOrganization: Boolean(orgUuid),
    active,
    usageStatus: status,
    usage,
  };
  if (alias) row.alias = alias;
  if (disabled) row.disabled = true;
  if (loginExpiresAt) row.loginExpiresAt = loginExpiresAt;
  if (usage !== null) {
    Object.assign(row, usageFreshnessFields(usageFetchedAt, usageAgeS));
  } else {
    Object.assign(row, lastGoodUsageFields(lastGoodUsage, usageFetchedAt, usageAgeS));
    Object.assign(row, usageFailureFields(status, lastError, backoffUntil));
  }
  return row;
}

/** The structured error payload for a handled `ClaudeSwitchError`. */
export function errorEnvelope(exc: Error): { schemaVersion: number; error: { type: string; message: string } } {
  return {
    schemaVersion: SCHEMA_VERSION,
    error: { type: exc.name, message: exc.message },
  };
}
