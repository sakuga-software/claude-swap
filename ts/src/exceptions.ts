/** Base error for Claude Switch errors. */
export class ClaudeSwitchError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Error related to credential operations. */
export class CredentialError extends ClaudeSwitchError {}

/** Failed to read credentials. */
export class CredentialReadError extends CredentialError {}

/** Failed to write credentials. */
export class CredentialWriteError extends CredentialError {}

/** Error related to configuration operations. */
export class ConfigError extends ClaudeSwitchError {}

/** Error during account switch operation. */
export class SwitchError extends ClaudeSwitchError {}

/** Error to set up or launch a session-mode profile. */
export class SessionError extends ClaudeSwitchError {}

/** Error to acquire a lock. */
export class LockError extends ClaudeSwitchError {}

/**
 * A wait for one of the advisory locks of Claude Code (`~/.claude.lock`,
 * `~/.claude.json.lock`) timed out. Nothing changed, so the caller can retry.
 */
export class ClaudeCodeLockTimeout extends LockError {}

/** Account not found. */
export class AccountNotFoundError extends ClaudeSwitchError {}

/** Validation error. */
export class ValidationError extends ClaudeSwitchError {}

/** Error during account export or import. */
export class TransferError extends ClaudeSwitchError {}

/** Error to migrate the backup directory between layouts (for example legacy to XDG). */
export class MigrationError extends ClaudeSwitchError {}

/**
 * A run-once migration did not finish for every record. The migration runner
 * records it as "not applied" and tries it again on the next run.
 */
export class MigrationIncomplete extends ClaudeSwitchError {}
