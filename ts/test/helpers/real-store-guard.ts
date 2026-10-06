import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { type GuardedRoot, holdsRealStore, isUnderRealStore } from "./real-store-roots.js";

/**
 * A test tried to write the real account store. This class does not extend
 * a Node `SystemError`, so code that catches `ENOENT`/`EEXIST` cannot absorb it.
 */
export class RealStoreWriteBlocked extends Error {
  override name = "RealStoreWriteBlocked";
}

type PathArgs = (args: unknown[]) => unknown[];

/** The roots that the installed guard compares against. Read at each call, so a test can swap them. */
let activeRoots: GuardedRoot[] = [];

/**
 * Replace the guarded roots and return the previous list. Only the tests of
 * the guard itself call it, with stand-in roots, and they must put back the result.
 */
export function setGuardedRoots(roots: GuardedRoot[]): GuardedRoot[] {
  const previous = activeRoots;
  activeRoots = roots;
  return previous;
}

export function guardedRoots(): readonly GuardedRoot[] {
  return activeRoots;
}

const first: PathArgs = (a) => [a[0]];
const second: PathArgs = (a) => [a[1]];
const both: PathArgs = (a) => [a[0], a[1]];
const openTarget: PathArgs = (a) => (isWriteFlag(a[1]) ? [a[0]] : []);

const GUARDED: Record<string, PathArgs> = {
  writeFile: first,
  appendFile: first,
  open: openTarget,
  mkdir: first,
  mkdtemp: first,
  rename: both,
  rm: first,
  rmdir: first,
  unlink: first,
  symlink: second,
  link: second,
  truncate: first,
  chown: first,
  lchown: first,
  lchmod: first,
  copyFile: second,
  cp: second,
  chmod: first,
  utimes: first,
  lutimes: first,
  createWriteStream: first,
};

/**
 * Wrap every `fs` function that writes, in callback, sync and promise form.
 * The guard stays for the life of the worker. A timer that outlives its test
 * still sees it.
 */
export function installRealStoreGuard(roots: GuardedRoot[]): void {
  activeRoots = roots;
  const check = (name: string, targets: unknown[], args: unknown[]) => {
    for (const target of targets) {
      const text = toPath(target);
      if (text === undefined) continue;
      const root = isUnderRealStore(text, activeRoots);
      if (root) {
        throw new RealStoreWriteBlocked(
          `${name} refused: ${text} is under the REAL account store (${root.path}). Fix the test isolation, not the guard.`,
        );
      }
    }
    // A recursive delete or a rename of a parent directory also takes the store away.
    const source = removesTree(name, args) ? toPath(args[0]) : undefined;
    const held = source === undefined ? undefined : holdsRealStore(source, activeRoots);
    if (held) {
      throw new RealStoreWriteBlocked(
        `${name} refused: ${source} contains the REAL account store (${held.path}). Fix the test isolation, not the guard.`,
      );
    }
  };

  const wrap = (target: Record<string, unknown>, name: string, select: PathArgs, rejects = false) => {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function guarded(this: unknown, ...args: unknown[]) {
      try {
        check(name, select(args), args);
      } catch (error) {
        if (rejects) return Promise.reject(error);
        throw error;
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  };

  const fsRecord = fs as unknown as Record<string, unknown>;
  const promises = fs.promises as unknown as Record<string, unknown>;
  for (const [name, select] of Object.entries(GUARDED)) {
    wrap(fsRecord, name, select);
    wrap(fsRecord, `${name}Sync`, select);
    wrap(promises, name, select, true);
  }
  syncBuiltinESMExports();
}

function removesTree(name: string, args: unknown[]): boolean {
  const base = name.replace(/Sync$/, "");
  if (base === "rename") return true;
  if (base !== "rm" && base !== "rmdir") return false;
  const options = args[1];
  return typeof options === "object" && options !== null && (options as { recursive?: unknown }).recursive === true;
}

function isWriteFlag(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === "string") return /[wax+]/.test(flags);
  if (typeof flags === "number") {
    const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
  }
  return false;
}

function toPath(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.protocol === "file:" ? decodeURIComponent(value.pathname) : undefined;
  if (Buffer.isBuffer(value)) return value.toString();
  return undefined;
}
