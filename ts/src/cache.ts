/** Simple file-based cache utilities for claude-swap. */

import fs from "node:fs";
import path from "node:path";
import { getBackupRoot } from "./paths.js";
import { jsonDumps } from "./support/py.js";

/**
 * The cache directory. Python computes `CACHE_DIR` at import time. This port
 * computes it at each call, because the tests change `HOME`.
 */
export function getCacheDir(): string {
  return path.join(getBackupRoot(), "cache");
}

/** The value of `readCache` if no valid cache entry exists. A cached `null` is a different value. */
export const MISSING: unique symbol = Symbol("MISSING");

/**
 * Return the stored `data` of a cache file that is younger than `ttl` seconds.
 * Otherwise return `fallback` (`MISSING` if not given).
 */
export function readCache(filePath: string, ttl: number, fallback: unknown = MISSING): unknown {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fallback;
    const record = raw as Record<string, unknown>;
    if (!("timestamp" in record) || !("data" in record)) return fallback;
    const timestamp = record.timestamp;
    if (typeof timestamp !== "number") return fallback;
    if (Date.now() / 1000 - timestamp < ttl) return record.data;
  } catch {
    return fallback;
  }
  return fallback;
}

/** Write `data` to a cache file with a timestamp. */
export function writeCache(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, jsonDumps({ timestamp: Date.now() / 1000, data }), "utf8");
}
