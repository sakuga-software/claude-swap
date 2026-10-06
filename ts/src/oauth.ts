/** OAuth token management and usage API for Claude Code accounts. */

import { createHash } from "node:crypto";
import { getLogger } from "./logging_config.js";
import { warning as printWarning } from "./printer.js";
import { fromisoformat, isoformat, jsonDumps } from "./support/py.js";

export const OAUTH_BETA_HEADER = "oauth-2025-04-20";
export const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USER_AGENT = "claude-swap/1.0";

const logger = getLogger("claude-swap");

/** One usage window, as `build_usage_result` stores it. */
export interface UsageWindow {
  pct: number;
  resets_at?: string | null;
  countdown?: string;
  clock?: string;
}

/** The pay-as-you-go extra-usage window. */
export interface SpendWindow extends UsageWindow {
  used: number;
  limit: number;
  currency: string;
}

/** A per-model weekly window. */
export interface ScopedWindow extends UsageWindow {
  name: string;
}

/** The internal usage dict that `build_usage_result` returns and the usage store keeps. */
export interface UsageDict {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  spend?: SpendWindow;
  scoped?: ScopedWindow[];
}

/** One `[label, pct, resetsAt]` window that gates an account. */
export type RelevantWindow = [label: string, pct: number, resetsAt: string | null];

/** The account identity of an OAuth token. The keys are the keys that the store writes to disk. */
export interface AccountIdentity {
  uuid: string;
  email: string | null;
  organizationUuid: string | null;
}

/**
 * The result of a refresh-token grant.
 *
 * `error` is one of:
 * - `null`: success, and `credentials` holds the rotated credentials JSON.
 * - `"invalid_grant"`: the server rejected the grant. The refresh token is dead.
 * - `"invalid_client"`: the server rejected the client ID. This is systemic, not about one account.
 * - `"no_refresh_token"`: the credential has no refresh token.
 * - `"transient"`: a network or server error. The token can still be valid.
 * - Other kinds that the consume gate of the switcher adds.
 *
 * `tokenAccount` is the identity that the token endpoint can send with a grant. It is optional.
 * `consumedFp` is the fingerprint of the credential that the consume gate sent.
 * `stashed` is true if the consume gate wrote the successor credential to the stash.
 */
export interface RefreshOutcome {
  credentials: string | null;
  error: string | null;
  tokenAccount: AccountIdentity | null;
  consumedFp: string | null;
  stashed: boolean;
}

/** Make a `RefreshOutcome`, like the Python dataclass constructor. */
export function refreshOutcome(
  credentials: string | null,
  error: string | null,
  extra: Partial<Pick<RefreshOutcome, "tokenAccount" | "consumedFp" | "stashed">> = {},
): RefreshOutcome {
  return {
    credentials,
    error,
    tokenAccount: extra.tokenAccount ?? null,
    consumedFp: extra.consumedFp ?? null,
    stashed: extra.stashed ?? false,
  };
}

/**
 * The result of a usage fetch.
 *
 * `usage` can be null on success if the response has no window data.
 * `error` is null on success, else a `classifyUsageError` kind or a refresh kind.
 * `retryAfterS` is the Retry-After value of the server.
 * `struckFp` is the fingerprint of the credential that a permanent auth error applies to.
 */
export interface UsageOutcome {
  usage: UsageDict | null;
  error: string | null;
  retryAfterS: number | null;
  struckFp: string | null;
}

/** Make a `UsageOutcome`, like the Python dataclass constructor. */
export function usageOutcome(
  usage: UsageDict | null,
  extra: Partial<Pick<UsageOutcome, "error" | "retryAfterS" | "struckFp">> = {},
): UsageOutcome {
  return { usage, error: extra.error ?? null, retryAfterS: extra.retryAfterS ?? null, struckFp: extra.struckFp ?? null };
}

export type PersistCredentials = (accountNum: string, email: string, credentials: string) => void;
export type RefreshVia = (
  accountNum: string,
  email: string,
  credentials: string,
) => RefreshOutcome | Promise<RefreshOutcome>;

/** The server answered with a status outside 2xx. The equivalent of `urllib.error.HTTPError`. */
export class HTTPError extends Error {
  override name = "HTTPError";

  constructor(
    readonly url: string,
    readonly code: number,
    readonly msg: string,
    readonly headers: Headers | null = null,
    readonly body = "",
  ) {
    super(`HTTP Error ${code}: ${msg}`);
  }
}

/** The request did not get a response. The equivalent of `urllib.error.URLError`. */
export class URLError extends Error {
  override name = "URLError";

  constructor(readonly reason: unknown) {
    super(`<urlopen error ${reason instanceof Error ? reason.message || reason.name : String(reason)}>`);
  }
}

/** Seams for the tests. The exported functions call through this object. */
export const internals = {
  fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
  fetchOauthProfile: fetchOauthProfileImpl,
  tryRefreshOauthCredentials: tryRefreshOauthCredentialsImpl,
  refreshOauthCredentials: refreshOauthCredentialsImpl,
  requestUsageData: requestUsageDataImpl,
};

/** The original `internals`. Tests restore them with `Object.assign(internals, realImplementations)`. */
export const realImplementations = Object.freeze({ ...internals });

/** Extract the OAuth access token from a credentials JSON string. */
export function extractAccessToken(credentials: string): string | null {
  const token = extractOauthData(credentials)?.accessToken;
  return typeof token === "string" ? token : null;
}

/** Extract the Claude AI OAuth payload from a credentials JSON string. */
export function extractOauthData(credentials: string): Record<string, unknown> | null {
  const data = parseJson(credentials);
  if (!isRecord(data)) return null;
  const oauth = data.claudeAiOauth;
  return isRecord(oauth) ? oauth : null;
}

/**
 * A stable identity fingerprint for a stored credential.
 *
 * It is the hash of the refresh token if there is one, so that two generations of one OAuth lineage compare equal.
 * Else it is the hash of the full content. It is null only for an empty input.
 */
export function credentialFingerprint(credentials: string): string | null {
  if (!credentials) return null;
  const token = extractOauthData(credentials)?.refreshToken;
  if (typeof token === "string" && token) return `sha256:${sha256(token)}`;
  return `sha256-full:${sha256(credentials)}`;
}

/** The hash of the access token alone. A refused token and its replacement compare unequal. */
export function accessTokenFingerprint(credentials: string): string | null {
  const token = extractOauthData(credentials)?.accessToken;
  if (typeof token !== "string" || !token) return null;
  return `sha256-at:${sha256(token)}`;
}

/**
 * The time when the stored login lapses (`refreshTokenExpiresAt`), as ISO-8601 UTC, or null.
 * A login from before Claude Code recorded the field gives null, which means "unknown".
 */
export function loginExpiresAtIso(credentials: string): string | null {
  const value = extractOauthData(credentials)?.refreshTokenExpiresAt;
  if (typeof value !== "number" || !(value > 0)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`timestamp out of range: ${value}`);
  return isoformat(date, { timespec: "seconds" }).replace("+00:00", "Z");
}

/** Return whether an OAuth token is expired or expires in less than `OAUTH_EXPIRY_BUFFER_MS`. */
export function isOauthTokenExpired(expiresAt: unknown): boolean {
  if (typeof expiresAt === "boolean") expiresAt = Number(expiresAt);
  if (typeof expiresAt !== "number") return false;
  return Date.now() + OAUTH_EXPIRY_BUFFER_MS >= Math.trunc(expiresAt);
}

/**
 * Refresh an OAuth access token with a POST to the token endpoint.
 * If the caller holds a lock that other processes wait for, `timeoutS` must stay inside their acquire timeout.
 */
export function tryRefreshOauthCredentials(credentials: string, timeoutS = 10.0): Promise<RefreshOutcome> {
  return internals.tryRefreshOauthCredentials(credentials, timeoutS);
}

async function tryRefreshOauthCredentialsImpl(credentials: string, timeoutS = 10.0): Promise<RefreshOutcome> {
  // `no_refresh_token` is permanent. An unparseable blob is more likely a torn read, so it is transient.
  let data: unknown;
  try {
    data = JSON.parse(credentials);
  } catch {
    return refreshOutcome(null, "transient");
  }
  if (!isRecord(data)) return refreshOutcome(null, "transient");
  const oauth = data.claudeAiOauth;
  if (!isRecord(oauth) || !oauth.refreshToken) return refreshOutcome(null, "no_refresh_token");

  try {
    const body = jsonDumps({ grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID });
    const text = await urlopen(
      OAUTH_TOKEN_URL,
      { method: "POST", body, headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT } },
      timeoutS,
    );
    const respData: unknown = JSON.parse(text);

    const accessToken = requireKey(respData, "access_token");
    const expiresIn = requireKey(respData, "expires_in");
    if (typeof expiresIn !== "number") throw new TypeError("expires_in is not a number");
    const resp = respData as Record<string, unknown>;
    oauth.accessToken = accessToken;
    oauth.expiresAt = Date.now() + expiresIn * 1000;
    if (resp.refresh_token) oauth.refreshToken = resp.refresh_token;
    if (resp.scope) {
      if (typeof resp.scope !== "string") throw new TypeError("scope is not a string");
      oauth.scopes = resp.scope.split(/\s+/).filter(Boolean);
    }
    data.claudeAiOauth = oauth;
    return refreshOutcome(jsonDumps(data), null, { tokenAccount: parseTokenAccount(resp) });
  } catch (e) {
    if (e instanceof HTTPError) {
      logger.debug("OAuth refresh failed: %s, body: %s", pyRepr(e), e.body.slice(0, 500));
      // Permanent only if the server rejected the grant: a 4xx and an RFC 6749 §5.2 top-level `error`.
      // A wrong "transient" costs one retry. A wrong "permanent" quarantines a live token.
      if (e.code === 400 || e.code === 401 || e.code === 403) {
        const parsed = parseJson(e.body);
        const err = isRecord(parsed) ? parsed.error : undefined;
        if (err === "invalid_grant" || err === "invalid_client") return refreshOutcome(null, err);
      }
      return refreshOutcome(null, "transient");
    }
    logger.debug("OAuth refresh failed: %s", pyRepr(e));
    return refreshOutcome(null, "transient");
  }
}

/**
 * Extract the optional account identity from a token-endpoint response.
 * The identity needs a non-empty string `account.uuid`. Malformed data gives null.
 */
export function parseTokenAccount(respData: Record<string, unknown>): AccountIdentity | null {
  const account = respData.account;
  if (!isRecord(account)) return null;
  const uuid = account.uuid;
  if (typeof uuid !== "string" || !uuid.trim()) return null;
  const email = account.email_address;
  const organization = respData.organization;
  const orgUuid = isRecord(organization) ? organization.uuid : undefined;
  return {
    uuid: uuid.trim(),
    email: typeof email === "string" ? email : null,
    organizationUuid: typeof orgUuid === "string" ? orgUuid : null,
  };
}

/** Refresh an OAuth access token. Null on any failure (see `RefreshOutcome`). */
export function refreshOauthCredentials(credentials: string): Promise<string | null> {
  return internals.refreshOauthCredentials(credentials);
}

async function refreshOauthCredentialsImpl(credentials: string): Promise<string | null> {
  return (await tryRefreshOauthCredentials(credentials)).credentials;
}

/**
 * Get the account identity of an OAuth access token with `GET /api/oauth/profile`, or null on any failure.
 *
 * The result counts as resolved only with a non-empty string `account.uuid`.
 * `email` and `organizationUuid` are optional.
 * Do not call this function while you hold a credential or config lock.
 */
export function fetchOauthProfile(accessToken: string): Promise<AccountIdentity | null> {
  return internals.fetchOauthProfile(accessToken);
}

async function fetchOauthProfileImpl(accessToken: string): Promise<AccountIdentity | null> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  let data: unknown;
  try {
    data = JSON.parse(await urlopen(OAUTH_PROFILE_URL, { headers }, 5));
  } catch (e) {
    if (e instanceof HTTPError && e.code === 401) {
      // A 401 is evidence, not proof. It goes to the log file only, and the caller continues without identity.
      logger.warning(
        "OAuth profile returned 401 while resolving credential ownership; proceeding without identity (pre-fix behavior).",
      );
    } else {
      logger.debug("OAuth profile fetch failed: %s", pyRepr(e));
    }
    return null;
  }
  const account = isRecord(data) ? data.account : undefined;
  if (!isRecord(account)) {
    logger.debug("OAuth profile response missing account object");
    return null;
  }
  const uuid = account.uuid;
  if (typeof uuid !== "string" || !uuid.trim()) {
    logger.debug("OAuth profile response missing account.uuid");
    return null;
  }
  const email = account.email;
  const organization = (data as Record<string, unknown>).organization;
  const orgUuid = isRecord(organization) ? organization.uuid : undefined;
  return {
    uuid: uuid.trim(),
    email: typeof email === "string" ? email : null,
    organizationUuid: typeof orgUuid === "string" ? orgUuid : null,
  };
}

/** A short debug summary of the stored OAuth token state. */
export function buildTokenStatus(credentials: string): string | null {
  const oauth = extractOauthData(credentials);
  if (!oauth) return null;

  const refreshStr = oauth.refreshToken ? "yes" : "no";
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt !== "number") return `oauth: unknown expiry, refresh token ${refreshStr}`;

  const state = isOauthTokenExpired(expiresAt) ? "expired" : "fresh";
  const [countdown, clock] = formatReset(isoformat(new Date(expiresAt)));
  return `oauth: ${state}, refresh token ${refreshStr}, expires ${clock} in ${countdown}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Return `[countdown, clock]` for a reset time in local time. */
export function formatReset(resetsAt: string): [string, string] {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(resetsAt.trim())) {
    // Python subtracts a naive datetime from an aware one, which raises TypeError.
    throw new TypeError(`can't compare offset-naive and offset-aware datetimes: '${resetsAt}'`);
  }
  const resetUtc = fromisoformat(resetsAt);
  const now = new Date();
  const totalSeconds = Math.max(0, Math.trunc((resetUtc.getTime() - now.getTime()) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  let countdown: string;
  if (days > 0) countdown = `${days}d ${hours}h`;
  else if (hours > 0) countdown = `${hours}h ${minutes}m`;
  else countdown = `${minutes}m`;

  return [countdown, resetClockString(resetUtc, now)];
}

/** Absolute reset time in local time: "20:39" on the same day, else "Jul 5 08:59". */
export function resetClockString(resetUtc: Date, nowUtc: Date): string {
  const time = `${pad(resetUtc.getHours())}:${pad(resetUtc.getMinutes())}`;
  const sameDay =
    resetUtc.getFullYear() === nowUtc.getFullYear() &&
    resetUtc.getMonth() === nowUtc.getMonth() &&
    resetUtc.getDate() === nowUtc.getDate();
  if (sameDay) return time;
  return `${MONTHS[resetUtc.getMonth()]} ${resetUtc.getDate()} ${time}`;
}

/**
 * `[countdown, clock]` for one usage window, or null when unknown.
 * The strings come from `resets_at` at render time, because the strings of the fetch time become old.
 * A window without `resets_at` falls back to the strings of the fetch time.
 */
export function freshResetStrings(window: UsageWindow): [string, string] | null {
  const resetsAt = window.resets_at;
  if (resetsAt) {
    try {
      return formatReset(resetsAt);
    } catch (e) {
      if (!(e instanceof RangeError || e instanceof TypeError)) throw e;
    }
  }
  if ("clock" in window) return [window.countdown ?? "?", window.clock as string];
  return null;
}

/** Request raw utilization data from the Anthropic usage API. */
export function requestUsageData(accessToken: string): Promise<unknown> {
  return internals.requestUsageData(accessToken);
}

async function requestUsageDataImpl(accessToken: string): Promise<unknown> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": OAUTH_BETA_HEADER,
    "User-Agent": USER_AGENT,
  };
  return JSON.parse(await urlopen(OAUTH_USAGE_URL, { headers }, 5));
}

/**
 * Map a usage-fetch error to `[kind, retryAfterS]`.
 *
 * `kind` is `"http-<code>"`, `"timeout"`, `"network"`, `"bad-response"`, or the error name.
 * `retryAfterS` is the `Retry-After` header in its seconds form. The HTTP-date form gives null.
 */
export function classifyUsageError(e: unknown): [string, number | null] {
  if (e instanceof HTTPError) {
    let retryAfter: number | null = null;
    const raw = e.headers?.get("Retry-After");
    if (raw) {
      const value = parsePyFloat(raw.trim());
      if (value !== null) retryAfter = value > 0 ? value : 0.0;
    }
    return [`http-${e.code}`, retryAfter];
  }
  if (isTimeoutError(e)) return ["timeout", null];
  if (e instanceof URLError) return [isTimeoutError(e.reason) ? "timeout" : "network", null];
  if (e instanceof SyntaxError) return ["bad-response", null];
  if (e instanceof Error) return [e.name, null];
  return [typeof e, null];
}

/**
 * Log one WARNING line with the cause, and the full error at DEBUG.
 * Users paste the line into public issues, so `context` must not contain the email.
 */
export function logUsageFailure(context: string, e: unknown, kind: string, retryAfterS: number | null = null): void {
  const where = context ? ` ${context}` : "";
  let cause = retryAfterS === null ? kind : `${kind}, retry-after ${retryAfterS.toFixed(0)}s`;
  if (kind === "http-429") {
    // The budget can be per token or per account, so the message does not name a scope.
    cause += " (usage-endpoint budget reached; backing off)";
  }
  logger.warning("Usage fetch failed%s: %s", where, cause);
  logger.debug("Usage fetch failure detail%s: %s", where, pyRepr(e));
}

/** Normalize raw usage API data into the structure that the CLI uses. */
export function buildUsageResult(data: unknown): UsageDict | null {
  logger.debug("Usage API response: %s", jsonDumps(data ?? null, 2));
  if (!isRecord(data)) throw new TypeError("usage response is not an object");

  const result: UsageDict = {};

  for (const key of ["five_hour", "seven_day"] as const) {
    const raw = data[key];
    if (!raw) continue;
    const entry: UsageWindow = { pct: requireKey(raw, "utilization") as number };
    const resetsAt = (raw as Record<string, unknown>).resets_at;
    if (resetsAt) {
      entry.resets_at = resetsAt as string;
      [entry.countdown, entry.clock] = formatReset(resetsAt as string);
    }
    result[key] = entry;
  }

  const eu = data.extra_usage;
  if (isRecord(eu) && eu.is_enabled) {
    // A null field (monthly_limit null means unlimited) drops the spend entry only.
    const { used_credits: usedCredits, monthly_limit: monthlyLimit, utilization } = eu;
    if (isPresent(usedCredits) && isPresent(monthlyLimit) && isPresent(utilization)) {
      try {
        const spend: SpendWindow = {
          used: pyFloat(usedCredits) / 100,
          limit: pyFloat(monthlyLimit) / 100,
          pct: pyFloat(utilization),
          currency: (eu.currency ?? "USD") as string,
        };
        if (eu.resets_at) {
          spend.resets_at = eu.resets_at as string;
          [spend.countdown, spend.clock] = formatReset(eu.resets_at as string);
        }
        result.spend = spend;
      } catch (e) {
        if (!(e instanceof TypeError || e instanceof RangeError)) throw e;
        logger.debug("extra_usage parse failed: %s", pyRepr(e));
      }
    }
  }

  // Per-model weekly limits are `limits[]` entries with a `scope.model.display_name`.
  const limits = data.limits;
  if (Array.isArray(limits)) {
    const scoped: ScopedWindow[] = [];
    for (const lim of limits as unknown[]) {
      if (!isRecord(lim)) continue;
      const scope = lim.scope;
      const model = isRecord(scope) ? scope.model : undefined;
      const name = isRecord(model) ? model.display_name : undefined;
      const pct = lim.percent;
      if (!name || typeof pct !== "number") continue;
      const entry: ScopedWindow = { name: name as string, pct };
      if (lim.resets_at) {
        entry.resets_at = lim.resets_at as string;
        [entry.countdown, entry.clock] = formatReset(lim.resets_at as string);
      }
      scoped.push(entry);
    }
    if (scoped.length > 0) result.scoped = scoped;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Every `[label, pct, resetsAt]` window that gates this account: always "5h" and "7d",
 * plus each per-model `scoped` window that `models` names (case-insensitive, `all` matches every one).
 * `spend` is a different axis and is not included.
 */
export function relevantWindows(usage: UsageDict | null | undefined, models: readonly string[] = []): RelevantWindow[] {
  if (!isRecord(usage)) return [];
  const windows: RelevantWindow[] = [];
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
    const window: unknown = usage[key];
    if (isRecord(window) && typeof window.pct === "number") {
      windows.push([label, window.pct, (window.resets_at as string | null | undefined) ?? null]);
    }
  }
  if (models.length > 0) {
    const wanted = new Set(models.map((m) => m.toLowerCase()));
    const matchAll = wanted.has("all");
    const scoped: unknown = usage.scoped;
    if (Array.isArray(scoped)) {
      for (const s of scoped as unknown[]) {
        if (
          isRecord(s) &&
          typeof s.pct === "number" &&
          typeof s.name === "string" &&
          (matchAll || wanted.has(s.name.toLowerCase()))
        ) {
          windows.push([s.name, s.pct, (s.resets_at as string | null | undefined) ?? null]);
        }
      }
    }
  }
  return windows;
}

/**
 * Headroom of the binding window (`100 - max(pct)`) over `relevantWindows`.
 * A value `<= 0` means that the account is at a limit. Null means that the usage is unknown.
 */
export function accountHeadroom(usage: UsageDict | null | undefined, models: readonly string[] = []): number | null {
  const pcts = relevantWindows(usage, models).map(([, pct]) => pct);
  if (pcts.length === 0) return null;
  return 100.0 - Math.max(...pcts);
}

/** Fetch 5-hour and 7-day utilization from the Anthropic usage API. Null on any failure. */
export async function fetchUsage(accessToken: string): Promise<UsageDict | null> {
  try {
    return buildUsageResult(await requestUsageData(accessToken));
  } catch (e) {
    const [kind] = classifyUsageError(e);
    logUsageFailure("", e, kind);
    return null;
  }
}

/**
 * Refresh failures that a retry in the same pass cannot fix.
 * With one of these, the caller must not send the expired token to the usage endpoint: it gets a 401 every pass.
 */
export const DETERMINISTIC_REFRESH_ERRORS: readonly string[] = [
  "store-unmirrored",
  "invalid_client",
  "consume-busy",
  "stash-unreadable",
];

const DEAD_REFRESH_ERRORS: readonly (string | null)[] = ["invalid_grant", "no_refresh_token"];

/**
 * Fetch usage for an account. Only an inactive account gets a token refresh,
 * because Claude Code owns the credentials of the active account.
 *
 * If `refreshVia(accountNum, email, snapshot)` is given, it replaces the direct POST.
 * The switcher gives its consume gate, which persists the result itself, so `persistCredentials` is then not used.
 */
export async function tryFetchUsageForAccount(
  accountNum: string,
  email: string,
  credentials: string,
  isActive: boolean,
  persistCredentials: PersistCredentials | null = null,
  refreshVia: RefreshVia | null = null,
): Promise<UsageOutcome> {
  const context = `for account ${accountNum}`;
  let oauth = extractOauthData(credentials);
  let accessToken = oauth?.accessToken;
  if (!oauth || !accessToken) return usageOutcome(null, { error: "no-access-token" });

  let workingCredentials = credentials;
  const refresh = (): Promise<RefreshOutcome> =>
    Promise.resolve(
      refreshVia ? refreshVia(accountNum, email, workingCredentials) : tryRefreshOauthCredentials(workingCredentials),
    );
  const struckFp = (outcome: RefreshOutcome) => outcome.consumedFp ?? credentialFingerprint(workingCredentials);

  if (!isActive && oauth.refreshToken && isOauthTokenExpired(oauth.expiresAt)) {
    const outcome = await refresh();
    if (outcome.credentials) {
      workingCredentials = outcome.credentials;
      if (!refreshVia) persist(persistCredentials, accountNum, email, workingCredentials);
      oauth = extractOauthData(workingCredentials) ?? oauth;
      accessToken = oauth.accessToken || accessToken;
    } else if (DEAD_REFRESH_ERRORS.includes(outcome.error)) {
      // The refresh lineage is dead. Do not send the expired token to the usage endpoint.
      // The strike binds to the credential that the gate sent, which can differ from the snapshot.
      return usageOutcome(null, { error: outcome.error, struckFp: struckFp(outcome) });
    } else if (outcome.error !== null && DETERMINISTIC_REFRESH_ERRORS.includes(outcome.error)) {
      return usageOutcome(null, { error: outcome.error });
    }
    // After a transient refresh failure, try the expired token. The 401 path below tries the refresh again.
  }

  try {
    return usageOutcome(buildUsageResult(await requestUsageData(accessToken as string)));
  } catch (e) {
    const [kind, retryAfter] = classifyUsageError(e);
    if (!(e instanceof HTTPError) || e.code !== 401 || isActive || !oauth.refreshToken) {
      logUsageFailure(context, e, kind, retryAfter);
      return usageOutcome(null, { error: kind, retryAfterS: retryAfter });
    }

    const outcome = await refresh();
    if (!outcome.credentials) {
      logUsageFailure(context, e, kind);
      const dead = DEAD_REFRESH_ERRORS.includes(outcome.error);
      const distinct = dead || (outcome.error !== null && DETERMINISTIC_REFRESH_ERRORS.includes(outcome.error));
      return usageOutcome(null, {
        error: distinct ? outcome.error : "refresh-failed",
        struckFp: dead ? struckFp(outcome) : null,
      });
    }

    workingCredentials = outcome.credentials;
    if (!refreshVia) persist(persistCredentials, accountNum, email, workingCredentials);
    const newToken = extractOauthData(workingCredentials)?.accessToken;
    if (!newToken) return usageOutcome(null, { error: "refresh-failed" });

    try {
      return usageOutcome(buildUsageResult(await requestUsageData(newToken as string)));
    } catch (retryError) {
      const [retryKind, retryAfterS] = classifyUsageError(retryError);
      logUsageFailure(`${context} after refresh`, retryError, retryKind, retryAfterS);
      return usageOutcome(null, { error: retryKind, retryAfterS });
    }
  }
}

/** The usage dict, or null (see `tryFetchUsageForAccount` for the cause). */
export async function fetchUsageForAccount(
  accountNum: string,
  email: string,
  credentials: string,
  isActive: boolean,
  persistCredentials: PersistCredentials | null = null,
): Promise<UsageDict | null> {
  return (await tryFetchUsageForAccount(accountNum, email, credentials, isActive, persistCredentials)).usage;
}

/** Call the persist callback. On failure, log a warning and print one to stderr. */
export function persist(
  callback: PersistCredentials | null,
  accountNum: string,
  email: string,
  credentials: string,
): void {
  if (!callback) return;
  try {
    callback(accountNum, email, credentials);
  } catch (e) {
    logger.warning(
      "Refreshed OAuth token for account %s (%s) but failed to persist it: %s. " +
        "The refresh token on disk may now be stale; if the next refresh fails " +
        "with invalid_grant, re-run `cswap --add-account` after logging in.",
      accountNum,
      email,
      pyRepr(e),
    );
    // stderr, because the `--json` commands write one machine-readable object to stdout.
    printWarning(
      `Warning: failed to save refreshed token for account ${accountNum} (${email}). ` +
        "If the next refresh fails, re-run `cswap --add-account` after logging in.",
      { file: process.stderr },
    );
  }
}

/**
 * Send a request and return the body text, like `urllib.request.urlopen(...).read()`.
 * A status outside 2xx throws `HTTPError`. A request without a response throws `URLError`.
 * The timeout covers the body too.
 */
async function urlopen(url: string, init: RequestInit, timeoutS: number): Promise<string> {
  const signal = AbortSignal.timeout(timeoutS * 1000);
  let response: Response;
  try {
    response = await internals.fetch(url, { ...init, signal });
  } catch (e) {
    if (e instanceof HTTPError || e instanceof URLError) throw e;
    const cause = e instanceof Error && !isTimeoutError(e) && e.cause !== undefined ? e.cause : e;
    throw new URLError(cause);
  }
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    throw new HTTPError(url, response.status, response.statusText, response.headers, body);
  }
  return response.text();
}

const TIMEOUT_CODES: readonly unknown[] = [
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
];

function isTimeoutError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  return (e as { name?: unknown }).name === "TimeoutError" || TIMEOUT_CODES.includes((e as { code?: unknown }).code);
}

/** The text of Python `repr()` for an error, for the debug log. */
export function pyRepr(e: unknown): string {
  if (e instanceof HTTPError) return `<HTTPError ${e.code}: '${e.msg}'>`;
  if (e instanceof URLError) return `URLError(${pyRepr(e.reason)})`;
  if (e instanceof Error) return `${e.name}('${e.message}')`;
  if (typeof e === "string") return `'${e}'`;
  return String(e);
}

/** Python `float()` for a JSON value. Throws TypeError or RangeError as Python throws TypeError or ValueError. */
function pyFloat(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string") {
    const parsed = parsePyFloat(value.trim());
    if (parsed === null) throw new RangeError(`could not convert string to float: '${value}'`);
    return parsed;
  }
  throw new TypeError(`float() argument must be a string or a real number, not '${typeof value}'`);
}

/** Parse the text forms that Python `float()` accepts, or return null. */
function parsePyFloat(text: string): number | null {
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(text);
  if (special) {
    if (special[2]!.toLowerCase() === "nan") return Number.NaN;
    return special[1] === "-" ? -Infinity : Infinity;
  }
  // Python allows one underscore between two digits.
  const digits = String.raw`\d(?:_?\d)*`;
  const pattern = new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?$`);
  if (!pattern.test(text)) return null;
  return Number(text.replaceAll("_", ""));
}

/** `obj[key]` with the Python errors: TypeError for a non-object, an Error named KeyError for a missing key. */
function requireKey(obj: unknown, key: string): unknown {
  if (!isRecord(obj)) throw new TypeError(`cannot read '${key}' of ${typeof obj}`);
  if (!(key in obj)) {
    const error = new Error(`'${key}'`);
    error.name = "KeyError";
    throw error;
  }
  return obj[key];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
