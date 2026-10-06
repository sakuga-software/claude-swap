import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeCredentials, internals as credentialsInternals } from "../src/credentials.js";
import { AccountNotFoundError, CredentialReadError, LockError, SwitchError, ValidationError } from "../src/exceptions.js";
import {
  USAGE_KEYCHAIN_UNAVAILABLE,
  USAGE_NO_CREDENTIALS,
  USAGE_RELOGIN_REQUIRED,
} from "../src/json_output.js";
import { FileLock } from "../src/locking.js";
import { KeychainError, internals as keychainInternals, keychainAccountName } from "../src/macos_keychain.js";
import { Platform } from "../src/models.js";
import {
  DETERMINISTIC_REFRESH_ERRORS,
  credentialFingerprint,
  internals as oauthInternals,
  refreshOutcome,
} from "../src/oauth.js";
import { getCredentialsPath } from "../src/paths.js";
import { sessionDirFor } from "../src/session.js";
import {
  type AccountInfoRow,
  CLAUDE_CODE_KEYCHAIN_SERVICE,
  ClaudeAccountSwitcher,
  ERROR_NOTES,
  type SequenceData,
  type SwitcherLock,
  internals,
} from "../src/switcher.js";
import type { Identity } from "../src/usage_store.js";
import { mockClaudeConfig, sampleSequenceData } from "./helpers/fixtures.js";
import { keychainStore } from "./helpers/keychain.js";
import { testHome } from "./helpers/home.js";

const savedSwitcherInternals = { ...internals };
const savedCredentialsInternals = { ...credentialsInternals };
const posixPermissions = process.platform !== "win32" && process.getuid?.() !== 0;

let stdout: string[];

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
  Object.assign(internals, savedSwitcherInternals);
  Object.assign(credentialsInternals, savedCredentialsInternals);
});

/** `capsys.readouterr().out`: the stdout since the last call. */
function readOut(): string {
  const text = stdout.join("");
  stdout = [];
  return text;
}

function raiseLocked(): never {
  throw new KeychainError("locked");
}

function permissionDenied(file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, open '${file}'`), {
    code: "EACCES",
    errno: -13,
    syscall: "open",
    path: file,
  });
}

/** Make `fs.readFileSync` throw EACCES for each path that `denied` accepts, while `active()` is true. */
function denyReads(denied: (file: string) => boolean, active: () => boolean = () => true): void {
  const real = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (active() && typeof file === "string" && denied(file)) throw permissionDenied(file);
    return (real as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync);
}

function oauthCreds(accessToken: string, refreshToken: string, expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt } });
}

/** Replace the refresh POST of `oauth` and record each credential that it gets. */
function mockRefresh(outcome: () => ReturnType<typeof refreshOutcome>, onCall?: () => void): string[] {
  const posted: string[] = [];
  oauthInternals.tryRefreshOauthCredentials = vi.fn(async (credentials: string) => {
    posted.push(credentials);
    onCall?.();
    return outcome();
  });
  return posted;
}

function gateSwitcher(): ClaudeAccountSwitcher {
  const data = sampleSequenceData();
  data.accounts["1"].email = "test@example.com";
  const s = new ClaudeAccountSwitcher();
  s.setupDirectories();
  s.writeJson(s.sequenceFile, data);
  return s;
}

/** `sequence.json` with every member present, as the tests build it. */
type FullSequenceData = Required<Pick<SequenceData, "activeAccountNumber" | "lastUpdated" | "sequence" | "accounts">> &
  SequenceData;

function seq(s: ClaudeAccountSwitcher): FullSequenceData {
  return s.getSequenceData() as FullSequenceData;
}

const OLD = oauthCreds("sk-old", "rt-old", 1000);
const NEW = oauthCreds("sk-new", "rt-new", 9999999999000);

describe("TestAddAccountAlias", () => {
  const fakeCreds = JSON.stringify({ claudeAiOauth: { accessToken: "tok" } });

  function configSwitcher(email: string): ClaudeAccountSwitcher {
    const config = {
      oauthAccount: { emailAddress: email, accountUuid: `uuid-${email}`, organizationUuid: "", organizationName: "" },
    };
    fs.writeFileSync(path.join(testHome(), ".claude.json"), JSON.stringify(config));
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.initSequenceFile();
    return s;
  }

  function patchStorage(s: ClaudeAccountSwitcher): void {
    vi.spyOn(s, "readActiveCredentials").mockReturnValue(activeCredentials(fakeCreds, false));
    vi.spyOn(s, "writeAccountCredentials").mockImplementation(() => {});
    vi.spyOn(s, "deleteAccountCredentials").mockImplementation(() => {});
  }

  it("test_add_account_sets_alias", async () => {
    const s = configSwitcher("a@x.com");
    patchStorage(s);
    await s.addAccount(null, false, "dev");

    expect(seq(s).accounts["1"]!.alias).toBe("dev");
  });

  it("test_readd_without_alias_preserves_existing", async () => {
    const s = configSwitcher("a@x.com");
    patchStorage(s);
    await s.addAccount(null, false, "dev");
    await s.addAccount();

    expect(seq(s).accounts["1"]!.alias).toBe("dev");
  });

  it("test_readd_refresh_in_place_applies_new_alias", async () => {
    const s = configSwitcher("a@x.com");
    patchStorage(s);
    await s.addAccount();
    await s.addAccount(null, false, "work");

    expect(seq(s).accounts["1"]!.alias).toBe("work");
  });

  it("test_explicit_slot_migration_preserves_alias", async () => {
    const s = configSwitcher("a@x.com");
    patchStorage(s);
    await s.addAccount(null, false, "dev");
    await s.addAccount(5);

    const data = seq(s);
    expect(data.accounts).not.toHaveProperty("1");
    expect(data.accounts["5"]!.alias).toBe("dev");
  });

  it("test_add_account_duplicate_alias_raises", async () => {
    const s = configSwitcher("a@x.com");
    const data = seq(s);
    data.accounts["9"] = { email: "other@x.com", uuid: "u9", alias: "dev", added: "2024-01-01T00:00:00Z" };
    data.sequence = [9];
    s.writeJson(s.sequenceFile, data);

    patchStorage(s);
    await expect(s.addAccount(null, false, "dev")).rejects.toThrow(ValidationError);
  });
});

describe("TestDisableEnableAccount", () => {
  function setup(): ClaudeAccountSwitcher {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.LINUX;
    s.setupDirectories();
    s.initSequenceFile();
    return s;
  }

  /** Add a fully switchable slot (credential and config backups present). */
  function seed(s: ClaudeAccountSwitcher, num: number, email: string): void {
    s.writeAccountCredentials(
      String(num),
      email,
      JSON.stringify({ claudeAiOauth: { accessToken: `sk-${num}`, refreshToken: `rt-${num}` } }),
    );
    s.writeAccountConfig(
      String(num),
      email,
      JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: `uuid-${num}` } }),
    );
    const data: FullSequenceData = seq(s) ?? {
      activeAccountNumber: null,
      lastUpdated: "",
      sequence: [],
      accounts: {},
    };
    data.accounts[String(num)] = {
      email,
      uuid: `uuid-${num}`,
      organizationUuid: "",
      organizationName: "",
      added: "2024-01-01T00:00:00Z",
    };
    if (!data.sequence.includes(num)) {
      data.sequence.push(num);
      data.sequence.sort((a, b) => a - b);
    }
    if (data.activeAccountNumber === null) data.activeAccountNumber = num;
    s.writeJson(s.sequenceFile, data);
  }

  /** Point the live login at a seeded account. */
  function makeLive(email: string, num: number): void {
    fs.writeFileSync(
      path.join(testHome(), ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: `sk-live-${num}`, refreshToken: `rt-live-${num}` } }),
    );
    fs.writeFileSync(
      path.join(testHome(), ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: `uuid-${num}` } }),
    );
  }

  it("test_disable_sets_flag_and_excludes_from_rotation", () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");
    seed(s, 3, "c@example.com");

    s.setAccountDisabled("2", true);

    expect(s.isAccountDisabled("2")).toBe(true);
    expect(s.disabledAccountNumbers()).toEqual(["2"]);
    expect(s.switchableAccountNumbers()).toEqual(["1", "3"]);
    expect(seq(s).accounts["2"]!.disabled).toBe(true);
    expect(readOut()).toContain("Disabled Account-2");
  });

  it("test_enable_clears_flag_and_restores_position", () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");
    seed(s, 3, "c@example.com");

    s.setAccountDisabled("2", true);
    readOut();
    s.setAccountDisabled("2", false);

    expect(s.isAccountDisabled("2")).toBe(false);
    expect(s.disabledAccountNumbers()).toEqual([]);
    expect(s.switchableAccountNumbers()).toEqual(["1", "2", "3"]);
    expect(seq(s).accounts["2"]).not.toHaveProperty("disabled");
    expect(readOut()).toContain("Enabled Account-2");
  });

  it("test_disable_by_email", () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");

    s.setAccountDisabled("b@example.com", true);

    expect(s.isAccountDisabled("2")).toBe(true);
  });

  it("test_disable_and_enable_by_alias", () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");
    s.setAlias("2", "dev");

    s.setAccountDisabled("dev", true);
    expect(s.isAccountDisabled("2")).toBe(true);
    expect(s.switchableAccountNumbers()).toEqual(["1"]);

    s.setAccountDisabled("dev", false);
    expect(s.isAccountDisabled("2")).toBe(false);
    expect(s.switchableAccountNumbers()).toEqual(["1", "2"]);
  });

  it("test_repeated_disable_is_noop", () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");

    s.setAccountDisabled("2", true);
    readOut();
    s.setAccountDisabled("2", true);

    expect(readOut()).toContain("already disabled");
    expect(s.isAccountDisabled("2")).toBe(true);
  });

  it("test_enable_when_not_disabled_is_noop", () => {
    const s = setup();
    seed(s, 1, "a@example.com");

    s.setAccountDisabled("1", false);

    expect(readOut()).toContain("already enabled");
  });

  it("test_disable_unknown_account_raises", () => {
    const s = setup();
    seed(s, 1, "a@example.com");

    expect(() => s.setAccountDisabled("99", true)).toThrow(AccountNotFoundError);
  });

  it("test_rotation_skips_disabled_slot", async () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");
    seed(s, 3, "c@example.com");
    s.setAccountDisabled("2", true);
    readOut();
    makeLive("a@example.com", 1);

    vi.spyOn(s, "listAccounts").mockResolvedValue(null);
    await s.switch();

    expect(readOut()).toContain("Skipping Account-2 (disabled)");
    expect(seq(s).activeAccountNumber).toBe(3);
  });

  it("test_best_strategy_ignores_disabled_candidate", async () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");
    s.setAccountDisabled("2", true);

    const [target, note] = await s.selectBestSwitchable("1");

    expect(target).toBeNull();
    expect(note).toBe("none");
  });

  it("test_explicit_switch_to_disabled_still_works", async () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");
    s.setAccountDisabled("2", true);
    makeLive("a@example.com", 1);

    vi.spyOn(s, "listAccounts").mockResolvedValue(null);
    await s.switchTo("2");

    expect(seq(s).activeAccountNumber).toBe(2);
  });

  it("test_remove_then_readd_clears_disabled", () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");
    s.setAccountDisabled("2", true);

    const data = seq(s);
    delete data.accounts["2"];
    data.sequence = data.sequence.filter((n) => n !== 2);
    s.writeJson(s.sequenceFile, data);
    seed(s, 2, "b@example.com");

    expect(s.isAccountDisabled("2")).toBe(false);
  });

  it("test_disable_active_account_warns_but_sets_flag", () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");

    s.setAccountDisabled("1", true);

    expect(readOut()).toContain("active account");
    expect(s.isAccountDisabled("1")).toBe(true);
  });

  it("test_disable_last_rotation_account_warns", () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");

    s.setAccountDisabled("1", true);
    readOut();
    s.setAccountDisabled("2", true);

    expect(readOut()).toContain("No accounts remain in rotation");
  });

  it("test_list_shows_disabled_marker", async () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");
    s.setAccountDisabled("2", true);
    readOut();

    vi.spyOn(s, "readCredentials").mockReturnValue("");
    vi.spyOn(s, "readAccountCredentials").mockReturnValue("");
    await s.listAccounts();

    const out = readOut();
    expect(out).toContain("(disabled)");
    const disabledLine = out.split("\n").find((ln) => ln.trim().startsWith("2:"));
    expect(disabledLine).toContain("(disabled)");
  });

  it("test_json_list_carries_disabled_field", async () => {
    const s = setup();
    seed(s, 1, "a@example.com");
    seed(s, 2, "b@example.com");
    s.setAccountDisabled("2", true);

    vi.spyOn(s, "readCredentials").mockReturnValue("");
    vi.spyOn(s, "readAccountCredentials").mockReturnValue("");
    const payload = (await s.listAccounts(false, true))!;

    const rows = new Map((payload.accounts as Array<Record<string, unknown>>).map((r) => [r.number, r]));
    expect(rows.get(2)!.disabled).toBe(true);
    expect(rows.get(1)).not.toHaveProperty("disabled");
  });
});

describe("TestDegradedReadProvenance", () => {
  it("test_an_empty_slot_under_pinned_file_mode_reads_as_empty", () => {
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.platform = Platform.MACOS;
    const store = s.store;
    store.pinFileMode({ residualCleared: true });

    const got = store.readActiveCredentials();
    expect(got.value).toBe("");
    expect(got.keychainUnavailable).toBe(false);
  });

  it("test_pinned_file_mode_is_not_a_degraded_read", () => {
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.platform = Platform.MACOS;
    const store = s.store;
    const creds = path.join(testHome(), ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(creds), { recursive: true });
    fs.writeFileSync(creds, oauthCreds("sk-live", "rt-live", 9_999_999_999_000));
    store.pinFileMode({ residualCleared: true });
    expect(store.readActiveCredentials().degraded).toBe(false);
  });

  function macosSwitcher(): ClaudeAccountSwitcher {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.MACOS;
    s.setupDirectories();
    return s;
  }

  it("test_file_covered_keychain_failure_is_degraded", () => {
    const s = macosSwitcher();
    const cred = getCredentialsPath();
    fs.mkdirSync(path.dirname(cred), { recursive: true });
    fs.writeFileSync(cred, "FROM-FILE");
    keychainInternals.getPassword = raiseLocked;
    credentialsInternals.ACTIVE_READ_RETRY_DELAY = 0;
    const result = s.readActiveCredentials();
    expect(result.value).toBe("FROM-FILE");
    expect(result.keychainUnavailable).toBe(false);
    expect(result.degraded).toBe(true);
  });

  it("test_healthy_keychain_read_is_not_degraded", () => {
    const s = macosSwitcher();
    keychainStore().setPassword(CLAUDE_CODE_KEYCHAIN_SERVICE, keychainAccountName(), "FROM-KC");
    const result = s.readActiveCredentials();
    expect(result.value).toBe("FROM-KC");
    expect(result.degraded).toBe(false);
  });

  it("test_linux_file_read_is_not_degraded", () => {
    const s = new ClaudeAccountSwitcher();
    const cred = getCredentialsPath();
    fs.mkdirSync(path.dirname(cred), { recursive: true });
    fs.writeFileSync(cred, "FROM-FILE");
    const result = s.readActiveCredentials();
    expect(result.value).toBe("FROM-FILE");
    expect(result.degraded).toBe(false);
  });

  it("test_degraded_active_read_never_consumes", async () => {
    mockClaudeConfig();
    const data = sampleSequenceData();
    data.accounts["1"].email = "test@example.com";
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.writeJson(s.sequenceFile, data);
    const stale = oauthCreds("sk-stale", "rt-stale", 1000);
    vi.spyOn(s.store, "readActiveCredentials").mockReturnValue(activeCredentials(stale, false, true));
    s.recordActiveVerdict(activeCredentials("", false, true));
    vi.spyOn(s, "readAccountCredentials").mockReturnValue(stale);
    const refresh = vi.fn();
    oauthInternals.tryRefreshOauthCredentials = refresh;
    internals.tryFetchUsageForAccount = vi.fn();

    const result = await s.fetchActiveUsage("1", "test@example.com", stale);

    expect(refresh).not.toHaveBeenCalled();
    expect(result.sentinel).toBe(USAGE_KEYCHAIN_UNAVAILABLE);
    expect(result.error ?? null).toBeNull();
  });

  it("test_status_path_sets_the_degraded_flag_too", async () => {
    mockClaudeConfig();
    const data = sampleSequenceData();
    data.accounts["1"].email = "test@example.com";
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.writeJson(s.sequenceFile, data);
    const stale = oauthCreds("sk-stale", "rt-stale", 1000);
    vi.spyOn(s.store, "readActiveCredentials").mockReturnValue(activeCredentials(stale, false, true));
    expect(s.activeReadDegraded).toBe(false);

    vi.spyOn(s, "readAccountCredentials").mockReturnValue(stale);
    internals.tryFetchUsageForAccount = vi.fn();
    await s.activeAccountUsage("1", "test@example.com", "");

    expect(s.activeReadDegraded).toBe(true);
  });
});

describe("TestBackupReadTriState", () => {
  function macosSwitcher(): ClaudeAccountSwitcher {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.MACOS;
    s.setupDirectories();
    return s;
  }

  it("test_keychain_error_reports_unreadable", () => {
    const s = macosSwitcher();
    keychainInternals.getPassword = raiseLocked;
    expect(s.store.readAccountCredentialsEx("1", "test@example.com")).toEqual(["", true]);
  });

  it("test_absent_backup_is_not_unreadable", () => {
    const s = macosSwitcher();
    expect(s.store.readAccountCredentialsEx("1", "test@example.com")).toEqual(["", false]);
  });

  it("test_enc_file_read_is_not_unreadable", () => {
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.store.writeAccountCredentials("1", "test@example.com", "CREDS");
    expect(s.store.readAccountCredentialsEx("1", "test@example.com")).toEqual(["CREDS", false]);
  });
});

describe("TestEncPermissionDeniedIsUnreadable", () => {
  it.skipIf(!posixPermissions)("test_unreadable_enc_is_not_absent_on_linux", () => {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.LINUX;
    s.setupDirectories();
    const [num, email] = ["3", "c@example.com"];
    s.writeAccountCredentials(num, email, '{"access_token":"live"}');
    const enc = s.backupEncPath(num, email);
    expect(fs.existsSync(enc)).toBe(true);

    const [vA, unreadA] = s.store.readAccountCredentialsEx(num, email);
    expect(vA).toBeTruthy();
    expect(unreadA).toBe(false);

    expect(s.store.readAccountCredentialsEx("9", "nobody@example.com")).toEqual(["", false]);

    fs.chmodSync(enc, 0o000);
    let unreadC: boolean;
    try {
      [, unreadC] = s.store.readAccountCredentialsEx(num, email);
    } finally {
      fs.chmodSync(enc, 0o600);
    }
    expect(unreadC).toBe(true);
  });

  it.skipIf(!posixPermissions)("test_unreadable_enc_is_not_absent_on_macos", () => {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.MACOS;
    s.setupDirectories();
    const [num, email] = ["3", "c@example.com"];
    s.writeBackupEnc(num, email, '{"access_token":"live"}');
    const enc = s.backupEncPath(num, email);

    const [vA, unreadA] = s.store.readAccountCredentialsEx(num, email);
    expect(vA).toBeTruthy();
    expect(unreadA).toBe(false);

    expect(s.store.readAccountCredentialsEx("9", "nobody@example.com")).toEqual(["", false]);

    fs.chmodSync(enc, 0o000);
    let unreadC: boolean;
    try {
      [, unreadC] = s.store.readAccountCredentialsEx(num, email);
    } finally {
      fs.chmodSync(enc, 0o600);
    }
    expect(unreadC).toBe(true);
  });

  it.skipIf(!posixPermissions)("test_unsearchable_credentials_dir_is_not_absent", () => {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.LINUX;
    s.setupDirectories();
    const [num, email] = ["3", "c@example.com"];
    s.writeAccountCredentials(num, email, '{"access_token":"live"}');
    const credDir = s.store.host.credentialsDir;

    const [vA, unreadA] = s.store.readAccountCredentialsEx(num, email);
    expect(vA).toBeTruthy();
    expect(unreadA).toBe(false);

    const enc = s.backupEncPath(num, email);
    fs.chmodSync(enc, 0o000);
    let unreadB: boolean;
    try {
      [, unreadB] = s.store.readAccountCredentialsEx(num, email);
    } finally {
      fs.chmodSync(enc, 0o600);
    }
    expect(unreadB).toBe(true);

    fs.chmodSync(credDir, 0o000);
    let unreadC: boolean;
    try {
      [, unreadC] = s.store.readAccountCredentialsEx(num, email);
    } finally {
      fs.chmodSync(credDir, 0o700);
    }
    expect(unreadC).toBe(true);
  });
});

describe("TestBackupUnreadableDisplay", () => {
  it("test_idle_slot_unreadable_backup_shows_keychain_unavailable", () => {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.MACOS;
    s.setupDirectories();
    keychainInternals.getPassword = raiseLocked;
    s.store.readAccountCredentialsEx("2", "b@example.com");
    const info: AccountInfoRow = [2, "b@example.com", "", "", false, "", ""];
    expect(s.staticUsageSentinel(info)).toBe(USAGE_KEYCHAIN_UNAVAILABLE);
  });

  it("test_idle_slot_absent_backup_still_no_credentials", () => {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.MACOS;
    s.setupDirectories();
    const info: AccountInfoRow = [2, "b@example.com", "", "", false, "", ""];
    expect(s.staticUsageSentinel(info)).toBe(USAGE_NO_CREDENTIALS);
  });

  it("test_active_slot_unreadable_credential_shows_keychain_unavailable_on_linux", () => {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.LINUX;
    s.setupDirectories();

    const credPath = path.join(testHome(), ".claude", ".credentials.json");
    fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "sk-live" } }), "utf8");

    const active = s.store.readActiveCredentials();
    s.recordActiveVerdict(active);
    const infoOk: AccountInfoRow = [1, "a@example.com", "", "", true, active.value || "", ""];
    expect(s.staticUsageSentinel(infoOk)).toBeNull();

    // The failure is injected at the read, not with chmod: POSIX mode bits do not stop the owner on Windows.
    let deny = true;
    denyReads((file) => file === credPath, () => deny);
    const activeBad = s.store.readActiveCredentials();
    deny = false;
    expect(activeBad.value).toBeNull();
    expect(activeBad.keychainUnavailable).toBe(false);
    s.recordActiveVerdict(activeBad);
    const infoBad: AccountInfoRow = [1, "a@example.com", "", "", true, activeBad.value || "", ""];
    expect(s.staticUsageSentinel(infoBad)).toBe(USAGE_KEYCHAIN_UNAVAILABLE);
  });
});

describe("TestSwitchUnreadableBackup", () => {
  it("test_switch_to_unreadable_backup_says_keychain", async () => {
    mockClaudeConfig();
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.MACOS;
    s.setupDirectories();
    s.writeJson(s.sequenceFile, sampleSequenceData());
    keychainInternals.getPassword = raiseLocked;

    const error = await s.switchTo("2").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SwitchError);
    const msg = (error as Error).message.toLowerCase();
    expect(msg).toContain("keychain");
    expect(msg).not.toContain("add-account");
  });

  it("test_normal_path_switch_to_unreadable_backup_says_keychain", async () => {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.MACOS;
    s.setupDirectories();
    s.writeJson(s.sequenceFile, sampleSequenceData());
    const cfg = s.getClaudeConfigPath();
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    s.writeJson(cfg, {
      oauthAccount: {
        emailAddress: "account1@example.com",
        accountUuid: "uuid-1",
        organizationUuid: "",
        organizationName: "",
      },
    });
    const live = oauthCreds("sk-live", "rt-live", 9999999999000);
    s.store.writeActiveCredentialsFile(live);
    s.writeAccountCredentials("2", "account2@example.com", live);
    s.writeAccountConfig(
      "2",
      "account2@example.com",
      JSON.stringify({
        oauthAccount: {
          emailAddress: "account2@example.com",
          accountUuid: "uuid-2",
          organizationUuid: "",
          organizationName: "",
        },
      }),
    );
    expect(s.currentAccountNumber()).toBe("1");

    keychainInternals.getPassword = raiseLocked;
    const error = await s.switchTo("2").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SwitchError);
    const msg = (error as Error).message.toLowerCase();
    expect(msg).toContain("keychain");
    expect(msg).not.toContain("add-account");
  });
});

/** A prior gate consumed the grant of `consumed` and could not persist `credentials`. The store still holds `consumed`. */
function stashSuccessorOf(s: ClaudeAccountSwitcher, credentials: string, consumed: string): void {
  s.store.writeUnclaimedCredential(credentials, {
    reason: "consume-gate-persist-failed",
    configSlot: "1",
    consumedFp: credentialFingerprint(consumed),
    fingerprint: credentialFingerprint(credentials),
  });
}

const isManifest = (file: string): boolean => path.basename(file) === ".unclaimed-manifest.json";

describe("TestConsumeGate", () => {
  it("test_gate_rereads_under_lock_and_posts_rereread_bytes", async () => {
    const s = gateSwitcher();
    const fresher = oauthCreds("sk-fresher", "rt-fresher", 2000);
    s.writeAccountCredentials("1", "test@example.com", fresher);
    const posted = mockRefresh(() => refreshOutcome(NEW, null));

    const result = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(posted).toEqual([fresher]);
    expect(result.credentials).toBe(NEW);
    expect(s.readAccountCredentials("1", "test@example.com")).toBe(NEW);
  });

  it("test_gate_cas_persist_detects_racing_writer", async () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);
    const racer = oauthCreds("sk-racer", "rt-racer", 8888888888000);
    mockRefresh(
      () => refreshOutcome(NEW, null),
      () => s.store.writeAccountCredentials("1", "test@example.com", racer),
    );

    const result = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(s.readAccountCredentials("1", "test@example.com")).toBe(racer);
    expect(result.credentials).toBe(racer);
    expect(Object.keys(s.listUnclaimedCredentials()).length).toBeGreaterThan(0);
  });

  it("test_gate_prefers_newer_session_profile_lineage", async () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);
    const profileNewer = oauthCreds("sk-prof", "rt-prof", 5000);
    const sdir = sessionDirFor(s.backupDir, "1", "test@example.com");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, ".credentials.json"), profileNewer);
    const posted = mockRefresh(() => refreshOutcome(NEW, null));
    vi.spyOn(s, "liveSessionPids").mockReturnValue([]);

    await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(posted).toEqual([profileNewer]);
  });

  it("test_gate_invalid_grant_returns_error_without_persist", async () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);
    mockRefresh(() => refreshOutcome(null, "invalid_grant"));

    const result = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(result.error).toBe("invalid_grant");
    expect(s.readAccountCredentials("1", "test@example.com")).toBe(OLD);
  });

  it("test_an_unreadable_stash_manifest_defers_instead_of_posting", async () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);
    stashSuccessorOf(s, NEW, OLD);

    denyReads(isManifest);
    const posted = mockRefresh(() => refreshOutcome(NEW, null));

    const result = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(posted).toEqual([]);
    expect(result.error).toBe("stash-unreadable");
  });

  it("test_a_stash_write_refuses_an_unreadable_manifest", () => {
    const s = gateSwitcher();
    stashSuccessorOf(s, NEW, OLD);
    const manifest = s.store.stashManifestPath();
    const before = fs.readFileSync(manifest);

    let deny = true;
    denyReads(isManifest, () => deny);

    expect(() =>
      s.store.writeUnclaimedCredential(OLD, { reason: "consume-gate-persist-failed", configSlot: "1" }),
    ).toThrow(CredentialReadError);

    deny = false;
    expect(fs.readFileSync(manifest).equals(before)).toBe(true);
    expect(fs.readdirSync(s.credentialsDir).filter((n) => n.startsWith(".unclaimed-manifest.json.corrupt-"))).toEqual(
      [],
    );
  });

  it("test_the_purge_exit_the_fail_closed_message_names_actually_works", async () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);
    stashSuccessorOf(s, NEW, OLD);
    fs.writeFileSync(s.store.stashManifestPath(), "{not json at all");

    const listed = s.listUnclaimedCredentials();
    expect(Object.keys(listed).length).toBeGreaterThan(0);

    for (const entryId of Object.keys(listed)) s.store.removeUnclaimedCredential(entryId);

    expect(s.store.stashEntryFilesExist()).toBe(false);
    const posted = mockRefresh(() => refreshOutcome(NEW, null));

    const result = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(posted).toEqual([OLD]);
    expect(result.error).toBeNull();
  });

  it.skipIf(!posixPermissions)("test_an_unlistable_dir_counts_as_entries_at_risk", () => {
    const s = gateSwitcher();
    stashSuccessorOf(s, NEW, OLD);
    expect(s.store.stashEntryFilesExist()).toBe(true);

    const credDir = s.store.host.credentialsDir;
    fs.chmodSync(credDir, 0o311);
    try {
      expect(s.store.stashEntryFilesExist()).toBe(true);
    } finally {
      fs.chmodSync(credDir, 0o700);
    }
  });

  it("test_a_missing_credentials_dir_is_provably_nothing_stashed", () => {
    const s = gateSwitcher();
    const credDir = s.store.host.credentialsDir;
    if (fs.existsSync(credDir)) fs.rmSync(credDir, { recursive: true });

    expect(s.store.stashEntryFilesExist()).toBe(false);
  });

  it("test_a_manifest_without_a_dict_entries_member_is_corrupt", () => {
    const s = gateSwitcher();
    for (const payload of ['{"schemaVersion": 1, "entries": "bogus"}', '{"schemaVersion": 1}']) {
      fs.writeFileSync(s.store.stashManifestPath(), payload);
      expect(s.store.readStashManifestEx(), payload).toEqual([{}, "corrupt"]);
    }
  });

  it("test_a_corrupt_manifest_with_orphan_entries_fails_closed", async () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);
    stashSuccessorOf(s, NEW, OLD);
    fs.writeFileSync(s.store.stashManifestPath(), "{not json at all");
    const posted = mockRefresh(() => refreshOutcome(null, "invalid_grant"));

    const result = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(posted).toEqual([]);
    expect(result.error).toBe("stash-unreadable");
  });

  it("test_a_corrupt_manifest_still_posts_rather_than_deadlocking", async () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);
    fs.writeFileSync(s.store.stashManifestPath(), "{not json at all");
    const posted = mockRefresh(() => refreshOutcome(NEW, null));

    const result = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(posted).toEqual([OLD]);
    expect(result.error).toBeNull();
  });

  it("test_a_manifest_of_invalid_utf8_is_corrupt_not_unreadable", () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);
    stashSuccessorOf(s, NEW, OLD);
    fs.writeFileSync(s.store.stashManifestPath(), Buffer.from([0xff, 0xfe, 0x00, ...Buffer.from("not utf8")]));

    expect(s.store.readStashManifestEx()).toEqual([{}, "corrupt"]);
  });

  it("test_a_readable_empty_manifest_still_posts", async () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);
    const posted = mockRefresh(() => refreshOutcome(NEW, null));

    const result = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(posted).toEqual([OLD]);
    expect(result.error).toBeNull();
  });

  it("test_a_removed_slot_defers_instead_of_posting_the_snapshot", async () => {
    const s = gateSwitcher();
    const posted = mockRefresh(() => refreshOutcome(NEW, null));

    const result = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(posted).toEqual([]);
    expect(result.error).toBe("transient");
    expect(s.listUnclaimedCredentials()).toEqual({});
  });

  it("test_an_absent_slot_defers_even_when_a_newer_profile_exists", async () => {
    const s = gateSwitcher();
    const profileNewer = oauthCreds("sk-prof", "rt-prof", 9999999999000);
    const sdir = sessionDirFor(s.backupDir, "1", "test@example.com");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, ".credentials.json"), profileNewer);
    const posted = mockRefresh(() => refreshOutcome(NEW, null));
    vi.spyOn(s, "liveSessionPids").mockReturnValue([]);

    const result = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(posted).toEqual([]);
    expect(result.error).toBe("transient");
    expect(s.readAccountCredentials("1", "test@example.com")).toBeFalsy();
  });
});

describe("TestInactiveRefreshRoutesThroughGate", () => {
  it("test_expired_inactive_fetch_uses_gate", async () => {
    const data = sampleSequenceData() as FullSequenceData;
    data.accounts["2"] = { email: "b@example.com", uuid: "u2", organizationUuid: "", organizationName: "" };
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.writeJson(s.sequenceFile, data);
    const expired = oauthCreds("sk-old", "rt-old", 1000);
    s.writeAccountCredentials("2", "b@example.com", expired);
    const fresh = oauthCreds("sk-new", "rt-new", 9999999999000);
    let gateArgs: [string, string] | undefined;
    vi.spyOn(s, "consumeBackupGrant").mockImplementation(async (num, email) => {
      gateArgs = [num, email];
      s.store.writeAccountCredentials(num, email, fresh);
      return refreshOutcome(fresh, null);
    });
    const direct = mockRefresh(() => refreshOutcome(null, "transient"));
    vi.spyOn(s, "liveSessionPids").mockReturnValue([]);
    oauthInternals.requestUsageData = async () => ({ five_hour: { utilization: 5 } });

    const info: AccountInfoRow = [2, "b@example.com", "", "", false, expired, ""];
    const record = await s.fetchAccountUsage(info);

    expect(gateArgs).toEqual(["2", "b@example.com"]);
    expect(direct).toEqual([]);
    expect(record.error ?? null).toBeNull();
  });
});

/** Record an `invalid_grant` strike on slot 2, bound to the fingerprint of `dead`. */
function strikeSlot2(s: ClaudeAccountSwitcher, dead: string, identities: Record<string, Identity>): void {
  const store = s.usageStore;
  const claims = store.reserve(["2"], identities, { respectPlans: false });
  store.record({ "2": { error: "invalid_grant", struckFp: credentialFingerprint(dead) } }, identities, claims);
}

function slot2Switcher(): ClaudeAccountSwitcher {
  mockClaudeConfig();
  const data = sampleSequenceData() as FullSequenceData;
  data.accounts["2"] = { email: "b@example.com", uuid: "u2", organizationUuid: "", organizationName: "" };
  const s = new ClaudeAccountSwitcher();
  s.setupDirectories();
  s.writeJson(s.sequenceFile, data);
  return s;
}

describe("TestStrikeUnbindsInCollector", () => {
  it("test_relogin_lifts_after_credential_replaced", async () => {
    const s = slot2Switcher();
    const dead = oauthCreds("a", "rt-dead", 1000);
    s.writeAccountCredentials("2", "b@example.com", dead);
    const identities: Record<string, Identity> = { "2": ["b@example.com", ""] };
    strikeSlot2(s, dead, identities);

    let entries = await s.collectUsageEntries([[2, "b@example.com", "", "", false, dead, ""]], new Set());
    expect(entries["2"]!.sentinel).toBe(USAGE_RELOGIN_REQUIRED);

    const fresh = oauthCreds("b", "rt-new", 1000);
    s.writeAccountCredentials("2", "b@example.com", fresh);
    entries = await s.collectUsageEntries([[2, "b@example.com", "", "", false, fresh, ""]], new Set());
    expect(entries["2"]!.sentinel).not.toBe(USAGE_RELOGIN_REQUIRED);
  });
});

describe("TestStoreResolutionParity", () => {
  it("test_securestorage_env_refuses_consume", async () => {
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/tmp/other");
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.writeJson(s.sequenceFile, sampleSequenceData());
    const creds = oauthCreds("a", "rt", 1000);
    s.writeAccountCredentials("1", "test@example.com", creds);
    const posted = mockRefresh(() => refreshOutcome(null, null));

    const result = await s.consumeBackupGrant("1", "test@example.com", creds);

    expect(posted).toEqual([]);
    expect(result.error).toBe("store-unmirrored");
  });

  it("test_session_shell_config_dir_refuses_switch", async () => {
    mockClaudeConfig();
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.writeJson(s.sequenceFile, sampleSequenceData());
    const inside = path.join(s.backupDir, "sessions", "1-test-example-com");
    fs.mkdirSync(inside, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", inside);

    const error = await s.switchTo("2").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SwitchError);
    expect((error as Error).message.toLowerCase()).toContain("session");
  });

  it("test_normal_env_unaffected", async () => {
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.writeJson(s.sequenceFile, sampleSequenceData());
    const creds = oauthCreds("a", "rt", 1000);
    s.writeAccountCredentials("1", "test@example.com", creds);
    const fresh = oauthCreds("b", "rt2", 9999999999000);
    mockRefresh(() => refreshOutcome(fresh, null));

    const result = await s.consumeBackupGrant("1", "test@example.com", creds);

    expect(result.credentials).toBe(fresh);
  });

  it("test_a_secure_store_miss_does_not_capture_the_other_profiles_key", () => {
    const active = path.join(testHome(), "profileA");
    const secure = path.join(testHome(), "profileB");
    fs.mkdirSync(active);
    fs.mkdirSync(secure);
    fs.writeFileSync(path.join(active, ".claude.json"), JSON.stringify({ primaryApiKey: "sk-ant-api-PROFILE-A" }));
    vi.stubEnv("CLAUDE_CONFIG_DIR", active);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", secure);

    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();

    expect(s.readCaptureCredentials()).not.toBe("sk-ant-api-PROFILE-A");
  });

  it("test_refuse_degraded_capture_is_not_a_toctou", () => {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.MACOS;
    s.setupDirectories();
    const cred = getCredentialsPath();
    fs.mkdirSync(path.dirname(cred), { recursive: true });
    fs.writeFileSync(cred, "STALE-FALLBACK-PLAINTEXT");
    credentialsInternals.ACTIVE_READ_RETRY_DELAY = 0;
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);

    let calls = 0;
    const healthyValue = '{"claudeAiOauth":{"refreshToken":"HEALTHY-RT"}}';
    keychainInternals.getPassword = () => {
      calls += 1;
      if (calls === 1) return healthyValue;
      throw new KeychainError("locked");
    };

    expect(s.readCaptureCredentials()).toBe(healthyValue);
    expect(calls).toBe(1);
  });

  it("test_refuse_degraded_capture_control_persistently_locked", () => {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.MACOS;
    s.setupDirectories();
    const cred = getCredentialsPath();
    fs.mkdirSync(path.dirname(cred), { recursive: true });
    fs.writeFileSync(cred, "STALE-FALLBACK-PLAINTEXT");
    credentialsInternals.ACTIVE_READ_RETRY_DELAY = 0;
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);
    keychainInternals.getPassword = raiseLocked;

    expect(() => s.readCaptureCredentials()).toThrow(CredentialReadError);
  });
});

/** A `FileLock` whose second `enter()` in the test throws `LockError`. `acquire` (the consume lock) always works. */
function secondEnterFails(): new (lockPath: string, timeout?: number) => SwitcherLock {
  let calls = 0;
  return class SecondLockFails implements SwitcherLock {
    private inner: FileLock;
    constructor(lockPath: string, timeout?: number) {
      this.inner = new FileLock(lockPath, timeout);
    }
    acquire(timeout?: number): boolean {
      return this.inner.acquire(timeout);
    }
    release(): void {
      this.inner.release();
    }
    enter(): unknown {
      calls += 1;
      if (calls === 2) throw new LockError("held elsewhere");
      return this.inner.enter();
    }
    exit(): void {
      this.inner.exit();
    }
  };
}

describe("TestConsumeGateLockFailures", () => {
  it("test_lock_failure_before_post_is_transient", async () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);

    // The consume lock of the slot works. The SLOT lock (window 1) is held elsewhere.
    internals.FileLock = class FailingLock implements SwitcherLock {
      acquire(): boolean {
        return true;
      }
      release(): void {}
      enter(): unknown {
        throw new LockError("held elsewhere");
      }
      exit(): void {}
    };
    const posted = mockRefresh(() => refreshOutcome(null, null));

    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(posted).toEqual([]);
    expect(out.error).toBe("transient");
  });

  it("test_lock_failure_after_post_stashes_successor", async () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);
    internals.FileLock = secondEnterFails();
    mockRefresh(() => refreshOutcome(NEW, null));

    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(out.credentials).toBe(NEW);
    expect(Object.keys(s.listUnclaimedCredentials()).length).toBeGreaterThan(0);
  });

  it("test_a_stashed_successor_is_not_reported_as_freshened", async () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);
    internals.FileLock = secondEnterFails();
    mockRefresh(() => refreshOutcome(NEW, null));

    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(s.readAccountCredentials("1", "test@example.com")).toBe(OLD);
    expect(out.error).not.toBeNull();
    expect(Object.keys(s.listUnclaimedCredentials()).length).toBeGreaterThan(0);
  });
});

describe("TestPermanentlyUnreadableStashRow", () => {
  it.skipIf(!posixPermissions)("test_ten_passes_name_the_condition_instead_of_network", async () => {
    const s = gateSwitcher();
    s.writeAccountCredentials("1", "test@example.com", OLD);
    const entryId = s.store.writeUnclaimedCredential(NEW, {
      reason: "consume-gate-persist-lock-failed",
      configSlot: "1",
      consumedFp: credentialFingerprint(OLD),
      fingerprint: credentialFingerprint(NEW),
    });
    const entryPath = s.store.stashEntryPath(entryId);
    fs.chmodSync(entryPath, 0o000);
    const posted = mockRefresh(() => refreshOutcome(null, null));
    const errors = new Set<string | null>();
    try {
      for (let i = 0; i < 10; i++) {
        errors.add((await s.consumeBackupGrant("1", "test@example.com", OLD)).error);
      }
    } finally {
      fs.chmodSync(entryPath, 0o600);
    }

    expect(posted).toEqual([]);
    expect([...errors]).toEqual(["stash-unreadable"]);
    expect(s.listUnclaimedCredentials()).toHaveProperty(entryId);
  });

  it("test_the_kind_carries_its_remedy_and_skips_the_doomed_fetch", () => {
    expect(ERROR_NOTES["stash-unreadable"]).toContain("cswap unclaimed");
    expect(DETERMINISTIC_REFRESH_ERRORS).toContain("stash-unreadable");
  });
});

describe("TestHealedStrikeUnblocksFetching", () => {
  it("test_collector_clears_stale_strike_row", async () => {
    const s = slot2Switcher();
    const dead = oauthCreds("a", "rt-dead", 1000);
    const identities: Record<string, Identity> = { "2": ["b@example.com", ""] };
    strikeSlot2(s, dead, identities);
    const fresh = oauthCreds("b", "rt-new", 1000);

    await s.collectUsageEntries([[2, "b@example.com", "", "", false, fresh, ""]], new Set());

    expect(s.usageStore.entries(identities, [])["2"]!.authDeadStrikes).toBe(0);
  });
});
