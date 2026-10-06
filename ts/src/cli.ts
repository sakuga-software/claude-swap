/** Command-line interface for Claude Swap. */

import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import tty from "node:tty";
import { cliShouldProbe, cliTheme } from "./appearance.js";
import { AutoSwitchEngine, type AutoSwitchEvent } from "./autoswitch.js";
import { ClaudeSwitchError } from "./exceptions.js";
import { errorEnvelope } from "./json_output.js";
import * as launchAgent from "./launch_agent.js";
import { MappingStore, normalizePath } from "./mappings.js";
import * as menubar from "./menubar.js";
import { getBackupRoot } from "./paths.js";
import {
  accent,
  bolded,
  colorsEnabled,
  dimmed,
  error,
  forceUtf8Output,
  muted,
  setTheme,
  warning,
  yellowed,
} from "./printer.js";
import { SessionManager } from "./session.js";
import {
  SETTING_SPECS,
  effectiveSettings,
  formatSettingValue,
  loadSettings,
  loadUiSettings,
  mergedWithCli,
  parseModelNames,
  setSetting,
  settingSpec,
  settingsPath,
  unsetSetting,
} from "./settings.js";
import { ArgumentParser, type Namespace, SUPPRESS } from "./support/argparse.js";
import { KeyboardInterrupt, SystemExit } from "./support/exit.js";
import { ljust, pyFixed } from "./support/pyformat.js";
import { jsonDumps } from "./support/py.js";
import { ClaudeAccountSwitcher, type JsonObject } from "./switcher.js";
import { exportAccounts, importAccounts, importUsage } from "./transfer.js";
import { checkForUpdate, runSelfUpgrade } from "./update_check.js";
import { VERSION } from "./version.js";

export { KeyboardInterrupt, SystemExit };

type TuiStart = "dashboard" | "watch";
type TuiRun = (switcher: ClaudeAccountSwitcher, start?: TuiStart) => Promise<number>;

/** The replaceable parts of this module. Tests change these properties. */
export const internals = {
  ClaudeAccountSwitcher,
  SessionManager,
  AutoSwitchEngine,
  loadSettings,
  exportAccounts,
  importAccounts,
  importUsage,
  checkForUpdate,
  runSelfUpgrade,
  launchAgent: {
    install: () => launchAgent.install(),
    uninstall: () => launchAgent.uninstall(),
    status: () => launchAgent.status(),
  },
  menubarRun: (switcher: ClaudeAccountSwitcher): number => menubar.run(switcher),
  loadTui: async (): Promise<TuiRun> => (await import("./tui/index.js")).run as TuiRun,
  platform: (): string => process.platform,
  geteuid: (): number => process.geteuid?.() ?? -1,
  stdinIsatty: (): boolean => tty.isatty(0),
  stdoutIsatty: (): boolean => tty.isatty(1),
  cwd: (): string => process.cwd(),
  progName,
  useNativeTls,
  /** Python `sys.exit`. It always throws; the entry point sets the exit status. */
  exit: (code = 0): never => {
    throw new SystemExit(code);
  },
  runCommand: (argv: string[]) => runCommand(argv),
  autoCommand: (argv: string[]) => autoCommand(argv),
  configCommand: (argv: string[]) => configCommand(argv),
  mapCommand: (argv: string[]) => mapCommand(argv),
  unmapCommand: (argv: string[]) => unmapCommand(argv),
  unclaimedCommand: (argv: string[]) => unclaimedCommand(argv),
  aliasCommand: (argv: string[]) => aliasCommand(argv),
  swapCommand: (argv: string[]) => swapCommand(argv),
  moveCommand: (argv: string[]) => moveCommand(argv),
};

function print(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function printErr(text = ""): void {
  process.stderr.write(`${text}\n`);
}

function exit(code = 0): never {
  return internals.exit(code);
}

/**
 * The command name for usage and help. Node gives the script path, for
 * example `.../bin/cswap` or `.../dist/cli.js`. A script file name falls back to `cswap`.
 */
export function progName(): string {
  let name = path.basename(process.argv[1] ?? "");
  for (const ext of [".exe", ".cmd", ".js", ".mjs", ".cjs", ".ts", ".tsx"]) {
    if (name.toLowerCase().endsWith(ext)) {
      name = name.slice(0, -ext.length);
      break;
    }
  }
  if (!name || ["cli", "main", "index", "node"].includes(name)) return "cswap";
  return name;
}

/**
 * Memorable subcommands and the long-standing flags that they expand to.
 * `switch` has its own rule, and `run`/`auto`/`config`/... have their own parsers.
 */
const SUBCOMMAND_FLAGS: Readonly<Record<string, string>> = {
  help: "--help",
  list: "--list",
  ls: "--list",
  status: "--status",
  add: "--add-account",
  "add-token": "--add-token",
  remove: "--remove-account",
  rm: "--remove-account",
  disable: "--disable-account",
  enable: "--enable-account",
  export: "--export",
  import: "--import",
  "import-usage": "--import-usage",
  purge: "--purge",
  upgrade: "--upgrade",
  update: "--upgrade",
  tui: "--tui",
  watch: "--watch",
  menubar: "--menubar",
};

/**
 * Rewrite a leading memorable subcommand into the equivalent flag argv.
 * Only a recognized first token changes. The tokens after it pass through unchanged.
 */
export function translateSubcommand(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  const [verb, ...rest] = argv as [string, ...string[]];
  if (verb === "switch") {
    // Bare `switch` rotates; `switch <num|email>` jumps to that account.
    if (rest.length > 0 && !rest[0]!.startsWith("-")) return ["--switch-to", ...rest];
    return ["--switch", ...rest];
  }
  const flag = Object.hasOwn(SUBCOMMAND_FLAGS, verb) ? SUBCOMMAND_FLAGS[verb] : undefined;
  if (flag !== undefined) return [flag, ...rest];
  return argv;
}

function isInterrupt(e: unknown): boolean {
  return e instanceof KeyboardInterrupt || (e as NodeJS.ErrnoException | null)?.code === "EINTR";
}

/** The shared error handling of the pre-dispatched commands. */
function handleCommandError(e: unknown): never {
  if (e instanceof ClaudeSwitchError) {
    error(`Error: ${e.message}`);
    exit(1);
  }
  if (isInterrupt(e)) {
    print(`\n${dimmed("Operation cancelled")}`);
    exit(130);
  }
  throw e;
}

function newSwitcher(debug: boolean): ClaudeAccountSwitcher {
  return new internals.ClaudeAccountSwitcher(debug);
}

/** Refuse to run as root outside a container. POSIX only. */
function guardRoot(switcher: ClaudeAccountSwitcher): void {
  if (internals.platform() !== "win32") {
    if (internals.geteuid() === 0 && !switcher.isRunningInContainer()) {
      error("Error: Do not run this script as root (unless running in a container)");
      exit(1);
    }
  }
}

/**
 * `cswap run NUM|EMAIL [--no-share] [-- <claude args>]`.
 *
 * `run` must be the first argument. On POSIX the command execs claude and never returns.
 */
export async function runCommand(argv: string[]): Promise<void> {
  const split = argv.indexOf("--");
  const head = split >= 0 ? argv.slice(0, split) : argv;
  const tail = split >= 0 ? argv.slice(split + 1) : [];

  const parser = new ArgumentParser({
    prog: `${internals.progName()} run`,
    description:
      "[EXPERIMENTAL] Launch Claude Code as a stored account in this " +
      "terminal only (the default login and other terminals are " +
      "unaffected).",
    rawDescription: true,
    epilog: `
Examples:
  cswap run 2
  cswap run user@example.com
  cswap run 2 --no-share
  cswap run 2 --share-history
  cswap run 2 --require-session
  cswap run 2 -- --resume
        `,
  });
  parser.addArgument("account", {
    nargs: "?",
    metavar: "NUM|EMAIL",
    help: "Account to run (number or email). Omit to use the current directory's mapping (see `cswap map`).",
  });
  parser.addArgument("--no-share", {
    action: "store_true",
    help:
      "Don't share settings/keybindings/CLAUDE.md/skills/commands/agents " +
      "from ~/.claude into the session profile (and remove previously " +
      "shared items)",
  });
  parser.addArgument("--share-history", {
    action: "boolean_optional",
    default: false,
    help:
      "Share conversation history (projects/ and history.jsonl) from " +
      "~/.claude into the session profile, so every account sees one " +
      "unified history. History the profile already accumulated is " +
      "merged into ~/.claude first. --no-share-history restores " +
      "per-account history (the default). Not supported on Windows.",
  });
  parser.addArgument("--require-session", {
    action: "store_true",
    help:
      "Refuse to launch when the account is already the active default " +
      "login, instead of running plain claude on that login (which a " +
      "later switch could pull out from under the session)",
  });
  parser.addArgument("--debug", { action: "store_true", help: "Enable debug logging" });
  const args = parser.parseArgs<{
    account: string | null;
    noShare: boolean;
    shareHistory: boolean;
    requireSession: boolean;
    debug: boolean;
  }>(head);

  try {
    const switcher = newSwitcher(args.debug);
    guardRoot(switcher);
    const manager = new internals.SessionManager(switcher);

    if (args.account !== null) {
      await manager.run(args.account, tail, !args.noShare, args.shareHistory, args.requireSession);
      return;
    }

    // No account given: use the mapping of the current directory.
    const [slot, email] = switcher.slotForDirectory(internals.cwd());
    if (slot !== null) {
      await manager.run(slot, tail, !args.noShare, args.shareHistory, args.requireSession);
      return;
    }
    if (email !== null) {
      warning(`Mapped account ${email} no longer exists — launching the default account.`);
    } else {
      print(dimmed(`No account mapped for ${internals.cwd()} — launching the default account.`));
    }
    manager.execDefault(tail);
  } catch (e) {
    handleCommandError(e);
  }
}

/** `cswap map [NUM|EMAIL] [PATH]`. Without NUM|EMAIL, list all mappings. */
export function mapCommand(argv: string[]): void {
  const parser = new ArgumentParser({
    prog: "cswap map",
    description:
      "Map a stored account to a directory so `cswap run` (with no " +
      "account) auto-launches it there. With no arguments, lists all " +
      "mappings.",
    rawDescription: true,
    epilog: `
Examples:
  cswap map 2 ~/work/client-app
  cswap map user@example.com          # map the current directory
  cswap map                           # list all mappings
        `,
  });
  parser.addArgument("account", {
    nargs: "?",
    metavar: "NUM|EMAIL",
    help: "Account to map (number or email). Omit to list mappings.",
  });
  parser.addArgument("path", { nargs: "?", metavar: "PATH", help: "Directory to map (default: current directory)" });
  parser.addArgument("--debug", { action: "store_true", help: "Enable debug logging" });
  const args = parser.parseArgs<{ account: string | null; path: string | null; debug: boolean }>(argv);

  try {
    const switcher = newSwitcher(args.debug);
    guardRoot(switcher);

    if (args.account === null) {
      switcher.listMappings();
      return;
    }

    const store = new MappingStore(switcher.backupDir);
    const [accountNum, email, orgUuid] = switcher.resolveAccount(args.account);
    const target = args.path || internals.cwd();
    if (!isDirectory(target)) {
      warning(`Warning: ${target} is not an existing directory (mapping it anyway)`);
    }
    const previous = store.get(target);
    store.set(target, email, orgUuid);

    const shown = normalizePath(target);
    if (previous && previous.email !== email) {
      print(`${accent("Mapped")} ${shown} → Account-${accountNum} (${email}) ${muted(`(was ${previous.email})`)}`);
    } else {
      print(`${accent("Mapped")} ${shown} → Account-${accountNum} (${email})`);
    }
  } catch (e) {
    handleCommandError(e);
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/** `cswap unmap [PATH]`: remove a directory → account mapping. */
export function unmapCommand(argv: string[]): void {
  const parser = new ArgumentParser({
    prog: "cswap unmap",
    description: "Remove a directory → account mapping (default: current directory).",
  });
  parser.addArgument("path", { nargs: "?", metavar: "PATH", help: "Directory to unmap (default: current directory)" });
  parser.addArgument("--debug", { action: "store_true", help: "Enable debug logging" });
  const args = parser.parseArgs<{ path: string | null; debug: boolean }>(argv);

  try {
    const switcher = newSwitcher(args.debug);
    guardRoot(switcher);
    const store = new MappingStore(switcher.backupDir);
    const target = args.path || internals.cwd();
    const shown = normalizePath(target);
    if (store.remove(target)) {
      print(`${accent("Unmapped")} ${shown}`);
    } else {
      print(dimmed(`No mapping for ${shown}`));
    }
  } catch (e) {
    handleCommandError(e);
  }
}

/**
 * `cswap unclaimed [--purge ID]`: list the stash rows, or drop one.
 *
 * Two stash states need a person: bytes that stay unreadable until a
 * keychain unlocks, and a row without metadata, which no pass can adopt.
 */
export function unclaimedCommand(argv: string[]): void {
  const parser = new ArgumentParser({
    prog: `${internals.progName()} unclaimed`,
    description:
      "List stashed credential entries, or purge one by id. " +
      "Purging deletes the bytes — recovery is /login + `cswap add`.",
  });
  parser.addArgument("--purge", { metavar: "ID", help: "Delete this entry's bytes and manifest row" });
  parser.addArgument("--debug", { action: "store_true", help: "Enable debug logging" });
  const args = parser.parseArgs<{ purge: string | null; debug: boolean }>(argv);

  try {
    const switcher = newSwitcher(args.debug);
    guardRoot(switcher);
    const entries = switcher.listUnclaimedCredentials();

    if (args.purge) {
      if (!Object.hasOwn(entries, args.purge)) {
        error(`Error: no unclaimed entry ${args.purge}`);
        exit(1);
      }
      switcher.store.removeUnclaimedCredential(args.purge);
      print(`${accent("Purged")} ${args.purge}`);
      return;
    }

    const ids = Object.keys(entries).sort();
    if (ids.length === 0) {
      print(dimmed("No unclaimed credential entries"));
      return;
    }
    for (const entryId of ids) {
      const meta = entries[entryId]!;
      const slot = (meta.configSlot as string | undefined) || "?";
      const reason = (meta.reason as string | undefined) || "orphaned (no manifest row)";
      print(`${entryId}  slot ${slot}  ${reason}`);
    }
  } catch (e) {
    handleCommandError(e);
  }
}

function accountEmail(switcher: ClaudeAccountSwitcher, num: string): string {
  const accounts = switcher.getSequenceData()?.accounts ?? {};
  return (Object.hasOwn(accounts, num) ? accounts[num]?.email : undefined) ?? "";
}

function byInt(a: string, b: string): number {
  return Number.parseInt(a, 10) - Number.parseInt(b, 10);
}

/** `cswap swap NUM|EMAIL|ALIAS NUM|EMAIL|ALIAS`: exchange the slot numbers of two accounts. */
export function swapCommand(argv: string[]): void {
  const parser = new ArgumentParser({
    prog: `${internals.progName()} swap`,
    description:
      "Exchange two accounts' slot numbers, so they trade places in " +
      "`cswap list` and as numeric targets. Aliases, backups, and " +
      "session history move with their account.",
    rawDescription: true,
    epilog: `
Examples:
  cswap swap 1 2
  cswap swap dev user@example.com
        `,
  });
  parser.addArgument("first", { metavar: "NUM|EMAIL|ALIAS", help: "One account" });
  parser.addArgument("second", { metavar: "NUM|EMAIL|ALIAS", help: "The other account" });
  parser.addArgument("--debug", { action: "store_true", help: "Enable debug logging" });
  const args = parser.parseArgs<{ first: string; second: string; debug: boolean }>(argv);

  try {
    const switcher = newSwitcher(args.debug);
    guardRoot(switcher);
    const [numA, numB] = switcher.swapAccounts(args.first, args.second);
    print(`${accent("Swapped")} Account ${numA} and Account ${numB}:`);
    for (const num of [numA, numB].sort(byInt)) print(`  ${num}: ${accountEmail(switcher, num)}`);
  } catch (e) {
    handleCommandError(e);
  }
}

/**
 * `cswap move NUM|EMAIL|ALIAS SLOT`: give an account a slot number.
 * An empty slot relocates the account. An occupied slot swaps the two accounts.
 */
export function moveCommand(argv: string[]): void {
  const parser = new ArgumentParser({
    prog: `${internals.progName()} move`,
    description:
      "Assign an account to a slot number. An empty slot relocates the " +
      "account there and frees its old slot; an occupied slot swaps the " +
      "two. Aliases, backups, and session history move with the account.",
    rawDescription: true,
    epilog: `
Examples:
  cswap move user@example.com 1   move an account onto shortcut 1
  cswap move dev 1                by alias
  cswap move 2 1                  by number (swaps if slot 1 is taken)
        `,
  });
  parser.addArgument("account", { metavar: "NUM|EMAIL|ALIAS", help: "Account to move" });
  parser.addArgument("slot", { metavar: "SLOT", help: "Destination slot number" });
  parser.addArgument("--debug", { action: "store_true", help: "Enable debug logging" });
  const args = parser.parseArgs<{ account: string; slot: string; debug: boolean }>(argv);

  try {
    const switcher = newSwitcher(args.debug);
    guardRoot(switcher);
    const [numSrc, numTarget, swapped] = switcher.moveAccount(args.account, args.slot);
    if (numSrc === numTarget) {
      print(`${dimmed("Already in")} slot ${numTarget}: ${accountEmail(switcher, numTarget)}`);
    } else if (swapped) {
      print(`${accent("Swapped")} Account ${numSrc} and Account ${numTarget}:`);
      for (const num of [numSrc, numTarget].sort(byInt)) print(`  ${num}: ${accountEmail(switcher, num)}`);
    } else {
      print(`${accent("Moved")} ${accountEmail(switcher, numTarget)} to slot ${numTarget}`);
    }
  } catch (e) {
    handleCommandError(e);
  }
}

/** `cswap alias [NUM|EMAIL] [NAME] [--unset]`. Without arguments, list all aliases. */
export function aliasCommand(argv: string[]): void {
  const parser = new ArgumentParser({
    prog: "cswap alias",
    description:
      "Set, remove, or list a short display alias for an account. " +
      "Once set, the alias can be used anywhere an account number or " +
      "email is accepted (switch, remove, run, map).",
    rawDescription: true,
    epilog: `
Examples:
  cswap alias 2 dev
  cswap alias user@example.com dev
  cswap alias 2 --unset
  cswap alias                         # list all aliases
        `,
  });
  parser.addArgument("account", {
    nargs: "?",
    metavar: "NUM|EMAIL",
    help: "Account to alias (number or email). Omit to list aliases.",
  });
  parser.addArgument("alias_name", {
    nargs: "?",
    metavar: "NAME",
    help: "Alias to set (letters, digits, ., -, _; not purely numeric).",
  });
  parser.addArgument("--unset", { action: "store_true", help: "Remove the account's alias" });
  parser.addArgument("--debug", { action: "store_true", help: "Enable debug logging" });
  const args = parser.parseArgs<{ account: string | null; aliasName: string | null; unset: boolean; debug: boolean }>(
    argv,
  );

  if (args.unset && args.aliasName) parser.error("--unset does not take a NAME argument");
  if (args.unset && args.account === null) parser.error("NUM|EMAIL is required with --unset");
  if (args.account !== null && !args.unset && !args.aliasName) {
    parser.error("NAME is required (or pass --unset to remove the alias)");
  }

  try {
    const switcher = newSwitcher(args.debug);
    guardRoot(switcher);

    if (args.account === null) {
      const rows = switcher.listAliases();
      if (rows.length === 0) {
        print(dimmed("No aliases set"));
        return;
      }
      print(bolded("Aliases:"));
      for (const [num, aliasName, email] of rows) print(`  ${num}: ${aliasName} ${muted(`(${email})`)}`);
      return;
    }

    if (args.unset) {
      const accountNum = switcher.unsetAlias(args.account);
      print(`${accent("Removed alias")} for Account ${accountNum}`);
    } else {
      const [accountNum, normalized] = switcher.setAlias(args.account, args.aliasName!);
      print(`${accent("Set alias")} '${normalized}' for Account ${accountNum}`);
    }
  } catch (e) {
    handleCommandError(e);
  }
}

function localTimeStamp(): string {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * `cswap auto [--once] [--json] [...]`: the auto-switch engine.
 *
 * The loop runs in the foreground. `--once` does one tick and exits with its
 * outcome: 0 switched, 1 error, 2 no action needed, 3 blocked.
 */
export async function autoCommand(argv: string[]): Promise<void> {
  const parser = new ArgumentParser({
    prog: "cswap auto",
    description:
      "Automatically switch accounts when the active one nears its " +
      "5h/7d rate limit. Runs a foreground polling loop; use --once " +
      "for a single tick (cron-friendly).",
    rawDescription: true,
    epilog: `
Exit codes with --once:
  0  switched to another account
  1  error (network trouble, lock contention, ...)
  2  no action needed
  3  blocked: wanted to switch but no viable target / all exhausted

Examples:
  cswap auto                       # foreground loop, switch at 90%% used
  cswap auto --threshold 80        # switch earlier
  cswap auto --model Fable         # also switch when the Fable weekly limit is hit
  cswap auto --json                # one JSON event per line (for scripts)
  cswap auto --once; echo $?       # single tick, outcome in exit code
  cswap auto --dry-run             # log decisions, never actually switch

Defaults live in settings.json in the backup root; flags override them.
        `,
  });
  parser.addArgument("--once", {
    action: "store_true",
    help: "Evaluate once, maybe switch, and exit (exit code = outcome)",
  });
  parser.addArgument("--json", {
    action: "store_true",
    help: "Emit one machine-readable JSON event per line on stdout",
  });
  parser.addArgument("--interval", {
    type: "float",
    metavar: "SECONDS",
    help: "Poll interval in loop mode (min 15; default 60)",
  });
  parser.addArgument("--threshold", {
    type: "float",
    metavar: "PCT",
    help: "Switch when the active account's binding 5h/7d window reaches this utilization (50-99.9; default 90)",
  });
  parser.addArgument("--cooldown", {
    type: "float",
    metavar: "SECONDS",
    help: "Minimum time between proactive switches (default 300)",
  });
  parser.addArgument("--model", {
    metavar: "NAMES",
    help:
      "Also switch when a per-model weekly limit is hit, not just the " +
      "account-wide 5h/7d windows. One name or a comma-separated list " +
      "(e.g. Fable, Opus, Sonnet, Haiku, or 'Fable,Opus'), or 'all' " +
      "for every per-model window an account reports",
  });
  parser.addArgument("--include-api-key-accounts", {
    action: "boolean_optional",
    help: "Allow switching onto managed API-key accounts as a last resort (they bill per token; default: excluded)",
  });
  parser.addArgument("--strategy", {
    choices: ["best", "consume-first"],
    help:
      "Target selection: 'best' (most quota left; default) or " +
      "'consume-first' (proactively use the account whose weekly window " +
      "resets soonest)",
  });
  parser.addArgument("--dry-run", {
    action: "store_true",
    help: "Evaluate and report, but never switch or write state",
  });
  parser.addArgument("--debug", { action: "store_true", help: "Enable debug logging" });
  const args = parser.parseArgs<{
    once: boolean;
    json: boolean;
    interval: number | null;
    threshold: number | null;
    cooldown: number | null;
    model: string | null;
    includeApiKeyAccounts: boolean | null;
    strategy: string | null;
    dryRun: boolean;
    debug: boolean;
  }>(argv);

  const jsonlEmit = (event: AutoSwitchEvent): void => {
    print(jsonDumps(event.toJson()));
  };
  const humanEmit = (event: AutoSwitchEvent): void => {
    let line = event.human();
    if (event.kind === "switch") line = accent(line);
    else if (event.kind === "error" || event.kind === "account-quarantined") line = yellowed(line);
    else if (event.kind === "poll" || event.kind === "no-switch" || event.kind === "sleep") line = dimmed(line);
    print(`${localTimeStamp()}  ${line}`);
  };

  const stopped = (): never => {
    const note = `\n${dimmed("Auto-switch stopped")}`;
    if (args.json) printErr(note);
    else print(note);
    exit(130);
  };

  try {
    const switcher = newSwitcher(args.debug);
    guardRoot(switcher);

    const settings = mergedWithCli(internals.loadSettings(switcher.backupDir), args);
    const engine = new internals.AutoSwitchEngine(switcher, settings, args.json ? jsonlEmit : humanEmit, {
      dryRun: args.dryRun,
    });

    if (args.once) exit(await engine.tick());

    // SIGTERM (systemd stop, the menu bar) stops the loop cleanly with status 0.
    // SIGINT is Ctrl-C: the loop stops and the command exits with 130.
    const controller = new AbortController();
    let interrupted = false;
    const onTerm = (): void => controller.abort();
    const onInt = (): void => {
      if (interrupted) process.exit(130);
      interrupted = true;
      controller.abort();
    };
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    let code: number;
    try {
      if (!args.json) {
        print(
          dimmed(
            `Auto-switch running: threshold ${pyFixed(settings.threshold, 0)}%, ` +
              `every ${pyFixed(settings.intervalSeconds, 0)}s` +
              `${args.dryRun ? " (dry-run)" : ""} — Ctrl-C to stop`,
          ),
        );
      }
      code = await engine.runLoop({ signal: controller.signal });
    } finally {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
    }
    if (interrupted) stopped();
    exit(code);
  } catch (e) {
    if (e instanceof ClaudeSwitchError) {
      if (args.json) print(jsonDumps(errorEnvelope(e)));
      else error(`Error: ${e.message}`);
      exit(1);
    }
    if (isInterrupt(e)) stopped();
    throw e;
  }
}

/**
 * `cswap config [list|get KEY|set KEY VALUE|unset KEY|path]`.
 *
 * `set` validates strictly, but a load clamps. Thus a bad key or value fails
 * here, and not later in `cswap auto`.
 */
export function configCommand(argv: string[]): void {
  const keyLines = Object.values(SETTING_SPECS)
    .map((spec) => `  ${ljust(spec.dotted, 34)}${spec.help} (default ${formatSettingValue(spec.default)})`)
    .join("\n");
  const parser = new ArgumentParser({
    prog: "cswap config",
    description: "Read and edit claude-swap settings (settings.json in the backup root).",
    rawDescription: true,
    epilog: `
Keys:
${keyLines}

Examples:
  cswap config                              # list effective settings
  cswap config get autoswitch.threshold
  cswap config set autoswitch.threshold 80
  cswap config unset autoswitch.threshold   # back to the default
  cswap config path                         # where settings.json lives
        `,
  });
  parser.addArgument("--json", {
    action: "store_true",
    help: "Emit machine-readable JSON to stdout (with list or get)",
  });
  parser.addArgument("--debug", { action: "store_true", help: "Enable debug logging" });
  const sub = parser.addSubparsers({ dest: "action", metavar: "{list,get,set,unset,path}" });

  const pList = sub.addParser("list", { help: "Show all effective settings (the default)" });
  const pGet = sub.addParser("get", { help: "Print one setting's effective value" });
  pGet.addArgument("key", { metavar: "KEY", help: "Dotted key, e.g. autoswitch.threshold" });
  for (const p of [pList, pGet]) {
    // SUPPRESS keeps a `cswap config --json get` from a reset by the default of the subparser.
    p.addArgument("--json", {
      action: "store_true",
      default: SUPPRESS,
      help: "Emit machine-readable JSON to stdout",
    });
  }
  const pSet = sub.addParser("set", { help: "Validate and persist one setting" });
  pSet.addArgument("key", { metavar: "KEY" });
  pSet.addArgument("value", { metavar: "VALUE" });
  const pUnset = sub.addParser("unset", { help: "Remove one setting (revert to the default)" });
  pUnset.addArgument("key", { metavar: "KEY" });
  sub.addParser("path", { help: "Print the settings.json location" });

  const args = parser.parseArgs<{ json?: boolean; debug: boolean; action: string | null; key: string; value: string }>(
    argv,
  );
  const jsonMode = Boolean(args.json);
  const action = args.action || "list";
  if (jsonMode && action !== "list" && action !== "get") parser.error("--json can only be used with list or get");

  try {
    const switcher = newSwitcher(args.debug);
    guardRoot(switcher);
    const root = switcher.backupDir;

    if (action === "path") {
      print(settingsPath(root));
    } else if (action === "list") {
      const rows = effectiveSettings(root);
      if (jsonMode) {
        const payload = {
          schemaVersion: 1,
          path: settingsPath(root),
          settings: rows.map(([spec, value, isSet]) => ({ key: spec.dotted, value, isSet })),
        };
        print(jsonDumps(payload, 2));
      } else {
        const keyW = Math.max(...rows.map(([spec]) => spec.dotted.length));
        const valW = Math.max(...rows.map(([, v]) => formatSettingValue(v).length));
        for (const [spec, value, isSet] of rows) {
          const line = `${ljust(spec.dotted, keyW)}  ${ljust(formatSettingValue(value), valW)}`;
          print(isSet ? line : `${line}  ${dimmed("(default)")}`);
        }
      }
    } else if (action === "get") {
      const spec = settingSpec(args.key);
      const [, value, isSet] = effectiveSettings(root).find(([sp]) => sp === spec)!;
      if (jsonMode) {
        print(jsonDumps({ schemaVersion: 1, key: spec.dotted, value, isSet }, 2));
      } else {
        print(formatSettingValue(value));
      }
    } else if (action === "set") {
      const value = setSetting(root, args.key, args.value);
      print(`${args.key} = ${formatSettingValue(value)}`);
    } else if (action === "unset") {
      if (unsetSetting(root, args.key)) {
        const fallback = settingSpec(args.key).default;
        print(`${args.key} unset (default: ${formatSettingValue(fallback)})`);
      } else {
        printErr(muted(`${args.key} is not set; nothing to do`));
      }
    }
  } catch (e) {
    if (e instanceof ClaudeSwitchError) {
      if (jsonMode) print(jsonDumps(errorEnvelope(e), 2));
      else error(`Error: ${e.message}`);
      exit(1);
    }
    if (isInterrupt(e)) {
      const note = `\n${dimmed("Operation cancelled")}`;
      if (jsonMode) printErr(note);
      else print(note);
      exit(130);
    }
    throw e;
  }
}

/**
 * Trust the CA certificates of the operating system too, as `node --use-system-ca` does.
 * A corporate proxy or a private CA is often only in the system store.
 */
export function useNativeTls(): void {
  try {
    const t = tls as typeof tls & {
      getCACertificates?: (type: string) => string[];
      setDefaultCACertificates?: (certs: string[]) => void;
    };
    if (typeof t.getCACertificates !== "function" || typeof t.setDefaultCACertificates !== "function") return;
    const merged = [...new Set([...t.getCACertificates("default"), ...t.getCACertificates("system")])];
    t.setDefaultCACertificates(merged);
  } catch {
    // TLS trust is best effort: the bundled roots of Node stay in use.
  }
}

/** `menubar --install-service|--uninstall-service|--service-status`. */
function menubarService(args: MainArgs): number {
  if (args.installService) {
    const result = internals.launchAgent.install();
    print(`Menu bar service installed (${result.label}).`);
    print(`  plist: ${result.plist}`);
    print(`  logs:  ${result.stderr_log}`);
    print(
      dimmed("It starts at login from now on. Re-run this after a cswap upgrade to point launchd at the new build."),
    );
    return 0;
  }

  if (args.uninstallService) {
    const result = internals.launchAgent.uninstall();
    if (result.was_loaded || result.removed_plist) print("Menu bar service removed.");
    else print("Menu bar service was not installed.");
    return 0;
  }

  const result = internals.launchAgent.status();
  if (!result.installed && !result.loaded) {
    print("Menu bar service is not installed.");
    print(dimmed("Install it with: cswap menubar --install-service"));
    return 0;
  }
  const state = result.state || (result.loaded ? "loaded" : "stopped");
  const pid = result.pid ? ` (pid ${result.pid})` : "";
  print(`Menu bar service: ${state}${pid}`);
  print(`  plist: ${result.plist}`);
  if (!result.installed) print(dimmed("launchd still has it loaded, but the plist is gone."));
  return 0;
}

interface MainArgs extends Namespace {
  debug: boolean;
  tokenStatus: boolean;
  json: boolean;
  strategy: string | null;
  model: string | null;
  slot: number | null;
  email: string | null;
  account: string | null;
  alias: string | null;
  force: boolean;
  full: boolean;
  hold: number | null;
  installService: boolean;
  uninstallService: boolean;
  serviceStatus: boolean;
  addAccount: boolean;
  removeAccount: string | null;
  disableAccount: string | null;
  enableAccount: string | null;
  list: boolean;
  switch: boolean;
  switchTo: string | null;
  status: boolean;
  purge: boolean;
  export: string | null;
  import: string | null;
  importUsage: string | null;
  tui: boolean;
  watch: boolean;
  menubar: boolean;
  upgrade: boolean;
  addToken: string | null;
}

function buildMainParser(prog: string): ArgumentParser {
  const parser = new ArgumentParser({
    prog,
    usage: "%(prog)s <command> [args] [options]",
    description: `Multi-Account Switcher for Claude Code

Commands:
  %(prog)s help                       show this help
  %(prog)s list                       list managed accounts
  %(prog)s status                     show current account
  %(prog)s switch                     rotate to the next account
  %(prog)s switch <num|email>         switch to a specific account
  %(prog)s add                        add the current account
  %(prog)s add-token [TOKEN|-]        register a setup-token or API key
  %(prog)s remove <num|email>         remove an account
  %(prog)s disable <num|email>        hold an account out of auto-rotation
  %(prog)s enable <num|email>         return a disabled account to rotation
  %(prog)s run <num|email> [-- ...]   run as an account, this terminal only
  %(prog)s run                        run the current dir's mapped account
  %(prog)s map <num|email> [path]     map a directory to an account
  %(prog)s map                        list directory mappings
  %(prog)s unmap [path]               remove a directory mapping
  %(prog)s alias <num|email> <name>   set a short alias for an account
  %(prog)s alias <num|email> --unset  remove an account's alias
  %(prog)s alias                      list all aliases
  %(prog)s swap <a> <b>               exchange two accounts' slot numbers
  %(prog)s move <a> <slot>            assign an account to a slot (swaps if taken)
  %(prog)s auto                       auto-switch when nearing rate limits
  %(prog)s config [set KEY VALUE]     show or change settings (settings.json)
  %(prog)s unclaimed [--purge ID]     list or drop stashed credential entries
  %(prog)s export <path>              export accounts
  %(prog)s import <path>              import accounts
  %(prog)s import-usage <path>        adopt usage another machine read (list --json)
  %(prog)s tui                        interactive dashboard (also: bare %(prog)s)
  %(prog)s watch                      dashboard, opened on the live watch page
  %(prog)s menubar                    macOS menu bar app
  %(prog)s menubar --install-service  keep the menu bar running via launchd
  %(prog)s upgrade                    self-upgrade to latest
  %(prog)s purge                      remove all claude-swap data

Aliases: ls=list  rm=remove  update=upgrade`,
    rawDescription: true,
    epilog: `Flags combine with subcommands:
  %(prog)s switch --strategy best           # pick the account with most quota left
  %(prog)s switch --strategy next-available # rotate, skipping rate-limited accounts
  %(prog)s switch user@example.com
  %(prog)s list --token-status
  %(prog)s list --json
  %(prog)s import-usage usage.json --hold 600  # adopt another machine's list --json
  %(prog)s add --slot 3                      # add to a specific slot
  %(prog)s add-token sk-ant-oat01-... --email me@example.com
  %(prog)s run 2 -- --resume                 # forward args after '--' to claude
  %(prog)s auto --once                       # single auto-switch tick (cron-friendly)
  %(prog)s config set autoswitch.threshold 80

The original flag spellings (%(prog)s --switch, %(prog)s --list, ...) keep working.
        `,
  });

  parser.addArgument("--version", { action: "version", version: `%(prog)s ${VERSION}` });
  parser.addArgument("--debug", { action: "store_true", help: "Enable debug logging" });
  parser.addArgument("--token-status", {
    action: "store_true",
    help: "Show source-labelled OAuth token diagnostics (use with 'list')",
  });
  parser.addArgument("--json", {
    action: "store_true",
    help:
      "Emit machine-readable JSON to stdout (use with 'list', 'status', " +
      "or 'switch'). See README 'JSON output for scripting'.",
  });
  parser.addArgument("--strategy", {
    choices: ["best", "next-available"],
    metavar: "{best,next-available}",
    help:
      "With bare 'switch': pick the target by remaining 5h/7d quota. " +
      "'best' jumps to the account with the most headroom; " +
      "'next-available' rotates to the next account, skipping any at their limit",
  });
  parser.addArgument("--model", {
    metavar: "NAMES",
    help:
      "With 'switch --strategy': also count these models' per-model " +
      "weekly limits when comparing accounts (comma-separated display " +
      "names, or 'all'). Defaults to the autoswitch.model setting",
  });
  parser.addArgument("--slot", {
    type: "int",
    metavar: "NUM",
    help: "Specify slot number when adding account (use with 'add' or 'add-token')",
  });
  parser.addArgument("--email", {
    metavar: "EMAIL",
    help:
      "Email address for the account. Optional with 'add-token'; " +
      "defaults to setup-token-{slot}@token.local (or " +
      "api-key-{slot}@token.local for API keys) since these tokens " +
      "carry no real email metadata.",
  });
  parser.addArgument("--account", { metavar: "NUM|EMAIL", help: "Limit export to one account (use with 'export')" });
  parser.addArgument("--alias", { metavar: "NAME", help: "Set a short display alias for the account (use with 'add')" });
  parser.addArgument("--force", {
    action: "store_true",
    help:
      "Overwrite existing accounts during import; with 'switch <num|email>', " +
      "activate the stored credentials without backing up the current " +
      "login first",
  });
  parser.addArgument("--full", {
    action: "store_true",
    help: "Include full ~/.claude.json in export (default: oauthAccount only)",
  });
  parser.addArgument("--hold", {
    type: "float",
    metavar: "SECONDS",
    help:
      "With 'import-usage': keep this machine from fetching the " +
      "imported accounts for this many seconds (0 lifts an earlier hold)",
  });
  parser.addArgument("--install-service", {
    action: "store_true",
    help:
      "With 'menubar': install a launchd LaunchAgent so the menu bar " +
      "starts at login and restarts on crash (macOS)",
  });
  parser.addArgument("--uninstall-service", {
    action: "store_true",
    help: "With 'menubar': stop the LaunchAgent and remove its plist (macOS)",
  });
  parser.addArgument("--service-status", {
    action: "store_true",
    help: "With 'menubar': report whether the LaunchAgent is installed and running",
  });

  // The legacy `--flag` interface still works, but help hides it: the subcommands are the documented interface.
  const group = parser.addMutuallyExclusiveGroup();
  group.addArgument("--add-account", { action: "store_true", help: SUPPRESS });
  group.addArgument("--remove-account", { metavar: "NUM|EMAIL", help: SUPPRESS });
  group.addArgument("--disable-account", { metavar: "NUM|EMAIL", help: SUPPRESS });
  group.addArgument("--enable-account", { metavar: "NUM|EMAIL", help: SUPPRESS });
  group.addArgument("--list", { action: "store_true", help: SUPPRESS });
  group.addArgument("--switch", { action: "store_true", help: SUPPRESS });
  group.addArgument("--switch-to", { metavar: "NUM|EMAIL", help: SUPPRESS });
  group.addArgument("--status", { action: "store_true", help: SUPPRESS });
  group.addArgument("--purge", { action: "store_true", help: SUPPRESS });
  group.addArgument("--export", { metavar: "PATH", help: SUPPRESS });
  group.addArgument("--import", { dest: "import", metavar: "PATH", help: SUPPRESS });
  group.addArgument("--import-usage", { metavar: "PATH", help: SUPPRESS });
  group.addArgument("--tui", { action: "store_true", help: SUPPRESS });
  group.addArgument("--watch", { action: "store_true", help: SUPPRESS });
  group.addArgument("--menubar", { action: "store_true", help: SUPPRESS });
  group.addArgument("--upgrade", { action: "store_true", help: SUPPRESS });
  group.addArgument("--add-token", { metavar: "TOKEN|-", nargs: "?", const: "", help: SUPPRESS });
  return parser;
}

function validateMainArgs(parser: ArgumentParser, args: MainArgs, prog: string): void {
  // A value action can be set but falsy (`--add-token` has const ""), so those use `!== null`.
  const anyCommand =
    args.addAccount ||
    args.list ||
    args.switch ||
    args.status ||
    args.purge ||
    args.tui ||
    args.watch ||
    args.menubar ||
    args.upgrade ||
    args.removeAccount !== null ||
    args.disableAccount !== null ||
    args.enableAccount !== null ||
    args.switchTo !== null ||
    args.export !== null ||
    args.import !== null ||
    args.importUsage !== null ||
    args.addToken !== null;
  if (!anyCommand) parser.error(`no command given — try '${prog} help'`);

  if (args.tokenStatus && !args.list) parser.error("--token-status can only be used with 'list'");
  if (args.json && !(args.list || args.status || args.switch || args.switchTo)) {
    parser.error("--json can only be used with 'list', 'status', or 'switch'");
  }
  // Token status is not in the JSON v1 schema.
  if (args.json && args.tokenStatus) parser.error("--token-status cannot be combined with --json");
  if (args.strategy !== null && !args.switch) parser.error("--strategy can only be used with bare 'switch'");
  if (args.model !== null && args.strategy === null) {
    parser.error("--model can only be used with 'switch --strategy best' or 'switch --strategy next-available'");
  }
  if (args.slot !== null && !(args.addAccount || args.addToken !== null)) {
    parser.error("--slot can only be used with 'add' or 'add-token'");
  }
  if (args.email !== null && args.addToken === null) parser.error("--email can only be used with 'add-token'");
  if (args.account !== null && !args.export) parser.error("--account can only be used with 'export'");
  if (args.alias !== null && !args.addAccount) parser.error("--alias can only be used with 'add'");
  if (args.force && !(args.import || args.switchTo)) {
    parser.error("--force can only be used with 'import' or 'switch <num|email>'");
  }
  if (args.full && !args.export) parser.error("--full can only be used with 'export'");
  if (args.hold !== null && args.importUsage === null) parser.error("--hold can only be used with 'import-usage'");
  if (args.hold !== null && !(Number.isFinite(args.hold) && args.hold >= 0)) {
    parser.error("--hold must be a non-negative number of seconds");
  }
  if ((args.installService || args.uninstallService || args.serviceStatus) && !args.menubar) {
    parser.error("--install-service, --uninstall-service and --service-status can only be used with 'menubar'");
  }
}

/** Run the self-upgrade. A Ctrl-C during the package manager run gives status 130. */
async function upgrade(): Promise<never> {
  let cancelled = false;
  const onInt = (): void => {
    cancelled = true;
  };
  process.on("SIGINT", onInt);
  let code: number;
  try {
    code = internals.runSelfUpgrade();
    // The signal of a Ctrl-C during spawnSync arrives on the next turn of the event loop.
    await new Promise((resolve) => setTimeout(resolve, 10));
  } catch (e) {
    if (!isInterrupt(e)) throw e;
    cancelled = true;
    code = 130;
  } finally {
    process.off("SIGINT", onInt);
  }
  if (cancelled) {
    print(`\n${dimmed("Upgrade cancelled")}`);
    exit(130);
  }
  exit(code);
}

/** The entry point of the CLI. `argv` excludes the program name. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  forceUtf8Output();
  internals.useNativeTls();
  try {
    // `run` gives the terminal to a child, and `--json` must stay machine-readable: no terminal query then.
    const probe = cliShouldProbe(argv, { colorsEnabled: colorsEnabled() });
    setTheme(cliTheme(loadUiSettings(getBackupRoot()).theme, { colors: probe }));
  } catch {
    // The theme is cosmetic. It must never block the CLI.
  }

  const first = argv[0];
  if (first === "run") return internals.runCommand(argv.slice(1));
  if (first === "auto") return internals.autoCommand(argv.slice(1));
  if (first === "config") return internals.configCommand(argv.slice(1));
  if (first === "map") return internals.mapCommand(argv.slice(1));
  if (first === "unmap") return internals.unmapCommand(argv.slice(1));
  if (first === "unclaimed") return internals.unclaimedCommand(argv.slice(1));
  if (first === "alias") return internals.aliasCommand(argv.slice(1));
  if (first === "swap") return internals.swapCommand(argv.slice(1));
  if (first === "move") return internals.moveCommand(argv.slice(1));

  // Bare `cswap` in an interactive terminal opens the TUI. Scripts and pipes get the usage error.
  if (argv.length === 0 && internals.stdoutIsatty() && internals.stdinIsatty()) argv = ["--tui"];

  argv = translateSubcommand(argv);
  const prog = internals.progName();
  const parser = buildMainParser(prog);
  const args = parser.parseArgs<MainArgs>(argv);
  validateMainArgs(parser, args, prog);

  // The self-upgrade does not construct the switcher: it must not touch the config or the keychain.
  if (args.upgrade) await upgrade();

  // JSON-capable commands return a payload. Only this function writes it to stdout.
  let payload: JsonObject | null | undefined = null;
  try {
    const switcher = newSwitcher(args.debug);
    guardRoot(switcher);

    if (args.addAccount) {
      await switcher.addAccount(args.slot, false, args.alias);
    } else if (args.addToken !== null) {
      switcher.addAccountFromToken(args.addToken, args.email, args.slot);
    } else if (args.removeAccount) {
      switcher.removeAccount(args.removeAccount);
    } else if (args.disableAccount !== null) {
      switcher.setAccountDisabled(args.disableAccount, true);
    } else if (args.enableAccount !== null) {
      switcher.setAccountDisabled(args.enableAccount, false);
    } else if (args.list) {
      payload = await switcher.listAccounts(args.tokenStatus, args.json);
    } else if (args.switch) {
      // Only the usage-aware strategies read model limits. `--model` wins over the autoswitch.model setting.
      let models: string[];
      let modelSource: string | null;
      if (args.strategy === null) {
        models = [];
        modelSource = null;
      } else if (args.model !== null) {
        models = parseModelNames(args.model);
        modelSource = "cli";
      } else {
        models = parseModelNames(internals.loadSettings(switcher.backupDir).model);
        modelSource = models.length > 0 ? "autoswitch.model" : null;
      }
      payload = (await switcher.switch(args.strategy, args.json, models, modelSource)) as JsonObject | null;
      if (payload != null && models.length > 0) {
        payload.models = [...models];
        payload.modelSource = modelSource;
      }
    } else if (args.switchTo) {
      payload = (await switcher.switchTo(args.switchTo, args.json, args.force)) as JsonObject | null;
    } else if (args.status) {
      payload = await switcher.status(args.json);
    } else if (args.purge) {
      switcher.purge();
    } else if (args.export) {
      internals.exportAccounts(switcher, args.export, args.account, args.full);
    } else if (args.import) {
      internals.importAccounts(switcher, args.import, args.force);
    } else if (args.importUsage) {
      internals.importUsage(switcher, args.importUsage, args.hold);
    } else if (args.tui) {
      const run = await internals.loadTui();
      exit(await run(switcher));
    } else if (args.watch) {
      const run = await internals.loadTui();
      exit(await run(switcher, "watch"));
    } else if (args.menubar) {
      if (internals.platform() !== "darwin") {
        error("The menu bar is only available on macOS.");
        exit(1);
      }
      if (args.installService || args.uninstallService || args.serviceStatus) exit(menubarService(args));
      exit(internals.menubarRun(switcher));
    }
  } catch (e) {
    if (e instanceof ClaudeSwitchError) {
      // JSON mode keeps stdout pure JSON: the error envelope goes there, not to stderr.
      if (args.json) print(jsonDumps(errorEnvelope(e), 2));
      else error(`Error: ${e.message}`);
      exit(1);
    }
    if (isInterrupt(e)) {
      // JSON mode keeps stdout parseable, so the note goes to stderr.
      const note = `\n${dimmed("Operation cancelled")}`;
      if (args.json) printErr(note);
      else print(note);
      exit(130);
    }
    throw e;
  }

  if (args.json && payload != null) print(jsonDumps(payload, 2));

  // After `purge`, the check would create the cache again in the deleted directory.
  if (!args.purge && !args.upgrade && !args.json) {
    const msg = await internals.checkForUpdate(VERSION);
    if (msg) printErr(`\n${muted(msg)}`);
  }
}
