import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore, SECURITY_SERVICE } from "../src/credentials.js";
import { AccountNotFoundError, ConfigError, CredentialError, ValidationError } from "../src/exceptions.js";
import { KeychainError, internals as keychainInternals } from "../src/macos_keychain.js";
import { Platform } from "../src/models.js";
import { ClaudeAccountSwitcher, internals } from "../src/switcher.js";
import type { SwitcherLock } from "../src/switcher/internals.js";
import { sampleSequenceData } from "./helpers/fixtures.js";
import { KeychainStore, keychainStore } from "./helpers/keychain.js";

type Sequence = Omit<ReturnType<typeof sampleSequenceData>, "accounts"> & { accounts: Record<string, Record<string, unknown>> };

function write(switcher: ClaudeAccountSwitcher, data: unknown): void {
  switcher.setupDirectories();
  switcher.writeJson(switcher.sequenceFile, data);
}

function accounts(switcher: ClaudeAccountSwitcher): Record<string, Record<string, unknown>> {
  return switcher.getSequenceData()!.accounts as Record<string, Record<string, unknown>>;
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const noPosixPerms = process.platform === "win32" || isRoot;

const realFileLock = internals.FileLock;

afterEach(() => {
  internals.FileLock = realFileLock;
});

/** Replace `FileLock` with a spy that records the path of each entered lock. */
function spyLock(): string[] {
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
  internals.FileLock = SpyLock;
  return entered;
}

/** An error with an errno `code`, like a Python `OSError`. */
function osError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** Make `fs.unlinkSync` fail for a file whose name starts with `prefix`. */
function failUnlink(prefix: string): void {
  const realUnlink = fs.unlinkSync;
  vi.spyOn(fs, "unlinkSync").mockImplementation((p: fs.PathLike) => {
    if (path.basename(String(p)).startsWith(prefix)) throw osError("EACCES", "permission denied (injected)");
    realUnlink(p);
  });
}

describe("TestMoveAccount", () => {
  it("test_move_to_empty_slot_relocates", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    expect(switcher.moveAccount("2", "5")).toEqual(["2", "5", false]);

    const data = accounts(switcher);
    expect(data["5"]!.email).toBe("account2@example.com");
    expect(data).not.toHaveProperty("2");
    expect(data["1"]!.email).toBe("account1@example.com");
  });

  it("test_move_to_empty_slot_updates_rotation_sequence", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    switcher.moveAccount("2", "5");

    expect(switcher.getSequenceData()!.sequence).toEqual([1, 5]);
  });

  it("test_move_keeps_sequence_sorted", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    switcher.moveAccount("1", "5");

    expect(switcher.getSequenceData()!.sequence).toEqual([2, 5]);
  });

  it("test_move_holds_account_lock", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    const entered = spyLock();

    switcher.moveAccount("2", "5");

    expect(entered).toEqual([switcher.lockFile]);
  });

  it("test_relocate_rechecks_target", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    expect(() => switcher.relocateLocked("1", "2")).toThrow(ValidationError);
    expect(() => switcher.relocateLocked("1", "2")).toThrow(/already occupied/);
  });

  it("test_move_occupied_path_takes_single_lock", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    const entered = spyLock();

    expect(switcher.moveAccount("1", "2")).toEqual(["1", "2", true]);
    expect(entered).toEqual([switcher.lockFile]);
  });

  it("test_move_unbacked_account_clears_stale_target_key", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    switcher.writeAccountCredentials("5", "account2@example.com", "stale-foreign");

    switcher.moveAccount("2", "5");

    expect(switcher.readAccountCredentials("5", "account2@example.com")).toBe("");
    expect(accounts(switcher)["5"]!.email).toBe("account2@example.com");
  });

  it("test_move_failed_required_clear_aborts_commit", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    switcher.writeAccountCredentials("5", "account2@example.com", "stale-foreign");
    failUnlink(".creds-5-");

    let error: unknown;
    try {
      switcher.moveAccount("2", "5");
    } catch (err) {
      error = err;
    }
    vi.mocked(fs.unlinkSync).mockRestore();

    expect(error).toBeInstanceOf(CredentialError);
    expect((error as Error).message).toMatch(/aborting before commit/);
    const data = accounts(switcher);
    expect(data["2"]!.email).toBe("account2@example.com");
    expect(data).not.toHaveProperty("5");
  });

  it.skipIf(noPosixPerms)("test_move_strict_clear_fails_closed_on_unreadable_dir", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    switcher.writeAccountCredentials("5", "account2@example.com", "stale-foreign");

    fs.chmodSync(switcher.credentialsDir, 0o000);
    try {
      expect(() => switcher.moveAccount("2", "5")).toThrow(ConfigError);
      expect(() => switcher.moveAccount("2", "5")).toThrow(/could not be read/);
    } finally {
      fs.chmodSync(switcher.credentialsDir, 0o700);
    }

    const data = accounts(switcher);
    expect(data["2"]!.email).toBe("account2@example.com");
    expect(data).not.toHaveProperty("5");
    expect(switcher.readAccountCredentials("5", "account2@example.com")).toBe("stale-foreign");
  });

  it("test_move_strict_clear_fails_closed_on_locked_keychain", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    switcher.platform = Platform.MACOS;
    const store = keychainStore();
    const staleKey = KeychainStore.key(SECURITY_SERVICE, "account-5-account2@example.com");
    store.data.set(staleKey, "stale-keychain");

    const locked = (): never => {
      throw new KeychainError("keychain locked (injected)");
    };
    keychainInternals.getPassword = locked;
    keychainInternals.deletePassword = locked;
    try {
      expect(() => switcher.moveAccount("2", "5")).toThrow(ConfigError);
      expect(() => switcher.moveAccount("2", "5")).toThrow(/could not be read/);
    } finally {
      keychainInternals.getPassword = store.getPassword;
      keychainInternals.deletePassword = store.deletePassword;
    }

    const data = accounts(switcher);
    expect(data["2"]!.email).toBe("account2@example.com");
    expect(data).not.toHaveProperty("5");
    expect(store.data.get(staleKey)).toBe("stale-keychain");
  });

  it("test_move_metadata_failure_leaves_account_intact", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    switcher.writeAccountCredentials("2", "account2@example.com", "creds-two");

    const realWriteJson = switcher.writeJson.bind(switcher);
    const spy = vi.spyOn(switcher, "writeJson").mockImplementation((filePath: string, data: unknown) => {
      if (filePath === switcher.sequenceFile) throw osError("ENOSPC", "disk full (injected)");
      realWriteJson(filePath, data);
    });
    expect(() => switcher.moveAccount("2", "5")).toThrow(/disk full/);
    spy.mockRestore();

    expect(switcher.readAccountCredentials("2", "account2@example.com")).toBe("creds-two");
    expect(switcher.readAccountCredentials("5", "account2@example.com")).toBe("");
    const data = accounts(switcher);
    expect(data["2"]!.email).toBe("account2@example.com");
    expect(data).not.toHaveProperty("5");
  });

  it("test_move_active_account_to_empty_slot_follows_active", () => {
    const switcher = new ClaudeAccountSwitcher();
    const sample = sampleSequenceData();
    write(switcher, sample);
    expect(sample.activeAccountNumber).toBe(1);

    switcher.moveAccount("1", "9");

    const data = switcher.getSequenceData()!;
    expect(data.activeAccountNumber).toBe(9);
    expect(accounts(switcher)["9"]!.email).toBe("account1@example.com");
  });

  it("test_move_by_email_and_alias", () => {
    const switcher = new ClaudeAccountSwitcher();
    const sample = sampleSequenceData() as Sequence;
    sample.accounts["2"]!.alias = "dev";
    write(switcher, sample);

    expect(switcher.moveAccount("dev", "7")).toEqual(["2", "7", false]);

    const data = accounts(switcher);
    expect(data["7"]!.alias).toBe("dev");
    expect(data).not.toHaveProperty("2");
  });

  it("test_move_relocates_credential_and_config_backups", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    switcher.writeAccountCredentials("2", "account2@example.com", "creds-two");
    switcher.writeAccountConfig("2", "account2@example.com", "config-two");

    switcher.moveAccount("2", "5");

    expect(switcher.readAccountCredentials("5", "account2@example.com")).toBe("creds-two");
    expect(switcher.readAccountConfig("5", "account2@example.com")).toBe("config-two");
    expect(switcher.readAccountCredentials("2", "account2@example.com")).toBe("");
    expect(switcher.readAccountConfig("2", "account2@example.com")).toBe("");
  });

  it("test_move_relocates_session_profile", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());
    const session = switcher.sessionDir("2", "account2@example.com");
    fs.mkdirSync(session, { recursive: true });
    fs.writeFileSync(path.join(session, "marker.txt"), "history-of-account-two");

    switcher.moveAccount("2", "5");

    const moved = switcher.sessionDir("5", "account2@example.com");
    expect(fs.readFileSync(path.join(moved, "marker.txt"), "utf8")).toBe("history-of-account-two");
    expect(fs.existsSync(session)).toBe(false);
  });

  it("test_move_to_empty_slot_with_missing_backups", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    switcher.moveAccount("2", "5");

    expect(accounts(switcher)["5"]!.email).toBe("account2@example.com");
    expect(switcher.readAccountCredentials("5", "account2@example.com")).toBe("");
  });

  it("test_move_to_occupied_slot_swaps", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    expect(switcher.moveAccount("1", "2")).toEqual(["1", "2", true]);

    const data = accounts(switcher);
    expect(data["2"]!.email).toBe("account1@example.com");
    expect(data["1"]!.email).toBe("account2@example.com");
  });

  it("test_move_is_general_form_of_swap", () => {
    const moveSwitcher = new ClaudeAccountSwitcher();
    write(moveSwitcher, sampleSequenceData());
    moveSwitcher.moveAccount("1", "2");
    const moved = accounts(moveSwitcher);

    const swapSwitcher = new ClaudeAccountSwitcher();
    write(swapSwitcher, sampleSequenceData());
    swapSwitcher.swapAccounts("1", "2");
    const swapped = accounts(swapSwitcher);

    expect(moved["1"]!.email).toBe(swapped["1"]!.email);
    expect(moved["2"]!.email).toBe(swapped["2"]!.email);
  });

  it("test_move_to_same_slot_is_noop", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    expect(switcher.moveAccount("1", "1")).toEqual(["1", "1", false]);

    const data = accounts(switcher);
    expect(data["1"]!.email).toBe("account1@example.com");
    expect(data["2"]!.email).toBe("account2@example.com");
  });

  it("test_move_normalizes_padded_target", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    const [, numTarget] = switcher.moveAccount("2", "05");

    expect(numTarget).toBe("5");
    expect(accounts(switcher)["5"]!.email).toBe("account2@example.com");
  });

  it.each(["abc", "0", "-1", "1.5", ""])("test_move_invalid_target_rejected[%s]", (bad) => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    expect(() => switcher.moveAccount("1", bad)).toThrow(ValidationError);
  });

  it("test_move_unknown_account_rejected", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    expect(() => switcher.moveAccount("nosuch@example.com", "5")).toThrow(AccountNotFoundError);
  });

  it("test_move_target_above_cap_rejected", () => {
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    expect(() => switcher.moveAccount("1", "100")).toThrow(ValidationError);
    expect(() => switcher.moveAccount("1", "100")).toThrow(/out of range/);
  });

  it("test_move_cap_stretches_to_existing_max_slot", () => {
    const switcher = new ClaudeAccountSwitcher();
    const sample = sampleSequenceData() as Sequence;
    sample.accounts["150"] = { email: "account150@example.com", uuid: "uuid-150", added: "2024-01-03T00:00:00Z" };
    sample.sequence.push(150);
    write(switcher, sample);

    expect(switcher.moveAccount("1", "120")).toEqual(["1", "120", false]);
    expect(accounts(switcher)["120"]!.email).toBe("account1@example.com");

    expect(() => switcher.moveAccount("2", "151")).toThrow(ValidationError);
    expect(() => switcher.moveAccount("2", "151")).toThrow(/out of range/);
  });
});

describe("TestMoveUnreadableSourceIsNotAbsent", () => {
  function fileMode(): void {
    vi.spyOn(CredentialStore.prototype, "useKeychain").mockReturnValue(false);
  }

  it.skipIf(noPosixPerms).each([null, Platform.MACOS])(
    "test_unreadable_enc_aborts_the_move_before_anything_changes[%s]",
    (asPlatform) => {
      fileMode();
      const switcher = new ClaudeAccountSwitcher();
      if (asPlatform !== null) switcher.platform = asPlatform;
      write(switcher, sampleSequenceData());
      switcher.writeAccountCredentials("2", "account2@example.com", "live-rt");
      switcher.writeAccountCredentials("1", "account1@example.com", "rt-1");

      expect(switcher.moveAccount("1", "5")).toEqual(["1", "5", false]);
      expect(switcher.readAccountCredentials("5", "account1@example.com")).toBe("rt-1");

      const enc = switcher.backupEncPath("2", "account2@example.com");
      fs.chmodSync(enc, 0o000);
      try {
        expect(() => switcher.moveAccount("2", "6")).toThrow(ConfigError);
        expect(() => switcher.moveAccount("2", "6")).toThrow(/could not be read/);
      } finally {
        if (fs.existsSync(enc)) fs.chmodSync(enc, 0o600);
      }

      const data = accounts(switcher);
      expect(data["2"]!.email).toBe("account2@example.com");
      expect(data).not.toHaveProperty("6");
      expect(switcher.readAccountCredentials("2", "account2@example.com")).toBe("live-rt");
    },
  );

  it("test_absent_source_still_moves", () => {
    fileMode();
    const switcher = new ClaudeAccountSwitcher();
    write(switcher, sampleSequenceData());

    expect(switcher.moveAccount("2", "5")).toEqual(["2", "5", false]);
    expect(accounts(switcher)["5"]!.email).toBe("account2@example.com");
  });
});
