/** Data models for Claude Swap. */

import fs from "node:fs";
import type { UsageEntry } from "./usage_store.js";

/**
 * Letters, digits, `-`, `_` and `.`. The rules in `normalizeAlias` also refuse
 * an alias with digits only (it would collide with a slot number) and an alias
 * that starts with `-` (the CLI would read it as an option).
 */
const ALIAS_RE = /^[a-z0-9_.-]+$/;

/**
 * Lowercase and validate a proposed alias. Throw `RangeError` if it is not valid.
 * The CLI, `cswap add --alias` and the import validation use this function.
 */
export function normalizeAlias(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) throw new RangeError("alias cannot be empty");
  if (/^\d+$/.test(normalized)) {
    throw new RangeError(`alias '${name}' cannot be purely numeric (reserved for slot numbers)`);
  }
  if (normalized.startsWith("-")) {
    throw new RangeError(`alias '${name}' cannot start with '-' (would be read as a command flag)`);
  }
  if (!ALIAS_RE.test(normalized)) {
    throw new RangeError(`alias '${name}' may only contain letters, digits, '-', '_', and '.'`);
  }
  return normalized;
}

/** Seams that the tests change. */
export const internals = {
  /** The value of Python `sys.platform` that `Platform.detect()` reads. */
  sysPlatform(): string {
    return process.platform;
  },
};

export type Platform = "MACOS" | "LINUX" | "WSL" | "WINDOWS" | "UNKNOWN";

/** Supported platforms. A test can replace `detect` with `vi.spyOn(Platform, "detect")`. */
export const Platform = {
  MACOS: "MACOS",
  LINUX: "LINUX",
  WSL: "WSL",
  WINDOWS: "WINDOWS",
  UNKNOWN: "UNKNOWN",

  /** Detect the current platform. A Linux host with `WSL_DISTRO_NAME` set is WSL. */
  detect(): Platform {
    const sysPlatform = internals.sysPlatform();
    if (sysPlatform === "darwin") return "MACOS";
    if (sysPlatform === "win32") return "WINDOWS";
    if (sysPlatform.startsWith("linux")) {
      return process.env.WSL_DISTRO_NAME ? "WSL" : "LINUX";
    }
    return "UNKNOWN";
  },
} as const;

/** The JSON form of one account in the sequence file. */
export interface AccountInfoDict {
  email: string;
  uuid: string;
  organizationUuid: string;
  organizationName: string;
  added: string;
}

/** Information about a managed account. */
export class AccountInfo {
  email: string;
  uuid: string;
  organizationUuid: string;
  organizationName: string;
  added: string;
  number: number;

  constructor(fields: {
    email: string;
    uuid: string;
    organizationUuid: string;
    organizationName: string;
    added: string;
    number: number;
  }) {
    this.email = fields.email;
    this.uuid = fields.uuid;
    this.organizationUuid = fields.organizationUuid;
    this.organizationName = fields.organizationName;
    this.added = fields.added;
    this.number = fields.number;
  }

  get isOrganization(): boolean {
    return Boolean(this.organizationUuid);
  }

  /** `email [OrgName]` or `email [personal]`. */
  get displayLabel(): string {
    const tag = this.organizationName ? this.organizationName : "personal";
    return `${this.email} [${tag}]`;
  }

  static fromDict(number: number, data: Record<string, unknown>): AccountInfo {
    const text = (key: string): string => {
      const value = data[key];
      return value === undefined || value === null ? "" : (value as string);
    };
    return new AccountInfo({
      email: data.email === undefined ? "" : (data.email as string),
      uuid: data.uuid === undefined ? "" : (data.uuid as string),
      organizationUuid: text("organizationUuid") || "",
      organizationName: text("organizationName") || "",
      added: data.added === undefined ? "" : (data.added as string),
      number,
    });
  }

  toDict(): AccountInfoDict {
    return {
      email: this.email,
      uuid: this.uuid,
      organizationUuid: this.organizationUuid,
      organizationName: this.organizationName,
      added: this.added,
    };
  }
}

/**
 * One managed account as the interactive UIs (the TUI) see it.
 * `usage.sentinel` holds a derived state (for example "api key") that replaces the usage bars.
 */
export interface AccountSnapshot {
  readonly number: string;
  readonly email: string;
  readonly orgName: string;
  readonly orgUuid: string;
  readonly isActive: boolean;
  readonly kind: "oauth" | "api_key";
  readonly switchable: boolean;
  readonly usage: UsageEntry;
  readonly alias: string;
  /** The account is out of the auto-rotation. It stays a valid explicit target. */
  readonly disabled: boolean;
}

/** Make an `AccountSnapshot` with the Python defaults for `alias` and `disabled`. */
export function accountSnapshot(
  fields: Omit<AccountSnapshot, "alias" | "disabled"> & Partial<Pick<AccountSnapshot, "alias" | "disabled">>,
): AccountSnapshot {
  return Object.freeze({ alias: "", disabled: false, ...fields });
}

/** The org tag to show: the org name, or `personal`. */
export function displayTag(snapshot: Pick<AccountSnapshot, "orgName">): string {
  return snapshot.orgName ? snapshot.orgName : "personal";
}

/**
 * A coherent view of all the managed accounts. The metadata, the active
 * account and the usage entries come from the same collect pass.
 */
export interface AccountsSnapshot {
  readonly activeNumber: string | null;
  readonly accounts: readonly AccountSnapshot[];
  readonly takenAt: number;
}

/** The part of `ClaudeAccountSwitcher` that `SwitchTransaction.rollback` uses. */
export interface RollbackTarget {
  writeCredentials(credentials: string): unknown;
  getSequenceData(): Record<string, unknown> | null | undefined;
  writeJson(filePath: string, data: unknown): unknown;
  readonly sequenceFile: string;
  readonly logger: { info(message: string): void; error(message: string): void };
}

/** A switch operation that can roll back. */
export class SwitchTransaction {
  originalCredentials: string;
  originalConfig: string;
  originalAccountNum: string;
  originalEmail: string;
  configPath: string;
  completedSteps: string[];

  constructor(fields: {
    originalCredentials: string;
    originalConfig: string;
    originalAccountNum: string;
    originalEmail: string;
    configPath: string;
    completedSteps?: string[];
  }) {
    this.originalCredentials = fields.originalCredentials;
    this.originalConfig = fields.originalConfig;
    this.originalAccountNum = fields.originalAccountNum;
    this.originalEmail = fields.originalEmail;
    this.configPath = fields.configPath;
    this.completedSteps = fields.completedSteps ?? [];
  }

  recordStep(step: string): void {
    this.completedSteps.push(step);
  }

  /** Roll back the completed steps in reverse order. Return false if a step failed. */
  rollback(switcher: RollbackTarget): boolean {
    let success = true;
    for (const step of [...this.completedSteps].reverse()) {
      try {
        if (step === "credentials_written") {
          switcher.writeCredentials(this.originalCredentials);
        } else if (step === "config_written") {
          fs.writeFileSync(this.configPath, this.originalConfig, "utf8");
          if (process.platform !== "win32") fs.chmodSync(this.configPath, 0o600);
        } else if (step === "sequence_updated") {
          const data = switcher.getSequenceData();
          if (data && Object.keys(data).length > 0) {
            data.activeAccountNumber = pyInt(this.originalAccountNum);
            data.lastUpdated = getTimestamp();
            switcher.writeJson(switcher.sequenceFile, data);
          }
        }
        switcher.logger.info(`Rolled back step: ${step}`);
      } catch (e) {
        switcher.logger.error(`Failed to rollback step ${step}: ${e instanceof Error ? e.message : String(e)}`);
        success = false;
      }
    }
    return success;
  }
}

function pyInt(text: string): number {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) throw new RangeError(`invalid literal for int() with base 10: '${text}'`);
  return Number.parseInt(trimmed, 10);
}

/** The current UTC time as `YYYY-MM-DDTHH:MM:SSZ`. */
export function getTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
