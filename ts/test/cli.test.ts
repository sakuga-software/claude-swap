import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cli from "../src/cli.js";
import { NoSwitchEvent, TickOutcome, type AutoSwitchEvent } from "../src/autoswitch.js";
import { ConfigError, SessionError } from "../src/exceptions.js";
import { MappingStore } from "../src/mappings.js";
import { getBackupRoot } from "../src/paths.js";
import { autoSwitchSettings, type AutoSwitchSettings } from "../src/settings.js";
import { ClaudeAccountSwitcher } from "../src/switcher.js";
import { internals as switcherInternals } from "../src/switcher/internals.js";
import { VERSION } from "../src/version.js";
import { captureOutput } from "./helpers/capture.js";
import { mockClaudeConfig } from "./helpers/fixtures.js";
import { testHome } from "./helpers/home.js";

const { internals, SystemExit } = cli;

const restores: Array<() => void> = [];

/** `monkeypatch.setattr`: the `afterEach` hook restores the property. */
function patch<T extends object, K extends keyof T>(obj: T, key: K, value: unknown): void {
  const saved = obj[key];
  obj[key] = value as T[K];
  restores.push(() => {
    obj[key] = saved;
  });
}

beforeEach(() => {
  patch(internals, "progName", () => "cswap");
  patch(internals, "useNativeTls", () => {});
  patch(internals, "geteuid", () => 1000);
  patch(internals, "checkForUpdate", async () => null);
});

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

/** Run `fn`. Returns the `SystemExit` code, or null if `fn` returns without an exit. */
async function exitCode(fn: () => unknown): Promise<number | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof SystemExit) return e.code;
    throw e;
  }
}

/** `cli.main()` with `argv`, as the Python tests patch `sys.argv`. */
function main(argv: string[]): Promise<void> {
  return cli.main(argv);
}

/** Run the CLI as the Python tests run `python -m claude_swap`: in-process, with captured output. */
async function runCli(argv: string[]): Promise<{ returncode: number; stdout: string; stderr: string }> {
  const capture = captureOutput();
  const code = await exitCode(() => main(argv));
  const { out, err } = capture.readouterr();
  return { returncode: code ?? 0, stdout: out, stderr: err };
}

type Mock = ReturnType<typeof vi.fn>;
interface Fake {
  backupDir: string;
  isRunningInContainer: Mock;
  addAccount: Mock;
  addAccountFromToken: Mock;
  removeAccount: Mock;
  setAccountDisabled: Mock;
  listAccounts: Mock;
  switch: Mock;
  switchTo: Mock;
  status: Mock;
  purge: Mock;
}

/** The `MagicMock` that `patch("claude_swap.cli.ClaudeAccountSwitcher")` gives. */
function fakeSwitcher(): Fake {
  return {
    backupDir: path.join(testHome(), "fake-backup"),
    isRunningInContainer: vi.fn(() => false),
    addAccount: vi.fn(async () => {}),
    addAccountFromToken: vi.fn(),
    removeAccount: vi.fn(),
    setAccountDisabled: vi.fn(),
    listAccounts: vi.fn(async () => undefined),
    switch: vi.fn(async () => undefined),
    switchTo: vi.fn(async () => undefined),
    status: vi.fn(async () => undefined),
    purge: vi.fn(),
  };
}

/** Replace the switcher class. Returns the class spy and its instance. */
function patchSwitcher(instance: object = fakeSwitcher()): { cls: ReturnType<typeof vi.fn>; instance: Fake } {
  const cls = vi.fn(function () {
    return instance;
  });
  patch(internals, "ClaudeAccountSwitcher", cls);
  return { cls, instance: instance as Fake };
}

function patchLoadSettings(settings: AutoSwitchSettings): void {
  patch(internals, "loadSettings", () => settings);
}

describe("TestCLI", () => {
  it("test_version_flag", async () => {
    const result = await runCli(["--version"]);
    expect(result.returncode).toBe(0);
    expect(result.stdout).toContain(VERSION);
  });

  it("test_help_flag", async () => {
    const result = await runCli(["--help"]);
    expect(result.returncode).toBe(0);
    expect(result.stdout).toContain("Multi-Account Switcher");
    expect(result.stdout.includes("cswap add") || result.stdout.includes("add ")).toBe(true);
    expect(result.stdout).toContain("switch <num|email>");
    expect(result.stdout).toContain("list ");
    expect(result.stdout).toContain("status ");
    const optionsSection = result.stdout.split("Flags combine with subcommands:")[0]!;
    expect(optionsSection).not.toContain("--add-account");
    expect(optionsSection).not.toContain("--switch ");
    expect(optionsSection).not.toContain("--list");
    expect(optionsSection).not.toContain("--status");
    expect(result.stdout).toContain("keep working");
  });

  it("test_no_args_shows_error", async () => {
    patch(internals, "stdoutIsatty", () => false);
    patch(internals, "stdinIsatty", () => false);
    const result = await runCli([]);
    expect(result.returncode).toBe(2);
    expect(result.stderr).toContain("no command given");
    expect(result.stderr).not.toContain("--add-account");
    expect(result.stderr).not.toContain("one of the arguments");
  });

  it("test_mutually_exclusive_args", async () => {
    const result = await runCli(["--list", "--status"]);
    expect(result.returncode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("not allowed");
  });

  it("test_debug_flag_accepted", async () => {
    const result = await runCli(["--debug", "--status"]);
    expect(!result.stderr.includes("--debug") || !result.stderr.includes("unrecognized")).toBe(true);
  });

  it("test_token_status_flag_requires_list", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["--token-status", "--status"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("--token-status can only be used with 'list'");
  });

  it("test_token_status_flag_is_forwarded_to_list", async () => {
    const { instance } = patchSwitcher();
    await main(["--list", "--token-status"]);
    expect(instance.listAccounts).toHaveBeenCalledExactlyOnceWith(true, false);
  });

  it("test_strategy_best_requires_switch", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["--strategy", "best", "--list"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("--strategy can only be used with bare 'switch'");
  });

  it("test_strategy_next_available_requires_switch", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["--strategy", "next-available", "--list"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("--strategy can only be used with bare 'switch'");
  });

  it("test_strategy_rejects_unknown_value", async () => {
    captureOutput();
    expect(await exitCode(() => main(["--switch", "--strategy", "bogus"]))).toBe(2);
  });

  it("test_switch_strategy_forwarded", async () => {
    const { instance } = patchSwitcher();
    patchLoadSettings(autoSwitchSettings());
    await main(["--switch", "--strategy", "best"]);
    expect(instance.switch).toHaveBeenCalledExactlyOnceWith("best", false, [], null);
  });

  it("test_switch_strategy_falls_back_to_configured_model", async () => {
    const { instance } = patchSwitcher();
    patchLoadSettings(autoSwitchSettings({ model: "Fable" }));
    await main(["--switch", "--strategy", "best"]);
    expect(instance.switch).toHaveBeenCalledExactlyOnceWith("best", false, ["Fable"], "autoswitch.model");
  });

  it("test_switch_model_flag_overrides_setting", async () => {
    const { instance } = patchSwitcher();
    patchLoadSettings(autoSwitchSettings({ model: "Sonnet" }));
    await main(["--switch", "--strategy", "next-available", "--model", "Opus, opus,Fable"]);
    expect(instance.switch).toHaveBeenCalledExactlyOnceWith("next-available", false, ["Opus", "Fable"], "cli");
  });

  it("test_switch_model_without_strategy_is_rejected", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["--switch", "--model", "Fable"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("--model can only be used with");
  });

  it("test_plain_switch_passes_no_strategy", async () => {
    const { instance } = patchSwitcher();
    await main(["--switch"]);
    expect(instance.switch).toHaveBeenCalledExactlyOnceWith(null, false, [], null);
  });

  it("test_slot_flag_requires_add_account", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["--list", "--slot", "3"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("--slot can only be used with 'add' or 'add-token'");
  });

  it("test_slot_flag_in_help", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("--slot");
  });

  it("test_account_flag_requires_export", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["--list", "--account", "1"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("--account can only be used with 'export'");
  });

  it("test_force_flag_requires_import_or_switch_to", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["--list", "--force"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("--force can only be used with 'import' or 'switch <num|email>'");
  });

  it("test_switch_to_force_forwarded", async () => {
    const { instance } = patchSwitcher();
    await main(["--switch-to", "2", "--force"]);
    expect(instance.switchTo).toHaveBeenCalledExactlyOnceWith("2", false, true);
  });

  it("test_switch_to_without_force_forwards_false", async () => {
    const { instance } = patchSwitcher();
    await main(["--switch-to", "2"]);
    expect(instance.switchTo).toHaveBeenCalledExactlyOnceWith("2", false, false);
  });

  it("test_export_and_import_are_mutually_exclusive", async () => {
    const result = await runCli(["--export", "/tmp/x", "--import", "/tmp/x"]);
    expect(result.returncode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("not allowed");
  });

  it("test_export_in_help", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("export <path>");
    expect(result.stdout).toContain("import <path>");
  });

  it("test_export_dispatch_calls_transfer", async () => {
    const { instance } = patchSwitcher();
    const exportFn = vi.fn();
    patch(internals, "exportAccounts", exportFn);
    await main(["--export", "/tmp/x", "--account", "2"]);
    expect(exportFn).toHaveBeenCalledExactlyOnceWith(instance, "/tmp/x", "2", false);
  });

  it("test_full_flag_requires_export", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["--list", "--full"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("--full can only be used with 'export'");
  });

  it("test_full_flag_dispatches_with_full_true", async () => {
    const { instance } = patchSwitcher();
    const exportFn = vi.fn();
    patch(internals, "exportAccounts", exportFn);
    await main(["--export", "/tmp/x", "--full"]);
    expect(exportFn).toHaveBeenCalledExactlyOnceWith(instance, "/tmp/x", null, true);
  });

  it("test_import_dispatch_calls_transfer", async () => {
    const { instance } = patchSwitcher();
    const importFn = vi.fn();
    patch(internals, "importAccounts", importFn);
    await main(["--import", "/tmp/x", "--force"]);
    expect(importFn).toHaveBeenCalledExactlyOnceWith(instance, "/tmp/x", true);
  });

  it("test_upgrade_in_help", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("upgrade ");
  });

  it("test_upgrade_dispatches_without_constructing_switcher", async () => {
    const { cls } = patchSwitcher();
    const upgradeFn = vi.fn(() => 0);
    patch(internals, "runSelfUpgrade", upgradeFn);
    expect(await exitCode(() => main(["--upgrade"]))).toBe(0);
    expect(upgradeFn).toHaveBeenCalledExactlyOnceWith();
    expect(cls).not.toHaveBeenCalled();
  });

  function menubarHarness(argv: string[]): { called: Record<string, boolean>; run: () => Promise<number | null> } {
    const called: Record<string, boolean> = {};
    patchSwitcher({ isRunningInContainer: () => false, backupDir: testHome() });
    patch(internals, "platform", () => "darwin");
    patch(internals, "menubarRun", () => {
      called.ran = true;
      return 0;
    });
    return { called, run: () => exitCode(() => main(argv)) };
  }

  it("test_menubar_flag_dispatches", async () => {
    const { called, run } = menubarHarness(["--menubar"]);
    expect(await run()).toBe(0);
    expect(called.ran).toBe(true);
  });

  it("test_menubar_subcommand_dispatches", async () => {
    const { called, run } = menubarHarness(["menubar"]);
    expect(await run()).toBe(0);
    expect(called.ran).toBe(true);
  });

  /** Drive `cswap menubar <service flag>` with the launch_agent calls replaced. */
  function serviceHarness(argv: string[]): { seen: Record<string, unknown>; run: () => Promise<number | null> } {
    const seen: Record<string, unknown> = { menubar_ran: false };
    patchSwitcher({ isRunningInContainer: () => false, backupDir: testHome() });
    patch(internals, "platform", () => "darwin");
    patch(internals, "menubarRun", () => {
      seen.menubar_ran = true;
      return 0;
    });
    const record =
      <T>(name: string, payload: T) =>
      (): T => {
        seen.called = name;
        return payload;
      };
    patch(internals, "launchAgent", {
      install: record("install", {
        label: "com.cswap.menubar",
        plist: "/tmp/p.plist",
        program: ["/tmp/cswap", "menubar"],
        stdout_log: "/tmp/o.log",
        stderr_log: "/tmp/e.log",
      }),
      uninstall: record("uninstall", { label: "com.cswap.menubar", was_loaded: true, removed_plist: true }),
      status: record("status", {
        label: "com.cswap.menubar",
        installed: true,
        loaded: true,
        state: "running",
        pid: 4242,
        plist: "/tmp/p.plist",
      }),
    });
    return { seen, run: () => exitCode(() => main(argv)) };
  }

  it("test_menubar_install_service_routes_to_launch_agent", async () => {
    const { seen, run } = serviceHarness(["menubar", "--install-service"]);
    const capsys = captureOutput();
    expect(await run()).toBe(0);
    expect(seen.called).toBe("install");
    expect(seen.menubar_ran).toBe(false);
    expect(capsys.readouterr().out).toContain("installed");
  });

  it.skip("test_install_service_warns_when_the_interpreter_draws_nothing", () => {
    // Python-only: framework_build_warning checks for a Python build that cannot draw a
    // rumps menu bar. The TypeScript CLI starts the native Swift app, so the check does not exist.
  });

  it.skip("test_install_service_stays_quiet_on_a_supported_interpreter", () => {
    // Python-only: see test_install_service_warns_when_the_interpreter_draws_nothing.
  });

  it("test_menubar_uninstall_service_routes_to_launch_agent", async () => {
    const { seen, run } = serviceHarness(["menubar", "--uninstall-service"]);
    const capsys = captureOutput();
    expect(await run()).toBe(0);
    expect(seen.called).toBe("uninstall");
    expect(seen.menubar_ran).toBe(false);
    expect(capsys.readouterr().out).toContain("removed");
  });

  it("test_menubar_service_status_reports_state_and_pid", async () => {
    const { seen, run } = serviceHarness(["menubar", "--service-status"]);
    const capsys = captureOutput();
    expect(await run()).toBe(0);
    expect(seen.called).toBe("status");
    const out = capsys.readouterr().out;
    expect(out).toContain("running");
    expect(out).toContain("4242");
  });

  it("test_menubar_service_flags_still_refuse_off_macos", async () => {
    const { run } = serviceHarness(["menubar", "--install-service"]);
    patch(internals, "platform", () => "linux");
    captureOutput();
    expect(await run()).toBe(1);
  });

  it("test_service_flags_are_rejected_outside_menubar", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["list", "--install-service"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("can only be used with 'menubar'");
  });

  it("test_plain_menubar_does_not_touch_the_service", async () => {
    const { seen, run } = serviceHarness(["menubar"]);
    expect(await run()).toBe(0);
    expect(seen.menubar_ran).toBe(true);
    expect(seen).not.toHaveProperty("called");
  });
});

describe("TestCLICommands", () => {
  it("test_status_no_account", async () => {
    const result = await runCli(["--status"]);
    expect(result.stdout.includes("No active Claude account") || result.returncode === 0).toBe(true);
  });

  it("test_list_no_accounts", async () => {
    // Answer 'n' to the first-run prompt.
    vi.spyOn(switcherInternals, "input").mockReturnValue("n");
    const result = await runCli(["--list"]);
    expect(result.stdout.includes("No accounts") || result.stdout.toLowerCase().includes("managed")).toBe(true);
  });

  it("test_add_token_without_email_dispatches_with_none", async () => {
    const mockAdd = vi.spyOn(ClaudeAccountSwitcher.prototype, "addAccountFromToken").mockImplementation(() => {});
    captureOutput();
    await main(["--add-token", "sk-ant-oat01-abc"]);
    expect(mockAdd).toHaveBeenCalledExactlyOnceWith("sk-ant-oat01-abc", null, null);
  });

  it("test_email_without_add_token_errors", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["--list", "--email", "u@x.com"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("--email can only be used with 'add-token'");
  });

  it("test_add_token_dispatches_to_switcher", async () => {
    const mockAdd = vi.spyOn(ClaudeAccountSwitcher.prototype, "addAccountFromToken").mockImplementation(() => {});
    captureOutput();
    await main(["--add-token", "mytoken", "--email", "u@example.com"]);
    expect(mockAdd).toHaveBeenCalledExactlyOnceWith("mytoken", "u@example.com", null);
  });

  it("test_add_token_with_slot", async () => {
    const mockAdd = vi.spyOn(ClaudeAccountSwitcher.prototype, "addAccountFromToken").mockImplementation(() => {});
    captureOutput();
    await main(["--add-token", "tok", "--email", "u@example.com", "--slot", "3"]);
    expect(mockAdd).toHaveBeenCalledExactlyOnceWith("tok", "u@example.com", 3);
  });

  it("test_add_token_in_help", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("add-token [TOKEN|-]");
    expect(result.stdout).toContain("--email");
  });
});

type RunCall = [string, ...unknown[]];

/** A `SessionManager` that records its calls in `calls`. */
function fakeSessionManager(calls: RunCall[], { recordInit = false } = {}) {
  return class FakeSessionManager {
    constructor(switcher: unknown) {
      if (recordInit) calls.push(["init", switcher]);
    }

    async run(identifier: string, claudeArgs: string[], share = true, shareHistory = false, requireSession = false) {
      calls.push(["run", identifier, claudeArgs, share, shareHistory, requireSession]);
    }

    execDefault(claudeArgs: string[]) {
      calls.push(["exec_default", claudeArgs]);
    }
  };
}

describe("TestRunCommand", () => {
  async function dispatch(argv: string[]): Promise<RunCall[]> {
    const calls: RunCall[] = [];
    patch(internals, "SessionManager", fakeSessionManager(calls, { recordInit: true }));
    patchSwitcher();
    await main(argv);
    return calls;
  }

  it("test_run_dispatches_with_defaults", async () => {
    expect(await dispatch(["run", "2"])).toContainEqual(["run", "2", [], true, false, false]);
  });

  it("test_run_by_email", async () => {
    expect(await dispatch(["run", "user@example.com"])).toContainEqual(["run", "user@example.com", [], true, false, false]);
  });

  it("test_no_share_flag", async () => {
    expect(await dispatch(["run", "2", "--no-share"])).toContainEqual(["run", "2", [], false, false, false]);
  });

  it("test_share_history_flag", async () => {
    expect(await dispatch(["run", "2", "--share-history"])).toContainEqual(["run", "2", [], true, true, false]);
  });

  it("test_no_share_history_flag", async () => {
    expect(await dispatch(["run", "2", "--no-share-history"])).toContainEqual(["run", "2", [], true, false, false]);
  });

  it("test_require_session_flag", async () => {
    expect(await dispatch(["run", "2", "--require-session"])).toContainEqual(["run", "2", [], true, false, true]);
  });

  it("test_tail_forwarded_verbatim", async () => {
    expect(await dispatch(["run", "2", "--", "--resume", "--model", "x"])).toContainEqual([
      "run",
      "2",
      ["--resume", "--model", "x"],
      true,
      false,
      false,
    ]);
  });

  it("test_tail_may_contain_run_flags", async () => {
    expect(await dispatch(["run", "2", "--", "--no-share"])).toContainEqual(["run", "2", ["--no-share"], true, false, false]);
  });

  it("test_run_unknown_flag_errors", async () => {
    captureOutput();
    expect(await exitCode(() => main(["run", "2", "--bogus"]))).toBe(2);
  });

  it("test_run_help", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["run", "--help"]))).toBe(0);
    const out = capsys.readouterr().out;
    expect(out).toContain("--no-share");
    expect(out).toContain("this terminal only");
  });

  it("test_main_help_mentions_run", async () => {
    expect((await runCli(["--help"])).stdout).toContain("run 2");
  });

  it("test_main_help_mentions_alias", async () => {
    expect((await runCli(["--help"])).stdout).toContain("alias <num|email>");
  });

  it("test_session_error_exits_cleanly", async () => {
    class FailingSessionManager {
      async run(): Promise<never> {
        throw new SessionError("boom");
      }
    }
    patch(internals, "SessionManager", FailingSessionManager);
    patchSwitcher();
    const capsys = captureOutput();
    expect(await exitCode(() => main(["run", "2"]))).toBe(1);
    expect(capsys.readouterr().err).toContain("boom");
  });
});

describe("TestSubcommandAliases", () => {
  it("test_translate_is_noop_for_flags", () => {
    expect(cli.translateSubcommand(["--list"])).toEqual(["--list"]);
    expect(cli.translateSubcommand(["--switch", "--json"])).toEqual(["--switch", "--json"]);
    expect(cli.translateSubcommand([])).toEqual([]);
  });

  it("test_translate_bare_switch_rotates", () => {
    expect(cli.translateSubcommand(["switch"])).toEqual(["--switch"]);
    expect(cli.translateSubcommand(["switch", "--strategy", "best"])).toEqual(["--switch", "--strategy", "best"]);
  });

  it("test_translate_switch_with_target", () => {
    expect(cli.translateSubcommand(["switch", "2"])).toEqual(["--switch-to", "2"]);
    expect(cli.translateSubcommand(["switch", "u@x.com", "--json"])).toEqual(["--switch-to", "u@x.com", "--json"]);
  });

  it("test_translate_simple_verbs_and_aliases", () => {
    expect(cli.translateSubcommand(["list"])).toEqual(["--list"]);
    expect(cli.translateSubcommand(["ls"])).toEqual(["--list"]);
    expect(cli.translateSubcommand(["status"])).toEqual(["--status"]);
    expect(cli.translateSubcommand(["add"])).toEqual(["--add-account"]);
    expect(cli.translateSubcommand(["rm", "2"])).toEqual(["--remove-account", "2"]);
    expect(cli.translateSubcommand(["upgrade"])).toEqual(["--upgrade"]);
    expect(cli.translateSubcommand(["update"])).toEqual(["--upgrade"]);
    expect(cli.translateSubcommand(["menubar"])).toEqual(["--menubar"]);
  });

  it("test_translate_value_verbs_pass_through_extra_flags", () => {
    expect(cli.translateSubcommand(["export", "b.cswap", "--full"])).toEqual(["--export", "b.cswap", "--full"]);
    expect(cli.translateSubcommand(["add-token", "sk-tok", "--slot", "3"])).toEqual([
      "--add-token",
      "sk-tok",
      "--slot",
      "3",
    ]);
  });

  it("test_translate_unknown_verb_unchanged", () => {
    expect(cli.translateSubcommand(["bogus"])).toEqual(["bogus"]);
  });

  it("test_switch_subcommand_dispatches_switch_to", async () => {
    const { instance } = patchSwitcher();
    await main(["switch", "2"]);
    expect(instance.switchTo).toHaveBeenCalledExactlyOnceWith("2", false, false);
  });

  it("test_bare_switch_subcommand_dispatches_switch", async () => {
    const { instance } = patchSwitcher();
    await main(["switch"]);
    expect(instance.switch).toHaveBeenCalledExactlyOnceWith(null, false, [], null);
  });

  it("test_list_subcommand_with_json", async () => {
    const payload = { schemaVersion: 1, accounts: [] };
    const { instance } = patchSwitcher();
    instance.listAccounts.mockResolvedValue(payload);
    captureOutput();
    await main(["list", "--json"]);
    expect(instance.listAccounts).toHaveBeenCalledExactlyOnceWith(false, true);
  });

  it("test_run_subcommand_still_dispatches", async () => {
    const calls: RunCall[] = [];
    patch(internals, "SessionManager", fakeSessionManager(calls));
    patchSwitcher();
    await main(["run", "2"]);
    expect(calls.map(([, identifier, claudeArgs, share]) => [identifier, claudeArgs, share])).toEqual([["2", [], true]]);
  });

  it("test_help_subcommand_prints_help", async () => {
    const result = await runCli(["help"]);
    expect(result.returncode).toBe(0);
    expect(result.stdout).toContain("Multi-Account Switcher");
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toContain("keep working");
  });
});

describe("TestJsonOutputCli", () => {
  it("test_json_rejected_without_supported_command", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["--purge", "--json"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("--json can only be used with");
  });

  it("test_token_status_with_json_rejected", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["--list", "--token-status", "--json"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("--token-status cannot be combined with --json");
  });

  it("test_list_json_serialized_to_stdout", async () => {
    const payload = { schemaVersion: 1, activeAccountNumber: null, accounts: [] };
    const { instance } = patchSwitcher();
    instance.listAccounts.mockResolvedValue(payload);
    const capsys = captureOutput();
    await main(["--list", "--json"]);
    expect(instance.listAccounts).toHaveBeenCalledExactlyOnceWith(false, true);
    expect(JSON.parse(capsys.readouterr().out)).toEqual(payload);
  });

  it("test_switch_json_forwarded_and_serialized", async () => {
    const payload = { schemaVersion: 1, switched: true };
    const { instance } = patchSwitcher();
    instance.switch.mockResolvedValue(payload);
    const capsys = captureOutput();
    await main(["--switch", "--json"]);
    expect(instance.switch).toHaveBeenCalledExactlyOnceWith(null, true, [], null);
    expect(JSON.parse(capsys.readouterr().out)).toEqual(payload);
  });

  it("test_switch_json_carries_model_fields_when_in_effect", async () => {
    const payload = { schemaVersion: 1, switched: true };
    const { instance } = patchSwitcher();
    instance.switch.mockResolvedValue(payload);
    const capsys = captureOutput();
    await main(["--switch", "--strategy", "best", "--model", "Fable", "--json"]);
    const out = JSON.parse(capsys.readouterr().out);
    expect(out.models).toEqual(["Fable"]);
    expect(out.modelSource).toBe("cli");
    expect(out.switched).toBe(true);
  });

  it("test_error_envelope_on_stdout_with_exit_1", async () => {
    const { instance } = patchSwitcher();
    instance.status.mockRejectedValue(new ConfigError("nope"));
    const capsys = captureOutput();
    expect(await exitCode(() => main(["--status", "--json"]))).toBe(1);
    const captured = capsys.readouterr();
    const envelope = JSON.parse(captured.out);
    expect(envelope.error).toEqual({ type: "ConfigError", message: "nope" });
    expect(captured.err).toBe("");
  });
});

describe("TestAutoCommand", () => {
  class FakeEngine {
    static instances: FakeEngine[] = [];
    static tickOutcome: TickOutcome | null = null;
    switcher: unknown;
    settings: AutoSwitchSettings;
    onEvent: (event: AutoSwitchEvent) => void;
    dryRun: boolean;

    constructor(
      switcher: unknown,
      settings: AutoSwitchSettings,
      onEvent: (event: AutoSwitchEvent) => void,
      { dryRun = false }: { dryRun?: boolean } = {},
    ) {
      this.switcher = switcher;
      this.settings = settings;
      this.onEvent = onEvent;
      this.dryRun = dryRun;
      FakeEngine.instances.push(this);
    }

    async tick(): Promise<TickOutcome> {
      return FakeEngine.tickOutcome ?? TickOutcome.NO_ACTION;
    }

    async runLoop(): Promise<number> {
      return 0;
    }

    stop(): void {}
  }

  beforeEach(() => {
    FakeEngine.instances = [];
    FakeEngine.tickOutcome = null;
  });

  async function run(argv: string[], engine: unknown = FakeEngine): Promise<number | null> {
    patch(internals, "AutoSwitchEngine", engine);
    return exitCode(() => main(["auto", ...argv]));
  }

  it("test_once_exit_code_switched", async () => {
    FakeEngine.tickOutcome = TickOutcome.SWITCHED;
    expect(await run(["--once"])).toBe(0);
  });

  it("test_once_exit_code_no_action", async () => {
    FakeEngine.tickOutcome = TickOutcome.NO_ACTION;
    expect(await run(["--once"])).toBe(2);
  });

  it("test_once_exit_code_blocked", async () => {
    FakeEngine.tickOutcome = TickOutcome.BLOCKED;
    expect(await run(["--once"])).toBe(3);
  });

  it("test_loop_mode_returns_loop_exit", async () => {
    captureOutput();
    expect(await run([])).toBe(0);
    expect(FakeEngine.instances.length).toBeGreaterThan(0);
  });

  it("test_flags_override_settings_json", async () => {
    const backup = getBackupRoot();
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(
      path.join(backup, "settings.json"),
      JSON.stringify({ schemaVersion: 1, autoswitch: { threshold: 80.0, cooldownSeconds: 42.0 } }),
    );
    await run(["--once", "--threshold", "60"]);
    const engine = FakeEngine.instances.at(-1)!;
    expect(engine.settings.threshold).toBe(60.0);
    expect(engine.settings.cooldownSeconds).toBe(42.0);
  });

  it("test_dry_run_forwarded", async () => {
    await run(["--once", "--dry-run"]);
    expect(FakeEngine.instances.at(-1)!.dryRun).toBe(true);
  });

  it("test_json_stdout_is_pure_jsonl", async () => {
    class EmittingEngine extends FakeEngine {
      override async tick(): Promise<TickOutcome> {
        this.onEvent(new NoSwitchEvent({ reason: "below-threshold" }));
        this.onEvent(new NoSwitchEvent({ reason: "cooldown" }));
        return TickOutcome.NO_ACTION;
      }
    }
    const capsys = captureOutput();
    await run(["--once", "--json"], EmittingEngine);
    const lines = capsys
      .readouterr()
      .out.split("\n")
      .filter((ln) => ln.trim());
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const payload = JSON.parse(line);
      expect(payload.event).toBe("no-switch");
      expect(payload.schemaVersion).toBe(1);
    }
  });

  it("test_unknown_flag_errors", async () => {
    captureOutput();
    expect(await exitCode(() => main(["auto", "--bogus"]))).toBe(2);
  });

  it("test_auto_help", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["auto", "--help"]))).toBe(0);
    const out = capsys.readouterr().out;
    expect(out).toContain("--once");
    expect(out).toContain("Exit codes");
  });

  it("test_main_help_mentions_auto", async () => {
    expect((await runCli(["--help"])).stdout).toContain("auto");
  });

  it("test_switcher_error_exits_1", async () => {
    patch(
      internals,
      "ClaudeAccountSwitcher",
      vi.fn(function () {
        throw new ConfigError("nope");
      }),
    );
    const capsys = captureOutput();
    expect(await exitCode(() => main(["auto", "--once"]))).toBe(1);
    expect(capsys.readouterr().err).toContain("nope");
  });
});

/** A real switcher with one managed account in slot 2. */
function seededSwitcher(): ClaudeAccountSwitcher {
  const switcher = new ClaudeAccountSwitcher();
  switcher.setupDirectories();
  switcher.initSequenceFile();
  const data = switcher.getSequenceData()!;
  data.accounts!["2"] = {
    email: "work@co.com",
    uuid: "u2",
    organizationUuid: "",
    organizationName: "",
    added: "2024-01-01T00:00:00Z",
  };
  data.sequence = [2];
  switcher.writeJson(switcher.sequenceFile, data);
  return switcher;
}

describe("TestUnclaimedCommand", () => {
  function stashed(): [ClaudeAccountSwitcher, string] {
    const switcher = new ClaudeAccountSwitcher();
    switcher.setupDirectories();
    switcher.initSequenceFile();
    const entryId = switcher.store.writeUnclaimedCredential("creds-bytes", {
      reason: "consume-gate-persist-lock-failed",
      configSlot: "2",
      consumedFp: "fp-old",
    });
    return [switcher, entryId];
  }

  it("test_list_shows_slot_and_reason_not_just_the_id", () => {
    const [, entryId] = stashed();
    const capsys = captureOutput();
    cli.unclaimedCommand([]);
    const out = capsys.readouterr().out;
    expect(out).toContain(entryId);
    expect(out).toContain("consume-gate-persist-lock-failed");
    expect(out).toContain("2");
  });

  it("test_purge_removes_bytes_and_row", () => {
    const [switcher, entryId] = stashed();
    captureOutput();
    cli.unclaimedCommand(["--purge", entryId]);
    expect(switcher.listUnclaimedCredentials()).toEqual({});
    expect(fs.existsSync(switcher.store.stashEntryPath(entryId))).toBe(false);
  });

  it("test_purging_an_unknown_id_fails_loudly", async () => {
    stashed();
    captureOutput();
    expect(await exitCode(() => cli.unclaimedCommand(["--purge", "no-such-entry"]))).toBe(1);
  });

  it("test_dispatched_from_main", async () => {
    const fn = vi.fn();
    patch(internals, "unclaimedCommand", fn);
    await main(["unclaimed", "--purge", "x"]);
    expect(fn).toHaveBeenCalledExactlyOnceWith(["--purge", "x"]);
  });
});

describe("TestMapCommand", () => {
  it("test_map_account_to_path", () => {
    seededSwitcher();
    const target = path.join(testHome(), "proj");
    fs.mkdirSync(target);
    const capsys = captureOutput();
    cli.mapCommand(["2", target]);
    const entry = new MappingStore(new ClaudeAccountSwitcher().backupDir).get(target);
    expect(entry).not.toBeNull();
    expect(entry!.email).toBe("work@co.com");
    expect(capsys.readouterr().out).toContain("Mapped");
  });

  it("test_map_nonexistent_path_warns_but_maps", () => {
    seededSwitcher();
    const target = path.join(testHome(), "not-created-yet");
    const capsys = captureOutput();
    cli.mapCommand(["2", target]);
    expect(new MappingStore(new ClaudeAccountSwitcher().backupDir).get(target)).not.toBeNull();
    expect(capsys.readouterr().out).toContain("is not an existing directory");
  });

  it("test_map_by_email_defaults_to_cwd", () => {
    seededSwitcher();
    const cwd = path.join(testHome(), "here");
    fs.mkdirSync(cwd);
    patch(internals, "cwd", () => cwd);
    captureOutput();
    cli.mapCommand(["work@co.com"]);
    expect(new MappingStore(new ClaudeAccountSwitcher().backupDir).get(cwd)).not.toBeNull();
  });

  it("test_map_unknown_account_errors", async () => {
    seededSwitcher();
    const capsys = captureOutput();
    expect(await exitCode(() => cli.mapCommand(["999", testHome()]))).toBe(1);
    expect(capsys.readouterr().err).toContain("Error");
  });

  it("test_map_list_empty", () => {
    seededSwitcher();
    const capsys = captureOutput();
    cli.mapCommand([]);
    expect(capsys.readouterr().out).toContain("No directory mappings yet");
  });

  it("test_map_list_shows_entries", () => {
    const switcher = seededSwitcher();
    const target = path.join(testHome(), "proj");
    fs.mkdirSync(target);
    new MappingStore(switcher.backupDir).set(target, "work@co.com", "");
    const capsys = captureOutput();
    cli.mapCommand([]);
    const out = capsys.readouterr().out;
    expect(out).toContain("Directory mappings");
    expect(out).toContain("work@co.com");
    expect(out).toContain("2:");
  });

  it("test_map_list_flags_removed_account", () => {
    const switcher = seededSwitcher();
    const target = path.join(testHome(), "proj");
    fs.mkdirSync(target);
    new MappingStore(switcher.backupDir).set(target, "ghost@co.com", "");
    const capsys = captureOutput();
    cli.mapCommand([]);
    expect(capsys.readouterr().out).toContain("account removed");
  });

  it("test_unmap_removes", () => {
    const switcher = seededSwitcher();
    const target = path.join(testHome(), "proj");
    fs.mkdirSync(target);
    const store = new MappingStore(switcher.backupDir);
    store.set(target, "work@co.com", "");
    const capsys = captureOutput();
    cli.unmapCommand([target]);
    expect(store.get(target)).toBeNull();
    expect(capsys.readouterr().out).toContain("Unmapped");
  });

  it("test_unmap_nonexistent_notes", () => {
    seededSwitcher();
    const target = path.join(testHome(), "proj");
    fs.mkdirSync(target);
    const capsys = captureOutput();
    cli.unmapCommand([target]);
    expect(capsys.readouterr().out).toContain("No mapping for");
  });

  it("test_map_dispatched_from_main", async () => {
    const mapFn = vi.fn();
    patch(internals, "mapCommand", mapFn);
    await main(["map", "2", "/tmp/x"]);
    expect(mapFn).toHaveBeenCalledExactlyOnceWith(["2", "/tmp/x"]);
  });

  it("test_unmap_dispatched_from_main", async () => {
    const unmapFn = vi.fn();
    patch(internals, "unmapCommand", unmapFn);
    await main(["unmap", "/tmp/x"]);
    expect(unmapFn).toHaveBeenCalledExactlyOnceWith(["/tmp/x"]);
  });

  it.skipIf(process.platform === "win32")("test_unmap_refuses_root", async () => {
    seededSwitcher();
    patch(internals, "geteuid", () => 0);
    vi.spyOn(ClaudeAccountSwitcher.prototype, "isRunningInContainer").mockReturnValue(false);
    const capsys = captureOutput();
    expect(await exitCode(() => cli.unmapCommand([testHome()]))).toBe(1);
    expect(capsys.readouterr().err).toContain("root");
  });

  it.skipIf(process.platform === "win32")("test_map_refuses_root", async () => {
    seededSwitcher();
    patch(internals, "geteuid", () => 0);
    vi.spyOn(ClaudeAccountSwitcher.prototype, "isRunningInContainer").mockReturnValue(false);
    const capsys = captureOutput();
    expect(await exitCode(() => cli.mapCommand(["2", testHome()]))).toBe(1);
    expect(capsys.readouterr().err).toContain("root");
  });
});

describe("TestAliasCommand", () => {
  it("test_set_alias_by_number", () => {
    seededSwitcher();
    const capsys = captureOutput();
    cli.aliasCommand(["2", "dev"]);
    expect(new ClaudeAccountSwitcher().getSequenceData()!.accounts!["2"]!.alias).toBe("dev");
    expect(capsys.readouterr().out).toContain("dev");
  });

  it("test_set_alias_by_email", () => {
    seededSwitcher();
    captureOutput();
    cli.aliasCommand(["work@co.com", "dev"]);
    expect(new ClaudeAccountSwitcher().getSequenceData()!.accounts!["2"]!.alias).toBe("dev");
  });

  it("test_unset_alias", () => {
    const switcher = seededSwitcher();
    const data = switcher.getSequenceData()!;
    data.accounts!["2"]!.alias = "dev";
    switcher.writeJson(switcher.sequenceFile, data);
    captureOutput();
    cli.aliasCommand(["2", "--unset"]);
    expect(new ClaudeAccountSwitcher().getSequenceData()!.accounts!["2"]).not.toHaveProperty("alias");
  });

  it("test_list_aliases", () => {
    const switcher = seededSwitcher();
    const data = switcher.getSequenceData()!;
    data.accounts!["2"]!.alias = "dev";
    switcher.writeJson(switcher.sequenceFile, data);
    const capsys = captureOutput();
    cli.aliasCommand([]);
    expect(capsys.readouterr().out).toContain("dev");
  });

  it("test_missing_name_errors", async () => {
    seededSwitcher();
    captureOutput();
    expect(await exitCode(() => cli.aliasCommand(["2"]))).not.toBeNull();
  });

  it("test_unset_without_account_errors", async () => {
    seededSwitcher();
    captureOutput();
    expect(await exitCode(() => cli.aliasCommand(["--unset"]))).not.toBeNull();
  });

  it("test_unset_with_name_errors", async () => {
    seededSwitcher();
    captureOutput();
    expect(await exitCode(() => cli.aliasCommand(["2", "dev", "--unset"]))).not.toBeNull();
  });

  it("test_invalid_alias_errors", async () => {
    seededSwitcher();
    const capsys = captureOutput();
    expect(await exitCode(() => cli.aliasCommand(["2", "123"]))).toBe(1);
    expect(capsys.readouterr().err).toContain("Error");
  });

  it("test_unknown_account_errors", async () => {
    seededSwitcher();
    captureOutput();
    expect(await exitCode(() => cli.aliasCommand(["999", "dev"]))).toBe(1);
  });

  it("test_dispatched_from_main", async () => {
    const aliasFn = vi.fn();
    patch(internals, "aliasCommand", aliasFn);
    await main(["alias", "2", "dev"]);
    expect(aliasFn).toHaveBeenCalledExactlyOnceWith(["2", "dev"]);
  });

  it.skipIf(process.platform === "win32")("test_alias_refuses_root", async () => {
    seededSwitcher();
    patch(internals, "geteuid", () => 0);
    vi.spyOn(ClaudeAccountSwitcher.prototype, "isRunningInContainer").mockReturnValue(false);
    const capsys = captureOutput();
    expect(await exitCode(() => cli.aliasCommand(["2", "dev"]))).toBe(1);
    expect(capsys.readouterr().err).toContain("root");
  });

  it("test_add_with_alias_flag", async () => {
    mockClaudeConfig();
    const fakeCreds = JSON.stringify({ claudeAiOauth: { accessToken: "tok" } });
    vi.spyOn(ClaudeAccountSwitcher.prototype, "readActiveCredentials").mockReturnValue({
      value: fakeCreds,
      keychainUnavailable: false,
      degraded: false,
    });
    vi.spyOn(ClaudeAccountSwitcher.prototype, "writeAccountCredentials").mockImplementation(() => {});
    captureOutput();
    await main(["add", "--alias", "dev"]);
    expect(new ClaudeAccountSwitcher().getSequenceData()!.accounts!["1"]!.alias).toBe("dev");
  });

  it("test_alias_flag_without_add_errors", async () => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(["list", "--alias", "dev"]))).toBe(2);
    expect(capsys.readouterr().err).toContain("--alias can only be used with 'add'");
  });
});

describe("TestRunAutoResolve", () => {
  type Seq = { accounts: Record<string, Record<string, unknown>>; sequence: number[] };

  /** A fake switcher with the real directory resolvers. */
  function fakeResolvingSwitcher(backup: string, seq: Seq): object {
    const sw = {
      backupDir: backup,
      isRunningInContainer: () => false,
      getSequenceDataMigrated: () => seq,
    } as Record<string, unknown>;
    sw.slotForDirectory = ClaudeAccountSwitcher.prototype.slotForDirectory.bind(sw as never);
    return sw;
  }

  async function dispatch(argv: string[], cwd: string, backup: string, seq: Seq): Promise<RunCall[]> {
    const calls: RunCall[] = [];
    patch(internals, "SessionManager", fakeSessionManager(calls));
    patchSwitcher(fakeResolvingSwitcher(backup, seq));
    patch(internals, "cwd", () => cwd);
    await main(argv);
    return calls.map((c) => (c[0] === "run" ? c.slice(0, 5) : c) as RunCall);
  }

  function dirs(...parts: string[]): string {
    const dir = path.join(testHome(), ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  const workSeq = (): Seq => ({
    accounts: { "2": { email: "work@co.com", organizationUuid: "", organizationName: "" } },
    sequence: [2],
  });

  it("test_mapped_dir_runs_resolved_account", async () => {
    const repo = dirs("work", "client-app");
    const backup = dirs("backup");
    new MappingStore(backup).set(repo, "work@co.com", "org-1");
    const seq: Seq = {
      accounts: { "2": { email: "work@co.com", organizationUuid: "org-1", organizationName: "Co" } },
      sequence: [2],
    };
    expect(await dispatch(["run"], repo, backup, seq)).toContainEqual(["run", "2", [], true, false]);
  });

  it("test_mapped_subdir_inherits", async () => {
    const repo = dirs("work");
    const sub = dirs("work", "client", "src");
    const backup = dirs("backup");
    new MappingStore(backup).set(repo, "work@co.com", "");
    expect(await dispatch(["run"], sub, backup, workSeq())).toContainEqual(["run", "2", [], true, false]);
  });

  it("test_unmapped_dir_falls_back_to_default", async () => {
    const backup = dirs("backup");
    const scratch = dirs("scratch");
    const capsys = captureOutput();
    const calls = await dispatch(["run"], scratch, backup, { accounts: {}, sequence: [] });
    expect(calls).toContainEqual(["exec_default", []]);
    expect(capsys.readouterr().out).toContain("No account mapped");
  });

  it("test_removed_account_falls_back_with_warning", async () => {
    const repo = dirs("repo");
    const backup = dirs("backup");
    new MappingStore(backup).set(repo, "ghost@co.com", "");
    const capsys = captureOutput();
    const calls = await dispatch(["run"], repo, backup, { accounts: {}, sequence: [] });
    expect(calls).toContainEqual(["exec_default", []]);
    expect(capsys.readouterr().out).toContain("no longer exists");
  });

  it("test_explicit_account_still_runs", async () => {
    const backup = dirs("backup");
    expect(await dispatch(["run", "3"], testHome(), backup, { accounts: {}, sequence: [] })).toContainEqual([
      "run",
      "3",
      [],
      true,
      false,
    ]);
  });

  it("test_no_account_forwards_tail", async () => {
    const repo = dirs("repo");
    const backup = dirs("backup");
    new MappingStore(backup).set(repo, "work@co.com", "");
    expect(await dispatch(["run", "--", "--resume"], repo, backup, workSeq())).toContainEqual([
      "run",
      "2",
      ["--resume"],
      true,
      false,
    ]);
  });

  it("test_no_account_forwards_share_history", async () => {
    const repo = dirs("repo");
    const backup = dirs("backup");
    new MappingStore(backup).set(repo, "work@co.com", "");
    expect(await dispatch(["run", "--share-history"], repo, backup, workSeq())).toContainEqual([
      "run",
      "2",
      [],
      true,
      true,
    ]);
  });
});

describe("TestDisableEnableDispatch", () => {
  async function run(argv: string[]): Promise<Fake> {
    const { instance } = patchSwitcher();
    await main(argv);
    return instance;
  }

  it("test_disable_subcommand_forwards", async () => {
    expect((await run(["disable", "2"])).setAccountDisabled).toHaveBeenCalledExactlyOnceWith("2", true);
  });

  it("test_enable_subcommand_forwards", async () => {
    expect((await run(["enable", "user@example.com"])).setAccountDisabled).toHaveBeenCalledExactlyOnceWith(
      "user@example.com",
      false,
    );
  });

  it("test_legacy_disable_flag_forwards", async () => {
    expect((await run(["--disable-account", "3"])).setAccountDisabled).toHaveBeenCalledExactlyOnceWith("3", true);
  });

  it("test_legacy_enable_flag_forwards", async () => {
    expect((await run(["--enable-account", "3"])).setAccountDisabled).toHaveBeenCalledExactlyOnceWith("3", false);
  });

  it("test_disable_without_target_errors", async () => {
    captureOutput();
    expect(await exitCode(() => main(["disable"]))).toBe(2);
  });
});

it.skip("test_importing_the_module_allocates_no_temp_dir", () => {
  // Python-only: the test guards a module-level `mkdtemp` in tests/test_cli.py and
  // the pytest basetemp of the subprocess HOME. These tests start no subprocess.
});

describe("TestImportUsageCli", () => {
  async function dispatch(argv: string[]): Promise<[Fake, ReturnType<typeof vi.fn>]> {
    const { instance } = patchSwitcher();
    const importFn = vi.fn();
    patch(internals, "importUsage", importFn);
    await main(argv);
    return [instance, importFn];
  }

  it("test_subcommand_dispatches_with_its_hold", async () => {
    const [instance, importFn] = await dispatch(["import-usage", "-", "--hold", "600"]);
    expect(importFn).toHaveBeenCalledExactlyOnceWith(instance, "-", 600.0);
  });

  it("test_no_hold_leaves_holds_alone", async () => {
    const [instance, importFn] = await dispatch(["import-usage", "/tmp/usage.json"]);
    expect(importFn).toHaveBeenCalledExactlyOnceWith(instance, "/tmp/usage.json", null);
  });

  it("test_zero_hold_reaches_the_import_to_lift_holds", async () => {
    const [instance, importFn] = await dispatch(["import-usage", "-", "--hold", "0"]);
    expect(importFn).toHaveBeenCalledExactlyOnceWith(instance, "-", 0.0);
  });

  it.each([
    [["list", "--hold", "60"], "--hold can only be used with 'import-usage'"],
    [["import-usage", "-", "--hold", "-1"], "--hold must be a non-negative"],
    [["import-usage", "-", "--hold", "inf"], "--hold must be a non-negative"],
  ])("test_hold_is_validated %j", async (argv, message) => {
    const capsys = captureOutput();
    expect(await exitCode(() => main(argv))).toBe(2);
    expect(capsys.readouterr().err).toContain(message);
  });
});
