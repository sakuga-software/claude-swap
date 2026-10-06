import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { activeCredentials } from "../src/credentials.js";
import { ConfigError, SwitchError } from "../src/exceptions.js";
import {
  accountRow,
  errorEnvelope,
  SCHEMA_VERSION,
  USAGE_KEYCHAIN_UNAVAILABLE,
  USAGE_NO_CREDENTIALS,
  USAGE_RELOGIN_REQUIRED,
  USAGE_TOKEN_EXPIRED,
  usageFields,
  usageFromJson,
  usageToJson,
} from "../src/json_output.js";
import { Platform } from "../src/models.js";
import { formatReset, type UsageDict, type UsageOutcome, usageOutcome } from "../src/oauth.js";
import { isoformat } from "../src/support/py.js";
import { ClaudeAccountSwitcher, internals as switcherInternals } from "../src/switcher.js";
import { UsageEntry, UsageStore } from "../src/usage_store.js";
import { mockClaudeConfig, sampleSequenceData, sampleSequenceDataWithOrg } from "./helpers/fixtures.js";
import { testHome } from "./helpers/home.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function isoFromNow(ms: number): string {
  return isoformat(new Date(Date.now() + ms));
}

function isoFromEpoch(epochS: number, ms: number): string {
  return isoformat(new Date(epochS * 1000 + ms));
}

type Json = Record<string, any>;

describe("TestJsonHelpers", () => {
  it("test_usage_to_json_maps_keys_and_preserves_raw_reset", () => {
    const resetsAt = isoFromNow(4 * HOUR + 30_000);
    const [countdown, clock] = formatReset(resetsAt);
    const usage: UsageDict = {
      five_hour: { pct: 25.0, resets_at: resetsAt, countdown: "4h", clock: "02:00" },
      seven_day: { pct: 16.0 },
      spend: { used: 12.5, limit: 300.0, pct: 4.0, currency: "USD", resets_at: resetsAt },
    };
    const out: Json = usageToJson(usage);
    expect(out.fiveHour).toEqual({ pct: 25.0, resetsAt, countdown, clock });
    expect(out.sevenDay).toEqual({ pct: 16.0 });
    expect(out.spend.used).toBe(12.5);
    expect(out.spend.resetsAt).toBe(resetsAt);
  });

  it("test_usage_to_json_projects_scoped_windows", () => {
    const resetsAt = isoFromNow(3 * HOUR + 30_000);
    const [countdown, clock] = formatReset(resetsAt);
    const usage: UsageDict = {
      five_hour: { pct: 7.0 },
      scoped: [{ name: "Fable", pct: 100.0, resets_at: resetsAt, countdown: "3h", clock: "21:59" }],
    };
    const out: Json = usageToJson(usage);
    expect(out.scoped).toEqual([{ name: "Fable", pct: 100.0, resetsAt, countdown, clock }]);
  });

  it("test_usage_to_json_recomputes_countdown_from_resets_at", () => {
    const resetsAt = isoFromNow(2 * HOUR + 30 * 60_000);
    const usage: UsageDict = {
      seven_day: { pct: 62.0, resets_at: resetsAt, countdown: "17h 0m", clock: "stale-clock" },
    };
    const out: Json = usageToJson(usage);
    expect(out.sevenDay.countdown.startsWith("2h")).toBe(true);
    expect(out.sevenDay.clock).not.toBe("stale-clock");
  });

  it("test_usage_to_json_falls_back_to_cached_strings_without_resets_at", () => {
    const usage: UsageDict = { seven_day: { pct: 62.0, countdown: "17h 0m", clock: "15:59" } };
    const out: Json = usageToJson(usage);
    expect(out.sevenDay).toEqual({ pct: 62.0, countdown: "17h 0m", clock: "15:59" });
  });

  it("test_usage_to_json_falls_back_on_unparseable_resets_at", () => {
    const usage: UsageDict = {
      seven_day: { pct: 62.0, resets_at: "not-a-date", countdown: "17h 0m", clock: "15:59" },
    };
    const out: Json = usageToJson(usage);
    expect(out.sevenDay.countdown).toBe("17h 0m");
    expect(out.sevenDay.clock).toBe("15:59");
  });

  it("test_usage_to_json_recomputes_spend_strings", () => {
    const resetsAt = isoFromNow(2 * HOUR + 30_000);
    const [countdown, clock] = formatReset(resetsAt);
    const usage: UsageDict = {
      spend: {
        used: 1.0,
        limit: 10.0,
        pct: 10.0,
        currency: "USD",
        resets_at: resetsAt,
        countdown: "stale",
        clock: "stale-clock",
      },
    };
    const out: Json = usageToJson(usage);
    expect(out.spend.countdown).toBe(countdown);
    expect(out.spend.clock).toBe(clock);
  });

  it("test_usage_to_json_adds_pace_fields_when_fetched_at_given", () => {
    const now = 1_700_000_000.0;
    const resetsAt = isoFromEpoch(now, 6 * DAY);
    const usage: UsageDict = { seven_day: { pct: 50.0, resets_at: resetsAt } };
    const out: Json = usageToJson(usage, now);
    expect(out.sevenDay.aheadOfPace).toBe(true);
    expect(Math.abs(out.sevenDay.expectedPct - 14.3)).toBeLessThanOrEqual(0.1);
    expect(out.sevenDay).toHaveProperty("projectedExhaustionAt");
    expect(out.sevenDay.willLastToReset).toBe(false);
  });

  it("test_usage_to_json_pace_fields_on_scoped_windows", () => {
    const now = 1_700_000_000.0;
    const resetsAt = isoFromEpoch(now, 6 * DAY);
    const usage: UsageDict = { scoped: [{ name: "Fable", pct: 50.0, resets_at: resetsAt }] };
    const out: Json = usageToJson(usage, now);
    expect(out.scoped[0].aheadOfPace).toBe(true);
  });

  it("test_usage_to_json_five_hour_never_gets_pace_fields", () => {
    const now = 1_700_000_000.0;
    const resetsAt = isoFromEpoch(now, 4 * HOUR);
    const usage: UsageDict = { five_hour: { pct: 90.0, resets_at: resetsAt } };
    const out: Json = usageToJson(usage, now);
    expect(out.fiveHour).not.toHaveProperty("aheadOfPace");
    expect(out.fiveHour).not.toHaveProperty("expectedPct");
  });

  it("test_usage_to_json_no_pace_fields_without_fetched_at", () => {
    const usage: UsageDict = { seven_day: { pct: 50.0, resets_at: isoFromNow(6 * DAY) } };
    const out: Json = usageToJson(usage);
    expect(out.sevenDay).not.toHaveProperty("aheadOfPace");
  });

  it("test_usage_to_json_no_pace_fields_within_suppression_window", () => {
    const now = 1_700_000_000.0;
    const resetsAt = isoFromEpoch(now, 7 * DAY - HOUR);
    const usage: UsageDict = { seven_day: { pct: 50.0, resets_at: resetsAt } };
    const out: Json = usageToJson(usage, now);
    expect(out.sevenDay).not.toHaveProperty("aheadOfPace");
  });

  it("test_usage_fields_variants", () => {
    expect(usageFields({ five_hour: { pct: 1.0 } })[0]).toBe("ok");
    expect(usageFields({ five_hour: { pct: 1.0 } })[1]).toEqual({ fiveHour: { pct: 1.0 } });
    expect(usageFields(USAGE_NO_CREDENTIALS)).toEqual(["no_credentials", null]);
    expect(usageFields("no credentials")).toEqual(["no_credentials", null]);
    expect(usageFields(USAGE_TOKEN_EXPIRED)).toEqual(["token_expired", null]);
    expect(usageFields(USAGE_KEYCHAIN_UNAVAILABLE)).toEqual(["keychain_unavailable", null]);
    expect(usageFields(USAGE_RELOGIN_REQUIRED)).toEqual(["relogin_required", null]);
    expect(usageFields(null)).toEqual(["unavailable", null]);
  });

  it("test_error_envelope_shape", () => {
    const env = errorEnvelope(new SwitchError("boom"));
    expect(env).toEqual({
      schemaVersion: SCHEMA_VERSION,
      error: { type: "SwitchError", message: "boom" },
    });
  });

  it("test_account_row_includes_alias_when_set", () => {
    const row = accountRow(1, "a@x.com", "", "", true, null, { alias: "dev" });
    expect(row.alias).toBe("dev");
  });

  it("test_account_row_omits_alias_when_unset", () => {
    const row = accountRow(1, "a@x.com", "", "", true, null);
    expect(row).not.toHaveProperty("alias");
  });

  it("test_account_row_includes_login_expiry_when_known", () => {
    const row = accountRow(1, "a@x.com", "", "", true, null, { loginExpiresAt: "2026-10-08T01:06:36Z" });
    expect(row.loginExpiresAt).toBe("2026-10-08T01:06:36Z");
  });

  it("test_account_row_omits_login_expiry_when_unknown", () => {
    expect(accountRow(1, "a@x.com", "", "", true, null)).not.toHaveProperty("loginExpiresAt");
  });
});

function capsys(): { readouterr: () => { out: string; err: string } } {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
  return {
    readouterr: () => {
      const result = { out, err };
      out = "";
      err = "";
      return result;
    },
  };
}

interface SequenceFixture {
  accounts: Record<string, Record<string, unknown>>;
}

/** `sample_sequence_data` with account 1 on the live email of `mock_claude_config`. */
function liveSequenceData(alias?: string): SequenceFixture {
  const data: SequenceFixture = sampleSequenceData();
  data.accounts["1"] = { ...data.accounts["1"], email: "test@example.com", ...(alias === undefined ? {} : { alias }) };
  return data;
}

function seededSwitcher(data: unknown): ClaudeAccountSwitcher {
  const switcher = new ClaudeAccountSwitcher();
  switcher.setupDirectories();
  switcher.writeJson(switcher.sequenceFile, data);
  return switcher;
}

const ACTIVE_CREDS = JSON.stringify({ claudeAiOauth: { accessToken: "sk-active" } });

function stubActive(switcher: ClaudeAccountSwitcher): void {
  vi.spyOn(switcher, "readActiveCredentials").mockReturnValue(activeCredentials(ACTIVE_CREDS, false));
}

function stubUsage(outcome: UsageOutcome): void {
  vi.spyOn(switcherInternals, "tryFetchUsageForAccount").mockResolvedValue(outcome);
}

describe("TestListJson", () => {
  it("test_empty_list_no_prompt", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const firstRun = vi.spyOn(switcher, "firstRunSetup").mockResolvedValue(undefined);
    const fakeInput = vi.spyOn(switcherInternals, "input").mockReturnValue("");

    const payload = await switcher.listAccounts(false, true);

    expect(firstRun).not.toHaveBeenCalled();
    expect(fakeInput).not.toHaveBeenCalled();
    expect(payload).toEqual({ schemaVersion: SCHEMA_VERSION, activeAccountNumber: null, accounts: [] });
  });

  it("test_list_payload", async () => {
    mockClaudeConfig();
    const capture = capsys();
    const backupCreds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-backup" } });
    const usage = { five_hour: { pct: 10.0, resets_at: "2026-01-01T00:00:00Z", countdown: "1h", clock: "01:00" } };
    const switcher = seededSwitcher(liveSequenceData());
    stubActive(switcher);
    vi.spyOn(switcher, "readAccountCredentials").mockReturnValue(backupCreds);
    stubUsage(usageOutcome(usage as unknown as UsageDict));

    const payload = (await switcher.listAccounts(false, true)) as Json;

    // The method prints nothing. The CLI serializes.
    expect(capture.readouterr().out).toBe("");
    expect(payload.schemaVersion).toBe(SCHEMA_VERSION);
    expect(payload.activeAccountNumber).toBe(1);
    const acct1 = (payload.accounts as Json[]).find((a) => a.number === 1) as Json;
    expect(acct1.active).toBe(true);
    expect(acct1.usageStatus).toBe("ok");
    expect(acct1.usage.fiveHour.resetsAt).toBe("2026-01-01T00:00:00Z");
  });

  it("test_list_payload_includes_alias", async () => {
    mockClaudeConfig();
    const switcher = seededSwitcher(liveSequenceData("dev"));
    stubActive(switcher);
    vi.spyOn(switcher, "readAccountCredentials").mockReturnValue("");
    stubUsage(usageOutcome(null));

    const payload = (await switcher.listAccounts(false, true)) as Json;

    const byNum = Object.fromEntries((payload.accounts as Json[]).map((a) => [a.number, a]));
    expect(byNum[1].alias).toBe("dev");
    expect(byNum[2]).not.toHaveProperty("alias");
  });

  it("test_list_payload_reports_login_expiry_from_the_stored_credential", async () => {
    mockClaudeConfig();
    const backupCreds = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-backup", refreshTokenExpiresAt: 1791421596865 },
    });
    const switcher = seededSwitcher(liveSequenceData());
    stubActive(switcher);
    vi.spyOn(switcher, "readAccountCredentials").mockReturnValue(backupCreds);
    stubUsage(usageOutcome(null));

    const payload = (await switcher.listAccounts(false, true)) as Json;

    const byNum = Object.fromEntries((payload.accounts as Json[]).map((a) => [a.number, a]));
    expect(byNum[1]).not.toHaveProperty("loginExpiresAt");
    expect(byNum[2].loginExpiresAt).toBe("2026-10-08T01:06:36Z");
  });

  it("test_usage_status_no_credentials_and_unavailable", async () => {
    mockClaudeConfig();
    const switcher = seededSwitcher(liveSequenceData());
    // Account 1 is active with creds but the fetch fails. Account 2 has no backup creds.
    stubActive(switcher);
    vi.spyOn(switcher, "readAccountCredentials").mockReturnValue("");
    stubUsage(usageOutcome(null));

    const payload = (await switcher.listAccounts(false, true)) as Json;

    const byNum = Object.fromEntries((payload.accounts as Json[]).map((a) => [a.number, a]));
    expect(byNum[1].usageStatus).toBe("unavailable");
    expect(byNum[1].usage).toBeNull();
    expect(byNum[2].usageStatus).toBe("no_credentials");
  });

  it.each([
    [100.0, "ok"],
    [400.0, "ok"],
    [4000.0, "unavailable"],
  ])("test_stale_usage_is_decision_gated_in_json[%s-%s]", async (ageS, expectedStatus) => {
    mockClaudeConfig();
    const switcher = seededSwitcher(liveSequenceData());
    const backdated = new UsageStore(path.join(switcher.backupDir, "cache"), () => Date.now() / 1000 - ageS);
    backdated.record({ "1": { usage: { five_hour: { pct: 25.0 } } as unknown as UsageDict } }, {
      "1": ["test@example.com", ""],
    });

    // The stale entry is due for a refetch, but the fetch fails. The store serves the old measurement.
    stubActive(switcher);
    vi.spyOn(switcher, "readAccountCredentials").mockReturnValue("");
    stubUsage(usageOutcome(null, { error: "timeout" }));

    const payload = (await switcher.listAccounts(false, true)) as Json;

    const row = (payload.accounts as Json[]).find((a) => a.number === 1) as Json;
    expect(row.usageStatus).toBe(expectedStatus);
    if (expectedStatus === "ok") {
      expect(row.usage.fiveHour.pct).toBe(25.0);
      expect(row.usageAgeSeconds).toBeGreaterThanOrEqual(ageS);
      expect(row).not.toHaveProperty("lastGoodUsage");
    } else {
      expect(row.usage).toBeNull();
      expect(row).not.toHaveProperty("usageFetchedAt");
      expect(row.lastGoodUsage.fiveHour.pct).toBe(25.0);
      expect(row.lastGoodAgeSeconds).toBeGreaterThanOrEqual(ageS);
      expect(row.lastGoodFetchedAt.endsWith("Z")).toBe(true);
      expect(row.usageError).toBe("timeout");
      expect(row.usageRetryAt.endsWith("Z")).toBe(true);
    }
  });
});

describe("TestStatusJson", () => {
  it("test_status_no_active", async () => {
    const switcher = new ClaudeAccountSwitcher();
    expect(await switcher.status(true)).toEqual({ schemaVersion: SCHEMA_VERSION, active: null });
  });

  it("test_status_unmanaged", async () => {
    mockClaudeConfig();
    const switcher = new ClaudeAccountSwitcher();
    const payload = (await switcher.status(true)) as Json;
    expect(payload.active).toEqual({ email: "test@example.com", managed: false });
  });

  it("test_status_managed", async () => {
    mockClaudeConfig();
    const capture = capsys();
    const usage = { five_hour: { pct: 25.0, resets_at: "2026-01-01T00:00:00Z", countdown: "1h", clock: "01:00" } };
    const switcher = seededSwitcher(liveSequenceData());
    stubActive(switcher);
    stubUsage(usageOutcome(usage as unknown as UsageDict));

    const payload = (await switcher.status(true)) as Json;

    expect(capture.readouterr().out).toBe("");
    const active = payload.active as Json;
    expect(active.number).toBe(1);
    expect(active.managed).toBe(true);
    expect(active.usageStatus).toBe("ok");
    expect(active.usage.fiveHour.resetsAt).toBe("2026-01-01T00:00:00Z");
    expect(payload.totalManagedAccounts).toBe(2);
  });

  it("test_status_managed_includes_display_grade_last_good", async () => {
    mockClaudeConfig();
    const switcher = seededSwitcher(liveSequenceData());
    const now = Date.now() / 1000;
    const entry = new UsageEntry({
      lastGood: { five_hour: { pct: 25.0 } } as unknown as UsageDict,
      fetchedAt: now - 4000,
      ageS: 4000.0,
      lastError: "http-429",
      backoffUntil: now + 3600,
    });
    stubActive(switcher);
    vi.spyOn(switcher, "activeAccountUsage").mockResolvedValue(entry);

    const payload = (await switcher.status(true)) as Json;

    const active = payload.active as Json;
    expect(active.usageStatus).toBe("unavailable");
    expect(active.usage).toBeNull();
    expect(active.lastGoodUsage.fiveHour.pct).toBe(25.0);
    expect(active.lastGoodAgeSeconds).toBe(4000.0);
    expect(active.usageError).toBe("http-429");
    expect(active.usageRetryAt.endsWith("Z")).toBe(true);
  });

  it("test_status_managed_includes_alias", async () => {
    mockClaudeConfig();
    const switcher = seededSwitcher(liveSequenceData("dev"));
    stubActive(switcher);
    stubUsage(usageOutcome(null));

    const payload = (await switcher.status(true)) as Json;

    expect((payload.active as Json).alias).toBe("dev");
  });
});

type Store = Map<string, string>;

function key(num: string | number, email: string): string {
  return `${num}|${email}`;
}

/** A switcher with accounts 1 (active) and 2, on in-memory credential and config stores. */
function twoAccountStores(): [ClaudeAccountSwitcher, Store, Store, { creds: string }] {
  const switcher = new ClaudeAccountSwitcher();
  switcher.setupDirectories();
  switcher.platform = Platform.LINUX;
  switcher.writeJson(switcher.sequenceFile, liveSequenceData());

  const liveCreds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-1", refreshToken: "rt-1" } });
  fs.writeFileSync(path.join(testHome(), ".claude", ".credentials.json"), liveCreds);

  const credsStore: Store = new Map([
    [key(1, "test@example.com"), liveCreds],
    [key(2, "account2@example.com"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-2", refreshToken: "rt-2" } })],
  ]);
  const configsStore: Store = new Map([
    [
      key(1, "test@example.com"),
      JSON.stringify({ oauthAccount: { emailAddress: "test@example.com", accountUuid: "test-uuid-1234" } }),
    ],
    [
      key(2, "account2@example.com"),
      JSON.stringify({ oauthAccount: { emailAddress: "account2@example.com", accountUuid: "uuid-2" } }),
    ],
  ]);
  return [switcher, credsStore, configsStore, { creds: liveCreds }];
}

function installPatches(switcher: ClaudeAccountSwitcher, creds: Store, configs: Store, live: { creds: string }): void {
  vi.spyOn(switcher, "readAccountCredentials").mockImplementation((n, e) => creds.get(key(n, e)) ?? "");
  // The strict reader answers from the same double. Otherwise it reads the real (empty) store.
  vi.spyOn(switcher, "readAccountCredentialsEx").mockImplementation((n, e) => [creds.get(key(n, e)) ?? "", false]);
  vi.spyOn(switcher, "writeAccountCredentials").mockImplementation((n, e, c) => {
    creds.set(key(n, e), c);
  });
  vi.spyOn(switcher, "readAccountConfig").mockImplementation((n, e) => configs.get(key(n, e)) ?? "");
  vi.spyOn(switcher, "writeAccountConfig").mockImplementation((n, e, c) => {
    configs.set(key(n, e), c);
  });
  vi.spyOn(switcher, "readCredentials").mockImplementation(() => live.creds ?? "");
  vi.spyOn(switcher, "writeCredentials").mockImplementation((c) => {
    live.creds = c;
  });
  // No network call from the post-switch usage path.
  stubUsage(usageOutcome(null));
}

describe("TestSwitchJson", () => {
  it("test_switch_to_result_no_leakage", async () => {
    mockClaudeConfig();
    const capture = capsys();
    const [switcher, creds, configs, live] = twoAccountStores();
    installPatches(switcher, creds, configs, live);

    const result = (await switcher.switchTo("2", true)) as Json;

    // No human output on stdout. The method only returns the dict.
    expect(capture.readouterr().out).toBe("");
    expect(result.switched).toBe(true);
    expect(result.strategy).toBe("direct");
    expect(result.reason).toBe("switched");
    expect(result.from).toEqual({ number: 1, email: "test@example.com" });
    expect(result.to).toEqual({ number: 2, email: "account2@example.com" });
    expect(result.warnings).toEqual([]);
  });

  it("test_switch_to_already_active_short_circuits", async () => {
    mockClaudeConfig();
    const [switcher, creds, configs, live] = twoAccountStores();
    installPatches(switcher, creds, configs, live);
    const perform = vi.spyOn(switcher, "performSwitch");

    const result = (await switcher.switchTo("1", true)) as Json;

    expect(perform).not.toHaveBeenCalled();
    expect(result.switched).toBe(false);
    expect(result.reason).toBe("already-active");
    expect(result.from).toEqual({ number: 1, email: "test@example.com" });
    expect(result.to).toEqual(result.from);
  });

  it("test_switch_to_force_self_activation_reports_activated", async () => {
    mockClaudeConfig();
    const capture = capsys();
    const [switcher, creds, configs, live] = twoAccountStores();
    creds.set(
      key(1, "test@example.com"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-imported-1", refreshToken: "rt-imported-1" } }),
    );
    installPatches(switcher, creds, configs, live);

    const result = (await switcher.switchTo("1", true, true)) as Json;

    expect(capture.readouterr().out).toBe("");
    expect(result.switched).toBe(false);
    expect(result.reason).toBe("activated");
    expect(result.from).toEqual({ number: 1, email: "test@example.com" });
    expect(result.to).toEqual(result.from);
    expect(result.message.startsWith("Activated Account-1")).toBe(true);
    // The live login was rewritten from the stored backup.
    expect(JSON.parse(live.creds).claudeAiOauth.accessToken).toBe("sk-imported-1");
  });

  it("test_switch_to_force_cross_slot_reports_switched", async () => {
    mockClaudeConfig();
    const capture = capsys();
    const [switcher, creds, configs, live] = twoAccountStores();
    const slot1Before = creds.get(key(1, "test@example.com"));
    installPatches(switcher, creds, configs, live);

    const result = (await switcher.switchTo("2", true, true)) as Json;

    expect(capture.readouterr().out).toBe("");
    expect(result.switched).toBe(true);
    expect(result.reason).toBe("switched");
    expect(result.from).toEqual({ number: 1, email: "test@example.com" });
    expect(result.to).toEqual({ number: 2, email: "account2@example.com" });
    // The backup of the current account was skipped: the creds of slot 1 did not change.
    expect(creds.get(key(1, "test@example.com"))).toBe(slot1Before);
  });

  it("test_noop_from_equals_to", async () => {
    mockClaudeConfig();
    const switcher = seededSwitcher(SINGLE_ACCOUNT());

    const result = (await switcher.switch(undefined, true)) as Json;

    expect(result.switched).toBe(false);
    expect(result.from).toEqual({ number: 1, email: "test@example.com" });
    expect(result.to).toEqual(result.from);
  });

  it("test_switch_to_from_unmanaged_account", async () => {
    mockClaudeConfig();
    // The managed accounts have other emails. The live account (test@example.com) is not one of them.
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.platform = Platform.LINUX;
    switcher.writeJson(switcher.sequenceFile, sampleSequenceData());
    const liveCreds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-x" } });
    fs.writeFileSync(path.join(testHome(), ".claude", ".credentials.json"), liveCreds);
    const creds: Store = new Map([[key(2, "account2@example.com"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-2" } })]]);
    const configs: Store = new Map([
      [
        key(2, "account2@example.com"),
        JSON.stringify({ oauthAccount: { emailAddress: "account2@example.com", accountUuid: "uuid-2" } }),
      ],
    ]);
    installPatches(switcher, creds, configs, { creds: liveCreds });

    const result = (await switcher.switchTo("2", true)) as Json;

    expect(result.switched).toBe(true);
    expect(result.from).toEqual({ number: null, email: "test@example.com" });
    expect(result.to.number).toBe(2);
  });

  it("test_switch_to_ambiguous_email_raises", async () => {
    mockClaudeConfig();
    const switcher = seededSwitcher(sampleSequenceDataWithOrg());
    const fakeInput = vi.spyOn(switcherInternals, "input").mockReturnValue("");

    const op = switcher.switchTo("user@example.com", true);
    await expect(op).rejects.toThrow(ConfigError);
    await expect(op).rejects.toThrow(/ambiguous/);
    expect(fakeInput).not.toHaveBeenCalled();
  });

  it("test_switch_only_one_account", async () => {
    mockClaudeConfig();
    const switcher = seededSwitcher(SINGLE_ACCOUNT());

    const result = (await switcher.switch(undefined, true)) as Json;

    expect(result.switched).toBe(false);
    expect(result.reason).toBe("only-one-account");
  });

  it("test_switch_unmanaged_account_is_noop_without_add", async () => {
    mockClaudeConfig();
    // The live account (test@example.com) is not in the managed set.
    const switcher = seededSwitcher(sampleSequenceData());
    const add = vi.spyOn(switcher, "addAccount");

    const result = (await switcher.switch(undefined, true)) as Json;

    expect(add).not.toHaveBeenCalled();
    expect(result.switched).toBe(false);
    expect(result.reason).toBe("unmanaged-account");
    expect(result.from).toEqual({ number: null, email: "test@example.com" });
  });
});

function SINGLE_ACCOUNT() {
  return {
    activeAccountNumber: 1,
    lastUpdated: "2024-01-01T00:00:00Z",
    sequence: [1],
    accounts: { "1": { email: "test@example.com", uuid: "u1", added: "2024-01-01T00:00:00Z" } },
  };
}

describe("TestAccountRowFailure", () => {
  it("test_unavailable_row_names_its_failure_and_retry", () => {
    const row = accountRow(2, "b@example.com", "", "", false, null, {
      lastError: "http-429",
      backoffUntil: 1_800_000_000.0,
    });
    expect(row.usageStatus).toBe("unavailable");
    expect(row.usageError).toBe("http-429");
    expect(row.usageRetryAt).toBe("2027-01-15T08:00:00Z");
  });

  it("test_lapsed_backoff_leaves_only_the_error", () => {
    const row = accountRow(2, "b@example.com", "", "", false, null, { lastError: "timeout" });
    expect(row.usageError).toBe("timeout");
    expect(row).not.toHaveProperty("usageRetryAt");
  });

  it("test_no_failure_adds_nothing", () => {
    const row = accountRow(2, "b@example.com", "", "", false, null);
    expect(row).not.toHaveProperty("usageError");
    expect(row).not.toHaveProperty("usageRetryAt");
  });

  it.each([{ five_hour: { pct: 5.0 } }, USAGE_TOKEN_EXPIRED, USAGE_NO_CREDENTIALS])(
    "test_explained_rows_do_not_repeat_an_old_failure",
    (entry) => {
      const row = accountRow(2, "b@example.com", "", "", false, entry, {
        usageFetchedAt: 1_800_000_000.0,
        lastError: "http-429",
        backoffUntil: 1_800_000_000.0,
      });
      expect(row).not.toHaveProperty("usageError");
      expect(row).not.toHaveProperty("usageRetryAt");
    },
  );
});

describe("TestAccountRowDisabled", () => {
  it("test_disabled_true_included", () => {
    const row = accountRow(2, "b@example.com", "", "", false, null, { disabled: true });
    expect(row.disabled).toBe(true);
  });

  it("test_disabled_absent_by_default", () => {
    const row = accountRow(1, "a@example.com", "", "", false, null);
    expect(row).not.toHaveProperty("disabled");
  });
});

describe("TestUsageFromJson", () => {
  const INTERNAL: UsageDict = {
    five_hour: { pct: 12.0, resets_at: "2099-01-01T05:00:00+00:00" },
    seven_day: { pct: 40.0, resets_at: "2099-01-07T00:00:00+00:00" },
    spend: { used: 5.0, limit: 50.0, pct: 10.0, currency: "USD", resets_at: "2099-02-01T00:00:00+00:00" },
    scoped: [{ name: "Fable", pct: 30.0, resets_at: "2099-01-07T00:00:00+00:00" }],
  };

  it("test_round_trips_what_the_api_measured", () => {
    const back = usageFromJson(usageToJson(INTERNAL, Date.now() / 1000));
    const windows = [back.five_hour!, back.seven_day!, back.spend!, back.scoped![0]!];
    for (const window of windows) {
      expect(window.countdown).toBeTruthy();
      expect(window.clock).toBeTruthy();
      delete window.countdown;
      delete window.clock;
    }
    expect(back).toEqual(INTERNAL);
  });

  it("test_a_window_without_a_reset_keeps_its_pct", () => {
    expect(usageFromJson({ fiveHour: { pct: 3 } })).toEqual({ five_hour: { pct: 3.0 } });
  });

  it.each([
    [null],
    [{}],
    [{ fiveHour: { pct: "12" } }],
    [{ fiveHour: { pct: -1 } }],
    [{ fiveHour: { pct: Number.NaN } }],
    [{ fiveHour: { pct: true } }],
    [{ sevenDay: { pct: 1, resetsAt: "next tuesday" } }],
    [{ spend: { pct: 1, used: 1, currency: "USD" } }],
    [{ scoped: [{ pct: 1 }] }],
    [{ scoped: { name: "Fable", pct: 1 } }],
  ])("test_malformed_usage_is_refused", (usage) => {
    expect(() => usageFromJson(usage)).toThrow(RangeError);
  });
});
