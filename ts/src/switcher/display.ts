/** Human text for the usage of one account: the lines under each row of `cswap list` and `cswap status`. */

import path from "node:path";
import {
  USAGE_API_KEY,
  USAGE_FOREIGN_CREDENTIAL,
  USAGE_KEYCHAIN_UNAVAILABLE,
  USAGE_RELOGIN_REQUIRED,
  USAGE_TOKEN_EXPIRED,
} from "../json_output.js";
import * as oauth from "../oauth.js";
import * as pace from "../pace.js";
import * as pollPolicy from "../poll_policy.js";
import { dimmed, formatAge, muted } from "../printer.js";
import { pyFixed, pyGroupedFixed, pyLen, ljust, rjust } from "../support/pyformat.js";
import { resolvePath } from "../support/pathlib.js";
import type { UsageEntry } from "../usage_store.js";
import { internals } from "./internals.js";

/**
 * Usage older than this gets a "· Xm ago" age note. Inside the serve TTL the
 * data is current by design (it is the poll cadence), so a note there is noise.
 */
export const USAGE_AGE_NOTE_S = pollPolicy.SERVE_TTL_S;

/**
 * Notes for the error kinds that need more than their identifier, in the
 * "usage unavailable (…)" line.
 */
export const ERROR_NOTES: Readonly<Record<string, string>> = Object.freeze({
  "store-unmirrored": "CLAUDE_SECURESTORAGE_CONFIG_DIR set — unset it or run from a normal shell",
  invalid_client: "cswap's OAuth client was rejected — systemic, not this account",
  "consume-busy": "another cswap surface holds the slot — retries next pass",
  "stash-unreadable":
    "this slot's stashed successor is unreadable — unlock the keychain or fix the file, then retry; `cswap unclaimed` inspects it",
});

/**
 * Notes for the sentinel usage states. The TUI shows the same words, so both
 * surfaces describe a state identically.
 */
export const SENTINEL_NOTES: Readonly<Record<string, string>> = Object.freeze({
  [USAGE_TOKEN_EXPIRED]: "token expired — refresh deferred this pass; retries automatically",
  [USAGE_FOREIGN_CREDENTIAL]: "live credential belongs to another account — a switch repairs it",
  [USAGE_API_KEY]: "API key (no quota)",
  [USAGE_KEYCHAIN_UNAVAILABLE]: "keychain unavailable — locked or in use; try again",
  [USAGE_RELOGIN_REQUIRED]: "re-login needed — refresh token dead; log in with Claude Code, then run: cswap add",
});

function lookup(table: Readonly<Record<string, string>>, key: string): string {
  return Object.hasOwn(table, key) ? table[key]! : key;
}

/** `"  (ahead of pace)"` when a weekly window is well ahead of pace, else `""`. */
export function paceMarker(window: unknown, fetchedAt: number | null | undefined): string {
  const result = pace.computePace(window, { fetchedAt });
  return result && result.ahead ? "  (ahead of pace)" : "";
}

function pct3(value: number): string {
  return rjust(pyFixed(value, 0), 3);
}

/** The usage rows of one measurement. Every label is padded to the widest one. */
export function formatUsageLines(usage: oauth.UsageDict, fetchedAt: number | null = null): string[] {
  const rows: Array<[string, string]> = [];
  const spend = usage.spend;
  if (spend) {
    const money = `$${pyGroupedFixed(spend.used, 2)} / $${pyGroupedFixed(spend.limit, 2)}`;
    const cell = oauth.freshResetStrings(spend);
    if (cell) rows.push(["$$", `${pct3(spend.pct)}%   resets ${ljust(cell[1], 12)}  ${money}`]);
    else rows.push(["$$", `${pct3(spend.pct)}%   ${money}`]);
  }
  for (const [label, w] of [
    ["5h", usage.five_hour],
    ["7d", usage.seven_day],
  ] as const) {
    if (w) {
      // Pace applies to the weekly window only, never to 5h (issue #125).
      const marker = label === "7d" ? paceMarker(w, fetchedAt) : "";
      const cell = oauth.freshResetStrings(w);
      if (cell) {
        const [countdown, clock] = cell;
        rows.push([label, `${pct3(w.pct)}%   resets ${ljust(clock, 12)}  in ${countdown}${marker}`]);
      } else {
        rows.push([label, `${pct3(w.pct)}%${marker}`]);
      }
    }
  }
  for (const w of usage.scoped ?? []) {
    // A model at or over its limit is the usual reason to switch, so it gets a flag.
    const marker = w.pct >= 100 ? "  (!)" : paceMarker(w, fetchedAt);
    const cell = oauth.freshResetStrings(w);
    if (cell) {
      const [countdown, clock] = cell;
      rows.push([w.name, `${pct3(w.pct)}%   resets ${ljust(clock, 12)}  in ${countdown}${marker}`]);
    } else {
      rows.push([w.name, `${pct3(w.pct)}%${marker}`]);
    }
  }
  const width = rows.reduce((max, [label]) => Math.max(max, pyLen(label)), 0) + 1;
  return rows.map(([label, body]) => `${ljust(`${label}:`, width)} ${body}`);
}

/**
 * "last seen 53% used · 12m ago" from the last-good measurement of an entry.
 * The TUI shows the same note under the sentinel states.
 */
export function lastSeenNote(entry: UsageEntry): string | null {
  if (entry.lastGood === null || entry.fetchedAt === null) return null;
  const headroom = oauth.accountHeadroom(entry.lastGood);
  if (headroom === null) return null;
  return `last seen ${pyFixed(100 - headroom, 0)}% used · ${formatAge(Math.trunc(entry.fetchedAt * 1000))}`;
}

/**
 * The styled usage lines (no indent) of one entry.
 *
 * A sentinel state shows its note, and a "last seen" line if an older
 * measurement exists. A measurement older than `USAGE_AGE_NOTE_S` gets an age
 * note. An account with no measurement shows "usage unavailable" and the last
 * fetch error.
 */
export function usageEntryLines(entry: UsageEntry): string[] {
  if (entry.sentinel !== null) {
    const out = [dimmed(lookup(SENTINEL_NOTES, entry.sentinel))];
    const lastSeen = lastSeenNote(entry);
    if (lastSeen !== null && entry.sentinel !== USAGE_API_KEY) out.push(`${dimmed("└")} ${muted(lastSeen)}`);
    return out;
  }
  if (entry.lastGood !== null) {
    const lines = formatUsageLines(entry.lastGood, entry.fetchedAt);
    if (lines.length > 0 && entry.ageS !== null && entry.ageS > USAGE_AGE_NOTE_S && entry.fetchedAt !== null) {
      lines[lines.length - 1] += ` · ${formatAge(Math.trunc(entry.fetchedAt * 1000))}`;
    }
    return lines.map((line, j) => `${dimmed(j === lines.length - 1 ? "└" : "├")} ${muted(line)}`);
  }
  let detail = "usage unavailable";
  if (entry.lastError) detail += ` (${lookup(ERROR_NOTES, entry.lastError)})`;
  return [dimmed(detail)];
}

/** `oauth.buildTokenStatus` with the label of the credential source. */
export function labelTokenStatus(source: string, credentials: string): string | null {
  const status = internals.buildTokenStatus(credentials);
  if (status === null) return null;
  const prefix = "oauth: ";
  if (status.startsWith(prefix)) return `${source}: ${status.slice(prefix.length)}`;
  return `${source}: ${status}`;
}

/**
 * True if two paths name the same directory, through symlinks and `..`.
 * If the resolution fails, compare the paths as written.
 */
export function sameDirectory(left: string, right: string): boolean {
  try {
    return resolvePath(left) === resolvePath(right);
  } catch {
    return path.normalize(left) === path.normalize(right);
  }
}
