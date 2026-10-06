/** Core account switcher logic for Claude Code. */

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as claudeLocks from "./claude_locks.js";
import {
  CLAUDE_CODE_KEYCHAIN_SERVICE,
  SECURITY_SERVICE,
  type ActiveCredentials,
  CredentialStore,
  looksLikeApiKey,
  mergeSharedCredentialFields,
  sharedCredentialFields,
} from "./credentials.js";
import {
  AccountNotFoundError,
  ConfigError,
  CredentialReadError,
  LockError,
  SessionError,
  SwitchError,
  ValidationError,
} from "./exceptions.js";
import { readTextWithRetry } from "./fsutil.js";
import {
  SCHEMA_VERSION,
  USAGE_API_KEY,
  USAGE_FOREIGN_CREDENTIAL,
  USAGE_KEYCHAIN_UNAVAILABLE,
  USAGE_NO_CREDENTIALS,
  USAGE_RELOGIN_REQUIRED,
  USAGE_TOKEN_EXPIRED,
  accountRef,
  accountRow,
  lastGoodUsageFields,
  usageFailureFields,
  usageFields,
  usageFreshnessFields,
} from "./json_output.js";
import { type Logger, setupLogging } from "./logging_config.js";
import * as macosKeychain from "./macos_keychain.js";
import { MappingStore } from "./mappings.js";
import {
  type AccountSnapshot,
  type AccountsSnapshot,
  Platform,
  type RollbackTarget,
  SwitchTransaction,
  accountSnapshot,
  getTimestamp,
  normalizeAlias,
} from "./models.js";
import * as oauth from "./oauth.js";
import {
  getBackupRoot,
  getCredentialsPath,
  getDefaultClaudeConfigHome,
  getGlobalConfigPath,
  getLegacyBackupRoot,
  migrateLegacyBackupDir,
} from "./paths.js";
import * as pollPolicy from "./poll_policy.js";
import {
  abbreviatePath,
  accent,
  boldAccent,
  bolded,
  dimmed,
  entrypointLabel,
  ideShortName,
  muted,
  warning,
} from "./printer.js";
import { getRunningInstances } from "./process_detection.js";
import * as session from "./session.js";
import { loadSettings, parseModelNames, settingsPath } from "./settings.js";
import { EOFError } from "./support/input.js";
import { errorText, isFileNotFound, isOsError, isPermissionError } from "./support/oserror.js";
import { mapPool } from "./support/pool.js";
import { jsonDumps } from "./support/py.js";
import { resolvePath } from "./support/pathlib.js";
import { pyStrRepr, pyTypeName } from "./support/pyformat.js";
import { type FetchRecord, type Identity, type PollPlan, UsageEntry, UsageStore, withSentinel } from "./usage_store.js";
import { labelTokenStatus, sameDirectory, usageEntryLines } from "./switcher/display.js";
import { internals } from "./switcher/internals.js";

export { CLAUDE_CODE_KEYCHAIN_SERVICE, SECURITY_SERVICE } from "./credentials.js";
export {
  ERROR_NOTES,
  SENTINEL_NOTES,
  USAGE_AGE_NOTE_S,
  formatUsageLines,
  labelTokenStatus,
  lastSeenNote,
  paceMarker,
  sameDirectory,
  usageEntryLines,
} from "./switcher/display.js";
export {
  type SwitcherLock,
  type SwitcherLockClass,
  internals,
} from "./switcher/internals.js";

/**
 * The service name of the legacy `keyring` backend for per-account backups.
 * The keyring cleanup in `purge()` uses it.
 */
export const KEYRING_SERVICE = "claude-code";

/**
 * Setup-tokens are inference-only on the server. Wider scopes cause 403s on
 * the profile endpoints. Claude Code's `CLAUDE_CODE_OAUTH_TOKEN` path uses the same scopes.
 */
export const SETUP_TOKEN_SCOPES: readonly string[] = Object.freeze(["user:inference"]);

/**
 * Stash reasons that mean the slot did NOT get the new credential, so a
 * null `error` would be false. A removed slot and a CAS conflict are not in
 * the list: the first has nothing to activate, and the second holds the
 * newer lineage of a racing writer.
 */
export const DEMOTING_STASH_REASONS: readonly string[] = Object.freeze([
  "consume-gate-persist-failed",
  "consume-gate-persist-lock-failed",
  "consume-gate-unpersisted",
  "consume-gate-store-unreadable",
]);

/** One account record in `sequence.json`. */
export interface AccountRecord {
  email?: string;
  uuid?: string;
  organizationUuid?: string | null;
  organizationName?: string | null;
  added?: string;
  alias?: string;
  disabled?: boolean;
  kind?: string;
  [key: string]: unknown;
}

/** The content of `sequence.json`. */
export interface SequenceData {
  activeAccountNumber?: number | null;
  lastUpdated?: string;
  sequence?: number[];
  accounts?: Record<string, AccountRecord>;
  [key: string]: unknown;
}

/** `(num, email, orgName, orgUuid, isActive, creds, alias)` for one managed account. */
export type AccountInfoRow = [
  num: number,
  email: string,
  orgName: string,
  orgUuid: string,
  isActive: boolean,
  creds: string,
  alias: string,
];

/** The owner of the live credential, resolved before the switch takes its locks. */
export interface Provenance {
  live: string | null;
  resolved: oauth.AccountIdentity | null;
}

export type AccountRef = ReturnType<typeof accountRef>;

/** What `performSwitch` returns: the account left, the account activated, and the warnings. */
export interface SwitchOp {
  from: AccountRef | null;
  to: AccountRef;
  warnings: string[];
}

/** The `--switch --json` payload. */
export interface SwitchResult {
  schemaVersion: number;
  switched: boolean;
  from: AccountRef | null;
  to: AccountRef | null;
  strategy: string;
  reason: string;
  message: string;
  warnings: string[];
}

export type JsonObject = Record<string, unknown>;

/** `[threshold, models]` for poll planning. */
export type PollInputs = readonly [threshold: number, models: readonly string[]];

export type OutgoingKind =
  | "own-bytes"
  | "own-family"
  | "own-rotated"
  | "foreign"
  | "foreign-synced"
  | "wiped"
  | "alien"
  | "known-foreign"
  | "unresolved";

type Held = { exit(): void };

/**
 * Paths of the `FileLock`s that this process holds now. An async task that
 * waits for a lock that another task of this process holds must wait with
 * the event loop free. A synchronous wait blocks the holder until the timeout.
 */
const heldInProcess = new Map<string, number>();

function markHeld(lockPath: string, delta: 1 | -1): void {
  const count = (heldInProcess.get(lockPath) ?? 0) + delta;
  if (count > 0) heldInProcess.set(lockPath, count);
  else heldInProcess.delete(lockPath);
}

/**
 * Run `acquire` when no task of this process holds one of `paths`, or after
 * `timeoutS`. The wait leaves the event loop free. The last check and
 * `acquire` run in one synchronous step, so no other task can take the lock between them.
 */
async function whenIdle<T>(paths: readonly string[], acquire: () => T, timeoutS = 10): Promise<T> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    if (!paths.some((p) => heldInProcess.has(p)) || Date.now() >= deadline) return acquire();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Wait until no task of this process holds a `FileLock`, with the event loop free.
 * Call it before a synchronous mutator that can run beside an async task, as the TUI does.
 */
export async function whenNoLockHeldInProcess(timeoutS = 30): Promise<void> {
  const deadline = Date.now() + timeoutS * 1000;
  while (heldInProcess.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Python `with FileLock(path):`. Throws `LockError` if the lock is not available. */
function enterFileLock(lockPath: string): Held {
  // A synchronous wait for a lock that an async task of this process holds
  // blocks the event loop, so the holder can never release it. Fail at once.
  if (heldInProcess.has(lockPath)) {
    throw new LockError("Failed to acquire lock - another operation of this process holds it");
  }
  const lock = new internals.FileLock(lockPath);
  lock.enter();
  markHeld(lockPath, 1);
  return {
    exit() {
      markHeld(lockPath, -1);
      lock.exit();
    },
  };
}

/** Enter each lock in order. If one fails, exit the locks already held in reverse order, then throw. */
function enterAll(openers: ReadonlyArray<() => Held>): Held {
  const held: Held[] = [];
  try {
    for (const open of openers) held.push(open());
  } catch (e) {
    for (const h of held.reverse()) h.exit();
    throw e;
  }
  return {
    exit() {
      for (const h of [...held].reverse()) h.exit();
    },
  };
}

/** Python `with A, B, ...:` around a synchronous body. */
function holdSync<T>(openers: ReadonlyArray<() => Held>, body: () => T): T {
  const held = enterAll(openers);
  try {
    return body();
  } finally {
    held.exit();
  }
}

/**
 * Python `with A, B, ...:` around an async body. First wait for the file
 * locks that another task of this process holds.
 */
async function holdAsync<T>(
  filePaths: readonly string[],
  openers: ReadonlyArray<() => Held>,
  body: () => T | Promise<T>,
): Promise<T> {
  const held = await whenIdle(filePaths, () => enterAll(openers));
  try {
    return await body();
  } finally {
    held.exit();
  }
}

function print(...parts: string[]): void {
  process.stdout.write(`${parts.join(" ")}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness of a dict-like value. */
function truthyDict(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function isDigits(text: string): boolean {
  return /^[0-9]+$/.test(text);
}

/** Python `int(value)` for a slot number. Throws `RangeError` like Python's `ValueError`. */
function pyInt(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number.parseInt(value.trim(), 10);
  throw new RangeError(`invalid literal for int() with base 10: ${pyStrRepr(String(value))}`);
}

/** Python `dict.get(key, default)`: the default only when the key is absent. */
function pyGet<T>(obj: Record<string, unknown> | null | undefined, key: string, dflt: T): unknown {
  if (!obj || !Object.hasOwn(obj, key)) return dflt;
  return obj[key];
}

/** `str(value)` of an optional text field read with `.get(key, "") or ""`. */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : value ? String(value) : "";
}

function accountsOf(data: SequenceData | null | undefined): Record<string, AccountRecord> {
  const accounts = data?.accounts;
  return isRecord(accounts) ? (accounts as Record<string, AccountRecord>) : {};
}

function sequenceOf(data: SequenceData | null | undefined): number[] {
  const seq = data?.sequence;
  return Array.isArray(seq) ? seq : [];
}

function recordOf(data: SequenceData | null | undefined, num: string): AccountRecord | undefined {
  const accounts = accountsOf(data);
  return Object.hasOwn(accounts, num) ? accounts[num] : undefined;
}

function numericSort(values: number[]): number[] {
  return values.sort((a, b) => a - b);
}

/** Python `float(value)` for a stored `expiresAt`. Null where Python raises. */
function pyFloat(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** `Path.with_suffix(suffix)`: replace the last suffix of the file name, or add one. */
function withSuffix(filePath: string, suffix: string): string {
  const name = path.basename(filePath);
  const i = name.lastIndexOf(".");
  const stem = i > 0 && i < name.length - 1 ? name.slice(0, i) : name;
  return path.join(path.dirname(filePath), stem + suffix);
}

function warnKey(slot: string, email: string, reason: string): string {
  return JSON.stringify([slot, email, reason]);
}

const CLEAN_VERDICT: ActiveCredentials = Object.freeze({ value: "", keychainUnavailable: false, degraded: false });

/** Multi-account switcher for Claude Code. */
export class ClaudeAccountSwitcher implements RollbackTarget {
  home: string;
  platform: Platform;
  backupDir: string;
  sequenceFile: string;
  configsDir: string;
  credentialsDir: string;
  lockFile: string;
  logger: Logger;
  usageStore: UsageStore;
  /** `[settings mtime, inputs]`. See `pollPolicyInputs`. */
  pollInputsCache: [number | null, PollInputs] | null = null;
  pollInputsOverride: PollInputs | null = null;
  /** The credential storage layer. It reads `platform`, `logger` and `credentialsDir` from this switcher. */
  store: CredentialStore;
  /**
   * The verdict of the active read, per async call chain. Two TUI lanes run on
   * one switcher, and the reset of one lane must not erase the verdict of the other.
   */
  activeVerdictStore = new AsyncLocalStorage<ActiveCredentials | null>();
  /**
   * `(slot, email, reason)` keys of provenance conditions already logged.
   * Each condition stays across collect passes and would log on every tick.
   */
  provenanceWarned = new Set<string>();
  /**
   * Definitive ownership verdicts for credential lineages, keyed by `lineageKey`.
   * True: the profile oracle (or our own refresh POST) attributed the lineage to the
   * slot. False: it resolved to another identity. Probe failures are never cached.
   */
  probeVerdicts = new Map<string, boolean>();

  constructor(debug = false) {
    this.home = os.homedir();
    this.platform = Platform.detect();
    this.backupDir = getBackupRoot();

    // Move the legacy backup dir before the logger or the directory setup writes to the new location.
    if (migrateLegacyBackupDir(this.backupDir)) {
      const legacy = getLegacyBackupRoot();
      process.stderr.write(`claude-swap: migrated data from ${legacy} to ${this.backupDir}\n`);
    }

    this.sequenceFile = path.join(this.backupDir, "sequence.json");
    this.configsDir = path.join(this.backupDir, "configs");
    this.credentialsDir = path.join(this.backupDir, "credentials");
    this.lockFile = path.join(this.backupDir, ".lock");
    this.logger = setupLogging(this.backupDir, debug);
    this.usageStore = new UsageStore(path.join(this.backupDir, "cache"));
    // The store must exist before the migrations run: they do storage operations on macOS.
    this.store = new CredentialStore(this);
    internals.runMigrations(this);
  }

  isRunningInContainer(): boolean {
    if (process.env.CONTAINER || process.env.container) return true;
    if (this.platform === Platform.WINDOWS) return false;
    if (fs.existsSync("/.dockerenv")) return true;

    const probe = (file: string, needles: readonly string[]): boolean => {
      if (!fs.existsSync(file)) return false;
      try {
        const content = fs.readFileSync(file, "utf8");
        return needles.some((x) => content.includes(x));
      } catch (e) {
        if (isPermissionError(e)) return false;
        throw e;
      }
    };
    if (probe("/proc/1/cgroup", ["docker", "lxc", "containerd", "kubepods"])) return true;
    if (probe("/proc/self/mountinfo", ["docker", "overlay"])) return true;
    return false;
  }

  /** The Claude configuration file path, as claude-code finds it. */
  getClaudeConfigPath(): string {
    return getGlobalConfigPath();
  }

  validateEmail(email: string): boolean {
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\n?$/.test(email);
  }

  /** Create the backup directories with mode 0700. */
  setupDirectories(): void {
    for (const directory of [this.backupDir, this.configsDir, this.credentialsDir]) {
      fs.mkdirSync(directory, { recursive: true });
      if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
    }
  }

  /**
   * Read and parse a JSON object file. Null if the file is ABSENT.
   *
   * With `strict`, throw `ConfigError` if the file is THERE but not readable:
   * an absent file is a real empty start, but an unreadable one must not be
   * overwritten unread. A JSON value that is not an object also counts as unreadable.
   */
  readJson(filePath: string, { strict = false }: { strict?: boolean } = {}): JsonObject | null {
    if (!fs.existsSync(filePath)) return null;
    let data: unknown;
    try {
      data = JSON.parse(readTextWithRetry(filePath));
    } catch (e) {
      if (e instanceof SyntaxError) {
        this.logger.warning(`Invalid JSON in ${filePath}`);
        if (strict) {
          throw new ConfigError(
            `${filePath} exists but could not be parsed (${e.message}). Repair or ` +
              "move it, then retry — refusing to overwrite it unread.",
          );
        }
        return null;
      }
      if (isOsError(e)) {
        this.logger.warning(`Could not read ${filePath}: ${e.message}`);
        if (strict) {
          throw new ConfigError(
            `${filePath} exists but could not be read (${e.message}). Fix what is ` + "blocking the read, then retry.",
          );
        }
        return null;
      }
      throw e;
    }
    if (!isRecord(data)) {
      const typeName = pyTypeName(data);
      this.logger.warning(`${filePath} holds ${typeName}, not a JSON object`);
      if (strict) {
        throw new ConfigError(`${filePath} holds ${typeName}, not a JSON object. Repair or move it, then retry.`);
      }
      return null;
    }
    return data;
  }

  /**
   * Copy an unparseable file aside before it is replaced, and tell the user.
   * Return the path of the copy.
   *
   * The copy gets mode 0600 (the original can hold a secret with a wider
   * mode), a counter suffix so that no earlier copy is overwritten, and a
   * name with no `:` (Windows refuses it).
   */
  salvageUnreadable(filePath: string, emitOutput: boolean, warningsOut: string[]): string {
    const dir = path.dirname(filePath);
    const stem = `${path.basename(filePath)}.unreadable-${Math.trunc(Date.now() / 1000)}`;
    let salvage = path.join(dir, stem);
    let n = 1;
    while (fs.existsSync(salvage)) {
      salvage = path.join(dir, `${stem}.${n}`);
      n += 1;
    }
    try {
      fs.writeFileSync(salvage, fs.readFileSync(filePath));
      if (process.platform !== "win32") fs.chmodSync(salvage, 0o600);
    } catch (e) {
      if (!isOsError(e)) throw e;
      throw new SwitchError(
        `${filePath} could not be parsed and the salvage copy failed (${e.message}); aborting rather than destroying it`,
      );
    }
    const msg = `${path.basename(filePath)} could not be parsed — a copy was kept at ${path.basename(salvage)}`;
    this.logger.warning(`${filePath} could not be parsed; a copy was kept at ${salvage} before it was replaced`);
    warningsOut.push(msg);
    if (emitOutput) warning(msg);
    return salvage;
  }

  /** Write a JSON file atomically with mode 0600, after a parse check of the written text. */
  writeJson(filePath: string, data: unknown): void {
    const content = jsonDumps(data, 2);
    const tempPath = withSuffix(filePath, `.${process.pid}.tmp`);
    fs.writeFileSync(tempPath, content, "utf8");
    try {
      JSON.parse(fs.readFileSync(tempPath, "utf8"));
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      fs.unlinkSync(tempPath);
      throw new ConfigError("Generated invalid JSON");
    }
    // The mode goes on the temp file, so the rename is the last step and nothing can fail after it.
    if (process.platform !== "win32") fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, filePath);
  }

  // The credential stores live in `CredentialStore`. These members delegate to it.

  get keychainUsableCache(): boolean | null {
    return this.store.keychainUsableCache;
  }

  set keychainUsableCache(value: boolean | null) {
    this.store.keychainUsableCache = value;
  }

  get keychainDisabledUntil(): number {
    return this.store.keychainDisabledUntil;
  }

  set keychainDisabledUntil(value: number) {
    this.store.keychainDisabledUntil = value;
  }

  get lastActiveCredentialsBackend(): "keychain" | "file" | null {
    return this.store.lastActiveCredentialsBackend;
  }

  set lastActiveCredentialsBackend(value: "keychain" | "file" | null) {
    this.store.lastActiveCredentialsBackend = value;
  }

  kcCall<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): R {
    return this.store.kcCall(fn, ...args);
  }

  useKeychain(): boolean {
    return this.store.useKeychain();
  }

  readCredentials(): string | null {
    return this.store.readCredentials();
  }

  readActiveCredentials(): ActiveCredentials {
    return this.store.readActiveCredentials();
  }

  /**
   * Refuse to CAPTURE the bytes of a degraded read, and return the value of
   * this one read. A locked Keychain leaves only the plaintext fallback, which
   * can be a superseded generation. A second read could fail differently, so
   * the caller captures these exact bytes.
   */
  refuseDegradedCapture(): string | null {
    const active = this.readActiveCredentials();
    if (active.degraded) {
      throw new CredentialReadError(
        "The macOS Keychain is unreadable right now (locked or no GUI " +
          "session), so the only readable credential is a plaintext " +
          "fallback that may be a superseded generation — capturing it " +
          "would file a spent refresh token against this slot. Retry " +
          "from a GUI terminal.",
      );
    }
    return active.value;
  }

  /**
   * Read the credential of the profile that the environment points at, as
   * claude resolves it, so the email and the token of a new slot come from one profile.
   *
   * Claude reads secure storage from `CLAUDE_SECURESTORAGE_CONFIG_DIR` when it
   * is defined (defined but empty means the default store), else from
   * `CLAUDE_CONFIG_DIR`. An unreadable keychain entry throws
   * `CredentialReadError`: the plaintext seed of the profile can be stale.
   * Read-only: cswap never writes the hashed keychain entry of claude.
   */
  readCaptureCredentials(): string | null {
    const secureEnv = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    const configDir = process.env.CLAUDE_CONFIG_DIR;

    if (secureEnv !== undefined) {
      // The override names the only store that claude reads. A miss means logged
      // out: a fallback to the active store could capture another profile.
      const creds = session.readConfigDirCredentials(secureEnv || getDefaultClaudeConfigHome(), {
        strictKeychain: true,
        keychainService: !secureEnv ? CLAUDE_CODE_KEYCHAIN_SERVICE : null,
      });
      if (creds) return creds;
      return "";
    } else if (!configDir) {
      return this.refuseDegradedCapture();
    } else {
      const creds = session.readConfigDirCredentials(configDir, { strictKeychain: true });
      if (creds) return creds;
      if (sameDirectory(configDir, getDefaultClaudeConfigHome())) {
        // Here the file backend of the active store and the default profile are the same.
        return this.refuseDegradedCapture();
      }
    }
    // Only the own `primaryApiKey` of this profile, never the unsuffixed keychain item of the default profile.
    const key = (this.readJson(getGlobalConfigPath()) ?? {}).primaryApiKey;
    return typeof key === "string" ? key : "";
  }

  writeCredentials(credentials: string): void {
    this.store.writeCredentials(credentials);
  }

  /**
   * Compose the credential to activate. The machine-shared OAuth integrations
   * (`SHARED_CREDENTIAL_KEYS`) come from the live credential, which holds the
   * current generation. Every other field comes from the target slot.
   */
  prepareCredentialsForActivation(targetCredentials: string, liveCredentials: string | null): string {
    const liveShared = sharedCredentialFields(liveCredentials);
    if (liveShared === null) return targetCredentials;
    return mergeSharedCredentialFields(targetCredentials, liveShared);
  }

  usesFileBackupBackend(): boolean {
    return this.store.usesFileBackupBackend();
  }

  backupEncPath(accountNum: string, email: string): string {
    return this.store.backupEncPath(accountNum, email);
  }

  writeBackupEnc(accountNum: string, email: string, credentials: string): void {
    this.store.writeBackupEnc(accountNum, email, credentials);
  }

  kcReadBackup(accountNum: string, email: string): string {
    return this.store.kcReadBackup(accountNum, email);
  }

  kcWriteBackup(accountNum: string, email: string, credentials: string): void {
    this.store.kcWriteBackup(accountNum, email, credentials);
  }

  deleteBackupKeychainQuiet(accountNum: string, email: string): void {
    this.store.deleteBackupKeychainQuiet(accountNum, email);
  }

  /**
   * Invalidate the session profile of a slot after its backup credentials change.
   *
   * A profile seeded from the old credentials can hold a rotated-out token
   * that still passes the local reuse check. A quiet profile loses its
   * credential material (its history stays). A live profile keeps its copy
   * and gets the stale marker, so setup re-bootstraps it after it exits.
   */
  postBackupWrite(accountNum: string, email: string): void {
    if (this.liveSessionPids(accountNum, email).length > 0) {
      if (!session.markSessionStale(this.sessionDir(accountNum, email))) {
        this.logger.error(
          "Account %s's backup credentials changed but its live " +
            "session profile could not be marked stale; it may keep " +
            "serving the superseded generation once it exits.",
          accountNum,
        );
      }
    } else {
      this.invalidateSessionCredentials(accountNum, email);
    }
  }

  /** Read the stored backup credential of a slot. Empty string when missing. */
  readAccountCredentials(accountNum: string, email: string): string {
    return this.store.readAccountCredentials(accountNum, email);
  }

  /**
   * Write the backup credential of a slot, then invalidate its session profile.
   *
   * WARNING: The code after the store write must not throw. Every caller reads an
   * error from this method as "the persist failed", but the slot already holds
   * the new credential. If the invalidation fails with an OS error, the stale
   * marker forces the re-bootstrap instead. Only an OS error is contained: the
   * real-store guard of the tests must stay visible.
   *
   * Takes NO lock: the caller holds `lockFile` if it needs it.
   */
  writeAccountCredentials(accountNum: string, email: string, credentials: string): void {
    this.store.writeAccountCredentials(accountNum, email, credentials);
    try {
      this.postBackupWrite(accountNum, email);
    } catch (e) {
      if (!isOsError(e)) throw e;
      if (session.markSessionStale(this.sessionDir(accountNum, email))) {
        this.logger.warning(
          "Stored account %s's credential but could not invalidate " +
            "its session profile; marked it stale so the next run " +
            "re-bootstraps.",
          accountNum,
          { excInfo: e },
        );
      } else {
        this.logger.error(
          "Stored account %s's credential but could NOT invalidate " +
            "its session profile OR mark it stale; the profile may " +
            "keep serving the superseded generation until its token " +
            "expires.",
          accountNum,
          { excInfo: e },
        );
      }
    }
  }

  deleteAccountCredentials(accountNum: string, email: string): void {
    this.store.deleteAccountCredentials(accountNum, email);
  }

  /** Pre-commit clear that throws if the key still reads non-empty. */
  deleteAccountCredentialsStrict(accountNum: string, email: string): void {
    this.store.deleteAccountCredentialsStrict(accountNum, email);
  }

  private configFile(accountNum: string, email: string): string {
    return path.join(this.configsDir, `.claude-config-${accountNum}-${email}.json`);
  }

  /**
   * Delete all the backups of an account (credentials and config) and its session profile.
   * The one path for every operation that removes or displaces a slot.
   * Throws `SessionError` if a session-mode instance uses the account.
   */
  deleteAccountFiles(accountNum: string, email: string): void {
    this.ensureNoLiveSession(accountNum, email, "the operation");
    this.deleteAccountCredentials(accountNum, email);
    const configFile = this.configFile(accountNum, email);
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
    this.deleteSessionProfile(accountNum, email);
  }

  /**
   * Drop the directory mappings of an identity that no longer has a slot.
   * A slot move and `--import --force` keep the `(email, org)` identity, so they need no prune.
   */
  pruneMappings(email: string, orgUuid: string | null | undefined): void {
    const pruned = new MappingStore(this.backupDir).pruneAccount(email, orgUuid || "");
    if (pruned) print(dimmed(`Removed ${pruned} directory mapping(s) for this account`));
  }

  /** Read the config backup of a slot. Empty string when missing. */
  readAccountConfig(accountNum: string, email: string): string {
    const configFile = this.configFile(accountNum, email);
    if (fs.existsSync(configFile)) return readTextWithRetry(configFile);
    return "";
  }

  /**
   * True if a slot has both a stored credential and a config backup, so a
   * switch can activate it without a new add. A sequence entry for a removed record is not switchable.
   */
  accountIsSwitchable(accountNum: string): boolean {
    const data = this.getSequenceData() ?? {};
    const record = recordOf(data, String(accountNum));
    if (!truthyDict(record)) return false;
    const email = textOf(pyGet(record, "email", ""));
    if (!this.readAccountCredentials(String(accountNum), email)) return false;
    if (!this.readAccountConfig(String(accountNum), email)) return false;
    return true;
  }

  writeAccountConfig(accountNum: string, email: string, config: string): void {
    const configFile = this.configFile(accountNum, email);
    fs.writeFileSync(configFile, config, "utf8");
    if (process.platform !== "win32") fs.chmodSync(configFile, 0o600);
  }

  /**
   * Resolve NUM|EMAIL|ALIAS to `[accountNum, email, organizationUuid]` for session mode.
   * An ambiguous email is an error, not a prompt: session mode ends in an exec.
   */
  resolveAccount(identifier: string): [string, string, string] {
    this.getSequenceDataMigrated();
    const accountNum = this.resolveAccountIdentifier(identifier);
    if (!accountNum) throw new AccountNotFoundError(`No account found with identifier: ${identifier}`);
    const data = this.getSequenceData() ?? {};
    const record = recordOf(data, accountNum);
    if (!truthyDict(record)) throw new AccountNotFoundError(`Account-${accountNum} does not exist`);
    return [accountNum, textOf(pyGet(record, "email", "")), textOf(record.organizationUuid)];
  }

  /**
   * Set (or rename) the alias of the account that matches `identifier` (slot
   * number, email or current alias). Return `[accountNum, normalizedAlias]`.
   */
  setAlias(identifier: string, alias: string): [string, string] {
    this.refuseSessionShell();
    let normalized: string;
    try {
      normalized = normalizeAlias(alias);
    } catch (e) {
      if (e instanceof RangeError) throw new ValidationError(e.message);
      throw e;
    }

    this.getSequenceDataMigrated();
    const accountNum = this.resolveAccountIdentifier(identifier);
    if (!accountNum) throw new AccountNotFoundError(`No account found with identifier: ${identifier}`);
    const data = this.getSequenceData() ?? {};
    const record = recordOf(data, accountNum);
    if (!truthyDict(record)) throw new AccountNotFoundError(`Account-${accountNum} does not exist`);

    const conflict = this.aliasInUse(normalized, { excludeNum: accountNum });
    if (conflict !== null) throw new ConfigError(`Alias '${normalized}' is already used by account ${conflict}`);

    record.alias = normalized;
    data.lastUpdated = getTimestamp();
    this.writeJson(this.sequenceFile, data);
    return [accountNum, normalized];
  }

  /** Clear the alias of the matching account and return its number. Clearing an unset alias succeeds. */
  unsetAlias(identifier: string): string {
    this.refuseSessionShell();
    this.getSequenceDataMigrated();
    const accountNum = this.resolveAccountIdentifier(identifier);
    if (!accountNum) throw new AccountNotFoundError(`No account found with identifier: ${identifier}`);
    const data = this.getSequenceData() ?? {};
    const record = recordOf(data, accountNum);
    if (!truthyDict(record)) throw new AccountNotFoundError(`Account-${accountNum} does not exist`);

    if (Object.hasOwn(record, "alias")) {
      delete record.alias;
      data.lastUpdated = getTimestamp();
      this.writeJson(this.sequenceFile, data);
    }
    return accountNum;
  }

  /** Every set alias as `[accountNum, alias, email]`, in slot-number order. */
  listAliases(): Array<[string, string, string]> {
    const data = this.getSequenceDataMigrated();
    const rows: Array<[string, string, string]> = [];
    for (const [num, acc] of Object.entries(accountsOf(data))) {
      if (acc.alias) rows.push([num, acc.alias, textOf(pyGet(acc, "email", ""))]);
    }
    return rows.sort((a, b) => pyInt(a[0]) - pyInt(b[0]));
  }

  /**
   * Exchange the slot numbers of two accounts.
   *
   * Everything keyed by the slot number moves: the records (aliases included),
   * the credential and config backups, the `sequence` membership (kept sorted),
   * `activeAccountNumber` and the session profiles. Mappings key on
   * `(email, org)` and do not change. Usage rows and quarantine entries heal
   * on the next pass through their identity checks.
   *
   * The whole resolve-validate-mutate span runs under the account lock. The
   * `sequence.json` write is the commit point. Return the two slot numbers.
   */
  swapAccounts(first: string, second: string): [string, string] {
    if (!fs.existsSync(this.sequenceFile)) throw new ConfigError("No accounts are managed yet");
    this.refuseSessionShell();
    return holdSync([() => enterFileLock(this.lockFile)], () => this.swapAccountsLocked(first, second));
  }

  /**
   * The backup of a slot for the snapshot before a swap or move. Throw if the
   * backup is unreadable (not absent): nothing has moved yet, so abort.
   */
  readBackupOrAbort(accountNum: string, email: string): string {
    const [creds, unreadable] = this.readAccountCredentialsEx(accountNum, email);
    if (unreadable) {
      throw new ConfigError(
        `Account-${accountNum}'s stored credential could not be ` +
          "read (keychain unavailable?); nothing was changed. Retry " +
          "once it is readable again.",
      );
    }
    return creds;
  }

  /**
   * The body of `swapAccounts`. The caller holds `lockFile`. `moveAccount`
   * resolves and dispatches inside one lock hold, because `FileLock` is not reentrant.
   */
  swapAccountsLocked(first: string, second: string): [string, string] {
    this.getSequenceDataMigrated();

    const numA = this.resolveAccountIdentifier(first);
    if (!numA) throw new AccountNotFoundError(`No account found with identifier: ${first}`);
    const numB = this.resolveAccountIdentifier(second);
    if (!numB) throw new AccountNotFoundError(`No account found with identifier: ${second}`);
    if (numA === numB) throw new ValidationError("Cannot swap an account with itself");

    const data = this.getSequenceData() ?? {};
    const recordA = recordOf(data, numA);
    const recordB = recordOf(data, numB);
    if (!truthyDict(recordA)) throw new AccountNotFoundError(`Account-${numA} does not exist`);
    if (!truthyDict(recordB)) throw new AccountNotFoundError(`Account-${numB} does not exist`);

    const emailA = textOf(pyGet(recordA, "email", ""));
    const emailB = textOf(pyGet(recordB, "email", ""));

    // A move under a live session-mode claude would pull state out from under it.
    this.ensureNoLiveSession(numA, emailA, "--swap-accounts");
    this.ensureNoLiveSession(numB, emailB, "--swap-accounts");

    // Read both slots first, so that a read failure aborts before anything moves.
    const credsA = this.readBackupOrAbort(numA, emailA);
    const credsB = this.readBackupOrAbort(numB, emailB);
    const configA = this.readAccountConfig(numA, emailA);
    const configB = this.readAccountConfig(numB, emailB);

    let staging: Record<string, string> = {};
    try {
      if (emailA === emailB) {
        // The backup keys of the two slots overlap fully, so each write
        // overwrites the material of the other account. Park durable copies first.
        staging = this.stageOverlapMaterial([
          [numA, [credsA, configA]],
          [numB, [credsB, configB]],
        ]);
      }

      this.swapSessionDirs(numA, emailA, numB, emailB);

      // Set each destination key to the exact state of its owner: write the
      // material that exists, clear what does not. The old keys are cleared
      // only after the commit, so the records never point at missing material.
      if (credsA) this.writeAccountCredentials(numB, emailA, credsA);
      else this.deleteAccountCredentialsStrict(numB, emailA);
      if (configA) this.writeAccountConfig(numB, emailA, configA);
      else this.deleteConfigBackup(numB, emailA);
      if (credsB) this.writeAccountCredentials(numA, emailB, credsB);
      else this.deleteAccountCredentialsStrict(numA, emailB);
      if (configB) this.writeAccountConfig(numA, emailB, configB);
      else this.deleteConfigBackup(numA, emailB);

      const accounts = accountsOf(data);
      accounts[numA] = recordB;
      accounts[numB] = recordA;
      const intA = pyInt(numA);
      const intB = pyInt(numB);
      data.sequence = numericSort(sequenceOf(data).map((n) => (n === intA ? intB : n === intB ? intA : n)));
      const active = data.activeAccountNumber;
      if (active === intA) data.activeAccountNumber = intB;
      else if (active === intB) data.activeAccountNumber = intA;
      data.lastUpdated = getTimestamp();
      // The commit point.
      this.writeJson(this.sequenceFile, data);
    } catch (e) {
      this.rollbackSwap(numA, emailA, credsA, configA, numB, emailB, credsB, configB, staging);
      throw e;
    }

    // After the commit, the cleanup is best effort. A stale key under a freed
    // slot can poison a later same-email account on that number, so log it loudly.
    if (emailA !== emailB) {
      for (const [num, email] of [
        [numA, emailA],
        [numB, emailB],
      ] as const) {
        try {
          this.deleteAccountFiles(num, email);
        } catch (e) {
          this.logger.error(`Stale backup left under old key ${num} (${email}): ${errorText(e)}`);
        }
      }
    }
    // The .prev generations of the destination keys hold displaced material
    // that a recovery must never put back on the new owner.
    if (credsA) this.store.deletePreviousBackup(numB, emailA);
    if (credsB) this.store.deletePreviousBackup(numA, emailB);
    this.discardStaging(staging);

    this.logger.info(`Swapped slots: ${numA} (${emailA}) <-> ${numB} (${emailB})`);
    return [numA, numB];
  }

  /**
   * Delete the config backup of one slot key, if present. A missing file is
   * fine. Other errors propagate: the callers need the abort or count the failure.
   */
  deleteConfigBackup(accountNum: string, email: string): void {
    try {
      fs.unlinkSync(this.configFile(accountNum, email));
    } catch (e) {
      if (!isFileNotFound(e)) throw e;
    }
  }

  /**
   * Remove the staged copies of a swap. A copy that stays holds plaintext
   * credentials and blocks the next same-email swap, so tell the user.
   */
  discardStaging(staging: Record<string, string>): void {
    for (const stagePath of Object.values(staging)) {
      try {
        fs.unlinkSync(stagePath);
      } catch (e) {
        if (!isOsError(e)) throw e;
        this.logger.error(`Could not remove swap staging copy: ${e.message}`);
        warning(
          `Could not remove swap staging file ${stagePath} — it holds ` +
            "pre-swap credentials; please delete it manually.",
        );
      }
    }
  }

  /**
   * Park the backup material of slots in files before overlapping writes.
   *
   * The files are durable on every platform, created with mode 0600 and
   * `O_EXCL`. A leftover file from an interrupted swap can be the only copy of
   * a credential, so the swap refuses and names it. A failure here aborts the
   * swap before anything is overwritten.
   */
  stageOverlapMaterial(material: ReadonlyArray<readonly [string, readonly [string, string]]>): Record<string, string> {
    const staged: Record<string, string> = {};
    try {
      for (const [num, [creds, config]] of material) {
        for (const [kind, content] of [
          ["creds", creds],
          ["config", config],
        ] as const) {
          if (!content) continue;
          const stagePath = path.join(this.credentialsDir, `.swap-staging-${kind}-${num}.json`);
          if (fs.existsSync(stagePath)) {
            throw new ConfigError(
              `Found leftover staging from an interrupted swap: ` +
                `${stagePath}. It holds that slot's pre-swap credentials ` +
                "and may be the only surviving copy. Verify both " +
                "accounts still work (`cswap list`), then delete " +
                "the file and retry.",
            );
          }
          const fd = fs.openSync(stagePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
          try {
            fs.writeSync(fd, content, null, "utf8");
          } finally {
            fs.closeSync(fd);
          }
          staged[`${kind}-${num}`] = stagePath;
        }
      }
    } catch (e) {
      if (e instanceof ConfigError) {
        // Leftover found: remove only what this call created.
        this.discardStaging(staged);
        throw e;
      }
      if (isOsError(e)) {
        this.discardStaging(staged);
        throw new ConfigError(`Could not stage swap material, nothing was changed: ${e.message}`);
      }
      throw e;
    }
    return staged;
  }

  /**
   * Exchange the session profile directories of two slots, best effort. A
   * profile that cannot move is pruned with the old keys and re-bootstrapped
   * from the moved backups, so a skipped move costs at most that history.
   */
  swapSessionDirs(numA: string, emailA: string, numB: string, emailB: string): void {
    const dirA = this.sessionDir(numA, emailA);
    const dirB = this.sessionDir(numB, emailB);
    const newA = this.sessionDir(numB, emailA);
    const newB = this.sessionDir(numA, emailB);

    let staging: string | null = null;
    try {
      if (fs.existsSync(dirA)) {
        staging = `${dirA}.swapping`;
        fs.renameSync(dirA, staging);
      }
      if (fs.existsSync(dirB) && !fs.existsSync(newB)) fs.renameSync(dirB, newB);
      if (staging !== null && !fs.existsSync(newA)) {
        fs.renameSync(staging, newA);
        staging = null;
      }
    } catch (e) {
      if (!isOsError(e)) throw e;
      this.logger.warning(`Session profile move skipped during swap: ${e.message}`);
    } finally {
      if (staging !== null) {
        // Never leave a profile under the staging name.
        try {
          if (!fs.existsSync(dirA)) fs.renameSync(staging, dirA);
        } catch (e) {
          if (!isOsError(e)) throw e;
        }
      }
    }
  }

  /**
   * Best-effort restore of both slots after a failed swap, before the commit.
   * A key whose original was empty goes back to empty. Each step runs on its
   * own. If one fails, the staged copies stay on disk for a manual recovery.
   */
  rollbackSwap(
    numA: string,
    emailA: string,
    credsA: string,
    configA: string,
    numB: string,
    emailB: string,
    credsB: string,
    configB: string,
    staging: Record<string, string>,
  ): void {
    this.logger.error(`Swap ${numA} <-> ${numB} failed mid-write; restoring both slots`);
    let failures = 0;
    this.swapSessionDirs(numB, emailA, numA, emailB);
    const overlap = emailA === emailB;
    for (const [kind, num, email, original] of [
      ["creds", numA, emailA, credsA],
      ["config", numA, emailA, configA],
      ["creds", numB, emailB, credsB],
      ["config", numB, emailB, configB],
    ] as const) {
      try {
        if (original) {
          if (kind === "creds") this.writeAccountCredentials(num, email, original);
          else this.writeAccountConfig(num, email, original);
        } else if (overlap) {
          // The shared key can now hold the material of the other account. An
          // empty original must read empty again. The strict delete counts a failure.
          if (kind === "creds") this.deleteAccountCredentialsStrict(num, email);
          else this.deleteConfigBackup(num, email);
        }
      } catch (e) {
        failures += 1;
        this.logger.error(`Rollback ${kind} restore failed for slot ${num}: ${errorText(e)}`);
      }
    }
    if (emailA !== emailB) {
      // Drop the half-written copies under the new keys. The records still point at the old slots.
      for (const [num, email] of [
        [numB, emailA],
        [numA, emailB],
      ] as const) {
        try {
          this.deleteAccountCredentials(num, email);
          this.deleteConfigBackup(num, email);
        } catch (e) {
          failures += 1;
          this.logger.error(`Rollback cleanup failed for slot ${num}: ${errorText(e)}`);
        }
      }
    }
    if (!failures) {
      // The restore writes pushed the half-written material into the .prev
      // generations. Both keys hold their originals now, so drop them.
      for (const [num, email, original] of [
        [numA, emailA, credsA],
        [numB, emailB, credsB],
      ] as const) {
        if (original) this.store.deletePreviousBackup(num, email);
      }
    }
    if (Object.keys(staging).length > 0) {
      if (failures) {
        const kept = Object.values(staging).join(", ");
        this.logger.error(`Rollback incomplete — staged pre-swap copies kept for manual recovery: ${kept}`);
        warning(`Swap rollback was incomplete; your pre-swap credentials are preserved in: ${kept}`);
      } else {
        this.discardStaging(staging);
      }
    }
  }

  /**
   * Put `account` (NUM|EMAIL|ALIAS) in slot `target`.
   *
   * - `target` is the current slot of the account: nothing changes.
   * - `target` is empty: the account moves there, and its old slot is free.
   * - `target` is occupied: the two accounts trade places, as with `swap`.
   *
   * A target can be any positive number up to 99, or up to the highest slot if
   * the table is already larger: `add` numbers from the highest slot, so a very
   * large target would inflate every later account number.
   *
   * Return `[sourceNum, targetNum, swapped]`.
   */
  moveAccount(account: string, target: string): [string, string, boolean] {
    this.refuseSessionShell();
    if (!fs.existsSync(this.sequenceFile)) throw new ConfigError("No accounts are managed yet");

    target = target.trim();
    if (!isDigits(target) || pyInt(target) < 1) {
      throw new ValidationError(
        `Target slot must be a positive slot number, got: ${pyStrRepr(target)} ` +
          "(use `swap` to trade two accounts by identifier)",
      );
    }
    target = String(pyInt(target));

    // Resolve inside the same lock hold as the mutation: a concurrent swap or
    // move could renumber a slot that was resolved outside the lock.
    return holdSync([() => enterFileLock(this.lockFile)], (): [string, string, boolean] => {
      this.getSequenceDataMigrated();

      const numSrc = this.resolveAccountIdentifier(account);
      if (!numSrc) throw new AccountNotFoundError(`No account found with identifier: ${account}`);

      const data = this.getSequenceData() ?? {};
      if (!truthyDict(recordOf(data, numSrc))) throw new AccountNotFoundError(`Account-${numSrc} does not exist`);

      let maxSlot = 0;
      for (const n of Object.keys(accountsOf(data))) {
        if (isDigits(n)) maxSlot = Math.max(maxSlot, pyInt(n));
      }
      const cap = Math.max(99, maxSlot);
      if (pyInt(target) > cap) {
        throw new ValidationError(
          `Target slot ${target} is out of range (1-${cap}): new accounts ` +
            "are numbered from the highest slot, so a large target would " +
            "inflate future account numbers",
        );
      }

      if (numSrc === target) return [numSrc, target, false];

      if (truthyDict(recordOf(data, target))) {
        this.swapAccountsLocked(numSrc, target);
        return [numSrc, target, true];
      }

      this.relocateLocked(numSrc, target);
      return [numSrc, target, false];
    });
  }

  /**
   * Move one account from `numSrc` to the empty slot `target`. The caller holds
   * `lockFile`. The `sequence.json` write is the commit point: before it the
   * old keys do not change, after it only the cleanup of the old keys stays.
   */
  relocateLocked(numSrc: string, target: string): void {
    const data = this.getSequenceData() ?? {};
    const record = recordOf(data, numSrc);
    if (!truthyDict(record)) throw new AccountNotFoundError(`Account-${numSrc} does not exist`);
    if (truthyDict(recordOf(data, target))) throw new ValidationError(`Slot ${target} is already occupied — retry the move`);
    const email = textOf(pyGet(record, "email", ""));

    this.ensureNoLiveSession(numSrc, email, "--move-account");

    // Read first, so that a read failure aborts before any move.
    const creds = this.readBackupOrAbort(numSrc, email);
    const config = this.readAccountConfig(numSrc, email);

    const srcDir = this.sessionDir(numSrc, email);
    const dstDir = this.sessionDir(target, email);
    try {
      // Best effort: a profile that cannot move is pruned with the old backups and re-bootstrapped later.
      if (fs.existsSync(srcDir) && !fs.existsSync(dstDir)) {
        try {
          fs.renameSync(srcDir, dstDir);
        } catch (e) {
          if (!isOsError(e)) throw e;
          this.logger.warning(`Session profile move skipped during move: ${e.message}`);
        }
      }

      // Set the target key to the exact state of the account: an account with
      // no backup must not take stale material that a crash left under the target key.
      if (creds) this.writeAccountCredentials(target, email, creds);
      else this.deleteAccountCredentialsStrict(target, email);
      if (config) this.writeAccountConfig(target, email, config);
      else this.deleteConfigBackup(target, email);

      const accounts = accountsOf(data);
      accounts[target] = record;
      delete accounts[numSrc];
      const intSrc = pyInt(numSrc);
      const intTarget = pyInt(target);
      data.sequence = numericSort(sequenceOf(data).map((n) => (n === intSrc ? intTarget : n)));
      if (data.activeAccountNumber === intSrc) data.activeAccountNumber = intTarget;
      data.lastUpdated = getTimestamp();
      // The commit point.
      this.writeJson(this.sequenceFile, data);
    } catch (e) {
      // Before the commit the records still point at numSrc. Drop the strays
      // under the target key and put the session profile back, best effort.
      try {
        this.deleteAccountCredentials(target, email);
        this.deleteConfigBackup(target, email);
        if (fs.existsSync(dstDir) && !fs.existsSync(srcDir)) fs.renameSync(dstDir, srcDir);
      } catch (cleanupError) {
        this.logger.error(`Cleanup after failed move incomplete: ${errorText(cleanupError)}`);
      }
      throw e;
    }

    try {
      this.deleteAccountFiles(numSrc, email);
    } catch (e) {
      this.logger.error(`Stale backup left under old key ${numSrc} (${email}): ${errorText(e)}`);
    }
    // A .prev kept while a stale target key was overwritten holds that stale material.
    if (creds) this.store.deletePreviousBackup(target, email);

    this.logger.info(`Moved slot: ${numSrc} (${email}) -> ${target}`);
  }

  /**
   * Resolve a directory to its mapped account slot, for `cswap run`.
   * `[null, null]`: no mapping. `[null, email]`: the mapped account was removed. `[slot, email]`: resolved.
   */
  slotForDirectory(directory: string): [string | null, string | null] {
    const match = new MappingStore(this.backupDir).resolve(directory);
    if (match === null) return [null, null];
    const [, entry] = match;
    const email = textOf(pyGet(entry, "email", ""));
    const seq = this.getSequenceDataMigrated() ?? {};
    const slot = ClaudeAccountSwitcher.findAccountSlot(seq, email, textOf(entry.organizationUuid));
    return [slot, email];
  }

  /** Print all directory → account mappings (for `cswap map`). */
  listMappings(): void {
    const mappings = new MappingStore(this.backupDir).all();
    const paths = Object.keys(mappings);
    if (paths.length === 0) {
      print(dimmed("No directory mappings yet."));
      print(muted("Map one with: cswap map <NUM|EMAIL> [PATH]"));
      return;
    }
    const seq = this.getSequenceDataMigrated() ?? {};
    print(bolded("Directory mappings:"));
    for (const mappedPath of paths.sort()) {
      const entry = mappings[mappedPath]!;
      const email = textOf(pyGet(entry, "email", ""));
      const orgUuid = textOf(entry.organizationUuid);
      const slot = ClaudeAccountSwitcher.findAccountSlot(seq, email, orgUuid);
      if (slot) {
        const account = recordOf(seq, slot) ?? {};
        const tag = ClaudeAccountSwitcher.getDisplayTag(email, textOf(pyGet(account, "organizationName", "")), orgUuid);
        print(`  ${mappedPath} ${dimmed("→")} ${slot}: ${email} ${muted(`[${tag}]`)}`);
      } else {
        print(`  ${mappedPath} ${dimmed("→")} ${email} ${muted("(account removed)")}`);
      }
    }
  }

  /**
   * Account number → decision-grade usage: a usage dict (last-good, trusted
   * while it is at most `usage_store.STALE_OK_S` old), a sentinel string, or null (unknown).
   */
  async usageByAccount(): Promise<Record<string, oauth.UsageDict | string | null>> {
    const accountsInfo = this.buildAccountsInfo();
    const entries = await this.collectUsageEntries(accountsInfo);
    const out: Record<string, oauth.UsageDict | string | null> = {};
    for (const [num, entry] of Object.entries(entries)) out[num] = entry.decisionValue();
    return out;
  }

  /**
   * Store-backed usage entries per account. `fetch` limits which accounts can
   * be fetched in this pass (null: every stale account). `scheduled` keeps the
   * valid future plans and still lets the due plans beat the serve TTL.
   */
  async usageEntriesByAccount(
    fetch: ReadonlySet<string> | null = null,
    { scheduled = false }: { scheduled?: boolean } = {},
  ): Promise<Record<string, UsageEntry>> {
    const accountsInfo = this.buildAccountsInfo();
    return this.collectUsageEntries(accountsInfo, fetch, { scheduled });
  }

  /**
   * A snapshot of every managed account for the TUI, from one
   * `buildAccountsInfo` + `collectUsageEntries` pass, so the view is coherent.
   */
  async accountsSnapshot(fetch: ReadonlySet<string> | null = null): Promise<AccountsSnapshot> {
    const accountsInfo = this.buildAccountsInfo();
    const entries = await this.collectUsageEntries(accountsInfo, fetch);
    const seqData = this.getSequenceData() ?? {};
    let activeNumber: string | null = null;
    const accounts: AccountSnapshot[] = [];
    for (const [num, email, orgName, orgUuid, isActive, , alias] of accountsInfo) {
      const n = String(num);
      if (isActive) activeNumber = n;
      accounts.push(
        accountSnapshot({
          number: n,
          email,
          orgName,
          orgUuid,
          isActive,
          kind: this.accountKind(n),
          switchable: this.accountIsSwitchable(n),
          usage: entries[n]!,
          alias,
          disabled: ClaudeAccountSwitcher.disabledFromData(seqData, n),
        }),
      );
    }
    return Object.freeze({ activeNumber, accounts: Object.freeze(accounts), takenAt: this.usageStore.clock() });
  }

  /**
   * The `fetchedAt` of each slot from the usage store. A pure file read. The
   * TUI watch view compares two snapshots to flash the rows that refreshed.
   */
  usageFetchStamps(): Record<string, number | null> {
    const data = this.getSequenceData() ?? {};
    const identities: Record<string, Identity> = {};
    for (const [num, info] of Object.entries(accountsOf(data))) {
      identities[num] = [textOf(pyGet(info, "email", "")), textOf(info.organizationUuid)];
    }
    const out: Record<string, number | null> = {};
    for (const [num, entry] of Object.entries(this.usageStore.entries(identities))) out[num] = entry.fetchedAt;
    return out;
  }

  /** Pin the poll planning inputs (a hosted auto engine sets its effective, CLI-merged settings). */
  setPollPolicyInputs(threshold: number, models: readonly string[]): void {
    this.pollInputsOverride = [threshold, [...models]];
  }

  /** Drop the pin of the hosted engine, so poll planning uses the settings file again. */
  clearPollPolicyInputs(): void {
    this.pollInputsOverride = null;
  }

  /**
   * Threshold and model names for poll planning: the pinned values, else the
   * settings file (read again only when its mtime changes).
   */
  pollPolicyInputs(): PollInputs {
    if (this.pollInputsOverride !== null) return this.pollInputsOverride;
    const file = settingsPath(this.backupDir);
    let mtime: number | null;
    try {
      mtime = fs.statSync(file).mtimeMs / 1000;
    } catch (e) {
      if (!isOsError(e)) throw e;
      mtime = null;
    }
    if (this.pollInputsCache !== null && this.pollInputsCache[0] === mtime) return this.pollInputsCache[1];
    const loaded = loadSettings(this.backupDir);
    const inputs: PollInputs = [loaded.threshold, parseModelNames(loaded.model)];
    this.pollInputsCache = [mtime, inputs];
    return inputs;
  }

  /**
   * Account numbers in rotation order that automatic selection can use. The
   * slots with no usable backups and the disabled slots are not in the list.
   */
  switchableAccountNumbers(): string[] {
    const data = this.getSequenceData() ?? {};
    return sequenceOf(data)
      .map((num) => String(num))
      .filter((num) => this.accountIsSwitchable(num) && !ClaudeAccountSwitcher.disabledFromData(data, num));
  }

  /** True if a slot is out of rotation, in data that is already loaded. */
  static disabledFromData(data: SequenceData, accountNum: string): boolean {
    const record = recordOf(data, String(accountNum));
    return Boolean(truthyDict(record) && record.disabled);
  }

  isAccountDisabled(accountNum: string): boolean {
    const data = this.getSequenceData() ?? {};
    return ClaudeAccountSwitcher.disabledFromData(data, String(accountNum));
  }

  /** The managed slots that the user disabled, in sequence order. */
  disabledAccountNumbers(): string[] {
    const data = this.getSequenceData() ?? {};
    return sequenceOf(data)
      .map((num) => String(num))
      .filter((num) => ClaudeAccountSwitcher.disabledFromData(data, num));
  }

  /**
   * Hold an account out of rotation (`disabled` true) or put it back.
   * A disabled account stays managed and stays a valid explicit `cswap switch` target.
   */
  setAccountDisabled(identifier: string, disabled: boolean): void {
    if (!fs.existsSync(this.sequenceFile)) throw new ConfigError("No accounts are managed yet");

    const [accountNum, email] = this.resolveAccount(identifier);

    const data = this.getSequenceData() ?? {};
    const record = recordOf(data, accountNum);
    if (!truthyDict(record)) throw new AccountNotFoundError(`Account-${accountNum} does not exist`);

    const verb = disabled ? "disabled" : "enabled";
    const capitalized = disabled ? "Disabled" : "Enabled";
    if (Boolean(record.disabled) === disabled) {
      print(dimmed(`Account-${accountNum} (${email}) is already ${verb}.`));
      return;
    }

    if (disabled) record.disabled = true;
    else delete record.disabled;
    data.lastUpdated = getTimestamp();
    this.writeJson(this.sequenceFile, data);
    this.logger.info(`${capitalized} account ${accountNum}: ${email}`);

    print(`${accent(capitalized)} Account-${accountNum} (${email}).`);

    if (disabled) {
      const active = data.activeAccountNumber;
      if (String(active ?? "None") === accountNum) {
        print(
          dimmed(
            "  It is the active account — it stays live until you switch " +
              "away; it just won't be an automatic switch target.",
          ),
        );
      }
      if (this.switchableAccountNumbers().length === 0) {
        warning(
          "  No accounts remain in rotation — auto-switch and bare " +
            "switch have nothing to pick. Re-enable one with " +
            "cswap enable <num|email>.",
        );
      }
    } else {
      print(dimmed("  It is back in the rotation."));
    }
  }

  /** `"api_key"` or `"oauth"` (setup-tokens read as oauth). */
  accountKindFor(accountNum: string): string {
    return this.accountKind(accountNum);
  }

  /** The stored email of a slot. Empty string when unknown. */
  accountEmail(accountNum: string): string {
    const data = this.getSequenceData() ?? {};
    return textOf(pyGet(recordOf(data, String(accountNum)) ?? {}, "email", ""));
  }

  /**
   * The slot of the live login. Null when there is none or it is not managed.
   *
   * There is no fallback to the recorded `activeAccountNumber`: for an
   * unmanaged live login, the auto-switch engine must not read the usage of
   * the wrong account. `hasLiveLogin` tells the two null cases apart.
   */
  currentAccountNumber(): string | null {
    const identity = this.getCurrentAccount();
    if (identity === null) return null;
    const data = this.getSequenceData() ?? {};
    const [email, orgUuid] = identity;
    return ClaudeAccountSwitcher.findAccountSlot(data, email, orgUuid);
  }

  /** True if `~/.claude.json` holds a live account identity. */
  hasLiveLogin(): boolean {
    return this.getCurrentAccount() !== null;
  }

  /** The PIDs of live `cswap run` sessions of a slot. */
  liveSessionPidsFor(accountNum: string, email: string): number[] {
    return this.liveSessionPids(accountNum, email);
  }

  /**
   * Persist rotated credentials to the backup store of an inactive slot, under
   * the lock. The caller must NOT hold `lockFile` (`FileLock` is not reentrant).
   */
  persistBackupCredentials(accountNum: string, email: string, credentials: string): void {
    holdSync([() => enterFileLock(this.lockFile)], () => this.writeAccountCredentials(accountNum, email, credentials));
  }

  /** The stored identity of a slot: `{ email, organizationUuid, uuid }`. */
  accountIdentity(accountNum: string): { email: string; organizationUuid: string; uuid: string } {
    const data = this.getSequenceData() ?? {};
    const acct = recordOf(data, String(accountNum)) ?? {};
    return {
      email: textOf(pyGet(acct, "email", "")),
      organizationUuid: textOf(acct.organizationUuid),
      uuid: textOf(acct.uuid).trim(),
    };
  }

  /**
   * Record a resolved account uuid on a slot that has none. An existing uuid
   * is never changed. With `expectedEmail`/`expectedOrg`, the slot must still
   * hold that identity under the lock. The caller must NOT hold `lockFile`.
   */
  backfillAccountUuid(
    accountNum: string,
    uuid: string,
    expectedEmail: string | null = null,
    expectedOrg: string | null = null,
  ): void {
    if (!uuid) return;
    holdSync([() => enterFileLock(this.lockFile)], () => {
      const data = this.getSequenceData() ?? {};
      const acct = recordOf(data, String(accountNum));
      if (
        acct !== undefined &&
        acct !== null &&
        !textOf(acct.uuid).trim() &&
        (expectedEmail === null || acct.email === expectedEmail) &&
        (expectedOrg === null || textOf(acct.organizationUuid) === expectedOrg)
      ) {
        acct.uuid = uuid;
        data.lastUpdated = getTimestamp();
        this.writeJson(this.sequenceFile, data);
      }
    });
  }

  /**
   * The gate through which a backup refresh token is consumed.
   *
   * A refresh token is one-time-use, so the POST must consume the freshest
   * copy of the grant, never a snapshot of the caller. The sequence (re-read,
   * POST, CAS) runs under a per-slot consume lock, so two consumers never POST
   * the same grant. The slot `FileLock` never covers the network call.
   * `fetchActiveUsage` can also POST the backup grant, and it takes the same
   * consume lock in the same order.
   *
   * A consumed generation is never discarded: if the persist fails, the
   * successor goes to the stash and the next pass adopts it. After the POST the
   * gate never throws. Every outcome carries `consumedFp`, the fingerprint of
   * the bytes the gate sent. The caller must NOT hold `lockFile`.
   */
  async consumeBackupGrant(accountNum: string, email: string, snapshot: string): Promise<oauth.RefreshOutcome> {
    // Claude Code 2.1.220 honors CLAUDE_SECURESTORAGE_CONFIG_DIR. The consume
    // path resolves the default store, which is then a stale copy by construction.
    if (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR) {
      this.logger.warning(
        "CLAUDE_SECURESTORAGE_CONFIG_DIR is set; cswap mirrors it " +
          "when capturing a credential but not when consuming one, " +
          "so refusing to consume account %s's refresh token " +
          "(unset the variable or run from a normal shell).",
        accountNum,
      );
      return oauth.refreshOutcome(null, "store-unmirrored");
    }

    // One in-flight consume per slot, held across re-read, POST and CAS. Only
    // other gates contend for this lock, and the POST is bounded.
    const consumePath = path.join(this.credentialsDir, `.consume-${accountNum}.lock`);
    const consumeLock = new internals.FileLock(consumePath);
    const acquired = await whenIdle([consumePath], () => {
      const ok = consumeLock.acquire();
      if (ok) markHeld(consumePath, 1);
      return ok;
    });
    if (!acquired) {
      this.logger.info("Another consume is in flight for account %s; deferring to the next pass.", accountNum);
      // Local serialization, not a failure: its own kind, so the tick does not blame the network.
      return oauth.refreshOutcome(null, "consume-busy");
    }
    try {
      return await this.consumeBackupGrantLocked(accountNum, email, snapshot);
    } finally {
      markHeld(consumePath, -1);
      consumeLock.release();
    }
  }

  /** The body of `consumeBackupGrant`. The caller holds the consume lock. */
  async consumeBackupGrantLocked(accountNum: string, email: string, snapshot: string): Promise<oauth.RefreshOutcome> {
    type Prepared = { refreshInput: string; inputOauth: Record<string, unknown> | null; consumedFp: string | null };
    let prepared: Prepared;
    try {
      const early = await holdAsync(
        [this.lockFile],
        [() => enterFileLock(this.lockFile)],
        (): oauth.RefreshOutcome | Prepared => {
          let [current, unreadable] = this.readAccountCredentialsEx(accountNum, email);
          if (unreadable) {
            // The snapshot is the possibly-superseded copy that this gate must never consume.
            this.logger.info("Backup for account %s unreadable (keychain); deferring the refresh.", accountNum);
            return oauth.refreshOutcome(null, "transient");
          }
          // A stashed successor of an earlier failed persist: writing it back
          // IS the pending persist, and it saves a grant.
          let adoptedCreds: string | null;
          try {
            adoptedCreds = this.adoptStashedSuccessor(accountNum, email, current);
          } catch (e) {
            if (!(e instanceof CredentialReadError)) throw e;
            // The only successor of the slot is unreadable. Defer, but with a
            // label that sends the operator to the keychain or the file, not the network.
            this.logger.info("Account %s's stashed successor is unreadable; deferring the refresh.", accountNum, {
              excInfo: e,
            });
            return oauth.refreshOutcome(null, "stash-unreadable");
          }
          if (adoptedCreds !== null) current = adoptedCreds;
          if (!current) {
            // ABSENT: the slot was removed after the read of the caller. Do not
            // spend a grant for an account that the user deleted.
            this.logger.info(
              "Account %s's stored credential is gone; deferring " +
                "the refresh rather than consuming a grant for a " +
                "slot that no longer exists.",
              accountNum,
            );
            return oauth.refreshOutcome(null, "transient");
          }
          let refreshInput = current;
          let inputOauth = oauth.extractOauthData(refreshInput);
          // The session profile wins only when no live session owns it and its identity (org too) still matches the slot.
          const orgUuid = textOf(pyGet(recordOf(this.getSequenceData() ?? {}, accountNum) ?? {}, "organizationUuid", ""));
          if (this.liveSessionPids(accountNum, email).length === 0) {
            const sdir = session.sessionDirFor(this.backupDir, accountNum, email);
            const profile = session.readSessionCredentials(sdir);
            if (
              profile &&
              // A marked profile is presumed stale against the backup.
              !session.isSessionStale(sdir) &&
              !session.sessionIdentityDrifted(sdir, email, orgUuid)
            ) {
              const profOauth = oauth.extractOauthData(profile);
              const curExp = Number((inputOauth ?? {}).expiresAt || 0);
              const profExp = Number((profOauth ?? {}).expiresAt || 0);
              if (
                profOauth &&
                profOauth.accessToken &&
                profOauth.refreshToken &&
                oauth.credentialFingerprint(profile) !== oauth.credentialFingerprint(refreshInput) &&
                profExp > curExp
              ) {
                // The profile holds the newer generation, so the backup grant is
                // already consumed. Resync the backup, then consume the profile.
                this.writeAccountCredentials(accountNum, email, profile);
                refreshInput = profile;
                inputOauth = profOauth;
              }
            }
          }
          return { refreshInput, inputOauth, consumedFp: oauth.credentialFingerprint(refreshInput) };
        },
      );
      if (!("refreshInput" in early)) return early;
      prepared = early;
    } catch (e) {
      if (e instanceof LockError) {
        // Nothing consumed yet: another holder owns the slot. Defer.
        this.logger.info("Slot lock held elsewhere; deferring account %s's backup refresh to the next pass.", accountNum);
        return oauth.refreshOutcome(null, "transient");
      }
      // No POST yet, so no grant of ours is outstanding. The store can already be
      // advanced (resync or adoption), but a deferral spends nothing.
      this.logger.warning("Pre-consume window failed for account %s; deferring.", accountNum, { excInfo: e });
      return oauth.refreshOutcome(null, "transient");
    }

    const { refreshInput, consumedFp } = prepared;
    const inputOauth = prepared.inputOauth ?? {};
    const snapAt = (oauth.extractOauthData(snapshot) ?? {}).accessToken;
    if (
      inputOauth.accessToken &&
      snapAt &&
      inputOauth.accessToken !== snapAt &&
      !oauth.isOauthTokenExpired(inputOauth.expiresAt)
    ) {
      // The store moved past the snapshot and the current generation is fresh:
      // the refresh already happened. Another POST would burn a generation.
      return oauth.refreshOutcome(refreshInput, null, { consumedFp });
    }

    const result = await oauth.tryRefreshOauthCredentials(refreshInput);
    if (result.error !== null || !result.credentials) {
      // The strike binds to the bytes that were sent.
      return { ...result, consumedFp };
    }
    const successor = result.credentials;

    let stashedReason = "";
    const stashSuccessor = (reason: string, note: string): void => {
      // Never discard a consumed generation. `consumedFp` is the adoption key.
      this.store.writeUnclaimedCredential(successor, {
        reason,
        configSlot: accountNum,
        consumedFp,
        fingerprint: oauth.credentialFingerprint(successor),
      });
      stashedReason = reason;
      this.logger.warning(note, accountNum);
    };

    let outcomeCreds = successor;
    try {
      try {
        await holdAsync([this.lockFile], [() => enterFileLock(this.lockFile)], () => {
          const [storeNow, storeUnreadable] = this.readAccountCredentialsEx(accountNum, email);
          if (storeUnreadable) {
            // The CAS cannot be evaluated. The grant is spent and the slot can
            // still hold the generation that spent it: stash AND demote.
            stashSuccessor(
              "consume-gate-store-unreadable",
              "Account %s's stored credential was unreadable " +
                "(keychain) after a refresh POST; successor " +
                "stashed, nothing rewritten.",
            );
          } else if (!storeNow) {
            // The slot was emptied during the POST. A write-back would bring back deleted credentials.
            stashSuccessor(
              "consume-gate-slot-removed",
              "Account %s's stored credential disappeared " +
                "during a refresh POST; successor stashed, " +
                "nothing rewritten.",
            );
          } else if (oauth.credentialFingerprint(storeNow) !== consumedFp) {
            // A writer replaced the lineage during the POST: stash ours, adopt the newer one.
            stashSuccessor(
              "consume-gate-cas-conflict",
              "Backup lineage for account %s moved during a " +
                "refresh POST; successor stashed, adopting the " +
                "newer store credential.",
            );
            outcomeCreds = storeNow;
          } else {
            this.writeAccountCredentials(accountNum, email, successor);
          }
        });
      } catch (e) {
        if (!(e instanceof LockError)) throw e;
        // The grant IS consumed: the successor must survive without the persist lock.
        stashSuccessor(
          "consume-gate-persist-lock-failed",
          "Slot lock unavailable after consuming account %s's grant; successor stashed for the next pass.",
        );
      }
    } catch (e) {
      // The grant IS consumed and the callers promise never to throw. The stash
      // is the last resort. If it fails too, the successor lives only in the return value.
      this.logger.warning("Persisting account %s's refreshed credential failed; stashing instead.", accountNum, {
        excInfo: e,
      });
      try {
        stashSuccessor(
          "consume-gate-persist-failed",
          "Persist failed after consuming account %s's grant; successor stashed for the next pass.",
        );
      } catch (stashError) {
        stashedReason = "consume-gate-unpersisted";
        this.logger.error(
          "Account %s's consumed successor could not be persisted " +
            "or stashed — it survives only for this pass. Fix the " +
            "storage failure, then re-login and `cswap add` if the " +
            "slot strikes.",
          accountNum,
          { excInfo: stashError },
        );
      }
    }
    if (DEMOTING_STASH_REASONS.includes(stashedReason)) {
      // The slot still holds the spent generation. A null error would tell the
      // caller to activate it, and Claude Code would then log the account out.
      // Report transient: the next pass adopts the stash. The credentials still
      // come back, for a caller that needs a live token for this request only.
      return oauth.refreshOutcome(outcomeCreds, "transient", {
        tokenAccount: result.tokenAccount,
        consumedFp,
        // Only `consume-gate-unpersisted` wrote no stash entry.
        stashed: stashedReason !== "consume-gate-unpersisted",
      });
    }
    return oauth.refreshOutcome(outcomeCreds, null, { tokenAccount: result.tokenAccount, consumedFp });
  }

  /**
   * Drop one stash entry. Never fatal: the important call runs after the
   * adoption already advanced the slot, and a throw there reads as a failed
   * refresh, so the caller would POST a consumed generation again.
   */
  retireStashEntry(entryId: string, accountNum: string): void {
    try {
      this.store.removeUnclaimedCredential(entryId);
    } catch (e) {
      this.logger.warning(
        "Could not retire account %s's stash entry %s; leaving it for " +
          "the next pass (`cswap unclaimed --purge` drops it by hand).",
        accountNum,
        entryId,
        { excInfo: e },
      );
    }
  }

  /**
   * Complete the failed persist of an earlier gate from the unclaimed stash.
   *
   * A stash entry records `consumedFp`, the generation that its credential
   * replaced. If the slot still stores that generation, write the successor
   * back and drop the entry. Return the adopted credentials, or null. The caller holds the slot `FileLock`.
   */
  adoptStashedSuccessor(accountNum: string, email: string, current: string): string | null {
    const curFp = oauth.credentialFingerprint(current);
    if (!curFp) return null;
    // An entry that is unreadable now must not stop the scan before a readable sibling on the same generation.
    let deferredEntryId: string | null = null;
    const [manifest, manifestVerdict] = this.store.readStashManifestEx();
    if (manifestVerdict === "unreadable" || (manifestVerdict === "corrupt" && this.store.stashEntryFilesExist())) {
      // The rows cannot be established. An empty scan would make the caller
      // POST a spent generation and quarantine a live account. A corrupt
      // manifest with no entry files falls through: then there is provably no
      // pending successor, and the next manifest write repairs the file.
      throw new CredentialReadError(
        `the unclaimed manifest is ${manifestVerdict} and stashed ` +
          `entry files exist; deferring account ${accountNum}'s ` +
          "adoption rather than POSTing a generation a stashed " +
          "successor may already have superseded (`cswap unclaimed` " +
          "lists them, `--purge` drops one)",
      );
    }
    for (const [entryId, rawMeta] of Object.entries(manifest)) {
      const meta = (isRecord(rawMeta) ? rawMeta : {}) as Record<string, unknown>;
      if (meta.configSlot !== accountNum) continue;
      if (meta.consumedFp !== curFp) {
        if (meta.reason === "consume-gate-cas-conflict") {
          // A CAS-conflict entry can never match: the store only moves forward.
          // Retire it here, where the slot lock and the current generation are at hand.
          this.retireStashEntry(entryId, accountNum);
          this.logger.info(
            "Retired account %s's CAS-conflict stash entry: its " +
              "generation was superseded by the writer that won the " +
              "race, so no pass can ever adopt it.",
            accountNum,
          );
        } else {
          const [bytes, unreadable] = this.store.readUnclaimedCredential(entryId);
          if (!bytes && !unreadable) {
            // No bytes and no matching generation: nothing can adopt it. An
            // UNREADABLE row stays: its bytes can hold a real superseded token.
            this.retireStashEntry(entryId, accountNum);
            this.logger.info(
              "Retired account %s's byte-less stash entry: its " +
                "credential is gone and its generation has passed, " +
                "so no pass could ever adopt it.",
              accountNum,
            );
          }
        }
        continue;
      }
      const [creds, unreadable] = this.store.readUnclaimedCredential(entryId);
      if (unreadable) {
        // The SOLE copy of a consumed generation. Keep looking for a readable sibling first.
        if (deferredEntryId === null) deferredEntryId = entryId;
        continue;
      }
      if (!creds) {
        // Absent or corrupt: the bytes are gone for good. Retire the row.
        this.retireStashEntry(entryId, accountNum);
        this.logger.info(
          "Retired account %s's unreadable-bytes stash entry: its generation is gone, so no pass could ever adopt it.",
          accountNum,
        );
        continue;
      }
      // The wrapper contains the session invalidation and cannot throw past its store write.
      this.writeAccountCredentials(accountNum, email, creds);
      this.retireStashEntry(entryId, accountNum);
      this.logger.info(
        "Adopted account %s's stashed successor (%s): the stored " +
          "generation was already consumed by the gate pass that " +
          "stashed it.",
        accountNum,
        meta.reason ?? "unknown",
      );
      return creds;
    }
    if (deferredEntryId !== null) {
      // The caller turns this into "transient" and defers, and the generation stays.
      throw new CredentialReadError(
        `stash entry ${deferredEntryId} for account ${accountNum} ` +
          "is unreadable; deferring adoption rather than discarding " +
          "its generation",
      );
    }
    return null;
  }

  /** Record the active-read verdict of this async call chain. */
  recordActiveVerdict(active: ActiveCredentials | null): void {
    this.activeVerdictStore.enterWith(active);
  }

  /** Wrap `fn` so that it runs with the verdict of the current call chain. */
  withActiveVerdict<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const verdict = this.activeVerdictStore.getStore() ?? null;
    return (...args: A) => this.activeVerdictStore.run(verdict, () => fn(...args));
  }

  /** The active-read verdict of this call chain. A clean one if it never read. */
  activeVerdict(): ActiveCredentials {
    return this.activeVerdictStore.getStore() ?? CLEAN_VERDICT;
  }

  get activeKeychainUnavailable(): boolean {
    return this.activeVerdict().keychainUnavailable;
  }

  /**
   * True if the active read of this call chain FAILED (plaintext-file error),
   * not a real absence. Off macOS, `value === null` is the only signal of a failed read.
   */
  get activeReadUnreadable(): boolean {
    return this.activeVerdict().value === null;
  }

  get activeReadDegraded(): boolean {
    return Boolean(this.activeVerdict().degraded);
  }

  /** `[value, unreadable]`: the backup read with its tri-state verdict. */
  readAccountCredentialsEx(accountNum: string, email: string): [string, boolean] {
    return this.store.readAccountCredentialsEx(accountNum, email);
  }

  /**
   * The safety copies that switches preserved (diagnostics only). The entries
   * are never consumed automatically. The recovery is `/login` + `cswap add [--slot N]`.
   */
  listUnclaimedCredentials(): Record<string, Record<string, unknown>> {
    return this.store.listUnclaimedCredentials();
  }

  sessionDir(accountNum: string, email: string): string {
    return session.sessionDirFor(this.backupDir, accountNum, email);
  }

  /** Token-status lines of one account row, labelled by credential source. */
  tokenStatusLines(accountInfo: AccountInfoRow): string[] {
    const [num, email, , orgUuid, isActive, creds] = accountInfo;
    if (looksLikeApiKey(creds)) return [];
    if (isActive) {
      const line = labelTokenStatus("active profile", creds);
      return line !== null ? [line] : [];
    }

    const lines: string[] = [];
    const sessionDir = this.sessionDir(String(num), email);
    const sessionCreds = session.readSessionCredentials(sessionDir);
    if (sessionCreds) {
      if (session.sessionIdentityDrifted(sessionDir, email, orgUuid)) {
        lines.push("session profile: ignored (different account)");
      } else {
        const line = labelTokenStatus("session profile", sessionCreds);
        if (line !== null) lines.push(line);
      }
    }
    const backupLine = labelTokenStatus("stored backup", creds);
    if (backupLine !== null) lines.push(backupLine);
    return lines;
  }

  /**
   * The PIDs of Claude instances that run against the session profile of an
   * account. An unreadable record gives no PID: a destructive guard must use
   * `ensureNoLiveSession`, which also counts the unreadable records.
   */
  liveSessionPids(accountNum: string, email: string): number[] {
    const [sessions] = session.scanLiveSessions(this.sessionDir(accountNum, email));
    return sessions.map((s) => s.pid);
  }

  /**
   * Refuse a destructive operation while a session-mode claude is live. A
   * record that cannot be read also refuses, with its own message.
   */
  ensureNoLiveSession(accountNum: string, email: string, action: string): void {
    const pids = this.liveSessionPids(accountNum, email);
    if (pids.length > 0) {
      throw new SessionError(
        `Account-${accountNum} (${email}) has a live session-mode Claude ` +
          `instance (PID ${pids.join(", ")}). ` +
          `Exit it first, then retry ${action}.`,
      );
    }
    const sessionDir = this.sessionDir(accountNum, email);
    const [, unreadable] = session.scanLiveSessions(sessionDir);
    if (unreadable) {
      throw new SessionError(
        `Account-${accountNum} (${email}) has ${unreadable} session ` +
          "record(s) that could not be read, so whether a Claude " +
          "instance is live cannot be determined. Inspect " +
          `${path.join(sessionDir, "sessions")} and remove or repair them, then ` +
          `retry ${action}.`,
      );
    }
  }

  /**
   * Drop the credential material of a session profile and keep its history.
   * The next `cswap run` fails the reuse check and re-bootstraps from the backup.
   */
  invalidateSessionCredentials(accountNum: string, email: string): void {
    const sessionDir = this.sessionDir(accountNum, email);
    if (!fs.existsSync(sessionDir)) return;
    session.deleteMacosKeychainEntry(sessionDir);
    fs.rmSync(path.join(sessionDir, ".credentials.json"), { force: true });
    session.clearSessionStale(sessionDir);
    this.logger.info(`Invalidated session credentials for account ${accountNum}`);
  }

  /**
   * The credential of the session profile if it is a newer generation of the
   * family of this slot than the stored backup, else null.
   *
   * Claude rotates the family inside the profile and the backup does not
   * follow. Generations differ by fingerprint and order by `expiresAt`. Null
   * for a profile that points at another account, a stale-marked profile, and
   * anything unreadable (a read error is not evidence of drift).
   */
  sessionProfileAhead(accountNum: string, email: string, orgUuid: string): string | null {
    const sessionDir = this.sessionDir(accountNum, email);
    if (session.isSessionStale(sessionDir)) return null;
    const profile = session.readSessionCredentials(sessionDir);
    if (!profile || session.sessionIdentityDrifted(sessionDir, email, orgUuid)) return null;
    const [backup, unreadable] = this.readAccountCredentialsEx(accountNum, email);
    if (unreadable) return null;
    if (oauth.credentialFingerprint(profile) === oauth.credentialFingerprint(backup)) return null;
    const issued = oauth.extractOauthData(profile) ?? {};
    const stored = oauth.extractOauthData(backup) ?? {};
    const issuedExp = pyFloat(issued.expiresAt || 0);
    const storedExp = pyFloat(stored.expiresAt || 0);
    if (issuedExp === null || storedExp === null) return null;
    return issuedExp > storedExp ? profile : null;
  }

  /**
   * Capture the credential of a quiet session profile into the slot backup.
   *
   * The complement of `postBackupWrite`: here the backup follows the profile.
   * Without it, a switch activates a consumed generation, and the collector
   * POSTs a dead grant. Only while the profile is quiet, and under the lock of
   * cswap. The store write is the pure one: `postBackupWrite` would invalidate
   * the profile that was just captured. Return true if the backup changed.
   */
  adoptSessionCredential(accountNum: string, email: string, orgUuid: string): boolean {
    const sessionDir = this.sessionDir(accountNum, email);
    const adopted = holdSync([() => enterFileLock(this.lockFile)], () => {
      if (!session.profileIsQuiescent(sessionDir)) return false;
      const profile = this.sessionProfileAhead(accountNum, email, orgUuid);
      if (profile === null) return false;
      this.store.writeAccountCredentials(accountNum, email, profile);
      return true;
    });
    if (!adopted) return false;
    this.logger.info(`Adopted account ${accountNum}'s session profile credential into its backup`);
    return true;
  }

  /**
   * Remove the session profile dir of an account and its keychain entry.
   *
   * WARNING: Delete the keychain entry first. Its hashed service name comes
   * from the dir path. The stale marker is a sibling of the dir, so clear it
   * explicitly, also when the dir is missing.
   */
  deleteSessionProfile(accountNum: string, email: string): void {
    const sessionDir = this.sessionDir(accountNum, email);
    if (fs.existsSync(sessionDir)) {
      session.deleteMacosKeychainEntry(sessionDir);
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch (e) {
        // `shutil.rmtree(ignore_errors=True)`: the check below reports what stays.
        if (!isOsError(e)) throw e;
      }
    }
    const cleared = session.clearSessionStale(sessionDir);
    if (fs.existsSync(sessionDir) || !cleared) {
      this.logger.warning(
        "Could not fully remove account %s's session profile at %s; " +
          "credentials are gone but the profile dir and/or its stale " +
          "marker survive (check permissions on it and its parent).",
        accountNum,
        sessionDir,
      );
      return;
    }
    this.logger.info(`Removed session profile for account ${accountNum} at ${sessionDir}`);
  }

  /** Create `sequence.json` if it does not exist. */
  initSequenceFile(): void {
    if (!fs.existsSync(this.sequenceFile)) {
      const initData: SequenceData = {
        activeAccountNumber: null,
        lastUpdated: getTimestamp(),
        sequence: [],
        accounts: {},
      };
      this.writeJson(this.sequenceFile, initData);
    }
  }

  /**
   * The roster. Null ONLY when it does not exist yet. A torn or unreadable
   * `sequence.json` throws `ConfigError`: callers that write the result back
   * would otherwise rebuild the roster from nothing.
   */
  getSequenceData(): SequenceData | null {
    return this.readJson(this.sequenceFile, { strict: true }) as SequenceData | null;
  }

  getNextAccountNumber(): number {
    const data = this.getSequenceData();
    if (!truthyDict(data) || !truthyDict(data.accounts)) return 1;
    const nums = Object.keys(accountsOf(data)).map((k) => pyInt(k));
    return Math.max(0, ...nums) + 1;
  }

  /** The current `[email, organizationUuid]` from `.claude.json`. */
  getCurrentAccount(): [string, string] | null {
    const triple = this.getCurrentIdentityTriple();
    return triple === null ? null : [triple[0], triple[1]];
  }

  /**
   * `[email, orgUuid, accountUuid]` from ONE read of `.claude.json`. Two reads
   * could pair the token of one account with the metadata of another.
   */
  getCurrentIdentityTriple(): [string, string, string] | null {
    const configPath = this.getClaudeConfigPath();
    if (!fs.existsSync(configPath)) return null;
    const data = this.readJson(configPath);
    if (!truthyDict(data)) return null;
    const oauthAccount = isRecord(data.oauthAccount) ? data.oauthAccount : {};
    const email = textOf(pyGet(oauthAccount, "emailAddress", ""));
    if (!email) return null;
    return [email, textOf(oauthAccount.organizationUuid), textOf(oauthAccount.accountUuid)];
  }

  /**
   * True if the live config identity is `(email, orgUuid)` now. The re-check
   * under the lock: a switch or `/login` between the read of a caller and its
   * lock changes this identity. The org counts: two slots can share an email.
   */
  liveIdentityMatches(email: string, orgUuid: string): boolean {
    const identity = this.getCurrentAccount();
    return identity !== null && identity[0] === email && identity[1] === (orgUuid || "");
  }

  /**
   * True if an oracle-resolved identity is the account of this slot. Uuid first.
   *
   * - true: the same account (a uuid match with a compatible org, or, for a
   *   slot with no uuid, an exact `(email, org)` match with the org present).
   * - false: another account. Safe to cache.
   * - null: unverifiable. Treat it like a probe failure: never cache it.
   */
  resolvedMatchesSlotIdentity(accountNum: string, resolved: oauth.AccountIdentity): boolean | null {
    const own = this.accountIdentity(accountNum);
    const rUuid = textOf(resolved.uuid).trim();
    const rEmail = resolved.email;
    const rOrg = resolved.organizationUuid;
    if (rUuid && own.uuid) {
      // The uuid is unique. The org only confirms it, so a missing org on either side is accepted.
      return rUuid === own.uuid && (!rOrg || !own.organizationUuid || rOrg === own.organizationUuid);
    }
    // No stored uuid. The same email can exist across orgs, so only an exact
    // `(email, org)` match with the org present affirms. On a match, store the uuid.
    if (rEmail && rEmail === own.email) {
      if (rOrg === null || rOrg === undefined) return null;
      if ((rOrg || "") === own.organizationUuid) {
        this.backfillAccountUuid(accountNum, rUuid, rEmail, rOrg || "");
        return true;
      }
      return false;
    }
    if (rEmail && rOrg !== null && rOrg !== undefined) return false;
    return null;
  }

  /**
   * The `probeVerdicts` key of a credential lineage. It binds the email of the
   * caller and the full stored identity of the slot (email, org, uuid), so a
   * slot that was created again for another account does not get the verdicts
   * of the old one. Build it at each lookup.
   */
  lineageKey(accountNum: string, email: string, fingerprint: string): string {
    const own = this.accountIdentity(accountNum);
    return JSON.stringify([accountNum, email, own.email, own.organizationUuid, own.uuid, fingerprint]);
  }

  /** The slot of the account that matches `(email, organizationUuid)`, else null. */
  static findAccountSlot(data: SequenceData, email: string, organizationUuid: string): string | null {
    for (const [num, account] of Object.entries(accountsOf(data))) {
      if (account.email === email && pyGet(account, "organizationUuid", "") === organizationUuid) return num;
    }
    return null;
  }

  /** True if an account exists with the `(email, organizationUuid)` key. */
  accountExists(email: string, organizationUuid: string): boolean {
    const data = this.getSequenceData();
    if (!truthyDict(data)) return false;
    return ClaudeAccountSwitcher.findAccountSlot(data, email, organizationUuid) !== null;
  }

  /** The stored kind of a slot: `"api_key"` or `"oauth"`. A slot with no `kind` is OAuth. */
  accountKind(accountNum: string | null): "api_key" | "oauth" {
    if (accountNum === null) return "oauth";
    const data = this.getSequenceData() ?? {};
    const record = recordOf(data, String(accountNum)) ?? {};
    return record.kind === "api_key" ? "api_key" : "oauth";
  }

  /**
   * Refuse if the active identity changed during the ownership check. A
   * `/login` in that window puts the identity of one account on the credential of another.
   */
  rejectIdentityDriftSinceVerify(verified: readonly [string, string, string]): void {
    const now = this.getCurrentIdentityTriple();
    if (now !== null && now[0] === verified[0] && now[1] === verified[1] && now[2] === verified[2]) return;
    throw new ConfigError(
      `The active account changed while ${verified[0]} was being ` +
        `verified (now ${(now ? now[0] : "") || "unknown"}). Nothing ` +
        "was changed. Re-run when no other login is in flight.",
    );
  }

  /**
   * Refuse if the credential lineage rotated during the ownership check. The
   * fingerprint hashes the refresh token, so a difference means the lineage
   * advanced. An unreadable store is unverifiable, not a refusal.
   */
  rejectCredentialDriftSinceVerify(verified: string): void {
    let now: string | null;
    try {
      now = this.readCaptureCredentials();
    } catch {
      return;
    }
    if (!now) return;
    const before = oauth.credentialFingerprint(verified);
    const after = oauth.credentialFingerprint(now);
    if (before === null || after === null || before === after) return;
    throw new ConfigError(
      "The stored credential rotated while it was being verified. " +
        "Nothing was changed. Registering the pre-rotation generation " +
        "would hand the slot a credential the server has already " +
        "retired. Re-run when no refresh is in flight.",
    );
  }

  /**
   * Guard for `addAccount`: the stored token must belong to THIS account.
   *
   * The identity comes from `.claude.json` and the credential from the
   * credential store, and nothing makes them agree. The profile endpoint
   * answers "whose token is this". Uuid first; the email decides only when the
   * slot has no uuid. The org is checked on both paths.
   *
   * An expired access token is unresolvable here, not refreshed: spending the
   * grant is a coordinated transition everywhere else. ADVISORY: an
   * unresolvable answer never blocks. Only a resolved identity that disagrees refuses.
   */
  async rejectForeignCredentialCapture(
    creds: string,
    email: string,
    orgUuid: string,
    accountUuid: string,
  ): Promise<string> {
    const unverified = (why: string): string => {
      print(
        `${accent("Notice:")} could not verify that the stored ` +
          `credential belongs to ${email} (${why}). Registering anyway; ` +
          "re-run where the check can complete to confirm.",
      );
      return creds;
    };

    const token = oauth.extractAccessToken(creds);
    if (!token) return unverified("no access token to resolve");
    const oauthData = oauth.extractOauthData(creds);
    if (oauthData && oauth.isOauthTokenExpired(oauthData.expiresAt)) {
      return unverified("the access token is expired");
    }
    const profile = await oauth.fetchOauthProfile(token);
    if (!profile) return unverified("the identity lookup did not resolve");
    const seenUuid = textOf(profile.uuid).trim();
    if (accountUuid) {
      // A match falls through to the org check below.
      if (seenUuid !== accountUuid) {
        throw new ConfigError(
          `The stored credential does not belong to ${email}: the ` +
            `token resolves to account ${seenUuid}, not ${accountUuid}. ` +
            "Nothing was changed. This happens when the config names " +
            "one account while the credential store still holds " +
            "another's token (e.g. a renamed .claude.json over a live " +
            `keychain item). Log in as ${email} in THIS environment, ` +
            "then re-run.",
        );
      }
    } else {
      const seen = textOf(profile.email).trim();
      if (!seen) return unverified("the resolved identity carries no address");
      if (seen.toLowerCase() !== email.toLowerCase()) {
        throw new ConfigError(
          `The stored credential does not belong to ${email}: the ` +
            `token resolves to ${seen}. Nothing was changed. This ` +
            "happens when the config names one account while the " +
            "credential store still holds another's token (e.g. a " +
            "renamed .claude.json over a live keychain item). Log in " +
            `as ${email} in THIS environment, then re-run.`,
        );
      }
    }
    const resolvedOrg = profile.organizationUuid;
    if (resolvedOrg === null || resolvedOrg === undefined) return creds;
    const seenOrg = resolvedOrg.trim();
    if (seenOrg === (orgUuid || "")) return creds;
    throw new ConfigError(
      `The stored credential for ${email} belongs to organization ` +
        `${seenOrg || "personal"}, not ${orgUuid || "personal"}. ` +
        "Nothing was changed. Two accounts can share an email " +
        `across organizations. Log in as ${email} in the ` +
        `${orgUuid || "personal"} organization in THIS environment, ` +
        "then re-run.",
    );
  }

  /** Guard for `addAccount`: never capture a live managed API key as an OAuth account. */
  rejectLiveApiKeyCapture(creds: string): void {
    if (looksLikeApiKey(creds)) {
      throw new ValidationError(
        "Active login is an API-key account. Add it with " +
          "'cswap --add-token sk-ant-api...' instead of --add-account.",
      );
    }
  }

  /**
   * Refuse a token whose `(email, personal org)` already exists as the OTHER
   * kind. The identity key has no kind, so the two could not be told apart at switch time.
   */
  rejectCrossKindCollision(email: string, isApiKey: boolean): void {
    const data = this.getSequenceData();
    if (!truthyDict(data)) return;
    const slot = ClaudeAccountSwitcher.findAccountSlot(data, email, "");
    if (slot === null) return;
    const existingKind = this.accountKind(slot);
    const newKind = isApiKey ? "api_key" : "oauth";
    if (existingKind !== newKind) {
      const existingLabel = existingKind === "api_key" ? "API-key" : "OAuth";
      const newLabel = isApiKey ? "API-key" : "OAuth";
      throw new ValidationError(
        `'${email}' already exists as an ${existingLabel} account ` +
          `(slot ${slot}); cannot add it as an ${newLabel} account. ` +
          "Pass a distinct --email.",
      );
    }
  }

  /** The display tag of the org context of an account. */
  static getDisplayTag(_email: string, orgName: string, _orgUuid: string): string {
    return orgName ? orgName : "personal";
  }

  /**
   * The number of the account whose alias matches (case-insensitive), or
   * null. An empty alias never matches.
   */
  findAccountByAlias(alias: string): string | null {
    if (!alias) return null;
    const data = this.getSequenceData();
    if (!truthyDict(data)) return null;
    const aliasKey = alias.toLowerCase();
    for (const [num, account] of Object.entries(accountsOf(data))) {
      if (textOf(account.alias).toLowerCase() === aliasKey) return num;
    }
    return null;
  }

  /** The number of the account that uses `alias` (other than `excludeNum`), or null. */
  aliasInUse(alias: string, { excludeNum = null }: { excludeNum?: string | null } = {}): string | null {
    const num = this.findAccountByAlias(alias);
    if (num !== null && num === excludeNum) return null;
    return num;
  }

  /**
   * Resolve an account identifier to an account number: number, then alias, then email.
   * Throws `ConfigError` if the email matches more than one account.
   */
  resolveAccountIdentifier(identifier: string): string | null {
    if (isDigits(identifier)) return identifier;

    const data = this.getSequenceData();
    if (!truthyDict(data)) return null;

    const aliasMatch = this.findAccountByAlias(identifier);
    if (aliasMatch !== null) return aliasMatch;

    const accounts = accountsOf(data);
    const matches = Object.entries(accounts)
      .filter(([, account]) => account.email === identifier)
      .map(([num]) => num);

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0]!;

    const details = matches.map((num) => `${num} [${accounts[num]!.organizationName || "personal"}]`).join(", ");
    throw new ConfigError(
      `Email '${identifier}' is ambiguous — matches accounts: ${details}. ` +
        "Use account number instead (e.g., cswap --switch-to 1).",
    );
  }

  /** The roster, after the org-field migration ran. */
  getSequenceDataMigrated(): SequenceData | null {
    let data = this.getSequenceData();
    if (!truthyDict(data)) return data;
    const needsMigration = Object.values(accountsOf(data)).some((acc) => !Object.hasOwn(acc, "organizationUuid"));
    if (needsMigration) {
      this.migrateOrgFields();
      data = this.getSequenceData();
    }
    return data;
  }

  /**
   * Fill `organizationUuid`/`organizationName` for accounts added before the
   * org support. The active account takes them from the live config, the
   * others from their config backups.
   */
  migrateOrgFields(): void {
    const data = this.getSequenceData();
    if (!truthyDict(data)) return;

    let liveEmail = "";
    let liveOrgUuid = "";
    let liveOrgName = "";
    const configPath = this.getClaudeConfigPath();
    if (fs.existsSync(configPath)) {
      try {
        const configData = this.readJson(configPath);
        if (truthyDict(configData)) {
          const oauthAccount = (configData.oauthAccount ?? {}) as Record<string, unknown>;
          liveEmail = textOf(pyGet(oauthAccount, "emailAddress", ""));
          liveOrgUuid = textOf(oauthAccount.organizationUuid);
          liveOrgName = textOf(oauthAccount.organizationName);
        }
      } catch {
        // An unreadable live config gives no org fields.
      }
    }

    let updated = false;
    for (const [num, account] of Object.entries(accountsOf(data))) {
      if (Object.hasOwn(account, "organizationUuid")) continue;

      const email = textOf(pyGet(account, "email", ""));

      // The live config is authoritative for the active account.
      if (email === liveEmail && liveEmail) {
        account.organizationUuid = liveOrgUuid;
        account.organizationName = liveOrgName;
        updated = true;
        continue;
      }

      const configText = this.readAccountConfig(num, email);
      if (configText) {
        try {
          const configData = JSON.parse(configText) as unknown;
          if (!isRecord(configData)) throw new TypeError("not a dict");
          const oauthAccount = configData.oauthAccount ?? {};
          if (!isRecord(oauthAccount)) throw new TypeError("not a dict");
          account.organizationUuid = textOf(oauthAccount.organizationUuid);
          account.organizationName = textOf(oauthAccount.organizationName);
        } catch (e) {
          if (!(e instanceof SyntaxError || e instanceof TypeError)) throw e;
          account.organizationUuid = "";
          account.organizationName = "";
        }
      } else {
        account.organizationUuid = "";
        account.organizationName = "";
      }
      updated = true;
    }

    if (updated) {
      data.lastUpdated = getTimestamp();
      this.writeJson(this.sequenceFile, data);
    }
  }

  /** Ask `[y/N]` to overwrite an occupied slot. Return false if the user cancels. */
  private confirmOverwrite(slot: number): boolean {
    let answer: string;
    try {
      answer = internals.input(`Overwrite slot ${slot}? [y/N] `).trim().toLowerCase();
    } catch (e) {
      if (!(e instanceof EOFError)) throw e;
      print(`\n${dimmed("Cancelled")}`);
      return false;
    }
    if (answer !== "y" && answer !== "yes") {
      print(dimmed("Cancelled"));
      return false;
    }
    return true;
  }

  /** Read the live config text for a backup. */
  private readLiveConfigText(configPath: string): string {
    try {
      return fs.readFileSync(configPath, "utf8");
    } catch (e) {
      if (isFileNotFound(e)) throw new ConfigError("Claude config file not found");
      if (isPermissionError(e)) throw new ConfigError("Permission denied reading Claude config");
      throw e;
    }
  }

  /**
   * Add the current account to the managed accounts.
   *
   * - `slot`: the slot number to use. Null gives the next free number. An
   *   occupied slot of another account asks for a confirmation.
   * - `assumeYes`: skip that prompt (callers with their own confirmation UI).
   * - `alias`: an optional display alias. If omitted, the alias of the slot stays.
   */
  async addAccount(slot: number | null = null, assumeYes = false, alias: string | null = null): Promise<void> {
    this.refuseSessionShell();
    this.setupDirectories();
    this.initSequenceFile();
    this.migrateOrgFields();

    if (alias !== null) {
      try {
        alias = normalizeAlias(alias);
      } catch (e) {
        if (e instanceof RangeError) throw new ValidationError(e.message);
        throw e;
      }
    }

    const identity = this.getCurrentIdentityTriple();
    if (identity === null) throw new ConfigError("No active Claude account found. Please log in first.");
    const [currentEmail, currentOrgUuid, currentAccountUuid] = identity;

    // No slot and a known account: refresh the credentials in place.
    if (slot === null && this.accountExists(currentEmail, currentOrgUuid)) {
      const seq = this.getSequenceData()!;
      const accountNum = ClaudeAccountSwitcher.findAccountSlot(seq, currentEmail, currentOrgUuid)!;
      const matchedOrgName = accountNum ? textOf(pyGet(recordOf(seq, accountNum), "organizationName", "")) : "";

      if (alias !== null) {
        const conflict = this.aliasInUse(alias, { excludeNum: accountNum });
        if (conflict !== null) throw new ValidationError(`Alias '${alias}' is already used by account ${conflict}`);
      }

      let currentCreds = this.readCaptureCredentials();
      if (currentCreds === null) throw new CredentialReadError("Failed to read credentials for current account");
      if (!currentCreds) throw new CredentialReadError("No credentials found for current account");
      this.rejectLiveApiKeyCapture(currentCreds);
      currentCreds = await this.rejectForeignCredentialCapture(
        currentCreds,
        currentEmail,
        currentOrgUuid,
        currentAccountUuid,
      );
      this.rejectCredentialDriftSinceVerify(currentCreds);

      const currentConfig = this.readLiveConfigText(this.getClaudeConfigPath());

      // After the read, because the check licenses those bytes. Compare the
      // triple that was read, never one rebuilt from its parts.
      this.rejectIdentityDriftSinceVerify(identity);

      this.writeAccountCredentials(accountNum, currentEmail, currentCreds);
      this.writeAccountConfig(accountNum, currentEmail, currentConfig);
      this.usageStore.clearDeadToken([accountNum], { [accountNum]: [currentEmail, currentOrgUuid] });

      if (alias !== null) recordOf(seq, accountNum)!.alias = alias;

      seq.activeAccountNumber = pyInt(accountNum);
      seq.lastUpdated = getTimestamp();
      this.writeJson(this.sequenceFile, seq);

      const tag = ClaudeAccountSwitcher.getDisplayTag(currentEmail, matchedOrgName, currentOrgUuid);
      this.logger.info(`Updated credentials for account ${accountNum}: ${currentEmail}`);
      print(`${accent("Updated credentials")} for Account ${accountNum} (${currentEmail} ${muted(`[${tag}]`)}).`);
      return;
    }

    // Decide the slot and collect the confirmations. Nothing destructive happens before the new account reads.
    let displaceSlot: [string, string, string] | null = null;
    let migrateFrom: string | null = null;
    let accountNum: string;
    let data: SequenceData = {};

    if (slot !== null) {
      if (slot < 1) throw new ConfigError("Slot number must be >= 1");
      accountNum = String(slot);
      data = this.getSequenceData()!;

      if (this.accountExists(currentEmail, currentOrgUuid)) {
        const oldNum = ClaudeAccountSwitcher.findAccountSlot(data, currentEmail, currentOrgUuid);
        if (oldNum && oldNum !== accountNum) migrateFrom = oldNum;
      }

      const existing = recordOf(data, accountNum);
      if (existing !== undefined) {
        const existingEmail = textOf(pyGet(existing, "email", "unknown"));
        const isSame = existingEmail === currentEmail && pyGet(existing, "organizationUuid", "") === currentOrgUuid;
        if (!isSame) {
          const existingTag = ClaudeAccountSwitcher.getDisplayTag(
            existingEmail,
            textOf(pyGet(existing, "organizationName", "")),
            textOf(pyGet(existing, "organizationUuid", "")),
          );
          warning(`Slot ${slot} already occupied`);
          print(`${existingEmail} ${muted(`[${existingTag}]`)}`);
          if (!assumeYes && !this.confirmOverwrite(slot)) return;
          displaceSlot = [accountNum, existingEmail, textOf(existing.organizationUuid)];
        }
      }
    } else {
      accountNum = String(this.getNextAccountNumber());
    }

    // Keep the alias before the cleanup below deletes the old record.
    let existingAlias: string | null = null;
    if (slot !== null) {
      const prior = recordOf(data, accountNum) ?? {};
      if (prior.email === currentEmail && pyGet(prior, "organizationUuid", "") === currentOrgUuid) {
        existingAlias = (prior.alias as string | undefined) ?? null;
      }
      if (migrateFrom) existingAlias = recordOf(data, migrateFrom)!.alias || existingAlias;
    }

    if (alias !== null) {
      const conflict = this.aliasInUse(alias, { excludeNum: accountNum });
      if (conflict !== null) throw new ValidationError(`Alias '${alias}' is already used by account ${conflict}`);
    }

    // Read the new credentials BEFORE any destructive operation.
    let currentCreds = this.readCaptureCredentials();
    if (currentCreds === null) throw new CredentialReadError("Failed to read credentials for current account");
    if (!currentCreds) throw new CredentialReadError("No credentials found for current account");
    this.rejectLiveApiKeyCapture(currentCreds);
    currentCreds = await this.rejectForeignCredentialCapture(currentCreds, currentEmail, currentOrgUuid, currentAccountUuid);
    this.rejectCredentialDriftSinceVerify(currentCreds);

    const configPath = this.getClaudeConfigPath();
    const currentConfig = this.readLiveConfigText(configPath);

    const configData = this.readJson(configPath) ?? {};
    const oauthAccount = (configData.oauthAccount ?? {}) as Record<string, unknown>;
    const accountUuid = textOf(oauthAccount.accountUuid);
    const organizationUuid = textOf(oauthAccount.organizationUuid);
    const organizationName = textOf(oauthAccount.organizationName);

    this.rejectIdentityDriftSinceVerify(identity);

    // The new account data is in memory now, so the destructive cleanup is safe.
    if (displaceSlot) {
      const [dNum, dEmail, dOrg] = displaceSlot;
      this.deleteAccountFiles(dNum, dEmail);
      const fresh = this.getSequenceData()!;
      removeFromSequence(fresh, pyInt(dNum));
      delete accountsOf(fresh)[dNum];
      this.writeJson(this.sequenceFile, fresh);
      this.pruneMappings(dEmail, dOrg);
    }

    if (migrateFrom) {
      const fresh = this.getSequenceData()!;
      const oldEmail = textOf(pyGet(recordOf(fresh, migrateFrom), "email", ""));
      this.deleteAccountFiles(migrateFrom, oldEmail);
      removeFromSequence(fresh, pyInt(migrateFrom));
      delete accountsOf(fresh)[migrateFrom];
      this.writeJson(this.sequenceFile, fresh);
    }

    this.writeAccountCredentials(accountNum, currentEmail, currentCreds);
    this.writeAccountConfig(accountNum, currentEmail, currentConfig);
    this.usageStore.clearDeadToken([accountNum], { [accountNum]: [currentEmail, organizationUuid] });

    data = this.getSequenceData()!;
    const record: AccountRecord = {
      email: currentEmail,
      uuid: accountUuid,
      organizationUuid,
      organizationName,
      added: getTimestamp(),
    };
    accountsOf(data)[accountNum] = record;
    const carriedAlias = alias !== null ? alias : existingAlias;
    if (carriedAlias) record.alias = carriedAlias;
    addToSequence(data, pyInt(accountNum));
    data.activeAccountNumber = pyInt(accountNum);
    data.lastUpdated = getTimestamp();

    this.writeJson(this.sequenceFile, data);
    const tag = ClaudeAccountSwitcher.getDisplayTag(currentEmail, organizationName, organizationUuid);
    this.logger.info(`Added account ${accountNum}: ${currentEmail} (org: ${organizationUuid || "personal"})`);
    if (migrateFrom) print(dimmed(`Moved from slot ${migrateFrom} → ${slot}`));
    print(`${accent("Added")} Account ${accountNum}: ${currentEmail} ${muted(`[${tag}]`)}`);
  }

  /**
   * Register a raw OAuth setup-token or a managed API key as a new account,
   * with no Claude Code login on this machine and no Anthropic API call.
   *
   * - `token`: the token, `"-"` to read one line from stdin, or `""` to prompt with no echo.
   *   A value that starts with `sk-ant-api` is a managed API key, anything else a setup-token.
   * - `email`: the email of the account. The default is `setup-token-{slot}@token.local`
   *   (or `api-key-{slot}@token.local`): these tokens carry no email.
   * - `slot`: the slot number. Null gives the next free number.
   * - `assumeYes`: skip the occupied-slot prompt.
   */
  addAccountFromToken(token: string, email: string | null = null, slot: number | null = null, assumeYes = false): void {
    this.refuseSessionShell();

    if (token === "-") token = internals.readStdinLine();
    else if (!token) token = internals.getpass("Token: ");

    token = token.trim();
    if (!token) throw new ValidationError("Token cannot be empty");

    const isApiKey = looksLikeApiKey(token);

    if (email && !this.validateEmail(email)) throw new ValidationError(`Invalid email format: ${email}`);

    this.setupDirectories();
    this.initSequenceFile();
    this.migrateOrgFields();

    // These tokens have no email. The slot number makes each default unique.
    if (!email) {
      if (slot === null) slot = this.getNextAccountNumber();
      const label = isApiKey ? "api-key" : "setup-token";
      email = `${label}-${slot}@token.local`;
    }

    this.rejectCrossKindCollision(email, isApiKey);

    // A managed key is stored raw. A setup-token goes in the credential JSON of Claude Code.
    const credentials = isApiKey
      ? token
      : jsonDumps({ claudeAiOauth: { accessToken: token, scopes: [...SETUP_TOKEN_SCOPES] } });
    const config = jsonDumps({
      oauthAccount: {
        emailAddress: email,
        accountUuid: "",
        organizationUuid: null,
        organizationName: null,
      },
    });

    // A known account (same email, personal): refresh in place.
    if (slot === null && this.accountExists(email, "")) {
      const seq = this.getSequenceData()!;
      const accountNum = ClaudeAccountSwitcher.findAccountSlot(seq, email, "");
      if (accountNum === null) throw new ConfigError(`Existing account metadata for ${email} is inconsistent`);
      this.writeAccountCredentials(accountNum, email, credentials);
      this.writeAccountConfig(accountNum, email, config);
      // A new credential lifts a dead-token quarantine of the slot. Token accounts are personal.
      this.usageStore.clearDeadToken([accountNum], { [accountNum]: [email, ""] });
      seq.lastUpdated = getTimestamp();
      this.writeJson(this.sequenceFile, seq);
      const kindLabel = isApiKey ? "API key" : "token";
      this.logger.info(`Updated ${kindLabel} for account ${accountNum}: ${email}`);
      print(`${accent(`Updated ${kindLabel}`)} for Account ${accountNum} (${email} ${muted("[personal]")}).`);
      return;
    }

    let displaceSlot: [string, string, string] | null = null;
    let migrateFrom: string | null = null;
    let accountNum: string;

    if (slot !== null) {
      if (slot < 1) throw new ConfigError("Slot number must be >= 1");
      accountNum = String(slot);
      const data = this.getSequenceData()!;

      if (this.accountExists(email, "")) {
        const oldNum = ClaudeAccountSwitcher.findAccountSlot(data, email, "");
        if (oldNum && oldNum !== accountNum) migrateFrom = oldNum;
      }

      const existing = recordOf(data, accountNum);
      if (existing !== undefined) {
        const existingEmail = textOf(pyGet(existing, "email", "unknown"));
        const isSame = existingEmail === email && pyGet(existing, "organizationUuid", "") === "";
        if (!isSame) {
          const existingTag = ClaudeAccountSwitcher.getDisplayTag(
            existingEmail,
            textOf(pyGet(existing, "organizationName", "")),
            textOf(pyGet(existing, "organizationUuid", "")),
          );
          warning(`Slot ${slot} already occupied`);
          print(`${existingEmail} ${muted(`[${existingTag}]`)}`);
          if (!assumeYes && !this.confirmOverwrite(slot)) return;
          displaceSlot = [accountNum, existingEmail, textOf(existing.organizationUuid)];
        }
      }
    } else {
      accountNum = String(this.getNextAccountNumber());
    }

    if (displaceSlot) {
      const [dNum, dEmail, dOrg] = displaceSlot;
      this.deleteAccountFiles(dNum, dEmail);
      const fresh = this.getSequenceData()!;
      removeFromSequence(fresh, pyInt(dNum));
      delete accountsOf(fresh)[dNum];
      this.writeJson(this.sequenceFile, fresh);
      this.pruneMappings(dEmail, dOrg);
    }

    if (migrateFrom) {
      const fresh = this.getSequenceData()!;
      const oldEmail = textOf(pyGet(recordOf(fresh, migrateFrom), "email", ""));
      this.deleteAccountFiles(migrateFrom, oldEmail);
      removeFromSequence(fresh, pyInt(migrateFrom));
      delete accountsOf(fresh)[migrateFrom];
      this.writeJson(this.sequenceFile, fresh);
    }

    this.writeAccountCredentials(accountNum, email, credentials);
    this.writeAccountConfig(accountNum, email, config);
    // A new credential in a reused slot lifts the quarantine of the old lineage.
    this.usageStore.clearDeadToken([accountNum], { [accountNum]: [email, ""] });

    const data = this.getSequenceData()!;
    const record: AccountRecord = {
      email,
      uuid: "",
      organizationUuid: "",
      organizationName: "",
      added: getTimestamp(),
    };
    if (isApiKey) record.kind = "api_key";
    accountsOf(data)[accountNum] = record;
    addToSequence(data, pyInt(accountNum));
    data.lastUpdated = getTimestamp();

    this.writeJson(this.sequenceFile, data);
    const sourceLabel = isApiKey ? "API key" : "token";
    this.logger.info(`Added account ${accountNum} from ${sourceLabel}: ${email}`);
    if (migrateFrom) print(dimmed(`Moved from slot ${migrateFrom} → ${slot}`));
    print(`${accent("Added")} Account ${accountNum}: ${email} ${muted("[personal]")} ${muted(`(from ${sourceLabel})`)}`);
  }

  /** Ask which of several accounts with one email to use. Return the slot, or null if cancelled. */
  private chooseAmongEmailMatches(identifier: string, data: SequenceData, matches: string[], verb: string): string | null {
    print(`Multiple accounts found for '${identifier}':`);
    for (const num of matches) {
      const acc = recordOf(data, num)!;
      const tag = ClaudeAccountSwitcher.getDisplayTag(
        textOf(pyGet(acc, "email", "")),
        textOf(pyGet(acc, "organizationName", "")),
        textOf(pyGet(acc, "organizationUuid", "")),
      );
      print(`  ${num}: ${identifier} ${muted(`[${tag}]`)}`);
    }
    const choice = internals.input(`Enter account number to ${verb}: `).trim();
    if (!isDigits(choice) || !matches.includes(choice)) {
      print(dimmed("Cancelled"));
      return null;
    }
    return choice;
  }

  /**
   * Remove an account from the managed accounts. `assumeYes` skips the
   * confirmation prompt (the TUI asks before it calls).
   */
  removeAccount(identifier: string, assumeYes = false): void {
    this.refuseSessionShell();
    if (!fs.existsSync(this.sequenceFile)) throw new ConfigError("No accounts are managed yet");

    this.getSequenceDataMigrated();

    if (!isDigits(identifier)) {
      const isAlias = this.findAccountByAlias(identifier) !== null;
      if (!isAlias && !this.validateEmail(identifier)) throw new ValidationError(`Invalid account identifier: ${identifier}`);

      // An ambiguous email asks. Aliases are unique.
      if (!isAlias) {
        const data = this.getSequenceData() ?? {};
        const matches = Object.entries(accountsOf(data))
          .filter(([, acc]) => acc.email === identifier)
          .map(([num]) => num);
        if (matches.length > 1) {
          const choice = this.chooseAmongEmailMatches(identifier, data, matches, "remove");
          if (choice === null) return;
          identifier = choice;
        }
      }
    }

    const accountNum = this.resolveAccountIdentifier(identifier);
    if (!accountNum) throw new AccountNotFoundError(`No account found with identifier: ${identifier}`);

    const data = this.getSequenceData() ?? {};
    const accountInfo = recordOf(data, accountNum);
    if (!truthyDict(accountInfo)) throw new AccountNotFoundError(`Account-${accountNum} does not exist`);

    const email = accountInfo.email as string;
    const activeAccount = data.activeAccountNumber;

    // Check before the prompt. `deleteAccountFiles` checks again for every path.
    this.ensureNoLiveSession(accountNum, email, "--remove-account");

    if (String(activeAccount ?? "None") === accountNum) {
      warning(`Warning: Account-${accountNum} (${email}) is currently active`);
    }

    if (!assumeYes) {
      const confirm = internals.input(
        `Are you sure you want to permanently remove Account-${accountNum} (${email})? [y/N] `,
      );
      if (confirm.toLowerCase() !== "y") {
        print(dimmed("Cancelled"));
        return;
      }
    }

    this.deleteAccountFiles(accountNum, email);

    delete accountsOf(data)[accountNum];
    const n = pyInt(accountNum);
    data.sequence = sequenceOf(data).filter((x) => x !== n);
    data.lastUpdated = getTimestamp();

    this.writeJson(this.sequenceFile, data);
    this.logger.info(`Removed account ${accountNum}: ${email}`);
    print(`${accent("Removed")} Account-${accountNum} (${email})`);

    this.pruneMappings(email, textOf(pyGet(accountInfo, "organizationUuid", "")));
  }

  /**
   * One `AccountInfoRow` per account in the sequence. The active account
   * reads the live store of Claude Code, every other slot its backup copy.
   */
  buildAccountsInfo(): AccountInfoRow[] {
    const data = this.getSequenceDataMigrated() ?? {};
    const currentIdentity = this.getCurrentAccount();

    let activeNum: string | null = null;
    if (currentIdentity !== null) {
      const [currentEmail, currentOrgUuid] = currentIdentity;
      activeNum = ClaudeAccountSwitcher.findAccountSlot(data, currentEmail, currentOrgUuid);
    }

    const accountsInfo: AccountInfoRow[] = [];
    // Reset on each build. Set below only from the read of the active slot.
    this.recordActiveVerdict(null);
    for (const num of sequenceOf(data)) {
      const account = recordOf(data, String(num)) ?? {};
      const email = textOf(pyGet(account, "email", "unknown"));
      const orgName = textOf(account.organizationName);
      const orgUuid = textOf(account.organizationUuid);
      const alias = textOf(account.alias);
      const isActive = String(num) === activeNum;

      let creds: string;
      if (isActive) {
        const active = this.readActiveCredentials();
        creds = active.value || "";
        this.recordActiveVerdict(active);
      } else {
        creds = this.readAccountCredentials(String(num), email);
      }

      accountsInfo.push([num, email, orgName, orgUuid, isActive, creds, alias]);
    }
    return accountsInfo;
  }

  /**
   * Usage fetch for the active account. An expired token is refreshed under
   * the lock protocol of Claude Code, which adopts a credential that another
   * process rotated under the same locks.
   *
   * Two invariants:
   * - Provenance (issue #117): a live credential is only CONSUMED or WRITTEN
   *   into the slot backup if its lineage is attributed to the slot (backup
   *   lineage, an oracle verdict, or our own refresh POST). Unattributable dead
   *   live bytes are replaced from the usable backup of the slot.
   * - A consumed generation is never discarded: after the POST the successor
   *   goes to both stores, and the backup survives a failed live write.
   */
  async fetchActiveUsage(accountNum: string, email: string, creds: string, orgUuid = ""): Promise<FetchRecord> {
    const oauthData = oauth.extractOauthData(creds);
    if (!oauthData || !oauthData.accessToken) return { sentinel: USAGE_NO_CREDENTIALS };

    // A really expired token gets the sentinel. A locally valid token that the
    // server refused (forceRefresh) keeps its 401 record, so the store paces the retries.
    const defer = (record: FetchRecord | null): FetchRecord => record ?? { sentinel: USAGE_TOKEN_EXPIRED };

    let forceRefresh: FetchRecord | null = null;
    if (!oauth.isOauthTokenExpired(oauthData.expiresAt)) {
      const outcome = await internals.tryFetchUsageForAccount(accountNum, email, creds, true);
      if (outcome.error !== "http-401") {
        if (outcome.usage !== null) {
          // The server accepted this credential. If its lineage differs from the
          // backup, Claude Code rotated during normal use: resync the backup now.
          // Never from a DEGRADED read: the fallback bytes can be the consumed predecessor.
          if (!this.activeReadDegraded) await this.resyncRotatedBackup(accountNum, email, orgUuid, creds);
          if (
            this.probeVerdicts.size > 0 &&
            this.probeVerdicts.get(this.lineageKey(accountNum, email, oauth.credentialFingerprint(creds) ?? "")) === false
          ) {
            // The served credential belongs to another account. Its quota is not
            // this slot's quota: a failover switch repairs the drift.
            return { sentinel: USAGE_FOREIGN_CREDENTIAL };
          }
        }
        return { usage: outcome.usage, error: outcome.error, retryAfterS: outcome.retryAfterS };
      }
      // A locally valid token that the server refuses (revoked, or clock skew).
      // Refresh, like Claude Code does on a 401. Keep the 401 as the fallback record.
      forceRefresh = { error: outcome.error, retryAfterS: outcome.retryAfterS };
    }

    // A degraded read can serve a stale generation. Never consume its refresh token.
    if (this.activeReadDegraded) return defer(forceRefresh ?? { sentinel: USAGE_KEYCHAIN_UNAVAILABLE });

    // With CLAUDE_SECURESTORAGE_CONFIG_DIR set, the default store is stale by construction.
    if (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR) {
      this.logger.warning(
        "CLAUDE_SECURESTORAGE_CONFIG_DIR is set; cswap mirrors it " +
          "when capturing a credential but not when refreshing one, " +
          "so refusing to refresh account %s's active credential " +
          "(unset the variable or run from a normal shell).",
        accountNum,
      );
      return { error: "store-unmirrored" };
    }

    // The attribution against the backup decides HOW to recover: an attributable
    // live credential is refreshed, else a usable backup is restored.
    const backup = this.readAccountCredentials(accountNum, email);
    const backupFp = oauth.credentialFingerprint(backup);
    const backupOauth = oauth.extractOauthData(backup);
    const backupUsable = Boolean(backupOauth && backupOauth.accessToken && backupOauth.refreshToken);
    const attributable = creds === backup || oauth.credentialFingerprint(creds) === backupFp;
    const unattributableKey = warnKey(accountNum, email, "unattributable");
    if (!attributable && !backupUsable) {
      if (!this.provenanceWarned.has(unattributableKey)) {
        this.provenanceWarned.add(unattributableKey);
        this.logger.warning(
          "Active credential does not match Account-%s's stored " +
            "backup and the backup is unusable; cannot refresh " +
            "(provenance unknown).",
          accountNum,
        );
      }
      return defer(forceRefresh);
    }
    this.provenanceWarned.delete(unattributableKey);

    // The sequence of Claude Code: locks, re-read, decide, POST, persist, release.
    // Lock order as in the switch: the consume lock, the account lock, then the
    // credential locks of Claude Code. The config lock covers only the live write.
    const consumePath = path.join(this.credentialsDir, `.consume-${accountNum}.lock`);
    let working: string;
    try {
      const step = await holdAsync(
        [consumePath, this.lockFile],
        [
          () => enterFileLock(consumePath),
          () => enterFileLock(this.lockFile),
          () => claudeLocks.acquireClaudeCredentialsLock(),
        ],
        async (): Promise<{ record: FetchRecord } | { working: string }> => {
          const live = this.readCredentials();
          if (live === null) {
            // A read ERROR, not an absence. The store can hold a newer credential.
            return { record: defer(forceRefresh) };
          }
          const liveOauth = live ? oauth.extractOauthData(live) : null;
          // The identity re-check runs even for an empty or non-OAuth live blob:
          // a switch to an API-key account in the gap leaves that shape.
          if (!this.liveIdentityMatches(email, orgUuid)) return { record: defer(forceRefresh) };
          if (
            liveOauth &&
            live !== creds &&
            // A wiped or access-token-only blob must not be adopted.
            liveOauth.accessToken &&
            liveOauth.refreshToken &&
            !oauth.isOauthTokenExpired(liveOauth.expiresAt)
          ) {
            // A live Claude Code already rotated it: adopt, consume nothing.
            // Resync the backup only when the lineage is attributable now.
            const liveVerdict = this.probeVerdicts.get(
              this.lineageKey(accountNum, email, oauth.credentialFingerprint(live) ?? ""),
            );
            if (liveVerdict === false) {
              // Known foreign: the sentinel makes autoswitch fail over, which repairs the drift.
              return { record: { sentinel: USAGE_FOREIGN_CREDENTIAL } };
            }
            if (liveVerdict || oauth.credentialFingerprint(live) === backupFp) {
              try {
                this.writeAccountCredentials(accountNum, email, live);
              } catch {
                this.logger.warning(
                  "Backup resync after adopting a rotated " +
                    "credential failed for account %s; the next " +
                    "expiry may refuse to refresh until a " +
                    "switch resyncs it.",
                  accountNum,
                );
              }
            } else {
              this.logger.debug(
                "Adopted a rotated live credential for account " +
                  "%s without a lineage verdict; backup resync " +
                  "deferred to the next fresh pass's oracle " +
                  "check.",
                accountNum,
              );
            }
            return { working: live };
          }

          // Select the credential whose grant can be consumed:
          // - live, if its lineage matches the backup;
          // - the backup, if the live bytes moved to a dead foreign lineage or were cleared;
          // - what the collector read, as the last resort.
          // Live bytes that moved during the pass to a third lineage mean another actor writes now: defer.
          let restoreSource: string | null = null;
          let refreshInput: string;
          if (liveOauth !== null && oauth.credentialFingerprint(live) === backupFp) {
            refreshInput = liveOauth.refreshToken ? live : backupUsable ? backup : creds;
          } else if (!live) {
            refreshInput = backupUsable ? backup : creds;
          } else if (live === creds) {
            // The generation order SELECTS a candidate, but only an ownership verdict LICENSES its consumption.
            const liveExp = Number((liveOauth ?? {}).expiresAt || 0);
            const backupExp = backupOauth ? Number(backupOauth.expiresAt || 0) : 0;
            if (liveOauth && liveOauth.refreshToken && liveExp > backupExp) {
              if (this.probeVerdicts.get(this.lineageKey(accountNum, email, oauth.credentialFingerprint(live) ?? ""))) {
                refreshInput = live;
              } else {
                const key = warnKey(accountNum, email, "expiry-unattributed");
                if (!this.provenanceWarned.has(key)) {
                  this.provenanceWarned.add(key);
                  this.logger.warning(
                    "Live credential is newer than " +
                      "Account-%s's backup but its " +
                      "ownership is unverified; refresh " +
                      "deferred to Claude Code's next " +
                      "use.",
                    accountNum,
                  );
                }
                return { record: defer(forceRefresh) };
              }
            } else {
              refreshInput = backupUsable ? backup : creds;
            }
          } else {
            return { record: defer(forceRefresh) };
          }
          const inputOauth = oauth.extractOauthData(refreshInput);
          let workingCreds: string;
          if (
            refreshInput === backup &&
            backupUsable &&
            !forceRefresh &&
            inputOauth &&
            !oauth.isOauthTokenExpired(inputOauth.expiresAt)
          ) {
            // The backup already holds a live credential (an earlier persist
            // reached it but not the live store). Restore it: no POST.
            restoreSource = backup;
            workingCreds = backup;
          } else {
            // The POST runs under the account lock, which a switch waits for 10 s.
            // Bound it well inside that time.
            const result = await oauth.tryRefreshOauthCredentials(refreshInput, 6.0);
            if (
              result.error === "invalid_grant" ||
              result.error === "no_refresh_token" ||
              (result.error === null && !result.credentials)
            ) {
              // Before the slot is condemned, re-read the SOURCE of the sent bytes
              // (live against live, backup against backup). A lineage that moved
              // during the POST means we consumed a superseded copy: transient.
              let moved: boolean;
              try {
                const sourceNow =
                  refreshInput === backup ? this.readAccountCredentials(accountNum, email) : this.readCredentials() ?? "";
                moved =
                  Boolean(sourceNow) &&
                  oauth.credentialFingerprint(sourceNow) !== oauth.credentialFingerprint(refreshInput);
              } catch {
                moved = false;
              }
              if (moved) return { record: { error: "refresh-failed" } };
              // An ERROR, so the store counts the strike and the quarantine shows
              // "re-login needed". The strike binds to the consumed generation.
              return {
                record: {
                  error: result.error ?? "invalid_grant",
                  struckFp: oauth.credentialFingerprint(refreshInput),
                },
              };
            }
            if (result.error !== null) return { record: { error: "refresh-failed" } };
            workingCreds = result.credentials!;
            // Our own POST produced this lineage: it is attributed with no oracle.
            this.probeVerdicts.set(
              this.lineageKey(accountNum, email, oauth.credentialFingerprint(workingCreds || "") ?? ""),
              true,
            );
            this.provenanceWarned.delete(warnKey(accountNum, email, "expiry-unattributed"));
          }
          // After a POST the successor MUST survive in at least one store.
          // Try both. A restore only needs the live write.
          let backupOk = true;
          let liveOk = true;
          if (restoreSource === null) {
            try {
              this.writeAccountCredentials(accountNum, email, workingCreds);
            } catch {
              backupOk = false;
              this.logger.warning(
                "Backup write failed after a consumed refresh for account %s; attempting the active store.",
                accountNum,
              );
            }
          }
          try {
            // The live write can touch ~/.claude.json, so the config lock covers it.
            // A timeout here is a failed live write: the grant is already consumed.
            claudeLocks.claudeConfigLock(() => this.writeCredentials(workingCreds));
          } catch {
            liveOk = false;
            this.logger.warning(
              "Active-store write failed after a %s for account %s%s.",
              restoreSource !== null ? "backup restore" : "consumed refresh",
              accountNum,
              backupOk ? "" : "; the rotated credential was NOT persisted anywhere — re-login may be required",
            );
          }
          if (!liveOk) {
            // The live store still holds the dead token.
            return { record: { sentinel: USAGE_TOKEN_EXPIRED } };
          }
          return { working: workingCreds };
        },
      );
      if ("record" in step) return step.record;
      working = step.working;
    } catch (e) {
      if (e instanceof LockError) {
        // A live holder (Claude Code mid-refresh, or another cswap operation). Retry next tick.
        this.logger.info(
          "Credential locks held elsewhere; deferring the active-token refresh for account %s to the next pass.",
          accountNum,
        );
        return defer(forceRefresh);
      }
      // The fetch must never throw into the collect pass.
      this.logger.warning(
        "Active-token refresh for account %s failed unexpectedly; deferring to the next pass.",
        accountNum,
        { excInfo: e },
      );
      return defer(forceRefresh);
    }

    const outcome = await internals.tryFetchUsageForAccount(accountNum, email, working, true);
    return { usage: outcome.usage, error: outcome.error, retryAfterS: outcome.retryAfterS };
  }

  /**
   * Resync the slot backup after a rotation that completed outside a collect pass.
   *
   * The config identity alone cannot attribute the drifted bytes: a foreign
   * credential can be in the live store while `~/.claude.json` still names
   * this slot. So the profile oracle attributes the lineage first, before any
   * lock, while the access token is known fresh. Definitive verdicts are kept
   * per lineage. Best effort: a failure leaves the backup stale. Never throws.
   */
  async resyncRotatedBackup(accountNum: string, email: string, orgUuid: string, creds: string): Promise<void> {
    try {
      const credsOauth = oauth.extractOauthData(creds);
      if (!(credsOauth && credsOauth.accessToken && credsOauth.refreshToken)) return;
      const backup = this.readAccountCredentials(accountNum, email);
      if (backup && oauth.credentialFingerprint(creds) === oauth.credentialFingerprint(backup)) return;
      const fp = oauth.credentialFingerprint(creds) ?? "";
      const verdict = this.probeVerdicts.get(this.lineageKey(accountNum, email, fp));
      if (verdict === false) return;
      if (verdict !== true) {
        const resolved = await oauth.fetchOauthProfile(oauth.extractAccessToken(creds) ?? "");
        if (resolved === null) {
          this.logger.debug(
            "Ownership probe for account %s's drifted live credential failed; resync skipped this pass.",
            accountNum,
          );
          return;
        }
        const match = this.resolvedMatchesSlotIdentity(accountNum, resolved);
        if (match === null) {
          this.logger.debug(
            "Ownership of account %s's drifted live credential " +
              "is unverifiable (no stored uuid, partial profile); " +
              "resync skipped this pass.",
            accountNum,
          );
          return;
        }
        // Build the key AFTER the match: an email-path match just stored the slot uuid.
        this.probeVerdicts.set(this.lineageKey(accountNum, email, fp), match);
        const resyncKey = warnKey(accountNum, email, "resync");
        if (!match) {
          if (!this.provenanceWarned.has(resyncKey)) {
            this.provenanceWarned.add(resyncKey);
            this.logger.warning(
              "Live credential resolves to a different " +
                "account than Account-%s's identity; backup " +
                "left untouched (foreign credential under a " +
                "stale config).",
              accountNum,
            );
          }
          return;
        }
        this.provenanceWarned.delete(resyncKey);
      }
      await holdAsync(
        [this.lockFile],
        [() => enterFileLock(this.lockFile), () => claudeLocks.acquireClaudeCredentialsLock()],
        () => {
          if (!this.liveIdentityMatches(email, orgUuid)) return;
          // Slot changes hold this lock, so a new key also checks that the slot is still the affirmed account.
          if (!this.probeVerdicts.get(this.lineageKey(accountNum, email, fp))) return;
          // The live bytes must still carry the probed lineage with a full pair.
          const live = this.readCredentials();
          if (!live) return;
          const liveOauth = oauth.extractOauthData(live);
          if (
            !(
              liveOauth &&
              liveOauth.accessToken &&
              liveOauth.refreshToken &&
              oauth.credentialFingerprint(live) === oauth.credentialFingerprint(creds)
            )
          ) {
            return;
          }
          this.writeAccountCredentials(accountNum, email, live);
          this.logger.info(
            "Resynced account %s's backup to the rotated live " +
              "credential (rotation completed outside a collect pass).",
            accountNum,
          );
        },
      );
    } catch (e) {
      if (e instanceof LockError) return;
      this.logger.warning(
        "Backup resync for account %s failed; the recovery branch's " +
          "newer-generation check still guards the next expiry.",
        accountNum,
        { excInfo: e },
      );
    }
  }

  /**
   * The sentinel state that needs no network call, or null. Computed again on
   * each collect pass, never stored, so it cannot outlive its condition.
   */
  staticUsageSentinel(accountInfo: AccountInfoRow): string | null {
    const [num, email, , , isActive, creds] = accountInfo;
    if (looksLikeApiKey(creds)) return USAGE_API_KEY;
    if (!creds || !oauth.extractAccessToken(creds)) {
      if (isActive && (this.activeKeychainUnavailable || this.activeReadUnreadable)) return USAGE_KEYCHAIN_UNAVAILABLE;
      // The read of THIS slot: "no credentials" would send the user to add a slot that has one.
      if (!isActive && this.readAccountCredentialsEx(String(num), email)[1]) return USAGE_KEYCHAIN_UNAVAILABLE;
      return USAGE_NO_CREDENTIALS;
    }
    // An expired active token is not a static state: the fetch path refreshes it.
    return null;
  }

  /** One network fetch for one account. Never throws. `rejectedFp` is the refused-credential stamp of the row. */
  async fetchAccountUsage(accountInfo: AccountInfoRow, rejectedFp: string | null = null): Promise<FetchRecord> {
    const [num, email, , orgUuid, isActive] = accountInfo;
    let creds = accountInfo[5];

    // The active account owns the live credential: the locked refresh path.
    if (isActive) return this.fetchActiveUsage(String(num), email, creds, orgUuid);

    let hasLiveSession = this.liveSessionPids(String(num), email).length > 0;

    // A session profile replaces the backup as the credential truth: claude
    // rotates the family inside the profile. While the session is live, fetch
    // with its newest credential, strictly read-only.
    const sessionDir = this.sessionDir(String(num), email);
    let sessionCreds = session.readSessionCredentials(sessionDir);
    if (sessionCreds && session.sessionIdentityDrifted(sessionDir, email, orgUuid)) {
      // An in-session /login points the profile at another account. The backup is the right identity and safe to refresh.
      this.logger.debug(
        `Session profile for account ${num} is logged in as a ` +
          "different account; fetching usage from the backup credential",
      );
      sessionCreds = null;
      hasLiveSession = false;
    }
    if (sessionCreds && !hasLiveSession) {
      // The session exited: adopt the profile head into the backup, and take the
      // idle path, refresh included, on it. A refused adoption changes nothing.
      try {
        if (await whenIdle([this.lockFile], () => this.adoptSessionCredential(String(num), email, orgUuid))) {
          creds = sessionCreds;
        }
      } catch (e) {
        if (!(e instanceof LockError)) throw e;
      }
      sessionCreds = null;
    }
    if (sessionCreds) {
      const sessionOauth = oauth.extractOauthData(sessionCreds);
      if (sessionOauth && sessionOauth.accessToken) {
        // The live claude refreshes on its next call. A request now gets a 401.
        if (oauth.isOauthTokenExpired(sessionOauth.expiresAt)) return { sentinel: USAGE_TOKEN_EXPIRED };
        return this.readOnlyFetch(String(num), email, sessionCreds, rejectedFp);
      }
    }

    if (hasLiveSession) {
      // No profile credential: the backup serves read-only. An expired copy is refused for sure.
      const backupOauth = oauth.extractOauthData(creds) ?? {};
      if (oauth.isOauthTokenExpired(backupOauth.expiresAt)) return { sentinel: USAGE_TOKEN_EXPIRED };
      return this.readOnlyFetch(String(num), email, creds, rejectedFp);
    }

    const outcome = await internals.tryFetchUsageForAccount(String(num), email, creds, false, null, (n, e, c) =>
      this.consumeBackupGrant(n, e, c),
    );
    return { usage: outcome.usage, error: outcome.error, retryAfterS: outcome.retryAfterS, struckFp: outcome.struckFp };
  }

  /**
   * A fetch with the credential of a live session, which cswap must never
   * refresh. A 401 means the live claude rotated past our copy: the slot is
   * expired, not failing, and the refused token is stamped on the row. Every
   * other error keeps its kind, a 429 above all.
   */
  async readOnlyFetch(num: string, email: string, creds: string, rejectedFp: string | null): Promise<FetchRecord> {
    const stamp = oauth.accessTokenFingerprint(creds);
    if (stamp !== null && stamp === rejectedFp) return { sentinel: USAGE_TOKEN_EXPIRED };
    const outcome = await internals.tryFetchUsageForAccount(num, email, creds, true);
    if (outcome.error === "http-401") return { sentinel: USAGE_TOKEN_EXPIRED, rejectedFp: stamp };
    return { usage: outcome.usage, error: outcome.error, retryAfterS: outcome.retryAfterS };
  }

  /**
   * Fetch the given accounts in parallel, with the request starts staggered.
   * `entries` is the snapshot before the fetch, for the refused-credential stamp of each row.
   */
  async runUsageFetches(
    infos: readonly AccountInfoRow[],
    entries: Record<string, UsageEntry> | null = null,
  ): Promise<Record<string, FetchRecord>> {
    const fetchOne = async (info: AccountInfoRow, idx: number): Promise<[string, FetchRecord]> => {
      if (idx && internals.FETCH_STAGGER_S) await internals.sleep(idx * internals.FETCH_STAGGER_S * 1000);
      const num = String(info[0]);
      const entry = entries && Object.hasOwn(entries, num) ? entries[num] : undefined;
      return [num, await this.fetchAccountUsage(info, entry ? entry.rejectedFingerprint : null)];
    };
    const pairs = await mapPool(infos, this.withActiveVerdict(fetchOne));
    return Object.fromEntries(pairs);
  }

  /**
   * Store-backed usage collection: one `UsageEntry` per account.
   *
   * `fetch` null (the on-demand callers) makes every account a candidate and
   * respects the stored poll plans. The auto engine gives a set whose members
   * can beat the serve TTL when their plan says so, or, without `scheduled`,
   * when the escalation needs them fresh. `UsageStore.reserve` decides the
   * final eligibility atomically, so two collectors never fetch one slot. A
   * failed fetch updates only the error fields, so the last-good measurement stays served.
   */
  async collectUsageEntries(
    accountsInfo: readonly AccountInfoRow[],
    fetch: ReadonlySet<string> | null = null,
    { scheduled = false }: { scheduled?: boolean } = {},
  ): Promise<Record<string, UsageEntry>> {
    const store = this.usageStore;
    const identities: Record<string, Identity> = {};
    const infoByNum = new Map<string, AccountInfoRow>();
    for (const info of accountsInfo) {
      identities[String(info[0])] = [info[1], info[3] || ""];
      infoByNum.set(String(info[0]), info);
    }
    // The scoped-window models, so the 429-stale trust bound follows the per-model resets.
    const [, models] = this.pollPolicyInputs();
    const sentinels = new Map<string, string>();
    for (const [num, info] of infoByNum) {
      const staticSentinel = this.staticUsageSentinel(info);
      if (staticSentinel !== null) sentinels.set(num, staticSentinel);
    }

    let entries = store.entries(identities, models);
    // Dead refresh-token lineage: quarantine. The sentinel also stops the endless fetch loop.
    for (const [num, info] of infoByNum) {
      if (sentinels.has(num)) continue;
      const entry = entries[num]!;
      if (this.entryTokenDead(entry, num, info[1], info[5], info[4])) {
        sentinels.set(num, USAGE_RELOGIN_REQUIRED);
      } else if (entry.authDeadStrikes && entry.tokenDead()) {
        // Struck, but no stored source matches the condemned generation now.
        // Clear the stale strike ROW too, so display and fetch eligibility agree.
        this.usageStore.clearDeadToken([num], { [num]: identities[num]! });
        entries = store.entries(identities, models);
      }
    }
    const requested = [...infoByNum.keys()].filter((num) => !sentinels.has(num) && (fetch === null || fetch.has(num)));
    let claims: Record<string, string>;
    if (fetch === null) {
      // Repair the reset-parked plans of older releases, under the lock that installs the claim.
      claims = store.reserve(requested, identities, { respectPlans: true, repairOverslept: true });
    } else {
      claims = store.reserve(requested, identities, { respectPlans: false, repairOverslept: scheduled });
    }
    // An expired ACTIVE credential that cannot reach the fetch path this tick
    // must still show as expired, so the auto engine holds instead of failing over.
    const now = store.clock();
    for (const [num, info] of infoByNum) {
      if (sentinels.has(num) || !info[4]) continue;
      if (Object.hasOwn(claims, num)) continue;
      // A hold for the reading of another machine keeps the row trusted: there is no gap.
      if (entries[num]!.held(now)) continue;
      const activeOauth = oauth.extractOauthData(info[5]);
      if (activeOauth && oauth.isOauthTokenExpired(activeOauth.expiresAt)) sentinels.set(num, USAGE_TOKEN_EXPIRED);
    }

    const claimed = Object.keys(claims);
    if (claimed.length > 0) {
      const pre = entries;
      const records = await this.runUsageFetches(
        claimed.map((num) => infoByNum.get(num)!),
        pre,
      );
      const plans = this.plansAfterFetch(records, pre, infoByNum);
      const accepted = store.record(records, identities, claims, plans);
      for (const [num, record] of Object.entries(records)) {
        if (accepted.has(num) && record.sentinel != null) sentinels.set(num, record.sentinel);
      }
      entries = store.entries(identities, models);
      // A fetch that just got invalid_grant reaches the dead threshold. Show "re-login needed" in THIS pass.
      for (const num of accepted) {
        const info = infoByNum.get(num)!;
        if (this.entryTokenDead(entries[num]!, num, info[1], info[5], info[4])) sentinels.set(num, USAGE_RELOGIN_REQUIRED);
      }
    }

    const out: Record<string, UsageEntry> = {};
    for (const num of infoByNum.keys()) out[num] = withSentinel(entries[num]!, sentinels.get(num) ?? null);
    return out;
  }

  /**
   * True if this slot is quarantined as refresh-token-dead now. The same answer
   * that `entryTokenDead` gives the collectors, for a caller with only a slot
   * number (the auto-heal of `cswap import`). An unreadable source cannot be condemned.
   */
  slotTokenDead(num: string, email: string): boolean {
    // The org is part of the row identity: an empty one matches nothing.
    const data = this.getSequenceData() ?? {};
    const org = textOf(pyGet(recordOf(data, num) ?? {}, "organizationUuid", ""));
    const ident: Record<string, Identity> = { [num]: [email, org] };
    const entries = this.usageStore.entries(ident);
    const entry = Object.hasOwn(entries, num) ? entries[num] : undefined;
    if (entry === undefined) return false;
    const isActive = num === this.currentAccountNumber();
    const [backup, unreadable] = this.readAccountCredentialsEx(num, email);
    if (unreadable) return false;
    // The value is tri-state: "" is absent, null a read ERROR, which cannot condemn.
    let stored: string;
    if (isActive) {
      const activeValue = this.store.readActiveCredentials().value;
      if (activeValue === null) return false;
      stored = activeValue;
    } else {
      stored = backup;
    }
    return this.entryTokenDead(entry, num, email, stored, isActive);
  }

  /**
   * The fingerprint-bound dead verdict against EVERY stored source.
   *
   * The active slot has two sources: the live credential, and the backup that
   * the recovery branch can POST. The strike holds while ANY source still
   * matches the struck generation.
   */
  entryTokenDead(entry: UsageEntry, num: string, email: string, stored: string, isActive: boolean): boolean {
    if (entry.tokenDead(undefined, oauth.credentialFingerprint(stored))) return true;
    if (!isActive) return false;
    const [backup, unreadable] = this.readAccountCredentialsEx(num, email);
    if (unreadable) {
      // The second source cannot be seen, so "no source matches" is not proven.
      // The caller would clear the persisted strike. Hold it if a strike exists.
      return entry.tokenDead();
    }
    return Boolean(backup) && entry.tokenDead(undefined, oauth.credentialFingerprint(backup));
  }

  /**
   * The cadence updates of the successful fetches, for the atomic commit.
   * Failures are paced by the backoff of the store.
   */
  plansAfterFetch(
    records: Record<string, FetchRecord>,
    pre: Record<string, UsageEntry>,
    infoByNum: ReadonlyMap<string, AccountInfoRow>,
  ): Record<string, PollPlan> {
    const now = this.usageStore.clock();
    const [threshold, models] = this.pollPolicyInputs();
    const plans: Record<string, PollPlan> = {};
    for (const [num, rec] of Object.entries(records)) {
      if (rec.sentinel != null || rec.error != null) continue;
      const before = Object.hasOwn(pre, num) ? pre[num] : undefined;
      const recent429 = before !== undefined && before.recent429(now);
      plans[num] = pollPolicy.planAfterFetch({
        prevIntervalS: before ? before.pollIntervalS : null,
        prevUsage: before ? before.lastGood : null,
        newUsage: rec.usage ?? null,
        isActive: Boolean(infoByNum.get(num)![4]),
        threshold,
        models,
        recent429,
        now,
      });
    }
    return plans;
  }

  /**
   * Pull the poll plan of the new active account to the active floor. The
   * next poll only moves earlier. Best effort: the switch already committed.
   */
  replanNewActive(number: string, email: string, orgUuid: string | null | undefined): void {
    try {
      const identities: Record<string, Identity> = { [number]: [email, orgUuid || ""] };
      const now = this.usageStore.clock();
      const entries = this.usageStore.entries(identities);
      const entry = Object.hasOwn(entries, number) ? entries[number] : undefined;
      if (entry === undefined || entry.fetchedAt === null) return;
      const nextPoll = Math.max(now, entry.fetchedAt + pollPolicy.MIN_INTERVAL_S);
      if (entry.nextPollAt !== null && entry.nextPollAt <= nextPoll) return;
      this.usageStore.setPollPlan({ [number]: [nextPoll, pollPolicy.MIN_INTERVAL_S] }, identities);
    } catch (e) {
      this.logger.warning(`Post-switch poll re-plan failed (switch itself succeeded): ${errorText(e)}`);
    }
  }

  /**
   * A one-time typo guard for `--model` on the manual strategies. Claimed only
   * when the usage of every account is readable.
   */
  warnInertModels(
    usage: Record<string, unknown>,
    models: readonly string[],
    jsonOutput: boolean,
    warnings: string[],
  ): void {
    const wanted = new Map<string, string>();
    for (const m of models) if (m.toLowerCase() !== "all") wanted.set(m.toLowerCase(), m);
    if (wanted.size === 0 || Object.keys(usage).length === 0) return;
    if (Object.values(usage).some((v) => !isRecord(v))) return;
    const seen = new Set<string>();
    for (const v of Object.values(usage)) {
      const scoped = (v as Record<string, unknown>).scoped;
      if (!Array.isArray(scoped)) continue;
      for (const s of scoped as unknown[]) {
        if (isRecord(s) && typeof s.name === "string") seen.add(s.name.toLowerCase());
      }
    }
    const missing = [...wanted].filter(([low]) => !seen.has(low)).map(([, name]) => name);
    if (missing.length === 0) return;
    const msg = `model(s) ${missing.join(", ")} match no account's usage windows (typo?)`;
    if (jsonOutput) warnings.push(msg);
    else warning(msg);
  }

  /**
   * The target of the `best` strategy, relative to the current account. A
   * switch is recommended only if it PROVABLY lands on more headroom. Return `[target, note]`:
   *
   * - `[num, ""]`: switch to `num`.
   * - `[null, "current-unavailable"]`: the usage of the current account is unknown.
   * - `[null, "no-comparison"]`: no other account has known usage.
   * - `[null, "incomplete-comparison"]`: the current account is the best of the known ones, but some usage is unknown.
   * - `[null, "stay"]`: the current account has the most headroom.
   * - `[null, "exhausted"]`: the current account is the best and every account is at its limit.
   * - `[null, "none"]`: no other switchable account exists.
   *
   * A tie stays. Never throws on a network failure.
   */
  async selectBestSwitchable(
    currentNum: string | null,
    models: readonly string[] = [],
    usage: Record<string, unknown> | null = null,
  ): Promise<[string | null, string]> {
    const data = this.getSequenceData() ?? {};
    const current = String(currentNum ?? "None");
    const others = sequenceOf(data)
      .map((n) => String(n))
      .filter(
        (n) => n !== current && this.accountIsSwitchable(n) && !ClaudeAccountSwitcher.disabledFromData(data, n),
      );
    if (others.length === 0) return [null, "none"];

    if (usage === null) usage = await this.usageByAccount();
    const get = (num: string) => (Object.hasOwn(usage!, num) ? usage![num] : undefined) as oauth.UsageDict | null;
    const currentHeadroom = oauth.accountHeadroom(get(current), models);
    if (currentHeadroom === null) return [null, "current-unavailable"];

    const scored = others.map((num) => [oauth.accountHeadroom(get(num), models), num] as const);
    const known = scored.filter(([h]) => h !== null) as Array<readonly [number, string]>;
    if (known.length === 0) return [null, "no-comparison"];

    // The first maximal element wins: the rotation order breaks a tie.
    let [bestHeadroom, bestNum] = known[0]!;
    for (const [h, num] of known.slice(1)) {
      if (h > bestHeadroom) [bestHeadroom, bestNum] = [h, num];
    }
    if (bestHeadroom > currentHeadroom) return [bestNum, ""];

    if (scored.some(([h]) => h === null)) return [null, "incomplete-comparison"];
    if (currentHeadroom <= 0) return [null, "exhausted"];
    return [null, "stay"];
  }

  /**
   * Slots that provably authenticate as one account: the same credential
   * fingerprint, or the same non-empty `uuid` + org. Two different generations
   * of one account are not visible here (`lockstepUsageWarnings` covers them).
   */
  duplicateAccountWarnings(accountsInfo: readonly AccountInfoRow[]): string[] {
    const data = this.getSequenceData() ?? {};
    const byFp = new Map<string, string>();
    const byIdentity = new Map<string, string>();
    const out: string[] = [];
    for (const [num, email, , orgUuid, , creds] of accountsInfo) {
      const snum = String(num);
      const fp = creds ? oauth.credentialFingerprint(creds) : null;
      if (fp) {
        const other = byFp.get(fp);
        if (other) {
          out.push(
            `Account-${other} and Account-${snum} hold the same ` +
              `credential (${email}) — one slot's backup was ` +
              "overwritten. Log in with the missing account and " +
              "re-add it: cswap add --slot N",
          );
        } else {
          byFp.set(fp, snum);
        }
      }
      const uuid = textOf((recordOf(data, snum) ?? {}).uuid).trim();
      if (uuid) {
        const key = JSON.stringify([uuid, orgUuid || ""]);
        const other = byIdentity.get(key);
        if (other && other !== snum) {
          out.push(`Account-${other} and Account-${snum} both authenticate as ${email} — remove or re-login one of them.`);
        } else if (!other) {
          byIdentity.set(key, snum);
        }
      }
    }
    return out;
  }

  /**
   * Heuristic: slots whose usage moves in exact lockstep (the same 5h and 7d
   * percentages and reset times) can be two generations of one account (issue
   * #117). Only rows where both windows have a reset time are compared.
   */
  lockstepUsageWarnings(accountsInfo: readonly AccountInfoRow[], entries: Record<string, UsageEntry>): string[] {
    const seen = new Map<string, string>();
    const out: string[] = [];
    for (const [num] of accountsInfo) {
      const snum = String(num);
      const entry = Object.hasOwn(entries, snum) ? entries[snum] : undefined;
      const usage = entry ? entry.decisionValue() : null;
      if (!isRecord(usage)) continue;
      const h5 = (usage as Record<string, unknown>).five_hour;
      const d7 = (usage as Record<string, unknown>).seven_day;
      if (!isRecord(h5) || !isRecord(d7)) continue;
      const parts = [h5.pct, h5.resets_at, d7.pct, d7.resets_at];
      if (parts.some((p) => p === null || p === undefined)) continue;
      const key = JSON.stringify(parts);
      const other = seen.get(key);
      if (other) {
        out.push(
          `Account-${other} and Account-${snum} report identical ` +
            "usage and reset times — they may be the same account " +
            "(issue #117). If it persists, log in with the missing " +
            "account and re-add it: cswap add --slot N",
        );
      } else {
        seen.set(key, snum);
      }
    }
    return out;
  }

  /** The `--list --json` payload. */
  buildListPayload(accountsInfo: readonly AccountInfoRow[], entries: Record<string, UsageEntry>): JsonObject {
    let activeNum: number | null = null;
    const accounts: JsonObject[] = [];
    const seqData = this.getSequenceData() ?? {};
    const now = this.usageStore.clock();
    for (const [num, email, orgName, orgUuid, isActive, creds, alias] of accountsInfo) {
      if (isActive) activeNum = num;
      const entry = entries[String(num)]!;
      // JSON carries the decision-grade value: scripts must not act on old data.
      accounts.push(
        accountRow(num, email, orgName, orgUuid, isActive, entry.decisionValue(), {
          usageFetchedAt: entry.fetchedAt,
          usageAgeS: entry.ageS,
          lastGoodUsage: entry.lastGood,
          lastError: entry.lastError,
          backoffUntil: entry.inBackoff(now) ? entry.backoffUntil : null,
          alias,
          disabled: ClaudeAccountSwitcher.disabledFromData(seqData, String(num)),
          loginExpiresAt: oauth.loginExpiresAtIso(creds),
        }),
      );
    }
    const payload: JsonObject = {
      schemaVersion: SCHEMA_VERSION,
      activeAccountNumber: activeNum,
      accounts,
    };
    // Fields that exist only when there is something to say.
    const dupWarnings = this.duplicateAccountWarnings(accountsInfo);
    if (dupWarnings.length > 0) payload.duplicateAccountWarnings = dupWarnings;
    const lockstepWarnings = this.lockstepUsageWarnings(accountsInfo, entries);
    if (lockstepWarnings.length > 0) payload.lockstepUsageWarnings = lockstepWarnings;
    const unclaimed = this.store.listUnclaimedCredentials();
    const ids = Object.keys(unclaimed);
    if (ids.length > 0) payload.unclaimedCredentials = ids.sort();
    return payload;
  }

  /**
   * List all managed accounts. With `jsonOutput`, return the schema-v1 payload
   * and print nothing. Else print the human view and return null. `fetch`
   * limits which accounts can be fetched in this pass.
   */
  async listAccounts(
    showTokenStatus = false,
    jsonOutput = false,
    fetch: ReadonlySet<string> | null = null,
  ): Promise<JsonObject | null> {
    if (!fs.existsSync(this.sequenceFile)) {
      // JSON mode never prompts.
      if (jsonOutput) return { schemaVersion: SCHEMA_VERSION, activeAccountNumber: null, accounts: [] };
      print(dimmed("No accounts are managed yet."));
      await this.firstRunSetup();
      return null;
    }

    const accountsInfo = this.buildAccountsInfo();
    const entries = await this.collectUsageEntries(accountsInfo, fetch);

    if (jsonOutput) return this.buildListPayload(accountsInfo, entries);

    const seqData = this.getSequenceData() ?? {};
    print(bolded("Accounts:"));
    accountsInfo.forEach((info, i) => {
      const [num, email, orgName, orgUuid, isActive, , alias] = info;
      const tag = ClaudeAccountSwitcher.getDisplayTag(email, orgName, orgUuid);
      const label = alias ? `${accent(alias)} (${email})` : email;
      let markers = "";
      if (isActive) markers += ` ${boldAccent("(active)")}`;
      if (ClaudeAccountSwitcher.disabledFromData(seqData, String(num))) markers += ` ${muted("(disabled)")}`;
      print(`  ${num}: ${label} ${muted(`[${tag}]`)}${markers}`);
      for (const line of usageEntryLines(entries[String(num)]!)) print(`     ${line}`);

      if (showTokenStatus) {
        for (const line of this.tokenStatusLines(info)) print(`     ${dimmed("•")} ${muted(line)}`);
      }
      if (i < accountsInfo.length - 1) print();
    });

    // The unclaimed safety copies stay out of this view: the user cannot act on them.
    const dupWarnings = this.duplicateAccountWarnings(accountsInfo);
    const lockstepWarnings = this.lockstepUsageWarnings(accountsInfo, entries);
    if (dupWarnings.length > 0 || lockstepWarnings.length > 0) {
      print();
      for (const msg of dupWarnings) warning(msg);
      for (const msg of lockstepWarnings) warning(msg);
    }

    try {
      const [sessions, ideInstances] = getRunningInstances();
      if (sessions.length > 0 || ideInstances.length > 0) {
        // Group by (label, folder) to avoid repeated lines.
        const groups = new Map<string, { label: string; cwd: string; sessions: number; ide: number }>();
        const group = (label: string, cwd: string) => {
          const key = JSON.stringify([label, cwd]);
          let counts = groups.get(key);
          if (!counts) {
            counts = { label, cwd, sessions: 0, ide: 0 };
            groups.set(key, counts);
          }
          return counts;
        };
        for (const s of sessions) group(entrypointLabel(s.entrypoint), abbreviatePath(s.cwd)).sessions += 1;
        for (const ide of ideInstances) {
          const name = ideShortName(ide.ideName);
          for (const folder of ide.workspaceFolders) group(name, abbreviatePath(folder)).ide += 1;
        }

        print();
        print(bolded("Running instances:"));
        for (const counts of groups.values()) {
          const parts: string[] = [];
          const s = counts.sessions;
          if (s) parts.push(`${s} session${s > 1 ? "s" : ""}`);
          if (counts.ide) parts.push("IDE");
          print(`  ${dimmed("●")} ${muted(counts.label)}   ${muted(counts.cwd)}  ${dimmed(`(${parts.join(", ")})`)}`);
        }
      }
    } catch (e) {
      this.logger.debug("Failed to detect running instances", { excInfo: e });
    }
    return null;
  }

  /**
   * The store-backed usage entry of the active account only (`--status` reads
   * one slot), through the shared collector.
   */
  async activeAccountUsage(accountNum: string, currentEmail: string, orgUuid: string): Promise<UsageEntry> {
    const active = this.readActiveCredentials();
    const creds = active.value || "";
    this.recordActiveVerdict(active);
    const info: AccountInfoRow = [pyInt(accountNum), currentEmail, "", orgUuid || "", true, creds, ""];
    const entries = await this.collectUsageEntries([info]);
    return entries[String(accountNum)]!;
  }

  /** The `--status --json` payload (no active account, unmanaged, or managed). */
  async buildStatusPayload(): Promise<JsonObject> {
    const identity = this.getCurrentAccount();
    if (identity === null) return { schemaVersion: SCHEMA_VERSION, active: null };
    const [currentEmail, currentOrgUuid] = identity;

    const data = this.getSequenceDataMigrated();
    if (!truthyDict(data)) {
      return { schemaVersion: SCHEMA_VERSION, active: { email: currentEmail, managed: false } };
    }

    const accountNum = ClaudeAccountSwitcher.findAccountSlot(data, currentEmail, currentOrgUuid);
    if (!accountNum) {
      return { schemaVersion: SCHEMA_VERSION, active: { email: currentEmail, managed: false } };
    }

    const acct = recordOf(data, accountNum)!;
    const orgName = textOf(acct.organizationName);
    const orgUuid = textOf(acct.organizationUuid);
    const alias = textOf(acct.alias);
    const entry = await this.activeAccountUsage(accountNum, currentEmail, orgUuid);
    // Decision-grade, as in the --list payload.
    const [status, usage] = usageFields(entry.decisionValue(), entry.fetchedAt);
    const active: JsonObject = {
      number: pyInt(accountNum),
      email: currentEmail,
      organizationName: orgName,
      organizationUuid: orgUuid,
      isOrganization: Boolean(orgUuid),
      managed: true,
      usageStatus: status,
      usage,
    };
    if (alias) active.alias = alias;
    if (usage !== null) {
      Object.assign(active, usageFreshnessFields(entry.fetchedAt, entry.ageS));
    } else {
      Object.assign(active, lastGoodUsageFields(entry.lastGood, entry.fetchedAt, entry.ageS));
      const now = this.usageStore.clock();
      Object.assign(active, usageFailureFields(status, entry.lastError, entry.inBackoff(now) ? entry.backoffUntil : null));
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      active,
      totalManagedAccounts: Object.keys(accountsOf(data)).length,
    };
  }

  /** Show the status of the current account, or return the schema-v1 payload. */
  async status(jsonOutput = false): Promise<JsonObject | null> {
    if (jsonOutput) return this.buildStatusPayload();

    const identity = this.getCurrentAccount();
    if (identity === null) {
      print(`${bolded("Status:")} ${dimmed("No active Claude account")}`);
      return null;
    }
    const [currentEmail, currentOrgUuid] = identity;

    const data = this.getSequenceDataMigrated();
    if (!truthyDict(data)) {
      print(`${bolded("Status:")} ${currentEmail} ${dimmed("(not managed)")}`);
      return null;
    }

    const accountNum = ClaudeAccountSwitcher.findAccountSlot(data, currentEmail, currentOrgUuid);
    let orgName = "";
    if (accountNum !== null) orgName = textOf(recordOf(data, accountNum)!.organizationName);

    if (accountNum) {
      const tag = ClaudeAccountSwitcher.getDisplayTag(currentEmail, orgName, currentOrgUuid);
      const total = Object.keys(accountsOf(data)).length;
      print(`${bolded("Status:")} ${accent(`Account-${accountNum}`)} (${currentEmail} ${muted(`[${tag}]`)})`);
      print(`  ${dimmed(`Total managed accounts: ${total}`)}`);
      const entry = await this.activeAccountUsage(accountNum, currentEmail, currentOrgUuid);
      for (const line of usageEntryLines(entry)) print(`  ${line}`);
    } else {
      print(`${bolded("Status:")} ${currentEmail} ${dimmed("(not managed)")}`);
    }
    return null;
  }

  /** The first-run setup. */
  async firstRunSetup(): Promise<void> {
    const identity = this.getCurrentAccount();
    if (identity === null) {
      print(dimmed("No active Claude account found. Please log in first."));
      return;
    }
    const [currentEmail] = identity;

    const response = internals.input(
      `No managed accounts found. Add current account (${currentEmail}) to managed list? [Y/n] `,
    );
    if (response.toLowerCase() === "n") {
      print(dimmed("Setup cancelled. You can run 'cswap --add-account' later."));
      return;
    }

    await this.addAccount();
  }

  /**
   * A switch result from a `performSwitch` return value. `switched` comes from
   * whether the live identity changed (`from !== to`).
   */
  switchResultFromOp(op: SwitchOp, strategy: string, extraWarnings: string[] | null = null): SwitchResult {
    const fromRef = op.from;
    const toRef = op.to;
    const switched = !refsEqual(fromRef, toRef);
    let reason: string;
    let message: string;
    if (switched) {
      reason = "switched";
      message = `Switched to Account-${toRef.number ?? "None"} (${toRef.email})`;
    } else {
      reason = "already-active";
      message = `Already on Account-${toRef.number ?? "None"} (${toRef.email})`;
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      switched,
      from: fromRef,
      to: toRef,
      strategy,
      reason,
      message,
      warnings: [...(extraWarnings ?? []), ...op.warnings],
    };
  }

  /**
   * A no-op switch result (`switched: false`). `from` defaults to `to`, so
   * every `switched: false` payload reports `from === to`.
   */
  switchNoop({
    strategy,
    reason,
    message,
    fromRef = null,
    toRef = null,
    warnings = null,
  }: {
    strategy: string;
    reason: string;
    message: string;
    fromRef?: AccountRef | null;
    toRef?: AccountRef | null;
    warnings?: string[] | null;
  }): SwitchResult {
    if (fromRef === null) fromRef = toRef;
    return {
      schemaVersion: SCHEMA_VERSION,
      switched: false,
      from: fromRef,
      to: toRef,
      strategy,
      reason,
      message,
      warnings: warnings ?? [],
    };
  }

  /**
   * Switch to the next account in the sequence.
   *
   * - `strategy`: `"best"` jumps to the switchable account with the most
   *   remaining quota (only if that is provably better). `"next-available"`
   *   rotates and skips the accounts at their limit. Null is a plain rotation.
   * - `models`: per-model weekly windows that the usage-aware strategies add to every comparison.
   * - `modelSource`: where `models` came from (`"cli"` or `"autoswitch.model"`), shown first.
   *
   * The strategies apply only with a live Claude login. The fresh-machine path ignores them.
   */
  async switch(
    strategy: string | null = null,
    jsonOutput = false,
    models: readonly string[] = [],
    modelSource: string | null = null,
  ): Promise<SwitchResult | null> {
    const strategyLabel = strategy === "best" || strategy === "next-available" ? strategy : "rotation";
    const warnings: string[] = [];
    if (strategyLabel === "rotation") models = [];
    if (models.length > 0 && !jsonOutput) {
      const source = modelSource === "cli" ? "--model" : modelSource;
      print(dimmed(`Using configured model limits: ${models.join(", ")}${source ? ` (from ${source})` : ""}`));
    }

    if (!fs.existsSync(this.sequenceFile)) throw new ConfigError("No accounts are managed yet");

    const identity = this.getCurrentAccount();

    this.getSequenceDataMigrated();

    // Fresh-machine path: no live login but managed accounts (for example
    // after --import). Activate the recorded active slot, else the first slot,
    // and walk the sequence if that target has no valid backups.
    if (identity === null) {
      const data = this.getSequenceData() ?? {};
      const sequence = sequenceOf(data);
      let preferred: number | null | undefined = data.activeAccountNumber;
      if (!preferred && sequence.length > 0) preferred = sequence[0];
      if (!preferred) throw new ConfigError("No accounts are managed yet");

      let target = String(preferred);
      const targetDisabled = ClaudeAccountSwitcher.disabledFromData(data, target);
      if (targetDisabled || !this.accountIsSwitchable(target)) {
        let reason: string;
        let consoleReason: string;
        if (targetDisabled) {
          reason = consoleReason = "(disabled)";
        } else {
          reason = "(no stored credentials/config)";
          consoleReason = `(no stored credentials/config, re-add with cswap --add-account --slot ${target})`;
        }
        if (jsonOutput) warnings.push(`Skipped Account-${target} ${reason}`);
        else print(`${accent("Skipping")} Account-${target} ${consoleReason}`);
        const fallback = sequence
          .map((num) => String(num))
          .find(
            (num) =>
              num !== target && !ClaudeAccountSwitcher.disabledFromData(data, num) && this.accountIsSwitchable(num),
          );
        if (!fallback) {
          if (sequence.some((num) => this.accountIsSwitchable(String(num)))) {
            throw new ConfigError("No accounts remain in rotation. Re-enable one with: cswap enable <num|email>");
          }
          throw new ConfigError(
            "No managed accounts have valid stored credentials/config. " +
              "Re-add a slot with: cswap --add-account --slot <number>",
          );
        }
        target = fallback;
      }
      const op = await this.performSwitch(target, !jsonOutput);
      return jsonOutput ? this.switchResultFromOp(op, strategyLabel, warnings) : null;
    }

    const [currentEmail, currentOrgUuid] = identity;

    if (!this.accountExists(currentEmail, currentOrgUuid)) {
      // JSON mode does not add silently: a side effect in automation is a surprise.
      if (jsonOutput) {
        const ref = accountRef(null, currentEmail);
        return this.switchNoop({
          strategy: strategyLabel,
          reason: "unmanaged-account",
          fromRef: ref,
          toRef: ref,
          message: "Active account is not managed; run cswap --add-account",
        });
      }
      print(`${accent("Notice:")} Active account '${currentEmail}' was not managed.`);
      await this.addAccount();
      const added = this.getSequenceData();
      const accountNum = added?.activeAccountNumber;
      print(`It has been automatically added as Account-${accountNum ?? "None"}.`);
      print(dimmed("Please run the switch command again to switch to the next account."));
      return null;
    }

    const data = this.getSequenceData()!;
    const sequence = sequenceOf(data);

    if (sequence.length < 2) {
      if (jsonOutput) {
        const num = ClaudeAccountSwitcher.findAccountSlot(data, currentEmail, currentOrgUuid);
        return this.switchNoop({
          strategy: strategyLabel,
          reason: "only-one-account",
          toRef: num ? accountRef(pyInt(num), currentEmail) : null,
          message: "Only one account is managed. Add more accounts to switch between.",
        });
      }
      print(dimmed("Only one account is managed. Add more accounts to switch between."));
      return null;
    }

    const activeAccount = data.activeAccountNumber;
    // Where the user is now (live identity), else the recorded active slot.
    let currentNum = ClaudeAccountSwitcher.findAccountSlot(data, currentEmail, currentOrgUuid);
    if (currentNum === null) currentNum = activeAccount !== null && activeAccount !== undefined ? String(activeAccount) : null;

    const currentRef = currentNum ? accountRef(pyInt(currentNum), currentEmail) : null;

    if (strategy === "best") {
      const bestUsage = await this.usageByAccount();
      this.warnInertModels(bestUsage, models, jsonOutput, warnings);
      const [target, note] = await this.selectBestSwitchable(currentNum, models, bestUsage);
      if (target !== null) {
        const op = await this.performSwitch(target, !jsonOutput);
        return jsonOutput ? this.switchResultFromOp(op, strategyLabel, warnings) : null;
      }
      const cur = currentNum ?? "None";
      if (note === "current-unavailable") {
        if (jsonOutput) {
          return this.switchNoop({
            strategy: strategyLabel,
            reason: "usage-unavailable",
            toRef: currentRef,
            warnings,
            message: `Current account usage is unavailable — staying on Account-${cur}.`,
          });
        }
        print(dimmed(`Current account usage is unavailable — staying on Account-${cur}. Run cswap --switch to rotate.`));
        return null;
      }
      if (note === "no-comparison") {
        if (jsonOutput) {
          return this.switchNoop({
            strategy: strategyLabel,
            reason: "usage-unavailable",
            toRef: currentRef,
            warnings,
            message: `No other account has usage data to compare — staying on Account-${cur}.`,
          });
        }
        print(
          dimmed(
            `No other account has usage data to compare — staying on Account-${cur}. Run cswap --switch to rotate.`,
          ),
        );
        return null;
      }
      if (note === "incomplete-comparison") {
        if (jsonOutput) {
          return this.switchNoop({
            strategy: strategyLabel,
            reason: "usage-unavailable",
            toRef: currentRef,
            warnings,
            message:
              "No account with known usage has more remaining quota; " +
              `some usage is unavailable — staying on Account-${cur}.`,
          });
        }
        print(
          dimmed(
            "No account with known usage has more remaining quota; some " +
              `usage is unavailable — staying on Account-${cur}.`,
          ),
        );
        return null;
      }
      if (note === "stay") {
        if (jsonOutput) {
          return this.switchNoop({
            strategy: strategyLabel,
            reason: "already-best",
            toRef: currentRef,
            warnings,
            message: `Already on the account with the most remaining quota (Account-${cur}).`,
          });
        }
        print(`${accent("Already on the account with the most remaining quota")} (Account-${cur}).`);
        return null;
      }
      if (note === "exhausted") {
        // With model limits, the binding window can be a scoped one.
        const limitsLabel = models.length > 0 ? "usage limits" : "5h/7d limit";
        if (jsonOutput) {
          return this.switchNoop({
            strategy: strategyLabel,
            reason: "candidates-exhausted",
            toRef: currentRef,
            warnings,
            message: `All accounts are at their ${limitsLabel} — staying on Account-${cur}.`,
          });
        }
        warning(`All accounts are at their ${limitsLabel} — staying on Account-${cur}.`);
        return null;
      }
      // "none": continue. The rotation reports that there is no target.
    }

    // Find the next candidate and skip the broken ones. The active slot is not
    // checked: `performSwitch` captures the live state into a new backup first.
    // The usage-aware rotation anchors on the live account. The plain rotation
    // anchors on the recorded active slot, as before.
    const anchor: unknown = strategy === "next-available" ? currentNum : activeAccount;
    let currentIndex = indexOfInt(sequence, anchor);
    if (currentIndex < 0) currentIndex = activeAccount === null || activeAccount === undefined ? -1 : sequence.indexOf(activeAccount);
    if (currentIndex < 0) currentIndex = 0;

    // Fetch the usage only when it is needed. An empty map skips the headroom check.
    const usage: Record<string, unknown> = strategy === "next-available" ? await this.usageByAccount() : {};
    if (strategy === "next-available") this.warnInertModels(usage, models, jsonOutput, warnings);

    let nextAccount: string | null = null;
    const skippedExhausted: string[] = [];
    for (let offset = 1; offset < sequence.length; offset += 1) {
      const candidate = String(sequence[(currentIndex + offset) % sequence.length]);
      if (ClaudeAccountSwitcher.disabledFromData(data, candidate)) {
        if (jsonOutput) warnings.push(`Skipped Account-${candidate} (disabled)`);
        else print(`${accent("Skipping")} Account-${candidate} (disabled)`);
        continue;
      }
      if (!this.accountIsSwitchable(candidate)) {
        if (jsonOutput) {
          warnings.push(`Skipped Account-${candidate} (no stored credentials/config)`);
        } else {
          print(
            `${accent("Skipping")} Account-${candidate} ` +
              `(no stored credentials/config, re-add with cswap --add-account --slot ${candidate})`,
          );
        }
        continue;
      }
      if (strategy === "next-available") {
        const candidateUsage = (Object.hasOwn(usage, candidate) ? usage[candidate] : undefined) as oauth.UsageDict | null;
        const headroom = oauth.accountHeadroom(candidateUsage, models);
        if (headroom !== null && headroom <= 0) {
          skippedExhausted.push(candidate);
          let label = "5h/7d";
          if (models.length > 0) {
            // Name what binds ("Fable", "5h/Fable", ...).
            const at = oauth
              .relevantWindows(candidateUsage, models)
              .filter(([, pct]) => pct >= 100.0)
              .map(([name]) => name);
            if (at.length > 0) label = at.join("/");
          }
          if (jsonOutput) warnings.push(`Skipped Account-${candidate} (at ${label} limit)`);
          else print(`${accent("Skipping")} Account-${candidate} (at ${label} limit)`);
          continue;
        }
      }
      nextAccount = candidate;
      break;
    }

    // Every rotation target is at its limit: stay.
    if (nextAccount === null && skippedExhausted.length > 0) {
      const limitsLabel = models.length > 0 ? "usage limits" : "5h/7d limit";
      const cur = currentNum ?? "None";
      if (jsonOutput) {
        return this.switchNoop({
          strategy: strategyLabel,
          reason: "candidates-exhausted",
          toRef: currentRef,
          warnings,
          message: `All other accounts are at their ${limitsLabel} — staying on Account-${cur}.`,
        });
      }
      warning(`All other accounts are at their ${limitsLabel} — staying on Account-${cur}.`);
      return null;
    }

    if (nextAccount === null) {
      if (jsonOutput) {
        return this.switchNoop({
          strategy: strategyLabel,
          reason: "no-valid-target",
          toRef: currentRef,
          warnings,
          message: "No other accounts have valid stored credentials/config.",
        });
      }
      print(
        dimmed(
          "No other accounts have valid stored credentials/config.\n" +
            "Re-add a skipped slot with: cswap --add-account --slot <number>",
        ),
      );
      return null;
    }

    // A rotation anchored on a drifted active slot can land on the current
    // slot. Provenance-aware: a no-op only if the live credential matches the
    // backup of the slot, or the divergence cannot be classified.
    let provenance: Provenance | null = null;
    if (nextAccount === currentNum) {
      const [action, resolvedProvenance] = await this.selfSwitchAction(nextAccount, currentEmail);
      provenance = resolvedProvenance;
      if (action !== "reconcile") {
        if (jsonOutput) {
          return this.switchNoop({
            strategy: strategyLabel,
            reason: "already-active",
            fromRef: currentRef,
            toRef: currentRef,
            warnings,
            message: `Already on Account-${nextAccount} (${currentEmail})`,
          });
        }
        print(`${accent("Already on")} Account-${nextAccount} (${currentEmail})`);
        return null;
      }
    }

    const op = await this.performSwitch(nextAccount, !jsonOutput, false, provenance);
    return jsonOutput ? this.switchResultFromOp(op, strategyLabel, warnings) : null;
  }

  /**
   * Switch to a specific account. `force` activates the stored credentials of
   * the target directly and skips the already-active guard and the backup of
   * the current login: the recovery path for a stale live login.
   */
  async switchTo(identifier: string, jsonOutput = false, force = false): Promise<SwitchResult | null> {
    if (!fs.existsSync(this.sequenceFile)) throw new ConfigError("No accounts are managed yet");

    this.getSequenceDataMigrated();

    if (!isDigits(identifier)) {
      const isAlias = this.findAccountByAlias(identifier) !== null;
      if (!isAlias && !this.validateEmail(identifier)) throw new ValidationError(`Invalid account identifier: ${identifier}`);

      // An ambiguous email asks, except in JSON mode: there the resolver throws a ConfigError that lists the slots.
      if (!jsonOutput && !isAlias) {
        const data = this.getSequenceData() ?? {};
        const matches = Object.entries(accountsOf(data))
          .filter(([, acc]) => acc.email === identifier)
          .map(([num]) => num);
        if (matches.length > 1) {
          const choice = this.chooseAmongEmailMatches(identifier, data, matches, "switch to");
          if (choice === null) return null;
          identifier = choice;
        }
      }
    }

    const targetAccount = this.resolveAccountIdentifier(identifier);
    if (!targetAccount) throw new AccountNotFoundError(`No account found with identifier: ${identifier}`);

    const data = this.getSequenceData();
    if (!Object.hasOwn(accountsOf(data), targetAccount)) {
      throw new AccountNotFoundError(`Account-${targetAccount} does not exist`);
    }

    // A self-switch is a no-op before any change (issue #79): it would back up
    // a possibly stale login over a new backup. --force skips this guard on
    // purpose. Provenance-aware (issue #117): a RESOLVED divergence continues,
    // so `performSwitch` can reconcile it.
    let provenance: Provenance | null = null;
    if (!force && truthyDict(data)) {
      const identity = this.getCurrentAccount();
      if (identity !== null) {
        const curSlot = ClaudeAccountSwitcher.findAccountSlot(data, identity[0], identity[1]);
        if (curSlot === targetAccount) {
          const [action, resolvedProvenance] = await this.selfSwitchAction(targetAccount, identity[0]);
          provenance = resolvedProvenance;
          if (action !== "reconcile") {
            const email = textOf(pyGet(recordOf(data, targetAccount) ?? {}, "email", ""));
            const ref = accountRef(pyInt(targetAccount), email);
            if (!jsonOutput) {
              print(`${accent("Already on")} Account-${targetAccount} (${email})`);
              print(
                dimmed(
                  "To rewrite the live login from the stored backup " +
                    "(e.g. after --import), run: " +
                    `cswap --switch-to ${targetAccount} --force`,
                ),
              );
              return null;
            }
            return this.switchNoop({
              strategy: "direct",
              reason: "already-active",
              fromRef: ref,
              toRef: ref,
              message: `Already on Account-${targetAccount} (${email})`,
            });
          }
        }
      }
    }

    const op = await this.performSwitch(targetAccount, !jsonOutput, force, provenance);
    const result = jsonOutput ? this.switchResultFromOp(op, "direct") : null;
    // A forced self-activation rewrote the live credentials from the backup: "already-active" would not describe it.
    if (result !== null && force && !result.switched) {
      const to = result.to!;
      result.reason = "activated";
      result.message = `Activated Account-${to.number ?? "None"} (${to.email}) from stored backup`;
    }
    return result;
  }

  /**
   * True if the live credential is provably the stored lineage of the slot
   * (bytes or refresh-token fingerprint). An unreadable or empty live
   * credential gives true: keep the no-op.
   */
  liveMatchesSlotBackup(slot: string, email: string): boolean {
    let live: string | null;
    try {
      live = this.readCredentials();
    } catch {
      return true;
    }
    if (!live) return true;
    const backup = this.readAccountCredentials(slot, email);
    if (!backup) return false;
    return live === backup || oauth.credentialFingerprint(live) === oauth.credentialFingerprint(backup);
  }

  /**
   * How to treat a switch to the slot that is already active. Return `[action, provenance]`:
   *
   * - `["noop", null]`: the live credential matches the backup (issue #79).
   * - `["reconcile", provenance]`: the live credential diverged and its owner
   *   resolved. The full switch classifies it.
   * - `["noop-diverged", null]`: diverged, but not classifiable (offline). A
   *   silent no-op: activating the backup over an unverified live credential
   *   can replace a new token with its consumed ancestor.
   */
  async selfSwitchAction(slot: string, email: string): Promise<[string, Provenance | null]> {
    if (this.liveMatchesSlotBackup(slot, email)) return ["noop", null];
    const provenance = await this.prefetchLiveIdentity();
    if (provenance.resolved === null || provenance.resolved === undefined) {
      this.logger.info(
        "Live credential diverges from Account-%s's stored backup " +
          "and ownership could not be verified; self-switch left " +
          "everything untouched (pre-fix no-op).",
        slot,
      );
      return ["noop-diverged", null];
    }
    return ["reconcile", provenance];
  }

  /**
   * Resolve the owner of the live credential BEFORE the locks are taken.
   *
   * If the live bytes or lineage match the backup of the slot, no network is
   * needed. Else only the API can say whose token it is, and a network call
   * must not run under the locks. `resolved` is valid only while the live bytes do
   * not change: the classifier under the lock checks the bytes again.
   */
  async prefetchLiveIdentity(): Promise<Provenance> {
    const result: Provenance = { live: null, resolved: null };
    let live: string | null;
    try {
      live = this.readCredentials();
    } catch (e) {
      this.logger.debug(`Pre-lock live credential read failed: ${String(e)}`);
      return result;
    }
    result.live = live;
    if (!live) return result;
    const identity = this.getCurrentAccount();
    if (identity === null) return result;
    const data = this.getSequenceData() ?? {};
    const slot = ClaudeAccountSwitcher.findAccountSlot(data, identity[0], identity[1]);
    if (slot === null) return result;
    const backup = this.readAccountCredentials(slot, identity[0]);
    if (backup === live || oauth.credentialFingerprint(backup) === oauth.credentialFingerprint(live)) return result;
    const accessToken = oauth.extractAccessToken(live);
    if (!accessToken) return result;
    try {
      result.resolved = await oauth.fetchOauthProfile(accessToken);
    } catch (e) {
      // The oracle is advisory and must never fail a switch.
      this.logger.debug(`Profile resolution raised: ${String(e)}`);
    }
    return result;
  }

  /**
   * What the switch-time backup can do with the live credential. Return `[kind, foreignSlot]`:
   *
   * - `own-bytes`: identical to the backup of the slot. Nothing to capture.
   * - `own-family`: the same refresh-token lineage. Back up normally.
   * - `own-rotated`: a full rotation that the profile endpoint resolved to this slot. Back up normally.
   * - `foreign`: uuid-positively another managed slot with another lineage. A
   *   backup here would destroy the only refresh token of this slot (issue #117).
   *   Preserved in a safety copy, never written into a slot.
   * - `foreign-synced`: another managed slot that already holds this lineage. Nothing to do.
   * - `wiped`: an OAuth blob with empty token fields (the invalid_grant reaction
   *   of Claude Code). Never written into a slot.
   * - `alien`: a complete identity (uuid, email, org) that matches no managed
   *   slot. Preserved in a safety copy.
   * - `known-foreign`: the oracle failed now, but a probe of this process
   *   already condemned this lineage. Routed like `alien`.
   * - `unresolved`: the identity could not be established, or only partly.
   *   The caller does the pre-fix backup: the oracle is advisory.
   */
  classifyOutgoingCredential(
    currentAccount: string,
    currentEmail: string,
    originalCreds: string,
    provenance: Provenance,
    data: SequenceData,
  ): [OutgoingKind, string | null] {
    const backup = this.readAccountCredentials(currentAccount, currentEmail);
    if (backup && backup === originalCreds) return ["own-bytes", null];
    if (backup && oauth.credentialFingerprint(backup) === oauth.credentialFingerprint(originalCreds)) {
      return ["own-family", null];
    }
    const liveOauth = oauth.extractOauthData(originalCreds);
    if (liveOauth !== null && !(liveOauth.accessToken || liveOauth.refreshToken)) return ["wiped", null];
    const resolved = provenance.resolved;
    if (resolved === null || resolved === undefined || provenance.live !== originalCreds) {
      if (
        this.probeVerdicts.get(
          this.lineageKey(currentAccount, currentEmail, oauth.credentialFingerprint(originalCreds) ?? ""),
        ) === false
      ) {
        return ["known-foreign", null];
      }
      return ["unresolved", null];
    }
    const rEmail = resolved.email || "";
    const rOrg = resolved.organizationUuid || "";
    const rUuid = textOf(resolved.uuid).trim();
    // The uuid of the outgoing slot first: robust to partial responses and to a changed email.
    const own = recordOf(data, currentAccount) ?? {};
    const ownUuid = textOf(own.uuid).trim();
    const ownOrg = textOf(own.organizationUuid);
    if (rUuid && ownUuid && rUuid === ownUuid && (!rOrg || !ownOrg || rOrg === ownOrg)) return ["own-rotated", null];
    let slot = rEmail ? ClaudeAccountSwitcher.findAccountSlot(data, rEmail, rOrg) : null;
    if (slot !== null && rUuid) {
      // An email+org match with another uuid is another account with a recycled email.
      const storedUuid = textOf((recordOf(data, slot) ?? {}).uuid).trim();
      if (storedUuid && storedUuid !== rUuid) slot = null;
    }
    if (slot === null && rUuid) {
      // The stored email can be stale or synthesized: try the org-scoped uuid.
      for (const [num, acct] of Object.entries(accountsOf(data))) {
        if (acct.uuid && acct.uuid === rUuid && textOf(acct.organizationUuid) === rOrg) {
          slot = num;
          break;
        }
      }
    }
    if (slot === currentAccount) return ["own-rotated", null];
    if (slot === null) {
      // A positive "alien" needs a complete identity. A partial one is like schema drift: fail open.
      if (rEmail && resolved.organizationUuid !== null && resolved.organizationUuid !== undefined) {
        return ["alien", null];
      }
      return ["unresolved", null];
    }
    // A cross-slot attribution must be uuid-positive.
    const storedUuid = textOf((recordOf(data, slot) ?? {}).uuid).trim();
    if (!rUuid || storedUuid !== rUuid) return ["alien", null];
    const foreignEmail = textOf(pyGet(recordOf(data, slot) ?? {}, "email", ""));
    const foreignBackup = this.readAccountCredentials(slot, foreignEmail);
    if (
      foreignBackup &&
      (foreignBackup === originalCreds ||
        oauth.credentialFingerprint(foreignBackup) === oauth.credentialFingerprint(originalCreds))
    ) {
      return ["foreign-synced", slot];
    }
    return ["foreign", slot];
  }

  /**
   * Preserve a live credential with no owner before it is overwritten. Throws
   * on failure: a successful stash is the license to overwrite the live store.
   * The logged evidence also helps to find what wrote the credential.
   */
  stashLiveCredential(
    originalCreds: string,
    reason: string,
    currentAccount: string,
    resolved: oauth.AccountIdentity | null,
  ): string {
    let credsMtime: string | null = null;
    try {
      const mtimeMs = fs.statSync(getCredentialsPath()).mtimeMs;
      credsMtime = new Date(Math.floor(mtimeMs / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    } catch (e) {
      // The Keychain backend, or no file.
      if (!isOsError(e)) throw e;
    }
    let liveOauthAccount: unknown = null;
    try {
      const config = this.readJson(this.getClaudeConfigPath());
      if (isRecord(config)) liveOauthAccount = config.oauthAccount ?? null;
    } catch {
      // Evidence only.
    }
    const entryId = this.store.writeUnclaimedCredential(originalCreds, {
      reason,
      configSlot: currentAccount,
      fingerprint: oauth.credentialFingerprint(originalCreds),
      liveOauthAccount,
      resolvedIdentity: resolved,
      credentialsMtime: credsMtime,
    });
    this.logger.warning(
      "Live credential does not belong to Account-%s (%s): stashed as %s " +
        "(credentials mtime %s). Something outside cswap rewrote the live " +
        "login after the last switch.",
      currentAccount,
      reason,
      entryId,
      credsMtime ?? "unknown",
    );
    return entryId;
  }

  /**
   * The stored credential of the switch target, or a `SwitchError` that says
   * why there is none. An unreadable backup must not send the user to add the
   * account again: that burns the stored grant.
   */
  readTargetCredentials(accountNum: string, email: string): string {
    const [creds, unreadable] = this.readAccountCredentialsEx(accountNum, email);
    if (creds) return creds;
    if (unreadable) {
      throw new SwitchError(
        `Account-${accountNum}'s backup is in the macOS Keychain ` +
          "but it is unreadable right now (locked or no GUI " +
          "session). Retry from a GUI terminal; do not re-add.",
      );
    }
    throw new SwitchError(
      `Account-${accountNum} has no stored credentials. Re-add with: cswap --add-account --slot ${accountNum}`,
    );
  }

  /**
   * Refuse to change the live store from inside a `cswap run` shell. A
   * `CLAUDE_CONFIG_DIR` inside a session profile means this shell IS a
   * session, and its "live store" is the profile. Every entry point that
   * changes the live store or the roster calls this.
   */
  refuseSessionShell(): void {
    const cfgDir = process.env.CLAUDE_CONFIG_DIR;
    if (!cfgDir) return;
    const rel = path.relative(resolvePath(path.join(this.backupDir, "sessions")), resolvePath(cfgDir));
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
    throw new SwitchError(
      "This shell is inside a cswap run session profile " +
        "(CLAUDE_CONFIG_DIR points at it). Mutating accounts here would " +
        "operate on the wrong live store — unset CLAUDE_CONFIG_DIR " +
        "or run from a normal shell.",
    );
  }

  /**
   * Do the account switch, with a rollback on failure.
   *
   * Return `{ from, to, warnings }`, captured under the lock. With
   * `emitOutput` false (JSON mode), no human output is printed, and the
   * live-session warning goes into `warnings`.
   *
   * `forceActivate` takes the direct activation path also when a managed live
   * login exists: the stored backup is written over the live credentials with
   * no backup of them first.
   *
   * The display after the switch runs after the locks are released, so the
   * persist callbacks inside `listAccounts()` can take them again.
   */
  async performSwitch(
    targetAccount: string,
    emitOutput = true,
    forceActivate = false,
    provenance: Provenance | null = null,
  ): Promise<SwitchOp> {
    this.refuseSessionShell();
    const warningsOut: string[] = [];
    // Session-mode drift. A live session profile of the target puts one refresh
    // token in two config dirs: a warning. If the profile already rotated past
    // the backup, the backup is a consumed generation: refuse. With nothing
    // running against the profile, adopt its credential into the backup first.
    const preData = this.getSequenceData() ?? {};
    const preAccount = recordOf(preData, targetAccount) ?? {};
    const preEmail = textOf(pyGet(preAccount, "email", ""));
    if (preEmail) {
      const preOrg = textOf(preAccount.organizationUuid);
      const [sessions, unreadable] = session.scanLiveSessions(this.sessionDir(targetAccount, preEmail));
      const pids = sessions.map((s) => s.pid);
      if (pids.length > 0 || unreadable) {
        if (this.sessionProfileAhead(targetAccount, preEmail, preOrg)) {
          const who =
            pids.length > 0
              ? `a live session-mode Claude instance (PID ${pids.join(", ")})`
              : `${unreadable} session record(s) that could not be read`;
          throw new SwitchError(
            `Account-${targetAccount} (${preEmail}) has ${who}, and ` +
              "its session profile's credential has rotated past the " +
              "stored backup: the backup is a consumed generation, and " +
              "activating it would fail with invalid_grant on its first " +
              "refresh. Exit the session (its credential is adopted into " +
              "the backup once nothing runs against it), or switch to " +
              "another account.",
          );
        }
        if (pids.length > 0) {
          const msg =
            `Account-${targetAccount} (${preEmail}) has a live ` +
            "session-mode Claude instance " +
            `(PID ${pids.join(", ")}). Running the same ` +
            "account as both the default login and a session can make " +
            "one copy's token go stale if the server rotates it. If the " +
            "session later fails to authenticate, exit it and re-run " +
            `'cswap run ${targetAccount}'.`;
          if (emitOutput) warning(msg);
          else warningsOut.push(msg);
        }
      } else {
        await whenIdle([this.lockFile], () => this.adoptSessionCredential(targetAccount, preEmail, preOrg));
      }
    }

    // The identity resolution can use the network, so it runs before the locks.
    // The force activation never backs up the live credential, so it skips it.
    if (provenance === null) {
      provenance = forceActivate ? { live: null, resolved: null } : await this.prefetchLiveIdentity();
    }
    const prov = provenance;

    // Hold the locks of Claude Code too: its token refresh re-reads the
    // credentials under ~/.claude.lock, and ~/.claude.json.lock keeps the
    // oauthAccount splice away from its config writes. Only local I/O runs here.
    let targetEmail = "";
    let toRef: AccountRef = accountRef(null, "");
    let fromRef: AccountRef | null = null;
    let data: SequenceData = {};
    let directDone = false;
    await whenIdle([this.lockFile], () =>
        holdSync(
        [
          () => enterFileLock(this.lockFile),
          () => claudeLocks.acquireClaudeCredentialsLock(),
          () => claudeLocks.acquireClaudeConfigLock(),
        ],
        () => {
          data = this.getSequenceData() ?? {};
          const activeAccount = data.activeAccountNumber;
          let currentAccount: string | null =
            activeAccount !== null && activeAccount !== undefined ? String(activeAccount) : null;
          const targetRecord = accountsOf(data)[targetAccount];
          if (targetRecord === undefined) throw new TypeError(`KeyError: '${targetAccount}'`);
          targetEmail = targetRecord.email as string;
          toRef = accountRef(pyInt(targetAccount), targetEmail);
          const currentIdentity = this.getCurrentAccount();
          if (currentIdentity !== null) {
            const [currentEmail, currentOrgUuid] = currentIdentity;
            currentAccount = ClaudeAccountSwitcher.findAccountSlot(data, currentEmail, currentOrgUuid);
          }

          const configPath = this.getClaudeConfigPath();

          // Direct activation: no live session yet (after an import), no tracked
          // active account, or --force. Skip the backup of the current login: it
          // would write account-None backups, or (force) poison the stored backup.
          if (forceActivate || currentIdentity === null || currentAccount === null) {
            if (currentIdentity === null) fromRef = null;
            else if (currentAccount === null) fromRef = accountRef(null, currentIdentity[0]);
            else fromRef = accountRef(pyInt(currentAccount), currentIdentity[0]);
            const targetCreds = this.readTargetCredentials(targetAccount, targetEmail);
            const targetConfig = this.readAccountConfig(targetAccount, targetEmail);
            if (!targetConfig) {
              throw new SwitchError(
                `Account-${targetAccount} has no stored config backup. ` +
                  `Re-add with: cswap --add-account --slot ${targetAccount}`,
              );
            }
            let targetConfigData: JsonObject;
            try {
              targetConfigData = JSON.parse(targetConfig) as JsonObject;
            } catch (exc) {
              if (!(exc instanceof SyntaxError)) throw exc;
              throw new SwitchError(`Invalid backup config: ${exc.message}`);
            }
            const targetOauth = isRecord(targetConfigData) ? targetConfigData.oauthAccount : undefined;
            if (!truthyDict(targetOauth)) throw new SwitchError("Invalid oauthAccount in backup");

            // Snapshot the live state, so a failure can be undone. An unreadable
            // snapshot (null) fails fast. "" means absent and restores nothing.
            let rollbackConfigText: string | null = null;
            let rollbackCreds: string | null = this.readCredentials();
            if (rollbackCreds === null) throw new CredentialReadError("Cannot snapshot live credentials before activation");
            if (currentIdentity === null) {
              // Fresh machine: "" means nothing to preserve.
              rollbackCreds = rollbackCreds || null;
            }
            if (fs.existsSync(configPath)) {
              try {
                rollbackConfigText = fs.readFileSync(configPath, "utf8");
              } catch (e) {
                if (!isOsError(e)) throw e;
                throw new ConfigError(`Cannot snapshot live config before activation: ${e.message}`);
              }
            }

            // Invariant II (issue #117): this path skips the backup, so stash the
            // live credential first. A failed stash aborts, except under --force.
            if (rollbackCreds && rollbackCreds !== targetCreds) {
              try {
                this.stashLiveCredential(rollbackCreds, "displaced-live-login", currentAccount ?? "unmanaged", null);
              } catch (e) {
                if (!forceActivate) {
                  throw new SwitchError(
                    "Could not preserve the live credential before " +
                      `activation (safety-copy write failed: ${errorText(e)}); ` +
                      "aborting rather than destroying it",
                  );
                }
                const msg =
                  "Could not preserve the replaced live credential " +
                  `(safety-copy write failed: ${errorText(e)}) — proceeding ` +
                  "because --force explicitly rewrites the live login.";
                if (emitOutput) warning(msg);
                else warningsOut.push(msg);
              }
            }

            let credsWritten = false;
            let configWritten = false;
            try {
              this.writeCredentials(this.prepareCredentialsForActivation(targetCreds, rollbackCreds));
              credsWritten = true;

              // Keep the local settings and projects: splice only oauthAccount. An
              // unreadable config is copied aside before it is replaced. A VALID
              // but empty `{}` is readable and is spliced.
              const existingConfig = fs.existsSync(configPath) ? this.readJson(configPath) : null;
              if (existingConfig !== null) {
                existingConfig.oauthAccount = targetOauth;
                this.writeJson(configPath, existingConfig);
              } else {
                if (fs.existsSync(configPath)) this.salvageUnreadable(configPath, emitOutput, warningsOut);
                this.writeJson(configPath, targetConfigData);
              }
              configWritten = true;

              data.activeAccountNumber = pyInt(targetAccount);
              data.lastUpdated = getTimestamp();
              this.writeJson(this.sequenceFile, data);
            } catch (e) {
              if (configWritten && rollbackConfigText !== null) {
                try {
                  fs.writeFileSync(configPath, rollbackConfigText, "utf8");
                  if (process.platform !== "win32") fs.chmodSync(configPath, 0o600);
                } catch (rollbackError) {
                  this.logger.error(`Failed to rollback config: ${errorText(rollbackError)}`);
                }
              }
              if (credsWritten && rollbackCreds !== null) {
                try {
                  this.writeCredentials(rollbackCreds);
                } catch (rollbackError) {
                  this.logger.error(`Failed to rollback credentials: ${errorText(rollbackError)}`);
                }
              }
              throw e;
            }

            if (forceActivate && currentIdentity !== null) {
              this.logger.info(`Activated account ${targetAccount} (forced, backup of current login skipped)`);
            } else {
              this.logger.info(`Activated account ${targetAccount} (no prior live account)`);
            }
            directDone = true;
            return;
          }

          const [currentEmail] = currentIdentity;
          fromRef = accountRef(pyInt(currentAccount), currentEmail);

          let originalCreds: string | null;
          let originalConfig: string;
          try {
            originalCreds = this.readCredentials();
            if (originalCreds === null) throw new CredentialReadError("Failed to read current credentials");
            if (!originalCreds) {
              // An empty read (a Keychain timeout returns "") must NOT be written
              // over the backup of the departing account.
              throw new CredentialReadError(
                "Current account credential is empty (Keychain unreadable?); refusing to overwrite its backup",
              );
            }
            originalConfig = fs.readFileSync(configPath, "utf8");
          } catch (e) {
            if (isFileNotFound(e)) throw new ConfigError("Claude config file not found");
            if (isPermissionError(e)) throw new ConfigError("Permission denied reading Claude config");
            throw e;
          }

          const transaction = new SwitchTransaction({
            originalCredentials: originalCreds,
            originalConfig,
            originalAccountNum: currentAccount,
            originalEmail: currentEmail,
            configPath,
          });

          try {
            // Step 1: back up the current account. Only the classification says
            // who owns the live bytes (issue #117). "unresolved" falls back to
            // the pre-fix backup, so the endpoint state never blocks a switch.
            const [kind, foreignSlot] = this.classifyOutgoingCredential(
              currentAccount,
              currentEmail,
              originalCreds,
              prov,
              data,
            );
            if (kind === "foreign" || kind === "alien" || kind === "known-foreign") {
              // Not the bytes of this slot: never into a slot, never destroyed.
              // The stash throws on failure, which aborts before the live store changes.
              this.stashLiveCredential(originalCreds, kind, currentAccount, prov.resolved);
              let msg: string;
              if (kind === "foreign") {
                msg =
                  "Credential ownership mismatch detected. The live " +
                  "credential was preserved and was not written " +
                  `into Account-${currentAccount}. If Account-` +
                  `${foreignSlot} later cannot authenticate, log ` +
                  "in as it and run: cswap add --slot " +
                  `${foreignSlot}`;
              } else if (kind === "known-foreign") {
                msg =
                  "The live credential was previously identified " +
                  "as another account's. It was preserved and not " +
                  `written into Account-${currentAccount}. If the ` +
                  "owning account later cannot authenticate, log " +
                  "in as it and run: cswap add";
              } else {
                msg =
                  "The live login does not match a managed " +
                  "account. It was preserved and not written into " +
                  `Account-${currentAccount}. If you need that ` +
                  "account, log in as it and run: cswap add";
              }
              if (emitOutput) warning(msg);
              else warningsOut.push(msg);
            } else if (kind === "foreign-synced") {
              const msg =
                "Credential ownership mismatch detected. The live " +
                `credential already matches Account-${foreignSlot}'s ` +
                "stored backup, so nothing was written into " +
                `Account-${currentAccount}.`;
              if (emitOutput) warning(msg);
              else warningsOut.push(msg);
            } else if (kind === "wiped") {
              // The tokens are empty. Writing them would replace the only refresh
              // token of the slot. Back up the config only.
              this.writeAccountConfig(currentAccount, currentEmail, originalConfig);
              const msg =
                "The live credential's tokens were wiped (Claude " +
                "Code clears them when a refresh is rejected). " +
                `Account-${currentAccount}'s stored backup was ` +
                "kept. If the account cannot authenticate after " +
                "switching back, log in with Claude Code and run: " +
                "cswap add";
              if (emitOutput) warning(msg);
              else warningsOut.push(msg);
            } else if (kind === "unresolved") {
              // Fail open: the pre-fix backup. Most divergences are the own
              // rotation of the account. Log only: a warning would cry wolf.
              this.writeAccountCredentials(currentAccount, currentEmail, originalCreds);
              this.writeAccountConfig(currentAccount, currentEmail, originalConfig);
              this.logger.info(
                `Backed up account ${currentAccount} (lineage ` +
                  "differs from the stored backup and ownership could " +
                  "not be verified — pre-fix backup)",
              );
            } else if (kind === "own-bytes") {
              this.writeAccountConfig(currentAccount, currentEmail, originalConfig);
              this.logger.info(`Backed up account ${currentAccount} (config only; credentials unchanged)`);
            } else {
              this.writeAccountCredentials(currentAccount, currentEmail, originalCreds);
              this.writeAccountConfig(currentAccount, currentEmail, originalConfig);
              if (kind === "own-rotated") {
                // The profile call proved the identity: fill a missing slot uuid now.
                const resolved = prov.resolved;
                const acct = recordOf(data, currentAccount);
                if (acct && !acct.uuid && resolved && resolved.uuid) acct.uuid = resolved.uuid;
              }
              this.logger.info(`Backed up account ${currentAccount}`);
            }

            // Step 2: the target account.
            const targetCreds = this.readTargetCredentials(targetAccount, targetEmail);
            const targetConfig = this.readAccountConfig(targetAccount, targetEmail);
            if (!targetConfig) {
              throw new SwitchError(
                `Account-${targetAccount} has no stored config backup. ` +
                  `Re-add with: cswap --add-account --slot ${targetAccount}`,
              );
            }

            // Step 3: activate the credentials of the target.
            this.writeCredentials(this.prepareCredentialsForActivation(targetCreds, originalCreds));
            transaction.recordStep("credentials_written");
            this.logger.info("Wrote target credentials");

            // Step 4: the oauthAccount of the target into the config.
            const targetConfigData = JSON.parse(targetConfig) as JsonObject;
            const oauthSection = isRecord(targetConfigData) ? targetConfigData.oauthAccount : undefined;
            if (!truthyDict(oauthSection)) throw new SwitchError("Invalid oauthAccount in backup");

            // An absent or unreadable config is copied aside and replaced, as in the direct path.
            const currentConfigData = this.readJson(configPath);
            if (currentConfigData !== null) {
              currentConfigData.oauthAccount = oauthSection;
              this.writeJson(configPath, currentConfigData);
            } else {
              if (fs.existsSync(configPath)) this.salvageUnreadable(configPath, emitOutput, warningsOut);
              this.writeJson(configPath, targetConfigData);
            }
            transaction.recordStep("config_written");
            this.logger.info("Updated config file");

            // Step 5: the sequence state.
            data.activeAccountNumber = pyInt(targetAccount);
            data.lastUpdated = getTimestamp();
            this.writeJson(this.sequenceFile, data);
            transaction.recordStep("sequence_updated");

            this.logger.info(`Switched from account ${currentAccount} to ${targetAccount}`);
          } catch (e) {
            const message = e instanceof SyntaxError ? e.message : errorText(e);
            this.logger.error(`Switch failed: ${message}, attempting rollback`);
            if (transaction.completedSteps.length > 0) {
              const success = transaction.rollback(this);
              if (success) {
                this.logger.info("Rollback successful");
                throw new SwitchError(`Switch failed and was rolled back: ${message}`);
              }
              this.logger.error("Rollback failed!");
              throw new SwitchError(`Switch failed and rollback also failed: ${message}. Manual recovery may be needed.`);
            }
            throw e;
          }
        },
      ),
    );

    if (directDone) {
      if (emitOutput) {
        print(`${accent("Activated")} Account-${targetAccount} (${targetEmail})`);
        print();
        this.printSwitchFollowup();
        print();
      }
      this.replanNewActive(targetAccount, targetEmail, textOf(pyGet(recordOf(data, targetAccount), "organizationUuid", "")));
      return { from: fromRef, to: toRef, warnings: warningsOut };
    }

    // The locks are released: network I/O and the persist callbacks of
    // `listAccounts()` can run. Display only, so JSON mode skips it.
    if (emitOutput) {
      print(`${accent("Switched to")} Account-${targetAccount} (${targetEmail})`);
      try {
        await this.listAccounts();
      } catch (e) {
        this.logger.warning(`Post-switch usage display failed: ${String(e)}`);
        print(dimmed("  (usage display unavailable — run `cswap --list` to retry)"));
      }
      print();
      this.printSwitchFollowup();
      print();
    }
    this.replanNewActive(targetAccount, targetEmail, textOf(pyGet(recordOf(data, targetAccount), "organizationUuid", "")));
    return { from: fromRef, to: toRef, warnings: warningsOut };
  }

  /**
   * The note after a successful switch, for the backend that the active
   * credential write used. A restart is never required: Claude Code drops its
   * cached token when `.credentials.json` changes, or after the Keychain cache TTL (~30 s).
   */
  printSwitchFollowup(): void {
    let backend = this.lastActiveCredentialsBackend;
    if (backend === null || backend === undefined) {
      // No write in this run: use the routing hint.
      backend = this.useKeychain() ? "keychain" : "file";
    }
    if (backend === "keychain") {
      print(
        dimmed(
          "Restart Claude Code to apply immediately — otherwise the " +
            "session can take up to ~30 seconds to pick up the new account.",
        ),
      );
    } else {
      print(dimmed("New account is active on your next message — no restart needed."));
    }
  }

  /**
   * Remove all traces of claude-swap from the system: the stored credentials
   * (the `.enc` files, and on macOS the Keychain items), a best-effort sweep
   * of the legacy keyring entries, the backup directory, and a stale legacy
   * `~/.claude-swap-backup` directory.
   */
  purge(): void {
    this.refuseSessionShell();
    const legacy = getLegacyBackupRoot();
    const legacyDistinct = legacy !== this.backupDir;

    // Refuse while a session-mode claude runs: the purge would pull its profile out from under it.
    const sessionsRoot = path.join(this.backupDir, "sessions");
    let sessionDirs: string[] = [];
    if (isDirectory(sessionsRoot)) {
      sessionDirs = fs
        .readdirSync(sessionsRoot)
        .map((name) => path.join(sessionsRoot, name))
        .filter((d) => isDirectory(d));
    }

    const live = new Map<string, number[]>();
    const unreadable = new Map<string, number>();
    for (const d of sessionDirs) {
      const [sessions, bad] = session.scanLiveSessions(d);
      if (sessions.length > 0) live.set(path.basename(d), sessions.map((s) => s.pid));
      else if (bad) unreadable.set(path.basename(d), bad);
    }
    if (live.size > 0) {
      const details = [...live].map(([name, pids]) => `${name} (PID ${pids.join(", ")})`).join("; ");
      throw new SessionError(`Live session-mode Claude instance(s) found: ${details}. Exit them first, then retry --purge.`);
    }
    if (unreadable.size > 0) {
      const details = [...unreadable].map(([name, n]) => `${name} (${n} record(s))`).join("; ");
      throw new SessionError(
        `Session records that could not be read: ${details}. Whether a ` +
          "Claude instance is live cannot be determined, and purging " +
          "would pull a live profile out from under it. Repair or remove " +
          "them, then retry --purge.",
      );
    }

    warning("This will remove ALL claude-swap data from your system:");
    print(`  - Backup directory: ${this.backupDir}`);
    if (legacyDistinct && fs.existsSync(legacy)) print(`  - Legacy backup directory: ${legacy}`);
    if (this.platform === Platform.MACOS) print("  - All stored account credentials (macOS Keychain and/or files)");
    else print("  - All stored account credential files");
    if (sessionDirs.length > 0) print("  - All session profiles and their Keychain entries");
    print();
    print(dimmed("Note: This does NOT affect your current Claude Code login."));
    print();

    const confirm = internals.input("Are you sure you want to purge all data? [y/N] ");
    if (confirm.toLowerCase() !== "y") {
      print(dimmed("Cancelled"));
      return;
    }

    const removedItems: string[] = [];

    // On macOS the backups can be in the Keychain and in .enc files. Elsewhere they are files only.
    const data = this.getSequenceData();
    if (truthyDict(data)) {
      for (const [accountNum, accountInfo] of Object.entries(accountsOf(data))) {
        const email = textOf(pyGet(accountInfo, "email", ""));
        const nums = [accountNum];
        if (String(accountNum) !== "None") nums.push("None");
        const usernames = nums.map((num) => `account-${num}-${email}`);

        for (const num of nums) {
          const credFile = path.join(this.credentialsDir, `.creds-${num}-${email}.enc`);
          try {
            if (fs.existsSync(credFile)) {
              fs.unlinkSync(credFile);
              removedItems.push(`Credential file: ${path.basename(credFile)}`);
            }
          } catch {
            // Ignore errors during the purge.
          }
        }

        if (this.platform === Platform.MACOS) {
          for (const username of usernames) {
            try {
              macosKeychain.deletePassword(SECURITY_SERVICE, username);
              removedItems.push(`Credential: ${username}`);
            } catch {
              // Ignore errors during the purge.
            }
          }
        }

        // The entries that an incomplete keyring migration left behind. Linux and WSL never used a keyring.
        if (this.platform === Platform.MACOS || this.platform === Platform.WINDOWS) {
          sweepLegacyKeyring(this.platform, usernames, removedItems);
        }
      }
    }

    // WARNING: The session keychain entries must go BEFORE the backup dir:
    // their hashed service names come from the dir paths.
    if (sessionDirs.length > 0) {
      for (const d of sessionDirs) session.deleteMacosKeychainEntry(d);
      removedItems.push(`Session profiles: ${sessionDirs.map((d) => path.basename(d)).join(", ")}`);
    }

    if (fs.existsSync(this.backupDir)) {
      // Close the log handlers first (Windows requires it).
      for (const handler of [...this.logger.handlers]) {
        handler.close();
        this.logger.removeHandler(handler);
      }
      fs.rmSync(this.backupDir, { recursive: true });
      removedItems.push(`Directory: ${this.backupDir}`);
    }

    if (legacyDistinct && fs.existsSync(legacy)) {
      try {
        fs.rmSync(legacy, { recursive: true });
        removedItems.push(`Legacy directory: ${legacy}`);
      } catch (e) {
        if (!isOsError(e)) throw e;
      }
    }

    if (removedItems.length > 0) {
      print(`\n${accent("Removed:")}`);
      for (const item of removedItems) print(`  ${dimmed("-")} ${item}`);
    } else {
      print(`\n${dimmed("No claude-swap data found to remove.")}`);
    }

    print(`\n${accent("Purge complete.")}`);
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function refsEqual(a: AccountRef | null, b: AccountRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.number === b.number && a.email === b.email;
}

/** `sequence.index(int(value))`, or -1 where Python raises. */
function indexOfInt(sequence: readonly number[], value: unknown): number {
  let n: number;
  try {
    n = pyInt(value);
  } catch {
    return -1;
  }
  return sequence.indexOf(n);
}

function removeFromSequence(data: SequenceData, n: number): void {
  const seq = sequenceOf(data);
  const i = seq.indexOf(n);
  if (i >= 0) seq.splice(i, 1);
  data.sequence = seq;
}

function addToSequence(data: SequenceData, n: number): void {
  const seq = sequenceOf(data);
  if (!seq.includes(n)) {
    seq.push(n);
    numericSort(seq);
  }
  data.sequence = seq;
}

/**
 * Best-effort removal of the legacy `KEYRING_SERVICE` entries. On macOS the
 * Python `keyring` backend stored them as generic passwords in the login
 * Keychain. Windows Credential Manager has no Node binding here, so Windows
 * skips the sweep. Never throws.
 */
export function sweepLegacyKeyring(platform: Platform, usernames: readonly string[], removedItems: string[]): void {
  if (platform !== Platform.MACOS) return;
  for (const username of usernames) {
    try {
      if (!macosKeychain.itemExists(KEYRING_SERVICE, username)) continue;
      macosKeychain.deletePassword(KEYRING_SERVICE, username);
      removedItems.push(`Legacy keyring credential: ${username}`);
    } catch {
      // Absent, or the Keychain is not available: nothing to clean.
    }
  }
}
