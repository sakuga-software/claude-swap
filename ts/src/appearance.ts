import fs from "node:fs";
import tty from "node:tty";
import { sleepSync } from "./support/sleep.js";

export type Appearance = "light" | "dark";

export const QUERY = Buffer.from("\x1b]11;?\x07", "latin1");
/** Device attributes (DA1) query. Its reply marks the end of the ordered replies. */
export const DA1_QUERY = Buffer.from("\x1b[c", "latin1");
// DA1 lets unsupported terminals reply fast. The cap covers SSH latency and terminals that reply to neither query.
const TIMEOUT_S = 1.0;
const MAX_REPLY = 256;
const POLL_INTERVAL_MS = 5;
// The full `ESC ]11;` opener prevents a match on echoed or interleaved input.
const RGB = /\x1b\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)(?:\x07|\x1b\\)/;
const HEX = /\x1b\]11;#([0-9a-fA-F]{6})(?:\x07|\x1b\\)/;
// A DA1 reply is `CSI ? Ps c`. The `?` marker prevents a match on an echoed DA1 query (`CSI c`).
const DA1_REPLY = /(?:\x1b\[|\x9b)\?[0-9;:]*c/;

/** The value of `internals.cache` before the first detection. */
export const UNSET = Symbol("unset");

let peeked: Buffer | undefined;

/** Mutable module state and seams. Tests replace these properties. */
export const internals = {
  /** The terminal background cannot change in a process, so the code queries it one time only. */
  cache: UNSET as typeof UNSET | Appearance | null,
  queryTerminalBackground: (): Buffer | null => queryTerminalBackground(),
  stdinIsatty: (): boolean => tty.isatty(0),
  stdoutIsatty: (): boolean => tty.isatty(1),
  /** Open the controlling terminal for nonblocking reads. The returned descriptor is the `fileno` of the query. */
  stdinFileno: (): number => fs.openSync("/dev/tty", fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY),
  closeFileno: (fd: number): void => fs.closeSync(fd),
  /** Get the terminal attributes to restore later. Node keeps them itself, so this only checks for a tty stream. */
  tcgetattr: (_fd: number): unknown => {
    if (typeof process.stdin.setRawMode !== "function") throw new Error("stdin is not a tty stream");
    return true;
  },
  setcbreak: (_fd: number): void => {
    process.stdin.setRawMode(true);
  },
  tcsetattr: (_fd: number, _old: unknown): void => {
    process.stdin.setRawMode(false);
  },
  writeStdout: (text: string): void => {
    fs.writeSync(1, text);
  },
  select: (fd: number, timeoutS: number): boolean => pollReadable(fd, timeoutS),
  read: (fd: number, size: number): Buffer => {
    if (peeked !== undefined) {
      const chunk = peeked;
      peeked = undefined;
      return chunk;
    }
    const buf = Buffer.alloc(size);
    return buf.subarray(0, fs.readSync(fd, buf, 0, size, null));
  },
  monotonic: (): number => performance.now() / 1000,
  tcflush: (): void => {
    let fd: number;
    try {
      fd = internals.stdinFileno();
    } catch {
      return;
    }
    try {
      const buf = Buffer.alloc(256);
      while (readNonblocking(fd, buf) > 0);
    } catch {
      // Best effort only.
    } finally {
      internals.closeFileno(fd);
    }
  },
};

/** Return the bytes read, 0 at end of file, or -1 if no input is pending. */
function readNonblocking(fd: number, buf: Buffer): number {
  try {
    return fs.readSync(fd, buf, 0, buf.length, null);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EAGAIN") return -1;
    throw err;
  }
}

// Node has no synchronous select(). This function polls a nonblocking read and keeps the bytes for `internals.read`.
function pollReadable(fd: number, timeoutS: number): boolean {
  const deadline = performance.now() + timeoutS * 1000;
  const buf = Buffer.alloc(32);
  for (;;) {
    const n = readNonblocking(fd, buf);
    if (n >= 0) {
      peeked = Buffer.from(buf.subarray(0, n));
      return true;
    }
    const left = deadline - performance.now();
    if (left <= 0) return false;
    sleepSync(Math.min(POLL_INTERVAL_MS, left));
  }
}

/** Test helper: forget the cached detection result. */
export function resetCache(): void {
  internals.cache = UNSET;
}

/** Parse an OSC 11 reply into `[r, g, b]`, each in the range 0..1. */
export function parseOsc11(reply: Buffer): [number, number, number] | null {
  const text = reply.toString("latin1");
  const rgb = RGB.exec(text);
  if (rgb) {
    const channels = rgb.slice(1, 4).map((h) => Number.parseInt(h, 16) / (16 ** h.length - 1));
    return channels as [number, number, number];
  }
  const hex = HEX.exec(text);
  if (hex) {
    const h = hex[1]!;
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  }
  return null;
}

/** Light or dark from an OSC 11 reply, or null if the reply is not parseable. */
export function classify(reply: Buffer): Appearance | null {
  const rgb = parseOsc11(reply);
  if (rgb === null) return null;
  const [r, g, b] = rgb;
  // BT.709 weights on gamma-encoded channels: an approximate brightness.
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.5 ? "light" : "dark";
}

/**
 * Send OSC 11 and DA1, then read through the DA1 reply. Return null on a failure.
 *
 * Terminals reply in order, so the DA1 reply comes after an OSC 11 reply.
 * Without it, a slow color reply can arrive as shell input after the tty restore.
 * `TERM=dumb`, the Linux console, tmux and screen do not support the query, so the function does not send it there.
 */
export function queryTerminalBackground(): Buffer | null {
  if (process.platform === "win32") return null;
  if (process.env.TERM === "dumb" || process.env.TERM === "linux") return null;
  if (process.env.TMUX || process.env.STY) return null;
  try {
    if (!(internals.stdinIsatty() && internals.stdoutIsatty())) return null;
  } catch {
    return null;
  }
  let fd: number;
  let old: unknown;
  try {
    fd = internals.stdinFileno();
  } catch {
    return null;
  }
  try {
    old = internals.tcgetattr(fd);
  } catch {
    closeQuietly(fd);
    return null;
  }
  try {
    internals.setcbreak(fd);
    internals.writeStdout(Buffer.concat([QUERY, DA1_QUERY]).toString("latin1"));
    const deadline = internals.monotonic() + TIMEOUT_S;
    let buf = Buffer.alloc(0);
    while (internals.monotonic() < deadline && buf.length < MAX_REPLY) {
      const remaining = deadline - internals.monotonic();
      if (!internals.select(fd, Math.max(0, remaining))) break;
      const chunk = internals.read(fd, 32);
      if (chunk.length === 0) break;
      buf = Buffer.concat([buf, chunk]);
      // Do not stop at the OSC reply. Only the DA1 reply proves that no reply bytes are still in transit.
      if (DA1_REPLY.test(buf.toString("latin1"))) break;
    }
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    try {
      internals.tcsetattr(fd, old);
    } catch {
      // The terminal mode stays as it is. Nothing more can be done.
    }
    closeQuietly(fd);
  }
}

function closeQuietly(fd: number): void {
  try {
    internals.closeFileno(fd);
  } catch {
    // The descriptor is already closed.
  }
}

/**
 * Light or dark from the terminal background, or null if the detection fails.
 * The result is cached per process. Call it first in cooked mode, before the TUI starts.
 */
export function detectTerminalBackground(): Appearance | null {
  if (internals.cache === UNSET) {
    const reply = internals.queryTerminalBackground();
    internals.cache = reply !== null ? classify(reply) : null;
  }
  return internals.cache;
}

export type Detect = () => string | null | undefined;

/**
 * Resolve a `ui.theme` setting to `light` or `dark`.
 * `dark` and `light` pass through without a query. `auto` follows `detect()`, with `dark` as the fallback.
 */
export function resolveTheme(setting: string, detect: Detect = detectTerminalBackground): string {
  if (setting === "dark" || setting === "light") return setting;
  return detect() || "dark";
}

/**
 * Whether the CLI must query the terminal background before dispatch.
 * False if colors are off, if the first token is `run`, or if `--json` is present.
 */
export function cliShouldProbe(argv: string[], { colorsEnabled }: { colorsEnabled: boolean }): boolean {
  if (!colorsEnabled) return false;
  if (argv.length > 0 && argv[0] === "run") return false;
  if (argv.includes("--json")) return false;
  return true;
}

/** Resolve the theme of a plain CLI command. If colors are off, `auto` becomes `dark` without a query. */
export function cliTheme(setting: string, { detect = detectTerminalBackground, colors }: { detect?: Detect; colors: boolean }): string {
  if (setting === "auto" && !colors) return "dark";
  return resolveTheme(setting, detect);
}

/**
 * Discard pending terminal input, for example a late OSC reply, before the TUI starts.
 * A reply that arrives after this call can still reach the TUI as keystrokes.
 */
export function drainStdin(): void {
  if (process.platform === "win32") return;
  try {
    if (!internals.stdinIsatty()) return;
  } catch {
    return;
  }
  try {
    internals.tcflush();
  } catch {
    // Best effort only.
  }
}
