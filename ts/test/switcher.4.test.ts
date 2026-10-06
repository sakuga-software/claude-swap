import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeCredentials,
  internals as credentialsInternals,
  type CredentialStore,
} from "../src/credentials.js";
import { CredentialError, CredentialReadError, SwitchError, ValidationError } from "../src/exceptions.js";
import * as macosKeychain from "../src/macos_keychain.js";
import { KeychainError, internals as keychainInternals } from "../src/macos_keychain.js";
import { MappingStore } from "../src/mappings.js";
import { Platform } from "../src/models.js";
import * as oauth from "../src/oauth.js";
import { internals as oauthInternals } from "../src/oauth.js";
import { getCredentialsPath } from "../src/paths.js";
import {
  type AccountInfoRow,
  CLAUDE_CODE_KEYCHAIN_SERVICE,
  ClaudeAccountSwitcher,
  type Provenance,
  SECURITY_SERVICE,
  type SequenceData,
  formatUsageLines,
  internals as switcherInternals,
} from "../src/switcher.js";
import { UsageEntry } from "../src/usage_store.js";
import { mockClaudeConfig, sampleSequenceData } from "./helpers/fixtures.js";
import { testHome } from "./helpers/home.js";
import { keychainStore } from "./helpers/keychain.js";

const realTryFetchUsageForAccount = switcherInternals.tryFetchUsageForAccount;
const realFetchStagger = switcherInternals.FETCH_STAGGER_S;
const realActiveReadRetryDelay = credentialsInternals.ACTIVE_READ_RETRY_DELAY;

beforeEach(() => {
  switcherInternals.FETCH_STAGGER_S = 0;
});

afterEach(() => {
  switcherInternals.tryFetchUsageForAccount = realTryFetchUsageForAccount;
  switcherInternals.FETCH_STAGGER_S = realFetchStagger;
  credentialsInternals.ACTIVE_READ_RETRY_DELAY = realActiveReadRetryDelay;
});

type Sample = Omit<ReturnType<typeof sampleSequenceData>, "accounts"> & {
  accounts: Record<string, Record<string, unknown>>;
};

function sample(): Sample {
  return sampleSequenceData() as Sample;
}

function raiseLocked(): never {
  throw new KeychainError("locked");
}

/** A Node system error, the equivalent of a Python `OSError`. */
function osError(message: string, code = "EIO"): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** Capture what the code writes to stdout. */
function captureStdout(): { text: () => string; clear: () => void } {
  let chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    text: () => chunks.join(""),
    clear: () => {
      chunks = [];
    },
  };
}

function liveCredentialsPath(): string {
  return path.join(testHome(), ".claude", ".credentials.json");
}

/** Decode a preserved credential entry from its file. The store has no read helper for it. */
function readSafetyCopy(switcher: ClaudeAccountSwitcher, entryId: string): string {
  return b64decodeStrict(fs.readFileSync(switcher.store.stashEntryPath(entryId), "utf8").trim());
}

function b64decodeStrict(text: string): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new Error("invalid base64");
  return Buffer.from(text, "base64").toString("utf8");
}

/** Python `datetime.isoformat()` of an aware UTC datetime. */
function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "+00:00");
}

type Store = Record<string, string>;

function key(num: string | number, email: string): string {
  return `${String(num)}|${email}`;
}

/**
 * Port of `TestPerformSwitchPostDisplay._setup_two_accounts`: a switcher with
 * two managed accounts, and in-memory credential and config stores.
 */
function setupTwoAccounts(seq: Sample): [ClaudeAccountSwitcher, Store, Store] {
  seq.accounts["1"]!.email = "test@example.com";
  const switcher = new ClaudeAccountSwitcher();
  switcher.setupDirectories();
  switcher.writeJson(switcher.sequenceFile, seq);

  const liveCreds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-live-1", refreshToken: "rt-live-1" } });
  fs.writeFileSync(liveCredentialsPath(), liveCreds);

  const expired2 = JSON.stringify({
    claudeAiOauth: { accessToken: "sk-stale-2", refreshToken: "rt-orig-2", expiresAt: 0, scopes: ["user:profile"] },
  });
  const credsStore: Store = { [key("2", "account2@example.com")]: expired2 };
  const configsStore: Store = {
    [key("2", "account2@example.com")]: JSON.stringify({
      oauthAccount: { emailAddress: "account2@example.com", accountUuid: "uuid-2" },
    }),
  };
  return [switcher, credsStore, configsStore];
}

/** Port of `TestPerformSwitchPostDisplay._install_store_patches`. */
function installStorePatches(
  switcher: ClaudeAccountSwitcher,
  credsStore: Store,
  configsStore: Store,
  liveState: { creds: string },
): void {
  vi.spyOn(switcher, "readAccountCredentials").mockImplementation((n, e) => credsStore[key(n, e)] ?? "");
  vi.spyOn(switcher, "readAccountCredentialsEx").mockImplementation((n, e) => [credsStore[key(n, e)] ?? "", false]);
  vi.spyOn(switcher, "writeAccountCredentials").mockImplementation((n, e, c) => {
    credsStore[key(n, e)] = c;
  });
  vi.spyOn(switcher, "readAccountConfig").mockImplementation((n, e) => configsStore[key(n, e)] ?? "");
  vi.spyOn(switcher, "writeAccountConfig").mockImplementation((n, e, c) => {
    configsStore[key(n, e)] = c;
  });
  vi.spyOn(switcher, "readCredentials").mockImplementation(() => liveState.creds);
  vi.spyOn(switcher, "writeCredentials").mockImplementation((c) => {
    liveState.creds = c;
  });
}

function stubListAccounts(switcher: ClaudeAccountSwitcher): void {
  vi.spyOn(switcher, "listAccounts").mockResolvedValue(undefined as never);
}

function accessToken(creds: string): unknown {
  return (JSON.parse(creds) as { claudeAiOauth: { accessToken: unknown } }).claudeAiOauth.accessToken;
}

describe("TestMacosKeychainFallback", () => {
  function macosSwitcher(): ClaudeAccountSwitcher {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.MACOS;
    s.setupDirectories();
    return s;
  }

  function noSession(s: ClaudeAccountSwitcher): void {
    vi.spyOn(s, "liveSessionPids").mockReturnValue([]);
    vi.spyOn(s, "invalidateSessionCredentials").mockImplementation(() => {});
  }

  function writeOldCredentialsFile(text: string): string {
    const cred = getCredentialsPath();
    fs.mkdirSync(path.dirname(cred), { recursive: true });
    fs.writeFileSync(cred, text);
    return cred;
  }

  it("test_non_macos_never_uses_keychain", () => {
    for (const plat of [Platform.LINUX, Platform.WSL, Platform.WINDOWS]) {
      const s = new ClaudeAccountSwitcher();
      s.platform = plat;
      expect(s.useKeychain()).toBe(false);
      expect(s.usesFileBackupBackend()).toBe(true);
    }
  });

  it("test_capability_cache_sticky_false", () => {
    const s = macosSwitcher();
    expect(s.useKeychain()).toBe(true);

    keychainInternals.getPassword = raiseLocked;
    expect(() => s.kcCall(macosKeychain.getPassword, "svc", "acct")).toThrow(KeychainError);
    expect(s.useKeychain()).toBe(false);

    // A later success must not flip the routing back.
    keychainInternals.getPassword = () => "ok";
    s.kcCall(macosKeychain.getPassword, "svc", "acct");
    expect(s.useKeychain()).toBe(false);
  });

  it("test_kc_call_failure_schedules_a_recheck", () => {
    const s = macosSwitcher();
    keychainInternals.getPassword = raiseLocked;
    const before = credentialsInternals.monotonic();
    expect(() => s.kcCall(macosKeychain.getPassword, "svc", "acct")).toThrow(KeychainError);
    expect(s.keychainDisabledUntil).toBeGreaterThan(before);
  });

  it("test_keychain_recovers_after_cooldown", () => {
    const s = macosSwitcher();
    s.keychainUsableCache = false;
    s.keychainDisabledUntil = credentialsInternals.monotonic() - 1;
    expect(s.useKeychain()).toBe(true);
    expect(s.keychainUsableCache).toBeNull();
    expect(s.keychainDisabledUntil).toBe(0.0);
  });

  it("test_keychain_stays_file_mode_during_cooldown", () => {
    const s = macosSwitcher();
    s.keychainUsableCache = false;
    s.keychainDisabledUntil = credentialsInternals.monotonic() + 100;
    expect(s.useKeychain()).toBe(false);
  });

  it("test_write_keychain_failure_pins_file_mode", () => {
    const s = macosSwitcher();
    const store = s.store;
    keychainInternals.setPassword = raiseLocked;
    keychainInternals.deletePassword = raiseLocked;
    vi.spyOn(store, "writeActiveCredentialsFile").mockImplementation(() => {});
    store.writeOauthCredentials('{"claudeAiOauth": {"accessToken": "x"}}');
    expect(store.lastActiveCredentialsBackend).toBe("file");
    expect(s.keychainDisabledUntil).toBe(0.0);
    expect(s.useKeychain()).toBe(false);
  });

  it("test_write_fallback_clears_pending_read_reprobe", () => {
    const s = macosSwitcher();
    const store = s.store;
    s.keychainUsableCache = false;
    s.keychainDisabledUntil = credentialsInternals.monotonic() + 100;
    keychainInternals.deletePassword = raiseLocked;
    vi.spyOn(store, "writeActiveCredentialsFile").mockImplementation(() => {});
    store.writeOauthCredentials('{"claudeAiOauth": {"accessToken": "x"}}');
    expect(store.lastActiveCredentialsBackend).toBe("file");
    expect(s.keychainDisabledUntil).toBe(0.0);
    expect(s.useKeychain()).toBe(false);
  });

  it("test_managed_key_write_fallback_pins_file_mode", () => {
    const s = macosSwitcher();
    const store = s.store;
    keychainInternals.setPassword = raiseLocked;
    vi.spyOn(store, "updateGlobalConfig").mockImplementation(() => {});
    vi.spyOn(store, "clearOauthCredential").mockImplementation(() => {});
    store.writeManagedCredentials(`sk-ant-api03-${"x".repeat(40)}`);
    expect(store.lastActiveCredentialsBackend).toBe("file");
    expect(s.keychainDisabledUntil).toBe(0.0);
    expect(s.useKeychain()).toBe(false);
  });

  it("test_item_exists_is_capability_neutral", () => {
    const s = macosSwitcher();
    s.keychainUsableCache = false;
    keychainStore().setPassword("svc", "acct", "x");
    // itemExists does not go through kcCall, so a true result must not revive the Keychain routing.
    expect(macosKeychain.itemExists("svc", "acct")).toBe(true);
    expect(s.useKeychain()).toBe(false);
  });

  it("test_capability_cache_is_process_local", () => {
    const s1 = macosSwitcher();
    s1.keychainUsableCache = false;
    expect(s1.useKeychain()).toBe(false);
    const s2 = macosSwitcher();
    expect(s2.keychainUsableCache).toBeNull();
    expect(s2.useKeychain()).toBe(true);
  });

  it("test_kc_call_propagates_programming_errors", () => {
    const s = macosSwitcher();
    const boom = (): never => {
      throw new TypeError("bug");
    };
    expect(() => s.kcCall(boom)).toThrow(TypeError);
    expect(s.keychainUsableCache).toBeNull();
  });

  it("test_active_write_does_not_swallow_programming_errors", () => {
    const s = macosSwitcher();
    keychainInternals.setPassword = () => {
      throw new TypeError("bug");
    };
    expect(() => s.writeCredentials('{"x":1}')).toThrow(TypeError);
  });

  it("test_active_write_keys_keychain_by_account_name", () => {
    vi.stubEnv("USER", undefined);
    const s = macosSwitcher();
    s.writeCredentials('{"x":1}');
    const acct = macosKeychain.keychainAccountName();
    expect(keychainStore().itemExists(CLAUDE_CODE_KEYCHAIN_SERVICE, acct)).toBe(true);
    expect(keychainStore().itemExists(CLAUDE_CODE_KEYCHAIN_SERVICE, "user")).toBe(false);
    expect(s.lastActiveCredentialsBackend).toBe("keychain");
  });

  it("test_active_read_prefers_keychain_then_file", () => {
    const s = macosSwitcher();
    const acct = macosKeychain.keychainAccountName();
    keychainStore().setPassword(CLAUDE_CODE_KEYCHAIN_SERVICE, acct, "FROM-KC");
    writeOldCredentialsFile("FROM-FILE");
    expect(s.readCredentials()).toBe("FROM-KC");
    keychainStore().deletePassword(CLAUDE_CODE_KEYCHAIN_SERVICE, acct);
    expect(s.readCredentials()).toBe("FROM-FILE");
  });

  it("test_active_read_retries_transient_keychain_failure", () => {
    const s = macosSwitcher();
    const acct = macosKeychain.keychainAccountName();
    keychainStore().setPassword(CLAUDE_CODE_KEYCHAIN_SERVICE, acct, "FROM-KC");
    credentialsInternals.ACTIVE_READ_RETRY_DELAY = 0;

    let calls = 0;
    const realGet = keychainInternals.getPassword;
    keychainInternals.getPassword = (service, account) => {
      calls += 1;
      if (calls === 1) throw new KeychainError("transient lock");
      return realGet(service, account);
    };

    const result = s.readActiveCredentials();
    expect(result.value).toBe("FROM-KC");
    expect(result.keychainUnavailable).toBe(false);
    expect(calls).toBe(2);
  });

  it("test_active_read_keychain_unavailable_no_fallback", () => {
    const s = macosSwitcher();
    keychainInternals.getPassword = raiseLocked;
    credentialsInternals.ACTIVE_READ_RETRY_DELAY = 0;
    expect(fs.existsSync(getCredentialsPath())).toBe(false);

    const result = s.readActiveCredentials();
    expect(result.value).toBe("");
    expect(result.keychainUnavailable).toBe(true);
    expect(s.readCredentials()).toBe("");
  });

  it("test_active_read_keychain_failure_covered_by_file", () => {
    const s = macosSwitcher();
    writeOldCredentialsFile("FROM-FILE");
    keychainInternals.getPassword = raiseLocked;
    credentialsInternals.ACTIVE_READ_RETRY_DELAY = 0;

    const result = s.readActiveCredentials();
    expect(result.value).toBe("FROM-FILE");
    expect(result.keychainUnavailable).toBe(false);
  });

  it("test_active_read_absent_item_is_not_keychain_unavailable", () => {
    const s = macosSwitcher();
    expect(fs.existsSync(getCredentialsPath())).toBe(false);

    const result = s.readActiveCredentials();
    expect(result.value).toBe("");
    expect(result.keychainUnavailable).toBe(false);
  });

  it("test_list_active_shows_keychain_unavailable", async () => {
    mockClaudeConfig();
    const seq = sample();
    seq.accounts["1"]!.email = "test@example.com";
    const s = macosSwitcher();
    s.writeJson(s.sequenceFile, seq);
    keychainInternals.getPassword = raiseLocked;
    credentialsInternals.ACTIVE_READ_RETRY_DELAY = 0;
    switcherInternals.tryFetchUsageForAccount = async () => oauth.usageOutcome(null, { error: "network" });
    expect(fs.existsSync(getCredentialsPath())).toBe(false);
    const out = captureStdout();

    await s.listAccounts();
    const text = out.text();
    expect(text).toContain("test@example.com");
    expect(text).toContain("(active)");
    expect(text).toContain("keychain unavailable — locked or in use; try again");
  });

  it("test_active_write_falls_back_to_file_and_clears_stale_keychain", () => {
    const s = macosSwitcher();
    const acct = macosKeychain.keychainAccountName();
    keychainStore().setPassword(CLAUDE_CODE_KEYCHAIN_SERVICE, acct, "STALE");
    keychainInternals.setPassword = raiseLocked;

    s.writeCredentials('{"fresh":1}');

    expect(s.lastActiveCredentialsBackend).toBe("file");
    expect(fs.readFileSync(getCredentialsPath(), "utf8")).toBe('{"fresh":1}');
    expect(keychainStore().itemExists(CLAUDE_CODE_KEYCHAIN_SERVICE, acct)).toBe(false);
  });

  it("test_keychain_write_refreshes_existing_file", () => {
    const s = macosSwitcher();
    const cred = writeOldCredentialsFile("OLD-CREDS");
    fs.utimesSync(cred, 1_000_000_000, 1_000_000_000);
    const oldMtimeNs = fs.statSync(cred, { bigint: true }).mtimeNs;

    s.writeCredentials('{"fresh":1}');

    expect(s.lastActiveCredentialsBackend).toBe("keychain");
    expect(fs.existsSync(cred)).toBe(true);
    expect(fs.readFileSync(cred, "utf8")).toBe('{"fresh":1}');
    expect(fs.statSync(cred, { bigint: true }).mtimeNs > oldMtimeNs).toBe(true);
  });

  it("test_keychain_write_bumps_mtime_even_when_content_unchanged", () => {
    const s = macosSwitcher();
    const cred = writeOldCredentialsFile('{"same":1}');
    fs.utimesSync(cred, 1_000_000_000, 1_000_000_000);
    const oldMtimeNs = fs.statSync(cred, { bigint: true }).mtimeNs;

    s.writeCredentials('{"same":1}');

    expect(fs.statSync(cred, { bigint: true }).mtimeNs > oldMtimeNs).toBe(true);
  });

  it("test_keychain_write_does_not_create_absent_file", () => {
    const s = macosSwitcher();
    const cred = getCredentialsPath();
    expect(fs.existsSync(cred)).toBe(false);

    s.writeCredentials('{"fresh":1}');

    expect(s.lastActiveCredentialsBackend).toBe("keychain");
    expect(fs.existsSync(cred)).toBe(false);
  });

  it("test_refresh_stale_file_is_best_effort", () => {
    const s = macosSwitcher();
    writeOldCredentialsFile("OLD-CREDS");
    vi.spyOn(s.store, "writeActiveCredentialsFile").mockImplementation(() => {
      throw osError("disk full", "ENOSPC");
    });

    s.writeCredentials('{"fresh":1}');

    expect(s.lastActiveCredentialsBackend).toBe("keychain");
  });

  it("test_backup_read_enc_wins_over_stale_keychain", () => {
    const s = macosSwitcher();
    s.kcWriteBackup("1", "a@example.com", "STALE-KC");
    s.writeBackupEnc("1", "a@example.com", "FRESH-FILE");
    expect(s.readAccountCredentials("1", "a@example.com")).toBe("FRESH-FILE");
  });

  it("test_backup_keychain_write_deletes_enc", () => {
    const s = macosSwitcher();
    s.writeBackupEnc("1", "a@example.com", "OLD-FILE");
    noSession(s);
    s.writeAccountCredentials("1", "a@example.com", "NEW-KC");
    expect(fs.existsSync(s.backupEncPath("1", "a@example.com"))).toBe(false);
    expect(s.readAccountCredentials("1", "a@example.com")).toBe("NEW-KC");
  });

  it("test_backup_enc_unlink_failure_rewrites_fresh", () => {
    const s = macosSwitcher();
    s.writeBackupEnc("1", "a@example.com", "OLD-FILE");
    const enc = s.backupEncPath("1", "a@example.com");

    const realUnlink = fs.unlinkSync;
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
      if (p === enc) throw osError("cannot unlink", "EPERM");
      realUnlink(p);
    });
    noSession(s);
    try {
      s.writeAccountCredentials("1", "a@example.com", "NEW-KC");
    } finally {
      unlink.mockRestore();
    }

    expect(Buffer.from(fs.readFileSync(enc, "utf8"), "base64").toString("utf8")).toBe("NEW-KC");
    expect(s.readAccountCredentials("1", "a@example.com")).toBe("NEW-KC");
  });

  it("test_backup_file_mode_writes_enc_and_clears_keychain", () => {
    const s = macosSwitcher();
    s.kcWriteBackup("1", "a@example.com", "STALE-KC");
    keychainInternals.setPassword = raiseLocked;
    noSession(s);
    s.writeAccountCredentials("1", "a@example.com", "FILE-CREDS");
    expect(s.readAccountCredentials("1", "a@example.com")).toBe("FILE-CREDS");
    expect(keychainStore().itemExists(SECURITY_SERVICE, "account-1-a@example.com")).toBe(false);
  });

  it.each(["corrupt", "", "!!!!", "   ", "\n"])("test_backup_bad_enc_falls_back_to_keychain[%j]", (bad) => {
    const s = macosSwitcher();
    s.kcWriteBackup("1", "a@example.com", "FROM-KC");
    fs.writeFileSync(s.backupEncPath("1", "a@example.com"), bad);
    expect(s.readAccountCredentials("1", "a@example.com")).toBe("FROM-KC");
  });

  it("test_backup_delete_removes_both_backends", () => {
    const s = macosSwitcher();
    s.kcWriteBackup("1", "a@example.com", "KC");
    s.writeBackupEnc("1", "a@example.com", "FILE");
    s.deleteAccountCredentials("1", "a@example.com");
    expect(fs.existsSync(s.backupEncPath("1", "a@example.com"))).toBe(false);
    expect(keychainStore().itemExists(SECURITY_SERVICE, "account-1-a@example.com")).toBe(false);
  });

  it("test_prev_keychain_item_retained_readable_control", () => {
    const s = macosSwitcher();
    s.kcWriteBackup("1", "a@example.com", "gen-1");
    s.writeAccountCredentials("1", "a@example.com", "gen-2");
    expect(keychainStore().itemExists(SECURITY_SERVICE, "account-1-a@example.com.prev")).toBe(true);
    expect(s.store.readPreviousBackup("1", "a@example.com")).toBe("gen-1");
  });

  it("test_healthy_mac_reads_create_no_files", () => {
    const s = macosSwitcher();
    s.kcWriteBackup("1", "a@example.com", "KC");
    expect(s.readAccountCredentials("1", "a@example.com")).toBe("KC");
    expect(fs.existsSync(s.backupEncPath("1", "a@example.com"))).toBe(false);
    expect(s.readCredentials()).toBe("");
    expect(fs.existsSync(getCredentialsPath())).toBe(false);
  });

  it("test_switch_followup_reflects_recorded_backend", () => {
    const s = macosSwitcher();
    const out = captureStdout();
    s.lastActiveCredentialsBackend = "file";
    s.printSwitchFollowup();
    expect(out.text()).toContain("next message");
    out.clear();
    s.lastActiveCredentialsBackend = "keychain";
    s.printSwitchFollowup();
    expect(out.text()).toContain("30 seconds");
  });
});

describe("TestFormatUsageLines", () => {
  type Usage = Parameters<typeof formatUsageLines>[0];
  const usageOf = (u: unknown): Usage => u as Usage;

  it("test_scoped_lines_render_per_model_with_at_limit_marker", () => {
    const lines = formatUsageLines(
      usageOf({
        five_hour: { pct: 7.0, clock: "20:39", countdown: "1h 30m" },
        seven_day: { pct: 72.0, clock: "21:59", countdown: "3h" },
        scoped: [{ name: "Fable", pct: 100.0, clock: "21:59", countdown: "3h" }],
      }),
    );
    expect(lines[0]!.startsWith("5h:")).toBe(true);
    expect(lines[1]!.startsWith("7d:")).toBe(true);
    const fable = lines[2]!;
    expect(fable.startsWith("Fable:")).toBe(true);
    expect(fable).toContain("100%");
    expect(fable.trimEnd().endsWith("(!)")).toBe(true);
  });

  it("test_scoped_under_limit_has_no_marker", () => {
    const lines = formatUsageLines(usageOf({ scoped: [{ name: "Fable", pct: 40.0, clock: "21:59", countdown: "3h" }] }));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith("Fable:")).toBe(true);
    expect(lines[0]).toContain("40%");
    expect(lines[0]).toContain("resets 21:59");
    expect(lines[0]).toContain("in 3h");
    expect(lines[0]!.trimEnd().endsWith("(!)")).toBe(false);
  });

  it("test_scoped_without_clock_renders_pct_only", () => {
    expect(formatUsageLines(usageOf({ scoped: [{ name: "Fable", pct: 100.0 }] }))).toEqual(["Fable: 100%  (!)"]);
  });

  it("test_countdown_recomputed_from_resets_at_not_cached_strings", () => {
    const resetsAt = isoUtc(Date.now() + (2 * 3600 + 30 * 60) * 1000);
    const line = formatUsageLines(
      usageOf({ seven_day: { pct: 62.0, resets_at: resetsAt, clock: "15:59", countdown: "17h 0m" } }),
    )[0]!;
    expect(line).toContain("in 2h");
    expect(line).not.toContain("17h");
  });

  it("test_reset_falls_back_to_cached_strings_without_resets_at", () => {
    const line = formatUsageLines(usageOf({ seven_day: { pct: 62.0, clock: "15:59", countdown: "17h 0m" } }))[0]!;
    expect(line).toContain("resets 15:59");
    expect(line).toContain("in 17h 0m");
  });

  it("test_reset_falls_back_on_unparseable_resets_at", () => {
    const line = formatUsageLines(
      usageOf({ seven_day: { pct: 62.0, resets_at: "not-a-date", clock: "15:59", countdown: "17h 0m" } }),
    )[0]!;
    expect(line).toContain("resets 15:59");
    expect(line).toContain("in 17h 0m");
  });

  it("test_spend_clock_recomputed_from_resets_at", () => {
    const resetsAt = isoUtc(Date.now() + 2 * 3600 * 1000);
    const expectedClock = oauth.formatReset(resetsAt)[1];
    const line = formatUsageLines(
      usageOf({
        spend: { used: 1.0, limit: 10.0, pct: 10.0, currency: "USD", resets_at: resetsAt, clock: "stale-clock" },
      }),
    )[0]!;
    expect(line).toContain(`resets ${expectedClock}`);
    expect(line).not.toContain("stale-clock");
  });

  it("test_no_scoped_key_renders_only_standard_windows", () => {
    const lines = formatUsageLines(usageOf({ five_hour: { pct: 7.0 }, seven_day: { pct: 72.0 } }));
    expect(lines.every((line) => !line.startsWith("Fable:"))).toBe(true);
  });

  it("test_scoped_labels_align_columns_with_standard_windows", () => {
    const lines = formatUsageLines(
      usageOf({
        five_hour: { pct: 0.0 },
        seven_day: { pct: 62.0, clock: "Jul 5 08:59", countdown: "1d 19h" },
        scoped: [{ name: "Fable", pct: 100.0, clock: "Jul 5 08:59", countdown: "1d 19h" }],
      }),
    );
    expect(lines[0]).toBe("5h:      0%");
    expect(lines[1]!.startsWith("7d:     62%   resets Jul 5 08:59")).toBe(true);
    expect(lines[2]!.startsWith("Fable: 100%   resets Jul 5 08:59")).toBe(true);
    expect(new Set(lines.map((line) => line.indexOf("%"))).size).toBe(1);
  });

  it("test_standard_windows_alone_keep_legacy_layout", () => {
    const lines = formatUsageLines(usageOf({ five_hour: { pct: 7.0, clock: "20:39", countdown: "1h 30m" } }));
    expect(lines).toEqual(["5h:   7%   resets 20:39         in 1h 30m"]);
  });

  const NOW = 1_700_000_000.0;

  it("test_seven_day_ahead_of_pace_marker", () => {
    const resetsAt = isoUtc((NOW + 6 * 86400) * 1000);
    const line = formatUsageLines(usageOf({ seven_day: { pct: 50.0, resets_at: resetsAt } }), NOW)[0]!;
    expect(line).toContain("(ahead of pace)");
  });

  it("test_five_hour_never_shows_pace_marker", () => {
    const resetsAt = isoUtc((NOW + 4 * 3600) * 1000);
    const line = formatUsageLines(usageOf({ five_hour: { pct: 90.0, resets_at: resetsAt } }), NOW)[0]!;
    expect(line).not.toContain("pace");
  });

  it("test_scoped_ahead_of_pace_marker_when_under_limit", () => {
    const resetsAt = isoUtc((NOW + 6 * 86400) * 1000);
    const line = formatUsageLines(usageOf({ scoped: [{ name: "Fable", pct: 50.0, resets_at: resetsAt }] }), NOW)[0]!;
    expect(line).toContain("(ahead of pace)");
    expect(line).not.toContain("(!)");
  });

  it("test_no_pace_marker_without_fetched_at", () => {
    const resetsAt = isoUtc(Date.now() + 6 * 86400 * 1000);
    const line = formatUsageLines(usageOf({ seven_day: { pct: 50.0, resets_at: resetsAt } }))[0]!;
    expect(line).not.toContain("pace");
  });

  it("test_no_pace_marker_within_suppression_window_after_reset", () => {
    const resetsAt = isoUtc((NOW + 7 * 86400 - 3600) * 1000);
    const line = formatUsageLines(usageOf({ seven_day: { pct: 50.0, resets_at: resetsAt } }), NOW)[0]!;
    expect(line).not.toContain("pace");
  });
});

const A1_BACKUP = JSON.stringify({ claudeAiOauth: { accessToken: "sk-stored-1", refreshToken: "rt-1" } });
const A1 = key("1", "test@example.com");
const A2 = key("2", "account2@example.com");

/** Run a quiet switch to slot 2 with `resolver` as the answer of the profile endpoint. */
async function runSwitch(switcher: ClaudeAccountSwitcher, resolver: oauth.AccountIdentity | null = null) {
  stubListAccounts(switcher);
  oauthInternals.fetchOauthProfile = async () => resolver;
  return switcher.performSwitch("2", false);
}

function identity(uuid: string, email: string | null, organizationUuid: string | null): oauth.AccountIdentity {
  return { uuid, email, organizationUuid } as oauth.AccountIdentity;
}

describe("TestProvenanceGuard", () => {
  function setup(seq: Sample = sample()): [ClaudeAccountSwitcher, Store, Store] {
    mockClaudeConfig();
    return setupTwoAccounts(seq);
  }

  it("test_byte_identical_live_skips_credential_backup", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    installStorePatches(s, credsStore, configsStore, { creds: A1_BACKUP });
    const writes: Array<[string, string]> = [];
    vi.mocked(s.writeAccountCredentials).mockImplementation((n, e) => {
      writes.push([n, e]);
    });
    const op = await runSwitch(s);
    expect(writes).toEqual([]);
    expect(op.warnings).toEqual([]);
    expect(configsStore[A1]).toBeTruthy();
  });

  it("test_access_token_rotation_same_lineage_backs_up", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const rotated = JSON.stringify({ claudeAiOauth: { accessToken: "sk-fresh-1", refreshToken: "rt-1", expiresAt: 9 } });
    installStorePatches(s, credsStore, configsStore, { creds: rotated });
    const profile = vi.fn(async () => null);
    oauthInternals.fetchOauthProfile = profile;
    stubListAccounts(s);
    const op = await s.performSwitch("2");
    expect(profile).not.toHaveBeenCalled();
    expect(credsStore[A1]).toBe(rotated);
    expect(op.warnings).toEqual([]);
  });

  it("test_full_rotation_resolved_to_outgoing_slot_backs_up", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const rotated = JSON.stringify({ claudeAiOauth: { accessToken: "sk-fresh-1", refreshToken: "rt-1-rotated" } });
    installStorePatches(s, credsStore, configsStore, { creds: rotated });
    const op = await runSwitch(s, identity("uuid-1", "test@example.com", ""));
    expect(credsStore[A1]).toBe(rotated);
    expect(op.warnings).toEqual([]);
    expect(s.listUnclaimedCredentials()).toEqual({});
  });

  it("test_resolution_backfills_empty_slot_uuid", async () => {
    const seq = sample();
    seq.accounts["1"]!.uuid = "";
    const [s, credsStore, configsStore] = setup(seq);
    credsStore[A1] = A1_BACKUP;
    const live = JSON.stringify({ claudeAiOauth: { accessToken: "sk-f", refreshToken: "rt-1-rotated" } });
    installStorePatches(s, credsStore, configsStore, { creds: live });
    await runSwitch(s, identity("uuid-resolved", "test@example.com", ""));
    expect(s.getSequenceData()!.accounts!["1"]!.uuid).toBe("uuid-resolved");
  });

  it("test_foreign_credential_preserved_never_backed_into_any_slot", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const a2Backup = credsStore[A2];
    const foreign = JSON.stringify({ claudeAiOauth: { accessToken: "sk-2-rotated", refreshToken: "rt-2-rotated" } });
    const liveState = { creds: foreign };
    installStorePatches(s, credsStore, configsStore, liveState);
    const op = await runSwitch(s, identity("uuid-2", "account2@example.com", ""));
    expect(credsStore[A1]).toBe(A1_BACKUP);
    expect(credsStore[A2]).toBe(a2Backup);
    const entries = s.listUnclaimedCredentials();
    const ids = Object.keys(entries);
    expect(ids).toHaveLength(1);
    const entryId = ids[0]!;
    expect(readSafetyCopy(s, entryId)).toBe(foreign);
    expect((entries[entryId]!.resolvedIdentity as { uuid: string }).uuid).toBe("uuid-2");
    expect(op.warnings.some((w) => w.includes("ownership mismatch") && w.includes("Account-2"))).toBe(true);
    expect(accessToken(liveState.creds)).toBe("sk-stale-2");
  });

  it("test_foreign_synced_lineage_warns_without_any_write", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const a2Backup = credsStore[A2]!;
    installStorePatches(s, credsStore, configsStore, { creds: a2Backup });
    const op = await runSwitch(s, identity("uuid-2", "account2@example.com", ""));
    expect(credsStore[A1]).toBe(A1_BACKUP);
    expect(credsStore[A2]).toBe(a2Backup);
    expect(s.listUnclaimedCredentials()).toEqual({});
    expect(op.warnings.some((w) => w.includes("already matches Account-2"))).toBe(true);
  });

  it("test_alien_credential_preserved_and_skipped", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const alien = JSON.stringify({ claudeAiOauth: { accessToken: "sk-x", refreshToken: "rt-x" } });
    installStorePatches(s, credsStore, configsStore, { creds: alien });
    const op = await runSwitch(s, identity("uuid-unmanaged", "elsewhere@example.com", ""));
    expect(credsStore[A1]).toBe(A1_BACKUP);
    const ids = Object.keys(s.listUnclaimedCredentials());
    expect(ids).toHaveLength(1);
    expect(readSafetyCopy(s, ids[0]!)).toBe(alien);
    expect(op.warnings.some((w) => w.includes("does not match a managed account"))).toBe(true);
  });

  it("test_blank_stored_uuid_email_match_is_alien_not_foreign", async () => {
    const seq = sample();
    seq.accounts["2"]!.uuid = "";
    const [s, credsStore, configsStore] = setup(seq);
    credsStore[A1] = A1_BACKUP;
    const a2Backup = credsStore[A2];
    const drifted = JSON.stringify({ claudeAiOauth: { accessToken: "sk-d", refreshToken: "rt-d" } });
    installStorePatches(s, credsStore, configsStore, { creds: drifted });
    const op = await runSwitch(s, identity("uuid-2-real", "account2@example.com", ""));
    expect(credsStore[A1]).toBe(A1_BACKUP);
    expect(credsStore[A2]).toBe(a2Backup);
    expect(Object.keys(s.listUnclaimedCredentials())).toHaveLength(1);
    expect(op.warnings.some((w) => w.includes("does not match a managed account"))).toBe(true);
  });

  it("test_partial_identity_uuid_only_matching_outgoing_slot_backs_up", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const rotated = JSON.stringify({ claudeAiOauth: { accessToken: "sk-f", refreshToken: "rt-1-rotated" } });
    installStorePatches(s, credsStore, configsStore, { creds: rotated });
    const op = await runSwitch(s, identity("uuid-1", null, null));
    expect(credsStore[A1]).toBe(rotated);
    expect(s.listUnclaimedCredentials()).toEqual({});
    expect(op.warnings).toEqual([]);
  });

  it("test_partial_identity_uuid_match_with_slot_org_recorded", () => {
    const seq = sample();
    seq.accounts["1"]!.organizationUuid = "org-1";
    const [s] = setup(seq);
    const data = s.getSequenceData() as SequenceData;
    const rotated = JSON.stringify({ claudeAiOauth: { accessToken: "sk-f", refreshToken: "rt-1-rotated" } });
    vi.spyOn(s, "readAccountCredentials").mockReturnValue(A1_BACKUP);
    const provenance: Provenance = { live: rotated, resolved: identity("uuid-1", null, null) };
    expect(s.classifyOutgoingCredential("1", "test@example.com", rotated, provenance, data)).toEqual([
      "own-rotated",
      null,
    ]);
  });

  it("test_partial_identity_matching_nothing_falls_open", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const mystery = JSON.stringify({ claudeAiOauth: { accessToken: "sk-x", refreshToken: "rt-x" } });
    installStorePatches(s, credsStore, configsStore, { creds: mystery });
    const op = await runSwitch(s, identity("uuid-nobody", null, null));
    expect(credsStore[A1]).toBe(mystery);
    expect(s.listUnclaimedCredentials()).toEqual({});
    expect(op.warnings).toEqual([]);
  });

  it("test_foreign_attribution_survives_missing_email", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const a2Backup = credsStore[A2];
    const foreign = JSON.stringify({ claudeAiOauth: { accessToken: "sk-2-rotated", refreshToken: "rt-2-rotated" } });
    installStorePatches(s, credsStore, configsStore, { creds: foreign });
    const op = await runSwitch(s, identity("uuid-2", null, ""));
    expect(credsStore[A1]).toBe(A1_BACKUP);
    expect(credsStore[A2]).toBe(a2Backup);
    expect(Object.keys(s.listUnclaimedCredentials())).toHaveLength(1);
    expect(op.warnings.some((w) => w.includes("Account-2"))).toBe(true);
  });

  it("test_unresolvable_mismatch_backs_up_pre_fix", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const mystery = JSON.stringify({ claudeAiOauth: { accessToken: "sk-x", refreshToken: "rt-x" } });
    const liveState = { creds: mystery };
    installStorePatches(s, credsStore, configsStore, liveState);
    const op = await runSwitch(s, null);
    expect(credsStore[A1]).toBe(mystery);
    expect(s.listUnclaimedCredentials()).toEqual({});
    expect(op.warnings).toEqual([]);
    expect(accessToken(liveState.creds)).toBe("sk-stale-2");
  });

  it("test_cached_foreign_verdict_survives_a_failed_switch_time_probe", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const foreign = JSON.stringify({ claudeAiOauth: { accessToken: "sk-foreign", refreshToken: "rt-foreign" } });
    s.probeVerdicts.set(s.lineageKey("1", "test@example.com", oauth.credentialFingerprint(foreign) ?? ""), false);
    const liveState = { creds: foreign };
    installStorePatches(s, credsStore, configsStore, liveState);
    const op = await runSwitch(s, null);
    expect(credsStore[A1]).toBe(A1_BACKUP);
    const stash = Object.values(s.listUnclaimedCredentials());
    expect(stash).toHaveLength(1);
    expect(stash[0]!.reason).toBe("known-foreign");
    expect(op.warnings.some((w) => w.includes("previously identified"))).toBe(true);
    expect(accessToken(liveState.creds)).toBe("sk-stale-2");
  });

  it("test_profile_exception_falls_back_to_pre_fix_backup", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const mystery = JSON.stringify({ claudeAiOauth: { accessToken: "sk-x", refreshToken: "rt-x" } });
    installStorePatches(s, credsStore, configsStore, { creds: mystery });
    stubListAccounts(s);
    oauthInternals.fetchOauthProfile = async () => {
      throw osError("network down", "ENETDOWN");
    };
    const op = await s.performSwitch("2", false);
    expect(credsStore[A1]).toBe(mystery);
    expect(s.listUnclaimedCredentials()).toEqual({});
    expect(op.warnings).toEqual([]);
  });

  it("test_safety_copy_failure_aborts_before_live_overwrite", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const mystery = JSON.stringify({ claudeAiOauth: { accessToken: "sk-x", refreshToken: "rt-x" } });
    const liveState = { creds: mystery };
    installStorePatches(s, credsStore, configsStore, liveState);
    vi.spyOn(s.store, "writeUnclaimedCredential").mockImplementation(() => {
      throw osError("disk full", "ENOSPC");
    });
    await expect(runSwitch(s, identity("uuid-unmanaged", "elsewhere@example.com", ""))).rejects.toThrow();
    expect(liveState.creds).toBe(mystery);
    expect(credsStore[A1]).toBe(A1_BACKUP);
  });

  it("test_wiped_live_credential_never_overwrites_a_token_bearing_backup", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const wiped = JSON.stringify({
      claudeAiOauth: {
        accessToken: "",
        refreshToken: "",
        expiresAt: 1000,
        scopes: ["user:profile"],
        subscriptionType: "max",
      },
    });
    const liveState = { creds: wiped };
    installStorePatches(s, credsStore, configsStore, liveState);
    const op = await runSwitch(s, null);
    expect(credsStore[A1]).toBe(A1_BACKUP);
    expect(accessToken(liveState.creds)).toBe("sk-stale-2");
    expect(s.listUnclaimedCredentials()).toEqual({});
    expect(op.warnings.some((w) => w.toLowerCase().includes("log in"))).toBe(true);
  });

  it("test_wiped_live_matching_wiped_backup_stays_quiet", async () => {
    const [s, credsStore, configsStore] = setup();
    const wiped = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 1000 } });
    credsStore[A1] = wiped;
    installStorePatches(s, credsStore, configsStore, { creds: wiped });
    const op = await runSwitch(s, null);
    expect(credsStore[A1]).toBe(wiped);
    expect(op.warnings).toEqual([]);
  });

  it("test_moved_bytes_between_prefetch_and_lock_fall_to_unresolved", async () => {
    const [s, credsStore, configsStore] = setup();
    credsStore[A1] = A1_BACKUP;
    const provenance: Provenance = {
      live: "something-else-entirely",
      resolved: identity("uuid-2", "account2@example.com", ""),
    };
    const moved = JSON.stringify({ claudeAiOauth: { accessToken: "sk-m", refreshToken: "rt-m" } });
    installStorePatches(s, credsStore, configsStore, { creds: moved });
    stubListAccounts(s);
    const op = await s.performSwitch("2", false, false, provenance);
    expect(credsStore[A1]).toBe(moved);
    expect(s.listUnclaimedCredentials()).toEqual({});
    expect(op.warnings).toEqual([]);
  });
});

describe("TestSelfSwitchProvenance", () => {
  function setup(): [ClaudeAccountSwitcher, Store, Store] {
    mockClaudeConfig();
    return setupTwoAccounts(sample());
  }

  it("test_matching_self_switch_is_noop", async () => {
    const [s, credsStore, configsStore] = setup();
    const backup = JSON.stringify({ claudeAiOauth: { accessToken: "sk-1", refreshToken: "rt-1" } });
    credsStore[A1] = backup;
    installStorePatches(s, credsStore, configsStore, { creds: backup });
    const result = (await s.switchTo("1", true))!;
    expect(result.switched).toBe(false);
    expect(result.reason).toBe("already-active");
  });

  it("test_diverged_unresolvable_self_switch_noops_silently", async () => {
    const [s, credsStore, configsStore] = setup();
    const backup = JSON.stringify({ claudeAiOauth: { accessToken: "sk-1", refreshToken: "rt-1" } });
    const diverged = JSON.stringify({ claudeAiOauth: { accessToken: "sk-1-new", refreshToken: "rt-1-rotated" } });
    credsStore[A1] = backup;
    const liveState = { creds: diverged };
    installStorePatches(s, credsStore, configsStore, liveState);
    oauthInternals.fetchOauthProfile = async () => null;
    const result = (await s.switchTo("1", true))!;
    expect(result.switched).toBe(false);
    expect(result.reason).toBe("already-active");
    expect(result.warnings ?? []).toEqual([]);
    expect(liveState.creds).toBe(diverged);
    expect(credsStore[A1]).toBe(backup);
  });

  it("test_diverged_resolved_self_switch_reconciles", async () => {
    const [s, credsStore, configsStore] = setup();
    const backup = JSON.stringify({ claudeAiOauth: { accessToken: "sk-1", refreshToken: "rt-1" } });
    const rotated = JSON.stringify({ claudeAiOauth: { accessToken: "sk-1-new", refreshToken: "rt-1-rotated" } });
    credsStore[A1] = backup;
    configsStore[A1] = JSON.stringify({ oauthAccount: { emailAddress: "test@example.com", accountUuid: "uuid-1" } });
    installStorePatches(s, credsStore, configsStore, { creds: rotated });
    oauthInternals.fetchOauthProfile = async () => identity("uuid-1", "test@example.com", "");
    stubListAccounts(s);
    const result = (await s.switchTo("1", true))!;
    expect(credsStore[A1]).toBe(rotated);
    expect(result.switched === false || result.to?.number === 1).toBe(true);
  });
});

function sequenceSwitcher(seq: Sample): ClaudeAccountSwitcher {
  const s = new ClaudeAccountSwitcher();
  s.setupDirectories();
  s.writeJson(s.sequenceFile, seq);
  return s;
}

describe("TestDuplicateAccountDetection", () => {
  it("test_same_fingerprint_across_slots_flagged", () => {
    const s = sequenceSwitcher(sample());
    const same = JSON.stringify({ claudeAiOauth: { accessToken: "sk", refreshToken: "rt-shared" } });
    const info: AccountInfoRow[] = [
      [1, "account1@example.com", "", "", true, same, ""],
      [2, "account2@example.com", "", "", false, same, ""],
    ];
    const warnings = s.duplicateAccountWarnings(info);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Account-1 and Account-2");
  });

  it("test_same_uuid_across_slots_flagged", () => {
    const seq = sample();
    seq.accounts["2"]!.uuid = "uuid-1";
    const s = sequenceSwitcher(seq);
    const info: AccountInfoRow[] = [
      [1, "account1@example.com", "", "", true, "creds-a", ""],
      [2, "account2@example.com", "", "", false, "creds-b", ""],
    ];
    const warnings = s.duplicateAccountWarnings(info);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("both authenticate");
  });

  it("test_empty_uuids_never_match_each_other", () => {
    const seq = sample();
    seq.accounts["1"]!.uuid = "";
    seq.accounts["2"]!.uuid = "";
    const s = sequenceSwitcher(seq);
    const info: AccountInfoRow[] = [
      [1, "setup-token-1@token.local", "", "", true, "creds-a", ""],
      [2, "setup-token-2@token.local", "", "", false, "creds-b", ""],
    ];
    expect(s.duplicateAccountWarnings(info)).toEqual([]);
  });

  it("test_clean_accounts_produce_no_warnings", () => {
    const s = sequenceSwitcher(sample());
    const info: AccountInfoRow[] = [
      [1, "account1@example.com", "", "", true, JSON.stringify({ claudeAiOauth: { refreshToken: "rt-1" } }), ""],
      [2, "account2@example.com", "", "", false, JSON.stringify({ claudeAiOauth: { refreshToken: "rt-2" } }), ""],
    ];
    expect(s.duplicateAccountWarnings(info)).toEqual([]);
  });
});

describe("TestLockstepUsageDetection", () => {
  function info(n = 2): AccountInfoRow[] {
    return Array.from({ length: n }, (_, k): AccountInfoRow => {
      const i = k + 1;
      return [i, `account${i}@example.com`, "", "", i === 1, `creds-${i}`, ""];
    });
  }

  function entry(h5Pct: number | null, h5Reset: string | null, d7Pct: number | null, d7Reset: string | null): UsageEntry {
    const usage: Record<string, { pct: number; resets_at?: string }> = {};
    if (h5Pct !== null) {
      usage.five_hour = { pct: h5Pct };
      if (h5Reset !== null) usage.five_hour.resets_at = h5Reset;
    }
    if (d7Pct !== null) {
      usage.seven_day = { pct: d7Pct };
      if (d7Reset !== null) usage.seven_day.resets_at = d7Reset;
    }
    return new UsageEntry({ lastGood: usage, fetchedAt: Date.now() / 1000, ageS: 0.0 });
  }

  it("test_identical_usage_and_resets_flagged", () => {
    const s = sequenceSwitcher(sample());
    const entries = {
      "1": entry(25.0, "2026-07-10T12:00:00Z", 60.0, "2026-07-14T00:00:00Z"),
      "2": entry(25.0, "2026-07-10T12:00:00Z", 60.0, "2026-07-14T00:00:00Z"),
    };
    const warnings = s.lockstepUsageWarnings(info(), entries);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Account-1 and Account-2");
    expect(warnings[0]).toContain("may be the same account");
  });

  it("test_differing_resets_not_flagged", () => {
    const s = sequenceSwitcher(sample());
    const entries = {
      "1": entry(25.0, "2026-07-10T12:00:00Z", 60.0, "2026-07-14T00:00:00Z"),
      "2": entry(25.0, "2026-07-10T13:00:00Z", 60.0, "2026-07-14T00:00:00Z"),
    };
    expect(s.lockstepUsageWarnings(info(), entries)).toEqual([]);
  });

  it("test_idle_accounts_without_resets_not_flagged", () => {
    const s = sequenceSwitcher(sample());
    const entries = { "1": entry(0.0, null, 0.0, null), "2": entry(0.0, null, 0.0, null) };
    expect(s.lockstepUsageWarnings(info(), entries)).toEqual([]);
  });

  it("test_sentinel_usage_never_compared", () => {
    const s = sequenceSwitcher(sample());
    const entries = { "1": new UsageEntry({ sentinel: "api-key" }), "2": new UsageEntry({ sentinel: "api-key" }) };
    expect(s.lockstepUsageWarnings(info(), entries)).toEqual([]);
  });

  it("test_payload_carries_lockstep_warnings_additively", () => {
    const s = sequenceSwitcher(sample());
    const lockstep = {
      "1": entry(25.0, "2026-07-10T12:00:00Z", 60.0, "2026-07-14T00:00:00Z"),
      "2": entry(25.0, "2026-07-10T12:00:00Z", 60.0, "2026-07-14T00:00:00Z"),
    };
    let payload = s.buildListPayload(info(), lockstep);
    expect(payload.lockstepUsageWarnings).toHaveLength(1);
    const clean = {
      "1": entry(25.0, "2026-07-10T12:00:00Z", 60.0, "2026-07-14T00:00:00Z"),
      "2": entry(30.0, "2026-07-10T13:00:00Z", 10.0, "2026-07-15T00:00:00Z"),
    };
    payload = s.buildListPayload(info(), clean);
    expect("lockstepUsageWarnings" in payload).toBe(false);
  });
});

const POSIX_NON_ROOT = process.platform !== "win32" && process.getuid?.() !== 0;

function linuxSwitcher(): ClaudeAccountSwitcher {
  const s = new ClaudeAccountSwitcher();
  s.platform = Platform.LINUX;
  s.setupDirectories();
  s.initSequenceFile();
  return s;
}

describe("TestStashAndRetentionStore", () => {
  it("test_safety_copy_write_and_list", () => {
    const s = linuxSwitcher();
    const store = s.store;
    const entryId = store.writeUnclaimedCredential("secret-bytes", { reason: "alien" });
    expect(readSafetyCopy(s, entryId)).toBe("secret-bytes");
    const entries = store.listUnclaimedCredentials();
    expect(entries[entryId]!.reason).toBe("alien");
    expect(entries[entryId]!.createdAt).toBeTruthy();
  });

  it.skipIf(process.platform === "win32")("test_safety_copy_file_is_owner_only", () => {
    const store = linuxSwitcher().store;
    const entryId = store.writeUnclaimedCredential("secret-bytes", {});
    expect(fs.statSync(store.stashEntryPath(entryId)).mode & 0o777).toBe(0o600);
  });

  it("test_two_snapshots_same_refresh_token_never_collide", () => {
    const s = linuxSwitcher();
    const store = s.store;
    const a = JSON.stringify({ claudeAiOauth: { accessToken: "sk-a", refreshToken: "rt" } });
    const b = JSON.stringify({ claudeAiOauth: { accessToken: "sk-b", refreshToken: "rt" } });
    const idA = store.writeUnclaimedCredential(a, {});
    const idB = store.writeUnclaimedCredential(b, {});
    expect(idA).not.toBe(idB);
    expect(readSafetyCopy(s, idA)).toBe(a);
    expect(readSafetyCopy(s, idB)).toBe(b);
  });

  it("test_orphaned_entry_file_still_listed", () => {
    const store = linuxSwitcher().store;
    const entryId = store.writeUnclaimedCredential("bytes", {});
    fs.unlinkSync(store.stashManifestPath());
    expect(entryId in store.listUnclaimedCredentials()).toBe(true);
  });

  it("test_prev_generation_retained_on_overwrite", () => {
    const store = linuxSwitcher().store;
    store.writeAccountCredentials("1", "a@b.c", "gen-1");
    store.writeAccountCredentials("1", "a@b.c", "gen-2");
    expect(store.readAccountCredentials("1", "a@b.c")).toBe("gen-2");
    expect(store.readPreviousBackup("1", "a@b.c")).toBe("gen-1");
    store.writeAccountCredentials("1", "a@b.c", "gen-2");
    expect(store.readPreviousBackup("1", "a@b.c")).toBe("gen-1");
  });

  it("test_prev_removed_with_account", () => {
    const store = linuxSwitcher().store;
    store.writeAccountCredentials("1", "a@b.c", "gen-1");
    store.writeAccountCredentials("1", "a@b.c", "gen-2");
    store.deleteAccountCredentials("1", "a@b.c");
    expect(store.readPreviousBackup("1", "a@b.c")).toBe("");
  });

  it.skipIf(!POSIX_NON_ROOT)("test_unreadable_current_backup_warns_instead_of_silent_no_op", () => {
    const s = linuxSwitcher();
    const store = s.store;
    store.writeAccountCredentials("1", "a@b.c", "gen-1");
    const enc = store.backupEncPath("1", "a@b.c");

    const warn = vi.spyOn(s.logger, "warning");
    fs.chmodSync(enc, 0o000);
    try {
      store.retainPreviousBackup("1", "a@b.c", "gen-2");
    } finally {
      fs.chmodSync(enc, 0o600);
    }

    const messages = warn.mock.calls.map((call) => String(call[0]).toLowerCase());
    expect(
      messages.some(
        (m) => m.includes("retain") && (m.includes("could not be retained") || m.includes("could not be read")),
      ),
      "an unreadable current backup at retention time produced no warning distinguishing it from an absent one",
    ).toBe(true);
  });

  it.skipIf(!POSIX_NON_ROOT)("test_strict_clear_final_belt_fails_closed_on_unreadable_enc", () => {
    const store = linuxSwitcher().store;
    store.writeAccountCredentials("1", "a@b.c", "live-material");
    const enc = store.backupEncPath("1", "a@b.c");

    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});
    fs.chmodSync(enc, 0o000);
    try {
      expect(() => store.deleteAccountCredentialsStrict("1", "a@b.c")).toThrow(CredentialError);
    } finally {
      fs.chmodSync(enc, 0o600);
      unlink.mockRestore();
    }

    expect(fs.existsSync(enc) && fs.statSync(enc).size > 0, "premise: the no-op unlink left material behind").toBe(
      true,
    );
  });
});

describe("TestActiveRefreshProvenance", () => {
  const LIVE = JSON.stringify({ claudeAiOauth: { accessToken: "sk-live", refreshToken: "rt-live", expiresAt: 1000 } });

  function setup(): ClaudeAccountSwitcher {
    mockClaudeConfig();
    const seq = sample();
    seq.accounts["1"]!.email = "test@example.com";
    return sequenceSwitcher(seq);
  }

  it("test_unattributed_live_grant_is_never_consumed", async () => {
    const s = setup();
    const backup = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-stored", refreshToken: "rt-stored", expiresAt: 1000 },
    });
    const refreshed = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-new", refreshToken: "rt-new", expiresAt: 9_999_999_999_000 },
    });
    const consumed: string[] = [];
    vi.spyOn(s, "readCredentials").mockReturnValue(LIVE);
    vi.spyOn(s, "readAccountCredentials").mockReturnValue(backup);
    vi.spyOn(s, "liveSessionPids").mockReturnValue([]);
    vi.spyOn(s, "writeCredentials").mockImplementation(() => {});
    vi.spyOn(s, "writeAccountCredentials").mockImplementation(() => {});
    oauthInternals.tryRefreshOauthCredentials = async (credentials) => {
      consumed.push(credentials);
      return oauth.refreshOutcome(refreshed, null);
    };
    switcherInternals.tryFetchUsageForAccount = async () =>
      oauth.usageOutcome({ five_hour: { pct: 1 } } as oauth.UsageDict);

    await s.fetchActiveUsage("1", "test@example.com", LIVE);

    expect(consumed).toEqual([backup]);
  });

  it("test_same_lineage_live_credential_still_refreshes", async () => {
    const s = setup();
    const backup = JSON.stringify({ claudeAiOauth: { accessToken: "sk-older", refreshToken: "rt-live" } });
    const refreshed = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-new", refreshToken: "rt-new", expiresAt: 9_999_999_999_000 },
    });
    const fetchCalls: Array<[string, boolean]> = [];
    vi.spyOn(s, "readCredentials").mockReturnValue(LIVE);
    vi.spyOn(s, "readAccountCredentials").mockReturnValue(backup);
    const writeLive = vi.spyOn(s, "writeCredentials").mockImplementation(() => {});
    const writeBackup = vi.spyOn(s, "writeAccountCredentials").mockImplementation(() => {});
    oauthInternals.tryRefreshOauthCredentials = async () => oauth.refreshOutcome(refreshed, null);
    switcherInternals.tryFetchUsageForAccount = async (_num, _email, credentials, isActive) => {
      fetchCalls.push([credentials, isActive]);
      return oauth.usageOutcome({ five_hour: { pct: 10 } } as oauth.UsageDict);
    };

    const result = await s.fetchActiveUsage("1", "test@example.com", LIVE);

    expect(fetchCalls).toEqual([[refreshed, true]]);
    expect(result.usage).toEqual({ five_hour: { pct: 10 } });
    expect(writeLive).toHaveBeenCalledExactlyOnceWith(refreshed);
    expect(writeBackup).toHaveBeenCalledExactlyOnceWith("1", "test@example.com", refreshed);
  });
});

/** Port of `TestDirectActivationPreservation._setup`. A null email leaves `~/.claude.json` absent. */
function setupDirectActivation(
  liveIdentityEmail: string | null = "untracked@example.com",
): [ClaudeAccountSwitcher, string] {
  const configPath = path.join(testHome(), ".claude.json");
  if (liveIdentityEmail !== null) {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        oauthAccount: {
          emailAddress: liveIdentityEmail,
          accountUuid: "",
          organizationUuid: null,
          organizationName: null,
        },
      }),
    );
  }
  const s = new ClaudeAccountSwitcher();
  s.platform = Platform.LINUX;
  s.setupDirectories();
  s.writeJson(s.sequenceFile, {
    activeAccountNumber: null,
    lastUpdated: "2024-01-01T00:00:00Z",
    sequence: [1],
    accounts: {
      "1": {
        email: "one@example.com",
        uuid: "uuid-one",
        organizationUuid: "",
        organizationName: "",
        added: "2024-01-01T00:00:00Z",
      },
    },
  });
  const targetCreds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-one", refreshToken: "rt-one" } });
  s.writeAccountCredentials("1", "one@example.com", targetCreds);
  s.writeAccountConfig(
    "1",
    "one@example.com",
    JSON.stringify({ oauthAccount: { emailAddress: "one@example.com", accountUuid: "uuid-one" } }),
  );
  const unmanaged = JSON.stringify({ claudeAiOauth: { accessToken: "sk-unmanaged", refreshToken: "rt-unmanaged" } });
  fs.writeFileSync(liveCredentialsPath(), unmanaged);
  return [s, unmanaged];
}

describe("TestDirectActivationPreservation", () => {
  it("test_unmanaged_live_login_stashed_before_activation", async () => {
    const [s, unmanaged] = setupDirectActivation();
    stubListAccounts(s);
    await s.performSwitch("1", false);
    const entries = s.listUnclaimedCredentials();
    const ids = Object.keys(entries);
    expect(ids).toHaveLength(1);
    expect(readSafetyCopy(s, ids[0]!)).toBe(unmanaged);
    expect(entries[ids[0]!]!.reason).toBe("displaced-live-login");
  });

  it("test_stash_failure_aborts_direct_activation", async () => {
    const [s, unmanaged] = setupDirectActivation();
    vi.spyOn(s.store, "writeUnclaimedCredential").mockImplementation(() => {
      throw osError("disk full", "ENOSPC");
    });
    const run = s.performSwitch("1", false);
    await expect(run).rejects.toThrow(SwitchError);
    await expect(run).rejects.toThrow(/preserve the live credential/);
    expect(fs.readFileSync(liveCredentialsPath(), "utf8")).toBe(unmanaged);
  });

  it("test_force_proceeds_with_warning_when_stash_fails", async () => {
    const [s] = setupDirectActivation();
    vi.spyOn(s.store, "writeUnclaimedCredential").mockImplementation(() => {
      throw osError("disk full", "ENOSPC");
    });
    stubListAccounts(s);
    const op = await s.performSwitch("1", false, true);
    expect(op.warnings.some((w) => w.includes("--force"))).toBe(true);
    expect(accessToken(fs.readFileSync(liveCredentialsPath(), "utf8"))).toBe("sk-one");
  });

  it("test_orphaned_live_login_without_config_identity_is_stashed", async () => {
    const [s, orphaned] = setupDirectActivation(null);
    stubListAccounts(s);
    await s.performSwitch("1", false);
    const entries = s.listUnclaimedCredentials();
    const ids = Object.keys(entries);
    expect(ids).toHaveLength(1);
    expect(readSafetyCopy(s, ids[0]!)).toBe(orphaned);
    expect(entries[ids[0]!]!.reason).toBe("displaced-live-login");
    expect(accessToken(fs.readFileSync(liveCredentialsPath(), "utf8"))).toBe("sk-one");
  });

  it("test_unreadable_live_credentials_without_config_identity_abort", async () => {
    const [s, orphaned] = setupDirectActivation(null);
    vi.spyOn(s, "readCredentials").mockReturnValue(null);
    const run = s.performSwitch("1", false);
    await expect(run).rejects.toThrow(CredentialReadError);
    await expect(run).rejects.toThrow(/snapshot/);
    expect(fs.readFileSync(liveCredentialsPath(), "utf8")).toBe(orphaned);
  });

  it("test_mid_failure_restores_identityless_config", async () => {
    const [s, orphaned] = setupDirectActivation(null);
    const configPath = path.join(testHome(), ".claude.json");
    const originalConfig = JSON.stringify({ projects: { "/home/x": { history: [] } } });
    fs.writeFileSync(configPath, originalConfig);

    const realWriteJson = s.writeJson.bind(s);
    vi.spyOn(s, "writeJson").mockImplementation((p, data) => {
      if (p === s.sequenceFile) throw osError("disk full", "ENOSPC");
      realWriteJson(p, data);
    });
    await expect(s.performSwitch("1", false)).rejects.toThrow("disk full");

    expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(fs.readFileSync(liveCredentialsPath(), "utf8")).toBe(orphaned);
  });
});

describe("TestSharedOAuthCredentialPreservation", () => {
  const API_KEY = `sk-ant-api03-${"a1b2c3d4e5".repeat(4)}`;

  it("test_live_shared_keys_win_over_stale_target_copies", () => {
    const s = new ClaudeAccountSwitcher();
    const target = JSON.stringify({
      claudeAiOauth: { accessToken: "target" },
      mcpOAuth: { server: { refreshToken: "stale" } },
      mcpOAuthClientConfig: { server: { clientId: "stale" } },
    });
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: "live" },
      mcpOAuth: { server: { refreshToken: "current" } },
      mcpOAuthClientConfig: { server: { clientId: "current" } },
    });
    expect(JSON.parse(s.prepareCredentialsForActivation(target, live))).toEqual({
      claudeAiOauth: { accessToken: "target" },
      mcpOAuth: { server: { refreshToken: "current" } },
      mcpOAuthClientConfig: { server: { clientId: "current" } },
    });
  });

  it("test_account_bound_and_unknown_siblings_stay_target_owned", () => {
    const s = new ClaudeAccountSwitcher();
    const target = JSON.stringify({
      claudeAiOauth: { accessToken: "target" },
      trustedDeviceToken: "device-token-b",
      someFutureField: { value: "target-owned" },
    });
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: "live" },
      trustedDeviceToken: "device-token-a",
      someFutureField: { value: "live" },
      mcpOAuth: { server: { refreshToken: "current" } },
    });
    expect(JSON.parse(s.prepareCredentialsForActivation(target, live))).toEqual({
      claudeAiOauth: { accessToken: "target" },
      trustedDeviceToken: "device-token-b",
      someFutureField: { value: "target-owned" },
      mcpOAuth: { server: { refreshToken: "current" } },
    });
  });

  it("test_shared_key_absent_from_live_is_not_resurrected", () => {
    const s = new ClaudeAccountSwitcher();
    const target = JSON.stringify({
      claudeAiOauth: { accessToken: "target" },
      mcpOAuth: { server: { refreshToken: "stale" } },
    });
    const live = JSON.stringify({ claudeAiOauth: { accessToken: "live" } });
    expect(JSON.parse(s.prepareCredentialsForActivation(target, live))).toEqual({
      claudeAiOauth: { accessToken: "target" },
    });
  });

  it("test_direct_activation_without_config_identity_composes_live_state", async () => {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.LINUX;
    s.setupDirectories();
    s.writeJson(s.sequenceFile, {
      activeAccountNumber: null,
      lastUpdated: "2024-01-01T00:00:00Z",
      sequence: [1],
      accounts: {
        "1": {
          email: "one@example.com",
          uuid: "uuid-one",
          organizationUuid: "",
          organizationName: "",
          added: "2024-01-01T00:00:00Z",
        },
      },
    });
    s.writeAccountCredentials(
      "1",
      "one@example.com",
      JSON.stringify({
        claudeAiOauth: { accessToken: "sk-one", refreshToken: "rt-one" },
        mcpOAuth: { server: { refreshToken: "stale" } },
      }),
    );
    s.writeAccountConfig(
      "1",
      "one@example.com",
      JSON.stringify({ oauthAccount: { emailAddress: "one@example.com", accountUuid: "uuid-one" } }),
    );
    fs.writeFileSync(liveCredentialsPath(), JSON.stringify({ mcpOAuth: { server: { refreshToken: "current" } } }));

    stubListAccounts(s);
    await s.performSwitch("1", false);

    expect(JSON.parse(fs.readFileSync(liveCredentialsPath(), "utf8"))).toEqual({
      claudeAiOauth: { accessToken: "sk-one", refreshToken: "rt-one" },
      mcpOAuth: { server: { refreshToken: "current" } },
    });
  });

  it("test_api_key_live_state_activates_target_verbatim", () => {
    const s = new ClaudeAccountSwitcher();
    const target = JSON.stringify({
      claudeAiOauth: { accessToken: "target" },
      mcpOAuth: { server: { refreshToken: "stale" } },
    });
    expect(s.prepareCredentialsForActivation(target, API_KEY)).toBe(target);
  });

  it("test_absent_live_state_activates_target_verbatim", () => {
    const s = new ClaudeAccountSwitcher();
    const target = JSON.stringify({
      claudeAiOauth: { accessToken: "target" },
      mcpOAuth: { server: { refreshToken: "old" } },
    });
    expect(s.prepareCredentialsForActivation(target, "")).toBe(target);
    expect(s.prepareCredentialsForActivation(target, null)).toBe(target);
  });

  it("test_api_key_target_is_never_composed", () => {
    const s = new ClaudeAccountSwitcher();
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: "live" },
      mcpOAuth: { server: { refreshToken: "current" } },
    });
    expect(s.prepareCredentialsForActivation(API_KEY, live)).toBe(API_KEY);
  });

  it("test_opaque_target_credential_activates_verbatim", () => {
    const s = new ClaudeAccountSwitcher();
    const target = JSON.stringify({ accessToken: "legacy", refreshToken: "legacy-rt" });
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: "live" },
      mcpOAuth: { server: { refreshToken: "current" } },
    });
    expect(s.prepareCredentialsForActivation(target, live)).toBe(target);
  });

  it("test_normal_switch_preserves_live_shared_state", async () => {
    mockClaudeConfig();
    const [s, credsStore, configsStore] = setupTwoAccounts(sample());
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-live-1", refreshToken: "rt-live-1" },
      mcpOAuth: { server: { refreshToken: "current" } },
    });
    const target = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-target-2", refreshToken: "rt-target-2" },
      mcpOAuth: { server: { refreshToken: "stale" } },
    });
    credsStore[A1] = live;
    credsStore[A2] = target;
    const liveState = { creds: live };
    installStorePatches(s, credsStore, configsStore, liveState);

    stubListAccounts(s);
    await s.performSwitch("2", false);

    const activated = JSON.parse(liveState.creds) as Record<string, { accessToken?: string }>;
    expect(activated.claudeAiOauth!.accessToken).toBe("sk-target-2");
    expect(activated.mcpOAuth).toEqual({ server: { refreshToken: "current" } });
  });

  it("test_direct_activation_preserves_live_shared_state", async () => {
    const [s] = setupDirectActivation();
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-unmanaged", refreshToken: "rt-unmanaged" },
      mcpOAuth: { server: { refreshToken: "current" } },
    });
    fs.writeFileSync(liveCredentialsPath(), live);
    const target = JSON.parse(s.readAccountCredentials("1", "one@example.com")) as Record<string, unknown>;
    target.mcpOAuth = { server: { refreshToken: "stale" } };
    s.writeAccountCredentials("1", "one@example.com", JSON.stringify(target));

    stubListAccounts(s);
    await s.performSwitch("1", false);

    const activated = JSON.parse(fs.readFileSync(liveCredentialsPath(), "utf8")) as Record<
      string,
      { accessToken?: string }
    >;
    expect(activated.claudeAiOauth!.accessToken).toBe("sk-one");
    expect(activated.mcpOAuth).toEqual({ server: { refreshToken: "current" } });
  });
});

describe("TestUuidConflictClassification", () => {
  it("test_email_match_with_conflicting_uuid_is_not_the_slot", async () => {
    mockClaudeConfig();
    const [s, credsStore, configsStore] = setupTwoAccounts(sample());
    const a1Backup = JSON.stringify({ claudeAiOauth: { accessToken: "sk-1", refreshToken: "rt-1" } });
    credsStore[A1] = a1Backup;
    const rotated = JSON.stringify({ claudeAiOauth: { accessToken: "sk-x", refreshToken: "rt-x" } });
    installStorePatches(s, credsStore, configsStore, { creds: rotated });
    stubListAccounts(s);
    // Same email and org as slot 1, but another non-empty uuid: not own-rotated.
    oauthInternals.fetchOauthProfile = async () => identity("uuid-recycled-email", "test@example.com", "");
    const op = await s.performSwitch("2", false);
    expect(credsStore[A1]).toBe(a1Backup);
    expect(Object.keys(s.listUnclaimedCredentials())).toHaveLength(1);
    expect(op.warnings.some((w) => w.includes("does not match a managed account"))).toBe(true);
  });
});

describe("TestStashStorageHardening", () => {
  function newStore(): CredentialStore {
    return linuxSwitcher().store;
  }

  it("test_identical_bytes_same_second_get_distinct_ids", () => {
    const store = newStore();
    const idA = store.writeUnclaimedCredential("same-bytes", {});
    const idB = store.writeUnclaimedCredential("same-bytes", {});
    expect(idA).not.toBe(idB);
    for (const entryId of [idA, idB]) {
      const raw = fs.readFileSync(store.stashEntryPath(entryId), "utf8").trim();
      expect(b64decodeStrict(raw)).toBe("same-bytes");
    }
  });

  it("test_corrupt_manifest_is_preserved_not_clobbered", () => {
    const store = newStore();
    const entryId = store.writeUnclaimedCredential("bytes-1", { reason: "x" });
    fs.writeFileSync(store.stashManifestPath(), "{ not json !!!");
    const newId = store.writeUnclaimedCredential("bytes-2", { reason: "y" });
    const dir = store.host.credentialsDir;
    const corrupt = fs.readdirSync(dir).filter((name) => name.startsWith(".unclaimed-manifest.json.corrupt-"));
    expect(corrupt).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, corrupt[0]!), "utf8")).toContain("not json");
    const entries = store.listUnclaimedCredentials();
    expect(newId in entries && entries[newId]!.reason === "y").toBe(true);
    expect(entryId in entries).toBe(true);
    const raw = fs.readFileSync(store.stashEntryPath(entryId), "utf8").trim();
    expect(b64decodeStrict(raw)).toBe("bytes-1");
  });
});

describe("TestStashManifestConcurrentMutation", () => {
  // Python runs the workers as threads on one store. Each TS store call is
  // synchronous, so the workers here are child processes on one credentials
  // directory. The manifest FileLock is a cross-process lock, so the race is the same.
  const ROWS = 40;
  const WORKER = path.join(import.meta.dirname, "helpers", "stash-churn.ts");

  function runWorker(credentialsDir: string, role: string, gatePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", WORKER, credentialsDir, role, String(ROWS), gatePath],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`worker ${role} exited with ${String(code)}: ${stderr}`));
      });
    });
  }

  /** Two stashers and one stash-then-retire churner, concurrent. Returns the probe tags whose rows are lost. */
  async function run(store: CredentialStore, gatePath: string): Promise<string[]> {
    const dir = store.host.credentialsDir;
    await Promise.all([runWorker(dir, "stash:a", gatePath), runWorker(dir, "churn", gatePath), runWorker(dir, "stash:b", gatePath)]);
    const probes = new Set(Object.values(store.readStashManifest()).map((meta) => (meta as { probe?: string }).probe));
    const expected = ["a", "b"].flatMap((tag) => Array.from({ length: ROWS }, (_, i) => `${tag}${i}`));
    return expected.filter((tag) => !probes.has(tag)).sort();
  }

  function newStore(): CredentialStore {
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.LINUX;
    s.setupDirectories();
    return s.store;
  }

  it("test_concurrent_stash_and_retire_lose_no_manifest_row", { timeout: 120_000 }, async () => {
    const store = newStore();
    const lost = await run(store, "");
    expect(
      lost,
      `${lost.length}/${2 * ROWS} stash rows lost to a concurrent manifest rewrite. ` +
        "adoptStashedSuccessor iterates manifest rows only, so a row-less successor can never be adopted",
    ).toEqual([]);
  });

  it("test_control_serialized_mutation_loses_no_row", { timeout: 120_000 }, async () => {
    const store = newStore();
    const gate = path.join(testHome(), "control-gate.lock");
    const lost = await run(store, gate);
    expect(lost, "control broken: the harness loses rows even when every mutation is serialized").toEqual([]);
  });
});

describe("TestRemoveAccountPrunesMappings", () => {
  it("test_remove_account_prunes_mappings", () => {
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.initSequenceFile();
    const data = s.getSequenceData()!;
    data.accounts = {
      ...data.accounts,
      "1": { email: "a@x.com", uuid: "u1", organizationUuid: "", organizationName: "", added: "2024-01-01T00:00:00Z" },
    };
    data.sequence = [1];
    s.writeJson(s.sequenceFile, data);

    const store = new MappingStore(s.backupDir);
    store.set(testHome(), "a@x.com", "");
    expect(store.get(testHome())).not.toBeNull();

    vi.spyOn(switcherInternals, "input").mockReturnValue("y");
    s.removeAccount("1");

    expect(store.get(testHome())).toBeNull();
  });

  function configSwitcher(email: string): ClaudeAccountSwitcher {
    fs.writeFileSync(
      path.join(testHome(), ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: email, accountUuid: `uuid-${email}`, organizationUuid: "", organizationName: "" },
      }),
    );
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.initSequenceFile();
    return s;
  }

  function stubCapture(s: ClaudeAccountSwitcher, creds: string): void {
    vi.spyOn(s, "readActiveCredentials").mockReturnValue(activeCredentials(creds, false));
    vi.spyOn(s, "writeAccountCredentials").mockImplementation(() => {});
    vi.spyOn(s, "deleteAccountCredentials").mockImplementation(() => {});
  }

  it("test_slot_overwrite_prunes_displaced_mappings", async () => {
    const fakeCreds = JSON.stringify({ claudeAiOauth: { accessToken: "tok" } });

    let s = configSwitcher("a@x.com");
    stubCapture(s, fakeCreds);
    await s.addAccount(3);

    const store = new MappingStore(s.backupDir);
    store.set(testHome(), "a@x.com", "");

    s = configSwitcher("b@x.com");
    stubCapture(s, fakeCreds);
    vi.spyOn(switcherInternals, "input").mockReturnValue("y");
    await s.addAccount(3);

    expect(store.get(testHome())).toBeNull();
  });

  it("test_slot_migration_keeps_mappings", async () => {
    const fakeCreds = JSON.stringify({ claudeAiOauth: { accessToken: "tok" } });

    const s = configSwitcher("a@x.com");
    stubCapture(s, fakeCreds);
    await s.addAccount();

    const store = new MappingStore(s.backupDir);
    store.set(testHome(), "a@x.com", "");

    await s.addAccount(5);

    expect(store.get(testHome())).not.toBeNull();
    expect(s.slotForDirectory(testHome())).toEqual(["5", "a@x.com"]);
  });
});

describe("TestSwitchRemoveGatesAcceptAlias", () => {
  it("test_switch_to_by_alias_reaches_resolution", async () => {
    const seq = sample();
    seq.accounts["2"]!.alias = "dev";
    const s = sequenceSwitcher(seq);
    const perform = vi
      .spyOn(s, "performSwitch")
      .mockResolvedValue({ from: null, to: { number: 2 }, warnings: [] } as unknown as Awaited<
        ReturnType<ClaudeAccountSwitcher["performSwitch"]>
      >);
    await s.switchTo("dev");
    expect(perform).toHaveBeenCalledExactlyOnceWith("2", true, false, null);
  });

  it("test_switch_to_unknown_alias_raises_account_not_found_not_validation", async () => {
    const s = sequenceSwitcher(sample());
    await expect(s.switchTo("not an email or alias!")).rejects.toThrow(ValidationError);
  });

  it("test_remove_account_by_alias", () => {
    const seq = sample();
    seq.accounts["2"]!.alias = "dev";
    const s = sequenceSwitcher(seq);
    vi.spyOn(switcherInternals, "input").mockReturnValue("y");
    vi.spyOn(s, "deleteAccountFiles").mockImplementation(() => {});
    s.removeAccount("dev");
    const data = s.getSequenceData()!;
    expect("2" in data.accounts!).toBe(false);
    expect("1" in data.accounts!).toBe(true);
  });

  it("test_remove_account_invalid_identifier_still_raises_validation", () => {
    const s = sequenceSwitcher(sample());
    expect(() => s.removeAccount("not an email or alias!")).toThrow(ValidationError);
  });
});
