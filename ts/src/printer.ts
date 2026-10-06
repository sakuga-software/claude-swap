import os from "node:os";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

type PaletteKey = "accent" | "muted" | "red" | "yellow";

const PALETTES: Record<string, Record<PaletteKey, string>> = {
  dark: {
    accent: "\x1b[38;5;173m",
    muted: "\x1b[38;5;250m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
  },
  light: {
    accent: "\x1b[38;2;149;76;42m",
    muted: "\x1b[38;2;99;93;85m",
    red: "\x1b[38;2;173;49;40m",
    yellow: "\x1b[38;2;121;89;17m",
  },
};

/** A stream that `warning()` can write to. */
export interface TextSink {
  write(text: string): unknown;
}

/** Mutable module state and seams. Tests change these properties. */
export const internals = {
  /** The cached result of `detectColorSupport()`. `null` means "not detected yet". */
  colorsEnabled: null as boolean | null,
  theme: "dark",
  stdoutIsatty: (): boolean => process.stdout.isTTY === true,
};

/** Select the CLI color palette. Unknown names fall back to dark. */
export function setTheme(name: string): void {
  internals.theme = Object.hasOwn(PALETTES, name) ? name : "dark";
}

function pal(key: PaletteKey): string {
  return PALETTES[internals.theme]![key];
}

/**
 * Node writes UTF-8 to stdout and stderr by default.
 * This function only sets the default string encoding where a stream supports it.
 */
export function forceUtf8Output(): void {
  for (const stream of [process.stdout, process.stderr]) {
    try {
      stream.setDefaultEncoding?.("utf8");
    } catch {
      // A replaced stream can reject the call. The output still works.
    }
  }
}

/** Detect whether the terminal supports ANSI colors. */
export function detectColorSupport(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  if (!internals.stdoutIsatty()) return false;
  // Node enables VT processing on the Windows console itself.
  if (process.platform === "win32") return true;
  if ((process.env.TERM ?? "") === "dumb") return false;
  return true;
}

/** Return whether color output is active. The first call caches the result. */
export function colorsEnabled(): boolean {
  if (internals.colorsEnabled === null) internals.colorsEnabled = detectColorSupport();
  return internals.colorsEnabled;
}

/**
 * Run `fn` with colored output forced on, then restore the prior cache.
 * If `fn` returns a promise, the restore occurs after the promise settles.
 */
export function forceColor<T>(fn: () => T): T {
  const saved = internals.colorsEnabled;
  internals.colorsEnabled = true;
  let result: T;
  try {
    result = fn();
  } catch (err) {
    internals.colorsEnabled = saved;
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(() => {
      internals.colorsEnabled = saved;
    }) as T;
  }
  internals.colorsEnabled = saved;
  return result;
}

function style(text: string, ...codes: string[]): string {
  if (!colorsEnabled()) return text;
  return `${codes.join("")}${text}${RESET}`;
}

/** Warm accent color for important elements. */
export function accent(text: string): string {
  return style(text, pal("accent"));
}

/** Slightly dimmer than normal text, for usage stats and org tags. */
export function muted(text: string): string {
  return style(text, pal("muted"));
}

/** Dim text for tertiary info, for example tree connectors and hints. */
export function dimmed(text: string): string {
  return style(text, DIM);
}

/** Bold text with no color, for structure. */
export function bolded(text: string): string {
  return style(text, BOLD);
}

/** Bold accent text for key markers, for example `(active)`. */
export function boldAccent(text: string): string {
  return style(text, BOLD, pal("accent"));
}

/** Yellow text for warnings. `warning()` prints, this function returns the string. */
export function yellowed(text: string): string {
  return style(text, pal("yellow"));
}

/** Print an error message in red to stderr. */
export function error(msg: string): void {
  process.stderr.write(`${style(msg, pal("red"))}\n`);
}

/**
 * Print a warning message in yellow to stdout, or to `file`.
 * A long-running process must send its warnings to stderr, because stderr stays line-buffered.
 */
export function warning(msg: string, { file }: { file?: TextSink } = {}): void {
  (file ?? process.stdout).write(`${style(msg, pal("yellow"))}\n`);
}

const ENTRYPOINT_LABELS: Record<string, string> = {
  cli: "CLI",
  "claude-vscode": "VS Code",
  "claude-desktop": "Desktop",
  "sdk-cli": "SDK",
  "sdk-ts": "SDK",
  "sdk-py": "SDK",
  mcp: "MCP",
  "local-agent": "Agent",
  remote: "Remote",
};

const IDE_SHORT_NAMES: Record<string, string> = {
  "Visual Studio Code": "VS Code",
};

/** Return a human-readable label for a Claude Code entrypoint. */
export function entrypointLabel(entrypoint: string): string {
  return Object.hasOwn(ENTRYPOINT_LABELS, entrypoint) ? ENTRYPOINT_LABELS[entrypoint]! : entrypoint;
}

/** Return a short display name for an IDE. */
export function ideShortName(ideName: string): string {
  return Object.hasOwn(IDE_SHORT_NAMES, ideName) ? IDE_SHORT_NAMES[ideName]! : ideName;
}

/** Replace the home directory prefix of `path` with `~`. */
export function abbreviatePath(path: string): string {
  const home = os.homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

/** Format a millisecond epoch timestamp as a human-readable age. */
export function formatAge(startedAtMs: number): string {
  const elapsed = Math.floor(Date.now() / 1000) - Math.floor(startedAtMs / 1000);
  if (elapsed < 60) return "just now";
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
  return `${Math.floor(elapsed / 86400)}d ago`;
}
