/**
 * Session mode: run Claude Code as a stored account in one terminal.
 *
 * `cswap run NUM|EMAIL` starts Claude Code with `CLAUDE_CONFIG_DIR` set to a
 * persistent profile under `<backup_dir>/sessions/<num>-<email-slug>/`. The
 * default `~/.claude/` login and the other terminals stay as they are. On
 * macOS, Claude hashes the NFC-normalized value of the variable into its
 * Keychain service name, so each profile gets its own Keychain item.
 *
 * The profile gets a plaintext `.credentials.json` seed, also on macOS. That
 * file is the stable credential contract of Claude, and Claude moves it into
 * its hashed Keychain item on the first write. cswap never writes that item.
 *
 * This module must not import `switcher`, because `switcher` imports it. It
 * gets the switcher as a `SessionHost`.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { properLockfile } from "./claude_locks.js";
import { ClaudeCodeLockTimeout, CredentialReadError, SessionError } from "./exceptions.js";
import { replaceWithRetry } from "./fsutil.js";
import { FileLock } from "./locking.js";
import type { Logger } from "./logging_config.js";
import * as macosKeychain from "./macos_keychain.js";
import { Platform } from "./models.js";
import { credentialFingerprint, type RefreshOutcome } from "./oauth.js";
import { getDefaultGlobalConfigPath } from "./paths.js";
import { accent, dimmed, muted, warning } from "./printer.js";
import { type ClaudeSession, scanSessions } from "./process_detection.js";
import { atomicWriteJson } from "./settings.js";
import { resolvePath } from "./support/pathlib.js";
import { jsonDumps } from "./support/py.js";
import { sleepSync } from "./support/sleep.js";
import { which } from "./support/which.js";

type JsonObject = Record<string, unknown>;

/**
 * The items that sharing mirrors from `~/.claude` into a session profile.
 * Account-scoped and instance-scoped items stay out. The one user-scoped key
 * of `.claude.json` (`mcpServers`) has its own mirror.
 */
export const SHARED_ITEMS = ["settings.json", "keybindings.json", "CLAUDE.md", "skills", "commands", "agents"] as const;

/** The history items that `--share-history` links. POSIX only: a Windows copy would fork the history. */
export const HISTORY_ITEMS = ["projects", "history.jsonl"] as const;

const MANAGEABLE_ITEMS: readonly string[] = [...SHARED_ITEMS, ...HISTORY_ITEMS];

/** The manifest of the entries that cswap created in a profile. Removal touches only these entries. */
export const SHARE_MANIFEST = ".cswap-shared.json";

/**
 * The backup credentials changed while the session was live. The next `cswap run`
 * with no live session must bootstrap the profile again.
 */
export const STALE_MARKER = ".cswap-stale-credentials";

export const MCP_KEY = "mcpServers";

/** The profile adopted the `mcpServers` mirror. Without it, `--no-share` never removes the key. */
export const MCP_MIRROR_MARKER = ".cswap-mcp-mirror-v1";

/** The write-once stash for the session-local MCP definitions that the first mirror replaces. */
export const MCP_DISPLACED_STASH = ".cswap-mcp-displaced.json";

/**
 * Env vars that make claude ignore the account OAuth. The auth-status probe
 * drops them, and a session launch removes them with a warning.
 */
export const AUTH_OVERRIDE_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
] as const;

/** `claude auth status` makes no API call, but it starts the full CLI. */
const AUTH_STATUS_TIMEOUT = 10.0;

/** The bootstrap holds the lock across auth-status probes, so it needs more than the default 10 s. */
const BOOTSTRAP_LOCK_TIMEOUT = 30.0;

/** The bounded retry of the strict capture read. It mirrors the retry of the active store read. */
export const STRICT_KEYCHAIN_ATTEMPTS = 2;

/** The verdict of `claude auth status`. "unknown" and "unreachable" mean that the probe failed, not the profile. */
export type SessionValidity = "valid" | "invalid" | "unknown" | "unreachable";

/** The result of a spawn, as `internals.spawnSync` gives it. */
export interface SpawnResult {
  status: number | null;
  stdout?: string;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

/** Seams that the tests change. The module calls these functions through this object. */
export const internals = {
  /** Seconds between two attempts of the strict Keychain read. */
  STRICT_KEYCHAIN_RETRY_DELAY: 0.3,
  which,
  spawnSync: (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnResult =>
    spawnSync(command, args, options),
  /** `os.execvpe`: `argv` includes `argv[0]`. */
  execve: (file: string, argv: string[], env: Record<string, string>): void => {
    if (!process.execve) throw new Error("process.execve is not available on this platform");
    process.execve(file, argv, env);
  },
  exit: (code: number): never => process.exit(code),
  sysPlatform: (): string => process.platform,
  atomicWriteJson,
  properLockfile,
  scanLiveSessions,
};

/**
 * The structural part of `ClaudeAccountSwitcher` that this module uses.
 * The `switcher` module imports `session`, so this module cannot import it.
 */
export interface SessionHost {
  backupDir: string;
  lockFile: string;
  platform: Platform;
  logger: Logger;
  resolveAccount(identifier: string): [string, string, string];
  getCurrentAccount(): [string, string] | null | Promise<[string, string] | null>;
  accountKind(accountNum: string): string;
  readAccountCredentials(accountNum: string, email: string): string | null;
  readAccountCredentialsEx(accountNum: string, email: string): [string | null, boolean];
  readAccountConfig(accountNum: string, email: string): string | null;
  consumeBackupGrant(accountNum: string, email: string, snapshot: string): RefreshOutcome | Promise<RefreshOutcome>;
  invalidateSessionCredentials(accountNum: string, email: string): void;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `Path.read_text(encoding="utf-8")`: throws on an I/O error and on bytes that are not UTF-8. */
function readTextStrict(file: string): string {
  return utf8.decode(fs.readFileSync(file));
}

function isOSError(err: unknown): boolean {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
}

function isDict(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python `==` for JSON values: the key order of an object does not matter. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (!isDict(a) || !isDict(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
}

function lstat(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

function stat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

const exists = (p: string): boolean => stat(p) !== undefined;
const isDir = (p: string): boolean => stat(p)?.isDirectory() ?? false;
const isFile = (p: string): boolean => stat(p)?.isFile() ?? false;
const isSymlink = (p: string): boolean => lstat(p)?.isSymbolicLink() ?? false;

/** `Path.touch(mode)`: create the file with `mode`, or update its times if it exists. */
function touch(p: string, mode = 0o666): void {
  fs.closeSync(fs.openSync(p, "a", mode));
  const now = new Date();
  fs.utimesSync(p, now, now);
}

/** `Path.unlink(missing_ok=True)`. */
function unlinkMissingOk(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** `os.path.dirname` (POSIX): unlike `path.dirname`, a trailing slash stays significant. */
function pyDirname(p: string): string {
  let head = p.slice(0, p.lastIndexOf("/") + 1);
  if (head && head !== "/".repeat(head.length)) head = head.replace(/\/+$/, "");
  return head;
}

/** `os.path.join(a, b)` (POSIX), with no normalization. */
function pyJoin(a: string, b: string): string {
  if (b.startsWith("/") || !a) return b;
  return a.endsWith("/") ? a + b : `${a}/${b}`;
}

/** `str.splitlines()`. */
function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function envDict(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

/**
 * The path where a profile's stale marker is written: a SIBLING of the
 * profile dir, in `<backup>/sessions/`. A fault on the profile dir (EACCES, a
 * read-only mount) that stops an invalidation also stops a child marker.
 */
export function staleMarkerFor(sessionDir: string): string {
  return path.join(path.dirname(sessionDir), `.${path.basename(sessionDir)}${STALE_MARKER}`);
}

/**
 * Whether a profile must be bootstrapped again. The child path is the location
 * that older versions wrote, so this function reads it too.
 */
export function isSessionStale(sessionDir: string): boolean {
  return exists(staleMarkerFor(sessionDir)) || exists(path.join(sessionDir, STALE_MARKER));
}

/**
 * Remove the stale flag from both marker locations. Returns whether every
 * marker is gone. A denied unlink is tolerated, but it is reported.
 */
export function clearSessionStale(sessionDir: string): boolean {
  let cleared = true;
  for (const marker of [staleMarkerFor(sessionDir), path.join(sessionDir, STALE_MARKER)]) {
    try {
      unlinkMissingOk(marker);
    } catch (e) {
      if (!isOSError(e)) throw e;
      cleared = false;
    }
  }
  return cleared;
}

/** Flag a live session profile for a new bootstrap after it exits. Returns whether the marker landed. */
export function markSessionStale(sessionDir: string): boolean {
  try {
    touch(staleMarkerFor(sessionDir));
    return true;
  } catch (e) {
    if (!isOSError(e)) throw e;
    return false;
  }
}

/**
 * A slug for an email address that is safe in a file name, also on Windows.
 * The `<num>-` prefix of the session dir makes it unique.
 */
export function slugifyEmail(email: string): string {
  let slug = "";
  for (const ch of email.normalize("NFC")) slug += /^[A-Za-z0-9._-]$/.test(ch) ? ch : "_";
  return slug;
}

/**
 * The session profile directory of an account. The profile contains the
 * `sessions/<pid>.json` files of Claude, so a full path is
 * `<backup>/sessions/2-user_x.com/sessions/1234.json`.
 */
export function sessionDirFor(backupDir: string, accountNum: string, email: string): string {
  return path.join(backupDir, "sessions", `${accountNum}-${slugifyEmail(email)}`);
}

/**
 * The Keychain service name that Claude Code derives for this config dir.
 * Claude hashes the raw `CLAUDE_CONFIG_DIR` value, NFC-normalized and unresolved.
 * Hash exactly the exported string, never a resolved path.
 */
export function keychainServiceName(configDir: string): string {
  const normalized = configDir.normalize("NFC");
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 8);
  return `Claude Code-credentials-${digest}`;
}

/** The Keychain account name. It is the same as for the active store. */
export function keychainAccountName(): string {
  return macosKeychain.keychainAccountName();
}

/**
 * Delete the hashed Keychain item of a session profile, if possible. Does
 * nothing off macOS. A stale item hides a new seed, and after the dir is
 * gone, nothing can compute the hashed name again.
 */
export function deleteMacosKeychainEntry(sessionDir: string): void {
  if (Platform.detect() !== Platform.MACOS) return;
  try {
    macosKeychain.deletePassword(keychainServiceName(sessionDir), keychainAccountName());
  } catch (e) {
    if (!macosKeychain.isKeychainError(e)) throw e;
  }
}

/**
 * The current credential JSON of a session profile, or null.
 *
 * After a session ran, the profile holds the newest generation of the token
 * family, because claude rotates tokens in place. This function only reads.
 */
export function readSessionCredentials(sessionDir: string): string | null {
  return readConfigDirCredentials(sessionDir);
}

/**
 * Whether the credential material of a profile can be present. False only if
 * every store is empty for certain: no readable seed and (on macOS) a
 * Keychain miss (rc 44). An unreadable Keychain counts as present, because the
 * profile can hold the newest token generation.
 */
function mayHaveCredentialMaterial(sessionDir: string): boolean {
  try {
    if (readTextStrict(path.join(sessionDir, ".credentials.json"))) return true;
  } catch {
    // No readable seed. The Keychain can still hold the material.
  }
  if (Platform.detect() !== Platform.MACOS) return false;
  for (const service of keychainServices(sessionDir)) {
    let material: string | null;
    try {
      material = macosKeychain.getPassword(service, keychainAccountName());
    } catch (e) {
      if (!macosKeychain.isKeychainError(e)) throw e;
      return true;
    }
    if (material !== null) return true;
  }
  return false;
}

/**
 * What the local files say about a profile without the probe. Never use it for
 * "unreachable": no file tells if `claude` can run.
 */
function artifactsSayUsable(sessionDir: string, email: string, orgUuid: string): boolean {
  return mayHaveCredentialMaterial(sessionDir) && !sessionIdentityDrifted(sessionDir, email, orgUuid);
}

/**
 * The Keychain service names that can hold the credential of a profile, in
 * lookup order. A profile that is a symlink can run under its own name or
 * under the name of its target, so both are tried. `override` names the
 * unsuffixed item of the default profile and stands alone.
 */
function keychainServices(configDir: string, override: string | null = null): string[] {
  if (override !== null) return [override];
  const services = [keychainServiceName(configDir)];
  let target: string;
  try {
    target = fs.readlinkSync(configDir);
  } catch {
    return services;
  }
  if (!target.startsWith("/")) target = pyJoin(pyDirname(configDir), target);
  services.push(keychainServiceName(target));
  return services;
}

/** The item of one service, or null if it is absent (rc 44). If `strict`, an unreadable Keychain gets one retry. */
function keychainEntry(service: string, strict: boolean): string | null {
  let attempts = strict ? STRICT_KEYCHAIN_ATTEMPTS : 1;
  for (;;) {
    try {
      return macosKeychain.getPassword(service, keychainAccountName());
    } catch (e) {
      if (!macosKeychain.isKeychainError(e)) throw e;
      attempts -= 1;
      if (!attempts) throw e;
      sleepSync(internals.STRICT_KEYCHAIN_RETRY_DELAY * 1000);
    }
  }
}

export interface ReadConfigDirCredentialsOptions {
  /**
   * For capture: an unreadable Keychain gets one retry, then throws
   * `CredentialReadError`. The plaintext seed can be older than an in-profile
   * `/login`. An absent item still falls back to the file.
   */
  strictKeychain?: boolean;
  /** Replaces the hashed service name. The default profile uses the unsuffixed item. */
  keychainService?: string | null;
}

/**
 * The credential JSON of a `CLAUDE_CONFIG_DIR` value, or null.
 *
 * The argument is the raw exported string. Claude derives the Keychain
 * service name from it verbatim, so do not normalize it.
 */
export function readConfigDirCredentials(
  configDir: string,
  { strictKeychain = false, keychainService = null }: ReadConfigDirCredentialsOptions = {},
): string | null {
  if (!isDir(configDir)) return null;
  if (Platform.detect() === Platform.MACOS) {
    for (const service of keychainServices(configDir, keychainService)) {
      let creds: string | null;
      try {
        creds = keychainEntry(service, strictKeychain);
      } catch (e) {
        if (!macosKeychain.isKeychainError(e)) throw e;
        if (strictKeychain) {
          throw new CredentialReadError(
            `Keychain entry for profile ${configDir} is unreadable ` +
              `(locked or busy) — unlock the keychain and retry: ${(e as Error).message}`,
            { cause: e },
          );
        }
        break;
      }
      if (creds) return creds;
    }
  }
  try {
    return readTextStrict(path.join(configDir, ".credentials.json"));
  } catch {
    return null;
  }
}

/**
 * The account identity that a session profile is logged in as:
 * `[email, organizationUuid]` with `""` for a missing org, or null if it is
 * not readable. An in-session `/login` can change it to a different account.
 */
export function readSessionIdentity(sessionDir: string): [string, string] | null {
  let config: unknown;
  try {
    config = JSON.parse(readTextStrict(path.join(sessionDir, ".claude.json")));
  } catch {
    return null;
  }
  if (!isDict(config)) return null;
  const oauthAccount = config.oauthAccount || {};
  if (!isDict(oauthAccount)) return null;
  const email = oauthAccount.emailAddress || "";
  if (!email) return null;
  return [email as string, (oauthAccount.organizationUuid || "") as string];
}

/**
 * Whether the profile is logged in as a different account than its slot.
 * The email must match. The org must match only if both sides have a value.
 * An unreadable identity is not drift.
 */
export function sessionIdentityDrifted(sessionDir: string, email: string, orgUuid: string): boolean {
  const identity = readSessionIdentity(sessionDir);
  if (identity === null) return false;
  const [profileEmail, profileOrg] = identity;
  if (profileEmail !== email) return true;
  return Boolean(profileOrg && orgUuid && profileOrg !== orgUuid);
}

/**
 * The live Claude instances of a profile, and the number of records that
 * could not be read. Every caller gates a destructive step, so an unreadable
 * record is not evidence that nothing runs.
 */
export function scanLiveSessions(sessionDir: string): [ClaudeSession[], number] {
  if (!exists(sessionDir)) return [[], 0];
  return scanSessions(sessionDir);
}

/** Nothing runs against this profile, and every record was readable. */
export function profileIsQuiescent(sessionDir: string): boolean {
  const [sessions, unreadable] = internals.scanLiveSessions(sessionDir);
  return sessions.length === 0 && unreadable === 0;
}

/** `mkdir -p` with mode 0700 on every level that it creates, as Claude Code does for history dirs. */
function mkdirPrivate(dir: string): void {
  const missing: string[] = [];
  let current = dir;
  while (!exists(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directory of missing.reverse()) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

/** `shutil.move` for a file: a rename, or a copy and a delete across file systems. */
function moveFile(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.cpSync(src, dst, { preserveTimestamps: true, verbatimSymlinks: true });
    fs.unlinkSync(src);
  }
}

/** `Path.rglob("*")` as relative path parts. It does not go into symlinked dirs. */
function walkRelative(root: string, prefix: string[] = []): string[][] {
  const found: string[][] = [];
  for (const entry of fs.readdirSync(path.join(root, ...prefix), { withFileTypes: true })) {
    const parts = [...prefix, entry.name];
    found.push(parts);
    if (entry.isDirectory()) found.push(...walkRelative(root, parts));
  }
  return found;
}

function compareParts(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/** The env of the auth-status probe: the session config dir, without the auth overrides. */
export function probeEnv(sessionDir: string): Record<string, string> {
  const env = envDict();
  for (const name of AUTH_OVERRIDE_ENV_VARS) delete env[name];
  env.CLAUDE_CONFIG_DIR = sessionDir;
  return env;
}

/** Bootstraps the session profile of each account and starts Claude in it. */
export class SessionManager {
  readonly switcher: SessionHost;
  readonly sessionsDir: string;
  readonly logger: Logger;

  constructor(switcher: SessionHost) {
    this.switcher = switcher;
    this.sessionsDir = path.join(switcher.backupDir, "sessions");
    this.logger = switcher.logger;
  }

  /**
   * Start Claude Code as the given account in the current terminal.
   *
   * If `requireSession`, the same-account fast path (plain claude on the
   * default login) becomes a refusal: a caller that needs one isolated account
   * per terminal cannot accept the default login.
   */
  async run(
    identifier: string,
    claudeArgs: string[],
    share = true,
    shareHistory = false,
    requireSession = false,
  ): Promise<never> {
    const claudeBin = internals.which("claude");
    if (!claudeBin) {
      throw new SessionError("'claude' was not found on PATH. Install Claude Code first.");
    }
    if (shareHistory && this.switcher.platform === Platform.WINDOWS) {
      throw new SessionError(
        "--share-history is not supported on Windows yet: sharing uses " +
          "re-synced copies there, which would fork the history instead " +
          "of sharing it.",
      );
    }

    const [accountNum, email, orgUuid] = this.switcher.resolveAccount(identifier);
    // This guard must come before the fast path below, which never returns.
    this.ensureNotApiKey(accountNum, email);

    const configDirPreset = process.env.CLAUDE_CONFIG_DIR;
    if (configDirPreset) {
      warning(`CLAUDE_CONFIG_DIR is already set (${configDirPreset}); overriding it for this launch.`);
    } else {
      // Never make a second credential copy of the active default login.
      // The two copies drift apart when the server rotates the refresh token.
      const current = await this.switcher.getCurrentAccount();
      if (current !== null && current[0] === email && current[1] === orgUuid) {
        if (requireSession) {
          throw new SessionError(
            `Account-${accountNum} (${email}) is the active default ` +
              "login, so this launch would run plain claude on the " +
              "default login rather than in a session profile (a " +
              "second copy of the active credential would drift). " +
              "Switch the default login to another account first, " +
              "or run `claude` directly.",
          );
        }
        print(dimmed(`Account-${accountNum} (${email}) is already the active default login — launching claude directly.`));
        this.exec(claudeBin, claudeArgs, envDict());
      }
    }

    const scrubbed = AUTH_OVERRIDE_ENV_VARS.filter((name) => process.env[name]);
    if (scrubbed.length > 0) {
      warning(`Ignoring ${scrubbed.join(", ")} for this session — it would override the selected account inside Claude Code.`);
    }

    const [sessionDir, num, mail] = await this.setupSession(identifier, share, shareHistory);

    print(`${accent("Launching")} Account-${num} (${mail}) ${muted("[session mode]")}`);
    const env = envDict();
    for (const name of AUTH_OVERRIDE_ENV_VARS) delete env[name];
    env.CLAUDE_CONFIG_DIR = sessionDir;
    this.exec(claudeBin, claudeArgs, env);
  }

  /**
   * Start plain Claude Code with the current default login and the unchanged
   * environment, as if the user typed `claude`.
   */
  execDefault(claudeArgs: string[]): never {
    const claudeBin = internals.which("claude");
    if (!claudeBin) {
      throw new SessionError("'claude' was not found on PATH. Install Claude Code first.");
    }
    this.exec(claudeBin, claudeArgs, envDict());
  }

  /**
   * Give the terminal to claude. Never returns.
   *
   * POSIX: `execve` replaces the cswap process. The lock must be released
   * before, because claude must not inherit it. Windows: an exec detaches
   * from the console, so cswap waits for claude and exits with its code.
   */
  exec(claudeBin: string, claudeArgs: string[], env: Record<string, string>): never {
    const argv = [claudeBin, ...claudeArgs];
    if (internals.sysPlatform() === "win32") {
      const result = internals.spawnSync(claudeBin, claudeArgs, { env, stdio: "inherit", encoding: "utf8" });
      if (result.error) throw result.error;
      internals.exit(result.signal === "SIGINT" ? 130 : (result.status ?? 1));
    }
    internals.execve(claudeBin, argv, env);
    throw new Error("unreachable");
  }

  /** Refuse an API-key account: session mode does not support it yet. */
  ensureNotApiKey(accountNum: string, email: string): void {
    if (this.switcher.accountKind(accountNum) === "api_key") {
      throw new SessionError(
        `Account-${accountNum} (${email}) is an API-key account; ` +
          "'cswap run' (session mode) does not support API-key accounts yet. " +
          "Use 'cswap --switch-to' to make it your default login instead.",
      );
    }
  }

  /** Make sure that a valid session profile exists. Returns `[dir, num, email]`. */
  async setupSession(identifier: string, share: boolean, shareHistory = false): Promise<[string, string, string]> {
    const [accountNum, email, orgUuid] = this.switcher.resolveAccount(identifier);
    this.ensureNotApiKey(accountNum, email);
    const sessionDir = sessionDirFor(this.switcher.backupDir, accountNum, email);

    // A live session keeps the marker for later: a second `cswap run` must not invalidate under it.
    const stale = isSessionStale(sessionDir) && profileIsQuiescent(sessionDir);

    if (!stale && this.isSessionValid(sessionDir, email, orgUuid)) {
      this.syncSharing(sessionDir, share, shareHistory);
      return [sessionDir, accountNum, email];
    }

    // WARNING: The refresh must run BEFORE the bootstrap lock. The gate takes the
    // same non-reentrant lock and makes a network call.
    const preCreds = this.switcher.readAccountCredentials(accountNum, email);
    if (preCreds && SessionManager.hasRefreshToken(preCreds)) {
      const outcome = await this.switcher.consumeBackupGrant(accountNum, email, preCreds);
      if (outcome.error !== null && outcome.credentials) {
        // The grant is spent and the backup still holds the old generation.
        // A bootstrap from it gives claude a dead refresh token, so refuse.
        // A stashed successor makes a retry safe. Without a stash, a retry spends nothing but earns a strike.
        if (outcome.stashed) {
          throw new SessionError(
            `Account-${accountNum}'s refreshed credential could ` +
              "not be stored, so the backup still holds a spent " +
              "grant. The successor is stashed — please retry, and " +
              "the next run adopts it automatically.",
          );
        }
        throw new SessionError(
          `Account-${accountNum}'s refreshed credential could ` +
            "neither be stored nor stashed, so the backup holds a " +
            "spent grant and the successor is gone. Fix the storage " +
            "failure first; retrying before that spends nothing but " +
            "earns a strike. If the slot strikes, log in again and " +
            `re-add it: cswap --add-account --slot ${accountNum}`,
        );
      }
      if (outcome.error !== null) {
        warning(`Could not refresh the token for Account-${accountNum}; continuing with the stored credentials.`);
      }
    }

    // The lock is released before any exec.
    return new FileLock(this.switcher.lockFile, BOOTSTRAP_LOCK_TIMEOUT).withLock((): [string, string, string] => {
      if (isSessionStale(sessionDir) && profileIsQuiescent(sessionDir)) {
        this.switcher.invalidateSessionCredentials(accountNum, email);
        clearSessionStale(sessionDir);
      }
      if (this.isSessionValid(sessionDir, email, orgUuid)) {
        // A peer `cswap run` can bootstrap while this one waits for the lock.
        // Its profile can hold the generation that the gate above spent, so seed it again.
        // WARNING: Never do this under a live claude: the bootstrap deletes its Keychain item.
        if (!this.profileMatchesBackup(sessionDir, accountNum, email) && profileIsQuiescent(sessionDir)) {
          this.bootstrap(sessionDir, accountNum, email, orgUuid);
        }
        this.syncSharing(sessionDir, share, shareHistory);
        return [sessionDir, accountNum, email];
      }

      this.bootstrap(sessionDir, accountNum, email, orgUuid);
      this.syncSharing(sessionDir, share, shareHistory);

      let verdict = this.sessionValidity(sessionDir, email, orgUuid);
      // WARNING: A probe failure must not reach `cleanupFailedSession`, which
      // deletes the profile. A timeout falls back to the local files.
      if (verdict === "unknown" && artifactsSayUsable(sessionDir, email, orgUuid)) {
        verdict = "valid";
      }
      if (verdict === "unknown" || verdict === "unreachable") {
        throw new SessionError(
          `Session profile for Account-${accountNum} (${email}) could ` +
            "not be verified: `claude auth status` did not run or did " +
            "not answer. The profile is left in place — check that " +
            "`claude` is on PATH, then retry.",
        );
      }
      if (verdict !== "valid") {
        this.cleanupFailedSession(sessionDir);
        throw new SessionError(
          `Session profile for Account-${accountNum} (${email}) failed ` +
            "validation. Log in with that account and re-add it: " +
            `cswap --add-account --slot ${accountNum}`,
        );
      }
      return [sessionDir, accountNum, email];
    });
  }

  /**
   * Whether the profile has the same credential generation as the backup,
   * by fingerprint. An unreadable side gives true: a read error is not
   * evidence of a mismatch.
   */
  profileMatchesBackup(sessionDir: string, accountNum: string, email: string): boolean {
    const profile = readSessionCredentials(sessionDir);
    const backup = this.switcher.readAccountCredentials(accountNum, email);
    if (!profile || !backup) return true;
    return credentialFingerprint(profile) === credentialFingerprint(backup);
  }

  /** Seed the session profile from the backup. The caller holds the lock. */
  bootstrap(sessionDir: string, accountNum: string, email: string, orgUuid: string): void {
    // Claude reads the Keychain before the file, so a stale hashed item hides the seed.
    deleteMacosKeychainEntry(sessionDir);

    const [creds, unreadable] = this.switcher.readAccountCredentialsEx(accountNum, email);
    if (!creds) {
      if (unreadable) {
        throw new SessionError(
          `Account-${accountNum}'s backup is in the macOS Keychain ` +
            "but it is unreadable right now (locked or no GUI " +
            "session). Retry from a GUI terminal; do not re-add.",
        );
      }
      throw new SessionError(
        `Account-${accountNum} has no stored credentials. Re-add with: cswap --add-account --slot ${accountNum}`,
      );
    }

    const configText = this.switcher.readAccountConfig(accountNum, email);
    let configData: unknown = {};
    if (configText) {
      try {
        configData = JSON.parse(configText);
      } catch {
        configData = {};
      }
    }
    const config: JsonObject = isDict(configData) ? configData : {};
    const oauthAccount = config.oauthAccount;
    if (!oauthAccount || (isDict(oauthAccount) && Object.keys(oauthAccount).length === 0)) {
      throw new SessionError(
        `Account-${accountNum} has no stored config backup. Re-add with: cswap --add-account --slot ${accountNum}`,
      );
    }

    const posix = process.platform !== "win32";
    fs.mkdirSync(sessionDir, { recursive: true });
    if (posix) fs.chmodSync(sessionDir, 0o700);

    const credsPath = path.join(sessionDir, ".credentials.json");
    fs.writeFileSync(credsPath, creds, "utf8");
    if (posix) fs.chmodSync(credsPath, 0o600);

    // Merge into the existing `.claude.json`, so a new bootstrap keeps the
    // history of the profile. Claude shows onboarding if `theme` is missing.
    const configPath = path.join(sessionDir, ".claude.json");
    let existing: JsonObject = {};
    if (exists(configPath)) {
      try {
        const parsed: unknown = JSON.parse(readTextStrict(configPath));
        existing = isDict(parsed) ? parsed : {};
      } catch {
        existing = {};
      }
    }
    existing.oauthAccount = oauthAccount;
    existing.hasCompletedOnboarding = true;
    if (!Object.hasOwn(existing, "theme")) existing.theme = config.theme || "dark";
    fs.writeFileSync(configPath, jsonDumps(existing, 2), "utf8");
    if (posix) fs.chmodSync(configPath, 0o600);

    this.logger.info(`Bootstrapped session profile for account ${accountNum} at ${sessionDir}`);
  }

  static hasRefreshToken(creds: string): boolean {
    let data: unknown;
    try {
      data = JSON.parse(creds);
    } catch {
      return true;
    }
    if (!isDict(data)) return true;
    const oauth = Object.hasOwn(data, "claudeAiOauth") ? data.claudeAiOauth : {};
    if (!isDict(oauth)) return true;
    return Boolean(oauth.refreshToken);
  }

  cleanupFailedSession(sessionDir: string): void {
    // The Keychain item goes first: after the dir is gone, nothing can compute its hashed name.
    deleteMacosKeychainEntry(sessionDir);
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Same as `rmtree(ignore_errors=True)`.
    }
    clearSessionStale(sessionDir);
  }

  /**
   * The verdict of `claude auth status`, a local check with no API call.
   *
   * "unknown": the probe ran and did not answer (timeout, bad output).
   * "unreachable": `claude` could not start. Neither one is evidence about
   * the profile, so neither one may share a value with "invalid".
   */
  sessionValidity(sessionDir: string, email: string, orgUuid: string): SessionValidity {
    if (!isDir(sessionDir)) return "invalid";
    // On Windows, `claude` is a `.cmd` shim that a bare name does not resolve.
    const claudeBin = internals.which("claude") ?? "claude";
    let result: SpawnResult;
    try {
      result = internals.spawnSync(claudeBin, ["auth", "status", "--json"], {
        env: probeEnv(sessionDir),
        encoding: "utf8",
        timeout: AUTH_STATUS_TIMEOUT * 1000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "unknown" : "unreachable";
    }
    if (result.error) {
      return (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "unknown" : "unreachable";
    }
    if (result.status !== 0) return "invalid";
    let status: unknown;
    try {
      status = JSON.parse(result.stdout ?? "");
    } catch {
      return "unknown";
    }
    if (!isDict(status)) return "unknown";
    if (status.loggedIn !== true) return "invalid";
    if (status.authMethod !== "claude.ai") return "invalid";
    if (status.email !== email) return "invalid";
    // The org check runs only if both sides have a value, so a schema change does not give false negatives.
    const statusOrg = status.orgId;
    if (statusOrg && orgUuid && statusOrg !== orgUuid) return "invalid";
    return "valid";
  }

  /**
   * Whether the profile can be used, as far as cswap can tell. On "unknown",
   * the local files decide. On "unreachable", the answer is false.
   *
   * WARNING: A caller that DELETES on a negative must use `sessionValidity`,
   * because this boolean cannot tell "invalid" from "could not tell".
   */
  isSessionValid(sessionDir: string, email: string, orgUuid: string): boolean {
    const verdict = this.sessionValidity(sessionDir, email, orgUuid);
    if (verdict === "unknown") return artifactsSayUsable(sessionDir, email, orgUuid);
    return verdict === "valid";
  }

  /**
   * Mirror the shared items of `~/.claude` into the profile, or undo it.
   *
   * `share` controls `SHARED_ITEMS` and the `mcpServers` mirror.
   * `shareHistory` controls `HISTORY_ITEMS`. The source is always the default
   * `~/.claude`, also if `CLAUDE_CONFIG_DIR` is set. The function runs on
   * every launch without a lock: concurrent runs repair each other on the next launch.
   */
  syncSharing(sessionDir: string, share: boolean, shareHistory = false): void {
    if (!isDir(sessionDir)) return;
    this.syncMcpServers(sessionDir, share);
    if (this.switcher.platform === Platform.WINDOWS) shareHistory = false;
    const activeItems: string[] = [...(share ? SHARED_ITEMS : []), ...(shareHistory ? HISTORY_ITEMS : [])];
    const isHistory = (name: string) => (HISTORY_ITEMS as readonly string[]).includes(name);
    const sourceRoot = path.join(os.homedir(), ".claude");
    const manifestPath = path.join(sessionDir, SHARE_MANIFEST);
    let managed = SessionManager.readManifest(manifestPath);

    // WARNING: A stale manifest must never delete real history, so only a
    // symlink is removed for a history item.
    for (const name of managed) {
      if (!activeItems.includes(name)) {
        const dest = path.join(sessionDir, name);
        if (isHistory(name) && exists(dest) && !isSymlink(dest)) continue;
        SessionManager.removeManaged(dest);
      }
    }
    if (activeItems.length === 0) {
      unlinkMissingOk(manifestPath);
      return;
    }

    const useSymlinks = this.switcher.platform !== Platform.WINDOWS;
    const newManaged: string[] = [];

    for (const name of activeItems) {
      const src = path.join(sourceRoot, name);
      const dest = path.join(sessionDir, name);

      if (isHistory(name) && !this.prepareHistoryShare(src, dest, sessionDir)) continue;

      if (!exists(src)) {
        if (managed.includes(name)) SessionManager.removeManaged(dest);
        continue;
      }

      // Link to the resolved target. Claude Code's atomic settings write
      // resolves one hop only, and replaces an intermediate link with a
      // regular file (anthropics/claude-code#78162).
      const linkTarget = isSymlink(src) ? resolvePath(src) : src;

      if (isSymlink(dest)) {
        if (!managed.includes(name)) managed = [...managed, name];
        if (useSymlinks) {
          try {
            if (fs.readlinkSync(dest) !== linkTarget) {
              fs.unlinkSync(dest);
              fs.symlinkSync(linkTarget, dest);
            }
          } catch (e) {
            if (!isOSError(e)) throw e;
            continue;
          }
          newManaged.push(name);
          continue;
        }
        // The profile moved from POSIX to Windows: replace the link with a copy.
        fs.unlinkSync(dest);
      } else if (exists(dest) && !managed.includes(name)) {
        print(dimmed(`Not sharing ${name}: the session profile already has its own copy.`));
        continue;
      }

      try {
        if (exists(dest)) SessionManager.removeManaged(dest);
        if (useSymlinks) {
          fs.symlinkSync(linkTarget, dest);
        } else {
          fs.cpSync(src, dest, { recursive: isDir(src), dereference: true, preserveTimestamps: true });
        }
      } catch (e) {
        if (!isOSError(e)) throw e;
        this.logger.warning(`Failed to share ${name} into session: ${(e as Error).message}`);
        continue;
      }
      newManaged.push(name);
    }

    this.writeManifest(manifestPath, newManaged);
  }

  /**
   * Mirror the user-scope `mcpServers` of the default profile (issue #139).
   *
   * The default profile is the only source, so adds, edits and deletions
   * propagate. `share=false` removes the key only from a profile with the
   * adoption marker. The first mirror stashes the definitions that it
   * replaces. A bad file, a symlinked target or a held lock leaves the
   * profile as it is. The adopted in-sync state takes no lock.
   */
  syncMcpServers(sessionDir: string, share: boolean): void {
    const configPath = path.join(sessionDir, ".claude.json");
    const marker = path.join(sessionDir, MCP_MIRROR_MARKER);

    let source: JsonObject | null;
    if (share) {
      source = SessionManager.readMcpSource();
      if (source === null) return;
    } else if (exists(marker)) {
      source = {};
    } else {
      return;
    }

    // WARNING: Check the type before the read. A FIFO blocks the launch, and
    // a write must never go through a symlink.
    if (!exists(configPath)) return;
    if (isSymlink(configPath) || !isFile(configPath)) {
      this.logger.warning(`Not syncing MCP servers: ${configPath} is not a regular file.`);
      return;
    }

    let existing = SessionManager.loadJsonObject(configPath);
    if (existing === null) return;
    let target = Object.hasOwn(existing, MCP_KEY) ? existing[MCP_KEY] : {};
    if (!isDict(target)) {
      this.logger.warning(`Not syncing MCP servers: the profile's ${MCP_KEY} is not an object.`);
      return;
    }
    if (jsonEqual(target, source) && (!share || exists(marker))) return;

    // A claude in this profile takes the same lock for its own `.claude.json` writes.
    const lockDir = path.join(path.dirname(configPath), `${path.basename(configPath)}.lock`);
    try {
      internals.properLockfile(lockDir, () => {
        // Read both sides again: a writer that waited here must not write an old snapshot.
        if (share) {
          source = SessionManager.readMcpSource();
          if (source === null) return;
        }
        if (isSymlink(configPath) || !isFile(configPath)) return;
        existing = SessionManager.loadJsonObject(configPath);
        if (existing === null) return;
        target = Object.hasOwn(existing, MCP_KEY) ? existing[MCP_KEY] : {};
        if (!isDict(target)) return;
        const mirror: JsonObject = source ?? {};
        if (jsonEqual(target, mirror)) {
          if (share) this.ensureMcpMarker(marker);
          return;
        }
        if (share && !exists(marker)) {
          const displaced: JsonObject = {};
          for (const [name, value] of Object.entries(target)) {
            if (!Object.hasOwn(mirror, name) || !jsonEqual(mirror[name], value)) displaced[name] = value;
          }
          if (Object.keys(displaced).length > 0 && !this.stashDisplacedMcp(sessionDir, displaced)) return;
        }
        if (Object.keys(mirror).length > 0) {
          existing[MCP_KEY] = mirror;
        } else {
          // Claude removes keys that have the default value. Do the same.
          delete existing[MCP_KEY];
        }
        try {
          internals.atomicWriteJson(configPath, existing);
        } catch (e) {
          if (!isOSError(e)) throw e;
          this.logger.warning(`Could not sync MCP servers: ${(e as Error).message}`);
          return;
        }
        // Only after a successful write. If the marker does not land, the next launch tries again.
        if (share) this.ensureMcpMarker(marker);
      });
    } catch (e) {
      if (!(e instanceof ClaudeCodeLockTimeout) && !isOSError(e)) throw e;
      this.logger.warning(`Could not sync MCP servers (${(e as Error).message}) — skipping this launch.`);
    }
  }

  /**
   * The user-scope `mcpServers` of the default profile, or null if it is not usable.
   * `{}` means "no servers" and propagates the removal. Null leaves the profile as it is.
   */
  static readMcpSource(): JsonObject | null {
    const config = SessionManager.loadJsonObject(getDefaultGlobalConfigPath());
    if (config === null) return null;
    const value = Object.hasOwn(config, MCP_KEY) ? config[MCP_KEY] : {};
    return isDict(value) ? value : null;
  }

  static loadJsonObject(file: string): JsonObject | null {
    let data: unknown;
    try {
      data = JSON.parse(readTextStrict(file));
    } catch {
      return null;
    }
    return isDict(data) ? data : null;
  }

  ensureMcpMarker(marker: string): void {
    if (exists(marker)) return;
    try {
      touch(marker);
    } catch (e) {
      if (!isOSError(e)) throw e;
      this.logger.warning(`Could not write ${path.basename(marker)}: ${(e as Error).message}`);
    }
  }

  /**
   * Save the definitions that the first mirror replaces. False stops the mirror.
   * The stash is write-once, and only a valid stash counts as a saved copy.
   */
  stashDisplacedMcp(sessionDir: string, displaced: JsonObject): boolean {
    const stash = path.join(sessionDir, MCP_DISPLACED_STASH);
    const name = path.basename(stash);
    if (isSymlink(stash) || exists(stash)) {
      if (SessionManager.isValidStash(stash)) return true;
      this.logger.warning(`${name} exists but is not a valid stash; leaving the profile's MCP servers in place.`);
      return false;
    }
    try {
      internals.atomicWriteJson(stash, { schemaVersion: 1, [MCP_KEY]: displaced });
    } catch (e) {
      if (!isOSError(e)) throw e;
      this.logger.warning(`Could not stash the profile's MCP servers (${(e as Error).message}); leaving them in place.`);
      return false;
    }
    print(
      dimmed(
        `Session MCP servers now mirror your default profile; the profile's previous definitions were saved to ${name}.`,
      ),
    );
    return true;
  }

  static isValidStash(stash: string): boolean {
    if (isSymlink(stash) || !isFile(stash)) return false;
    const data = SessionManager.loadJsonObject(stash);
    return data !== null && isDict(data[MCP_KEY]);
  }

  /**
   * Make a history item ready to link. Returns false to skip it for this launch.
   * Real history in the profile goes into `~/.claude` first, also if the
   * manifest claims the entry. A missing source is created empty.
   */
  prepareHistoryShare(src: string, dest: string, sessionDir: string): boolean {
    const name = path.basename(dest);
    if (exists(dest) && !isSymlink(dest)) {
      // The merge moves files away from a running claude, so it waits for a quiescent profile.
      if (!profileIsQuiescent(sessionDir)) {
        print(dimmed(`Not sharing ${name} yet: another session is using this profile — retrying on the next launch.`));
        return false;
      }
      try {
        SessionManager.mergeHistoryIntoSource(src, dest);
      } catch (e) {
        if (!isOSError(e)) throw e;
        this.logger.warning(`Could not merge ${name} into ${src}: ${(e as Error).message}`);
        print(dimmed(`Not sharing ${name}: merging the profile's existing history failed (see log).`));
        return false;
      }
      print(dimmed(`Merged the profile's existing ${name} into ${src} — conversation history is now shared.`));
    }
    if (!exists(src)) {
      try {
        // Modes 0600 and 0700, as Claude Code uses for history. A mode applies only at creation.
        if (name.endsWith(".jsonl")) {
          fs.mkdirSync(path.dirname(src), { recursive: true });
          touch(src, 0o600);
        } else {
          mkdirPrivate(src);
        }
      } catch (e) {
        if (!isOSError(e)) throw e;
        this.logger.warning(`Could not create ${src}: ${(e as Error).message}`);
        return false;
      }
    }
    return true;
  }

  /**
   * Move the history of the profile at `dest` into `src`.
   *
   * A directory merges file by file. Transcript names are UUIDs, so a
   * collision is the same session and the target copy stays. `history.jsonl`
   * gets the lines that it does not have. On a failure, the function throws
   * and leaves the remaining files for the next attempt.
   */
  static mergeHistoryIntoSource(src: string, dest: string): void {
    if (isDir(dest)) {
      mkdirPrivate(src);
      const entries = walkRelative(dest).sort((a, b) => compareParts(b, a));
      for (const rel of entries) {
        const file = path.join(dest, ...rel);
        const target = path.join(src, ...rel);
        if (isDir(file)) {
          // The reverse order moved the children first.
          fs.rmdirSync(file);
          continue;
        }
        if (exists(target)) {
          fs.unlinkSync(file);
          continue;
        }
        mkdirPrivate(path.dirname(target));
        moveFile(file, target);
      }
      fs.rmdirSync(dest);
    } else {
      let existing = new Set<string>();
      if (exists(src)) existing = new Set(splitlines(readTextStrict(src)));
      const lines = splitlines(readTextStrict(dest)).filter((line) => line && !existing.has(line));
      if (lines.length > 0) {
        fs.mkdirSync(path.dirname(src), { recursive: true });
        if (!exists(src)) touch(src, 0o600);
        fs.appendFileSync(src, `${lines.join("\n")}\n`, "utf8");
      }
      fs.unlinkSync(dest);
    }
  }

  static readManifest(manifestPath: string): string[] {
    let data: unknown;
    try {
      data = JSON.parse(readTextStrict(manifestPath));
    } catch {
      return [];
    }
    if (!isDict(data)) return [];
    const items = Object.hasOwn(data, "items") ? data.items : [];
    const names = Array.isArray(items) ? items : isDict(items) ? Object.keys(items) : [];
    // Act only on names that cswap could have created.
    return names.filter((item): item is string => typeof item === "string" && MANAGEABLE_ITEMS.includes(item));
  }

  writeManifest(manifestPath: string, items: string[]): void {
    const mode = this.switcher.platform !== Platform.WINDOWS ? "symlink" : "copy";
    const payload = jsonDumps({ items, mode }, 2);
    const dir = path.dirname(manifestPath);
    let tmp: string;
    let fd: number;
    for (;;) {
      tmp = path.join(dir, `.cswap-shared-${randomBytes(6).toString("base64url")}.tmp`);
      try {
        fd = fs.openSync(tmp, "wx", 0o600);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    try {
      try {
        fs.writeSync(fd, payload, null, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      replaceWithRetry(tmp, manifestPath);
    } catch (e) {
      if (!isOSError(e)) throw e;
      try {
        fs.unlinkSync(tmp);
      } catch {
        // The temporary file is already gone.
      }
    }
  }

  /** Remove a share entry that cswap created. The caller makes sure that `dest` is in the manifest or is a symlink. */
  static removeManaged(dest: string): void {
    try {
      if (isSymlink(dest) || isFile(dest)) {
        unlinkMissingOk(dest);
      } else if (isDir(dest)) {
        try {
          fs.rmSync(dest, { recursive: true, force: true });
        } catch {
          // Same as `rmtree(ignore_errors=True)`.
        }
      }
    } catch (e) {
      if (!isOSError(e)) throw e;
    }
  }
}
