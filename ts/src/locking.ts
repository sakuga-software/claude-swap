/** File locking for concurrent access protection. */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LockError } from "./exceptions.js";
import { sleepSync } from "./support/sleep.js";

const OWNER_FILE = "owner";

/** Seams and bounds that the tests change. */
export const internals = {
  pollMs: 100,
  /** A held lock older than this is stale, also if its holder pid is alive. This bound covers pid reuse. */
  staleAfterMs: 10 * 60 * 1000,
  /** A lock directory with no owner file is stale after this time. The holder died between mkdir and the owner write. */
  unownedGraceMs: 5 * 1000,
  isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
};

interface Owner {
  pid: number;
  token: string;
}

/**
 * Cross-process exclusive lock.
 *
 * WARNING: This lock is not compatible with the Python version. Node has no
 * `flock`, so the lock is the directory `<lockPath>.d`, which `mkdir` creates
 * atomically. The Python and TypeScript cswap must not run at the same time
 * against one store. The lock does not create `<lockPath>`.
 *
 * Because no kernel lock stops at process exit, a waiter removes the
 * directory if the owner pid is dead, or if the directory is older than
 * `internals.staleAfterMs`.
 */
export class FileLock {
  lockPath: string;
  timeout: number;
  /** True while this instance holds the lock. */
  locked = false;
  private token: string | undefined;

  /** `timeout` is in seconds. */
  constructor(lockPath: string, timeout = 10.0) {
    this.lockPath = lockPath;
    this.timeout = timeout;
  }

  get lockDir(): string {
    return `${this.lockPath}.d`;
  }

  /** Get the exclusive lock. Wait at most `timeout` seconds. Return false on timeout. */
  acquire(timeout?: number): boolean {
    const limitMs = (timeout ?? this.timeout) * 1000;
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const start = performance.now();
    for (;;) {
      if (this.tryCreate() || (breakIfStale(this.lockDir) && this.tryCreate())) {
        this.locked = true;
        return true;
      }
      if (performance.now() - start > limitMs) return false;
      sleepSync(internals.pollMs);
    }
  }

  /** Release the lock. A second call does nothing. */
  release(): void {
    if (!this.locked) return;
    try {
      if (readOwner(this.lockDir)?.token === this.token) {
        fs.rmSync(this.lockDir, { recursive: true, force: true });
      }
    } finally {
      this.locked = false;
      this.token = undefined;
    }
  }

  /** The `__enter__` of the Python context manager. */
  enter(): this {
    if (!this.acquire()) {
      throw new LockError("Failed to acquire lock - another instance may be running");
    }
    return this;
  }

  /** The `__exit__` of the Python context manager. */
  exit(): void {
    this.release();
  }

  /**
   * Run `fn` while this instance holds the lock, then release it. If `fn`
   * returns a promise, the lock stays held until the promise settles.
   * Throw `LockError` if the lock is not available before the timeout.
   */
  withLock<T>(fn: (lock: this) => T): T {
    this.enter();
    let result: T;
    try {
      result = fn(this);
    } catch (e) {
      this.exit();
      throw e;
    }
    if (result instanceof Promise) {
      return result.finally(() => this.exit()) as T;
    }
    this.exit();
    return result;
  }

  private tryCreate(): boolean {
    try {
      fs.mkdirSync(this.lockDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    const token = randomUUID();
    try {
      const tmp = path.join(this.lockDir, `${OWNER_FILE}.tmp`);
      fs.writeFileSync(tmp, `${process.pid}\n${token}\n`);
      fs.renameSync(tmp, path.join(this.lockDir, OWNER_FILE));
    } catch (e) {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
      throw e;
    }
    this.token = token;
    return true;
  }
}

function readOwner(lockDir: string): Owner | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(lockDir, OWNER_FILE), "utf8");
  } catch {
    return undefined;
  }
  const [pidText = "", token = ""] = text.split("\n");
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || !token) return undefined;
  return { pid, token };
}

function ageMs(dir: string): number | undefined {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs;
  } catch {
    return undefined;
  }
}

function isStale(lockDir: string): boolean {
  const age = ageMs(lockDir);
  if (age === undefined) return false;
  const owner = readOwner(lockDir);
  if (!owner) return age > internals.unownedGraceMs;
  return !internals.isPidAlive(owner.pid) || age > internals.staleAfterMs;
}

/**
 * Remove a stale lock directory and return true. Only the holder of the
 * `<lockDir>.break` directory removes a lock, so two waiters cannot both
 * see one stale lock and then remove the new lock of a third process.
 */
function breakIfStale(lockDir: string): boolean {
  if (!isStale(lockDir)) return false;
  const breaker = `${lockDir}.break`;
  try {
    fs.mkdirSync(breaker);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const age = ageMs(breaker);
    if (age !== undefined && age > internals.unownedGraceMs) fs.rmSync(breaker, { recursive: true, force: true });
    return false;
  }
  try {
    if (!isStale(lockDir)) return false;
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    fs.rmSync(breaker, { recursive: true, force: true });
  }
}
