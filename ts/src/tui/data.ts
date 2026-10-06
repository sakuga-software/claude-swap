/**
 * Data service of the TUI: snapshots, captured actions and display helpers.
 *
 * The TUI never parses printed CLI output. It reads
 * `ClaudeAccountSwitcher.accountsSnapshot` and renders structured data.
 * `SnapshotSource` (shared with the GUI shells) paces the fetches.
 */

import { stripVTControlCharacters } from "node:util";
import { ClaudeSwitchError } from "../exceptions.js";
import type { AccountsSnapshot } from "../models.js";
import * as oauth from "../oauth.js";
import * as printer from "../printer.js";
import { SnapshotSource } from "../snapshot_source.js";
import { EOFError } from "../support/input.js";
import { fromisoformat } from "../support/py.js";
import { SENTINEL_NOTES, lastSeenNote } from "../switcher/display.js";
import { internals as switcherInternals } from "../switcher/internals.js";
import { SERVE_TTL_S } from "../usage_store.js";

export { SnapshotSource, lastSeenNote };

/** The part of `ClaudeAccountSwitcher` that the TUI uses. */
export interface TuiSwitcher {
  readonly backupDir: string;
  accountsSnapshot(fetch?: ReadonlySet<string> | null): Promise<AccountsSnapshot>;
  switchTo(identifier: string, jsonOutput?: boolean, force?: boolean): unknown;
  switch(strategy?: string | null, jsonOutput?: boolean): unknown;
  removeAccount(identifier: string, assumeYes?: boolean): unknown;
  setAccountDisabled(identifier: string, disabled: boolean): unknown;
  addAccount(slot?: number | null, assumeYes?: boolean): unknown;
  addAccountFromToken(token: string, email?: string | null, slot?: number | null, assumeYes?: boolean): unknown;
  setPollPolicyInputs(threshold: number, models: readonly string[]): void;
  clearPollPolicyInputs(): void;
}

/** The outcome of a captured switcher action. */
export class ActionResult {
  constructor(
    readonly ok: boolean,
    /** The captured stdout and stderr, with ANSI colors. */
    readonly output: string,
    /** The structured result of an action that supports JSON. */
    readonly payload: Record<string, unknown> | null = null,
  ) {}

  /** The first line of the output that is not empty, without ANSI codes. */
  get firstLine(): string {
    for (const line of this.output.split(/\r?\n/)) {
      const plain = stripVTControlCharacters(line).trim();
      if (plain) return plain;
    }
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eofInput(): never {
  throw new EOFError("EOF when reading a line");
}

/**
 * Run a switcher action with stdout and stderr captured and colors forced on.
 *
 * The terminal input seams of the switcher throw `EOFError` during the action,
 * so an unexpected prompt fails and does not freeze the TUI.
 *
 * WARNING: The capture is global to the process. The Ink renderer must write
 * through a stream that keeps the original `write` (see `tui/index.tsx`).
 */
export async function runAction(fn: () => unknown): Promise<ActionResult> {
  let buf = "";
  const capture = (chunk: string | Uint8Array): boolean => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  const savedSeams = {
    input: switcherInternals.input,
    getpass: switcherInternals.getpass,
    readStdinLine: switcherInternals.readStdinLine,
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  Object.assign(switcherInternals, { input: eofInput, getpass: eofInput, readStdinLine: eofInput });
  try {
    return await printer.forceColor(async () => {
      let payload: unknown;
      try {
        payload = await fn();
      } catch (e) {
        if (e instanceof ClaudeSwitchError) {
          buf += `Error: ${e.message}\n`;
          return new ActionResult(false, buf);
        }
        if (e instanceof EOFError) {
          buf += "Error: interactive input is not available here.\n";
          return new ActionResult(false, buf);
        }
        throw e;
      }
      return new ActionResult(true, buf, isRecord(payload) ? payload : null);
    });
  } finally {
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
    Object.assign(switcherInternals, savedSeams);
  }
}

/** The wording that `cswap list` prints for this sentinel state. */
export function sentinelLabel(sentinel: string): string {
  return Object.hasOwn(SENTINEL_NOTES, sentinel) ? SENTINEL_NOTES[sentinel]! : sentinel;
}

function pyNumber(value: unknown): number | null {
  return typeof value === "number" ? value : typeof value === "boolean" ? Number(value) : null;
}

/** The utilization pct of one window (`five_hour` or `seven_day`), if known. */
export function windowPct(lastGood: unknown, key: string): number | null {
  if (!isRecord(lastGood)) return null;
  const window = lastGood[key];
  if (!isRecord(window)) return null;
  return pyNumber(window.pct);
}

function resetDate(window: unknown): Date | null {
  if (!isRecord(window)) return null;
  const resetsAt = window.resets_at;
  if (!resetsAt) return null;
  try {
    const date = fromisoformat(String(resetsAt));
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

/**
 * The live countdown to the reset of one window ("resets 2h 13m"), if known.
 * It comes from `resets_at` at render time, because the countdown of the fetch time becomes old.
 */
export function resetText(window: unknown, now: number): string | null {
  const date = resetDate(window);
  if (date === null) return null;
  const remaining = date.getTime() / 1000 - now;
  if (remaining <= 0) return "resets now";
  return `resets ${formatDuration(remaining)}`;
}

/** The local reset time ("20:39" or "Jul 14 09:00"), or null if unknown or elapsed. */
export function resetClock(window: unknown, now: number): string | null {
  const date = resetDate(window);
  if (date === null) return null;
  if (date.getTime() / 1000 - now <= 0) return null;
  return oauth.resetClockString(date, new Date(now * 1000));
}

/** `resetText` for one of the top-level 5h and 7d windows. */
export function windowResetText(lastGood: unknown, key: string, now: number): string | null {
  if (!isRecord(lastGood)) return null;
  return resetText(lastGood[key], now);
}

/** A compact duration: "45s", "12m", "2h 13m", "3d 4h". */
export function formatDuration(seconds: number): string {
  const s = Math.trunc(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    const minutes = Math.floor(s / 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const hours = Math.floor(s / 3600);
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** The age note of a measurement ("· 2m ago"), or null while the measurement is fresh. */
export function formatAge(ageS: number | null | undefined): string | null {
  if (ageS === null || ageS === undefined || ageS < SERVE_TTL_S) return null;
  return `· ${formatDuration(ageS)} ago`;
}

/** The local time as HH:MM:SS, for the event log. */
export function clockStamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
