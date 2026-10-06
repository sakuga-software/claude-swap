import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockError } from "../src/exceptions.js";
import { FileLock, internals } from "../src/locking.js";
import { testHome } from "./helpers/home.js";

const TS_ROOT = path.resolve(import.meta.dirname, "..");
const HOLD_LOCK = path.join(import.meta.dirname, "helpers", "hold-lock.ts");

const original = { ...internals };
const children: ChildProcess[] = [];
let tmpPath: string;

beforeEach(() => {
  tmpPath = testHome();
});

afterEach(() => {
  Object.assign(internals, original);
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

interface Holder {
  child: ChildProcess;
  ready: Promise<boolean>;
  done: Promise<void>;
}

function holdLockProcess(lockPath: string, duration: number): Holder {
  const child = spawn(process.execPath, ["--import", "tsx", HOLD_LOCK, lockPath, String(duration)], {
    cwd: TS_ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const ready = new Promise<boolean>((resolve) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) resolve(true);
    });
    void done.then(() => resolve(false));
  });
  return { child, ready, done };
}

describe("TestFileLock", () => {
  it("test_acquire_and_release", () => {
    const lock = new FileLock(path.join(tmpPath, ".lock"));

    expect(lock.acquire(1.0)).toBe(true);
    expect(lock.locked).toBe(true);
    lock.release();
    expect(lock.locked).toBe(false);
  });

  it("test_context_manager", () => {
    const lock = new FileLock(path.join(tmpPath, ".lock"));

    lock.withLock((held) => {
      expect(held.locked).toBe(true);
    });

    expect(lock.locked).toBe(false);
  });

  it("test_context_manager_creates_parent_dirs", () => {
    const lockPath = path.join(tmpPath, "nested", "dir", ".lock");

    new FileLock(lockPath).withLock(() => {
      expect(fs.existsSync(path.dirname(lockPath))).toBe(true);
    });
  });

  it("test_lock_timeout", () => {
    const lockPath = path.join(tmpPath, ".lock");

    const lock1 = new FileLock(lockPath);
    expect(lock1.acquire(1.0)).toBe(true);

    const lock2 = new FileLock(lockPath);
    expect(lock2.acquire(0.5)).toBe(false);

    lock1.release();
  });

  it("test_lock_acquired_after_release", () => {
    const lockPath = path.join(tmpPath, ".lock");

    const lock1 = new FileLock(lockPath);
    lock1.acquire(1.0);
    lock1.release();

    const lock2 = new FileLock(lockPath);
    expect(lock2.acquire(1.0)).toBe(true);
    lock2.release();
  });

  it("test_context_manager_raises_on_timeout", () => {
    const lockPath = path.join(tmpPath, ".lock");

    const holder = new FileLock(lockPath);
    holder.acquire(1.0);

    expect(() => {
      const lock = new FileLock(lockPath);
      lock.acquire = () => false;
      lock.withLock(() => undefined);
    }).toThrow(LockError);

    holder.release();
  });

  it("test_double_release_safe", () => {
    const lock = new FileLock(path.join(tmpPath, ".lock"));

    lock.acquire(1.0);
    lock.release();
    lock.release();
  });
});

describe("TestFileLockConcurrency", () => {
  it("test_concurrent_access_blocked", async () => {
    const lockPath = path.join(tmpPath, ".lock");
    const holder = holdLockProcess(lockPath, 2.0);

    expect(await holder.ready).toBe(true);

    const lock = new FileLock(lockPath);
    expect(lock.acquire(0.5)).toBe(false);

    await holder.done;
  }, 20_000);

  it("test_lock_acquired_after_process_exits", async () => {
    const lockPath = path.join(tmpPath, ".lock");
    const holder = holdLockProcess(lockPath, 0.5);

    await holder.done;

    const lock = new FileLock(lockPath);
    expect(lock.acquire(1.0)).toBe(true);
    lock.release();
  }, 20_000);
});

describe("FileLock stale locks (TypeScript only)", () => {
  it("reclaims the lock of a killed holder", async () => {
    const lockPath = path.join(tmpPath, ".lock");
    const holder = holdLockProcess(lockPath, 30);
    expect(await holder.ready).toBe(true);

    holder.child.kill("SIGKILL");
    await holder.done;

    const lock = new FileLock(lockPath);
    expect(lock.acquire(1.0)).toBe(true);
    lock.release();
  }, 20_000);

  it("reclaims a lock directory with no owner after the grace time", () => {
    const lockPath = path.join(tmpPath, ".lock");
    fs.mkdirSync(`${lockPath}.d`);
    const lock = new FileLock(lockPath);

    expect(lock.acquire(0.3)).toBe(false);

    const old = new Date(Date.now() - internals.unownedGraceMs - 1000);
    fs.utimesSync(`${lockPath}.d`, old, old);
    expect(lock.acquire(0.3)).toBe(true);
    lock.release();
  });

  it("reclaims a lock of a live pid after the stale bound", () => {
    const lockPath = path.join(tmpPath, ".lock");
    const holder = new FileLock(lockPath);
    expect(holder.acquire(1.0)).toBe(true);
    internals.staleAfterMs = 0;
    const old = new Date(Date.now() - 1000);
    fs.utimesSync(`${lockPath}.d`, old, old);

    const lock = new FileLock(lockPath);
    expect(lock.acquire(0.3)).toBe(true);

    holder.release();
    expect(fs.existsSync(`${lockPath}.d`)).toBe(true);
    lock.release();
    expect(fs.existsSync(`${lockPath}.d`)).toBe(false);
  });

  it("does not create the Python flock file", () => {
    const lockPath = path.join(tmpPath, ".lock");
    new FileLock(lockPath).withLock(() => {
      expect(fs.existsSync(`${lockPath}.d`)).toBe(true);
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases the lock after the promise of an async body settles", async () => {
    const lockPath = path.join(tmpPath, ".lock");
    const lock = new FileLock(lockPath);
    let resolveBody!: () => void;
    const pending = lock.withLock(() => new Promise<void>((resolve) => (resolveBody = resolve)));

    expect(lock.locked).toBe(true);
    resolveBody();
    await pending;
    expect(lock.locked).toBe(false);
  });
});
