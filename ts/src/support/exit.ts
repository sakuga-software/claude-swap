/** Python `SystemExit` and `KeyboardInterrupt` for the CLI. */

/**
 * The CLI throws this error instead of a call to `process.exit()`. The entry
 * point catches it and sets the exit status. Thus a test can call `main()`.
 */
export class SystemExit extends Error {
  override name = "SystemExit";

  constructor(readonly code: number = 0) {
    super(`SystemExit(${code})`);
  }
}

/** The user interrupted an operation. The CLI prints a cancel note and exits with 130. */
export class KeyboardInterrupt extends Error {
  override name = "KeyboardInterrupt";
}
