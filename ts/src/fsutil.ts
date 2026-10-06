/** Filesystem primitives with no claude-swap dependencies. */

import fs from "node:fs";
import { sleepSync } from "./support/sleep.js";

/**
 * Node error codes for the Windows errors that usually mean "another process
 * has the file open now". libuv maps ERROR_ACCESS_DENIED (5) to `EPERM` or
 * `EACCES`, and ERROR_SHARING_VIOLATION (32) and ERROR_LOCK_VIOLATION (33) to `EBUSY`.
 */
export const TRANSIENT_WIN_ERRORS: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface RetryOptions {
  attempts?: number;
  /** Delay in seconds before the second attempt. The delay doubles up to 0.25 s. */
  initialDelay?: number;
}

/** Seams that the tests replace. */
export const internals = {
  platform: process.platform as string,
  renameSync: (src: string, dst: string): void => fs.renameSync(src, dst),
  readFileSync: (path: string): string => fs.readFileSync(path, "utf8"),
};

/**
 * Read a UTF-8 text file. On Windows, retry past transient sharing failures,
 * because antivirus and the indexer open a file just after a rename onto it.
 * On POSIX, raise the first error. Line endings become `\n`, as in Python text mode.
 */
export function readTextWithRetry(path: string, options: RetryOptions = {}): string {
  return withRetry(options, () => internals.readFileSync(path).replace(/\r\n?/g, "\n"));
}

/**
 * `os.replace`. On Windows, retry past transient sharing failures. Other
 * errors (missing source, cross-device link) raise on the first attempt.
 */
export function replaceWithRetry(src: string, dst: string, options: RetryOptions = {}): void {
  withRetry(options, () => internals.renameSync(src, dst));
}

function withRetry<T>({ attempts = 10, initialDelay = 0.002 }: RetryOptions, op: () => T): T {
  if (attempts < 1) throw new RangeError("attempts must be >= 1");
  let delay = initialDelay;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return op();
    } catch (e) {
      if (!isTransient(e) || attempt === attempts - 1) throw e;
      sleepSync(delay * 1000);
      delay = Math.min(delay * 2, 0.25);
    }
  }
}

function isTransient(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return internals.platform === "win32" && code !== undefined && TRANSIENT_WIN_ERRORS.has(code);
}
