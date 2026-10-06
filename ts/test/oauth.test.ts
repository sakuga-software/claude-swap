import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { DEBUG, getLogger, Handler, type LogRecord, StreamHandler, WARNING } from "../src/logging_config.js";
import * as oauth from "../src/oauth.js";
import { HTTPError, internals, refreshOutcome, URLError } from "../src/oauth.js";
import { isoformat } from "../src/support/py.js";
import { ERROR_NOTES } from "../src/switcher.js";
import { bodyOf, errorResponse, header, jsonResponse, mockFetch, useRealOauthProfileFetch } from "./helpers/oauth.js";

function setNow(date: Date): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(date);
}

class CaptureHandler extends Handler {
  readonly records: LogRecord[] = [];

  protected emit(record: LogRecord): void {
    this.records.push(record);
  }
}

/** The equivalent of `caplog.at_level(level, logger="claude-swap")` for the rest of the test. */
function captureLogs(level = WARNING): LogRecord[] {
  const logger = getLogger("claude-swap");
  const previous = logger.level;
  const handler = new CaptureHandler();
  logger.addHandler(handler);
  logger.setLevel(level);
  onTestFinished(() => {
    logger.removeHandler(handler);
    logger.setLevel(previous);
  });
  return handler.records;
}

function captureStream(stream: NodeJS.WriteStream): string[] {
  const chunks: string[] = [];
  vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return chunks;
}

const FIXED_NOW = new Date(Date.UTC(2026, 2, 23, 12, 0, 0));
const HOUR = 3_600_000;
const MINUTE = 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("TestExtractAccessToken", () => {
  it("test_valid_credentials", () => {
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-test-token" } });
    expect(oauth.extractAccessToken(creds)).toBe("sk-test-token");
  });

  it("test_missing_key", () => {
    expect(oauth.extractAccessToken(JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
  });

  it("test_invalid_json", () => {
    expect(oauth.extractAccessToken("not-json")).toBeNull();
  });

  it("test_empty_string", () => {
    expect(oauth.extractAccessToken("")).toBeNull();
  });
});

describe("TestAccountHeadroom", () => {
  it("test_binding_window_is_the_higher_utilization", () => {
    expect(oauth.accountHeadroom({ five_hour: { pct: 80.0 }, seven_day: { pct: 20.0 } })).toBe(20.0);
  });

  it("test_seven_day_can_be_the_binding_window", () => {
    expect(oauth.accountHeadroom({ five_hour: { pct: 10.0 }, seven_day: { pct: 95.0 } })).toBe(5.0);
  });

  it("test_single_window", () => {
    expect(oauth.accountHeadroom({ five_hour: { pct: 40.0 } })).toBe(60.0);
  });

  it("test_at_limit_is_zero_headroom", () => {
    expect(oauth.accountHeadroom({ five_hour: { pct: 100.0 } })).toBe(0.0);
  });

  it("test_spend_is_ignored", () => {
    const usage = { spend: { pct: 99.0, used: 1, limit: 1, currency: "USD" }, five_hour: { pct: 10.0 } };
    expect(oauth.accountHeadroom(usage)).toBe(90.0);
  });

  it("test_no_window_data_is_unknown", () => {
    expect(oauth.accountHeadroom({ spend: { pct: 50.0, used: 1, limit: 1, currency: "USD" } })).toBeNull();
    expect(oauth.accountHeadroom({})).toBeNull();
  });

  it("test_none_and_non_dict_are_unknown", () => {
    expect(oauth.accountHeadroom(null)).toBeNull();
    expect(oauth.accountHeadroom("no credentials" as never)).toBeNull();
  });

  it("test_malformed_pct_is_ignored", () => {
    expect(oauth.accountHeadroom({ five_hour: { pct: null as never } })).toBeNull();
  });

  it("test_scoped_ignored_without_models_arg", () => {
    const usage = { five_hour: { pct: 10.0 }, scoped: [{ name: "Fable", pct: 100.0 }] };
    expect(oauth.accountHeadroom(usage)).toBe(90.0);
  });

  it("test_named_model_folds_into_binding_window", () => {
    const usage = { five_hour: { pct: 10.0 }, scoped: [{ name: "Fable", pct: 95.0 }] };
    expect(oauth.accountHeadroom(usage, ["Fable"])).toBe(5.0);
  });

  it("test_maxed_model_is_at_limit_despite_session_headroom", () => {
    const usage = { five_hour: { pct: 1.0 }, seven_day: { pct: 40.0 }, scoped: [{ name: "Fable", pct: 100.0 }] };
    expect(oauth.accountHeadroom(usage, ["Fable"])).toBe(0.0);
  });

  it("test_model_match_is_case_insensitive", () => {
    expect(oauth.accountHeadroom({ scoped: [{ name: "Fable", pct: 70.0 }] }, ["fable"])).toBe(30.0);
  });

  it("test_unlisted_model_does_not_bind", () => {
    const usage = { five_hour: { pct: 10.0 }, scoped: [{ name: "Opus", pct: 100.0 }] };
    expect(oauth.accountHeadroom(usage, ["Fable"])).toBe(90.0);
  });

  it("test_multiple_models_take_the_worst", () => {
    const usage = {
      five_hour: { pct: 10.0 },
      scoped: [
        { name: "Fable", pct: 30.0 },
        { name: "Opus", pct: 95.0 },
        { name: "Haiku", pct: 50.0 },
      ],
    };
    expect(oauth.accountHeadroom(usage, ["Fable", "Opus", "Sonnet"])).toBe(5.0);
  });

  it("test_works_for_any_model_name", () => {
    for (const name of ["Opus", "Sonnet", "Haiku"]) {
      expect(oauth.accountHeadroom({ scoped: [{ name, pct: 100.0 }] }, [name])).toBe(0.0);
    }
  });

  it("test_only_scoped_and_named_yields_headroom", () => {
    expect(oauth.accountHeadroom({ scoped: [{ name: "Fable", pct: 100.0 }] }, ["Fable"])).toBe(0.0);
  });

  it("test_scoped_without_5h7d_and_unlisted_model_is_unknown", () => {
    expect(oauth.accountHeadroom({ scoped: [{ name: "Opus", pct: 100.0 }] }, ["Fable"])).toBeNull();
  });

  it("test_all_sentinel_matches_every_scoped_window", () => {
    const usage = {
      five_hour: { pct: 10.0 },
      scoped: [
        { name: "Fable", pct: 30.0 },
        { name: "Sonnet", pct: 97.0 },
      ],
    };
    expect(oauth.accountHeadroom(usage, ["all"])).toBe(3.0);
    expect(oauth.accountHeadroom(usage, ["ALL"])).toBe(3.0);
  });
});

describe("TestRelevantWindows", () => {
  it("test_carries_labels_pcts_and_resets", () => {
    const usage = {
      five_hour: { pct: 80.0, resets_at: "2026-07-10T12:00:00Z" },
      seven_day: { pct: 20.0 },
      scoped: [{ name: "Fable", pct: 95.0, resets_at: "2026-07-12T09:00:00Z" }],
    };
    expect(oauth.relevantWindows(usage, ["Fable"])).toEqual([
      ["5h", 80.0, "2026-07-10T12:00:00Z"],
      ["7d", 20.0, null],
      ["Fable", 95.0, "2026-07-12T09:00:00Z"],
    ]);
  });

  it("test_scoped_excluded_without_models", () => {
    const usage = { five_hour: { pct: 10.0 }, scoped: [{ name: "Fable", pct: 99.0 }] };
    expect(oauth.relevantWindows(usage)).toEqual([["5h", 10.0, null]]);
  });

  it("test_non_dict_usage_is_empty", () => {
    expect(oauth.relevantWindows(null)).toEqual([]);
    expect(oauth.relevantWindows("no credentials" as never)).toEqual([]);
  });
});

describe("TestFormatReset", () => {
  it("test_same_day_shows_time_only", () => {
    setNow(FIXED_NOW);
    const future = new Date(FIXED_NOW.getTime() + 2 * HOUR + 15 * MINUTE);
    const [countdown, clock] = oauth.formatReset(isoformat(future));
    expect(countdown).toBe("2h 15m");
    expect(clock.split(":").length - 1).toBe(1);
  });

  it("test_different_day_shows_date", () => {
    setNow(FIXED_NOW);
    const future = new Date(FIXED_NOW.getTime() + 48 * HOUR);
    const [, clock] = oauth.formatReset(isoformat(future));
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    expect(months.some((m) => clock.includes(m))).toBe(true);
  });

  it("test_minutes_only_when_under_one_hour", () => {
    setNow(FIXED_NOW);
    const future = new Date(FIXED_NOW.getTime() + 45 * MINUTE);
    const [countdown] = oauth.formatReset(isoformat(future));
    expect(countdown).toBe("45m");
    expect(countdown).not.toContain("h");
  });
});

describe("TestFetchUsage", () => {
  async function fetchWithResponse(responseData: unknown) {
    mockFetch(() => jsonResponse(responseData));
    return oauth.fetchUsage("sk-test-token");
  }

  it("test_success", async () => {
    setNow(FIXED_NOW);
    const future = isoformat(new Date(FIXED_NOW.getTime() + HOUR));
    const result = await fetchWithResponse({
      five_hour: { utilization: 22.0, resets_at: future },
      seven_day: { utilization: 61.0, resets_at: future },
    });
    expect(result?.five_hour?.pct).toBe(22.0);
    expect(result?.seven_day?.pct).toBe(61.0);
    expect(result?.five_hour?.countdown).toBe("1h 0m");
  });

  it("test_network_error", async () => {
    mockFetch(() => {
      throw new Error("timeout");
    });
    expect(await oauth.fetchUsage("sk-test-token")).toBeNull();
  });

  it("test_http_error_logs_in_debug_mode", async () => {
    const logger = getLogger("claude-swap");
    const previous = logger.level;
    const stderr = captureStream(process.stderr);
    logger.setLevel(DEBUG);
    const handler = new StreamHandler();
    logger.addHandler(handler);
    try {
      mockFetch(() => errorResponse(429, "Too Many Requests"));
      const result = await oauth.fetchUsage("sk-test-token");

      expect(result).toBeNull();
      const debugOutput = stderr.join("");
      expect(debugOutput).toContain("Usage fetch failed");
      expect(debugOutput).toContain("<HTTPError 429: 'Too Many Requests'>");
    } finally {
      logger.removeHandler(handler);
      logger.setLevel(previous);
    }
  });

  it("test_bad_response", async () => {
    expect(await fetchWithResponse({})).toBeNull();
  });

  it("test_null_resets_at", async () => {
    setNow(FIXED_NOW);
    const future = isoformat(new Date(FIXED_NOW.getTime() + 22 * HOUR));
    const result = await fetchWithResponse({
      five_hour: { utilization: 0.0, resets_at: null },
      seven_day: { utilization: 100.0, resets_at: future },
    });
    expect(result).not.toBeNull();
    expect(result?.five_hour?.pct).toBe(0.0);
    expect(result?.five_hour).not.toHaveProperty("clock");
    expect(result?.five_hour).not.toHaveProperty("countdown");
    expect(result?.seven_day?.pct).toBe(100.0);
    expect(result?.seven_day).toHaveProperty("clock");
    expect(result?.seven_day).toHaveProperty("countdown");
  });

  it("test_extra_usage_complete", async () => {
    const result = await fetchWithResponse({
      five_hour: { utilization: 22.0, resets_at: null },
      seven_day: { utilization: 61.0, resets_at: null },
      extra_usage: { is_enabled: true, used_credits: 72900, monthly_limit: 500000, utilization: 14.58, currency: "USD" },
    });
    expect(result).not.toBeNull();
    expect(result?.five_hour?.pct).toBe(22.0);
    expect(result?.seven_day?.pct).toBe(61.0);
    expect(result?.spend?.used).toBe(729.0);
    expect(result?.spend?.limit).toBe(5000.0);
    expect(result?.spend?.pct).toBe(14.58);
    expect(result?.spend?.currency).toBe("USD");
  });

  it("test_extra_usage_unlimited_keeps_other_rows", async () => {
    const result = await fetchWithResponse({
      five_hour: { utilization: 22.0, resets_at: null },
      seven_day: { utilization: 61.0, resets_at: null },
      extra_usage: { is_enabled: true, used_credits: 72900, monthly_limit: null, utilization: null, currency: "USD" },
    });
    expect(result).not.toBeNull();
    expect(result?.five_hour?.pct).toBe(22.0);
    expect(result?.seven_day?.pct).toBe(61.0);
    expect(result).not.toHaveProperty("spend");
  });

  it("test_extra_usage_partial_keeps_other_rows", async () => {
    const result = await fetchWithResponse({
      five_hour: { utilization: 22.0, resets_at: null },
      seven_day: { utilization: 61.0, resets_at: null },
      extra_usage: { is_enabled: true, used_credits: null, monthly_limit: 500000, utilization: 14.58 },
    });
    expect(result).not.toBeNull();
    expect(result?.five_hour?.pct).toBe(22.0);
    expect(result?.seven_day?.pct).toBe(61.0);
    expect(result).not.toHaveProperty("spend");
  });

  it("test_extra_usage_disabled_keeps_other_rows", async () => {
    const result = await fetchWithResponse({
      five_hour: { utilization: 22.0, resets_at: null },
      seven_day: { utilization: 61.0, resets_at: null },
      extra_usage: { is_enabled: false, used_credits: 72900, monthly_limit: 500000, utilization: 14.58 },
    });
    expect(result).not.toBeNull();
    expect(result?.five_hour?.pct).toBe(22.0);
    expect(result?.seven_day?.pct).toBe(61.0);
    expect(result).not.toHaveProperty("spend");
  });

  it("test_scoped_per_model_limits", async () => {
    setNow(FIXED_NOW);
    const future = isoformat(new Date(FIXED_NOW.getTime() + 3 * HOUR));
    const result = await fetchWithResponse({
      five_hour: { utilization: 7.0, resets_at: null },
      seven_day: { utilization: 72.0, resets_at: null },
      seven_day_opus: null,
      limits: [
        { kind: "session", group: "session", percent: 7, resets_at: null, scope: null, is_active: false },
        { kind: "weekly_all", group: "weekly", percent: 72, resets_at: null, scope: null, is_active: false },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 100,
          severity: "critical",
          resets_at: future,
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
          is_active: true,
        },
      ],
    });
    expect(result).not.toBeNull();
    expect(result?.scoped).toHaveLength(1);
    const fable = result!.scoped![0]!;
    expect(fable.name).toBe("Fable");
    expect(fable.pct).toBe(100.0);
    expect(fable.resets_at).toBe(future);
    expect(fable.countdown).toBe("3h 0m");
    expect(fable).toHaveProperty("clock");
  });

  it("test_no_limits_no_scoped_key", async () => {
    const result = await fetchWithResponse({
      five_hour: { utilization: 22.0, resets_at: null },
      seven_day: { utilization: 61.0, resets_at: null },
    });
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("scoped");
  });
});

function makeRefreshCredentials(scopes = ["user:profile", "user:inference", "user:sessions:claude_code"]): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0, scopes },
  });
}

describe("TestRefreshOAuthCredentials", () => {
  it("test_refresh_sends_correct_body", async () => {
    let seenBody: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      seenBody = bodyOf(init);
      return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    });

    const refreshed = await oauth.refreshOauthCredentials(makeRefreshCredentials());

    expect(refreshed).not.toBeNull();
    expect(seenBody.grant_type).toBe("refresh_token");
    expect(seenBody.refresh_token).toBe("old-refresh");
    expect(seenBody.client_id).toBe(oauth.OAUTH_CLIENT_ID);
    expect(seenBody).not.toHaveProperty("scope");
  });
});

describe("TestTryRefreshOAuthCredentials", () => {
  function httpError(code: number, body: string, msg = "err") {
    mockFetch(() => errorResponse(code, msg, body));
  }

  it("test_success_rotates_and_has_no_error", async () => {
    mockFetch(() => jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));

    const outcome = await oauth.tryRefreshOauthCredentials(makeRefreshCredentials());

    expect(outcome.error).toBeNull();
    const rotated = JSON.parse(outcome.credentials!).claudeAiOauth;
    expect(rotated.accessToken).toBe("new-access");
    expect(rotated.refreshToken).toBe("new-refresh");
  });

  it("test_invalid_grant_body_on_400_is_permanent", async () => {
    httpError(400, '{"error": "invalid_grant"}');
    const outcome = await oauth.tryRefreshOauthCredentials(makeRefreshCredentials());
    expect(outcome.credentials).toBeNull();
    expect(outcome.error).toBe("invalid_grant");
  });

  it("test_400_without_marker_is_transient", async () => {
    httpError(400, '{"error": "temporarily_unavailable"}');
    expect((await oauth.tryRefreshOauthCredentials(makeRefreshCredentials())).error).toBe("transient");
  });

  it("test_5xx_is_transient_even_with_marker", async () => {
    httpError(500, '{"error": "invalid_grant"}');
    expect((await oauth.tryRefreshOauthCredentials(makeRefreshCredentials())).error).toBe("transient");
  });

  it("test_network_error_is_transient", async () => {
    mockFetch(() => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND dns") });
    });
    expect((await oauth.tryRefreshOauthCredentials(makeRefreshCredentials())).error).toBe("transient");
  });

  it("test_missing_refresh_token_is_permanent", async () => {
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: 0 } });
    expect((await oauth.tryRefreshOauthCredentials(creds)).error).toBe("no_refresh_token");
  });

  it("test_invalid_json_is_transient", async () => {
    // An unparseable blob is more likely a torn read. It must not give a permanent verdict.
    expect((await oauth.tryRefreshOauthCredentials("not json")).error).toBe("transient");
  });

  it("test_wrapper_returns_none_on_failure", async () => {
    httpError(400, '{"error": "invalid_grant"}');
    expect(await oauth.refreshOauthCredentials(makeRefreshCredentials())).toBeNull();
  });
});

describe("TestBuildTokenStatus", () => {
  it("test_builds_fresh_token_status", () => {
    setNow(new Date(Date.UTC(2026, 3, 2, 18, 0, 0)));
    const expiresAt = Date.UTC(2026, 3, 2, 19, 30, 0);
    const credentials = JSON.stringify({
      claudeAiOauth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt },
    });

    const status = oauth.buildTokenStatus(credentials);

    expect(status).not.toBeNull();
    expect(status).toContain("oauth: fresh, refresh token yes");
    expect(status).toContain("in 1h 30m");
  });

  it("test_builds_unknown_expiry_status", () => {
    const credentials = JSON.stringify({ claudeAiOauth: { accessToken: "old-access", refreshToken: "old-refresh" } });
    expect(oauth.buildTokenStatus(credentials)).toBe("oauth: unknown expiry, refresh token yes");
  });
});

describe("TestFetchUsageForAccount", () => {
  function makeCredentials({
    access = "old-access",
    refresh = "old-refresh",
    expiresAt = undefined as number | undefined,
    orgUuid = "org-1",
    scopes = ["user:profile", "user:inference", "user:sessions:claude_code"],
  } = {}): string {
    const oauthData: Record<string, unknown> = {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: expiresAt ?? Date.now() + 3_600_000,
      scopes,
      subscriptionType: "pro",
      rateLimitTier: "default_claude_ai",
    };
    return JSON.stringify({ claudeAiOauth: oauthData, organizationUuid: orgUuid });
  }

  function makeTokenResponse(access = "new-access", refresh = "new-refresh", expiresIn = 3600): Response {
    return jsonResponse({
      access_token: access,
      refresh_token: refresh,
      expires_in: expiresIn,
      scope: "user:profile user:inference user:sessions:claude_code",
    });
  }

  function makeUsageResponse(h5Pct = 12.0, d7Pct = 34.0): Response {
    return jsonResponse({
      five_hour: { utilization: h5Pct, resets_at: null },
      seven_day: { utilization: d7Pct, resets_at: null },
    });
  }

  it("test_refreshes_expired_token_before_usage_fetch", async () => {
    const credentials = makeCredentials({ expiresAt: Date.now() - 1_000 });
    const persistMock = vi.fn();
    mockFetch((url, init) => {
      if (url.includes("oauth/token")) return makeTokenResponse();
      if (url.includes("oauth/usage")) {
        expect(header(init, "Authorization")).toBe("Bearer new-access");
        return makeUsageResponse();
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await oauth.fetchUsageForAccount("1", "test@example.com", credentials, false, persistMock);

    expect(result?.five_hour?.pct).toBe(12.0);
    expect(persistMock).toHaveBeenCalledOnce();
    const merged = JSON.parse(persistMock.mock.calls[0]![2] as string);
    expect(merged.organizationUuid).toBe("org-1");
    expect(merged.claudeAiOauth.accessToken).toBe("new-access");
    expect(merged.claudeAiOauth.refreshToken).toBe("new-refresh");
  });

  it("test_retries_401_with_token_refresh", async () => {
    const credentials = makeCredentials();
    let usageCalls = 0;
    const persistMock = vi.fn();
    mockFetch((url, init) => {
      if (url.includes("oauth/token")) return makeTokenResponse();
      if (url.includes("oauth/usage")) {
        usageCalls += 1;
        if (usageCalls === 1) {
          expect(header(init, "Authorization")).toBe("Bearer old-access");
          return errorResponse(401, "Unauthorized");
        }
        expect(header(init, "Authorization")).toBe("Bearer new-access");
        return makeUsageResponse(56.0, 78.0);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await oauth.fetchUsageForAccount("2", "test@example.com", credentials, false, persistMock);

    expect(result?.seven_day?.pct).toBe(78.0);
    expect(usageCalls).toBe(2);
    expect(persistMock).toHaveBeenCalledOnce();
    expect(JSON.parse(persistMock.mock.calls[0]![2] as string).claudeAiOauth.accessToken).toBe("new-access");
  });

  it("test_valid_token_fetches_usage_without_refresh", async () => {
    const credentials = makeCredentials();
    mockFetch((url, init) => {
      if (url.includes("oauth/usage")) {
        expect(header(init, "Authorization")).toBe("Bearer old-access");
        return makeUsageResponse(10.0, 20.0);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const refreshMock = vi.spyOn(internals, "refreshOauthCredentials");

    const result = await oauth.fetchUsageForAccount("1", "test@example.com", credentials, false);

    expect(refreshMock).not.toHaveBeenCalled();
    expect(result?.five_hour?.pct).toBe(10.0);
  });

  it("test_refresh_failure_returns_none_gracefully", async () => {
    const credentials = makeCredentials({ expiresAt: Date.now() - 1_000 });
    mockFetch((url) => {
      if (url.includes("oauth/token")) return errorResponse(400, "Bad Request");
      if (url.includes("oauth/usage")) return errorResponse(401, "Unauthorized");
      throw new Error(`Unexpected URL: ${url}`);
    });

    expect(await oauth.fetchUsageForAccount("1", "test@example.com", credentials, false)).toBeNull();
  });

  it("test_refreshes_when_scopes_are_missing", async () => {
    const parsed = JSON.parse(makeCredentials({ expiresAt: Date.now() - 1_000 }));
    delete parsed.claudeAiOauth.scopes;
    const credentials = JSON.stringify(parsed);
    const persistMock = vi.fn();
    mockFetch((url, init) => {
      if (url.includes("oauth/token")) {
        expect(bodyOf(init)).not.toHaveProperty("scope");
        return makeTokenResponse();
      }
      if (url.includes("oauth/usage")) return makeUsageResponse();
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await oauth.fetchUsageForAccount("1", "test@example.com", credentials, false, persistMock);

    expect(result).not.toBeNull();
    expect(persistMock).toHaveBeenCalledOnce();
  });

  it("test_active_account_skips_refresh_even_when_expired", async () => {
    // Claude Code owns the credentials of the active account, so cswap must never refresh them.
    const credentials = makeCredentials({ expiresAt: Date.now() - 1_000 });
    const persistMock = vi.fn();
    let refreshCalls = 0;
    mockFetch((url) => {
      if (url.includes("oauth/token")) {
        refreshCalls += 1;
        throw new Error("Active account must not trigger a refresh POST");
      }
      if (url.includes("oauth/usage")) return errorResponse(401, "Unauthorized");
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await oauth.fetchUsageForAccount("1", "test@example.com", credentials, true, persistMock);

    expect(refreshCalls).toBe(0);
    expect(persistMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("test_active_account_401_does_not_retry_with_refresh", async () => {
    const credentials = makeCredentials();
    mockFetch((url) => {
      if (url.includes("oauth/token")) throw new Error("Active account must not trigger a refresh POST on 401");
      if (url.includes("oauth/usage")) return errorResponse(401, "Unauthorized");
      throw new Error(`Unexpected URL: ${url}`);
    });
    const persistMock = vi.fn();

    const result = await oauth.fetchUsageForAccount("1", "test@example.com", credentials, true, persistMock);

    expect(result).toBeNull();
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("test_persist_failure_logs_warning_with_recovery_hint", () => {
    const records = captureLogs(WARNING);
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const boom = () => {
      throw new Error("disk exploded");
    };

    oauth.persist(boom, "1", "test@example.com", "{}");

    const warningRecords = records.filter((r) => r.levelno === WARNING && r.name === "claude-swap");
    expect(warningRecords).toHaveLength(1);
    const msg = warningRecords[0]!.message;
    expect(msg).toContain("failed to persist");
    expect(msg).toContain("cswap --add-account");
    expect(msg).toContain("1");
    expect(msg).toContain("test@example.com");

    expect(stderr.join("")).toContain("failed to save refreshed token");
    expect(stderr.join("")).toContain("cswap --add-account");
    expect(stdout.join("")).toBe("");
  });
});

describe("TestClassifyUsageError", () => {
  function httpError(code: number, headers?: Record<string, string>): HTTPError {
    return new HTTPError(oauth.OAUTH_USAGE_URL, code, "err", headers ? new Headers(headers) : null);
  }

  it("test_http_codes", () => {
    expect(oauth.classifyUsageError(httpError(429))[0]).toBe("http-429");
    expect(oauth.classifyUsageError(httpError(500))[0]).toBe("http-500");
    expect(oauth.classifyUsageError(httpError(401))[0]).toBe("http-401");
  });

  it("test_retry_after_seconds", () => {
    expect(oauth.classifyUsageError(httpError(429, { "Retry-After": "30" }))).toEqual(["http-429", 30.0]);
  });

  it("test_retry_after_date_form_ignored", () => {
    const [, retry] = oauth.classifyUsageError(httpError(429, { "Retry-After": "Fri, 04 Jul 2026 12:00:00 GMT" }));
    expect(retry).toBeNull();
  });

  it("test_retry_after_negative_clamped", () => {
    expect(oauth.classifyUsageError(httpError(429, { "Retry-After": "-5" }))[1]).toBe(0.0);
  });

  it("test_no_headers", () => {
    expect(oauth.classifyUsageError(httpError(429))).toEqual(["http-429", null]);
  });

  it("test_timeout", () => {
    // AbortSignal.timeout() rejects with a DOMException named TimeoutError. A socket timeout has the code ETIMEDOUT.
    const signalTimeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const socketTimeout = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(oauth.classifyUsageError(signalTimeout)[0]).toBe("timeout");
    expect(oauth.classifyUsageError(socketTimeout)[0]).toBe("timeout");
    expect(oauth.classifyUsageError(new URLError(signalTimeout))[0]).toBe("timeout");
  });

  it("test_network", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(oauth.classifyUsageError(new URLError(refused))[0]).toBe("network");
  });

  it("test_bad_response", () => {
    let error: unknown;
    try {
      JSON.parse("not json");
    } catch (e) {
      error = e;
    }
    expect(oauth.classifyUsageError(error)[0]).toBe("bad-response");
  });

  it("test_fallback_type_name", () => {
    // Python ValueError maps to RangeError.
    expect(oauth.classifyUsageError(new RangeError("x"))[0]).toBe("RangeError");
  });
});

describe("TestTryFetchUsageOutcome", () => {
  function makeCredentials(): string {
    return JSON.stringify({
      claudeAiOauth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() + HOUR },
    });
  }

  it("test_success_outcome", async () => {
    mockFetch(() => jsonResponse({ five_hour: { utilization: 12.0, resets_at: null } }));
    const outcome = await oauth.tryFetchUsageForAccount("1", "a@b.c", makeCredentials(), false);
    expect(outcome.error).toBeNull();
    expect(outcome.usage?.five_hour?.pct).toBe(12.0);
  });

  it("test_429_outcome_carries_retry_after", async () => {
    mockFetch(() => errorResponse(429, "Too Many", "", { "Retry-After": "42" }));
    const records = captureLogs(WARNING);

    const outcome = await oauth.tryFetchUsageForAccount("1", "a@b.c", makeCredentials(), false);

    expect(outcome.usage).toBeNull();
    expect(outcome.error).toBe("http-429");
    expect(outcome.retryAfterS).toBe(42.0);
    const line = records.filter((r) => r.levelno === WARNING).find((r) => r.message.includes("http-429"))!.message;
    expect(line).toContain("account 1");
    expect(line).toContain("retry-after 42s");
    expect(line).not.toContain("a@b.c");
    expect(line).toContain("usage-endpoint budget");
  });

  it("test_edge_429_warning_names_the_budget", async () => {
    mockFetch(() => errorResponse(429, "Too Many", "", { "Retry-After": "0" }));
    const records = captureLogs(WARNING);

    const outcome = await oauth.tryFetchUsageForAccount("1", "a@b.c", makeCredentials(), false);

    expect(outcome.retryAfterS).toBe(0.0);
    const line = records.find((r) => r.levelno === WARNING && r.message.includes("http-429"))!.message;
    expect(line).toContain("retry-after 0s");
    expect(line).toContain("usage-endpoint budget");
  });

  it("test_timeout_outcome", async () => {
    mockFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const outcome = await oauth.tryFetchUsageForAccount("1", "a@b.c", makeCredentials(), false);
    expect(outcome.error).toBe("timeout");
  });

  it("test_no_access_token_outcome", async () => {
    const outcome = await oauth.tryFetchUsageForAccount("1", "a@b.c", JSON.stringify({ claudeAiOauth: {} }), false);
    expect(outcome.error).toBe("no-access-token");
  });
});

describe("TestInvalidGrantPropagation", () => {
  function expiredCredentials(): string {
    return JSON.stringify({
      claudeAiOauth: { accessToken: "old-access", refreshToken: "dead-refresh", expiresAt: Date.now() - HOUR },
    });
  }

  function validCredentials(): string {
    return JSON.stringify({
      claudeAiOauth: { accessToken: "good-access", refreshToken: "dead-refresh", expiresAt: Date.now() + HOUR },
    });
  }

  it("test_proactive_refresh_invalid_grant_short_circuits", async () => {
    vi.spyOn(internals, "tryRefreshOauthCredentials").mockResolvedValue(refreshOutcome(null, "invalid_grant"));
    const usage = vi.spyOn(internals, "requestUsageData");

    const outcome = await oauth.tryFetchUsageForAccount("1", "a@b.c", expiredCredentials(), false);

    expect(outcome.error).toBe("invalid_grant");
    expect(usage).not.toHaveBeenCalled();
  });

  it("test_401_retry_invalid_grant_is_permanent", async () => {
    mockFetch(() => errorResponse(401, "Unauthorized"));
    vi.spyOn(internals, "tryRefreshOauthCredentials").mockResolvedValue(refreshOutcome(null, "invalid_grant"));

    const outcome = await oauth.tryFetchUsageForAccount("1", "a@b.c", validCredentials(), false);

    expect(outcome.error).toBe("invalid_grant");
  });

  it("test_transient_refresh_failure_is_not_permanent", async () => {
    mockFetch(() => errorResponse(401, "Unauthorized"));
    vi.spyOn(internals, "tryRefreshOauthCredentials").mockResolvedValue(refreshOutcome(null, "transient"));

    const outcome = await oauth.tryFetchUsageForAccount("1", "a@b.c", validCredentials(), false);

    expect(outcome.error).toBe("refresh-failed");
  });
});

describe("TestCredentialFingerprint", () => {
  it("test_stable_across_access_token_rotation", () => {
    const a = JSON.stringify({ claudeAiOauth: { accessToken: "sk-old", refreshToken: "rt-1" } });
    const b = JSON.stringify({ claudeAiOauth: { accessToken: "sk-new", refreshToken: "rt-1", expiresAt: 5 } });
    expect(oauth.credentialFingerprint(a)).toBe(oauth.credentialFingerprint(b));
  });

  it("test_differs_across_refresh_token_rotation", () => {
    const a = JSON.stringify({ claudeAiOauth: { refreshToken: "rt-1" } });
    const b = JSON.stringify({ claudeAiOauth: { refreshToken: "rt-2" } });
    expect(oauth.credentialFingerprint(a)).not.toBe(oauth.credentialFingerprint(b));
  });

  it("test_full_content_fallback_for_api_keys_and_setup_tokens", () => {
    const apiKey = "sk-ant-api03-xyz";
    const setup = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-abc" } });
    expect(oauth.credentialFingerprint(apiKey)).not.toBeNull();
    expect(oauth.credentialFingerprint(setup)).not.toBeNull();
    expect(oauth.credentialFingerprint(apiKey)).not.toBe(oauth.credentialFingerprint(setup));
  });

  it("test_full_hash_never_collides_with_refresh_hash", () => {
    const withRt = JSON.stringify({ claudeAiOauth: { refreshToken: "rt-1" } });
    expect(oauth.credentialFingerprint(withRt)?.startsWith("sha256:")).toBe(true);
    expect(oauth.credentialFingerprint("raw-token")?.startsWith("sha256-full:")).toBe(true);
  });

  it("test_empty_input_is_none", () => {
    expect(oauth.credentialFingerprint("")).toBeNull();
  });
});

describe("TestTokenAccountParsing", () => {
  async function refreshWithResponse(payload: unknown) {
    mockFetch(() => jsonResponse(payload));
    return oauth.tryRefreshOauthCredentials(makeRefreshCredentials());
  }

  it("test_token_account_surfaced_when_present", async () => {
    const outcome = await refreshWithResponse({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      account: { uuid: "acc-uuid", email_address: "a@b.c" },
      organization: { uuid: "org-uuid" },
    });
    expect(outcome.error).toBeNull();
    expect(outcome.tokenAccount).toEqual({ uuid: "acc-uuid", email: "a@b.c", organizationUuid: "org-uuid" });
  });

  it("test_token_account_absent_is_none", async () => {
    const outcome = await refreshWithResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    expect(outcome.error).toBeNull();
    expect(outcome.tokenAccount).toBeNull();
  });

  it("test_token_account_without_uuid_is_none", async () => {
    const outcome = await refreshWithResponse({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      account: { email_address: "a@b.c" },
    });
    expect(outcome.error).toBeNull();
    expect(outcome.tokenAccount).toBeNull();
  });

  it("test_token_account_non_string_uuid_is_none", async () => {
    const outcome = await refreshWithResponse({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      account: { uuid: 12345, email_address: "a@b.c" },
    });
    expect(outcome.error).toBeNull();
    expect(outcome.tokenAccount).toBeNull();
  });

  it("test_token_account_uuid_whitespace_normalized", async () => {
    const outcome = await refreshWithResponse({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      account: { uuid: "  acc-uuid  ", email_address: "a@b.c" },
    });
    expect(outcome.tokenAccount?.uuid).toBe("acc-uuid");
  });

  it("test_token_account_non_string_optionals_normalized", async () => {
    const outcome = await refreshWithResponse({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      account: { uuid: "acc-uuid", email_address: { weird: 1 } },
      organization: { uuid: 99 },
    });
    expect(outcome.error).toBeNull();
    expect(outcome.tokenAccount).toEqual({ uuid: "acc-uuid", email: null, organizationUuid: null });
  });
});

describe("TestFetchOauthProfile", () => {
  useRealOauthProfileFetch();

  function profileResponse(payload: unknown) {
    mockFetch(() => jsonResponse(payload));
  }

  it("test_resolves_identity", async () => {
    const seen: { url?: string; auth?: string | null } = {};
    mockFetch((url, init) => {
      seen.url = url;
      seen.auth = header(init, "Authorization");
      return jsonResponse({ account: { uuid: "acc-uuid", email: "a@b.c" }, organization: { uuid: "org-uuid" } });
    });

    const result = await oauth.fetchOauthProfile("sk-live");

    expect(result).toEqual({ uuid: "acc-uuid", email: "a@b.c", organizationUuid: "org-uuid" });
    expect(seen.url?.endsWith("/api/oauth/profile")).toBe(true);
    expect(seen.auth).toBe("Bearer sk-live");
  });

  it("test_uses_bounded_timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    profileResponse({ account: { uuid: "acc-uuid", email: "a@b.c" } });

    await oauth.fetchOauthProfile("sk-live");

    expect(timeout).toHaveBeenCalledWith(5000);
  });

  it("test_network_failure_is_unresolvable_not_error", async () => {
    mockFetch(() => {
      throw new TypeError("fetch failed", { cause: new Error("down") });
    });
    expect(await oauth.fetchOauthProfile("sk-live")).toBeNull();
  });

  it("test_missing_account_object_is_unresolvable", async () => {
    profileResponse({ unexpected: true });
    expect(await oauth.fetchOauthProfile("sk-live")).toBeNull();
  });

  it("test_missing_uuid_is_unresolvable", async () => {
    profileResponse({ account: { email: "a@b.c" }, organization: { uuid: "org-uuid" } });
    expect(await oauth.fetchOauthProfile("sk-live")).toBeNull();
  });

  it("test_non_string_uuid_is_unresolvable", async () => {
    profileResponse({ account: { uuid: 12345, email: "a@b.c" } });
    expect(await oauth.fetchOauthProfile("sk-live")).toBeNull();
  });

  it("test_blank_uuid_is_unresolvable", async () => {
    profileResponse({ account: { uuid: "   ", email: "a@b.c" } });
    expect(await oauth.fetchOauthProfile("sk-live")).toBeNull();
  });

  it("test_malformed_json_is_unresolvable", async () => {
    mockFetch(() => new Response("<!doctype html><html>gateway error", { status: 200 }));
    expect(await oauth.fetchOauthProfile("sk-live")).toBeNull();
  });

  it("test_uuid_whitespace_normalized_at_boundary", async () => {
    profileResponse({ account: { uuid: "  acc-uuid  ", email: "a@b.c" } });
    expect((await oauth.fetchOauthProfile("sk-live"))?.uuid).toBe("acc-uuid");
  });

  it("test_valid_uuid_with_missing_email_still_resolves", async () => {
    profileResponse({ account: { uuid: "acc-uuid" } });
    expect(await oauth.fetchOauthProfile("sk-live")).toEqual({ uuid: "acc-uuid", email: null, organizationUuid: null });
  });

  it("test_non_string_optional_fields_are_dropped_not_fatal", async () => {
    profileResponse({ account: { uuid: "acc-uuid", email: { weird: true } }, organization: { uuid: 99 } });
    expect(await oauth.fetchOauthProfile("sk-live")).toEqual({ uuid: "acc-uuid", email: null, organizationUuid: null });
  });

  it("test_401_is_unresolvable_with_log_file_warning", async () => {
    mockFetch(() => errorResponse(401, "Unauthorized"));
    const records = captureLogs(WARNING);

    expect(await oauth.fetchOauthProfile("sk-live")).toBeNull();
    expect(records.some((r) => r.message.includes("401") && r.message.includes("pre-fix"))).toBe(true);
  });
});

describe("TestInvalidGrantTaxonomy", () => {
  async function refreshWithBody(code: number, body: string) {
    const creds = JSON.stringify({ claudeAiOauth: { refreshToken: "rt-x", accessToken: "a" } });
    mockFetch(() => errorResponse(code, "err", body));
    return oauth.tryRefreshOauthCredentials(creds);
  }

  it("test_rfc_invalid_grant_is_permanent", async () => {
    expect((await refreshWithBody(400, '{"error": "invalid_grant"}')).error).toBe("invalid_grant");
  });

  it("test_substring_in_other_envelope_is_transient", async () => {
    const out = await refreshWithBody(400, '{"error": "server_error", "detail": "log mentions invalid_grant"}');
    expect(out.error).toBe("transient");
  });

  it("test_invalid_client_is_systemic_not_dead_token", async () => {
    expect((await refreshWithBody(401, '{"error": "invalid_client"}')).error).toBe("invalid_client");
  });

  it("test_unparseable_body_is_transient", async () => {
    expect((await refreshWithBody(400, "<html>oops</html>")).error).toBe("transient");
  });

  it("test_error_description_variant_still_permanent", async () => {
    const out = await refreshWithBody(400, '{"error": "invalid_grant", "error_description": "revoked"}');
    expect(out.error).toBe("invalid_grant");
  });
});

describe("TestNoRefreshTokenStructuralGuard", () => {
  it("test_complete_dict_without_rt_is_permanent", async () => {
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: "a" } });
    expect((await oauth.tryRefreshOauthCredentials(creds)).error).toBe("no_refresh_token");
  });

  it("test_unparseable_blob_is_transient", async () => {
    expect((await oauth.tryRefreshOauthCredentials('{"claudeAiOa')).error).toBe("transient");
  });

  it("test_non_dict_payload_is_transient", async () => {
    expect((await oauth.tryRefreshOauthCredentials('"just-a-string"')).error).toBe("transient");
  });
});

describe("TestConsumeBusyIsDeterministic", () => {
  it("test_a_busy_gate_does_not_spend_a_doomed_request", async () => {
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: "expired", refreshToken: "r", expiresAt: 1 } });
    const usage = vi.spyOn(internals, "requestUsageData");

    const out = await oauth.tryFetchUsageForAccount("1", "a@example.com", creds, false, null, () =>
      refreshOutcome(null, "consume-busy"),
    );

    expect(out.error).toBe("consume-busy");
    expect(usage).not.toHaveBeenCalled();
  });

  it("test_every_deterministic_kind_has_a_note", () => {
    // A kind with no note renders the bare identifier, which is worse than the generic "refresh-failed".
    const missing = oauth.DETERMINISTIC_REFRESH_ERRORS.filter((k) => !(k in ERROR_NOTES));
    expect(missing).toEqual([]);
  });
});

describe("TestLoginExpiresAtIso", () => {
  it("test_refresh_token_expiry_is_reported_as_iso_utc", () => {
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-x", refreshTokenExpiresAt: 1791421596865 } });
    expect(oauth.loginExpiresAtIso(creds)).toBe("2026-10-08T01:06:36Z");
  });

  it.each([
    "",
    "not json",
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-x" } }),
    JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: "soon" } }),
    JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: true } }),
    JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: 0 } }),
    JSON.stringify({ other: {} }),
  ])("test_anything_but_a_positive_epoch_is_unknown", (creds) => {
    expect(oauth.loginExpiresAtIso(creds)).toBeNull();
  });
});

describe("network isolation", () => {
  it("blocks a real request when a test gives no mock", async () => {
    await expect(globalThis.fetch("https://api.anthropic.com/api/oauth/usage")).rejects.toThrow(
      "real network call in test",
    );
    expect(await oauth.fetchUsage("sk-test-token")).toBeNull();
  });

  it("stubs fetchOauthProfile to null by default", async () => {
    const realFetch = mockFetch(() => jsonResponse({ account: { uuid: "acc-uuid" } }));
    expect(await oauth.fetchOauthProfile("sk-live")).toBeNull();
    expect(realFetch).not.toHaveBeenCalled();
  });
});
