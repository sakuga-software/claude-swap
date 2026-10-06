/**
 * Directory to account mappings for the `cswap run` auto-resolution.
 *
 * A key is a normalized absolute directory. An entry holds the stable
 * identity (email and organizationUuid), not the slot number, because slot
 * numbers are reused. This module does not import the switcher: the caller
 * resolves an entry to a live slot.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { replaceWithRetry } from "./fsutil.js";
import { getTimestamp } from "./models.js";
import { jsonDumps } from "./support/py.js";
import { expandUser, resolvePath } from "./support/pathlib.js";

export const SCHEMA_VERSION = 1;

export interface MappingEntry {
  email: string;
  organizationUuid: string;
  added: string;
  [key: string]: unknown;
}

/** Seams that the tests change. */
export const internals = {
  /** `os.path.normcase`: lowercase and backslashes on Windows, the identity elsewhere. */
  normcase(p: string): string {
    return process.platform === "win32" ? p.toLowerCase().replaceAll("/", "\\") : p;
  },
};

/**
 * Normalize a path to a stable mapping key: expand `~`, make it absolute,
 * resolve the symlinks and apply `normcase`.
 */
export function normalizePath(p: string): string {
  return internals.normcase(resolvePath(expandUser(p)));
}

/** Reads and writes `<backup_dir>/mappings.json`. */
export class MappingStore {
  readonly path: string;

  constructor(backupDir: string) {
    this.path = path.join(backupDir, "mappings.json");
  }

  /** The normalized path to entry map. It is empty if the file is missing or not valid. */
  load(): Record<string, MappingEntry> {
    if (!fs.existsSync(this.path)) return {};
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(this.path)));
    } catch {
      return {};
    }
    if (!isObject(data)) return {};
    const mappings = "mappings" in data ? data.mappings : {};
    return isObject(mappings) ? (mappings as Record<string, MappingEntry>) : {};
  }

  all(): Record<string, MappingEntry> {
    return this.load();
  }

  /** Exact lookup for a normalized path. It does not look at the ancestors. */
  get(p: string): MappingEntry | null {
    const mappings = this.load();
    const key = normalizePath(p);
    return Object.hasOwn(mappings, key) ? (mappings[key] ?? null) : null;
  }

  /** Add or replace the mapping for `p`, and write the file atomically. */
  set(p: string, email: string, orgUuid: string | null | undefined): void {
    const mappings = this.load();
    mappings[normalizePath(p)] = {
      email,
      organizationUuid: orgUuid || "",
      added: getTimestamp(),
    };
    this.write(mappings);
  }

  /** Delete the mapping for `p`. Return true if a mapping was removed. */
  remove(p: string): boolean {
    const mappings = this.load();
    const key = normalizePath(p);
    if (!Object.hasOwn(mappings, key) || mappings[key] == null) return false;
    delete mappings[key];
    this.write(mappings);
    return true;
  }

  /** Delete each mapping to (email, orgUuid). Return the number removed. */
  pruneAccount(email: string, orgUuid: string | null | undefined): number {
    const mappings = this.load();
    const org = orgUuid || "";
    const doomed = Object.entries(mappings)
      .filter(([, entry]) => isObject(entry) && entry.email === email && (entry.organizationUuid || "") === org)
      .map(([key]) => key);
    for (const key of doomed) delete mappings[key];
    if (doomed.length > 0) this.write(mappings);
    return doomed.length;
  }

  /**
   * Return [key, entry] of the deepest mapped directory that is `cwd` or an
   * ancestor of `cwd`, or null.
   */
  resolve(cwd: string): [string, MappingEntry] | null {
    const target = normalizePath(cwd);
    const mappings = this.load();
    const chain = new Set<string>([target]);
    for (let dir = target, parent = path.dirname(dir); parent !== dir; dir = parent, parent = path.dirname(dir)) {
      chain.add(parent);
    }
    let best: [string, MappingEntry] | null = null;
    for (const [key, entry] of Object.entries(mappings)) {
      if (chain.has(path.normalize(key)) && (best === null || key.length > best[0].length)) {
        best = [key, entry];
      }
    }
    return best;
  }

  private write(mappings: Record<string, MappingEntry>): void {
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
    const payload = jsonDumps({ schemaVersion: SCHEMA_VERSION, mappings }, 2);
    const tmp = path.join(dir, `.mappings-${randomBytes(6).toString("hex")}.tmp`);
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      try {
        if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, payload, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      replaceWithRetry(tmp, this.path);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
