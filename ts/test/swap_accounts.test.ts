import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { AccountNotFoundError, ConfigError, CredentialError, ValidationError } from "../src/exceptions.js";
import { Platform } from "../src/models.js";
import { ClaudeAccountSwitcher, internals, type SequenceData } from "../src/switcher.js";
import type { SwitcherLock } from "../src/switcher/internals.js";
import { sampleSequenceData, sampleSequenceDataWithOrg } from "./helpers/fixtures.js";

function write(switcher: ClaudeAccountSwitcher, data: unknown): void {
  switcher.setupDirectories();
  switcher.writeJson(switcher.sequenceFile, data);
}

function sequence(switcher: ClaudeAccountSwitcher): SequenceData {
  return switcher.getSequenceData()!;
}

function account(switcher: ClaudeAccountSwitcher, num: string): Record<string, unknown> {
  return sequence(switcher).accounts![num] as Record<string, unknown>;
}

function stagingFiles(switcher: ClaudeAccountSwitcher): string[] {
  return fs.readdirSync(switcher.credentialsDir).filter((name) => name.startsWith(".swap-staging-"));
}

function osError(message: string, code = "EIO"): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe("TestSwapAccounts", () => {
  it("test_swap_by_number", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    expect(switcher.swapAccounts("1", "2")).toEqual(["1", "2"]);

    expect(account(switcher, "1").email).toBe("account2@example.com");
    expect(account(switcher, "2").email).toBe("account1@example.com");
  });

  it("test_swap_moves_active_number_with_account", () => {
    const switcher = new ClaudeAccountSwitcher();
    const data = sampleSequenceData();
    write(switcher, data);
    expect(data.activeAccountNumber).toBe(1);

    switcher.swapAccounts("1", "2");

    expect(sequence(switcher).activeAccountNumber).toBe(2);
    expect(account(switcher, "2").email).toBe("account1@example.com");
  });

  it("test_swap_keeps_sequence_sorted", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    switcher.swapAccounts("1", "2");

    expect(sequence(switcher).sequence).toEqual([1, 2]);
  });

  it("test_swap_by_email_and_alias", () => {
    const switcher = new ClaudeAccountSwitcher();
    const data = sampleSequenceData();
    (data.accounts["2"] as Record<string, unknown>).alias = "dev";
    write(switcher, data);

    expect(switcher.swapAccounts("account1@example.com", "dev")).toEqual(["1", "2"]);

    // The alias travels with its account into the new slot.
    expect(account(switcher, "1").alias).toBe("dev");
    expect(account(switcher, "2").alias).toBeUndefined();
  });

  it("test_swap_moves_credential_and_config_backups", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    switcher.writeAccountCredentials("1", "account1@example.com", "creds-one");
    switcher.writeAccountConfig("1", "account1@example.com", "config-one");
    switcher.writeAccountCredentials("2", "account2@example.com", "creds-two");
    switcher.writeAccountConfig("2", "account2@example.com", "config-two");

    switcher.swapAccounts("1", "2");

    expect(switcher.readAccountCredentials("2", "account1@example.com")).toBe("creds-one");
    expect(switcher.readAccountConfig("2", "account1@example.com")).toBe("config-one");
    expect(switcher.readAccountCredentials("1", "account2@example.com")).toBe("creds-two");
    expect(switcher.readAccountConfig("1", "account2@example.com")).toBe("config-two");
    expect(switcher.readAccountCredentials("1", "account1@example.com")).toBe("");
    expect(switcher.readAccountCredentials("2", "account2@example.com")).toBe("");
  });

  it("test_swap_with_one_slot_missing_backups", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    switcher.writeAccountCredentials("1", "account1@example.com", "creds-one");

    switcher.swapAccounts("1", "2");

    expect(switcher.readAccountCredentials("2", "account1@example.com")).toBe("creds-one");
    expect(switcher.readAccountCredentials("1", "account2@example.com")).toBe("");
  });

  it("test_swap_same_account_rejected", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    expect(() => switcher.swapAccounts("1", "1")).toThrow(ValidationError);
  });

  it("test_swap_unknown_identifier_rejected", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    expect(() => switcher.swapAccounts("1", "nosuch@example.com")).toThrow(AccountNotFoundError);
  });

  it("test_swap_same_email_accounts", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceDataWithOrg());
    const email = "user@example.com";
    switcher.writeAccountCredentials("1", email, "creds-org");
    switcher.writeAccountCredentials("2", email, "creds-personal");

    switcher.swapAccounts("1", "2");

    expect(switcher.readAccountCredentials("1", email)).toBe("creds-personal");
    expect(switcher.readAccountCredentials("2", email)).toBe("creds-org");
    expect(account(switcher, "2").organizationUuid).toBe("org-uuid-5678");
    expect(stagingFiles(switcher)).toEqual([]);
  });

  it("test_swap_same_email_partial_failure_rolls_back", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceDataWithOrg());
    const email = "user@example.com";
    switcher.writeAccountCredentials("1", email, "creds-org");
    switcher.writeAccountCredentials("2", email, "creds-personal");

    const realWrite = switcher.writeAccountCredentials.bind(switcher);
    let calls = 0;
    const spy = vi.spyOn(switcher, "writeAccountCredentials").mockImplementation((num, mail, creds) => {
      calls += 1;
      if (calls === 2) throw osError("disk full (injected)");
      realWrite(num, mail, creds);
    });
    expect(() => switcher.swapAccounts("1", "2")).toThrow("disk full (injected)");
    spy.mockRestore();

    // Both originals are back under their pre-swap keys, and the table was never renumbered.
    expect(switcher.readAccountCredentials("1", email)).toBe("creds-org");
    expect(switcher.readAccountCredentials("2", email)).toBe("creds-personal");
    expect(account(switcher, "1").organizationUuid).toBe("org-uuid-5678");
    expect(sequence(switcher).activeAccountNumber).toBe(1);
  });

  it("test_swap_same_email_persistent_failure_keeps_staged_copy", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceDataWithOrg());
    const email = "user@example.com";
    switcher.writeAccountCredentials("1", email, "creds-org");
    switcher.writeAccountCredentials("2", email, "creds-personal");

    const realWrite = switcher.writeAccountCredentials.bind(switcher);
    let calls = 0;
    const spy = vi.spyOn(switcher, "writeAccountCredentials").mockImplementation((num, mail, creds) => {
      calls += 1;
      if (calls >= 2) throw osError("disk full (injected, persistent)");
      realWrite(num, mail, creds);
    });
    expect(() => switcher.swapAccounts("1", "2")).toThrow("disk full");
    spy.mockRestore();

    // The restore failed, so slot 2 holds the wrong material, but the staged copy has the original.
    expect(switcher.readAccountCredentials("1", email)).toBe("creds-org");
    const staged = path.join(switcher.credentialsDir, ".swap-staging-creds-2.json");
    expect(fs.readFileSync(staged, "utf8")).toBe("creds-personal");
    if (process.platform !== "win32") expect(fs.statSync(staged).mode & 0o777).toBe(0o600);
  });

  it("test_swap_same_email_rollback_restores_empty_slot", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceDataWithOrg());
    const email = "user@example.com";
    switcher.writeAccountCredentials("1", email, "creds-org");

    const spy = vi.spyOn(switcher, "writeJson").mockImplementation(() => {
      throw osError("disk full (injected)");
    });
    expect(() => switcher.swapAccounts("1", "2")).toThrow("disk full (injected)");
    spy.mockRestore();

    expect(switcher.readAccountCredentials("1", email)).toBe("creds-org");
    expect(switcher.readAccountCredentials("2", email)).toBe("");
    expect(account(switcher, "1").organizationUuid).toBe("org-uuid-5678");
    expect(stagingFiles(switcher)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("test_write_json_publishes_only_after_chmod", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    const before = fs.readFileSync(switcher.sequenceFile, "utf8");

    const spy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw osError("chmod denied (injected)", "EPERM");
    });
    expect(() => switcher.writeJson(switcher.sequenceFile, { x: 1 })).toThrow("chmod denied");
    spy.mockRestore();

    expect(fs.readFileSync(switcher.sequenceFile, "utf8")).toBe(before);
  });

  it("test_swap_same_email_one_sided_clears_destination", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceDataWithOrg());
    const email = "user@example.com";
    switcher.writeAccountCredentials("1", email, "creds-org");

    switcher.swapAccounts("1", "2");

    expect(switcher.readAccountCredentials("2", email)).toBe("creds-org");
    expect(switcher.readAccountCredentials("1", email)).toBe("");
    expect(account(switcher, "2").organizationUuid).toBe("org-uuid-5678");
  });

  it("test_swap_clears_stale_destination_key", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    // Account 1 has no backup. A stale file sits under the key it takes after the swap.
    switcher.writeAccountCredentials("2", "account1@example.com", "stale-foreign");

    switcher.swapAccounts("1", "2");

    expect(switcher.readAccountCredentials("2", "account1@example.com")).toBe("");
  });

  it("test_swap_refuses_leftover_staging", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceDataWithOrg());
    const email = "user@example.com";
    switcher.writeAccountCredentials("1", email, "creds-org");
    switcher.writeAccountCredentials("2", email, "creds-personal");
    const leftover = path.join(switcher.credentialsDir, ".swap-staging-creds-1.json");
    fs.writeFileSync(leftover, "only-surviving-copy", "utf8");

    expect(() => switcher.swapAccounts("1", "2")).toThrow(ConfigError);
    expect(() => switcher.swapAccounts("1", "2")).toThrow(/interrupted swap/);

    expect(fs.readFileSync(leftover, "utf8")).toBe("only-surviving-copy");
    expect(switcher.readAccountCredentials("1", email)).toBe("creds-org");
    expect(switcher.readAccountCredentials("2", email)).toBe("creds-personal");
    expect(account(switcher, "1").organizationUuid).toBe("org-uuid-5678");
  });

  it("test_swap_failed_required_clear_aborts_commit", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceDataWithOrg());
    const email = "user@example.com";
    switcher.writeAccountCredentials("1", email, "creds-org");

    const realUnlink = fs.unlinkSync;
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (path.basename(String(target)).startsWith(".creds-1-")) {
        throw osError("permission denied (injected)", "EACCES");
      }
      realUnlink(target);
    });
    let caught: unknown;
    try {
      switcher.swapAccounts("1", "2");
    } catch (e) {
      caught = e;
    }
    spy.mockRestore();
    expect(caught).toBeInstanceOf(CredentialError);
    expect((caught as Error).message).toMatch(/aborting before commit/);

    // The table is not renumbered, and the rollback reverted the half-written copy under the shared key.
    expect(account(switcher, "1").organizationUuid).toBe("org-uuid-5678");
    expect(switcher.readAccountCredentials("1", email)).toBe("creds-org");
    expect(switcher.readAccountCredentials("2", email)).toBe("");
  });

  it("test_swap_same_email_clears_prev_generations", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceDataWithOrg());
    const email = "user@example.com";
    switcher.writeAccountCredentials("1", email, "creds-org");
    switcher.writeAccountCredentials("2", email, "creds-personal");

    switcher.swapAccounts("1", "2");

    expect(fs.readdirSync(switcher.credentialsDir).filter((name) => name.endsWith(".enc.prev"))).toEqual([]);
  });

  it("test_swap_holds_account_lock", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    const entered: string[] = [];

    class SpyLock implements SwitcherLock {
      constructor(readonly lockPath: string) {}
      acquire(): boolean {
        return true;
      }
      release(): void {}
      enter(): this {
        entered.push(this.lockPath);
        return this;
      }
      exit(): void {}
    }

    const realLock = internals.FileLock;
    internals.FileLock = SpyLock;
    try {
      switcher.swapAccounts("1", "2");
    } finally {
      internals.FileLock = realLock;
    }

    expect(entered).toEqual([switcher.lockFile]);
  });

  it("test_swap_moves_session_profiles", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    const sessionA = switcher.sessionDir("1", "account1@example.com");
    fs.mkdirSync(sessionA, { recursive: true });
    fs.writeFileSync(path.join(sessionA, "marker.txt"), "history-of-account-one");

    switcher.swapAccounts("1", "2");

    const moved = switcher.sessionDir("2", "account1@example.com");
    expect(fs.readFileSync(path.join(moved, "marker.txt"), "utf8")).toBe("history-of-account-one");
    expect(fs.existsSync(sessionA)).toBe(false);
  });
});

describe("TestSwapUnreadableSourceIsNotAbsent", () => {
  function fileModeSwitcher(): ClaudeAccountSwitcher {
    // Force the file store: on macOS a usable Keychain takes the write, and there is no `.enc` to chmod.
    vi.spyOn(CredentialStore.prototype, "useKeychain").mockReturnValue(false);
    return new ClaudeAccountSwitcher();
  }

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([null, Platform.MACOS])(
    "test_unreadable_enc_aborts_the_swap_before_anything_changes[%s]",
    (asPlatform) => {
      const switcher = fileModeSwitcher();
      if (asPlatform !== null) switcher.platform = asPlatform;
      write(switcher, sampleSequenceData());
      switcher.writeAccountCredentials("1", "account1@example.com", "rt-1");
      switcher.writeAccountCredentials("2", "account2@example.com", "rt-2");

      // Control: both readable, the swap lands cleanly.
      switcher.swapAccounts("1", "2");
      expect(switcher.readAccountCredentials("2", "account1@example.com")).toBe("rt-1");
      expect(switcher.readAccountCredentials("1", "account2@example.com")).toBe("rt-2");
      switcher.swapAccounts("1", "2");

      const enc = switcher.backupEncPath("2", "account2@example.com");
      fs.chmodSync(enc, 0o000);
      try {
        expect(() => switcher.swapAccounts("1", "2")).toThrow(ConfigError);
        expect(() => switcher.swapAccounts("1", "2")).toThrow(/could not be read/);
      } finally {
        if (fs.existsSync(enc)) fs.chmodSync(enc, 0o600);
      }

      expect(account(switcher, "1").email).toBe("account1@example.com");
      expect(account(switcher, "2").email).toBe("account2@example.com");
      expect(switcher.readAccountCredentials("1", "account1@example.com")).toBe("rt-1");
      expect(switcher.readAccountCredentials("2", "account2@example.com")).toBe("rt-2");
    },
  );

  it("test_absent_source_still_swaps", () => {
    const switcher = fileModeSwitcher();
    write(switcher, sampleSequenceData());

    expect(switcher.swapAccounts("1", "2")).toEqual(["1", "2"]);

    expect(account(switcher, "1").email).toBe("account2@example.com");
    expect(account(switcher, "2").email).toBe("account1@example.com");
  });
});
