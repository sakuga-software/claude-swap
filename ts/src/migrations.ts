/**
 * Run-once data migrations. Each migration:
 * - returns true when it completed: the runner records it as applied;
 * - returns false when it does not apply: the runner records nothing, so a backup restored later can still trigger it;
 * - throws (`MigrationIncomplete` or other) when it failed in part: the runner logs it and tries it again on the next run.
 *
 * `<backupDir>/.migrations.json` records the applied migrations:
 * `{"version": 1, "applied": {"<id>": "<timestamp>"}}`.
 */

import fs from "node:fs";
import path from "node:path";
import { MigrationIncomplete } from "./exceptions.js";
import { replaceWithRetry } from "./fsutil.js";
import * as macosKeychain from "./macos_keychain.js";
import { Platform, getTimestamp } from "./models.js";
import { internals as settingsInternals } from "./settings.js";
import { errorText } from "./support/oserror.js";
import { jsonDumps } from "./support/py.js";
import { type AccountRecord, type ClaudeAccountSwitcher, KEYRING_SERVICE } from "./switcher.js";

export const STATE_FILENAME = ".migrations.json";
export const STATE_VERSION = 1;

function statePath(switcher: ClaudeAccountSwitcher): string {
  return path.join(switcher.backupDir, STATE_FILENAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `{migrationId: timestamp}` map. A missing or corrupt state file gives `{}`, so it never blocks a migration. */
export function loadApplied(switcher: ClaudeAccountSwitcher): Record<string, unknown> {
  const file = statePath(switcher);
  if (!fs.existsSync(file)) return {};
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const applied = isPlainObject(data) ? data.applied : undefined;
  return isPlainObject(applied) ? applied : {};
}

/** Record `migrationId` as applied with an atomic write. The other records stay. */
export function markApplied(switcher: ClaudeAccountSwitcher, migrationId: string): void {
  const file = statePath(switcher);
  const applied = loadApplied(switcher);
  applied[migrationId] = getTimestamp();
  const content = jsonDumps({ version: STATE_VERSION, applied }, 2);

  const [fd, tmpPath] = settingsInternals.mkstemp(path.dirname(file), ".tmp");
  let openFd = fd;
  try {
    fs.writeSync(openFd, Buffer.from(content, "utf8"));
    fs.closeSync(openFd);
    openFd = -1;
    replaceWithRetry(tmpPath, file);
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  } catch (e) {
    if (openFd >= 0) fs.closeSync(openFd);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // The replace can already have moved the file.
    }
    throw e;
  }
}

function emailOf(info: AccountRecord): string {
  return info.email ?? "";
}

function countEmails(accounts: Record<string, AccountRecord>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const info of Object.values(accounts)) counts.set(emailOf(info), (counts.get(emailOf(info)) ?? 0) + 1);
  return counts;
}

/**
 * Copy the Windows backup credentials from Credential Manager to files.
 *
 * Node has no binding for the Credential Manager, so this port cannot read the
 * legacy entries. It returns false and does not record the migration: the
 * Python version can still do it on the same store.
 */
export function migrateWindowsKeyringToFiles(_switcher: ClaudeAccountSwitcher): boolean {
  return false;
}

/**
 * Move the macOS backup credentials from the legacy `KEYRING_SERVICE` items to
 * the `security` service (`SECURITY_SERVICE`). The copy is written and read
 * back before the legacy item is considered done.
 *
 * Node has no `keyring` library. The `security` CLI reads the same login
 * Keychain items, so this port always does the Python "keyring unavailable"
 * path: it reads with `security` and leaves the legacy item in place, because a
 * delete by a different app can show a second Keychain prompt. `purge` removes it.
 *
 * Returns false on another platform or without a readable sequence. Throws
 * `MigrationIncomplete` if an account could not be moved safely.
 */
export function migrateMacosKeyringToSecurity(switcher: ClaudeAccountSwitcher): boolean {
  if (switcher.platform !== Platform.MACOS) return false;
  if (!fs.existsSync(switcher.sequenceFile)) return false;

  const data = switcher.getSequenceData();
  // A corrupt sequence must not mark the migration: a repaired or restored file must still get it.
  if (data === null) return false;

  const accounts = data.accounts ?? {};
  if (Object.keys(accounts).length === 0) return true;

  // Read the security service directly: a fallback .enc file must not count as "already migrated".
  let pending: [string, AccountRecord][];
  try {
    pending = Object.entries(accounts).filter(([accountNum, info]) => !switcher.kcReadBackup(accountNum, emailOf(info)));
  } catch (e) {
    if (!macosKeychain.isKeychainError(e)) throw e;
    throw new MigrationIncomplete(`Keychain unavailable, deferring macOS keyring migration: ${errorText(e)}`, {
      cause: e,
    });
  }
  if (pending.length === 0) return true;

  // `account-None-<email>` belongs to a slot only when no other slot has that email.
  const emailCounts = countEmails(accounts);
  const readOld = (username: string): string => macosKeychain.getPassword(KEYRING_SERVICE, username) ?? "";

  let migrated = 0;
  let failed = 0;

  for (const [accountNum, info] of pending) {
    const email = emailOf(info);
    const canonical = `account-${accountNum}-${email}`;
    const noneUser = `account-None-${email}`;

    let creds: string;
    try {
      creds = readOld(canonical);
    } catch (e) {
      switcher.logger.warning(`macos_keyring_to_security: read of ${canonical} failed: ${errorText(e)}`);
      failed += 1;
      continue;
    }

    let sourceUsername = canonical;
    if (!creds && accountNum !== "None" && emailCounts.get(email) === 1) {
      try {
        creds = readOld(noneUser);
      } catch (e) {
        switcher.logger.warning(`macos_keyring_to_security: read of ${noneUser} failed: ${errorText(e)}`);
        failed += 1;
        continue;
      }
      if (creds) sourceUsername = noneUser;
    }

    if (!creds) continue;

    // Use the Keychain-only helpers: the transparent backup methods can divert the write to an .enc file.
    let readback: string;
    try {
      switcher.kcWriteBackup(accountNum, email, creds);
      readback = switcher.kcReadBackup(accountNum, email);
    } catch (e) {
      switcher.logger.warning(`macos_keyring_to_security: write/read-back for ${canonical} failed: ${errorText(e)}`);
      // A partial item must not shadow the intact legacy entry. The retry writes it again.
      switcher.deleteBackupKeychainQuiet(accountNum, email);
      failed += 1;
      continue;
    }

    if (readback !== creds) {
      switcher.logger.warning(
        `macos_keyring_to_security: read-back mismatch for ${canonical}; ` +
          "discarding the security item and leaving the keyring entry in place",
      );
      switcher.deleteBackupKeychainQuiet(accountNum, email);
      failed += 1;
      continue;
    }

    if (macosKeychain.itemExists(KEYRING_SERVICE, sourceUsername)) {
      switcher.logger.warning(
        `macos_keyring_to_security: legacy keyring entry ${sourceUsername} ` +
          "was left behind (delete failed or was denied); harmless — " +
          "remove manually or via purge",
      );
    }
    migrated += 1;
  }

  if (migrated) {
    process.stderr.write(
      `claude-swap: migrated ${migrated} macOS credential(s) from the keyring into the Keychain via security\n`,
    );
  }

  if (failed) {
    throw new MigrationIncomplete(
      `${failed} account(s) could not be migrated to the security service; will retry on next run`,
    );
  }
  return true;
}

export type Migration = (switcher: ClaudeAccountSwitcher) => boolean;

/** The migrations in run order, as `[id, fn]`. The ids are the keys of the state file. */
export const MIGRATIONS: readonly (readonly [string, Migration])[] = [
  ["windows_keyring_to_files", migrateWindowsKeyringToFiles],
  ["macos_keyring_to_security", migrateMacosKeyringToSecurity],
];

/**
 * Run the migrations that are not applied yet. Never throws: a failed
 * migration is logged and stays unrecorded, so the next run tries it again.
 * Does nothing if the backup directory does not exist, so a fresh install
 * keeps no directory.
 */
export function runMigrations(switcher: ClaudeAccountSwitcher): void {
  if (!fs.existsSync(switcher.backupDir)) return;

  const applied = loadApplied(switcher);
  for (const [migrationId, fn] of MIGRATIONS) {
    if (Object.hasOwn(applied, migrationId)) continue;
    let completed: boolean;
    try {
      completed = fn(switcher);
    } catch (e) {
      switcher.logger.warning(`Migration ${migrationId} did not complete (will retry): ${errorText(e)}`);
      continue;
    }
    if (completed) {
      try {
        markApplied(switcher, migrationId);
      } catch (e) {
        switcher.logger.warning(
          `Migration ${migrationId} ran but recording it failed (will re-run next time): ${errorText(e)}`,
        );
      }
    }
  }
}
