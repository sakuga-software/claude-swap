// No test runs the real `launchctl`: `internals.spawnSync` throws unless a test installs a router.
// Every test passes `home` and `uid`, so nothing writes to the real ~/Library.
import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as launchAgent from "../src/launch_agent.js";
import { internals, LABEL } from "../src/launch_agent.js";
import { ClaudeSwitchError } from "../src/exceptions.js";
import { testHome } from "./helpers/home.js";
import { parsePlist, type PlistValue } from "./helpers/plist.js";

const PROGRAM = ["/Users/x/.local/bin/cswap"];
const UID = 501;

const original = { ...internals };
let tmpPath: string;
let cwd: string;

beforeEach(() => {
  tmpPath = testHome();
  cwd = process.cwd();
  internals.platform = "darwin";
  internals.spawnSync = () => {
    throw new Error("A test tried to run the real launchctl. Install a router.");
  };
});

afterEach(() => {
  Object.assign(internals, original);
  process.chdir(cwd);
});

function completed(returncode = 0, stdout = "", stderr = ""): SpawnSyncReturns<string> {
  return { pid: 0, output: [null, stdout, stderr], stdout, stderr, status: returncode, signal: null };
}

type Run = (file: string, args: string[]) => SpawnSyncReturns<string>;

/** Install `run` as the launchctl replacement and return the mock that records the calls. */
function mockRun(run: Run) {
  return vi.spyOn(internals, "spawnSync").mockImplementation((file, args) => run(file, args));
}

/** Answer per launchctl subcommand. The default is success. */
function router(responses: Record<string, SpawnSyncReturns<string>>): Run {
  return (_file, args) => responses[args[0] ?? ""] ?? completed(0);
}

function argvs(run: ReturnType<typeof mockRun>): string[][] {
  return run.mock.calls.map(([file, args]) => [file, ...args]);
}

function subcommands(run: ReturnType<typeof mockRun>): string[] {
  return run.mock.calls.map(([, args]) => args[0] ?? "");
}

function parsed(home: string): Record<string, PlistValue> {
  return parsePlist(launchAgent.buildPlist(PROGRAM, LABEL, home)) as Record<string, PlistValue>;
}

function pathEntries(home: string): string[] {
  return ((parsed(home).EnvironmentVariables as Record<string, string>).PATH ?? "").split(":");
}

it("test_build_plist_is_parseable_and_runs_the_menubar_subcommand", () => {
  const plist = parsed(tmpPath);
  expect(plist.Label).toBe(LABEL);
  expect(plist.ProgramArguments).toEqual([...PROGRAM, "menubar"]);
  expect(plist.RunAtLoad).toBe(true);
});

it("test_build_plist_keepalive_restarts_a_crash_but_respects_a_quit", () => {
  // A bare `KeepAlive: true` makes the Quit item useless: launchd relaunches a clean exit at once.
  expect(parsed(tmpPath).KeepAlive).toEqual({ SuccessfulExit: false });
});

it("test_build_plist_marks_the_agent_interactive_not_background", () => {
  expect(parsed(tmpPath).ProcessType).toBe("Interactive");
});

it("test_build_plist_survives_paths_that_would_break_hand_written_xml", () => {
  const odd = path.join(tmpPath, "home & <co>");
  expect(parsed(odd).StandardErrorPath).toBe(path.join(odd, "Library/Logs", `${LABEL}.err`));
});

it.skipIf(process.platform === "win32")("test_build_plist_path_env_leads_with_the_programs_own_directory", () => {
  expect(pathEntries(tmpPath)[0]).toBe("/Users/x/.local/bin");
});

it.skipIf(process.platform === "win32")("test_build_plist_path_env_includes_the_user_bin_dir", () => {
  expect(pathEntries(tmpPath)).toContain(path.join(os.homedir(), ".local/bin"));
});

it("test_build_plist_path_env_keeps_the_launchd_defaults", () => {
  const entries = pathEntries(tmpPath);
  for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) expect(entries).toContain(dir);
});

it("test_resolve_program_prefers_the_console_script", () => {
  const script = path.join(tmpPath, "cswap");
  fs.writeFileSync(script, "#!/bin/sh\n");
  internals.argv1 = () => script;
  expect(launchAgent.resolveProgram()).toEqual([script]);
});

it("test_resolve_program_keeps_the_symlink_and_does_not_follow_it", () => {
  // A global npm or pnpm install links the bin into the package directory. The symlink path is the stable one.
  const venvBin = path.join(tmpPath, "venv", "bin");
  fs.mkdirSync(venvBin, { recursive: true });
  const real = path.join(venvBin, "cswap");
  fs.writeFileSync(real, "#!/bin/sh\n");
  const linkDir = path.join(tmpPath, "local", "bin");
  fs.mkdirSync(linkDir, { recursive: true });
  const link = path.join(linkDir, "cswap");
  fs.symlinkSync(real, link);

  internals.argv1 = () => link;
  expect(launchAgent.resolveProgram()).toEqual([link]);
});

it("test_resolve_program_makes_a_relative_argv0_absolute", () => {
  const script = path.join(tmpPath, "cswap");
  fs.writeFileSync(script, "#!/bin/sh\n");
  process.chdir(tmpPath);
  internals.argv1 = () => "./cswap";
  const result = launchAgent.resolveProgram();
  expect(result).toEqual([path.join(process.cwd(), "cswap")]);
  expect(path.isAbsolute(result[0] ?? "")).toBe(true);
});

it("test_resolve_program_falls_back_to_the_interpreter_without_a_script", () => {
  internals.argv1 = () => path.join(tmpPath, "gone");
  internals.which = () => null;
  expect(launchAgent.resolveProgram()).toEqual([process.execPath, internals.cliEntry()]);
});

it("test_resolve_program_ignores_an_argv0_that_is_not_cswap", () => {
  // Under vitest, the script path is the test runner. launchd must not run it.
  const other = path.join(tmpPath, "vitest");
  fs.writeFileSync(other, "#!/bin/sh\n");
  const found = path.join(tmpPath, "cswap");
  fs.writeFileSync(found, "#!/bin/sh\n");
  internals.argv1 = () => other;
  internals.which = () => found;
  expect(launchAgent.resolveProgram()).toEqual([found]);
});

it("test_install_writes_the_plist_and_bootstraps_it", () => {
  const run = mockRun(router({ print: completed(1) }));
  const result = launchAgent.install(LABEL, tmpPath, PROGRAM, UID);

  expect(fs.existsSync(result.plist)).toBe(true);
  expect(argvs(run)).toContainEqual(["launchctl", "bootstrap", `gui/${UID}`, result.plist]);
});

it("test_install_creates_the_log_directory", () => {
  mockRun(router({ print: completed(1) }));
  const result = launchAgent.install(LABEL, tmpPath, PROGRAM, UID);
  expect(fs.statSync(path.dirname(result.stderr_log)).isDirectory()).toBe(true);
});

it("test_install_boots_out_first_when_already_loaded", () => {
  // Without the bootout, launchd refuses a reinstall with "service already loaded".
  const run = mockRun(router({ print: completed(0) }));
  internals.sleepSync = () => {};
  internals.waitUntilUnloaded = () => true;
  launchAgent.install(LABEL, tmpPath, PROGRAM, UID);

  const subs = subcommands(run);
  expect(subs.indexOf("bootout")).toBeLessThan(subs.indexOf("bootstrap"));
  expect(subs.indexOf("bootout")).toBeGreaterThanOrEqual(0);
});

it("test_install_does_not_boot_out_when_nothing_is_loaded", () => {
  const run = mockRun(router({ print: completed(1) }));
  launchAgent.install(LABEL, tmpPath, PROGRAM, UID);
  expect(subcommands(run)).not.toContain("bootout");
});

it("test_install_waits_for_the_old_job_to_go_away_before_bootstrapping", () => {
  // `bootout` can return before launchd ends the teardown. A `bootstrap` in that window fails.
  let prints = 0;
  const slept = vi.fn();
  internals.sleepSync = slept;
  const ran = mockRun((_file, args) => {
    if (args[0] === "print") {
      prints += 1;
      return completed(prints <= 3 ? 0 : 1);
    }
    return completed(0);
  });

  launchAgent.install(LABEL, tmpPath, PROGRAM, UID);

  expect(slept).toHaveBeenCalled();
  const subs = subcommands(ran);
  expect(subs.indexOf("bootout")).toBeLessThan(subs.indexOf("bootstrap"));
  expect(subs.filter((s) => s === "print").length).toBeGreaterThan(2);
});

it("test_wait_until_unloaded_gives_up_after_the_timeout", () => {
  internals.sleepSync = () => {};
  mockRun(router({ print: completed(0) }));
  expect(launchAgent.waitUntilUnloaded(LABEL, UID, 0.0)).toBe(false);
});

it("test_install_names_the_lingering_predecessor_when_bootstrap_fails", () => {
  internals.waitUntilUnloaded = () => false;
  mockRun(router({ print: completed(0), bootstrap: completed(5, "", "Operation already in progress") }));
  expect(() => launchAgent.install(LABEL, tmpPath, PROGRAM, UID)).toThrow(ClaudeSwitchError);
  expect(() => launchAgent.install(LABEL, tmpPath, PROGRAM, UID)).toThrow(/still shutting down/);
});

it("test_install_raises_with_launchctl_detail_when_bootstrap_fails", () => {
  mockRun(router({ print: completed(1), bootstrap: completed(5, "", "Input/output error") }));
  expect(() => launchAgent.install(LABEL, tmpPath, PROGRAM, UID)).toThrow(ClaudeSwitchError);
  expect(() => launchAgent.install(LABEL, tmpPath, PROGRAM, UID)).toThrow(/Input\/output error/);
});

it("test_install_refuses_off_macos", () => {
  internals.platform = "linux";
  expect(() => launchAgent.install(LABEL, tmpPath, PROGRAM, UID)).toThrow(ClaudeSwitchError);
  expect(() => launchAgent.install(LABEL, tmpPath, PROGRAM, UID)).toThrow(/only available on macOS/);
});

it("test_uninstall_boots_out_and_removes_the_plist", () => {
  const target = launchAgent.plistPath(LABEL, tmpPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "x");

  const run = mockRun(router({ print: completed(0) }));
  const result = launchAgent.uninstall(LABEL, tmpPath, UID);

  expect(result).toEqual({ label: LABEL, was_loaded: true, removed_plist: true });
  expect(fs.existsSync(target)).toBe(false);
  expect(argvs(run)).toContainEqual(["launchctl", "bootout", `gui/${UID}/${LABEL}`]);
});

it("test_uninstall_is_quiet_when_nothing_is_installed", () => {
  mockRun(router({ print: completed(1) }));
  const result = launchAgent.uninstall(LABEL, tmpPath, UID);
  expect(result.was_loaded).toBe(false);
  expect(result.removed_plist).toBe(false);
});

it("test_uninstall_removes_a_plist_that_was_never_bootstrapped", () => {
  const target = launchAgent.plistPath(LABEL, tmpPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "x");
  mockRun(router({ print: completed(1) }));
  const result = launchAgent.uninstall(LABEL, tmpPath, UID);
  expect(result.removed_plist).toBe(true);
  expect(fs.existsSync(target)).toBe(false);
});

it("test_uninstall_raises_when_bootout_fails_and_the_service_stays_loaded", () => {
  mockRun(router({ print: completed(0), bootout: completed(3, "", "in use") }));
  expect(() => launchAgent.uninstall(LABEL, tmpPath, UID)).toThrow(ClaudeSwitchError);
  expect(() => launchAgent.uninstall(LABEL, tmpPath, UID)).toThrow(/in use/);
});

it("test_uninstall_tolerates_a_bootout_race_that_already_unloaded_it", () => {
  // bootout fails because the job went away. The next print shows that the job is gone.
  let prints = 0;
  mockRun((_file, args) => {
    if (args[0] === "print") {
      prints += 1;
      return prints === 1 ? completed(0) : completed(1);
    }
    if (args[0] === "bootout") return completed(3, "", "No such process");
    return completed(0);
  });
  expect(launchAgent.uninstall(LABEL, tmpPath, UID).was_loaded).toBe(true);
});

it("test_status_reads_state_and_pid_from_launchctl_print", () => {
  const printed = "\tstate = running\n\tpid = 25026\n\tlast exit code = (never exited)\n";
  mockRun(router({ print: completed(0, printed) }));
  const result = launchAgent.status(LABEL, UID, tmpPath);

  expect(result.loaded).toBe(true);
  expect(result.state).toBe("running");
  expect(result.pid).toBe(25026);
});

it("test_status_reports_not_loaded_without_inventing_a_pid", () => {
  mockRun(router({ print: completed(1) }));
  const result = launchAgent.status(LABEL, UID, tmpPath);
  expect(result.loaded).toBe(false);
  expect(result.pid).toBeNull();
  expect(result.state).toBeNull();
});

it("test_status_separates_installed_from_loaded", () => {
  // A plist that launchd does not know tells the user to run --install-service again.
  const target = launchAgent.plistPath(LABEL, tmpPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "x");
  mockRun(router({ print: completed(1) }));
  const result = launchAgent.status(LABEL, UID, tmpPath);
  expect(result.installed).toBe(true);
  expect(result.loaded).toBe(false);
});

it("test_status_reads_the_jobs_own_state_not_a_nested_blocks", () => {
  // Regression: real `launchctl print` repeats `state` in nested blocks, for example `pid-local endpoints`.
  const printed =
    "gui/501/com.cswap.menubar = {\n" +
    "\tactive count = 1\n" +
    "\tstate = running\n" +
    "\tpid = 25026\n" +
    "\tpid-local endpoints = {\n" +
    "\t\tstate = active\n" +
    "\t\tpid = 999\n" +
    "\t}\n" +
    "}\n";
  mockRun(router({ print: completed(0, printed) }));
  const result = launchAgent.status(LABEL, UID, tmpPath);

  expect(result.state).toBe("running");
  expect(result.pid).toBe(25026);
});

it("test_status_keeps_multi_word_launchd_states", () => {
  // Before the process starts, launchd reports "spawn scheduled".
  mockRun(router({ print: completed(0, "\tstate = spawn scheduled\n") }));
  expect(launchAgent.status(LABEL, UID, tmpPath).state).toBe("spawn scheduled");
});

it("test_status_ignores_a_non_numeric_pid_line", () => {
  mockRun(router({ print: completed(0, "\tpid = (none)\n") }));
  expect(launchAgent.status(LABEL, UID, tmpPath).pid).toBeNull();
});
