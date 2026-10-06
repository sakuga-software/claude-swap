/**
 * `cswap menubar`: start the native macOS menu bar app (`menubar/`, Swift).
 *
 * The app reads its data by running `cswap ... --json` commands. This module
 * finds the app bundle and gives it the path of this `cswap` and of the backup root.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSwitchError } from "./exceptions.js";
import * as launchAgent from "./launch_agent.js";
import { dimmed } from "./printer.js";

export const APP_NAME = "CswapMenuBar.app";
export const APP_ENV = "CSWAP_MENUBAR_APP";
const EXECUTABLE = path.join("Contents", "MacOS", "CswapMenuBar");

/** The replaceable parts of this module. Tests change these properties. */
export const internals = {
  platform: (): string => process.platform,
  /** The package root: `dist/..` in a build, `src/..` under tsx. */
  packageRoot: (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  execPath: (): string => process.execPath,
  /** The path of the running script, as the user started it. */
  argv1: (): string | undefined => process.argv[1],
  resolveProgram: (): string[] => launchAgent.resolveProgram(),
  cliEntry: (): string => launchAgent.internals.cliEntry(),
  spawn,
  spawnSync,
};

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The places to look for the app bundle, in order. */
export function appCandidates(): string[] {
  const fromEnv = process.env[APP_ENV];
  if (fromEnv) return [fromEnv];
  const root = internals.packageRoot();
  return [
    path.join(root, "menubar", APP_NAME),
    // A source checkout: `menubar/scripts/bundle.sh` writes the bundle here.
    path.join(root, "..", "menubar", "build", APP_NAME),
    path.join(os.homedir(), "Applications", APP_NAME),
    path.join("/Applications", APP_NAME),
  ];
}

/** The first app bundle that has an executable binary, or null. */
export function findApp(): string | null {
  for (const candidate of appCandidates()) {
    if (isExecutable(path.join(candidate, EXECUTABLE))) return path.resolve(candidate);
  }
  return null;
}

function notFoundMessage(): string {
  const searched = appCandidates()
    .map((c) => `  ${c}`)
    .join("\n");
  return (
    "The menu bar app (CswapMenuBar.app) was not found. Searched:\n" +
    `${searched}\n` +
    "Build it from a claude-swap checkout with `menubar/scripts/bundle.sh`, then copy " +
    "menubar/build/CswapMenuBar.app to ~/Applications, or set CSWAP_MENUBAR_APP to its path."
  );
}

/**
 * The executable that the app runs for each `cswap` command. The app starts
 * it directly, so the file must be executable.
 */
export function cswapExecutable(): string {
  // The running entry comes first: a `which cswap` can find another install, for example the Python one.
  const running = internals.argv1();
  if (running && isExecutable(path.resolve(running))) return path.resolve(running);
  const program = internals.resolveProgram();
  if (program.length === 1) return program[0]!;
  const entry = internals.cliEntry();
  if (!isExecutable(entry)) {
    try {
      fs.chmodSync(entry, 0o755);
    } catch {
      // The check below reports the problem.
    }
  }
  if (!isExecutable(entry)) {
    throw new ClaudeSwitchError(`${entry} is not executable. Run \`pnpm build\` or install the cswap package.`);
  }
  return entry;
}

/**
 * Start the menu bar app for `switcher`. Returns the exit status.
 *
 * From a terminal, the app runs detached and this function returns at once.
 * Under the LaunchAgent, the function waits for the app, so launchd can
 * restart it after a crash.
 */
export function run(switcher: { backupDir: string }): number {
  if (internals.platform() !== "darwin") {
    throw new ClaudeSwitchError("The menu bar is only available on macOS.");
  }
  const app = findApp();
  if (app === null) throw new ClaudeSwitchError(notFoundMessage());

  const binary = path.join(app, EXECUTABLE);
  const args = ["--cswap", cswapExecutable(), "--backup-dir", switcher.backupDir];
  // The `cswap` script starts with `#!/usr/bin/env node`, so this `node` must be on PATH.
  const pathDirs = [path.dirname(internals.execPath()), ...(process.env.PATH ?? "").split(path.delimiter)].filter(Boolean);
  const env = { ...process.env, PATH: [...new Set(pathDirs)].join(path.delimiter) };

  if (process.env.XPC_SERVICE_NAME === launchAgent.LABEL) {
    const result = internals.spawnSync(binary, args, { env, stdio: "inherit" });
    if (result.error) throw new ClaudeSwitchError(`Could not start ${binary}: ${result.error.message}`);
    return result.status ?? 1;
  }

  const child = internals.spawn(binary, args, { env, detached: true, stdio: "ignore" });
  child.on("error", (e) => {
    process.stderr.write(`Could not start ${binary}: ${e.message}\n`);
  });
  child.unref();
  process.stdout.write(`${dimmed(`Menu bar started (${app}).`)}\n`);
  return 0;
}
