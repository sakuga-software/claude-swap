import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MigrationIncomplete } from "../src/exceptions.js";
import { KeychainError, internals as keychainInternals } from "../src/macos_keychain.js";
import * as migrations from "../src/migrations.js";
import { runMigrations } from "../src/migrations.js";
import { Platform } from "../src/models.js";
import { type AccountRecord, ClaudeAccountSwitcher, KEYRING_SERVICE, internals } from "../src/switcher.js";
import { captureOutput } from "./helpers/capture.js";
import { keychainStore } from "./helpers/keychain.js";

function makeWindowsSwitcher(): ClaudeAccountSwitcher {
  const switcher = new ClaudeAccountSwitcher();
  switcher.platform = Platform.WINDOWS;
  switcher.setupDirectories();
  return switcher;
}

/** Construction runs the migrations while no sequence exists (a no-op). The test seeds the sequence after. */
function makeMacosSwitcher(): ClaudeAccountSwitcher {
  const switcher = new ClaudeAccountSwitcher();
  switcher.platform = Platform.MACOS;
  switcher.setupDirectories();
  return switcher;
}

function seedSequence(switcher: ClaudeAccountSwitcher, accounts: Record<string, AccountRecord>): void {
  switcher.writeJson(switcher.sequenceFile, {
    activeAccountNumber: null,
    lastUpdated: "2024-01-01T00:00:00Z",
    sequence: Object.keys(accounts)
      .filter((k) => /^\d+$/.test(k))
      .map(Number),
    accounts,
  });
}

function stateFile(switcher: ClaudeAccountSwitcher): string {
  return path.join(switcher.backupDir, ".migrations.json");
}

function readState(switcher: ClaudeAccountSwitcher): { version: number; applied: Record<string, string> } {
  return JSON.parse(fs.readFileSync(stateFile(switcher), "utf8")) as { version: number; applied: Record<string, string> };
}

function seedLegacyItem(username: string, secret: string): void {
  keychainStore().setPassword(KEYRING_SERVICE, username, secret);
}

function hasLegacyItem(username: string): boolean {
  return keychainStore().itemExists(KEYRING_SERVICE, username);
}

describe("TestWindowsKeyringToFiles", () => {
  it.skip("test_migrates_entries_to_files_and_records_state", () => {
    // Node has no Credential Manager binding, so the Windows migration is a no-op that returns false.
  });

  it.skip("test_idempotent_second_run_touches_no_keyring", () => {
    // Node has no Credential Manager binding, so the Windows migration is a no-op that returns false.
  });

  it.skip("test_creates_credentials_dir_if_missing", () => {
    // Node has no Credential Manager binding, so the Windows migration is a no-op that returns false.
  });

  it.skip("test_completes_when_no_legacy_entries_present", () => {
    // Node has no Credential Manager binding, so the Windows migration is a no-op. the no-op returns false, so the migration is never recorded.
  });
});

describe("TestSkips", () => {
  it("test_non_windows_is_noop", () => {
    const switcher = makeWindowsSwitcher();
    switcher.platform = Platform.LINUX;
    seedSequence(switcher, { "1": { email: "a@example.com" } });

    expect(migrations.migrateWindowsKeyringToFiles(switcher)).toBe(false);
    expect(fs.existsSync(stateFile(switcher))).toBe(false);
  });

  it("test_no_sequence_file_skips_unmarked", () => {
    const switcher = makeWindowsSwitcher();
    expect(migrations.migrateWindowsKeyringToFiles(switcher)).toBe(false);
    expect(fs.existsSync(stateFile(switcher))).toBe(false);
  });

  it("test_corrupt_sequence_not_marked", () => {
    const switcher = makeWindowsSwitcher();
    fs.writeFileSync(switcher.sequenceFile, "{ not json", "utf8");
    runMigrations(switcher);
    expect(fs.existsSync(stateFile(switcher))).toBe(false);
  });
});

describe("TestAccountNoneFallback", () => {
  it.skip("test_canonical_wins_over_none", () => {
    // Node has no Credential Manager binding, so the Windows migration is a no-op that returns false.
  });

  it.skip("test_none_used_as_fallback_when_email_unique", () => {
    // Node has no Credential Manager binding, so the Windows migration is a no-op that returns false.
  });

  it.skip("test_none_not_used_for_duplicate_email", () => {
    // Node has no Credential Manager binding, so the Windows migration is a no-op that returns false.
  });
});

describe("TestFailures", () => {
  it.skip("test_read_back_mismatch_keeps_keyring_and_unmarked", () => {
    // Node has no Credential Manager binding, so the Windows migration is a no-op that returns false.
  });

  it.skip("test_partial_failure_migrates_rest_and_stays_unmarked", () => {
    // Node has no Credential Manager binding, so the Windows migration is a no-op that returns false.
  });

  it.skip("test_partial_failure_raises_from_migration_fn", () => {
    // Node has no Credential Manager binding, so the Windows migration is a no-op that returns false.
  });

  it.skip("test_inaccessible_backend_raises_incomplete", () => {
    // Node has no Credential Manager binding, so the Windows migration is a no-op. the backend is always absent, and the no-op returns false instead of a throw.
  });
});

describe("TestRunner", () => {
  it("test_noop_when_backup_dir_absent", () => {
    const switcher = new ClaudeAccountSwitcher();
    switcher.platform = Platform.WINDOWS;
    expect(fs.existsSync(switcher.backupDir)).toBe(false);
    runMigrations(switcher);
    expect(fs.existsSync(switcher.backupDir)).toBe(false);
  });
});

describe("TestWindowsFileBackend", () => {
  it("test_round_trip_uses_files_not_keyring", () => {
    const switcher = makeWindowsSwitcher();
    expect(switcher.usesFileBackupBackend()).toBe(true);
    const getPassword = vi.spyOn(keychainInternals, "getPassword");
    const setPassword = vi.spyOn(keychainInternals, "setPassword");

    switcher.writeAccountCredentials("1", "a@example.com", "secret");
    expect(switcher.readAccountCredentials("1", "a@example.com")).toBe("secret");
    switcher.deleteAccountCredentials("1", "a@example.com");
    expect(switcher.readAccountCredentials("1", "a@example.com")).toBe("");
    expect(getPassword).not.toHaveBeenCalled();
    expect(setPassword).not.toHaveBeenCalled();

    expect(fs.existsSync(path.join(switcher.credentialsDir, ".creds-1-a@example.com.enc"))).toBe(false);
  });
});

describe("TestPurgeWindows", () => {
  it("test_purge_removes_files_and_legacy_keyring", () => {
    // The Credential Manager half of the Python test has no Node equivalent. Only the file cleanup is checked.
    const switcher = makeWindowsSwitcher();
    seedSequence(switcher, { "1": { email: "a@example.com" } });
    switcher.writeAccountCredentials("1", "a@example.com", "secret");
    const credFile = path.join(switcher.credentialsDir, ".creds-1-a@example.com.enc");
    expect(fs.existsSync(credFile)).toBe(true);

    captureOutput();
    vi.spyOn(internals, "input").mockReturnValue("y");
    switcher.purge();

    expect(fs.existsSync(credFile)).toBe(false);
  });
});

describe("TestMacosKeyringToSecurity", () => {
  it("test_non_macos_skips", () => {
    const switcher = makeMacosSwitcher();
    switcher.platform = Platform.LINUX;
    expect(migrations.migrateMacosKeyringToSecurity(switcher)).toBe(false);
  });

  it("test_no_sequence_skips", () => {
    const switcher = makeMacosSwitcher();
    fs.rmSync(switcher.sequenceFile, { force: true });
    expect(migrations.migrateMacosKeyringToSecurity(switcher)).toBe(false);
  });

  it("test_empty_accounts_completes", () => {
    const switcher = makeMacosSwitcher();
    seedSequence(switcher, {});
    expect(migrations.migrateMacosKeyringToSecurity(switcher)).toBe(true);
  });

  it.skip("test_relocates_keyring_creds_to_security", () => {
    // Node has no keyring library. The macOS migration reads the legacy items with security and never deletes them. the test checks the keyring delete. test_fallback_to_security_when_keyring_unavailable covers the relocation.
  });

  it.skip("test_denied_legacy_delete_warns_but_completes", () => {
    // Node has no keyring library. The macOS migration reads the legacy items with security and never deletes them. no keyring delete exists to deny.
  });

  it("test_precheck_skips_keyring_when_already_migrated", () => {
    const switcher = makeMacosSwitcher();
    seedSequence(switcher, { "1": { email: "a@example.com" } });
    switcher.writeAccountCredentials("1", "a@example.com", "already");
    const getPassword = vi.spyOn(keychainInternals, "getPassword");

    expect(migrations.migrateMacosKeyringToSecurity(switcher)).toBe(true);

    expect(getPassword.mock.calls.filter(([service]) => service === KEYRING_SERVICE)).toEqual([]);
  });

  it("test_no_keyring_item_is_benign_skip", () => {
    const switcher = makeMacosSwitcher();
    seedSequence(switcher, { "1": { email: "a@example.com" } });

    expect(migrations.migrateMacosKeyringToSecurity(switcher)).toBe(true);
    expect(switcher.readAccountCredentials("1", "a@example.com")).toBe("");
  });

  it("test_read_back_mismatch_keeps_keyring_and_raises", () => {
    const switcher = makeMacosSwitcher();
    seedSequence(switcher, { "1": { email: "a@example.com" } });
    seedLegacyItem("account-1-a@example.com", "sekret");

    vi.spyOn(switcher, "kcReadBackup").mockReturnValueOnce("").mockReturnValueOnce("WRONG");
    expect(() => migrations.migrateMacosKeyringToSecurity(switcher)).toThrow(MigrationIncomplete);

    expect(hasLegacyItem("account-1-a@example.com")).toBe(true);
  });

  it("test_fallback_to_security_when_keyring_unavailable", () => {
    const switcher = makeMacosSwitcher();
    seedSequence(switcher, { "1": { email: "a@example.com" } });
    seedLegacyItem("account-1-a@example.com", "sekret");
    const err = captureOutput();

    expect(migrations.migrateMacosKeyringToSecurity(switcher)).toBe(true);

    expect(switcher.readAccountCredentials("1", "a@example.com")).toBe("sekret");
    // The legacy item stays on purpose: a delete with security can show a second prompt.
    expect(hasLegacyItem("account-1-a@example.com")).toBe(true);
    expect(err.readouterr().err).toContain("migrated 1 macOS credential(s)");
  });

  it.skip("test_locked_keyring_does_not_fall_back", () => {
    // Node has no keyring library. The macOS migration reads the legacy items with security and never deletes them. no keyring read exists that could fail before the security read.
  });

  it("test_security_keychain_unusable_defers_and_writes_no_enc", () => {
    const switcher = makeMacosSwitcher();
    seedSequence(switcher, { "1": { email: "a@example.com" } });

    vi.spyOn(switcher, "kcReadBackup").mockImplementation(() => {
      throw new KeychainError("locked");
    });
    runMigrations(switcher);

    expect(fs.existsSync(path.join(switcher.credentialsDir, ".creds-1-a@example.com.enc"))).toBe(false);
    if (fs.existsSync(stateFile(switcher))) {
      expect(readState(switcher).applied).not.toHaveProperty("macos_keyring_to_security");
    }
  });

  it("test_idempotent_via_runner_marks_applied", () => {
    const switcher = makeMacosSwitcher();
    seedSequence(switcher, { "1": { email: "a@example.com" } });
    seedLegacyItem("account-1-a@example.com", "sekret");
    captureOutput();

    runMigrations(switcher);
    const state = readState(switcher);
    expect(state.applied).toHaveProperty("macos_keyring_to_security");
    expect(state.version).toBe(1);
  });
});
