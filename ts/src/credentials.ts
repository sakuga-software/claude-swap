/**
 * Credential storage layer for claude-swap.
 *
 * `CredentialStore` owns where the credentials live and how the code reads and
 * writes them: the macOS Keychain or file routing, the Keychain capability
 * detection for each process, and the `.enc`-wins backup reconciliation.
 * It reads its configuration from a data-only host view and never calls a
 * method of the switcher.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CredentialError, CredentialReadError, CredentialWriteError } from "./exceptions.js";
import { replaceWithRetry } from "./fsutil.js";
import { FileLock } from "./locking.js";
import { type Logger, getLogger } from "./logging_config.js";
import * as macosKeychain from "./macos_keychain.js";
import { Platform } from "./models.js";
import {
  getClaudeConfigHome,
  getCredentialsPath,
  getDefaultClaudeConfigHome,
  getGlobalConfigPath,
} from "./paths.js";
import { keychainServiceName } from "./session.js";
import { atomicWriteJson, internals as settingsInternals } from "./settings.js";
import { resolvePath } from "./support/pathlib.js";
import { jsonDumps } from "./support/py.js";
import { sleepSync } from "./support/sleep.js";

export { Platform };

const logger = getLogger("claude-swap");

/**
 * Service name of the per-account backup items. It is different from the old
 * keyring service, so old and new items can exist together during a migration.
 */
export const SECURITY_SERVICE = "claude-swap";

/** Service name of the active OAuth credential of Claude Code in the macOS Keychain. */
export const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Service name of the active managed API key of Claude Code in the macOS Keychain.
 * Off macOS the managed key is `primaryApiKey` in `~/.claude.json`.
 */
export const CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE = "Claude Code";

/**
 * After a Keychain failure, a long-running daemon probes the Keychain again
 * after this many seconds. A CLI command ends before this time, so one
 * command never uses two backends.
 */
export const KEYCHAIN_RECHECK_COOLDOWN_S = 60.0;

/**
 * Machine-shared siblings of `claudeAiOauth`. On activation the live copy of
 * these keys wins. All other keys stay with the target slot.
 */
export const SHARED_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "mcpOAuth",
  "mcpOAuthClientConfig",
  "mcpXaaIdp",
  "mcpXaaIdpConfig",
  "pluginSecrets",
]);

/** Account-scoped siblings that cswap knows. The unknown-key probe does not report them. */
export const ACCOUNT_CREDENTIAL_KEYS: ReadonlySet<string> = new Set(["claudeAiOauth", "trustedDeviceToken"]);

/** Seams and bounds that the tests change. */
export const internals = {
  /** Attempts of the active OAuth Keychain read. A locked Keychain can fail one `security` call. */
  ACTIVE_READ_ATTEMPTS: 2,
  /** Seconds between two attempts of the active OAuth Keychain read. */
  ACTIVE_READ_RETRY_DELAY: 0.3,
  /** `time.monotonic()`, in seconds. */
  monotonic: (): number => performance.now() / 1000,
  /** `time.time()`, in seconds. */
  time: (): number => Date.now() / 1000,
  /** `time.sleep()`, in seconds. */
  sleep: (seconds: number): void => sleepSync(seconds * 1000),
  /** `secrets.token_hex(3)`. */
  tokenHex: (bytes: number): string => randomBytes(bytes).toString("hex"),
};

/**
 * Outcome of a read of the active credential of Claude Code.
 *
 * - `value`: the credential (OAuth JSON or a raw managed key), `""` if no
 *   backend has one, or `null` on a plaintext file read error.
 * - `keychainUnavailable`: true only if the macOS OAuth Keychain read failed
 *   and no other backend gave a credential.
 * - `degraded`: true if the OAuth Keychain read failed, also when a fallback
 *   gave a credential. That credential can be an old generation. You can
 *   serve it, but you must never use its refresh token.
 */
export interface ActiveCredentials {
  value: string | null;
  keychainUnavailable: boolean;
  degraded: boolean;
}

export function activeCredentials(
  value: string | null,
  keychainUnavailable: boolean,
  degraded = false,
): ActiveCredentials {
  return { value, keychainUnavailable, degraded };
}

/** The data-only view of its owner that `CredentialStore` reads at call time. */
export interface StoreHost {
  platform: Platform;
  credentialsDir: string;
  logger: Logger;
}

/** Verdict of a stash manifest read. */
export type StashManifestVerdict = "ok" | "unreadable" | "corrupt";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCode(e: unknown): string | undefined {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A Python `OSError`: a Node system error. */
function isOSError(e: unknown): boolean {
  return e instanceof Error && errCode(e) !== undefined;
}

/** `Path.read_text(encoding="utf-8")`: strict UTF-8, with universal newlines. */
function readText(file: string): string {
  return readUtf8(fs.readFileSync(file)).replace(/\r\n?/g, "\n");
}

function readUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** `base64.b64decode(text, validate=True).decode("utf-8")`. */
function b64decodeStrict(text: string): string {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new RangeError("Invalid base64-encoded string");
  }
  return readUtf8(Buffer.from(text, "base64"));
}

function pyTrim(text: string): string {
  return text.replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/g, "");
}

function unlinkIfExists(file: string): void {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/**
 * Whether the active config home is the config home of the default profile.
 * A path that does not resolve gives false: an unknown profile must not read
 * the credential of the default profile.
 */
function activeProfileIsDefault(): boolean {
  try {
    return resolvePath(getClaudeConfigHome()) === resolvePath(getDefaultClaudeConfigHome());
  } catch {
    return false;
  }
}

/**
 * The Keychain services of the OAuth credential for the active environment,
 * in the order to try. The resolution is the same as the capture read and as
 * Claude Code: a defined `CLAUDE_SECURESTORAGE_CONFIG_DIR` wins (empty means
 * the default store), else `CLAUDE_CONFIG_DIR`. An explicit `CLAUDE_CONFIG_DIR`
 * that names the default profile also tries the unsuffixed item.
 */
export function activeOauthKeychainServices(): string[] {
  const secureEnv = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secureEnv !== undefined) {
    if (!secureEnv) return [CLAUDE_CODE_KEYCHAIN_SERVICE];
    return [keychainServiceName(secureEnv)];
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (!configDir) return [CLAUDE_CODE_KEYCHAIN_SERVICE];
  const services = [keychainServiceName(configDir)];
  if (activeProfileIsDefault()) services.push(CLAUDE_CODE_KEYCHAIN_SERVICE);
  return services;
}

/**
 * Whether an active credential is a raw managed API key and not OAuth JSON.
 * Only a bare `sk-ant-api…` string matches, so a raw `sk-ant-oat…` setup
 * token is never an API key.
 */
export function looksLikeApiKey(credentials: string | null | undefined): boolean {
  if (!credentials) return false;
  const text = pyTrim(credentials);
  return text.startsWith("sk-ant-api") && !text.startsWith("{");
}

function credentialObject(credentials: string | null | undefined): JsonObject | null {
  if (!credentials || looksLikeApiKey(credentials)) return null;
  let data: unknown;
  try {
    data = JSON.parse(credentials);
  } catch {
    return null;
  }
  return isObject(data) ? data : null;
}

/**
 * Return the machine-shared fields (`SHARED_CREDENTIAL_KEYS`) of a Claude OAuth
 * credential object. Returns `null` if the input is not a JSON credential
 * object. An object, also `{}`, is the authority for each shared key: a key
 * that is not in it is not in the shared state of the machine.
 */
export function sharedCredentialFields(credentials: string | null | undefined): JsonObject | null {
  const data = credentialObject(credentials);
  if (data === null) return null;
  if ("claudeAiOauth" in data) {
    const unrecognized = Object.keys(data)
      .filter((key) => !SHARED_CREDENTIAL_KEYS.has(key) && !ACCOUNT_CREDENTIAL_KEYS.has(key))
      .sort();
    if (unrecognized.length > 0) {
      logger.debug(
        "Live credential has sibling keys cswap does not recognize (a newer Claude Code?), treating them as slot-owned: %s",
        `[${unrecognized.map((key) => `'${key}'`).join(", ")}]`,
      );
    }
  }
  const shared: JsonObject = {};
  for (const key of SHARED_CREDENTIAL_KEYS) {
    if (key in data) shared[key] = data[key];
  }
  return shared;
}

/**
 * Compose a target Claude login with the shared fields of the machine.
 * The shared keys of the target go away and `sharedFields` supplies them.
 * Returns `targetCredentials` unchanged if it is not a JSON credential object
 * with a `claudeAiOauth` login.
 */
export function mergeSharedCredentialFields(targetCredentials: string, sharedFields: JsonObject): string {
  const target = credentialObject(targetCredentials);
  if (target === null || !("claudeAiOauth" in target)) return targetCredentials;
  const composed: JsonObject = {};
  for (const [key, value] of Object.entries(target)) {
    if (!SHARED_CREDENTIAL_KEYS.has(key)) composed[key] = value;
  }
  Object.assign(composed, sharedFields);
  return jsonDumps(composed);
}

/**
 * The value that Claude Code stores in `customApiKeyResponses.approved`: the
 * last 20 characters (`normalizeApiKeyForConfig`). A different value makes
 * Claude Code ask the user again to approve the key.
 */
export function approvedForm(apiKey: string): string {
  return pyTrim(apiKey).slice(-20);
}

/**
 * Owns the active and the per-account backup credential stores.
 * One store for each switcher: the capability cache is for one process only.
 */
export class CredentialStore {
  host: StoreHost;
  /** Keychain usability, learned from real `security` calls. `null` until the first call. */
  keychainUsableCache: boolean | null = null;
  /** Monotonic time after which to probe the Keychain again. 0 means no probe is pending. */
  keychainDisabledUntil = 0.0;
  /** True if a write fallback chose file mode, and a failed read did not force it. */
  fileModeIsOurs = false;
  /** True if the last Keychain operation failed. A routing choice does not change it. */
  keychainOpFailed = false;
  /** True if the last active OAuth read could not reach the Keychain. */
  activeReadFailed = false;
  /**
   * What `pinFileMode` saw about the residual active Keychain item:
   * `null` if never pinned, true if the delete returned, false if it failed.
   */
  residualVerdict: boolean | null = null;
  /** The backend of the last active-credential write, for the message after a switch. */
  lastActiveCredentialsBackend: "keychain" | "file" | null = null;

  constructor(host: StoreHost) {
    this.host = host;
  }

  /**
   * Run a `macos_keychain` call and learn the Keychain usability from it.
   *
   * A success changes the cache from `null` to true, never from false to true.
   * A Keychain error sets file mode, starts the cooldown and throws again.
   * Other errors propagate unchanged.
   *
   * WARNING: Do not call `itemExists` through this method. It returns false for
   * "absent" and for "failed", so a timeout looks like a usable Keychain.
   */
  kcCall<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): R {
    let result: R;
    try {
      result = fn(...args);
    } catch (e) {
      if (macosKeychain.isKeychainError(e)) {
        this.keychainOpFailed = true;
        this.keychainUsableCache = false;
        this.keychainDisabledUntil = internals.monotonic() + KEYCHAIN_RECHECK_COOLDOWN_S;
      }
      throw e;
    }
    this.keychainOpFailed = false;
    if (this.keychainUsableCache === null) this.keychainUsableCache = true;
    return result;
  }

  /**
   * Whether credential operations use the macOS Keychain now. False off macOS.
   * After a failure, the store probes the Keychain again when the cooldown
   * ends. A pinned file mode has no deadline and stays.
   */
  useKeychain(): boolean {
    if (this.host.platform !== Platform.MACOS) return false;
    if (
      this.keychainUsableCache === false &&
      this.keychainDisabledUntil &&
      internals.monotonic() >= this.keychainDisabledUntil
    ) {
      this.keychainUsableCache = null;
      this.keychainDisabledUntil = 0.0;
    }
    return this.keychainUsableCache !== false;
  }

  /**
   * Pin file mode for the rest of the process, with no Keychain probe.
   *
   * After a write falls back to the file, an old Keychain item can stay.
   * A later probe could read it and show the wrong account.
   * `residualCleared` is the result of the delete of that item. If it is true,
   * nothing can shadow the file, so the two failure flags are cleared.
   */
  pinFileMode({ residualCleared }: { residualCleared: boolean }): void {
    this.keychainUsableCache = false;
    this.keychainDisabledUntil = 0.0;
    this.fileModeIsOurs = true;
    this.residualVerdict = residualCleared;
    if (residualCleared) {
      this.keychainOpFailed = false;
      this.activeReadFailed = false;
    }
  }

  /**
   * True if the Keychain cannot answer, so an empty read proves nothing.
   * Use this predicate, not `keychainUsableCache`, for "unreadable". It probes
   * through `useKeychain()`, so a cooldown that ended clears the verdict.
   */
  get keychainUnreadable(): boolean {
    if (this.host.platform !== Platform.MACOS) return false;
    if (this.useKeychain()) return false;
    return this.keychainOpFailed;
  }

  /** The active credential: the string, `""` if not found, or `null` on a file read error. */
  readCredentials(): string | null {
    return this.readActiveCredentials().value;
  }

  /**
   * Read the OAuth Keychain items of the active profile in order, and stop at
   * the first hit. Returns `[value, failed]`. An unreadable Keychain stops the
   * walk, because a different service name cannot do better.
   */
  readActiveOauthKeychain(): [string | null, boolean] {
    for (const service of activeOauthKeychainServices()) {
      const [value, failed] = this.readOneOauthKeychain(service);
      if (value) return [value, false];
      if (failed) return [null, true];
    }
    return [null, false];
  }

  /**
   * Read one OAuth Keychain item, with a bounded retry. Returns `[value, failed]`.
   * `failed` is true only if each attempt threw a Keychain error. An absent
   * item (rc 44) gives `[null, false]` and has no retry.
   */
  readOneOauthKeychain(service: string): [string | null, boolean] {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < internals.ACTIVE_READ_ATTEMPTS; attempt++) {
      try {
        const value = this.kcCall(macosKeychain.getPassword, service, macosKeychain.keychainAccountName());
        return [value, false];
      } catch (e) {
        if (!macosKeychain.isKeychainError(e)) throw e;
        lastError = e;
        if (attempt + 1 < internals.ACTIVE_READ_ATTEMPTS) internals.sleep(internals.ACTIVE_READ_RETRY_DELAY);
      }
    }
    this.host.logger.warning(
      `Keychain read failed after ${internals.ACTIVE_READ_ATTEMPTS} attempt(s), trying file: ${errText(lastError)}`,
    );
    return [null, true];
  }

  /**
   * Read the active credential of Claude Code and classify the outcome.
   *
   * Order: the OAuth Keychain item of the active profile (macOS), the plaintext
   * `.credentials.json`, then the managed key (Keychain "Claude Code", then
   * `primaryApiKey`). This function does not change state on disk.
   */
  readActiveCredentials(): ActiveCredentials {
    let keychainFailed = false;
    if (this.useKeychain()) {
      let val: string | null;
      [val, keychainFailed] = this.readActiveOauthKeychain();
      this.activeReadFailed = keychainFailed;
      if (val) return activeCredentials(val, false);
    } else if (this.residualVerdict === false || this.activeReadFailed || this.keychainUnreadable) {
      keychainFailed = true;
    }

    const credFile = getCredentialsPath();
    if (fs.existsSync(credFile)) {
      let text: string;
      try {
        text = readText(credFile);
      } catch (e) {
        this.host.logger.error(`Failed to read credentials file: ${errText(e)}`);
        return activeCredentials(null, keychainFailed, keychainFailed);
      }
      if (pyTrim(text)) return activeCredentials(text, false, keychainFailed);
    }

    const key = this.readManagedKey();
    if (key) return activeCredentials(key, false, keychainFailed);
    return activeCredentials("", keychainFailed, keychainFailed);
  }

  /**
   * Read the active managed API key, or `""`. The Keychain item is read only
   * for the default profile, because its service name for a custom profile is
   * not known. `primaryApiKey` comes from the config of the active profile.
   */
  readManagedKey(): string {
    if (activeProfileIsDefault() && this.useKeychain()) {
      let val: string | null;
      try {
        val = this.kcCall(
          macosKeychain.getPassword,
          CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE,
          macosKeychain.keychainAccountName(),
        );
      } catch (e) {
        if (!macosKeychain.isKeychainError(e)) throw e;
        this.host.logger.warning(`Managed-key Keychain read failed: ${errText(e)}`);
        val = null;
      }
      if (val) return val;
    }
    const cfg = this.readGlobalConfig();
    if (cfg) {
      const key = cfg.primaryApiKey;
      if (typeof key === "string" && key) return key;
    }
    return "";
  }

  /** Read and parse `~/.claude.json`. Returns `null` if it is absent or unreadable. */
  readGlobalConfig(): JsonObject | null {
    const file = getGlobalConfigPath();
    if (!fs.existsSync(file)) return null;
    let data: unknown;
    try {
      data = JSON.parse(readText(file));
    } catch (e) {
      this.host.logger.warning(`Failed to read global config: ${errText(e)}`);
      return null;
    }
    return isObject(data) ? data : null;
  }

  /**
   * Apply `mutator` to `~/.claude.json` atomically (mode 0600). All other keys
   * stay. Throws `CredentialWriteError` if the file exists but is unreadable,
   * because a write would replace content that the code did not read.
   */
  updateGlobalConfig(mutator: (cfg: JsonObject) => void): void {
    const file = getGlobalConfigPath();
    let data: JsonObject | null;
    try {
      data = this.readGlobalConfig();
    } catch (e) {
      throw new CredentialWriteError(`Failed to read global config for update: ${errText(e)}`);
    }
    if (data === null && fs.existsSync(file)) {
      throw new CredentialWriteError(
        `${file} exists but could not be read — refusing to overwrite it. Move or repair the file, then retry.`,
      );
    }
    data = data ?? {};
    mutator(data);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(path.dirname(file), file, jsonDumps(data, 2));
  }

  /** Write the plaintext active-credentials file of Claude Code atomically. */
  writeActiveCredentialsFile(credentials: string): void {
    const credDir = getClaudeConfigHome();
    fs.mkdirSync(credDir, { recursive: true });
    atomicWrite(credDir, path.join(credDir, ".credentials.json"), credentials);
  }

  /**
   * Remove the active-credential Keychain item (macOS only), best-effort.
   * Claude Code reads the Keychain before the file, so an old item can shadow
   * a file fallback. Returns true if no active item can shadow the file.
   */
  deleteActiveKeychainEntry(): boolean {
    if (this.host.platform !== Platform.MACOS) return true;
    try {
      macosKeychain.deletePassword(CLAUDE_CODE_KEYCHAIN_SERVICE, macosKeychain.keychainAccountName());
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Write the active credential of Claude Code, with one auth axis only.
   * An OAuth credential clears the managed key. A managed key clears the OAuth
   * credential. Throws `CredentialWriteError` if the write fails.
   */
  writeCredentials(credentials: string): void {
    if (looksLikeApiKey(credentials)) {
      this.writeManagedCredentials(pyTrim(credentials));
    } else {
      this.writeOauthCredentials(credentials);
      this.clearManagedKey();
    }
  }

  /**
   * Activate a managed API key, then clear the OAuth credential.
   * The key goes to the macOS Keychain if it is usable, else to `primaryApiKey`.
   * `customApiKeyResponses.approved` always gets the last 20 characters.
   */
  writeManagedCredentials(apiKey: string): void {
    let wroteToKeychain = false;
    if (this.useKeychain()) {
      try {
        this.kcCall(
          macosKeychain.setPassword,
          CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE,
          macosKeychain.keychainAccountName(),
          apiKey,
        );
        wroteToKeychain = true;
      } catch (e) {
        if (!macosKeychain.isKeychainError(e)) throw e;
        this.host.logger.warning(`Managed-key Keychain write failed, falling back to config: ${errText(e)}`);
      }
    }

    const approved = approvedForm(apiKey);
    const mutate = (cfg: JsonObject): void => {
      let responses = cfg.customApiKeyResponses;
      if (!isObject(responses)) responses = {};
      const responsesObj = responses as JsonObject;
      let approvedList = responsesObj.approved;
      if (!Array.isArray(approvedList)) approvedList = [];
      const list = approvedList as unknown[];
      if (!list.includes(approved)) list.push(approved);
      responsesObj.approved = list;
      if (!("rejected" in responsesObj)) responsesObj.rejected = [];
      cfg.customApiKeyResponses = responsesObj;
      if (wroteToKeychain) delete cfg.primaryApiKey;
      else cfg.primaryApiKey = apiKey;
    };

    try {
      this.updateGlobalConfig(mutate);
    } catch (e) {
      if (e instanceof CredentialWriteError) throw e;
      throw new CredentialWriteError(`Failed to write managed API key: ${errText(e)}`);
    }

    this.clearOauthCredential();
    if (this.host.platform === Platform.MACOS && !wroteToKeychain) {
      // The item that can shadow here is the MANAGED item, and nothing deleted it.
      this.pinFileMode({ residualCleared: false });
    }
    this.lastActiveCredentialsBackend = wroteToKeychain ? "keychain" : "file";
  }

  /**
   * Clear the active managed API key (Claude Code `removeApiKey`), best-effort.
   * `customApiKeyResponses.approved` stays. If the global config exists but is
   * unreadable, the function logs a warning and does not write it.
   */
  clearManagedKey(): void {
    if (this.host.platform === Platform.MACOS) {
      try {
        macosKeychain.deletePassword(CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE, macosKeychain.keychainAccountName());
      } catch {
        // A Keychain that is down cannot be cleaned now.
      }
    }
    const cfg = this.readGlobalConfig();
    if (cfg === null && fs.existsSync(getGlobalConfigPath())) {
      this.host.logger.warning(
        "Could not clear primaryApiKey: the global config exists but could not be read (unreadable, not absent) — leaving it in place rather than overwriting it unread",
      );
      return;
    }
    if (cfg !== null && cfg.primaryApiKey !== undefined && cfg.primaryApiKey !== null) {
      try {
        this.updateGlobalConfig((c) => {
          delete c.primaryApiKey;
        });
      } catch (e) {
        this.host.logger.warning(`Failed to clear primaryApiKey: ${errText(e)}`);
      }
    }
  }

  /** Clear the active OAuth credential (Keychain item and plaintext file), best-effort. */
  clearOauthCredential(): void {
    this.deleteActiveKeychainEntry();
    const credFile = getCredentialsPath();
    try {
      unlinkIfExists(credFile);
    } catch (e) {
      if (!isOSError(e)) throw e;
      this.host.logger.warning(`Failed to remove credentials file: ${errText(e)}`);
    }
  }

  /**
   * Write the active OAuth credential of Claude Code.
   *
   * On macOS with a usable Keychain, write the Keychain item, then rewrite a
   * `.credentials.json` that already exists, so a running session sees a new
   * mtime and reloads. Never create the file in that case. Otherwise write the
   * file and clear the old Keychain item. Throws `CredentialWriteError`.
   */
  writeOauthCredentials(credentials: string): void {
    if (this.useKeychain()) {
      try {
        this.kcCall(
          macosKeychain.setPassword,
          CLAUDE_CODE_KEYCHAIN_SERVICE,
          macosKeychain.keychainAccountName(),
          credentials,
        );
      } catch (e) {
        if (!macosKeychain.isKeychainError(e)) throw e;
        this.host.logger.warning(`Keychain write failed, falling back to file: ${errText(e)}`);
        return this.writeOauthCredentialsFileMode(credentials);
      }
      this.refreshStaleCredentialsFile(credentials);
      this.lastActiveCredentialsBackend = "keychain";
      return;
    }
    this.writeOauthCredentialsFileMode(credentials);
  }

  private writeOauthCredentialsFileMode(credentials: string): void {
    try {
      this.writeActiveCredentialsFile(credentials);
    } catch (e) {
      throw new CredentialWriteError(`Failed to write credentials: ${errText(e)}`);
    }
    const cleared = this.deleteActiveKeychainEntry();
    if (this.host.platform === Platform.MACOS) {
      this.pinFileMode({ residualCleared: cleared });
    }
    this.lastActiveCredentialsBackend = "file";
  }

  /**
   * After a Keychain write, rewrite a `.credentials.json` that already exists.
   * The new mtime makes a running Claude Code session reload its token.
   * Best-effort: a failure does not fail the switch.
   */
  refreshStaleCredentialsFile(credentials: string): void {
    if (!fs.existsSync(getCredentialsPath())) return;
    try {
      this.writeActiveCredentialsFile(credentials);
    } catch (e) {
      this.host.logger.warning(
        `Could not refresh .credentials.json after Keychain write (${errText(e)}); a running session may not hot-reload until restart`,
      );
    }
  }

  /**
   * Whether the per-account backup writes go to `.enc` files. True off macOS,
   * and on macOS when the Keychain is not usable.
   */
  usesFileBackupBackend(): boolean {
    return !this.useKeychain();
  }

  backupEncPath(accountNum: string, email: string): string {
    return path.join(this.host.credentialsDir, `.creds-${accountNum}-${email}.enc`);
  }

  backupUsername(accountNum: string, email: string): string {
    return `account-${accountNum}-${email}`;
  }

  /** Read a backup from the Keychain only. Returns `""` if absent. Throws on a Keychain failure. */
  kcReadBackup(accountNum: string, email: string): string {
    const creds = this.kcCall(macosKeychain.getPassword, SECURITY_SERVICE, this.backupUsername(accountNum, email));
    return creds || "";
  }

  /** Write a backup to the Keychain only. Throws on failure. */
  kcWriteBackup(accountNum: string, email: string, credentials: string): void {
    this.kcCall(macosKeychain.setPassword, SECURITY_SERVICE, this.backupUsername(accountNum, email), credentials);
  }

  /** Delete a backup Keychain item only. Throws on failure. */
  kcDeleteBackup(accountNum: string, email: string): void {
    this.kcCall(macosKeychain.deletePassword, SECURITY_SERVICE, this.backupUsername(accountNum, email));
  }

  /** Delete the `.prev` Keychain item of a slot. Throws on failure. */
  kcDeleteBackupPrev(accountNum: string, email: string): void {
    this.kcCall(macosKeychain.deletePassword, SECURITY_SERVICE, this.prevBackupUsername(accountNum, email));
  }

  /** Delete a backup Keychain item, best-effort. Never throws. */
  deleteBackupKeychainQuiet(accountNum: string, email: string): void {
    try {
      this.kcDeleteBackup(accountNum, email);
    } catch (e) {
      this.host.logger.warning(`Failed to delete credentials from Keychain: ${errText(e)}`);
    }
  }

  /** Write a per-account backup `.enc` (base64) file atomically. */
  writeBackupEnc(accountNum: string, email: string, credentials: string): void {
    this.atomicB64Write(this.backupEncPath(accountNum, email), credentials);
  }

  /** Write a base64-encoded credential file atomically (mode 0600). */
  atomicB64Write(target: string, credentials: string): void {
    fs.mkdirSync(this.host.credentialsDir, { recursive: true });
    const encoded = Buffer.from(credentials, "utf8").toString("base64");
    atomicWrite(this.host.credentialsDir, target, encoded);
  }

  /**
   * Stop an old `.enc` from shadowing a backup that the Keychain now holds.
   * Delete the `.enc`. If the delete fails, rewrite it with the new credential.
   * If that also fails, throw.
   */
  reconcileEncAfterKeychainWrite(accountNum: string, email: string, credentials: string): void {
    const encFile = this.backupEncPath(accountNum, email);
    if (!fs.existsSync(encFile)) return;
    try {
      fs.unlinkSync(encFile);
      return;
    } catch (e) {
      this.host.logger.warning(
        `Could not delete .enc after Keychain backup write (${errText(e)}); rewriting it with the fresh credentials to keep both consistent`,
      );
    }
    this.writeBackupEnc(accountNum, email, credentials);
  }

  /**
   * Read the backup credential of an account. Returns `""` if it is missing.
   *
   * On macOS the `.enc` wins. Only an absent, empty or corrupt `.enc` falls
   * through to the Keychain. Off macOS only the `.enc` is read. A read that
   * FAILED (not absent) pushes `true` to `failed`.
   */
  readAccountCredentials(accountNum: string, email: string, failed?: boolean[]): string {
    const encFile = this.backupEncPath(accountNum, email);
    let encPresent: boolean;
    try {
      // `stat` and not `existsSync`: a directory that cannot be searched is a failure, not an absent file.
      fs.statSync(encFile);
      encPresent = true;
    } catch (e) {
      if (errCode(e) === "ENOENT") {
        encPresent = false;
      } else if (isOSError(e)) {
        failed?.push(true);
        this.host.logger.warning(`Failed to read credentials file: ${errText(e)}`);
        encPresent = false;
      } else {
        throw e;
      }
    }
    if (encPresent) {
      let encoded: string | undefined;
      try {
        encoded = pyTrim(readText(encFile));
      } catch (e) {
        if (!isOSError(e)) throw e;
        failed?.push(true);
        this.host.logger.warning(`Failed to read credentials file: ${errText(e)}`);
      }
      if (encoded !== undefined) {
        let decoded: string | undefined;
        try {
          decoded = b64decodeStrict(encoded);
        } catch (e) {
          // A corrupt .enc is a content problem and not a read failure, so `failed` stays.
          this.host.logger.warning(`Failed to read credentials file: ${errText(e)}`);
        }
        if (decoded) return decoded;
      }
    }
    if (this.host.platform === Platform.MACOS) {
      try {
        return this.kcReadBackup(accountNum, email);
      } catch (e) {
        if (!macosKeychain.isKeychainError(e)) throw e;
        failed?.push(true);
        this.host.logger.warning(`Failed to read credentials from Keychain: ${errText(e)}`);
      }
    }
    return "";
  }

  /**
   * Read a backup and tell "unreadable" from "absent". Returns `[value, unreadable]`.
   * `unreadable` is true only if THIS read failed: the `.enc` exists but could
   * not be read, or the macOS Keychain read threw.
   */
  readAccountCredentialsEx(accountNum: string, email: string): [string, boolean] {
    const failed: boolean[] = [];
    const value = this.readAccountCredentials(accountNum, email, failed);
    if (value) return [value, false];
    return ["", failed.length > 0];
  }

  /**
   * Write the backup credential of an account. This function only does I/O.
   *
   * Before the write, the current generation becomes the `.prev` copy
   * (best-effort). macOS writes the Keychain if it is usable, then removes the
   * `.enc`. Otherwise it writes the `.enc` and deletes the old Keychain copy.
   * A file write failure throws.
   */
  writeAccountCredentials(accountNum: string, email: string, credentials: string): void {
    this.retainPreviousBackup(accountNum, email, credentials);
    if (this.useKeychain()) {
      let wrote = false;
      try {
        this.kcWriteBackup(accountNum, email, credentials);
        wrote = true;
      } catch (e) {
        if (!macosKeychain.isKeychainError(e)) throw e;
        this.host.logger.warning(`Keychain backup write failed, falling back to file: ${errText(e)}`);
      }
      if (wrote) {
        this.reconcileEncAfterKeychainWrite(accountNum, email, credentials);
        return;
      }
    }

    try {
      this.writeBackupEnc(accountNum, email, credentials);
    } catch (e) {
      this.host.logger.warning(`Failed to write credentials file: ${errText(e)}`);
      throw e;
    }
    if (this.host.platform === Platform.MACOS) this.deleteBackupKeychainQuiet(accountNum, email);
  }

  /**
   * Delete the backup credential of an account from all backends, best-effort.
   * This also deletes the legacy `account-None-{email}` alias and the `.prev` copies.
   */
  deleteAccountCredentials(accountNum: string, email: string): void {
    const nums = [accountNum];
    if (String(accountNum) !== "None") nums.push("None");
    for (const num of nums) {
      try {
        unlinkIfExists(this.backupEncPath(num, email));
      } catch (e) {
        this.host.logger.warning(`Failed to delete credentials file: ${errText(e)}`);
      }
      if (this.host.platform === Platform.MACOS) this.deleteBackupKeychainQuiet(num, email);
      this.deletePreviousBackup(num, email);
    }
  }

  /**
   * Clear a slot key and fail closed. Throws `CredentialError` unless the slot
   * is surely empty. Use it for a clear before a transaction commits.
   * The Keychain delete runs also in file mode.
   */
  deleteAccountCredentialsStrict(accountNum: string, email: string): void {
    this.deleteAccountCredentials(accountNum, email);
    try {
      try {
        fs.unlinkSync(this.backupEncPath(accountNum, email));
      } catch (e) {
        if (errCode(e) !== "ENOENT") throw e;
      }
      if (this.host.platform === Platform.MACOS) this.kcDeleteBackup(accountNum, email);
    } catch (e) {
      if (!isOSError(e) && !macosKeychain.isKeychainError(e)) throw e;
      throw new CredentialError(
        `Could not clear stored credentials for slot ${accountNum} (${email}) — aborting before commit: ${errText(e)}`,
        { cause: e },
      );
    }
    const [value, unreadable] = this.readAccountCredentialsEx(accountNum, email);
    if (value || unreadable) {
      throw new CredentialError(
        `Could not clear stored credentials for slot ${accountNum} (${email}) — aborting before commit`,
      );
    }
  }

  /**
   * Delete the `.prev` generation of a slot key from both backends, best-effort.
   * Call it also when a key changes owner, so a recovery cannot restore the
   * generation of the previous owner.
   */
  deletePreviousBackup(accountNum: string, email: string): void {
    try {
      unlinkIfExists(this.prevBackupPath(accountNum, email));
    } catch (e) {
      this.host.logger.warning(`Failed to delete .prev file: ${errText(e)}`);
    }
    if (this.host.platform === Platform.MACOS) {
      try {
        this.kcDeleteBackupPrev(accountNum, email);
      } catch (e) {
        this.host.logger.warning(`Failed to delete .prev from Keychain: ${errText(e)}`);
      }
    }
  }

  prevBackupPath(accountNum: string, email: string): string {
    return path.join(this.host.credentialsDir, `.creds-${accountNum}-${email}.enc.prev`);
  }

  prevBackupUsername(accountNum: string, email: string): string {
    return `${this.backupUsername(accountNum, email)}.prev`;
  }

  /**
   * Keep the current backup of a slot as `.prev` before it is replaced.
   * The `.prev` goes to the same backend as the backup, so a Keychain Mac
   * gets no plaintext copy. If the current backup is unreadable, write no
   * `.prev`: a copy of the incoming bytes could shadow a real one.
   */
  retainPreviousBackup(accountNum: string, email: string, newCredentials: string): void {
    let current: string;
    let unreadable: boolean;
    try {
      [current, unreadable] = this.readAccountCredentialsEx(accountNum, email);
    } catch (e) {
      this.host.logger.warning(`Could not read backup for retention: ${errText(e)}`);
      return;
    }
    if (unreadable) {
      this.host.logger.warning(
        `Could not retain previous credential generation for account ${accountNum}: the current backup exists but could not be read (not absent) — no .prev recovery copy will exist for this write`,
      );
      return;
    }
    if (!current || current === newCredentials) return;
    try {
      if (this.useKeychain()) {
        this.kcCall(macosKeychain.setPassword, SECURITY_SERVICE, this.prevBackupUsername(accountNum, email), current);
      } else {
        this.atomicB64Write(this.prevBackupPath(accountNum, email), current);
      }
    } catch (e) {
      this.host.logger.warning(
        `Failed to retain previous credential generation for account ${accountNum}: ${errText(e)}`,
      );
    }
  }

  /** Read the `.prev` generation. Returns `""` if absent or corrupt. The `.enc.prev` file wins. */
  readPreviousBackup(accountNum: string, email: string): string {
    const prevFile = this.prevBackupPath(accountNum, email);
    if (fs.existsSync(prevFile)) {
      try {
        const decoded = b64decodeStrict(pyTrim(readText(prevFile)));
        if (decoded) return decoded;
      } catch (e) {
        this.host.logger.warning(`Failed to read .prev file: ${errText(e)}`);
      }
    }
    if (this.host.platform === Platform.MACOS) {
      try {
        return (
          this.kcCall(macosKeychain.getPassword, SECURITY_SERVICE, this.prevBackupUsername(accountNum, email)) || ""
        );
      } catch (e) {
        if (!macosKeychain.isKeychainError(e)) throw e;
        this.host.logger.warning(`Failed to read .prev from Keychain: ${errText(e)}`);
      }
    }
    return "";
  }

  // Unclaimed credentials are 0600 files on every platform, also on macOS.
  // A failed stash write stops the switch, so it must not depend on the Keychain.

  stashManifestPath(): string {
    return path.join(this.host.credentialsDir, ".unclaimed-manifest.json");
  }

  stashEntryPath(entryId: string): string {
    return path.join(this.host.credentialsDir, `.unclaimed-${entryId}.enc`);
  }

  /**
   * Read the stash manifest. Returns `[entries, verdict]`:
   * - `"ok"`: the rows, or no rows for an absent manifest.
   * - `"unreadable"`: the file exists but the read failed. Callers must defer.
   * - `"corrupt"`: the bytes are not a manifest. Only a manifest write repairs it.
   */
  readStashManifestEx(): [JsonObject, StashManifestVerdict] {
    const file = this.stashManifestPath();
    let raw: Buffer;
    try {
      raw = fs.readFileSync(file);
    } catch (e) {
      if (errCode(e) === "ENOENT") return [{}, "ok"];
      if (!isOSError(e)) throw e;
      this.host.logger.warning(`Unclaimed manifest unreadable: ${errText(e)}`);
      return [{}, "unreadable"];
    }
    let entries: unknown;
    try {
      const data: unknown = JSON.parse(readUtf8(raw));
      if (!isObject(data)) throw new TypeError(`'${pyTypeName(data)}' object has no attribute 'get'`);
      entries = data.entries;
    } catch (e) {
      this.host.logger.warning(`Failed to read unclaimed manifest: ${errText(e)}`);
      return [{}, "corrupt"];
    }
    if (!isObject(entries)) {
      this.host.logger.warning("Unclaimed manifest parses but has no valid 'entries' member");
      return [{}, "corrupt"];
    }
    return [entries, "ok"];
  }

  /**
   * Whether the bytes of a stashed credential exist on disk. A directory that
   * cannot be listed gives true. A missing directory gives false.
   */
  stashEntryFilesExist(): boolean {
    let names: string[];
    try {
      names = fs.readdirSync(this.host.credentialsDir);
    } catch (e) {
      if (errCode(e) === "ENOENT") return false;
      if (isOSError(e)) return true;
      throw e;
    }
    return names.some((name) => name.startsWith(".unclaimed-") && name.endsWith(".enc"));
  }

  readStashManifest(): JsonObject {
    return this.readStashManifestEx()[0];
  }

  /** Write the stash manifest. A corrupt manifest is first renamed to `<name>.corrupt-<epoch>`. */
  writeStashManifest(entries: JsonObject): void {
    fs.mkdirSync(this.host.credentialsDir, { recursive: true });
    const file = this.stashManifestPath();
    if (fs.existsSync(file)) {
      try {
        JSON.parse(readText(file));
      } catch {
        const aside = path.join(path.dirname(file), `${path.basename(file)}.corrupt-${Math.trunc(internals.time())}`);
        try {
          fs.renameSync(file, aside);
          this.host.logger.warning(`Unreadable unclaimed manifest preserved as ${path.basename(aside)}`);
        } catch (e) {
          if (!isOSError(e)) throw e;
          this.host.logger.warning(`Could not preserve corrupt unclaimed manifest: ${errText(e)}`);
        }
      }
    }
    atomicWriteJson(file, { schemaVersion: 1, entries });
  }

  /**
   * Apply `mutate(entries)` to the manifest as one atomic step, under the
   * manifest lock (not the slot lock). Throws `LockError` on a lock timeout,
   * a system error if the write fails, and `CredentialReadError` if the
   * manifest is unreadable, because a rewrite from an empty read would lose
   * all rows. A corrupt manifest continues, because only a write repairs it.
   */
  mutateStashManifest(mutate: (entries: JsonObject) => void): void {
    fs.mkdirSync(this.host.credentialsDir, { recursive: true });
    const manifest = this.stashManifestPath();
    const lockPath = path.join(path.dirname(manifest), `${path.basename(manifest, ".json")}.lock`);
    new FileLock(lockPath).withLock(() => {
      const [entries, verdict] = this.readStashManifestEx();
      if (verdict === "unreadable") {
        throw new CredentialReadError(
          "the unclaimed manifest is unreadable; refusing to rewrite it from an empty read, which would orphan every stashed successor it maps",
        );
      }
      mutate(entries);
      this.writeStashManifest(entries);
    });
  }

  /**
   * Keep a credential of unknown origin. Returns the entry id. Throws on any
   * failure, because callers overwrite the live store only after a successful
   * stash. The entry file goes before the manifest row.
   */
  writeUnclaimedCredential(credentials: string, context: JsonObject): string {
    const now = new Date();
    const ts = utcStamp(now).replace(/[-:]/g, "");
    const digest = createHash("sha256").update(credentials, "utf8").digest("hex").slice(0, 12);
    // The nonce keeps ids unique for identical bytes in the same second.
    const entryId = `${ts}-${digest}-${internals.tokenHex(3)}`;
    this.atomicB64Write(this.stashEntryPath(entryId), credentials);
    const row = { createdAt: `${utcStamp(new Date())}Z`, ...context };
    this.mutateStashManifest((entries) => {
      entries[entryId] = row;
    });
    return entryId;
  }

  /** Manifest entries by id, with the entry files that have no manifest row. */
  listUnclaimedCredentials(): Record<string, JsonObject> {
    const entries = { ...this.readStashManifest() } as Record<string, JsonObject>;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.host.credentialsDir);
    } catch (e) {
      if (!isOSError(e)) throw e;
    }
    for (const name of names.sort()) {
      if (!name.startsWith(".unclaimed-") || !name.endsWith(".enc")) continue;
      const entryId = name.slice(".unclaimed-".length, -".enc".length);
      if (!(entryId in entries)) entries[entryId] = { createdAt: null };
    }
    return entries;
  }

  /**
   * Decode the bytes of one stashed credential. Returns `[value, unreadable]`.
   * `unreadable` is true if the entry file exists but the read failed.
   * An absent or corrupt entry gives `["", false]`.
   */
  readUnclaimedCredential(entryId: string): [string, boolean] {
    const file = this.stashEntryPath(entryId);
    let encoded: string;
    try {
      encoded = pyTrim(readText(file));
    } catch (e) {
      if (errCode(e) === "ENOENT") return ["", false];
      if (!isOSError(e)) throw e;
      this.host.logger.warning(`Unclaimed credential ${entryId} unreadable: ${errText(e)}`);
      return ["", true];
    }
    try {
      return [b64decodeStrict(encoded), false];
    } catch (e) {
      this.host.logger.warning(`Failed to decode unclaimed credential ${entryId}: ${errText(e)}`);
      return ["", false];
    }
  }

  /** Delete a stash entry (bytes and manifest row) after its adoption. */
  removeUnclaimedCredential(entryId: string): void {
    try {
      fs.unlinkSync(this.stashEntryPath(entryId));
    } catch (e) {
      if (errCode(e) !== "ENOENT") {
        if (!isOSError(e)) throw e;
        this.host.logger.warning(`Failed to remove unclaimed credential ${entryId}: ${errText(e)}`);
      }
    }
    this.mutateStashManifest((entries) => {
      delete entries[entryId];
    });
  }
}

/** `YYYY-MM-DDTHH:MM:SS` in UTC. */
function utcStamp(date: Date): string {
  return date.toISOString().slice(0, 19);
}

function pyTypeName(value: unknown): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return typeof value;
}

/**
 * The atomic write sequence of the Python version: `mkstemp` in `dir`, write,
 * close, replace onto `target`, then mode 0600 (not on Windows). On failure,
 * close and remove the temporary file.
 */
function atomicWrite(dir: string, target: string, text: string): void {
  const [fd, tmpPath] = settingsInternals.mkstemp(dir, ".tmp");
  let openFd = fd;
  try {
    fs.writeSync(openFd, Buffer.from(text, "utf8"));
    fs.closeSync(openFd);
    openFd = -1;
    replaceWithRetry(tmpPath, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
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
