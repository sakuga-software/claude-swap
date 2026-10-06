/**
 * macOS Keychain access with the `security` CLI.
 *
 * The same stable `/usr/bin/security` binary creates and reads each item, so
 * reads stay silent across upgrades. The command shapes mirror Claude Code
 * (`utils/secureStorage/macOsKeychainStorage.ts`). Values must be printable
 * text: `find-generic-password -w` returns other data hex-encoded.
 *
 * The module is safe to import on every platform. It starts `security` only
 * when a function is called.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import os from "node:os";

/**
 * `security -i` reads stdin with a 4096-byte line buffer. A longer command
 * line is cut in the middle of an argument and the write fails (Claude Code
 * #30337). The 64 bytes of margin cover line terminator differences.
 */
export const SECURITY_STDIN_LINE_LIMIT = 4096 - 64;

const NOT_FOUND_RC = 44;

/**
 * A locked login keychain on a headless host can wait for an unlock forever.
 * The timeout stops that. A fallback can add a cleanup spawn, so keep it short.
 */
export const TIMEOUT_MS = 5000;

/** An absolute path, so that a `security` binary earlier on PATH cannot read the secrets. */
const SECURITY = "/usr/bin/security";

/** A `security` call failed for a reason that is not "not found". */
export class KeychainError extends Error {
  override name = "KeychainError";
}

/**
 * Replaces the Python `KEYCHAIN_ERRORS` tuple. Returns true for an error that
 * means "the Keychain is not usable": a `KeychainError` (a timeout included)
 * or a system error such as a missing `security` binary. Any other error is a
 * bug and must not cause a fallback to file storage.
 */
export function isKeychainError(err: unknown): boolean {
  if (err instanceof KeychainError) return true;
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
}

type SpawnSyncFn = (
  file: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

function realGetPassword(service: string, account: string): string | null {
  const result = run("find-generic-password", [SECURITY, "find-generic-password", "-a", account, "-w", "-s", service]);
  if (result.status === 0) return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (result.status === NOT_FOUND_RC) return null;
  throw failure("find-generic-password", result);
}

function realItemExists(service: string, account: string): boolean {
  const result = internals.spawnSync(SECURITY, ["find-generic-password", "-a", account, "-s", service], options());
  return !result.error && result.status === 0;
}

function realSetPassword(service: string, account: string, password: string): void {
  const hexValue = Buffer.from(password, "utf8").toString("hex");
  const command = `add-generic-password -U -a ${quote(account)} -s ${quote(service)} -X ${hexValue}\n`;
  // If the command is too long for stdin, put it in argv. Hex in argv is
  // visible to a process monitor, but a cut stdin line corrupts the entry.
  const result =
    Buffer.byteLength(command, "utf8") <= SECURITY_STDIN_LINE_LIMIT
      ? run("add-generic-password", [SECURITY, "-i"], command)
      : run("add-generic-password", [SECURITY, "add-generic-password", "-U", "-a", account, "-s", service, "-X", hexValue]);
  if (result.status !== 0) throw failure("add-generic-password", result);
}

function realDeletePassword(service: string, account: string): void {
  const result = run("delete-generic-password", [SECURITY, "delete-generic-password", "-a", account, "-s", service]);
  if (result.status === 0 || result.status === NOT_FOUND_RC) return;
  throw failure("delete-generic-password", result);
}

/**
 * The replaceable parts of this module. The four public functions call the
 * Keychain through these properties, so a test can install a fake for each one.
 */
export const internals: {
  spawnSync: SpawnSyncFn;
  getPassword: (service: string, account: string) => string | null;
  itemExists: (service: string, account: string) => boolean;
  setPassword: (service: string, account: string, password: string) => void;
  deletePassword: (service: string, account: string) => void;
} = {
  spawnSync: spawnSync as SpawnSyncFn,
  getPassword: realGetPassword,
  itemExists: realItemExists,
  setPassword: realSetPassword,
  deletePassword: realDeletePassword,
};

/** The implementations that start `security`. A test helper uses them to restore `internals`. */
export const realImplementations = {
  getPassword: realGetPassword,
  itemExists: realItemExists,
  setPassword: realSetPassword,
  deletePassword: realDeletePassword,
} as const;

/**
 * The account name of the active credential item. It mirrors `getUsername()`
 * in Claude Code: `$USER`, then the OS user name, then a fixed name. A
 * different default makes the two tools use different Keychain items.
 */
export function keychainAccountName(): string {
  const user = process.env.USER;
  if (user) return user;
  try {
    return os.userInfo().username;
  } catch {
    return "claude-code-user";
  }
}

/**
 * Returns the stored password, or `null` if the item does not exist (rc 44).
 * Throws `KeychainError` for a different non-zero exit or a timeout.
 */
export function getPassword(service: string, account: string): string | null {
  return internals.getPassword(service, account);
}

/**
 * Returns true if a generic password item exists. The lookup reads only the
 * attributes, so it cannot show a Keychain prompt. It never throws: a failure
 * or a timeout returns false.
 */
export function itemExists(service: string, account: string): boolean {
  return internals.itemExists(service, account);
}

/**
 * Creates or updates a generic password item (`-U`). The secret goes to
 * `security -i` on stdin, not in argv, if the command fits the stdin line.
 * Throws `KeychainError` for a non-zero exit or a timeout.
 */
export function setPassword(service: string, account: string, password: string): void {
  internals.setPassword(service, account, password);
}

/**
 * Deletes a generic password item. An item that does not exist (rc 44) is a
 * success. Throws `KeychainError` for a different non-zero exit or a timeout.
 */
export function deletePassword(service: string, account: string): void {
  internals.deletePassword(service, account);
}

function options(input?: string): SpawnSyncOptionsWithStringEncoding {
  const opts: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", timeout: TIMEOUT_MS };
  if (input !== undefined) opts.input = input;
  return opts;
}

function run(operation: string, argv: string[], input?: string): SpawnSyncReturns<string> {
  const [file, ...args] = argv as [string, ...string[]];
  const result = internals.spawnSync(file, args, options(input));
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new KeychainError(`security ${operation} timed out after ${(TIMEOUT_MS / 1000).toFixed(1)}s`, {
        cause: result.error,
      });
    }
    throw result.error;
  }
  return result;
}

function failure(operation: string, result: SpawnSyncReturns<string>): KeychainError {
  return new KeychainError(`security ${operation} failed (rc=${result.status}): ${(result.stderr ?? "").trim()}`);
}

/** `security -i` parses each line like a shell, so quote the value and escape `"` and `\`. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
