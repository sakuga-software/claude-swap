/**
 * Cooperate with the advisory locks of Claude Code while cswap changes its files.
 *
 * Claude Code uses the npm `proper-lockfile` protocol (checked against the
 * 2.1.218 bundle):
 * - The lock is a directory. The atomic `mkdir` is the mutex.
 * - The OAuth refresh takes two locks in this order: the primary
 *   `<config-home>/.oauth_refresh.lock`, then the legacy `<config-home>.lock`.
 *   Both use `stale: 60000, update: 5000`.
 * - The config lock (`~/.claude.json.lock`) is stale after 10 s and touched every 5 s.
 *
 * A swap under the credential locks cannot fall inside a token refresh of
 * Claude Code, so the refresh cannot write the old account back.
 */

import fs from "node:fs";
import path from "node:path";
import { ClaudeCodeLockTimeout } from "./exceptions.js";
import { getLogger } from "./logging_config.js";
import { getClaudeConfigHome, getGlobalConfigPath } from "./paths.js";
import { sleepSync } from "./support/sleep.js";

/** A credential lock younger than 60 s belongs to a live holder. Never take it. */
export const CREDENTIALS_STALENESS_S = 60.0;
export const CONFIG_STALENESS_S = 10.0;
/** A little faster than the 5 s of Claude Code, for margin. */
export const TOUCH_INTERVAL_S = 3.0;
/** The time limit for each lock. `claudeCredentialsLock` takes two locks, so its worst case is about two times this value. */
export const DEFAULT_TIMEOUT_S = 9.0;

/** Values that the tests change. The functions read them at call time. */
export const internals = {
  TOUCH_INTERVAL_S,
  DEFAULT_TIMEOUT_S,
};

const logger = getLogger("claude-swap");

/** The legacy credential lock (`~/.claude.lock`). Claude Code still takes it for compatibility. */
export function credentialsLockDir(): string {
  const home = getClaudeConfigHome();
  return path.join(path.dirname(home), `${path.basename(home)}.lock`);
}

/** The primary OAuth refresh lock of Claude Code 2.1.218 and later. */
export function oauthRefreshLockDir(): string {
  return path.join(getClaudeConfigHome(), ".oauth_refresh.lock");
}

/** The lock directory of the global config file (`~/.claude.json.lock`). */
export function configLockDir(): string {
  const file = getGlobalConfigPath();
  return path.join(path.dirname(file), `${path.basename(file)}.lock`);
}

export interface LockOptions {
  /** Seconds. The default is `internals.DEFAULT_TIMEOUT_S` at call time. */
  timeout?: number | null;
}

export interface ProperLockfileOptions extends LockOptions {
  /** Seconds. A lock with an older mtime is stale and can be taken over. */
  staleness?: number;
}

/** A held lock, or a group of held locks. `exit()` releases it. A second call does nothing. */
export interface HeldLock {
  exit(): void;
}

/**
 * A lock directory that is compatible with `proper-lockfile`.
 *
 * WARNING: The mtime touch is a timer. It runs only when the event loop runs.
 * During a long synchronous block, nothing touches the lock, and Claude Code
 * can see it as stale after the staleness time.
 */
export class ProperLockfile implements HeldLock {
  readonly lockDir: string;
  readonly timeout: number | null | undefined;
  readonly staleness: number;
  private timer: NodeJS.Timeout | undefined;
  private held = false;

  constructor(lockDir: string, { timeout, staleness = CONFIG_STALENESS_S }: ProperLockfileOptions = {}) {
    this.lockDir = lockDir;
    this.timeout = timeout;
    this.staleness = staleness;
  }

  /** Get the lock, or throw `ClaudeCodeLockTimeout` after the timeout. */
  enter(): this {
    const timeoutS = this.timeout ?? internals.DEFAULT_TIMEOUT_S;
    const lockDir = this.lockDir;
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    const start = performance.now();
    for (;;) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      if ((performance.now() - start) / 1000 > timeoutS) {
        throw new ClaudeCodeLockTimeout(
          `Could not acquire ${path.basename(lockDir)} — Claude Code appears ` +
            "to be refreshing credentials. Retry in a few seconds.",
        );
      }
      let heldMtimeMs: number;
      try {
        heldMtimeMs = fs.statSync(lockDir).mtimeMs;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if ((Date.now() - heldMtimeMs) / 1000 > this.staleness) {
        // If another waiter wins the rmdir/mkdir race, this loop tries again.
        try {
          fs.rmdirSync(lockDir);
        } catch {
          sleepSync(50);
        }
        continue;
      }
      sleepSync(250 + Math.random() * 250);
    }

    this.held = true;
    this.timer = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(lockDir, now, now);
      } catch {
        this.stopTouching();
      }
    }, internals.TOUCH_INTERVAL_S * 1000);
    this.timer.unref();
    return this;
  }

  exit(): void {
    if (!this.held) return;
    this.held = false;
    this.stopTouching();
    try {
      fs.rmdirSync(this.lockDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        logger.warning("Lock %s vanished while held (taken over as stale?)", this.lockDir);
      } else {
        logger.warning("Failed to release lock %s: %s", this.lockDir, (e as Error).message);
      }
    }
  }

  private stopTouching(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Get each lock in order. If one fails, release the locks already held, in
 * reverse order, and throw.
 */
function enterAll(locks: ProperLockfile[]): HeldLock {
  const held: ProperLockfile[] = [];
  try {
    for (const lock of locks) held.push(lock.enter());
  } catch (e) {
    for (const lock of held.reverse()) lock.exit();
    throw e;
  }
  return {
    exit() {
      for (const lock of [...held].reverse()) lock.exit();
    },
  };
}

/**
 * Run `fn` while `lock` is held, then release it. If `fn` returns a promise,
 * the lock stays held until the promise settles.
 */
function runHeld<T>(lock: HeldLock, fn: () => T): T {
  let result: T;
  try {
    result = fn();
  } catch (e) {
    lock.exit();
    throw e;
  }
  if (result instanceof Promise) {
    return result.finally(() => lock.exit()) as T;
  }
  lock.exit();
  return result;
}

/**
 * Hold a `proper-lockfile` lock directory while `fn` runs. The lock is taken
 * over if its mtime is older than `staleness` seconds.
 * Throw `ClaudeCodeLockTimeout` if the lock stays held past `timeout`.
 */
export function properLockfile<T>(lockDir: string, fn: () => T, options: ProperLockfileOptions = {}): T {
  return runHeld(new ProperLockfile(lockDir, options).enter(), fn);
}

/**
 * Get the two credential-refresh locks of Claude Code, in its order: the
 * primary, then the legacy. The same order prevents a deadlock between cswap
 * and Claude Code. Call `exit()` on the result to release them.
 */
export function acquireClaudeCredentialsLock({ timeout }: LockOptions = {}): HeldLock {
  return enterAll([
    new ProperLockfile(oauthRefreshLockDir(), { timeout, staleness: CREDENTIALS_STALENESS_S }),
    new ProperLockfile(credentialsLockDir(), { timeout, staleness: CREDENTIALS_STALENESS_S }),
  ]);
}

/** Hold the credential-refresh locks of Claude Code while `fn` runs. */
export function claudeCredentialsLock<T>(fn: () => T, options: LockOptions = {}): T {
  return runHeld(acquireClaudeCredentialsLock(options), fn);
}

/** Get the global config write lock (`~/.claude.json.lock`). Call `exit()` on the result to release it. */
export function acquireClaudeConfigLock({ timeout }: LockOptions = {}): HeldLock {
  return new ProperLockfile(configLockDir(), { timeout }).enter();
}

/** Hold the global config write lock of Claude Code while `fn` runs. */
export function claudeConfigLock<T>(fn: () => T, options: LockOptions = {}): T {
  return runHeld(acquireClaudeConfigLock(options), fn);
}
