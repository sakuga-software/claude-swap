/**
 * Run `cswap menubar` as a launchd LaunchAgent instead of a foreground process.
 *
 * The plist pins the `cswap` bin path, not the Node entry script: the bin path
 * stays the same across upgrades. Logs go to `~/Library/Logs`, not `/tmp`.
 * Everything here is macOS-only.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSwitchError } from "./exceptions.js";
import { sleepSync } from "./support/sleep.js";

export const LABEL = "com.cswap.menubar";

// The default launchd PATH does not find a Homebrew or ~/.local/bin `claude`.
const EXTRA_PATH_DIRS = ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"];
const BASE_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

// `launchctl bootout` can return before launchd removes the job, and a
// `bootstrap` in that window fails with "Operation already in progress".
const UNLOAD_TIMEOUT_SECONDS = 5.0;
const UNLOAD_POLL_SECONDS = 0.1;

/** The result of one `launchctl` call. */
export interface LaunchctlResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

export interface ServiceStatus {
  label: string;
  installed: boolean;
  loaded: boolean;
  state: string | null;
  pid: number | null;
  plist: string;
}

export interface InstallResult {
  label: string;
  plist: string;
  program: string[];
  stdout_log: string;
  stderr_log: string;
}

export interface UninstallResult {
  label: string;
  was_loaded: boolean;
  removed_plist: boolean;
}

type SpawnSyncFn = (file: string, args: string[], options: { encoding: "utf8" }) => SpawnSyncReturns<string>;

/** The replaceable parts of this module. Tests change these properties. */
export const internals = {
  platform: process.platform as string,
  spawnSync: spawnSync as SpawnSyncFn,
  sleepSync,
  /** The path of the running script, as the user started it. */
  argv1: (): string | undefined => process.argv[1],
  which: whichOnPath,
  execPath: (): string => process.execPath,
  /** The package entry that `node` runs if no `cswap` bin exists. */
  cliEntry: (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js"),
  waitUntilUnloaded: (label: string = LABEL, uid?: number, timeout: number = UNLOAD_TIMEOUT_SECONDS): boolean =>
    waitUntilUnloaded(label, uid, timeout),
};

function requireMacos(): void {
  if (internals.platform !== "darwin") {
    throw new ClaudeSwitchError("The menu bar service is only available on macOS.");
  }
}

function currentUid(): number {
  return process.getuid?.() ?? 0;
}

/** Absolute path of the LaunchAgent plist for `label`. */
export function plistPath(label: string = LABEL, home?: string): string {
  return path.join(home ?? os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

/** `[stdout, stderr]` log destinations for `label`. */
export function logPaths(label: string = LABEL, home?: string): [string, string] {
  const logs = path.join(home ?? os.homedir(), "Library", "Logs");
  return [path.join(logs, `${label}.log`), path.join(logs, `${label}.err`)];
}

/** launchd service target, for example `gui/501/com.cswap.menubar`. */
export function serviceTarget(label: string = LABEL, uid?: number): string {
  return `gui/${uid ?? currentUid()}/${label}`;
}

/** launchd domain target, for example `gui/501`. */
export function domainTarget(uid?: number): string {
  return `gui/${uid ?? currentUid()}`;
}

function isFile(p: string): boolean {
  return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
}

function whichOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (isFile(candidate)) return candidate;
    } catch {
      // Not executable here. Try the next directory.
    }
  }
  return null;
}

/**
 * The argv prefix that launchd runs, without the subcommand.
 *
 * The path becomes absolute, but the function does not resolve symlinks.
 * A global npm or pnpm install puts a `cswap` symlink in a bin directory, and
 * the symlink keeps its path across upgrades. The target can move.
 */
export function resolveProgram(): string[] {
  const candidate = internals.argv1();
  if (candidate) {
    const absolute = path.resolve(candidate);
    if (path.basename(absolute) === "cswap" && isFile(absolute)) return [absolute];
  }

  const which = internals.which("cswap");
  if (which) return [path.resolve(which)];

  return [internals.execPath(), internals.cliEntry()];
}

function expandUser(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** PATH for the agent. The program directory comes first, then the directory of `node`. */
function pathEnv(program: string[]): string {
  const dirs: string[] = [];
  const add = (dir: string) => {
    if (dir !== "" && dir !== "." && !dirs.includes(dir)) dirs.push(dir);
  };
  add(path.dirname(program[0] ?? ""));
  // The `cswap` bin starts with `#!/usr/bin/env node`. A Node from nvm, fnm or volta is in none of the other directories.
  // Use the `node` on PATH first. An upgrade can remove the versioned directory of `execPath`.
  add(path.dirname(internals.which("node") ?? internals.execPath()));
  for (const extra of [...EXTRA_PATH_DIRS, ...BASE_PATH_DIRS]) add(expandUser(extra));
  return dirs.join(":");
}

type PlistValue = string | boolean | number | PlistValue[] | { [key: string]: PlistValue };

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plistLines(value: PlistValue, depth: number): string[] {
  const indent = "\t".repeat(depth);
  if (typeof value === "string") return [`${indent}<string>${escapeXml(value)}</string>`];
  if (typeof value === "boolean") return [`${indent}<${value}/>`];
  if (typeof value === "number") return [`${indent}<integer>${Math.trunc(value)}</integer>`];
  if (Array.isArray(value)) {
    return [`${indent}<array>`, ...value.flatMap((item) => plistLines(item, depth + 1)), `${indent}</array>`];
  }
  const lines = [`${indent}<dict>`];
  for (const key of Object.keys(value).sort()) {
    lines.push(`${indent}\t<key>${escapeXml(key)}</key>`, ...plistLines(value[key] as PlistValue, depth + 1));
  }
  lines.push(`${indent}</dict>`);
  return lines;
}

/** Serialize the LaunchAgent plist in the `plistlib.dumps` XML format. Paths with `&` or `<` stay valid. */
export function buildPlist(program?: string[], label: string = LABEL, home?: string): string {
  const prog = program && program.length > 0 ? program : resolveProgram();
  const [outLog, errLog] = logPaths(label, home);
  const body: PlistValue = {
    Label: label,
    ProgramArguments: [...prog, "menubar"],
    RunAtLoad: true,
    // Restart a crash, but obey a Quit: the Quit item exits with status 0.
    KeepAlive: { SuccessfulExit: false },
    // launchd throttles the I/O and CPU of a Background process. A menu bar process owns UI.
    ProcessType: "Interactive",
    EnvironmentVariables: { PATH: pathEnv(prog) },
    StandardOutPath: outLog,
    StandardErrorPath: errLog,
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    ...plistLines(body, 0),
    "</plist>",
    "",
  ].join("\n");
}

function launchctl(...args: string[]): LaunchctlResult {
  const result = internals.spawnSync("launchctl", args, { encoding: "utf8" });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ClaudeSwitchError("launchctl not found; is this macOS?", { cause: result.error });
    }
    throw result.error;
  }
  return { returncode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Wait until launchd removes the job. Returns `true` if the job went away before the timeout. */
export function waitUntilUnloaded(label: string = LABEL, uid?: number, timeout: number = UNLOAD_TIMEOUT_SECONDS): boolean {
  const deadline = performance.now() + timeout * 1000;
  while (isLoaded(label, uid)) {
    if (performance.now() >= deadline) return false;
    internals.sleepSync(UNLOAD_POLL_SECONDS * 1000);
  }
  return true;
}

/** Whether launchd knows the service now. */
export function isLoaded(label: string = LABEL, uid?: number): boolean {
  return launchctl("print", serviceTarget(label, uid)).returncode === 0;
}

/** Installed, loaded and running state, and the pid if there is one. */
export function status(label: string = LABEL, uid?: number, home?: string): ServiceStatus {
  requireMacos();
  const printed = launchctl("print", serviceTarget(label, uid));
  const loaded = printed.returncode === 0;
  let state: string | null = null;
  let pid: number | null = null;
  if (loaded) {
    for (const line of printed.stdout.split(/\r?\n/)) {
      // `launchctl print` repeats keys such as `state` in nested blocks. The fields of the job have exactly one tab.
      if (!line.startsWith("\t") || line.startsWith("\t\t")) continue;
      const stripped = line.trim();
      if (state === null && stripped.startsWith("state = ")) {
        state = stripped.slice("state = ".length).trim();
      } else if (pid === null && stripped.startsWith("pid = ")) {
        const raw = stripped.slice("pid = ".length).trim();
        if (/^\d+$/.test(raw)) pid = Number(raw);
      }
    }
  }
  return {
    label,
    installed: fs.existsSync(plistPath(label, home)),
    loaded,
    state,
    pid,
    plist: plistPath(label, home),
  };
}

function failure(command: string, result: LaunchctlResult, detail: string): ClaudeSwitchError {
  return new ClaudeSwitchError(`launchctl ${command} failed (exit ${result.returncode})${detail ? `: ${detail}` : ""}`);
}

/**
 * Write the plist and give the service to launchd.
 *
 * If the service is loaded, the function boots it out first. Thus a call
 * after an upgrade reads the plist again and does not fail with EEXIST.
 */
export function install(label: string = LABEL, home?: string, program?: string[], uid?: number): InstallResult {
  requireMacos();
  const prog = program && program.length > 0 ? program : resolveProgram();
  const targetPlist = plistPath(label, home);
  const [outLog, errLog] = logPaths(label, home);

  fs.mkdirSync(path.dirname(targetPlist), { recursive: true });
  fs.mkdirSync(path.dirname(outLog), { recursive: true });
  fs.writeFileSync(targetPlist, buildPlist(prog, label, home));

  let settled = true;
  if (isLoaded(label, uid)) {
    launchctl("bootout", serviceTarget(label, uid));
    settled = internals.waitUntilUnloaded(label, uid);
  }

  const booted = launchctl("bootstrap", domainTarget(uid), targetPlist);
  if (booted.returncode !== 0) {
    let detail = (booted.stderr || booted.stdout || "").trim();
    if (!settled) detail = `${detail}; the previous instance was still shutting down`.replace(/^; /, "");
    throw failure("bootstrap", booted, detail);
  }

  return {
    label,
    plist: targetPlist,
    program: [...prog, "menubar"],
    stdout_log: outLog,
    stderr_log: errLog,
  };
}

/** Stop the service and delete its plist. Every partial state is accepted. */
export function uninstall(label: string = LABEL, home?: string, uid?: number): UninstallResult {
  requireMacos();
  const targetPlist = plistPath(label, home);
  const wasLoaded = isLoaded(label, uid);
  if (wasLoaded) {
    const bootedOut = launchctl("bootout", serviceTarget(label, uid));
    if (bootedOut.returncode !== 0 && isLoaded(label, uid)) {
      throw failure("bootout", bootedOut, (bootedOut.stderr || bootedOut.stdout || "").trim());
    }
  }

  const existed = fs.existsSync(targetPlist);
  if (existed) fs.unlinkSync(targetPlist);

  return { label, was_loaded: wasLoaded, removed_plist: existed };
}
