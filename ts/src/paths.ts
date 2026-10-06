/**
 * Path resolution for the Claude Code config and credential files, with the
 * same rules as Claude Code (`utils/env.ts getGlobalClaudeFile`,
 * `utils/secureStorage/plainTextStorage.ts getStoragePath`).
 * Also resolves the cswap backup root (XDG on Linux and WSL).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MigrationError } from "./exceptions.js";
import { Platform } from "./models.js";
import { expandUser, resolvePath } from "./support/pathlib.js";

export const LEGACY_BACKUP_DIRNAME = ".claude-swap-backup";

/** Seams that the tests change. */
export const internals = {
  /** `shutil.move`: a rename, or a copy and a delete across file systems. */
  move(src: string, dst: string): void {
    try {
      fs.renameSync(src, dst);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
  },
};

/** The Claude config home: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function getClaudeConfigHome(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) return env;
  return path.join(os.homedir(), ".claude");
}

/**
 * The global Claude config file: the legacy `<config_home>/.config.json` if it
 * exists, else `(CLAUDE_CONFIG_DIR || $HOME)/.claude.json`.
 */
export function getGlobalConfigPath(): string {
  const legacy = path.join(getClaudeConfigHome(), ".config.json");
  if (fs.existsSync(legacy)) return legacy;
  const env = process.env.CLAUDE_CONFIG_DIR;
  return path.join(env ? env : os.homedir(), ".claude.json");
}

/** The config home of the default profile. This function ignores `CLAUDE_CONFIG_DIR`. */
export function getDefaultClaudeConfigHome(): string {
  return path.join(os.homedir(), ".claude");
}

/**
 * The global config path of the default profile. This function ignores
 * `CLAUDE_CONFIG_DIR`, because a caller that mirrors the real profile must
 * not read from another session.
 */
export function getDefaultGlobalConfigPath(): string {
  const legacy = path.join(getDefaultClaudeConfigHome(), ".config.json");
  if (fs.existsSync(legacy)) return legacy;
  return path.join(os.homedir(), ".claude.json");
}

export function getCredentialsPath(): string {
  return path.join(getClaudeConfigHome(), ".credentials.json");
}

/** The legacy (before XDG) backup root: `~/.claude-swap-backup`. */
export function getLegacyBackupRoot(): string {
  return path.join(os.homedir(), LEGACY_BACKUP_DIRNAME);
}

/**
 * The cswap backup root for the current platform.
 * - Linux and WSL: `$XDG_DATA_HOME/claude-swap`, else `~/.local/share/claude-swap`.
 * - Other platforms: `~/.claude-swap-backup`.
 *
 * The XDG spec ignores an empty or relative `$XDG_DATA_HOME`. A leading `~`
 * expands, because systemd units and Dockerfiles do no shell expansion.
 */
export function getBackupRoot(): string {
  const platform = Platform.detect();
  if (platform === Platform.LINUX || platform === Platform.WSL) {
    const xdg = process.env.XDG_DATA_HOME ?? "";
    if (xdg) {
      const xdgPath = expandUser(xdg);
      if (path.isAbsolute(xdgPath)) return path.join(xdgPath, "claude-swap");
    }
    return path.join(os.homedir(), ".local", "share", "claude-swap");
  }
  return getLegacyBackupRoot();
}

/** Names that any cswap run can create in the backup root with no user data. */
const THROWAWAY_NAMES = new Set(["cache"]);
const THROWAWAY_PREFIXES = ["claude-swap.log"];

function listDir(target: string): fs.Dirent[] | undefined {
  try {
    return fs.readdirSync(target, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e;
  }
}

function targetHasMeaningfulData(target: string): boolean {
  for (const entry of listDir(target) ?? []) {
    if (THROWAWAY_NAMES.has(entry.name)) continue;
    if (THROWAWAY_PREFIXES.some((p) => entry.name.startsWith(p))) continue;
    return true;
  }
  return false;
}

function wipeThrowawayArtifacts(target: string): void {
  const entries = listDir(target);
  if (entries === undefined) return;
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) fs.rmSync(full, { recursive: true });
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(target);
}

/**
 * The flag of an interrupted migration to `target`. It is a sibling of the
 * backup root, not a child. Spell it only here: this flag lets the migration
 * delete the destination.
 */
export function migrationFlagFor(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.migrating`);
}

/**
 * Move the legacy backup directory to `target` if necessary.
 *
 * The flag file exists during the move. On the next run:
 * - Flag and legacy present: the move stopped. Delete the partial target and move again.
 * - Flag present, legacy gone: the move completed. Delete the flag.
 * - No flag, both paths present: refuse, unless the target holds only
 *   throwaway artifacts (cache, log files).
 *
 * Return true if the move occurred in this call.
 * Throw `MigrationError` on a collision or if the move fails.
 */
export function migrateLegacyBackupDir(target: string): boolean {
  const legacy = getLegacyBackupRoot();
  if (resolvePath(legacy) === resolvePath(target)) return false;

  const flag = migrationFlagFor(target);

  if (!fs.existsSync(legacy)) {
    fs.rmSync(flag, { force: true });
    return false;
  }

  try {
    if (fs.existsSync(flag)) {
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
    } else if (fs.existsSync(target)) {
      if (targetHasMeaningfulData(target)) {
        throw new MigrationError(
          `Both legacy (${legacy}) and new (${target}) backup paths exist. ` +
            "Refusing to merge or overwrite — inspect both and remove the " +
            "stale one manually before re-running.",
        );
      }
      wipeThrowawayArtifacts(target);
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    touch(flag);
    internals.move(legacy, target);
    fs.unlinkSync(flag);
  } catch (e) {
    if (e instanceof MigrationError || !isOsError(e)) throw e;
    throw new MigrationError(`Migration of ${legacy} → ${target} failed: ${(e as Error).message}`, { cause: e });
  }

  return true;
}

function touch(file: string): void {
  fs.closeSync(fs.openSync(file, "a"));
  const now = new Date();
  fs.utimesSync(file, now, now);
}

function isOsError(e: unknown): boolean {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string";
}
