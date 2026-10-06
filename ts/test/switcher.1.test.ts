import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeCredentials } from "../src/credentials.js";
import { AccountNotFoundError, ConfigError, SessionError, ValidationError } from "../src/exceptions.js";
import { USAGE_TOKEN_EXPIRED } from "../src/json_output.js";
import { Platform, internals as modelsInternals, normalizeAlias } from "../src/models.js";
import * as oauth from "../src/oauth.js";
import * as pollPolicy from "../src/poll_policy.js";
import * as session from "../src/session.js";
import { type AccountInfoRow, ClaudeAccountSwitcher, internals } from "../src/switcher.js";
import { type FetchRecord, UsageStore } from "../src/usage_store.js";
import { mockClaudeConfig, sampleSequenceData } from "./helpers/fixtures.js";
import { testHome } from "./helpers/home.js";
import { jsonResponse, mockFetch } from "./helpers/oauth.js";

vi.mock("../src/session.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/session.js")>();
  return {
    ...real,
    readSessionCredentials: vi.fn(real.readSessionCredentials),
    sessionIdentityDrifted: vi.fn(real.sessionIdentityDrifted),
  };
});

type SequenceFixture = Omit<ReturnType<typeof sampleSequenceData>, "accounts"> & {
  accounts: Record<string, Record<string, unknown>>;
};

function sequenceData(): SequenceFixture {
  return sampleSequenceData() as SequenceFixture;
}

/** Credential JSON with an access token that expires `expiresInS` seconds from now. */
function oauthCreds(token: string, expiresInS: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: `rt-${token}`,
      expiresAt: Math.trunc((Date.now() / 1000 + expiresInS) * 1000),
    },
  });
}

const nowS = (): number => Date.now() / 1000;

let stdout: string[];

function capturedOut(): string {
  const text = stdout.join("");
  stdout = [];
  return text;
}

function spyFetch(outcome: oauth.UsageOutcome = oauth.usageOutcome(null)) {
  return vi.spyOn(internals, "tryFetchUsageForAccount").mockResolvedValue(outcome);
}

function writeSequence(switcher: ClaudeAccountSwitcher, data: unknown): void {
  switcher.setupDirectories();
  switcher.writeJson(switcher.sequenceFile, data);
}

beforeEach(() => {
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  internals.FETCH_STAGGER_S = 0;
});

afterEach(() => {
  internals.FETCH_STAGGER_S = 0.25;
  vi.mocked(session.readSessionCredentials).mockReset();
  vi.mocked(session.sessionIdentityDrifted).mockReset();
});

describe("TestEmailValidation", () => {
  it("test_valid_emails", () => {
    const switcher = new ClaudeAccountSwitcher();
    for (const email of ["user@example.com", "user.name@example.co.uk", "user+tag@example.org", "user123@test.io"]) {
      expect(switcher.validateEmail(email), `Expected ${email} to be valid`).toBe(true);
    }
  });

  it("test_invalid_emails", () => {
    const switcher = new ClaudeAccountSwitcher();
    for (const email of ["not-an-email", "@example.com", "user@", "user@.com", "", "user@com"]) {
      expect(switcher.validateEmail(email), `Expected ${email} to be invalid`).toBe(false);
    }
  });
});

describe("TestFindAccountSlot", () => {
  const DATA = {
    accounts: {
      "1": { email: "user@example.com", organizationUuid: "" },
      "2": { email: "user@example.com", organizationUuid: "org-123" },
      "3": { email: "other@example.com" },
    },
  };

  it("test_matches_composite_identity", () => {
    expect(ClaudeAccountSwitcher.findAccountSlot(DATA, "user@example.com", "org-123")).toBe("2");
  });

  it("test_same_email_wrong_org_is_no_match", () => {
    expect(ClaudeAccountSwitcher.findAccountSlot(DATA, "user@example.com", "org-999")).toBeNull();
  });

  it("test_absent_email_is_no_match", () => {
    expect(ClaudeAccountSwitcher.findAccountSlot(DATA, "nobody@example.com", "")).toBeNull();
  });

  it("test_empty_org_matches_missing_or_empty_org_field", () => {
    expect(ClaudeAccountSwitcher.findAccountSlot(DATA, "user@example.com", "")).toBe("1");
    expect(ClaudeAccountSwitcher.findAccountSlot(DATA, "other@example.com", "")).toBe("3");
  });

  it("test_empty_data_is_no_match", () => {
    expect(ClaudeAccountSwitcher.findAccountSlot({}, "user@example.com", "")).toBeNull();
  });
});

describe("TestPlatformDetection", () => {
  it("test_macos_detection", () => {
    vi.spyOn(modelsInternals, "sysPlatform").mockReturnValue("darwin");
    expect(Platform.detect()).toBe(Platform.MACOS);
  });

  it("test_linux_detection", () => {
    vi.spyOn(modelsInternals, "sysPlatform").mockReturnValue("linux");
    vi.stubEnv("WSL_DISTRO_NAME", undefined);
    expect(Platform.detect()).toBe(Platform.LINUX);
  });

  it("test_wsl_detection", () => {
    vi.spyOn(modelsInternals, "sysPlatform").mockReturnValue("linux");
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    expect(Platform.detect()).toBe(Platform.WSL);
  });

  it("test_windows_detection", () => {
    vi.spyOn(modelsInternals, "sysPlatform").mockReturnValue("win32");
    expect(Platform.detect()).toBe(Platform.WINDOWS);
  });

  it("test_unknown_platform", () => {
    vi.spyOn(modelsInternals, "sysPlatform").mockReturnValue("freebsd");
    expect(Platform.detect()).toBe(Platform.UNKNOWN);
  });
});

describe("TestJsonOperations", () => {
  it("test_write_and_read_json", () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    const testPath = path.join(switcher.backupDir, "test.json");
    const testData = { key: "value", number: 42, nested: { a: 1 } };

    switcher.writeJson(testPath, testData);

    expect(switcher.readJson(testPath)).toEqual(testData);
  });

  it("test_read_nonexistent_json", () => {
    const switcher = new ClaudeAccountSwitcher();
    expect(switcher.readJson("/nonexistent/path.json")).toBeNull();
  });

  it("test_read_invalid_json", () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    const testPath = path.join(switcher.backupDir, "invalid.json");
    fs.writeFileSync(testPath, "not valid json {{{");

    expect(switcher.readJson(testPath)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("test_json_file_permissions", () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    const testPath = path.join(switcher.backupDir, "secure.json");

    switcher.writeJson(testPath, { secret: "data" });

    expect(fs.statSync(testPath).mode & 0o777).toBe(0o600);
  });
});

describe("TestGetCurrentAccount", () => {
  it("test_no_config_file", () => {
    expect(new ClaudeAccountSwitcher().getCurrentAccount()).toBeNull();
  });

  it("test_with_valid_config", () => {
    mockClaudeConfig();
    expect(new ClaudeAccountSwitcher().getCurrentAccount()).toEqual(["test@example.com", ""]);
  });

  it("test_config_without_oauth", () => {
    fs.writeFileSync(path.join(testHome(), ".claude.json"), JSON.stringify({ other: "data" }));
    expect(new ClaudeAccountSwitcher().getCurrentAccount()).toBeNull();
  });

  it("test_config_with_empty_email", () => {
    fs.writeFileSync(
      path.join(testHome(), ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "", accountUuid: "uuid" } }),
    );
    expect(new ClaudeAccountSwitcher().getCurrentAccount()).toBeNull();
  });
});

describe("TestGetClaudeConfigPathUtf8", () => {
  it("test_fallback_config_with_unicode_punctuation", () => {
    const config = {
      oauthAccount: {
        emailAddress: "user@example.com",
        accountUuid: "uuid-1",
        displayName: "Name with “smart” quotes",
      },
    };
    const fallback = path.join(testHome(), ".claude.json");
    fs.writeFileSync(fallback, JSON.stringify(config), "utf8");

    expect(new ClaudeAccountSwitcher().getClaudeConfigPath()).toBe(fallback);
  });
});

describe("TestAccountExists", () => {
  it("test_account_exists", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    expect(switcher.accountExists("account1@example.com", "")).toBe(true);
    expect(switcher.accountExists("nonexistent@example.com", "")).toBe(false);
  });

  it("test_no_sequence_file", () => {
    expect(new ClaudeAccountSwitcher().accountExists("any@example.com", "")).toBe(false);
  });
});

describe("TestResolveAccountIdentifier", () => {
  it("test_resolve_by_number", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    expect(switcher.resolveAccountIdentifier("1")).toBe("1");
    expect(switcher.resolveAccountIdentifier("2")).toBe("2");
  });

  it("test_resolve_by_email", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    expect(switcher.resolveAccountIdentifier("account1@example.com")).toBe("1");
    expect(switcher.resolveAccountIdentifier("account2@example.com")).toBe("2");
  });

  it("test_resolve_nonexistent", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    expect(switcher.resolveAccountIdentifier("nonexistent@example.com")).toBeNull();
    expect(switcher.resolveAccountIdentifier("999")).toBe("999");
  });
});

describe("TestAliasValidation", () => {
  it("test_valid_aliases", () => {
    for (const alias of ["dev", "work-1", "client_a", "team.b", "DEV"]) normalizeAlias(alias);
  });

  it("test_invalid_aliases", () => {
    for (const alias of ["123", "dev@work", "dev work", "", "dev/work", "-dev"]) {
      expect(() => normalizeAlias(alias)).toThrow(RangeError);
    }
  });
});

describe("TestResolveByAlias", () => {
  it("test_empty_identifier_never_matches_aliasless_account", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    expect(switcher.findAccountByAlias("")).toBeNull();
    expect(switcher.resolveAccountIdentifier("")).toBeNull();
  });

  it("test_resolve_by_alias", () => {
    const data = sequenceData();
    data.accounts["2"]!.alias = "dev";
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, data);

    expect(switcher.resolveAccountIdentifier("dev")).toBe("2");
  });

  it("test_resolve_by_alias_case_insensitive", () => {
    const data = sequenceData();
    data.accounts["2"]!.alias = "dev";
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, data);

    expect(switcher.resolveAccountIdentifier("DEV")).toBe("2");
  });

  it("test_number_takes_precedence_over_alias", () => {
    const data = sequenceData();
    data.accounts["2"]!.alias = "dev";
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, data);

    expect(switcher.resolveAccountIdentifier("1")).toBe("1");
  });

  it("test_alias_takes_precedence_over_unrelated_email", () => {
    const data = sequenceData();
    data.accounts["2"]!.alias = "dev";
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, data);

    expect(switcher.resolveAccountIdentifier("account1@example.com")).toBe("1");
    expect(switcher.resolveAccountIdentifier("dev")).toBe("2");
  });

  it("test_resolve_account_public_wrapper_supports_alias", () => {
    const data = sequenceData();
    data.accounts["2"]!.alias = "dev";
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, data);

    const [num, email] = switcher.resolveAccount("dev");
    expect(num).toBe("2");
    expect(email).toBe("account2@example.com");
  });
});

describe("TestAliasCommand", () => {
  it("test_set_alias_by_number", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    const [num, normalized] = switcher.setAlias("2", "dev");

    expect(num).toBe("2");
    expect(normalized).toBe("dev");
    expect(switcher.getSequenceData()!.accounts!["2"]!.alias).toBe("dev");
  });

  it("test_set_alias_normalizes_to_lowercase", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    const [, normalized] = switcher.setAlias("2", "DEV");

    expect(normalized).toBe("dev");
    expect(switcher.getSequenceData()!.accounts!["2"]!.alias).toBe("dev");
  });

  it("test_set_alias_by_email", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    const [num] = switcher.setAlias("account2@example.com", "dev");

    expect(num).toBe("2");
    expect(switcher.getSequenceData()!.accounts!["2"]!.alias).toBe("dev");
  });

  it("test_rename_via_existing_alias_identifier", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());
    switcher.setAlias("1", "dev");

    const [num, normalized] = switcher.setAlias("dev", "prod");

    expect(num).toBe("1");
    expect(normalized).toBe("prod");
    expect(switcher.resolveAccountIdentifier("prod")).toBe("1");
    expect(switcher.resolveAccountIdentifier("dev")).toBeNull();
  });

  it("test_set_invalid_alias_raises", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    expect(() => switcher.setAlias("2", "123")).toThrow(ValidationError);
  });

  it("test_set_duplicate_alias_raises", () => {
    const data = sequenceData();
    data.accounts["1"]!.alias = "dev";
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, data);

    expect(() => switcher.setAlias("2", "dev")).toThrow(ConfigError);
  });

  it("test_unset_alias", () => {
    const data = sequenceData();
    data.accounts["2"]!.alias = "dev";
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, data);

    const num = switcher.unsetAlias("2");

    expect(num).toBe("2");
    expect(switcher.getSequenceData()!.accounts!["2"]).not.toHaveProperty("alias");
  });

  it("test_unset_alias_idempotent", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    switcher.unsetAlias("2");
    switcher.unsetAlias("2");
  });

  it("test_alias_unknown_account_raises", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    expect(() => switcher.setAlias("999", "dev")).toThrow(AccountNotFoundError);
  });

  it("test_list_aliases", () => {
    const data = sequenceData();
    data.accounts["2"]!.alias = "dev";
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, data);

    expect(switcher.listAliases()).toEqual([["2", "dev", "account2@example.com"]]);
  });

  it("test_list_aliases_sequence_order", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());
    switcher.setAlias("2", "content");
    switcher.setAlias("1", "dev");

    expect(switcher.listAliases()).toEqual([
      ["1", "dev", "account1@example.com"],
      ["2", "content", "account2@example.com"],
    ]);
  });

  it("test_list_aliases_empty", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    expect(switcher.listAliases()).toEqual([]);
  });
});

describe("TestDirectorySetup", () => {
  it("test_creates_directories", () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();

    expect(fs.existsSync(switcher.backupDir)).toBe(true);
    expect(fs.existsSync(switcher.configsDir)).toBe(true);
    expect(fs.existsSync(switcher.credentialsDir)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("test_directory_permissions", () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();

    for (const directory of [switcher.backupDir, switcher.configsDir, switcher.credentialsDir]) {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
  });
});

describe("TestAddAccountRefresh", () => {
  it("test_readd_existing_account_updates_credentials", async () => {
    mockClaudeConfig();
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.initSequenceFile();

    const oldCreds = JSON.stringify({ claudeAiOauth: { accessToken: "old-token" } });
    const newCreds = JSON.stringify({ claudeAiOauth: { accessToken: "new-token" } });
    const stored: { creds?: string } = {};
    const writeCreds = vi.spyOn(switcher, "writeAccountCredentials").mockImplementation((_num, _email, creds) => {
      stored.creds = creds;
    });

    const readActive = vi.spyOn(switcher, "readActiveCredentials").mockReturnValue(activeCredentials(oldCreds, false));
    await switcher.addAccount();

    let data = switcher.getSequenceData()!;
    expect(Object.keys(data.accounts!)).toHaveLength(1);
    expect(data.accounts!["1"]!.email).toBe("test@example.com");
    expect(stored.creds).toContain("old-token");

    readActive.mockReturnValue(activeCredentials(newCreds, false));
    await switcher.addAccount();

    data = switcher.getSequenceData()!;
    expect(Object.keys(data.accounts!)).toHaveLength(1);
    expect(data.sequence).toHaveLength(1);
    expect(capturedOut()).toContain("Updated credentials");
    expect(stored.creds).toContain("new-token");
    expect(writeCreds).toHaveBeenCalledTimes(2);
  });
});

describe("TestGetNextAccountNumber", () => {
  it("test_first_account", () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.initSequenceFile();

    expect(switcher.getNextAccountNumber()).toBe(1);
  });

  it("test_with_existing_accounts", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    expect(switcher.getNextAccountNumber()).toBe(3);
  });
});

describe("TestStatus", () => {
  it("test_status_no_account", async () => {
    await new ClaudeAccountSwitcher().status();
  });

  it("test_status_unmanaged_account", async () => {
    mockClaudeConfig();
    await new ClaudeAccountSwitcher().status();
  });

  it("test_status_managed_account", async () => {
    mockClaudeConfig();
    const data = sequenceData();
    data.accounts["1"]!.email = "test@example.com";
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, data);

    await switcher.status();
  });
});

describe("TestStatusCache", () => {
  const activeCreds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-active" } });

  function managedSwitcher(): ClaudeAccountSwitcher {
    mockClaudeConfig();
    const data = sequenceData();
    data.accounts["1"]!.email = "test@example.com";
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, data);
    return switcher;
  }

  it("test_status_uses_cached_usage", async () => {
    const switcher = managedSwitcher();
    new UsageStore(path.join(switcher.backupDir, "cache")).record(
      {
        "1": {
          usage: {
            five_hour: { pct: 25, clock: "Jan 1 03:00", countdown: "1h" },
            seven_day: { pct: 60, clock: "Jan 2 03:00", countdown: "2d" },
          },
        },
      },
      { "1": ["test@example.com", ""] },
    );
    vi.spyOn(switcher, "readActiveCredentials").mockReturnValue(activeCredentials(activeCreds, false));
    const fetchSpy = spyFetch();

    await switcher.status();

    expect(fetchSpy).not.toHaveBeenCalled();
    const output = capturedOut();
    expect(output).toContain("25%");
    expect(output).toContain("60%");
  });

  it("test_status_fetches_with_is_active_true_when_cc_running", async () => {
    const switcher = managedSwitcher();
    const usageResult = {
      five_hour: { pct: 10, clock: "Jan 1 03:00", countdown: "0m" },
      seven_day: { pct: 50, clock: "Jan 2 03:00", countdown: "0m" },
    };
    vi.spyOn(switcher, "readActiveCredentials").mockReturnValue(activeCredentials(activeCreds, false));
    const fetchSpy = spyFetch(oauth.usageOutcome(usageResult));

    await switcher.status();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![3]).toBe(true);
    expect(capturedOut()).toContain("10%");
    const entry = new UsageStore(path.join(switcher.backupDir, "cache")).entries({ "1": ["test@example.com", ""] })["1"]!;
    expect(entry.lastGood).toEqual(usageResult);
  });

  it("test_status_preserves_other_accounts_in_cache", async () => {
    const switcher = managedSwitcher();
    const store = new UsageStore(path.join(switcher.backupDir, "cache"));
    store.record({ "2": { usage: { five_hour: { pct: 80 } } } }, { "2": ["account2@example.com", ""] });
    const usageResult = { five_hour: { pct: 10, clock: "Jan 1 03:00", countdown: "0m" } };
    vi.spyOn(switcher, "readActiveCredentials").mockReturnValue(activeCredentials(activeCreds, false));
    spyFetch(oauth.usageOutcome(usageResult));

    await switcher.status();

    const entries = store.entries({ "1": ["test@example.com", ""], "2": ["account2@example.com", ""] });
    expect(entries["1"]!.lastGood).toEqual(usageResult);
    expect(entries["2"]!.lastGood).toEqual({ five_hour: { pct: 80 } });
  });
});

describe("TestFetchAccountUsageSessionProfile", () => {
  const info = (backupCreds: string): AccountInfoRow => [2, "test@example.com", "Org", "org-uuid", false, backupCreds, ""];

  function liveSession(switcher: ClaudeAccountSwitcher, pids: number[]): void {
    vi.spyOn(switcher, "liveSessionPids").mockReturnValue(pids);
  }

  function sessionCredentials(value: string | null): void {
    vi.mocked(session.readSessionCredentials).mockReturnValue(value);
  }

  function writeProfileIdentity(switcher: ClaudeAccountSwitcher, email: string, orgUuid: string): void {
    const sessionDir = switcher.sessionDir("2", "test@example.com");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: orgUuid } }),
    );
  }

  it("test_fresh_session_credentials_fetch_read_only", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", -3600);
    const sessionCreds = oauthCreds("sk-session", 7200);
    liveSession(switcher, [123]);
    sessionCredentials(sessionCreds);
    const fetchSpy = spyFetch(oauth.usageOutcome({ five_hour: { pct: 5 } }));

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.usage).toEqual({ five_hour: { pct: 5 } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const args = fetchSpy.mock.calls[0]!;
    expect(args[2]).toBe(sessionCreds);
    expect(args[3]).toBe(true);
    expect(args[4]).toBeUndefined();
  });

  it("test_expired_session_credentials_with_live_session_is_sentinel", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", -3600);
    liveSession(switcher, [123]);
    sessionCredentials(oauthCreds("sk-session", -60));
    const fetchSpy = spyFetch();

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.sentinel).toBe(USAGE_TOKEN_EXPIRED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("test_rejected_session_credentials_with_live_session_is_sentinel", async () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    const backup = oauthCreds("sk-backup", -3600);
    const sessionCreds = oauthCreds("sk-session", 7200);
    switcher.writeAccountCredentials("2", "test@example.com", backup);
    liveSession(switcher, [123]);
    sessionCredentials(sessionCreds);
    spyFetch(oauth.usageOutcome(null, { error: "http-401" }));

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.sentinel).toBe(USAGE_TOKEN_EXPIRED);
    expect(record.error ?? null).toBeNull();
    expect(record.rejectedFp).toBe(oauth.accessTokenFingerprint(sessionCreds));
    expect(switcher.readAccountCredentials("2", "test@example.com")).toBe(backup);
  });

  it("test_stamped_session_credential_is_not_requested_again", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", -3600);
    const sessionCreds = oauthCreds("sk-session", 7200);
    const stamp = oauth.accessTokenFingerprint(sessionCreds);
    liveSession(switcher, [123]);
    sessionCredentials(sessionCreds);
    const fetchSpy = spyFetch();

    const record = await switcher.fetchAccountUsage(info(backup), stamp);

    expect(record.sentinel).toBe(USAGE_TOKEN_EXPIRED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("test_rotated_session_credential_after_a_stamp_is_requested", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", -3600);
    const sessionCreds = oauthCreds("sk-session-2", 7200);
    const stamp = oauth.accessTokenFingerprint(oauthCreds("sk-session", 7200));
    liveSession(switcher, [123]);
    sessionCredentials(sessionCreds);
    const fetchSpy = spyFetch(oauth.usageOutcome({ five_hour: { pct: 3 } }));

    const record = await switcher.fetchAccountUsage(info(backup), stamp);

    expect(record.usage).toEqual({ five_hour: { pct: 3 } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("test_live_session_without_profile_credentials_serves_backup_read_only", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", 7200);
    liveSession(switcher, [123]);
    sessionCredentials(null);
    const fetchSpy = spyFetch(oauth.usageOutcome({ five_hour: { pct: 7 } }));

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.usage).toEqual({ five_hour: { pct: 7 } });
    const args = fetchSpy.mock.calls[0]!;
    expect(args[2]).toBe(backup);
    expect(args[3]).toBe(true);
    expect(args[5]).toBeUndefined();
  });

  it("test_live_session_without_profile_credentials_and_expired_backup_is_sentinel", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", -60);
    liveSession(switcher, [123]);
    sessionCredentials(null);
    const fetchSpy = spyFetch();

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.sentinel).toBe(USAGE_TOKEN_EXPIRED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("test_live_session_rejected_backup_is_sentinel", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", 7200);
    liveSession(switcher, [123]);
    sessionCredentials(null);
    spyFetch(oauth.usageOutcome(null, { error: "http-401" }));

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.sentinel).toBe(USAGE_TOKEN_EXPIRED);
    expect(record.error ?? null).toBeNull();
    expect(record.rejectedFp).toBe(oauth.accessTokenFingerprint(backup));
  });

  it("test_stamped_backup_under_live_session_is_not_requested_again", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", 7200);
    liveSession(switcher, [123]);
    sessionCredentials(null);
    const fetchSpy = spyFetch();

    const record = await switcher.fetchAccountUsage(info(backup), oauth.accessTokenFingerprint(backup));

    expect(record.sentinel).toBe(USAGE_TOKEN_EXPIRED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("test_refused_credential_is_requested_once_across_passes", async () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    const row = info(oauthCreds("sk-backup", -3600));
    liveSession(switcher, [123]);
    sessionCredentials(oauthCreds("sk-session", 7200));
    const fetchSpy = spyFetch(oauth.usageOutcome(null, { error: "http-401" }));

    const first = (await switcher.collectUsageEntries([row]))["2"]!;
    const second = (await switcher.collectUsageEntries([row]))["2"]!;

    expect(first.sentinel).toBe(USAGE_TOKEN_EXPIRED);
    expect(second.sentinel).toBe(USAGE_TOKEN_EXPIRED);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("test_live_session_other_errors_keep_their_identity", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", 7200);
    liveSession(switcher, [123]);
    sessionCredentials(null);
    spyFetch(oauth.usageOutcome(null, { error: "http-429", retryAfterS: 3600.0 }));

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.sentinel ?? null).toBeNull();
    expect(record.error).toBe("http-429");
    expect(record.retryAfterS).toBe(3600.0);
  });

  it("test_expired_session_credentials_without_live_session_falls_back", async () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    const backup = oauthCreds("sk-backup", 7200);
    switcher.writeAccountCredentials("2", "test@example.com", backup);
    liveSession(switcher, []);
    sessionCredentials(oauthCreds("sk-session", -60));
    const fetchSpy = spyFetch(oauth.usageOutcome({ five_hour: { pct: 9 } }));

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.usage).toEqual({ five_hour: { pct: 9 } });
    const args = fetchSpy.mock.calls[0]!;
    expect(args[2]).toBe(backup);
    expect(args[3]).toBe(false);
    expect(args[5]).toEqual(expect.any(Function));
    expect(switcher.readAccountCredentials("2", "test@example.com")).toBe(backup);
  });

  it("test_exited_session_ahead_of_backup_is_adopted", async () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    const backup = oauthCreds("sk-backup", -3600);
    const sessionCreds = oauthCreds("sk-session", 7200);
    switcher.writeAccountCredentials("2", "test@example.com", backup);
    liveSession(switcher, []);
    sessionCredentials(sessionCreds);
    const fetchSpy = spyFetch(oauth.usageOutcome({ five_hour: { pct: 9 } }));

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.usage).toEqual({ five_hour: { pct: 9 } });
    const args = fetchSpy.mock.calls[0]!;
    expect(args[2]).toBe(sessionCreds);
    expect(args[3]).toBe(false);
    expect(args[5]).toEqual(expect.any(Function));
    expect(switcher.readAccountCredentials("2", "test@example.com")).toBe(sessionCreds);
  });

  it("test_live_session_ahead_of_backup_is_not_adopted", async () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    const backup = oauthCreds("sk-backup", -3600);
    const sessionCreds = oauthCreds("sk-session", 7200);
    switcher.writeAccountCredentials("2", "test@example.com", backup);
    liveSession(switcher, [123]);
    sessionCredentials(sessionCreds);
    const fetchSpy = spyFetch(oauth.usageOutcome({ five_hour: { pct: 5 } }));

    await switcher.fetchAccountUsage(info(backup));

    const args = fetchSpy.mock.calls[0]!;
    expect(args[2]).toBe(sessionCreds);
    expect(args[3]).toBe(true);
    expect(switcher.readAccountCredentials("2", "test@example.com")).toBe(backup);
  });

  it("test_no_session_profile_uses_backup_path", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", 7200);
    liveSession(switcher, []);
    sessionCredentials(null);
    const fetchSpy = spyFetch(oauth.usageOutcome({ five_hour: { pct: 9 } }));

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.usage).toEqual({ five_hour: { pct: 9 } });
    const args = fetchSpy.mock.calls[0]!;
    expect(args[2]).toBe(backup);
    expect(args[3]).toBe(false);
    expect(args[5]).toEqual(expect.any(Function));
  });

  it("test_exited_session_rejected_backup_still_refreshes", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", 7200);
    liveSession(switcher, []);
    sessionCredentials(null);
    const fetchSpy = spyFetch(oauth.usageOutcome(null, { error: "http-401" }));

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.sentinel ?? null).toBeNull();
    expect(record.error).toBe("http-401");
    const args = fetchSpy.mock.calls[0]!;
    expect(args[3]).toBe(false);
    expect(args[5]).toEqual(expect.any(Function));
  });

  it("test_drifted_profile_email_falls_back_to_backup", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", 7200);
    writeProfileIdentity(switcher, "other@example.com", "org-other");
    liveSession(switcher, [123]);
    sessionCredentials(oauthCreds("sk-session", 7200));
    const fetchSpy = spyFetch(oauth.usageOutcome({ five_hour: { pct: 9 } }));

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.usage).toEqual({ five_hour: { pct: 9 } });
    const args = fetchSpy.mock.calls[0]!;
    expect(args[2]).toBe(backup);
    expect(args[3]).toBe(false);
    expect(args[5]).toEqual(expect.any(Function));
  });

  it("test_drifted_profile_org_same_email_falls_back", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", 7200);
    writeProfileIdentity(switcher, "test@example.com", "org-uuid-other");
    liveSession(switcher, [123]);
    sessionCredentials(oauthCreds("sk-session", 7200));
    const fetchSpy = spyFetch(oauth.usageOutcome({ five_hour: { pct: 9 } }));

    await switcher.fetchAccountUsage(info(backup));

    expect(fetchSpy.mock.calls[0]![2]).toBe(backup);
  });

  it("test_matching_profile_identity_uses_session_credentials", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", -3600);
    const sessionCreds = oauthCreds("sk-session", 7200);
    writeProfileIdentity(switcher, "test@example.com", "org-uuid");
    liveSession(switcher, [123]);
    sessionCredentials(sessionCreds);
    const fetchSpy = spyFetch(oauth.usageOutcome({ five_hour: { pct: 5 } }));

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.usage).toEqual({ five_hour: { pct: 5 } });
    const args = fetchSpy.mock.calls[0]!;
    expect(args[2]).toBe(sessionCreds);
    expect(args[3]).toBe(true);
  });

  it("test_unreadable_profile_identity_trusts_session_credentials", async () => {
    const switcher = new ClaudeAccountSwitcher();
    const backup = oauthCreds("sk-backup", -3600);
    const sessionCreds = oauthCreds("sk-session", 7200);
    fs.mkdirSync(switcher.sessionDir("2", "test@example.com"), { recursive: true });
    liveSession(switcher, [123]);
    sessionCredentials(sessionCreds);
    const fetchSpy = spyFetch(oauth.usageOutcome({ five_hour: { pct: 5 } }));

    const record = await switcher.fetchAccountUsage(info(backup));

    expect(record.usage).toEqual({ five_hour: { pct: 5 } });
    const args = fetchSpy.mock.calls[0]!;
    expect(args[2]).toBe(sessionCreds);
    expect(args[3]).toBe(true);
  });
});

describe("TestAdoptSessionCredential", () => {
  const EMAIL = "test@example.com";

  function makeSwitcher(backup: string): ClaudeAccountSwitcher {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.writeAccountCredentials("2", EMAIL, backup);
    return switcher;
  }

  function seedProfile(switcher: ClaudeAccountSwitcher, creds: string, email = EMAIL, org = "org-uuid"): string {
    const sessionDir = switcher.sessionDir("2", EMAIL);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".credentials.json"), creds);
    fs.writeFileSync(
      path.join(sessionDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: org } }),
    );
    return sessionDir;
  }

  it("test_quiescent_profile_ahead_is_adopted", () => {
    const backup = oauthCreds("sk-backup", -3600);
    const profile = oauthCreds("sk-session", 7200);
    const switcher = makeSwitcher(backup);
    const sessionDir = seedProfile(switcher, profile);

    expect(switcher.adoptSessionCredential("2", EMAIL, "org-uuid")).toBe(true);
    expect(switcher.readAccountCredentials("2", EMAIL)).toBe(profile);
    expect(fs.readFileSync(path.join(sessionDir, ".credentials.json"), "utf8")).toBe(profile);
  });

  it("test_live_profile_is_not_adopted", () => {
    const backup = oauthCreds("sk-backup", -3600);
    const switcher = makeSwitcher(backup);
    const sessionDir = seedProfile(switcher, oauthCreds("sk-session", 7200));
    const records = path.join(sessionDir, "sessions");
    fs.mkdirSync(records);
    fs.writeFileSync(path.join(records, `${process.pid}.json`), JSON.stringify({ pid: process.pid }));

    expect(switcher.adoptSessionCredential("2", EMAIL, "org-uuid")).toBe(false);
    expect(switcher.readAccountCredentials("2", EMAIL)).toBe(backup);
  });

  it("test_stale_marked_profile_is_not_adopted", () => {
    const backup = oauthCreds("sk-backup", -3600);
    const switcher = makeSwitcher(backup);
    const sessionDir = seedProfile(switcher, oauthCreds("sk-session", 7200));
    session.markSessionStale(sessionDir);

    expect(switcher.adoptSessionCredential("2", EMAIL, "org-uuid")).toBe(false);
    expect(switcher.readAccountCredentials("2", EMAIL)).toBe(backup);
  });

  it("test_profile_behind_a_fresh_relogin_is_not_adopted", () => {
    const backup = oauthCreds("sk-backup", 7200);
    const switcher = makeSwitcher(backup);
    seedProfile(switcher, oauthCreds("sk-session", -60));

    expect(switcher.adoptSessionCredential("2", EMAIL, "org-uuid")).toBe(false);
    expect(switcher.readAccountCredentials("2", EMAIL)).toBe(backup);
  });

  it("test_profile_on_the_backup_generation_is_not_adopted", () => {
    const creds = oauthCreds("sk-same", 7200);
    const switcher = makeSwitcher(creds);
    seedProfile(switcher, creds);

    expect(switcher.adoptSessionCredential("2", EMAIL, "org-uuid")).toBe(false);
  });

  it("test_profile_logged_in_as_another_account_is_not_adopted", () => {
    const backup = oauthCreds("sk-backup", -3600);
    const switcher = makeSwitcher(backup);
    seedProfile(switcher, oauthCreds("sk-session", 7200), "other@example.com");

    expect(switcher.adoptSessionCredential("2", EMAIL, "org-uuid")).toBe(false);
    expect(switcher.readAccountCredentials("2", EMAIL)).toBe(backup);
  });
});

describe("TestLiveSessionGuardOnAnUnreadableRecord", () => {
  function sessionsDir(switcher: ClaudeAccountSwitcher): string {
    const d = path.join(switcher.sessionDir("2", "test@example.com"), "sessions");
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  it("test_unreadable_record_refuses_like_a_live_one", () => {
    const switcher = new ClaudeAccountSwitcher();
    fs.writeFileSync(path.join(sessionsDir(switcher), "9999.json"), "not json{{{", "utf8");

    const guard = () => switcher.ensureNoLiveSession("2", "test@example.com", "the operation");
    expect(guard).toThrow(SessionError);
    expect(guard).toThrow(/could not be read/);
  });

  it("test_readable_and_empty_still_permits", () => {
    const switcher = new ClaudeAccountSwitcher();
    sessionsDir(switcher);

    switcher.ensureNoLiveSession("2", "test@example.com", "the operation");
  });
});

describe("TestListAccountsUsage", () => {
  const activeCreds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-active" } });
  const backupCreds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-backup" } });

  function managedSwitcher(mutate: (data: SequenceFixture) => void = () => {}): ClaudeAccountSwitcher {
    mockClaudeConfig();
    const data = sequenceData();
    data.accounts["1"]!.email = "test@example.com";
    mutate(data);
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, data);
    return switcher;
  }

  function storedCredentials(switcher: ClaudeAccountSwitcher, active: string, backup: string): void {
    // The Python tests patch `_read_credentials`. The list path does not read it, so the active row reads the empty store.
    vi.spyOn(switcher, "readCredentials").mockReturnValue(active);
    vi.spyOn(switcher, "readAccountCredentials").mockReturnValue(backup);
  }

  function activeAndBackup(switcher: ClaudeAccountSwitcher): void {
    vi.spyOn(switcher, "readActiveCredentials").mockReturnValue(activeCredentials(activeCreds, false));
    vi.spyOn(switcher, "readAccountCredentials").mockReturnValue(backupCreds);
  }

  const usageResult = {
    five_hour: { pct: 10, clock: "Jan 1 03:00", countdown: "0m" },
    seven_day: { pct: 50, clock: "Jan 2 03:00", countdown: "0m" },
  };

  it("test_list_shows_usage", async () => {
    const switcher = managedSwitcher();
    storedCredentials(switcher, activeCreds, backupCreds);
    mockFetch(() =>
      jsonResponse({
        five_hour: { utilization: 10.0, resets_at: "2026-01-01T00:00:00Z" },
        seven_day: { utilization: 50.0, resets_at: "2026-01-02T00:00:00Z" },
      }),
    );

    await switcher.listAccounts();

    const output = capturedOut();
    expect(output).toContain("test@example.com [personal] (active)");
    expect(output).toContain("account2@example.com");
    expect(output).toContain("├ 5h:");
    expect(output).toContain("└ 7d:");
    expect(output).toContain("10%");
    expect(output).toContain("50%");
  });

  it("test_list_shows_alias_before_email", async () => {
    const switcher = managedSwitcher((data) => {
      data.accounts["1"]!.alias = "dev";
    });
    storedCredentials(switcher, activeCreds, backupCreds);
    spyFetch(oauth.usageOutcome(null));

    await switcher.listAccounts();

    const output = capturedOut();
    expect(output).toContain("  1: dev (test@example.com) [personal] (active)");
    expect(output).toContain("  2: account2@example.com");
    expect(output).not.toContain("(account2@example.com)");
  });

  it("test_list_shows_usage_null_reset", async () => {
    const switcher = managedSwitcher();
    storedCredentials(switcher, activeCreds, backupCreds);
    mockFetch(() =>
      jsonResponse({
        five_hour: { utilization: 0.0, resets_at: null },
        seven_day: { utilization: 100.0, resets_at: "2026-04-03T02:59:59Z" },
      }),
    );

    await switcher.listAccounts();

    const output = capturedOut();
    expect(output).toContain("5h:   0%");
    expect(output).toContain("7d: 100%");
    expect(output).not.toContain("usage unavailable");
  });

  it("test_list_no_credentials", async () => {
    const switcher = managedSwitcher();
    storedCredentials(switcher, "", "");

    await switcher.listAccounts();

    expect(capturedOut()).toContain("no credentials");
  });

  it("test_list_never_writes_live_while_claude_code_running", async () => {
    const backup = JSON.stringify({ claudeAiOauth: { accessToken: "sk-backup", refreshToken: "rt-orig" } });
    const refreshedCreds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-new", refreshToken: "rt-new" } });
    const switcher = managedSwitcher();
    storedCredentials(switcher, activeCreds, backup);
    const writeLive = vi.spyOn(switcher, "writeCredentials").mockImplementation(() => {});
    const writeBackup = vi.spyOn(switcher, "writeAccountCredentials").mockImplementation(() => {});
    vi.spyOn(switcher, "consumeBackupGrant").mockImplementation(async (accountNum, email) => {
      switcher.writeAccountCredentials(accountNum, email, refreshedCreds);
      return oauth.refreshOutcome(refreshedCreds, null);
    });
    vi.spyOn(internals, "tryFetchUsageForAccount").mockImplementation(
      async (accountNum, email, credentials, isActive, _persist = null, refreshVia = null) => {
        // A refresh on the inactive account only, through the consume gate.
        if (!isActive && refreshVia !== null) await refreshVia(accountNum, email, credentials);
        return oauth.usageOutcome(null);
      },
    );

    await switcher.listAccounts();

    expect(writeLive).not.toHaveBeenCalled();
    expect(writeBackup).toHaveBeenCalledTimes(1);
    expect(writeBackup).toHaveBeenCalledWith("2", "account2@example.com", refreshedCreds);
  });

  it("test_list_shows_token_status_when_requested", async () => {
    const switcher = managedSwitcher();
    storedCredentials(switcher, activeCreds, backupCreds);
    spyFetch(oauth.usageOutcome(null));
    vi.mocked(session.readSessionCredentials).mockReturnValue(null);
    vi.spyOn(internals, "buildTokenStatus").mockReturnValue("oauth: fresh, refresh token yes");

    await switcher.listAccounts(true);

    const output = capturedOut();
    expect(output).toContain("active profile: fresh, refresh token yes");
    expect(output).toContain("stored backup: fresh, refresh token yes");
  });

  it("test_token_status_lines_for_active_account_use_active_profile", () => {
    const switcher = new ClaudeAccountSwitcher();
    const build = vi.spyOn(internals, "buildTokenStatus").mockReturnValue("oauth: fresh, refresh token yes");

    const lines = switcher.tokenStatusLines([1, "active@example.com", "", "", true, "active-creds", ""]);

    expect(lines).toEqual(["active profile: fresh, refresh token yes"]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith("active-creds");
  });

  it("test_token_status_lines_preserve_api_key_silence", () => {
    const switcher = new ClaudeAccountSwitcher();
    const readSession = vi.mocked(session.readSessionCredentials);
    const build = vi.spyOn(internals, "buildTokenStatus");

    const lines = switcher.tokenStatusLines([2, "key@example.com", "", "", false, "sk-ant-api03-test", ""]);

    expect(lines).toEqual([]);
    expect(readSession).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("test_token_status_lines_prefer_matching_session_profile_then_backup", () => {
    const switcher = new ClaudeAccountSwitcher();
    const readSession = vi.mocked(session.readSessionCredentials).mockReturnValue("session-creds");
    const drifted = vi.mocked(session.sessionIdentityDrifted).mockReturnValue(false);
    const statuses: Record<string, string> = {
      "session-creds": "oauth: fresh, refresh token yes",
      "backup-creds": "oauth: expired, refresh token yes",
    };
    const build = vi.spyOn(internals, "buildTokenStatus").mockImplementation((credentials) => statuses[credentials] ?? null);

    const lines = switcher.tokenStatusLines([2, "inactive@example.com", "", "org-2", false, "backup-creds", ""]);

    expect(lines).toEqual(["session profile: fresh, refresh token yes", "stored backup: expired, refresh token yes"]);
    expect(readSession).toHaveBeenCalledTimes(1);
    expect(drifted).toHaveBeenCalledTimes(1);
    expect(build.mock.calls).toEqual([["session-creds"], ["backup-creds"]]);
  });

  it("test_token_status_lines_ignore_drifted_session_profile", () => {
    const switcher = new ClaudeAccountSwitcher();
    const readSession = vi.mocked(session.readSessionCredentials).mockReturnValue("session-creds");
    const drifted = vi.mocked(session.sessionIdentityDrifted).mockReturnValue(true);
    const build = vi.spyOn(internals, "buildTokenStatus").mockReturnValue("oauth: expired, refresh token yes");

    const lines = switcher.tokenStatusLines([2, "inactive@example.com", "", "org-2", false, "backup-creds", ""]);

    expect(lines).toEqual(["session profile: ignored (different account)", "stored backup: expired, refresh token yes"]);
    expect(readSession).toHaveBeenCalledTimes(1);
    expect(drifted).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith("backup-creds");
  });

  it("test_token_status_lines_without_session_show_only_backup", () => {
    const switcher = new ClaudeAccountSwitcher();
    const readSession = vi.mocked(session.readSessionCredentials).mockReturnValue(null);
    const drifted = vi.mocked(session.sessionIdentityDrifted);
    const build = vi.spyOn(internals, "buildTokenStatus").mockReturnValue("oauth: fresh, refresh token yes");

    const lines = switcher.tokenStatusLines([2, "inactive@example.com", "", "org-2", false, "backup-creds", ""]);

    expect(lines).toEqual(["stored backup: fresh, refresh token yes"]);
    expect(readSession).toHaveBeenCalledTimes(1);
    expect(drifted).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith("backup-creds");
  });

  it("test_token_status_lines_are_read_only", () => {
    const switcher = new ClaudeAccountSwitcher();
    vi.mocked(session.readSessionCredentials).mockReturnValue("session-creds");
    vi.mocked(session.sessionIdentityDrifted).mockReturnValue(false);
    vi.spyOn(internals, "buildTokenStatus")
      .mockReturnValueOnce("oauth: fresh, refresh token yes")
      .mockReturnValueOnce("oauth: expired, refresh token yes");
    const refresh = vi.spyOn(oauth.internals, "tryRefreshOauthCredentials");
    const fetchSpy = spyFetch();
    const writeLive = vi.spyOn(switcher, "writeCredentials");
    const writeBackup = vi.spyOn(switcher, "writeAccountCredentials");

    switcher.tokenStatusLines([2, "inactive@example.com", "", "org-2", false, "backup-creds", ""]);

    expect(refresh).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writeLive).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
  });

  it("test_list_uses_cached_usage", async () => {
    const switcher = managedSwitcher();
    new UsageStore(path.join(switcher.backupDir, "cache")).record(
      {
        "1": {
          usage: {
            five_hour: { pct: 25, clock: "Jan 1 03:00", countdown: "1h" },
            seven_day: { pct: 60, clock: "Jan 2 03:00", countdown: "2d" },
          },
        },
        "2": {
          usage: {
            five_hour: { pct: 80, clock: "Jan 1 04:00", countdown: "30m" },
            seven_day: { pct: 90, clock: "Jan 3 03:00", countdown: "3d" },
          },
        },
      },
      { "1": ["test@example.com", ""], "2": ["account2@example.com", ""] },
    );
    activeAndBackup(switcher);
    const fetchSpy = spyFetch();

    await switcher.listAccounts();

    expect(fetchSpy).not.toHaveBeenCalled();
    const output = capturedOut();
    expect(output).toContain("25%");
    expect(output).toContain("80%");
  });

  it("test_list_refetches_stale_entries", async () => {
    const switcher = managedSwitcher();
    const backdated = new UsageStore(path.join(switcher.backupDir, "cache"), () => nowS() - 400);
    backdated.record({ "1": { usage: { five_hour: { pct: 25 } } } }, { "1": ["test@example.com", ""] });
    activeAndBackup(switcher);
    const fetchSpy = spyFetch(oauth.usageOutcome(usageResult));

    await switcher.listAccounts();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const output = capturedOut();
    expect(output).toContain("10%");
    expect(output).not.toContain("25%");
  });

  it("test_on_demand_pass_persists_poll_plans", async () => {
    const switcher = managedSwitcher();
    activeAndBackup(switcher);
    spyFetch(oauth.usageOutcome(usageResult));

    await switcher.listAccounts();

    const entries = switcher.usageStore.entries({
      "1": ["test@example.com", ""],
      "2": ["account2@example.com", ""],
    });
    for (const num of ["1", "2"]) {
      expect(entries[num]!.nextPollAt).not.toBeNull();
      expect(entries[num]!.pollIntervalS).not.toBeNull();
    }
  });

  it("test_on_demand_pass_respects_poll_plans", async () => {
    const switcher = managedSwitcher();
    const ident1: Record<string, [string, string]> = { "1": ["test@example.com", ""] };
    const backdated = new UsageStore(path.join(switcher.backupDir, "cache"), () => nowS() - 400);
    backdated.record({ "1": { usage: { five_hour: { pct: 25 } } } }, ident1);
    switcher.usageStore.setPollPlan({ "1": [nowS() + 600.0, 600.0] }, ident1);
    activeAndBackup(switcher);
    const fetchSpy = spyFetch(oauth.usageOutcome(usageResult));

    await switcher.listAccounts();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(capturedOut()).toContain("25%");
  });

  it("test_on_demand_pass_repairs_reset_parked_exhausted_plan", async () => {
    const switcher = managedSwitcher();
    const ident1: Record<string, [string, string]> = { "1": ["test@example.com", ""] };
    const backdated = new UsageStore(path.join(switcher.backupDir, "cache"), () => nowS() - 400);
    const exhausted = {
      five_hour: { pct: 25 },
      seven_day: { pct: 100, resets_at: "2099-01-01T00:00:00Z" },
    };
    backdated.record({ "1": { usage: exhausted } }, ident1);
    switcher.usageStore.setPollPlan({ "1": [nowS() + 86_400.0, 300.0] }, ident1);
    activeAndBackup(switcher);
    const fetchSpy = spyFetch(oauth.usageOutcome({ five_hour: { pct: 5 }, seven_day: { pct: 10 } }));

    await switcher.listAccounts();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(capturedOut()).toContain("10%");
    const entry = switcher.usageStore.entries(ident1)["1"]!;
    expect(entry.nextPollAt).not.toBeNull();
    expect(entry.nextPollAt!).toBeLessThan(nowS() + 86_400.0);
  });

  it("test_replan_new_active_pulls_candidate_plan_to_floor", () => {
    mockClaudeConfig();
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    const ident: Record<string, [string, string]> = { "1": ["a@x.com", ""] };
    const store = switcher.usageStore;
    store.record({ "1": { usage: { five_hour: { pct: 10 } } } }, ident);
    store.setPollPlan({ "1": [nowS() + 600.0, 600.0] }, ident);

    switcher.replanNewActive("1", "a@x.com", "");
    let entry = store.entries(ident)["1"]!;
    expect(entry.pollIntervalS).toBe(pollPolicy.MIN_INTERVAL_S);
    expect(entry.nextPollAt!).toBeLessThanOrEqual(nowS() + pollPolicy.MIN_INTERVAL_S + 1);

    // An urgent plan never moves later.
    store.setPollPlan({ "1": [nowS() + 60.0, 60.0] }, ident);
    switcher.replanNewActive("1", "a@x.com", "");
    entry = store.entries(ident)["1"]!;
    expect(entry.pollIntervalS).toBe(60.0);

    // A plan without a measurement would block the on-demand callers from the first fetch.
    const ident2: Record<string, [string, string]> = { "2": ["b@x.com", ""] };
    switcher.replanNewActive("2", "b@x.com", "");
    expect(store.entries(ident2)["2"]!.nextPollAt).toBeNull();

    const oldStore = new UsageStore(path.join(switcher.backupDir, "cache"), () => nowS() - 400);
    oldStore.record({ "2": { usage: { five_hour: { pct: 10 } } } }, ident2);
    store.setPollPlan({ "2": [nowS() + 600.0, 600.0] }, ident2);
    switcher.replanNewActive("2", "b@x.com", "");
    entry = store.entries(ident2)["2"]!;
    expect(entry.nextPollAt!).toBeLessThanOrEqual(nowS() + 1);
  });

  it("test_replan_new_active_failure_is_logged_not_raised", () => {
    mockClaudeConfig();
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    const ident: Record<string, [string, string]> = { "1": ["a@x.com", ""] };
    switcher.usageStore.record({ "1": { usage: { five_hour: { pct: 10 } } } }, ident);
    vi.spyOn(switcher.usageStore, "setPollPlan").mockImplementation(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    const warn = vi.spyOn(switcher.logger, "warning");

    switcher.replanNewActive("1", "a@x.com", "");

    expect(warn.mock.calls.some(([msg]) => String(msg).includes("switch itself succeeded"))).toBe(true);
  });

  it("test_list_fetch_set_restricts_fetches", async () => {
    const switcher = managedSwitcher();
    activeAndBackup(switcher);
    const fetchSpy = spyFetch(oauth.usageOutcome(usageResult));

    await switcher.listAccounts(false, false, new Set());
    expect(fetchSpy).not.toHaveBeenCalled();

    await switcher.listAccounts(false, false, new Set(["2"]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe("2");
  });
});

describe("TestUsageFetchStamps", () => {
  it("test_stamps_reflect_store_without_fetching", () => {
    const switcher = new ClaudeAccountSwitcher();
    writeSequence(switcher, sequenceData());

    expect(switcher.usageFetchStamps()).toEqual({ "1": null, "2": null });

    const record: FetchRecord = { usage: { five_hour: { pct: 25 } } };
    new UsageStore(path.join(switcher.backupDir, "cache")).record({ "1": record }, { "1": ["account1@example.com", ""] });
    const stamps = switcher.usageFetchStamps();
    expect(stamps["1"]).not.toBeNull();
    expect(stamps["2"]).toBeNull();
  });
});
