/** Seams of the switcher module. Tests replace these properties. */

import { FileLock } from "../locking.js";
import { runMigrations } from "../migrations.js";
import * as oauth from "../oauth.js";
import type { ClaudeAccountSwitcher } from "../switcher.js";
import { getpassSync, inputSync, readStdinLine } from "../support/input.js";

/** The part of `FileLock` that the switcher uses. A test fake implements the same four methods. */
export interface SwitcherLock {
  /** Wait at most `timeout` seconds. Return false on timeout. */
  acquire(timeout?: number): boolean;
  release(): void;
  /** Get the lock, or throw `LockError`. */
  enter(): unknown;
  exit(): void;
}

export type SwitcherLockClass = new (lockPath: string, timeout?: number) => SwitcherLock;

export const internals = {
  FileLock: FileLock as SwitcherLockClass,
  /** Python `input()`. Throws `EOFError` at the end of the input. */
  input: (prompt: string): string => inputSync(prompt),
  getpass: (prompt: string): string => getpassSync(prompt),
  /** `sys.stdin.readline()` without the line end. */
  readStdinLine: (): string => readStdinLine(),
  tryFetchUsageForAccount: (
    accountNum: string,
    email: string,
    credentials: string,
    isActive: boolean,
    persistCredentials: oauth.PersistCredentials | null = null,
    refreshVia: oauth.RefreshVia | null = null,
  ): Promise<oauth.UsageOutcome> =>
    oauth.tryFetchUsageForAccount(accountNum, email, credentials, isActive, persistCredentials, refreshVia),
  buildTokenStatus: (credentials: string): string | null => oauth.buildTokenStatus(credentials),
  /**
   * Delay in seconds between the starts of two usage requests in one collect
   * pass. N accounts must not send N requests to the usage endpoint at the same instant (issue #85).
   */
  FETCH_STAGGER_S: 0.25,
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  /** Run the one-time data migrations. The constructor calls it synchronously. */
  runMigrations: (switcher: ClaudeAccountSwitcher): void => {
    runMigrations(switcher);
  },
};
