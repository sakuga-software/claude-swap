/**
 * Detect the running Claude Code instances from the session records
 * (`~/.claude/sessions/{pid}.json`) and the IDE lockfiles
 * (`~/.claude/ide/{port}.lock`), as Claude Code itself does.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getLogger } from "./logging_config.js";
import { getClaudeConfigHome } from "./paths.js";

const logger = getLogger("claude_swap.process_detection");

/**
 * The OS reuses pids, so a session record can name a different process.
 * On Linux, `procStart` is a tick count that does not change. Elsewhere it
 * is a `ps -o lstart` wall-clock time, which needs slack for small clock steps.
 */
export const PID_REUSE_SLACK_S = 120;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A running Claude Code session from `~/.claude/sessions/{pid}.json`. */
export interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** "interactive", "bg", "daemon" or "daemon-worker". */
  kind: string;
  /** "cli", "claude-vscode", "claude-desktop", "sdk-cli" or "mcp". */
  entrypoint: string;
  /** "busy", "idle" or "waiting". */
  status: string | null;
}

/** A running IDE instance from `~/.claude/ide/{port}.lock`. */
export interface IdeInstance {
  /** From the file name. */
  port: number;
  pid: number;
  ideName: string;
  workspaceFolders: string[];
}

export function getClaudeDir(): string {
  return getClaudeConfigHome();
}

/** Seams that the tests change. The module calls its own functions through this object. */
export const internals = {
  sysPlatform: (): string => process.platform,
  kill: (pid: number, signal: number | NodeJS.Signals): void => {
    process.kill(pid, signal);
  },
  spawnSync: spawnSync as (command: string, args: string[], options: object) => SpawnSyncReturns<string>,
  readFile: (file: string): string => fs.readFileSync(file, "latin1"),
  isPidAlive,
  isPidAliveWindows,
  processStartedAt,
  processStartTicks,
  processIsClaude,
};

/**
 * Return true if a process with this pid runs. A pid that is not a 32-bit
 * signed integer throws `RangeError`, as the Python version throws `OverflowError`.
 */
export function isPidAlive(pid: number): boolean {
  if (pid <= 1) return false;
  if (!Number.isInteger(pid) || pid > 0x7fffffff) throw new RangeError(`pid out of range: ${pid}`);

  if (internals.sysPlatform() === "win32") return internals.isPidAliveWindows(pid);

  return killZero(pid);
}

function killZero(pid: number): boolean {
  try {
    internals.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM: the process exists, but this user cannot signal it.
    if (code === "EPERM") return true;
    if (typeof code === "string") return false;
    throw e;
  }
}

/** On Windows, Node implements `process.kill(pid, 0)` with `OpenProcess`, as the Python version does with ctypes. */
export function isPidAliveWindows(pid: number): boolean {
  try {
    return killZero(pid);
  } catch {
    return false;
  }
}

/**
 * `ps -o <columns>` for `pid` under `LC_ALL=C TZ=UTC`, or null if it is not
 * known. On Windows and on each failure, return null: "cannot tell" must
 * never mean "not the recorded process".
 */
function ps(pid: number, ...columns: string[]): string | null {
  if (internals.sysPlatform() === "win32") return null;
  let proc: SpawnSyncReturns<string>;
  try {
    proc = internals.spawnSync("ps", ["-o", columns.map((c) => `${c}=`).join(","), "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
  } catch {
    return null;
  }
  if (proc.error) return null;
  const text = (proc.stdout ?? "").trim();
  if (proc.status !== 0 || !text) return null;
  return text;
}

/** The start of `pid` in epoch seconds, read as Claude Code reads `procStart`, or null if not known. */
export function processStartedAt(pid: number): number | null {
  const text = ps(pid, "lstart");
  if (text === null) return null;
  try {
    return lstartSeconds(text);
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}

/**
 * Parse `Wed Sep  2 20:35:59 2026` (the `ps -o lstart` format under
 * `LC_ALL=C TZ=UTC`) as epoch seconds. Throw `RangeError` if the text has another format.
 */
export function lstartSeconds(text: string): number {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5 || !MONTHS.includes(parts[1]!)) throw new RangeError(text);
  const [, month, day, clock, year] = parts as [string, string, string, string, string];
  const fields = clock.split(":");
  if (fields.length !== 3 || !fields.every(isDigits) || !isDigits(day) || !isDigits(year)) {
    throw new RangeError(text);
  }
  const [hours, minutes, seconds] = fields.map(Number) as [number, number, number];
  return Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), hours, minutes, seconds) / 1000;
}

/** The start time in `/proc/<pid>/stat`, in clock ticks since boot, or null. Only Linux has this file. */
export function processStartTicks(pid: number): string | null {
  let text: string;
  try {
    text = internals.readFile(`/proc/${pid}/stat`);
  } catch {
    return null;
  }
  return statStartTicks(text);
}

/**
 * Field 22 of a `/proc/<pid>/stat` line. The command name is in parentheses
 * and can contain spaces and parentheses, so count from the last `)`.
 */
export function statStartTicks(text: string): string | null {
  const close = text.lastIndexOf(")");
  const rest = close === -1 ? text : text.slice(close + 1);
  const fields = rest.split(/\s+/).filter(Boolean);
  const ticks = fields[19];
  if (ticks === undefined || !isDigits(ticks)) return null;
  return ticks;
}

/**
 * Return true if the process at `pid` looks like a claude (from `ps -o comm=,args=`),
 * or null if it is not known.
 */
export function processIsClaude(pid: number): boolean | null {
  const text = ps(pid, "comm", "args");
  if (text === null) return null;
  return text.toLowerCase().includes("claude");
}

/**
 * Return true if the live process at `pid` is the one that wrote a record
 * with this `procStart`.
 * - Digits only (Linux): the tick counts must be equal.
 * - A `ps -o lstart` time: only a process that started after the record
 *   (plus slack) and is not a claude is a different process. A clock step
 *   can make a live claude look younger than its record.
 * - All that is not known passes, so a live session never looks absent.
 */
export function pidMatchesRecord(pid: number, procStart: string | null | undefined): boolean {
  if (!procStart) return true;
  if (isDigits(procStart)) {
    const ticks = internals.processStartTicks(pid);
    return ticks === null || ticks === procStart;
  }
  let recorded: number;
  try {
    recorded = lstartSeconds(procStart);
  } catch {
    return true;
  }
  const started = internals.processStartedAt(pid);
  if (started === null || started <= recorded + PID_REUSE_SLACK_S) return true;
  return internals.processIsClaude(pid) !== false;
}

/**
 * The live sessions, and the number of records that cannot be read.
 *
 * A record is live only if its pid is alive and still belongs to the claude
 * that wrote it. A guard must treat a count above zero as live: "0 live" and
 * "0 readable" give the same list, and only the first is safe for a
 * destructive step.
 */
export function scanSessions(claudeDir?: string | null): [ClaudeSession[], number] {
  const sessionsDir = path.join(claudeDir || getClaudeDir(), "sessions");
  if (!isDirectory(sessionsDir)) return [[], 0];

  const sessions: ClaudeSession[] = [];
  let unreadable = 0;
  for (const file of globFiles(sessionsDir, ".json")) {
    try {
      const data = readRecord(file);
      if (!("pid" in data)) throw new RecordError("missing pid");
      const pid = data.pid;
      if (typeof pid !== "number") throw new RecordError("pid is not a number");
      if (!internals.isPidAlive(pid)) continue;
      if (!pidMatchesRecord(pid, data.procStart as string | null | undefined)) {
        logger.debug("Skipping session file %s: pid %s was recycled", file, pid);
        continue;
      }
      sessions.push({
        pid,
        sessionId: (data.sessionId ?? "") as string,
        cwd: (data.cwd ?? "") as string,
        startedAt: (data.startedAt ?? 0) as number,
        kind: (data.kind ?? "") as string,
        entrypoint: (data.entrypoint ?? "") as string,
        status: (data.status ?? null) as string | null,
      });
    } catch (e) {
      unreadable += 1;
      logger.debug("Skipping session file %s: %s", file, (e as Error).message);
    }
  }
  return [sessions, unreadable];
}

/**
 * The live sessions. A record that cannot be read is skipped. Use this only
 * for a listing: a guard before a destructive step must call `scanSessions`.
 */
export function listSessions(claudeDir?: string | null): ClaudeSession[] {
  return scanSessions(claudeDir)[0];
}

/** The IDE lockfiles whose process is alive. */
export function listIdeInstances(claudeDir?: string | null): IdeInstance[] {
  const ideDir = path.join(claudeDir || getClaudeDir(), "ide");
  if (!isDirectory(ideDir)) return [];

  const instances: IdeInstance[] = [];
  for (const file of globFiles(ideDir, ".lock")) {
    try {
      const data = readRecord(file);
      const pid = data.pid;
      if (pid === undefined || pid === null) continue;
      if (typeof pid !== "number") throw new RecordError("pid is not a number");
      if (!internals.isPidAlive(pid)) continue;
      const port = pyInt(path.basename(file, ".lock"));
      instances.push({
        port,
        pid,
        ideName: (data.ideName ?? "Unknown IDE") as string,
        workspaceFolders: (data.workspaceFolders ?? []) as string[],
      });
    } catch (e) {
      logger.debug("Skipping IDE lockfile %s: %s", file, (e as Error).message);
    }
  }
  return instances;
}

/** All the running Claude Code sessions and IDE instances. */
export function getRunningInstances(claudeDir?: string | null): [ClaudeSession[], IdeInstance[]] {
  const resolved = claudeDir || getClaudeDir();
  return [listSessions(resolved), listIdeInstances(resolved)];
}

class RecordError extends Error {}

/** Read a JSON object. Throw if the file is not valid UTF-8, not valid JSON, or not an object. */
function readRecord(file: string): Record<string, unknown> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  const data: unknown = JSON.parse(text);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new RecordError("record is not a JSON object");
  }
  return data as Record<string, unknown>;
}

function globFiles(dir: string, suffix: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(dir, name));
}

function isDirectory(p: string): boolean {
  return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function isDigits(text: string): boolean {
  return /^\d+$/.test(text);
}

function pyInt(text: string): number {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) throw new RangeError(`invalid literal for int() with base 10: '${text}'`);
  return Number.parseInt(trimmed, 10);
}
