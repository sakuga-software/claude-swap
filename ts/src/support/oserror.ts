/** Python `OSError` checks for Node errors. */

/**
 * True if `e` is a Node system error (it has a string `code`), the
 * equivalent of a Python `OSError`. An error with no code, for example the
 * real-store guard of the tests, is not an `OSError`.
 */
export function isOsError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string";
}

/** Python `FileNotFoundError`. */
export function isFileNotFound(e: unknown): boolean {
  return isOsError(e) && e.code === "ENOENT";
}

/** Python `PermissionError`. */
export function isPermissionError(e: unknown): boolean {
  return isOsError(e) && (e.code === "EACCES" || e.code === "EPERM");
}

/** The message of an error, as Python `str(e)` gives it. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
