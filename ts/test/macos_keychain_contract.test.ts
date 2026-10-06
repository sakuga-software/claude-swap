import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internals as credentialsInternals } from "../src/credentials.js";
import { CredentialReadError, SwitchError } from "../src/exceptions.js";
import { USAGE_KEYCHAIN_UNAVAILABLE, USAGE_NO_CREDENTIALS } from "../src/json_output.js";
import * as macosKeychain from "../src/macos_keychain.js";
import { Platform } from "../src/models.js";
import { getCredentialsPath } from "../src/paths.js";
import { type AccountInfoRow, ClaudeAccountSwitcher } from "../src/switcher.js";
import { useRealKeychain } from "./helpers/keychain.js";

const kc = macosKeychain.internals;

/** The `macos_switcher` fixture: the platform is MACOS on any host. */
function macosSwitcher(): ClaudeAccountSwitcher {
  const switcher = new ClaudeAccountSwitcher();
  switcher.platform = Platform.MACOS;
  return switcher;
}

function locked(message = "locked"): () => never {
  return () => {
    throw new macosKeychain.KeychainError(message);
  };
}

/** The Python `(num, email, None, None, False, "", None)` row of an idle slot with no credentials. */
function idleRow(num: string, email: string): AccountInfoRow {
  return [Number(num), email, "", "", false, "", ""];
}

describe("TestBackupCredentialsSecurity", () => {
  it("test_read_account_credentials_uses_security_service", () => {
    const switcher = macosSwitcher();
    const getPassword = vi.spyOn(kc, "getPassword").mockReturnValue("fake-token");

    const result = switcher.readAccountCredentials("1", "user@example.com");

    expect(getPassword).toHaveBeenCalledTimes(1);
    expect(getPassword).toHaveBeenCalledWith("claude-swap", "account-1-user@example.com");
    expect(result).toBe("fake-token");
  });

  it("test_write_account_credentials_uses_security_service", () => {
    const switcher = macosSwitcher();
    vi.spyOn(kc, "getPassword").mockReturnValue(null);
    const setPassword = vi.spyOn(kc, "setPassword").mockImplementation(() => {});

    switcher.writeAccountCredentials("2", "alice@example.com", "secret-token");

    expect(setPassword).toHaveBeenCalledTimes(1);
    expect(setPassword).toHaveBeenCalledWith("claude-swap", "account-2-alice@example.com", "secret-token");
  });

  it("test_write_retains_prev_generation_in_keychain_not_a_file", () => {
    const switcher = macosSwitcher();
    vi.spyOn(kc, "getPassword").mockReturnValue("old-generation");
    const setPassword = vi.spyOn(kc, "setPassword").mockImplementation(() => {});

    switcher.writeAccountCredentials("2", "alice@example.com", "secret-token");

    const calls = setPassword.mock.calls.map((c) => c.join("|"));
    const prev = calls.indexOf("claude-swap|account-2-alice@example.com.prev|old-generation");
    expect(prev).toBeGreaterThanOrEqual(0);
    expect(calls[prev + 1]).toBe("claude-swap|account-2-alice@example.com|secret-token");
    expect(fs.existsSync(switcher.store.prevBackupPath("2", "alice@example.com"))).toBe(false);
  });

  it("test_delete_account_credentials_uses_security_service", () => {
    const switcher = macosSwitcher();
    const deletePassword = vi.spyOn(kc, "deletePassword").mockImplementation(() => {});

    switcher.deleteAccountCredentials("3", "bob@example.com");

    expect(deletePassword.mock.calls).toEqual([
      ["claude-swap", "account-3-bob@example.com"],
      ["claude-swap", "account-3-bob@example.com.prev"],
      ["claude-swap", "account-None-bob@example.com"],
      ["claude-swap", "account-None-bob@example.com.prev"],
    ]);
  });
});

// The isolated test HOME hides ~/Library/Keychains from `security`. Get the
// real HOME now, before the setup file changes it.
const REAL_HOME = process.env.HOME;

// WARNING: these tests change the default keychain and the user search list.
// They run only on GitHub Actions macOS, never on a developer machine.
const macCiOnly = process.platform === "darwin" && !!process.env.CI && process.env.GITHUB_ACTIONS === "true";

describe.runIf(macCiOnly)("real keychain (tmp_keychain)", () => {
  useRealKeychain({ allowSecurityCli: true });

  let tmpDir: string;
  let testKeychain: string;
  let originalDefault: string | null;
  let originalList: string[];

  function security(...args: string[]): void {
    execFileSync("security", args, { stdio: "inherit" });
  }

  beforeEach(() => {
    vi.stubEnv("HOME", REAL_HOME);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cswap-keychain-"));
    testKeychain = path.join(tmpDir, "test.keychain");
    security("create-keychain", "-p", "", testKeychain);
    security("unlock-keychain", "-p", "", testKeychain);

    // A CI runner can have no default keychain (rc 1). Then skip its restore.
    const defaultProc = spawnSync("security", ["default-keychain"], { encoding: "utf8" });
    originalDefault = defaultProc.status === 0 ? defaultProc.stdout.trim().replace(/^"|"$/g, "") : null;
    const listProc = spawnSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" });
    originalList = (listProc.status === 0 ? listProc.stdout : "")
      .split("\n")
      .map((line) => line.trim().replace(/^"|"$/g, ""))
      .filter((line) => line !== "");

    security("default-keychain", "-s", testKeychain);
    security("list-keychains", "-d", "user", "-s", testKeychain);
    // A locked keychain blocks a headless runner on an unlock prompt. Remove
    // the auto-lock timeout and unlock after the swap.
    security("set-keychain-settings", testKeychain);
    security("unlock-keychain", "-p", "", testKeychain);
  });

  afterEach(() => {
    // Restore the search list before the default. macOS does not report a
    // default keychain that is not in the search list.
    if (originalList.length > 0) spawnSync("security", ["list-keychains", "-d", "user", "-s", ...originalList]);
    if (originalDefault) spawnSync("security", ["default-keychain", "-s", originalDefault]);
    spawnSync("security", ["delete-keychain", testKeychain]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_read_credentials_finds_claude_code_seeded_entry", () => {
    const username = process.env.USER ?? "";
    security(
      "add-generic-password",
      "-a",
      username,
      "-s",
      "Claude Code-credentials",
      "-w",
      "fake-token-read",
      "-A",
      testKeychain,
    );

    const switcher = new ClaudeAccountSwitcher();
    switcher.platform = Platform.MACOS;
    expect(switcher.readCredentials()).toBe("fake-token-read");
  });

  it("test_write_credentials_creates_user_scoped_entry", () => {
    // If the entry has an account name other than $USER, the lookup below fails with rc 44.
    const switcher = new ClaudeAccountSwitcher();
    switcher.platform = Platform.MACOS;
    switcher.writeCredentials("fake-token-write");

    const username = process.env.USER ?? "";
    const result = spawnSync(
      "security",
      ["find-generic-password", "-a", username, "-s", "Claude Code-credentials", "-w", testKeychain],
      { encoding: "utf8" },
    );
    expect(result.status, `security find-generic-password failed: ${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("fake-token-write");
  });

  it("test_wrapper_roundtrip_real_keychain", () => {
    macosKeychain.setPassword("claude-swap-test", "acct-1", "round-trip-token");
    expect(macosKeychain.getPassword("claude-swap-test", "acct-1")).toBe("round-trip-token");
    macosKeychain.deletePassword("claude-swap-test", "acct-1");
    expect(macosKeychain.getPassword("claude-swap-test", "acct-1")).toBeNull();
  });
});

describe("TestOurOwnFileModeIsNotAKeychainFailure", () => {
  function lockAll(message = "locked"): void {
    vi.spyOn(kc, "setPassword").mockImplementation(locked(message));
    vi.spyOn(kc, "getPassword").mockImplementation(locked(message));
    vi.spyOn(kc, "deletePassword").mockImplementation(locked(message));
  }

  it("test_an_empty_backup_stays_empty_after_our_own_file_mode_write", () => {
    const store = macosSwitcher().store;
    store.pinFileMode({ residualCleared: true });
    const [, unreadable] = store.readAccountCredentialsEx("9", "x@e.com");
    expect(unreadable).toBe(false);
  });

  it("test_a_write_fallback_does_not_certify_an_unread_backup", () => {
    const store = macosSwitcher().store;
    store.keychainUsableCache = true;
    lockAll();

    expect(store.readAccountCredentialsEx("3", "c@e.com"), "premise: a locked Keychain makes an empty backup read unprovable").toEqual(["", true]);

    store.writeOauthCredentials('{"claudeAiOauth": {"accessToken": "sk-fb"}}');
    expect(store.fileModeIsOurs, "premise: the write pinned").toBe(true);

    const [, unreadable] = store.readAccountCredentialsEx("3", "c@e.com");
    expect(unreadable, "a write fallback for the ACTIVE credential does not certify the backup empty").toBe(true);
  });

  it("test_a_write_fallback_does_not_certify_the_ACTIVE_read_either", () => {
    const switcher = macosSwitcher();
    const store = switcher.store;
    store.keychainUsableCache = true;
    lockAll();

    expect(store.readActiveCredentials().degraded, "premise").toBe(true);
    store.writeOauthCredentials('{"claudeAiOauth": {"accessToken": "x"}}');
    expect(store.fileModeIsOurs, "premise: the write pinned").toBe(true);

    expect(store.readActiveCredentials().degraded, "a write fallback does not prove the slot is empty").toBe(true);
    expect(switcher.staticUsageSentinel(idleRow("2", "b@example.com"))).toBe(USAGE_KEYCHAIN_UNAVAILABLE);
  });

  it("test_the_default_capture_path_refuses_a_degraded_read", () => {
    const switcher = macosSwitcher();
    const store = switcher.store;
    store.keychainUsableCache = true;
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    lockAll();

    // A readable plaintext fallback is the trap: it can be the consumed predecessor.
    fs.mkdirSync(path.dirname(getCredentialsPath()), { recursive: true });
    fs.writeFileSync(getCredentialsPath(), JSON.stringify({ claudeAiOauth: { accessToken: "sk-maybe-spent" } }));

    expect(() => switcher.readCaptureCredentials()).toThrow(CredentialReadError);
    expect(() => switcher.readCaptureCredentials()).toThrow(/superseded generation/);
  });

  it("test_a_real_keychain_failure_still_reports_unreadable", () => {
    const store = macosSwitcher().store;
    vi.spyOn(kc, "getPassword").mockImplementation(locked());
    const [, unreadable] = store.readAccountCredentialsEx("9", "x@e.com");
    expect(unreadable).toBe(true);
  });

  it("test_a_stale_failure_flag_does_not_condemn_a_working_read", () => {
    const store = macosSwitcher().store;
    store.keychainUsableCache = false;
    const [, unreadable] = store.readAccountCredentialsEx("9", "x@e.com");
    expect(unreadable).toBe(false);
  });

  it("test_a_recovered_keychain_is_not_condemned_by_the_previous_read", () => {
    const store = macosSwitcher().store;
    const realGet = kc.getPassword;

    vi.spyOn(kc, "getPassword").mockImplementation(locked());
    expect(store.readAccountCredentialsEx("9", "x@e.com")).toEqual(["", true]);

    vi.mocked(kc.getPassword).mockImplementation(realGet);
    const [, unreadable] = store.readAccountCredentialsEx("9", "x@e.com");
    expect(unreadable, "the previous read's failure outlived it").toBe(false);
  });

  it("test_a_recovered_keychain_does_not_latch_through_a_later_pin", () => {
    const store = macosSwitcher().store;
    store.keychainUsableCache = true;
    const healthy = kc.getPassword;

    vi.spyOn(kc, "getPassword").mockImplementation(locked());
    expect(() => store.kcCall(macosKeychain.getPassword, "svc", "acct")).toThrow(macosKeychain.KeychainError);
    expect(store.keychainUnreadable, "premise: inside the cooldown").toBe(true);

    vi.mocked(kc.getPassword).mockImplementation(healthy);
    store.keychainDisabledUntil = credentialsInternals.monotonic() - 1;
    expect(store.keychainUnreadable, "premise: cooldown lapsed").toBe(false);

    store.kcCall(macosKeychain.getPassword, "svc", "acct");
    store.pinFileMode({ residualCleared: true });

    expect(store.keychainUnreadable, "the failure latched through the pin").toBe(false);
  });

  it("test_a_recovered_keychain_does_not_latch_through_an_UNVERIFIED_pin", () => {
    const store = macosSwitcher().store;
    store.keychainUsableCache = true;
    const healthy = kc.getPassword;

    vi.spyOn(kc, "getPassword").mockImplementation(locked());
    expect(() => store.kcCall(macosKeychain.getPassword, "svc", "acct")).toThrow(macosKeychain.KeychainError);
    expect(store.keychainUnreadable, "premise: inside the cooldown").toBe(true);

    vi.mocked(kc.getPassword).mockImplementation(healthy);
    store.keychainDisabledUntil = credentialsInternals.monotonic() - 1;
    expect(store.keychainUnreadable, "premise: cooldown lapsed").toBe(false);

    store.kcCall(macosKeychain.getPassword, "svc", "acct");
    // The managed-key fallback pins with an unverified residual. That pin clears nothing.
    store.pinFileMode({ residualCleared: false });

    expect(store.keychainUnreadable, "a transient failure latched for the rest of the process").toBe(false);
  });

  it("test_an_idle_backup_read_does_not_erase_the_active_verdict", () => {
    const store = macosSwitcher().store;
    store.keychainUsableCache = true;
    const realGet = kc.getPassword;
    vi.spyOn(kc, "getPassword").mockImplementation((service, account) => {
      if (service.includes("credentials")) throw new macosKeychain.KeychainError("locked");
      return realGet(service, account);
    });

    expect(store.readActiveCredentials().degraded, "premise").toBe(true);
    store.readAccountCredentials("3", "c@example.com");
    expect(store.readActiveCredentials().degraded, "an unrelated readable backup erased the active failure").toBe(true);
  });

  it("test_the_active_verdict_survives_a_pin_only_when_it_is_true", () => {
    const store = macosSwitcher().store;
    const healthy = kc.getPassword;

    // 1. Nothing ever failed.
    store.keychainUsableCache = true;
    store.readActiveCredentials();
    store.pinFileMode({ residualCleared: true });
    expect(store.activeReadFailed).toBe(false);
    expect(store.readActiveCredentials().degraded).toBe(false);

    // 2. A failure that the cooldown healed.
    store.keychainUsableCache = true;
    store.activeReadFailed = false;
    vi.spyOn(kc, "getPassword").mockImplementation(locked());
    store.readActiveCredentials();
    expect(store.activeReadFailed, "premise: it failed").toBe(true);
    vi.mocked(kc.getPassword).mockImplementation(healthy);
    store.keychainDisabledUntil = credentialsInternals.monotonic() - 1;
    store.readActiveCredentials();
    expect(store.activeReadFailed, "premise: healed").toBe(false);
    store.pinFileMode({ residualCleared: true });
    expect(store.activeReadFailed, "a pin resurrected a verdict that the cooldown cleared").toBe(false);
    expect(store.readActiveCredentials().degraded).toBe(false);
  });

  it.skip("test_the_active_verdict_crosses_the_fetch_pool", () => {
    // Python-only: it tests a thread-local verdict across a ThreadPoolExecutor worker.
  });

  it.skip("test_the_active_verdict_is_not_shared_across_TUI_lanes", () => {
    // Python-only: it races two threads on one switcher.
  });

  it.skip("test_two_concurrent_backup_reads_keep_their_own_verdicts", () => {
    // Python-only: it races two threads on one credential store.
  });

  it("test_a_verified_clear_ends_the_degraded_verdict", () => {
    const store = macosSwitcher().store;
    store.keychainUsableCache = true;

    vi.spyOn(kc, "getPassword").mockImplementation(locked("errSecAuthFailed rc=36"));
    expect(store.readActiveCredentials().degraded, "premise: it failed").toBe(true);

    // The Keychain recovers, and a write falls back for its own reason. Its delete of the old item succeeds.
    vi.mocked(kc.getPassword).mockImplementation(() => null);
    vi.spyOn(kc, "deletePassword").mockImplementation(() => {});
    const cleared = store.deleteActiveKeychainEntry();
    expect(cleared, "premise: the residual is provably gone").toBe(true);
    store.pinFileMode({ residualCleared: cleared });

    expect(store.readActiveCredentials().degraded, "no Keychain item can shadow the file").toBe(false);
  });

  it("test_a_verified_clear_does_not_mask_a_LATER_failure", () => {
    const switcher = macosSwitcher();
    const store = switcher.store;
    store.keychainUsableCache = true;

    vi.spyOn(kc, "deletePassword").mockImplementation(() => {});
    store.pinFileMode({ residualCleared: store.deleteActiveKeychainEntry() });
    expect(store.readActiveCredentials().degraded, "premise").toBe(false);

    vi.spyOn(kc, "getPassword").mockImplementation(locked());
    switcher.readAccountCredentials("9", "i@e.com");
    store.keychainDisabledUntil = credentialsInternals.monotonic() - 1;
    expect(store.readActiveCredentials().degraded, "premise: the active read ran again and failed").toBe(true);

    expect(store.readActiveCredentials().degraded, "a verdict recorded before the failure outranked it").toBe(true);
  });

  it("test_a_failed_clear_survives_an_unrelated_success", () => {
    const switcher = macosSwitcher();
    const store = switcher.store;
    store.keychainUsableCache = true;

    vi.spyOn(kc, "setPassword").mockImplementation(locked("write denied"));
    expect(() => store.kcCall(macosKeychain.setPassword, "svc", "acct", "v")).toThrow(macosKeychain.KeychainError);
    expect(store.activeReadFailed, "premise: no read ever failed").toBe(false);

    vi.spyOn(kc, "deletePassword").mockImplementation(locked("write denied"));
    const cleared = store.deleteActiveKeychainEntry();
    expect(cleared, "premise: the residual may survive").toBe(false);
    store.pinFileMode({ residualCleared: cleared });
    expect(store.readActiveCredentials().degraded, "premise").toBe(true);

    vi.spyOn(kc, "getPassword").mockReturnValue("sibling-token");
    expect(switcher.readAccountCredentials("9", "i@e.com"), "premise: the sibling read succeeds").toBe("sibling-token");

    expect(store.readActiveCredentials().degraded, "an unrelated readable backup erased the residual verdict").toBe(true);
  });

  it("test_the_sentinel_asks_about_the_slot_it_is_describing", () => {
    const switcher = macosSwitcher();
    const store = switcher.store;
    store.keychainUsableCache = true;
    store.writeAccountCredentials("2", "b@e.com", '{"claudeAiOauth": {"accessToken": "ALIVE"}}');

    vi.spyOn(kc, "getPassword").mockImplementation(locked("errSecAuthFailed"));

    const verdict = switcher.staticUsageSentinel(idleRow("2", "b@e.com"));
    expect(verdict, "slot 2 has a backup that the Keychain did not let us read").toBe(USAGE_KEYCHAIN_UNAVAILABLE);
  });

  it("test_a_lapsed_cooldown_clears_the_unreadable_verdict", () => {
    const store = macosSwitcher().store;
    expect(() => store.kcCall(locked("denied"))).toThrow(macosKeychain.KeychainError);
    expect(store.keychainUnreadable, "inside the cooldown").toBe(true);

    store.keychainDisabledUntil = credentialsInternals.monotonic() - 1;
    expect(store.keychainUnreadable, "cooldown lapsed — re-probe").toBe(false);
  });

  it("test_off_macos_there_is_no_keychain_to_be_unreadable", () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.platform = Platform.LINUX;
    const store = switcher.store;
    store.keychainUsableCache = false;
    expect(store.keychainUnreadable).toBe(false);
  });

  it("test_a_missing_slot_is_no_credentials_not_keychain_unavailable", () => {
    const switcher = macosSwitcher();
    switcher.store.pinFileMode({ residualCleared: true });
    expect(switcher.staticUsageSentinel(idleRow("9", "x@e.com"))).toBe(USAGE_NO_CREDENTIALS);
  });

  it("test_switch_to_an_empty_slot_says_re_add_after_our_file_mode_write", async () => {
    const switcher = macosSwitcher();
    switcher.setupDirectories();
    switcher.initSequenceFile();
    switcher.writeJson(switcher.sequenceFile, {
      activeAccountNumber: null,
      lastUpdated: "",
      sequence: [2],
      accounts: {
        "2": {
          email: "b@example.com",
          uuid: "uuid-2",
          organizationUuid: "",
          organizationName: "",
          added: "2024-01-01T00:00:00Z",
        },
      },
    });
    switcher.store.pinFileMode({ residualCleared: true });

    const op = switcher.performSwitch("2", false, true);
    await expect(op).rejects.toThrow(SwitchError);
    await expect(op).rejects.toThrow(/has no stored credentials/);
  });
});
