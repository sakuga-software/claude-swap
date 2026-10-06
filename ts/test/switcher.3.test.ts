import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as claudeLocks from "../src/claude_locks.js";
import { activeCredentials } from "../src/credentials.js";
import {
  ClaudeCodeLockTimeout,
  ConfigError,
  CredentialReadError,
  SwitchError,
  ValidationError,
} from "../src/exceptions.js";
import { USAGE_RELOGIN_REQUIRED } from "../src/json_output.js";
import { internals as keychainInternals } from "../src/macos_keychain.js";
import { AccountInfo, Platform } from "../src/models.js";
import { internals as oauthInternals, refreshOutcome, usageOutcome, type UsageDict } from "../src/oauth.js";
import { getBackupRoot, getLegacyBackupRoot } from "../src/paths.js";
import { jsonDumps } from "../src/support/py.js";
import {
  type AccountInfoRow,
  ClaudeAccountSwitcher,
  SECURITY_SERVICE,
  SETUP_TOKEN_SCOPES,
  type SequenceData,
  internals,
} from "../src/switcher.js";
import { type FetchRecord, type Identity, SERVE_TTL_S } from "../src/usage_store.js";
import { captureOutput } from "./helpers/capture.js";
import {
  mockClaudeConfig,
  mockCredentialsFile,
  mockOrgClaudeConfig,
  mockPersonalClaudeConfig,
  sampleSequenceData,
  sampleSequenceDataPreV06,
  sampleSequenceDataWithOrg,
} from "./helpers/fixtures.js";
import { keychainStore } from "./helpers/keychain.js";
import { testHome } from "./helpers/home.js";

type Json = Record<string, any>;

const dumps = (value: unknown): string => jsonDumps(value);

function homePath(...parts: string[]): string {
  return path.join(testHome(), ...parts);
}

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function readJsonFile(file: string): Json {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Json;
}

function seq(s: ClaudeAccountSwitcher): Json {
  return s.getSequenceData() as Json;
}

function writeBackupSequence(data: unknown): void {
  const backupDir = getBackupRoot();
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "sequence.json"), dumps(data));
}

function expectThrows(fn: () => unknown, cls: new (...args: never[]) => Error, match?: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(cls);
  if (match) expect((caught as Error).message).toMatch(match);
}

async function expectRejects(
  promise: Promise<unknown>,
  cls: new (...args: never[]) => Error,
  match?: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(cls);
  if (match) expect((caught as Error).message).toMatch(match);
}

const key = (num: string, email: string): string => JSON.stringify([String(num), email]);

interface LiveState {
  creds: string;
}

/** Route the credential and config reads and writes of `switcher` to in-memory maps, so no test touches a real store. */
function installStorePatches(
  switcher: ClaudeAccountSwitcher,
  credsStore: Map<string, string>,
  configsStore: Map<string, string>,
  liveState: LiveState,
): void {
  vi.spyOn(switcher, "readAccountCredentials").mockImplementation((num, email) => credsStore.get(key(num, email)) ?? "");
  // The strict reader must answer too, or a caller that asks absent-vs-unreadable reads the real store.
  vi.spyOn(switcher, "readAccountCredentialsEx").mockImplementation((num, email) => [
    credsStore.get(key(num, email)) ?? "",
    false,
  ]);
  vi.spyOn(switcher, "writeAccountCredentials").mockImplementation((num, email, creds) => {
    credsStore.set(key(num, email), creds);
  });
  vi.spyOn(switcher, "readAccountConfig").mockImplementation((num, email) => configsStore.get(key(num, email)) ?? "");
  vi.spyOn(switcher, "writeAccountConfig").mockImplementation((num, email, cfg) => {
    configsStore.set(key(num, email), cfg);
  });
  vi.spyOn(switcher, "readCredentials").mockImplementation(() => liveState.creds);
  vi.spyOn(switcher, "writeCredentials").mockImplementation((creds) => {
    liveState.creds = creds;
  });
}

function storeKeys(store: Map<string, string>): Array<[string, string]> {
  return [...store.keys()].map((k) => JSON.parse(k) as [string, string]);
}

describe("TestPerformSwitchPostDisplay", () => {
  function setupTwoAccounts(sequenceData: Json): [ClaudeAccountSwitcher, Map<string, string>, Map<string, string>] {
    sequenceData.accounts["1"].email = "test@example.com";
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.writeJson(switcher.sequenceFile, sequenceData);

    writeText(
      homePath(".claude", ".credentials.json"),
      dumps({ claudeAiOauth: { accessToken: "sk-live-1", refreshToken: "rt-live-1" } }),
    );

    // Expired backup of account 2: the list_accounts() pass refreshes it.
    const expired2 = dumps({
      claudeAiOauth: { accessToken: "sk-stale-2", refreshToken: "rt-orig-2", expiresAt: 0, scopes: ["user:profile"] },
    });
    const credsStore = new Map([[key("2", "account2@example.com"), expired2]]);
    const configsStore = new Map([
      [key("2", "account2@example.com"), dumps({ oauthAccount: { emailAddress: "account2@example.com", accountUuid: "uuid-2" } })],
    ]);
    return [switcher, credsStore, configsStore];
  }

  it("test_switch_persists_rotated_refresh_token_to_backup", async () => {
    mockClaudeConfig();
    const [switcher, credsStore, configsStore] = setupTwoAccounts(sampleSequenceData());
    // After the swap, account 1 is inactive and its expired backup is eligible for the proactive refresh.
    const liveState = {
      creds: dumps({
        claudeAiOauth: { accessToken: "sk-live-1", refreshToken: "rt-orig-1", expiresAt: 0, scopes: ["user:profile"] },
      }),
    };
    installStorePatches(switcher, credsStore, configsStore, liveState);

    const rotatedCreds = dumps({
      claudeAiOauth: {
        accessToken: "sk-rotated-1",
        refreshToken: "rt-rotated-1",
        expiresAt: 9_999_999_999_000,
        scopes: ["user:profile"],
      },
    });
    oauthInternals.tryRefreshOauthCredentials = async () => refreshOutcome(rotatedCreds, null);
    oauthInternals.requestUsageData = async () => ({
      five_hour: { utilization: 12.0, resets_at: null },
      seven_day: { utilization: 34.0, resets_at: null },
    });
    // Slot 1 has no stored backup: the provenance guard (issue #117) resolves the live owner as slot 1.
    oauthInternals.fetchOauthProfile = async () => ({ uuid: "uuid-1", email: "test@example.com", organizationUuid: "" });
    captureOutput();

    await switcher.performSwitch("2");

    const backupAfter = credsStore.get(key("1", "test@example.com")) ?? "";
    expect(backupAfter, "backup credentials for account 1 are missing").toBeTruthy();
    const backupOauth = JSON.parse(backupAfter).claudeAiOauth;
    expect(backupOauth.refreshToken, "lock deadlock regression").toBe("rt-rotated-1");
    expect(backupOauth.accessToken).toBe("sk-rotated-1");
  });

  it("test_switch_refuses_to_overwrite_backup_with_empty_current_creds", async () => {
    mockClaudeConfig();
    const [switcher, credsStore, configsStore] = setupTwoAccounts(sampleSequenceData());
    const goodBackup = dumps({ claudeAiOauth: { accessToken: "sk-good-1", refreshToken: "rt-good-1" } });
    credsStore.set(key("1", "test@example.com"), goodBackup);
    // An empty live read, as a `security find-generic-password` timeout gives.
    const liveState = { creds: "" };
    installStorePatches(switcher, credsStore, configsStore, liveState);
    captureOutput();

    await expectRejects(switcher.performSwitch("2"), CredentialReadError);

    expect(credsStore.get(key("1", "test@example.com"))).toBe(goodBackup);
  });

  it("test_switch_survives_post_display_failure", async () => {
    mockClaudeConfig();
    const [switcher, credsStore, configsStore] = setupTwoAccounts(sampleSequenceData());
    const liveState = { creds: dumps({ claudeAiOauth: { accessToken: "sk-live-1", refreshToken: "rt-live-1" } }) };
    installStorePatches(switcher, credsStore, configsStore, liveState);
    switcher.platform = Platform.LINUX;
    const capsys = captureOutput();
    vi.spyOn(switcher, "listAccounts").mockRejectedValue(new Error("boom"));

    await switcher.performSwitch("2");

    const data = switcher.getSequenceData();
    expect(data).not.toBeNull();
    expect(data!.activeAccountNumber).toBe(2);
    const output = capsys.readouterr().out;
    expect(output).toContain("Switched to");
    expect(output).toContain("usage display unavailable");
    expect(output).toContain("no restart needed");
  });

  it("test_switch_followup_macos", () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.platform = Platform.MACOS;
    const capsys = captureOutput();

    switcher.printSwitchFollowup();

    const out = capsys.readouterr().out;
    expect(out).toContain("apply immediately");
    expect(out).toContain("30 seconds");
    expect(out).not.toContain("no restart needed");
  });

  it("test_switch_followup_non_macos", () => {
    const capsys = captureOutput();
    for (const plat of [Platform.LINUX, Platform.WSL, Platform.WINDOWS]) {
      const switcher = new ClaudeAccountSwitcher();
      switcher.platform = plat;

      switcher.printSwitchFollowup();

      const out = capsys.readouterr().out;
      expect(out, plat).toContain("no restart needed");
      expect(out, plat).not.toContain("30 seconds");
    }
  });

  it("test_switch_with_unset_active_account_does_not_write_none_backup", async () => {
    mockClaudeConfig();
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.writeJson(switcher.sequenceFile, {
      activeAccountNumber: null,
      lastUpdated: "2024-01-01T00:00:00Z",
      sequence: [1],
      accounts: {
        "1": {
          email: "target@example.com",
          uuid: "",
          organizationUuid: "",
          organizationName: "",
          added: "2024-01-01T00:00:00Z",
        },
      },
    });
    const credsStore = new Map([
      [
        key("1", "target@example.com"),
        dumps({
          claudeAiOauth: {
            accessToken: "target-token",
            refreshToken: null,
            expiresAt: null,
            scopes: ["user:inference"],
            subscriptionType: null,
            rateLimitTier: null,
          },
        }),
      ],
    ]);
    const configsStore = new Map([
      [
        key("1", "target@example.com"),
        dumps({
          oauthAccount: { emailAddress: "target@example.com", accountUuid: "", organizationUuid: null, organizationName: null },
        }),
      ],
    ]);
    const liveState = {
      creds: dumps({ claudeAiOauth: { accessToken: "existing-live-token", refreshToken: "existing-refresh" } }),
    };
    installStorePatches(switcher, credsStore, configsStore, liveState);
    captureOutput();

    await switcher.performSwitch("1");

    expect(storeKeys(credsStore).some(([num]) => num === "None")).toBe(false);
    expect(storeKeys(configsStore).some(([num]) => num === "None")).toBe(false);
    expect(JSON.parse(liveState.creds).claudeAiOauth.accessToken).toBe("target-token");
    expect(switcher.getSequenceData()!.activeAccountNumber).toBe(1);
  });

  it("test_switch_uses_live_identity_for_current_backup_slot", async () => {
    writeText(
      homePath(".claude.json"),
      dumps({
        oauthAccount: { emailAddress: "realiti44@gmail.com", accountUuid: "", organizationUuid: null, organizationName: null },
      }),
    );
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.writeJson(switcher.sequenceFile, {
      activeAccountNumber: 3,
      lastUpdated: "2024-01-01T00:00:00Z",
      sequence: [3, 4],
      accounts: {
        "3": {
          email: "onurcetinkol@gmail.com",
          uuid: "",
          organizationUuid: "",
          organizationName: "",
          added: "2024-01-01T00:00:00Z",
        },
        "4": {
          email: "realiti44@gmail.com",
          uuid: "",
          organizationUuid: "",
          organizationName: "",
          added: "2024-01-01T00:00:00Z",
        },
      },
    });
    const targetCreds = dumps({ claudeAiOauth: { accessToken: "target-token", refreshToken: "target-refresh" } });
    const liveCreds = dumps({ claudeAiOauth: { accessToken: "realiti-live-token", refreshToken: "realiti-live-refresh" } });
    const credsStore = new Map([
      [key("3", "onurcetinkol@gmail.com"), targetCreds],
      [key("4", "realiti44@gmail.com"), "old-realiti-backup"],
    ]);
    const configsStore = new Map([
      [
        key("3", "onurcetinkol@gmail.com"),
        dumps({
          oauthAccount: {
            emailAddress: "onurcetinkol@gmail.com",
            accountUuid: "",
            organizationUuid: null,
            organizationName: null,
          },
        }),
      ],
      [key("4", "realiti44@gmail.com"), "old-realiti-config"],
    ]);
    const liveState = { creds: liveCreds };
    installStorePatches(switcher, credsStore, configsStore, liveState);
    vi.spyOn(switcher, "listAccounts").mockResolvedValue(null);
    // The backup of slot 4 does not match the live bytes: the provenance guard resolves the owner as slot 4.
    oauthInternals.fetchOauthProfile = async () => ({ uuid: "", email: "realiti44@gmail.com", organizationUuid: "" });
    captureOutput();

    await switcher.performSwitch("3");

    expect(credsStore.get(key("4", "realiti44@gmail.com"))).toBe(liveCreds);
    expect(credsStore.has(key("3", "realiti44@gmail.com"))).toBe(false);
    expect(JSON.parse(liveState.creds).claudeAiOauth.accessToken).toBe("target-token");
  });

  function untrackedSetup(): [ClaudeAccountSwitcher, string, Map<string, string>, Map<string, string>] {
    const originalConfigText = dumps({
      oauthAccount: { emailAddress: "untracked@example.com", accountUuid: "", organizationUuid: null, organizationName: null },
    });
    writeText(homePath(".claude.json"), originalConfigText);
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.writeJson(switcher.sequenceFile, {
      activeAccountNumber: null,
      lastUpdated: "2024-01-01T00:00:00Z",
      sequence: [1],
      accounts: {
        "1": {
          email: "target@example.com",
          uuid: "",
          organizationUuid: "",
          organizationName: "",
          added: "2024-01-01T00:00:00Z",
        },
      },
    });
    const credsStore = new Map([
      [key("1", "target@example.com"), dumps({ claudeAiOauth: { accessToken: "target-token", refreshToken: "target-refresh" } })],
    ]);
    const configsStore = new Map([
      [
        key("1", "target@example.com"),
        dumps({
          oauthAccount: { emailAddress: "target@example.com", accountUuid: "", organizationUuid: null, organizationName: null },
        }),
      ],
    ]);
    return [switcher, originalConfigText, credsStore, configsStore];
  }

  it("test_direct_activation_rolls_back_live_creds_on_sequence_write_failure", async () => {
    const [switcher, originalConfigText, credsStore, configsStore] = untrackedSetup();
    const originalLiveCreds = dumps({
      claudeAiOauth: { accessToken: "live-untracked-token", refreshToken: "live-untracked-refresh" },
    });
    const liveState = { creds: originalLiveCreds };
    installStorePatches(switcher, credsStore, configsStore, liveState);

    const originalWriteJson = switcher.writeJson.bind(switcher);
    vi.spyOn(switcher, "writeJson").mockImplementation((file, data) => {
      if (file === switcher.sequenceFile && (data as SequenceData).activeAccountNumber === 1) {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      originalWriteJson(file, data);
    });
    captureOutput();

    await expectRejects(switcher.performSwitch("1"), Error, /disk full/);

    expect(liveState.creds).toBe(originalLiveCreds);
    expect(fs.readFileSync(homePath(".claude.json"), "utf8")).toBe(originalConfigText);
  });

  it("test_direct_activation_fails_fast_when_live_creds_unreadable", async () => {
    const [switcher, originalConfigText, credsStore, configsStore] = untrackedSetup();
    const liveState = { creds: "live-creds-that-we-cannot-read" };
    installStorePatches(switcher, credsStore, configsStore, liveState);
    vi.spyOn(switcher, "readCredentials").mockReturnValue(null);
    captureOutput();

    await expectRejects(switcher.performSwitch("1"), CredentialReadError, /snapshot/);

    expect(liveState.creds).toBe("live-creds-that-we-cannot-read");
    expect(fs.readFileSync(homePath(".claude.json"), "utf8")).toBe(originalConfigText);
  });
});

describe("TestSwitchToSelfSlotAndForce", () => {
  const IMPORTED_1 = dumps({ claudeAiOauth: { accessToken: "sk-imported-1", refreshToken: "rt-imported-1" } });
  const LIVE_1 = dumps({ claudeAiOauth: { accessToken: "sk-live-1", refreshToken: "rt-live-1" } });

  /** Accounts 1 (active, live) and 2. The stored backup of slot 1 holds new imported credentials, unlike the stale live ones. */
  function postImportState(): [ClaudeAccountSwitcher, Map<string, string>, Map<string, string>, LiveState] {
    mockClaudeConfig();
    const sequenceData: Json = sampleSequenceData();
    sequenceData.accounts["1"].email = "test@example.com";
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.platform = Platform.LINUX;
    switcher.writeJson(switcher.sequenceFile, sequenceData);

    writeText(homePath(".claude", ".credentials.json"), LIVE_1);

    const credsStore = new Map([
      [key("1", "test@example.com"), IMPORTED_1],
      [key("2", "account2@example.com"), dumps({ claudeAiOauth: { accessToken: "sk-2", refreshToken: "rt-2" } })],
    ]);
    const configsStore = new Map([
      [key("1", "test@example.com"), dumps({ oauthAccount: { emailAddress: "test@example.com", accountUuid: "test-uuid-1234" } })],
      [
        key("2", "account2@example.com"),
        dumps({ oauthAccount: { emailAddress: "account2@example.com", accountUuid: "uuid-2" } }),
      ],
    ]);
    return [switcher, credsStore, configsStore, { creds: LIVE_1 }];
  }

  it("test_switch_to_current_slot_is_noop_preserving_backup", async () => {
    const [switcher, creds, configs, live] = postImportState();
    installStorePatches(switcher, creds, configs, live);
    const capsys = captureOutput();

    const result = await switcher.switchTo("1");

    expect(result).toBeNull();
    expect(creds.get(key("1", "test@example.com"))).toBe(IMPORTED_1);
    expect(live.creds).toBe(LIVE_1);
    const out = capsys.readouterr().out;
    expect(out).toContain("Already on");
    expect(out).toContain("Account-1");
    expect(out).toContain("cswap --switch-to 1 --force");
  });

  it("test_force_self_activation_restores_imported_creds", async () => {
    const [switcher, creds, configs, live] = postImportState();
    installStorePatches(switcher, creds, configs, live);
    const capsys = captureOutput();

    const result = await switcher.switchTo("1", false, true);

    expect(result).toBeNull();
    expect(live.creds).toBe(IMPORTED_1);
    expect(creds.get(key("1", "test@example.com"))).toBe(IMPORTED_1);
    expect(switcher.getSequenceData()!.activeAccountNumber).toBe(1);
    expect(capsys.readouterr().out).toContain("Activated");
  });

  it("test_force_cross_slot_skips_backup_of_current", async () => {
    const [switcher, creds, configs, live] = postImportState();
    installStorePatches(switcher, creds, configs, live);
    captureOutput();

    await switcher.switchTo("2", false, true);

    expect(creds.get(key("1", "test@example.com"))).toBe(IMPORTED_1);
    expect(JSON.parse(live.creds).claudeAiOauth.accessToken).toBe("sk-2");
    expect(switcher.getSequenceData()!.activeAccountNumber).toBe(2);
  });
});

describe("TestAccountInfoOrgFields", () => {
  it("test_account_info_includes_org_fields", () => {
    const info = new AccountInfo({
      email: "user@example.com",
      uuid: "user-uuid",
      organizationUuid: "org-uuid-123",
      organizationName: "Acme Corp",
      added: "2024-01-01T00:00:00Z",
      number: 1,
    });
    expect(info.organizationUuid).toBe("org-uuid-123");
    expect(info.organizationName).toBe("Acme Corp");
  });

  it("test_account_info_personal_account_has_empty_org", () => {
    const info = AccountInfo.fromDict(1, { email: "user@example.com", uuid: "user-uuid", added: "2024-01-01T00:00:00Z" });
    expect(info.organizationUuid).toBe("");
    expect(info.organizationName).toBe("");
  });

  it("test_account_info_to_dict_includes_org_fields", () => {
    const info = new AccountInfo({
      email: "user@example.com",
      uuid: "user-uuid",
      organizationUuid: "org-uuid",
      organizationName: "Acme",
      added: "2024-01-01T00:00:00Z",
      number: 1,
    });
    const d = info.toDict();
    expect(d.organizationUuid).toBe("org-uuid");
    expect(d.organizationName).toBe("Acme");
  });

  it("test_account_info_is_organization_property", () => {
    const org = AccountInfo.fromDict(1, { email: "u@e.com", uuid: "u", added: "", organizationUuid: "o" });
    const personal = AccountInfo.fromDict(2, { email: "u@e.com", uuid: "u", added: "" });
    expect(org.isOrganization).toBe(true);
    expect(personal.isOrganization).toBe(false);
  });

  it("test_account_info_display_label", () => {
    const org = new AccountInfo({ email: "u@e.com", uuid: "u", organizationUuid: "o", organizationName: "Acme", added: "", number: 1 });
    const personal = new AccountInfo({ email: "u@e.com", uuid: "u", organizationUuid: "", organizationName: "", added: "", number: 2 });
    expect(org.displayLabel).toBe("u@e.com [Acme]");
    expect(personal.displayLabel).toBe("u@e.com [personal]");
  });
});

describe("TestAccountExistsCompositeKey", () => {
  it("test_distinguishes_org_and_personal", () => {
    mockCredentialsFile();
    writeBackupSequence({
      activeAccountNumber: 1,
      lastUpdated: "2024-01-01T00:00:00Z",
      sequence: [1],
      accounts: {
        "1": {
          email: "user@example.com",
          uuid: "user-uuid",
          organizationUuid: "org-uuid-A",
          organizationName: "Acme",
          added: "2024-01-01T00:00:00Z",
        },
      },
    });
    const switcher = new ClaudeAccountSwitcher();
    expect(switcher.accountExists("user@example.com", "org-uuid-A")).toBe(true);
    expect(switcher.accountExists("user@example.com", "")).toBe(false);
    expect(switcher.accountExists("user@example.com", "org-uuid-B")).toBe(false);
  });
});

describe("TestGetCurrentAccountOrgSupport", () => {
  it("test_returns_org_info", () => {
    mockOrgClaudeConfig();
    const switcher = new ClaudeAccountSwitcher();
    expect(switcher.getCurrentAccount()).toEqual(["user@example.com", "org-uuid-5678"]);
  });

  it("test_returns_empty_org_for_personal", () => {
    mockPersonalClaudeConfig();
    const switcher = new ClaudeAccountSwitcher();
    expect(switcher.getCurrentAccount()).toEqual(["user@example.com", ""]);
  });

  it("test_returns_none_when_no_config", () => {
    const switcher = new ClaudeAccountSwitcher();
    expect(switcher.getCurrentAccount()).toBeNull();
  });
});

describe("TestDeadTokenQuarantine", () => {
  const deadCreds = (): string => dumps({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: 1 } });

  function makeDead(switcher: ClaudeAccountSwitcher, num = "2", identity: Identity = ["test@example.com", ""]): void {
    switcher.usageStore.record({ [num]: { error: "invalid_grant" } }, { [num]: identity });
  }

  it("test_collector_surfaces_relogin_sentinel_and_skips_fetch", async () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    makeDead(switcher);
    const info: AccountInfoRow[] = [[2, "test@example.com", "Org", "", false, deadCreds(), ""]];
    const fetch = vi.spyOn(internals, "tryFetchUsageForAccount");

    const entries = await switcher.collectUsageEntries(info);

    expect(entries["2"]!.sentinel).toBe(USAGE_RELOGIN_REQUIRED);
    // Quarantined: no endless 401/429 loop.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_relogin_surfaces_same_pass_on_invalid_grant", async () => {
    // The pre-fetch quarantine scan cannot see a strike that this pass records.
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    const info: AccountInfoRow[] = [[2, "test@example.com", "Org", "", false, deadCreds(), ""]];
    const run = vi.spyOn(switcher, "runUsageFetches").mockResolvedValue({ "2": { error: "invalid_grant" } });

    const entries = await switcher.collectUsageEntries(info);

    expect(run).toHaveBeenCalledOnce();
    expect(entries["2"]!.sentinel).toBe(USAGE_RELOGIN_REQUIRED);
  });

  it("test_the_collector_hands_the_trust_bound_its_configured_models", async () => {
    // Both `store.entries(identities, models)` sites of the collector must get the configured models.
    // Unscoped windows are far out; the Fable window resets in 30 minutes.
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.pollInputsOverride = [90.0, ["Fable"]];
    const store = switcher.usageStore;
    const now = Date.now() / 1000;
    const iso = (ahead: number): string => new Date((now + ahead) * 1000).toISOString();
    const readTable = (): Json => readJsonFile(store.path);
    const writeTable = (table: Json): void => fs.writeFileSync(store.path, dumps(table));

    const live = dumps({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: (now + 86400) * 1000 } });
    const info: AccountInfoRow[] = [[2, "test@example.com", "Org", "", false, live, ""]];
    const ident: Record<string, Identity> = { "2": ["test@example.com", ""] };
    store.record(
      {
        "2": {
          usage: {
            five_hour: { pct: 25.0, resets_at: iso(100 * 3600.0) },
            seven_day: { pct: 10.0, resets_at: iso(100 * 3600.0) },
            scoped: [{ name: "Fable", pct: 90.0, resets_at: iso(1800.0) }],
          } as UsageDict,
        },
      },
      ident,
    );
    // Age the row past the serve TTL without a clock change, which would move the scoped reset too.
    let table = readTable();
    table.accounts["2"].fetchedAt -= SERVE_TTL_S * 4;
    writeTable(table);

    const run = vi
      .spyOn(switcher, "runUsageFetches")
      .mockResolvedValue({ "2": { error: "http-429", retryAfterS: 3600.0 } });
    await switcher.collectUsageEntries(info, new Set(["2"]));
    expect(run).toHaveBeenCalledOnce();
    run.mockRestore();

    expect(store.entries(ident, ["Fable"])["2"]!.backoffUntil, "premise: a backoff was recorded").not.toBeNull();
    // Move the scoped reset into the past, as a real clock does 30 minutes later. The unscoped windows stay far ahead.
    table = readTable();
    const row = table.accounts["2"];
    row.lastGood.scoped[0].resets_at = iso(-60.0 / 3600.0);
    row.fetchedAt -= 1860.0;
    writeTable(table);

    // The backoff must be past, or `reserve` refuses and the post-fetch re-read never runs.
    table = readTable();
    table.accounts["2"].backoffUntil = null;
    writeTable(table);

    // The fetch claims the slot but records nothing, so the re-read sees the state above.
    vi.spyOn(switcher, "runUsageFetches").mockResolvedValue({});
    const fetched = (await switcher.collectUsageEntries(info, new Set(["2"])))["2"]!;
    expect(
      fetched.decisionValue(),
      `the FETCHING path returned a row still serving last_good (trust_extended=${fetched.trustExtended})`,
    ).toBeNull();

    const returned = (await switcher.collectUsageEntries(info, new Set()))["2"]!;
    expect(
      returned.decisionValue(),
      `the collector RETURNED a row still serving last_good (trust_extended=${returned.trustExtended})`,
    ).toBeNull();
  });

  it("test_readd_clears_quarantine", async () => {
    // A re-add with a fresh credential must lift the quarantine.
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    const identity: Identity = ["user@example.com", "org-A"];
    makeDead(switcher, "1", identity);
    expect(switcher.usageStore.entries({ "1": identity })["1"]!.tokenDead()).toBe(true);

    const fakeCreds = dumps({ claudeAiOauth: { accessToken: "fresh" } });
    writeText(
      homePath(".claude.json"),
      dumps({
        oauthAccount: { emailAddress: "user@example.com", accountUuid: "u", organizationUuid: "org-A", organizationName: "Acme" },
      }),
    );
    vi.spyOn(switcher, "readActiveCredentials").mockReturnValue(activeCredentials(fakeCreds, false));
    vi.spyOn(switcher, "writeAccountCredentials").mockImplementation(() => {});
    captureOutput();
    await switcher.addAccount();

    expect(switcher.usageStore.entries({ "1": identity })["1"]!.tokenDead()).toBe(false);
  });
});

function patchCapture(switcher: ClaudeAccountSwitcher, creds: string): void {
  vi.spyOn(switcher, "readActiveCredentials").mockReturnValue(activeCredentials(creds, false));
  vi.spyOn(switcher, "writeAccountCredentials").mockImplementation(() => {});
}

describe("TestAddAccountOrgFields", () => {
  it("test_allows_same_email_different_org", async () => {
    const fakeCreds = dumps({ claudeAiOauth: { accessToken: "test-token" } });
    const configPath = homePath(".claude.json");
    captureOutput();

    writeText(
      configPath,
      dumps({
        oauthAccount: {
          emailAddress: "user@example.com",
          accountUuid: "user-uuid",
          organizationUuid: "org-uuid-A",
          organizationName: "Acme",
        },
      }),
    );
    const switcher = new ClaudeAccountSwitcher();
    patchCapture(switcher, fakeCreds);
    await switcher.addAccount();

    writeText(configPath, dumps({ oauthAccount: { emailAddress: "user@example.com", accountUuid: "user-uuid" } }));
    await switcher.addAccount();

    const sequence = readJsonFile(path.join(getBackupRoot(), "sequence.json"));
    expect(Object.keys(sequence.accounts)).toHaveLength(2);
    expect(sequence.accounts["1"].organizationUuid).toBe("org-uuid-A");
    expect(sequence.accounts["2"].organizationUuid).toBe("");
  });

  it("test_blocks_true_duplicate", async () => {
    const fakeCreds = dumps({ claudeAiOauth: { accessToken: "test-token" } });
    const configPath = homePath(".claude.json");
    const orgConfig = {
      oauthAccount: {
        emailAddress: "user@example.com",
        accountUuid: "user-uuid",
        organizationUuid: "org-uuid-A",
        organizationName: "Acme",
      },
    };
    writeText(configPath, dumps(orgConfig));
    const switcher = new ClaudeAccountSwitcher();
    patchCapture(switcher, fakeCreds);
    const capsys = captureOutput();
    await switcher.addAccount();

    capsys.readouterr();
    writeText(configPath, dumps(orgConfig));
    await switcher.addAccount();
    expect(capsys.readouterr().out).toContain("Updated credentials");

    const sequence = readJsonFile(path.join(getBackupRoot(), "sequence.json"));
    expect(Object.keys(sequence.accounts)).toHaveLength(1);
  });

  it("test_stores_org_name_in_sequence", async () => {
    const fakeCreds = dumps({ claudeAiOauth: { accessToken: "test-token" } });
    writeText(
      homePath(".claude.json"),
      dumps({
        oauthAccount: {
          emailAddress: "user@example.com",
          accountUuid: "user-uuid",
          organizationUuid: "org-uuid",
          organizationName: "My Org",
        },
      }),
    );
    const switcher = new ClaudeAccountSwitcher();
    patchCapture(switcher, fakeCreds);
    captureOutput();
    await switcher.addAccount();

    const sequence = readJsonFile(path.join(getBackupRoot(), "sequence.json"));
    expect(sequence.accounts["1"].organizationName).toBe("My Org");
    expect(sequence.accounts["1"].organizationUuid).toBe("org-uuid");
  });
});

describe("TestResolveIdentifierAmbiguity", () => {
  it("test_by_number_always_works", () => {
    writeBackupSequence(sampleSequenceDataWithOrg());
    const switcher = new ClaudeAccountSwitcher();
    expect(switcher.resolveAccountIdentifier("1")).toBe("1");
    expect(switcher.resolveAccountIdentifier("2")).toBe("2");
  });

  it("test_raises_on_ambiguous_email", () => {
    writeBackupSequence(sampleSequenceDataWithOrg());
    const switcher = new ClaudeAccountSwitcher();
    expectThrows(() => switcher.resolveAccountIdentifier("user@example.com"), ConfigError, /ambiguous/);
  });

  it("test_unique_email_still_works", () => {
    writeBackupSequence(sampleSequenceData());
    const switcher = new ClaudeAccountSwitcher();
    expect(switcher.resolveAccountIdentifier("account1@example.com")).toBe("1");
  });
});

describe("TestListAccountsOrgDisplay", () => {
  it("test_shows_org_name_and_personal", async () => {
    mockCredentialsFile();
    writeBackupSequence(sampleSequenceDataWithOrg());
    writeText(
      homePath(".claude.json"),
      dumps({
        oauthAccount: {
          emailAddress: "user@example.com",
          accountUuid: "user-uuid",
          organizationUuid: "org-uuid-5678",
          organizationName: "Acme Corp",
        },
      }),
    );
    const switcher = new ClaudeAccountSwitcher();
    vi.spyOn(internals, "tryFetchUsageForAccount").mockResolvedValue(usageOutcome(null));
    const capsys = captureOutput();

    await switcher.listAccounts();

    const out = capsys.readouterr().out;
    expect(out).toContain("Acme Corp");
    expect(out).toContain("personal");
    expect(out).toContain("(active)");
  });

  it("test_active_account_detected_by_org_uuid", async () => {
    mockCredentialsFile();
    writeBackupSequence(sampleSequenceDataWithOrg());
    writeText(homePath(".claude.json"), dumps({ oauthAccount: { emailAddress: "user@example.com", accountUuid: "user-uuid" } }));
    const switcher = new ClaudeAccountSwitcher();
    vi.spyOn(internals, "tryFetchUsageForAccount").mockResolvedValue(usageOutcome(null));
    const capsys = captureOutput();

    await switcher.listAccounts();

    const lines = capsys
      .readouterr()
      .out.split("\n")
      .filter((ln) => ln.includes("(active)"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("personal");
  });
});

describe("TestBackwardCompatibility", () => {
  it("test_old_sequence_json_without_org_fields", async () => {
    writeBackupSequence(sampleSequenceData());
    writeText(homePath(".claude.json"), dumps({ oauthAccount: { emailAddress: "account1@example.com", accountUuid: "uuid-1" } }));
    writeText(homePath(".claude", ".credentials.json"), '{"accessToken": "tok"}');
    const switcher = new ClaudeAccountSwitcher();
    vi.spyOn(internals, "tryFetchUsageForAccount").mockResolvedValue(usageOutcome(null));
    const capsys = captureOutput();

    await switcher.listAccounts();

    const out = capsys.readouterr().out;
    expect(out).toContain("account1@example.com");
    expect(out).toContain("personal");
  });

  it("test_status_with_old_sequence_json", async () => {
    writeBackupSequence(sampleSequenceData());
    writeText(homePath(".claude.json"), dumps({ oauthAccount: { emailAddress: "account1@example.com", accountUuid: "uuid-1" } }));
    const switcher = new ClaudeAccountSwitcher();
    const capsys = captureOutput();

    await switcher.status();

    const out = capsys.readouterr().out;
    expect(out).toContain("account1@example.com");
    expect(out).toContain("personal");
  });
});

describe("TestUpgradeMigration", () => {
  const liveOrgConfig = {
    oauthAccount: {
      emailAddress: "user@example.com",
      accountUuid: "user-uuid-1234",
      organizationUuid: "org-uuid-live",
      organizationName: "Live Org",
    },
  };

  /** The state before v0.6.0, with a live config. */
  function setupPreV06(sequenceData: unknown, liveConfig: unknown): void {
    writeBackupSequence(sequenceData);
    writeText(homePath(".claude.json"), dumps(liveConfig));
  }

  it("test_status_after_upgrade_with_org_uuid", async () => {
    setupPreV06(sampleSequenceDataPreV06(), liveOrgConfig);
    const switcher = new ClaudeAccountSwitcher();
    const capsys = captureOutput();

    await switcher.status();

    const out = capsys.readouterr().out;
    expect(out).toContain("Account-1");
    expect(out).not.toContain("not managed");
  });

  it("test_list_after_upgrade_marks_active", async () => {
    setupPreV06(sampleSequenceDataPreV06(), liveOrgConfig);
    writeText(homePath(".claude", ".credentials.json"), dumps({ claudeAiOauth: { accessToken: "test-token" } }));
    const switcher = new ClaudeAccountSwitcher();
    vi.spyOn(internals, "tryFetchUsageForAccount").mockResolvedValue(usageOutcome(null));
    const capsys = captureOutput();

    await switcher.listAccounts();

    expect(capsys.readouterr().out).toContain("(active)");
  });

  it("test_migration_uses_live_config_over_backup", () => {
    setupPreV06(sampleSequenceDataPreV06(), liveOrgConfig);
    const switcher = new ClaudeAccountSwitcher();
    const data = switcher.getSequenceDataMigrated() as Json;

    expect(data.accounts["1"].organizationUuid).toBe("org-uuid-live");
    expect(data.accounts["1"].organizationName).toBe("Live Org");
  });

  it("test_migration_idempotent", () => {
    setupPreV06(sampleSequenceDataPreV06(), liveOrgConfig);
    const switcher = new ClaudeAccountSwitcher();
    const data1 = switcher.getSequenceDataMigrated() as Json;
    const data2 = switcher.getSequenceDataMigrated() as Json;

    expect(data1.accounts["1"].organizationUuid).toBe(data2.accounts["1"].organizationUuid);
    expect(data1.accounts["2"].organizationUuid).toBe(data2.accounts["2"].organizationUuid);
  });

  it("test_migration_skips_already_migrated", () => {
    const sequenceData: Json = sampleSequenceDataPreV06();
    sequenceData.accounts["1"].organizationUuid = "existing-org";
    sequenceData.accounts["1"].organizationName = "Existing Org";
    setupPreV06(sequenceData, {
      oauthAccount: {
        emailAddress: "user@example.com",
        accountUuid: "user-uuid-1234",
        organizationUuid: "different-org",
        organizationName: "Different Org",
      },
    });

    const switcher = new ClaudeAccountSwitcher();
    const data = switcher.getSequenceDataMigrated() as Json;

    expect(data.accounts["1"].organizationUuid).toBe("existing-org");
    expect(data.accounts["1"].organizationName).toBe("Existing Org");
    expect(data.accounts["2"].organizationUuid).toBe("");
  });

  it("test_switch_after_upgrade_no_duplicate", async () => {
    setupPreV06(sampleSequenceDataPreV06(), liveOrgConfig);
    writeText(homePath(".claude", ".credentials.json"), dumps({ claudeAiOauth: { accessToken: "test-token" } }));

    const switcher = new ClaudeAccountSwitcher();
    const backupDir = getBackupRoot();
    const encoded = Buffer.from(dumps({ claudeAiOauth: { accessToken: "token-2" } })).toString("base64");
    writeText(path.join(backupDir, "credentials", ".creds-2-other@example.com.enc"), encoded);
    writeText(
      path.join(backupDir, "configs", ".claude-config-2-other@example.com.json"),
      dumps({ oauthAccount: { emailAddress: "other@example.com", accountUuid: "other-uuid-5678" } }),
    );

    const backupCreds = dumps({ claudeAiOauth: { accessToken: "token-2" } });
    vi.spyOn(switcher, "writeCredentials").mockImplementation(() => {});
    vi.spyOn(switcher, "writeAccountCredentials").mockImplementation(() => {});
    vi.spyOn(switcher, "readAccountCredentials").mockReturnValue(backupCreds);
    vi.spyOn(switcher, "readAccountConfig").mockReturnValue(
      dumps({ oauthAccount: { emailAddress: "other@example.com", accountUuid: "other-uuid-5678" } }),
    );
    const capsys = captureOutput();

    await switcher.switch();

    expect(Object.keys(seq(switcher).accounts)).toHaveLength(2);
    expect(capsys.readouterr().out.toLowerCase()).not.toContain("auto");
  });
});

describe("TestAddAccountSlot", () => {
  const fakeCreds = dumps({ claudeAiOauth: { accessToken: "tok" } });

  /** Write a Claude config for `email` and return a new switcher. */
  function makeSwitcher(email = "test@example.com", orgUuid = "", orgName = ""): ClaudeAccountSwitcher {
    writeText(
      homePath(".claude.json"),
      dumps({
        oauthAccount: { emailAddress: email, accountUuid: `uuid-${email}`, organizationUuid: orgUuid, organizationName: orgName },
      }),
    );
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.initSequenceFile();
    return switcher;
  }

  function patchAdd(switcher: ClaudeAccountSwitcher, { deleteCreds = false } = {}): void {
    patchCapture(switcher, fakeCreds);
    if (deleteCreds) vi.spyOn(switcher, "deleteAccountCredentials").mockImplementation(() => {});
  }

  it("test_add_to_specific_empty_slot", async () => {
    const switcher = makeSwitcher();
    patchAdd(switcher);
    const capsys = captureOutput();

    await switcher.addAccount(5);

    const data = seq(switcher);
    expect(data.accounts).toHaveProperty("5");
    expect(data.accounts["5"].email).toBe("test@example.com");
    expect(data.activeAccountNumber).toBe(5);
    expect(data.sequence).toContain(5);
    expect(capsys.readouterr().out).toContain("Added");
  });

  it("test_add_without_slot_auto_assigns", async () => {
    const switcher = makeSwitcher();
    patchAdd(switcher);
    captureOutput();

    await switcher.addAccount();

    expect(seq(switcher).accounts).toHaveProperty("1");
  });

  it("test_slot_occupied_cancel", async () => {
    const capsys = captureOutput();
    let switcher = makeSwitcher("a@example.com");
    patchAdd(switcher);
    await switcher.addAccount(3);

    switcher = makeSwitcher("b@example.com");
    patchAdd(switcher);
    vi.spyOn(internals, "input").mockReturnValue("n");
    await switcher.addAccount(3);

    expect(seq(switcher).accounts["3"].email).toBe("a@example.com");
    expect(capsys.readouterr().out).toContain("Cancelled");
  });

  it("test_slot_occupied_overwrite", async () => {
    const capsys = captureOutput();
    let switcher = makeSwitcher("a@example.com");
    patchAdd(switcher, { deleteCreds: true });
    await switcher.addAccount(3);

    switcher = makeSwitcher("b@example.com");
    patchAdd(switcher, { deleteCreds: true });
    vi.spyOn(internals, "input").mockReturnValue("y");
    await switcher.addAccount(3);

    const data = seq(switcher);
    expect(data.accounts["3"].email).toBe("b@example.com");
    expect(Object.keys(data.accounts)).toHaveLength(1);
    expect(capsys.readouterr().out).toContain("Added");
  });

  it("test_migrate_account_to_different_slot", async () => {
    const capsys = captureOutput();
    const switcher = makeSwitcher("user@example.com");
    patchAdd(switcher, { deleteCreds: true });
    await switcher.addAccount();

    expect(seq(switcher).accounts).toHaveProperty("1");

    await switcher.addAccount(5);

    const data = seq(switcher);
    expect(data.accounts).not.toHaveProperty("1");
    expect(data.accounts).toHaveProperty("5");
    expect(data.accounts["5"].email).toBe("user@example.com");
    expect(data.sequence).not.toContain(1);
    expect(data.sequence).toContain(5);
    expect(capsys.readouterr().out).toContain("Moved from slot 1");
  });

  it("test_migrate_with_occupied_target_cancel_preserves_old_slot", async () => {
    const capsys = captureOutput();
    let switcher = makeSwitcher("a@example.com");
    patchAdd(switcher);
    await switcher.addAccount(1);

    switcher = makeSwitcher("b@example.com");
    patchAdd(switcher);
    await switcher.addAccount(3);

    switcher = makeSwitcher("a@example.com");
    patchAdd(switcher);
    vi.spyOn(internals, "input").mockReturnValue("n");
    await switcher.addAccount(3);

    const data = seq(switcher);
    expect(data.accounts["1"].email).toBe("a@example.com");
    expect(data.accounts["3"].email).toBe("b@example.com");
    expect(capsys.readouterr().out).toContain("Cancelled");
  });

  it("test_slot_must_be_positive", async () => {
    const switcher = makeSwitcher();
    vi.spyOn(switcher, "readActiveCredentials").mockReturnValue(activeCredentials(fakeCreds, false));
    captureOutput();

    await expectRejects(switcher.addAccount(0), ConfigError, /must be >= 1/);
  });

  it("test_sequence_stays_sorted", async () => {
    captureOutput();
    let switcher = makeSwitcher("a@example.com");
    patchAdd(switcher);
    await switcher.addAccount(5);

    switcher = makeSwitcher("b@example.com");
    patchAdd(switcher);
    await switcher.addAccount(2);

    expect(seq(switcher).sequence).toEqual([2, 5]);
  });
});

describe("TestPurgeLegacyCleanup", () => {
  // On macOS the backup root and the legacy root are one directory, so pin the Linux layout.
  function ensureLinuxLayout(): void {
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.LINUX);
  }

  /** A switcher made while the legacy directory is absent, then the legacy directory reappears. */
  function makeSwitcherThenRecreateLegacy(): [ClaudeAccountSwitcher, string, string] {
    ensureLinuxLayout();
    const backupDir = getBackupRoot();
    fs.mkdirSync(backupDir, { recursive: true });

    const switcher = new ClaudeAccountSwitcher();

    const legacy = getLegacyBackupRoot();
    fs.mkdirSync(legacy, { recursive: true });
    return [switcher, backupDir, legacy];
  }

  it("test_purge_removes_stale_legacy_directory", () => {
    const [switcher, backupDir, legacy] = makeSwitcherThenRecreateLegacy();
    fs.writeFileSync(path.join(legacy, "ghost.txt"), "should be removed");
    vi.spyOn(internals, "input").mockReturnValue("y");
    captureOutput();

    switcher.purge();

    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it("test_purge_prompt_lists_legacy_when_present", () => {
    const [switcher, backupDir, legacy] = makeSwitcherThenRecreateLegacy();
    vi.spyOn(internals, "input").mockReturnValue("n");
    const capsys = captureOutput();

    switcher.purge();

    const out = capsys.readouterr().out;
    expect(out).toContain(backupDir);
    expect(out).toContain(legacy);
  });

  it("test_purge_prompt_omits_legacy_when_absent", () => {
    ensureLinuxLayout();
    const backupDir = getBackupRoot();
    fs.mkdirSync(backupDir, { recursive: true });
    const legacy = getLegacyBackupRoot();
    expect(fs.existsSync(legacy)).toBe(false);

    const switcher = new ClaudeAccountSwitcher();
    vi.spyOn(internals, "input").mockReturnValue("n");
    const capsys = captureOutput();

    switcher.purge();

    expect(capsys.readouterr().out).not.toContain("Legacy backup directory");
  });
});

describe("TestAddAccountFromToken", () => {
  function makeSwitcher(): ClaudeAccountSwitcher {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.initSequenceFile();
    return switcher;
  }

  /** Replace both backup writers. Return the spies. */
  function patchWrites(switcher: ClaudeAccountSwitcher) {
    return {
      creds: vi.spyOn(switcher, "writeAccountCredentials").mockImplementation(() => {}),
      config: vi.spyOn(switcher, "writeAccountConfig").mockImplementation(() => {}),
    };
  }

  function lastArg(spy: { mock: { calls: unknown[][] } }): string {
    return spy.mock.calls.at(-1)![2] as string;
  }

  it("test_basic_add_stores_account", () => {
    const switcher = makeSwitcher();
    patchWrites(switcher);
    const capsys = captureOutput();

    switcher.addAccountFromToken("sk-ant-oat01-abc", "user@example.com");

    const data = seq(switcher);
    expect(data.accounts).toHaveProperty("1");
    expect(data.accounts["1"].email).toBe("user@example.com");
    expect(data.sequence).toContain(1);
    const out = capsys.readouterr().out;
    expect(out).toContain("Added");
    expect(out).toContain("user@example.com");
  });

  it("test_credentials_blob_format", () => {
    const switcher = makeSwitcher();
    const spies = patchWrites(switcher);
    captureOutput();

    switcher.addAccountFromToken("mytoken", "user@example.com");

    const oauthBlob = JSON.parse(lastArg(spies.creds)).claudeAiOauth;
    expect(oauthBlob.accessToken).toBe("mytoken");
    expect(oauthBlob.scopes).toEqual([...SETUP_TOKEN_SCOPES]);
  });

  it("test_config_blob_contains_email", () => {
    const switcher = makeSwitcher();
    const spies = patchWrites(switcher);
    captureOutput();

    switcher.addAccountFromToken("mytoken", "user@example.com");

    expect(JSON.parse(lastArg(spies.config)).oauthAccount.emailAddress).toBe("user@example.com");
  });

  it("test_explicit_slot", () => {
    const switcher = makeSwitcher();
    patchWrites(switcher);
    captureOutput();

    switcher.addAccountFromToken("tok", "user@example.com", 7);

    const data = seq(switcher);
    expect(data.accounts).toHaveProperty("7");
    expect(data.accounts).not.toHaveProperty("1");
    expect(data.sequence).toContain(7);
  });

  it("test_update_in_place_same_email", () => {
    const switcher = makeSwitcher();
    patchWrites(switcher);
    const capsys = captureOutput();

    switcher.addAccountFromToken("token-v1", "user@example.com");
    switcher.addAccountFromToken("token-v2", "user@example.com");

    expect(Object.keys(seq(switcher).accounts)).toHaveLength(1);
    expect(capsys.readouterr().out).toContain("Updated token");
  });

  it("test_update_in_place_writes_scopes", () => {
    const switcher = makeSwitcher();
    const spies = patchWrites(switcher);
    captureOutput();
    switcher.addAccountFromToken("token-v1", "user@example.com");

    switcher.addAccountFromToken("token-v2", "user@example.com");

    const oauthBlob = JSON.parse(lastArg(spies.creds)).claudeAiOauth;
    expect(oauthBlob.accessToken).toBe("token-v2");
    expect(oauthBlob.scopes).toEqual([...SETUP_TOKEN_SCOPES]);
  });

  it("test_update_in_place_clears_quarantine", () => {
    const switcher = makeSwitcher();
    patchWrites(switcher);
    captureOutput();
    switcher.addAccountFromToken("token-v1", "user@example.com");

    const identity: Identity = ["user@example.com", ""];
    switcher.usageStore.record({ "1": { error: "invalid_grant" } }, { "1": identity });
    expect(switcher.usageStore.entries({ "1": identity })["1"]!.tokenDead()).toBe(true);

    switcher.addAccountFromToken("token-v2", "user@example.com");

    expect(switcher.usageStore.entries({ "1": identity })["1"]!.tokenDead()).toBe(false);
  });

  it("test_new_write_clears_stale_quarantine", () => {
    const switcher = makeSwitcher();
    const identity: Identity = ["user@example.com", ""];
    switcher.usageStore.record({ "5": { error: "invalid_grant" } }, { "5": identity });
    expect(switcher.usageStore.entries({ "5": identity })["5"]!.tokenDead()).toBe(true);
    patchWrites(switcher);
    captureOutput();

    switcher.addAccountFromToken("tok", "user@example.com", 5);

    expect(switcher.usageStore.entries({ "5": identity })["5"]!.tokenDead()).toBe(false);
  });

  it("test_update_in_place_rejects_inconsistent_metadata", () => {
    // Never write account-None-* credentials if the sequence lookup is corrupt.
    const switcher = makeSwitcher();
    vi.spyOn(switcher, "accountExists").mockReturnValue(true);
    const writeCreds = vi.spyOn(switcher, "writeAccountCredentials").mockImplementation(() => {});
    captureOutput();

    expectThrows(() => switcher.addAccountFromToken("token-v2", "user@example.com"), ConfigError, /metadata.*inconsistent/);

    expect(writeCreds).not.toHaveBeenCalled();
  });

  it("test_invalid_email_raises", () => {
    const switcher = makeSwitcher();
    expectThrows(() => switcher.addAccountFromToken("tok", "not-an-email"), ValidationError, /Invalid email/);
  });

  it("test_empty_token_raises", () => {
    const switcher = makeSwitcher();
    expectThrows(() => switcher.addAccountFromToken("   ", "user@example.com"), ValidationError, /empty/);
  });

  it("test_stdin_token", () => {
    const switcher = makeSwitcher();
    vi.spyOn(internals, "readStdinLine").mockReturnValue("stdin-token");
    const spies = patchWrites(switcher);
    captureOutput();

    switcher.addAccountFromToken("-", "user@example.com");

    const oauthBlob = JSON.parse(lastArg(spies.creds)).claudeAiOauth;
    expect(oauthBlob.accessToken).toBe("stdin-token");
    expect(oauthBlob.scopes).toEqual([...SETUP_TOKEN_SCOPES]);
  });

  it("test_slot_zero_raises", () => {
    const switcher = makeSwitcher();
    expectThrows(() => switcher.addAccountFromToken("tok", "user@example.com", 0), ConfigError, />= 1/);
  });

  it("test_sequence_sorted_after_add", () => {
    const switcher = makeSwitcher();
    patchWrites(switcher);
    captureOutput();

    switcher.addAccountFromToken("tok", "a@example.com", 5);
    switcher.addAccountFromToken("tok", "b@example.com", 2);

    expect(seq(switcher).sequence).toEqual([2, 5]);
  });

  it("test_default_email_when_omitted", () => {
    const switcher = makeSwitcher();
    patchWrites(switcher);
    const capsys = captureOutput();

    switcher.addAccountFromToken("tok");

    expect(seq(switcher).accounts["1"].email).toBe("setup-token-1@token.local");
    expect(capsys.readouterr().out).toContain("setup-token-1@token.local");
  });

  it("test_default_email_with_explicit_slot", () => {
    const switcher = makeSwitcher();
    patchWrites(switcher);
    captureOutput();

    switcher.addAccountFromToken("tok", null, 7);

    expect(seq(switcher).accounts["7"].email).toBe("setup-token-7@token.local");
  });

  it("test_default_email_writes_to_config_blob", () => {
    const switcher = makeSwitcher();
    const spies = patchWrites(switcher);
    captureOutput();

    switcher.addAccountFromToken("tok", null, 3);

    expect(JSON.parse(lastArg(spies.config)).oauthAccount.emailAddress).toBe("setup-token-3@token.local");
  });

  it("test_default_email_unique_per_slot", () => {
    const switcher = makeSwitcher();
    patchWrites(switcher);
    captureOutput();

    switcher.addAccountFromToken("tok-a", null, 4);
    switcher.addAccountFromToken("tok-b", null, 8);

    const data = seq(switcher);
    const emails = new Set(["4", "8"].map((n) => data.accounts[n].email));
    expect(emails).toEqual(new Set(["setup-token-4@token.local", "setup-token-8@token.local"]));
  });

  it("test_explicit_email_not_overridden_by_default", () => {
    const switcher = makeSwitcher();
    patchWrites(switcher);
    captureOutput();

    switcher.addAccountFromToken("tok", "me@example.com", 2);

    expect(seq(switcher).accounts["2"].email).toBe("me@example.com");
  });
});

describe("TestPurge", () => {
  it("test_purge_removes_legacy_none_keychain_entry", () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.platform = Platform.MACOS;
    switcher.setupDirectories();
    switcher.writeJson(switcher.sequenceFile, {
      activeAccountNumber: 1,
      lastUpdated: "2024-01-01T00:00:00Z",
      sequence: [1],
      accounts: {
        "1": {
          email: "user@example.com",
          uuid: "",
          organizationUuid: "",
          organizationName: "",
          added: "2024-01-01T00:00:00Z",
        },
      },
    });
    // The legacy keyring sweep deletes only the items that exist, so seed them.
    keychainStore().setPassword("claude-code", "account-1-user@example.com", "x");
    keychainStore().setPassword("claude-code", "account-None-user@example.com", "x");
    const deletePassword = vi.spyOn(keychainInternals, "deletePassword");
    vi.spyOn(internals, "input").mockReturnValue("y");
    captureOutput();

    switcher.purge();

    const calls = deletePassword.mock.calls.map((c) => [c[0], c[1]]);
    expect(calls).toEqual(
      expect.arrayContaining([
        [SECURITY_SERVICE, "account-1-user@example.com"],
        [SECURITY_SERVICE, "account-None-user@example.com"],
        ["claude-code", "account-1-user@example.com"],
        ["claude-code", "account-None-user@example.com"],
      ]),
    );
  });
});

/** The `_setup` / `_seed` helpers of `TestSwitchSkipsBrokenSlots`. */
function setupLinuxSwitcher(): ClaudeAccountSwitcher {
  const s = new ClaudeAccountSwitcher();
  s.platform = Platform.LINUX;
  s.setupDirectories();
  s.initSequenceFile();
  return s;
}

function seedAccount(s: ClaudeAccountSwitcher, num: number, email: string, { creds = true, config = true } = {}): void {
  if (creds) {
    s.writeAccountCredentials(String(num), email, dumps({ claudeAiOauth: { accessToken: `sk-${num}`, refreshToken: `rt-${num}` } }));
  }
  if (config) {
    s.writeAccountConfig(String(num), email, dumps({ oauthAccount: { emailAddress: email, accountUuid: `uuid-${num}` } }));
  }
  const data = (s.getSequenceData() ?? {
    activeAccountNumber: null,
    lastUpdated: "",
    sequence: [],
    accounts: {},
  }) as Json;
  data.accounts[String(num)] = {
    email,
    uuid: `uuid-${num}`,
    organizationUuid: "",
    organizationName: "",
    added: "2024-01-01T00:00:00Z",
  };
  if (!data.sequence.includes(num)) {
    data.sequence.push(num);
    data.sequence.sort((a: number, b: number) => a - b);
  }
  if (data.activeAccountNumber === null || data.activeAccountNumber === undefined) data.activeAccountNumber = num;
  s.writeJson(s.sequenceFile, data);
}

function writeLiveLogin(credsJson: Json, email: string, num: number): void {
  writeText(homePath(".claude", ".credentials.json"), dumps(credsJson));
  writeText(homePath(".claude.json"), dumps({ oauthAccount: { emailAddress: email, accountUuid: `uuid-${num}` } }));
}

describe("TestSwitchSkipsBrokenSlots", () => {
  const liveCreds = { claudeAiOauth: { accessToken: "sk-live-1", refreshToken: "rt-live-1" } };

  it("test_account_is_switchable_helper", () => {
    const s = setupLinuxSwitcher();
    seedAccount(s, 1, "a@example.com");
    seedAccount(s, 2, "b@example.com", { creds: false });
    seedAccount(s, 3, "c@example.com", { config: false });

    expect(s.accountIsSwitchable("1")).toBe(true);
    expect(s.accountIsSwitchable("2")).toBe(false);
    expect(s.accountIsSwitchable("3")).toBe(false);
    // A stale sequence reference to a missing account record.
    expect(s.accountIsSwitchable("99")).toBe(false);
  });

  it("test_rotation_skips_broken_next_slot", async () => {
    const s = setupLinuxSwitcher();
    seedAccount(s, 1, "a@example.com");
    seedAccount(s, 2, "b@example.com", { creds: false });
    seedAccount(s, 3, "c@example.com");
    writeLiveLogin(liveCreds, "a@example.com", 1);
    vi.spyOn(s, "listAccounts").mockResolvedValue(null);
    const capsys = captureOutput();

    await s.switch();

    expect(capsys.readouterr().out).toContain("Skipping Account-2");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(3);
  });

  it("test_rotation_no_valid_targets_returns_without_error", async () => {
    const s = setupLinuxSwitcher();
    seedAccount(s, 1, "a@example.com");
    seedAccount(s, 2, "b@example.com", { creds: false });
    writeLiveLogin(liveCreds, "a@example.com", 1);
    const capsys = captureOutput();

    await s.switch();

    const out = capsys.readouterr().out;
    expect(out).toContain("Skipping Account-2");
    expect(out).toContain("No other accounts have valid");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(1);
  });

  it("test_switch_to_missing_credentials_actionable_error", async () => {
    const s = setupLinuxSwitcher();
    seedAccount(s, 1, "a@example.com");
    seedAccount(s, 2, "b@example.com", { creds: false });
    writeLiveLogin(liveCreds, "a@example.com", 1);
    captureOutput();

    await expectRejects(s.switchTo("2"), SwitchError, /has no stored credentials/);
  });

  it("test_switch_to_missing_config_actionable_error", async () => {
    const s = setupLinuxSwitcher();
    seedAccount(s, 1, "a@example.com");
    seedAccount(s, 2, "b@example.com", { config: false });
    writeLiveLogin(liveCreds, "a@example.com", 1);
    captureOutput();

    await expectRejects(s.switchTo("2"), SwitchError, /has no stored config backup/);
  });

  it("test_fresh_machine_skips_broken_preferred_target", async () => {
    const s = setupLinuxSwitcher();
    seedAccount(s, 1, "a@example.com", { creds: false });
    seedAccount(s, 2, "b@example.com");
    // The recorded active account 1 is broken, as after an import and a later corruption.
    const data = seq(s);
    data.activeAccountNumber = 1;
    s.writeJson(s.sequenceFile, data);
    vi.spyOn(s, "listAccounts").mockResolvedValue(null);
    const capsys = captureOutput();

    await s.switch();

    expect(capsys.readouterr().out).toContain("Skipping Account-1");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(2);
  });

  it("test_fresh_machine_skips_disabled_preferred_target", async () => {
    const s = setupLinuxSwitcher();
    seedAccount(s, 1, "a@example.com");
    seedAccount(s, 2, "b@example.com");
    const capsys = captureOutput();
    s.setAccountDisabled("1", true);
    capsys.readouterr();
    vi.spyOn(s, "listAccounts").mockResolvedValue(null);

    await s.switch();

    expect(capsys.readouterr().out).toContain("Skipping Account-1 (disabled)");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(2);
  });

  it("test_fresh_machine_all_broken_raises", async () => {
    const s = setupLinuxSwitcher();
    seedAccount(s, 1, "a@example.com", { creds: false });
    seedAccount(s, 2, "b@example.com", { config: false });
    captureOutput();

    await expectRejects(s.switch(), ConfigError, /No managed accounts have valid/);
  });

  it("test_fresh_machine_all_disabled_raises", async () => {
    const s = setupLinuxSwitcher();
    seedAccount(s, 1, "a@example.com");
    seedAccount(s, 2, "b@example.com");
    captureOutput();
    s.setAccountDisabled("1", true);
    s.setAccountDisabled("2", true);

    await expectRejects(s.switch(), ConfigError, /No accounts remain in rotation/);
  });
});

/** The `_make_live` helper of `TestUsageAwareSwitch`: make account `num` the live Claude login. */
function makeLive(email: string, num: number): void {
  writeLiveLogin({ claudeAiOauth: { accessToken: "sk-live", refreshToken: "rt-live" } }, email, num);
}

type UsageMap = Record<string, UsageDict | string | null>;

const usage = (pct: number): UsageDict => ({ five_hour: { pct }, seven_day: { pct: 0.0 } }) as UsageDict;

const modelUsage = (fiveH: number, fable: number): UsageDict =>
  ({ five_hour: { pct: fiveH }, seven_day: { pct: 0.0 }, scoped: [{ name: "Fable", pct: fable }] }) as UsageDict;

function threeAccounts(liveEmail = "a@example.com", liveNum = 1): ClaudeAccountSwitcher {
  const s = setupLinuxSwitcher();
  seedAccount(s, 1, "a@example.com");
  seedAccount(s, 2, "b@example.com");
  seedAccount(s, 3, "c@example.com");
  makeLive(liveEmail, liveNum);
  return s;
}

function twoAccounts(): ClaudeAccountSwitcher {
  const s = setupLinuxSwitcher();
  seedAccount(s, 1, "a@example.com");
  seedAccount(s, 2, "b@example.com");
  makeLive("a@example.com", 1);
  return s;
}

function patchUsage(s: ClaudeAccountSwitcher, usageMap: UsageMap) {
  vi.spyOn(s, "usageByAccount").mockResolvedValue(usageMap);
  return vi.spyOn(s, "listAccounts").mockResolvedValue(null);
}

describe("TestUsageAwareSwitch", () => {
  it("test_best_switches_to_more_headroom", async () => {
    const s = threeAccounts();
    // Current (1) has 50% headroom; 3 has 80% (best), 2 has 10%.
    patchUsage(s, { "1": usage(50), "2": usage(90), "3": usage(20) });
    captureOutput();

    await s.switch("best");

    expect(s.getSequenceData()!.activeAccountNumber).toBe(3);
  });

  it("test_best_stays_when_current_is_already_best", async () => {
    const s = twoAccounts();
    // Current (1) has 11% headroom; the only other (2) is at its limit.
    const mockList = patchUsage(s, { "1": usage(89), "2": usage(100) });
    const capsys = captureOutput();

    await s.switch("best");

    expect(capsys.readouterr().out).toContain("Already on the account with the most remaining quota");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(1);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("test_best_all_exhausted_stays_put", async () => {
    const s = threeAccounts();
    patchUsage(s, { "1": usage(100), "2": usage(100), "3": usage(100) });
    const capsys = captureOutput();

    await s.switch("best");

    const out = capsys.readouterr().out;
    expect(out).toContain("All accounts are at their 5h/7d limit");
    expect(out).toContain("staying on Account-1");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(1);
  });

  it("test_best_current_usage_unavailable_stays", async () => {
    const s = twoAccounts();
    // Current usage unknown: no target is provably better.
    const mockList = patchUsage(s, { "1": null, "2": usage(10) });
    const capsys = captureOutput();

    await s.switch("best");

    expect(capsys.readouterr().out).toContain("Current account usage is unavailable");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(1);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("test_best_no_candidate_usage_stays", async () => {
    const s = twoAccounts();
    const mockList = patchUsage(s, { "1": usage(50), "2": null });
    const capsys = captureOutput();

    await s.switch("best");

    const out = capsys.readouterr().out;
    expect(out).toContain("No other account has usage data to compare");
    expect(out).not.toContain("All accounts are at their 5h/7d limit");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(1);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("test_best_incomplete_comparison_stays", async () => {
    const s = threeAccounts();
    // Current (1) 50% headroom; 2 worse (10%); 3 unknown.
    const mockList = patchUsage(s, { "1": usage(50), "2": usage(90), "3": null });
    const capsys = captureOutput();

    await s.switch("best");

    const out = capsys.readouterr().out;
    expect(out).toContain("some usage is unavailable");
    expect(out).not.toContain("most remaining quota");
    expect(out).not.toContain("All accounts are at their 5h/7d limit");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(1);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("test_best_current_exhausted_with_unknown_candidate_stays", async () => {
    const s = threeAccounts();
    // The unknown account 3 can have room, so "all exhausted" is false.
    const mockList = patchUsage(s, { "1": usage(100), "2": usage(100), "3": null });
    const capsys = captureOutput();

    await s.switch("best");

    const out = capsys.readouterr().out;
    expect(out).toContain("some usage is unavailable");
    expect(out).not.toContain("All accounts are at their 5h/7d limit");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(1);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("test_skip_exhausted_skips_limited_account", async () => {
    const s = threeAccounts();
    patchUsage(s, { "1": usage(0), "2": usage(100), "3": usage(20) });
    const capsys = captureOutput();

    await s.switch("next-available");

    expect(capsys.readouterr().out).toContain("Skipping Account-2 (at 5h/7d limit)");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(3);
  });

  it("test_next_available_with_models_skips_and_names_the_window", async () => {
    const s = threeAccounts();
    patchUsage(s, { "1": modelUsage(0, 10), "2": modelUsage(5, 100), "3": modelUsage(20, 20) });
    const capsys = captureOutput();

    await s.switch("next-available", false, ["Fable"], "autoswitch.model");

    const out = capsys.readouterr().out;
    expect(out).toContain("Using configured model limits: Fable (from autoswitch.model)");
    expect(out).toContain("Skipping Account-2 (at Fable limit)");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(3);
  });

  it("test_next_available_without_models_ignores_scoped", async () => {
    const s = threeAccounts();
    patchUsage(s, { "1": modelUsage(0, 10), "2": modelUsage(5, 100), "3": modelUsage(20, 20) });
    const capsys = captureOutput();

    await s.switch("next-available");

    const out = capsys.readouterr().out;
    expect(out).not.toContain("Using configured model limits");
    expect(out).not.toContain("Skipping");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(2);
  });

  it("test_best_noop_json_keeps_inert_model_warning", async () => {
    // The typo warning must reach the JSON payload when `best` stays too.
    const s = twoAccounts();
    captureOutput();
    const byAccount = vi.spyOn(s, "usageByAccount");

    byAccount.mockResolvedValue({ "1": modelUsage(0, 10), "2": modelUsage(50, 10) });
    let payload = (await s.switch("best", true, ["Fabel"], "cli"))!;
    expect(payload.switched).toBe(false);
    expect(payload.reason).toBe("already-best");
    expect(payload.warnings.some((w) => w.includes("Fabel"))).toBe(true);

    byAccount.mockResolvedValue({ "1": modelUsage(100, 10), "2": modelUsage(100, 10) });
    payload = (await s.switch("best", true, ["Fabel"], "cli"))!;
    expect(payload.reason).toBe("candidates-exhausted");
    expect(payload.warnings.some((w) => w.includes("Fabel"))).toBe(true);
  });

  it("test_manual_strategies_warn_on_inert_model_name", async () => {
    const s = twoAccounts();
    patchUsage(s, { "1": modelUsage(0, 10), "2": modelUsage(5, 10) });
    const capsys = captureOutput();

    await s.switch("next-available", false, ["Fabel"], "cli");
    expect(capsys.readouterr().out).toContain("Fabel");

    // A matching name stays quiet.
    await s.switch("best", false, ["Fable"], "cli");
    expect(capsys.readouterr().out).not.toContain("typo");
  });

  it("test_best_with_models_folds_scoped_into_the_comparison", async () => {
    // On 5h alone nothing beats the current account. With Fable folded in, account 2 has the most headroom.
    const s = threeAccounts();
    patchUsage(s, { "1": modelUsage(5, 90), "2": modelUsage(5, 20), "3": modelUsage(50, 80) });
    const capsys = captureOutput();

    await s.switch("best", false, ["Fable"], "cli");

    expect(capsys.readouterr().out).toContain("Using configured model limits: Fable (from --model)");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(2);
  });

  it("test_skip_exhausted_all_limited_stays_put", async () => {
    const s = threeAccounts();
    const mockList = patchUsage(s, { "1": usage(0), "2": usage(100), "3": usage(100) });
    const capsys = captureOutput();

    await s.switch("next-available");

    expect(capsys.readouterr().out).toContain("staying on Account-1");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(1);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("test_skip_exhausted_unknown_usage_is_not_skipped", async () => {
    const s = twoAccounts();
    // Unknown usage for account 2 must not cause a skip.
    patchUsage(s, { "1": null, "2": null });
    captureOutput();

    await s.switch("next-available");

    expect(s.getSequenceData()!.activeAccountNumber).toBe(2);
  });

  it("test_next_available_anchors_on_live_account_under_drift", async () => {
    const s = setupLinuxSwitcher();
    seedAccount(s, 1, "a@example.com");
    seedAccount(s, 2, "b@example.com");
    seedAccount(s, 3, "c@example.com");
    // The recorded active account is 1, but the live login is account 2.
    const data = seq(s);
    data.activeAccountNumber = 1;
    s.writeJson(s.sequenceFile, data);
    makeLive("b@example.com", 2);
    patchUsage(s, { "1": usage(0), "2": usage(0), "3": usage(0) });
    captureOutput();

    await s.switch("next-available");

    // Anchored on the live account (2): the next is 3, not 2 (a no-op).
    expect(s.getSequenceData()!.activeAccountNumber).toBe(3);
  });
});

describe("TestClaudeCodeLockCooperation", () => {
  const defaultTimeout = claudeLocks.internals.DEFAULT_TIMEOUT_S;

  afterEach(() => {
    claudeLocks.internals.DEFAULT_TIMEOUT_S = defaultTimeout;
  });

  it("test_switch_holds_both_cc_locks_at_write_time", async () => {
    const s = twoAccounts();
    const credsLock = homePath(".claude.lock");
    const configLock = homePath(".claude.json.lock");
    const isDir = (p: string): boolean => fs.existsSync(p) && fs.statSync(p).isDirectory();
    const seen: Array<[boolean, boolean]> = [];
    const originalWrite = s.writeCredentials.bind(s);
    vi.spyOn(s, "writeCredentials").mockImplementation((credentials) => {
      seen.push([isDir(credsLock), isDir(configLock)]);
      originalWrite(credentials);
    });
    vi.spyOn(s, "listAccounts").mockResolvedValue(null);
    captureOutput();

    await s.switchTo("2");

    expect(s.getSequenceData()!.activeAccountNumber).toBe(2);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(([a, b]) => a && b)).toBe(true);
    // Released after the switch.
    expect(fs.existsSync(credsLock)).toBe(false);
    expect(fs.existsSync(configLock)).toBe(false);
  });

  it("test_preheld_cc_lock_fails_cleanly_without_mutation", async () => {
    const s = twoAccounts();
    claudeLocks.internals.DEFAULT_TIMEOUT_S = 0.3;
    // A fresh mtime means a live Claude Code refresh.
    fs.mkdirSync(homePath(".claude.lock"));
    const liveCredsBefore = fs.readFileSync(homePath(".claude", ".credentials.json"), "utf8");
    captureOutput();

    await expectRejects(s.switchTo("2"), ClaudeCodeLockTimeout);

    // Nothing changed: the locks come before any write.
    expect(s.getSequenceData()!.activeAccountNumber).toBe(1);
    expect(fs.readFileSync(homePath(".claude", ".credentials.json"), "utf8")).toBe(liveCredsBefore);
    // The lock of the holder stays.
    expect(fs.statSync(homePath(".claude.lock")).isDirectory()).toBe(true);
  });
});
